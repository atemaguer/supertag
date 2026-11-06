import type { Task } from "./index.js";
import { mailboxObject, mailboxText, TagMessagingError } from "./mailbox.js";
import type { ObjectiveLimitState } from "./objective-limits.js";
import type { TaskAssignment } from "./task-assignment.js";
import { parseWorkspaceNames } from "./workspace.js";

export const OBJECTIVE_STATUSES = [
  "working",
  "blocked",
  "limited",
  "ready_for_review",
  "completed",
  "cancelled",
] as const;
/**
 * Statuses a status update may set. `cancelled` is absent: only an operator cancels an
 * Objective, through the cancellation request that also stops its Tasks.
 */
export const OBJECTIVE_UPDATE_STATUSES = [
  "working",
  "blocked",
  "limited",
  "ready_for_review",
  "completed",
] as const;
export type ObjectiveUpdateStatus = (typeof OBJECTIVE_UPDATE_STATUSES)[number];
/** Terminal statuses: no new Tasks, continuations, wakes, observations, or limit warnings. */
export const OBJECTIVE_CLOSED_STATUSES = ["completed", "cancelled"] as const;
export function objectiveClosed(status: string): boolean {
  return status === "completed" || status === "cancelled";
}
/** The fields that identify one of the Objective owner's own activations. */
export interface OwnerActivationCandidate {
  readonly taskId: string;
  readonly objectiveId: string;
  readonly teamId: string;
  readonly assignedTagId: string;
  readonly requestedByTagId: string;
  readonly parentTaskId: string | null;
  readonly sourceMessageId?: string | null;
  readonly activationKind?: "team_reply" | null;
}
/**
 * One of the owner's own activations: its start Task or any other owner root Task in the
 * Objective's Leadership Team, which SuperTag creates for them, a follow-up or assessment
 * follow-up that resumes it (`...:followup`, `followup:<digest>`), an authenticated surface
 * instruction, or a Mailbox delivery the owner requested of itself. Nobody reviews these, so they end with the
 * activation. Work assigned directly to the owner in another Team is not one; it waits
 * for review like any other Task.
 */
export function ownerActivation(task: OwnerActivationCandidate, ownerTagId: string): boolean {
  if (
    task.activationKind === "team_reply" ||
    task.assignedTagId !== ownerTagId ||
    task.parentTaskId
  )
    return false;
  if (typeof task.sourceMessageId === "string") return task.requestedByTagId === task.assignedTagId;
  return (
    task.teamId === `${task.objectiveId}:leadership` ||
    task.taskId === `${task.objectiveId}:start` ||
    task.taskId.endsWith(":followup") ||
    task.taskId.startsWith("followup:") ||
    task.taskId.startsWith("surface-instruction:")
  );
}
/**
 * An owner activation that receives the owner's other triggers while it is queued, running, or
 * waiting: one in the Objective's Leadership Team. A surface instruction is excluded because it
 * carries the authority of the person who sent it, not the owner's.
 */
export function ownerActivationReceivesTriggers(
  task: OwnerActivationCandidate,
  ownerTagId: string,
): boolean {
  return (
    ownerActivation(task, ownerTagId) &&
    task.teamId === `${task.objectiveId}:leadership` &&
    !task.taskId.startsWith("surface-instruction:")
  );
}
/**
 * A trigger delivered to the owner's open activation instead of starting another activation: a
 * Tag message addressed to the owner, or a change to a Task the owner delegated.
 */
