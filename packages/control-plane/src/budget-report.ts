import type { Objective, Task, TaskAssignment, TaskAttempt, TaskEvent } from "@supertag/core";
import type { AppliedHarnessExecutionLimits } from "@supertag/worker-sdk";
import {
  type TaskExecutionLimitReport,
  taskExecutionLimitReport,
} from "./task-execution-report.js";

export interface CurrencyAmount {
  readonly amountMinor: number;
  readonly currency: string;
  readonly estimated?: boolean;
}

export interface TaskAttemptBudgetReport {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly status: TaskAttempt["status"];
  /** Full requested, applied, and observed Harness evidence for this Attempt. */
  readonly limits: TaskExecutionLimitReport;
  readonly requestedCost: CurrencyAmount | null;
  readonly appliedCost: AppliedHarnessExecutionLimits["maxReportedCost"] | null;
  readonly observedCost: CurrencyAmount | null;
  readonly costCoverage: "not_applicable" | "pending" | "complete" | "unknown";
}

export interface TaskBudgetReport {
  readonly organizational: {
    /** Null means Objective allocations are internal units rather than money. */
    readonly currency: string | null;
    /** Immutable allocation admitted for this Task. */
    readonly limitMinor: number;
    /** Amount still reserved in the Objective rather than charged. */
    readonly reservedMinor: number;
    /** Amount charged when execution first began. */
    readonly chargedMinor: number;
  };
  readonly provider: {
    /** The Task's per-Attempt provider ceiling; retries do not silently rewrite it. */
    readonly requestedCost: CurrencyAmount | null;
    readonly objectiveCurrencyComparison:
      | "internal_units"
      | "not_applicable"
      | "matching"
      | "currency_mismatch";
    readonly appliedCostByCurrency: Readonly<Record<string, number>>;
    readonly observedCostByCurrency: Readonly<Record<string, number>>;
    readonly coverage: {
      readonly status: "not_applicable" | "pending" | "complete" | "partial" | "unknown";
      readonly complete: boolean;
      readonly unknownAttemptIds: readonly string[];
      readonly pendingAttemptIds: readonly string[];
    };
    readonly attempts: readonly TaskAttemptBudgetReport[];
  };
}

export interface ObjectiveBudgetReport {
  readonly organizational: {
    readonly currency: string | null;
    readonly limitMinor: number | null;
    readonly reservedMinor: number;
    readonly chargedMinor: number;
    readonly availableMinor: number | null;
    /** A consistency check between Objective counters and visible Task allocations. */
    readonly visibleTasks: {
      readonly allocatedMinor: number;
      readonly reservedMinor: number;
      readonly chargedMinor: number;
      readonly reconcilesWithObjective: boolean;
    };
  };
  readonly provider: {
    /** Sum of one per-Attempt ceiling for each visible Task, grouped without currency conversion. */
    readonly requestedCostByCurrency: Readonly<Record<string, number>>;
    /** Sum of applied ceilings across Attempts, grouped without currency conversion. */
    readonly appliedCostByCurrency: Readonly<Record<string, number>>;
    /** Sum of each Attempt's latest cumulative observation exactly once. */
    readonly observedCostByCurrency: Readonly<Record<string, number>>;
    readonly coverage: {
      /** This projection includes only Tasks visible to the caller of read_objective. */
      readonly scope: "visible_tasks";
      readonly completeForVisibleTasks: boolean;
      readonly completeTaskIds: readonly string[];
      readonly partialTaskIds: readonly string[];
      readonly unknownTaskIds: readonly string[];
      readonly pendingTaskIds: readonly string[];
      readonly currencyMismatchTaskIds: readonly string[];
      /** Internal allocation units cannot be reconciled with provider-reported money. */
      readonly objectiveCurrencyComparison: "internal_units" | "matching" | "currency_mismatch";
    };
  };
}

