import type { Session, SurfaceProvider, TaskStatus } from "./index.js";
import type { Objective, ObjectiveStatus } from "./objective.js";

/**
 * Who may see a Session from the Tag's other conversations. `shared` Sessions (channels, threads,
 * issues, pull requests) are visible to every Session of the Tag. A `private` Session is a direct
 * conversation with one person and is visible only where that same person is the requester.
 * Derived from the surface event when the Session opens; never configured.
 */
export type SessionAudience = "shared" | "private";

/** Fixed bounds for reading the Tag's other Sessions and Objectives. */
export const SESSION_TOOL_MAX_RESULTS = 20;
export const SESSION_SEARCH_MAX_QUERY = 200;

/**
 * The stable key of a requester: provider, Surface Account, and the provider's actor id.
 * It owns a private Session and identifies the same person when another Session reads it.
 */
export function sessionRequesterKey(
  provider: string,
  surfaceAccountId: string,
  actorId: string,
): string {
  return `${provider}:${surfaceAccountId}:${actorId}`;
}

/**
 * A conversation Task reading its Tag's other Sessions. It sees a Session of `tagId` that is
 * shared, or private to `requesterKey`; list and search results leave out its own `sessionId`.
 */
export interface SessionViewer {
  readonly tagId: string;
  readonly requesterKey: string;
  readonly sessionId: string;
}

export interface SessionPage {
  readonly limit: number;
  readonly offset?: number;
}

/** One visible Session, as `list_sessions` returns it. */
export interface SessionSummary {
  readonly sessionId: string;
  readonly audience: SessionAudience;
  readonly provider?: SurfaceProvider;
  readonly scope?: string;
  /** The Session's first request, shortened. */
  readonly firstRequest?: string;
  readonly lastInteractionAt: string;
}

/** A completed Task in a visible Session whose request or result summary matched a query. */
export interface SessionSearchHit {
  readonly sessionId: string;
  readonly taskId: string;
  readonly completedAt: string;
  readonly provider?: SurfaceProvider;
  readonly scope?: string;
  readonly requestExcerpt?: string;
  readonly summaryExcerpt?: string;
}

/** An open Objective the Tag owns, with where it started. */
export interface TagObjectiveSummary {
  readonly id: string;
  readonly status: ObjectiveStatus;
  readonly outcome: string;
  readonly deadline?: string;
  readonly updatedAt: string;
  readonly home?: { readonly provider?: SurfaceProvider; readonly scope?: string };
}

/**
 * A turn of a root Session may start work Sessions with `start_session`, whose parent is that
 * Session, each running one Task with an instruction the Tag wrote. They are Sessions of the same
 * Tag, or, from an Objective's turn, of a member of the Objective's Team. Fixed limits.
 */
export const WORK_SESSION_TITLE_MAX = 120;
export const WORK_SESSION_INSTRUCTION_MAX = 8_000;
/** Work Sessions of one conversation that run at once; later ones queue. */
export const WORK_SESSION_MAX_RUNNING = 4;
/**
 * Work Sessions one conversation turn may start or continue. Each draws an equal share of what
 * the turn's reported token and cost limits have left (see `workSessionExecution`). A turn whose
 * `maxNativeAgents` is lower starts at most that many; 0 starts none.
 */
export const WORK_SESSION_MAX_PER_TURN = 4;
/** Unfinished (running or queued) work Sessions one conversation may hold. */
export const WORK_SESSION_MAX_OPEN = 8;
/** The bounded result text a report turn carries back to the conversation. */
export const WORK_SESSION_REPORT_RESULT_MAX = 4_000;
/** The question a work Session Task may put to the person with `ask`. */
export const WORK_SESSION_QUESTION_MAX = 2_000;

/** The key of the Session an Objective owns: its conversation with the owner Tag. */
export function objectiveSessionKey(objectiveId: string): string {
  return `objective:${objectiveId}`;
}

/** The Objective whose Session has this key, or undefined for any other Session. */
export function objectiveIdOfSessionKey(sessionKey: string): string | undefined {
  return sessionKey.startsWith("objective:") ? sessionKey.slice("objective:".length) : undefined;
}

/** The key of a Tag's inbox Session, whose turns handle its Mailbox messages. */
export function inboxSessionKey(tagId: string): string {
  return `inbox:${tagId}`;
}

/** Whether a Session key is a Tag's inbox Session. */
export function isInboxSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith("inbox:");
}

/** The durable delivery id of the turn that starts an Objective. */
export function objectiveStartDeliveryId(objectiveId: string): string {
  return `objective-start:${objectiveId}`;
}

/** The durable delivery id of an operator's message to an Objective, keyed by its idempotency key. */
export function objectiveMessageDeliveryId(objectiveId: string, key: string): string {
  return `objective-message:${objectiveId}:${key}`;
}

/** The durable delivery id of the one wake after the Objective's Task `ownerTaskId` ended idle. */
export function objectiveIdleDeliveryId(ownerTaskId: string): string {
  return `objective-idle:${ownerTaskId}`;
}