export interface OwnerDelivery {
  readonly kind: "message" | "task";
  /** The Tag message ID or the delegated Task ID. */
  readonly id: string;
  /** The Task Attempt that received the delivery in its context; null until the next one starts. */
  readonly attempt: number | null;
}
/** Deliveries recorded on an owner activation, stored as `ownerDeliveries` in its Task trigger. */
export interface OwnerDeliveries {
  /** Deliveries no successful Task Attempt has handled yet. */
  readonly pending: readonly OwnerDelivery[];
  /** Delegated Tasks whose change an activation already handled; they need no follow-up. */
  readonly handledTaskIds: readonly string[];
}
/** Reads an activation's deliveries from its Task trigger, tolerating absent or malformed data. */
export function ownerDeliveries(trigger: unknown): OwnerDeliveries {
  const value =
    trigger && typeof trigger === "object" && !Array.isArray(trigger)
      ? (trigger as Record<string, unknown>)["ownerDeliveries"]
      : undefined;
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const pending = Array.isArray(record["pending"])
    ? (record["pending"] as unknown[]).flatMap((entry): OwnerDelivery[] => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as Record<string, unknown>;
        return (item["kind"] === "message" || item["kind"] === "task") &&
          typeof item["id"] === "string" &&
          (item["attempt"] === null || Number.isSafeInteger(item["attempt"]))
          ? [{ kind: item["kind"], id: item["id"], attempt: item["attempt"] as number | null }]
          : [];
      })
    : [];
  const handledTaskIds = Array.isArray(record["handledTaskIds"])
    ? (record["handledTaskIds"] as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  return { pending, handledTaskIds };
}
/**
 * A submitted result from one of the owner's own activations. Nobody reviews these, so they never
 * hold completion and never count as needing review.
 */
