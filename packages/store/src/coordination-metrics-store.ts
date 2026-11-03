// This projection deliberately uses database aggregates. Metrics must remain complete as tables
// grow and must not inherit pagination limits from resource-list APIs.

import {
  COORDINATION_INBOX_KINDS,
  type CoordinationInboxKind,
  type CoordinationMetricSnapshot,
  type CoordinationMetricsStore,
  type DatabaseProvider,
} from "@supertag/core";

type Row = Readonly<Record<string, unknown>>;
type Query = (statement: string, parameters?: readonly unknown[]) => Promise<readonly Row[]>;

export class DrizzleCoordinationMetricsStore implements CoordinationMetricsStore {
  constructor(
    private readonly provider: DatabaseProvider,
    private readonly query: Query,
  ) {}

  async readCoordinationMetrics(
    input: { readonly asOf?: string } = {},
  ): Promise<CoordinationMetricSnapshot> {
    const capturedAt = input.asOf ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(capturedAt)))
      throw new Error("Metrics asOf must be a timestamp");

    const [
      resources,
      assignments,
      recovery,
      inbox,
      usage,
      costs,
      agents,
      limits,
      scheduling,
      schedulingByPriority,
      workerHosts,
      mailbox,
      replies,
    ] = await Promise.all([
      this.one(resourceSql),
      this.one(taskAssignmentSql),
      this.one(this.recoverySql(capturedAt)),
      this.query(this.inboxSql()),
      this.one(this.usageSql()),
      this.query(this.costSql()),
      this.one(this.agentSql()),
      this.one(this.limitSql()),
      this.one(this.schedulingSql(capturedAt)),
      this.query(this.schedulingByPrioritySql()),
      this.query(workerHostSql),
      this.one(queueSql("TagMessage", "pending", "processing")),
      this.one(queueSql("OutboundReply", "pending", "delivering")),
    ]);

    const byKind = Object.fromEntries(COORDINATION_INBOX_KINDS.map((kind) => [kind, 0])) as Record<
      CoordinationInboxKind,
      number
    >;
    let oldestActionableAt: string | null = null;
    for (const row of inbox) {
      const kind = String(row["kind"] ?? "") as CoordinationInboxKind;
      if (!(COORDINATION_INBOX_KINDS as readonly string[]).includes(kind)) continue;
      byKind[kind] = integer(row["count"]);
      const oldest = timestamp(row["oldest"]);
      if (oldest && (oldestActionableAt === null || oldest < oldestActionableAt))
        oldestActionableAt = oldest;
    }
    const reportedCostByCurrency: Record<string, number> = {};
    for (const row of costs) {
      const currency = String(row["currency"] ?? "");
      if (/^[A-Z]{3}$/u.test(currency)) reportedCostByCurrency[currency] = integer(row["amount"]);
    }
    const priorityRows = new Map(schedulingByPriority.map((row) => [String(row["priority"]), row]));
    const byPriority = Object.fromEntries(
      (["urgent", "high", "normal", "low"] as const).map((priority) => {
        const row = priorityRows.get(priority) ?? {};
        const oldestQueuedAt = timestamp(row["oldestQueuedAt"]);
        return [
          priority,
          {
            queued: integer(row["queued"]),
            oldestQueuedAt,
            oldestQueuedAgeSeconds:
              oldestQueuedAt === null
                ? null
                : Math.max(
                    0,
                    Math.floor((Date.parse(capturedAt) - Date.parse(oldestQueuedAt)) / 1000),
                  ),
            placedAttempts: integer(row["placedAttempts"]),
            averageQueueDurationMs: duration(row["averageQueueDurationMs"]),
            maximumQueueDurationMs: duration(row["maximumQueueDurationMs"]),
          },
        ];
      }),
    ) as CoordinationMetricSnapshot["scheduling"]["byPriority"];

    return {
      capturedAt,
      tags: integer(resources["tags"]),
      roles: integer(resources["roles"]),
      roleAssignments: integer(resources["roleAssignments"]),
      surfaceAccounts: integer(resources["surfaceAccounts"]),
      permissionSets: integer(resources["permissionSets"]),
      contextSets: integer(resources["contextSets"]),
      sessions: integer(resources["sessions"]),
      tasks: statuses(resources, ["pending", "running", "completed", "failed", "cancelled"]),
      taskAssignments: statuses(assignments, [
        "queued",
        "running",
        "waiting",
        "submitted",
        "accepted",
        "rejected",
        "cancelled",
        "failed",
      ]),
      recovery: {
        unknownControlDeliveries: integer(recovery["unknownControlDeliveries"]),
        blockedSessions: integer(recovery["blockedSessions"]),
        durableExecutionsAwaitingReconciliation: integer(
          recovery["durableExecutionsAwaitingReconciliation"],
        ),
      },
      coordinationInbox: {
        pending: Object.values(byKind).reduce((sum, value) => sum + value, 0),
        byKind,
        oldestActionableAt,
        oldestActionableAgeSeconds:
          oldestActionableAt === null
            ? null
            : Math.max(
                0,
                Math.floor((Date.parse(capturedAt) - Date.parse(oldestActionableAt)) / 1000),
              ),
      },
      usage: {
        reportingAttempts: integer(usage["reportingAttempts"]),
        totalTokens: integer(usage["totalTokens"]),
        incompleteAttempts: integer(usage["incompleteAttempts"]),
        reportedCostByCurrency,
      },
      nativeAgents: {
        peakConcurrent: integer(agents["peakConcurrent"]),
        tokenLimitInterruptions: integer(limits["tokenLimitInterruptions"]),
        agentLimitInterruptions: integer(limits["agentLimitInterruptions"]),
      },
      scheduling: {
        queued: integer(scheduling["queued"]),
        oldestQueuedAt: timestamp(scheduling["oldestQueuedAt"]),
        oldestQueuedAgeSeconds:
          timestamp(scheduling["oldestQueuedAt"]) === null
            ? null
            : Math.max(
                0,
                Math.floor(
                  (Date.parse(capturedAt) -
                    Date.parse(timestamp(scheduling["oldestQueuedAt"]) as string)) /
                    1000,
                ),
              ),
        placedAttempts: integer(scheduling["placedAttempts"]),
        averageQueueDurationMs: duration(scheduling["averageQueueDurationMs"]),
        maximumQueueDurationMs: duration(scheduling["maximumQueueDurationMs"]),
        averagePlacementDurationMs: duration(scheduling["averagePlacementDurationMs"]),
        maximumPlacementDurationMs: duration(scheduling["maximumPlacementDurationMs"]),
        admissionRejections: integer(scheduling["admissionRejections"]),
        byPriority,
        reservations: {
          consumed: integer(scheduling["reservationsConsumed"]),
          active: integer(scheduling["reservationsActive"]),
          expired: integer(scheduling["reservationsExpired"]),
        },
        workerHosts: workerHosts.map((row) => {
          const capacity = integer(row["capacity"]);
          const activeAttempts = integer(row["activeAttempts"]);
          const draining = integer(row["draining"]) === 1 || row["draining"] === true;
          const connected = String(row["connectionStatus"]) === "connected";
          return {
            id: String(row["id"]),
            phase: draining ? "draining" : connected ? "connected" : "unreachable",
            activeAttempts,
            capacity,
            availableSlots: integer(row["availableSlots"]),
            utilization: capacity === 0 ? 0 : Math.min(1, activeAttempts / capacity),
          };
        }),
      },
      mailbox: queue(mailbox),
      replyDelivery: queue(replies),
    };
  }

  private async one(statement: string): Promise<Row> {
    return (await this.query(statement))[0] ?? {};
  }

  private recoverySql(asOf: string): string {
    const durable = this.jsonText('a."workerSnapshot"', "durableExecution");
    const outcomeUnknown = this.jsonText('q."result"', "outcomeUnknown");
    const blocked = this.provider === "postgresql" ? "true" : "1";
    return `SELECT
      (SELECT count(*) FROM "InboundControlDelivery" WHERE "status" = 'unknown') AS "unknownControlDeliveries",
      (SELECT count(*) FROM (SELECT DISTINCT "tagId", "sessionKey" FROM "DurableInboundEvent" WHERE "sessionBlocked" = ${blocked}) blocked) AS "blockedSessions",
      (SELECT count(*) FROM "TaskAssignment" q
        LEFT JOIN "TaskAttempt" a ON a."id" = (
          SELECT latest."id" FROM "TaskAttempt" latest
          WHERE latest."taskId" = q."taskId" ORDER BY latest."attemptNumber" DESC LIMIT 1
        )
        WHERE (q."status" = 'running' AND q."leaseExpiresAt" IS NOT NULL
          AND q."leaseExpiresAt" <= ${literal(asOf)} AND ${durable} IN ('true', '1'))
          OR (q."status" = 'failed' AND ${outcomeUnknown} IN ('true', '1'))
      ) AS "durableExecutionsAwaitingReconciliation"`;
  }

  private inboxSql(): string {
    return `SELECT 'task_approval' AS "kind", count(*) AS "count", min("updatedAt") AS "oldest" FROM "TaskAssignment" WHERE "status" = 'queued' AND "approval" = 'pending'
      UNION ALL SELECT 'task_review', count(*), min("updatedAt") FROM "TaskAssignment" WHERE "status" = 'submitted'`;
  }

  private usageSql(): string {
    const total = this.jsonNumber('"payload"', "usage", "totalTokens");
    const complete = this.jsonText('"payload"', "usage", "complete");
    return `WITH ranked AS (
      SELECT "attemptId", "payload", row_number() OVER (PARTITION BY "attemptId" ORDER BY "sequence" DESC) AS rn
      FROM "TaskEvent" WHERE "type" = 'usage.updated' AND "attemptId" IS NOT NULL
    ) SELECT count(*) AS "reportingAttempts", coalesce(sum(${total}), 0) AS "totalTokens",
      coalesce(sum(CASE WHEN ${complete} IN ('true', '1') THEN 0 ELSE 1 END), 0) AS "incompleteAttempts"
      FROM ranked WHERE rn = 1`;
  }

  private costSql(): string {
    const currency = this.jsonText('"payload"', "usage", "reportedCost", "currency");
    const amount = this.jsonNumber('"payload"', "usage", "reportedCost", "amountMinor");
    return `WITH ranked AS (
      SELECT "attemptId", "payload", row_number() OVER (PARTITION BY "attemptId" ORDER BY "sequence" DESC) AS rn
      FROM "TaskEvent" WHERE "type" = 'usage.updated' AND "attemptId" IS NOT NULL AND ${currency} IS NOT NULL
    ) SELECT ${currency} AS "currency", coalesce(sum(${amount}), 0) AS "amount"
      FROM ranked WHERE rn = 1 AND ${currency} IS NOT NULL GROUP BY ${currency}`;
  }

  private agentSql(): string {
    const agentId = this.jsonText('"payload"', "agent", "id");
    const parentId = this.jsonText('"payload"', "agent", "parentId");
    const status = this.jsonText('"payload"', "agent", "status");
    return `WITH events AS (
      SELECT "attemptId", "sequence", ${agentId} AS agent_id, ${status} AS status,
        lag(${status}) OVER (PARTITION BY "attemptId", ${agentId} ORDER BY "sequence") AS prior_status
      FROM "TaskEvent" WHERE "type" = 'agent.updated' AND "attemptId" IS NOT NULL AND ${parentId} IS NOT NULL
    ), changes AS (
      SELECT "attemptId", "sequence", CASE
        WHEN status = 'running' AND (prior_status IS NULL OR prior_status <> 'running') THEN 1
        WHEN status <> 'running' AND prior_status = 'running' THEN -1 ELSE 0 END AS delta FROM events
    ), concurrency AS (
      SELECT sum(delta) OVER (PARTITION BY "attemptId" ORDER BY "sequence" ROWS UNBOUNDED PRECEDING) AS active FROM changes
    ) SELECT coalesce(max(active), 0) AS "peakConcurrent" FROM concurrency`;
  }

  private limitSql(): string {
    const message = this.jsonText('"payload"', "error", "message");
    return `SELECT
      coalesce(sum(CASE WHEN ${message} LIKE '%reported token budget exceeded%' THEN 1 ELSE 0 END), 0) AS "tokenLimitInterruptions",
      coalesce(sum(CASE WHEN ${message} LIKE '%native agent limit exceeded%' THEN 1 ELSE 0 END), 0) AS "agentLimitInterruptions"
      FROM "TaskEvent" WHERE "type" = 'execution.failed'`;
  }

  private schedulingSql(asOf: string): string {
    const placement = this.jsonText('a."workerSnapshot"', "placement", "workerHostId");
    const reservation = this.jsonText('a."workerSnapshot"', "placement", "reservation", "id");
    const reservationExpiry = this.jsonText(
      'a."workerSnapshot"',
      "placement",
      "reservation",
      "expiresAt",
    );
    const acceptedHost = this.jsonText('a."workerSnapshot"', "workerHostId");
    const placementDuration = this.jsonNumber('a."workerSnapshot"', "selectionDurationMs");
    const queueDuration =
      this.provider === "postgresql"
        ? 'extract(epoch FROM (a."startedAt"::timestamptz - q."createdAt"::timestamptz)) * 1000'
        : '(julianday(a."startedAt") - julianday(q."createdAt")) * 86400000';
    return `SELECT
      (SELECT count(*) FROM "TaskAssignment" WHERE "status" = 'queued') AS "queued",
      (SELECT min("createdAt") FROM "TaskAssignment" WHERE "status" = 'queued') AS "oldestQueuedAt",
      count(CASE WHEN ${placement} IS NOT NULL THEN 1 END) AS "placedAttempts",
      coalesce(avg(CASE WHEN ${placement} IS NOT NULL THEN ${queueDuration} END), 0) AS "averageQueueDurationMs",
      coalesce(max(CASE WHEN ${placement} IS NOT NULL THEN ${queueDuration} END), 0) AS "maximumQueueDurationMs",
      coalesce(avg(CASE WHEN ${placement} IS NOT NULL THEN ${placementDuration} END), 0) AS "averagePlacementDurationMs",
      coalesce(max(CASE WHEN ${placement} IS NOT NULL THEN ${placementDuration} END), 0) AS "maximumPlacementDurationMs",
      (SELECT count(*) FROM "TaskEvent" WHERE "type" = 'task.admission-rejected') AS "admissionRejections",
      count(CASE WHEN ${reservation} IS NOT NULL AND ${acceptedHost} IS NOT NULL THEN 1 END) AS "reservationsConsumed",
      count(CASE WHEN ${reservation} IS NOT NULL AND ${acceptedHost} IS NULL AND ${reservationExpiry} > ${literal(asOf)} THEN 1 END) AS "reservationsActive",
      count(CASE WHEN ${reservation} IS NOT NULL AND ${acceptedHost} IS NULL AND ${reservationExpiry} <= ${literal(asOf)} THEN 1 END) AS "reservationsExpired"
      FROM "TaskAttempt" a JOIN "TaskAssignment" q ON q."taskId" = a."taskId"`;
  }

  private schedulingByPrioritySql(): string {
    const placement = this.jsonText('a."workerSnapshot"', "placement", "workerHostId");
    const queueDuration =
      this.provider === "postgresql"
        ? 'extract(epoch FROM (a."startedAt"::timestamptz - q."createdAt"::timestamptz)) * 1000'
        : '(julianday(a."startedAt") - julianday(q."createdAt")) * 86400000';
    return `SELECT q."priority" AS "priority",
      count(DISTINCT CASE WHEN q."status" = 'queued' THEN q."taskId" END) AS "queued",
      min(CASE WHEN q."status" = 'queued' THEN q."createdAt" END) AS "oldestQueuedAt",
      count(CASE WHEN ${placement} IS NOT NULL THEN 1 END) AS "placedAttempts",
      coalesce(avg(CASE WHEN ${placement} IS NOT NULL THEN ${queueDuration} END), 0) AS "averageQueueDurationMs",
      coalesce(max(CASE WHEN ${placement} IS NOT NULL THEN ${queueDuration} END), 0) AS "maximumQueueDurationMs"
      FROM "TaskAssignment" q LEFT JOIN "TaskAttempt" a ON a."taskId" = q."taskId"
      GROUP BY q."priority"`;
  }

  private jsonText(column: string, ...path: string[]): string {
    if (this.provider === "postgresql")
      return (
        path.slice(0, -1).reduce((value, key) => `${value}->'${key}'`, column) +
        `->>'${path.at(-1)}'`
      );
    return `CAST(json_extract(${column}, '$.${path.join(".")}') AS TEXT)`;
  }

  private jsonNumber(column: string, ...path: string[]): string {
    const value = this.jsonText(column, ...path);
    return this.provider === "postgresql"
      ? `coalesce(nullif(${value}, '')::bigint, 0)`
      : `coalesce(CAST(${value} AS INTEGER), 0)`;
  }
}

