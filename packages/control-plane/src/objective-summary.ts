import {
  minutesUntilDeadline,
  type Objective,
  objectiveDeadlineGraceMs,
  objectiveDeadlineNotices,
  objectiveDeadlinePassed,
  objectiveHasReportedBudget,
  objectiveReportedBudgetExhausted,
  readableDuration,
  TagMessagingError,
  type TaskAssignment,
  type Team,
  type Workstream,
} from "@supertag/core";

/**
 * The deadline and budget as every activation should see them: time remaining, what happens
 * at each limit, and which limit observations were already recorded.
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
          guidance: `At the deadline, new Tasks and continuations are refused. Running Task Attempts keep authority for ${readableDuration(graceMs).replace(/^about /, "")} more; the owner may complete the Objective with evidence in that time. After grace and running work settle, the Objective becomes limited and its owner records a final summary.`,
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
                "Provider-reported cost counts against this budget. At the limit, new Tasks and continuations are refused; running Task Attempts finish and their overrun is recorded.",
            }
          : {
              measure: "allocation" as const,
              limitMinor: limit,
              currency: null,
              committedMinor: objective.spentMinor + objective.reservedMinor,
              guidance: "Task allocations (maxCostMinor) are reserved against this budget.",
            },
  };
}

/** A discovery view: results, artifacts, and policy documents belong in detail reads. */
export function objectiveSummary(
  objective: Objective,
  tasks: readonly TaskAssignment[],
  teams: readonly Team[],
  workstreams: readonly Workstream[],
  input: Record<string, unknown>,
  now = new Date().toISOString(),
) {
  const limit = input["limit"] ?? 10;
  const offset = input["offset"] ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > 100 ||
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0
  )
    throw new TagMessagingError(400, "limit must be 1–100 and offset a nonnegative safe integer");
  const preview = (value: string | null | undefined, length = 200) =>
    value?.slice(0, length) ?? null;
  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  const active = (task: TaskAssignment) =>
    ["queued", "running", "waiting"].includes(task.status)
      ? 0
      : task.status === "submitted"
        ? 1
        : 2;
  const sortedTasks = [...tasks].sort(
    (a, b) =>
      active(a) - active(b) ||
      (a.status === "submitted" && b.status === "submitted"
        ? b.createdAt.localeCompare(a.createdAt)
        : a.createdAt.localeCompare(b.createdAt)) ||
      a.taskId.localeCompare(b.taskId),
  );
  const page = <T>(rows: readonly T[], project: (row: T) => Record<string, unknown>) => {
    const items: Record<string, unknown>[] = [];
    let bytes = 2;
    for (const row of rows.slice(offset as number, (offset as number) + (limit as number))) {
      let item = project(row);
      if (Buffer.byteLength(JSON.stringify(item)) > 4900) {
        item = {
          id: item["id"],
          taskId: item["taskId"],
          status: item["status"],
          detailsOmitted: true,
        };
      }
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (bytes + size > 5000) break;
      items.push(item);
      bytes += size;
    }
    if (!items.length && (offset as number) < rows.length)
      throw new TagMessagingError(
        400,
        "A summary identifier exceeds the response budget; inspect the resource directly",
      );
    return {
      items,
      total: rows.length,
      offset,
      nextOffset:
        (offset as number) + items.length < rows.length ? (offset as number) + items.length : null,
    };
  };
  const definition = [{ field: "outcome", index: 0, text: objective.outcome }].flatMap(
    ({ text, ...identity }) =>
      Array.from({ length: Math.max(1, Math.ceil(text.length / 400)) }, (_, part) => ({
        ...identity,
        characterOffset: part * 400,
        totalCharacters: text.length,
        text: text.slice(part * 400, (part + 1) * 400),
      })),
  );
  const definitionPage = page(definition, (part) => part);
  const visibleTasks = new Map(tasks.map((task) => [task.taskId, task]));
  const references = (ids: readonly string[]) => ({
    items: ids.slice(0, 5).map((taskId) => ({
      taskId,
      status: visibleTasks.get(taskId)?.status ?? "unavailable",
    })),
    total: ids.length,
  });
  const taskPage = page(sortedTasks, (task) => ({
    taskId: task.taskId,
    status: task.status,
    teamId: task.teamId,
    assignedTagId: task.assignedTagId,
    requestedByTagId: task.requestedByTagId,
    parentTaskId: task.parentTaskId,
    sourceMessageId: task.sourceMessageId,
    instructionPreview: preview(task.instruction),
    priority: task.priority,
    approval: task.approval,
    updatedAt: task.updatedAt,
    dependencies: references(task.dependencies ?? []),
    waiting:
      task.status === "waiting" && task.waitState
        ? {
            registeredAt: task.waitState.registeredAt,
            reasonPreview: preview(task.waitState.reason),
            acceptedTasks: references(task.waitState.acceptedTaskIds),
            submittedTasks: references(task.waitState.submittedTaskIds),
            mailbox: task.waitState.mailbox,
            workstreamPosts: task.waitState.workstreamPosts,
            notBefore: task.waitState.notBefore,
          }
        : null,
  }));
  const teamPage = page([...teams].sort(byId), (team) => ({
    id: team.id,
    namePreview: preview(team.name),
    leadTagId: team.leadTagId,
    status: team.status,
    revision: team.revision,
  }));
  const streamPage = page([...workstreams].sort(byId), (stream) => ({
    id: stream.id,
    titlePreview: preview(stream.title),
    ownerTagId: stream.ownerTagId,
    observationSource:
      objective.observations?.some((source) => source.workstreamId === stream.id) ?? false,
    lastAssessedSequence: objective.observationState?.cursors[stream.id],
  }));
  return {
    id: objective.id,
    ownerTagId: objective.ownerTagId,
    status: objective.status,
    revision: objective.revision,
    deadline: objective.deadline,
    executionStartedAt: objective.executionStartedAt,
    ongoing: Boolean(objective.ongoing),
    operatorClosureRequired: Boolean(objective.ongoing),
    observationDelivery: {
      blockedPreview: preview(objective.observationState?.blocked),
      pendingMessageId: objective.observationState?.pending?.messageId,
      assessmentTaskId: objective.observationState?.pending?.taskId,
      assessmentAttempt: objective.observationState?.pending?.attemptCount,
      through: objective.observationState?.pending?.through,
    },
    outcomePreview: preview(objective.outcome, 400),
    allocation: {
      limitMinor: objective.budgetLimitMinor,
      chargedMinor: objective.spentMinor,
      reservedMinor: objective.reservedMinor,
      currency: objective.budgetCurrency,
    },
    limits: objectiveLimitsView(objective, now),
    definition: definitionPage.items,
    tasks: taskPage.items,
    teams: teamPage.items,
    workstreams: streamPage.items,
    pages: {
      definition: { ...definitionPage, items: undefined },
      tasks: { ...taskPage, items: undefined },
      teams: { ...teamPage, items: undefined },
      workstreams: { ...streamPage, items: undefined },
    },
    details:
      "Definition contains lossless text parts of the outcome; follow pages.definition.nextOffset to read all parts. Other text fields are previews. Waiting shows registered conditions, not a prediction of progress: all Tasks within a nonempty accepted/submitted group must qualify; groups, mailbox, Workstream posts and timer are alternative wake conditions. Mailbox wakes require completed mailbox assignments. Dependency and wait references show at most five entries; unavailable means outside this view, not missing or failed. Use read_task for remaining references. Age alone does not prove a stall. Use read_task for full instructions, results, dependencies, artifacts and budget evidence; read_team/read_workstream for their details. Follow each collection's nextOffset with read_objective offset. Pages are live, not a snapshot; active/submitted Tasks sort first. No native transcript or overflow file is required.",
  };
}
