// biome-ignore-all lint/suspicious/noExplicitAny: Shared dialect transaction helpers.
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNotNull, ne, or, sql } from "drizzle-orm";
import type { TeamReplySource } from "./team-reply-triggers.js";

export const TEAM_REPLY_PAIR_TASK_LIMIT = 3;
export const TEAM_REPLY_TAG_HOUR_LIMIT = 4;
export const TEAM_REPLY_HOUR_MS = 60 * 60 * 1000;
/** Content retries share a five-minute window anchored to the original item. */
export const TEAM_REPLY_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
/** Only the store generates post IDs; callers cannot impersonate a system notice with a key. */
export const TEAM_REPLY_LOOP_NOTICE_PREFIX = "team-reply-loop:";

type Flow<T> = Generator<any, T, any>;
type Root = string | null;

/**
 * Called under the Objective and Team locks, before persisting an admitted reply. Those locks
 * serialize the check with admission in both dialects, including replies held for approval.
 * Coalescing must check each source and mark only allowed sources as admitted.
 * Digest-only edges preserve ancestry but never count as wakes or authorize execution.
 * Counts use distinct admitted Task IDs, so a batch consumes one wake per participating pair.
 * Cancellation, failure, approval and settlement never refund a wake.
 */
export function* teamReplyLoopBrakeAllows(
  tx: any,
  tables: any,
  source: TeamReplySource,
  now: string,
): Flow<boolean> {
  const r = tables.teamReplyTriggers;
  const cache = new Map<string, Set<Root>>();
  // Follow durable source edges, not reply IDs supplied in message bodies or mutable Task status.
  // Each original non-reply source Task is a scope. A coalesced reply inherits every root; a
  // source without an attributable Task shares the Objective's null scope, never a fresh quota.
  const roots = function* (taskId: Root): Flow<Set<Root>> {
    if (taskId === null) return new Set([null]);
    const cached = cache.get(taskId);
    if (cached) return cached;
    const parents = yield tx
      .select({ sourceTaskId: r.sourceTaskId })
      .from(r)
      .where(and(eq(r.objectiveId, source.objectiveId), eq(r.taskId, taskId)));
    const result = new Set<Root>();
    cache.set(taskId, result);
    if (!parents.length) result.add(taskId);
    for (const parent of parents)
      for (const root of yield* roots(parent.sourceTaskId)) result.add(root);
    return result;
  };
  const scopes = yield* roots(source.sourceTaskId ?? null);
  const history = yield tx
    .select({ taskId: r.taskId, sourceTaskId: r.sourceTaskId })
    .from(r)
    .where(
      and(
        eq(r.objectiveId, source.objectiveId),
        isNotNull(r.taskId),
        ne(r.status, "digest"),
        or(
          and(eq(r.senderTagId, source.senderTagId), eq(r.recipientTagId, source.recipientTagId)),
          and(eq(r.senderTagId, source.recipientTagId), eq(r.recipientTagId, source.senderTagId)),
        ),
      ),
    );
  const counts = new Map<Root, Set<string>>([...scopes].map((scope) => [scope, new Set()]));
  for (const prior of history)
    for (const scope of yield* roots(prior.sourceTaskId)) counts.get(scope)?.add(prior.taskId);
  let blocked = false;
  for (const [scope, tasks] of counts) {
    if (tasks.size < TEAM_REPLY_PAIR_TASK_LIMIT) continue;
    blocked = true;
    yield* postLoopBlocker(tx, tables, source, scope, now);
  }
  if (blocked) return false;

  const q = tables.taskAssignments;
  const [recent] = yield tx
    .select({ count: sql`count(distinct ${r.taskId})` })
    .from(r)
    .innerJoin(q, eq(q.taskId, r.taskId))
    .where(
      and(
        eq(r.objectiveId, source.objectiveId),
        eq(r.recipientTagId, source.recipientTagId),
        ne(r.status, "digest"),
        gt(q.createdAt, new Date(Date.parse(now) - TEAM_REPLY_HOUR_MS).toISOString()),
      ),
    );
  if (Number(recent.count) < TEAM_REPLY_TAG_HOUR_LIMIT) return true;
  yield* postHourlyBlocker(tx, tables, source, now);
  return false;
}

