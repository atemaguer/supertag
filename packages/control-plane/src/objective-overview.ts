import {
  type MountOutputManifest,
  type Objective,
  type ObjectiveSessionSummary,
  objectiveClosed,
  objectiveDeadlineGraceMs,
  objectiveHasReportedBudget,
  objectiveIdOfSessionKey,
  objectiveLimitEvents,
  placementHoldReason,
  readableDuration,
  type SpendUsage,
  type Store,
  storedTaskFindings,
  type Task,
  type TaskAttempt,
  type TaskDelivery,
  type TaskEvent,
  type Team,
  taskDelivery,
  type WorkstreamPost,
  workSessionWaiting,
} from "@supertag/core";
import type { ApprovalSummary } from "./approvals.js";
import { objectiveBudgetReport, objectivePool, taskBudgetReport } from "./budget-report.js";
import type { ObjectiveRunnableCondition } from "./objective-runnable.js";
import { objectiveLimitsView } from "./objective-summary.js";

type OverviewStore = Pick<
  Store,
  "findTaskById" | "listSessionTaskIds" | "listTaskAttempts" | "listTaskEvents" | "readSpend"
>;

export interface ObjectiveOverviewInput {
  readonly objectiveId: string;
  readonly limit?: number;
  readonly offset?: number;
}

interface Explanation {
  readonly kind: string;
  readonly message: string;
  readonly nextAction: string;
  readonly observedAt?: string;
}

/** Why a turn is held or how it ended, with the Harness that ran a failed Attempt. */
export interface ObjectiveTaskExplanation extends Explanation {
  readonly harness?: string;
  readonly failureKind?: string;
}

/** A high-severity finding in the latest result of one of the Objective's Sessions. */
export interface HighFinding {
  readonly taskId: string;
  readonly id: string;
  readonly summary: string;
  readonly location?: string;
}

/** The latest turn of one Session of the Objective. */
export interface ObjectiveSessionTask {
  readonly id: string;
  /** The Task's status, or `waiting` when it ended asking a question or waiting on an approval. */
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The question the turn asked, while it waits on the answer. */
  readonly question?: string;
  /** The Workspace the turn works in; null without one. */
  readonly workspace: string | null;
  readonly delivery: TaskDelivery | null;
  /** The latest Task Attempt's status, when one started. */
  readonly attemptStatus?: string;
  /** The result text the turn ended with, cut to 400 characters. */
  readonly report?: string;
  readonly explanations: readonly ObjectiveTaskExplanation[];
}

/** One turn of the Objective's conversation: what came in, or what the owner replied. */
export interface ObjectiveConversationMessage {
  readonly taskId: string;
  /** `operator` and `supertag` delivered a turn; `owner` is the owner Tag's reply. */
  readonly from: "operator" | "supertag" | "owner";
  readonly operatorId?: string;
  readonly text: string;
  readonly createdAt: string;
}

/** The newest turns of the Objective's conversation shown in the overview. */
const CONVERSATION_TURNS = 25;
const PREVIEW = 400;

const preview = (text: string | undefined) =>
  text === undefined ? undefined : text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text;

function sessionStatus(session: ObjectiveSessionSummary): string {
  if (!session.task) return "queued";
  return workSessionWaiting(session) ? "waiting" : session.task.status;
}

/** Bytes each Volume received from the Tasks' Attempts. */
function volumeWrites(attempts: readonly TaskAttempt[]) {
  const writes = new Map<
    string,
    { volume: string; files: number; bytes: number; partial: number; refused: number }
  >();
  for (const attempt of attempts)
    for (const manifest of attempt.mountOutputManifests ?? ([] as readonly MountOutputManifest[])) {
      const entry = writes.get(manifest.volume) ?? {
        volume: manifest.volume,
        files: 0,
        bytes: 0,
        partial: 0,
        refused: 0,
      };
      entry.files += manifest.objects.length;
      entry.bytes += manifest.objects.reduce((sum, object) => sum + object.size, 0);
      if (manifest.status === "partial") entry.partial++;
      if (manifest.status === "refused") entry.refused++;
      writes.set(manifest.volume, entry);
    }
  return [...writes.values()].sort((a, b) => a.volume.localeCompare(b.volume));
}

