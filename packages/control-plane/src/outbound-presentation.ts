import { createHash } from "node:crypto";
import type { OutboundReply } from "@supertag/core";

/** Stable delivery identities for Objective reports. */
export function objectiveReportKey(objectiveId: string, idempotencyKey: string): string {
  return `objective-report:${digest(`${objectiveId}:${idempotencyKey}`)}`;
}

export function taskApprovalKey(taskId: string): string {
  return `task-approval:${digest(taskId)}`;
}

/**
 * Interprets existing queued keys in one place. Ordinary progress replaces the
 * acknowledgement; Objective reports and approval requests are standalone.
 */
export function outboundPresentationPolicy(
  reply: Pick<OutboundReply, "deliveryKey" | "presentation">,
): { readonly useAcknowledgement: boolean; readonly waitForAcknowledgement: boolean } {
  const standalone =
    reply.deliveryKey === "acknowledgement" ||
    reply.deliveryKey === "session-input-unresolved" ||
    reply.deliveryKey.startsWith("objective-report:") ||
    reply.deliveryKey.startsWith("operator-message:") ||
    reply.deliveryKey.startsWith("task-approval:") ||
    reply.deliveryKey.startsWith("task-budget:") ||
    reply.deliveryKey.startsWith("objective-budget:") ||
    reply.deliveryKey.startsWith("objective-limit:");
  return {
    useAcknowledgement: !standalone,
    waitForAcknowledgement: reply.presentation === "status" && !standalone,
  };
}

/**
 * Replies SuperTag records but sends nowhere: a work Session's own replies, whose result returns
 * to its conversation as a report turn, and the empty final reply of an update turn that stayed
 * silent with skip_reply.
 */
export function sentNowhere(reply: Pick<OutboundReply, "event" | "deliveryKey" | "text">): boolean {
  const kind = reply.event.internal?.kind;
  return (
    kind === "work_session" ||
    (kind === "session_update" && reply.deliveryKey === "final" && reply.text.trim() === "")
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
