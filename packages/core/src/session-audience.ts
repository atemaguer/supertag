import type { Session, SurfaceProvider } from "./index.js";
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
}
