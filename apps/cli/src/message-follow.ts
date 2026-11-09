import { create, equals, type MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import type { ChangeFeed, PositionedChangeNotice, ReplyStreamPart } from "@supertag/control-plane";
import type { Tag, Task } from "@supertag/core";
import {
  type ActivitySchema,
  ActivityStatus,
  ErrorReason,
  type FollowEvent,
  FollowEventSchema,
  type Message,
  ReplyPresentation,
  ReplyStatus,
  WorkSessionSchema,
} from "@supertag/operator-api";
import { messageOf, workSessionSettled } from "./conversation-messages.js";
import { operatorError, STREAM_HEARTBEAT_MS } from "./operator-rpc-context.js";
import type { OperatorReadStore } from "./operator-seams.js";

/** How long a feed nobody reads keeps recording, so a dropped follower resumes exactly. */
const RESUME_WINDOW_MS = 2 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;
/** Characters of text and activity one feed keeps; past it, it drops them and keeps the rest. */
const FEED_CHARACTERS = 1024 * 1024;
/** How often a feed rereads its message when no change notice woke it. */
const REREAD_MS = 2_000;
/**
 * A sequence is a feed's epoch times this, plus the event's number in the feed. Epochs grow
 * across feeds and restarts, so a new feed's events follow every event of an earlier one.
 */
const EPOCH_SIZE = 2n ** 31n;
const MAX_EPOCH = 2n ** 32n - 1n;

type Part = NonNullable<MessageInitShape<typeof FollowEventSchema>["part"]>;
type ActivityInit = MessageInitShape<typeof ActivitySchema>;

/** The live reply of a running turn, which only the process running it holds. */
export interface LiveReplies {
  /** The reply's parts from `after`, or undefined when no live reply of the Task is open. */
  streamTaskReply(
    taskId: string,
    after: number | "now",
  ): Promise<ReadableStream<ReplyStreamPart> | undefined>;
}

export interface MessageFollowSources {
  readonly store: OperatorReadStore;
  readonly replies: LiveReplies;
  readonly changes: Pick<ChangeFeed, "subscribe">;
}

/** What `FollowMessage` streams a message's events from. */
export interface MessageFollower {
  /** The events after `after`, then each new one, until `end` or until `signal` aborts. */
  follow(message: FollowedMessage, after: bigint, signal: AbortSignal): AsyncIterable<FollowEvent>;
}

/** The message a follower follows: its Tag, its Task, and its conversation's name. */
export interface FollowedMessage {
  readonly operatorId: string;
  readonly tag: Pick<Tag, "name">;
  readonly task: Task;
  readonly conversation: string;
}

/**
 * The events of one follower's `FollowMessage` stream, recorded as they happen. The feed keeps
 * recording after its reader drops, for `RESUME_WINDOW_MS`, so a resume continues exactly.
 */
class Feed {
  readonly events: FollowEvent[] = [];
  readonly stop = new AbortController();
  readers = 0;
  idleSince = Date.now();
  ended = false;
  failure: unknown;
  #characters = 0;
  readonly #epoch: bigint;
  readonly #waiters = new Set<() => void>();

  constructor(epoch: bigint) {
    this.#epoch = epoch;
  }

  /** Records one event. A bounded one, text or activity, is dropped once the feed is full. */
  push(part: Part, bounded = false): void {
    if (this.ended) return;
    if (bounded) {
      const size = JSON.stringify(part.value ?? {}).length;
      if (this.#characters + size > FEED_CHARACTERS) return;
      this.#characters += size;
    }
    this.events.push(
      create(FollowEventSchema, {
        sequence: this.#epoch * EPOCH_SIZE + BigInt(this.events.length + 1),
        part,
      }),
    );
    if (part.case === "end") this.ended = true;
    this.#notify();
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    this.#notify();
  }

  /** Waits for the next event, up to `ms`; false when the time ran out first. */
  next(count: number, signal: AbortSignal, ms: number): Promise<boolean> {
    if (this.events.length > count || this.ended || signal.aborted) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
        signal.removeEventListener("abort", wake);
        resolve(value);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      this.#waiters.add(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
  }

  #notify(): void {
    for (const wake of [...this.#waiters]) wake();
  }
}

/** Wakes a feed when a change notice concerns what it follows. It resolves one waiter at a time. */
class Wake {
  readonly #unsubscribe: () => void;
  #pending = false;
  #resolve: (() => void) | undefined;

  constructor(
    changes: MessageFollowSources["changes"],
    concerns: (notice: PositionedChangeNotice) => boolean,
  ) {
    this.#unsubscribe = changes.subscribe((notice) => {
      if (!concerns(notice)) return;
      this.#pending = true;
      this.#resolve?.();
    });
  }

  /** Resolves on a notice since the last wait, after `ms`, or when `signal` aborts. */
  wait(signal: AbortSignal, ms: number): Promise<void> {
    if (this.#pending || signal.aborted) {
      this.#pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.#resolve = undefined;
        this.#pending = false;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      this.#resolve = done;
    });
  }

  close(): void {
    this.#unsubscribe();
    this.#resolve?.();
  }
}

