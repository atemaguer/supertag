import type { Objective, Task, TaskAssignment, TaskAttempt, TaskEvent } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { objectiveBudgetReport, taskBudgetReport } from "./src/budget-report.js";

const objective = {
  id: "objective",
  budgetLimitMinor: 2_000,
  budgetCurrency: "USD",
  reservedMinor: 0,
  spentMinor: 400,
} as Objective;

const assignment = {
  taskId: "task",
  status: "accepted",
  reservedMinor: 400,
  chargedMinor: 400,
} as TaskAssignment;

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

describe("budget reports", () => {
  it("keeps each Attempt's original requested allocation after renewal", () => {
    const budget = taskBudgetReport({
      objective,
      assignment,
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
  it.each(["queued", "cancelled"] as const)(
    "preserves earlier charges during %s renewed allocation",
    (status) => {
      const budget = taskBudgetReport({
        objective,
        assignment: {
          ...assignment,
          status,
          reservedMinor: 200,
          chargedMinor: null,
          result: { budgetRenewal: { previousChargedMinor: 100 } },
        },
        task,
        attempts: [],
        events: [],
      });
      expect(budget.organizational).toMatchObject({
        chargedMinor: 100,
        reservedMinor: status === "queued" ? 200 : 0,
        limitMinor: 300,
      });
    },
  );
  it("sums only the latest cumulative cost once per Attempt across retries", () => {
    const attempts = [attempt("attempt-1", 1, "failed"), attempt("attempt-2", 2, "completed")];
    const budget = taskBudgetReport({
      objective,
      assignment,
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

    expect(budget.organizational).toEqual({
      currency: "USD",
      limitMinor: 400,
      reservedMinor: 0,
      chargedMinor: 400,
    });
    expect(budget.provider).toMatchObject({
      requestedCost: { amountMinor: 300, currency: "USD" },
      objectiveCurrencyComparison: "matching",
      appliedCostByCurrency: { USD: 600 },
      observedCostByCurrency: { USD: 175 },
      coverage: { status: "complete", complete: true },
    });

    const aggregate = objectiveBudgetReport(objective, [{ taskId: "task", budget }]);
    expect(aggregate).toMatchObject({
      organizational: {
        limitMinor: 2_000,
        reservedMinor: 0,
        chargedMinor: 400,
        availableMinor: 1_600,
        visibleTasks: {
          allocatedMinor: 400,
          reservedMinor: 0,
          chargedMinor: 400,
          reconcilesWithObjective: true,
        },
      },
      provider: {
        requestedCostByCurrency: { USD: 600 },
        appliedCostByCurrency: { USD: 600 },
        observedCostByCurrency: { USD: 175 },
        coverage: {
          scope: "visible_tasks",
          completeForVisibleTasks: true,
          completeTaskIds: ["task"],
          objectiveCurrencyComparison: "matching",
        },
      },
    });
  });

  it("keeps missing enforcement evidence unknown without parsing failure text", () => {
    const legacyAttempt = attempt("legacy", 1, "failed");
    const budget = taskBudgetReport({
      objective,
      assignment,
      task,
      attempts: [legacyAttempt],
      events: [
        event("legacy", 1, "execution.failed", {
          error: { message: "provider cost budget exceeded after $3" },
        }),
      ],
    });

    expect(budget.provider).toMatchObject({
      observedCostByCurrency: {},
      coverage: {
        status: "unknown",
        complete: false,
        unknownAttemptIds: ["legacy"],
      },
    });
  });

  it("keeps coverage unknown when the applied cost ceiling exceeds the request", () => {
    const completed = attempt("over-applied", 1, "completed");
    const budget = taskBudgetReport({
      objective,
      assignment,
      task,
      attempts: [completed],
      events: [applied("over-applied", 1, "USD", 400), usage("over-applied", 2, 100)],
    });

    expect(budget.provider.coverage).toMatchObject({
      status: "unknown",
      complete: false,
      unknownAttemptIds: ["over-applied"],
    });
    expect(budget.provider.attempts[0]).toMatchObject({
      costCoverage: "unknown",
      limits: {
        completeness: { applied: false, complete: false },
        outcome: { status: "unknown" },
      },
    });
    expect(
      objectiveBudgetReport(objective, [{ taskId: "task", budget }]).provider.coverage,
    ).toMatchObject({
      completeForVisibleTasks: false,
      unknownTaskIds: ["task"],
    });
  });

  it("treats complete observed spend as covered when no monetary ceiling was requested", () => {
    const uncapped = { ...task, execution: {} } as Task;
    const completed = attempt("uncapped", 1, "completed");
    const budget = taskBudgetReport({
      objective,
      assignment,
      task: uncapped,
      attempts: [completed],
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
      assignment,
      task,
      attempts: [],
      events: [],
    });
    expect(internal.provider.objectiveCurrencyComparison).toBe("internal_units");
    expect(internal.provider.coverage.status).toBe("unknown");

    const mismatch = taskBudgetReport({
      objective,
      assignment,
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
      completeForVisibleTasks: false,
      currencyMismatchTaskIds: ["task"],
      objectiveCurrencyComparison: "currency_mismatch",
    });
  });
});

it("keeps streamed token usage with no reported cost unknown rather than free", () => {
  const budget = taskBudgetReport({
    objective,
    assignment,
    task: { ...task, execution: {} },
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
    objectiveBudgetReport(objective, [{ taskId: "task", budget }]).provider.coverage
      .completeForVisibleTasks,
  ).toBe(false);
});

it("keeps the final summary activation outside the exhausted Objective budget", () => {
  const ordinary = taskBudgetReport({
    objective,
    assignment,
    task,
    attempts: [attempt("work", 1, "completed")],
    events: [usage("work", 1, 2100)],
  });
  const summary = {
    ...ordinary,
    provider: {
      ...ordinary.provider,
      observedCostByCurrency: { USD: 25 },
    },
  };
  expect(
    objectiveBudgetReport(objective, [
      { taskId: "task", budget: ordinary },
      { taskId: `${objective.id}:limit-summary:2`, limitSummaryActivation: true, budget: summary },
    ]).provider.observedCostByCurrency,
  ).toEqual({ USD: 2100 });
  expect(
    objectiveBudgetReport(objective, [
      { taskId: `${objective.id}:limit-summary:unmarked`, budget: summary },
    ]).provider.observedCostByCurrency,
  ).toEqual({ USD: 25 });
});
