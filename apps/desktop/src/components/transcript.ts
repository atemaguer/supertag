import type { Message, Tag } from "../gateway";
import type { TagSummary } from "./sidebar";

/** Tasks a Worker Host has not finished: the Tag is still working on them. */
export const RUNNING = new Set(["queued", "claimed", "running"]);

/**
 * What the operator's last message shows under it, as a messaging app shows delivery: "Sent" once
 * the Gateway accepted it, "Seen" once a Worker Host took it up (or the running Task it
 * joined accepted it), and otherwise why it did not arrive.
 */
export function deliveryStatus(message: Message): string | undefined {
  if (!fromOperator(message)) return undefined;
  const input = message.liveInput?.state;
  if (input)
    return {
      pending: "Sent",
      dispatching: "Sent",
      accepted: "Seen",
      unknown: "Delivery uncertain",
      withdrawn: "Not delivered",
    }[input];
  return message.task.state === "queued" ? "Sent" : "Seen";
}

/** Whether the operator wrote the message: a report or a Schedule's turn has none from them. */
export function fromOperator(message: Message): boolean {
  return message.workSessionReportId === undefined && message.scheduleId === undefined;
}

/**
 * Where each turn's reply shows when later messages joined it, as a person's quick follow-ups
 * that one run answers together: after the last of them, so the conversation reads in order.
 * `answeredBy` maps the last joined message to the turn whose reply it shows; `replyLater` holds
 * the turns and joined messages that show only their prompt.
 */
export function joinedReplies(messages: readonly Message[]): {
  answeredBy: Map<string, Message>;
  replyLater: Set<string>;
} {
  const byTask = new Map(messages.map((message) => [message.task.taskId, message]));
  const last = new Map<string, Message>();
  for (const message of messages) {
    const source = message.liveInput?.taskId;
    if (
      !fromOperator(message) ||
      message.liveInput?.state !== "accepted" ||
      !source ||
      source === message.task.taskId ||
      !byTask.has(source)
    )
      continue;
    const prior = last.get(source);
    if (!prior || prior.order < message.order) last.set(source, message);
  }
  const answeredBy = new Map<string, Message>();
  const replyLater = new Set<string>();
  for (const [source, follower] of last) {
    const turn = byTask.get(source);
    if (!turn) continue;
    answeredBy.set(follower.task.taskId, turn);
    replyLater.add(source);
  }
  for (const message of messages) {
    const source = message.liveInput?.taskId;
    if (
      source &&
      replyLater.has(source) &&
      message.liveInput?.state === "accepted" &&
      !answeredBy.has(message.task.taskId)
    )
      replyLater.add(message.task.taskId);
  }
  return { answeredBy, replyLater };
}

/** A gap between two messages longer than this starts a new time divider. */
const DIVIDER_GAP = 15 * 60_000;

/**
 * Where time dividers go: before the first loaded message and wherever more than fifteen minutes
 * separate two messages. Messages without a time get none.
 */
export function timeDividers(messages: readonly Message[]): Map<string, number> {
  const dividers = new Map<string, number>();
  let previous: number | undefined;
  for (const message of messages) {
    const at = message.task.createdAtMs;
    if (at === undefined) continue;
    if (previous === undefined || at - previous > DIVIDER_GAP)
      dividers.set(message.task.taskId, at);
    previous = at;
  }
  return dividers;
}

/** A divider's label: "Today 10:16 PM", "Yesterday 9:02 AM", the weekday this week, else a date. */
export function dividerLabel(at: number, now = Date.now()): string {
  const then = new Date(at);
  const time = then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (at >= today.getTime()) return `Today ${time}`;
  if (at >= today.getTime() - day) return `Yesterday ${time}`;
  if (at >= today.getTime() - 6 * day)
    return `${then.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  return `${then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} ${time}`;
}

/** The last message the operator wrote, which alone shows its delivery. */
export function lastOperatorMessage(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && fromOperator(message)) return message.task.taskId;
  }
  return undefined;
}

/**
 * What the sidebar row of an open conversation shows: the first line of its last message (the
 * Tag's reply, else what the operator wrote), when it was sent, and whether the Tag is working.
 */
export function conversationSummary(messages: readonly Message[]): TagSummary {
  const last = messages.at(-1);
  if (!last) return {};
  const reply = last.task.result?.trim();
  const prompt = fromOperator(last) ? last.task.prompt?.trim() : undefined;
  const line = (reply || (prompt ? `You: ${prompt}` : "")).split("\n")[0]?.trim();
  return {
    ...(line ? { preview: line } : {}),
    ...(last.task.createdAtMs !== undefined ? { lastActivityMs: last.task.createdAtMs } : {}),
    ...(RUNNING.has(last.task.state) ? { working: true } : {}),
  };
}

/** "3 of 8 Work Sessions open", once the Tag says how many it may have. */
export function workSessionCount(tag: Pick<Tag, "maxWorkSessions" | "openWorkSessions">) {
  if (!tag.maxWorkSessions) return undefined;
  return `${tag.openWorkSessions ?? 0} of ${tag.maxWorkSessions} Work Sessions open`;
}
