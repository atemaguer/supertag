import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../desktop";
import type { Conversation } from "../gateway";
import { previewLine } from "./preview-line";

/**
 * Native notifications and the Dock badge, computed here from the conversation list the watch
 * keeps current. A notification says a Tag replied or asked a question in a conversation that is
 * not in view; the badge counts the unread replies. Turns that stayed quiet never count: the
 * Gateway leaves them out of the list.
 */

/** Which notifications this device shows: every reply, only questions, or none. */
export type NotificationLevel = "all" | "questions" | "off";

const LEVEL_KEY = "supertag.desktop.notifications";
const LEVEL_EVENT = "supertag-notification-level";
const LEVELS: readonly NotificationLevel[] = ["all", "questions", "off"];

export function readLevel(): NotificationLevel {
  try {
    const saved = localStorage.getItem(LEVEL_KEY);
    return LEVELS.find((level) => level === saved) ?? "all";
  } catch {
    return "all";
  }
}

/** Saves the level on this device; every view showing it follows. */
export function saveLevel(level: NotificationLevel) {
  try {
    if (level === "all") localStorage.removeItem(LEVEL_KEY);
    else localStorage.setItem(LEVEL_KEY, level);
  } catch {
    // Without storage, the level lasts until the window closes.
  }
  window.dispatchEvent(new CustomEvent(LEVEL_EVENT, { detail: level }));
}

export function useNotificationLevel() {
  const [level, setLevel] = useState(readLevel);
  useEffect(() => {
    const changed = (event: Event) =>
      setLevel((event as CustomEvent<NotificationLevel>).detail ?? readLevel());
    window.addEventListener(LEVEL_EVENT, changed);
    return () => window.removeEventListener(LEVEL_EVENT, changed);
  }, []);
  const change = useCallback((next: NotificationLevel) => {
    setLevel(next);
    saveLevel(next);
  }, []);
  return [level, change] as const;
}

/** One native notification. A newer one with the same key stands for the earlier. */
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

/** The Dock badge: unread replies across conversations, but the one open in front. */
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

function useFocused() {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const update = () => setFocused(document.hasFocus() && !document.hidden);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return focused;
}

export interface Notifier {
  /** Shows a notification; a newer one with the same key replaces the earlier. */
  show(alert: Alert): void;
  badge(count: number): void;
  /** Calls `open` with the Tag of a clicked notification, until the returned stop. */
  clicks(open: (tagId: string) => void): () => void;
}

/** For a window without the native app, such as the browser preview. */
export const silentNotifier: Notifier = {
  show() {},
  badge() {},
  clicks: () => () => {},
};

/**
 * The system notifier, through the desktop app's main process: it shows the notification,
 * focuses the window when one is clicked, and sets the Dock badge.
 */
export const nativeNotifier: Notifier = {
  show(alert) {
    const { key, tagId, title, body } = alert;
    void desktop()
      .notify({ key, tagId, title, body })
      .catch(() => {});
  },
  badge(count) {
    void desktop()
      .setBadge({ count: Math.max(0, count) })
      .catch(() => {});
  },
  clicks(open) {
    return desktop().onNotificationClick(open);
  },
};

/**
 * Notifies this device of replies and questions in conversations not in view, and keeps the Dock
 * badge on the unread total. `conversations` is the list as the Gateway last returned it;
 * `fresh` is false until it has, so a cached list never notifies.
 */
export function useDesktopNotifications({
  conversations,
  fresh,
  openTagId,
  name,
  onOpen,
  notifier = nativeNotifier,
}: {
  conversations: readonly Conversation[];
  fresh: boolean;
  openTagId?: string;
  name(tagId: string): string;
  onOpen(tagId: string): void;
  notifier?: Notifier;
}) {
  const [level] = useNotificationLevel();
  const focused = useFocused();
  const known = useRef<Map<string, Conversation> | undefined>(undefined);
  const context = useRef({ focused, openTagId, level, name });
  context.current = { focused, openTagId, level, name };
  useEffect(() => {
    if (!fresh) return;
    for (const alert of alertsFor(known.current, conversations, context.current))
      notifier.show(alert);
    known.current = new Map(conversations.map((entry) => [entry.tagId, entry]));
  }, [conversations, fresh, notifier]);
  useEffect(() => {
    notifier.badge(unreadTotal(conversations, focused ? openTagId : undefined));
  }, [conversations, focused, openTagId, notifier]);
  useEffect(() => () => notifier.badge(0), [notifier]);
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => notifier.clicks((tagId) => open.current(tagId)), [notifier]);
}
