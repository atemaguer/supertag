import { describe, expect, it } from "vitest";
import {
  objectivePool,
  poolExecution,
  poolRemainderExecution,
  turnPool,
} from "../packages/control-plane/src/budget-pool.ts";
import {
  POOL_FLOOR_RATIO,
  TagMessagingError,
  type TaskExecutionRequirements,
} from "../packages/core/src/index.ts";
import { startObjectiveSession, startSessionHarness } from "./support/objective-session.ts";

/**
 * One budget pool per Objective covers its conversation and every Session beneath it: each turn
 * may spend what the budget has left, and once too little is left no new turn is admitted. A
 * conversation turn's reported limits are a pool under the same rule.
 */

const base: TaskExecutionRequirements = { limits: { maxReportedTokens: 10_000 } };
const spent = (costMinor: number, tokens = 0) => ({ tokens, costMinor });

describe("the pool cap", () => {
  it("caps every turn at what the budget has left, and refuses one below the floor", () => {
    const pool = objectivePool({ budgetLimitMinor: 1000, budgetCurrency: "USD" });
    expect(objectivePool({ budgetLimitMinor: null, budgetCurrency: null })).toEqual({});
    expect(objectivePool({ budgetLimitMinor: 1000, budgetCurrency: null })).toEqual({});
    expect(poolExecution({}, spent(0), base)).toBe(base);
    expect(poolExecution(pool, spent(0), base)?.limits).toEqual({
      maxReportedTokens: 10_000,
      maxReportedCost: { currency: "USD", amountMinor: 1000 },
    });
    expect(poolExecution(pool, spent(600), base)?.limits?.maxReportedCost).toEqual({
      currency: "USD",
      amountMinor: 400,
    });
    // A turn that already has a lower limit of its own keeps it.
    expect(
      poolExecution(pool, spent(100), {
        ...base,
        limits: { maxReportedCost: { currency: "USD", amountMinor: 250 } },
      })?.limits?.maxReportedCost,
    ).toEqual({ currency: "USD", amountMinor: 250 });
    // A limit in another currency gives way to the pool's.
    expect(
      poolExecution(pool, spent(100), {
        limits: { maxReportedCost: { currency: "EUR", amountMinor: 250 } },
      })?.limits?.maxReportedCost,
    ).toEqual({ currency: "USD", amountMinor: 900 });
    // The floor: below 5% of the budget the pool is spent, and nothing new is admitted.
    expect(POOL_FLOOR_RATIO).toBe(0.05);
    expect(poolExecution(pool, spent(950), base)).not.toBeUndefined();
    expect(poolExecution(pool, spent(951), base)).toBeUndefined();
    expect(
      poolExecution(
        objectivePool({ budgetLimitMinor: 10, budgetCurrency: "USD" }),
        spent(10),
        base,
      ),
    ).toBeUndefined();
  });

  it("lets a conversation turn's work Tasks draw on its reported limits", () => {
    const turn: TaskExecutionRequirements = {
      harness: "codex",
      limits: {
        maxNativeAgents: 2,
        maxReportedTokens: 10_000,
        maxReportedCost: { amountMinor: 500, currency: "USD" },
      },
    };
    const pool = turnPool(turn);
    expect(pool).toEqual({
      maxReportedTokens: 10_000,
      maxReportedCost: { amountMinor: 500, currency: "USD" },
    });
    // The turn spent 2,000 tokens and 100 cents: each new work Task may spend the rest. A first
    // work Task still running holds nothing back from the second.
    const first = poolExecution(pool, spent(100, 2_000), turn);
    const second = poolExecution(pool, spent(100, 2_000), turn);
    expect(first).toEqual({
      harness: "codex",
      limits: {
        maxNativeAgents: 2,
        maxReportedTokens: 8_000,
        maxReportedCost: { amountMinor: 400, currency: "USD" },
      },
    });
    expect(second).toEqual(first);
    // Once the first reported 3,000 tokens and 150 cents, a third sees what both left.
    expect(poolExecution(pool, spent(250, 5_000), turn)?.limits).toMatchObject({
      maxReportedTokens: 5_000,
      maxReportedCost: { amountMinor: 250 },
    });
    // A Task continuing after an approval keeps a smaller allowance of its own.
    expect(
      poolExecution(pool, spent(250, 5_000), {
        ...turn,
        limits: {
          maxReportedTokens: 4_000,
          maxReportedCost: { amountMinor: 300, currency: "USD" },
        },
      })?.limits,
    ).toEqual({ maxReportedTokens: 4_000, maxReportedCost: { amountMinor: 250, currency: "USD" } });
    // Below the floor, in tokens or in cost, nothing draws on the pool.
    expect(poolExecution(pool, spent(0, 9_500), turn)).not.toBeUndefined();
    expect(poolExecution(pool, spent(0, 9_501), turn)).toBeUndefined();
    expect(poolExecution(pool, spent(476, 0), turn)).toBeUndefined();
    // Only a token limit: the pool limits tokens alone.
    expect(
      poolExecution(turnPool({ limits: { maxReportedTokens: 100 } }), spent(999, 40), {
        limits: { maxReportedTokens: 100 },
      }),
    ).toEqual({ limits: { maxReportedTokens: 60 } });
    // A Task the pool owes, as an Objective's report turn, gets what is left with no floor, and
    // the smallest limits a Task can carry once nothing is.
    expect(poolRemainderExecution(pool, spent(400, 9_900), turn).limits).toEqual({
      maxNativeAgents: 2,
      maxReportedTokens: 100,
      maxReportedCost: { amountMinor: 100, currency: "USD" },
    });
    expect(poolRemainderExecution(pool, spent(600, 12_000), turn).limits).toEqual({
      maxNativeAgents: 2,
      maxReportedTokens: 1,
      maxReportedCost: { amountMinor: 0, currency: "USD" },
    });
    // A turn without reported limits has no pool, whatever it spent.
    expect(turnPool({ limits: { maxNativeAgents: 1 } })).toEqual({});
    expect(poolExecution({}, spent(9, 99), { harness: "codex" })).toEqual({ harness: "codex" });
  });
});