const resourceSql = `SELECT
  (SELECT count(*) FROM "Tag") AS "tags",
  (SELECT count(*) FROM "Role") AS "roles",
  (SELECT count(*) FROM "RoleAssignment") AS "roleAssignments",
  (SELECT count(*) FROM "SurfaceAccount") AS "surfaceAccounts",
  (SELECT count(*) FROM "TagPermissionSet") AS "permissionSets",
  (SELECT count(*) FROM "TagContextSet") AS "contextSets",
  (SELECT count(*) FROM "Session") AS "sessions",
  (SELECT count(*) FROM "Task") AS "total",
  (SELECT count(*) FROM "Task" WHERE "status" = 'pending') AS "pending",
  (SELECT count(*) FROM "Task" WHERE "status" = 'running') AS "running",
  (SELECT count(*) FROM "Task" WHERE "status" = 'completed') AS "completed",
  (SELECT count(*) FROM "Task" WHERE "status" = 'failed') AS "failed",
  (SELECT count(*) FROM "Task" WHERE "status" = 'cancelled') AS "cancelled"`;

const taskAssignmentSql = `SELECT count(*) AS "total",
  sum(CASE WHEN "status" = 'queued' THEN 1 ELSE 0 END) AS "queued",
  sum(CASE WHEN "status" = 'running' THEN 1 ELSE 0 END) AS "running",
  sum(CASE WHEN "status" = 'waiting' THEN 1 ELSE 0 END) AS "waiting",
  sum(CASE WHEN "status" = 'submitted' THEN 1 ELSE 0 END) AS "submitted",
  sum(CASE WHEN "status" = 'accepted' THEN 1 ELSE 0 END) AS "accepted",
  sum(CASE WHEN "status" = 'rejected' THEN 1 ELSE 0 END) AS "rejected",
  sum(CASE WHEN "status" = 'cancelled' THEN 1 ELSE 0 END) AS "cancelled",
  sum(CASE WHEN "status" = 'failed' THEN 1 ELSE 0 END) AS "failed" FROM "TaskAssignment"`;

