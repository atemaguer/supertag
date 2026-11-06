// biome-ignore-all lint/suspicious/noExplicitAny: Shared dialect queries use different Drizzle query types.
import {
  type DatabaseProvider,
  type JsonRecord,
  OBJECTIVE_CLOSED_STATUSES,
  type Objective,
  type ObjectiveStatus,
  SESSION_SEARCH_MAX_QUERY,
  SESSION_TOOL_MAX_RESULTS,
  type Session,
  type SessionAudience,
  type SessionAudienceStore,
  type SessionPage,
  type SessionSearchHit,
  type SessionSummary,
  type SessionViewer,
  type SurfaceProvider,
  TagMessagingError,
  type TagObjectiveSummary,
} from "@supertag/core";
import { and, asc, desc, eq, inArray, isNotNull, ne, notInArray, or, sql } from "drizzle-orm";

const FIRST_REQUEST_CHARACTERS = 200;

/** The Session an Objective reports from: where it was created, else its notification Task's. */
const objectiveHomeSession = sql<
  string | null
>`coalesce("Objective"."surfaceSessionId", (select nt."sessionId" from "Task" nt where nt."id" = "Objective"."notificationTaskId"))`;
const EXCERPT_CHARACTERS = 240;

/**
 * The one Session visibility rule. A conversation Task of Tag T sees Session S iff S belongs to T
 * and S is shared or private to the Task's requester. `alias` names the Session row in the query.
 */
export function visibleSession(alias: string, viewer: SessionViewer): any {
  const s = sql.identifier(alias);
  return sql`(${s}."tagId" = ${viewer.tagId} and (${s}."audience" = 'shared' or ${s}."audienceActorKey" = ${viewer.requesterKey}))`;
}