it("draws every turn of an Objective from one pool and refuses work below the floor", async () => {
  const results: Record<string, string> = {};
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.kind === "work_session") {
        const spend = /spend (\d+)/u.exec(turn.request)?.[1];
        return { reply: "Measured.", reportedCostMinor: Number(spend ?? 0) };
      }
      if (turn.internal?.kind === "session_report") {
        const title = turn.internal.title;
        if (title === "first") {
          results["second"] = (
            await turn.call("start_session", { title: "second", instruction: "spend 380" })
          ).text;
          return "Carrying on.";
        }
        results["third"] = (
          await turn.call("start_session", { title: "third", instruction: "spend 10" })
        ).text;
        return "Out of budget.";
      }
      await turn.call("start_session", { title: "first", instruction: "spend 600" });
      return "Started the first.";
    },
  });
  try {
    const owner = await harness.tag("planner");
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
      objective: {
        outcome: "Measure the checkout",
        budgetLimitMinor: 1000,
        budgetCurrency: "USD",
      },
    });
    const cost = (taskId: string) =>
      harness.store
        .findTaskById(taskId)
        .then((task) => task?.execution.limits?.maxReportedCost?.amountMinor);

    // The first turn may spend the whole budget; nothing is spent yet.
    const start = await session.waitForOwnerTurn({ reason: "objective_start" });
    expect(await cost(start.task.id)).toBe(1000);
    const first = await session.waitForReport();
    expect(await cost(first.report.workTaskId)).toBe(1000);

    // The work Session reported 600, so the report turn and the work it starts see 400 left.
    expect(await cost(first.task.id)).toBe(400);
    const second = await session.waitForReport();
    expect(await cost(second.report.workTaskId)).toBe(400);

    // 980 of 1000 is spent, which leaves less than the floor. The report still reaches the
    // Objective, capped at the 20 left, but it starts no new work Session.
    expect(await cost(second.task.id)).toBe(20);
    await expect
      .poll(() => results["third"], { timeout: 15_000, interval: 50 })
      .toContain(`Objective ${session.objective.id} has too little of its budget left`);
    expect(results["second"]).toContain('"status":"started"');
    expect(
      (await harness.store.listObjectiveSessions(session.objective.id)).filter(
        (entry) => entry.parentSessionId !== undefined,
      ),
    ).toHaveLength(2);

    // No turn of the Objective is admitted either, until an operator raises the budget.
    await expect(
      harness.controlPlane.messageObjective({
        objectiveId: session.objective.id,
        text: "Keep going",
        operatorId: "admin",
        idempotencyKey: "spent-1",
      }),
    ).rejects.toThrow(`Objective ${session.objective.id} has spent its budget`);
    const objective = await harness.store.getObjective(session.objective.id);
    await harness.store.updateObjectiveStatus(objective.id, {
      expectedRevision: objective.revision,
      budgetLimitMinor: 4000,
    });
    const resumed = await harness.controlPlane.messageObjective({
      objectiveId: session.objective.id,
      text: "Keep going",
      operatorId: "admin",
      idempotencyKey: "spent-2",
    });
    expect(await cost(resumed.taskId)).toBe(3020);
    expect(harness.errors.filter((error) => !(error instanceof TagMessagingError))).toEqual([]);
  } finally {
    await harness.close();
  }
}, 90_000);