const workerHostSql = `SELECT "id", "connectionStatus", "draining", "activeAttempts", "capacity", "availableSlots"
  FROM "WorkerHost" ORDER BY "id"`;

function queueSql(table: string, pending: string, active: string): string {
  return `SELECT
    sum(CASE WHEN "status" IN ('${pending}', '${active}') THEN 1 ELSE 0 END) AS "backlog",
    sum(CASE WHEN "status" IN ('${pending}', '${active}') AND "attemptCount" > 1 THEN 1 ELSE 0 END) AS "retrying",
    sum(CASE WHEN "attemptCount" > 1 THEN "attemptCount" - 1 ELSE 0 END) AS "retryAttempts",
    sum(CASE WHEN "status" = 'failed' THEN 1 ELSE 0 END) AS "failed",
    min(CASE WHEN "status" IN ('${pending}', '${active}') THEN "createdAt" END) AS "oldestPendingAt"
    FROM "${table}"`;
}

function statuses<T extends string>(
  row: Row,
  names: readonly T[],
): Readonly<Record<"total" | T, number>> {
  return Object.fromEntries([
    ["total", integer(row["total"])],
    ...names.map((name) => [name, integer(row[name])] as const),
  ]) as Record<"total" | T, number>;
}

function queue(row: Row): CoordinationMetricSnapshot["mailbox"] {
  return {
    backlog: integer(row["backlog"]),
    retrying: integer(row["retrying"]),
    retryAttempts: integer(row["retryAttempts"]),
    failed: integer(row["failed"]),
    oldestPendingAt: timestamp(row["oldestPendingAt"]),
  };
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function duration(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
