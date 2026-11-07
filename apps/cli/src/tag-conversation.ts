import { parseArgs } from "node:util";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";
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
  /** Why the turn has not started, while no bound Worker Host can run it. */
  readonly waiting?: string;
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
  /** Why a decision on a request the work Task waited on did not continue the work Session. */
  readonly notContinued?: string;
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
  /**
   * Receives the output as it is shown: activity lines, the final reply, and work Session lines.
   * Without it, the output is part of the result.
   */
  readonly write?: (text: string) => void;
  /** Receives the follow-up notice after a detach. */
  readonly warn?: (text: string) => void;
  /** Show activity lines, dimmed, as for a terminal. */
  readonly interactive?: boolean;
}

export function tagConversationHelp(): string {
  return `Usage:
  supertag message tag NAME TEXT|- [--session NAME] [--output text|json]

Sends TEXT (or standard input for -) to the Tag as you, shows a line for each command the Tag
runs, then its reply.
--session names the conversation; without it the conversation is default. The same name
continues the same Session, so the Tag sees the earlier messages and replies.
The conversation is private to you: the admin token and each Operator Token have their own.
The Tag answers with its Roles' permissions only; no location's Permission or Context Sets apply.
While no bound Worker Host can run the turn, it shows "· waiting: REASON" once, such as
"· waiting: no bound Worker Host provides MCP server notes".
When the Tag hands work to work Sessions, it shows "· working: TITLE" for each one and stays
until the Tag reports each result in the conversation. In a terminal, while a work Session works,
it shows each command it runs as "· running: COMMAND". A work Session that needs you shows
"· waiting on you: TITLE" and the Tag's question; answer it with your next message. A work
Session that needs an approval shows "· approval needed: TITLE" and the request, then
"· waiting for approval: TITLE" and the Tag's report. Decide it with supertag approve request or
supertag deny request in another terminal: the work Session continues on its own, and this command
shows "· working: TITLE" again, then its next report. When the decision cannot continue it,
because the Tag's permissions changed or the turn's limits are spent, it shows
"· not continued: TITLE" and why.
Ctrl-C stops following; the Tag keeps working, and supertag describe task shows it.
A report still arrives in the conversation, and your next message there sees it.
--output json waits and prints the message record with the reply and the work Sessions' reports;
it returns at a report that waits for approval, so you can decide the request.
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
  /**
   * Rereads the message until every work Session it started is `done` by the given test, or time
   * runs out.
   */
  const awaitReports = async (
    current: TagMessageRecord,
    onRecord: (record: TagMessageRecord) => void,
    done: (session: StartedWorkSession) => boolean = settled,
  ): Promise<TagMessageRecord | undefined> => {
    const deadline = Date.now() + workTimeoutMs;
    for (;;) {
      onRecord(current);
      const sessions = current.startedSessions ?? [];
      if (sessions.every(done)) return current;
      if (Date.now() >= deadline) return current;
      if (!(await pause(options.intervalMs ?? POLL_INTERVAL_MS, options.signal))) return undefined;
      current = await client.request<TagMessageRecord>(messagePath);
    }
  };

  if (output.json) {
    const replied = await poll(Date.now() + timeoutMs);
    if (replied === undefined) return detached();
    // The record returns once each work Session reported, including one waiting on approval,
    // so a caller can decide the request; the decision continues the work Session on its own.
    const reported = await awaitReports(
      replied,
      () => {},
      (session) => session.reportStatus === "replied",
    );
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
  // A conversation turn's text includes what the Tag says between tool calls; show only its
  // activity while it runs, then the final reply, as a teammate's message.
  if (record.status !== "replied") {
    // Until the reply stream sends its first part, say once why the turn has not started.
    const started = new AbortController();
    const shownWaiting = new Set<string>();
    const showWaiting = (current: TagMessageRecord) => {
      if (current.waiting === undefined || shownWaiting.has(current.waiting)) return;
      shownWaiting.add(current.waiting);
      write(`· waiting: ${terminalText(current.waiting)}\n`);
    };
    showWaiting(record);
    const watching = (async () => {
      while (await pause(options.intervalMs ?? POLL_INTERVAL_MS, started.signal)) {
        const current = await client.request<TagMessageRecord>(messagePath).catch(() => undefined);
        if (started.signal.aborted) return;
        if (current !== undefined) showWaiting(current);
        if (current?.status === "replied") return;
      }
    })();
    try {
      streamed = await streamReply(client, `${messagePath}/stream`, {
        idleMs: timeoutMs,
        interactive: options.interactive === true,
        write,
        onPart: () => started.abort(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } finally {
      started.abort();
      await watching;
    }
  }
  if (streamed?.ended === "detached") return detached();
  if (streamed?.ended === "idle") throw notReplied();
  let reply = record.reply ?? streamed?.reply;
  if (reply === undefined) {
    const replied = await poll(Date.now() + timeoutMs);
    if (replied === undefined) return detached();
    reply = replied.reply;
  }
  const finalText = reply?.text ?? "";
  if (reply?.presentation === "error")
    throw new Error(`Tag ${terminalText(name)} could not answer: ${finalText}`);
  write(`${terminalLines(finalText.trimEnd())}\n`);
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
  const following = new AbortController();
  const activity: Promise<unknown>[] = [];
  // Each work Session's Task being followed. A decision on its approval request continues the
  // Session as its next Task, which shows "working" again and then its own report.
  const followedTasks = new Map<string, string | undefined>();
  const follow = (session: StartedWorkSession, count: number) => {
    const known = followedTasks.has(session.id);
    const previous = followedTasks.get(session.id);
    if (known && previous === session.taskId) return;
    followedTasks.set(session.id, session.taskId);
    // A Session that had no Task yet is still the same piece of work.
    if (!known || previous !== undefined)
      options.write(`· working: ${terminalText(session.title)}\n`);
    if (!options.interactive || session.taskId === undefined || session.reportStatus === "replied")
      return;
    activity.push(
      streamReply(client, `${tagPath}/${encodeURIComponent(session.taskId)}/stream`, {
        idleMs: options.idleMs,
        interactive: true,
        indent: true,
        ...(count > 1 ? { label: session.title } : {}),
        write: options.write,
        signal: following.signal,
      }).catch(() => undefined),
    );
  };
  const shown = new Set<string>();
  try {
    const reported = await awaitReports(record, (current) => {
      const started = current.startedSessions ?? [];
      for (const session of started) follow(session, started.length);
      for (const session of started) {
        // A status reply posts nowhere on the CLI, so the approval notice prints here, once.
        for (const approval of session.approvals ?? []) {
          if (shown.has(`approval:${approval.requestId}`)) continue;
          shown.add(`approval:${approval.requestId}`);
          options.write(
            `· approval needed: ${terminalText(session.title)}\n${terminalLines(approval.text.trimEnd())}\n`,
          );
        }
        const reportKey = `report:${session.taskId ?? session.id}`;
        if (session.report === undefined || shown.has(reportKey)) continue;
        shown.add(reportKey);
        const ended =
          session.status === "completed"
            ? "done"
            : session.status === "waiting"
              ? session.question === undefined
                ? "waiting for approval"
                : "waiting on you"
              : session.status === "failed"
                ? "failed"
                : "stopped";
        options.write(
          `· ${ended}: ${terminalText(session.title)}\n${terminalLines(session.report.text.trimEnd())}\n`,
        );
      }
      // A decision that could not continue the work Session ends the wait; say why, once.
      for (const session of current.startedSessions ?? []) {
        if (session.notContinued === undefined || shown.has(`stopped:${session.taskId}`)) continue;
        shown.add(`stopped:${session.taskId}`);
        options.write(
          `· not continued: ${terminalText(session.title)}\n${terminalLines(session.notContinued.trimEnd())}\n`,
        );
      }
    });
    if (reported === undefined) return "detached";
    return (reported.startedSessions ?? []).every(settled) ? "done" : "timeout";
  } finally {
    following.abort();
    await Promise.all(activity);
  }
}

/**
 * Whether a work Session needs no more following: its Task's report arrived, and the Task does
 * not wait on an approval decision only. Deciding the request continues the Session as its next
 * Task, so a Session waiting on approval stays followed; one waiting on a question waits for the
 * person's next message.
 */
function settled(session: StartedWorkSession): boolean {
  if (session.reportStatus !== "replied") return false;
  return !(session.status === "waiting" && session.question === undefined);
}

interface StreamedReply {
  readonly reply?: TagReply;
  readonly ended: "finished" | "closed" | "detached" | "idle";
}

/**
 * Follows one message's reply stream: interactively, one line per command or tool the Tag starts,
 * and the final reply from its finish or error part, where it ends.
 */
async function streamReply(
  client: ControlPlaneClient,
  path: string,
  options: {
    readonly idleMs: number;
    readonly interactive: boolean;
    /** Names the work Session an activity line belongs to. */
    readonly label?: string;
    /** Indents activity lines under a work Session's "working" line. */
    readonly indent?: boolean;
    readonly write: (text: string) => void;
    /** Called for each part the stream sends. */
    readonly onPart?: () => void;
    readonly signal?: AbortSignal;
  },
): Promise<StreamedReply> {
  const abort = new AbortController();
  let ended: "detached" | "idle" | undefined;
  const detach = () => {
    ended ??= "detached";
    abort.abort();
  };
  if (options.signal?.aborted) return { ended: "detached" };
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
  try {
    awake();
    const response = await client.stream(path, abort.signal);
    if (response.body === null) return { ended: "closed" };
    const events = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());
    for await (const event of events) {
      awake();
      if (event.data === "[DONE]") break;
      const part = parsePart(event.data);
      if (part === undefined) continue;
      options.onPart?.();
      if (part.type === "data-activity" && options.interactive) {
        const line = activityLine(part["data"]);
        if (line !== undefined) {
          const shown = options.label === undefined ? line : `${options.label} ${line}`;
          options.write(
            `\u001b[2m${options.indent === true ? "  " : ""}${terminalText(shown)}\u001b[22m\n`,
          );
        }
      } else if (part.type === "error") {
        const errorText = typeof part["errorText"] === "string" ? part["errorText"] : "";
        return { reply: { presentation: "error", text: errorText }, ended: "finished" };
      } else if (part.type === "finish") {
        const metadata = isRecord(part["messageMetadata"]) ? part["messageMetadata"] : {};
        const reply = metadata["reply"];
        return {
          ...(isRecord(reply) &&
          typeof reply["presentation"] === "string" &&
          typeof reply["text"] === "string"
            ? { reply: { presentation: reply["presentation"], text: reply["text"] } }
            : {}),
          ended: "finished",
        };
      }
    }
    return { ended: ended ?? "closed" };
  } catch (error) {
    if (ended !== undefined) return { ended };
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
