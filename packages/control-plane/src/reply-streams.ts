import type { TaskAttemptEvent } from "@supertag/worker-sdk";
import {
  createResumableStreamContext,
  type Publisher,
  type ResumableStreamContext,
  type Subscriber,
} from "resumable-stream/generic";

/**
 * Characters of frames one stream keeps, which every reader replays. Past it the stream drops text
 * and activity but still sends its text ends, retries, and finish; readers then read the record.
 */
const MAX_STREAM_CHARACTERS = 4 * 1024 * 1024;
/** Deltas arriving within this window, up to `MAX_DELTA_CHARACTERS`, share one text-delta part. */
const DELTA_WINDOW_MS = 25;
const MAX_DELTA_CHARACTERS = 4096;
/** How long a finished stream still answers "done" before readers fall back to the stored reply. */
const FINISHED_TTL_SECONDS = 60;
/** A stream that hears nothing this long ends without a finish; readers then read the record. */
const IDLE_STREAM_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

/** The final reply a finished Task recorded, as a stream's finish part carries it. */
export interface StreamedReply {
  readonly presentation: string;
  readonly text: string;
}

export type ReplyStreamEnd =
  | { readonly status: "completed" | "cancelled"; readonly reply?: StreamedReply }
  | { readonly status: "failed"; readonly reply?: StreamedReply };

interface OpenStream {
  readonly taskId: string;
  readonly controller: ReadableStreamDefaultController<string>;
  readonly ready: Promise<void>;
  attemptNumber: number;
  frames: number;
  characters: number;
  /** Set once the stream reached its size bound; later text and activity are dropped. */
  truncated: boolean;
  pendingText: string;
  pendingTimer: NodeJS.Timeout | undefined;
  textId: string | undefined;
  textBlocks: number;
  lastEventAt: number;
}

/**
 * Live replies of conversation Tasks, one resumable stream per Task. Each chunk is one Server-Sent
 * Event carrying an AI SDK UI message stream part, numbered with an `id` so a reader resumes after
 * the last part it saw. The producer drains inside the Control Plane, so a stream completes with
 * no reader; a finished stream is forgotten quickly and readers use the stored reply instead.
 */
export class ReplyStreams {
  readonly #context: ResumableStreamContext;
  readonly #streams = new Map<string, OpenStream>();
  readonly #sweep: NodeJS.Timeout;

  constructor() {
    const pubsub = new MemoryPubSub();
    this.#context = createResumableStreamContext({
      waitUntil: null,
      keyPrefix: "supertag-reply",
      publisher: pubsub,
      subscriber: pubsub,
    });
    this.#sweep = setInterval(() => this.#expireIdle(), SWEEP_INTERVAL_MS);
    this.#sweep.unref();
  }

  /** Opens the Task's stream, or notes a retry when a new Task Attempt continues it. */
  open(taskId: string, attemptNumber: number): void {
    const existing = this.#streams.get(taskId);
    if (existing) {
      if (attemptNumber === existing.attemptNumber) return;
      existing.attemptNumber = attemptNumber;
      this.#endText(existing);
      this.#write(
        existing,
        { type: "data-activity", data: { kind: "retry", attempt: attemptNumber } },
        true,
      );
      return;
    }
    let controller!: ReadableStreamDefaultController<string>;
    const source = new ReadableStream<string>({
      start(streamController) {
        controller = streamController;
      },
    });
    const ready = this.#context
      .createNewResumableStream(taskId, () => source)
      // Nobody reads the producer's own copy; readers resume through the context.
      .then((own) => own?.cancel())
      .catch(() => undefined);
    const stream: OpenStream = {
      taskId,
      controller,
      ready,
      attemptNumber,
      frames: 0,
      characters: 0,
      truncated: false,
      pendingText: "",
      pendingTimer: undefined,
      textId: undefined,
      textBlocks: 0,
      lastEventAt: Date.now(),
    };
    this.#streams.set(taskId, stream);
    this.#write(stream, { type: "start", messageId: taskId }, true);
  }

  /** Forwards one Worker event: text deltas, and command and tool activity. */
  event(taskId: string, event: TaskAttemptEvent): void {
    const stream = this.#streams.get(taskId);
    if (!stream) return;
    if (event.type === "output.delta") {
      if (!event.text || stream.truncated) return;
      stream.lastEventAt = Date.now();
      // A harness may send a token per delta; batching them keeps the kept frames mostly text.
      stream.pendingText += event.text;
      if (stream.pendingText.length >= MAX_DELTA_CHARACTERS) this.#flushText(stream);
      else if (stream.pendingTimer === undefined) {
        stream.pendingTimer = setTimeout(() => this.#flushText(stream), DELTA_WINDOW_MS);
        stream.pendingTimer.unref();
      }
      return;
    }
    const activity = activityPart(event);
    if (!activity) return;
    this.#endText(stream);
    this.#write(stream, activity);
  }

  /** Ends the Task's stream with its final reply, or with the error that ended the Task. */
  finish(taskId: string, end: ReplyStreamEnd): void {
    const stream = this.#streams.get(taskId);
    if (!stream) return;
    this.#endText(stream);
    if (end.status === "failed")
      this.#write(stream, { type: "error", errorText: end.reply?.text ?? "The Task failed" }, true);
    else
      this.#write(
        stream,
        {
          type: "finish",
          messageMetadata: { status: end.status, ...(end.reply ? { reply: end.reply } : {}) },
        },
        true,
      );
    this.#close(taskId, stream);
  }

  /**
   * A reader's copy of the Task's running stream after part `after` (0 for all of it, "now" for
   * only parts still to come), or undefined when the Task has no running stream.
   */
  async read(
    taskId: string,
    after: number | "now" = 0,
  ): Promise<ReadableStream<string> | undefined> {
    const stream = this.#streams.get(taskId);
    if (!stream) return undefined;
    // Text already received counts as sent before now.
    if (after === "now") this.#flushText(stream);
    const skip = after === "now" ? stream.frames : after;
    await stream.ready;
    const live = await this.#context.resumeExistingStream(taskId).catch(() => undefined);
    if (!live) return undefined;
    return skip > 0 ? live.pipeThrough(skipFrames(skip)) : live;
  }

  /** Ends every running stream without a finish, as the Control Plane stops. */
  close(): void {
    clearInterval(this.#sweep);
    for (const [taskId, stream] of this.#streams) this.#close(taskId, stream);
  }

  #expireIdle(): void {
    const cutoff = Date.now() - IDLE_STREAM_MS;
    for (const [taskId, stream] of this.#streams)
      if (stream.lastEventAt < cutoff) this.#close(taskId, stream);
  }

  #flushText(stream: OpenStream): void {
    clearTimeout(stream.pendingTimer);
    stream.pendingTimer = undefined;
    const delta = stream.pendingText;
    stream.pendingText = "";
    if (!delta || this.#streams.get(stream.taskId) !== stream) return;
    if (stream.textId === undefined) {
      const id = `text-${stream.textBlocks + 1}`;
      if (!this.#write(stream, { type: "text-start", id })) return;
      stream.textBlocks += 1;
      stream.textId = id;
    }
    this.#write(stream, { type: "text-delta", id: stream.textId, delta });
  }

  #endText(stream: OpenStream): void {
    this.#flushText(stream);
    if (stream.textId === undefined) return;
    this.#write(stream, { type: "text-end", id: stream.textId }, true);
    stream.textId = undefined;
  }

  /**
   * Enqueues one part unless it would pass the stream's size bound. Essential parts (start, text
   * ends, retries, and the finish) are always sent; each is small and bounded in number.
   */
  #write(stream: OpenStream, part: Record<string, unknown>, essential = false): boolean {
    if (!essential && stream.truncated) return false;
    const frame = `id: ${stream.frames + 1}\ndata: ${JSON.stringify(part)}\n\n`;
    if (!essential && stream.characters + frame.length > MAX_STREAM_CHARACTERS) {
      stream.truncated = true;
      return false;
    }
    stream.frames += 1;
    stream.characters += frame.length;
    stream.lastEventAt = Date.now();
    stream.controller.enqueue(frame);
    return true;
  }

  #close(taskId: string, stream: OpenStream): void {
    clearTimeout(stream.pendingTimer);
    stream.pendingTimer = undefined;
    this.#streams.delete(taskId);
    stream.controller.enqueue("data: [DONE]\n\n");
    stream.controller.close();
  }
}

