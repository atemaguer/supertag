/** How a conversation reads as a messaging app shows it: delivery, joined replies, time dividers. */
import type { Conversation, Message, Tag } from "./gateway";
import { previewLine } from "./preview-line";

/**
 * What the Tag list shows about a Tag beyond its name. The cached Tag list fills these in; until
 * then a row shows just the name.
 */
export interface TagSummary {
  /** The first line of the last message in the Tag's conversation. */
  preview?: string;
  /** When the conversation last changed, in milliseconds since the epoch. */
  lastActivityMs?: number;
  /** Whether the conversation has messages this person has not seen. */
  unread?: boolean;
  /** Whether the Tag is working on a Task in this conversation. */
  working?: boolean;
  /** Whether the conversation's latest message is the Tag's question, still unanswered. */
  asking?: boolean;
}

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
  const line = reply ? previewLine(reply) : prompt ? `You: ${previewLine(prompt)}` : "";
  return {
    ...(line ? { preview: line } : {}),
    ...(last.task.createdAtMs !== undefined ? { lastActivityMs: last.task.createdAtMs } : {}),
    ...(RUNNING.has(last.task.state) ? { working: true } : {}),
  };
}

/**
 * What a settled turn says under its reply, only when there is something to say: a turn that
 * succeeded says nothing. The tone colours it: muted, a warning, or an error.
 */
export function turnNotice(
  taskState: string,
  inputState?: string,
): { text: string; tone: "muted" | "warning" | "error" } | undefined {
  const input = {
    pending: { text: "Waiting to join the running Task", tone: "muted" },
    dispatching: { text: "Joining the running Task", tone: "muted" },
    accepted: { text: "Joined the running Task", tone: "muted" },
    unknown: { text: "Delivery uncertain", tone: "warning" },
    withdrawn: { text: "Not delivered to the running Task", tone: "error" },
  }[inputState ?? ""] as { text: string; tone: "muted" | "warning" | "error" } | undefined;
  if (input) return input;
  return (
    {
      queued: { text: "Queued", tone: "muted" },
      claimed: { text: "Starting", tone: "muted" },
      running: { text: "Working", tone: "muted" },
      failed: { text: "Failed", tone: "error" },
      cancelled: { text: "Cancelled", tone: "warning" },
      uncertain: { text: "Interrupted: needs attention", tone: "warning" },
    } as Record<string, { text: string; tone: "muted" | "warning" | "error" }>
  )[taskState];
}

/** The lead Tag first, then the others by last activity, newest first, keeping the given order. */
export function orderTags(tags: Tag[], summaries: Record<string, TagSummary> = {}) {
  const lead = tags.find((entry) => entry.lead);
  const others = tags
    .filter((entry) => entry !== lead)
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (summaries[b.entry.tagId]?.lastActivityMs ?? 0) -
          (summaries[a.entry.tagId]?.lastActivityMs ?? 0) || a.index - b.index,
    )
    .map(({ entry }) => entry);
  return { lead, others };
}

/** What the sidebar shows for a conversation the Gateway lists. */
export function rowSummary(conversation: Conversation): TagSummary {
  const line = previewLine(conversation.preview);
  return {
    ...(line ? { preview: conversation.previewFromTag ? line : `You: ${line}` } : {}),
    ...(conversation.lastActivityAtMs ? { lastActivityMs: conversation.lastActivityAtMs } : {}),
    ...(conversation.unreadCount > 0 ? { unread: true } : {}),
    ...(conversation.working ? { working: true } : {}),
    ...(conversation.asking ? { asking: true } : {}),
  };
}
