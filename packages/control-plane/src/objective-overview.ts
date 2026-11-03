import {
  buildCommitmentView,
  currentUncertainAttempt,
  type MountOutputManifest,
  type Objective,
  objectiveClosed,
  objectiveDeadlineGraceMs,
  objectiveHasReportedBudget,
  objectiveItemProgress,
  objectiveLimitEvents,
  objectiveReportedBudgetExhausted,
  ownerActivationAwaitsNoReview,
  readableDuration,
  resolveTeamScaling,
  SELF_ESCALATED_EVENT,
  type SpendUsage,
  type Store,
  storedTaskFindings,
  type TagMessage,
  type TaskAssignment,
  type TaskAssignmentStatus,
  type Team,
  type TeamLiveDelivery,
  type TeamOccupant,
  taskClaimDeclineNextStep,
  taskDelivery,
  teamRunningCount,
  uncertainAttemptRecoverCommand,
  unsandboxedCommandHoldsOf,
  unsandboxedCommandsReason,
  type WorkstreamPost,
} from "@supertag/core";
import type { ApprovalSummary } from "./approvals.js";
import { objectiveBudgetReport, taskBudgetReport } from "./budget-report.js";
import { isSchedulingEvent, SCHEDULING_WAITING_EVENT } from "./capacity-wait.js";
import type { ObjectiveRunnableCondition } from "./objective-runnable.js";

type OverviewStore = Pick<
  Store,
  | "findTaskById"
  | "listTaskAttempts"
  | "listTaskEvents"
  | "listOpenTeamMessages"
  | "listOpenWorkstreamPosts"
  | "readSpend"
>;

