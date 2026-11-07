import { parseArgs } from "node:util";
import { EventSourceParserStream } from "eventsource-parser/stream";
import {
  ControlPlaneClient,
  ControlPlaneRequestError,
  type ControlPlaneTarget,
} from "./control-plane-client.js";
import { takeOutputFlag } from "./output-flag.js";
import { terminalLines, terminalText } from "./terminal-text.js";

/** One message in a CLI conversation, as `POST /api/v1/tags/NAME/messages` returns it. */
export interface TagMessageRecord {
  readonly kind: "TagMessage";
  readonly tag: string;
  readonly session: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly joinedTaskId?: string;
  readonly status: "waiting" | "replied";
  readonly reply?: TagReply;
  /**
   * Work Sessions this message's turn started or continued, each with its report once the Tag
   * wrote it.
   */
  readonly startedSessions?: readonly StartedWorkSession[];
}

export interface StartedWorkSession {
  readonly id: string;
  readonly title: string;
  readonly taskId?: string;
  /** The work Task's status, or `waiting` when it completed by asking the person `question`. */
  readonly status: string;
  readonly question?: string;
  /** Approval notices for the work Task's pending approval requests. */
  readonly approvals?: readonly { readonly requestId: string; readonly text: string }[];
  readonly reportStatus: "waiting" | "replied";
  readonly reportTaskId?: string;
  readonly report?: TagReply;
}

interface TagReply {
  readonly presentation: string;
  readonly text: string;
}

/**
 * How long `message tag` waits for the reply when it polls, and how long a streamed reply may go
 * without a new part. Fixed, not configurable.
 */
const REPLY_TIMEOUT_MS = 10 * 60_000;
/** How long `message tag` follows the work Sessions a turn started. Fixed, not configurable. */
const WORK_TIMEOUT_MS = 60 * 60_000;
const POLL_INTERVAL_MS = 1000;

export interface TagConversationOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  /** Aborting detaches from the reply; the Tag keeps working. */
  readonly signal?: AbortSignal;
  /** Receives streamed reply text as it arrives; without it, the text is part of the result. */
  readonly write?: (text: string) => void;
  /** Receives the follow-up notice after a detach. */
  readonly warn?: (text: string) => void;
  /** Show activity lines, dimmed, as for a terminal. */
  readonly interactive?: boolean;
}

export function tagConversationHelp(): string {
  return `Usage:
  supertag message tag NAME TEXT|- [--session NAME] [--output text|json]

Sends TEXT (or standard input for -) to the Tag as you and shows its reply as it is written.
--session names the conversation; without it the conversation is default. The same name
continues the same Session, so the Tag sees the earlier messages and replies.
The conversation is private to you: the admin token and each Operator Token have their own.
The Tag answers with its Roles' permissions only; no location's Permission or Context Sets apply.
When the Tag hands work to work Sessions, it shows "· working: TITLE" for each one and stays
until the Tag reports each result in the conversation. A work Session that needs you shows
"· waiting on you: TITLE" and the Tag's question; answer it with your next message.
Ctrl-C stops showing the reply; the Tag keeps working, and supertag describe task shows it.
A report still arrives in the conversation, and your next message there sees it.
--output json waits and prints the message record with the reply and the work Sessions' reports.
`;
}

