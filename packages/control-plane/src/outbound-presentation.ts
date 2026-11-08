import { createHash } from "node:crypto";
import type { OutboundReply } from "@supertag/core";

/** Stable delivery identities for SuperTag's notices in an Objective's home thread. */
export function objectiveReportKey(objectiveId: string, idempotencyKey: string): string {
  return `objective-report:${digest(`${objectiveId}:${idempotencyKey}`)}`;
}

/**
 * Interprets existing queued keys in one place. Ordinary progress replaces the
 * acknowledgement; Objective reports and notices are standalone.
 */
export function outboundPresentationPolicy(
  reply: Pick<OutboundReply, "deliveryKey" | "presentation">,
): { readonly useAcknowledgement: boolean; readonly waitForAcknowledgement: boolean } {
  const standalone =
    reply.deliveryKey === "acknowledgement" ||
    reply.deliveryKey === "session-input-unresolved" ||
    reply.deliveryKey.startsWith("objective-report:") ||
    reply.deliveryKey.startsWith("objective-budget:") ||
    reply.deliveryKey.startsWith("objective-limit:");
  return {
    useAcknowledgement: !standalone,
    waitForAcknowledgement: reply.presentation === "status" && !standalone,
  };
}

/**
 * Replies SuperTag records but sends nowhere: a work Session's own replies, whose result returns
 * to its conversation as a report turn.
 */
export function sentNowhere(reply: Pick<OutboundReply, "event">): boolean {
  return reply.event.internal?.kind === "work_session";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
