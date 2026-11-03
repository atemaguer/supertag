import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayCredentialVault, TaskAssignment } from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import { confirmWaitCleanup } from "../packages/control-plane/src/wait-cleanup.js";
import type {
  DurableWorklet,
  ExecutionUsage,
  TaskAttemptEvent,
  TaskAttemptSpec,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const vault: GatewayCredentialVault = {
  async store() {},
  async resolve() {
    return undefined;
  },
  async delete() {},
};

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} budget governance recovery`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      it("preserves reservations and exact durable provider evidence across Control Plane recovery", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supertag-budget-governance-"));
        const isolated =
          dialect === "postgresql" && postgres
            ? await createIsolatedPostgresDatabase(postgres)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        let store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(async () => {
          await store.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        });

        const owner = await store.createTag({ name: `budget-owner-${randomUUID()}` });
        const worker = await store.createTag({ name: `budget-worker-${randomUUID()}` });
        await store.bindTagWorkerHost(worker.id, "recovered-budget-host");
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Complete provider-governed work within the Objective budget",
          budgetLimitMinor: 2_000,
          budgetCurrency: "USD",
        });
        const team = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Budget delivery",
          leadTagId: owner.id,
          memberTagIds: [worker.id],
          maxConcurrency: 4,
        });
        const controlPlane = new ControlPlane({ store, credentialVault: vault });
        const admit = async (
          name: string,
          maxCostMinor: number,
          maxReportedCost: number,
        ): Promise<TaskAssignment> =>
          (await controlPlane.objectives.commandAsAdministrator("assign_task", {
            objectiveId: objective.id,
            taskId: `${objective.id}:${name}`,
            teamId: team.id,
            assignedTagId: worker.id,
            instruction: `Execute deterministic ${name} work`,
            acceptanceCriteria: ["Durable usage evidence recorded"],
            maxCostMinor,
            execution: {
              limits: { maxReportedCost: { amountMinor: maxReportedCost, currency: "USD" } },
            },
          })) as TaskAssignment;

        const within = await admit("within", 300, 300);
        expect(await store.getObjective(objective.id)).toMatchObject({
          budgetLimitMinor: 2_000,
          budgetCurrency: "USD",
          reservedMinor: 300,
          spentMinor: 0,
        });
        expect(
          await controlPlane.objectives.commandAsAdministrator("read_task", {
            objectiveId: objective.id,
            taskId: within.taskId,
          }),
        ).toMatchObject({
          reservedMinor: 300,
          chargedMinor: null,
          budget: {
            organizational: {
              currency: "USD",
              limitMinor: 300,
              reservedMinor: 300,
              chargedMinor: 0,
            },
            provider: {
              requestedCost: { amountMinor: 300, currency: "USD" },
              coverage: { status: "pending", complete: false },
            },
          },
        });

        const threshold = await admit("threshold", 250, 250);
        const cancelled = await admit("cancelled", 200, 200);
        const cumulative = await admit("cumulative", 150, 150);
        const receipts = new Map<string, DurableReceipt>();
        await recordAttempt(store, within, {
          appliedMinor: 250,
          observations: [usage(80, false), usage(200, true)],
          terminal: "completed",
          receipts,
        });
        await recordAttempt(store, threshold, {
          appliedMinor: 250,
          observations: [usage(250, true)],
          terminal: "completed",
          receipts,
        });
        await recordAttempt(store, cancelled, {
          appliedMinor: 180,
          observations: [usage(125, true)],
          terminal: "cancelled",
          receipts,
        });
        const cumulativeAttempt = await recordAttempt(store, cumulative, {
          appliedMinor: 125,
          observations: [usage(25, false), usage(75, true)],
          terminal: "completed",
          receipts,
          replayUsageSequence: 3,
        });

        await store.disconnect();
        store = new DrizzleStore({ url });
        await store.connect();
        const recoveredControlPlane = new ControlPlane({
          store,
          credentialVault: vault,
          worklet: recoveredWorklet(receipts),
          reply: async () => undefined,
        });

        const withinExecution = await recoveredControlPlane.inspectTaskExecution(within.taskId);
        expect(withinExecution).toMatchObject({
          availability: "available",
          limits: {
            requested: { maxReportedCost: { amountMinor: 300, currency: "USD" } },
            applied: {
              maxReportedCost: {
                limit: { amountMinor: 250, currency: "USD" },
                method: "provider-budget",
              },
            },
            observed: {
              usage: { totalTokens: 20, complete: true, reportedCost: { amountMinor: 200 } },
            },
            completeness: { applied: true, usage: true, terminal: true, complete: true },
            outcome: {
              status: "within_limits",
              thresholdReached: { maxReportedCost: false },
            },
          },
        });
        expect(await recoveredControlPlane.inspectTaskExecution(threshold.taskId)).toMatchObject({
          limits: {
            outcome: {
              status: "threshold_reached",
              thresholdReached: { maxReportedCost: true },
            },
          },
        });
        expect(await recoveredControlPlane.inspectTaskExecution(cancelled.taskId)).toMatchObject({
          receipt: { status: "cancelled" },
          limits: {
            observed: {
              usage: {
                complete: true,
                reportedCost: { amountMinor: 125, currency: "USD" },
              },
            },
            completeness: { applied: true, usage: true, terminal: true, complete: true },
            outcome: { status: "within_limits" },
          },
        });

        const first = await recoveredControlPlane.objectives.commandAsAdministrator(
          "read_objective",
          {
            objectiveId: objective.id,
          },
        );
        const second = await recoveredControlPlane.objectives.commandAsAdministrator(
          "read_objective",
          {
            objectiveId: objective.id,
          },
        );
        expect(second).toEqual(first);
        expect(first).toMatchObject({
          budgetCurrency: "USD",
          budget: {
            organizational: {
              currency: "USD",
              limitMinor: 2_000,
              reservedMinor: 0,
              chargedMinor: 900,
              availableMinor: 1_100,
              visibleTasks: {
                allocatedMinor: 900,
                reservedMinor: 0,
                chargedMinor: 900,
                reconcilesWithObjective: true,
              },
            },
            provider: {
              requestedCostByCurrency: { USD: 900 },
              appliedCostByCurrency: { USD: 805 },
              observedCostByCurrency: { USD: 650 },
              coverage: {
                completeForVisibleTasks: true,
                objectiveCurrencyComparison: "matching",
              },
            },
          },
        });

        const tasks = (first as { tasks: Array<{ taskId: string; budget: unknown }> }).tasks;
        const cumulativeBudget = tasks.find((task) => task.taskId === cumulative.taskId)?.budget;
        expect(cumulativeBudget).toMatchObject({
          provider: {
            requestedCost: { amountMinor: 150, currency: "USD" },
            appliedCostByCurrency: { USD: 125 },
            observedCostByCurrency: { USD: 75 },
            coverage: { status: "complete", complete: true },
            attempts: [
              {
                attemptId: cumulativeAttempt,
                status: "completed",
                requestedCost: { amountMinor: 150, currency: "USD" },
                appliedCost: {
                  limit: { amountMinor: 125, currency: "USD" },
                  method: "provider-budget",
                },
                observedCost: { amountMinor: 75, currency: "USD" },
                costCoverage: "complete",
              },
            ],
          },
        });
        expect(
          (await store.listTaskEvents(cumulative.taskId)).filter(
            (event) => event.type === "usage.updated",
          ),
        ).toHaveLength(2);
      });

      it("persists provider usage emitted during durable wait cancellation before recovery", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supertag-wait-budget-recovery-"));
        const isolated =
          dialect === "postgresql" && postgres
            ? await createIsolatedPostgresDatabase(postgres)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        let store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(async () => {
          await store.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        });

        const owner = await store.createTag({ name: `wait-budget-owner-${randomUUID()}` });
        await store.bindTagWorkerHost(owner.id, "wait-budget-host");
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Wait without losing provider accounting",
          budgetLimitMinor: 500,
          budgetCurrency: "USD",
        });
        const team = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Wait accounting",
          leadTagId: owner.id,
          memberTagIds: [],
          maxConcurrency: 1,
        });
        const controlPlane = new ControlPlane({ store, credentialVault: vault });
        const assignment = (await controlPlane.objectives.commandAsAdministrator("assign_task", {
          objectiveId: objective.id,
          taskId: `${objective.id}:wait`,
          teamId: team.id,
          assignedTagId: owner.id,
          instruction: "Register a durable wait after coordinating",
          acceptanceCriteria: ["Wait is durable"],
          maxCostMinor: 100,
          execution: {
            limits: { maxReportedCost: { amountMinor: 100, currency: "USD" } },
          },
        })) as TaskAssignment;
        const leaseOwner = "wait-budget-test";
        const claimed = await store.claimTaskAssignment({
          taskId: assignment.taskId,
          leaseOwner,
        });
        if (!claimed) throw new Error("Could not claim wait accounting Task");
        const attempt = await store.createTaskAttempt({
          taskId: assignment.taskId,
          attemptNumber: claimed.attemptCount,
          workerProfile: { id: "wait-budget", revision: "1" },
          workerSnapshot: { durableExecution: true },
          startedAt: new Date().toISOString(),
        });
        await store.registerTaskAssignmentWait({
          taskId: assignment.taskId,
          leaseOwner,
          attemptCount: claimed.attemptCount,
          notBefore: "2099-01-01T00:00:00.000Z",
        });
        const identity = {
          taskId: assignment.taskId,
          attemptId: attempt.id,
          at: new Date().toISOString(),
        };
        for (const [index, event] of [
          { ...identity, type: "execution.started" as const, workerId: "wait-budget" },
          {
            ...identity,
            type: "execution.limits.applied" as const,
            requested: { maxReportedCost: { amountMinor: 100, currency: "USD" } },
            applied: {
              maxReportedCost: {
                limit: { amountMinor: 100, currency: "USD" },
                method: "provider-budget" as const,
              },
            },
          },
        ].entries())
          await store.appendTaskAssignmentJournalEvent({
            taskId: assignment.taskId,
            attemptId: attempt.id,
            leaseOwner,
            attemptCount: claimed.attemptCount,
            sequence: index + 1,
            type: event.type,
            payload: event,
          });

        const tail: readonly TaskAttemptEvent[] = [
          {
            ...identity,
            type: "usage.updated",
            usage: {
              inputTokens: 30,
              outputTokens: 10,
              cachedInputTokens: 0,
              totalTokens: 40,
              complete: true,
              reportedCost: { amountMinor: 35, currency: "USD" },
            },
          },
          { ...identity, type: "execution.completed" },
        ];
        const receipt = {
          taskId: assignment.taskId,
          attemptId: attempt.id,
          specDigest: "sha256:wait-budget",
          status: "cancelled" as const,
          lastSequence: 4,
        };
        const durable: DurableWorklet = {
          id: "wait-budget-worklet",
          async describe() {
            return {
              id: "wait-budget-worklet",
              protocolVersion: 1,
              host: { id: "wait-budget-host", workers: [] },
            };
          },
          async *execute() {},
          async accept() {
            return receipt;
          },
          async cancel() {
            return receipt;
          },
          async inspect() {
            return receipt;
          },
          async *events(_attemptId, after = 0) {
            for (const [index, event] of tail.entries()) {
              const sequence = index + 3;
              if (sequence > after) yield { sequence, event };
            }
          },
        };
        const errors: unknown[] = [];
        expect(
          await confirmWaitCleanup({
            durable,
            store,
            task: claimed,
            attemptId: attempt.id,
            leaseOwner,
            isStopping: () => false,
            onError: (error) => errors.push(error),
          }),
        ).toBe("settled");
        expect(errors).toEqual([]);
        expect((await store.getTaskAssignment(assignment.taskId))?.status).toBe("waiting");

        await store.disconnect();
        store = new DrizzleStore({ url });
        await store.connect();
        const recovered = new ControlPlane({
          store,
          credentialVault: vault,
          worklet: durable,
          reply: async () => undefined,
        });
        expect(await recovered.inspectTaskExecution(assignment.taskId)).toMatchObject({
          availability: "available",
          receipt: { status: "cancelled", lastSequence: 4 },
          limits: {
            requested: { maxReportedCost: { amountMinor: 100, currency: "USD" } },
            applied: {
              maxReportedCost: {
                limit: { amountMinor: 100, currency: "USD" },
                method: "provider-budget",
              },
            },
            observed: {
              usage: {
                totalTokens: 40,
                complete: true,
                reportedCost: { amountMinor: 35, currency: "USD" },
              },
            },
            completeness: { applied: true, usage: true, terminal: true, complete: true },
            outcome: { status: "within_limits" },
          },
        });
        expect(
          await recovered.objectives.commandAsAdministrator("read_task", {
            objectiveId: objective.id,
            taskId: assignment.taskId,
          }),
        ).toMatchObject({
          budget: {
            provider: {
              observedCostByCurrency: { USD: 35 },
              coverage: { status: "complete", complete: true },
            },
          },
        });
      });
    },
  );
}

interface DurableReceipt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly specDigest: string;
  readonly status: "completed" | "cancelled";
  readonly lastSequence: number;
}

function usage(amountMinor: number, complete: boolean): ExecutionUsage {
  return {
    inputTokens: 12,
    outputTokens: 8,
    cachedInputTokens: 0,
    totalTokens: 20,
    complete,
    reportedCost: { amountMinor, currency: "USD" },
  };
}

async function recordAttempt(
  store: DrizzleStore,
  task: TaskAssignment,
  input: {
    readonly appliedMinor: number;
    readonly observations: readonly ExecutionUsage[];
    readonly terminal: "completed" | "cancelled";
    readonly receipts: Map<string, DurableReceipt>;
    readonly replayUsageSequence?: number;
  },
): Promise<string> {
  const leaseOwner = `budget-test-${task.taskId}`;
  const claimed = await store.claimTaskAssignment({ taskId: task.taskId, leaseOwner });
  if (!claimed) throw new Error(`Could not claim ${task.taskId}`);
  const attempt = await store.createTaskAttempt({
    taskId: task.taskId,
    attemptNumber: claimed.attemptCount,
    workerProfile: { id: "budget-test", revision: "1" },
    workerSnapshot: { durableExecution: true },
    startedAt: new Date().toISOString(),
  });
  const identity = {
    taskId: task.taskId,
    attemptId: attempt.id,
    at: new Date().toISOString(),
  };
  const requested = (await store.findTaskById(task.taskId))?.execution.limits ?? {};
  const events: TaskAttemptEvent[] = [
    { type: "execution.started", ...identity, workerId: "budget-test" },
    {
      type: "execution.limits.applied",
      ...identity,
      requested,
      applied: {
        maxReportedCost: {
          limit: { amountMinor: input.appliedMinor, currency: "USD" },
          method: "provider-budget",
        },
      },
    },
    ...input.observations.map(
      (observation): TaskAttemptEvent => ({
        type: "usage.updated",
        ...identity,
        usage: observation,
      }),
    ),
    {
      type: input.terminal === "cancelled" ? "execution.cancelled" : "execution.completed",
      ...identity,
    },
  ];
  for (const [index, event] of events.entries()) {
    const sequence = index + 1;
    const saved = await store.appendTaskAssignmentJournalEvent({
      taskId: task.taskId,
      attemptId: attempt.id,
      leaseOwner,
      attemptCount: claimed.attemptCount,
      sequence,
      type: event.type,
      payload: { ...event },
    });
    if (sequence === input.replayUsageSequence) {
      const replay = await store.appendTaskAssignmentJournalEvent({
        taskId: task.taskId,
        attemptId: attempt.id,
        leaseOwner,
        attemptCount: claimed.attemptCount,
        sequence,
        type: event.type,
        payload: { ...event },
      });
      expect(replay.id).toBe(saved.id);
    }
  }
  if (input.terminal === "cancelled") {
    await store.closeTaskAttempt({
      attemptId: attempt.id,
      status: "cancelled",
      endedAt: new Date().toISOString(),
    });
    await store.cancelTaskAssignment(task.taskId, task.requestedByTagId);
  } else {
    await store.settleTaskAssignment({
      taskId: task.taskId,
      leaseOwner,
      attemptCount: claimed.attemptCount,
      terminalAttempt: { id: attempt.id, status: "completed" },
      result: { text: "Deterministic provider usage recorded" },
    });
  }
  input.receipts.set(attempt.id, {
    attemptId: attempt.id,
    taskId: task.taskId,
    specDigest: `sha256:${attempt.id}`,
    status: input.terminal,
    lastSequence: events.length,
  });
  return attempt.id;
}

function recoveredWorklet(receipts: ReadonlyMap<string, DurableReceipt>): DurableWorklet {
  return {
    id: "recovered-budget-worklet",
    async describe() {
      return {
        id: "recovered-budget-worklet",
        protocolVersion: 1,
        host: { id: "recovered-budget-host", workers: [] },
      };
    },
    async *execute(_spec: TaskAttemptSpec) {},
    async accept(spec) {
      const receipt = receipts.get(spec.attemptId);
      if (!receipt) throw new Error("Unknown deterministic Attempt");
      return receipt;
    },
    async inspect(attemptId) {
      return receipts.get(attemptId);
    },
    async *events(_attemptId, _after = 0) {},
    async cancel(attemptId) {
      const receipt = receipts.get(attemptId);
      if (!receipt) throw new Error("Unknown deterministic Attempt");
      return receipt;
    },
  };
}
