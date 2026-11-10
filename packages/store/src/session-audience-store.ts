// biome-ignore-all lint/suspicious/noExplicitAny: Shared dialect queries use different Drizzle query types.
import {
  type DatabaseProvider,
  type IdleObjective,
  type JsonRecord,
  OBJECTIVE_CLOSED_STATUSES,
  type Objective,
  type ObjectiveSessionStore,
  type ObjectiveSessionSummary,
  type ObjectiveStatus,
  objectiveSessionKey,
  SESSION_NOT_CONTINUED_EVENT,
  SESSION_SEARCH_MAX_QUERY,
  SESSION_TOOL_MAX_RESULTS,
  type Session,
  type SessionAudience,
  type SessionAudienceStore,
  type SessionLatestTask,
  type SessionPage,
  type SessionSearchHit,
  type SessionSummary,
  type SessionTaskSummary,
  type SessionViewer,
  type SurfaceProvider,
  sessionApprovalDeliveryId,
  TagMessagingError,
  type TagObjectiveSummary,
  type TaskStatus,
  type WorkSessionSummary,
  workSessionReportDeliveryId,
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
    ...(row.parentSessionId == null ? {} : { parentSessionId: row.parentSessionId }),
    ...(row.objectiveId == null ? {} : { objectiveId: row.objectiveId }),
    lastInteractionAt: row.lastInteractionAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleSessionAudienceStore implements SessionAudienceStore, ObjectiveSessionStore {
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

  async listWorkSessions(parentSessionId: string): Promise<readonly WorkSessionSummary[]> {
    const s = this.tables.sessions;
    const rows = await this.db
      .select({
        id: s.id,
        origin: s.origin,
        createdAt: s.createdAt,
        taskId: sql`(select lt."id" from "Task" lt where lt."sessionId" = "Session"."id" order by lt."createdAt" desc, lt."id" desc limit 1)`,
        taskStatus: sql`(select lt."status" from "Task" lt where lt."sessionId" = "Session"."id" order by lt."createdAt" desc, lt."id" desc limit 1)`,
      })
      .from(s)
      .where(eq(s.parentSessionId, parentSessionId))
      .orderBy(desc(s.createdAt), desc(s.id))
      .limit(200);
    const details = await this.latestTaskDetails(rows);
    return rows.toReversed().map((row: any) => {
      const origin = jsonRecord(row.origin, "session origin");
      return {
        sessionId: row.id,
        title: typeof origin["title"] === "string" ? origin["title"] : "",
        ...(typeof origin["startedByTaskId"] === "string"
          ? { startedByTaskId: origin["startedByTaskId"] }
          : {}),
        createdAt: row.createdAt,
        ...(details.has(row.taskId) ? { task: details.get(row.taskId) } : {}),
      };
    });
  }

  /**
   * Each row's latest Task (`taskId`, `taskStatus`): the turn that started it (from its admitted
   * event), and the question or approval requests it ended waiting on.
   */
  private async latestTaskDetails(
    rows: readonly { readonly taskId?: unknown; readonly taskStatus?: unknown }[],
  ): Promise<ReadonlyMap<unknown, SessionLatestTask>> {
    const t = this.tables.tasks,
      i = this.tables.durableInboundEvents,
      e = this.tables.taskEvents;
    const latest = rows.filter(
      (row): row is { taskId: string; taskStatus: string } =>
        typeof row.taskId === "string" && typeof row.taskStatus === "string",
    );
    const taskIds = latest.map((row) => row.taskId);
    if (taskIds.length === 0) return new Map();
    // A Task whose decided request could not continue its Session waits on no approval any more.
    const notContinued = new Set<string>(
      (
        await this.db
          .select({ taskId: e.taskId })
          .from(e)
          .where(and(inArray(e.taskId, taskIds), eq(e.type, SESSION_NOT_CONTINUED_EVENT)))
      ).map((row: any) => row.taskId as string),
    );
    const found = new Map<string, Omit<SessionLatestTask, "id" | "status">>(
      (
        await this.db
          .select({ id: t.id, outcome: t.outcome, event: i.event })
          .from(t)
          .innerJoin(i, eq(i.id, t.inboundEventId))
          .where(inArray(t.id, taskIds))
      ).map((row: any) => {
        const internal = optionalRecord(optionalRecord(row.event)?.["internal"]);
        const outcome = optionalRecord(row.outcome);
        const question = outcome?.["question"];
        const approvals = notContinued.has(row.id)
          ? []
          : Array.isArray(outcome?.["approvals"])
            ? (outcome["approvals"] as unknown[]).filter(
                (id): id is string => typeof id === "string",
              )
            : [];
        return [
          row.id,
          {
            ...(typeof internal?.["startedByTaskId"] === "string"
              ? { startedByTaskId: internal["startedByTaskId"] }
              : {}),
            ...(typeof question === "string" ? { question } : {}),
            ...(approvals.length === 0 ? {} : { approvals }),
          },
        ];
      }),
    );
    return new Map(
      latest.map((row) => [
        row.taskId,
        { id: row.taskId, status: row.taskStatus as TaskStatus, ...found.get(row.taskId) },
      ]),
    );
  }

  async listSessionTaskIds(sessionId: string): Promise<readonly string[]> {
    const t = this.tables.tasks;
    const rows = await this.db
      .select({ id: t.id })
      .from(t)
      .where(eq(t.sessionId, sessionId))
      .orderBy(asc(t.createdAt), asc(t.id));
    return rows.map((row: any) => row.id as string);
  }

  async sessionTaskSummaries(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, SessionTaskSummary>> {
    if (sessionIds.length === 0) return new Map();
    const s = this.tables.sessions;
    const summaries = new Map<string, SessionTaskSummary>();
    for (let offset = 0; offset < sessionIds.length; offset += 500) {
      const rows = await this.db
        .select({
          id: s.id,
          status: sql`(select lt."status" from "Task" lt where lt."sessionId" = "Session"."id" order by lt."createdAt" desc, lt."id" desc limit 1)`,
          firstRequest: sql`(select substr(ft."requestText", 1, 200) from "Task" ft where ft."sessionId" = "Session"."id" order by ft."createdAt" asc, ft."id" asc limit 1)`,
        })
        .from(s)
        .where(inArray(s.id, [...sessionIds.slice(offset, offset + 500)]));
      for (const row of rows)
        summaries.set(row.id, {
          ...(typeof row.status === "string" ? { latestTaskStatus: row.status as TaskStatus } : {}),
          ...(typeof row.firstRequest === "string" && row.firstRequest.trim()
            ? { firstRequest: row.firstRequest }
            : {}),
        });
    }
    return summaries;
  }

  /**
   * Finished work Session Tasks without a report turn. The scan starts from work Sessions (indexed
   * by parent), and the report lookup uses the inbound event's (surface account, delivery id) key:
   * a report turn is admitted under the same surface account as the work Task it reports.
   */
  async listUnreportedWorkTasks(limit: number): Promise<readonly string[]> {
    const t = this.tables.tasks,
      s = this.tables.sessions,
      w = this.tables.durableInboundEvents;
    const rows = await this.db
      .select({ id: t.id })
      .from(s)
      .innerJoin(t, eq(t.sessionId, s.id))
      .innerJoin(w, eq(w.id, t.inboundEventId))
      .where(
        and(
          isNotNull(s.parentSessionId),
          inArray(t.status, ["completed", "failed", "cancelled"]),
          sql`not exists (select 1 from "DurableInboundEvent" r where r."surfaceAccountId" = ${w.surfaceAccountId} and r."deliveryId" = 'session-report:' || ${t.id})`,
        ),
      )
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(limit);
    return rows.map((row: any) => row.id);
  }

  async listDecidedSessionWaits(limit: number): Promise<readonly string[]> {
    const t = this.tables.tasks,
      s = this.tables.sessions,
      w = this.tables.durableInboundEvents;
    const rows = await this.db
      .select({ id: t.id })
      .from(s)
      .innerJoin(t, eq(t.sessionId, s.id))
      .innerJoin(w, eq(w.id, t.inboundEventId))
      .where(
        and(
          or(
            isNotNull(s.parentSessionId),
            and(isNotNull(s.objectiveId), sql`${s.sessionKey} = 'objective:' || ${s.objectiveId}`),
            sql`${s.sessionKey} like 'inbox:%'`,
          ),
          eq(t.status, "completed"),
          // Decided and not yet used: a denial, an Objective-wide approval, or a once approval
          // nobody consumed. The Task's outcome names the request, so it waited on it.
          sql`exists (select 1 from "ApprovalRequest" a where a."taskId" = ${t.id} and a."kind" = 'surface-action' and (a."status" = 'denied' or (a."status" = 'approved' and a."consumedAt" is null)) and cast(${t.outcome} as text) like '%"' || a."id" || '"%')`,
          sql`not exists (select 1 from "Task" n where n."sessionId" = ${t.sessionId} and (n."createdAt" > ${t.createdAt} or (n."createdAt" = ${t.createdAt} and n."id" > ${t.id})))`,
          sql`not exists (select 1 from "DurableInboundEvent" r where r."surfaceAccountId" = ${w.surfaceAccountId} and r."deliveryId" = ${sessionApprovalDeliveryId("")} || ${t.id})`,
          sql`not exists (select 1 from "TaskEvent" e where e."taskId" = ${t.id} and e."type" = ${SESSION_NOT_CONTINUED_EVENT})`,
          // A retired Tag takes no more turns.
          sql`exists (select 1 from "Tag" g where g."id" = ${t.tagId} and g."status" = 'active')`,
        ),
      )
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(limit);
    return rows.map((row: any) => row.id);
  }

  async findObjectiveOwnerSession(objectiveId: string): Promise<Session | undefined> {
    const s = this.tables.sessions;
    const [row] = await this.db
      .select()
      .from(s)
      .where(
        and(eq(s.objectiveId, objectiveId), eq(s.sessionKey, objectiveSessionKey(objectiveId))),
      )
      .limit(1);
    return row === undefined ? undefined : sessionFromRow(row);
  }

  async listObjectiveSessions(objectiveId: string): Promise<readonly ObjectiveSessionSummary[]> {
    const s = this.tables.sessions;
    const rows = await this.db
      .select({
        id: s.id,
        tagId: s.tagId,
        sessionKey: s.sessionKey,
        parentSessionId: s.parentSessionId,
        origin: s.origin,
        createdAt: s.createdAt,
        taskId: sql`(select lt."id" from "Task" lt where lt."sessionId" = "Session"."id" order by lt."createdAt" desc, lt."id" desc limit 1)`,
        taskStatus: sql`(select lt."status" from "Task" lt where lt."sessionId" = "Session"."id" order by lt."createdAt" desc, lt."id" desc limit 1)`,
      })
      .from(s)
      .where(eq(s.objectiveId, objectiveId))
      .orderBy(asc(s.createdAt), asc(s.id));
    const details = await this.latestTaskDetails(rows);
    const own = objectiveSessionKey(objectiveId);
    return rows
      .toSorted(
        (left: any, right: any) =>
          Number(right.sessionKey === own) - Number(left.sessionKey === own),
      )
      .map((row: any) => {
        const origin = jsonRecord(row.origin, "session origin");
        return {
          sessionId: row.id,
          tagId: row.tagId,
          sessionKey: row.sessionKey,
          ...(row.parentSessionId == null ? {} : { parentSessionId: row.parentSessionId }),
          ...(row.parentSessionId != null && typeof origin["title"] === "string"
            ? { title: origin["title"] }
            : {}),
          createdAt: row.createdAt,
          ...(details.has(row.taskId) ? { task: details.get(row.taskId) } : {}),
        };
      });
  }

  async listIdleObjectives(limit: number): Promise<readonly IdleObjective[]> {
    const o = this.tables.objectives,
      s = this.tables.sessions,
      t = this.tables.tasks;
    const pg = this.provider === "postgresql";
    const asked = pg
      ? sql`(${t.outcome}->>'question') is not null`
      : sql`json_extract(${t.outcome}, '$.question') is not null`;
    const awaitsApproval = pg
      ? sql`(jsonb_typeof(${t.outcome}->'approvals') = 'array' and jsonb_array_length(${t.outcome}->'approvals') > 0)`
      : sql`coalesce(json_array_length(${t.outcome}, '$.approvals'), 0) > 0`;
    const rows = await this.db
      .select({ objectiveId: o.id, ownerTaskId: t.id })
      .from(o)
      .innerJoin(s, and(eq(s.objectiveId, o.id), sql`${s.sessionKey} = 'objective:' || ${o.id}`))
      .innerJoin(
        t,
        sql`${t.id} = (select lt."id" from "Task" lt where lt."sessionId" = ${s.id} order by lt."createdAt" desc, lt."id" desc limit 1)`,
      )
      .where(
        and(
          eq(o.status, "working"),
          sql`${o.pausedAt} is null`,
          eq(o.ongoing, false),
          inArray(t.status, ["completed", "failed"]),
          sql`not (${asked})`,
          sql`(not (${awaitsApproval}) or exists (select 1 from "TaskEvent" ne where ne."taskId" = ${t.id} and ne."type" = ${SESSION_NOT_CONTINUED_EVENT}))`,
          // Nothing of the Objective is due, running or still to report.
          sql`not exists (select 1 from "TagMessage" m where m."objectiveId" = ${o.id} and m."review" is not null and not exists (select 1 from "DurableInboundEvent" r where r."tagId" = ${o.ownerTagId} and r."sessionKey" = ${s.sessionKey} and r."deliveryId" = 'objective-notice:' || ${o.id} || ':review:' || m."id"))`,
          sql`not exists (select 1 from "DurableInboundEvent" e join "Session" es on es."tagId" = e."tagId" and es."sessionKey" = e."sessionKey" where es."objectiveId" = ${o.id} and e."status" in ('pending', 'processing'))`,
          sql`not exists (select 1 from "Session" ws join "Task" wt on wt."sessionId" = ws."id" join "DurableInboundEvent" wi on wi."id" = wt."inboundEventId" where ws."objectiveId" = ${o.id} and ws."parentSessionId" is not null and wt."status" in ('completed', 'failed', 'cancelled') and not exists (select 1 from "DurableInboundEvent" r where r."surfaceAccountId" = wi."surfaceAccountId" and r."deliveryId" = 'session-report:' || wt."id"))`,
          sql`exists (select 1 from "Tag" g where g."id" = ${o.ownerTagId} and g."status" = 'active')`,
        ),
      )
      .orderBy(asc(t.updatedAt), asc(o.id))
      .limit(limit);
    return rows.map((row: any) => ({ objectiveId: row.objectiveId, ownerTaskId: row.ownerTaskId }));
  }

  async listOpenObjectiveTaskIds(objectiveId: string): Promise<readonly string[]> {
    const t = this.tables.tasks,
      s = this.tables.sessions;
    const rows = await this.db
      .select({ id: t.id })
      .from(t)
      .innerJoin(s, eq(s.id, t.sessionId))
      .where(and(eq(s.objectiveId, objectiveId), inArray(t.status, ["pending", "running"])))
      .orderBy(asc(t.createdAt), asc(t.id));
    return rows.map((row: any) => row.id as string);
  }

  async findWorkSessionReport(
    workTaskId: string,
  ): Promise<{ readonly inboundEventId: string; readonly taskId?: string } | undefined> {
    const i = this.tables.durableInboundEvents,
      t = this.tables.tasks;
    // The report shares the work Task's surface account, so both lookups use an index.
    const [work] = await this.db
      .select({ surfaceAccountId: i.surfaceAccountId })
      .from(t)
      .innerJoin(i, eq(i.id, t.inboundEventId))
      .where(eq(t.id, workTaskId))
      .limit(1);
    if (work === undefined) return undefined;
    const [row] = await this.db
      .select({ inboundEventId: i.id, taskId: t.id })
      .from(i)
      .leftJoin(t, eq(t.inboundEventId, i.id))
      .where(
        and(
          eq(i.surfaceAccountId, work.surfaceAccountId),
          eq(i.deliveryId, workSessionReportDeliveryId(workTaskId)),
        ),
      )
      .limit(1);
    return row === undefined
      ? undefined
      : { inboundEventId: row.inboundEventId, ...(row.taskId ? { taskId: row.taskId } : {}) };
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

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Readonly<Record<string, unknown>>)
    : undefined;
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
