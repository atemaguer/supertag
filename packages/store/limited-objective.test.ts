import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import type { AdmitTaskAssignmentInput } from "../core/src/index.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} limited Objectives`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-limited-objective-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(async () => {
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      });
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      const worker = await store.createTag({ name: `worker-${randomUUID()}` });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Ship the change",
        budgetCurrency: "USD",
        budgetLimitMinor: 100,
      });
      const team = await store.createTeam({
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Delivery",
        leadTagId: owner.id,
        memberTagIds: [worker.id],
        maxConcurrency: null,
      });
      const leadership = await store.createTeam({
        id: `${objective.id}:leadership`,
        objectiveId: objective.id,
        name: "Leadership",
        leadTagId: owner.id,
        memberTagIds: [owner.id],
        maxConcurrency: null,
      });
      const assignment = (taskId: string, ownerTask = false): AdmitTaskAssignmentInput => ({
        taskId,
        objectiveId: objective.id,
        teamId: ownerTask ? leadership.id : team.id,
        requestedByTagId: owner.id,
        assignedTagId: ownerTask ? owner.id : worker.id,
        instruction: "Ship",
        acceptanceCriteria: ["Done"],
        execution: {},
        maxCostMinor: 0,
        authorizationSnapshot: {
          version: 4,
          capturedAt: new Date().toISOString(),
          tag: { id: ownerTask ? owner.id : worker.id, name: ownerTask ? owner.name : worker.name },
          origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
          requester: { id: owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        },
        contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
        workspacePlan: { version: 1, status: "none" },
      });
      await store.admitTaskAssignment({
        ...assignment(`${objective.id}:start`, true),
        startObjectiveExecution: true,
      });
      await store.claimTaskAssignment({ taskId: `${objective.id}:start`, leaseOwner: "start" });
      await store.settleTaskAssignment({
        taskId: `${objective.id}:start`,
        leaseOwner: "start",
        attemptCount: 1,
        result: { text: "Delegated work" },
      });
      return { store, owner, objective, assignment };
    }

    it("lets running work finish, admits one bounded summary, and resumes on a higher budget", async () => {
      const f = await fixture();
      await f.store.admitTaskAssignment(f.assignment("running"));
      await f.store.admitTaskAssignment(f.assignment("queued-before-limit"));
      await f.store.claimTaskAssignment({ taskId: "running", leaseOwner: "worker" });
      const exhausted = await f.store.recordObjectiveLimitState(
        f.objective.id,
        {
          reportedSpend: {
            amountMinor: 110,
            currency: "USD",
            unknownAttemptIds: [],
            observedAt: new Date().toISOString(),
          },
          budgetExhausted: { limitMinor: 100, spentMinor: 110, at: new Date().toISOString() },
        },
        f.objective.revision,
      );
      expect(exhausted?.status).toBe("working");
      if (!exhausted?.limitState) throw new Error("Exhaustion was not recorded");
      expect(
        await f.store.claimTaskAssignment({ taskId: "queued-before-limit", leaseOwner: "late" }),
      ).toBeUndefined();
      await expect(f.store.admitTaskAssignment(f.assignment("new"))).rejects.toThrow(
        "budget exhausted",
      );
      expect((await f.store.getTaskAssignment("running"))?.status).toBe("running");
      await f.store.settleTaskAssignment({
        taskId: "running",
        leaseOwner: "worker",
        attemptCount: 1,
        result: { text: "Done" },
      });
      const limited = await f.store.recordObjectiveLimitState(
        f.objective.id,
        exhausted.limitState,
        exhausted.revision,
        true,
      );
      expect(limited?.status).toBe("limited");
      if (!limited) throw new Error("Objective did not become limited");
      await expect(
        f.store.updateObjectiveStatus(f.objective.id, {
          budgetLimitMinor: 200,
          expectedRevision: limited.revision,
        }),
      ).rejects.toThrow("final limit summary");
      await expect(f.store.admitTaskAssignment(f.assignment("still-new"))).rejects.toThrow();
      const summaryId = limited.limitState?.summaryTaskId;
      if (!summaryId) throw new Error("Limit summary Task was not named");
      await f.store.admitTaskAssignment({
        ...f.assignment(summaryId, true),
        limitSummaryActivation: true,
        execution: { limits: { maxReportedTokens: 4000 } },
      });
      expect((await f.store.getTaskAssignment(summaryId))?.limitSummaryActivation).toBe(true);
      await f.store.claimTaskAssignment({ taskId: summaryId, leaseOwner: "summary" });
      const summaryAttempt = await f.store.createTaskAttempt({
        taskId: summaryId,
        attemptNumber: 1,
        workerProfile: { id: "summary", revision: "1" },
        workerSnapshot: {},
        startedAt: new Date().toISOString(),
      });
      await f.store.startTask({ taskId: summaryId, startedAt: new Date().toISOString() });
      const recorded = await f.store.updateObjectiveStatus(
        f.objective.id,
        {
          status: "limited",
          expectedRevision: limited.revision,
          completionSummary:
            "Progress: implementation done. Open: review. Blockers: budget. Next: raise budget and review.",
        },
        f.owner.id,
        { taskId: summaryId, attemptCount: 1, leaseOwner: "summary" },
      );
      expect(recorded.limitState?.summary?.text).toContain("Next: raise budget");
      expect((await f.store.listTaskEvents(summaryId)).map((event) => event.type)).toContain(
        "objective.limit-summary-recorded",
      );
      expect((await f.store.listTaskEvents(summaryId)).map((event) => event.type)).not.toContain(
        "objective.completed",
      );
      await f.store.settleTaskAssignment({
        taskId: summaryId,
        leaseOwner: "summary",
        attemptCount: 1,
        terminalAttempt: { id: summaryAttempt.id, status: "completed" },
        result: { text: "Summary recorded" },
      });
      await expect(
        f.store.updateObjectiveStatus(
          f.objective.id,
          { status: "working", expectedRevision: recorded.revision },
          f.owner.id,
        ),
      ).rejects.toThrow("Only an operator");
      const resumed = await f.store.updateObjectiveStatus(f.objective.id, {
        budgetLimitMinor: 200,
        expectedRevision: recorded.revision,
      });
      expect(resumed.status).toBe("working");
      expect(resumed.limitState?.summary?.text).toBe(recorded.limitState?.summary?.text);
      expect((await f.store.listStalledObjectiveOwnerTasks()).map((task) => task.taskId)).toContain(
        summaryId,
      );
      const again = await f.store.recordObjectiveLimitState(
        f.objective.id,
        {
          ...(resumed.limitState ?? {}),
          budgetExhausted: { limitMinor: 200, spentMinor: 210, at: new Date().toISOString() },
          reportedSpend: {
            amountMinor: 210,
            currency: "USD",
            unknownAttemptIds: [],
            observedAt: new Date().toISOString(),
          },
        },
        resumed.revision,
        true,
      );
      expect(again?.limitState?.summaryTaskId).not.toBe(summaryId);
      expect(again?.limitState?.summary).toBeUndefined();
    });

    it("persists exhaustion before transitioning when a Task claimed during the drain check", async () => {
      const f = await fixture();
      await f.store.admitTaskAssignment(f.assignment("claimed-during-sweep"));
      await f.store.admitTaskAssignment(f.assignment("queued-after-claim"));
      await f.store.claimTaskAssignment({ taskId: "claimed-during-sweep", leaseOwner: "worker" });
      const state = {
        budgetExhausted: { limitMinor: 100, spentMinor: 110, at: new Date().toISOString() },
      };
      const observed = await f.store.recordObjectiveLimitState(
        f.objective.id,
        state,
        f.objective.revision,
        true,
      );
      expect(observed?.status).toBe("working");
      if (!observed) throw new Error("Exhaustion was not recorded");
      expect(observed?.limitState?.budgetExhausted).toEqual(state.budgetExhausted);
      expect(
        await f.store.claimTaskAssignment({ taskId: "queued-after-claim", leaseOwner: "late" }),
      ).toBeUndefined();
      await f.store.settleTaskAssignment({
        taskId: "claimed-during-sweep",
        leaseOwner: "worker",
        attemptCount: 1,
        result: { text: "Done" },
      });
      const limited = await f.store.recordObjectiveLimitState(
        f.objective.id,
        state,
        observed.revision,
        true,
      );
      expect(limited?.status).toBe("limited");
    });

    it("reserves summary Task IDs for the marked owner activation", async () => {
      const f = await fixture();
      await expect(
        f.store.admitTaskAssignment(f.assignment(`${f.objective.id}:limit-summary:2`)),
      ).rejects.toThrow("reserved");
      await expect(
        f.store.admitTaskAssignment(f.assignment(`${f.objective.id}:limit-summary:other`)),
      ).rejects.toThrow("reserved");
      await expect(
        f.store.admitTaskAssignment({
          ...f.assignment(`${f.objective.id}:limit-summary:2`),
          limitSummaryActivation: true,
        }),
      ).rejects.toThrow("Invalid limit summary activation");
    });

    it("resumes a deadline-limited Objective when an operator moves the deadline", async () => {
      const f = await fixture();
      const past = new Date(Date.now() - 60_000).toISOString();
      const deadlineObjective = await f.store.updateObjectiveStatus(f.objective.id, {
        deadline: past,
        expectedRevision: f.objective.revision,
      });
      const limited = await f.store.recordObjectiveLimitState(
        f.objective.id,
        {
          ...(deadlineObjective.limitState ?? {}),
          deadlinePassed: { deadline: past, at: new Date().toISOString() },
        },
        deadlineObjective.revision,
        true,
      );
      if (!limited) throw new Error("Objective did not become limited");
      await f.store.recordObjectiveLimitState(
        f.objective.id,
        {
          ...(limited.limitState ?? {}),
          summary: {
            text: "Progress: done. Open: deploy. Blocker: deadline. Next: move it.",
            at: new Date().toISOString(),
          },
        },
        limited.revision,
      );
      const resumed = await f.store.updateObjectiveStatus(f.objective.id, {
        deadline: new Date(Date.now() + 60_000).toISOString(),
        expectedRevision: limited.revision,
      });
      expect(resumed.status).toBe("working");
      expect(resumed.limitState?.summary?.text).toContain("Open: deploy");
    });
  });
}