/** One system notice per Team, pair and original Task; insert directly, without a wake trigger. */
function* postLoopBlocker(
  tx: any,
  tables: any,
  source: TeamReplySource,
  scope: Root,
  now: string,
): Flow<void> {
  const pair = [source.senderTagId, source.recipientTagId].sort();
  const id = `${TEAM_REPLY_LOOP_NOTICE_PREFIX}${createHash("sha256")
    .update(JSON.stringify([source.teamId, source.objectiveId, pair, scope]))
    .digest("hex")}`;
  yield* postSystemBlocker(
    tx,
    tables,
    source,
    id,
    now,
    `Tags ${pair.join(" and ")} reached ${TEAM_REPLY_PAIR_TASK_LIMIT} reply activations for ${scope === null ? "unattributed posts in this Objective" : `Task ${scope}`}. Further posts between them stay available for live delivery or the next digest without waking either Tag.`,
    scope === null ? [] : [scope],
  );
}

/** One hourly-cap notice per Team and recipient in a rolling hour, regardless of sender. */
function* postHourlyBlocker(
  tx: any,
  tables: any,
  source: TeamReplySource,
  now: string,
): Flow<void> {
  const p = tables.workstreamPosts;
  const prefix = `${TEAM_REPLY_LOOP_NOTICE_PREFIX}hour:${createHash("sha256")
    .update(JSON.stringify([source.teamId, source.objectiveId, source.recipientTagId]))
    .digest("hex")}:`;
  const [existing] = yield tx
    .select({ id: p.id })
    .from(p)
    .where(
      and(
        sql`${p.id} like ${`${prefix}%`}`,
        gt(p.createdAt, new Date(Date.parse(now) - TEAM_REPLY_HOUR_MS).toISOString()),
      ),
    )
    .limit(1);
  if (existing) return;
  yield* postSystemBlocker(
    tx,
    tables,
    source,
    `${prefix}${randomUUID()}`,
    now,
    `Tag ${source.recipientTagId} reached ${TEAM_REPLY_TAG_HOUR_LIMIT} reply activations in a rolling hour for Objective ${source.objectiveId}. Further posts to this Tag stay available for live delivery or the next digest without waking it until allowance becomes available.`,
    [],
  );
}

function* postSystemBlocker(
  tx: any,
  tables: any,
  source: TeamReplySource,
  id: string,
  now: string,
  body: string,
  references: string[],
): Flow<void> {
  const p = tables.workstreamPosts;
  // Only store-generated IDs can identify notices; member idempotency keys cannot forge one.
  const [existing] = yield tx.select({ id: p.id }).from(p).where(eq(p.id, id)).limit(1);
  if (existing) return;
  const [team] = yield tx.select().from(tables.teams).where(eq(tables.teams.id, source.teamId));
  const [last] = yield tx
    .select({ sequence: p.sequence })
    .from(p)
    .where(and(eq(p.workstreamId, source.teamId), eq(p.objectiveId, source.objectiveId)))
    .orderBy(desc(p.sequence))
    .limit(1);
  yield tx
    .insert(p)
    .values({
      id,
      workstreamId: source.teamId,
      objectiveId: source.objectiveId,
      authorTagId: null,
      sourceTaskId: null,
      type: "blocker",
      to: [team.leadTagId],
      body: `System loop brake: ${body} This notice does not wake anyone or require a reply.`,
      references,
      replyTo: null,
      sequence: (last?.sequence ?? 0) + 1,
      createdAt: now,
      idempotencyKey: randomUUID(),
    })
    .returning();
}
