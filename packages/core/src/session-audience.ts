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
 * A conversation turn may start work Sessions with `start_session`: Sessions of the same Tag
 * whose parent is the conversation Session, each running one Task with an instruction the Tag
 * wrote, under the starting turn's admitted authorization. Fixed limits.
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

/** The durable delivery id of the one report turn for a work Session's Task. */
export function workSessionReportDeliveryId(workTaskId: string): string {
  return `session-report:${workTaskId}`;
}

/**
 * The durable delivery id of the one Task that continues a work Session after its Task `workTaskId`
 * ended waiting on approval requests and one of them was decided.
 */
export function workSessionApprovalDeliveryId(workTaskId: string): string {
  return `work-session-approval:${workTaskId}`;
}

/**
 * The Task event a work Session Task gets when a decided approval request it waited on could not
 * continue the Session: its permissions changed, or its starting turn's budget is spent. The Task
 * then waits on nothing.
 */
export const WORK_SESSION_NOT_CONTINUED_EVENT = "work_session.not-continued";

/**
 * A turn SuperTag admits itself into a Session. It is never a human message: its text is the
 * Tag's own instruction (`work_session`) or absent (`session_report`), it
 * carries no explicit human command, and it runs under the starting conversation turn's admitted
 * authorization.
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
    };

/** One work Session a conversation started, with its latest Task. */
export interface WorkSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  /** The conversation turn that started the work Session. */
  readonly startedByTaskId?: string;
  readonly createdAt: string;
  /** The work Session's latest Task. */
  readonly task?: {
    readonly id: string;
    readonly status: TaskStatus;
    /** The conversation turn that started this Task, with `start_session` or `continue_session`. */
    readonly startedByTaskId?: string;
    /** The question this Task asked with `ask`; a completed Task with one waits on the person. */
    readonly question?: string;
    /**
     * The approval requests this Task ended waiting on; a completed Task with some waits on
     * their decision and continues on its own once one is decided.
     */
    readonly approvals?: readonly string[];
  };
}

/**
 * Whether a work Session's latest Task completed waiting: on the person's answer to its question,
 * or on the decision of an approval request. A Task ends either done or waiting.
 */
export function workSessionWaiting(session: WorkSessionSummary): boolean {
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
  /**
   * Completed work Session Tasks of active Tags, oldest first, that are still their Session's latest Task, ended
   * waiting on an approval request that has since been decided, and were neither continued with
   * `workSessionApprovalDeliveryId` nor marked `WORK_SESSION_NOT_CONTINUED_EVENT`.
   */
  listDecidedWorkSessionWaits(limit: number): Promise<readonly string[]>;
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
