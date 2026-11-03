// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.
import { TagMessagingError } from "@supertag/core";
import { and, asc, eq, isNull } from "drizzle-orm";

/** Check under the Objective lock, in the same transaction as the closing update. */
export function* refuseCompletionWithPendingQuestions(
  tx: any,
  tables: any,
  objectiveId: string,
  ownerTagId: string,
): Generator<any, void, any> {
  const m = tables.objectiveMessages;
  const pending = yield tx
    .select({ id: m.id, createdAt: m.createdAt, body: m.body })
    .from(m)
    .where(
      and(
        eq(m.objectiveId, objectiveId),
        eq(m.senderTagId, ownerTagId),
        eq(m.needsReply, true),
        isNull(m.replyMessageId),
        isNull(m.resolvedAt),
      ),
    )
    .orderBy(asc(m.createdAt), asc(m.id));
  if (!pending.length) return;
  const lines = pending.map(
    (row: { id: string; createdAt: string; body: Record<string, unknown> }) => {
      const firstLine = String(row.body?.["message"] ?? "").split(/\r?\n/, 1)[0];
      return `- ${row.id} (asked ${row.createdAt}): ${firstLine}`;
    },
  );
  throw new TagMessagingError(
    409,
    `Objective cannot be completed while owner questions to the operator await answers:\n${lines.join("\n")}\nAnswer each with supertag message objective ${objectiveId} --reply-to MESSAGE_ID TEXT. Wait for those answers before retrying completion.`,
  );
}

/** Cancellation abandons unanswered questions without claiming an operator answered them. */
export function* resolveCancelledObjectiveQuestions(
  tx: any,
  tables: any,
  objectiveId: string,
  ownerTagId: string,
  at: string,
): Generator<any, void, any> {
  const m = tables.objectiveMessages;
  yield tx
    .update(m)
    .set({ resolvedAt: at, resolutionReason: "Objective cancelled", updatedAt: at })
    .where(
      and(
        eq(m.objectiveId, objectiveId),
        eq(m.senderTagId, ownerTagId),
        eq(m.needsReply, true),
        isNull(m.replyMessageId),
        isNull(m.resolvedAt),
      ),
    )
    .returning();
}

/** The recorded reason for approvals an Objective's closure expired. */
export function closedObjectiveResolutionReason(status: "completed" | "cancelled"): string {
  return status === "cancelled" ? "Objective cancelled" : "Objective completed";
}

/**
 * Expires pending approval requests when an Objective closes. The caller holds the Objective
 * lock and runs this in the transaction that records the closing status.
 */
export function* expireClosedObjectiveApprovals(
  tx: any,
  tables: any,
  objectiveId: string,
  status: "completed" | "cancelled",
  at: string,
): Generator<any, void, any> {
  const reason = closedObjectiveResolutionReason(status);
  const a = tables.approvalRequests;
  yield tx
    .update(a)
    .set({ status: "expired", decidedAt: at, reason, updatedAt: at })
    .where(and(eq(a.objectiveId, objectiveId), eq(a.status, "pending")))
    .returning();
}
