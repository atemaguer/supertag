import { parseArgs } from "node:util";
import { toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type FollowEvent,
  type Message,
  MessageSchema,
  ReplyStatus,
  type WorkSession,
  WorkSessionStatus,
} from "@supertag/operator-api";
import type { ControlPlaneTarget } from "./control-plane-client.js";
import { conversationClient, operatorErrorMessage } from "./operator-client.js";
import { takeOutputFlag } from "./output-flag.js";
import { terminalLines, terminalText } from "./terminal-text.js";

/**
 * How long `message tag` waits for the reply without a new event from the stream. Fixed, not
 * configurable.
 */
const REPLY_TIMEOUT_MS = 10 * 60_000;
/** How long `message tag` follows the work Sessions a turn started. Fixed, not configurable. */
const WORK_TIMEOUT_MS = 60 * 60_000;

type ConversationClient = ReturnType<typeof conversationClient>;

export interface TagConversationOptions {
  /** How long to wait for the reply, and how long to follow the work Sessions. */
  readonly timeoutMs?: number;
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

export const tagMessageDeprecation =
  "supertag message tag is deprecated. Run supertag in a terminal and select a Tag to message it.";

export function tagConversationHelp(): string {
  return `Usage:
  supertag message tag NAME TEXT|- [--session NAME] [--output text|json]

${tagMessageDeprecation}

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
  const client = tagConversationClient(target);
  const sent = await refusedAsError(() =>
    client.sendMessage({ tag: name, conversation: values.session ?? "", text }),
  );
  return followTagMessage(client, sent, { ...options, json: output.json });
}

/** The client `message tag` and `message objective` follow replies with. */
export function tagConversationClient(target: ControlPlaneTarget): ConversationClient {
  return conversationClient({ url: target.url, token: target.token, warnOnSkew: true });
}

/** Runs an operator RPC; a refusal becomes an error with the Control Plane's message. */
export async function refusedAsError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ConnectError) throw new Error(operatorErrorMessage(error));
    throw error;
  }
}

/**
 * Follows one message's turn to its reply, then the work Sessions it started, as `message tag`
 * shows them. With `json`, waits and returns the message instead.
 */
export async function followTagMessage(
  client: ConversationClient,
  sent: Message,
  options: TagConversationOptions & { readonly json?: boolean } = {},
): Promise<string> {
  const name = sent.tag;
  const replyTimeoutMs = options.timeoutMs ?? REPLY_TIMEOUT_MS;
  const workTimeoutMs = options.timeoutMs ?? WORK_TIMEOUT_MS;
  const json = options.json === true;
  const interactive = options.interactive === true && !json;
  let printed = "";
  const write = (chunk: string) => {
    if (!chunk || json) return;
    printed += chunk;
    options.write?.(chunk);
  };
  const followUp = `Check it with: supertag describe task ${sent.taskId}. The reply stays in the ${sent.conversation} conversation, so your next message there sees it.`;

  const following = new AbortController();
  let ended: "detached" | "idle" | "work timeout" | "reported" | undefined;
  const stop = (why: NonNullable<typeof ended>) => {
    ended ??= why;
    following.abort();
  };
  const detach = () => stop("detached");
  if (options.signal?.aborted) ended = "detached";
  options.signal?.addEventListener("abort", detach, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const deadline = (ms: number, why: "idle" | "work timeout") => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(why), ms);
    timer.unref();
  };

  let replied = false;
  const sessions = new Map<string, WorkSession>();
  const show = workSessionLines(write);
  try {
    if (ended === undefined) {
      deadline(replyTimeoutMs, "idle");
      const stream = client.followMessage(
        { tag: name, taskId: sent.taskId },
        { signal: following.signal, timeoutMs: 0 },
      );
      const shownWaiting = new Set<string>();
      for await (const event of stream) {
        const part = event.part;
        if (part.case === "heartbeat" || part.case === undefined) continue;
        if (!replied) deadline(replyTimeoutMs, "idle");
        if (part.case === "waiting") {
          if (shownWaiting.has(part.value.reason)) continue;
          shownWaiting.add(part.value.reason);
          write(`· waiting: ${terminalText(part.value.reason)}\n`);
        } else if (part.case === "activity") {
          if (interactive) write(activityLine(part.value, sessions));
        } else if (part.case === "error") {
          if (!json)
            throw new Error(`Tag ${terminalText(name)} could not answer: ${part.value.text}`);
        } else if (part.case === "finish") {
          replied = true;
          deadline(workTimeoutMs, "work timeout");
          write(`${terminalLines((part.value.reply?.text ?? "").trimEnd())}\n`);
          for (const session of part.value.message?.workSessions ?? [])
            sessions.set(session.id, session);
          show([...sessions.values()]);
        } else if (part.case === "workSessionChanged" && part.value.workSession !== undefined) {
          sessions.set(part.value.workSession.id, part.value.workSession);
          show([...sessions.values()]);
        } else if (part.case === "end") break;
        // `--output json` returns once each work Session reported, even one waiting on approval.
        if (
          json &&
          replied &&
          [...sessions.values()].every((session) => session.reportStatus === ReplyStatus.REPLIED)
        ) {
          stop("reported");
          break;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof ConnectError && error.code === Code.Canceled && ended !== undefined)) {
      if (error instanceof ConnectError) throw new Error(operatorErrorMessage(error));
      throw error;
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", detach);
    following.abort();
  }

  if (ended === "idle")
    throw new Error(
      `Tag ${name} has not replied yet; it keeps working on task/${sent.taskId}. ${followUp}`,
    );
  if (ended === "detached") {
    options.warn?.(
      replied
        ? `\nStopped following the work; Tag ${terminalText(name)} keeps working, and each report will arrive in the ${sent.conversation} conversation, so your next message there sees it.\n`
        : `\nStopped showing the reply; Tag ${terminalText(name)} keeps working on task/${sent.taskId}. ${followUp}\n`,
    );
    return "";
  }
  if (json) {
    const current = await refusedAsError(() =>
      client.getMessage({ tag: name, taskId: sent.taskId }),
    );
    return `${toJsonString(MessageSchema, current, { prettySpaces: 2 })}\n`;
  }
  if (ended === "work timeout")
    options.warn?.(
      `\nTag ${terminalText(name)} is still working; each report will arrive in the ${sent.conversation} conversation.\n`,
    );
  return options.write ? "" : printed;
}

/**
 * Shows the work Sessions a message started as they change: a working line per Session, and once
 * each its approval notices, its report, and why a decision did not continue it.
 */
function workSessionLines(
  write: (text: string) => void,
): (sessions: readonly WorkSession[]) => void {
  // Each work Session's Task being followed. A decision on its approval request continues the
  // Session as its next Task, which shows "working" again and then its own report.
  const followedTasks = new Map<string, string>();
  const shown = new Set<string>();
  return (sessions) => {
    for (const session of sessions) {
      const previous = followedTasks.get(session.id);
      if (previous !== undefined && previous === session.taskId) continue;
      followedTasks.set(session.id, session.taskId);
      // A Session that had no Task yet is still the same piece of work.
      if (previous === undefined || previous !== "")
        write(`· working: ${terminalText(session.title)}\n`);
    }
    for (const session of sessions) {
      // A status reply posts nowhere on the CLI, so the approval notice prints here, once.
      for (const approval of session.approvals) {
        if (shown.has(`approval:${approval.requestId}`)) continue;
        shown.add(`approval:${approval.requestId}`);
        write(
          `· approval needed: ${terminalText(session.title)}\n${terminalLines(approval.text.trimEnd())}\n`,
        );
      }
      const reportKey = `report:${session.taskId || session.id}`;
      if (session.report === undefined || shown.has(reportKey)) continue;
      shown.add(reportKey);
      const ended =
        session.status === WorkSessionStatus.COMPLETED
          ? "done"
          : session.status === WorkSessionStatus.WAITING
            ? session.question === ""
              ? "waiting for approval"
              : "waiting on you"
            : session.status === WorkSessionStatus.FAILED
              ? "failed"
              : "stopped";
      write(
        `· ${ended}: ${terminalText(session.title)}\n${terminalLines(session.report.text.trimEnd())}\n`,
      );
    }
    // A decision that could not continue the work Session ends the wait; say why, once.
    for (const session of sessions) {
      if (session.notContinued === "" || shown.has(`stopped:${session.taskId}`)) continue;
      shown.add(`stopped:${session.taskId}`);
      write(
        `· not continued: ${terminalText(session.title)}\n${terminalLines(session.notContinued.trimEnd())}\n`,
      );
    }
  };
}

/**
 * One dimmed line for a command or tool the Tag starts, or a retry: a work Session's indented,
 * and named by its title when the message started more than one.
 */
function activityLine(
  activity: Extract<FollowEvent["part"], { case: "activity" }>["value"],
  sessions: ReadonlyMap<string, WorkSession>,
): string {
  if (activity.text === "") return "";
  const line = `· ${activity.text}`;
  if (activity.workSessionId === "") return `\u001b[2m${terminalText(line)}\u001b[22m\n`;
  const title = sessions.size > 1 ? sessions.get(activity.workSessionId)?.title : undefined;
  return `\u001b[2m  ${terminalText(title === undefined ? line : `${title} ${line}`)}\u001b[22m\n`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
