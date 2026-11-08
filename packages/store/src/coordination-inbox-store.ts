// biome-ignore-all lint/suspicious/noExplicitAny: This read model spans dialect-specific Drizzle tables.

import type {
  CoordinationInboxApproval,
  CoordinationInboxFilter,
  CoordinationInboxItem,
  CoordinationInboxKind,
  CoordinationInboxPage,
  CoordinationInboxStore,
  ReadCoordinationInboxInput,
} from "@supertag/core";
import {
  ATTEMPT_CLEANUP_BLOCK_REASONS,
  COORDINATION_INBOX_KINDS,
  COORDINATION_INBOX_VERSION,
  coordinationInboxCommands,
  coordinationInboxQuestion,
  mailboxText,
  OBJECTIVE_CLOSED_STATUSES,
  objectiveLimitEvents,
  readableDuration,
  TagMessagingError,
} from "@supertag/core";
import { and, asc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";

export const COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT = 1_000;
/** Render deadline warnings against the inbox read time, not their recorded warning time. */
export function inboxLimitReason(
  event: { kind: string; message: string },
  deadline: string | null,
  asOf: string,
): string {
  if (event.kind !== "objective_deadline_approaching" || !deadline) return event.message;
  const remaining = Date.parse(deadline) - Date.parse(asOf);
  return remaining > 0
    ? `The Objective deadline ${deadline} is near: ${readableDuration(remaining)} left.`
    : `The Objective deadline ${deadline} has passed.`;
}

/** The latest Task of the Session `alias` names, as a correlated subquery. */
const latestTaskOf = (alias: string) =>
  sql.raw(
    `(select lt."id" from "Task" lt where lt."sessionId" = ${alias}."id" order by lt."createdAt" desc, lt."id" desc limit 1)`,
  );

interface InboxCursor {
  readonly v: 6;
  readonly asOf: string;
  readonly actionableSince: string;
  readonly key: string;
  readonly filter: CoordinationInboxFilter;
}

/**
 * Read-only, redacted projection over open Objectives and the Tasks of their Sessions that need
 * an operator: decisions, questions, limits, and Tasks that cannot continue on their own.
 */
export class DrizzleCoordinationInboxStore implements CoordinationInboxStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
  ) {}

  async readCoordinationInbox(
    input: ReadCoordinationInboxInput = {},
  ): Promise<CoordinationInboxPage> {
    const limit = parseLimit(input.limit);
    const requestedFilter = parseFilter(input);
    const cursor = input.cursor === undefined ? undefined : parseCursor(input.cursor);
    const hasExplicitFilter =
      input.objectiveId !== undefined ||
      input.kind !== undefined ||
      input.status !== undefined ||
      input.nextActorId !== undefined;
    if (cursor && hasExplicitFilter && !sameFilter(cursor.filter, requestedFilter))
      throw new TagMessagingError(400, "Coordination inbox cursor does not match filters");
    const filter = cursor && !hasExplicitFilter ? cursor.filter : requestedFilter;
    const asOf = parseAsOf(cursor?.asOf ?? input.asOf ?? new Date().toISOString());
    if (cursor && input.asOf !== undefined && parseAsOf(input.asOf) !== cursor.asOf)
      throw new TagMessagingError(400, "Coordination inbox cursor does not match asOf");
    const wants = (kind: CoordinationInboxKind) =>
      filter.kind === undefined || filter.kind === kind;

    const t = this.tables;
    const o = t.objectives;
    const objectives = (await this.db
      .select()
      .from(o)
      .where(
        and(
          notInArray(o.status, [...OBJECTIVE_CLOSED_STATUSES]),
          lte(o.createdAt, asOf),
          filter.objectiveId === undefined ? undefined : eq(o.id, filter.objectiveId),
        ),
      )
      .orderBy(asc(o.createdAt), asc(o.id))
      .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1)) as any[];
    const truncatedKinds = new Set<CoordinationInboxKind>();
    const truncated = (rows: readonly unknown[], kinds: readonly CoordinationInboxKind[]) => {
      if (rows.length > COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)
        for (const kind of kinds) if (wants(kind)) truncatedKinds.add(kind);
    };
    truncated(objectives, ["objective_budget", "objective_limit"]);
    const open = objectives.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT);
    const openObjectiveIds = this.db
      .select({ id: o.id })
      .from(o)
      .where(notInArray(o.status, [...OBJECTIVE_CLOSED_STATUSES]));

    const items: CoordinationInboxItem[] = [];
    const push = (item: Omit<CoordinationInboxItem, "projectionVersion" | "ageSeconds">) => {
      const value: CoordinationInboxItem = {
        projectionVersion: COORDINATION_INBOX_VERSION,
        ...item,
        commands: coordinationInboxCommands(item),
        ageSeconds: Math.max(
          0,
          Math.floor((Date.parse(asOf) - Date.parse(item.actionableSince)) / 1_000),
        ),
      };
      if (matches(value, filter)) items.push(value);
    };
    const objectiveEvidence = (objective: any) =>
      ({ kind: "objective", id: objective.id, revision: objective.revision }) as const;
    const taskEvidence = (task: any) =>
      ({
        kind: "task",
        id: task.id,
        status: task.status,
        attemptCount: task.attemptCount ?? 0,
        updatedAt: task.updatedAt,
      }) as const;

    if (input.includeApprovals !== false && wants("approval")) {
      const a = t.approvalRequests,
        task = t.tasks,
        session = t.sessions;
      const rows = (await this.db
        .select({
          request: a,
          task: { id: task.id, status: task.status, sessionId: task.sessionId },
          latestTaskId: sql`(select lt."id" from "Task" lt where lt."sessionId" = ${task.sessionId} order by lt."createdAt" desc, lt."id" desc limit 1)`,
          requester: { name: t.tags.name },
          objective: o,
        })
        .from(a)
        .leftJoin(o, eq(o.id, a.objectiveId))
        .leftJoin(task, eq(task.id, a.taskId))
        .leftJoin(session, eq(session.id, task.sessionId))
        .leftJoin(t.tags, eq(t.tags.id, a.requestingTagId))
        .where(
          and(
            eq(a.status, "pending"),
            lte(a.createdAt, asOf),
            filter.objectiveId === undefined
              ? or(
                  and(
                    isNotNull(a.objectiveId),
                    notInArray(o.status, [...OBJECTIVE_CLOSED_STATUSES]),
                  ),
                  // A Tag's inbox turn has no Objective; its requests reach only this inbox.
                  and(isNull(a.objectiveId), sql`${session.sessionKey} like 'inbox:%'`),
                )
              : and(
                  eq(a.objectiveId, filter.objectiveId),
                  notInArray(o.status, [...OBJECTIVE_CLOSED_STATUSES]),
                ),
          ),
        )
        .orderBy(asc(a.createdAt), asc(a.id))
        .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1)) as any[];
      truncated(rows, ["approval"]);
      for (const row of rows.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)) {
        const { request, objective } = row;
        // A Session waits on the request while its Task runs, or ended waiting and is still the
        // Session's latest Task; a request a later Task superseded can never be used.
        const waiting =
          row.task?.status === "running" ||
          row.task?.status === "pending" ||
          (row.task?.status === "completed" && row.latestTaskId === row.task.id);
        if (!waiting) continue;
        const approval: CoordinationInboxApproval = {
          requestId: request.id,
          requestKind: request.kind,
          summary: request.summary,
          requestingTagId: request.requestingTagId,
          ...(row.requester?.name ? { requestingTagName: row.requester.name } : {}),
          taskId: request.taskId,
          blocking: true,
        };
        push({
          key: `approval:${request.id}`,
          kind: "approval",
          status: "pending",
          reason: "A Session waits for this decision and continues once it is made.",
          objectiveId: objective?.id ?? null,
          nextActorTagIds: [],
          excludedActorTagIds: [request.requestingTagId],
          operatorEligible: true,
          actionableSince: request.createdAt,
          deadline: objective?.deadline ?? null,
          evidence: [
            { kind: "approval_request", id: request.id },
            ...(objective ? [objectiveEvidence(objective)] : []),
          ],
          permittedActions: [],
          approval,
          redaction: metadataOnly(["actions", "argumentsDigest"]),
        });
      }
    }

    if (wants("question")) {
      const s = t.sessions,
        task = t.tasks;
      const rows = (await this.db
        .select({ task, objective: o })
        .from(s)
        .innerJoin(o, eq(o.id, s.objectiveId))
        .innerJoin(task, sql`${task.id} = ${latestTaskOf('"Session"')}`)
        .where(
          and(
            isNotNull(s.objectiveId),
            sql`${s.parentSessionId} is null`,
            sql`${s.sessionKey} = 'objective:' || ${s.objectiveId}`,
            notInArray(o.status, [...OBJECTIVE_CLOSED_STATUSES]),
            filter.objectiveId === undefined ? undefined : eq(o.id, filter.objectiveId),
            eq(task.status, "completed"),
            lte(task.updatedAt, asOf),
          ),
        )
        .orderBy(asc(task.updatedAt), asc(task.id))
        .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1)) as any[];
      truncated(rows, ["question"]);
      for (const { task: row, objective } of rows.slice(
        0,
        COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT,
      )) {
        const question = record(row.outcome)?.["question"];
        if (typeof question !== "string" || !question.trim()) continue;
        const askedAt = row.endedAt ?? row.updatedAt;
        push({
          key: `question:${row.id}`,
          kind: "question",
          status: "pending",
          reason: `Objective ${objective.id} asked a question and waits on the answer.`,
          objectiveId: objective.id,
          nextActorTagIds: [],
          excludedActorTagIds: [],
          operatorEligible: true,
          actionableSince: askedAt,
          deadline: objective.deadline ?? null,
          evidence: [taskEvidence(row), objectiveEvidence(objective)],
          permittedActions: [],
          question: coordinationInboxQuestion(question, askedAt),
          redaction: metadataOnly([]),
        });
      }
    }

    if (wants("objective_budget") || wants("objective_limit"))
      for (const objective of open) {
        if (!objective.executionStartedAt) continue;
        for (const event of objectiveLimitEvents(objective)) {
          if (event.at > asOf) continue;
          // A spent budget refuses new work until an operator raises it; the other limits warn.
          const kind =
            event.kind === "objective_budget_exhausted" ? "objective_budget" : "objective_limit";
          const budget = event.kind.startsWith("objective_budget");
          push({
            key: `${kind}:${objective.id}:${event.key}`,
            kind,
            status: "pending",
            reason: inboxLimitReason(event, objective.deadline ?? null, asOf),
            objectiveId: objective.id,
            nextActorTagIds: [],
            excludedActorTagIds: [],
            operatorEligible: true,
            actionableSince: event.at,
            deadline: objective.deadline ?? null,
            evidence: [objectiveEvidence(objective)],
            permittedActions: [
              {
                tool: "update_objective",
                arguments: { objectiveId: objective.id, expectedRevision: objective.revision },
                requiredInputFields: [budget ? "budgetLimitMinor" : "deadline"],
              },
            ],
            redaction: metadataOnly([]),
          });
        }
      }

    if (wants("task_attention")) {
      const task = t.tasks,
        i = t.durableInboundEvents;
      // A turn whose effect could not be confirmed blocks its Session: SuperTag never replays it,
      // and the item lasts while the Session is blocked. Only a Task Attempt's execution or
      // cancellation cleanup is released by the Worker's terminal receipt, automatic on
      // reconnect or after an operator's recovery; the item promises that only for those.
      const blocked = (await this.db
        .select({
          task,
          error: i.lastError,
          attempt: sql`(select ta."id" from "TaskAttempt" ta where ta."taskId" = ${task.id} order by ta."attemptNumber" desc limit 1)`,
          attemptCount: i.attemptCount,
          objective: o,
        })
        .from(i)
        .innerJoin(task, eq(task.inboundEventId, i.id))
        .innerJoin(o, eq(o.id, task.objectiveId))
        .where(
          and(
            eq(i.sessionBlocked, true),
            inArray(task.objectiveId, openObjectiveIds),
            lte(task.updatedAt, asOf),
            filter.objectiveId === undefined ? undefined : eq(o.id, filter.objectiveId),
          ),
        )
        .orderBy(asc(task.updatedAt), asc(task.id))
        .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1)) as any[];
      const integrity = (await this.db
        .select({ task, objective: o })
        .from(task)
        .innerJoin(o, eq(o.id, task.objectiveId))
        .where(
          and(
            eq(task.status, "failed"),
            inArray(task.objectiveId, openObjectiveIds),
            // A failed Attempt records what the Worker reported as its source in the outcome.
            sql`${task.outcome} is not null`,
            lte(task.updatedAt, asOf),
            filter.objectiveId === undefined ? undefined : eq(o.id, filter.objectiveId),
          ),
        )
        .orderBy(asc(task.updatedAt), asc(task.id))
        .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1)) as any[];
      truncated(blocked, ["task_attention"]);
      truncated(integrity, ["task_attention"]);
      // The recover command names the Worker that ran the Attempt, so the item carries the
      // Attempt's recorded Worker identity alongside its id.
      const uncertainWorkers = await this.uncertainAttemptWorkers(
        blocked
          .slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)
          .map((row) => row.attempt)
          .filter((id): id is string => typeof id === "string"),
      );
      for (const row of blocked.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)) {
        const attemptId = typeof row.attempt === "string" ? row.attempt : undefined;
        const why = String(row.error ?? "Execution completion could not be confirmed").replace(
          /[.\s]*$/u,
          ".",
        );
        const releasedByReceipt =
          attemptId !== undefined && ATTEMPT_CLEANUP_BLOCK_REASONS.has(String(row.error));
        push({
          key: `task_attention:${row.task.id}:uncertain:${attemptId ?? "none"}`,
          kind: "task_attention",
          status: "pending",
          reason: releasedByReceipt
            ? `The Task's Attempt may have executed, so SuperTag will not replay it, and its Session takes no new turn while that execution may still run. Why: ${why} The Session resumes once its Worker Host records that the Attempt stopped, which the Worker does itself on reconnect when it can verify cleanup. Otherwise, on the Worker Host that ran it, stop the host service first (supertag down SERVICE), confirm all of the Attempt's processes and remote executions stopped, then run the recover command and start the host again. The Task keeps its outcome and never runs again.`
            : `SuperTag could not confirm what this turn did, so it will not replay it, and its Session takes no new turn. Why: ${why}`,
          objectiveId: row.objective.id,
          nextActorTagIds: [],
          excludedActorTagIds: [],
          operatorEligible: true,
          actionableSince: row.task.updatedAt,
          deadline: row.objective.deadline ?? null,
          evidence: [
            taskEvidence({ ...row.task, attemptCount: row.attemptCount }),
            objectiveEvidence(row.objective),
          ],
          ...(attemptId === undefined
            ? {}
            : {
                uncertainAttempt: {
                  attemptId,
                  ...(uncertainWorkers.get(attemptId) ?? {}),
                },
              }),
          permittedActions: [],
          redaction: metadataOnly(["request", "result"]),
        });
      }
      for (const { task: row, objective } of integrity.slice(
        0,
        COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT,
      )) {
        const result = record(row.outcome);
        if (result?.["failureKind"] !== "workspace-integrity") continue;
        push({
          key: `task_attention:${row.id}`,
          kind: "task_attention",
          status: "pending",
          reason: `The Worker stopped running git for this Task because the repository's git config changed during its Task Attempt. ${String(result["error"] ?? "")} Inspect the restored repository config on the Worker Host before continuing the work.`,
          objectiveId: objective.id,
          nextActorTagIds: [],
          excludedActorTagIds: [],
          operatorEligible: true,
          actionableSince: row.updatedAt,
          deadline: objective.deadline ?? null,
          evidence: [taskEvidence(row), objectiveEvidence(objective)],
          permittedActions: [],
          redaction: metadataOnly(["request", "result"]),
        });
      }
    }

    if (wants("mcp_login")) {
      const task = t.tasks,
        e = t.taskEvents;
      const pending = (await this.db
        .select({ task, objective: o })
        .from(task)
        .innerJoin(o, eq(o.id, task.objectiveId))
        .where(
          and(
            eq(task.status, "pending"),
            inArray(task.objectiveId, openObjectiveIds),
            lte(task.createdAt, asOf),
            filter.objectiveId === undefined ? undefined : eq(o.id, filter.objectiveId),
          ),
        )
        .orderBy(asc(task.updatedAt), asc(task.id))
        .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1)) as any[];
      truncated(pending, ["mcp_login"]);
      const candidates = pending.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT);
      const events =
        candidates.length === 0
          ? []
          : await this.db
              .select({
                taskId: e.taskId,
                type: e.type,
                payload: e.payload,
                createdAt: e.createdAt,
              })
              .from(e)
              .where(
                and(
                  inArray(
                    e.taskId,
                    candidates.map((row: any) => row.task.id),
                  ),
                  inArray(e.type, ["task.scheduling-incompatible", "task.scheduling-compatible"]),
                  lte(e.createdAt, asOf),
                ),
              )
              .orderBy(asc(e.taskId), asc(e.sequence));
      const latest = new Map<string, any>();
      for (const event of events) latest.set(event.taskId, event);
      for (const { task: row, objective } of candidates) {
        const event = latest.get(row.id);
        if (event?.type !== "task.scheduling-incompatible") continue;
        for (const server of mcpLoginServers(event.payload))
          push({
            key: `mcp_login:${row.id}:${server}`,
            kind: "mcp_login",
            status: "pending",
            reason: `The Task needs MCP server ${server}, whose login lapsed on its Worker Host. Run the login command on that host; the Task waits until then.`,
            objectiveId: objective.id,
            nextActorTagIds: [],
            excludedActorTagIds: [],
            operatorEligible: true,
            actionableSince: event.createdAt,
            deadline: objective.deadline ?? null,
            evidence: [taskEvidence(row), objectiveEvidence(objective)],
            permittedActions: [],
            redaction: metadataOnly(["request"]),
          });
      }
    }

    items.sort(
      (left, right) =>
        left.actionableSince.localeCompare(right.actionableSince) ||
        left.key.localeCompare(right.key),
    );
    const after = cursor
      ? items.filter(
          (item) =>
            item.actionableSince > cursor.actionableSince ||
            (item.actionableSince === cursor.actionableSince && item.key > cursor.key),
        )
      : items;
    const pageItems = after.slice(0, limit);
    const last = pageItems.at(-1);
    return {
      projectionVersion: COORDINATION_INBOX_VERSION,
      asOf,
      items: pageItems,
      tagNames: {},
      truncatedKinds: [...truncatedKinds].sort(),
      ...(after.length > limit && last
        ? {
            nextCursor: encodeCursor({
              v: 6,
              asOf,
              actionableSince: last.actionableSince,
              key: last.key,
              filter,
            }),
          }
        : {}),
    };
  }

  /**
   * The Worker Host and Worker each Attempt recorded when it accepted the turn, read from the
   * Attempt's Worker snapshot. Without them the inbox cannot name a runnable recover command.
   */
  private async uncertainAttemptWorkers(
    attemptIds: readonly string[],
  ): Promise<Map<string, { workerHostId?: string; workerId?: string }>> {
    const workers = new Map<string, { workerHostId?: string; workerId?: string }>();
    if (attemptIds.length === 0) return workers;
    const attempts = this.tables.taskAttempts;
    const rows = (await this.db
      .select({ id: attempts.id, snapshot: attempts.workerSnapshot })
      .from(attempts)
      .where(inArray(attempts.id, [...new Set(attemptIds)]))) as any[];
    for (const row of rows) {
      const snapshot = record(row.snapshot) ?? {};
      const workerHostId = snapshot["workerHostId"];
      const workerId = snapshot["workerId"];
      workers.set(row.id, {
        ...(typeof workerHostId === "string" ? { workerHostId } : {}),
        ...(typeof workerId === "string" ? { workerId } : {}),
      });
    }
    return workers;
  }
}