/** The durable delivery id of a SuperTag notice to an Objective, such as a budget warning. */
export function objectiveNoticeDeliveryId(objectiveId: string, key: string): string {
  return `objective-notice:${objectiveId}:${key}`;
}

/** The durable delivery id of the inbox turn admitted for one Mailbox message. */
export function inboxDeliveryId(tagId: string, messageId: string): string {
  return `inbox:${tagId}:${messageId}`;
}

/** The durable delivery id of the one report turn for a work Session's Task. */
export function workSessionReportDeliveryId(workTaskId: string): string {
  return `session-report:${workTaskId}`;
}

/**
 * The durable delivery id of the one Task that continues a Session after its Task `taskId` ended
 * waiting on approval requests and one of them was decided. Work Sessions and Objective Sessions
 * share it.
 */
export function sessionApprovalDeliveryId(taskId: string): string {
  return `session-approval:${taskId}`;
}

/**
 * The Task event a Task gets when a decided approval request it waited on could not continue its
 * Session: its permissions changed, or the budget is spent. The Task then waits on nothing.
 */
export const SESSION_NOT_CONTINUED_EVENT = "session.not-continued";

/** Who a `delivery` turn comes from. */
export type DeliveryFrom =
  | { readonly kind: "person"; readonly id: string; readonly displayName?: string }
  | { readonly kind: "tag"; readonly tagId: string; readonly tagName: string }
  | { readonly kind: "supertag" };

/**
 * Why a `delivery` turn runs. Objective reasons run in the Objective's Session; `inbox` runs in
 * the recipient Tag's inbox Session.
 */
export type DeliveryReason =
  | "objective_start"
  | "objective_message"
  | "objective_idle"
  | "objective_notice"
  | "approval_decision"
  | "inbox";

/**
 * A turn SuperTag admits itself into a Session. It carries no explicit human command: a
 * `work_session` turn's text is the Tag's own instruction, a `session_report` carries a finished
 * work Session's result, and a `delivery` brings something from a person, a Tag or SuperTag
 * itself to an Objective's Session or a Tag's inbox.
 */
export type InternalTurn =
  | {
      /**
       * A work Session's Task: its first, started by `start_session`, or a later one started by
       * `continue_session` (`continued`), whose text is the Tag's relay of the person's answer.
       */
      readonly kind: "work_session";
      readonly startedByTaskId: string;
      readonly parentSessionId: string;
      readonly title: string;
      readonly continued?: true;
      /** The Workspace the work Session edits, on its own branch; absent without one. */
      readonly workspace?: string;
    }
  | {
      /** The conversation turn that reports a finished work Session's result. */
      readonly kind: "session_report";
      readonly startedByTaskId: string;
      readonly workSessionId: string;
      readonly workTaskId: string;
      readonly title: string;
      /**
       * `waiting`: the work Task completed after `ask` or on a pending approval request, so the
       * work Session waits on the person's answer or on the decision.
       */
      readonly status: "cancelled" | "completed" | "failed" | "waiting";
      /** The work Task's result text, bounded by `WORK_SESSION_REPORT_RESULT_MAX`. */
      readonly result: string;
      /** The question the work Task asked, when `waiting`. */
      readonly question?: string;
      /** The approval requests the work Task waits on, when `waiting`. */
      readonly approvals?: readonly string[];
      /** SuperTag's account of where the work Task's Workspace changes are, when it had one. */
      readonly delivery?: string;
    }
  | {
      /**
       * One input for every delivered turn: an Objective's start, an operator's message, the idle
       * wake, a budget or deadline notice, an approval decision, or the Tag's Mailbox messages.
       * The text is in the event; Mailbox messages are bound when the inbox Task starts.
       */
      readonly kind: "delivery";
      readonly from: DeliveryFrom;
      readonly reason: DeliveryReason;
      readonly objectiveId?: string;
      /** The Task whose action caused this turn, such as the one that sent a Mailbox message. */
      readonly startedByTaskId?: string;
    };

/** A Session's latest Task, as Session lists show it. */
export interface SessionLatestTask {
  readonly id: string;
  readonly status: TaskStatus;
  /** The turn that started this Task, with `start_session` or `continue_session`. */
  readonly startedByTaskId?: string;
  /** The question this Task asked with `ask`; a completed Task with one waits on the answer. */
  readonly question?: string;
  /**
   * The approval requests this Task ended waiting on; a completed Task with some waits on
   * their decision and continues on its own once one is decided.
   */
  readonly approvals?: readonly string[];
}

/** One work Session a conversation started, with its latest Task. */
export interface WorkSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  /** The conversation turn that started the work Session. */
  readonly startedByTaskId?: string;
  readonly createdAt: string;
  /** The work Session's latest Task. */
  readonly task?: SessionLatestTask;
}