export interface ObjectiveOverviewInput {
  readonly objectiveId: string;
  readonly teamId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

interface Explanation {
  readonly kind: string;
  readonly message: string;
  readonly nextAction: string;
  readonly observedAt?: string;
  readonly harness?: string;
  readonly failureKind?: string;
}

const statuses: readonly TaskAssignmentStatus[] = [
  "queued",
  "running",
  "waiting",
  "submitted",
  "accepted",
  "rejected",
  "cancelled",
  "failed",
];

function performance(tasks: readonly TaskAssignment[], ownerTagId: string) {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
    TaskAssignmentStatus,
    number
  >;
  for (const task of tasks) counts[task.status]++;
  const reviewed = counts.accepted + counts.rejected;
  // The completion rule's exception: the owner's own submitted root activations have no reviewer.
  const unreviewed = tasks.filter((task) => ownerActivationAwaitsNoReview(task, ownerTagId)).length;
  return {
    total: tasks.length,
    states: counts,
    /** Running Tasks whose current Attempt is uncertain; they are also counted as running. */
    uncertain: tasks.filter((task) => currentUncertainAttempt(task) !== undefined).length,
    // Wait/resume executions also increment attemptCount; these are not all retries.
    additionalAttempts: tasks.reduce((sum, task) => sum + Math.max(0, task.attemptCount - 1), 0),
    review: {
      /** Submitted results someone must still accept or reject. */
      awaiting: counts.submitted - unreviewed,
      accepted: counts.accepted,
      rejected: counts.rejected,
      acceptanceRate: reviewed === 0 ? null : counts.accepted / reviewed,
    },
  };
}

const elapsed = (from: string | null | undefined, to: string | null | undefined) =>
  from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : 0;

type ActivationHistory = ReturnType<typeof activationHistory>;

/**
 * Historical queueing and waiting reconstructed from `task.activation-claimed` events. Activations
 * claimed before those events existed are counted as unrecorded rather than estimated.
 */
function activationHistory(
  events: readonly { readonly type: string; readonly payload?: Record<string, unknown> }[],
  attempts: readonly { readonly attemptNumber: number; readonly startedAt: string }[],
) {
  const history = {
    recordedActivations: 0,
    waitMs: 0,
    waitMsByReason: {} as Record<string, number>,
    wakeDetectionMs: 0,
    wakeDetectionUnknown: 0,
    queueMs: 0,
    dependencyWaitMs: 0,
    readyQueueMs: 0,
    startMs: 0,
  };
  for (const event of events) {
    const payload = event.payload;
    if (event.type !== "task.activation-claimed" || payload?.["version"] !== 1) continue;
    const queuedAt = String(payload["queuedAt"]);
    const claimedAt = String(payload["claimedAt"]);
    const dependenciesReadyAt = (payload["dependenciesReadyAt"] as string | null) ?? null;
    const availableAt = String(payload["availableAt"]);
    const wait = payload["wait"] as {
      registeredAt: string;
      conditionAt: string | null;
      wokenAt: string;
      reason: string;
    } | null;
    history.recordedActivations++;
    if (wait) {
      const waited = elapsed(wait.registeredAt, wait.wokenAt);
      history.waitMs += waited;
      history.waitMsByReason[wait.reason] = (history.waitMsByReason[wait.reason] ?? 0) + waited;
      if (wait.conditionAt) history.wakeDetectionMs += elapsed(wait.conditionAt, wait.wokenAt);
      else history.wakeDetectionUnknown++;
    }
    history.queueMs += elapsed(queuedAt, claimedAt);
    history.dependencyWaitMs += elapsed(
      queuedAt,
      dependenciesReadyAt && dependenciesReadyAt < claimedAt ? dependenciesReadyAt : null,
    );
    const readyAt = [queuedAt, availableAt, dependenciesReadyAt ?? queuedAt].reduce((a, b) =>
      b > a ? b : a,
    );
    history.readyQueueMs += elapsed(readyAt < claimedAt ? readyAt : claimedAt, claimedAt);
    const attempt = attempts.find(
      (candidate) => candidate.attemptNumber === payload["attemptNumber"],
    );
    history.startMs += elapsed(claimedAt, attempt?.startedAt);
  }
  return {
    ...history,
    unrecordedActivations: Math.max(0, attempts.length - history.recordedActivations),
  };
}

function sumActivationHistory(histories: readonly ActivationHistory[]): ActivationHistory {
  const total = activationHistory([], []);
  for (const history of histories) {
    for (const key of Object.keys(total) as (keyof ActivationHistory)[]) {
      if (key === "waitMsByReason") {
        for (const [reason, ms] of Object.entries(history.waitMsByReason))
          total.waitMsByReason[reason] = (total.waitMsByReason[reason] ?? 0) + ms;
      } else total[key] += history[key];
    }
  }
  return total;
}

/** Read-only projection. The caller must scope every input before invoking it. */
export async function buildObjectiveOverview(input: {
  readonly store: OverviewStore;
  readonly objective: Objective;
  readonly tasks: readonly TaskAssignment[];
  readonly teams: readonly Team[];
  /** Running work of these Teams across every Objective; defaults to this Objective's Tasks. */
  readonly teamOccupants?: readonly TeamOccupant[];
  readonly limit: number;
  readonly offset: number;
  readonly teamId?: string;
  readonly executionReadiness: string;
  readonly now?: string;
  /** Approval requests for this Objective; omitted by callers without approval storage. */
  readonly approvals?: ApprovalSummary;
  /** Status conditions, such as Runnable, computed from live Control Plane state. */
  readonly conditions?: readonly ObjectiveRunnableCondition[];
  /** Display names of the Tags this view mentions, by Tag ID. */
  readonly tagNames?: Readonly<Record<string, string>>;
  /** Recent messages between the operator and the owner, oldest first. */
  readonly conversation?: readonly ObjectiveConversationMessage[];
  readonly coordination?: {
    readonly posts: readonly WorkstreamPost[];
    readonly directMessages: readonly TagMessage[];
    /** Recent posts and direct messages injected into running Task Attempts, oldest first. */
    readonly liveDeliveries: readonly TeamLiveDelivery[];
  };
}) {
  const openCoordination = new Map(
    await Promise.all(
      input.teams.map(
        async (team) =>
          [
            team.id,
            {
              posts: await input.store.listOpenWorkstreamPosts(team.id, input.objective.id, 21),
              directMessages: await input.store.listOpenTeamMessages(
                team.id,
                input.objective.id,
                21,
              ),
            },
          ] as const,
      ),
    ),
  );
  const capturedAt = input.now ?? new Date().toISOString();
  const now = Date.parse(capturedAt);
  const { objective, teams } = input;
  // Delegated work first, then the owner's own activations (start, follow-up, assessment, and
  // Mailbox Tasks), which would otherwise bury it. Stable order while paging an unchanged
  // organization. This is not a snapshot cursor.
  const ownerActivation = (task: TaskAssignment) =>
    task.assignedTagId === objective.ownerTagId && !task.parentTaskId ? 1 : 0;
  const tasks = [...input.tasks].sort(
    (a, b) =>
      ownerActivation(a) - ownerActivation(b) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.taskId.localeCompare(b.taskId),
  );
  const spend = await input.store.readSpend({
    by: "objective",
    objectiveIds: [objective.id],
  });
  const group = spend.groups.find((group) => group.key === objective.id);
  const objectiveSpend: SpendUsage = group ?? {
    attempts: 0,
    reportedCostByCurrency: null,
    unknownCostAttempts: 0,
    reportedTokens: null,
    unknownTokenAttempts: 0,
  };
  const postTriggeredSpend = group?.postTriggered ?? objectiveSpend;
  const selected = tasks.slice(input.offset, input.offset + input.limit);
  const details = [];
  // Keep database fan-out bounded independently of the Objective's size.
  for (let offset = 0; offset < selected.length; offset += 8) {
    details.push(
      ...(await Promise.all(
        selected.slice(offset, offset + 8).map(async (assignment) => {
          const [task, attempts, events] = await Promise.all([
            input.store.findTaskById(assignment.taskId),
            input.store.listTaskAttempts(assignment.taskId),
            input.store.listTaskEvents(assignment.taskId),
          ]);
          return { assignment, task, attempts, events };
        }),
      )),
    );
  }
  const artifacts = new Map<string, readonly unknown[]>();
  for (const { assignment, task } of details) {
    if (Array.isArray(task?.trigger["inputArtifacts"]))
      artifacts.set(assignment.taskId, task.trigger["inputArtifacts"]);
  }
  const commitments = new Map(
    buildCommitmentView({
      objectiveId: objective.id,
      objectiveOwnerTagId: objective.ownerTagId,
      tasks,
      teams,
      now: capturedAt,
      inputArtifactsByTaskId: artifacts,
    }).commitments.map((item) => [item.taskId, item]),
  );
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const effectiveScaling = (team: Team) => {
    const lineage: Team[] = [];
    const seen = new Set<string>();
    let current: Team | undefined = team;
    while (current) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      lineage.unshift(current);
      if (current.parentTeamId === null) return resolveTeamScaling(lineage);
      current = teamById.get(current.parentTeamId);
    }
    // A scoped overview cannot infer limits from ancestors the viewer cannot see.
    return null;
  };
  // The scheduler's rule: only this Team's own running member Attempts occupy its throttle.
  const occupants = input.teamOccupants ?? input.tasks;
  const occupancy = new Map(teams.map((team) => [team.id, teamRunningCount(team, occupants)]));
  const taskDetails = details.map(({ assignment, task, attempts, events }) => {
    const commitment = commitments.get(assignment.taskId);
    if (!commitment) throw new Error("Objective Task projection missing");
    const explanations: Explanation[] = commitment.blockers.map((blocker) => {
      switch (blocker.kind) {
        case "approval":
          return {
            kind: blocker.kind,
            message: "Assignment needs approval.",
            nextAction:
              "Inspect read_task, then approve through update_task with its current expectedStatus.",
          };
        case "dependency":
          return {
            kind: blocker.kind,
            message: `Dependency ${blocker.taskId} is not known to be accepted in this view.`,
            nextAction:
              "Inspect the dependency and its review; completion alone does not satisfy acceptance.",
          };
        case "review":
          return {
            kind: blocker.kind,
            message: "Execution submitted a result that needs review.",
            nextAction:
              "Inspect its artifacts, then accept or reject through update_task with an assessment.",
          };
        case "wait": {
          const wait = assignment.waitState;
          const conditions = wait
            ? [
                ...(wait.acceptedTaskIds.length
                  ? [`acceptance of Tasks ${wait.acceptedTaskIds.join(", ")}`]
                  : []),
                ...(wait.submittedTaskIds.length
                  ? [`results from Tasks ${wait.submittedTaskIds.join(", ")}`]
                  : []),
                ...(wait.mailbox ? ["a Mailbox message"] : []),
                ...(wait.workstreamPosts
                  ? [`new posts in Workstream ${wait.workstreamPosts.workstreamId}`]
                  : []),
                ...(wait.notBefore ? [`time ${wait.notBefore}`] : []),
              ]
            : [];
          return {
            kind: blocker.kind,
            message: conditions.length
              ? `Registered wait for ${conditions.join(" or ")}.`
              : "The manager registered a durable wait; its conditions are unavailable.",
            nextAction:
              "Inspect waitState and the referenced Tasks, Mailbox, timer, or Workstream.",
          };
        }
        case "schedule":
          return {
            kind: blocker.kind,
            message: `Assignment is delayed until ${assignment.availableAt}.`,
            nextAction:
              "Inspect Task events for scheduling or admission backoff; wait for availableAt.",
          };
        case "repair":
          return {
            kind: blocker.kind,
            message: "The result failed or was rejected.",
            nextAction:
              "Inspect Task events and review evidence before explicitly assigning repair work.",
          };
        default:
          throw new Error("Unknown commitment blocker");
      }
    });
    if (assignment.status === "queued") {
      if (objective.status === "completed")
        explanations.push({
          kind: "objective_completed",
          message: "The Objective is completed; new dispatch is stopped.",
          nextAction: "Inspect the completion assessment before changing Objective status.",
        });
      if (objective.status === "cancelled")
        explanations.push({
          kind: "objective_cancelled",
          message: "The Objective is cancelled; new dispatch is stopped.",
          nextAction: "Cancel this Task, or cancel the Objective again to cancel its open Tasks.",
        });
      if (objective.deadline && Date.parse(objective.deadline) <= now)
        explanations.push({
          kind: "deadline",
          message: "The Objective deadline has passed.",
          nextAction:
            "Review the Objective constraints with its owner; no new execution can start.",
        });
      if (objectiveReportedBudgetExhausted(objective))
        explanations.push({
          kind: "objective_budget_exhausted",
          message: "Provider-reported spend reached the Objective budget.",
          nextAction: "An operator can raise the budget limit; no new execution can start.",
        });
      if (input.executionReadiness !== "ready")
        explanations.push({
          kind: "controller",
          message: `Objective execution is ${input.executionReadiness}.`,
          nextAction: "Inspect Control Plane readiness and connected Worker Hosts.",
        });
      const seen = new Set<string>();
      let teamId: string | null = assignment.teamId;
      while (teamId && !seen.has(teamId)) {
        seen.add(teamId);
        const team = teamById.get(teamId);
        if (!team) break;
        if (team.status !== "active")
          explanations.push({
            kind: "team_inactive",
            message: `Team ${team.id} is not active.`,
            nextAction: "Inspect Team membership and lifecycle before reassigning work.",
          });
        if (
          team.id === assignment.teamId &&
          team.maxConcurrency !== null &&
          (occupancy.get(team.id) ?? 0) >= team.maxConcurrency
        )
          explanations.push({
            kind: "team_capacity",
            message: `Running work by its members fills Team ${team.id}'s concurrency limit of ${team.maxConcurrency}.`,
            nextAction:
              "Inspect active Tasks before changing priority, or remove the Team's maxConcurrency if the throttle is no longer wanted.",
          });
        teamId = team.parentTeamId;
      }
      const diagnosis = events.findLast(isSchedulingEvent);
      // A dependency wait is already explained by the commitment's dependency blockers.
      // A declined claim found a free Worker; state the store's reason instead of a capacity one.
      if (
        diagnosis?.type === SCHEDULING_WAITING_EVENT &&
        diagnosis.payload?.["reason"] === "claim"
      ) {
        const claim = diagnosis.payload["claim"];
        const record =
          claim && typeof claim === "object" && !Array.isArray(claim)
            ? (claim as Record<string, unknown>)
            : {};
        explanations.push({
          kind: "claim_declined",
          message:
            typeof record["message"] === "string"
              ? record["message"]
              : "The Control Plane declined to start the Task.",
          nextAction: `${taskClaimDeclineNextStep(typeof record["code"] === "string" ? record["code"] : "")} This is the last stored observation, not a live check.`,
          observedAt: diagnosis.createdAt,
        });
      } else if (
        diagnosis?.type === SCHEDULING_WAITING_EVENT &&
        diagnosis.payload?.["reason"] !== "dependencies"
      ) {
        const hosts = Array.isArray(diagnosis.payload?.["hosts"])
          ? (diagnosis.payload["hosts"] as readonly Record<string, unknown>[])
          : [];
        explanations.push({
          kind: "worker_capacity",
          message:
            diagnosis.payload?.["reason"] === "capacity"
              ? `Every matching Worker is busy: ${hosts
                  .map(
                    (host) =>
                      `Worker Host ${String(host["workerHostId"])} (${Array.isArray(host["busyTaskIds"]) ? host["busyTaskIds"].length : 0} of ${String(host["capacity"])} busy)`,
                  )
                  .join(", ")}.`
              : "No eligible Worker Host has a matching Worker connected.",
          nextAction:
            "Wait for a running Task to finish, or raise the host's concurrency. This is the last stored observation, not a live capacity probe.",
          observedAt: diagnosis.createdAt,
        });
      }
      const logins = mcpLoginsOf(diagnosis?.payload);
      const unsandboxed = unsandboxedCommandHoldsOf(diagnosis?.payload);
      const workspaceRefusals = Array.isArray(diagnosis?.payload?.["workspaceRefusals"])
        ? diagnosis.payload["workspaceRefusals"].filter(
            (reason): reason is string => typeof reason === "string",
          )
        : [];
      if (diagnosis?.type === "task.scheduling-incompatible" && workspaceRefusals.length > 0)
        explanations.push({
          kind: "worker_requirements",
          message: workspaceRefusals.join(" "),
          nextAction: "Choose a Worker Profile whose Workspace environment can serve this source.",
          observedAt: diagnosis.createdAt,
        });
      else if (diagnosis?.type === "task.scheduling-incompatible" && unsandboxed.length > 0)
        explanations.push({
          kind: "worker_requirements",
          message: unsandboxed.map(unsandboxedCommandsReason).join(" "),
          nextAction:
            "Edit supertag.yaml on that Worker Host and run supertag up, or assign the work to a Tag whose host sandboxes commands, such as one running Codex.",
          observedAt: diagnosis.createdAt,
        });
      else if (diagnosis?.type === "task.scheduling-incompatible" && logins.length > 0)
        explanations.push({
          kind: "worker_requirements",
          message: `Held until MCP server ${logins.join(", ")} is logged in on its Worker Host; the login lapsed.`,
          nextAction: `On that Worker Host, run ${logins.map((server) => `supertag mcp login ${server}`).join(", then ")}.`,
          observedAt: diagnosis.createdAt,
        });
      else if (diagnosis?.type === "task.scheduling-incompatible") {
        const requirements = diagnosis.payload?.["unmetRequirements"];
        explanations.push({
          kind: "worker_requirements",
          message: `The last scheduler observation found no compatible Worker${Array.isArray(requirements) ? `: ${requirements.filter((item) => typeof item === "string").join(", ")}` : "."}`,
          nextAction:
            "Inspect the Task's execution requirements and connected Worker capabilities. This is the last stored observation, not a live capacity probe.",
          observedAt: diagnosis.createdAt,
        });
      }
    }
    const uncertain = currentUncertainAttempt(assignment);
    if (uncertain)
      explanations.push({
        kind: "attempt_uncertain",
        message: `Uncertain: Attempt ${uncertain.attemptId} may have executed, so it will not be replayed (${uncertain.reason.replace(/[.\s]*$/u, "")}). It keeps a Worker slot until an operator recovers it.`,
        nextAction: `On Worker Host ${uncertain.workerHostId ?? "that ran it"}, stop the host service first, confirm the Attempt's execution stopped, then run: ${uncertainAttemptRecoverCommand(assignment.taskId, uncertain)}`,
        observedAt: uncertain.detectedAt,
      });
    else if (
      assignment.result?.["outcomeUnknown"] === true ||
      (assignment.status === "running" &&
        assignment.leaseExpiresAt &&
        Date.parse(assignment.leaseExpiresAt) <= now)
    ) {
      explanations.push({
        kind: "recovery",
        message:
          "The execution outcome needs reconciliation; an expired lease does not prove it stopped.",
        nextAction:
          "Inspect the exact Attempt and Worker receipt. Do not blindly rerun external effects.",
      });
    }
    if (
      assignment.status === "failed" &&
      assignment.result?.["failureKind"] === "budget-exhausted"
    ) {
      explanations.push({
        kind: "budget_exhausted",
        message:
          "Execution stopped after exhausting its allocation. Accepted delivery remains valid.",
        nextAction:
          objective.status === "completed"
            ? "The Objective is completed. Review the recorded overrun; no renewal is required for accepted work."
            : "Review remaining work. An authorized manager other than the assignee, or an operator, can renew through update_task with queued status and explicit executionLimits. A Mailbox reply alone does not restart work.",
      });
    }
    const orderedAttempts = [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
    const latestAttempt = orderedAttempts.at(-1);
    const latestExecution = latestAttempt?.workerSnapshot["execution"];
    const failureHarness =
      latestExecution && typeof latestExecution === "object" && !Array.isArray(latestExecution)
        ? (latestExecution as Record<string, unknown>)["harness"]
        : undefined;
    const failure = assignment.result?.["error"];
    if (assignment.status === "failed" && typeof failure === "string")
      explanations.push({
        kind: "execution_failed",
        message: failure,
        ...(typeof assignment.result?.["failureKind"] === "string"
          ? { failureKind: assignment.result["failureKind"] }
          : {}),
        nextAction: "Inspect the failed Task Attempt before retrying.",
        observedAt: assignment.updatedAt,
        ...(typeof failureHarness === "string" ? { harness: failureHarness } : {}),
      });
    const deliveredCommits = assignment.result?.["deliveredCommits"] as
      | { readonly branch?: unknown; readonly head?: unknown }
      | null
      | undefined;
    if (assignment.status === "failed" && deliveredCommits && typeof deliveredCommits === "object")
      explanations.push({
        kind: "failed_after_delivering_commits",
        message: `Failed after delivering commits: branch ${String(deliveredCommits.branch)} reached ${String(deliveredCommits.head).slice(0, 12)} before the Attempt failed.`,
        nextAction:
          "Review the committed branch. The delegator can accept it with update_task status accepted, expectedStatus failed, and an assessment; it cannot be rejected or resumed this way.",
      });
    const budget = taskBudgetReport({ objective, assignment, task, attempts, events });
    const delivered = taskDelivery({
      ...(task?.workspacePlan === undefined ? {} : { workspacePlan: task.workspacePlan }),
      result: task?.result ?? assignment.result?.["taskResult"],
      events,
    });
    return {
      ...commitment,
      /** The running Task's uncertain Attempt, or null; see `TaskAttemptUncertainty`. */
      uncertainAttempt: uncertain ?? null,
      /** The Workspace the Task runs in, or null for a Task without one. */
      workspace: task?.workspacePlan?.status === "workspace" ? task.workspacePlan.workspace : null,
      /** What the Task delivered: its Workspace branch, patches, pull request, and outputs. */
      delivery: delivered ?? null,
      /** Changes the assignee made to its own execution with escalate_task, oldest first. */
      selfEscalations: events
        .filter((event) => event.type === SELF_ESCALATED_EVENT && event.payload)
        .map((event) => ({
          at: event.createdAt,
          byTagId: String(event.payload?.["byTagId"] ?? ""),
          change: String(event.payload?.["change"] ?? ""),
          reason: String(event.payload?.["reason"] ?? ""),
        })),
      explanations,
      schedulingObservation:
        "Recorded reasons are partial; their absence does not establish dispatch eligibility.",
      timing: {
        activationCount: assignment.attemptCount,
        currentWaitKind:
          assignment.status === "waiting" && assignment.waitState
            ? assignment.waitState.acceptedTaskIds.length ||
              assignment.waitState.submittedTaskIds.length
              ? "task_results"
              : "events_or_timer"
            : null,
        currentQueueMs:
          assignment.status === "queued"
            ? Math.max(0, now - Date.parse(assignment.updatedAt))
            : null,
        runningExecutionMs: orderedAttempts.reduce(
          (sum, attempt) =>
            sum +
            (!attempt.endedAt && attempt.status === "running"
              ? Math.max(0, now - Date.parse(attempt.startedAt))
              : 0),
          0,
        ),
        createdAt: assignment.createdAt,
        updatedAt: assignment.updatedAt,
        currentWaitMs:
          assignment.status === "waiting" && assignment.waitState
            ? Math.max(0, now - Date.parse(assignment.waitState.registeredAt))
            : null,
        completedExecutionMs: orderedAttempts.reduce(
          (sum, attempt) =>
            sum +
            (attempt.endedAt
              ? Math.max(0, Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt))
              : 0),
          0,
        ),
        completedExecutionCount: orderedAttempts.filter((attempt) => attempt.endedAt !== undefined)
          .length,
        history: activationHistory(events, orderedAttempts),
      },
      evidence: {
        taskId: assignment.taskId,
        latestAttemptId: latestAttempt?.id ?? null,
        producingAttemptId:
          assignment.status === "submitted" ||
          assignment.status === "accepted" ||
          assignment.status === "rejected"
            ? (orderedAttempts.find((attempt) => attempt.attemptNumber === assignment.attemptCount)
                ?.id ?? null)
            : null,
        resultAvailable: task?.result !== undefined || assignment.result !== null,
        events: { count: events.length, latestAt: events.at(-1)?.createdAt ?? null },
        attempts: orderedAttempts.map((attempt) => ({
          id: attempt.id,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt ?? null,
          workerProfile: attempt.workerProfile,
        })),
      },
      budget,
      limitSummaryActivation: assignment.limitSummaryActivation,
    };
  });
  const writesByVolume = new Map<
    string,
    { volume: string; files: number; bytes: number; partial: number; refused: number }
  >();
  for (const { attempts } of details)
    for (const attempt of attempts) {
      for (const manifest of attempt.mountOutputManifests ??
        ([] as readonly MountOutputManifest[])) {
        const entry = writesByVolume.get(manifest.volume) ?? {
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
        writesByVolume.set(manifest.volume, entry);
      }
    }
  const writes = [...writesByVolume.values()].sort((a, b) => a.volume.localeCompare(b.volume));
  const budget = objectiveBudgetReport(
    objective,
    taskDetails.map((task) => ({
      taskId: task.taskId,
      limitSummaryActivation: task.limitSummaryActivation,
      budget: task.budget,
    })),
  );
  const attemptReports = taskDetails.flatMap((task) => task.budget.provider.attempts);
  const usageReports = attemptReports.flatMap((attempt) =>
    attempt.limits.observed.usage ? [attempt.limits.observed.usage] : [],
  );
  const attention: Explanation[] = [];
  if (objective.observationState?.blocked)
    attention.push({
      kind: "observation_delivery_blocked",
      message: objective.observationState.blocked,
      nextAction:
        "Inspect the pending assessment and source permissions. Restore budget or capacity, or explicitly recover the existing Task. Reading observations alone does not acknowledge delivery.",
      observedAt: capturedAt,
    });
  if (!objective.executionStartedAt && !objectiveClosed(objective.status))
    attention.push({
      kind: "not_started",
      message: "The Objective has not been started.",
      nextAction:
        "Fix what held the start, such as an owner Tag without a Worker Host, then rerun supertag create objective with this ID and the same definition. API clients call start_objective.",
    });
  if (objective.pausedAt && !objectiveClosed(objective.status))
    attention.push({
      kind: "objective_paused",
      message: `An operator paused this Objective at ${objective.pausedAt}. No new Task, continuation, or follow-up starts; running Task Attempts finish.`,
      nextAction: `supertag resume objective ${objective.id}`,
      observedAt: objective.pausedAt,
    });
  if (
    !objective.pausedAt &&
    objective.executionStartedAt &&
    objective.status === "working" &&
    (!objective.observations?.length || Boolean(objective.observationState?.blocked)) &&
    tasks.some(
      (task) =>
        task.assignedTagId === objective.ownerTagId &&
        !task.parentTaskId &&
        ["submitted", "accepted", "failed", "cancelled", "rejected"].includes(task.status),
    ) &&
    !tasks.some((task) => ["queued", "running", "waiting"].includes(task.status))
  )
    attention.push({
      kind: "no_scheduled_follow_up",
      message:
        "The Objective remains working, but its owner has finished a root Task and no visible Task is queued, running, or durably waiting. This may require follow-up; it does not prove the outcome is unmet.",
      nextAction:
        "Review the owner's result and outstanding responsibilities. If work remains, arrange an authorized follow-up Task or Mailbox escalation. A prose request or promise to resume does not register a durable wait. Check the full Objective before acting on a Team-scoped view.",
      observedAt: capturedAt,
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
      kind: "owner_blocked",
      message: "The owner marked this Objective blocked.",
      nextAction:
        "Review its Tasks and contact the owner; this status is not a global execution pause.",
    });
  if (objective.status === "ready_for_review")
    attention.push({
      kind: "objective_review",
      message: "The owner submitted this Objective for review.",
      nextAction: `Review the owner's assessment and results. Approve with supertag approve objective ${objective.id}, or request changes with supertag message objective ${objective.id} TEXT.`,
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
          "Review remaining work against the budget. An operator can raise budgetLimitMinor with update_objective.",
        observedAt: threshold.at,
      });
    if (exhausted)
      attention.push({
        kind: "objective_budget_exhausted",
        message: exhausted.message,
        nextAction:
          "Review provider usage and remaining work. An operator can raise budgetLimitMinor with update_objective; admission resumes once the limit exceeds reported spend.",
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
          "Review remaining work. An operator can move the deadline with update_objective.",
        observedAt: approaching.at,
      });
    if (objective.deadline && Date.parse(objective.deadline) <= now)
      attention.push({
        kind: "deadline_passed",
        message:
          Date.parse(objective.deadline) + objectiveDeadlineGraceMs(objective) > now
            ? "The deadline has passed; new Tasks and continuations are refused. Running Task Attempts may finish during the grace period."
            : "The deadline grace period has ended. After running work settles, the Objective becomes limited and its owner records a final summary.",
        nextAction:
          "Review remaining work and the Objective's constraints. An operator can extend the deadline with update_objective.",
        observedAt: recorded.get("deadline_passed")?.at ?? capturedAt,
      });
  }
  if (input.approvals && input.approvals.pending > 0)
    attention.push({
      kind: "approvals_pending",
      message: `${input.approvals.pending} approval request${input.approvals.pending === 1 ? " is" : "s are"} waiting for a decision.`,
      nextAction: `Review them with supertag list approval --objective ${objective.id}, then approve or deny each request.`,
      observedAt: capturedAt,
    });
  if (budget.organizational.availableMinor !== null && budget.organizational.availableMinor <= 0)
    attention.push({
      kind: "allocation_exhausted",
      message:
        "No unallocated budget remains. Already reserved Tasks are not blocked by this fact alone.",
      nextAction: "Inspect allocations and provider usage separately before admitting more work.",
    });
  return {
    projectionVersion: 1 as const,
    objectiveSpend,
    postTriggeredSpend,
    capturedAt,
    consistency:
      "Observed records, not a transactional snapshot. Re-read before any mutation and use its existing status/revision fence.",
    objective,
    openHighFindings: tasks.flatMap((task) =>
      storedTaskFindings(task.result)
        .filter((finding) => finding.status === "open" && finding.severity === "high")
        .map((finding) => ({ taskId: task.taskId, ...finding })),
    ),
    executionReadiness: input.executionReadiness,
    conditions: input.conditions ?? [],
    scope: { objectiveId: objective.id, teamId: input.teamId ?? null },
    attention,
    ...(input.approvals ? { approvals: input.approvals } : {}),
    tagNames: input.tagNames ?? {},
    conversation: input.conversation ?? [],
    /** Each numbered statement item with every visible Task that serves it, not only this page. */
    items: objectiveItemProgress(objective.outcome, tasks),
    performance: {
      population:
        "Visible assignments, including coordination and Mailbox work; current review state, not a historical review-event count.",
      ...performance(tasks, objective.ownerTagId),
      byTeam: teams.map((team) => ({
        teamId: team.id,
        ...performance(
          tasks.filter((task) => task.teamId === team.id),
          objective.ownerTagId,
        ),
      })),
      byTag: [...new Set(tasks.map((task) => task.assignedTagId))].sort().map((tagId) => ({
        tagId,
        ...performance(
          tasks.filter((task) => task.assignedTagId === tagId),
          objective.ownerTagId,
        ),
      })),
    },
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      openCoordination: openCoordination.get(team.id) ?? { posts: [], directMessages: [] },
      leadTagId: team.leadTagId,
      parentTeamId: team.parentTeamId,
      status: team.status,
      maxConcurrency: team.maxConcurrency,
      scaling: team.scaling,
      effectiveScaling: effectiveScaling(team),
      running: occupancy.get(team.id) ?? 0,
    })),
    capacityCoverage:
      "Each Team's running count is its own members' running Task Attempts in every Objective it serves, the work its maxConcurrency limits; descendant Teams and waiting Tasks do not count.",
    allocation: {
      currency: objective.budgetCurrency ?? null,
      limitMinor: objective.budgetLimitMinor ?? null,
      reservedMinor: objective.reservedMinor,
      chargedMinor: objective.spentMinor,
      availableMinor: budget.organizational.availableMinor,
    },
    pageUsage: {
      byTag: [...new Set(taskDetails.map((task) => task.assignedTagId))].sort().map((tagId) => {
        const selectedTasks = taskDetails.filter((task) => task.assignedTagId === tagId);
        const reports = selectedTasks.flatMap((task) => task.budget.provider.attempts);
        const usage = reports.flatMap((report) =>
          report.limits.observed.usage ? [report.limits.observed.usage] : [],
        );
        return {
          tagId,
          taskCount: selectedTasks.length,
          activationCount: selectedTasks.reduce(
            (sum, task) => sum + task.timing.activationCount,
            0,
          ),
          completedExecutionMs: selectedTasks.reduce(
            (sum, task) => sum + task.timing.completedExecutionMs,
            0,
          ),
          runningExecutionMs: selectedTasks.reduce(
            (sum, task) => sum + task.timing.runningExecutionMs,
            0,
          ),
          history: sumActivationHistory(selectedTasks.map((task) => task.timing.history)),
          reportedTokens: usage.length
            ? usage.reduce((sum, report) => sum + report.totalTokens, 0)
            : null,
          reportingUsage: usage.length,
          completeUsage: usage.filter((report) => report.complete).length,
          recordedAttempts: reports.length,
        };
      }),
      taskIds: selected.map((task) => task.taskId),
      coversAllVisibleTasks: selected.length === tasks.length,
      provider: budget.provider,
      reportedTokens:
        usageReports.length === 0
          ? null
          : usageReports.reduce((total, usage) => total + usage.totalTokens, 0),
      observationCoverage: {
        attempts: attemptReports.length,
        reportingUsage: usageReports.length,
        completeUsage: usageReports.filter((usage) => usage.complete).length,
        reportingCost: attemptReports.filter((attempt) => attempt.observedCost !== null).length,
        missingUsageAttemptIds: attemptReports
          .filter((attempt) => !attempt.limits.observed.usage)
          .map((attempt) => attempt.attemptId),
        missingCostAttemptIds: attemptReports
          .filter((attempt) => attempt.observedCost === null)
          .map((attempt) => attempt.attemptId),
      },
    },
    coordination: input.coordination ?? { posts: [], directMessages: [], liveDeliveries: [] },
    writes,
    tasks: taskDetails,
    total: tasks.length,
    offset: input.offset,
    nextOffset: input.offset + input.limit < tasks.length ? input.offset + input.limit : null,
  };
}

export type ObjectiveOverview = Awaited<ReturnType<typeof buildObjectiveOverview>>;

/** One message between the operator and the Objective owner. */
export interface ObjectiveConversationMessage {
  readonly id: string;
  /** `owner` wrote to the operator; `operator` wrote to the owner. */
  readonly from: "owner" | "operator";
  readonly tagId: string;
  readonly operatorId?: string;
  readonly text: string;
  readonly needsReply?: boolean;
  /** For owner messages: pending until the operator replies or the Objective closes. */
  readonly status?: "pending" | "replied" | "reported" | "resolved";
  /** For a resolved owner question: why it left the inbox unanswered. */
  readonly resolutionReason?: string;
  readonly createdAt: string;
}

/** MCP servers a scheduling diagnosis holds for a login, validated as server names. */
export function mcpLoginsOf(payload: Readonly<Record<string, unknown>> | undefined): string[] {
  const value = payload?.["mcpLogins"];
  return Array.isArray(value)
    ? value.filter(
        (server): server is string =>
          typeof server === "string" && /^[a-z0-9][a-z0-9_-]{0,58}$/u.test(server),
      )
    : [];
}