/**
 * `FollowMessage` for every follower in this process. Each call gets its own feed, which reads
 * the message's live reply from the Control Plane's reply streams and its work Sessions from the
 * store, waking on change notices. A resume whose feed is still held continues it; any other
 * resume starts a new feed from the current state. Feeds and live replies are in this process's
 * memory, so a resume reaches its feed only on the process that started it.
 */
export class MessageFollows implements MessageFollower {
  readonly #sources: MessageFollowSources;
  readonly #feeds = new Map<string, Feed>();
  readonly #sweep: NodeJS.Timeout;
  #lastEpoch = 0n;

  constructor(sources: MessageFollowSources) {
    this.#sources = sources;
    this.#sweep = setInterval(() => this.#expire(), SWEEP_INTERVAL_MS);
    this.#sweep.unref();
  }

  /** The events after `after`, then each new one, until `end` or until `signal` aborts. */
  async *follow(
    message: FollowedMessage,
    after: bigint,
    signal: AbortSignal,
  ): AsyncGenerator<FollowEvent> {
    if (after < 0n || after / EPOCH_SIZE >= MAX_EPOCH)
      throw operatorError(
        Code.InvalidArgument,
        ErrorReason.INVALID_ARGUMENT,
        "after_sequence is not a sequence this stream sent",
        [{ path: "after_sequence", description: "0, or the sequence of an event received" }],
      );
    const epoch = after / EPOCH_SIZE;
    let feed = after === 0n ? undefined : this.#feeds.get(feedKey(message, epoch));
    if (feed !== undefined && Number(after % EPOCH_SIZE) > feed.events.length) feed = undefined;
    feed ??= this.#open(message, after === 0n ? "start" : "resume", epoch);
    feed.readers += 1;
    try {
      let next = feed.events.findIndex((event) => event.sequence > after);
      if (next === -1) next = feed.events.length;
      while (!signal.aborted) {
        while (next < feed.events.length) {
          const event = feed.events[next] as FollowEvent;
          next += 1;
          yield event;
          if (event.part.case === "end") return;
        }
        if (feed.failure !== undefined) throw feed.failure;
        if (feed.ended) return;
        if (!(await feed.next(next, signal, STREAM_HEARTBEAT_MS)) && !signal.aborted)
          yield create(FollowEventSchema, { part: { case: "heartbeat", value: {} } });
      }
    } finally {
      feed.readers -= 1;
      feed.idleSince = Date.now();
    }
  }

