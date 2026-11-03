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
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Measure coordination",
      });
      const team = await store.createTeam({
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Metrics Team",
        leadTagId: owner.id,
        memberTagIds: [worker.id],
        maxConcurrency: 1_000,
      });
      const assignment = (taskId: string, requiresApproval = false): AdmitTaskAssignmentInput => ({
        taskId,
        objectiveId: objective.id,
        teamId: team.id,
        requestedByTagId: owner.id,
        assignedTagId: worker.id,
        instruction: `Measure ${taskId}`,
        acceptanceCriteria: ["Recorded"],
        requiresApproval,
        execution: {},
        authorizationSnapshot: {
          version: 4,
          capturedAt: new Date().toISOString(),
          tag: { id: worker.id, name: worker.name },
          origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
          requester: { id: owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        },
        contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
        workspacePlan: { version: 1, status: "none" },
      });
      return { store, owner, worker, objective, assignment };
    }

    it("counts every Task and TaskAssignment beyond resource-list pagination", async () => {
      const f = await fixture();
      for (let index = 0; index < 137; index += 1)
        await f.store.admitTaskAssignment(f.assignment(`metric-task-${index}`, index < 3));

      const metrics = await f.store.readCoordinationMetrics({
        asOf: "2030-01-01T00:00:00.000Z",
      });

      expect(metrics.tasks).toMatchObject({ total: 137, pending: 137 });
      expect(metrics.taskAssignments).toMatchObject({ total: 137, queued: 137 });
      expect(metrics.coordinationInbox.byKind.task_approval).toBe(3);
      expect(metrics.coordinationInbox.pending).toBe(3);
      expect(metrics.coordinationInbox.oldestActionableAgeSeconds).toBeGreaterThan(0);
    });

    it("aggregates the latest cumulative usage and native child-agent peak", async () => {
      const f = await fixture();
      const taskId = randomUUID();
      await f.store.admitTaskAssignment(f.assignment(taskId));
      await f.store.claimTaskAssignment({ taskId, leaseOwner: "metrics-worker" });
      const attempt = await f.store.createTaskAttempt({
        taskId,
        attemptNumber: 1,
        workerProfile: { id: "metrics", revision: "1" },
        workerSnapshot: {},
        startedAt: new Date().toISOString(),
      });
      const at = new Date().toISOString();
      for (const payload of [
        {
          taskId,
          attemptId: attempt.id,
          at,
          type: "usage.updated",
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cachedInputTokens: 0,
            totalTokens: 5,
            complete: false,
          },
        },
        {
          taskId,
          attemptId: attempt.id,
          at,
          type: "usage.updated",
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            cachedInputTokens: 1,
            totalTokens: 20,
            complete: true,
            reportedCost: { amountMinor: 7, currency: "USD" },
          },
        },
      ])
        await f.store.appendTaskEvent({
          taskId,
          attemptId: attempt.id,
          type: "usage.updated",
          payload,
        });
      for (const [id, status] of [
        ["child-1", "running"],
        ["child-2", "running"],
        ["child-1", "completed"],
        ["child-2", "completed"],
      ] as const)
        await f.store.appendTaskEvent({
          taskId,
          attemptId: attempt.id,
          type: "agent.updated",
          payload: {
            taskId,
            attemptId: attempt.id,
            at,
            type: "agent.updated",
            agent: { id, parentId: "manager", status },
          },
        });
      await f.store.appendTaskEvent({
        taskId,
        attemptId: attempt.id,
        type: "execution.failed",
        payload: {
          taskId,
          attemptId: attempt.id,
          at,
          type: "execution.failed",
          error: { name: "Error", message: "Codex reported token budget exceeded" },
        },
      });
      await f.store.settleTaskAssignment({
        taskId,
        leaseOwner: "metrics-worker",
        attemptCount: 1,
        result: { outcomeUnknown: true },
        terminalAttempt: { id: attempt.id, status: "failed" },
        failed: true,
      });

      const metrics = await f.store.readCoordinationMetrics();
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
      const queuedTaskId = randomUUID();
      const placedTaskId = randomUUID();
      await f.store.admitTaskAssignment(f.assignment(queuedTaskId));
      await f.store.admitTaskAssignment(f.assignment(placedTaskId));
      await f.store.updateTaskAssignment(
        queuedTaskId,
        { expectedStatus: "queued", priority: "urgent" },
        f.owner.id,
      );
      await f.store.claimTaskAssignment({ taskId: placedTaskId, leaseOwner: "scheduler" });
      const attempt = await f.store.createTaskAttempt({
        taskId: placedTaskId,
        attemptNumber: 1,
        workerProfile: { id: "metrics", revision: "1" },
        workerSnapshot: {
          selectionDurationMs: 17,
          placement: {
            workerHostId: "metrics-host",
            workletId: "metrics-worklet",
            workerId: "metrics-worker",
            reservation: {
              id: randomUUID(),
              expiresAt: "2030-01-01T00:01:00.000Z",
            },
          },
          workerHostId: "metrics-host",
        },
        startedAt: new Date().toISOString(),
      });
      await f.store.appendTaskEvent({
        taskId: placedTaskId,
        attemptId: attempt.id,
        type: "task.admission-rejected",
        payload: { version: 1, reason: "capacity changed" },
      });
      await f.store.enrollWorkerHost({
        id: "metrics-host",
        credentialId: "credential",
        enrolledAt: new Date().toISOString(),
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
        observedAt: new Date().toISOString(),
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
        byPriority: {
          urgent: expect.objectContaining({ queued: 1, placedAttempts: 0 }),
          high: expect.objectContaining({ queued: 0, placedAttempts: 0 }),
          normal: expect.objectContaining({ queued: 0, placedAttempts: 1 }),
          low: expect.objectContaining({ queued: 0, placedAttempts: 0 }),
        },
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

    it("reports durable Mailbox backlog and retry attempts", async () => {
      const f = await fixture();
      await f.store.setTagMessagingGrant({
        senderTagId: f.owner.id,
        recipientTagId: f.worker.id,
        messageTypes: ["clarification.requested"],
      });
      const credentialId = randomUUID();
      await f.store.createTagMailboxCredential({
        id: credentialId,
        tagId: f.worker.id,
        tokenHash: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      await f.store.enqueueTagMessage({
        senderTagId: f.owner.id,
        recipientTagId: f.worker.id,
        objectiveId: f.objective.id,
        type: "clarification.requested",
        body: { question: "Need durable evidence?" },
        idempotencyKey: randomUUID(),
      });
      const claim = async () => {
        const now = new Date().toISOString();
        const delivery = await f.store.claimTagMessage({
          tagId: f.worker.id,
          credentialId,
          now,
          leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        });
        expect(delivery).toBeDefined();
        if (!delivery) throw new Error("Expected Mailbox delivery");
        return { delivery, now };
      };
      for (let index = 0; index < 2; index += 1) {
        const { delivery, now } = await claim();
        await f.store.settleTagMessage({
          tagId: f.worker.id,
          credentialId,
          messageId: delivery.message.id,
          leaseToken: delivery.leaseToken,
          now,
          status: "pending",
        });
      }

      const metrics = await f.store.readCoordinationMetrics();
      expect(metrics.mailbox).toMatchObject({
        backlog: 1,
        retrying: 1,
        retryAttempts: 1,
        failed: 0,
      });
      expect(metrics.mailbox.oldestPendingAt).not.toBeNull();
    });
  });
}
