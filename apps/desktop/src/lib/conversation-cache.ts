import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlPlane, Conversation, Message, WatchUpdate } from "../control-plane";
import { type History, lastOf, latestHistory, refreshRequest, tail, unsettled } from "./history";
import { describe } from "./polling";
import { useWatchRefresh, type WatchFeed } from "./watch";

/**
 * What the app shows at once, before the Control Plane answers: each Tag's conversation (its
 * latest messages) and the conversation list with the selected Tag. Every entry belongs to one
 * Control Plane and principal (`ControlPlane.scope`), so another connection never sees it. The
 * most recent conversations stay in memory; each entry is also written to disk through the
 * native app, which keeps it owner-only in the app's data directory.
 */

/** What every disk entry records; an entry written with another schema is discarded. */
export const SCHEMA_VERSION = 1;
/** How many conversations stay in memory. */
const MEMORY_ENTRIES = 32;
/** How long a changed entry waits before it is written to disk, to coalesce bursts. */
const WRITE_DELAY = 500;
/** How many Tags have their conversation read ahead when the app connects. */
const PREFETCH_TAGS = 16;

interface Stored<T> {
  schemaVersion: number;
  value: T;
}

/** The value of a disk entry written with this schema, if it is one. */
export function storedValue(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return undefined;
  const value = entry as Partial<Stored<unknown>>;
  return value.schemaVersion === SCHEMA_VERSION ? value.value : undefined;
}

export function stored<T>(value: T): Stored<T> {
  return { schemaVersion: SCHEMA_VERSION, value };
}

const memory = new Map<string, History>();
/** Conversations a view shows now. A view keeps its own conversation current. */
const open = new Map<string, number>();
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const warming = new Map<string, Promise<History | undefined>>();
const rosters = new Map<string, Roster>();
/** The latest read mark sent per scope and Tag, so one is sent once. */
const marks = new Map<string, number>();

function key(controlPlane: ControlPlane, tagId: string) {
  return JSON.stringify([controlPlane.scope, tagId]);
}

function remember(entry: string, history: History) {
  memory.delete(entry);
  memory.set(entry, history);
  for (const oldest of memory.keys()) {
    if (memory.size <= MEMORY_ENTRIES) break;
    memory.delete(oldest);
  }
}

function later(entry: string, write: () => void) {
  clearTimeout(pendingWrites.get(entry));
  pendingWrites.set(
    entry,
    setTimeout(() => {
      pendingWrites.delete(entry);
      write();
    }, WRITE_DELAY),
  );
}

/** The Tag's conversation as it was last shown, from memory. */
export function cachedHistory(controlPlane: ControlPlane, tagId: string): History | undefined {
  const entry = memory.get(key(controlPlane, tagId));
  return entry && { ...entry, loading: false };
}

/** The Tag's conversation as the disk holds it, if it holds a valid copy. */
export async function storedHistory(
  controlPlane: ControlPlane,
  tagId: string,
): Promise<History | undefined> {
  try {
    const history = parseHistory(storedValue(await controlPlane.readCache(`tag:${tagId}`)), tagId);
    if (history && !memory.has(key(controlPlane, tagId)))
      remember(key(controlPlane, tagId), history);
    return history;
  } catch {
    return undefined;
  }
}

/** Records what the Tag's conversation shows now: in memory at once, its tail on disk soon. */
export function cacheHistory(controlPlane: ControlPlane, tagId: string, history: History) {
  if (!history.read) return;
  const entry = key(controlPlane, tagId);
  remember(entry, history);
  later(entry, () => {
    const latest = memory.get(entry);
    if (!latest) return;
    const { messages, cursor, conversationId } = tail(latest);
    void controlPlane
      .writeCache(`tag:${tagId}`, stored({ messages, cursor, conversationId }))
      .catch(() => {});
  });
}

/** Marks the Tag's conversation as shown by a view until the returned function is called. */
export function openConversation(controlPlane: ControlPlane, tagId: string) {
  const entry = key(controlPlane, tagId);
  open.set(entry, (open.get(entry) ?? 0) + 1);
  return () => {
    const count = (open.get(entry) ?? 1) - 1;
    if (count) open.set(entry, count);
    else open.delete(entry);
  };
}

/**
 * Brings the Tag's cached conversation up to date unless a view shows it, reading only what
 * changed since the cached copy. Concurrent calls for one Tag share a read.
 */