export function ownerActivationAwaitsNoReview(
  task: OwnerActivationCandidate & { readonly status: string },
  ownerTagId: string,
): boolean {
  return task.status === "submitted" && ownerActivation(task, ownerTagId);
}
export interface ObjectiveObservationState {
  readonly nextSource?: number;
  readonly cursors: Readonly<Record<string, number>>;
  readonly pending?: {
    readonly messageId: string;
    /** Existing owner activation responsible for this batch, when one can safely be reused. */
    readonly taskId?: string;
    readonly attemptCount?: number;
    readonly through: Readonly<Record<string, number>>;
  };
  readonly blocked?: string;
}
export interface CreateObjectiveInput {
  /** Ongoing responsibilities remain active until an operator ends them. */
  readonly ongoing?: boolean;
  /** Operator-configured Team channels whose posts require owner assessment. */
  readonly observations?: readonly { readonly workstreamId: string }[];
  readonly id: string;
  /**
   * One natural-language statement: the result, how success is verified, what must not change,
   * and when to ask a person.
   */
  readonly outcome: string;
  readonly deadline?: string | null;
  readonly budgetLimitMinor?: number | null;
  /** Uppercase three-letter currency code; absent values keep budgets as internal allocation units. */
  readonly budgetCurrency?: string | null;
  /**
   * Runtime actions, such as `files:write`, that the Objective's Tasks may receive. Operator
   * creation without this field defaults it to the actions the owner Tag's Permission Sets allow,
   * resolved once at creation; an explicit list narrows that set. Never granted by membership.
   */
  readonly runtimeActions?: readonly string[];
  /** Operator-selected verified surface Task used for operational notifications. */
  readonly notificationTaskId?: string | null;
  /**
   * Named Workspaces this Objective's Tasks may work in. With exactly one, Tasks use it by
   * default; with several, a lead chooses one per Task.
   */
  readonly workspaces?: readonly string[];
}
export interface Objective extends CreateObjectiveInput {
  readonly observationState?: ObjectiveObservationState;
  /** Read-only limit observations: warnings raised, budget exhaustion, deadline passage. */
  readonly limitState?: ObjectiveLimitState;
  readonly ownerTagId: string;
  readonly status: ObjectiveStatus;
  readonly revision: number;
  readonly completionSummary: string | null;
  /** When an operator cancelled the Objective; null otherwise. */
  readonly cancelledAt?: string | null;
  /** The operator's reason for cancelling, when one was given. */
  readonly cancellationReason?: string | null;
  /** When an operator paused the Objective; null while it runs. */
  readonly pausedAt?: string | null;
  /** Set by durable Objective start admission, not ordinary Objective creation. */
  readonly executionStartedAt?: string | null;
  /** Verified originating surface Task and its exact conversation Session. */
  readonly surfaceTaskId?: string | null;
  readonly surfaceSessionId?: string | null;
  readonly spentMinor: number;
  readonly reservedMinor: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/** Narrow fields the periodic limit sweep needs from each executing Objective. */
export type ObjectiveLimitCandidate = Pick<
  Objective,
  | "id"
  | "ownerTagId"
  | "status"
  | "revision"
  | "createdAt"
  | "deadline"
  | "budgetLimitMinor"
  | "budgetCurrency"
  | "limitState"
  | "spentMinor"
  | "reservedMinor"
>;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];
export interface CancelObjectiveInput {
  /** Optional operator explanation, recorded on the Objective and sent to its owner. */
  readonly reason?: string | null;
}
export interface UpdateObjectiveStatusInput {
  /** Operators may explicitly increase a finite Objective allocation. */
  readonly budgetLimitMinor?: number;
  /** Operators only. A new deadline, including after the old one passed. */
  readonly deadline?: string;
  readonly status?: ObjectiveUpdateStatus;
  readonly expectedRevision: number;
  /** Administrative only; null restores the default notification destination. */
  readonly notificationTaskId?: string | null;
  /**
   * Operators only. Replaces the Objective's runtime actions for Tasks admitted afterwards;
   * accepted Tasks keep their snapshot.
   */
  readonly runtimeActions?: readonly string[];
  /**
   * Required when completing or recording a limit summary. Optional with ready_for_review.
   */
  readonly completionSummary?: string;
}
export interface CreateSurfaceObjectiveInput {
  readonly taskId: string;
  readonly outcome: string;
  readonly deadline?: string | null;
  readonly budgetLimitMinor?: number | null;
  readonly budgetCurrency?: string | null;
  /**
   * A subset of the Workspaces the originating location attaches. Omitted: all of them. A GitHub
   * location without explicit Workspaces attaches those whose `source` is its repository.
   */
  readonly workspaces?: readonly string[];
}
export interface ObjectiveStore {
  createSurfaceObjective(input: CreateSurfaceObjectiveInput): Promise<Objective>;
  attachSurfaceObjective(taskId: string, objectiveId: string): Promise<Objective>;
  getSurfaceObjective(taskId: string): Promise<Objective | undefined>;
  /** Trusted outbox access to the original verified surface Task. */
  getObjectiveSurfaceTask(objectiveId: string): Promise<Task | undefined>;
  /** Trusted notification routing: revalidate a human-originated surface destination. */
  getVerifiedSurfaceTask(taskId: string): Promise<Task | undefined>;
  /**
   * The most recently updated Objective whose notification thread is this Session: its
   * notificationTaskId, or else its originating surface Task, belongs to the Session.
   */
  findObjectiveByNotificationSession(sessionId: string): Promise<Objective | undefined>;
  createObjective(
    input: CreateObjectiveInput & { readonly ownerTagId: string },
    /** A dry run validates exactly as creation does and returns the would-be Objective. */
    options?: { readonly dryRun?: boolean },
  ): Promise<Objective>;
  /** Viewer omitted only for trusted administrative callers. */
  getObjective(id: string, viewerTagId?: string): Promise<Objective>;
  /** Operator listing; a Tag filter matches the Objective owner exactly. */
  listObjectives(tagId?: string, limit?: number, offset?: number): Promise<readonly Objective[]>;
  /** Tag mailbox listing; includes Objectives visible through Team membership. */
  listVisibleObjectives(tagId: string, limit?: number): Promise<readonly Objective[]>;
  updateObjectiveStatus(
    id: string,
    input: UpdateObjectiveStatusInput,
    actorTagId?: string,
    /** Trusted active execution completing its own Objective, never tool input. */
    execution?: {
      readonly taskId: string;
      readonly attemptCount: number;
      readonly leaseOwner: string;
    },
    /** Trusted administrative audit identity, never read from tool arguments. */
    source?: {
      readonly operatorId?: string;
      readonly taskId?: string;
      readonly attemptCount?: number;
    },
  ): Promise<Objective>;
  /**
   * Trusted Control Plane limit sweep only. Replaces the system-maintained limit observations
   * without changing the Objective revision, so owners' revision fences stay valid. Returns
   * undefined, writing nothing, when the Objective changed since the sweep read it.
   */
  recordObjectiveLimitState(
    id: string,
    state: ObjectiveLimitState,
    expectedRevision: number,
    /** Trusted limit sweep: move to limited after running Attempts settle. */
    limited?: boolean,
  ): Promise<Objective | undefined>;
  /**
   * Trusted operator path. Cancels the Objective and records the reason. Cancelling a cancelled
   * Objective changes nothing, and a completed one is refused; `changed` reports whether this
   * call made the transition. Unadmitted Mailbox messages of the Objective fail, and the owner's
   * Mailbox records a cancellation notice. The caller cancels the open Tasks.
   */
  cancelObjective(
    id: string,
    input: CancelObjectiveInput,
    source: { readonly operatorId: string },
  ): Promise<{ readonly objective: Objective; readonly changed: boolean }>;
  /**
   * Trusted operator path. Pausing records `pausedAt`; while it is set no new Task, continuation,
   * or follow-up starts, and running Task Attempts finish. Pausing a paused Objective changes
   * nothing; a completed or cancelled one is refused.
   */
  pauseObjective(
    id: string,
    source: { readonly operatorId: string },
  ): Promise<{ readonly objective: Objective; readonly changed: boolean }>;
  /**
   * Trusted operator path. Clears `pausedAt` and returns when the pause began, so the caller can
   * summarize what changed while paused. Resuming a running Objective changes nothing.
   */
  resumeObjective(
    id: string,
    source: { readonly operatorId: string },
  ): Promise<{
    readonly objective: Objective;
    readonly changed: boolean;
    readonly pausedAt: string | null;
  }>;
  /** Trusted Control Plane sweep: started Objectives that are not completed or cancelled. */
  listExecutingObjectives(limit?: number): Promise<readonly ObjectiveLimitCandidate[]>;
  /**
   * Trusted administrative read: Objectives that are not completed or cancelled, started or not,
   * oldest first. Deletion protection uses it to find references.
   */
  listOpenObjectives(limit?: number): Promise<readonly Objective[]>;
}
function prose(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /\p{Cc}/u.test(value.replace(/[\n\r\t]/gu, ""))
  )
    throw new TagMessagingError(400, `${field} must contain 1–${max} characters of text`);
  return value.trim();
}
export function parseCreateObjective(value: unknown): CreateObjectiveInput {
  const record = mailboxObject(value, [
    "id",
    "observations",
    "ongoing",
    "outcome",
    "deadline",
    "budgetLimitMinor",
    "budgetCurrency",
    "runtimeActions",
    "notificationTaskId",
    "workspaces",
  ]);
  if (record["ongoing"] !== undefined && typeof record["ongoing"] !== "boolean")
    throw new TagMessagingError(400, "ongoing must be a boolean");
  const observations = record["observations"] ?? [];
  if (!Array.isArray(observations) || observations.length > 16)
    throw new TagMessagingError(400, "observations must contain at most 16 Workstreams");
  const sources = observations.map((value) => {
    const source = mailboxObject(value, ["workstreamId"]);
    return { workstreamId: mailboxText(source["workstreamId"], "workstreamId") };
  });
  if (new Set(sources.map((source) => source.workstreamId)).size !== sources.length)
    throw new TagMessagingError(400, "Observation Workstreams must be distinct");
  const id = mailboxText(record["id"], "id");
  if (id === "." || id === "..")
    throw new TagMessagingError(400, "Objective ID cannot be a URL dot segment");
  const deadline = record["deadline"];
  if (
    deadline !== undefined &&
    deadline !== null &&
    (typeof deadline !== "string" || !Number.isFinite(Date.parse(deadline)))
  )
    throw new TagMessagingError(400, "deadline must be an ISO timestamp");
  const budget = record["budgetLimitMinor"];
  if (
    budget !== undefined &&
    budget !== null &&
    (!Number.isSafeInteger(budget) || (budget as number) < 0)
  )
    throw new TagMessagingError(400, "budgetLimitMinor must be a nonnegative integer");
  const budgetCurrency = record["budgetCurrency"];
  if (
    budgetCurrency !== undefined &&
    budgetCurrency !== null &&
    (typeof budgetCurrency !== "string" || !/^[A-Z]{3}$/u.test(budgetCurrency))
  )
    throw new TagMessagingError(
      400,
      "budgetCurrency must be an uppercase three-letter currency code",
    );
  if (budgetCurrency != null && budget == null)
    throw new TagMessagingError(400, "budgetCurrency requires budgetLimitMinor");
  const strings = (field: string, max: number) => {
    const items = record[field] ?? [];
    if (!Array.isArray(items) || items.length > 50)
      throw new TagMessagingError(400, `${field} must be an array of at most 50 strings`);
    return items.map((item) => prose(item, field, max));
  };
  return {
    observations: sources,
    ongoing: record["ongoing"] === true,
    deadline: typeof deadline === "string" ? new Date(deadline).toISOString() : null,
    budgetLimitMinor: (budget as number | null | undefined) ?? null,
    budgetCurrency: (budgetCurrency as string | null | undefined) ?? null,
    runtimeActions: strings("runtimeActions", 200),
    workspaces: parseWorkspaceNames(record["workspaces"]),
    ...(record["notificationTaskId"] === undefined
      ? {}
      : {
          notificationTaskId:
            record["notificationTaskId"] === null
              ? null
              : mailboxText(record["notificationTaskId"], "notificationTaskId"),
        }),
    id,
    outcome: prose(record["outcome"], "outcome", OBJECTIVE_OUTCOME_MAX),
  };
}

