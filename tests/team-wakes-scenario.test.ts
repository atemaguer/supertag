import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskAssignment } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { TEAM_REPLY_COALESCE_WINDOW_MS } from "../packages/store/src/team-reply-triggers.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const FAKE_COST_MINOR = 5;
const postgres = process.env["SUPERTAG_POSTGRES_URL"];

// Measure only activations caused by these two messages, excluding Objective setup.
// Baseline d77140c6 (source-derived, not executed): enqueueTagMessage records directTeamId;
// admitMailboxTaskAssignments excludes same-Team non-owner DMs. postWorkstream stores the
// blocker but creates no activation. With no registered waits, all baseline counts are zero.
// This is a deterministic admission/spend scenario, not a model-quality or latency benchmark.
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Team wakes scenario`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      vi.useRealTimers();
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    it("wakes builder B for a question and the lead for B's blocker, reporting each reply's cost", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"));
      const directory = await mkdtemp(join(tmpdir(), "supertag-wakes-scenario-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      let url = `file:${join(directory, "state.db")}`;
      if (dialect === "postgresql") {
        const isolated = await createIsolatedPostgresDatabase(postgres as string);
        url = isolated.url;
        cleanups.push(isolated.cleanup);
      }
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      const lead = await store.createTag({ name: "scenario-lead" });
      const builderA = await store.createTag({ name: "scenario-builder-a" });
      const builderB = await store.createTag({ name: "scenario-builder-b" });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: lead.id,
        outcome: "Resolve a builder question and a release blocker",
        budgetLimitMinor: 1000,
        budgetCurrency: "USD",
        runtimeActions: [],
      });
      const team = await store.createTeam({
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Scenario build",
        leadTagId: lead.id,
        memberTagIds: [builderA.id, builderB.id],
      });
      for (const tag of [lead, builderA, builderB])
        await store.bindTagWorkerHost(tag.id, "scenario-host");
      // Start execution without running a setup activation or charging its cost.
      const start = await store.admitTaskAssignment({
        taskId: randomUUID(),
        objectiveId: objective.id,
        teamId: team.id,
        requestedByTagId: lead.id,
        assignedTagId: lead.id,
        startObjectiveExecution: true,
        instruction: "Start",
        acceptanceCriteria: ["Started"],
        execution: {},
        authorizationSnapshot: {
          version: 4,
          capturedAt: new Date().toISOString(),
          tag: { id: lead.id, name: lead.name },
          origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: lead.id },
          requester: { id: lead.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        },
        contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
        workspacePlan: { version: 1, status: "none" },
      });
      await store.cancelTaskAssignment(start.taskId, lead.id);

      const activations: TaskAssignment[] = [];
      const complete = async (task: TaskAssignment, sourceId: string) => {
        const claimed = await store.claimTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "scenario",
        });
        if (!claimed) throw new Error("Scenario reply was not claimable");
        activations.push(claimed);
        const digest = await store.deliverActivationDigest({
          tagId: claimed.assignedTagId,
          objectiveId: objective.id,
        });
        expect(digest.items.map((item) => item.id)).toContain(sourceId);
        const attempt = await store.createTaskAttempt({
          taskId: claimed.taskId,
          attemptNumber: claimed.attemptCount,
          workerProfile: { id: "default", revision: "1" },
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        await store.appendTaskEvent({
          taskId: claimed.taskId,
          attemptId: attempt.id,
          type: "execution.usage.updated",
          payload: {
            usage: {
              inputTokens: 10,
              outputTokens: 10,
              cachedInputTokens: 0,
              totalTokens: 20,
              complete: true,
              reportedCost: { amountMinor: FAKE_COST_MINOR, currency: "USD" },
            },
          },
        });
        const settled = await store.settleTaskAssignment({
          taskId: claimed.taskId,
          leaseOwner: "scenario",
          attemptCount: claimed.attemptCount,
          result: { answer: "Recorded the question or blocker" },
        });
        expect(settled?.status).toBe("accepted");
      };
      const admitReply = async (recipientId: string, sourceId: string) => {
        expect(await store.admitMailboxTaskAssignments()).toEqual([]);
        vi.setSystemTime(Date.now() + TEAM_REPLY_COALESCE_WINDOW_MS);
        const admitted = await store.admitMailboxTaskAssignments();
        expect(admitted).toHaveLength(1);
        const reply = admitted[0];
        if (!reply) throw new Error("Missing scenario reply");
        expect(reply).toMatchObject({
          assignedTagId: recipientId,
          activationKind: "team_reply",
          sourceMessageId: null,
        });
        expect((await store.findTaskById(reply.taskId))?.trigger).toMatchObject({
          kind: "team_reply",
          sources: [expect.objectContaining({ itemId: sourceId })],
        });
        return reply;
      };

      const question = await store.enqueueTagMessage({
        senderTagId: builderA.id,
        recipientTagId: builderB.id,
        objectiveId: objective.id,
        type: "question",
        body: { message: "Which schema should I use for the release?" },
        idempotencyKey: "builder-a-question",
      });
      const builderReply = await admitReply(builderB.id, question.message.id);
      await complete(builderReply, question.message.id);
      const blocker = await store.postWorkstream({
        workstreamId: team.id,
        authorTagId: builderB.id,
        type: "blocker",
        body: "The release schema needs a decision from the lead.",
        idempotencyKey: "builder-b-blocker",
      });
      expect(blocker.to).toEqual([lead.id]);
      const leadReply = await admitReply(lead.id, blocker.id);
      await complete(leadReply, blocker.id);

      // Repeated admission must not produce more activations after either reply settles.
      vi.setSystemTime(Date.now() + TEAM_REPLY_COALESCE_WINDOW_MS);
      expect(await store.admitMailboxTaskAssignments()).toEqual([]);
      const assignments = await store.listTaskAssignments(objective.id);
      expect(assignments.filter((task) => task.taskId !== start.taskId)).toHaveLength(2);
      const spend = await store.readSpend({ by: "objective" });
      expect(spend.groups).toHaveLength(1);
      const measured = {
        leadWakes: activations.filter((task) => task.assignedTagId === lead.id).length,
        replyActivations: activations.filter((task) => task.activationKind === "team_reply").length,
        otherActivations: activations.filter((task) => task.activationKind !== "team_reply").length,
        reportedCostMinor: spend.groups[0]?.reportedCostByCurrency?.["USD"],
      };
      expect(measured).toEqual({
        leadWakes: 1,
        replyActivations: 2,
        otherActivations: 0,
        reportedCostMinor: 2 * FAKE_COST_MINOR,
      });
      expect(spend.groups[0]).toMatchObject({
        attempts: 2,
        unknownCostAttempts: 0,
        postTriggered: {
          attempts: 2,
          reportedCostByCurrency: { USD: 2 * FAKE_COST_MINOR },
          unknownCostAttempts: 0,
        },
      });
    });
  });
}