/**
 * Whether a Session's latest Task completed waiting: on the answer to its question, or on the
 * decision of an approval request. A Task ends either done or waiting.
 */
export function workSessionWaiting(session: { readonly task?: SessionLatestTask }): boolean {
  return (
    session.task?.status === "completed" &&
    (session.task.question !== undefined || (session.task.approvals?.length ?? 0) > 0)
  );
}

export interface SessionAudienceStore {
  /** Visible Sessions other than the viewer's own, most recent activity first. */
  listVisibleSessions(viewer: SessionViewer, page: SessionPage): Promise<readonly SessionSummary[]>;
  /** One Session if the viewer may see it, its own included. */
  findVisibleSession(viewer: SessionViewer, sessionId: string): Promise<Session | undefined>;
  /**
   * Completed Tasks of visible Sessions, other than the viewer's own, whose request text or
   * result summary contains `query` (case-insensitive), most recently completed first.
   */
  searchVisibleSessions(
    viewer: SessionViewer,
    input: { readonly query: string; readonly limit: number },
  ): Promise<readonly SessionSearchHit[]>;
  /**
   * Non-terminal Objectives the viewer's Tag owns whose home Session it may see, most recently
   * updated first, with the count of all such Objectives.
   */
  listVisibleOpenObjectives(
    viewer: SessionViewer,
    page: SessionPage,
  ): Promise<{ readonly objectives: readonly TagObjectiveSummary[]; readonly total: number }>;
  /** One Objective the viewer's Tag owns, in any status, if its home Session is visible. */
  findVisibleObjective(viewer: SessionViewer, objectiveId: string): Promise<Objective | undefined>;
  /** The work Sessions a conversation Session started, oldest first, at most 200 of the newest. */
  listWorkSessions(parentSessionId: string): Promise<readonly WorkSessionSummary[]>;
  /** Each Session's latest Task status and first request (its first 200 characters), when it has Tasks. */
  sessionTaskSummaries(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, SessionTaskSummary>>;
  /** The ids of a Session's Tasks, oldest first: the last one is its latest Task. */
  listSessionTaskIds(sessionId: string): Promise<readonly string[]>;
  /**
   * Finished Tasks of work Sessions whose report turn has not been admitted yet, oldest first.
   * Admitting the report with `workSessionReportDeliveryId` removes a Task from this list.
   */
  listUnreportedWorkTasks(limit: number): Promise<readonly string[]>;
  /** The report turn admitted for a work Session's Task, and its Task once opened. */
  findWorkSessionReport(
    workTaskId: string,
  ): Promise<{ readonly inboundEventId: string; readonly taskId?: string } | undefined>;
}

/** What a Session's Tasks say about it in a list: its latest status and how it began. */
export interface SessionTaskSummary {
  readonly latestTaskStatus?: TaskStatus;
  readonly firstRequest?: string;
}

/**
 * One Session of an Objective: its own Session (`objectiveSessionKey`) or a work Session started
 * under it, of the owner Tag or a Team member. Each has its latest Task.
 */
export interface ObjectiveSessionSummary {
  readonly sessionId: string;
  readonly tagId: string;
  readonly sessionKey: string;
  /** The Session that started this work Session; absent for the Objective's own Session. */
  readonly parentSessionId?: string;
  /** The work Session's title; absent for the Objective's own Session. */
  readonly title?: string;
  readonly createdAt: string;
  readonly task?: SessionLatestTask;
}

/** An Objective whose latest own Task ended with nothing left running or waiting. */
export interface IdleObjective {
  readonly objectiveId: string;
  /** The Objective Session's latest Task. */
  readonly ownerTaskId: string;
}

/** Queries over the Sessions that belong to an Objective (`Session.objectiveId`). */
export interface ObjectiveSessionStore {
  /** The Objective's own Session, once its first turn was admitted. */
  findObjectiveOwnerSession(objectiveId: string): Promise<Session | undefined>;
  /** Every Session of the Objective, its own first, then work Sessions oldest first. */
  listObjectiveSessions(objectiveId: string): Promise<readonly ObjectiveSessionSummary[]>;
  /**
   * Objectives that are `working`, not paused and not ongoing, whose own latest Task completed or
   * failed without a question or approval requests, with no pending or processing turn in any
   * of their Sessions and no work Session Task whose report is still to be admitted. Oldest
   * first.
   */
  listIdleObjectives(limit: number): Promise<readonly IdleObjective[]>;
  /** Pending and running Tasks of every Session of the Objective. */
  listOpenObjectiveTaskIds(objectiveId: string): Promise<readonly string[]>;
  /**
   * Completed Tasks of active Tags, oldest first, of work, Objective and inbox Sessions, that
   * are still their Session's latest Task, ended waiting on an approval request that has since
   * been decided, and were neither continued with `sessionApprovalDeliveryId` nor marked
   * `SESSION_NOT_CONTINUED_EVENT`.
   */
  listDecidedSessionWaits(limit: number): Promise<readonly string[]>;
}
