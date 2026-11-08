import type { Objective, Task, TaskAttempt, TaskEvent } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { objectiveBudgetReport, objectivePool, taskBudgetReport } from "./src/budget-report.js";

const objective = {
  id: "objective",
  budgetLimitMinor: 2_000,
  budgetCurrency: "USD",
  limitState: { reportedSpend: { amountMinor: 400, currency: "USD", unknownAttemptIds: [] } },
} as unknown as Objective;

const task = {
  id: "task",
  execution: { limits: { maxReportedCost: { amountMinor: 300, currency: "USD" } } },
} as Task;

function attempt(id: string, attemptNumber: number, status: TaskAttempt["status"]): TaskAttempt {
  return { id, taskId: "task", attemptNumber, status } as TaskAttempt;
}

function event(
  attemptId: string,
  sequence: number,
  type: string,
  payload: TaskEvent["payload"],
): TaskEvent {
  return {
    id: `event-${sequence}`,
    taskId: "task",
    attemptId,
    sequence,
    type,
    payload,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

function applied(
  attemptId: string,
  sequence: number,
  currency = "USD",
  amountMinor = 300,
): TaskEvent {
  return event(attemptId, sequence, "execution.limits.applied", {
    requested: task.execution.limits ?? {},
    applied: {
      maxReportedCost: {
        limit: { amountMinor, currency },
        method: "provider-budget",
      },
    },
  });
}

function usage(
  attemptId: string,
  sequence: number,
  amountMinor: number,
  complete = true,
  currency = "USD",
): TaskEvent {
  return event(attemptId, sequence, "execution.usage.updated", {
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      totalTokens: 15,
      complete,
      reportedCost: { amountMinor, currency },
    },
  });
}

describe("the Objective's one budget pool", () => {
  it("reports what the limit sweep last measured and what remains", () => {
    expect(objectivePool(objective)).toEqual({
      currency: "USD",
      limitMinor: 2_000,
      spentMinor: 400,
      availableMinor: 1_600,
    });
  });
  it("counts nothing spent before the first sweep, and has no pool without a currency", () => {
    expect(objectivePool({ ...objective, limitState: null } as unknown as Objective)).toMatchObject(
      { spentMinor: 0, availableMinor: 2_000 },
    );
    expect(
      objectivePool({ ...objective, budgetCurrency: null } as unknown as Objective),
    ).toMatchObject({ currency: null, spentMinor: null, availableMinor: null });
    expect(
      objectivePool({ ...objective, budgetLimitMinor: null } as unknown as Objective),
    ).toMatchObject({ limitMinor: null, availableMinor: null });
  });
});

describe("budget reports", () => {
  it("keeps each Attempt's own requested allocation", () => {
    const budget = taskBudgetReport({
      objective,
      task: {
        ...task,
        execution: { limits: { maxReportedCost: { amountMinor: 900, currency: "USD" } } },
      },
      attempts: [attempt("attempt-1", 1, "failed"), attempt("attempt-2", 2, "completed")],
      events: [
        applied("attempt-1", 1),
        event("attempt-2", 2, "execution.limits.applied", {
          requested: { maxReportedCost: { amountMinor: 900, currency: "USD" } },
          applied: {},
        }),
      ],
    });
    expect(budget.provider.attempts.map((a) => a.requestedCost?.amountMinor)).toEqual([300, 900]);
    expect(
      budget.provider.attempts.map((a) => a.limits.requested.maxReportedCost?.amountMinor),
    ).toEqual([300, 900]);
  });

  it("sums only the latest cumulative cost once per Attempt across retries", () => {
    const attempts = [attempt("attempt-1", 1, "failed"), attempt("attempt-2", 2, "completed")];
    const budget = taskBudgetReport({
      objective,
      task,
      attempts,
      events: [
        applied("attempt-1", 1),
        usage("attempt-1", 2, 40, false),
        usage("attempt-1", 3, 100),
        applied("attempt-2", 4),
        usage("attempt-2", 5, 75),
      ],
    });

    expect(budget.provider).toMatchObject({
      requestedCost: { amountMinor: 300, currency: "USD" },
      objectiveCurrencyComparison: "matching",
      appliedCostByCurrency: { USD: 600 },
      observedCostByCurrency: { USD: 175 },
      coverage: { status: "complete", complete: true },
    });

    expect(objectiveBudgetReport(objective, [{ taskId: "task", budget }])).toMatchObject({
      provider: {
        requestedCostByCurrency: { USD: 600 },
        appliedCostByCurrency: { USD: 600 },
        observedCostByCurrency: { USD: 175 },
        coverage: {
          complete: true,
          completeTaskIds: ["task"],
          objectiveCurrencyComparison: "matching",
        },
      },
    });
  });

  it("sums every Task of the Objective's Sessions, the owner's turns included", () => {
    const owner = taskBudgetReport({
      objective,
      task: { ...task, id: "owner", execution: {} } as Task,
      attempts: [attempt("owner-1", 1, "completed")],
      events: [usage("owner-1", 1, 25)],
    });
    const work = taskBudgetReport({
      objective,
      task: { ...task, execution: {} } as Task,
      attempts: [attempt("work-1", 1, "completed")],
      events: [usage("work-1", 1, 2_100)],
    });
    expect(
      objectiveBudgetReport(objective, [
        { taskId: "owner", budget: owner },
        { taskId: "task", budget: work },
      ]).provider.observedCostByCurrency,
    ).toEqual({ USD: 2_125 });
  });

  it("keeps missing enforcement evidence unknown without parsing failure text", () => {
    const budget = taskBudgetReport({
      objective,
      task,
      attempts: [attempt("legacy", 1, "failed")],
      events: [
        event("legacy", 1, "execution.failed", {
          error: { message: "provider cost budget exceeded after $3" },
        }),
      ],
    });

    expect(budget.provider).toMatchObject({
      observedCostByCurrency: {},
      coverage: { status: "unknown", complete: false, unknownAttemptIds: ["legacy"] },
    });
  });

  it("keeps coverage unknown when the applied cost ceiling exceeds the request", () => {
    const budget = taskBudgetReport({
      objective,
      task,
      attempts: [attempt("over-applied", 1, "completed")],
      events: [applied("over-applied", 1, "USD", 400), usage("over-applied", 2, 100)],
    });

    expect(budget.provider.coverage).toMatchObject({
      status: "unknown",
      complete: false,
      unknownAttemptIds: ["over-applied"],
    });
    expect(budget.provider.attempts[0]).toMatchObject({
      costCoverage: "unknown",
      limits: { completeness: { applied: false, complete: false }, outcome: { status: "unknown" } },
    });
    expect(
      objectiveBudgetReport(objective, [{ taskId: "task", budget }]).provider.coverage,
    ).toMatchObject({ complete: false, unknownTaskIds: ["task"] });
  });

  it("treats complete observed spend as covered when no monetary ceiling was requested", () => {
    const budget = taskBudgetReport({
      objective,
      task: { ...task, execution: {} } as Task,
      attempts: [attempt("uncapped", 1, "completed")],
      events: [usage("uncapped", 1, 90)],
    });

    expect(budget.provider).toMatchObject({
      requestedCost: null,
      observedCostByCurrency: { USD: 90 },
      coverage: { status: "complete", complete: true },
    });
    expect(budget.provider.attempts[0]).toMatchObject({
      appliedCost: null,
      observedCost: { amountMinor: 90, currency: "USD" },
      costCoverage: "complete",
    });
  });

  it("reports currencyless allocation units and currency mismatches explicitly", () => {
    const internal = taskBudgetReport({
      objective: { ...objective, budgetCurrency: null } as Objective,
      task,
      attempts: [],
      events: [],
    });
    expect(internal.provider.objectiveCurrencyComparison).toBe("internal_units");
    expect(internal.provider.coverage.status).toBe("unknown");

    const mismatch = taskBudgetReport({
      objective,
      task: {
        ...task,
        execution: { limits: { maxReportedCost: { amountMinor: 300, currency: "EUR" } } },
      },
      attempts: [],
      events: [],
    });
    expect(mismatch.provider.objectiveCurrencyComparison).toBe("currency_mismatch");
    expect(
      objectiveBudgetReport(objective, [{ taskId: "task", budget: mismatch }]).provider.coverage,
    ).toMatchObject({
      complete: false,
      currencyMismatchTaskIds: ["task"],
      objectiveCurrencyComparison: "currency_mismatch",
    });
  });

  it("keeps streamed token usage with no reported cost unknown rather than free", () => {
    const budget = taskBudgetReport({
      objective,
      task: { ...task, execution: {} } as Task,
      attempts: [attempt("partial", 1, "completed")],
      events: [
        event("partial", 1, "execution.usage.updated", {
          usage: {
            inputTokens: 10,
            outputTokens: 3,
            cachedInputTokens: 0,
            totalTokens: 13,
            complete: false,
          },
        }),
      ],
    });
    expect(budget.provider.coverage).toMatchObject({
      status: "unknown",
      complete: false,
      unknownAttemptIds: ["partial"],
    });
    expect(
      objectiveBudgetReport(objective, [{ taskId: "task", budget }]).provider.coverage.complete,
    ).toBe(false);
  });
});
