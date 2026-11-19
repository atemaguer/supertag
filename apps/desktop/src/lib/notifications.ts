import {
  type Alert,
  alertsFor,
  type Conversation,
  type NotificationLevel,
  unreadTotal,
} from "@supertag/client/model";
import { useCallback, useEffect, useRef, useState } from "react";
import { desktop } from "../desktop";

/**
 * Native notifications and the Dock badge, computed here from the conversation list the watch
 * keeps current. A notification says a Tag replied or asked a question in a conversation that is
 * not in view; the badge counts the unread replies. Turns that stayed quiet never count: the
 * Gateway leaves them out of the list.
 */

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
