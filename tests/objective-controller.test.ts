import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  ORG_ARCHITECT_ROLE_KEY,
  type TaskAssignment,
  taskFollowupId,
} from "../packages/core/src/index.js";
import {
  LocalWorklet,
  REPORTED_COST_LIMIT_CAPABILITY,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

describe("Objective controller command boundaries", () => {
  it("rejects a multi-Tag direct address before resolving Tag names", async () => {
    const f = await fixture();
    const lookup = vi.spyOn(f.store, "findTagByName");
    await expect(
      f.controller.command(
        "send_message",
        {
          objectiveId: f.objective.id,
          to: [f.worker.id, "unknown-tag"],
          type: "question",
          body: { message: "Review?" },
          idempotencyKey: randomUUID(),
        },
        f.caller,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("backs off repeated scheduler failures instead of retrying every tick", async () => {
    const f = await fixture();
    // Only the controller under test may tick: the fixture's own controller shares the store,
    // and a tick it schedules after fake timers start would double the counted calls.
    await f.controller.stop();
    const sweep = vi
      .spyOn(f.store, "admitMailboxTaskAssignments")
      .mockRejectedValue(new Error("No remote Worklet is connected"));
    const controller = new ObjectiveController(
      f.store,
      durableTestWorklet(new LocalWorklet("backoff", "backoff", [])),
    );
    controller.activateCoordination({ url: "http://127.0.0.1:3434" });
    vi.useFakeTimers();
    try {
      controller.start();
      await vi.advanceTimersByTimeAsync(13000);
      expect(sweep).toHaveBeenCalledTimes(7);
      await controller.stop();
    } finally {
      vi.useRealTimers();
      sweep.mockRestore();
    }
  });
  it("carries Team scaling through management commands and rejects excess growth", async () => {
    const f = await fixture();
    const updated = await f.controller.command("update_team", {
      objectiveId: f.objective.id,
      teamId: f.team.id,
      expectedRevision: f.team.revision,
      scaling: { maxBreadth: 1, maxDepth: 1 },
    });
    expect(updated).toMatchObject({ scaling: { maxBreadth: 1, maxDepth: 1 } });
    const child = {
      objectiveId: f.objective.id,
      parentTeamId: f.team.id,
      name: "Exploration",
      leadTagId: f.lead.id,
      memberTagIds: [],
      maxConcurrency: 1,
    };
    await expect(
      f.controller.command("create_team", { ...child, id: randomUUID() }),
    ).resolves.toMatchObject({ parentTeamId: f.team.id });
    await expect(
      f.controller.command("create_team", { ...child, id: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      f.controller.command("read_team", {
        objectiveId: f.objective.id,
        teamId: f.team.id,
      }),
    ).resolves.toMatchObject({ scaling: { maxBreadth: 1, maxDepth: 1 } });
  });
  it("exposes staged coordination readiness independently of admission and capacity", async () => {
    const store = new DrizzleStore({ url: "file::memory:" });
    const controller = new ObjectiveController(
      store,
      durableTestWorklet(new LocalWorklet("readiness", "host", [])),
    );
    expect(controller.executionReadiness).toBe("stopped");
    controller.start();
    controller.start();
    try {
      expect(controller.executionReadiness).toBe("awaiting-coordination");
      controller.activateCoordination({ url: "http://127.0.0.1:3434" });
      expect(controller.executionReadiness).toBe("ready");
    } finally {
      await controller.stop();
    }
    expect(controller.executionReadiness).toBe("stopped");
    const workerless = new ObjectiveController(store, undefined);
    workerless.activateCoordination({ url: "http://127.0.0.1:3434" });
    workerless.start();
    try {
      expect(workerless.executionReadiness).toBe("awaiting-worklet");
    } finally {
      await workerless.stop();
    }
  });
  it("exposes management primitives only when the active manager has a matching role", async () => {
    const f = await fixture();
    const actions = await f.controller.coordinationActions(f.caller);
    expect(actions).toEqual(
      expect.arrayContaining([
        "read_team",
        "read_mailbox",
        "assign_task",
        "update_task",
        "create_team",
        "update_team",
        "read_workstream",
        "post_workstream",
      ]),
    );
    // Every Team has exactly one channel, created with it; there is no other way to make one.
    expect(actions).not.toContain("create_workstream");
    expect(actions).not.toContain("update_workstream");
    expect(actions).not.toContain("update_objective");
    expect(actions).not.toContain("create_tag");
  });

  it("grants durable organization creation authority through the built-in Role", async () => {
    const f = await fixture();
    const role = await f.store.ensureSystemRole({
      systemKey: ORG_ARCHITECT_ROLE_KEY,
      name: "Org Architect",
      purpose: "Decide when durable organization structure is warranted.",
      instructions: "Create durable structure only when the policy supports it.",
    });
    const assignment = await f.store.assignRole({
      roleId: role.id,
      tagId: f.lead.id,
    });
    const designTask = (await f.controller.command(
      "assign_task",
      {
        taskId: randomUUID(),
        teamId: f.team.id,
        assignedTagId: f.lead.id,
        instruction: "Review organization structure",
        acceptanceCriteria: ["Policy applied"],
      },
      f.caller,
    )) as TaskAssignment;
    const admitted = await f.store.findTaskById(designTask.taskId);
    expect(admitted?.authorizationSnapshot.roles).toEqual([
      expect.objectContaining({
        assignmentId: assignment.id,
        assignmentRevision: assignment.revision,
        role: expect.objectContaining({
          systemKey: ORG_ARCHITECT_ROLE_KEY,
          revision: role.revision,
        }),
      }),
    ]);
    const caller = await f.activate(designTask);
    await expect(f.controller.coordinationActions(caller)).resolves.toEqual(
      expect.arrayContaining(["create_tag", "create_team"]),
    );
    await expect(
      f.controller.command("create_tag", { name: `architect-created-${randomUUID()}` }, caller),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      f.controller.command(
        "create_team",
        {
          id: randomUUID(),
          name: "Architect-created Team",
          leadTagId: f.worker.id,
          memberTagIds: [f.worker.id],
          maxConcurrency: 1,
        },
        caller,
      ),
    ).resolves.toMatchObject({ name: "Architect-created Team", status: "active" });
  });

  it("returns the existing start Task when an operator starts a started Objective again", async () => {
    const f = await fixture();
    const first = (await f.controller.command("start_objective", {
      objectiveId: f.objective.id,
      taskId: "bootstrap",
    })) as TaskAssignment;
    await expect(
      f.controller.command("start_objective", { objectiveId: f.objective.id, maxCostMinor: 5 }),
    ).resolves.toMatchObject({ taskId: first.taskId });
    const starts = (await f.store.listTaskAssignments(f.objective.id)).filter(
      (task) => task.teamId === `${f.objective.id}:leadership`,
    );
    expect(starts.map((task) => task.taskId)).toEqual(["bootstrap"]);
  });
  it("lets a new Objective's owner find Tags by name and staff a Team below Leadership", async () => {
    const f = await fixture();
    const start = (await f.controller.command("start_objective", {
      objectiveId: f.objective.id,
    })) as TaskAssignment;
    const leadershipId = `${f.objective.id}:leadership`;
    expect(await f.store.getTeam(leadershipId)).toMatchObject({
      memberTagIds: [f.owner.id],
      // Leadership sets no throttle; Worker Host capacity is the only limit.
      maxConcurrency: null,
    });
    await expect
      .poll(async () => (await f.store.getTaskAssignment(start.taskId))?.status)
      .toBe("running");
    const owner = await f.store.getTaskAssignment(start.taskId);
    if (!owner) throw new Error("Missing owner start Task");
    expect(owner.instruction).toContain(
      "Leave out maxConcurrency so Worker Host capacity is the only limit; set one only to deliberately throttle that Team's work.",
    );
    expect(await f.controller.coordinationActions(owner)).toContain("list_tags");
    const directory = (await f.controller.command("list_tags", {}, owner)) as {
      tags: {
        id: string;
        name: string;
        roles: string[];
        workerHosts: { id: string }[];
        taskCounts: {
          objective: { running: number; queued: number };
          overall: { running: number; queued: number };
        };
      }[];
    };
    expect(directory.tags.find((tag) => tag.id === f.worker.id)).toMatchObject({
      name: f.worker.name,
      roles: [],
      workerHosts: [{ id: "fixture" }],
      taskCounts: { objective: { running: 0, queued: 0 }, overall: { running: 0, queued: 0 } },
    });
    expect(directory.tags.find((tag) => tag.id === f.owner.id)?.taskCounts).toEqual({
      objective: { running: 1, queued: 0 },
      overall: { running: 1, queued: 0 },
    });
    // Team leads may list Tags too.
    await expect(f.controller.command("list_tags", {}, f.caller)).resolves.toMatchObject({
      nextOffset: null,
    });
    const stray = await f.store.createTag({ name: `stray-${randomUUID()}` });
    const request = {
      id: `${f.objective.id}:delivery`,
      name: "Delivery",
      leadTagId: f.owner.name,
      memberTagIds: [f.worker.name],
      parentTeamId: leadershipId,
      maxConcurrency: 3,
    };
    await expect(
      f.controller.command(
        "create_team",
        { ...request, memberTagIds: [f.worker.name, stray.name] },
        owner,
      ),
    ).rejects.toThrow(`Tag ${stray.name} (${stray.id}) has no bound Worker Host`);
    const team = (await f.controller.command("create_team", request, owner)) as {
      id: string;
      leadTagId: string;
      memberTagIds: string[];
    };
    expect(team.leadTagId).toBe(f.owner.id);
    expect(team.memberTagIds).toEqual([f.owner.id, f.worker.id].sort());
    const assigned = (await f.controller.command(
      "assign_task",
      {
        taskId: randomUUID(),
        teamId: team.id,
        assignedTagId: f.worker.name,
        instruction: "Build the change",
        acceptanceCriteria: ["Built"],
      },
      owner,
    )) as TaskAssignment;
    expect(assigned.assignedTagId).toBe(f.worker.id);
  });
  it("routes manager Team creation to the nearest Org Architect", async () => {
    const f = await fixture();
    const leadership = (await f.controller.command("start_objective", {
      objectiveId: f.objective.id,
      taskId: randomUUID(),
    })) as TaskAssignment;
    await f.controller.command("update_task", {
      objectiveId: f.objective.id,
      taskId: leadership.taskId,
      expectedStatus: leadership.status,
      status: "cancelled",
    });
    const role = await f.store.ensureSystemRole({
      systemKey: ORG_ARCHITECT_ROLE_KEY,
      name: "Org Architect",
      purpose: "Decide when durable organization structure is warranted.",
      instructions: "Require continuing ownership before approving a Team.",
    });
    const assignment = await f.store.assignRole({
      roleId: role.id,
      tagId: f.worker.id,
    });
    await f.store.assignRole({
      roleId: role.id,
      tagId: f.owner.id,
    });
    const teamId = randomUUID();
    const request = {
      id: teamId,
      name: "Evidence synthesis",
      leadTagId: f.worker.id,
      memberTagIds: [f.worker.id],
      parentTeamId: f.team.id,
      maxConcurrency: 1,
    };

    const pending = (await f.controller.command("create_team", request, f.caller)) as {
      status: string;
      duplicate: boolean;
      message: {
        id: string;
        recipientTagId: string;
        body: Record<string, unknown>;
      };
    };
    expect(pending).toMatchObject({
      status: "pending",
      duplicate: false,
      message: {
        recipientTagId: f.worker.id,
        body: {
          action: "create_team",
          input: { ...request, objectiveId: f.objective.id, objectiveIds: [] },
        },
      },
    });
    await expect(f.store.getTeam(teamId)).rejects.toMatchObject({ statusCode: 404 });
    const architectTask = (await f.store.admitMailboxTaskAssignments()).find(
      (task) => task.sourceMessageId === pending.message.id,
    );
    expect(architectTask).toBeDefined();
    if (!architectTask) throw new Error("Architect review was not admitted");
    expect((await f.store.findTaskById(architectTask.taskId))?.authorizationSnapshot.roles).toEqual(
      [
        expect.objectContaining({
          assignmentId: assignment.id,
          role: expect.objectContaining({ systemKey: ORG_ARCHITECT_ROLE_KEY }),
        }),
      ],
    );
    await expect
      .poll(async () => (await f.store.getTaskAssignment(architectTask.taskId))?.status)
      .toBe("running");
    const reviewCaller = await f.store.getTaskAssignment(architectTask.taskId);
    if (!reviewCaller) throw new Error("Missing Org Architect review Task");
    await expect(f.controller.command("create_team", request, reviewCaller)).resolves.toMatchObject(
      { id: teamId, name: request.name, status: "active" },
    );
    await expect(
      f.store.listResourceChanges({ resourceType: "team", resourceId: teamId }),
    ).resolves.toEqual([
      expect.objectContaining({
        actorTagId: f.worker.id,
        sourceTaskId: reviewCaller.taskId,
        sourceMessageId: pending.message.id,
      }),
    ]);
    const reply = (await f.controller.command(
      "send_message",
      {
        recipientTagId: f.lead.id,
        type: "message",
        body: {
          outcome: "approved",
          resourceId: teamId,
          rationale: "The Team has a continuing synthesis responsibility.",
        },
        idempotencyKey: `organization-decision:${teamId}`,
        inReplyTo: pending.message.id,
      },
      reviewCaller,
    )) as { message: { id: string } };
    await expect(f.store.listTagMessageReplies(pending.message.id)).resolves.toEqual([
      expect.objectContaining({ id: reply.message.id, recipientTagId: f.lead.id }),
    ]);
    await expect(f.controller.command("create_team", request, f.caller)).resolves.toMatchObject({
      status: "pending",
      duplicate: true,
      message: { id: pending.message.id },
    });

    await f.store.assignRole({
      roleId: role.id,
      tagId: f.lead.id,
    });
    await expect(
      f.controller.command("create_team", { ...request, id: randomUUID() }, f.caller),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "More than one Org Architect is positioned to review this request",
    });
  });

  it("accepts a named Team addressee and defaults a direct message to note", async () => {
    const f = await fixture();
    const sent = (await f.controller.command(
      "send_message",
      {
        to: [f.worker.name],
        body: { message: "See the review evidence" },
        idempotencyKey: randomUUID(),
      },
      f.caller,
    )) as { message: { recipientTagId: string; to: string[]; type: string } };
    expect(sent.message).toMatchObject({
      recipientTagId: f.worker.id,
      to: [f.worker.id],
      type: "note",
    });
    expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
  });

  it("routes Objective-owner Tag creation through the Org Architect mailbox", async () => {
    const f = await fixture();
    const role = await f.store.ensureSystemRole({
      systemKey: ORG_ARCHITECT_ROLE_KEY,
      name: "Org Architect",
      purpose: "Decide when durable organization structure is warranted.",
      instructions: "Require a durable identity boundary before approving a Tag.",
    });
    await f.store.assignRole({
      roleId: role.id,
      tagId: f.worker.id,
    });
    await f.store.setTagMessagingGrant({
      senderTagId: f.owner.id,
      recipientTagId: f.worker.id,
      messageTypes: ["message"],
    });
    await f.store.setTagMessagingGrant({
      senderTagId: f.worker.id,
      recipientTagId: f.owner.id,
      messageTypes: ["message"],
    });
    const team = await f.store.getTeam(f.team.id);
    await f.store.updateTeam(f.team.id, {
      expectedRevision: team.revision,
      memberTagIds: [...team.memberTagIds, f.owner.id],
    });
    const ownerTask = (await f.controller.command("assign_task", {
      objectiveId: f.objective.id,
      taskId: randomUUID(),
      teamId: f.team.id,
      assignedTagId: f.owner.id,
      instruction: "Manage organization structure",
      acceptanceCriteria: ["Structure reviewed"],
    })) as TaskAssignment;
    const ownerCaller = await f.activate(ownerTask);

    const pending = (await f.controller.command(
      "create_tag",
      { name: "durable-evaluator" },
      ownerCaller,
    )) as { status: string; message: { body: Record<string, unknown> } };
    expect(pending).toMatchObject({
      status: "pending",
      message: {
        body: {
          action: "create_tag",
          input: { name: "durable-evaluator" },
        },
      },
    });
    await expect(f.store.findTagByName("durable-evaluator")).resolves.toBeUndefined();
  });

  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function fixture(
    options: {
      budgetLimitMinor?: number;
      budgetCurrency?: string;
      managerCostMinor?: number;
      managerExecution?: Record<string, unknown>;
      workerFailure?: { name: string; message: string };
      afterFailure?: string;
    } = {},
  ) {
    const directory = await mkdtemp(join(tmpdir(), "supertag-controller-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const owner = await store.createTag({ name: `owner-${randomUUID()}` });
    const lead = await store.createTag({ name: `lead-${randomUUID()}` });
    const worker = await store.createTag({ name: `worker-${randomUUID()}` });
    await Promise.all(
      [owner, lead, worker].map((tag) => store.bindTagWorkerHost(tag.id, "fixture")),
    );
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "Validate scheduling",
      runtimeActions: ["test.read", "test.write"],
      ...(options.budgetLimitMinor === undefined
        ? {}
        : { budgetLimitMinor: options.budgetLimitMinor }),
      ...(options.budgetCurrency === undefined ? {} : { budgetCurrency: options.budgetCurrency }),
    });
    const other = await store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "Other",
    });
    const team = await store.createTeam({
      id: randomUUID(),
      objectiveId: objective.id,
      name: "Research",
      leadTagId: lead.id,
      memberTagIds: [worker.id],
      maxConcurrency: 2,
    });
    let failExecution = () => {};
    const failureRequested = new Promise<void>((resolve) => {
      failExecution = resolve;
    });
    const runtimeWorker: Worker = {
      async describe() {
        return {
          profileCapabilities: [
            {
              profile: { id: "default", revision: "1" },
              capabilities: [
                { id: "supertag.coordination", version: 1 },
                REPORTED_COST_LIMIT_CAPABILITY,
              ],
              contextTypes: [],
            },
          ],
          id: "fixture-worker",
          type: "test",
          profiles: [{ id: "default", revision: "1" }],
          capabilities: [
            { id: "supertag.coordination", version: 1 },
            REPORTED_COST_LIMIT_CAPABILITY,
          ],
          contextTypes: [],
          maxConcurrency: 2,
        };
      },
      async *execute(spec, signal) {
        if (!signal) throw new Error("Controller must supply execution cancellation");
        yield {
          type: "execution.started",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          workerId: "fixture-worker",
        };
        await Promise.race([
          failureRequested,
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        signal.throwIfAborted();
        if (options.workerFailure) {
          yield {
            type: "execution.failed",
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            at: new Date().toISOString(),
            error: options.workerFailure,
          };
          if (options.afterFailure) throw new Error(options.afterFailure);
          return;
        }
        yield {
          type: "execution.failed",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          error: { name: "Error", message: "Fixture execution failure" },
        };
      },
    };
    const onError = vi.fn();
    const controller = new ObjectiveController(
      store,
      durableTestWorklet(new LocalWorklet("fixture", "fixture", [runtimeWorker])),
      onError,
    );
    controller.activateCoordination({ url: "http://fixture.invalid" });
    cleanups.push(() => controller.stop());
    const assigned = (await controller.command("assign_task", {
      objectiveId: objective.id,
      taskId: randomUUID(),
      teamId: team.id,
      assignedTagId: lead.id,
      instruction: "Lead research",
      acceptanceCriteria: ["Evidence gathered"],
      ...(options.managerCostMinor === undefined ? {} : { maxCostMinor: options.managerCostMinor }),
      ...(options.managerExecution === undefined ? {} : { execution: options.managerExecution }),
    })) as TaskAssignment;
    controller.start();
    await expect
      .poll(async () => (await store.getTaskAssignment(assigned.taskId))?.status)
      .toBe("running");
    await expect.poll(async () => (await store.listTaskAttempts(assigned.taskId)).length).toBe(1);
    const caller = await store.getTaskAssignment(assigned.taskId);
    if (!caller?.leaseOwner) throw new Error("Missing controller execution lease");
    const activate = async (task: TaskAssignment) => {
      // Independent assignments get real leases and canonical Attempts under
      // the same controller identity, without fabricating caller state.
      if (task.assignedTagId === caller.assignedTagId)
        await store.cancelTaskAssignment(caller.taskId, owner.id);
      const claimed = await store.claimTaskAssignment({
        taskId: task.taskId,
        leaseOwner: caller.leaseOwner as string,
      });
      if (!claimed) throw new Error("Fixture assignment could not acquire execution authority");
      await store.createTaskAttempt({
        workerProfile: { id: "default", revision: "1" },
        taskId: task.taskId,
        attemptNumber: claimed.attemptCount,
        workerSnapshot: {},
        startedAt: new Date().toISOString(),
      });
      await store.startTask({ taskId: task.taskId, startedAt: new Date().toISOString() });
      return claimed;
    };
    return {
      store,
      controller,
      owner,
      lead,
      worker,
      objective,
      other,
      team,
      caller,
      activate,
      failExecution,
      onError,
    };
  }
  it("rejects Task admission for an unbound Tag with actionable guidance", async () => {
    const f = await fixture();
    await f.store.unbindTagWorkerHost(f.worker.id, "fixture");
    await expect(
      f.controller.commandAsAdministrator("assign_task", {
        objectiveId: f.objective.id,
        taskId: randomUUID(),
        teamId: f.team.id,
        assignedTagId: f.worker.id,
        instruction: "Research the issue",
        acceptanceCriteria: ["Evidence gathered"],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Bind a Worker Host"),
    });
  });
  it.each([
    ["HarnessProviderError", "harness"],
    ["WorkspaceSetupError", "workspace-setup"],
    ["WorkspaceIntegrityError", "workspace-integrity"],
    ["Error", undefined],
  ])("persists failure provenance from Worker events (%s)", async (name, failureKind) => {
    const message = "Authentication failed";
    const f = await fixture({ workerFailure: { name: name as string, message } });
    f.failExecution();
    await expect
      .poll(async () => (await f.store.getTaskAssignment(f.caller.taskId))?.status)
      .toBe("failed");
    const task = await f.store.getTaskAssignment(f.caller.taskId);
    expect(task?.result?.["error"]).toBe(message);
    expect(task?.result?.["failureKind"]).toBe(failureKind);
    expect(await f.store.listTaskEvents(f.caller.taskId)).toContainEqual(
      expect.objectContaining({
        type: "execution.failed",
        payload: expect.objectContaining({ error: { name, message } }),
      }),
    );
  });

  it("fails the Task with the later error when another error ends the stream", async () => {
    // A Worker that throws after its terminal event fails the Attempt and frees its slot
    // (reliability-alpha): the result error appends the later exception to the provider
    // failure instead of reporting the provider failure alone.
    const f = await fixture({
      workerFailure: { name: "HarnessProviderError", message: "Please run /login" },
      afterFailure: "git Authentication failed",
    });
    f.failExecution();
    await expect
      .poll(async () => (await f.store.getTaskAssignment(f.caller.taskId))?.status)
      .toBe("failed");
    const task = await f.store.getTaskAssignment(f.caller.taskId);
    expect(task?.uncertainAttempt).toBeNull();
    expect(task?.result?.["error"]).toBe("Please run /login; Error: git Authentication failed");
    expect(task?.result?.["error"]).not.toBe("Please run /login");
    expect((await f.store.listTaskAttempts(f.caller.taskId))[0]?.status).toBe("failed");
    await expect.poll(() => f.controller.activeCount).toBe(0);
  });

  it.each([false, true])(
    "settles failure and its Attempt under one authority fence (rejected=%s)",
    async (rejected) => {
      const f = await fixture();
      const settle = vi.spyOn(f.store, "settleTaskAssignment");
      const close = vi.spyOn(f.store, "closeTaskAttempt");
      const storageError = new Error("Storage unavailable");
      if (rejected) settle.mockRejectedValue(storageError);
      const [attempt] = await f.store.listTaskAttempts(f.caller.taskId);
      f.failExecution();
      await expect.poll(() => f.controller.activeCount).toBe(0);
      expect(settle).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: f.caller.taskId,
          leaseOwner: f.caller.leaseOwner,
          attemptCount: f.caller.attemptCount,
          failed: true,
          terminalAttempt: { id: attempt?.id, status: "failed" },
        }),
      );
      expect(close).not.toHaveBeenCalled();
      if (rejected) expect(f.onError).toHaveBeenCalledWith(storageError);
      expect((await f.store.listTaskAttempts(f.caller.taskId))[0]?.status).toBe(
        rejected ? "running" : "failed",
      );
    },
  );
  it("scopes attempts to one Objective and hides Tasks in other Objectives", async () => {
    const f = await fixture();
    await expect(
      f.controller.command("read_objective", { objectiveId: f.other.id }, f.caller),
    ).rejects.toMatchObject({ statusCode: 403 });
    const otherTeam = await f.store.createTeam({
      id: randomUUID(),
      objectiveId: f.other.id,
      name: "Other",
      leadTagId: f.owner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    const otherTask = (await f.controller.command("assign_task", {
      objectiveId: f.other.id,
      taskId: randomUUID(),
      teamId: otherTeam.id,
      assignedTagId: f.owner.id,
      instruction: "Other work",
      acceptanceCriteria: ["Done"],
    })) as TaskAssignment;
    await expect(
      f.controller.command("read_task", { taskId: otherTask.taskId }, f.caller),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.controller.command(
        "assign_task",
        {
          taskId: randomUUID(),
          teamId: otherTeam.id,
          assignedTagId: f.owner.id,
          instruction: "Escaped work",
          acceptanceCriteria: ["Done"],
        },
        f.caller,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("refuses execution limits no connected Worker Profile enforces at assignment", async () => {
    const f = await fixture();
    await expect(
      f.controller.command(
        "assign_task",
        {
          taskId: randomUUID(),
          teamId: f.team.id,
          assignedTagId: f.worker.id,
          instruction: "Implement with an enforced native agent ceiling",
          acceptanceCriteria: ["Implementation completed"],
          execution: { limits: { maxNativeAgents: 1 } },
        },
        f.caller,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("enforces execution.limits.maxNativeAgents"),
    });
  });
  it("turns an incompatible delegated assignment into durable manager work", async () => {
    const f = await fixture({
      budgetLimitMinor: 100,
      budgetCurrency: "USD",
      managerCostMinor: 10,
      managerExecution: {
        limits: { maxReportedCost: { amountMinor: 10, currency: "USD" } },
      },
    });
    const blockedTaskId = randomUUID();
    const managerTaskId = await taskFollowupId(`${blockedTaskId}:scheduling`);
    const admit = f.store.admitTaskAssignment.bind(f.store);
    let rejectManagerAdmission = true;
    const admissions = vi
      .spyOn(f.store, "admitTaskAssignment")
      .mockImplementation(async (input) => {
        if (input.taskId === managerTaskId && rejectManagerAdmission) {
          rejectManagerAdmission = false;
          throw new Error("Transient manager Task admission failure");
        }
        return admit(input);
      });
    const blocked = (await f.controller.command(
      "assign_task",
      {
        taskId: blockedTaskId,
        teamId: f.team.id,
        assignedTagId: f.worker.id,
        instruction: "Implement on a GPU Worker",
        acceptanceCriteria: ["Implementation completed"],
        execution: { requires: [{ id: "example.gpu", version: 1 }] },
      },
      f.caller,
    )) as TaskAssignment;

    await expect
      .poll(
        async () =>
          (await f.store.listTaskEvents(blocked.taskId)).find(
            (event) => event.type === "task.scheduling-incompatible",
          )?.payload,
      )
      .toMatchObject({
        status: "incompatible",
        unmetRequirements: ["execution.requires.example.gpu@1"],
      });
    const visible = (await f.controller.command(
      "read_task",
      { taskId: blocked.taskId },
      f.caller,
    )) as TaskAssignment & {
      scheduling: { status: string; unmetRequirements: readonly string[] };
    };
    expect(visible.scheduling).toMatchObject({
      status: "incompatible",
      unmetRequirements: ["execution.requires.example.gpu@1"],
    });

    await expect
      .poll(() =>
        f.onError.mock.calls.some(
          ([error]) =>
            error instanceof Error && error.message === "Transient manager Task admission failure",
        ),
      )
      .toBe(true);
    await expect
      .poll(async () => f.store.getTaskAssignment(managerTaskId))
      .toMatchObject({
        objectiveId: f.objective.id,
        teamId: f.caller.teamId,
        assignedTagId: f.caller.assignedTagId,
        requestedByTagId: f.objective.ownerTagId,
      });
    const managerTask = await f.store.getTaskAssignment(managerTaskId);
    expect(managerTask?.instruction).toContain(`Task ${blocked.taskId} cannot run`);
    expect(managerTask?.instruction).toContain("read_task");
    expect(managerTask?.parentTaskId).toBeNull();
    expect(managerTask?.reservedMinor).toBe(10);
    expect((await f.store.findTaskById(managerTaskId))?.execution).toMatchObject({
      limits: { maxReportedCost: { amountMinor: 10, currency: "USD" } },
    });
    expect(await f.store.getObjective(f.objective.id)).toMatchObject({
      spentMinor: 10,
      reservedMinor: 10,
    });
    expect(admissions.mock.calls.filter(([input]) => input.taskId === managerTaskId)).toHaveLength(
      2,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      (await f.store.listTaskEvents(blocked.taskId)).filter(
        (event) => event.type === "task.scheduling-incompatible",
      ),
    ).toHaveLength(1);
  });
  it("records which running Tasks fill the Worker a queued Task waits for", async () => {
    const f = await fixture();
    const wide = await f.store.createTeam({
      id: randomUUID(),
      objectiveId: f.objective.id,
      name: "Builders",
      leadTagId: f.lead.id,
      memberTagIds: [f.worker.id],
      maxConcurrency: 5,
    });
    const assign = async () =>
      (await f.controller.command("assign_task", {
        objectiveId: f.objective.id,
        taskId: randomUUID(),
        teamId: wide.id,
        assignedTagId: f.worker.id,
        instruction: "Build",
        acceptanceCriteria: ["Built"],
      })) as TaskAssignment;
    // The lead's Task holds one of the Worker's two slots; this Task takes the other.
    const running = await assign();
    await expect
      .poll(async () => (await f.store.getTaskAssignment(running.taskId))?.status)
      .toBe("running");
    const queued = await assign();
    const wait = {
      version: 1,
      status: "waiting",
      reason: "capacity",
      hosts: [
        {
          workerHostId: "fixture",
          harnesses: [],
          capacity: 2,
          busyTaskIds: [f.caller.taskId, running.taskId].toSorted(),
        },
      ],
    };
    await expect
      .poll(
        async () =>
          (await f.store.listTaskEvents(queued.taskId)).findLast(
            (event) => event.type === "task.scheduling-waiting",
          )?.payload,
      )
      .toEqual(wait);
    expect((await f.store.getTaskAssignment(queued.taskId))?.status).toBe("queued");
    const visible = (await f.controller.command("read_task", {
      objectiveId: f.objective.id,
      taskId: queued.taskId,
    })) as TaskAssignment & { scheduling?: unknown };
    expect(visible.scheduling).toEqual(wait);
    // An unchanged wait is recorded once, not on every scheduler tick.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      (await f.store.listTaskEvents(queued.taskId)).filter(
        (event) => event.type === "task.scheduling-waiting",
      ),
    ).toHaveLength(1);
    // When a slot frees, the Task starts and the wait is resolved.
    await f.store.cancelTaskAssignment(running.taskId, f.owner.id);
    await expect
      .poll(async () => (await f.store.getTaskAssignment(queued.taskId))?.status, {
        timeout: 15000,
      })
      .toBe("running");
    expect((await f.store.listTaskEvents(queued.taskId)).map((event) => event.type)).toContain(
      "task.scheduling-compatible",
    );
  }, 30_000);

  it("records why the store declined to claim a queued Task with a free Worker", async () => {
    const f = await fixture();
    const queuedId = randomUUID();
    const decline = {
      code: "objective_activation",
      message: `Its Tag already runs ${f.caller.taskId} in this Objective; the Task starts when that Attempt ends.`,
      taskIds: [f.caller.taskId],
    } as const;
    // The store's own reasons are covered by its tests; here it declines one Task as it would.
    const claim = f.store.claimTaskAssignment.bind(f.store);
    const claims = vi.spyOn(f.store, "claimTaskAssignment").mockImplementation(async (input) => {
      if (input.taskId !== queuedId) return claim(input);
      input.onDecline?.(decline);
      return undefined;
    });
    await f.controller.command("assign_task", {
      objectiveId: f.objective.id,
      taskId: queuedId,
      teamId: f.team.id,
      assignedTagId: f.worker.id,
      instruction: "Build",
      acceptanceCriteria: ["Built"],
    });
    const wait = { version: 1, status: "waiting", reason: "claim", claim: decline };
    await expect
      .poll(
        async () =>
          (await f.store.listTaskEvents(queuedId)).findLast(
            (event) => event.type === "task.scheduling-waiting",
          )?.payload,
      )
      .toEqual(wait);
    expect((await f.store.getTaskAssignment(queuedId))?.status).toBe("queued");
    const visible = (await f.controller.command("read_task", {
      objectiveId: f.objective.id,
      taskId: queuedId,
    })) as TaskAssignment & { scheduling?: unknown };
    expect(visible.scheduling).toEqual(wait);
    // An unchanged reason is recorded once, not on every scheduler tick.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(claims.mock.calls.filter(([input]) => input.taskId === queuedId).length).toBeGreaterThan(
      1,
    );
    expect(
      (await f.store.listTaskEvents(queuedId)).filter(
        (event) => event.type === "task.scheduling-waiting",
      ),
    ).toHaveLength(1);
    // Once the claim succeeds, the Task starts and the wait is resolved.
    claims.mockRestore();
    await expect
      .poll(async () => (await f.store.getTaskAssignment(queuedId))?.status, { timeout: 15000 })
      .toBe("running");
    expect((await f.store.listTaskEvents(queuedId)).map((event) => event.type)).toContain(
      "task.scheduling-compatible",
    );
  }, 30_000);

  it("offers no placement to a Task until its dependencies are accepted", async () => {
    const f = await fixture();
    const claims = vi.spyOn(f.store, "claimTaskAssignment");
    const source = (await f.controller.command(
      "assign_task",
      {
        taskId: randomUUID(),
        teamId: f.team.id,
        assignedTagId: f.worker.id,
        instruction: "Produce implementation evidence",
        acceptanceCriteria: ["Evidence is reviewable"],
      },
      f.caller,
    )) as TaskAssignment;
    await expect
      .poll(async () => (await f.store.getTaskAssignment(source.taskId))?.status)
      .toBe("running");
    const dependent = (await f.controller.command(
      "assign_task",
      {
        taskId: randomUUID(),
        teamId: f.team.id,
        assignedTagId: f.worker.id,
        instruction: "Review the implementation",
        acceptanceCriteria: ["Review is independent"],
        dependencies: [source.taskId],
      },
      f.caller,
    )) as TaskAssignment;
    const wait = {
      version: 1,
      status: "waiting",
      reason: "dependencies",
      dependencies: [{ taskId: source.taskId, status: "running" }],
    };
    const latestScheduling = async () =>
      (await f.store.listTaskEvents(dependent.taskId)).findLast(
        (event) =>
          event.type === "task.scheduling-waiting" ||
          event.type === "task.scheduling-compatible" ||
          event.type === "task.scheduling-incompatible",
      );
    await expect.poll(async () => (await latestScheduling())?.payload).toEqual(wait);
    await expect(
      f.controller.command("read_task", { taskId: dependent.taskId }, f.caller),
    ).resolves.toMatchObject({ scheduling: wait });
    // Several ticks later: one diagnosis, no placement, and no claim was attempted.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const events = await f.store.listTaskEvents(dependent.taskId);
    expect(events.filter((event) => event.type === "task.scheduling-waiting")).toHaveLength(1);
    expect(events.filter((event) => event.type.startsWith("task.placement"))).toEqual([]);
    expect(claims.mock.calls.filter(([input]) => input.taskId === dependent.taskId)).toEqual([]);
    expect(await f.store.listTaskAttempts(dependent.taskId)).toEqual([]);

    // A submitted dependency still holds the Task; the diagnosis records the new state.
    const running = await f.store.getTaskAssignment(source.taskId);
    if (!running?.leaseOwner) throw new Error("Missing source lease");
    await f.store.settleTaskAssignment({
      taskId: source.taskId,
      leaseOwner: running.leaseOwner,
      attemptCount: running.attemptCount,
      result: { taskResult: { summary: "Ready for review" } },
    });
    await expect
      .poll(async () => (await latestScheduling())?.payload)
      .toEqual({ ...wait, dependencies: [{ taskId: source.taskId, status: "submitted" }] });
    expect(claims.mock.calls.filter(([input]) => input.taskId === dependent.taskId)).toEqual([]);

    // Once accepted, the Task is offered for placement again.
    await f.controller.command(
      "update_task",
      {
        taskId: source.taskId,
        expectedStatus: "submitted",
        status: "accepted",
        assessment: "Evidence reviewed",
      },
      f.caller,
    );
    await expect
      .poll(async () => (await latestScheduling())?.payload?.["reason"], { timeout: 15000 })
      .not.toBe("dependencies");
  }, 30_000);

  it("gives a freed slot to the Objective owner before older delegated Tasks", async () => {
    const f = await fixture();
    const team = await f.store.getTeam(f.team.id);
    const wide = await f.store.updateTeam(f.team.id, {
      expectedRevision: team.revision,
      memberTagIds: [...team.memberTagIds, f.owner.id],
      maxConcurrency: 5,
    });
    const assign = async (assignedTagId: string, instruction: string) =>
      (await f.controller.command("assign_task", {
        objectiveId: f.objective.id,
        taskId: randomUUID(),
        teamId: wide.id,
        assignedTagId,
        instruction,
        acceptanceCriteria: ["Done"],
      })) as TaskAssignment;
    // The lead's Task and one builder Task fill the Worker's two slots.
    const running = await assign(f.worker.id, "Build item 1");
    await expect
      .poll(async () => (await f.store.getTaskAssignment(running.taskId))?.status)
      .toBe("running");
    // A second builder Task queues first; the owner's review queues after it.
    const delegated = await assign(f.worker.id, "Build item 2");
    await expect
      .poll(async () =>
        (await f.store.listTaskEvents(delegated.taskId)).some(
          (event) => event.type === "task.scheduling-waiting",
        ),
      )
      .toBe(true);
    const review = await assign(f.owner.id, "Review submitted results");
    await expect
      .poll(async () =>
        (await f.store.listTaskEvents(review.taskId)).some(
          (event) => event.type === "task.scheduling-waiting",
        ),
      )
      .toBe(true);
    await f.store.cancelTaskAssignment(running.taskId, f.owner.id);
    await expect
      .poll(async () => (await f.store.getTaskAssignment(review.taskId))?.status, {
        timeout: 15000,
      })
      .toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await f.store.getTaskAssignment(delegated.taskId))?.status).toBe("queued");
  }, 30_000);

  it("starts the owner's activation in the coordination slot when delegated Tasks fill the Worker", async () => {
    const f = await fixture();
    const wide = await f.store.createTeam({
      id: randomUUID(),
      objectiveId: f.objective.id,
      name: "Builders",
      leadTagId: f.lead.id,
      memberTagIds: [f.worker.id],
    });
    const assign = async (instruction: string) =>
      (await f.controller.command("assign_task", {
        objectiveId: f.objective.id,
        taskId: randomUUID(),
        teamId: wide.id,
        assignedTagId: f.worker.id,
        instruction,
        acceptanceCriteria: ["Done"],
      })) as TaskAssignment;
    // The lead's Task and one builder Task fill the Worker's two slots; another builder waits.
    const running = await assign("Build item 1");
    await expect
      .poll(async () => (await f.store.getTaskAssignment(running.taskId))?.status)
      .toBe("running");
    const delegated = await assign("Build item 2");
    await expect
      .poll(async () =>
        (await f.store.listTaskEvents(delegated.taskId)).some(
          (event) => event.type === "task.scheduling-waiting",
        ),
      )
      .toBe(true);
    // The owner's start Task does not wait for either of them.
    const start = (await f.controller.command("start_objective", {
      objectiveId: f.objective.id,
    })) as TaskAssignment;
    await expect
      .poll(async () => (await f.store.getTaskAssignment(start.taskId))?.status, {
        timeout: 15000,
      })
      .toBe("running");
    expect((await f.store.getTaskAssignment(running.taskId))?.status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await f.store.getTaskAssignment(delegated.taskId))?.status).toBe("queued");
  }, 30_000);

  it("assigns one managerial activation for several ready child results", async () => {
    const f = await fixture();
    const hold = vi.spyOn(f.store, "listTaskAssignmentFollowups").mockResolvedValue([]);
    const children: TaskAssignment[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const child = (await f.controller.command(
          "assign_task",
          {
            taskId: randomUUID(),
            teamId: f.team.id,
            assignedTagId: f.worker.id,
            instruction: `Gather evidence ${index}`,
            acceptanceCriteria: ["Evidence"],
          },
          f.caller,
        )) as TaskAssignment;
        const active = await f.activate(child);
        if (!active.leaseOwner) throw new Error("Missing lease");
        await f.store.settleTaskAssignment({
          taskId: child.taskId,
          leaseOwner: active.leaseOwner,
          attemptCount: active.attemptCount,
          result: { text: "Evidence ready" },
        });
        children.push(child);
      }
    } finally {
      hold.mockRestore();
    }
    await expect
      .poll(async () => {
        const tasks = await f.store.listTaskAssignments(f.objective.id);
        const covered = await Promise.all(tasks.map((task) => f.store.findTaskById(task.taskId)));
        return covered.filter((task) => task?.trigger["followupSources"]);
      })
      .toHaveLength(1);
    const tasks = await f.store.listTaskAssignments(f.objective.id);
    const covered = (
      await Promise.all(tasks.map((task) => f.store.findTaskById(task.taskId)))
    ).filter((task) => task?.trigger["followupSources"]);
    expect(covered[0]?.trigger["followupSources"]).toMatchObject({
      taskIds: expect.arrayContaining(children.map((child) => child.taskId)),
    });
    expect(await f.store.listTaskAssignmentFollowups()).toEqual([]);
  });
  it("reserves inherited provider cost for a result followup exactly once", async () => {
    const f = await fixture({
      budgetLimitMinor: 100,
      budgetCurrency: "USD",
      managerCostMinor: 10,
      managerExecution: {
        limits: { maxReportedCost: { amountMinor: 10, currency: "USD" } },
      },
    });
    const child = (await f.controller.command(
      "assign_task",
      {
        taskId: randomUUID(),
        teamId: f.team.id,
        assignedTagId: f.worker.id,
        instruction: "Produce bounded evidence",
        acceptanceCriteria: ["Evidence produced"],
      },
      f.caller,
    )) as TaskAssignment;
    const active = await f.activate(child);
    if (!active.leaseOwner) throw new Error("Missing child lease");
    await f.store.settleTaskAssignment({
      taskId: child.taskId,
      leaseOwner: active.leaseOwner,
      attemptCount: active.attemptCount,
      result: { taskResult: { summary: "Bounded evidence" } },
    });

    const followupId = await taskFollowupId(child.taskId);
    await expect
      .poll(async () => f.store.getTaskAssignment(followupId))
      .toMatchObject({
        objectiveId: f.objective.id,
        reservedMinor: 10,
      });
    expect((await f.store.findTaskById(followupId))?.execution).toMatchObject({
      limits: { maxReportedCost: { amountMinor: 10, currency: "USD" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      (await f.store.listTaskAssignments(f.objective.id)).filter(
        (task) => task.taskId === followupId,
      ),
    ).toHaveLength(1);
    expect(await f.store.getObjective(f.objective.id)).toMatchObject({
      spentMinor: 20,
      reservedMinor: 0,
    });

    await f.store.cancelTaskAssignment(followupId, f.owner.id);
    expect(await f.store.getObjective(f.objective.id)).toMatchObject({
      spentMinor: 20,
      reservedMinor: 0,
    });
  });
  it("includes dependency blockers and responsible reviewers when reading one Task", async () => {
    const f = await fixture();
    const source = (await f.controller.command(
      "assign_task",
      {
        taskId: randomUUID(),
        teamId: f.team.id,
        assignedTagId: f.worker.id,
        instruction: "Produce implementation evidence",
        acceptanceCriteria: ["Evidence is reviewable"],
      },
      f.caller,
    )) as TaskAssignment;
    const active = await f.activate(source);
    if (!active.leaseOwner) throw new Error("Missing source lease");
    await f.store.settleTaskAssignment({
      taskId: source.taskId,
      leaseOwner: active.leaseOwner,
      attemptCount: active.attemptCount,
      result: { taskResult: { summary: "Ready for review" } },
    });
    const dependent = (await f.controller.command(
      "assign_task",
      {
        taskId: randomUUID(),
        teamId: f.team.id,
        assignedTagId: f.worker.id,
        instruction: "Review the implementation",
        acceptanceCriteria: ["Review is independent"],
        dependencies: [source.taskId],
      },
      f.caller,
    )) as TaskAssignment;

    const detail = (await f.controller.command(
      "read_task",
      { taskId: dependent.taskId },
      f.caller,
    )) as TaskAssignment & {
      blocking: {
        dependencies: Array<{ taskId: string; status: string; state: string }>;
        blockers: Array<{ kind: string; taskId?: string }>;
        nextActorTagIds: string[];
      };
    };
    expect(detail.blocking).toMatchObject({
      dependencies: [{ taskId: source.taskId, status: "submitted", state: "pending" }],
      blockers: [{ kind: "dependency", taskId: source.taskId }],
      nextActorTagIds: expect.arrayContaining([f.lead.id]),
    });
    const sourceDetail = (await f.controller.command(
      "read_task",
      { taskId: source.taskId },
      f.caller,
    )) as TaskAssignment & {
      blocking: { dependents: Array<{ taskId: string; status: string; assignedTagId: string }> };
    };
    expect(sourceDetail.blocking.dependents).toContainEqual({
      taskId: dependent.taskId,
      status: "queued",
      assignedTagId: f.worker.id,
    });
  });
  it("bounds commitment views and applies the same visibility as assignment reads", async () => {
    const f = await fixture();
    const hiddenTeam = await f.store.createTeam({
      id: randomUUID(),
      objectiveId: f.objective.id,
      name: "Private",
      leadTagId: f.owner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    const hidden = (await f.controller.command("assign_task", {
      objectiveId: f.objective.id,
      taskId: randomUUID(),
      teamId: hiddenTeam.id,
      assignedTagId: f.owner.id,
      instruction: "Private evidence",
      acceptanceCriteria: ["Private"],
    })) as TaskAssignment;
    const view = (await f.controller.command("read_commitments", { limit: 1 }, f.caller)) as {
      commitments: Array<{ taskId: string }>;
      total: number;
      nextOffset: number | null;
    };
    expect(view.commitments.map((entry) => entry.taskId)).toEqual([f.caller.taskId]);
    expect(view.total).toBe(1);
    expect(view.nextOffset).toBeNull();
    expect(JSON.stringify(view)).not.toContain(hidden.taskId);
    const admin = (await f.controller.command("read_commitments", {
      objectiveId: f.objective.id,
      limit: 1,
    })) as typeof view;
    expect(admin.total).toBe(2);
    expect(admin.nextOffset).toBe(1);
    const second = (await f.controller.command("read_commitments", {
      objectiveId: f.objective.id,
      limit: 1,
      offset: 1,
    })) as typeof view;
    expect(second.commitments).toHaveLength(1);
    expect(second.commitments[0]?.taskId).not.toBe(admin.commitments[0]?.taskId);
    for (const args of [
      { limit: 101 },
      { limit: 0 },
      { offset: -1 },
      { offset: 1.5 },
      { teamId: hiddenTeam.id },
    ])
      await expect(f.controller.command("read_commitments", args, f.caller)).rejects.toMatchObject({
        statusCode: 400,
      });
    await expect(
      f.controller.command("read_commitments", { objectiveId: f.other.id }, f.caller),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("does not resolve hidden dependency details in a visible commitment", async () => {
    const f = await fixture();
    const hiddenTeam = await f.store.createTeam({
      id: randomUUID(),
      objectiveId: f.objective.id,
      name: "Private",
      leadTagId: f.owner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    const hidden = (await f.controller.command("assign_task", {
      objectiveId: f.objective.id,
      taskId: randomUUID(),
      teamId: hiddenTeam.id,
      assignedTagId: f.owner.id,
      instruction: "SECRET_INSTRUCTION",
      acceptanceCriteria: ["Private"],
    })) as TaskAssignment;
    const dependent = (await f.controller.command("assign_task", {
      objectiveId: f.objective.id,
      taskId: randomUUID(),
      teamId: f.caller.teamId,
      assignedTagId: f.worker.id,
      instruction: "Consume dependency",
      acceptanceCriteria: ["Done"],
      dependencies: [hidden.taskId],
    })) as TaskAssignment;
    const view = (await f.controller.command("read_commitments", {}, f.caller)) as {
      commitments: Array<{ taskId: string; dependencies: unknown[] }>;
    };
    expect(view.commitments.find((task) => task.taskId === dependent.taskId)?.dependencies).toEqual(
      [
        {
          taskId: hidden.taskId,
          state: "unavailable",
          status: null,
          nextActorTagIds: [dependent.requestedByTagId],
        },
      ],
    );
    expect(view.commitments.some((task) => task.taskId === hidden.taskId)).toBe(false);
    expect(JSON.stringify(view)).not.toContain("SECRET_INSTRUCTION");
  });
  it("loads only the selected commitment page and preserves frozen artifact review provenance", async () => {
    const f = await fixture();
    const controller = new ObjectiveController(f.store, undefined);
    const digest = `sha256:${"a".repeat(64)}`;
    const artifact = {
      artifactId: "captured-output",
      path: "output.txt",
      uri: `supertag-artifact:${digest}`,
      digest,
      mediaType: "text/plain",
      provenance: {
        taskId: "source",
        attemptCount: 1,
        statusAtAdmission: "submitted",
        reviewedByTagId: null,
      },
      privateScratch: "DO_NOT_EXPOSE",
    };
    const reviewedArtifact = {
      ...artifact,
      provenance: {
        taskId: "previous-source",
        attemptCount: 2,
        statusAtAdmission: "accepted",
        reviewedByTagId: f.owner.id,
      },
    };
    const source = { ...f.caller, taskId: "source", status: "submitted" as const };
    const assignments = vi
      .spyOn(f.store, "listTaskAssignments")
      .mockResolvedValue([source, f.caller]);
    const stored = await f.store.findTaskById(f.caller.taskId);
    if (!stored) throw new Error("Missing stored assignment");
    const loaded = vi.spyOn(f.store, "findTaskById").mockResolvedValue({
      ...stored,
      trigger: {
        ...stored.trigger,
        inputArtifacts: [artifact, reviewedArtifact],
        privateScratch: "DO_NOT_EXPOSE",
      },
    });
    try {
      const read = () =>
        controller.command("read_commitments", {
          objectiveId: f.objective.id,
          limit: 1,
          offset: 1,
        }) as Promise<{ commitments: Array<{ consumedArtifacts: unknown[] }> }>;
      const before = await read();
      expect(loaded.mock.calls).toEqual([[f.caller.taskId]]);
      expect(before.commitments[0]?.consumedArtifacts).toEqual([
        {
          artifactId: artifact.artifactId,
          path: artifact.path,
          uri: artifact.uri,
          digest,
          mediaType: "text/plain",
          provenance: artifact.provenance,
        },
        {
          artifactId: artifact.artifactId,
          path: artifact.path,
          uri: artifact.uri,
          digest,
          mediaType: "text/plain",
          provenance: reviewedArtifact.provenance,
        },
      ]);
      assignments.mockResolvedValue([
        { ...source, status: "accepted", result: { reviewedByTagId: f.owner.id } },
        f.caller,
      ]);
      const after = await read();
      expect(after.commitments[0]?.consumedArtifacts).toEqual(
        before.commitments[0]?.consumedArtifacts,
      );
      expect(JSON.stringify(after)).not.toContain("DO_NOT_EXPOSE");
      const detail = (await controller.commandAsAdministrator("read_task", {
        objectiveId: f.objective.id,
        taskId: f.caller.taskId,
        limit: 1,
      })) as { inputArtifacts: unknown[]; inputPage: { nextOffset: number | null } };
      expect(detail.inputArtifacts).toHaveLength(1);
      expect(detail.inputPage.nextOffset).toBe(1);
      expect(JSON.stringify(detail)).not.toContain("DO_NOT_EXPOSE");
      const next = (await controller.commandAsAdministrator("read_task", {
        objectiveId: f.objective.id,
        taskId: f.caller.taskId,
        offset: 1,
        limit: 1,
      })) as { inputArtifacts: unknown[]; inputPage: { nextOffset: number | null } };
      expect(next.inputArtifacts).toMatchObject([{ provenance: reviewedArtifact.provenance }]);
      expect(next.inputPage.nextOffset).toBeNull();
    } finally {
      loaded.mockRestore();
      assignments.mockRestore();
    }
  });
  it("keeps human approval unavailable to agent attempts and binds approved work immutably", async () => {
    const f = await fixture();
    const input = {
      taskId: randomUUID(),
      teamId: f.team.id,
      assignedTagId: f.worker.id,
      instruction: "Publish proposed pricing",
      acceptanceCriteria: ["Approved proposal published"],
    };
    const task = (await f.controller.command(
      "assign_task",
      { ...input, requiresApproval: true },
      f.caller,
    )) as TaskAssignment;
    expect(task.approval).toBe("pending");
    expect(task.parentTaskId).toBe(f.caller.taskId);
    await expect(
      f.controller.command(
        "update_task",
        { taskId: task.taskId, expectedStatus: "queued", approval: "approved" },
        f.caller,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await f.controller.command("update_task", {
      objectiveId: f.objective.id,
      taskId: task.taskId,
      expectedStatus: "queued",
      approval: "approved",
    });
    await expect(
      f.controller.command(
        "assign_task",
        { ...input, requiresApproval: true, instruction: "Changed pricing" },
        f.caller,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.store.getTaskAssignment(task.taskId))?.instruction).toBe(input.instruction);
  });
  it("rejects authority forged in task input and restricts root Team or Tag creation", async () => {
    const f = await fixture();
    await expect(
      f.controller.command(
        "assign_task",
        {
          taskId: randomUUID(),
          teamId: f.team.id,
          assignedTagId: f.worker.id,
          instruction: "Work",
          acceptanceCriteria: ["Done"],
          requestedByTagId: f.owner.id,
        },
        f.caller,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      f.controller.command("create_tag", { name: "Unauthorized" }, f.caller),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      f.controller.command(
        "create_team",
        {
          id: randomUUID(),
          name: "Independent",
          leadTagId: f.lead.id,
          memberTagIds: [f.worker.id],
          maxConcurrency: 1,
        },
        f.caller,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("allows a Team lead to delegate within its Team but not grant arbitrary membership", async () => {
    const f = await fixture();
    const task = (await f.controller.command(
      "assign_task",
      {
        taskId: randomUUID(),
        teamId: f.team.id,
        assignedTagId: f.worker.id,
        instruction: "Research",
        acceptanceCriteria: ["Evidence"],
      },
      f.caller,
    )) as TaskAssignment;
    expect(task.requestedByTagId).toBe(f.lead.id);
    await expect(
      f.controller.command(
        "assign_task",
        {
          taskId: randomUUID(),
          teamId: f.team.id,
          assignedTagId: f.owner.id,
          instruction: "Unscoped",
          acceptanceCriteria: ["Done"],
        },
        f.caller,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("composes Team context, Task priority, and governance through resource updates", async () => {
    const f = await fixture();
    const child = (await f.controller.command(
      "assign_task",
      {
        taskId: randomUUID(),
        teamId: f.team.id,
        assignedTagId: f.worker.id,
        instruction: "Apply the reviewed scheduling rule",
        acceptanceCriteria: ["Rule applied"],
      },
      f.caller,
    )) as TaskAssignment;
    const prioritized = (await f.controller.command(
      "update_task",
      {
        taskId: child.taskId,
        expectedStatus: "queued",
        priority: "urgent",
      },
      f.caller,
    )) as TaskAssignment;
    expect(prioritized.priority).toBe("urgent");
    await expect(
      f.controller.command(
        "update_task",
        {
          taskId: child.taskId,
          expectedStatus: "submitted",
          priority: "low",
        },
        f.caller,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const contextualized = (await f.controller.command(
      "update_team",
      {
        teamId: f.team.id,
        expectedRevision: f.team.revision,
        context: {
          schedulingRule: {
            statement: "Adjacent intervals use strict boundaries",
            evidence: [`task:${child.taskId}`],
          },
        },
      },
      f.caller,
    )) as { revision: number; context: Record<string, unknown> };
    expect(contextualized.context).toHaveProperty("schedulingRule");
    const read = (await f.controller.command("read_team", {}, f.caller)) as {
      context: Record<string, unknown>;
      tasks: TaskAssignment[];
      objectives: Array<{ id: string; outcome: string; status: string }>;
    };
    expect(read.context).toEqual(contextualized.context);
    expect(read.tasks.some((task) => task.taskId === child.taskId)).toBe(true);
    expect(read.objectives).toEqual([
      expect.objectContaining({
        id: f.objective.id,
        outcome: f.objective.outcome,
        status: f.objective.status,
      }),
    ]);

    const linked = await f.store.updateTeam(f.team.id, {
      expectedRevision: contextualized.revision,
      objectiveIds: [f.other.id],
    });
    const linkedRead = (await f.controller.command("read_team", {}, f.caller)) as {
      objectives: Array<{ id: string; outcome: string; status: string }>;
    };
    expect(linkedRead.objectives).toEqual([
      expect.objectContaining({ id: f.objective.id, outcome: f.objective.outcome }),
      expect.objectContaining({ id: f.other.id, outcome: f.other.outcome }),
    ]);
    const transferred = (await f.controller.command("update_team", {
      objectiveId: f.objective.id,
      teamId: f.team.id,
      expectedRevision: linked.revision,
      governingObjectiveId: f.other.id,
    })) as {
      objectiveId: string;
      objectiveIds: readonly string[];
      context: Record<string, unknown>;
    };
    expect(transferred.objectiveId).toBe(f.other.id);
    expect(transferred.objectiveIds).toContain(f.objective.id);
    expect(transferred.context).toEqual(contextualized.context);
  });
  it("projects hierarchy and labels only authorized Team and owner destinations", async () => {
    const f = await fixture();
    const child = await f.store.createTeam({
      id: randomUUID(),
      objectiveId: f.objective.id,
      name: "Research operations",
      leadTagId: f.worker.id,
      memberTagIds: [],
      parentTeamId: f.team.id,
      maxConcurrency: 1,
    });
    const peer = await f.store.createTeam({
      id: randomUUID(),
      objectiveId: f.objective.id,
      name: "Customer evidence",
      leadTagId: f.worker.id,
      memberTagIds: [f.lead.id],
      maxConcurrency: 1,
    });
    await f.store.setTagMessagingGrant({
      senderTagId: f.lead.id,
      recipientTagId: f.worker.id,
      messageTypes: ["message", "progress.updated"],
    });
    await f.store.setTagMessagingGrant({
      senderTagId: f.lead.id,
      recipientTagId: f.owner.id,
      messageTypes: ["message"],
    });

    const root = (await f.controller.command("read_team", {}, f.caller)) as {
      governingObjective: {
        id: string;
        ownerTagId: string;
        ownerDestination: {
          recipientTagId: string;
          relationship: string;
          messageTypes: readonly string[];
        } | null;
      };
      hierarchy: {
        parent: { id: string } | null;
        children: Array<{ id: string; leadTagId: string }>;
      };
      destinations: Array<{ teamId: string; relationship: string; messageTypes: string[] }>;
    };
    expect(root.governingObjective).toMatchObject({
      id: f.objective.id,
      ownerTagId: f.owner.id,
      ownerDestination: {
        recipientTagId: f.owner.id,
        relationship: "governing_objective_owner",
        messageTypes: ["message"],
      },
    });
    expect(root.hierarchy).toEqual({
      parent: null,
      children: [expect.objectContaining({ id: child.id, leadTagId: f.worker.id })],
    });
    expect(root.destinations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ teamId: child.id, relationship: "child" }),
        expect.objectContaining({ teamId: peer.id, relationship: "peer" }),
      ]),
    );
    expect(root.destinations).toContainEqual(
      expect.objectContaining({
        teamId: f.team.id,
        relationship: "current",
        messageTypes: expect.arrayContaining(["note", "question", "blocker"]),
      }),
    );

    await f.store.setTagMessagingGrant({
      senderTagId: f.lead.id,
      recipientTagId: f.lead.id,
      messageTypes: ["message"],
    });
    const nested = (await f.controller.command("read_team", { teamId: child.id }, f.caller)) as {
      hierarchy: { parent: { id: string; leadTagId: string } | null };
      destinations: Array<{ teamId: string; relationship: string }>;
    };
    expect(nested.hierarchy.parent).toMatchObject({ id: f.team.id, leadTagId: f.lead.id });
    expect(nested.destinations).toContainEqual(
      expect.objectContaining({ teamId: f.team.id, relationship: "parent" }),
    );
  });
  it("cannot expand delegated runtime authority when assigning child work", async () => {
    const f = await fixture();
    const original = await f.store.findTaskById(f.caller.taskId);
    if (!original) throw new Error("Missing canonical assignment");
    const narrowed = await f.store.admitTaskAssignment({
      taskId: randomUUID(),
      objectiveId: f.objective.id,
      teamId: f.team.id,
      requestedByTagId: f.owner.id,
      assignedTagId: f.lead.id,
      instruction: "Read-only research",
      acceptanceCriteria: ["Evidence"],
      execution: original.execution,
      contextPlan: original.contextPlan,
      workspacePlan: original.workspacePlan,
      authorizationSnapshot: { ...original.authorizationSnapshot, runtimeActions: ["test.read"] },
    });
    const child = (await f.controller.command(
      "assign_task",
      {
        taskId: randomUUID(),
        teamId: f.team.id,
        assignedTagId: f.worker.id,
        instruction: "Read-only delegated research",
        acceptanceCriteria: ["Evidence"],
      },
      await f.activate(narrowed),
    )) as TaskAssignment;
    expect(
      (await f.store.findTaskById(child.taskId))?.authorizationSnapshot.runtimeActions,
    ).toEqual(["test.read"]);
  });
  it("shares a Team's channel with its members and lets the Objective owner only read it", async () => {
    const f = await fixture();
    for (const name of ["create_workstream", "update_workstream"])
      await expect(
        f.controller.command(
          name,
          { id: randomUUID(), title: "Research evidence", participantTagIds: [f.worker.id] },
          f.caller,
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    const post = (await f.controller.command(
      "post_workstream",
      { workstreamId: f.team.id, body: "Research evidence", idempotencyKey: "lead-post" },
      f.caller,
    )) as { authorTagId: string; type: string; to: readonly string[] };
    expect(post).toMatchObject({ authorTagId: f.lead.id, type: "note", to: [] });
    const member = (await f.controller.command("assign_task", {
      objectiveId: f.objective.id,
      taskId: randomUUID(),
      teamId: f.team.id,
      assignedTagId: f.worker.id,
      instruction: "Research",
      acceptanceCriteria: ["Evidence"],
    })) as TaskAssignment;
    const read = (await f.controller.command(
      "read_workstream",
      { workstreamId: f.team.id },
      await f.activate(member),
    )) as { ownerTagId: string; participantTagIds: readonly string[]; posts: readonly unknown[] };
    expect(read.ownerTagId).toBe(f.lead.id);
    expect(read.participantTagIds).toEqual([f.lead.id, f.worker.id].sort());
    expect(read.posts).toHaveLength(1);
    // An administrative call acts as the Objective owner, who reads but is not a member.
    await expect(
      f.controller.command("read_workstream", {
        objectiveId: f.objective.id,
        workstreamId: f.team.id,
      }),
    ).resolves.toMatchObject({ posts: [expect.objectContaining({ body: "Research evidence" })] });
    await expect(
      f.controller.command("post_workstream", {
        objectiveId: f.objective.id,
        workstreamId: f.team.id,
        body: "Owner note",
        idempotencyKey: "owner-post",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("requires an explicit Attempt caller without changing administrative compatibility", async () => {
    const f = await fixture();
    await expect(
      f.controller.commandAsAdministrator("read_objective", { objectiveId: f.objective.id }),
    ).resolves.toMatchObject({ id: f.objective.id });
    await expect(
      f.controller.commandAsAttempt("read_objective", {}, f.caller),
    ).resolves.toMatchObject({ id: f.objective.id });
    // JavaScript callers are not protected by the required TypeScript argument.
    for (const missing of [undefined, null, false, 0, ""]) {
      await expect(
        Reflect.apply(f.controller.commandAsAttempt, f.controller, [
          "read_objective",
          { objectiveId: f.objective.id },
          missing,
        ]),
      ).rejects.toMatchObject({ statusCode: 401 });
    }
    await expect(
      f.controller.command("read_objective", { objectiveId: f.objective.id }),
    ).resolves.toMatchObject({ id: f.objective.id });
  });
  it("bounds Attempt summaries without changing administrative detail or visibility", async () => {
    const f = await fixture();
    const original = await f.store.listTaskAssignments(f.objective.id);
    const huge = "Result evidence ".repeat(6000);
    const visible = { ...f.caller, result: { text: huge } };
    const hidden = {
      ...visible,
      taskId: "hidden",
      assignedTagId: "other",
      requestedByTagId: "other",
      teamId: "other",
    };
    vi.spyOn(f.store, "listTaskAssignments").mockResolvedValue([visible, hidden]);
    const summary = (await f.controller.commandAsAttempt(
      "read_objective",
      { limit: 1, offset: 0 },
      f.caller,
    )) as { tasks: { taskId: string }[]; pages: { tasks: { total: number } } };
    expect(summary.tasks.map((task) => task.taskId)).toEqual([f.caller.taskId]);
    expect(summary.pages.tasks.total).toBe(1);
    expect(JSON.stringify(summary)).not.toContain(huge);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(32768);
    vi.mocked(f.store.listTaskAssignments).mockResolvedValue([visible, ...original.slice(1)]);
    const admin = await f.controller.commandAsAdministrator("read_objective", {
      objectiveId: f.objective.id,
    });
    expect(JSON.stringify(admin)).toContain(huge);
  });
  it("projects organizational and provider budget evidence through Objective and Task reads", async () => {
    const f = await fixture();
    const objective = (await f.controller.commandAsAdministrator("read_objective", {
      objectiveId: f.objective.id,
    })) as {
      budget: {
        organizational: { currency: string | null; chargedMinor: number };
        provider: { coverage: { completeForVisibleTasks: boolean } };
      };
      tasks: readonly { taskId: string; budget: unknown }[];
    };
    expect(objective.budget).toMatchObject({
      organizational: { currency: null, chargedMinor: 0 },
      provider: { coverage: { scope: "visible_tasks", completeForVisibleTasks: true } },
    });
    expect(objective.tasks.find((task) => task.taskId === f.caller.taskId)?.budget).toBeDefined();

    await expect(
      f.controller.commandAsAdministrator("read_task", {
        objectiveId: f.objective.id,
        taskId: f.caller.taskId,
      }),
    ).resolves.toMatchObject({
      taskId: f.caller.taskId,
      budget: {
        organizational: { currency: null, limitMinor: 0, chargedMinor: 0 },
        provider: {
          objectiveCurrencyComparison: "internal_units",
          coverage: { status: "not_applicable", complete: true },
        },
      },
    });
  });
  it("rechecks retained caller snapshots after wait registration", async () => {
    const f = await fixture();
    if (!f.caller.leaseOwner) throw new Error("Missing lease");
    await f.store.registerTaskAssignmentWait({
      taskId: f.caller.taskId,
      leaseOwner: f.caller.leaseOwner,
      attemptCount: f.caller.attemptCount,
      notBefore: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(
      f.controller.commandAsAttempt("read_objective", {}, f.caller),
    ).rejects.toMatchObject({
      statusCode: 401,
    });
  });
  it("rejects absent, malformed, and forged execution credentials", async () => {
    const f = await fixture();
    for (const token of [
      undefined,
      "bad",
      `${Buffer.from(JSON.stringify({ id: f.caller.taskId, attempt: 1 })).toString("base64url")}.forged`,
    ])
      await expect(f.controller.authenticate(token)).rejects.toMatchObject({ statusCode: 401 });
  });
});
