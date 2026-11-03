import type {
  JsonRecord,
  TagAuthorizationSnapshot,
  TagContextPlan,
  TaskEvent,
  TaskExecutionRequirements,
  TaskWorkspacePlan,
} from "./index.js";
import type { TagMessage } from "./mailbox.js";
import type { TeamOccupant } from "./team.js";
export type TeamTaskPriority = "urgent" | "high" | "normal" | "low";
export type TaskAssignmentStatus =
  | "queued"
  | "running"
  | "waiting"
  | "submitted"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "failed";
/**
 * Why the store declined to start a queued Task. `approval`: the Task awaits approval.
 * `retry_delay`: it may not start before `availableAt`. `objective`: the Objective admits no
 * new work, such as while paused. `objective_activation`: its Tag already runs an activation
 * in the same Objective (`taskIds`) that must finish first. `inactive_tag`: its assignee or
 * requester Tag is not active. `dependencies`: a dependency is not accepted. `team`: its Team
 * is inactive, does not serve the Objective, or no longer includes the assignee.
 * `team_concurrency`: its Team's maxConcurrency is full of running Tasks; `taskIds` names only
 * those in the Task's own Objective, and the message counts the rest.
 */
export interface TaskClaimDecline {
  readonly code:
    | "approval"
    | "retry_delay"
    | "objective"
    | "objective_activation"
    | "inactive_tag"
    | "dependencies"
    | "team"
    | "team_concurrency";
  /** One plain sentence naming the cause. */
  readonly message: string;
  readonly taskIds?: readonly string[];
  readonly teamId?: string;
  readonly tagId?: string;
  readonly availableAt?: string;
}
/**
 * What clears a declined claim, after a free Worker was found. Some declines clear on their own;
 * others need someone to act, so one sentence per code says which. Unknown codes get a neutral
 * sentence.
 */
