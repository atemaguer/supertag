import { useEffect } from "react";
import type { ControlPlane, Message, WatchUpdate } from "../control-plane";
import { type History, latestHistory, readHistory } from "./history";
import type { WatchFeed } from "./watch";

/**
 * Conversations the app has shown, so opening one again renders it at once and then revalidates.
 * Each entry belongs to one Control Plane and principal (`ControlPlane.scope`), so another
 * connection never sees it. The most recent are kept in memory, and each is also written to disk
 * through the native app, which keeps it owner-only in the app's data directory.
 */

/** How many conversations stay in memory. */
const MEMORY_ENTRIES = 32;
/** How long a changed conversation waits before it is written to disk, to coalesce bursts. */
const WRITE_DELAY = 500;
/** How many Tags have their conversation read ahead when the app connects. */
const PREFETCH_TAGS = 16;
/** What the disk cache records, so a newer app can tell an older entry apart. */
const VERSION = 1;

const memory = new Map<string, History>();
/** The conversation each Tag last showed, by scope and Tag. */
const shownConversations = new Map<string, string>();
/** Conversations a view shows now. A view keeps its own conversation current. */
const open = new Map<string, number>();
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const warming = new Map<string, Promise<History | undefined>>();

function key(controlPlane: ControlPlane, tagId: string, conversation: string) {
  return JSON.stringify([controlPlane.scope, tagId, conversation]);
}

function remember(entry: string, history: History) {
  memory.delete(entry);
  memory.set(entry, history);
  for (const oldest of memory.keys()) {
    if (memory.size <= MEMORY_ENTRIES) break;
    memory.delete(oldest);
  }
}

/** The conversation as it was last shown, from memory. */
export function cachedHistory(
  controlPlane: ControlPlane,
  tagId: string,
  conversation: string,
): History | undefined {
  const entry = memory.get(key(controlPlane, tagId, conversation));
  return entry && { ...entry, loading: false };
}

/** The conversation as the disk cache holds it, if it holds a valid one. */
export async function storedHistory(
  controlPlane: ControlPlane,
  tagId: string,
  conversation: string,
): Promise<History | undefined> {
  try {
    const value = await controlPlane.readCache(tagId, conversation);
    const history = parseStored(value, tagId, conversation);
    if (history && !memory.has(key(controlPlane, tagId, conversation)))
      remember(key(controlPlane, tagId, conversation), history);
    return history;
  } catch {
    return undefined;
  }
}

/** Records what a conversation shows now, in memory at once and on disk shortly after. */
export function cacheHistory(
  controlPlane: ControlPlane,
  tagId: string,
  conversation: string,
  history: History,
) {
  if (!history.read) return;
  const entry = key(controlPlane, tagId, conversation);
  remember(entry, history);
  clearTimeout(pendingWrites.get(entry));
  pendingWrites.set(
    entry,
    setTimeout(() => {
      pendingWrites.delete(entry);
      const latest = memory.get(entry);
      if (!latest) return;
      const { messages, cursor, sessionId, head } = latest;
      void controlPlane
        .writeCache(tagId, conversation, { version: VERSION, messages, cursor, sessionId, head })
        .catch(() => {});
    }, WRITE_DELAY),
  );
}

/** The conversation a Tag showed last on this connection's Control Plane, if it showed one. */
export function shownConversation(controlPlane: ControlPlane, tagId: string) {
  return shownConversations.get(JSON.stringify([controlPlane.scope, tagId]));
}

export function showConversation(controlPlane: ControlPlane, tagId: string, conversation: string) {
  shownConversations.set(JSON.stringify([controlPlane.scope, tagId]), conversation);
}

/** Marks a conversation as shown by a view until the returned function is called. */
export function openConversation(controlPlane: ControlPlane, tagId: string, conversation: string) {
  const entry = key(controlPlane, tagId, conversation);
  open.set(entry, (open.get(entry) ?? 0) + 1);
  return () => {
    const count = (open.get(entry) ?? 1) - 1;
    if (count) open.set(entry, count);
    else open.delete(entry);
  };
}

/**
 * Reads a conversation into the cache unless a view shows it, starting from what is cached, and
 * returns what it read. Concurrent calls for one conversation share a read.
 */