function metadataOnly(omitted: readonly string[]): CoordinationInboxItem["redaction"] {
  return { level: "metadata_only", omitted };
}

function matches(item: CoordinationInboxItem, filter: CoordinationInboxFilter): boolean {
  return (
    (filter.objectiveId === undefined || item.objectiveId === filter.objectiveId) &&
    (filter.kind === undefined || item.kind === filter.kind) &&
    (filter.status === undefined || item.status === filter.status) &&
    (filter.nextActorId === undefined || item.nextActorTagIds.includes(filter.nextActorId))
  );
}

function parseFilter(input: ReadCoordinationInboxInput): CoordinationInboxFilter {
  if (input.kind !== undefined && !COORDINATION_INBOX_KINDS.includes(input.kind))
    throw new TagMessagingError(400, "Invalid coordination inbox kind");
  if (input.status !== undefined && input.status !== "pending")
    throw new TagMessagingError(400, "Invalid coordination inbox status");
  return {
    ...(input.objectiveId === undefined
      ? {}
      : { objectiveId: mailboxText(input.objectiveId, "objectiveId") }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.nextActorId === undefined
      ? {}
      : { nextActorId: mailboxText(input.nextActorId, "nextActorId") }),
  };
}

function parseLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TagMessagingError(400, "Coordination inbox limit must be an integer from 1 to 100");
  return limit;
}