export function taskClaimDeclineNextStep(code: string): string {
  switch (code) {
    case "retry_delay":
    case "objective_activation":
    case "dependencies":
    case "team_concurrency":
      return "A Worker was free; the Task starts when this clears.";
    case "approval":
      return "A Worker was free; the Task starts once it is approved.";
    case "objective":
      return "A Worker was free; the Task starts only if the Objective admits new work again, such as after a resume or a raised limit.";
    case "inactive_tag":
    case "team":
      return "A Worker was free; the Task cannot start until an operator fixes this.";
    default:
      return "A Worker was free; the Control Plane declined to start the Task.";
  }
}
export interface TaskAssignmentWaitState {
  /** Assignee-reported explanation; not an authorization or verified diagnosis. */
  readonly reason?: string;
  readonly acceptedTaskIds: readonly string[];
  readonly submittedTaskIds: readonly string[];
  readonly mailbox: boolean;
  readonly workstreamPosts?: { readonly workstreamId: string; readonly afterSequence: number };
  readonly notBefore: string | null;
  readonly registeredAt: string;
  readonly attemptCount: number;
  readonly mailboxTaskIds: readonly string[];
  readonly consumedMailboxTaskIds: readonly string[];
  /**
   * Set when the assignee changed its own execution with escalate_task. The wait wakes at once
   * and the next Task Attempt runs with the new execution.
   */
  readonly escalation?: { readonly change: string; readonly byTagId: string };
  readonly wake?: {
    readonly at: string;
    readonly reason:
      | "accepted_tasks"
      | "submitted_tasks"
      | "blocked_tasks"
      | "mailbox"
      | "time"
      | "workstream_posts"
      | "escalated"
      /** The Objective owner received a deadline notice: a warning or a moved deadline. */
      | "deadline"
      /** An Objective owner trigger was delivered to this activation; see `OwnerDeliveries`. */
      | "delivery"
      /** A waited-on or requested Task's Attempt became uncertain; see `TaskAttemptUncertainty`. */
      | "uncertain_tasks";
    readonly workstreamId?: string;
    readonly throughSequence?: number;
    readonly taskIds: readonly string[];
  };
}
/** Durable assignment metadata attached to the existing executable Task. */
export interface TaskAssignment {
  readonly taskId: string;
  /** Trusted communication activation; never an assignment or approval from its sender. */
  readonly activationKind?: "team_reply" | null;
  /** Set only for the controller's final bounded Objective limit summary. */
  readonly limitSummaryActivation: boolean;
  readonly objectiveId: string;
  readonly workstreamId: string | null;
  readonly parentTaskId: string | null;
  readonly sourceMessageId: string | null;
  readonly waitState: TaskAssignmentWaitState | null;
  readonly teamId: string;
  readonly requestedByTagId: string;
  readonly assignedTagId: string;
  readonly instruction: string;
  readonly acceptanceCriteria: readonly string[];
  /** Objective statement items this Task serves, in numeric order, such as ["1", "3"]. */
  readonly items: readonly string[];
  readonly dependencies: readonly string[];
  /** Scheduling priority used when selecting the next eligible Task. */
  readonly priority: TeamTaskPriority;
  readonly status: TaskAssignmentStatus;
  readonly approval: "pending" | "approved";
  readonly attemptCount: number;
  readonly reservedMinor: number;
  readonly chargedMinor: number | null;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  /**
   * Set while the running Task's current Attempt is uncertain. Read it through
   * {@link currentUncertainAttempt}, which ignores a record left from an earlier Attempt.
   */
  readonly uncertainAttempt?: TaskAttemptUncertainty | null;
  readonly result: JsonRecord | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/**
 * A running Task's Attempt whose Worker Host receipt is `unknown`: it may have executed, so
 * SuperTag never replays it, and it keeps its Worker's capacity. Only an operator on that Worker
 * Host can settle it, by confirming execution stopped with `supertag recover worklet`.
 */
export interface TaskAttemptUncertainty {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly detectedAt: string;
  /** Why the receipt became `unknown`, as the Worker Host recorded it. */
  readonly reason: string;
  readonly workerHostId?: string;
  readonly workerId?: string;
}
/** The uncertain Attempt of a running Task, or undefined when its current Attempt is not. */
export function currentUncertainAttempt(
  task: Pick<TaskAssignment, "status" | "attemptCount" | "uncertainAttempt">,
): TaskAttemptUncertainty | undefined {
  const uncertain = task.uncertainAttempt;
  return task.status === "running" && uncertain && uncertain.attemptNumber === task.attemptCount
    ? uncertain
    : undefined;
}
export interface AdmitTaskAssignmentInput {
  /** Trusted controller provenance for the delegating Task Attempt. */
  readonly sourceAttemptCount?: number;
  /** Trusted controller only: the one bounded owner summary after a limit. */
  readonly limitSummaryActivation?: true;
  /** Trusted controller receipt: several child results assigned to one managerial activation. */
  readonly followupSources?: { readonly parentTaskId: string; readonly taskIds: readonly string[] };
  /** Trusted controller only: atomically activate mailbox wake-ups on root admission. */
  readonly startObjectiveExecution?: true;
  readonly taskId: string;
  readonly objectiveId: string;
  readonly workstreamId?: string;
  readonly parentTaskId?: string;
  readonly teamId: string;
  readonly requestedByTagId: string;
  readonly assignedTagId: string;
  readonly instruction: string;
  readonly acceptanceCriteria: readonly string[];
  /** Objective statement items this Task serves, such as ["1", "3"]. */
  readonly items?: readonly string[];
  readonly dependencies?: readonly string[];
  /** Select immutable outputs from visible submitted, accepted, or rejected Tasks at admission. */
  readonly inputArtifacts?: readonly (
    | {
        readonly artifactId: string;
        readonly paths: readonly string[];
        /** Require reviewed acceptance when consuming an interface rather than repair evidence. */
        readonly requireAccepted?: boolean;
      }
    | {
        /** Select an exact cross-Objective publication; destination consent is resolved by Store. */
        readonly publicationApprovalId: string;
        readonly artifactId: string;
        readonly paths: readonly string[];
      }
  )[];
  readonly requiresApproval?: boolean;
  readonly maxCostMinor?: number;
  readonly execution: TaskExecutionRequirements;
  readonly authorizationSnapshot: TagAuthorizationSnapshot;
  readonly contextPlan: TagContextPlan;
  readonly workspacePlan: TaskWorkspacePlan;
}
/** Resource-shaped Task changes. The current status is the optimistic concurrency fence. */
export interface UpdateTaskAssignmentInput {
  readonly expectedStatus: TaskAssignmentStatus;
  readonly priority?: TeamTaskPriority;
  readonly approval?: "approved";
  readonly status?: "accepted" | "rejected" | "cancelled" | "queued";
  /** Explicit next-Attempt allocation; required with queued after budget exhaustion. */
  readonly executionLimits?: NonNullable<TaskExecutionRequirements["limits"]>;
  readonly assessment?: string;
  /** Closes one finding on the Task's result as fixed or accepted. */
  readonly finding?: import("./task-findings.js").TaskFindingClosure;
}
export interface TaskAssignmentStore {
  registerTaskAssignmentWait(input: {
    taskId: string;
    leaseOwner: string;
    attemptCount: number;
    acceptedTaskIds?: readonly string[];
    submittedTaskIds?: readonly string[];
    mailbox?: boolean;
    workstreamPosts?: { workstreamId: string; afterSequence: number };
    notBefore?: string;
    reason?: string;
  }): Promise<TaskAssignment>;
  /**
   * Records the assignee's change to its running Task's execution and ends the current Task
   * Attempt like a durable wait that wakes at once, so the Task continues in a new Attempt with
   * the new execution. Appends a `task.self-escalated` event; refuses after `maxEscalations`.
   */
  escalateTaskAssignment(input: {
    taskId: string;
    leaseOwner: string;
    attemptCount: number;
    execution: TaskExecutionRequirements;
    change: string;
    reason: string;
    maxEscalations: number;
  }): Promise<TaskAssignment>;
  wakeWaitingTaskAssignments(): Promise<readonly TaskAssignment[]>;
  reconcileObjectiveObservations(): Promise<void>;
  admitMailboxTaskAssignments(): Promise<readonly TaskAssignment[]>;
  getTaskAssignmentSourceMessage(taskId: string): Promise<TagMessage | undefined>;
  admitTaskAssignment(input: AdmitTaskAssignmentInput): Promise<TaskAssignment>;
  getTaskAssignment(taskId: string): Promise<TaskAssignment | undefined>;
  listTaskAssignments(objectiveId: string): Promise<readonly TaskAssignment[]>;
  countActiveTaskAssignments(): Promise<
    readonly {
      assignedTagId: string;
      objectiveId: string;
      status: "queued" | "running";
      count: number;
    }[]
  >;
  /**
   * Running Task Attempts of the given Teams across every Objective, the occupancy the scheduler
   * checks against each Team's maxConcurrency.
   */
  listRunningTeamOccupants(teamIds: readonly string[]): Promise<readonly TeamOccupant[]>;
  listTaskAssignmentFollowups(): Promise<readonly TaskAssignment[]>;
  /**
   * Completed or cancelled Objectives that still have live leftovers: queued or waiting Tasks,
   * submitted owner activations, or active Teams they govern.
   */
  listClosedObjectiveLeftovers(limit?: number): Promise<readonly string[]>;
  /**
   * Ends what a completed or cancelled Objective leaves behind, once its Tasks can no longer run:
   * closes the owner's submitted activations, which nobody reviews, and dissolves the Teams the
   * Objective governs when they serve no open Objective and hold no unfinished Task. Callers cancel
   * queued and waiting Tasks first through the ordinary cancellation path.
   */
  settleClosedObjective(
    objectiveId: string,
    reason: string,
  ): Promise<{
    readonly closedTaskIds: readonly string[];
    readonly dissolvedTeamIds: readonly string[];
  }>;
  /**
   * Latest owner Tasks of executing Objectives that need a continuation. With submitted results,
   * open findings, or unhandled operator input, other active delegated Tasks do not suppress an
   * owner wake. A queued, running, or waiting owner activation does suppress it.
   */
  listStalledObjectiveOwnerTasks(): Promise<readonly TaskAssignment[]>;
  /**
   * Delivers changes to Tasks the Objective owner delegated to the owner's open activation, the
   * queued, running, or waiting activation that receives the owner's triggers. Returns its Task ID,
   * or undefined when none is open and the caller should admit a follow-up instead.
   */
  deliverOwnerTaskChanges(
    objectiveId: string,
    taskIds: readonly string[],
  ): Promise<string | undefined>;
  listPendingTaskAssignments(options?: {
    readonly excludeTaskIds?: readonly string[];
    readonly approvalOnly?: boolean;
  }): Promise<readonly TaskAssignment[]>;
  /** Small fields needed on each Objective limit sweep; detailed budget evidence is read on change. */
  listTaskAssignmentLimitEntries(objectiveId: string): Promise<
    readonly (Pick<TaskAssignment, "taskId" | "status" | "updatedAt" | "limitSummaryActivation"> & {
      readonly eventSequence: number;
      readonly attemptUpdatedAt: string;
      readonly taskUpdatedAt: string;
    })[]
  >;
  /** Recheck a queued owner message before context; fail it if its Team grant was revoked. */
  recheckOwnerDeliveryMessage(messageId: string): Promise<boolean>;
  /**
   * Starts an Attempt for a queued Task, or returns undefined. When a queued Task cannot start
   * yet, `onDecline` receives why, so the scheduler can record it.
   */
  claimTaskAssignment(input: {
    taskId: string;
    leaseOwner: string;
    leaseSeconds?: number;
    onDecline?: (decline: TaskClaimDecline) => void;
  }): Promise<TaskAssignment | undefined>;
  claimTaskAssignmentRecovery(input: {
    taskId: string;
    attemptId: string;
    leaseOwner: string;
    leaseSeconds?: number;
  }): Promise<TaskAssignment | undefined>;
  releaseUnacceptedTaskAssignment(input: {
    taskId: string;
    attemptId: string;
    leaseOwner: string;
    attemptCount: number;
    reason: string;
    /** Delay persisted as availableAt by the same transaction that releases the Attempt. */
    retryAfterMs: number;
  }): Promise<TaskAssignment>;
  /**
   * Treats a running Attempt whose ephemeral Worker Host was removed as stopped. Like an expired
   * lease without durable execution, the Task is queued again when it holds no reserved budget and
   * has attempts left; otherwise it fails and needs explicit reassignment. Returns undefined when
   * the Attempt is no longer the Task's running Attempt or its lease is still live.
   */
  releaseLostTaskAssignment(input: {
    taskId: string;
    attemptId: string;
    workerHostId: string;
  }): Promise<TaskAssignment | undefined>;
  /**
   * Records that the running Task's current Attempt is uncertain, appends a
   * `task.attempt-uncertain` event, and wakes waiters through `wakeWaitingTaskAssignments`.
   * Returns undefined when the Attempt is no longer the Task's running Attempt or is already
   * recorded as uncertain. Recovery or settlement of the Attempt clears the record.
   */
  markTaskAssignmentUncertain(input: {
    taskId: string;
    attemptId: string;
    reason: string;
    workerHostId?: string;
    workerId?: string;
  }): Promise<TaskAssignment | undefined>;
  appendTaskAssignmentJournalEvent(input: {
    taskId: string;
    attemptId: string;
    leaseOwner: string;
    attemptCount: number;
    sequence: number;
    type: string;
    payload: JsonRecord;
  }): Promise<TaskEvent>;
  renewTaskAssignment(input: {
    taskId: string;
    leaseOwner: string;
    attemptCount: number;
    leaseSeconds?: number;
    /**
     * After the lease owner was suspended, also renew a lease that expired after this moment.
     * Only renewal accepts it; every other leased change still needs a current lease.
     */
    renewableSince?: string;
  }): Promise<TaskAssignment>;
  settleTaskAssignment(input: {
    taskId: string;
    leaseOwner: string;
    attemptCount: number;
    result: JsonRecord;
    terminalAttempt?: { id: string; status: "completed" | "failed" | "cancelled" };
    /** Internal: promote archived native state only with fenced durable-wait settlement. */
    waitSessionCompatibility?: string | undefined;
    failed?: boolean;
    retry?: boolean;
  }): Promise<TaskAssignment>;
  cancelTaskAssignment(
    taskId: string,
    actorTagId: string,
    /** Trusted callers only: why the Control Plane cancelled, merged into the result. */
    result?: JsonRecord,
  ): Promise<TaskAssignment>;
  approveTaskAssignment(taskId: string, actorTagId: string): Promise<TaskAssignment>;
  reviewTaskAssignment(
    taskId: string,
    actorTagId: string,
    accepted: boolean,
    assessment: string,
  ): Promise<TaskAssignment>;
  updateTaskAssignment(
    taskId: string,
    input: UpdateTaskAssignmentInput,
    actorTagId: string,
    options?: {
      readonly administrator?: boolean;
      /** The operator behind an administrative change, recorded when it closes a finding. */
      readonly operatorId?: string;
      /**
       * The Task whose Attempt made the change. When it is one of the Objective owner's own
       * activations, an accept, reject, or cancel is recorded as handled by it and never
       * delivered back to it.
       */
      readonly byTaskId?: string;
    },
  ): Promise<TaskAssignment>;
}

/** Stable bounded ID for a result wake-up, including for maximum-length Task IDs. */
export async function taskFollowupId(taskId: string): Promise<string> {
  const readable = `${taskId}:followup`;
  if (readable.length <= 200) return readable;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(taskId));
  return `followup:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
