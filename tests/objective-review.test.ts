import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import { LocalWorklet, type Worker } from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

const operator = { operatorId: "reviewer", scopes: { actions: ["*"] } };
const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Objective review`, () => {
    const cleanups: Array<() => Promise<unknown> | unknown> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "objective-review-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const isolated =
        dialect === "postgresql"
          ? await createIsolatedPostgresDatabase(postgres as string)
          : undefined;
      if (isolated) cleanups.push(() => isolated.cleanup());
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      const objective = await store.createObjective({
        id: `review-${randomUUID()}`,
        ownerTagId: owner.id,
        outcome: "Ship the report. A person reviews it before it counts as done.",
        budgetLimitMinor: 500,
      });
      const controller = new ObjectiveController(store, undefined);
      return { store, owner, objective, controller };
    }
    async function ownerQuestion(f: Awaited<ReturnType<typeof fixture>>, key: string) {
      const team = `${f.objective.id}:leadership`;
      if (!(await f.store.listTeams(f.objective.id)).some((item) => item.id === team))
        await f.store.createTeam({
          id: team,
          objectiveId: f.objective.id,
          name: "Leadership",
          leadTagId: f.owner.id,
          memberTagIds: [],
          maxConcurrency: 1,
        });
      const at = new Date().toISOString();
      const taskId = `${f.objective.id}:root`;
      if (!(await f.store.getTaskAssignment(taskId)))
        await f.store.admitTaskAssignment({
          taskId,
          objectiveId: f.objective.id,
          teamId: team,
          requestedByTagId: f.owner.id,
          assignedTagId: f.owner.id,
          instruction: "Ship the report",
          acceptanceCriteria: ["Reviewed"],
          execution: {},
          contextPlan: emptyTagContextPlan(at),
          workspacePlan: { version: 1, status: "none" },
          authorizationSnapshot: {
            version: 4,
            capturedAt: at,
            tag: { id: f.owner.id, name: f.owner.name },
            origin: { kind: "internal", objectiveId: f.objective.id, requestedByTagId: f.owner.id },
            requester: { id: f.owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
        });
      return (
        await f.store.enqueueObjectiveMessage({
          objectiveId: f.objective.id,
          senderTagId: f.owner.id,
          sourceTaskId: taskId,
          type: "message",
          body: { message: `Which format? (${key})` },
          idempotencyKey: key,
        })
      ).message;
    }

    async function settleOwnerMail(f: Awaited<ReturnType<typeof fixture>>) {
      for (;;) {
        const now = new Date().toISOString();
        const delivery = await f.store.claimTagMessage({
          tagId: f.owner.id,
          credentialId: "test-owner",
          now,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        if (!delivery) return;
        await f.store.settleTagMessage({
          tagId: f.owner.id,
          credentialId: "test-owner",
          messageId: delivery.message.id,
          leaseToken: delivery.leaseToken,
          now,
          status: "processed",
        });
      }
    }

    it("dry-runs creation with the same validation and stores nothing", async () => {
      const f = await fixture();
      const dry = await f.store.createObjective(
        { id: "dry-run", ownerTagId: f.owner.id, outcome: "Try it" },
        { dryRun: true },
      );
      expect(dry).toMatchObject({ id: "dry-run", status: "working", revision: 1, spentMinor: 0 });
      await expect(f.store.getObjective("dry-run")).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        f.store.createObjective(
          { id: f.objective.id, ownerTagId: f.owner.id, outcome: "Something else" },
          { dryRun: true },
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        f.store.createObjective(
          { id: "dry-run", ownerTagId: f.owner.id, outcome: "Try it", workspaces: ["missing"] },
          { dryRun: true },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    }, 60000);

    it("delivers an unsolicited operator message without changing status or budget", async () => {
      const f = await fixture();
      const sent = await f.controller.messageObjective(
        { objectiveId: f.objective.id, message: "  Please include last quarter.  " },
        operator,
      );
      expect(sent).toMatchObject({
        duplicate: false,
        repliedToMessageId: null,
        statusChange: null,
        message: {
          senderTagId: f.owner.id,
          recipientTagId: f.owner.id,
          operatorId: "reviewer",
          body: { message: "Please include last quarter." },
          status: "pending",
        },
      });
      expect(sent.guidance).toContain("has not started");
      expect(sent.message.inReplyTo).toBeUndefined();
      const objective = await f.store.getObjective(f.objective.id);
      expect(objective).toMatchObject({ status: "working", revision: 1, budgetLimitMinor: 500 });
      await expect(
        f.controller.messageObjective(
          { objectiveId: f.objective.id, message: "Hi" },
          { operatorId: "limited", scopes: { actions: ["read_mailbox"] } },
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.controller.messageObjective(
          { objectiveId: f.objective.id, message: "Hi" },
          { operatorId: "elsewhere", scopes: { actions: ["*"], objectiveIds: ["other"] } },
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.controller.messageObjective({ objectiveId: f.objective.id, message: "  " }, operator),
      ).rejects.toMatchObject({ statusCode: 400 });
    }, 60000);

    it("leaves questions pending for an unmarked message and answers only the named question", async () => {
      const f = await fixture();
      const older = await ownerQuestion(f, "older");
      const latest = await ownerQuestion(f, "latest");
      await f.store.updateObjectiveStatus(f.objective.id, {
        status: "blocked",
        expectedRevision: 1,
      });
      const unrelated = await f.controller.messageObjective(
        { objectiveId: f.objective.id, message: "Please also check the appendix." },
        operator,
      );
      expect(unrelated.repliedToMessageId).toBeNull();
      expect(unrelated.message.inReplyTo).toBeUndefined();
      expect(unrelated.statusChange).toBeNull();
      expect(unrelated.objective.status).toBe("blocked");
      expect((await f.store.getObjectiveMessage(latest.id))?.status).toBe("pending");
      await expect(
        f.controller.messageObjective(
          { objectiveId: f.objective.id, message: "Use PDF.", inReplyTo: "unknown-question" },
          operator,
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      const sent = await f.controller.messageObjective(
        {
          objectiveId: f.objective.id,
          message: "Use PDF.",
          inReplyTo: older.id,
          idempotencyKey: "answer",
        },
        operator,
      );
      expect(sent.repliedToMessageId).toBe(older.id);
      expect(sent.message.inReplyTo).toBe(older.id);
      expect(sent.statusChange).toEqual({ from: "blocked", to: "working" });
      expect(sent.objective).toMatchObject({ status: "working", revision: 3 });
      expect(await f.store.getObjectiveMessage(older.id)).toMatchObject({
        status: "replied",
        replyMessageId: sent.message.id,
        repliedByOperatorId: "reviewer",
      });
      expect((await f.store.getObjectiveMessage(latest.id))?.status).toBe("pending");
      await expect(
        f.controller.messageObjective(
          { objectiveId: f.objective.id, message: "Different answer", inReplyTo: older.id },
          operator,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      // A retry with the same key is the same delivery and changes nothing more.
      const retry = await f.controller.messageObjective(
        {
          objectiveId: f.objective.id,
          message: "Use PDF.",
          inReplyTo: older.id,
          idempotencyKey: "answer",
        },
        operator,
      );
      expect(retry).toMatchObject({
        duplicate: true,
        statusChange: null,
        message: { id: sent.message.id },
      });
      expect((await f.store.getObjective(f.objective.id)).revision).toBe(3);
      await expect(
        f.controller.messageObjective(
          { objectiveId: f.objective.id, message: "Use CSV.", idempotencyKey: "answer" },
          operator,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      const changes = await f.store.listResourceChanges({
        resourceType: "objective",
        resourceId: f.objective.id,
      });
      expect(changes.at(-1)).toMatchObject({
        operatorId: "reviewer",
        sourceMessageId: sent.message.id,
        changes: { status: { previous: "blocked", next: "working" } },
      });
    }, 60000);

    it("requests changes on a review, approves with the owner's assessment, and guards reopening", async () => {
      const f = await fixture();
      const setupQuestion = await ownerQuestion(f, "setup");
      // The owner stops for review and records its assessment.
      await f.store.updateObjectiveStatus(
        f.objective.id,
        { status: "ready_for_review", expectedRevision: 1, completionSummary: "Draft v1 ready." },
        f.owner.id,
      );
      const changes = await f.controller.messageObjective(
        { objectiveId: f.objective.id, message: "Add a summary table." },
        operator,
      );
      expect(changes.statusChange).toEqual({ from: "ready_for_review", to: "working" });
      expect(changes.objective.completionSummary).toBeNull();
      await expect(
        f.controller.approveObjective({ objectiveId: f.objective.id }, operator),
      ).rejects.toThrow("is working, not ready_for_review");
      let current = await f.store.getObjective(f.objective.id);
      await f.store.updateObjectiveStatus(
        f.objective.id,
        {
          status: "ready_for_review",
          expectedRevision: current.revision,
          completionSummary: "Draft v2 has the summary table; checks pass.",
        },
        f.owner.id,
      );
      // Approval first waits for the owner's unanswered question.
      await expect(
        f.controller.approveObjective({ objectiveId: f.objective.id }, operator),
      ).rejects.toThrow(setupQuestion.id);
      await f.store.replyToObjectiveMessage({
        messageId: setupQuestion.id,
        objectiveId: f.objective.id,
        recipientTagId: f.owner.id,
        body: { message: "Use Markdown." },
        idempotencyKey: "setup-answer",
        operatorId: "reviewer",
      });
      // Once answered, queued work and unread Mailbox messages still block completion.
      await expect(
        f.controller.approveObjective({ objectiveId: f.objective.id }, operator),
      ).rejects.toThrow("remain unsettled");
      await f.store.cancelTaskAssignment(`${f.objective.id}:root`, f.owner.id);
      await settleOwnerMail(f);
      const approved = await f.controller.approveObjective(
        { objectiveId: f.objective.id },
        operator,
      );
      expect(approved).toMatchObject({
        status: "completed",
        completionSummary: "Draft v2 has the summary table; checks pass.",
      });
      await expect(
        f.controller.approveObjective({ objectiveId: f.objective.id }, operator),
      ).rejects.toThrow("already completed");
      await expect(
        f.controller.messageObjective(
          { objectiveId: f.objective.id, message: "One more" },
          operator,
        ),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("--reopen") });
      const reopened = await f.controller.messageObjective(
        { objectiveId: f.objective.id, message: "Also cover Q4.", reopen: true },
        operator,
      );
      expect(reopened.statusChange).toEqual({ from: "completed", to: "working" });
      current = await f.store.getObjective(f.objective.id);
      expect(current).toMatchObject({ status: "working", completionSummary: null });
      expect(
        (
          await f.store.listResourceChanges({
            resourceType: "objective",
            resourceId: f.objective.id,
          })
        ).at(-1)?.changes,
      ).toEqual({
        status: { previous: "completed", next: "working" },
        completionSummary: {
          previous: "Draft v2 has the summary table; checks pass.",
          next: null,
        },
      });
      // Without a recorded assessment, approval says who approved.
      await settleOwnerMail(f);
      await f.store.updateObjectiveStatus(f.objective.id, {
        status: "ready_for_review",
        expectedRevision: current.revision,
      });
      expect(
        (await f.controller.approveObjective({ objectiveId: f.objective.id }, operator))
          .completionSummary,
      ).toBe("Approved by operator reviewer. The owner recorded no assessment.");
      expect((await f.store.getObjective(f.objective.id)).budgetLimitMinor).toBe(500);
    }, 60000);
  });

describe("operator messages wake the Objective owner", () => {
  const cleanups: Array<() => Promise<unknown> | unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("runs the owner on the message, then keeps a reopened Objective moving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "objective-review-wake-"));
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
      outcome: "Write the launch note. A person reviews it.",
    });
    const seen: Array<{ taskId: string; instruction: string; sourceMessage: unknown }> = [];
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
      async *execute(spec) {
        const at = () => new Date().toISOString();
        const context = JSON.parse(
          spec.input.messages.find((message) => message.role === "system")?.text ?? "{}",
        );
        seen.push({
          taskId: spec.taskId,
          instruction: spec.input.messages[0]?.text ?? "",
          sourceMessage: context.sourceMessage,
        });
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
          message: { role: "teammate", text: "Done for now." },
        };
        yield {
          type: "execution.completed",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: at(),
        };
      },
    };
    const controller = new ObjectiveController(
      store,
      durableTestWorklet(new LocalWorklet("fixture", "fixture", [worker])),
      () => {},
    );
    controller.activateCoordination({ url: "http://fixture.invalid" });
    cleanups.push(() => controller.stop());
    await controller.command("start_objective", { objectiveId: objective.id });
    // The owner stops for review before its activation even runs.
    await store.updateObjectiveStatus(
      objective.id,
      {
        status: "ready_for_review",
        expectedRevision: (await store.getObjective(objective.id)).revision,
        completionSummary: "Draft ready.",
      },
      owner.id,
    );
    controller.start();
    const ownerTasks = async () =>
      (await store.listTaskAssignments(objective.id)).filter(
        (task) => task.assignedTagId === owner.id,
      );
    await expect
      .poll(async () => (await ownerTasks()).map((task) => task.status), { timeout: 15000 })
      .toEqual(["accepted"]);
    // The activation closed itself; nothing wakes an owner waiting for review.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await ownerTasks()).toHaveLength(1);

    const sent = await controller.messageObjective(
      { objectiveId: objective.id, message: "Mention the pricing change." },
      operator,
    );
    expect(sent.statusChange).toEqual({ from: "ready_for_review", to: "working" });
    await expect
      .poll(
        async () =>
          (await ownerTasks()).find((task) => task.sourceMessageId === sent.message.id)?.status,
        { timeout: 15000 },
      )
      .toBe("accepted");
    const delivery = seen.find((entry) => entry.taskId === `message:${sent.message.id}`);
    expect(delivery?.instruction).toContain("An operator directing this Objective");
    expect(delivery?.sourceMessage).toMatchObject({
      operatorId: "reviewer",
      body: { message: "Mention the pricing change." },
    });
    // With the Objective working again, the owner is asked to finish the work.
    await expect
      .poll(
        async () =>
          (await ownerTasks()).some((task) =>
            task.instruction.startsWith("Your last activation ended"),
          ),
        { timeout: 15000 },
      )
      .toBe(true);

    await controller.stop();
    // Let the reopened Objective start from a completed state with its work settled.
    for (const task of await ownerTasks())
      if (["queued", "running", "waiting"].includes(task.status))
        await store.cancelTaskAssignment(task.taskId, owner.id);
    let current = await store.getObjective(objective.id);
    await store.updateObjectiveStatus(
      objective.id,
      {
        status: "ready_for_review",
        expectedRevision: current.revision,
        completionSummary: "Pricing added.",
      },
      owner.id,
    );
    expect(
      (await controller.approveObjective({ objectiveId: objective.id }, operator)).status,
    ).toBe("completed");
    const reopened = await controller.messageObjective(
      { objectiveId: objective.id, message: "Translate it too.", reopen: true },
      operator,
    );
    current = await store.getObjective(objective.id);
    expect(current.status).toBe("working");
    controller.start();
    await expect
      .poll(
        async () =>
          (await ownerTasks()).find((task) => task.sourceMessageId === reopened.message.id)?.status,
        { timeout: 15000 },
      )
      .toBe("accepted");
  }, 60000);
});
