import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxSessionKey, objectiveSessionKey } from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} coordination metrics`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-coordination-metrics-"));
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
        name: `Metrics Team ${randomUUID()}`,
        memberTagIds: [owner.id, worker.id],
        maxConcurrency: 1_000,
      });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Measure coordination",
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
        scope: "channel:metrics",
      });
      const ownerSession = await store.openSession({
        tagId: owner.id,
        sessionKey: objectiveSessionKey(objective.id),
        origin: {},
        objectiveId: objective.id,
        at: new Date().toISOString(),
      });
      /** One work Session turn of the Objective, left pending. */
      async function turn(title: string) {
        const at = new Date().toISOString();
        const session = await store.openSession({
          tagId: worker.id,
          sessionKey: `work:${ownerSession.id}:${title}`,
          origin: {},
          parentSessionId: ownerSession.id,
          at,
        });
        const authorization = {
          version: 5,
          capturedAt: at,
          tag: { id: worker.id, name: worker.name },
          origin: {
            tagRouteId: route.id,
            surfaceAccountId: account.id,
            provider: "slack",
            scope: "channel:metrics",
          },
          requester: { id: owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        } as const;
        const eventId = randomUUID();
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId: worker.id,
          authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          event: {
            eventId,
            logicalEventId: eventId,
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: "channel:metrics",
            sessionKey: session.sessionKey,
            actor: { id: worker.id, kind: "bot" },
            internal: {
              kind: "work_session",
              startedByTaskId: eventId,
              parentSessionId: ownerSession.id,
              title,
            },
            text: `Measure ${title}`,
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: "metrics",
              target: { channelId: "metrics", threadTs: "metrics" },
            },
            source: {},
            metadata: {},
          },
        });
        const task = await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: worker.id,
          sessionId: session.id,
          execution: {},
          actor: { id: worker.id, kind: "bot" },
          trigger: { origin: "work_session" },
          requestText: `Measure ${title}`,
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          createdAt: at,
        });
        return { task, inboundEventId: admitted.work.id };
      }
      return { store, owner, worker, objective, team, turn, ownerSession };
    }

    it("counts every Task and inbox item beyond resource-list pagination", async () => {
      const f = await fixture();
      const tasks: string[] = [];
      for (let index = 0; index < 137; index += 1)
        tasks.push((await f.turn(`metric-task-${index}`)).task.id);
      for (const taskId of tasks.slice(0, 3))
        await f.store.createApprovalRequest({
          objectiveId: f.objective.id,
          taskId,
          attemptId: `${taskId}-attempt`,
          requestingTagId: f.worker.id,
          kind: "surface-action",
          actions: [{ target: "runtime", action: "files:write" }],
          summary: "Write the export",
          ruleSources: ["release"],
          approvers: [],
        });

      const metrics = await f.store.readCoordinationMetrics({
        asOf: "2030-01-01T00:00:00.000Z",
      });

      expect(metrics.tasks).toMatchObject({ total: 137, pending: 137 });
      expect(metrics.sessions).toBe(138);
      expect(metrics.coordinationInbox.byKind.approval).toBe(3);
      expect(metrics.coordinationInbox.pending).toBe(3);
      expect(metrics.coordinationInbox.oldestActionableAgeSeconds).toBeGreaterThan(0);
    });

    it("aggregates the latest cumulative usage and native child-agent peak", async () => {
      const f = await fixture();
      const { task, inboundEventId } = await f.turn("usage");
      const now = new Date().toISOString();
      await f.store.claimDueInboundEvent({
        inboundEventId,
        leaseOwner: "metrics-worker",
        now,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await f.store.startTask({ taskId: task.id, startedAt: now });
      const attempt = await f.store.createTaskAttempt({
        taskId: task.id,
        attemptNumber: 1,
        workerProfile: { id: "metrics", revision: "1" },
        workerSnapshot: { durableExecution: true },
        startedAt: now,
      });
      const at = now;
      for (const usage of [
        { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0, totalTokens: 5, complete: false },
        {
          inputTokens: 12,
          outputTokens: 8,
          cachedInputTokens: 1,
          totalTokens: 20,
          complete: true,
          reportedCost: { amountMinor: 7, currency: "USD" },
        },
      ])
        await f.store.appendTaskEvent({
          taskId: task.id,
          attemptId: attempt.id,
          type: "usage.updated",
          payload: { taskId: task.id, attemptId: attempt.id, at, type: "usage.updated", usage },
        });
      for (const [id, status] of [
        ["child-1", "running"],
        ["child-2", "running"],
        ["child-1", "completed"],
        ["child-2", "completed"],
      ] as const)
        await f.store.appendTaskEvent({
          taskId: task.id,
          attemptId: attempt.id,
          type: "agent.updated",
          payload: {
            taskId: task.id,
            attemptId: attempt.id,
            at,
            type: "agent.updated",
            agent: { id, parentId: "manager", status },
          },
        });
      await f.store.appendTaskEvent({
        taskId: task.id,
        attemptId: attempt.id,
        type: "execution.failed",
        payload: {
          taskId: task.id,
          attemptId: attempt.id,
          at,
          type: "execution.failed",
          error: { name: "Error", message: "Codex reported token budget exceeded" },
        },
      });

      // Read past the Attempt's lease: a durable Attempt whose lease lapsed awaits reconciliation.
      const metrics = await f.store.readCoordinationMetrics({
        asOf: "2030-01-01T00:00:00.000Z",
      });
      expect(metrics.usage).toEqual({
        reportingAttempts: 1,
        totalTokens: 20,
        incompleteAttempts: 0,
        reportedCostByCurrency: { USD: 7 },
      });
      expect(metrics.nativeAgents).toEqual({
        peakConcurrent: 2,
        tokenLimitInterruptions: 1,
        agentLimitInterruptions: 0,
      });
      expect(metrics.recovery.durableExecutionsAwaitingReconciliation).toBe(1);
    });

    it("reports durable scheduling latency, reservation outcomes, and Worker Host utilization", async () => {
      const f = await fixture();
      await f.turn("queued");
      const placed = await f.turn("placed");
      const now = new Date().toISOString();
      await f.store.claimDueInboundEvent({
        inboundEventId: placed.inboundEventId,
        leaseOwner: "scheduler",
        now,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await f.store.startTask({ taskId: placed.task.id, startedAt: now });
      const attempt = await f.store.createTaskAttempt({
        taskId: placed.task.id,
        attemptNumber: 1,
        workerProfile: { id: "metrics", revision: "1" },
        workerSnapshot: {
          selectionDurationMs: 17,
          placement: {
            workerHostId: "metrics-host",
            workletId: "metrics-worklet",
            workerId: "metrics-worker",
            reservation: { id: randomUUID(), expiresAt: "2030-01-01T00:01:00.000Z" },
          },
          workerHostId: "metrics-host",
        },
        startedAt: now,
      });
      await f.store.appendTaskEvent({
        taskId: placed.task.id,
        attemptId: attempt.id,
        type: "task.admission-rejected",
        payload: { version: 1, reason: "capacity changed" },
      });
      await f.store.enrollWorkerHost({
        id: "metrics-host",
        credentialId: "credential",
        enrolledAt: now,
      });
      await f.store.claimWorkerHostConnection({
        workerHostId: "metrics-host",
        credentialRevision: 1,
        workletId: "metrics-worklet",
        protocolVersion: 17,
        durableProtocolVersion: 1,
        workerSnapshot: { workers: [] },
        capacity: 4,
        availableSlots: 3,
        activeAttempts: 1,
        ready: true,
        observedAt: now,
      });

      const metrics = await f.store.readCoordinationMetrics({
        asOf: "2030-01-01T00:00:00.000Z",
      });
      expect(metrics.scheduling).toMatchObject({
        queued: 1,
        placedAttempts: 1,
        averagePlacementDurationMs: 17,
        maximumPlacementDurationMs: 17,
        admissionRejections: 1,
        reservations: { consumed: 1, active: 0, expired: 0 },
        workerHosts: [
          {
            id: "metrics-host",
            phase: "connected",
            activeAttempts: 1,
            capacity: 4,
            availableSlots: 3,
            utilization: 0.25,
          },
        ],
      });
      expect(metrics.scheduling.averageQueueDurationMs).toBeGreaterThanOrEqual(0);
      expect(metrics.scheduling.maximumQueueDurationMs).toBeGreaterThanOrEqual(0);
      expect(metrics.scheduling.oldestQueuedAgeSeconds).toBeGreaterThan(0);
    });

    it("reports the Mailbox messages no inbox turn has taken", async () => {
      const f = await fixture();
      await f.store.setTagMessagingGrants(f.worker.id, [f.owner.id]);
      const first = await f.store.deliverTagMessage({
        senderTagId: f.owner.id,
        recipientTagId: f.worker.id,
        objectiveId: f.objective.id,
        text: "Need durable evidence?",
        hops: 0,
      });
      await f.store.deliverTagMessage({
        senderTagId: f.owner.id,
        recipientTagId: f.worker.id,
        objectiveId: f.objective.id,
        text: "And the schedule?",
        hops: 0,
      });
      expect(await f.store.readCoordinationMetrics()).toMatchObject({
        mailbox: { pending: 2, oldestPendingAt: first.message.createdAt },
      });

      // Binding them to an inbox turn clears the backlog.
      const inbox = await f.store.openSession({
        tagId: f.worker.id,
        sessionKey: inboxSessionKey(f.worker.id),
        origin: {},
        at: new Date().toISOString(),
      });
      const turn = await f.turn("inbox-turn");
      await f.store.bindInboxMessages(turn.task.id, f.worker.id);
      expect(inbox.sessionKey).toBe(inboxSessionKey(f.worker.id));
      expect((await f.store.readCoordinationMetrics()).mailbox).toEqual({
        pending: 0,
        oldestPendingAt: null,
      });
    });
  });
}