export function sessionFromRow(row: any): Session {
  if (row.state !== "open") throw new Error(`Unsupported session state: ${row.state}`);
  return {
    id: row.id,
    tagId: row.tagId,
    sessionKey: row.sessionKey,
    origin: jsonRecord(row.origin, "session origin"),
    state: "open",
    audience: sessionAudience(row.audience),
    ...(row.audienceActorKey == null ? {} : { audienceActorKey: row.audienceActorKey }),
    lastInteractionAt: row.lastInteractionAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleSessionAudienceStore implements SessionAudienceStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  async listVisibleSessions(
    viewer: SessionViewer,
    page: SessionPage,
  ): Promise<readonly SessionSummary[]> {
    const s = this.tables.sessions;
    const { limit, offset } = sessionPage(page);
    const rows = await this.db
      .select({
        id: s.id,
        origin: s.origin,
        audience: s.audience,
        lastInteractionAt: s.lastInteractionAt,
        firstRequest: sql`(select f."requestText" from "Task" f where f."sessionId" = "Session"."id" order by f."createdAt" asc, f."id" asc limit 1)`,
      })
      .from(s)
      .where(and(visibleSession("Session", viewer), ne(s.id, viewer.sessionId)))
      .orderBy(desc(s.lastInteractionAt), asc(s.id))
      .limit(limit)
      .offset(offset);
    return rows.map((row: any) => ({
      sessionId: row.id,
      audience: sessionAudience(row.audience),
      ...originLocation(row.origin),
      ...(typeof row.firstRequest === "string" && row.firstRequest.length > 0
        ? { firstRequest: shorten(row.firstRequest, FIRST_REQUEST_CHARACTERS) }
        : {}),
      lastInteractionAt: row.lastInteractionAt,
    }));
  }

  async findVisibleSession(viewer: SessionViewer, sessionId: string): Promise<Session | undefined> {
    const s = this.tables.sessions;
    const [row] = await this.db
      .select()
      .from(s)
      .where(and(eq(s.id, sessionId), visibleSession("Session", viewer)))
      .limit(1);
    return row === undefined ? undefined : sessionFromRow(row);
  }

  async searchVisibleSessions(
    viewer: SessionViewer,
    input: { readonly query: string; readonly limit: number },
  ): Promise<readonly SessionSearchHit[]> {
    const query = input.query.trim();
    if (query.length < 1 || query.length > SESSION_SEARCH_MAX_QUERY)
      throw new TagMessagingError(
        400,
        `query must be 1 to ${SESSION_SEARCH_MAX_QUERY} characters after trimming`,
      );
    const { limit } = sessionPage({ limit: input.limit });
    const t = this.tables.tasks,
      s = this.tables.sessions;
    const pg = this.provider === "postgresql";
    const needle = query.toLowerCase();
    const summary = pg
      ? sql`(${t.result}->>'summary')`
      : sql`json_extract(${t.result}, '$.summary')`;
    const contains = (value: unknown) =>
      pg
        ? sql`strpos(lower(coalesce(${value}, '')), ${needle}) > 0`
        : sql`instr(lower(coalesce(${value}, '')), ${needle}) > 0`;
    const rows = await this.db
      .select({
        taskId: t.id,
        sessionId: t.sessionId,
        endedAt: t.endedAt,
        requestText: t.requestText,
        summary,
        origin: s.origin,
      })
      .from(t)
      .innerJoin(s, eq(s.id, t.sessionId))
      .where(
        and(
          eq(t.tagId, viewer.tagId),
          eq(t.status, "completed"),
          isNotNull(t.result),
          isNotNull(t.endedAt),
          ne(t.sessionId, viewer.sessionId),
          visibleSession("Session", viewer),
          or(contains(t.requestText), contains(summary)),
        ),
      )
      .orderBy(desc(t.endedAt), desc(t.id))
      .limit(limit);
    return rows.map((row: any) => ({
      sessionId: row.sessionId,
      taskId: row.taskId,
      completedAt: row.endedAt,
      ...originLocation(row.origin),
      ...(typeof row.requestText === "string" && row.requestText.length > 0
        ? { requestExcerpt: excerpt(row.requestText, needle) }
        : {}),
      ...(typeof row.summary === "string" && row.summary.length > 0
        ? { summaryExcerpt: excerpt(row.summary, needle) }
        : {}),
    }));
  }

  async listVisibleOpenObjectives(
    viewer: SessionViewer,
    page: SessionPage,
  ): Promise<{ readonly objectives: readonly TagObjectiveSummary[]; readonly total: number }> {
    const o = this.tables.objectives,
      s = this.tables.sessions;
    const { limit, offset } = sessionPage(page);
    const where = and(
      eq(o.ownerTagId, viewer.tagId),
      notInArray(o.status, [...OBJECTIVE_CLOSED_STATUSES]),
      this.visibleObjective(viewer),
    );
    const [rows, [counted]] = await Promise.all([
      this.db
        .select({
          id: o.id,
          status: o.status,
          outcome: o.outcome,
          deadline: o.deadline,
          updatedAt: o.updatedAt,
          homeSessionId: objectiveHomeSession,
        })
        .from(o)
        .where(where)
        .orderBy(desc(o.updatedAt), desc(o.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: sql`count(*)` }).from(o).where(where),
    ]);
    const homeIds = [
      ...new Set(rows.map((row: any) => row.homeSessionId).filter(Boolean)),
    ] as string[];
    const homes = new Map<string, unknown>(
      homeIds.length === 0
        ? []
        : (
            await this.db
              .select({ id: s.id, origin: s.origin })
              .from(s)
              .where(inArray(s.id, homeIds))
          ).map((row: any) => [row.id, row.origin]),
    );
    return {
      total: Number(counted?.total ?? 0),
      objectives: rows.map((row: any) => ({
        id: row.id,
        status: row.status as ObjectiveStatus,
        outcome: row.outcome,
        ...(row.deadline == null ? {} : { deadline: row.deadline }),
        updatedAt: row.updatedAt,
        ...(row.homeSessionId && homes.has(row.homeSessionId)
          ? { home: originLocation(homes.get(row.homeSessionId)) }
          : {}),
      })),
    };
  }

  async findVisibleObjective(
    viewer: SessionViewer,
    objectiveId: string,
  ): Promise<Objective | undefined> {
    const o = this.tables.objectives;
    const [row] = await this.db
      .select()
      .from(o)
      .where(
        and(eq(o.id, objectiveId), eq(o.ownerTagId, viewer.tagId), this.visibleObjective(viewer)),
      )
      .limit(1);
    return row as Objective | undefined;
  }

  /**
   * An Objective is as visible as its home Session: the Session it was created in and the Session
   * of its notification Task. Both must be visible when both exist; one with neither is shared.
   */
  private visibleObjective(viewer: SessionViewer): any {
    return sql`(("Objective"."surfaceSessionId" is null or exists (select 1 from "Session" home where home."id" = "Objective"."surfaceSessionId" and ${visibleSession("home", viewer)})) and ("Objective"."notificationTaskId" is null or exists (select 1 from "Task" nt join "Session" home on home."id" = nt."sessionId" where nt."id" = "Objective"."notificationTaskId" and ${visibleSession("home", viewer)})))`;
  }
}

function sessionPage(page: SessionPage): { limit: number; offset: number } {
  const offset = page.offset ?? 0;
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > SESSION_TOOL_MAX_RESULTS)
    throw new TagMessagingError(
      400,
      `limit must be an integer between 1 and ${SESSION_TOOL_MAX_RESULTS}`,
    );
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new TagMessagingError(400, "offset must be a nonnegative safe integer");
  return { limit: page.limit, offset };
}

function sessionAudience(value: unknown): SessionAudience {
  if (value !== "shared" && value !== "private")
    throw new Error(`Unsupported Session audience: ${String(value)}`);
  return value;
}

function jsonRecord(value: unknown, label: string): JsonRecord {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`Persisted ${label} is invalid`);
  return parsed as JsonRecord;
}

function originLocation(value: unknown): { provider?: SurfaceProvider; scope?: string } {
  const origin = value === undefined || value === null ? {} : jsonRecord(value, "session origin");
  return {
    ...(typeof origin["provider"] === "string"
      ? { provider: origin["provider"] as SurfaceProvider }
      : {}),
    ...(typeof origin["scope"] === "string" ? { scope: origin["scope"] } : {}),
  };
}

function shorten(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** A window of the text around the first case-insensitive match, or its start. */
function excerpt(value: string, needle: string): string {
  if (value.length <= EXCERPT_CHARACTERS) return value;
  const at = Math.max(0, value.toLowerCase().indexOf(needle));
  const start = Math.max(0, Math.min(at - 80, value.length - EXCERPT_CHARACTERS));
  const end = Math.min(value.length, start + EXCERPT_CHARACTERS);
  return `${start > 0 ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`;
}