export async function runTagConversationCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
  options: TagConversationOptions = {},
): Promise<string> {
  const output = takeOutputFlag(args);
  const { values, positionals } = parseArgs({
    args: output.args,
    allowPositionals: true,
    options: { session: { type: "string" } },
    strict: true,
  });
  const [name, message, ...rest] = positionals;
  if (name === undefined || message === undefined || rest.length > 0)
    throw new Error(tagConversationHelp());
  const text = message === "-" ? await readStdin() : message;
  if (!text.trim()) throw new Error("The message is empty");
  const client = new ControlPlaneClient(target);
  const tagPath = `/api/v1/tags/${encodeURIComponent(name)}/messages`;
  const record = await client.request<TagMessageRecord>(tagPath, {
    method: "POST",
    body: JSON.stringify({
      text,
      ...(values.session === undefined ? {} : { session: values.session }),
    }),
  });
  const timeoutMs = options.timeoutMs ?? REPLY_TIMEOUT_MS;
  const notReplied = () =>
    new Error(
      `Tag ${name} has not replied yet; it keeps working on task/${record.taskId}. ${followUp(record)}`,
    );
  const detached = () => {
    options.warn?.(
      `\nStopped showing the reply; Tag ${terminalText(name)} keeps working on task/${record.taskId}. ${followUp(record)}\n`,
    );
    return "";
  };
  const messagePath = `${tagPath}/${encodeURIComponent(record.taskId)}`;
  const poll = async (deadline: number): Promise<TagMessageRecord | undefined> => {
    let current = record;
    while (current.status !== "replied") {
      if (Date.now() >= deadline) throw notReplied();
      if (!(await pause(options.intervalMs ?? POLL_INTERVAL_MS, options.signal))) return undefined;
      current = await client.request<TagMessageRecord>(messagePath);
    }
    return current;
  };

  const workTimeoutMs = options.timeoutMs ?? WORK_TIMEOUT_MS;
  const detachedFromWork = () => {
    options.warn?.(
      `\nStopped following the work; Tag ${terminalText(name)} keeps working, and each report will arrive in the ${record.session} conversation, so your next message there sees it.\n`,
    );
    return "";
  };
  /** Rereads the message until every work Session it started has a report, or time runs out. */
  const awaitReports = async (
    current: TagMessageRecord,
    onRecord: (record: TagMessageRecord) => void,
  ): Promise<TagMessageRecord | undefined> => {
    const deadline = Date.now() + workTimeoutMs;
    for (;;) {
      onRecord(current);
      const sessions = current.startedSessions ?? [];
      if (sessions.every((session) => session.reportStatus === "replied")) return current;
      if (Date.now() >= deadline) return current;
      if (!(await pause(options.intervalMs ?? POLL_INTERVAL_MS, options.signal))) return undefined;
      current = await client.request<TagMessageRecord>(messagePath);
    }
  };

  if (output.json) {
    const replied = await poll(Date.now() + timeoutMs);
    if (replied === undefined) return detached();
    const reported = await awaitReports(replied, () => {});
    if (reported === undefined) return detachedFromWork();
    return `${JSON.stringify(reported, null, 2)}\n`;
  }

  let printed = "";
  const write = (chunk: string) => {
    if (!chunk) return;
    printed += chunk;
    if (options.write) options.write(chunk);
  };
  let streamed: StreamedReply | undefined;
  if (record.status !== "replied")
    try {
      // A conversation turn's text includes what the Tag says between tool calls; show only its
      // activity while it runs, then the final reply, as a teammate's message.
      streamed = await streamReply(client, `${messagePath}/stream`, {
        idleMs: timeoutMs,
        interactive: options.interactive === true,
        text: false,
        write,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      // A Control Plane without reply streams; read the record instead.
      if (!(error instanceof ControlPlaneRequestError) || ![404, 405].includes(error.status))
        throw error;
    }
  if (streamed?.ended === "detached") return detached();
  if (streamed?.ended === "idle") throw notReplied();
  let reply = record.reply ?? streamed?.reply;
  if (reply === undefined) {
    const replied = await poll(Date.now() + timeoutMs);
    if (replied === undefined) return detached();
    reply = replied.reply;
  }
  const lineBreak = printed === "" || printed.endsWith("\n") ? "" : "\n";
  const finalText = reply?.text ?? "";
  if (reply?.presentation === "error") {
    write(lineBreak);
    throw new Error(`Tag ${terminalText(name)} could not answer: ${finalText}`);
  }
  write(`${lineBreak}${terminalLines(finalText.trimEnd())}\n`);
  const followed = await followWorkSessions(
    client,
    tagPath,
    await client.request<TagMessageRecord>(messagePath),
    awaitReports,
    { idleMs: workTimeoutMs, interactive: options.interactive === true, write },
  );
  if (followed === "detached") return detachedFromWork();
  if (followed === "timeout")
    options.warn?.(
      `\nTag ${terminalText(name)} is still working; each report will arrive in the ${record.session} conversation.\n`,
    );
  return options.write ? "" : printed;
}

/**
 * After the turn's reply, follows the work Sessions it started: a line per Session, their
 * activity on a terminal, and each report turn's text as it arrives.
 */
async function followWorkSessions(
  client: ControlPlaneClient,
  tagPath: string,
  record: TagMessageRecord,
  awaitReports: (
    current: TagMessageRecord,
    onRecord: (record: TagMessageRecord) => void,
  ) => Promise<TagMessageRecord | undefined>,
  options: {
    readonly idleMs: number;
    readonly interactive: boolean;
    readonly write: (text: string) => void;
  },
): Promise<"done" | "detached" | "timeout"> {
  const sessions = record.startedSessions ?? [];
  if (sessions.length === 0) return "done";
  for (const session of sessions) options.write(`· working: ${terminalText(session.title)}\n`);
  const following = new AbortController();
  const activity = options.interactive
    ? sessions.flatMap((session) =>
        session.taskId === undefined || session.reportStatus === "replied"
          ? []
          : [
              streamReply(client, `${tagPath}/${encodeURIComponent(session.taskId)}/stream`, {
                idleMs: options.idleMs,
                interactive: true,
                text: false,
                indent: true,
                ...(sessions.length > 1 ? { label: session.title } : {}),
                write: options.write,
                signal: following.signal,
              }).catch(() => undefined),
            ],
      )
    : [];
  const shown = new Set<string>();
  try {
    const reported = await awaitReports(record, (current) => {
      for (const session of current.startedSessions ?? []) {
        // A status reply posts nowhere on the CLI, so the approval notice prints here, once.
        for (const approval of session.approvals ?? []) {
          if (shown.has(`approval:${approval.requestId}`)) continue;
          shown.add(`approval:${approval.requestId}`);
          options.write(
            `· approval needed: ${terminalText(session.title)}\n${terminalLines(approval.text.trimEnd())}\n`,
          );
        }
        if (session.report === undefined || shown.has(session.id)) continue;
        shown.add(session.id);
        const ended =
          session.status === "completed"
            ? "done"
            : session.status === "waiting"
              ? "waiting on you"
              : session.status === "failed"
                ? "failed"
                : "stopped";
        options.write(
          `· ${ended}: ${terminalText(session.title)}\n${terminalLines(session.report.text.trimEnd())}\n`,
        );
      }
    });
    if (reported === undefined) return "detached";
    return (reported.startedSessions ?? []).every((session) => session.reportStatus === "replied")
      ? "done"
      : "timeout";
  } finally {
    following.abort();
    await Promise.all(activity);
  }
}

interface StreamedReply {
  /** Reply text the stream carried, as written. */
  readonly text: string;
  readonly reply?: TagReply;
  readonly ended: "finished" | "closed" | "detached" | "idle";
}

/**
 * Follows one message's reply stream: text deltas as they arrive and, interactively, one line per
 * command or tool the Tag starts. Ends at the stream's finish or error part.
 */
async function streamReply(
  client: ControlPlaneClient,
  path: string,
  options: {
    readonly idleMs: number;
    readonly interactive: boolean;
    /** Print text deltas; a followed work Session shows only its activity. */
    readonly text?: boolean;
    /** Names the work Session an activity line belongs to. */
    readonly label?: string;
    /** Indents activity lines under a work Session's "working" line. */
    readonly indent?: boolean;
    readonly write: (text: string) => void;
    readonly signal?: AbortSignal;
  },
): Promise<StreamedReply> {
  const abort = new AbortController();
  let ended: "detached" | "idle" | undefined;
  const detach = () => {
    ended ??= "detached";
    abort.abort();
  };
  if (options.signal?.aborted) return { text: "", ended: "detached" };
  options.signal?.addEventListener("abort", detach, { once: true });
  let idle: NodeJS.Timeout | undefined;
  const awake = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      ended ??= "idle";
      abort.abort();
    }, options.idleMs);
    idle.unref();
  };
  let text = "";
  let atLineStart = true;
  const write = (chunk: string) => {
    if (!chunk) return;
    options.write(chunk);
    atLineStart = chunk.endsWith("\n");
  };
  try {
    awake();
    const response = await client.stream(path, abort.signal);
    if (response.body === null) return { text, ended: "closed" };
    const events = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());
    for await (const event of events) {
      awake();
      if (event.data === "[DONE]") break;
      const part = parsePart(event.data);
      if (part === undefined) continue;
      if (part.type === "text-delta" && typeof part["delta"] === "string") {
        text += part["delta"];
        if (options.text !== false) write(terminalLines(part["delta"]));
      } else if (part.type === "data-activity" && options.interactive) {
        const line = activityLine(part["data"]);
        if (line !== undefined) {
          if (!atLineStart) write("\n");
          const shown = options.label === undefined ? line : `${options.label} ${line}`;
          write(
            `\u001b[2m${options.indent === true ? "  " : ""}${terminalText(shown)}\u001b[22m\n`,
          );
        }
      } else if (part.type === "error") {
        const errorText = typeof part["errorText"] === "string" ? part["errorText"] : "";
        return { text, reply: { presentation: "error", text: errorText }, ended: "finished" };
      } else if (part.type === "finish") {
        const metadata = isRecord(part["messageMetadata"]) ? part["messageMetadata"] : {};
        const reply = metadata["reply"];
        return {
          text,
          ...(isRecord(reply) &&
          typeof reply["presentation"] === "string" &&
          typeof reply["text"] === "string"
            ? { reply: { presentation: reply["presentation"], text: reply["text"] } }
            : {}),
          ended: "finished",
        };
      }
    }
    return { text, ended: ended ?? "closed" };
  } catch (error) {
    if (ended !== undefined) return { text, ended };
    throw error;
  } finally {
    clearTimeout(idle);
    options.signal?.removeEventListener("abort", detach);
    abort.abort();
  }
}

function parsePart(
  data: string,
): (Record<string, unknown> & { readonly type: string }) | undefined {
  try {
    const part: unknown = JSON.parse(data);
    return isRecord(part) && typeof part["type"] === "string"
      ? (part as Record<string, unknown> & { readonly type: string })
      : undefined;
  } catch {
    return undefined;
  }
}

/** One short line for a command or tool the Tag starts, or a retry. */
function activityLine(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (data["kind"] === "retry") return `· retrying (Task Attempt ${String(data["attempt"])})`;
  if (data["status"] !== "running") return undefined;
  if (data["kind"] === "command" && typeof data["command"] === "string")
    return `· running: ${data["command"]}`;
  if (data["kind"] === "tool" && typeof data["tool"] === "string")
    return `· using: ${data["tool"]}`;
  return undefined;
}

function followUp(record: TagMessageRecord): string {
  return `Check it with: supertag describe task ${record.taskId}. The reply stays in the ${record.session} conversation, so your next message there sees it.`;
}

/** Waits `ms`; false when `signal` aborted first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(value);
    };
    const stop = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