/** Command and tool activity from execution events, as `data-activity` parts. */
function activityPart(event: TaskAttemptEvent): Record<string, unknown> | undefined {
  if (event.type === "command.updated")
    return {
      type: "data-activity",
      id: `command:${event.command.id}`,
      data: { kind: "command", command: event.command.command, status: event.command.status },
    };
  if (
    event.type === "tool.call.started" ||
    event.type === "tool.call.completed" ||
    event.type === "tool.call.failed"
  )
    return {
      type: "data-activity",
      id: `tool:${event.call.id}`,
      data: {
        kind: "tool",
        tool: `${event.call.provider}.${event.call.operation}`,
        status:
          event.type === "tool.call.started"
            ? "running"
            : event.type === "tool.call.completed"
              ? "completed"
              : "failed",
      },
    };
  return undefined;
}

/** Drops the frames a resuming reader already has. Producer chunks hold whole frames. */
function skipFrames(after: number): TransformStream<string, string> {
  return new TransformStream({
    transform(chunk, controller) {
      const kept = chunk
        .split(/(?<=\n\n)/u)
        .filter(
          (frame) => Number(/^id: (\d+)\n/u.exec(frame)?.[1] ?? Number.POSITIVE_INFINITY) > after,
        )
        .join("");
      if (kept) controller.enqueue(kept);
    },
  });
}

/**
 * The single-process publisher and subscriber the resumable stream context needs. Keys expire
 * like Redis keys, except that a finished stream's marker lives only briefly.
 */
class MemoryPubSub implements Publisher, Subscriber {
  readonly #values = new Map<string, { value: string; timer?: NodeJS.Timeout }>();
  readonly #channels = new Map<string, (message: string) => void>();

  async connect(): Promise<void> {}

  async publish(channel: string, message: string): Promise<number> {
    const listener = this.#channels.get(channel);
    if (!listener) return 0;
    // The context's listeners are async; a failed one must not reject the publisher.
    Promise.resolve()
      .then(() => listener(message))
      .catch(() => undefined);
    return 1;
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    this.#channels.set(channel, callback);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.#channels.delete(channel);
  }

  async set(key: string, value: string, options?: { EX?: number }): Promise<"OK"> {
    clearTimeout(this.#values.get(key)?.timer);
    const seconds = value === "DONE" ? FINISHED_TTL_SECONDS : options?.EX;
    const timer =
      seconds === undefined
        ? undefined
        : setTimeout(() => this.#values.delete(key), seconds * 1000);
    timer?.unref();
    this.#values.set(key, { value, ...(timer === undefined ? {} : { timer }) });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.#values.get(key)?.value ?? null;
  }

  async incr(key: string): Promise<number> {
    const current = this.#values.get(key);
    const next = Number(current?.value ?? 0) + 1;
    if (!Number.isSafeInteger(next)) throw new Error("ERR value is not an integer or out of range");
    this.#values.set(key, { ...current, value: String(next) });
    return next;
  }
}
