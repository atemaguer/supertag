import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlPlane, Message, MessagePage } from "../control-plane";
import {
  cachedHistory,
  cacheHistory,
  clearConversationCache,
  openConversation,
  refreshCachedConversations,
  storedHistory,
  warmConversation,
  warmTag,
} from "./conversation-cache";
import { watchFeed } from "./watch";

function message(taskId: string, sessionId = "conversation/one"): Message {
  return {
    conversation: "default",
    task: { taskId, tagId: "lead", sessionId, prompt: taskId, state: "succeeded", result: "done" },
    events: [{ sequence: 1, kind: "message", text: `Working on ${taskId}` }],
  };
}

function controlPlane(scope: string, pages: MessagePage[] = []) {
  const disk = new Map<string, unknown>();
  const messages = vi.fn(async () => pages.shift() ?? { messages: [] });
  const plane: ControlPlane = {
    scope,
    tags: async () => [],
    conversations: vi.fn(async () => [{ tagId: "lead", name: "default", sessionId: "s" }]),
    messages,
    send: async () => message("sent"),
    events: async () => [],
    saveArtifact: async () => false,
    readCache: async (tagId, conversation) => disk.get(`${tagId}/${conversation}`),
    writeCache: async (tagId, conversation, value) => {
      disk.set(`${tagId}/${conversation}`, structuredClone(value));
    },
  };
  return { plane, disk, messages };
}

beforeEach(() => clearConversationCache());
afterEach(() => vi.useRealTimers());

it("shows a cached conversation only to the Control Plane and principal that read it", async () => {
  const alice = controlPlane(JSON.stringify(["https://one.example.com", "operator:alice"]), [
    { messages: [message("t2"), message("t1")] },
  ]);
  const bob = controlPlane(JSON.stringify(["https://one.example.com", "client:bob"]));
  const elsewhere = controlPlane(JSON.stringify(["https://two.example.com", "operator:alice"]));
  const read = await warmConversation(alice.plane, "lead", "default");
  expect(read?.messages.map(({ task }) => task.taskId)).toEqual(["t1", "t2"]);
  const cached = cachedHistory(alice.plane, "lead", "default");
  expect(cached).toMatchObject({ loading: false, read: true, head: "t2" });
  expect(cached?.messages[0]?.events?.[0]?.text).toBe("Working on t1");
  expect(cachedHistory(bob.plane, "lead", "default")).toBeUndefined();
  expect(cachedHistory(elsewhere.plane, "lead", "default")).toBeUndefined();
});

it("writes a changed conversation to disk once a burst settles and reads it back", async () => {
  vi.useFakeTimers();
  const { plane, disk } = controlPlane("scope");
  const history = {
    messages: [message("t1")],
    sessionId: "conversation/one",
    head: "t1",
    loading: false,
    read: true,
  };
  cacheHistory(plane, "lead", "default", { ...history, messages: [] });
  cacheHistory(plane, "lead", "default", history);
  // A history not yet read from the Control Plane is never cached.
  cacheHistory(plane, "lead", "other", { ...history, read: false });
  expect(disk.size).toBe(0);
  await vi.runAllTimersAsync();
  expect([...disk.keys()]).toEqual(["lead/default"]);
  clearConversationCache();
  expect(cachedHistory(plane, "lead", "default")).toBeUndefined();
  expect(await storedHistory(plane, "lead", "default")).toMatchObject({
    head: "t1",
    read: true,
    messages: [{ task: { taskId: "t1" } }],
  });
  // Reading from disk also fills memory.
  expect(cachedHistory(plane, "lead", "default")?.head).toBe("t1");
});

it("ignores a disk entry that does not belong to the conversation", async () => {
  const { plane, disk } = controlPlane("scope");
  disk.set("lead/default", { version: 1, messages: [message("t1")], sessionId: "other" });
  expect(await storedHistory(plane, "lead", "default")).toBeUndefined();
  disk.set("lead/default", { version: 2, messages: [], sessionId: "conversation/one" });
  expect(await storedHistory(plane, "lead", "default")).toBeUndefined();
  disk.set("lead/default", "not a history");
  expect(await storedHistory(plane, "lead", "default")).toBeUndefined();
});

it("revalidates from the cached head and leaves an open conversation to its view", async () => {
  const { plane, messages } = controlPlane("scope", [
    { messages: [message("t1")] },
    { messages: [message("t2"), message("t1")] },
  ]);
  await warmConversation(plane, "lead", "default");
  const close = openConversation(plane, "lead", "default");
  await warmConversation(plane, "lead", "default");
  expect(messages).toHaveBeenCalledOnce();
  close();
  const [first, second] = await Promise.all([
    warmConversation(plane, "lead", "default"),
    warmConversation(plane, "lead", "default"),
  ]);
  expect(first).toBe(second);
  expect(messages).toHaveBeenCalledTimes(2);
  expect(cachedHistory(plane, "lead", "default")?.messages.map(({ task }) => task.taskId)).toEqual([
    "t1",
    "t2",
  ]);
});

it("warms a Tag's newest conversation and rereads cached ones the watch reports", async () => {
  const { plane, messages } = controlPlane("scope", [
    { messages: [message("t1")] },
    { messages: [message("t2"), message("t1")] },
  ]);
  expect(await warmTag(plane, "lead")).toBe("default");
  const feed = watchFeed();
  const stop = refreshCachedConversations(plane, feed);
  feed.publish({ kind: "conversation", tagId: "other", conversation: "default" });
  feed.publish({ kind: "conversation", tagId: "lead", conversation: "default" });
  await vi.waitFor(() => expect(cachedHistory(plane, "lead", "default")?.head).toBe("t2"));
  expect(messages).toHaveBeenCalledTimes(2);
  stop();
});
