import type { Message, MessagePage } from "../control-plane";

export interface History {
  messages: Message[];
  cursor?: string;
  sessionId?: string;
  head?: string;
  loading: boolean;
  read: boolean;
}

export const emptyHistory: History = { messages: [], loading: true, read: false };

// Read back to the last authoritative head. A local send receipt may already
// be visible in the newest page even while earlier arrivals need to be read.
export async function readHistory(
  read: (cursor?: string) => Promise<MessagePage>,
  before: History,
  signal: AbortSignal,
): Promise<MessagePage> {
  let cursor: string | undefined;
  let sessionId: string | undefined;
  const messages: Message[] = [];
  const seen = new Set<string>();
  for (;;) {
    signal.throwIfAborted();
    const next = await read(cursor);
    signal.throwIfAborted();
    sessionId ??= next.messages[0]?.task.sessionId;
    if (next.messages.some(({ task }) => task.sessionId !== sessionId)) {
      throw new Error("The conversation changed while loading its history.");
    }
    messages.push(...next.messages);
    if (
      !before.read ||
      (before.sessionId && sessionId !== before.sessionId) ||
      !next.nextCursor ||
      next.messages.some(({ task }) => task.taskId === before.head)
    ) {
      return { messages, nextCursor: next.nextCursor };
    }
    if (seen.has(next.nextCursor)) throw new Error("The Control Plane repeated a history cursor.");
    seen.add(next.nextCursor);
    cursor = next.nextCursor;
  }
}

export function latestHistory(before: History, page: MessagePage): History {
  const head = page.messages[0]?.task;
  if (!head) return { ...emptyHistory, read: true, loading: false };
  const incoming = [
    ...new Map(page.messages.map((message) => [message.task.taskId, message])).values(),
  ].reverse();
  if (!before.sessionId || before.sessionId !== head.sessionId) {
    return {
      messages: incoming,
      cursor: page.nextCursor || undefined,
      sessionId: head.sessionId,
      head: head.taskId,
      loading: false,
      read: true,
    };
  }
  const inPage = new Set(incoming.map(({ task }) => task.taskId));
  const common = before.messages.findIndex(({ task }) => inPage.has(task.taskId));
  const anchor = common < 0 ? before.messages.length : common;
  return {
    ...before,
    head: head.taskId,
    loading: false,
    read: true,
    cursor: before.read ? before.cursor : page.nextCursor || undefined,
    messages: [
      ...before.messages.slice(0, anchor),
      ...incoming,
      ...before.messages.slice(anchor).filter(({ task }) => !inPage.has(task.taskId)),
    ],
  };
}

export function earlierHistory(before: History, expected: History, page: MessagePage): History {
  if (before.sessionId !== expected.sessionId || before.cursor !== expected.cursor) return before;
  if (page.messages.some(({ task }) => task.sessionId !== expected.sessionId)) return before;
  const messages = [
    ...new Map(
      [...[...page.messages].reverse(), ...before.messages].map((message) => [
        message.task.taskId,
        message,
      ]),
    ).values(),
  ];
  return { ...before, messages, cursor: page.nextCursor || undefined };
}

export function receivedMessage(before: History, message: Message): History {
  const { sessionId, taskId } = message.task;
  if (
    (before.sessionId && before.sessionId !== sessionId) ||
    before.messages.some(({ task }) => task.taskId === taskId)
  )
    return before;
  return { ...before, messages: before.messages.concat(message), loading: false, sessionId };
}