function parseAsOf(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new TagMessagingError(400, "Coordination inbox asOf must be an ISO timestamp");
  const normalized = new Date(value).toISOString();
  if (Date.parse(normalized) > Date.now())
    throw new TagMessagingError(400, "Coordination inbox asOf cannot be in the future");
  return normalized;
}

function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function record(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function parseCursor(value: string): InboxCursor {
  try {
    if (typeof value !== "string" || value.length < 1 || value.length > 4_096)
      throw new Error("size");
    const cursor = record(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (
      cursor?.["v"] !== 6 ||
      typeof cursor["asOf"] !== "string" ||
      typeof cursor["actionableSince"] !== "string" ||
      typeof cursor["key"] !== "string" ||
      !record(cursor["filter"])
    )
      throw new Error("shape");
    parseAsOf(cursor["asOf"]);
    if (
      !Number.isFinite(Date.parse(cursor["actionableSince"])) ||
      cursor["key"].length < 1 ||
      cursor["key"].length > 1_000
    )
      throw new Error("position");
    return {
      v: 6,
      asOf: cursor["asOf"],
      actionableSince: cursor["actionableSince"],
      key: cursor["key"],
      filter: parseFilter(cursor["filter"] as ReadCoordinationInboxInput),
    };
  } catch (error) {
    if (error instanceof TagMessagingError) throw error;
    throw new TagMessagingError(400, "Invalid coordination inbox cursor");
  }
}

function sameFilter(left: CoordinationInboxFilter, right: CoordinationInboxFilter): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** MCP server names a scheduling diagnosis holds for a login. */
function mcpLoginServers(payload: unknown): string[] {
  const value = record(payload)?.["mcpLogins"];
  return Array.isArray(value)
    ? value.filter(
        (server): server is string =>
          typeof server === "string" && /^[a-z0-9][a-z0-9_-]{0,58}$/u.test(server),
      )
    : [];
}