export function warmConversation(
  controlPlane: ControlPlane,
  tagId: string,
  conversation: string,
): Promise<History | undefined> {
  const entry = key(controlPlane, tagId, conversation);
  if (open.has(entry)) return Promise.resolve(memory.get(entry));
  const running = warming.get(entry);
  if (running) return running;
  const read = (async () => {
    try {
      const before = memory.get(entry) ?? (await storedHistory(controlPlane, tagId, conversation));
      const start = before ?? { messages: [], loading: true, read: false };
      const page = await readHistory(
        (cursor) => controlPlane.messages(tagId, conversation, cursor),
        start,
        new AbortController().signal,
      );
      // A view that opened meanwhile has its own read, which is at least as recent.
      if (open.has(entry)) return memory.get(entry);
      const next = latestHistory(start, page);
      cacheHistory(controlPlane, tagId, conversation, next);
      return next;
    } catch {
      return undefined;
    } finally {
      warming.delete(entry);
    }
  })();
  warming.set(entry, read);
  return read;
}

/**
 * Reads the conversation a Tag shows into the cache: the one it last showed, else its newest.
 * Returns that conversation's name.
 */
export async function warmTag(
  controlPlane: ControlPlane,
  tagId: string,
): Promise<string | undefined> {
  let conversation = shownConversation(controlPlane, tagId);
  if (!conversation) {
    try {
      conversation = (await controlPlane.conversations(tagId))[0]?.name;
    } catch {
      return undefined;
    }
    if (!conversation) return undefined;
    showConversation(controlPlane, tagId, conversation);
  }
  await warmConversation(controlPlane, tagId, conversation);
  return conversation;
}

/**
 * Keeps cached conversations current: when the watch reports a change to one no view shows, it is
 * read again, so opening it later shows its latest messages at once.
 */
export function refreshCachedConversations(controlPlane: ControlPlane, feed: WatchFeed) {
  const unsubscribe = feed.subscribe((update: WatchUpdate) => {
    if (update.kind !== "conversation") return;
    if (memory.has(key(controlPlane, update.tagId, update.conversation)))
      void warmConversation(controlPlane, update.tagId, update.conversation);
  });
  return () => {
    unsubscribe();
  };
}

/**
 * Reads ahead the conversation of each Tag but the selected one, one at a time, so selecting a
 * Tag shows its conversation at once, and keeps cached conversations current through the watch.
 */
export function useConversationPrefetch(
  controlPlane: ControlPlane,
  tagIds: readonly string[],
  selected: string | undefined,
  feed: WatchFeed | undefined,
) {
  useEffect(() => feed && refreshCachedConversations(controlPlane, feed), [controlPlane, feed]);
  const others = tagIds
    .filter((tagId) => tagId !== selected)
    .slice(0, PREFETCH_TAGS)
    .join("\n");
  useEffect(() => {
    let stopped = false;
    void (async () => {
      for (const tagId of others.split("\n")) {
        if (stopped || !tagId) return;
        await warmTag(controlPlane, tagId);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [controlPlane, others]);
}

function parseStored(value: unknown, tagId: string, conversation: string): History | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stored = value as Record<string, unknown>;
  if (stored.version !== VERSION || !Array.isArray(stored.messages)) return undefined;
  const messages = stored.messages as Message[];
  const valid = messages.every(
    (message) =>
      message &&
      typeof message === "object" &&
      message.conversation === conversation &&
      typeof message.task?.taskId === "string" &&
      message.task.tagId === tagId &&
      message.task.sessionId === stored.sessionId,
  );
  if (!valid || (messages.length > 0 && typeof stored.sessionId !== "string")) return undefined;
  return {
    messages,
    cursor: typeof stored.cursor === "string" ? stored.cursor : undefined,
    sessionId: typeof stored.sessionId === "string" ? stored.sessionId : undefined,
    head: typeof stored.head === "string" ? stored.head : undefined,
    loading: false,
    read: true,
  };
}

/** Forgets everything cached in memory. For tests. */
export function clearConversationCache() {
  memory.clear();
  shownConversations.clear();
  open.clear();
  for (const timer of pendingWrites.values()) clearTimeout(timer);
  pendingWrites.clear();
  warming.clear();
}
