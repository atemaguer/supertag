import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectiveSessionKey } from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
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
      const team = await store.createTeam({
        id: randomUUID(),
        name: `Delivery ${randomUUID()}`,
        memberTagIds: [owner.id, worker.id],
      });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Ship the change",
        budgetCurrency: "USD",
        budgetLimitMinor: 100,
        teamId: team.id,
      });
      const account = await store.saveSurfaceAccount({
        provider: "slack",
        externalAccountId: randomUUID(),
        displayName: "Slack",
        authMethod: "test",
        credentialId: "test",
        status: "connected",
        configuration: {},
        verifiedAt: new Date().toISOString(),
      });
      const route = await store.addTagRoute({
        tagId: owner.id,
        surfaceAccountId: account.id,
        scope: "channel:delivery",
      });
      const ownerSession = await store.openSession({
        tagId: owner.id,
        sessionKey: objectiveSessionKey(objective.id),
        origin: {},
        objectiveId: objective.id,
        at: new Date().toISOString(),
      });
      /**
       * One turn of a Session of the Objective: the Objective's own Session, or a work Session
       * under it when `work` names one.
       */
      async function turn(tagId: string, work?: string) {
        const at = new Date().toISOString();
        const tag = tagId === owner.id ? owner : worker;
        const session =
          work === undefined
            ? ownerSession
            : await store.openSession({
                tagId,
                sessionKey: `work:${ownerSession.id}:${work}`,
                origin: {},
                parentSessionId: ownerSession.id,
                at,
              });
        const authorization = {
          version: 5,
          capturedAt: at,
          tag: { id: tag.id, name: tag.name },
          origin: {
            tagRouteId: route.id,
            surfaceAccountId: account.id,
            provider: "slack",
            scope: "channel:delivery",
          },
          requester: { id: owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        } as const;
        const eventId = randomUUID();
        const admitted = await store.admitInboundEvent({
          // Due at the turn's own time, so claiming it at that time never depends on the clock.
          availableAt: at,
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId,
          authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          event: {
            eventId,
            logicalEventId: eventId,
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: "channel:delivery",
            sessionKey: session.sessionKey,
            actor: { id: tag.id, kind: "bot" },
            internal:
              work === undefined
                ? { kind: "delivery", from: { kind: "supertag" }, reason: "objective_start" }
                : {
                    kind: "work_session",
                    startedByTaskId: eventId,
                    parentSessionId: ownerSession.id,
                    title: work,
                  },
            text: "Ship",
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: "delivery",
              target: { channelId: "delivery", threadTs: "delivery" },
            },
            source: {},
            metadata: {},
          },
        });
        const task = await store.openTask({
          inboundEventId: admitted.work.id,
          tagId,
          sessionId: session.id,
          execution: {},
          actor: { id: tag.id, kind: "bot" },
          trigger: { origin: "objective" },
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          createdAt: at,
        });
        const claimed = await store.claimDueInboundEvent({
          inboundEventId: admitted.work.id,
          leaseOwner: "summary",
          now: at,
          leaseExpiresAt: new Date(Date.parse(at) + 60_000).toISOString(),
        });
        if (claimed?.status !== "processing") throw new Error("The turn was not claimed");
        const attempt = await store.createTaskAttempt({
          taskId: task.id,
          attemptNumber: 1,
          workerProfile: { id: "default", revision: "1" },
          workerSnapshot: {},
          startedAt: at,
        });
        await store.startTask({ taskId: task.id, startedAt: at });
        return { task, attempt, inboundEventId: admitted.work.id };
      }
      async function finish(taskId: string) {
        await store.closeTask({
          taskId,
          status: "completed",
          endedAt: new Date().toISOString(),
        });
      }
      return { store, owner, worker, objective, team, turn, finish };
    }

    const spend = (amountMinor: number) => ({
      reportedSpend: {
        amountMinor,
        currency: "USD",
        unknownAttemptIds: [],
        observedAt: new Date().toISOString(),
      },
    });

    it("lets running work finish, then becomes limited and takes one bounded summary", async () => {
      const f = await fixture();
      const running = await f.turn(f.worker.id, "ship");
      const state = {
        ...spend(110),
        budgetExhausted: { limitMinor: 100, spentMinor: 110, at: new Date().toISOString() },
        // A stale summary from an earlier limit never survives a new one.
        summary: { text: "Stale", at: new Date().toISOString() },
      };
      const exhausted = await f.store.recordObjectiveLimitState(
        f.objective.id,
        state,
        f.objective.revision,
        true,
      );
      // Running work keeps its authority; the limit is recorded without the transition.
      expect(exhausted?.status).toBe("working");
      expect(exhausted?.limitState?.budgetExhausted).toEqual(state.budgetExhausted);
      if (!exhausted) throw new Error("Exhaustion was not recorded");

      await f.finish(running.task.id);
      const limited = await f.store.recordObjectiveLimitState(
        f.objective.id,
        state,
        exhausted.revision,
        true,
      );
      expect(limited?.status).toBe("limited");
      expect(limited?.limitState?.summary).toBeUndefined();
      if (!limited) throw new Error("Objective did not become limited");

      const summaryTurn = await f.turn(f.owner.id);
      const summary =
        "Progress: implementation done. Open: review. Blockers: budget. Next: raise budget and review.";
      const recorded = await f.store.updateObjectiveStatus(
        f.objective.id,
        { status: "limited", expectedRevision: limited.revision, completionSummary: summary },
        f.owner.id,
        {
          taskId: summaryTurn.task.id,
          attemptCount: summaryTurn.attempt.attemptNumber,
          leaseOwner: "summary",
        },
      );
      expect(recorded.limitState?.summary?.text).toContain("Next: raise budget");
      const events = (await f.store.listTaskEvents(summaryTurn.task.id)).map((event) => event.type);
      expect(events).toContain("objective.limit-summary-recorded");
      expect(events).not.toContain("objective.completed");
      // One summary only.
      await expect(
        f.store.updateObjectiveStatus(
          f.objective.id,
          { status: "limited", expectedRevision: recorded.revision, completionSummary: summary },
          f.owner.id,
        ),
      ).rejects.toThrow("already recorded");
    });

    it("resumes on a higher budget only for an operator, and a new limit drops the summary", async () => {
      const f = await fixture();
      const state = {
        ...spend(110),
        budgetExhausted: { limitMinor: 100, spentMinor: 110, at: new Date().toISOString() },
      };
      const limited = await f.store.recordObjectiveLimitState(
        f.objective.id,
        state,
        f.objective.revision,
        true,
      );
      if (!limited) throw new Error("Objective did not become limited");
      const summaryTurn = await f.turn(f.owner.id);
      const recorded = await f.store.updateObjectiveStatus(
        f.objective.id,
        {
          status: "limited",
          expectedRevision: limited.revision,
          completionSummary: "Progress: done. Open: review. Blockers: budget. Next: raise it.",
        },
        f.owner.id,
        {
          taskId: summaryTurn.task.id,
          attemptCount: summaryTurn.attempt.attemptNumber,
          leaseOwner: "summary",
        },
      );

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

      await f.finish(summaryTurn.task.id);
      const again = await f.store.recordObjectiveLimitState(
        f.objective.id,
        {
          ...(resumed.limitState ?? {}),
          ...spend(210),
          budgetExhausted: { limitMinor: 200, spentMinor: 210, at: new Date().toISOString() },
        },
        resumed.revision,
        true,
      );
      expect(again?.status).toBe("limited");
      expect(again?.limitState?.summary).toBeUndefined();
    });

    it("persists exhaustion before transitioning when a turn was running during the drain check", async () => {
      const f = await fixture();
      const running = await f.turn(f.worker.id, "ship");
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
      expect(observed.limitState?.budgetExhausted).toEqual(state.budgetExhausted);
      // Nothing was written at the Objective's old revision, so the sweep retries from the new one.
      expect(
        await f.store.recordObjectiveLimitState(f.objective.id, state, f.objective.revision - 1),
      ).toBeUndefined();
      await f.finish(running.task.id);
      const limited = await f.store.recordObjectiveLimitState(
        f.objective.id,
        state,
        observed.revision,
        true,
      );
      expect(limited?.status).toBe("limited");
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
