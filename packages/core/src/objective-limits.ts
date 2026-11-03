import type { Objective } from "./objective.js";

/** A monetary budget warns once when provider-reported spend reaches this share of its limit. */
export const OBJECTIVE_BUDGET_WARNING_FRACTION = 0.8;
/** A deadline warns once at each of these offsets, in minutes before it. */
export const OBJECTIVE_DEADLINE_WARNING_MINUTES = [1440, 60] as const;
/**
 * A deadline also warns once when this share of its window remains. The window runs from when
 * an operator last set the deadline (or the Objective was created) to the deadline.
 */
export const OBJECTIVE_DEADLINE_WARNING_FRACTION = 0.25;
/** Running Task Attempts keep their authority at most this long after the deadline passes. */
export const OBJECTIVE_DEADLINE_GRACE_MS = 15 * 60_000;
/** Short windows cap the grace period at this share of the window... */
export const OBJECTIVE_DEADLINE_GRACE_FRACTION = 0.25;
/** ...but never below this. */
export const OBJECTIVE_DEADLINE_MIN_GRACE_MS = 60_000;

/**
 * System-maintained record of limit observations. Every entry names the limit it was
 * observed against, so raising a budget or moving a deadline makes older entries inert.
 */
export interface ObjectiveLimitState {
  /** Identity of the one owner summary activation for the current limit transition. */
  readonly summaryTaskId?: string;
  /** Owner's final account of progress, open work, blockers, and the next step. */
  readonly summary?: { readonly text: string; readonly at: string };
  readonly reportedSpend?: {
    readonly amountMinor: number;
    readonly currency: string;
    /** Executed Task Attempts whose cost is unknown; they are not counted as zero. */
    readonly unknownAttemptIds: readonly string[];
    /** Task Attempts whose recorded cost comes from a model price estimate. */
    readonly estimatedCostAttempts?: number;
    readonly observedAt: string;
  };
  readonly budgetWarnings?: readonly {
    readonly fraction: number;
    readonly limitMinor: number;
    readonly spentMinor: number;
    readonly at: string;
  }[];
  readonly budgetExhausted?: {
    readonly limitMinor: number;
    readonly spentMinor: number;
    readonly at: string;
  };
  /** When an operator last set the deadline; warnings already due at that time are skipped. */
  readonly deadlineSetAt?: { readonly deadline: string; readonly at: string };
  readonly deadlineWarnings?: readonly {
    readonly minutesBefore: number;
    readonly deadline: string;
    readonly at: string;
  }[];
  readonly deadlinePassed?: { readonly deadline: string; readonly at: string };
}

interface LimitSubject {
  readonly status?: string;
  readonly createdAt?: string;
  readonly deadline?: string | null;
  readonly budgetLimitMinor?: number | null;
  readonly budgetCurrency?: string | null;
  readonly limitState?: ObjectiveLimitState | null;
  readonly pausedAt?: string | null;
}

export function objectiveDeadlinePassed(objective: LimitSubject, at: string): boolean {
  return Boolean(objective.deadline && objective.deadline <= at);
}

/**
 * When the current deadline's window started: the time an operator last set this deadline, or
 * the Objective's creation. Undefined without a deadline or a known start.
 */
export function objectiveDeadlineWindowStart(objective: LimitSubject): string | undefined {
  if (!objective.deadline) return undefined;
  const set = objective.limitState?.deadlineSetAt;
  return set?.deadline === objective.deadline ? set.at : objective.createdAt;
}

/**
 * How long running Task Attempts keep authority after the deadline: 15 minutes, capped at a
 * quarter of the deadline window for short windows, and never less than 1 minute. A deadline
 * that had already passed when it was set has no window and keeps the full 15 minutes.
 */
export function objectiveDeadlineGraceMs(objective: LimitSubject): number {
  const start = objectiveDeadlineWindowStart(objective);
  if (!objective.deadline || !start) return OBJECTIVE_DEADLINE_GRACE_MS;
  const windowMs = Date.parse(objective.deadline) - Date.parse(start);
  if (!(windowMs > 0)) return OBJECTIVE_DEADLINE_GRACE_MS;
  return Math.min(
    OBJECTIVE_DEADLINE_GRACE_MS,
    Math.max(
      OBJECTIVE_DEADLINE_MIN_GRACE_MS,
      Math.floor(windowMs * OBJECTIVE_DEADLINE_GRACE_FRACTION),
    ),
  );
}