/**
 * A readable Objective ID from the first words of its outcome plus a short random suffix, like
 * Kubernetes generateName: "Ship SSO for the admin console" becomes "ship-sso-for-7f3k". The
 * result always satisfies Objective ID rules.
 */
export function generateObjectiveId(
  outcome: string,
  random: () => string = randomObjectiveSuffix,
): string {
  const words = outcome
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, " ")
    .split(/[\s-]+/u)
    .filter(Boolean)
    .slice(0, 3);
  const slug = words.join("-").slice(0, 40).replace(/-+$/u, "") || "objective";
  return `${slug}-${random()}`;
}
function randomObjectiveSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

/** Longest Objective outcome statement. */
export const OBJECTIVE_OUTCOME_MAX = 8000;
export function parseObjectiveStatus(value: unknown): UpdateObjectiveStatusInput {
  const record = mailboxObject(value, [
    "status",
    "expectedRevision",
    "completionSummary",
    "notificationTaskId",
    "budgetLimitMinor",
    "deadline",
    "runtimeActions",
  ]);
  if (record["status"] === "cancelled")
    throw new TagMessagingError(
      400,
      "Only an operator can cancel an Objective, with a cancellation request rather than a status update",
    );
  if (
    (record["status"] === undefined
      ? record["notificationTaskId"] === undefined &&
        record["budgetLimitMinor"] === undefined &&
        record["deadline"] === undefined &&
        record["runtimeActions"] === undefined
      : !OBJECTIVE_UPDATE_STATUSES.includes(record["status"] as ObjectiveUpdateStatus)) ||
    !Number.isSafeInteger(record["expectedRevision"]) ||
    (record["expectedRevision"] as number) < 1
  )
    throw new TagMessagingError(
      400,
      "A valid status, notificationTaskId, budgetLimitMinor, deadline, or runtimeActions and a positive expectedRevision are required",
    );
  const runtimeActions = record["runtimeActions"];
  if (
    runtimeActions !== undefined &&
    (!Array.isArray(runtimeActions) || runtimeActions.length > 50)
  )
    throw new TagMessagingError(400, "runtimeActions must be an array of at most 50 strings");
  const budget = record["budgetLimitMinor"];
  if (budget !== undefined && (!Number.isSafeInteger(budget) || (budget as number) < 0))
    throw new TagMessagingError(400, "budgetLimitMinor must be a nonnegative safe integer");
  const deadline = record["deadline"];
  if (
    deadline !== undefined &&
    (typeof deadline !== "string" || !Number.isFinite(Date.parse(deadline)))
  )
    throw new TagMessagingError(400, "deadline must be an ISO timestamp");
  const status = {
    ...(budget === undefined ? {} : { budgetLimitMinor: budget as number }),
    ...(typeof deadline === "string" ? { deadline: new Date(deadline).toISOString() } : {}),
    ...(runtimeActions === undefined
      ? {}
      : {
          runtimeActions: [
            ...new Set(
              (runtimeActions as unknown[]).map((item) => prose(item, "runtimeActions", 200)),
            ),
          ],
        }),
    ...(record["status"] === undefined
      ? {}
      : { status: record["status"] as ObjectiveUpdateStatus }),
    ...(record["notificationTaskId"] === undefined
      ? {}
      : {
          notificationTaskId:
            record["notificationTaskId"] === null
              ? null
              : mailboxText(record["notificationTaskId"], "notificationTaskId"),
        }),
    expectedRevision: record["expectedRevision"] as number,
  };
  if (status.status === "completed" || status.status === "limited")
    return {
      ...status,
      completionSummary: prose(record["completionSummary"], "completionSummary", 16000),
    };
  // An owner stopping for review records its assessment; approval completes with it.
  if (status.status === "ready_for_review" && record["completionSummary"] !== undefined)
    return {
      ...status,
      completionSummary: prose(record["completionSummary"], "completionSummary", 16000),
    };
  if (record["completionSummary"] !== undefined)
    throw new TagMessagingError(
      400,
      "completionSummary is only valid when completing an Objective or marking it ready_for_review",
    );
  return status;
}

