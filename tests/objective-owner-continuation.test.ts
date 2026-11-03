import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskResourceFromStore } from "../apps/cli/src/control-plane-resources.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { loadOwnerWakeBrief } from "../packages/control-plane/src/owner-wake-brief.js";
import { SessionContinuity } from "../packages/control-plane/src/session-continuity.js";
import { ownerDeliveries, taskFollowupId } from "../packages/core/src/index.js";
import {
  LocalWorklet,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

describe("Objective owner continuation", () => {
  const cleanups: Array<() => Promise<unknown> | unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function fixture(execute: Worker["execute"]) {
    const directory = await mkdtemp(join(tmpdir(), "supertag-continuation-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const owner = await store.createTag({ name: `owner-${randomUUID()}` });
    await store.bindTagWorkerHost(owner.id, "fixture");
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "Resolve the backlog",
    });
    const worker: Worker = {
      async describe() {
        return {
          profileCapabilities: [
            {
              profile: { id: "default", revision: "1" },
              capabilities: [{ id: "supertag.coordination", version: 1 }],
              contextTypes: [],
            },
          ],
          id: "fixture-worker",
          type: "test",
          profiles: [{ id: "default", revision: "1" }],
          capabilities: [{ id: "supertag.coordination", version: 1 }],
          contextTypes: [],
          maxConcurrency: 1,
        };
      },
      execute,
    };
    const controller = new ObjectiveController(
      store,
      durableTestWorklet(new LocalWorklet("fixture", "fixture", [worker])),
      () => {},
    );
    controller.activateCoordination({ url: "http://fixture.invalid" });
    cleanups.push(() => controller.stop());
    const ownerRoots = async () =>
      (await store.listTaskAssignments(objective.id)).filter(
        (task) => task.assignedTagId === owner.id && !task.parentTaskId && !task.sourceMessageId,
      );
    return { store, controller, owner, objective, ownerRoots };
  }
  const failing: Worker["execute"] = async function* (spec) {
    yield {
      type: "execution.started",
      taskId: spec.taskId,
      attemptId: spec.attemptId,
      at: new Date().toISOString(),
      workerId: "fixture-worker",
    };
    yield {
      type: "execution.failed",
      taskId: spec.taskId,
      attemptId: spec.attemptId,
      at: new Date().toISOString(),
      error: { name: "Error", message: "Harness returned an empty response" },
    };
  };

  const finishing: Worker["execute"] = async function* (spec) {
    const at = () => new Date().toISOString();
    yield {
      type: "execution.started",
      taskId: spec.taskId,
      attemptId: spec.attemptId,
      at: at(),
      workerId: "fixture-worker",
    };
    yield {
      type: "output.message",
      taskId: spec.taskId,
      attemptId: spec.attemptId,
      at: at(),
      message: { role: "teammate", text: "I made progress and stopped." },
    };
    yield { type: "execution.completed", taskId: spec.taskId, attemptId: spec.attemptId, at: at() };
  };
  const failingWith = (message: string): Worker["execute"] =>
    async function* (spec) {
      yield {
        type: "execution.started",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
        workerId: "fixture-worker",
      };
      yield {
        type: "execution.failed",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
        error: { name: "Error", message },
      };
    };

  it("asks an owner that finished without completing for a verdict, up to a limit", async () => {
    const f = await fixture(finishing);
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    f.controller.start();
    // The original activation plus three assessment continuations that start no new Tasks, each
    // closing itself when it ends.
    await expect
      .poll(
        async () => (await f.ownerRoots()).filter((task) => task.status === "accepted").length,
        {
          timeout: 20000,
        },
      )
      .toBe(4);
    const assessment = (await f.ownerRoots()).find(
      (task) => task.taskId !== `${f.objective.id}:start`,
    );
    expect(assessment?.instruction).toContain("Objective is still working");
    expect(assessment?.instruction).toContain("set the Objective status to blocked");
    expect(assessment?.instruction).toContain("I made progress and stopped.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await f.ownerRoots()).toHaveLength(4);
  });

  it("does not continue an owner that marked its Objective blocked", async () => {
    const f = await fixture(finishing);
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    const objective = await f.store.getObjective(f.objective.id);
    await f.store.updateObjectiveStatus(
      f.objective.id,
      { status: "blocked", expectedRevision: objective.revision },
      undefined,
      undefined,
      { operatorId: "test" },
    );
    f.controller.start();
    await expect
      .poll(async () => (await f.ownerRoots())[0]?.status, { timeout: 20000 })
      .toBe("accepted");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await f.ownerRoots()).toHaveLength(1);
  });

  it.each([
    ["a provider usage limit", "You've hit your session limit · resets 11:10pm"],
    ["an error an operator must fix", "Invalid API key"],
  ])("does not immediately continue an owner that failed on %s", async (_, message) => {
    const f = await fixture(failingWith(message));
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    f.controller.start();
    await expect
      .poll(async () => (await f.ownerRoots())[0]?.status, { timeout: 20000 })
      .toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await f.ownerRoots()).toHaveLength(1);
    expect(await f.store.listStalledObjectiveOwnerTasks()).toHaveLength(1);
  });

  it("continues a failed owner from durable state, then stops after the continuation limit", async () => {
    const f = await fixture(failing);
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    f.controller.start();
    // The original activation plus three continuations, each failing.
    await expect
      .poll(async () => (await f.ownerRoots()).filter((task) => task.status === "failed").length, {
        timeout: 20000,
      })
      .toBe(4);
    const roots = await f.ownerRoots();
    const continuation = roots.find((task) => task.taskId !== `${f.objective.id}:start`);
    expect(continuation?.instruction).toContain("Continue from durable state");
    expect(continuation?.instruction).toContain("Harness returned an empty response");
    // No fifth activation: a persistently failing owner waits for an operator.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await f.ownerRoots()).toHaveLength(4);
    expect(await f.store.listStalledObjectiveOwnerTasks()).toHaveLength(1);
  });

  it("does not continue an owner while other work in the Objective is still active", async () => {
    const f = await fixture(failing);
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    const [root] = await f.ownerRoots();
    if (!root) throw new Error("Missing owner activation");
    const claimed = await f.store.claimTaskAssignment({ taskId: root.taskId, leaseOwner: "test" });
    if (!claimed) throw new Error("Owner activation could not be claimed");
    // Another queued Task keeps the organization alive; its result will wake the owner.
    await f.controller.commandAsAdministrator("assign_task", {
      objectiveId: f.objective.id,
      taskId: randomUUID(),
      teamId: root.teamId,
      assignedTagId: f.owner.id,
      instruction: "Other work",
      acceptanceCriteria: ["Done"],
    });
    await f.store.settleTaskAssignment({
      taskId: root.taskId,
      leaseOwner: "test",
      attemptCount: claimed.attemptCount,
      failed: true,
      result: { error: "Harness failure" },
    });
    expect(await f.store.listStalledObjectiveOwnerTasks()).toEqual([]);
  });

  describe("an owner whose waiting activation was cancelled", () => {
    // The dogfood stall: the owner waited on a builder's Task, a Mailbox Task cancelled that
    // waiting activation and then failed, and the builder submitted afterwards. Nothing was
    // running, queued, or waiting for the owner, so its result was never reviewed.
    async function cancelledWait(
      f: Awaited<ReturnType<typeof fixture>>,
      result: Record<string, unknown> = {},
    ) {
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const builder = await f.store.createTag({ name: `builder-${randomUUID()}` });
      const team = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Builders",
        leadTagId: f.owner.id,
        memberTagIds: [builder.id],
        maxConcurrency: 1,
      });
      const at = new Date().toISOString();
      const child = await f.store.admitTaskAssignment({
        taskId: `${f.objective.id}:final-fixes`,
        objectiveId: f.objective.id,
        teamId: team.id,
        requestedByTagId: f.owner.id,
        assignedTagId: builder.id,
        parentTaskId: root.taskId,
        instruction: "Fix the review finding",
        acceptanceCriteria: ["Finding fixed"],
        execution: {},
        authorizationSnapshot: {
          version: 4,
          capturedAt: at,
          tag: { id: builder.id, name: builder.name },
          origin: { kind: "internal", objectiveId: f.objective.id, requestedByTagId: f.owner.id },
          requester: { id: f.owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        },
        contextPlan: { version: 7, capturedAt: at, sets: [] },
        workspacePlan: { version: 1, status: "none" },
      });
      const claimed = await f.store.claimTaskAssignment({
        taskId: root.taskId,
        leaseOwner: "owner",
      });
      if (!claimed) throw new Error("Owner activation could not be claimed");
      await f.store.registerTaskAssignmentWait({
        taskId: root.taskId,
        leaseOwner: "owner",
        attemptCount: claimed.attemptCount,
        submittedTaskIds: [child.taskId],
      });
      await f.store.settleTaskAssignment({
        taskId: root.taskId,
        leaseOwner: "owner",
        attemptCount: claimed.attemptCount,
        result: {},
      });
      await f.store.cancelTaskAssignment(root.taskId, f.owner.id);
      await f.store.claimTaskAssignment({ taskId: child.taskId, leaseOwner: "builder" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await f.store.settleTaskAssignment({
        taskId: child.taskId,
        leaseOwner: "builder",
        attemptCount: 1,
        result: { text: "Fixed", ...result },
      });
      expect((await f.store.getTaskAssignment(child.taskId))?.status).toBe("submitted");
      return { root, child };
    }

    it("wakes the owner to review a result submitted after the cancellation", async () => {
      const f = await fixture(finishing);
      const { child } = await cancelledWait(f);
      f.controller.start();
      await expect
        .poll(
          async () => (await f.store.getTaskAssignment(await taskFollowupId(child.taskId)))?.status,
          {
            timeout: 20000,
          },
        )
        .toBe("accepted");
    });

    it("wakes the owner once for the same submitted result", async () => {
      const f = await fixture(finishing);
      const { child } = await cancelledWait(f);
      // Without a result follow-up, the stalled Objective must still reach the owner.
      vi.spyOn(f.store, "listTaskAssignmentFollowups").mockResolvedValue([]);
      f.controller.start();
      await expect
        .poll(
          async () =>
            (await f.ownerRoots()).find((task) => task.taskId.includes(":stall-wake:"))?.status,
          { timeout: 20000 },
        )
        .toBe("accepted");
      const review = (await f.ownerRoots()).find((task) => task.taskId.includes(":stall-wake:"));
      expect(review?.instruction).toContain(child.taskId);
      // It finishes without deciding; the same pending set must not start another owner wake.
      const roots = (await f.ownerRoots()).length;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await f.ownerRoots()).toHaveLength(roots);
      expect(
        (await f.ownerRoots()).filter((task) => task.taskId.includes(":stall-wake:")),
      ).toHaveLength(1);
      const inbox = await f.store.readCoordinationInbox({
        objectiveId: f.objective.id,
        kind: "task_attention",
      });
      expect(
        inbox.items.some(
          (item) => item.key === `task_attention:objective:${f.objective.id}:stalled`,
        ),
      ).toBe(true);
    }, 60_000);

    it("shows a stalled Objective in Task attention until its one review wake starts", async () => {
      const f = await fixture(async function* (spec) {
        const at = new Date().toISOString();
        yield {
          type: "execution.started",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at,
          workerId: "fixture-worker",
        };
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield {
          type: "execution.completed",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
        };
      });
      const { child } = await cancelledWait(f);
      vi.spyOn(f.store, "listTaskAssignmentFollowups").mockResolvedValue([]);
      const attention = async () =>
        (
          await f.store.readCoordinationInbox({
            objectiveId: f.objective.id,
            kind: "task_attention",
          })
        ).items.find((item) => item.key === `task_attention:objective:${f.objective.id}:stalled`);
      expect(await attention()).toMatchObject({
        reason: expect.stringContaining(child.taskId),
        commands: [`supertag message objective ${f.objective.id} TEXT`],
      });
      f.controller.start();
      await expect
        .poll(
          async () =>
            (await f.ownerRoots()).some(
              (task) => task.taskId.includes(":stall-wake:") && task.status === "running",
            ),
          { timeout: 20000 },
        )
        .toBe(true);
      expect(await attention()).toBeUndefined();
      await expect
        .poll(
          async () =>
            (await f.ownerRoots()).filter((task) => task.taskId.includes(":stall-wake:")).length,
          { timeout: 20000 },
        )
        .toBe(1);
    });

    it("wakes the owner for an open finding after its Task was accepted", async () => {
      const f = await fixture(finishing);
      const { child } = await cancelledWait(f, {
        taskResult: {
          findings: [{ id: "F1", severity: "high", summary: "Checkout fails", status: "open" }],
        },
      });
      await f.store.reviewTaskAssignment(child.taskId, f.owner.id, true, "Finding remains open");
      vi.spyOn(f.store, "listTaskAssignmentFollowups").mockResolvedValue([]);
      const attention = await f.store.readCoordinationInbox({
        objectiveId: f.objective.id,
        kind: "task_attention",
      });
      expect(attention.items.find((item) => item.key.endsWith(":stalled"))?.reason).toContain(
        `open finding ${child.taskId} F1`,
      );
      f.controller.start();
      await expect
        .poll(
          async () => (await f.ownerRoots()).some((task) => task.taskId.includes(":stall-wake:")),
          { timeout: 20000 },
        )
        .toBe(true);
    });
  });

  it("wakes the owner in a fresh session with an Objective brief while delegated Tasks still resume", async () => {
    const specs: TaskAttemptSpec[] = [];
    const f = await fixture(async function* (spec, signal) {
      specs.push(spec);
      yield {
        type: "usage.updated",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
        usage: {
          inputTokens: 900,
          outputTokens: 100,
          cachedInputTokens: 0,
          totalTokens: 1000,
          complete: true,
          reportedCost: { amountMinor: 150, currency: "USD" },
        },
      };
      yield* finishing(spec, signal);
    });
    // Any Task could resume native state; only the owner's activations must decline it.
    const prior = { id: "prior-native-state", format: "test-v1", uri: "supertag://sessions/prior" };
    const readTask = vi.spyOn(SessionContinuity.prototype, "readTask").mockResolvedValue(prior);
    cleanups.push(() => readTask.mockRestore());
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    const [root] = await f.ownerRoots();
    if (!root) throw new Error("Missing owner activation");
    const builder = await f.store.createTag({ name: `builder-${randomUUID()}` });
    await f.store.bindTagWorkerHost(builder.id, "fixture");
    const team = await f.store.createTeam({
      id: randomUUID(),
      objectiveId: f.objective.id,
      name: "Builders",
      leadTagId: f.owner.id,
      memberTagIds: [builder.id],
      maxConcurrency: 2,
    });
    const delegate = (taskId: string, instruction: string) => {
      const at = new Date().toISOString();
      return f.store.admitTaskAssignment({
        taskId,
        objectiveId: f.objective.id,
        teamId: team.id,
        requestedByTagId: f.owner.id,
        assignedTagId: builder.id,
        parentTaskId: root.taskId,
        instruction,
        acceptanceCriteria: ["Done"],
        execution: {},
        authorizationSnapshot: {
          version: 4,
          capturedAt: at,
          tag: { id: builder.id, name: builder.name },
          origin: { kind: "internal", objectiveId: f.objective.id, requestedByTagId: f.owner.id },
          requester: { id: f.owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        },
        contextPlan: { version: 7, capturedAt: at, sets: [] },
        workspacePlan: { version: 1, status: "none" },
      });
    };
    const exporter = await delegate(`${f.objective.id}:export`, "Build the billing export");
    // The owner's first Attempt delegates, records why it waits, and ends.
    const claimed = await f.store.claimTaskAssignment({ taskId: root.taskId, leaseOwner: "owner" });
    if (!claimed) throw new Error("Owner activation could not be claimed");
    const first = await f.store.createTaskAttempt({
      taskId: root.taskId,
      attemptNumber: claimed.attemptCount,
      workerProfile: { id: "default", revision: "1" },
      workerSnapshot: { kind: "assignment" },
      startedAt: new Date().toISOString(),
    });
    await f.store.registerTaskAssignmentWait({
      taskId: root.taskId,
      leaseOwner: "owner",
      attemptCount: claimed.attemptCount,
      submittedTaskIds: [exporter.taskId],
      reason: "Waiting for the billing export before rollout",
    });
    await f.store.settleTaskAssignment({
      taskId: root.taskId,
      leaseOwner: "owner",
      attemptCount: claimed.attemptCount,
      result: {},
    });
    await f.store.closeTaskAttempt({
      attemptId: first.id,
      status: "cancelled",
      endedAt: new Date().toISOString(),
    });
    expect((await f.store.getTaskAssignment(root.taskId))?.status).toBe("waiting");
    // While the owner waits, the exporter submits and new work is queued.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.store.claimTaskAssignment({ taskId: exporter.taskId, leaseOwner: "builder" });
    await f.store.settleTaskAssignment({
      taskId: exporter.taskId,
      leaseOwner: "builder",
      attemptCount: 1,
      result: { text: "Export ready on the Task branch" },
    });
    const followup = await delegate(`${f.objective.id}:docs`, "Document the export");
    f.controller.start();
    await expect
      .poll(() => specs.map((spec) => spec.taskId), { timeout: 20000 })
      .toEqual(expect.arrayContaining([root.taskId, followup.taskId]));

    const wake = specs.find((spec) => spec.taskId === root.taskId);
    // Same Task and Session, but no native transcript: the harness starts a fresh session.
    expect(wake?.session?.id).toBe(`assignment:${root.taskId}`);
    expect(wake?.session?.sessionState).toBeUndefined();
    const brief = wake?.input.messages.find((message) => message.id === `${root.taskId}:brief`);
    expect(brief?.role).toBe("system");
    expect(brief?.text).toContain("starts a fresh harness session");
    expect(brief?.text).toContain(`Changes since your last wake at ${first.startedAt}`);
    expect(brief?.text).toContain(`Task ${exporter.taskId} submitted`);
    expect(brief?.text).toContain("Results awaiting your review (1):");
    expect(brief?.text).toContain("Export ready on the Task branch");
    expect(brief?.text).toContain(
      'Your wait reason: "Waiting for the billing export before rollout',
    );
    // The existing context message still comes first.
    expect(wake?.input.messages[1]?.id).toBe(`${root.taskId}:context`);

    // An ordinary delegated Task keeps native resume and gets no brief.
    const delegated = specs.find((spec) => spec.taskId === followup.taskId);
    expect(delegated?.session?.sessionState).toEqual(prior);
    expect(delegated?.input.messages.some((message) => message.id.endsWith(":brief"))).toBe(false);

    // Each wake's provider-reported cost is visible per Task Attempt.
    await expect
      .poll(async () => (await f.store.listTaskAttempts(root.taskId)).length, { timeout: 20000 })
      .toBe(2);
    await expect
      .poll(
        async () => {
          const task = await f.store.findTaskById(root.taskId);
          if (!task) return undefined;
          return (await taskResourceFromStore(f.store, task)).status.attempts?.map((attempt) => [
            attempt.number,
            attempt.reportedCost,
            attempt.endedToWait,
          ]);
        },
        { timeout: 20000 },
      )
      .toEqual([
        // The first wake ended to wait durably; its reason is kept per Attempt.
        [1, null, { reason: "Waiting for the billing export before rollout" }],
        [2, { amountMinor: 150, currency: "USD" }, null],
      ]);
    // A real cancellation recorded after the wait supersedes the wait ending.
    await f.store.appendTaskEvent({
      taskId: root.taskId,
      type: "task.cancelled",
      payload: { attemptCount: 1 },
    });
    const cancelledTask = await f.store.findTaskById(root.taskId);
    if (!cancelledTask) throw new Error("Missing owner Task");
    expect(
      (await taskResourceFromStore(f.store, cancelledTask)).status.attempts?.[0]?.endedToWait,
    ).toBeNull();
  });

  it("continues an owner whose Mailbox Task failed after cancelling its activation", async () => {
    const f = await fixture(finishing);
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    const [root] = await f.ownerRoots();
    if (!root) throw new Error("Missing owner activation");
    await f.store.cancelTaskAssignment(root.taskId, f.owner.id);
    const sent = await f.store.sendOperatorObjectiveMessage({
      objectiveId: f.objective.id,
      message: "Let the fix finish, then complete.",
      idempotencyKey: randomUUID(),
      operatorId: "operator",
    });
    await f.store.admitMailboxTaskAssignments();
    const mailbox = `message:${sent.message.id}`;
    const claimed = await f.store.claimTaskAssignment({ taskId: mailbox, leaseOwner: "mailbox" });
    if (!claimed) throw new Error("Mailbox Task could not be claimed");
    await f.store.settleTaskAssignment({
      taskId: mailbox,
      leaseOwner: "mailbox",
      attemptCount: claimed.attemptCount,
      failed: true,
      result: { error: "Execution cleanup confirmed. Task outcome remains unknown" },
    });
    expect((await f.store.listStalledObjectiveOwnerTasks()).map((task) => task.taskId)).toEqual([
      mailbox,
    ]);
    f.controller.start();
    await expect
      .poll(async () => (await f.ownerRoots()).some((task) => task.status === "accepted"), {
        timeout: 20000,
      })
      .toBe(true);
    const continuation = (await f.ownerRoots()).find((task) => task.status === "accepted");
    expect(continuation?.instruction).toContain("Continue from durable state");
    // It carries the owner's responsibility, not the operator's message.
    expect(continuation?.instruction).toContain(root.instruction.slice(0, 40));
  });

  it("shows unhandled operator input when no owner activation remains", async () => {
    const f = await fixture(finishing);
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    const [root] = await f.ownerRoots();
    if (!root) throw new Error("Missing owner activation");
    await f.store.cancelTaskAssignment(root.taskId, f.owner.id);
    const sent = await f.store.sendOperatorObjectiveMessage({
      objectiveId: f.objective.id,
      message: "Please check checkout first.",
      idempotencyKey: randomUUID(),
      operatorId: "operator",
    });
    const inbox = await f.store.readCoordinationInbox({
      objectiveId: f.objective.id,
      kind: "task_attention",
    });
    expect(inbox.items.find((item) => item.key.endsWith(":stalled"))?.reason).toContain(
      `unhandled operator input ${sent.message.id}`,
    );
    expect((await f.store.listStalledObjectiveOwnerTasks()).map((task) => task.taskId)).toContain(
      root.taskId,
    );
  });
  describe("owner triggers delivered to the open activation", () => {
    const send = (f: Awaited<ReturnType<typeof fixture>>, message: string) =>
      f.store.sendOperatorObjectiveMessage({
        objectiveId: f.objective.id,
        message,
        idempotencyKey: randomUUID(),
        operatorId: "operator",
      });
    const messageTasks = async (f: Awaited<ReturnType<typeof fixture>>) =>
      (await f.store.listTaskAssignments(f.objective.id)).filter((task) => task.sourceMessageId);
    const deliveries = async (f: Awaited<ReturnType<typeof fixture>>, taskId: string) =>
      ownerDeliveries((await f.store.findTaskById(taskId))?.trigger).pending;
    async function claim(f: Awaited<ReturnType<typeof fixture>>, taskId: string) {
      const claimed = await f.store.claimTaskAssignment({ taskId, leaseOwner: "owner" });
      if (!claimed) throw new Error(`Task ${taskId} could not be claimed`);
      return claimed;
    }
    const settle = (
      f: Awaited<ReturnType<typeof fixture>>,
      claimed: { taskId: string; attemptCount: number },
      failed = false,
    ) =>
      f.store.settleTaskAssignment({
        taskId: claimed.taskId,
        leaseOwner: "owner",
        attemptCount: claimed.attemptCount,
        ...(failed ? { failed: true, result: { error: "Harness failed" } } : { result: {} }),
      });

    it("never leaves the Objective without an owner continuation after a message and a queued start", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const sent = await send(f, "Review the new direction.");
      await f.store.admitMailboxTaskAssignments();
      // The queued start receives the message; no second activation exists to claim first.
      expect(await messageTasks(f)).toEqual([]);
      expect(await f.store.getTaskAssignment(`message:${sent.message.id}`)).toBeUndefined();
      expect(await deliveries(f, root.taskId)).toEqual([
        { kind: "message", id: sent.message.id, attempt: null },
      ]);
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("processing");
      const claimed = await claim(f, root.taskId);
      expect(await deliveries(f, root.taskId)).toEqual([
        { kind: "message", id: sent.message.id, attempt: claimed.attemptCount },
      ]);
      await settle(f, claimed);
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("processed");
      expect((await f.store.getTaskAssignment(root.taskId))?.status).toBe("accepted");
      expect(await deliveries(f, root.taskId)).toEqual([]);
      // The Objective is still working with nothing active, so the owner is continued.
      expect((await f.store.listStalledObjectiveOwnerTasks()).map((task) => task.taskId)).toEqual([
        root.taskId,
      ]);
      f.controller.start();
      await expect
        .poll(
          async () =>
            (await f.ownerRoots()).some((task) =>
              task.instruction.startsWith("Your last activation ended"),
            ),
          { timeout: 20000 },
        )
        .toBe(true);
    });

    it("keeps the running activation going for a message that arrives during it", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const first = await claim(f, root.taskId);
      const sent = await send(f, "Also cover the new case.");
      await f.store.admitMailboxTaskAssignments();
      expect(await messageTasks(f)).toEqual([]);
      // A second activation would wait for this one; the message waits for its next Attempt.
      await settle(f, first);
      expect((await f.store.getTaskAssignment(root.taskId))?.status).toBe("waiting");
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("processing");
      expect(await f.store.listStalledObjectiveOwnerTasks()).toEqual([]);
      const [woken] = await f.store.wakeWaitingTaskAssignments();
      expect(woken?.taskId).toBe(root.taskId);
      expect(woken?.waitState?.wake?.reason).toBe("delivery");
      const second = await claim(f, root.taskId);
      expect(await deliveries(f, root.taskId)).toEqual([
        { kind: "message", id: sent.message.id, attempt: second.attemptCount },
      ]);
      await settle(f, second);
      expect((await f.store.getTaskAssignment(root.taskId))?.status).toBe("accepted");
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("processed");
    });

    it("wakes a waiting owner activation for a delivered message", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const claimed = await claim(f, root.taskId);
      await f.store.registerTaskAssignmentWait({
        taskId: root.taskId,
        leaseOwner: "owner",
        attemptCount: claimed.attemptCount,
        notBefore: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await settle(f, claimed);
      expect(await f.store.wakeWaitingTaskAssignments()).toEqual([]);
      const sent = await send(f, "Stop waiting and look at this.");
      await f.store.admitMailboxTaskAssignments();
      expect(await messageTasks(f)).toEqual([]);
      const [woken] = await f.store.wakeWaitingTaskAssignments();
      expect(woken?.taskId).toBe(root.taskId);
      expect(woken?.waitState?.wake?.reason).toBe("delivery");
      expect(await deliveries(f, root.taskId)).toEqual([
        { kind: "message", id: sent.message.id, attempt: null },
      ]);
    });

    it("wakes a mailbox-waiting owner for operator input without a delivery Task", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const claimed = await claim(f, root.taskId);
      await f.store.registerTaskAssignmentWait({
        taskId: root.taskId,
        leaseOwner: "owner",
        attemptCount: claimed.attemptCount,
        mailbox: true,
        reason: "Waiting for operator input",
      });
      await settle(f, claimed);
      expect(await f.store.wakeWaitingTaskAssignments()).toEqual([]);
      await send(f, "The merge is ready. Continue.");
      // Operator input itself satisfies the wait, even before the mailbox admission tick.
      expect((await f.store.wakeWaitingTaskAssignments()).map((task) => task.taskId)).toEqual([
        root.taskId,
      ]);
    });

    it("refuses a mailbox wait for previously delivered but unhandled operator input", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const sent = await send(f, "The merge was ready before this activation.");
      await f.store.admitMailboxTaskAssignments();
      const claimed = await claim(f, root.taskId);
      await expect(
        f.store.registerTaskAssignmentWait({
          taskId: root.taskId,
          leaseOwner: "owner",
          attemptCount: claimed.attemptCount,
          mailbox: true,
          reason: "Waiting for operator input",
        }),
      ).rejects.toThrow(sent.message.id);
      expect((await f.store.getTaskAssignment(root.taskId))?.waitState).toBeNull();
    });

    it("does not treat a prior successful Attempt as handling operator input", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const sent = await send(f, "Do not wait for the merge; it already happened.");
      await f.store.admitMailboxTaskAssignments();
      const first = await claim(f, root.taskId);
      await f.store.registerTaskAssignmentWait({
        taskId: root.taskId,
        leaseOwner: "owner",
        attemptCount: first.attemptCount,
        notBefore: new Date().toISOString(),
      });
      await settle(f, first);
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("processed");
      await f.store.wakeWaitingTaskAssignments();
      const second = await claim(f, root.taskId);
      await expect(
        f.store.registerTaskAssignmentWait({
          taskId: root.taskId,
          leaseOwner: "owner",
          attemptCount: second.attemptCount,
          mailbox: true,
        }),
      ).rejects.toThrow(sent.message.id);
    });

    async function childForOwner(f: Awaited<ReturnType<typeof fixture>>, rootId: string) {
      const root = await f.store.getTaskAssignment(rootId);
      const execution = await f.store.findTaskById(rootId);
      if (!root || !execution) throw new Error("Missing root");
      return f.store.admitTaskAssignment({
        taskId: randomUUID(),
        objectiveId: f.objective.id,
        teamId: root.teamId,
        assignedTagId: f.owner.id,
        requestedByTagId: f.owner.id,
        parentTaskId: rootId,
        instruction: "Independent delivery work",
        acceptanceCriteria: ["Done"],
        execution: {},
        authorizationSnapshot: execution.authorizationSnapshot,
        contextPlan: execution.contextPlan,
        workspacePlan: { version: 1, status: "none" },
      });
    }

    it.each(["before", "after"])(
      "does not block or wake an owner-Tag child for operator input arriving %s its wait",
      async (timing) => {
        const f = await fixture(finishing);
        await f.controller.command("start_objective", { objectiveId: f.objective.id });
        const [root] = await f.ownerRoots();
        if (!root) throw new Error("Missing root");
        const child = await childForOwner(f, root.taskId);
        const claimed = await claim(f, child.taskId);
        if (timing === "before") await send(f, "Direction for the owner activation only");
        await f.store.registerTaskAssignmentWait({
          taskId: child.taskId,
          leaseOwner: "owner",
          attemptCount: claimed.attemptCount,
          mailbox: true,
        });
        await settle(f, claimed);
        if (timing === "after") await send(f, "Direction for the owner activation only");
        expect(
          (await f.store.wakeWaitingTaskAssignments()).map((task) => task.taskId),
        ).not.toContain(child.taskId);
        expect((await f.store.getTaskAssignment(child.taskId))?.status).toBe("waiting");
      },
    );

    it("does not let a sibling owner-Tag Task handle input seen by the owner activation", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing root");
      const child = await childForOwner(f, root.taskId);
      const childClaimed = await claim(f, child.taskId);
      const claimed = await claim(f, root.taskId);
      const sent = await send(f, "Never delegate full verification");
      await loadOwnerWakeBrief(f.store, f.objective, claimed, "fixture-attempt");
      vi.useFakeTimers({ toFake: ["Date"] });
      cleanups.push(() => vi.useRealTimers());
      vi.setSystemTime(Date.now() + 1000);
      await f.store.updateObjectiveStatus(
        f.objective.id,
        {
          expectedRevision: (await f.store.getObjective(f.objective.id)).revision,
          status: "blocked",
        },
        f.owner.id,
        undefined,
        { taskId: child.taskId, attemptCount: childClaimed.attemptCount },
      );
      expect(
        (await f.store.listUnhandledOperatorInputs(f.objective.id)).map((m) => m.id),
      ).toContain(sent.message.id);
    });

    it("requires a fresh receipt in each owner attempt, even for the same Task", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing root");
      const first = await claim(f, root.taskId);
      const sent = await send(f, "Use the new candidate");
      await loadOwnerWakeBrief(f.store, f.objective, first, "fixture-attempt");
      await f.store.registerTaskAssignmentWait({
        taskId: root.taskId,
        leaseOwner: "owner",
        attemptCount: first.attemptCount,
        notBefore: new Date().toISOString(),
      });
      await settle(f, first);
      await f.store.wakeWaitingTaskAssignments();
      const second = await claim(f, root.taskId);
      vi.useFakeTimers({ toFake: ["Date"] });
      cleanups.push(() => vi.useRealTimers());
      const reply = (attemptCount: number) =>
        f.store.enqueueObjectiveMessage({
          objectiveId: f.objective.id,
          sourceTaskId: root.taskId,
          sourceAttemptCount: attemptCount,
          senderTagId: f.owner.id,
          type: "message",
          body: { message: "Reviewed candidate" },
          idempotencyKey: randomUUID(),
        });
      vi.setSystemTime(Date.now() + 1000);
      await reply(second.attemptCount);
      expect(
        (await f.store.listUnhandledOperatorInputs(f.objective.id)).map((m) => m.id),
      ).toContain(sent.message.id);
      await loadOwnerWakeBrief(f.store, f.objective, second, "fixture-attempt-2");
      vi.setSystemTime(Date.now() + 1000);
      await reply(first.attemptCount); // stale call cannot use the new receipt
      expect(
        (await f.store.listUnhandledOperatorInputs(f.objective.id)).map((m) => m.id),
      ).toContain(sent.message.id);
      await reply(second.attemptCount);
      expect(await f.store.listUnhandledOperatorInputs(f.objective.id)).toEqual([]);
    });

    it("handles full mailbox reads through real owner tools, but not no-op updates or omitted bodies", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing root");
      const caller = await f.store.claimTaskAssignment({
        taskId: root.taskId,
        leaseOwner: f.controller["instanceId"],
      });
      if (!caller) throw new Error("Cannot claim root");
      const attempt = await f.store.createTaskAttempt({
        taskId: root.taskId,
        attemptNumber: caller.attemptCount,
        workerProfile: { id: "default", revision: "1" },
        workerSnapshot: {},
        startedAt: new Date().toISOString(),
      });
      await f.store.startTask({ taskId: root.taskId, startedAt: new Date().toISOString() });
      const large = await send(f, `Omitted from brief: ${"x".repeat(5000)}`);
      const brief = await loadOwnerWakeBrief(f.store, f.objective, caller, attempt.id);
      const unhandled = brief.slice(
        brief.indexOf("Unhandled operator messages"),
        brief.indexOf("End of unhandled operator message data."),
      );
      expect(unhandled).toContain("bodies omitted here");
      expect(unhandled).not.toContain("Omitted from brief:");
      vi.useFakeTimers({ toFake: ["Date"] });
      cleanups.push(() => vi.useRealTimers());
      vi.setSystemTime(Date.now() + 1000);
      const reply = () =>
        f.controller.command(
          "send_message",
          {
            recipientObjectiveId: f.objective.id,
            type: "message",
            body: { message: "I reviewed the input" },
            needsReply: false,
            idempotencyKey: randomUUID(),
          },
          caller,
        );
      await reply();
      expect(
        (await f.store.listUnhandledOperatorInputs(f.objective.id)).map((m) => m.id),
      ).toContain(large.message.id);
      await f.controller.command("read_mailbox", { messageId: large.message.id }, caller);
      vi.setSystemTime(Date.now() + 1000);
      const objective = await f.store.getObjective(f.objective.id);
      await f.controller.command(
        "update_objective",
        { expectedRevision: objective.revision, status: objective.status },
        caller,
      );
      expect(
        (await f.store.listUnhandledOperatorInputs(f.objective.id)).map((m) => m.id),
      ).toContain(large.message.id);
      await reply();
      expect(await f.store.listUnhandledOperatorInputs(f.objective.id)).toEqual([]);
    });

    it("can handle a pruned historical input only after reading its removal marker", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing root");
      const sent = await send(f, "Old direction");
      await f.store.admitMailboxTaskAssignments();
      const first = await claim(f, root.taskId);
      await f.store.registerTaskAssignmentWait({
        taskId: root.taskId,
        leaseOwner: "owner",
        attemptCount: first.attemptCount,
        notBefore: new Date().toISOString(),
      });
      await settle(f, first);
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("processed");
      // Operator messages keep their bodies while the Objective is open: prune while it is
      // closed, then reopen it to reach a pruned historical input.
      expect(
        await f.store.pruneTagMessageBodies({ before: new Date(Date.now() + 1000).toISOString() }),
      ).toEqual({ pruned: 0 });
      const setStatus = async (status: "completed" | "working") =>
        f.store.updateObjectiveStatus(
          f.objective.id,
          {
            status,
            expectedRevision: (await f.store.getObjective(f.objective.id)).revision,
            ...(status === "completed" ? { completionSummary: "Done" } : {}),
          },
          f.owner.id,
        );
      await setStatus("completed");
      expect(
        await f.store.pruneTagMessageBodies({ before: new Date(Date.now() + 1000).toISOString() }),
      ).toEqual({ pruned: 1 });
      await setStatus("working");
      await f.store.wakeWaitingTaskAssignments();
      const caller = await f.store.claimTaskAssignment({
        taskId: root.taskId,
        leaseOwner: f.controller["instanceId"],
      });
      if (!caller) throw new Error("Missing next attempt");
      const attempt = await f.store.createTaskAttempt({
        taskId: root.taskId,
        attemptNumber: caller.attemptCount,
        workerProfile: { id: "default", revision: "1" },
        workerSnapshot: {},
        startedAt: new Date().toISOString(),
      });
      await f.store.startTask({ taskId: root.taskId, startedAt: new Date().toISOString() });
      await loadOwnerWakeBrief(f.store, f.objective, caller, attempt.id);
      const reply = () =>
        f.controller.command(
          "send_message",
          {
            recipientObjectiveId: f.objective.id,
            body: { message: "The old body was removed; please resend if still needed" },
            type: "message",
            idempotencyKey: randomUUID(),
          },
          caller,
        );
      vi.useFakeTimers({ toFake: ["Date"] });
      cleanups.push(() => vi.useRealTimers());
      vi.setSystemTime(Date.now() + 1000);
      await reply();
      expect(
        (await f.store.listUnhandledOperatorInputs(f.objective.id)).map((m) => m.id),
      ).toContain(sent.message.id);
      const read = await f.controller.command(
        "read_mailbox",
        { messageId: sent.message.id },
        caller,
      );
      expect(read).toMatchObject({ messages: [{ bodyPrunedAt: expect.any(String) }] });
      vi.setSystemTime(Date.now() + 1000);
      await reply();
      expect(await f.store.listUnhandledOperatorInputs(f.objective.id)).toEqual([]);
    });

    it("pages received owner history through the existing after cursor without losing old IDs", async () => {
      const f = await fixture(finishing);
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push((await send(f, `Direction ${i}`)).message.id);
      const other = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.owner.id,
        outcome: "Other",
      });
      await f.store.sendOperatorObjectiveMessage({
        objectiveId: other.id,
        message: "Other Objective",
        operatorId: "operator",
        idempotencyKey: randomUUID(),
      });
      const received: string[] = [];
      let after: { createdAt: string; id: string } | null = null;
      do {
        const page = (await f.controller.command("read_mailbox", {
          objectiveId: f.objective.id,
          limit: 2,
          ...(after ? { after } : {}),
        })) as { messages: { id: string }[]; nextAfter: typeof after };
        received.push(...page.messages.map((m) => m.id));
        after = page.nextAfter;
      } while (after);
      expect(received.sort()).toEqual(ids.sort());
      expect(new Set(received).size).toBe(7);
    });

    it.each(["assignment", "no-op update"])(
      "does not clear unseen input after an owner %s",
      async (action) => {
        const f = await fixture(finishing);
        await f.controller.command("start_objective", { objectiveId: f.objective.id });
        const [root] = await f.ownerRoots();
        if (!root) throw new Error("Missing owner activation");
        const claimed = await claim(f, root.taskId);
        await loadOwnerWakeBrief(f.store, f.objective, claimed, "fixture-attempt");
        vi.useFakeTimers({ toFake: ["Date"] });
        cleanups.push(() => vi.useRealTimers());
        vi.setSystemTime(Date.now() + 1000);
        const sent = await send(f, "Never delegate full verification.");
        vi.setSystemTime(Date.now() + 1000);
        if (action === "assignment") {
          const execution = await f.store.findTaskById(root.taskId);
          if (!execution) throw new Error("Missing execution");
          await f.store.admitTaskAssignment({
            taskId: randomUUID(),
            objectiveId: f.objective.id,
            teamId: root.teamId,
            requestedByTagId: f.owner.id,
            assignedTagId: f.owner.id,
            parentTaskId: root.taskId,
            sourceAttemptCount: claimed.attemptCount,
            instruction: "Unrelated work",
            acceptanceCriteria: ["Done"],
            execution: {},
            authorizationSnapshot: execution.authorizationSnapshot,
            contextPlan: execution.contextPlan,
            workspacePlan: { version: 1, status: "none" },
          });
        } else {
          const current = await f.store.getObjective(f.objective.id);
          await f.store.updateObjectiveStatus(
            f.objective.id,
            { expectedRevision: current.revision, status: current.status },
            f.owner.id,
          );
        }
        expect(
          (await f.store.listUnhandledOperatorInputs(f.objective.id)).map((m) => m.id),
        ).toContain(sent.message.id);
      },
    );

    it.each(["reply", "objective update", "assignment"])(
      "allows waiting after a durable owner %s handles earlier input",
      async (action) => {
        const f = await fixture(finishing);
        await f.controller.command("start_objective", { objectiveId: f.objective.id });
        const [root] = await f.ownerRoots();
        if (!root) throw new Error("Missing owner activation");
        vi.useFakeTimers({ toFake: ["Date"] });
        cleanups.push(() => vi.useRealTimers());
        const sent = await send(f, "Review the merge, then wait for further direction.");
        await f.store.admitMailboxTaskAssignments();
        const claimed = await claim(f, root.taskId);
        await loadOwnerWakeBrief(f.store, f.objective, claimed, "fixture-attempt");
        vi.setSystemTime(Date.now() + 1000);
        if (action === "reply")
          await f.store.enqueueObjectiveMessage({
            objectiveId: f.objective.id,
            senderTagId: f.owner.id,
            sourceTaskId: root.taskId,
            sourceAttemptCount: claimed.attemptCount,
            type: "message",
            body: { message: "Reviewed the merge." },
            idempotencyKey: randomUUID(),
          });
        else if (action === "objective update")
          await f.store.updateObjectiveStatus(
            f.objective.id,
            {
              expectedRevision: (await f.store.getObjective(f.objective.id)).revision,
              status: "blocked",
            },
            f.owner.id,
            undefined,
            { taskId: root.taskId, attemptCount: claimed.attemptCount },
          );
        else {
          const execution = await f.store.findTaskById(root.taskId);
          if (!execution) throw new Error("Missing Task execution");
          await f.store.admitTaskAssignment({
            taskId: randomUUID(),
            objectiveId: f.objective.id,
            teamId: root.teamId,
            requestedByTagId: f.owner.id,
            assignedTagId: f.owner.id,
            parentTaskId: root.taskId,
            sourceAttemptCount: claimed.attemptCount,
            instruction: "Review the merge",
            acceptanceCriteria: ["Reviewed"],
            execution: {},
            authorizationSnapshot: execution.authorizationSnapshot,
            contextPlan: execution.contextPlan,
            workspacePlan: { version: 1, status: "none" },
          });
        }
        vi.setSystemTime(Date.now() + 1000);
        await f.store.registerTaskAssignmentWait({
          taskId: root.taskId,
          leaseOwner: "owner",
          attemptCount: claimed.attemptCount,
          mailbox: true,
        });
        await settle(f, claimed);
        expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("processed");
        expect(await f.store.wakeWaitingTaskAssignments()).toEqual([]);
        vi.setSystemTime(Date.now() + 1000);
        await send(f, "New direction after the recorded action.");
        expect((await f.store.wakeWaitingTaskAssignments()).map((task) => task.taskId)).toContain(
          root.taskId,
        );
      },
    );

    it.each(["unrelated report", "operator update", "other Objective", "equal timestamp"])(
      "does not treat %s as handling operator input",
      async (action) => {
        const f = await fixture(finishing);
        await f.controller.command("start_objective", { objectiveId: f.objective.id });
        const [root] = await f.ownerRoots();
        if (!root) throw new Error("Missing owner activation");
        vi.useFakeTimers({ toFake: ["Date"] });
        cleanups.push(() => vi.useRealTimers());
        const sent = await send(f, "The operator decision still needs handling.");
        const claimed = await claim(f, root.taskId);
        if (action !== "equal timestamp") vi.setSystemTime(Date.now() + 1000);
        if (action === "unrelated report")
          await f.store.enqueueObjectiveMessage({
            objectiveId: f.objective.id,
            senderTagId: f.owner.id,
            sourceTaskId: root.taskId,
            sourceAttemptCount: claimed.attemptCount,
            type: "message",
            body: { message: "Still running." },
            needsReply: false,
            idempotencyKey: randomUUID(),
          });
        else {
          const target =
            action === "other Objective"
              ? await f.store.createObjective({
                  id: randomUUID(),
                  ownerTagId: f.owner.id,
                  outcome: "Unrelated work",
                })
              : f.objective;
          await f.store.updateObjectiveStatus(
            target.id,
            { expectedRevision: target.revision, status: "working" },
            action === "operator update" ? undefined : f.owner.id,
            undefined,
            action === "operator update" ? { operatorId: "operator" } : undefined,
          );
        }
        await expect(
          f.store.registerTaskAssignmentWait({
            taskId: root.taskId,
            leaseOwner: "owner",
            attemptCount: claimed.attemptCount,
            mailbox: true,
          }),
        ).rejects.toThrow(sent.message.id);
      },
    );

    it("does not mistake a synthetic deadline notice for unhandled operator input", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const claimed = await claim(f, root.taskId);
      await f.store.updateObjectiveStatus(
        f.objective.id,
        {
          expectedRevision: f.objective.revision,
          deadline: new Date(Date.now() + 3_600_000).toISOString(),
        },
        undefined,
        undefined,
        { operatorId: "operator" },
      );
      await expect(
        f.store.registerTaskAssignmentWait({
          taskId: root.taskId,
          leaseOwner: "owner",
          attemptCount: claimed.attemptCount,
          mailbox: true,
        }),
      ).resolves.toMatchObject({ waitState: { mailbox: true } });
    });

    it("returns delivered messages to the Mailbox when the activation fails", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const seen = await send(f, "Delivered before the Attempt.");
      await f.store.admitMailboxTaskAssignments();
      const claimed = await claim(f, root.taskId);
      const unseen = await send(f, "Delivered during the Attempt.");
      await f.store.admitMailboxTaskAssignments();
      await settle(f, claimed, true);
      expect(await deliveries(f, root.taskId)).toEqual([]);
      expect(await f.store.getTagMessage(seen.message.id)).toMatchObject({
        status: "pending",
        attemptCount: 1,
      });
      expect(await f.store.getTagMessage(unseen.message.id)).toMatchObject({
        status: "pending",
        attemptCount: 0,
      });
      // The next activation receives both: one starts from the first message, the other joins it.
      await f.store.admitMailboxTaskAssignments();
      const tasks = await messageTasks(f);
      expect(tasks.map((task) => task.sourceMessageId)).toEqual([seen.message.id]);
      expect(await deliveries(f, `message:${seen.message.id}`)).toEqual([
        { kind: "message", id: unseen.message.id, attempt: null },
      ]);
    });

    it("lets the owner complete after handling a delivered operator message", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const sent = await send(f, "Complete this outcome after review.");
      await f.store.admitMailboxTaskAssignments();
      const claimed = await claim(f, root.taskId);
      const attempt = await f.store.createTaskAttempt({
        workerProfile: { id: "default", revision: "1" },
        taskId: root.taskId,
        attemptNumber: claimed.attemptCount,
        workerSnapshot: {},
        startedAt: new Date().toISOString(),
      });
      const completed = await f.store.updateObjectiveStatus(
        f.objective.id,
        {
          expectedRevision: f.objective.revision,
          status: "completed",
          completionSummary: "Reviewed",
        },
        f.owner.id,
        { taskId: root.taskId, attemptCount: claimed.attemptCount, leaseOwner: "owner" },
      );
      expect(completed.status).toBe("completed");
      await f.store.settleTaskAssignment({
        taskId: root.taskId,
        leaseOwner: "owner",
        attemptCount: claimed.attemptCount,
        terminalAttempt: { id: attempt.id, status: "completed" },
        result: { summary: "Reviewed" },
      });
      expect((await f.store.getTaskAssignment(root.taskId))?.status).toBe("accepted");
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("processed");
    });

    it("delivers a delegated result to the running activation instead of a follow-up", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const builder = await f.store.createTag({ name: `builder-${randomUUID()}` });
      const team = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Builders",
        leadTagId: f.owner.id,
        memberTagIds: [builder.id],
      });
      const first = await claim(f, root.taskId);
      const at = new Date().toISOString();
      const delegate = (name: string) =>
        f.store.admitTaskAssignment({
          taskId: `${f.objective.id}:${name}`,
          objectiveId: f.objective.id,
          teamId: team.id,
          requestedByTagId: f.owner.id,
          assignedTagId: builder.id,
          parentTaskId: root.taskId,
          instruction: `Do ${name}`,
          acceptanceCriteria: ["Done"],
          execution: {},
          authorizationSnapshot: {
            version: 4,
            capturedAt: at,
            tag: { id: builder.id, name: builder.name },
            origin: {
              kind: "internal",
              objectiveId: f.objective.id,
              requestedByTagId: f.owner.id,
            },
            requester: { id: f.owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          workspacePlan: { version: 1, status: "none" },
        });
      const submit = async (taskId: string) => {
        const built = await f.store.claimTaskAssignment({ taskId, leaseOwner: "builder" });
        if (!built) throw new Error(`Task ${taskId} could not be claimed`);
        await f.store.settleTaskAssignment({
          taskId,
          leaseOwner: "builder",
          attemptCount: built.attemptCount,
          result: { text: "Done" },
        });
      };
      const build = await delegate("build");
      const verify = await delegate("verify");
      await submit(build.taskId);
      const followups = async () =>
        (await f.store.listTaskAssignmentFollowups()).map((task) => task.taskId);
      expect(await followups()).toEqual([build.taskId]);
      expect(await f.store.deliverOwnerTaskChanges(f.objective.id, [build.taskId])).toBe(
        root.taskId,
      );
      expect(await followups()).toEqual([]);
      await settle(f, first);
      const [woken] = await f.store.wakeWaitingTaskAssignments();
      expect(woken?.waitState?.wake).toMatchObject({ reason: "delivery", taskIds: [build.taskId] });
      const second = await claim(f, root.taskId);
      // Its wait belongs to the previous Attempt, so a change during this one is delivered too.
      await submit(verify.taskId);
      expect(await followups()).toEqual([verify.taskId]);
      expect(await f.store.deliverOwnerTaskChanges(f.objective.id, [verify.taskId])).toBe(
        root.taskId,
      );
      await settle(f, second);
      expect((await f.store.getTaskAssignment(root.taskId))?.status).toBe("waiting");
      await f.store.wakeWaitingTaskAssignments();
      const third = await claim(f, root.taskId);
      await settle(f, third);
      expect((await f.store.getTaskAssignment(root.taskId))?.status).toBe("accepted");
      // Handled once, the results need no follow-up activation later.
      expect(await followups()).toEqual([]);
      for (const child of [build, verify])
        expect(await f.store.getTaskAssignment(await taskFollowupId(child.taskId))).toBeUndefined();
    });

    it("never handles an owner Task under another activation's authorization", async () => {
      const f = await fixture(finishing);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      // A queued owner Task with its own, narrower authorization snapshot.
      const at = new Date().toISOString();
      const narrow = {
        version: 4 as const,
        capturedAt: at,
        tag: { id: f.owner.id, name: f.owner.name },
        origin: {
          kind: "internal" as const,
          objectiveId: f.objective.id,
          requestedByTagId: f.owner.id,
        },
        requester: { id: f.owner.id, kind: "bot" as const },
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      };
      const instruction = await f.store.admitTaskAssignment({
        taskId: `surface-instruction:${randomUUID()}`,
        objectiveId: f.objective.id,
        teamId: root.teamId,
        requestedByTagId: f.owner.id,
        assignedTagId: f.owner.id,
        instruction: "Assess this authenticated human update",
        acceptanceCriteria: ["Assessed"],
        execution: {},
        authorizationSnapshot: narrow,
        contextPlan: { version: 7, capturedAt: at, sets: [] },
        workspacePlan: { version: 1, status: "none" },
      });
      const claimed = await claim(f, root.taskId);
      // Claiming one activation leaves the other Task and its policy untouched.
      expect((await f.store.getTaskAssignment(instruction.taskId))?.status).toBe("queued");
      expect(
        await f.store.claimTaskAssignment({ taskId: instruction.taskId, leaseOwner: "other" }),
      ).toBeUndefined();
      await settle(f, claimed);
      expect((await f.store.getTaskAssignment(instruction.taskId))?.status).toBe("queued");
      const next = await claim(f, instruction.taskId);
      expect((await f.store.findTaskById(next.taskId))?.authorizationSnapshot).toEqual(narrow);
      // A message never joins an activation that carries another principal's authority.
      const sent = await send(f, "Direction while only the surface instruction is open.");
      await f.store.admitMailboxTaskAssignments();
      expect((await messageTasks(f)).map((task) => task.sourceMessageId)).toEqual([
        sent.message.id,
      ]);
      expect(await deliveries(f, instruction.taskId)).toEqual([]);
    });

    it("places delivered triggers in the owner's Attempt context", async () => {
      let captured: Parameters<Worker["execute"]>[0] | undefined;
      const hold: Worker["execute"] = async function* (spec, signal) {
        captured = spec;
        yield {
          type: "execution.started",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          workerId: "fixture-worker",
        };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      };
      const f = await fixture(hold);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const sent = await send(f, "Review this direction in the current activation.");
      await f.store.admitMailboxTaskAssignments();
      f.controller.start();
      await expect.poll(() => captured?.taskId).toBe(`${f.objective.id}:start`);
      // An owner activation may use the Worker's coordination slot.
      expect(captured?.placement?.coordinationSlot).toBe(true);
      const context = captured?.input.messages.find((message) => message.id.endsWith(":context"));
      const parsed = JSON.parse(context?.text ?? "null");
      expect(parsed.deliveries).toEqual([
        {
          kind: "message",
          message: expect.objectContaining({ id: sent.message.id, operatorId: "operator" }),
        },
      ]);
      expect(parsed.deliveryGuidance).toContain("Handle every entry before ending");
    });

    it("omits a removed sender's queued message from owner context", async () => {
      let captured: Parameters<Worker["execute"]>[0] | undefined;
      const hold: Worker["execute"] = async function* (spec, signal) {
        captured = spec;
        yield {
          type: "execution.started",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          workerId: "fixture-worker",
        };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      };
      const f = await fixture(hold);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const sender = await f.store.createTag({ name: `removed-${randomUUID()}` });
      const team = await f.store.getTeam(root.teamId);
      await f.store.updateTeam(team.id, {
        expectedRevision: team.revision,
        memberTagIds: [...team.memberTagIds, sender.id],
      });
      const sent = await f.store.enqueueTagMessage({
        senderTagId: sender.id,
        recipientTagId: f.owner.id,
        objectiveId: f.objective.id,
        type: "note",
        body: { message: "Do not deliver after removal" },
        idempotencyKey: randomUUID(),
      });
      await f.store.admitMailboxTaskAssignments();
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("pending");
      await f.store.updateTeam(team.id, {
        expectedRevision: team.revision + 1,
        memberTagIds: team.memberTagIds,
      });
      f.controller.start();
      await expect.poll(() => captured?.taskId).toBe(root.taskId);
      const context = captured?.input.messages.find((message) => message.id.endsWith(":context"));
      const parsed = JSON.parse(context?.text ?? "null");
      expect(parsed.deliveries).toBeUndefined();
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("failed");
    });

    it("omits a removed sender from a non-owner digest after current-work context loads", async () => {
      let captured: TaskAttemptSpec | undefined;
      const f = await fixture(async function* (spec) {
        captured = spec;
        yield* finishing(spec);
      });
      const sender = await f.store.createTag({ name: `sender-${randomUUID()}` });
      const recipient = await f.store.createTag({ name: `recipient-${randomUUID()}` });
      await f.store.bindTagWorkerHost(recipient.id, "fixture");
      const team = await f.store.createTeam({
        id: `${f.objective.id}:build`,
        objectiveId: f.objective.id,
        name: "Build",
        leadTagId: f.owner.id,
        memberTagIds: [sender.id, recipient.id],
      });
      const taskId = `build-${randomUUID()}`;
      await f.controller.command("assign_task", {
        objectiveId: f.objective.id,
        taskId,
        teamId: team.id,
        assignedTagId: recipient.id,
        instruction: "Build",
        acceptanceCriteria: ["Done"],
      });
      const sent = await f.store.enqueueTagMessage({
        senderTagId: sender.id,
        recipientTagId: recipient.id,
        objectiveId: f.objective.id,
        type: "note",
        body: { message: "Revoked digest text" },
        idempotencyKey: randomUUID(),
      });
      const dispatch = f.controller["dispatchCommand"].bind(f.controller);
      f.controller["dispatchCommand"] = async (...args) => {
        const result = await dispatch(...args);
        if (args[0] === "read_objective") {
          await f.store.updateTeam(team.id, {
            expectedRevision: team.revision,
            memberTagIds: [recipient.id],
          });
        }
        return result;
      };
      f.controller.start();
      await expect.poll(() => captured?.taskId).toBe(taskId);
      expect(captured?.input.messages.map((message) => message.text).join("\n")).not.toContain(
        "Revoked digest text",
      );
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("failed");
    });

    it("omits revoked Team text from the owner digest and brief during context assembly", async () => {
      let captured: Parameters<Worker["execute"]>[0] | undefined;
      const hold: Worker["execute"] = async function* (spec, signal) {
        captured = spec;
        yield {
          type: "execution.started",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          workerId: "fixture-worker",
        };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      };
      const f = await fixture(hold);
      await f.controller.command("start_objective", { objectiveId: f.objective.id });
      const [root] = await f.ownerRoots();
      if (!root) throw new Error("Missing owner activation");
      const sender = await f.store.createTag({ name: `removed-${randomUUID()}` });
      const team = await f.store.getTeam(root.teamId);
      await f.store.updateTeam(team.id, {
        expectedRevision: team.revision,
        memberTagIds: [...team.memberTagIds, sender.id],
      });
      const sent = await f.store.enqueueTagMessage({
        senderTagId: sender.id,
        recipientTagId: f.owner.id,
        objectiveId: f.objective.id,
        type: "note",
        body: { message: "Remove during context assembly" },
        idempotencyKey: randomUUID(),
      });
      await f.store.admitMailboxTaskAssignments();
      const readDigest = f.store.readActivationDigest.bind(f.store);
      vi.spyOn(f.store, "readActivationDigest").mockImplementationOnce(async (input) => {
        await f.store.updateTeam(team.id, {
          expectedRevision: team.revision + 1,
          memberTagIds: team.memberTagIds,
        });
        return readDigest(input);
      });
      f.controller.start();
      await expect.poll(() => captured?.taskId).toBe(root.taskId);
      const context = captured?.input.messages.find((message) => message.id.endsWith(":context"));
      expect(JSON.parse(context?.text ?? "null").deliveries).toBeUndefined();
      expect(
        captured?.input.messages.find((message) => message.id.endsWith(":brief"))?.text,
      ).not.toContain("Remove during context assembly");
      expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("failed");
    });
  });
});