/**
 * True once the deadline grace period ends. Until then, running Task Attempts keep their
 * authority and the owner may still complete the Objective; nothing new starts.
 */
export function objectiveDeadlineStopsRunning(
  objective: LimitSubject,
  at: string,
  graceMs = objectiveDeadlineGraceMs(objective),
): boolean {
  return Boolean(objective.deadline && Date.parse(objective.deadline) + graceMs <= Date.parse(at));
}

/**
 * The warning offsets, in whole minutes before the deadline, that apply to a deadline window:
 * 24 hours, 1 hour, and the point where a quarter of the window remains, largest first. An
 * offset already due when the window started is skipped.
 */
export function objectiveDeadlineWarningMinutes(deadline: string, windowStart: string): number[] {
  const due = Date.parse(deadline);
  const start = Date.parse(windowStart);
  const windowMs = due - start;
  if (!(windowMs > 0)) return [];
  const proportional = Math.max(
    1,
    Math.round((windowMs * OBJECTIVE_DEADLINE_WARNING_FRACTION) / 60_000),
  );
  return [...new Set<number>([...OBJECTIVE_DEADLINE_WARNING_MINUTES, proportional])]
    .filter((minutes) => due - minutes * 60_000 > start)
    .sort((a, b) => b - a);
}

/** A duration in readable units: "about 15 minutes", "about 12 hours", "about 3 days". */
export function readableDuration(ms: number): string {
  if (ms < 60_000) return "less than a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `about ${days} days`;
}

/** A budget with a currency caps provider-reported spend across the Objective. */
export function objectiveHasReportedBudget(objective: LimitSubject): boolean {
  return (
    objective.budgetLimitMinor !== null &&
    objective.budgetLimitMinor !== undefined &&
    typeof objective.budgetCurrency === "string"
  );
}

/** Reported spend reached the current limit, as last recorded by the Control Plane. */
export function objectiveReportedBudgetExhausted(objective: LimitSubject): boolean {
  return (
    objectiveHasReportedBudget(objective) &&
    objective.limitState?.budgetExhausted?.limitMinor === objective.budgetLimitMinor
  );
}

/** A reason new Tasks, continuations, and wakes cannot start, or undefined when they may. */
export function objectiveAdmissionBlocker(objective: LimitSubject, at: string): string | undefined {
  if (objective.status === "cancelled") return "Objective is cancelled";
  if (objective.status === "completed") return "Objective is completed";
  if (objective.status === "limited") return "Objective is limited";
  if (objective.pausedAt) return "Objective is paused";
  if (objectiveDeadlinePassed(objective, at)) return "Objective is past its deadline";
  if (objectiveReportedBudgetExhausted(objective)) return "Objective budget exhausted";
  return undefined;
}

/** Minutes until the deadline, negative after it; null without a deadline. */
export function minutesUntilDeadline(
  deadline: string | null | undefined,
  at: string,
): number | null {
  if (!deadline) return null;
  return Math.round((Date.parse(deadline) - Date.parse(at)) / 60_000);
}

/** Current, still-relevant limit events. Each has a stable key used for one notification. */
export interface ObjectiveLimitEvent {
  readonly key: string;
  readonly kind:
    | "objective_budget_threshold"
    | "objective_budget_exhausted"
    | "objective_deadline_approaching"
    | "deadline_passed";
  readonly at: string;
  readonly message: string;
}