/** Longest operator cancellation reason. */
export const OBJECTIVE_CANCELLATION_REASON_MAX = 2000;
export function parseCancelObjective(value: unknown): CancelObjectiveInput {
  const record = mailboxObject(value ?? {}, ["reason"]);
  if (record["reason"] === undefined || record["reason"] === null) return { reason: null };
  return { reason: prose(record["reason"], "reason", OBJECTIVE_CANCELLATION_REASON_MAX) };
}

/** The notice an Objective's owner and collaboration surface receive when it is cancelled. */
export function objectiveCancellationNotice(
  objective: Pick<Objective, "id" | "cancellationReason">,
): string {
  return objective.cancellationReason
    ? `An operator cancelled Objective ${objective.id}: ${objective.cancellationReason}\nIts open Tasks were cancelled; no new work will start for it.`
    : `An operator cancelled Objective ${objective.id}.\nIts open Tasks were cancelled; no new work will start for it.`;
}

/** A completion report quotes at most this many characters of the completion summary. */
export const OBJECTIVE_COMPLETION_NOTICE_SUMMARY_LIMIT = 1500;

/** The status report a completed Objective posts to its home Session. */
export function objectiveCompletionNotice(
  objective: Pick<Objective, "id" | "completionSummary">,
): string {
  const summary = objective.completionSummary?.trim();
  if (!summary) return `Objective ${objective.id} is completed.`;
  const quoted =
    summary.length > OBJECTIVE_COMPLETION_NOTICE_SUMMARY_LIMIT
      ? `${summary.slice(0, OBJECTIVE_COMPLETION_NOTICE_SUMMARY_LIMIT - 1)}…`
      : summary;
  return `Objective ${objective.id} is completed: ${quoted}`;
}

