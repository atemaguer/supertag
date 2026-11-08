import {
  minutesUntilDeadline,
  type Objective,
  type ObjectiveSessionSummary,
  objectiveDeadlineGraceMs,
  objectiveDeadlineNotices,
  objectiveDeadlinePassed,
  objectiveHasReportedBudget,
  objectiveReportedBudgetExhausted,
  readableDuration,
  type Team,
  workSessionWaiting,
} from "@supertag/core";
import { objectivePool } from "./budget-report.js";

/**
 * The deadline and budget as every turn of the Objective should see them: time remaining, what
 * happens at each limit, and which limit observations were already recorded.
 */
export function objectiveLimitsView(objective: Objective, now: string) {
  const minutesRemaining = minutesUntilDeadline(objective.deadline, now);
  const state = objective.limitState ?? {};
  const limit = objective.budgetLimitMinor ?? null;
  const graceMs = objectiveDeadlineGraceMs(objective);
  const passed = objectiveDeadlinePassed(objective, now);
  return {
    deadline: objective.deadline
      ? {
          at: objective.deadline,
          minutesRemaining: Math.max(0, minutesRemaining ?? 0),
          remaining: passed
            ? "passed"
            : `${readableDuration(Date.parse(objective.deadline) - Date.parse(now))} left`,
          passed,
          graceMinutes: graceMs / 60_000,
          // Notices already raised for this deadline, newest last.
          notices: objectiveDeadlineNotices(objective).map(({ kind, at, message }) => ({
            kind,
            at,
            message,
          })),
          guidance: `At the deadline, new turns and work Sessions are refused. Running Task Attempts keep authority for ${readableDuration(graceMs).replace(/^about /, "")} more; the owner may complete the Objective with evidence in that time. After grace and running work settle, the Objective becomes limited.`,
        }
      : null,
    budget:
      limit === null
        ? null
        : objectiveHasReportedBudget(objective)
          ? {
              measure: "provider_reported_cost" as const,
              limitMinor: limit,
              currency: objective.budgetCurrency,
              reportedSpentMinor: state.reportedSpend?.amountMinor ?? null,
              overrunMinor: Math.max(0, (state.reportedSpend?.amountMinor ?? 0) - limit),
              reportedSpendObservedAt: state.reportedSpend?.observedAt ?? null,
              unknownCostAttempts: state.reportedSpend?.unknownAttemptIds.length ?? 0,
              exhausted: objectiveReportedBudgetExhausted(objective),
              guidance:
                "Provider-reported cost of every Task of the Objective's Sessions counts against this one pool. A work Session starts only while enough of it is left; at the limit new turns are refused, running Task Attempts finish and their overrun is recorded.",
            }
          : {
              measure: "unmeasured" as const,
              limitMinor: limit,
              currency: null,
              guidance:
                "The budget names no currency, so provider-reported cost cannot be counted against it.",
            },
  };
}

/** What `read_objective` returns: the Objective, its limits and pool, its Team and its Sessions. */
export function objectiveSummary(input: {
  readonly objective: Objective;
  readonly sessions: readonly ObjectiveSessionSummary[];
  readonly team: Team | undefined;
  /** Display names of the Tags this view mentions, by Tag ID. */
  readonly tagNames: Readonly<Record<string, string>>;
  readonly now?: string;
}) {
  const { objective, team, tagNames } = input;
  const name = (tagId: string) => tagNames[tagId] ?? tagId;
  return {
    id: objective.id,
    owner: name(objective.ownerTagId),
    status: objective.status,
    revision: objective.revision,
    outcome: objective.outcome,
    ongoing: Boolean(objective.ongoing),
    deadline: objective.deadline ?? null,
    pausedAt: objective.pausedAt ?? null,
    startedAt: objective.executionStartedAt ?? null,
    completionSummary: objective.completionSummary,
    workspaces: objective.workspaces ?? [],
    team: team
      ? {
          name: team.name,
          members: team.memberTagIds.map(name),
          maxConcurrency: team.maxConcurrency,
        }
      : null,
    limits: objectiveLimitsView(objective, input.now ?? new Date().toISOString()),
    budget: objectivePool(objective),
    sessions: input.sessions.map((session) => ({
      sessionId: session.sessionId,
      tag: name(session.tagId),
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(session.parentSessionId === undefined
        ? {}
        : { parentSessionId: session.parentSessionId }),
      status: !session.task
        ? "queued"
        : workSessionWaiting(session)
          ? "waiting"
          : session.task.status,
      ...(session.task?.question === undefined ? {} : { question: session.task.question }),
      ...(session.task?.approvals?.length ? { approvals: session.task.approvals } : {}),
    })),
  };
}