export function taskBudgetReport(input: {
  readonly objective: Pick<Objective, "budgetCurrency">;
  readonly assignment: TaskAssignment;
  readonly task: Task | undefined;
  readonly attempts: readonly TaskAttempt[];
  readonly events: readonly TaskEvent[];
}): TaskBudgetReport {
  const requestedCost = input.task?.execution.limits?.maxReportedCost ?? null;
  const attempts = input.attempts
    .toSorted((a, b) => a.attemptNumber - b.attemptNumber)
    .map((attempt): TaskAttemptBudgetReport => {
      const limits = taskExecutionLimitReport(input.task, attempt, input.events);
      const appliedCost = limits.applied?.maxReportedCost ?? null;
      const observedCost = limits.observed.usage?.reportedCost ?? null;
      return {
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        limits,
        requestedCost: limits.requested?.maxReportedCost ?? null,
        appliedCost,
        observedCost,
        costCoverage: attemptCostCoverage(limits, attempt.status),
      };
    });
  const coverage = taskCostCoverage(input.assignment, requestedCost, attempts);
  const currency = input.objective.budgetCurrency ?? null;
  const providerCurrencies = new Set(
    [
      requestedCost?.currency,
      ...attempts.flatMap((attempt) => [
        attempt.appliedCost?.limit.currency,
        attempt.observedCost?.currency,
      ]),
    ].filter((value): value is string => value !== undefined),
  );
  const renewal = input.assignment.result?.["budgetRenewal"];
  const previousCharged =
    renewal &&
    typeof renewal === "object" &&
    !Array.isArray(renewal) &&
    "previousChargedMinor" in renewal &&
    typeof renewal["previousChargedMinor"] === "number"
      ? renewal["previousChargedMinor"]
      : 0;
  const chargedMinor = input.assignment.chargedMinor ?? previousCharged;
  return {
    organizational: {
      currency,
      limitMinor:
        input.assignment.chargedMinor === null
          ? chargedMinor + input.assignment.reservedMinor
          : Math.max(chargedMinor, input.assignment.reservedMinor),
      reservedMinor:
        input.assignment.chargedMinor === null && input.assignment.status !== "cancelled"
          ? input.assignment.reservedMinor
          : 0,
      chargedMinor,
    },
    provider: {
      requestedCost,
      objectiveCurrencyComparison:
        currency === null
          ? "internal_units"
          : providerCurrencies.size === 0
            ? "not_applicable"
            : [...providerCurrencies].every((providerCurrency) => providerCurrency === currency)
              ? "matching"
              : "currency_mismatch",
      appliedCostByCurrency: currencyTotals(
        attempts.map((attempt) => attempt.appliedCost?.limit ?? null),
      ),
      observedCostByCurrency: currencyTotals(attempts.map((attempt) => attempt.observedCost)),
      coverage,
      attempts,
    },
  };
}

export function objectiveBudgetReport(
  objective: Pick<
    Objective,
    "budgetCurrency" | "budgetLimitMinor" | "reservedMinor" | "spentMinor"
  >,
  tasks: readonly {
    readonly taskId: string;
    readonly limitSummaryActivation?: boolean;
    readonly budget: TaskBudgetReport;
  }[],
): ObjectiveBudgetReport {
  // The one final owner activation has a separate fixed allowance. Its provider usage remains
  // visible on its Task, but it never consumes or inflates the exhausted Objective budget.
  tasks = tasks.filter(({ limitSummaryActivation }) => !limitSummaryActivation);
  const allocatedMinor = sum(tasks.map(({ budget }) => budget.organizational.limitMinor));
  const reservedMinor = sum(tasks.map(({ budget }) => budget.organizational.reservedMinor));
  const chargedMinor = sum(tasks.map(({ budget }) => budget.organizational.chargedMinor));
  const requestedCostByCurrency = currencyTotals(
    tasks.flatMap(({ budget }) => budget.provider.attempts.map((attempt) => attempt.requestedCost)),
  );
  const appliedCostByCurrency = mergeCurrencyTotals(
    tasks.map(({ budget }) => budget.provider.appliedCostByCurrency),
  );
  const observedCostByCurrency = mergeCurrencyTotals(
    tasks.map(({ budget }) => budget.provider.observedCostByCurrency),
  );
  const taskIds = (status: TaskBudgetReport["provider"]["coverage"]["status"]) =>
    tasks
      .filter(({ budget }) => budget.provider.coverage.status === status)
      .map(({ taskId }) => taskId);
  const completeTaskIds = taskIds("complete");
  const partialTaskIds = taskIds("partial");
  const unknownTaskIds = taskIds("unknown");
  const pendingTaskIds = taskIds("pending");
  const currencyMismatchTaskIds = tasks
    .filter(({ budget }) => budget.provider.objectiveCurrencyComparison === "currency_mismatch")
    .map(({ taskId }) => taskId);
  const objectiveCurrencyComparison =
    objective.budgetCurrency == null
      ? ("internal_units" as const)
      : currencyMismatchTaskIds.length > 0
        ? ("currency_mismatch" as const)
        : ("matching" as const);
  return {
    organizational: {
      currency: objective.budgetCurrency ?? null,
      limitMinor: objective.budgetLimitMinor ?? null,
      reservedMinor: objective.reservedMinor,
      chargedMinor: objective.spentMinor,
      availableMinor:
        objective.budgetLimitMinor === null || objective.budgetLimitMinor === undefined
          ? null
          : objective.budgetLimitMinor - objective.reservedMinor - objective.spentMinor,
      visibleTasks: {
        allocatedMinor,
        reservedMinor,
        chargedMinor,
        reconcilesWithObjective:
          reservedMinor === objective.reservedMinor && chargedMinor === objective.spentMinor,
      },
    },
    provider: {
      requestedCostByCurrency,
      appliedCostByCurrency,
      observedCostByCurrency,
      coverage: {
        scope: "visible_tasks",
        completeForVisibleTasks:
          partialTaskIds.length === 0 &&
          unknownTaskIds.length === 0 &&
          pendingTaskIds.length === 0 &&
          currencyMismatchTaskIds.length === 0,
        completeTaskIds,
        partialTaskIds,
        unknownTaskIds,
        pendingTaskIds,
        currencyMismatchTaskIds,
        objectiveCurrencyComparison,
      },
    },
  };
}