/** What an operator should look at, each with the next step. */
function attentionOf(
  objective: Objective,
  sessions: readonly ObjectiveSessionSummary[],
  approvals: ApprovalSummary | undefined,
  capturedAt: string,
): Explanation[] {
  const now = Date.parse(capturedAt);
  const attention: Explanation[] = [];
  if (!objective.executionStartedAt && !objectiveClosed(objective.status))
    attention.push({
      kind: "not_started",
      message: "The Objective's conversation has not started.",
      nextAction:
        "Fix what held the start, such as an owner Tag without a Worker Host, then rerun supertag create objective with this ID and the same definition.",
    });
  if (objective.pausedAt && !objectiveClosed(objective.status))
    attention.push({
      kind: "objective_paused",
      message: `An operator paused this Objective at ${objective.pausedAt}. No turn of its Sessions starts; running Task Attempts finish.`,
      nextAction: `supertag resume objective ${objective.id}`,
      observedAt: objective.pausedAt,
    });
  if (objective.status === "cancelled")
    attention.push({
      kind: "objective_cancelled",
      message: objective.cancellationReason
        ? `An operator cancelled this Objective: ${objective.cancellationReason}`
        : "An operator cancelled this Objective.",
      nextAction:
        "No new work starts for it. Create a new Objective to resume the outcome; a cancelled Objective cannot be reopened.",
      ...(objective.cancelledAt ? { observedAt: objective.cancelledAt } : {}),
    });
  if (objective.status === "blocked")
    attention.push({
      kind: "objective_blocked",
      message:
        "The Objective is blocked: its owner ended twice with nothing running and nothing asked, or marked it blocked.",
      nextAction:
        "Read the Objective's conversation, or open the Objective in the terminal UI and press m to message its owner.",
    });
  if (objective.status === "ready_for_review")
    attention.push({
      kind: "objective_review",
      message: "The owner submitted this Objective for review.",
      nextAction: `Review the owner's assessment and results. Run supertag approve objective ${objective.id} to approve, or open the Objective in the terminal UI and press m to request changes.`,
    });
  const question = sessions.find(
    (session) =>
      objectiveIdOfSessionKey(session.sessionKey) !== undefined &&
      session.task?.status === "completed" &&
      session.task.question !== undefined,
  );
  if (question?.task?.question !== undefined)
    attention.push({
      kind: "owner_question",
      message: `The owner asked: ${preview(question.task.question)}`,
      nextAction: "Answer the question under Waiting on you in the terminal UI.",
    });
  if (!objectiveClosed(objective.status)) {
    const recorded = new Map(objectiveLimitEvents(objective).map((event) => [event.kind, event]));
    const threshold = recorded.get("objective_budget_threshold");
    const exhausted = recorded.get("objective_budget_exhausted");
    if (threshold && !exhausted)
      attention.push({
        kind: "objective_budget_threshold",
        message: threshold.message,
        nextAction:
          "Review remaining work against the budget. An operator can raise it with supertag update objective --budget-minor.",
        observedAt: threshold.at,
      });
    if (exhausted)
      attention.push({
        kind: "objective_budget_exhausted",
        message: exhausted.message,
        nextAction:
          "Review provider usage and remaining work. Raise the budget with supertag update objective --budget-minor; new turns start again once the limit exceeds reported spend.",
        observedAt: exhausted.at,
      });
    const unknown = objective.limitState?.reportedSpend?.unknownAttemptIds ?? [];
    if (objectiveHasReportedBudget(objective) && unknown.length)
      attention.push({
        kind: "budget_coverage_incomplete",
        message: `${unknown.length} executed Task Attempt${unknown.length === 1 ? "" : "s"} reported no cost. Reported spend counts only known costs, so actual spend may be higher.`,
        nextAction:
          "Inspect those Task Attempts' usage evidence. Work under a monetary budget should run on Harnesses that report cost.",
        observedAt: objective.limitState?.reportedSpend?.observedAt ?? capturedAt,
      });
    const approaching = recorded.get("objective_deadline_approaching");
    if (approaching && objective.deadline && Date.parse(objective.deadline) > now)
      attention.push({
        kind: "objective_deadline_approaching",
        message: `The deadline ${objective.deadline} is near: ${readableDuration(Date.parse(objective.deadline) - now)} left.`,
        nextAction:
          "Review remaining work. An operator can move it with supertag update objective --deadline.",
        observedAt: approaching.at,
      });
    if (objective.deadline && Date.parse(objective.deadline) <= now)
      attention.push({
        kind: "deadline_passed",
        message:
          Date.parse(objective.deadline) + objectiveDeadlineGraceMs(objective) > now
            ? "The deadline has passed; new turns and work Sessions are refused. Running Task Attempts may finish during the grace period."
            : "The deadline grace period has ended. After running work settles, the Objective becomes limited.",
        nextAction:
          "Review remaining work. An operator can extend it with supertag update objective --deadline.",
        observedAt: recorded.get("deadline_passed")?.at ?? capturedAt,
      });
  }
  if (approvals && approvals.pending > 0)
    attention.push({
      kind: "approvals_pending",
      message: `${approvals.pending} approval request${approvals.pending === 1 ? " is" : "s are"} waiting for a decision.`,
      nextAction: `Review them with supertag list approval --objective ${objective.id}, then approve or deny each request.`,
      observedAt: capturedAt,
    });
  return attention;
}