  /** Stops every feed, as the API Server stops. */
  close(): void {
    clearInterval(this.#sweep);
    for (const feed of this.#feeds.values()) feed.stop.abort();
    this.#feeds.clear();
  }

  #open(message: FollowedMessage, mode: "start" | "resume", after: bigint): Feed {
    const now = BigInt(Math.floor(Date.now() / 1000));
    let epoch = this.#lastEpoch + 1n;
    if (now > epoch) epoch = now;
    if (after + 1n > epoch) epoch = after + 1n;
    this.#lastEpoch = epoch;
    const feed = new Feed(epoch);
    this.#feeds.set(feedKey(message, epoch), feed);
    void this.#run(feed, message, mode).catch((error: unknown) => {
      if (!feed.stop.signal.aborted) feed.fail(error);
    });
    return feed;
  }

  #expire(): void {
    const cutoff = Date.now() - RESUME_WINDOW_MS;
    for (const [key, feed] of this.#feeds)
      if (feed.readers === 0 && feed.idleSince < cutoff) {
        feed.stop.abort();
        this.#feeds.delete(key);
      }
  }

  /**
   * Records the message's events: the turn until its reply or error, then its work Sessions
   * until each is settled, then `end`. In `resume` mode it skips the text and activity a
   * follower may already have and sends the current state instead.
   */
  async #run(feed: Feed, followed: FollowedMessage, mode: "start" | "resume"): Promise<void> {
    const { store, replies, changes } = this.#sources;
    const signal = feed.stop.signal;
    const followedTasks = new Set([followed.task.id]);
    const wake = new Wake(
      changes,
      (notice) =>
        (notice.kind === "conversation_message" && notice.id === followed.task.id) ||
        (notice.kind === "task" && followedTasks.has(notice.id)),
    );
    const read = async (): Promise<Message> =>
      messageOf(
        store,
        followed.tag,
        (await store.findTaskById(followed.task.id)) ?? followed.task,
        followed.conversation,
      );
    try {
      let message = await read();
      let joined = "";
      let waiting = "";
      let from: number | "now" = mode === "resume" ? "now" : 0;
      let endedWithoutReply = 0;
      while (message.status !== ReplyStatus.REPLIED) {
        if (signal.aborted) return;
        if (message.joinedTaskId !== joined) {
          if (joined !== "") followedTasks.delete(joined);
          joined = message.joinedTaskId;
          if (joined !== "") followedTasks.add(joined);
          feed.push({ case: "joined", value: { taskId: joined } });
          // A joined turn's earlier text answered earlier messages. A withdrawn delivery runs as
          // the message's own turn, from its first part.
          from = joined === "" ? 0 : "now";
          endedWithoutReply = 0;
        }
        if (message.waitingReason !== "" && message.waitingReason !== waiting) {
          waiting = message.waitingReason;
          feed.push({ case: "waiting", value: { reason: waiting } });
        }
        const turnId = joined === "" ? followed.task.id : joined;
        const live = await replies.streamTaskReply(turnId, from);
        if (live !== undefined) {
          await readStream(live, signal, (part) => {
            if (part.type === "text-delta" && typeof part["delta"] === "string" && part["delta"])
              feed.push({ case: "textDelta", value: { text: part["delta"] } }, true);
            const activity = activityOf(part, "");
            if (activity !== undefined)
              feed.push({ case: "activity", value: activity }, activity.detail?.case !== "retry");
          });
          // A later stream of the turn is a new one, from its first part.
          from = 0;
        } else {
          const turn = await store.findTaskById(turnId);
          endedWithoutReply =
            turn !== undefined && turn.status !== "pending" && turn.status !== "running"
              ? endedWithoutReply + 1
              : 0;
          // The reply commits with the Task's end; one still missing on a second look never comes.
          if (endedWithoutReply > 1) {
            feed.push({ case: "error", value: { text: endedText(turn?.status) } });
            feed.push({ case: "end", value: { message } });
            return;
          }
          await wake.wait(signal, endedWithoutReply > 0 ? 250 : REREAD_MS);
        }
        message = await read();
      }
      const reply = message.reply;
      if (reply?.presentation === ReplyPresentation.ERROR) {
        feed.push({ case: "error", value: { text: reply.text } });
        feed.push({ case: "end", value: { message } });
        return;
      }
      feed.push({ case: "finish", value: { ...(reply === undefined ? {} : { reply }), message } });
      if (mode === "resume")
        for (const session of message.workSessions)
          feed.push({ case: "workSessionChanged", value: { workSession: session } });
      await this.#followWork(feed, message, mode, followedTasks, wake, read);
    } finally {
      wake.close();
    }
  }

  /** Records the work Sessions' activity and each change to them until every one is settled. */
  async #followWork(
    feed: Feed,
    started: Message,
    mode: "start" | "resume",
    followedTasks: Set<string>,
    wake: Wake,
    read: () => Promise<Message>,
  ): Promise<void> {
    const signal = feed.stop.signal;
    const held = new Map(started.workSessions.map((session) => [session.id, session] as const));
    const following = new Map<
      string,
      { readonly taskId: string; readonly stop: AbortController }
    >();
    const activity: Promise<void>[] = [];
    let message = started;
    try {
      for (let first = true; !signal.aborted; first = false) {
        for (const session of message.workSessions) {
          const before = held.get(session.id);
          if (before === undefined ? !first : !equals(WorkSessionSchema, before, session))
            feed.push({ case: "workSessionChanged", value: { workSession: session } });
          held.set(session.id, session);
          const current = following.get(session.id);
          if (session.taskId === "" || current?.taskId === session.taskId) continue;
          // A decision on an approval request continues the work Session as a new Task.
          current?.stop.abort();
          followedTasks.add(session.taskId);
          const stop = new AbortController();
          following.set(session.id, { taskId: session.taskId, stop });
          activity.push(
            this.#followActivity(
              feed,
              session.id,
              session.taskId,
              mode === "resume" && first ? "now" : 0,
              AbortSignal.any([signal, stop.signal]),
            ).catch(() => undefined),
          );
        }
        if (message.workSessions.every(workSessionSettled)) break;
        await wake.wait(signal, REREAD_MS);
        message = await read();
      }
    } finally {
      for (const { stop } of following.values()) stop.abort();
      await Promise.all(activity);
    }
    if (!signal.aborted) feed.push({ case: "end", value: { message } });
  }

  /** Records one work Session Task's commands, tool calls and retries, never its text. */
  async #followActivity(
    feed: Feed,
    workSessionId: string,
    taskId: string,
    from: number | "now",
    signal: AbortSignal,
  ): Promise<void> {
    const { store, replies, changes } = this.#sources;
    // The Task's start opens its live reply.
    const wake = new Wake(changes, (notice) => notice.kind === "task" && notice.id === taskId);
    try {
      while (!signal.aborted) {
        const live = await replies.streamTaskReply(taskId, from);
        if (live !== undefined) {
          await readStream(live, signal, (part) => {
            const activity = activityOf(part, workSessionId);
            if (activity !== undefined)
              feed.push({ case: "activity", value: activity }, activity.detail?.case !== "retry");
          });
          return;
        }
        const task = await store.findTaskById(taskId);
        if (task === undefined || (task.status !== "pending" && task.status !== "running")) return;
        await wake.wait(signal, REREAD_MS);
      }
    } finally {
      wake.close();
    }
  }
}