/** At most this many changed Tasks are named in a resume summary; the rest are counted. */
export const OBJECTIVE_RESUME_SUMMARY_TASKS = 10;

/**
 * The message that wakes the owner when an operator resumes a paused Objective: how long it was
 * paused, the Tasks whose state changed meanwhile, and the work still waiting to start.
 */
export function objectiveResumeSummary(
  objective: Pick<Objective, "id" | "updatedAt">,
  pausedAt: string,
  tasks: readonly Pick<TaskAssignment, "taskId" | "status" | "updatedAt">[],
): string {
  const resumedAt = objective.updatedAt;
  const changed = tasks
    .filter((task) => task.updatedAt >= pausedAt && task.updatedAt <= resumedAt)
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.taskId.localeCompare(b.taskId));
  const queued = tasks.filter((task) => task.status === "queued" || task.status === "waiting");
  const lines = [
    `An operator resumed Objective ${objective.id}. It was paused from ${pausedAt} to ${resumedAt}; new Tasks, continuations, and follow-ups were refused meanwhile.`,
  ];
  if (changed.length === 0) lines.push("No Task changed while it was paused.");
  else {
    lines.push(
      `${changed.length} Task${changed.length === 1 ? "" : "s"} changed while it was paused:`,
    );
    for (const task of changed.slice(0, OBJECTIVE_RESUME_SUMMARY_TASKS))
      lines.push(`- ${task.taskId}: ${task.status}`);
    if (changed.length > OBJECTIVE_RESUME_SUMMARY_TASKS)
      lines.push(`- and ${changed.length - OBJECTIVE_RESUME_SUMMARY_TASKS} more`);
  }
  if (queued.length > 0)
    lines.push(
      `${queued.length} queued or waiting Task${queued.length === 1 ? "" : "s"} may start again.`,
    );
  lines.push("Review the changes, then continue the Objective.");
  return lines.join("\n");
}
