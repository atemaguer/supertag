import type { Store } from "@supertag/core";
import type { TaskAttemptEvent } from "@supertag/worker-sdk";

/** The command ID prefix of every operator surface message sent live; the rest is its inbound event ID. */
export const SESSION_INPUT_COMMAND_PREFIX = "session-input:";

/**
 * Undoes the live delivery of an operator's surface message a Task Attempt reports withdrawn: its
 * harness confirms its model never read the input before the Task Attempt's final
 * response. The message's follower Task returns to `pending` and runs on its own after the
 * Session's current work, and the target Task records a `task.session-input` event with status
 * `withdrawn`. Other events, input this Control Plane did not send, and deliveries to another
 * Task Attempt change nothing; repeating it changes nothing.
 */
export async function withdrawSessionInput(
  store: Pick<Store, "appendTaskEvent" | "withdrawInboundControlDelivery">,
  event: TaskAttemptEvent,
): Promise<boolean> {
  if (event.type !== "input.withdrawn") return false;
  if (!event.commandId.startsWith(SESSION_INPUT_COMMAND_PREFIX)) return false;
  const inboundEventId = event.commandId.slice(SESSION_INPUT_COMMAND_PREFIX.length);
  // Persisted events can predate Worker validation; malformed IDs must not stall replay.
  if (!inboundEventId || inboundEventId.length > 200 || /[\s\p{Cc}]/u.test(inboundEventId))
    return false;
  const withdrawn = await store.withdrawInboundControlDelivery({
    inboundEventId,
    taskId: event.taskId,
    attemptId: event.attemptId,
  });
  if (!withdrawn) return false;
  await store.appendTaskEvent({
    taskId: withdrawn.delivery.taskId,
    attemptId: withdrawn.delivery.attemptId,
    type: "task.session-input",
    payload: {
      version: 1,
      status: "withdrawn",
      inboundEventId,
      ...(withdrawn.followerTaskId ? { taskId: withdrawn.followerTaskId } : {}),
    },
  });
  return true;
}
