// biome-ignore-all lint/suspicious/noExplicitAny: Shared dialect transaction helpers.
import { randomUUID } from "node:crypto";
import { teamSupportsObjective } from "@supertag/core";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Collect a short tool-call burst across ten normal 200ms scheduler ticks. Fixed from the
 * first trigger, not sliding: reply latency stays bounded and the five-minute TTL is unchanged.
 */
export const TEAM_REPLY_COALESCE_WINDOW_MS = 2_000;
/** Pending wakes have five minutes to obtain budget; the source still reaches the digest. */
export const TEAM_REPLY_TRIGGER_TTL_MS = 5 * 60 * 1000;
/** Reservation in the Objective's minor budget units, independent of a prior Task's limits. */
export const TEAM_REPLY_RESERVATION_MINOR = 100;

export interface TeamReplySource {
  readonly objectiveId: string;
  readonly teamId: string;
  readonly senderTagId: string;
  readonly recipientTagId: string;
  readonly itemKind: "post" | "direct_message";
  readonly itemId: string;
  readonly itemType: string;
  readonly sourceTaskId?: string | null;
}

/** Called under the Objective and Team locks; Tag claims take the recipient lock too. */
export function* teamReplyRecipientBusy(
  tx: any,
  tables: any,
  tagId: string,
  source: TeamReplySource,
): Generator<any, boolean, any> {
  const tags = tables.tags;
  const [tag] = yield tx
    .update(tags)
    .set({ updatedAt: sql`${tags.updatedAt}` })
    .where(eq(tags.id, tagId))
    .returning();
  if (tag?.status !== "active") return true;
  const q = tables.taskAssignments;
  const [assignment] = yield tx
    .select({ id: q.taskId })
    .from(q)
    .where(and(eq(q.assignedTagId, tagId), inArray(q.status, ["queued", "running"])))
    .limit(1);
  if (assignment) return true;
  const waiting = yield tx
    .select({ wait: q.waitState })
    .from(q)
    .where(
      and(
        eq(q.assignedTagId, tagId),
        eq(q.objectiveId, source.objectiveId),
        eq(q.status, "waiting"),
      ),
    );
  if (waiting.length) {
    const items = source.itemKind === "post" ? tables.workstreamPosts : tables.tagMessages;
    const [item] = yield tx.select().from(items).where(eq(items.id, source.itemId));
    if (
      waiting.some(({ wait }: any) =>
        source.itemKind === "direct_message"
          ? wait?.mailbox && item?.createdAt >= wait.registeredAt
          : wait?.workstreamPosts?.workstreamId === source.teamId &&
            item?.sequence > wait.workstreamPosts.afterSequence,
      )
    )
      return true;
  }
  const t = tables.tasks;
  const [task] = yield tx
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tagId, tagId), eq(t.status, "running")))
    .limit(1);
  return !!task;
}

/** Only the moment of arrival can make a wake eligible. Running recipients keep their digest. */
export function* queueTeamReplyTrigger(
  tx: any,
  tables: any,
  source: TeamReplySource,
): Generator<any, void, any> {
  if (
    !["question", "blocker"].includes(source.itemType) ||
    source.senderTagId === source.recipientTagId
  )
    return;
  if (yield* teamReplyRecipientBusy(tx, tables, source.recipientTagId, source)) return;
  const q = tables.taskAssignments;
  // A message body cannot name its source Task. Infer it only from a unique current assignment.
  const senders = yield tx
    .select({ taskId: q.taskId })
    .from(q)
    .where(
      and(
        eq(q.assignedTagId, source.senderTagId),
        eq(q.objectiveId, source.objectiveId),
        source.sourceTaskId ? eq(q.taskId, source.sourceTaskId) : eq(q.status, "running"),
      ),
    )
    .limit(2);
  const at = new Date().toISOString();
  yield tx
    .insert(tables.teamReplyTriggers)
    .values({
      ...source,
      id: randomUUID(),
      sourceTaskId: senders.length === 1 ? senders[0].taskId : null,
      taskId: null,
      status: "pending",
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .returning();
}

/** Recheck membership and source identity before admission and again before starting a reply. */
export function* validTeamReplySource(
  tx: any,
  tables: any,
  source: TeamReplySource,
): Generator<any, boolean, any> {
  const t = tables.teams;
  const [team] = yield tx.select().from(t).where(eq(t.id, source.teamId));
  const member = (id: string) => team?.leadTagId === id || team?.memberTagIds.includes(id);
  if (
    team?.status !== "active" ||
    !teamSupportsObjective(team, source.objectiveId) ||
    !member(source.senderTagId) ||
    !member(source.recipientTagId)
  )
    return false;
  const [sender] = yield tx
    .select()
    .from(tables.tags)
    .where(eq(tables.tags.id, source.senderTagId));
  if (sender?.status !== "active") return false;
  if (source.itemKind === "post") {
    const p = tables.workstreamPosts;
    const [post] = yield tx.select().from(p).where(eq(p.id, source.itemId));
    return (
      !!post &&
      post.authorTagId === source.senderTagId &&
      post.workstreamId === source.teamId &&
      post.objectiveId === source.objectiveId &&
      ["question", "blocker"].includes(post.type) &&
      post.to.includes(source.recipientTagId)
    );
  }
  const m = tables.tagMessages;
  const [message] = yield tx.select().from(m).where(eq(m.id, source.itemId));
  return (
    !!message &&
    message.senderTagId === source.senderTagId &&
    message.recipientTagId === source.recipientTagId &&
    message.directTeamId === source.teamId &&
    message.objectiveId === source.objectiveId &&
    !message.operatorId &&
    !message.bodyPrunedAt &&
    message.status === "pending" &&
    ["question", "blocker"].includes(message.type)
  );
}
