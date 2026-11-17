import type { Message, MessagePage, ReadMessages } from "../control-plane";

/**
 * The part of a conversation the app holds, oldest first. A read that starts from it asks only
 * for what changed since its latest message.
 */
export interface History {
  messages: Message[];
  /** Reads the messages before the oldest held, when there are any. */
  cursor?: string;
  /** The conversation the messages came from. A page from another one replaces them. */
  conversationId?: string;
  loading: boolean;
  /** The messages came from the Control Plane, at least once. */
  read: boolean;
}

export const emptyHistory: History = { messages: [], loading: true, read: false };

/** How many messages a cached copy keeps: the conversation's latest. */
export const TAIL = 50;

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

/** A message the Control Plane will still change: its turn has not finished. */
export function unsettled(message: Message) {
  return !FINISHED.has(message.task.state);
}

/** What to read to bring `history` up to date: only what changed, once it holds a copy. */
export function refreshRequest(tagId: string, history: History): ReadMessages {
  const latest = lastOf(history.messages, ({ order }) => order > 0);
  if (!history.read || !history.conversationId || !latest) return { tagId };
  return {
    tagId,
    after: latest.order,
    conversationId: history.conversationId,
    refreshTaskIds: history.messages
      .filter((message) => message.order > 0 && unsettled(message))
      .map(({ task }) => task.taskId)
      .slice(-128),
  };
}

/**
 * Applies a read to the history. Changes merge into it by Task; any other page is the newest
 * and replaces it.
 */
export function latestHistory(before: History, page: MessagePage): History {
  const incoming = [...page.messages].reverse();
  if (page.incremental && before.conversationId === page.conversationId) {
    return {
      ...before,
      loading: false,
      read: true,
      messages: ordered(before.messages, incoming),
    };
  }
  return {
    messages: ordered([], incoming),
    cursor: page.nextCursor || undefined,
    conversationId: page.conversationId || undefined,
    loading: false,
    read: true,
  };
}

/** Adds a page of earlier messages read with `expected.cursor`. */
export function earlierHistory(before: History, expected: History, page: MessagePage): History {
  if (before.conversationId !== expected.conversationId || before.cursor !== expected.cursor)
    return before;
  if (page.conversationId && page.conversationId !== before.conversationId) return before;
  return {
    ...before,
    messages: ordered([...page.messages].reverse(), before.messages),
    cursor: page.nextCursor || undefined,
  };
}

/** Adds the Control Plane's receipt for a message sent here, unless the history holds it. */
export function receivedMessage(before: History, message: Message): History {
  if (before.messages.some(({ task }) => task.taskId === message.task.taskId)) return before;
  return { ...before, messages: ordered(before.messages, [message]), loading: false };
}

/** The history's latest `TAIL` messages, which still read the earlier ones through a cursor. */
export function tail(history: History): History {
  if (history.messages.length <= TAIL) return history;
  const messages = history.messages.slice(-TAIL);
  const oldest = messages[0]?.order;
  return { ...history, messages, cursor: oldest ? String(oldest) : undefined };
}

/**
 * Each Task once, the latest copy winning, ordered by the conversation. A turn that finished
 * quietly leaves: the Control Plane sends it only to a copy that held it running.
 */
function ordered(earlier: readonly Message[], later: readonly Message[]): Message[] {
  const byTask = new Map<string, Message>();
  for (const message of [...earlier, ...later]) byTask.set(message.task.taskId, message);
  return [...byTask.values()]
    .filter((message) => !message.task.quiet)
    .sort((a, b) => a.order - b.order);
}

/** The last message that matches. */
export function lastOf(
  messages: readonly Message[],
  matches: (message: Message) => boolean,
): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && matches(message)) return message;
  }
  return undefined;
}