export function warmConversation(
  controlPlane: ControlPlane,
  tagId: string,
): Promise<History | undefined> {
  const entry = key(controlPlane, tagId);
  if (open.has(entry)) return Promise.resolve(memory.get(entry));
  const running = warming.get(entry);
  if (running) return running;
  const read = (async () => {
    try {
      const before = memory.get(entry) ?? (await storedHistory(controlPlane, tagId));
      const start = before ?? { messages: [], loading: true, read: false };
      const page = await controlPlane.messages(refreshRequest(tagId, start));
      // A view that opened meanwhile has its own read, which is at least as recent.
      if (open.has(entry)) return memory.get(entry);
      const next = latestHistory(start, page);
      cacheHistory(controlPlane, tagId, next);
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
 * Keeps cached conversations current: when the watch reports a change to one no view shows, only
 * what changed is read, so opening it later shows its latest messages at once.
 */
export function refreshCachedConversations(controlPlane: ControlPlane, feed: WatchFeed) {
  const unsubscribe = feed.subscribe((update: WatchUpdate) => {
    if (update.kind === "conversation" && memory.has(key(controlPlane, update.tagId)))
      void warmConversation(controlPlane, update.tagId);
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
        await warmConversation(controlPlane, tagId);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [controlPlane, others]);
}

/** The conversation list, and the Tag the app showed last. */
export interface Roster {
  conversations: Conversation[];
  selectedTag?: string;
}

/** The roster as the app last showed it on this connection's Control Plane, from memory. */
export function cachedRoster(controlPlane: ControlPlane): Roster | undefined {
  return rosters.get(controlPlane.scope);
}

/** The roster as the disk holds it, if it holds a valid one. */
export async function storedRoster(controlPlane: ControlPlane): Promise<Roster | undefined> {
  try {
    const roster = parseRoster(storedValue(await controlPlane.readCache("roster")));
    if (roster && !rosters.has(controlPlane.scope)) rosters.set(controlPlane.scope, roster);
    return rosters.get(controlPlane.scope);
  } catch {
    return undefined;
  }
}

/** Records a change to the roster, in memory at once and on disk soon. */
export function cacheRoster(controlPlane: ControlPlane, change: Partial<Roster>) {
  const roster = { conversations: [], ...rosters.get(controlPlane.scope), ...change };
  rosters.set(controlPlane.scope, roster);
  later(JSON.stringify([controlPlane.scope, "roster"]), () => {
    const latest = rosters.get(controlPlane.scope);
    if (latest) void controlPlane.writeCache("roster", stored(latest)).catch(() => {});
  });
}

/** How often the conversation list is read while the watch is not live. */
const LIST_INTERVAL = 5_000;
const conversationChanged = (update: WatchUpdate) => update.kind === "conversation";

/**
 * The caller's conversation with each Tag: from the cache at once, then from the Control Plane,
 * read again when the watch reports a conversation changed or was read.
 */
export function useConversationList(controlPlane: ControlPlane, feed: WatchFeed | undefined) {
  const [conversations, setConversations] = useState(
    () => cachedRoster(controlPlane)?.conversations ?? [],
  );
  const [error, setError] = useState("");
  const read = useRef(false);
  useEffect(() => {
    read.current = false;
    if (cachedRoster(controlPlane)) return;
    void storedRoster(controlPlane).then((roster) => {
      if (roster && !read.current) setConversations(roster.conversations);
    });
  }, [controlPlane]);
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await controlPlane.conversations();
        if (signal.aborted) return;
        read.current = true;
        setConversations(next);
        setError("");
        cacheRoster(controlPlane, { conversations: next });
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
        return false;
      }
    },
    [controlPlane],
  );
  useWatchRefresh(refresh, LIST_INTERVAL, feed, conversationChanged);
  return { conversations, error };
}

/**
 * Records that the caller has read the Tag's conversation up to its latest finished turn, when
 * that is later than the mark the Control Plane has.
 */
export function markShown(controlPlane: ControlPlane, tagId: string, history: History) {
  const latest = lastOf(history.messages, (message) => message.order > 0 && !unsettled(message));
  if (!latest) return;
  const known = cachedRoster(controlPlane)?.conversations.find((entry) => entry.tagId === tagId);
  const marked = JSON.stringify([controlPlane.scope, tagId]);
  if (Math.max(known?.readOrder ?? 0, marks.get(marked) ?? 0) >= latest.order) return;
  marks.set(marked, latest.order);
  void controlPlane
    .markRead(tagId, latest.order)
    .then((conversation) => {
      const roster = cachedRoster(controlPlane);
      if (roster)
        cacheRoster(controlPlane, {
          conversations: roster.conversations.map((entry) =>
            entry.tagId === tagId ? conversation : entry,
          ),
        });
    })
    .catch(() => marks.delete(marked));
}

function parseHistory(value: unknown, tagId: string): History | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (!Array.isArray(entry.messages) || typeof entry.conversationId !== "string") return undefined;
  const messages = entry.messages as Message[];
  const valid = messages.every(
    (message) =>
      message &&
      typeof message === "object" &&
      typeof message.order === "number" &&
      typeof message.task?.taskId === "string" &&
      message.task.tagId === tagId,
  );
  if (!valid) return undefined;
  return {
    messages,
    cursor: typeof entry.cursor === "string" ? entry.cursor : undefined,
    conversationId: entry.conversationId,
    loading: false,
    read: true,
  };
}

function parseRoster(value: unknown): Roster | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (!Array.isArray(entry.conversations)) return undefined;
  const conversations = entry.conversations as Conversation[];
  if (!conversations.every((conversation) => typeof conversation?.tagId === "string"))
    return undefined;
  return {
    conversations,
    selectedTag: typeof entry.selectedTag === "string" ? entry.selectedTag : undefined,
  };
}

/** Forgets everything cached in memory. For tests. */
export function clearConversationCache() {
  memory.clear();
  open.clear();
  rosters.clear();
  marks.clear();
  for (const timer of pendingWrites.values()) clearTimeout(timer);
  pendingWrites.clear();
  warming.clear();
}
