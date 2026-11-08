import { describe, expect, it } from "vitest";
import { poolExecution } from "../packages/control-plane/src/objective-sessions.ts";
import {
  OBJECTIVE_POOL_FLOOR_RATIO,
  TagMessagingError,
  type TaskExecutionRequirements,
} from "../packages/core/src/index.ts";
import { startObjectiveSession, startSessionHarness } from "./support/objective-session.ts";

/**
 * One budget pool per Objective covers its conversation and every Session beneath it: each turn
 * may spend what the budget has left, and once too little is left no new turn is admitted.
 */

const base: TaskExecutionRequirements = { limits: { maxReportedTokens: 10_000 } };

describe("the pool cap", () => {
  it("caps every turn at what the budget has left, and refuses one below the floor", () => {
    const objective = { budgetLimitMinor: 1000, budgetCurrency: "USD" } as const;
    expect(poolExecution({ budgetLimitMinor: null, budgetCurrency: null }, 0, base)).toBe(base);
    expect(poolExecution(objective, 0, base)?.limits).toEqual({
      maxReportedTokens: 10_000,
      maxReportedCost: { currency: "USD", amountMinor: 1000 },
    });
    expect(poolExecution(objective, 600, base)?.limits?.maxReportedCost).toEqual({
      currency: "USD",
      amountMinor: 400,
    });
    // A turn that already has a lower limit of its own keeps it.
    expect(
      poolExecution(objective, 100, {
        ...base,
        limits: { maxReportedCost: { currency: "USD", amountMinor: 250 } },
      })?.limits?.maxReportedCost,
    ).toEqual({ currency: "USD", amountMinor: 250 });
    // The floor: below 5% of the budget the pool is spent, and nothing new is admitted.
    expect(OBJECTIVE_POOL_FLOOR_RATIO).toBe(0.05);
    expect(poolExecution(objective, 949, base)).not.toBeUndefined();
    expect(poolExecution(objective, 951, base)).toBeUndefined();
    expect(
      poolExecution({ budgetLimitMinor: 10, budgetCurrency: "USD" }, 10, base),
    ).toBeUndefined();
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
    // Objective, under the Session's own limit, but it starts no new work Session.
    expect(await cost(second.task.id)).toBe(400);
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