/** Why an open turn is held, or why a finished one failed, from its stored records. */
function taskExplanations(input: {
  readonly objective: Objective;
  readonly task: Task;
  readonly attempts: readonly TaskAttempt[];
  readonly events: readonly TaskEvent[];
  readonly executionReadiness: string;
}): ObjectiveTaskExplanation[] {
  const { objective, task, events } = input;
  const explanations: ObjectiveTaskExplanation[] = [];
  const latest = input.attempts.toSorted((a, b) => b.attemptNumber - a.attemptNumber)[0];
  const attemptEvents = latest ? events.filter((event) => event.attemptId === latest.id) : [];
  if (task.status === "pending") {
    if (objective.pausedAt && !objectiveClosed(objective.status))
      explanations.push({
        kind: "objective_paused",
        message: "The Objective is paused; this turn starts once it resumes.",
        nextAction: `supertag resume objective ${objective.id}`,
      });
    if (input.executionReadiness !== "ready")
      explanations.push({
        kind: "controller",
        message: `Objective execution is ${input.executionReadiness}.`,
        nextAction: "Inspect Control Plane readiness and connected Worker Hosts.",
      });
    const diagnosis = events.findLast(
      (event) =>
        event.type === "task.scheduling-incompatible" ||
        event.type === "task.scheduling-compatible",
    );
    if (diagnosis?.type === "task.scheduling-incompatible") {
      const reason = placementHoldReason(diagnosis.payload);
      explanations.push({
        kind: "worker_requirements",
        message: reason
          ? `Waiting: ${reason}.`
          : "The last scheduling check found no compatible Worker.",
        nextAction: `Inspect it with supertag describe task ${task.id}. This is the last stored observation, not a live check.`,
        observedAt: diagnosis.createdAt,
      });
    }
  }
  const uncertain = attemptEvents.findLast((event) => event.type === "execution.uncertain");
  if (task.status === "running" && latest?.status === "running" && uncertain)
    explanations.push({
      kind: "attempt_uncertain",
      message: `Uncertain: Attempt ${latest.id} may have executed, so it will not be replayed.`,
      nextAction: `Inspect it with supertag describe task ${task.id}, then recover it on its Worker Host.`,
      observedAt: uncertain.createdAt,
    });
  if (task.status === "failed") {
    const failed = attemptEvents.findLast((event) => event.type === "execution.failed");
    const error = failed?.payload?.["error"];
    const message =
      error && typeof error === "object" && !Array.isArray(error)
        ? (error as Record<string, unknown>)["message"]
        : undefined;
    const execution = latest?.workerSnapshot["execution"];
    const harness =
      execution && typeof execution === "object" && !Array.isArray(execution)
        ? (execution as Record<string, unknown>)["harness"]
        : undefined;
    const failureKind = task.outcome?.["failureKind"];
    explanations.push({
      kind: "execution_failed",
      message: typeof message === "string" ? message : "The turn failed.",
      nextAction: `Inspect the failed Task Attempt with supertag describe task ${task.id}.`,
      ...(failed ? { observedAt: failed.createdAt } : {}),
      ...(typeof harness === "string" ? { harness } : {}),
      ...(typeof failureKind === "string" ? { failureKind } : {}),
    });
  }
  return explanations;
}