export function objectiveLimitEvents(objective: Objective): ObjectiveLimitEvent[] {
  const state = objective.limitState ?? {};
  const limit = objective.budgetLimitMinor ?? null;
  const deadline = objective.deadline ?? null;
  const unit = objective.budgetCurrency ?? "";
  const events: ObjectiveLimitEvent[] = [];
  for (const entry of state.budgetWarnings ?? [])
    if (entry.limitMinor === limit)
      events.push({
        key: `budget-threshold-${entry.fraction}-${entry.limitMinor}`,
        kind: "objective_budget_threshold",
        at: entry.at,
        message: `Provider-reported spend reached ${Math.round(entry.fraction * 100)}% of the Objective budget: ${entry.spentMinor} of ${entry.limitMinor} minor units of ${unit}.`,
      });
  if (state.budgetExhausted && state.budgetExhausted.limitMinor === limit)
    events.push({
      key: `budget-exhausted-${state.budgetExhausted.limitMinor}`,
      kind: "objective_budget_exhausted",
      at: state.budgetExhausted.at,
      message: `Provider-reported spend reached the Objective budget: ${state.budgetExhausted.spentMinor} of ${state.budgetExhausted.limitMinor} minor units of ${unit}. New Tasks and continuations are refused; running Task Attempts finish, and cost beyond the limit is recorded as overrun.`,
    });
  for (const entry of state.deadlineWarnings ?? [])
    if (entry.deadline === deadline)
      events.push({
        key: `deadline-approaching-${entry.minutesBefore}-${entry.deadline}`,
        kind: "objective_deadline_approaching",
        at: entry.at,
        message: objectiveDeadlineWarningMessage(entry.deadline, entry.minutesBefore),
      });
  if (state.deadlinePassed && state.deadlinePassed.deadline === deadline)
    events.push({
      key: `deadline-passed-${state.deadlinePassed.deadline}`,
      kind: "deadline_passed",
      at: state.deadlinePassed.at,
      message: `The Objective deadline ${state.deadlinePassed.deadline} passed. New Tasks and continuations are refused. Running Task Attempts may finish for ${readableDuration(objectiveDeadlineGraceMs(objective)).replace(/^about /, "")}, and the owner may still complete the Objective in that time.`,
    });
  return events;
}

/** The warning text for a deadline approaching, stated as time left at the warning point. */
export function objectiveDeadlineWarningMessage(deadline: string, minutesBefore: number): string {
  return `The Objective deadline ${deadline} is near: ${readableDuration(minutesBefore * 60_000)} left.`;
}

/** A deadline event the owner should be told about, with a stable key for one delivery. */
export interface ObjectiveDeadlineNotice {
  readonly key: string;
  readonly kind: "objective_deadline_set" | "objective_deadline_approaching" | "deadline_passed";
  readonly deadline: string;
  readonly at: string;
  readonly message: string;
}

/**
 * Notices for the current deadline, oldest first: the operator setting or moving it, each
 * warning, and its passage. Entries for an earlier deadline are inert and never returned.
 */
export function objectiveDeadlineNotices(objective: LimitSubject): ObjectiveDeadlineNotice[] {
  const deadline = objective.deadline;
  if (!deadline) return [];
  const state = objective.limitState ?? {};
  const notices: ObjectiveDeadlineNotice[] = [];
  if (state.deadlineSetAt?.deadline === deadline)
    notices.push({
      key: `deadline-set-${deadline}-${state.deadlineSetAt.at}`,
      kind: "objective_deadline_set",
      deadline,
      at: state.deadlineSetAt.at,
      message: objectiveDeadlineSetMessage(deadline, state.deadlineSetAt.at),
    });
  for (const entry of state.deadlineWarnings ?? [])
    if (entry.deadline === deadline)
      notices.push({
        key: `deadline-approaching-${entry.minutesBefore}-${deadline}`,
        kind: "objective_deadline_approaching",
        deadline,
        at: entry.at,
        message: objectiveDeadlineWarningMessage(deadline, entry.minutesBefore),
      });
  if (state.deadlinePassed?.deadline === deadline)
    notices.push({
      key: `deadline-passed-${deadline}`,
      kind: "deadline_passed",
      deadline,
      at: state.deadlinePassed.at,
      message: `The Objective deadline ${deadline} passed. New Tasks and continuations are refused. Complete the Objective now if its statement is satisfied; running Task Attempts keep authority for ${readableDuration(objectiveDeadlineGraceMs(objective)).replace(/^about /, "")}.`,
    });
  return notices.sort((a, b) => a.at.localeCompare(b.at));
}

/** The notice an owner receives when an operator sets or moves the deadline. */
export function objectiveDeadlineSetMessage(
  deadline: string,
  at: string,
  previous?: string | null,
): string {
  const left = Date.parse(deadline) - Date.parse(at);
  return `${previous ? `An operator moved the Objective deadline from ${previous} to ${deadline}` : `An operator set the Objective deadline to ${deadline}`}: ${left > 0 ? `${readableDuration(left)} left` : "it has already passed"}. Deadline warnings now follow this deadline. Plan the remaining work to finish before it.`;
}
