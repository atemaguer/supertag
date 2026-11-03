// biome-ignore-all lint/suspicious/noExplicitAny: Shared dialect transactions use different table types.
import { ownerActivation, type TagMessage } from "@supertag/core";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { publicMessage } from "./mailbox-store.js";

/** Called only under the Objective lock, after persisting a real owner action. */
export function* handleOperatorInputs(
  tx: any,
  tables: any,
  objective: { id: string; ownerTagId: string },
  taskId: string | undefined,
  attemptCount: number | undefined,
  at: string,
  kind: string,
  actionId: string,
  messageId?: string,
): Generator<any, void, any> {
  if (!taskId) return;
  const q = tables.taskAssignments;
  const [task] = yield tx.select().from(q).where(eq(q.taskId, taskId));
  if (
    !task ||
    task.objectiveId !== objective.id ||
    !ownerActivation(task, objective.ownerTagId) ||
    task.status !== "running" ||
    task.attemptCount !== attemptCount ||
    !task.leaseExpiresAt ||
    task.leaseExpiresAt <= at
  )
    return;
  const r = tables.operatorInputReceipts;
  yield tx
    .update(r)
    .set({ handledAt: at, handlingKind: kind, handlingId: actionId })
    .where(
      and(
        eq(r.taskId, taskId),
        eq(r.attemptCount, task.attemptCount),
        lt(r.seenAt, at),
        isNull(r.handledAt),
        messageId === undefined ? undefined : eq(r.messageId, messageId),
      ),
    )
    .returning();
}

/** Delivery or successful execution alone never proves operator input was handled. */
export function* unhandledOperatorInputs(
  tx: any,
  tables: any,
  objective: { id: string; ownerTagId: string },
  limit = 100,
  offset = 0,
): Generator<any, TagMessage[], any> {
  const m = tables.tagMessages;
  const r = tables.operatorInputReceipts;
  const messages = yield tx
    .select()
    .from(m)
    .where(
      and(
        eq(m.objectiveId, objective.id),
        eq(m.recipientTagId, objective.ownerTagId),
        sql`${m.operatorId} is not null`,
        // Synthetic deadline/cancellation notices are born processed, without delivery attempts.
        or(inArray(m.status, ["pending", "processing"]), sql`${m.attemptCount} > 0`),
        sql`not exists (select 1 from ${r} where ${r.messageId} = ${m.id}
      and ${r.handledAt} is not null and ${r.handledAt} > ${m.createdAt})`,
      ),
    )
    .orderBy(desc(m.createdAt), desc(m.id))
    .limit(limit)
    .offset(offset);
  return messages.map(publicMessage);
}
