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
Ctrl-C stops showing the reply; the Tag keeps working, and supertag describe task shows it.
--output json waits and prints the message record with the reply.
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

  if (output.json) {
    const replied = await poll(Date.now() + timeoutMs);
    if (replied === undefined) return detached();
    return `${JSON.stringify(replied, null, 2)}\n`;
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
      streamed = await streamReply(client, `${messagePath}/stream`, {
        idleMs: timeoutMs,
        interactive: options.interactive === true,
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
  const shown = streamed?.text.trim() ?? "";
  // The streamed text usually ends with the final reply; repeat the reply only when it does not.
  const remainder =
    finalText.trim() !== "" && shown.endsWith(finalText.trim())
      ? lineBreak
      : `${lineBreak}${shown === "" ? "" : "\n"}${terminalLines(finalText.trimEnd())}\n`;
  return options.write ? remainder : `${printed}${remainder}`;
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
        write(terminalLines(part["delta"]));
      } else if (part.type === "data-activity" && options.interactive) {
        const line = activityLine(part["data"]);
        if (line !== undefined) {
          if (!atLineStart) write("\n");
          write(`\u001b[2m${terminalText(line)}\u001b[22m\n`);
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