function feedKey(message: FollowedMessage, epoch: bigint): string {
  return `${message.operatorId}\n${message.task.id}\n${epoch}`;
}

/** Reads a live reply until it finishes or ends, or until `signal` aborts. */
async function readStream(
  live: ReadableStream<ReplyStreamPart>,
  signal: AbortSignal,
  onPart: (part: ReplyStreamPart["part"]) => void,
): Promise<void> {
  const reader = live.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      onPart(value.part);
      if (value.part.type === "finish" || value.part.type === "error") return;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

const ACTIVITY_STATUSES: Readonly<Record<string, ActivityStatus>> = {
  running: ActivityStatus.RUNNING,
  completed: ActivityStatus.COMPLETED,
  failed: ActivityStatus.FAILED,
};

/** A reply stream's command, tool or retry part as an `Activity`. */
function activityOf(
  part: ReplyStreamPart["part"],
  workSessionId: string,
): ActivityInit | undefined {
  if (part.type !== "data-activity") return undefined;
  const data = part["data"];
  if (typeof data !== "object" || data === null) return undefined;
  const fields = data as Record<string, unknown>;
  const id = typeof part["id"] === "string" ? part["id"].replace(/^(command|tool):/u, "") : "";
  const status = typeof fields["status"] === "string" ? fields["status"] : "";
  if (fields["kind"] === "retry" && typeof fields["attempt"] === "number")
    return {
      workSessionId,
      text: `retrying (Task Attempt ${fields["attempt"]})`,
      detail: { case: "retry", value: { attempt: fields["attempt"] } },
    };
  if (fields["kind"] === "command" && typeof fields["command"] === "string")
    return {
      workSessionId,
      text: status === "running" ? `running: ${fields["command"]}` : "",
      detail: {
        case: "command",
        value: {
          id,
          command: fields["command"],
          status: ACTIVITY_STATUSES[status] ?? ActivityStatus.UNSPECIFIED,
        },
      },
    };
  if (fields["kind"] === "tool" && typeof fields["tool"] === "string")
    return {
      workSessionId,
      text: status === "running" ? `using: ${fields["tool"]}` : "",
      detail: {
        case: "tool",
        value: {
          id,
          tool: fields["tool"],
          status: ACTIVITY_STATUSES[status] ?? ActivityStatus.UNSPECIFIED,
        },
      },
    };
  return undefined;
}

function endedText(status: string | undefined): string {
  if (status === "cancelled") return "The Task was cancelled";
  if (status === "failed") return "The Task failed";
  return "The Task ended without a reply";
}