/** The latest turns of the Objective's own Session, oldest first. */
function conversationOf(tasks: readonly Task[]): ObjectiveConversationMessage[] {
  return tasks.slice(-CONVERSATION_TURNS).flatMap((task) => [
    ...(task.requestText
      ? [
          {
            taskId: task.id,
            from: task.actor.kind === "user" ? ("operator" as const) : ("supertag" as const),
            ...(task.actor.kind === "user" ? { operatorId: task.actor.id } : {}),
            text: task.requestText,
            createdAt: task.createdAt,
          },
        ]
      : []),
    ...(task.responseText
      ? [
          {
            taskId: task.id,
            from: "owner" as const,
            text: task.responseText,
            createdAt: task.endedAt ?? task.updatedAt,
          },
        ]
      : []),
  ]);
}

/** Read-only operator projection. The caller must authorize and scope every input. */
export async function buildObjectiveOverview(input: {
  readonly store: OverviewStore;
  readonly objective: Objective;
  readonly sessions: readonly ObjectiveSessionSummary[];
  readonly team: Team | undefined;
  readonly limit: number;
  readonly offset: number;
  readonly executionReadiness: string;
  readonly now?: string;
  readonly approvals?: ApprovalSummary;
  /** Status conditions, such as Runnable, computed from live Control Plane state. */
  readonly conditions?: readonly ObjectiveRunnableCondition[];
  /** Display names of the Tags this view mentions, by Tag ID. */
  readonly tagNames?: Readonly<Record<string, string>>;
  /** The Team's newest Workstream posts, oldest first. */
  readonly posts?: readonly WorkstreamPost[];
}) {
  const capturedAt = input.now ?? new Date().toISOString();
  const { objective, sessions } = input;
  const taskIdsBySession = await Promise.all(
    sessions.map(async (session) => ({
      session,
      taskIds: await input.store.listSessionTaskIds(session.sessionId),
    })),
  );
  // Tasks oldest first within each Session; the Objective's own Session comes first.
  const allTaskIds = taskIdsBySession.flatMap(({ session, taskIds }) =>
    taskIds.map((taskId) => ({ session, taskId })),
  );
  const selected = allTaskIds.slice(input.offset, input.offset + input.limit);
  const details = [];
  // Keep database fan-out bounded independently of the Objective's size.
  for (let offset = 0; offset < selected.length; offset += 8)
    details.push(
      ...(
        await Promise.all(
          selected.slice(offset, offset + 8).map(async ({ session, taskId }) => {
            const [task, attempts, events] = await Promise.all([
              input.store.findTaskById(taskId),
              input.store.listTaskAttempts(taskId),
              input.store.listTaskEvents(taskId),
            ]);
            return task ? [{ session, task, attempts, events }] : [];
          }),
        )
      ).flat(),
    );
  const tasks = details.map(({ session, task, attempts, events }) => ({
    taskId: task.id,
    sessionId: session.sessionId,
    tagId: task.tagId,
    status: task.status,
    ...(task.requestText === undefined ? {} : { request: preview(task.requestText) }),
    ...(task.responseText === undefined ? {} : { response: preview(task.responseText) }),
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    endedAt: task.endedAt ?? null,
    attempts: attempts
      .toSorted((a, b) => a.attemptNumber - b.attemptNumber)
      .map((attempt) => ({
        id: attempt.id,
        number: attempt.attemptNumber,
        status: attempt.status,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt ?? null,
        workerProfile: attempt.workerProfile,
      })),
    budget: taskBudgetReport({ objective, task, attempts, events }),
  }));
  // Each Session's latest turn, with what it delivered and why it is held or failed.
  const latestTurns = new Map<
    string,
    { readonly turn: ObjectiveSessionTask; readonly highFindings: readonly HighFinding[] }
  >();
  for (let offset = 0; offset < sessions.length; offset += 8)
    await Promise.all(
      sessions.slice(offset, offset + 8).map(async (session) => {
        if (session.task === undefined) return;
        const [task, attempts, events] = await Promise.all([
          input.store.findTaskById(session.task.id),
          input.store.listTaskAttempts(session.task.id),
          input.store.listTaskEvents(session.task.id),
        ]);
        if (task === undefined) return;
        const latest = attempts.toSorted((a, b) => b.attemptNumber - a.attemptNumber)[0];
        latestTurns.set(session.sessionId, {
          turn: {
            id: task.id,
            status: workSessionWaiting(session) ? "waiting" : task.status,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            ...(session.task.question === undefined ? {} : { question: session.task.question }),
            workspace:
              task.workspacePlan.status === "workspace" ? task.workspacePlan.workspace : null,
            delivery:
              taskDelivery({ workspacePlan: task.workspacePlan, result: task.result, events }) ??
              null,
            ...(latest === undefined ? {} : { attemptStatus: latest.status }),
            ...(task.responseText ? { report: preview(task.responseText) ?? "" } : {}),
            explanations: taskExplanations({
              objective,
              task,
              attempts,
              events,
              executionReadiness: input.executionReadiness,
            }),
          },
          highFindings: storedTaskFindings(task.result)
            .filter((finding) => finding.severity === "high")
            .map((finding) => ({
              taskId: task.id,
              id: finding.id,
              summary: finding.summary,
              ...(finding.location ? { location: finding.location } : {}),
            })),
        });
      }),
    );
  const ownerSession = taskIdsBySession.find(
    ({ session }) => objectiveIdOfSessionKey(session.sessionKey) === objective.id,
  );
  const ownerTasks = (
    await Promise.all(
      (ownerSession?.taskIds ?? [])
        .slice(-CONVERSATION_TURNS)
        .map((taskId) => input.store.findTaskById(taskId)),
    )
  ).filter((task): task is Task => task !== undefined);
  const spend = await input.store.readSpend({ by: "objective", objectiveIds: [objective.id] });
  const objectiveSpend: SpendUsage = spend.groups.find((group) => group.key === objective.id) ?? {
    attempts: 0,
    reportedCostByCurrency: null,
    unknownCostAttempts: 0,
    reportedTokens: null,
    unknownTokenAttempts: 0,
  };
  return {
    projectionVersion: 1 as const,
    capturedAt,
    consistency:
      "Observed records, not a transactional snapshot. Re-read before any mutation and use its existing status/revision fence.",
    objective,
    executionReadiness: input.executionReadiness,
    conditions: input.conditions ?? [],
    attention: attentionOf(objective, sessions, input.approvals, capturedAt),
    ...(input.approvals ? { approvals: input.approvals } : {}),
    tagNames: input.tagNames ?? {},
    team: input.team
      ? {
          id: input.team.id,
          name: input.team.name,
          memberTagIds: input.team.memberTagIds,
          maxConcurrency: input.team.maxConcurrency,
        }
      : null,
    limits: objectiveLimitsView(objective, capturedAt),
    pool: objectivePool(objective),
    objectiveSpend,
    conversation: conversationOf(ownerTasks),
    sessions: taskIdsBySession.map(({ session, taskIds }) => {
      const latest = latestTurns.get(session.sessionId);
      return {
        id: session.sessionId,
        tagId: session.tagId,
        /** The Objective's conversation, where the owner works. */
        owner: objectiveIdOfSessionKey(session.sessionKey) === objective.id,
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.parentSessionId === undefined
          ? {}
          : { parentSessionId: session.parentSessionId }),
        status: sessionStatus(session),
        ...(session.task?.question === undefined ? {} : { question: session.task.question }),
        ...(session.task?.approvals?.length ? { approvals: session.task.approvals } : {}),
        taskCount: taskIds.length,
        createdAt: session.createdAt,
        ...(latest === undefined ? {} : { task: latest.turn }),
      };
    }),
    highFindings: sessions.flatMap(
      (session) => latestTurns.get(session.sessionId)?.highFindings ?? [],
    ),
    posts: input.posts ?? [],
    pageUsage: {
      taskIds: tasks.map((task) => task.taskId),
      provider: objectiveBudgetReport(
        objective,
        tasks.map((task) => ({ taskId: task.taskId, budget: task.budget })),
      ).provider,
    },
    writes: volumeWrites(details.flatMap(({ attempts }) => attempts)),
    tasks,
    total: allTaskIds.length,
    offset: input.offset,
    nextOffset: input.offset + input.limit < allTaskIds.length ? input.offset + input.limit : null,
  };
}

export type ObjectiveOverview = Awaited<ReturnType<typeof buildObjectiveOverview>>;
