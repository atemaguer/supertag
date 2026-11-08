import {
  OBJECTIVE_BUDGET_WARNING_FRACTION,
  type ObjectiveLimitCandidate,
  type ObjectiveLimitState,
  objectiveDeadlineStopsRunning,
  objectiveDeadlineWarningMinutes,
  objectiveDeadlineWindowStart,
  objectiveHasReportedBudget,
  objectiveReportedBudgetExhausted,
} from "@supertag/core";
import type { ObjectiveBudgetReport } from "./budget-report.js";

/** Provider-reported spend in the Objective's currency, from persisted usage evidence. */
export interface ReportedSpend {
  readonly amountMinor: number;
  readonly currency: string;
  readonly unknownAttemptIds: readonly string[];
  readonly estimatedCostAttempts: number;
}

/** A limit becomes a status only after all in-flight Task Attempts have settled. */
export function objectiveShouldLimit(
  objective: ObjectiveLimitCandidate,
  state: ObjectiveLimitState,
  tasks: readonly { readonly status: string }[],
  now: string,
  deadlineGraceMs: number,
): boolean {
  return (
    objective.status !== "limited" &&
    (objectiveReportedBudgetExhausted({ ...objective, limitState: state }) ||
      objectiveDeadlineStopsRunning(objective, now, deadlineGraceMs)) &&
    tasks.every((task) => task.status !== "running")
  );
}

/** Reported spend from an Objective budget report covering every Task in the Objective. */
export function reportedSpend(
  objective: ObjectiveLimitCandidate,
  report: ObjectiveBudgetReport,
  attempts: readonly {
    readonly attemptId: string;
    readonly costCoverage: string;
    readonly observedCost?: { readonly estimated?: boolean } | null;
  }[],
): ReportedSpend | undefined {
  const currency = objective.budgetCurrency;
  if (!currency) return undefined;
  return {
    amountMinor: report.provider.observedCostByCurrency[currency] ?? 0,
    currency,
    unknownAttemptIds: attempts
      .filter((attempt) => attempt.costCoverage === "unknown")
      .map((attempt) => attempt.attemptId),
    estimatedCostAttempts: attempts.filter((attempt) => attempt.observedCost?.estimated === true)
      .length,
  };
}

/**
 * Records each limit observation once. Entries name the limit they were observed against,
 * so an increased budget or a moved deadline starts a fresh set of observations.
 */
export function evaluateObjectiveLimits(
  objective: ObjectiveLimitCandidate,
  now: string,
  spend: ReportedSpend | undefined,
): ObjectiveLimitState {
  const previous = objective.limitState ?? {};
  const reported = objectiveHasReportedBudget(objective);
  const limit = reported ? (objective.budgetLimitMinor as number) : null;
  const budgetWarnings =
    limit === null
      ? []
      : (previous.budgetWarnings ?? []).filter((entry) => entry.limitMinor === limit);
  let budgetExhausted =
    limit !== null && previous.budgetExhausted?.limitMinor === limit
      ? previous.budgetExhausted
      : undefined;
  if (limit !== null && spend) {
    const fraction = OBJECTIVE_BUDGET_WARNING_FRACTION;
    if (
      spend.amountMinor >= Math.ceil(fraction * limit) &&
      !budgetWarnings.some((entry) => entry.fraction === fraction)
    )
      budgetWarnings.push({ fraction, limitMinor: limit, spentMinor: spend.amountMinor, at: now });
    if (!budgetExhausted && spend.amountMinor >= limit)
      budgetExhausted = { limitMinor: limit, spentMinor: spend.amountMinor, at: now };
  }
  const deadline = objective.deadline ?? null;
  const deadlineSetAt =
    deadline && previous.deadlineSetAt?.deadline === deadline ? previous.deadlineSetAt : undefined;
  const deadlineWarnings = deadline
    ? (previous.deadlineWarnings ?? []).filter((entry) => entry.deadline === deadline)
    : [];
  let deadlinePassed =
    deadline && previous.deadlinePassed?.deadline === deadline
      ? previous.deadlinePassed
      : undefined;
  if (deadline) {
    const due = Date.parse(deadline);
    if (due > Date.parse(now)) {
      // Warnings already due when the deadline was set are skipped.
      const start = objectiveDeadlineWindowStart(objective) ?? objective.createdAt;
      for (const minutesBefore of objectiveDeadlineWarningMinutes(deadline, start)) {
        if (
          due - minutesBefore * 60_000 <= Date.parse(now) &&
          !deadlineWarnings.some((entry) => entry.minutesBefore === minutesBefore)
        )
          deadlineWarnings.push({ minutesBefore, deadline, at: now });
      }
    } else if (!deadlinePassed) deadlinePassed = { deadline, at: now };
  }
  return {
    ...(previous.summary ? { summary: previous.summary } : {}),
    ...(reported && spend
      ? {
          reportedSpend: {
            amountMinor: spend.amountMinor,
            currency: spend.currency,
            unknownAttemptIds: spend.unknownAttemptIds.slice(0, 50),
            estimatedCostAttempts: spend.estimatedCostAttempts,
            observedAt: now,
          },
        }
      : {}),
    ...(budgetWarnings.length ? { budgetWarnings } : {}),
    ...(budgetExhausted ? { budgetExhausted } : {}),
    ...(deadlineSetAt ? { deadlineSetAt } : {}),
    ...(deadlineWarnings.length ? { deadlineWarnings } : {}),
    ...(deadlinePassed ? { deadlinePassed } : {}),
  };
}

/** Key-order-independent JSON; PostgreSQL jsonb does not preserve key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** True when anything other than the spend observation time changed. */
export function limitStateChanged(
  previous: ObjectiveLimitState | undefined,
  next: ObjectiveLimitState,
): boolean {
  const comparable = (state: ObjectiveLimitState | undefined) => {
    if (!state) return "{}";
    const { reportedSpend, ...rest } = state;
    return canonical({
      ...rest,
      ...(reportedSpend
        ? {
            reportedSpend: {
              amountMinor: reportedSpend.amountMinor,
              currency: reportedSpend.currency,
              unknownAttemptIds: reportedSpend.unknownAttemptIds,
              estimatedCostAttempts: reportedSpend.estimatedCostAttempts,
            },
          }
        : {}),
    });
  };
  return comparable(previous) !== comparable(next);
}