function attemptCostCoverage(
  report: TaskExecutionLimitReport,
  status: TaskAttempt["status"],
): TaskAttemptBudgetReport["costCoverage"] {
  const requested = report.requested.maxReportedCost;
  const applied = report.applied?.maxReportedCost;
  const observed = report.observed.usage?.reportedCost;
  if (
    requested === undefined &&
    applied === undefined &&
    observed === undefined &&
    report.observed.usage == null
  )
    return "not_applicable";
  if (status === "running") return "pending";
  if (requested !== undefined && report.completeness.applied !== true) return "unknown";
  if (observed === undefined || report.observed.usage?.complete !== true) return "unknown";
  if (applied === undefined) return "complete";
  if (requested !== undefined && applied.limit.currency !== requested.currency) return "unknown";
  return observed.currency === applied.limit.currency ? "complete" : "unknown";
}

function taskCostCoverage(
  assignment: TaskAssignment,
  requested: CurrencyAmount | null,
  attempts: readonly TaskAttemptBudgetReport[],
): TaskBudgetReport["provider"]["coverage"] {
  const relevant =
    requested !== null ||
    attempts.some(
      (attempt) =>
        attempt.appliedCost !== null ||
        attempt.observedCost !== null ||
        attempt.limits.observed.usage != null,
    );
  const pendingAttemptIds = attempts
    .filter((attempt) => attempt.costCoverage === "pending")
    .map((attempt) => attempt.attemptId);
  const unknownAttemptIds = attempts
    .filter((attempt) => attempt.costCoverage === "unknown")
    .map((attempt) => attempt.attemptId);
  const completeCount = attempts.filter((attempt) => attempt.costCoverage === "complete").length;
  let status: TaskBudgetReport["provider"]["coverage"]["status"];
  if (!relevant) status = "not_applicable";
  else if (unknownAttemptIds.length > 0) status = completeCount > 0 ? "partial" : "unknown";
  else if (pendingAttemptIds.length > 0) status = "pending";
  else if (attempts.length === 0)
    status =
      assignment.status === "cancelled"
        ? "complete"
        : ["queued", "running", "waiting"].includes(assignment.status)
          ? "pending"
          : "unknown";
  else status = "complete";
  return {
    status,
    complete: status === "complete" || status === "not_applicable",
    unknownAttemptIds,
    pendingAttemptIds,
  };
}

function currencyTotals(
  values: readonly (CurrencyAmount | null)[],
): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const value of values) {
    if (value === null) continue;
    totals[value.currency] = (totals[value.currency] ?? 0) + value.amountMinor;
  }
  return totals;
}

function mergeCurrencyTotals(
  values: readonly Readonly<Record<string, number>>[],
): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const value of values)
    for (const [currency, amountMinor] of Object.entries(value))
      totals[currency] = (totals[currency] ?? 0) + amountMinor;
  return totals;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
