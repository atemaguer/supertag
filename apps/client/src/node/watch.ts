/**
 * The Gateway Watch: tells the window which views to read again as Tags, conversations,
 * Schedules and notes change. It resumes from its last token after the stream drops, and starts
 * over when the Gateway no longer knows the token.
 */

import {
  type WatchChange,
  type WatchEvent,
  WatchKind,
  WatchReason,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import type { WatchUpdate } from "../model/gateway";
import { Code, ConnectError, type GatewayClient } from "./sdk";
import {
  Closed,
  FIRST_RETRY_MS,
  fatal,
  IDLE_MS,
  MAX_RETRY_MS,
  pause,
  readStream,
  type Updates,
} from "./streams";

/** What every conversation Session ID starts with. */
const CONVERSATION_SESSION = "conversation/";
const KINDS = [
  WatchKind.TAG,
  WatchKind.CONVERSATION_MESSAGE,
  WatchKind.TASK,
  WatchKind.SCHEDULE,
  WatchKind.MEMORY,
];

/** The view a change invalidates, if any. */
export function invalidation(change: WatchChange): WatchUpdate | undefined {
  switch (change.kind) {
    case WatchKind.TAG:
      return { kind: "tag" };
    case WatchKind.SCHEDULE:
      return change.tagId === "" ? undefined : { kind: "schedule", tagId: change.tagId };
    case WatchKind.MEMORY:
      return change.tagId === "" ? undefined : { kind: "memory", tagId: change.tagId };
    case WatchKind.CONVERSATION_MESSAGE:
      break;
    case WatchKind.TASK:
      // Message creation has its own notice. Later changes to a conversation's Tasks carry
      // the result and status invalidation for it.
      if (
        change.reason === WatchReason.CREATED ||
        !change.sessionId.startsWith(CONVERSATION_SESSION)
      ) {
        return undefined;
      }
      break;
    default:
      return undefined;
  }
  return change.tagId === "" ? undefined : { kind: "conversation", tagId: change.tagId };
}

export interface WatchTiming {
  firstRetryMs: number;
  idleMs: number;
}

/** Runs the Watch until `stop` aborts, the window stops receiving, or the Gateway refuses it. */
export async function runWatch(
  client: GatewayClient,
  stop: AbortSignal,
  updates: Updates<WatchUpdate>,
  timing: WatchTiming = { firstRetryMs: FIRST_RETRY_MS, idleMs: IDLE_MS },
): Promise<void> {
  const send = (update: WatchUpdate) => {
    if (!updates.send(update)) throw new Closed();
  };
  let token = "";
  let retry = timing.firstRetryMs;
  let lost = false;
  try {
    for (;;) {
      let live = false;
      const ended = await readStream(
        (signal) => client.events.watch({ resumeToken: token, kinds: KINDS }, { signal }),
        (frame: WatchEvent) => {
          const update = frame.update;
          let notice: WatchUpdate | undefined;
          switch (update.case) {
            case "heartbeat":
              break;
            case "resync":
              notice = { kind: "resync" };
              break;
            case "change":
              notice = invalidation(update.value);
              break;
            default:
              throw new ConnectError("Gateway Watch returned an incomplete frame", Code.DataLoss);
          }
          if (!live && notice?.kind !== "resync") send({ kind: "ready" });
          if (notice !== undefined) send(notice);
          live = true;
          if (frame.resumeToken !== "") token = frame.resumeToken;
        },
        stop,
        timing.idleMs,
      );
      if (ended.stopped) return;
      if (live) {
        retry = timing.firstRetryMs;
        lost = false;
      }
      if (!lost) {
        send({ kind: "lost" });
        lost = true;
      }
      if (ended.code === Code.InvalidArgument && token !== "") {
        // The Gateway no longer knows the token: start over at once.
        token = "";
        continue;
      }
      if (fatal(ended.code)) return;
      if (await pause(retry, stop)) return;
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    }
  } catch (error) {
    if (error instanceof Closed) return;
    throw error;
  }
}
