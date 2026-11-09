import { type JsonValue, toJson } from "@bufbuild/protobuf";
import {
  type Activity,
  ActivitySchema,
  type FollowEvent,
  MessageSchema,
  ReplySchema,
  type WorkSession,
  WorkSessionSchema,
} from "./gen/supertag/operator/v1/conversation_pb.js";

/**
 * The AI SDK UI message stream chunks this adapter writes, as the `ai` package's
 * `UIMessageChunk` documents them. Data values are the proto3 JSON of the event's message.
 */
export type UIMessageChunk =
  | { type: "start"; messageId?: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "data-joined"; id: "joined"; data: { taskId: string } }
  | { type: "data-waiting"; id: "waiting"; data: { reason: string } }
  | { type: "data-activity"; id: string; data: JsonValue }
  | { type: "data-reply"; id: "reply"; data: JsonValue }
  | { type: "data-work-session"; id: string; data: JsonValue }
  | { type: "error"; errorText: string }
  | { type: "finish"; messageMetadata: { message: JsonValue } };

export interface UIMessageChunkOptions {
  /** The `start` chunk's `messageId`, usually the message's Task ID. */
  messageId?: string;
}

/**
 * Turns `ConversationService.FollowMessage` events into AI SDK UI message chunks, one event at a
 * time, so a chat UI built on the AI SDK hooks can show a reply through a custom transport.
 *
 * - `text_delta` becomes text parts; an `activity` or the turn's end closes the open one.
 * - `activity` becomes a `data-activity` part per command, tool call, or retry. A command's or
 *   tool call's end replaces its start, since both share the part `id`.
 * - `joined`, `waiting`, `finish.reply`, and each work Session become `data-joined`,
 *   `data-waiting`, `data-reply`, and `data-work-session` parts with stable ids. A repeat, as a
 *   resumed stream sends, replaces the part instead of adding one.
 * - `finish` with no text written yet also writes the reply as a text part, so a finished turn
 *   shows it, once: a repeated `finish` replaces `data-reply` only. When text was streamed,
 *   `data-reply` is the reply and the text parts are its draft.
 * - `error` becomes an `error` chunk; `end` becomes `finish` with the final message as
 *   `messageMetadata.message`. Heartbeats and anything after `end` write nothing.
 *
 * Keep one adapter across a resumed call: pass `lastSequence` as `after_sequence`.
 */
export class FollowEventAdapter {
  readonly #messageId: string | undefined;
  #started = false;
  #ended = false;
  #textId: string | undefined;
  #textBlocks = 0;
  #wroteText = false;
  #lastSequence = 0n;

  constructor(options: UIMessageChunkOptions = {}) {
    this.#messageId = options.messageId;
  }

  /** The sequence of the last event applied, for `FollowMessageRequest.after_sequence`. */
  get lastSequence(): bigint {
    return this.#lastSequence;
  }

  /** Whether `end` arrived, so the stream is complete. */
  get ended(): boolean {
    return this.#ended;
  }

  /** The chunks for one event. */
  push(event: FollowEvent): UIMessageChunk[] {
    if (this.#ended || event.part.case === undefined || event.part.case === "heartbeat") return [];
    if (event.sequence !== 0n) {
      if (event.sequence <= this.#lastSequence) return [];
      this.#lastSequence = event.sequence;
    }
    const chunks = this.#start();
    const part = event.part;
    switch (part.case) {
      case "joined":
        chunks.push({ type: "data-joined", id: "joined", data: { taskId: part.value.taskId } });
        break;
      case "waiting":
        chunks.push({ type: "data-waiting", id: "waiting", data: { reason: part.value.reason } });
        break;
      case "textDelta":
        if (!part.value.text) break;
        if (this.#textId === undefined) {
          this.#textBlocks += 1;
          this.#textId = `text-${this.#textBlocks}`;
          chunks.push({ type: "text-start", id: this.#textId });
        }
        this.#wroteText = true;
        chunks.push({ type: "text-delta", id: this.#textId, delta: part.value.text });
        break;
      case "activity":
        this.#endText(chunks);
        chunks.push({
          type: "data-activity",
          id: activityId(part.value, event.sequence),
          data: toJson(ActivitySchema, part.value),
        });
        break;
      case "finish": {
        this.#endText(chunks);
        const reply = part.value.reply;
        if (reply) {
          if (!this.#wroteText && reply.text) this.#writeText(chunks, reply.text);
          chunks.push({ type: "data-reply", id: "reply", data: toJson(ReplySchema, reply) });
        }
        for (const session of part.value.message?.workSessions ?? [])
          chunks.push(workSessionChunk(session));
        break;
      }
      case "error":
        this.#endText(chunks);
        chunks.push({ type: "error", errorText: part.value.text });
        break;
      case "workSessionChanged":
        if (part.value.workSession) chunks.push(workSessionChunk(part.value.workSession));
        break;
      case "end":
        this.#endText(chunks);
        this.#ended = true;
        chunks.push({
          type: "finish",
          messageMetadata: {
            message: part.value.message ? toJson(MessageSchema, part.value.message) : null,
          },
        });
        break;
    }
    return chunks;
  }

  #start(): UIMessageChunk[] {
    if (this.#started) return [];
    this.#started = true;
    return [
      this.#messageId === undefined
        ? { type: "start" }
        : { type: "start", messageId: this.#messageId },
    ];
  }

  #writeText(chunks: UIMessageChunk[], text: string): void {
    this.#wroteText = true;
    this.#textBlocks += 1;
    const id = `text-${this.#textBlocks}`;
    chunks.push(
      { type: "text-start", id },
      { type: "text-delta", id, delta: text },
      { type: "text-end", id },
    );
  }

  #endText(chunks: UIMessageChunk[]): void {
    if (this.#textId === undefined) return;
    chunks.push({ type: "text-end", id: this.#textId });
    this.#textId = undefined;
  }
}

/**
 * A `ReadableStream` of UI message chunks from a `FollowMessage` call, the shape a custom AI SDK
 * `ChatTransport` returns. Cancelling the stream cancels the call.
 */
export function followEventsToUIMessageStream(
  events: AsyncIterable<FollowEvent>,
  options: UIMessageChunkOptions = {},
): ReadableStream<UIMessageChunk> {
  const adapter = new FollowEventAdapter(options);
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        const chunks = adapter.push(next.value);
        for (const chunk of chunks) controller.enqueue(chunk);
        if (adapter.ended) {
          controller.close();
          await iterator.return?.();
          return;
        }
        if (chunks.length > 0) return;
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function workSessionChunk(session: WorkSession): UIMessageChunk {
  return {
    type: "data-work-session",
    id: session.id,
    data: toJson(WorkSessionSchema, session),
  };
}

function activityId(activity: Activity, sequence: bigint): string {
  const scope = activity.workSessionId ? `${activity.workSessionId}:` : "";
  const detail = activity.detail;
  switch (detail.case) {
    case "command":
      return `${scope}command:${detail.value.id}`;
    case "tool":
      return `${scope}tool:${detail.value.id}`;
    case "retry":
      return `${scope}retry:${detail.value.attempt}`;
    default:
      return `${scope}activity:${sequence}`;
  }
}
