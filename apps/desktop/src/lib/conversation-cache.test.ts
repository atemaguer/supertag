import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  CacheKey,
  Conversation,
  Gateway,
  Message,
  MessagePage,
  ReadMessages,
} from "../gateway";
import {
  cachedHistory,
  cachedRoster,
  cacheHistory,
  cacheRoster,
  clearConversationCache,
  markShown,
  openConversation,
  refreshCachedConversations,
  SCHEMA_VERSION,
  storedHistory,
  storedRoster,
  warmConversation,
} from "./conversation-cache";
import { TAIL } from "./history";
import { watchFeed } from "./watch";

function message(taskId: string, order: number, state = "succeeded"): Message {
  return {
    order,
    task: { taskId, tagId: "lead", sessionId: "conversation/one", prompt: taskId, state },
    events: [{ sequence: 1, kind: "message", text: `Working on ${taskId}` }],
  };
}

function summary(readOrder = 0): Conversation {
  return {
    tagId: "lead",
    conversationId: "c1",
    preview: "done",
    previewFromTag: true,
    lastActivityAtMs: 1,
    latestOrder: 2,
    readOrder,
    unreadCount: readOrder ? 0 : 1,
    working: false,
  };
}

function gateway(scope: string, pages: MessagePage[] = []) {
  const disk = new Map<CacheKey, unknown>();
  const messages = vi.fn(
    async (_read: ReadMessages) => pages.shift() ?? { conversationId: "c1", messages: [] },
  );
  const markRead = vi.fn(async (_tagId: string, order: number) => summary(order));
  const plane: Gateway = {
    scope,
    tags: async () => [],
    conversations: async () => [summary()],
    messages,
    send: async () => message("sent", 9),
    markRead,
    events: async () => [],
    readCache: async (key) => disk.get(key),
    writeCache: async (key, value) => {
      disk.set(key, structuredClone(value));
    },
  };
  return { plane, disk, messages, markRead };
}

beforeEach(() => clearConversationCache());
afterEach(() => vi.useRealTimers());

it("shows a cached conversation only to the Gateway and principal that read it", async () => {
  const alice = gateway(JSON.stringify(["https://one.example.com", "operator:alice"]), [
    { conversationId: "c1", messages: [message("t2", 2), message("t1", 1)] },
  ]);
  const bob = gateway(JSON.stringify(["https://one.example.com", "client:bob"]));
  const elsewhere = gateway(JSON.stringify(["https://two.example.com", "operator:alice"]));
  const read = await warmConversation(alice.plane, "lead");
  expect(read?.messages.map(({ task }) => task.taskId)).toEqual(["t1", "t2"]);
  const cached = cachedHistory(alice.plane, "lead");
  expect(cached).toMatchObject({ loading: false, read: true, conversationId: "c1" });
  expect(cached?.messages[0]?.events?.[0]?.text).toBe("Working on t1");
  expect(cachedHistory(bob.plane, "lead")).toBeUndefined();
  expect(cachedHistory(elsewhere.plane, "lead")).toBeUndefined();
});

it("writes the conversation's versioned tail once a burst settles and reads it back", async () => {
  vi.useFakeTimers();
  const { plane, disk } = gateway("scope");
  const messages = Array.from({ length: TAIL + 2 }, (_, index) => message(`t${index}`, index + 1));
  const history = { messages, conversationId: "c1", loading: false, read: true };
  cacheHistory(plane, "lead", { ...history, messages: [] });
  cacheHistory(plane, "lead", history);
  // A history not yet read from the Gateway is never cached.
  cacheHistory(plane, "other", { ...history, read: false });
  expect(disk.size).toBe(0);
  await vi.runAllTimersAsync();
  expect([...disk.keys()]).toEqual(["tag:lead"]);
  expect(disk.get("tag:lead")).toMatchObject({ schemaVersion: SCHEMA_VERSION });
  clearConversationCache();
  const restored = await storedHistory(plane, "lead");
  expect(restored?.messages).toHaveLength(TAIL);
  expect(restored?.cursor).toBe("3");
  // Reading from disk also fills memory.
  expect(cachedHistory(plane, "lead")?.messages).toHaveLength(TAIL);
});

it("discards a disk entry of another schema or another Tag", async () => {
  const { plane, disk } = gateway("scope");
  disk.set("tag:lead", {
    schemaVersion: SCHEMA_VERSION + 1,
    value: { conversationId: "c1", messages: [] },
  });
  expect(await storedHistory(plane, "lead")).toBeUndefined();
  disk.set("tag:lead", {
    schemaVersion: SCHEMA_VERSION,
    value: {
      conversationId: "c1",
      messages: [{ ...message("t1", 1), task: { ...message("t1", 1).task, tagId: "other" } }],
    },
  });
  expect(await storedHistory(plane, "lead")).toBeUndefined();
  disk.set("tag:lead", "not an entry");
  expect(await storedHistory(plane, "lead")).toBeUndefined();
});

it("revalidates only what changed and leaves an open conversation to its view", async () => {
  const { plane, messages } = gateway("scope", [
    { conversationId: "c1", messages: [message("t1", 1, "running")] },
    { conversationId: "c1", incremental: true, messages: [message("t2", 2), message("t1", 1)] },
  ]);
  await warmConversation(plane, "lead");
  const close = openConversation(plane, "lead");
  await warmConversation(plane, "lead");
  expect(messages).toHaveBeenCalledOnce();
  close();
  const [first, second] = await Promise.all([
    warmConversation(plane, "lead"),
    warmConversation(plane, "lead"),
  ]);
  expect(first).toBe(second);
  expect(messages.mock.calls[1]?.[0]).toEqual({
    tagId: "lead",
    after: 1,
    conversationId: "c1",
    refreshTaskIds: ["t1"],
  });
  expect(cachedHistory(plane, "lead")?.messages.map(({ task }) => task.taskId)).toEqual([
    "t1",
    "t2",
  ]);
});

it("rereads cached conversations the watch reports", async () => {
  const { plane, messages } = gateway("scope", [
    { conversationId: "c1", messages: [message("t1", 1)] },
    { conversationId: "c1", incremental: true, messages: [message("t2", 2)] },
  ]);
  await warmConversation(plane, "lead");
  const feed = watchFeed();
  const stop = refreshCachedConversations(plane, feed);
  feed.publish({ kind: "conversation", tagId: "other" });
  feed.publish({ kind: "conversation", tagId: "lead" });
  await vi.waitFor(() => expect(cachedHistory(plane, "lead")?.messages).toHaveLength(2));
  expect(messages).toHaveBeenCalledTimes(2);
  stop();
});

it("keeps the roster and selection per scope, and marks the latest finished turn read once", async () => {
  vi.useFakeTimers();
  const { plane, disk, markRead } = gateway("scope");
  cacheRoster(plane, { conversations: [summary()] });
  cacheRoster(plane, { selectedTag: "lead" });
  await vi.runAllTimersAsync();
  expect(disk.get("roster")).toMatchObject({ value: { selectedTag: "lead" } });
  clearConversationCache();
  expect(cachedRoster(plane)).toBeUndefined();
  expect((await storedRoster(plane))?.conversations[0]?.unreadCount).toBe(1);
  const history = {
    messages: [message("t1", 1), message("t2", 2), message("t3", 3, "running")],
    conversationId: "c1",
    loading: false,
    read: true,
  };
  markShown(plane, "lead", history);
  markShown(plane, "lead", history);
  await vi.runAllTimersAsync();
  expect(markRead.mock.calls).toEqual([["lead", 2]]);
  expect(cachedRoster(plane)?.conversations[0]?.readOrder).toBe(2);
});
