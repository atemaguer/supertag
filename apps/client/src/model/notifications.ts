/**
 * Which replies and questions notify, decided from the conversation list a watch keeps current.
 * A notification says a Tag replied or asked a question in a conversation that is not in view;
 * the unread total counts replies elsewhere. Turns that stayed quiet never count: the Gateway
 * leaves them out of the list. How a front end shows them (a native notification, a terminal
 * escape) is its own.
 */
import type { Conversation } from "./gateway";
import { previewLine } from "./preview-line";

/** Which notifications this device shows: every reply, only questions, or none. */
export type NotificationLevel = "all" | "questions" | "off";

/** One notification. A newer one with the same key stands for the earlier. */
export interface Alert {
  key: string;
  tagId: string;
  title: string;
  body: string;
  question: boolean;
}

export interface AlertContext {
  /** The window has the focus. */
  focused: boolean;
  /** The Tag whose conversation is open. */
  openTagId?: string;
  level: NotificationLevel;
  name(tagId: string): string;
}

/**
 * What changed between two reads of the conversation list that deserves a notification: a Tag's
 * new reply, or its new question, in a conversation not in view. The first read only sets what
 * is known. The caller's own messages, a turn still running, and quiet turns never notify.
 */
export function alertsFor(
  prior: ReadonlyMap<string, Conversation> | undefined,
  next: readonly Conversation[],
  context: AlertContext,
): Alert[] {
  if (!prior || context.level === "off") return [];
  const alerts: Alert[] = [];
  for (const conversation of next) {
    const before = prior.get(conversation.tagId);
    if (!conversation.previewFromTag) continue;
    if (context.focused && conversation.tagId === context.openTagId) continue;
    const newer = conversation.latestOrder > (before?.latestOrder ?? 0);
    const question =
      conversation.asking === true && (newer || !before?.asking) && conversation.unreadCount > 0;
    const reply = newer && conversation.unreadCount > (before?.unreadCount ?? 0);
    if (!question && (!reply || context.level === "questions")) continue;
    const name = context.name(conversation.tagId);
    const preview = previewLine(conversation.preview) || "New message";
    alerts.push({
      key: `${question ? "question" : "reply"}:${conversation.tagId}`,
      tagId: conversation.tagId,
      title: name,
      body: question
        ? preview
        : conversation.unreadCount > 1
          ? `${conversation.unreadCount} new messages`
          : preview,
      question,
    });
  }
  return alerts;
}

/** The unread count, as the Dock badge shows it: unread replies across conversations, but the one open in front. */
export function unreadTotal(conversations: readonly Conversation[], shownTagId?: string): number {
  return conversations.reduce(
    (total, conversation) =>
      conversation.tagId === shownTagId ? total : total + conversation.unreadCount,
    0,
  );
}

/** A stable notification ID per key, so a server that replaces by ID shows only the latest. */
export function alertId(key: string): number {
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 2_000_000_000;
}
