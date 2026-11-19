/**
 * Pushes an open conversation's changes to the window from `Conversations.FollowConversation`,
 * reopening the stream where it left off after it drops.
 */

import {
  type FollowConversationResponse,
  type ListMessagesResponse,
  TaskState,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import type {
  FollowUpdate,
  MessagePage,
  ReadMessages,
  TurnText,
  TurnWait,
} from "../../src/gateway";
import { messages as convertMessages } from "./convert";
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

const FINISHED = new Set([TaskState.SUCCEEDED, TaskState.FAILED, TaskState.CANCELLED]);

/** Where a reopened stream resumes: the conversation, its latest order, its unfinished turns. */
export class Cursor {
  readonly tagId: string;
  conversationId: string;
  after: number;
  readonly unfinished: Set<string>;

  constructor(read: ReadMessages) {
    this.tagId = read.tagId;
    this.conversationId = read.conversationId ?? "";
    this.after = read.after ?? 0;
    this.unfinished = new Set(read.refreshTaskIds ?? []);
  }

  request() {
    return {
      tagId: this.tagId,
      conversationId: this.conversationId,
      after: BigInt(this.conversationId === "" ? 0 : this.after),
      refreshTaskIds: [...this.unfinished].sort().slice(0, 128),
    };
  }

  advance(page: ListMessagesResponse) {
    if (!page.incremental) {
      this.conversationId = page.conversationId;
      this.after = 0;
      this.unfinished.clear();
    }
    for (const message of page.messages) {
      const task = message.task;
      if (task === undefined) continue;
      this.after = Math.max(this.after, Number(message.order));
      if (FINISHED.has(task.state)) this.unfinished.delete(task.taskId);
      else this.unfinished.add(task.taskId);
    }
  }
}

function changed(cursor: Cursor, response: FollowConversationResponse): FollowUpdate | undefined {
  let messages: MessagePage | undefined;
  const page = response.messages;
  if (page !== undefined) {
    cursor.advance(page);
    if (page.messages.some((message) => message.task?.tagId !== cursor.tagId)) {
      throw new ConnectError("Gateway returned a message of another conversation", Code.DataLoss);
    }
    try {
      messages = convertMessages(page);
    } catch {
      throw new ConnectError("Gateway returned an incomplete message", Code.DataLoss);
    }
  }
  const waits: TurnWait[] = response.waits.map((wait) => ({
    taskId: wait.taskId,
    reason: wait.reason,
  }));
  const texts: TurnText[] = response.texts.map((text) => ({
    taskId: text.taskId,
    text: text.text,
  }));
  if (messages === undefined && waits.length === 0 && texts.length === 0) return undefined;
  return {
    kind: "changed",
    ...(messages === undefined ? {} : { messages }),
    ...(waits.length === 0 ? {} : { waits }),
    ...(texts.length === 0 ? {} : { texts }),
  };
}

/** Follows one conversation until `stop` aborts, the window stops receiving, or it is refused. */
export async function runFollow(
  client: GatewayClient,
  cursor: Cursor,
  stop: AbortSignal,
  updates: Updates<FollowUpdate>,
  timing = { firstRetryMs: FIRST_RETRY_MS, idleMs: IDLE_MS },
): Promise<void> {
  const send = (update: FollowUpdate) => {
    if (!updates.send(update)) throw new Closed();
  };
  let retry = timing.firstRetryMs;
  let lost = false;
  try {
    for (;;) {
      let live = false;
      const ended = await readStream(
        (signal) => client.conversations.followConversation(cursor.request(), { signal }),
        (response: FollowConversationResponse) => {
          if (!live) {
            live = true;
            send({ kind: "ready" });
          }
          const update = changed(cursor, response);
          if (update !== undefined) send(update);
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
      if (fatal(ended.code)) return;
      if (await pause(retry, stop)) return;
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    }
  } catch (error) {
    if (error instanceof Closed) return;
    throw error;
  }
}
