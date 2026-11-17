import { describe, expect, it } from "vitest";
import type { Message } from "../control-plane";
import {
  earlierHistory,
  emptyHistory,
  latestHistory,
  receivedMessage,
  refreshRequest,
  shownMessages,
  TAIL,
  tail,
} from "./history";

function message(taskId: string, order: number, state = "succeeded"): Message {
  return {
    order,
    task: { taskId, sessionId: "conversation/one", tagId: "lead", prompt: taskId, state },
  };
}

const ids = (messages: readonly Message[]) => messages.map(({ task }) => task.taskId);

describe("conversation history", () => {
  it("asks only for what changed once it holds a copy, and merges the changes", () => {
    expect(refreshRequest("lead", emptyHistory)).toEqual({ tagId: "lead" });
    let history = latestHistory(emptyHistory, {
      conversationId: "c1",
      messages: [message("three", 3, "running"), message("two", 2)],
      nextCursor: "2",
    });
    expect(ids(history.messages)).toEqual(["two", "three"]);
    expect(history.cursor).toBe("2");
    expect(refreshRequest("lead", history)).toEqual({
      tagId: "lead",
      after: 3,
      conversationId: "c1",
      refreshTaskIds: ["three"],
    });
    // The running turn finished and a new message arrived; earlier messages stay.
    history = latestHistory(history, {
      conversationId: "c1",
      incremental: true,
      messages: [message("four", 4), message("three", 3)],
    });
    expect(ids(history.messages)).toEqual(["two", "three", "four"]);
    expect(history.messages[1]?.task.state).toBe("succeeded");
    expect(history.cursor).toBe("2");
  });

  it("replaces its copy with a page of another conversation or a newest page", () => {
    const old = latestHistory(emptyHistory, {
      conversationId: "c1",
      messages: [message("old", 1)],
    });
    const replaced = latestHistory(old, {
      conversationId: "c2",
      incremental: true,
      messages: [message("new", 1)],
      nextCursor: "1",
    });
    expect(ids(replaced.messages)).toEqual(["new"]);
    expect(replaced.conversationId).toBe("c2");
    // A page read for the replaced copy is not merged into the new one.
    expect(earlierHistory(replaced, old, { conversationId: "c1", messages: [] })).toBe(replaced);
    const newest = latestHistory(old, { conversationId: "c1", messages: [message("later", 9)] });
    expect(ids(newest.messages)).toEqual(["later"]);
  });

  it("adds earlier pages and receipts in conversation order, once each", () => {
    let history = latestHistory(emptyHistory, {
      conversationId: "c1",
      messages: [message("three", 3)],
      nextCursor: "3",
    });
    history = earlierHistory(history, history, {
      conversationId: "c1",
      messages: [message("two", 2), message("one", 1)],
    });
    expect(ids(history.messages)).toEqual(["one", "two", "three"]);
    expect(history.cursor).toBeUndefined();
    history = receivedMessage(history, message("four", 4, "queued"));
    expect(receivedMessage(history, message("four", 4))).toBe(history);
    expect(ids(history.messages)).toEqual(["one", "two", "three", "four"]);
  });

  it("keeps its latest messages as the cached tail, which still pages back", () => {
    const messages = Array.from({ length: TAIL + 5 }, (_, index) =>
      message(`m${index + 1}`, index + 1),
    );
    const full = latestHistory(emptyHistory, {
      conversationId: "c1",
      messages: [...messages].reverse(),
    });
    const kept = tail(full);
    expect(kept.messages).toHaveLength(TAIL);
    expect(kept.messages[0]?.task.taskId).toBe("m6");
    expect(kept.cursor).toBe("6");
    expect(tail(kept)).toBe(kept);
  });
});

describe("a Schedule's wake-up", () => {
  it("shows only once it finishes, while the history still refreshes it", () => {
    const hello = message("hello", 1);
    const wake = { ...message("wake", 2, "running"), scheduleId: "schedule" };
    const history = { messages: [hello, wake], conversationId: "c", loading: false, read: true };
    expect(ids(shownMessages(history.messages))).toEqual(["hello"]);
    expect(refreshRequest("lead", history).refreshTaskIds).toEqual(["wake"]);
    for (const state of ["queued", "claimed", "uncertain"])
      expect(ids(shownMessages([{ ...wake, task: { ...wake.task, state } }]))).toEqual([]);
    const posted = { ...wake, task: { ...wake.task, state: "succeeded", result: "CI is red" } };
    expect(ids(shownMessages([hello, posted]))).toEqual(["hello", "wake"]);
    // A person's message joining it makes it their answer: it shows at once.
    for (const state of ["pending", "dispatching", "accepted", "unknown"]) {
      const joined = { ...message("ask", 3, "queued"), liveInput: { taskId: "wake", state } };
      expect(ids(shownMessages([hello, wake, joined]))).toEqual(["hello", "wake", "ask"]);
    }
    const withdrawn = {
      ...message("ask", 3, "queued"),
      liveInput: { taskId: "wake", state: "withdrawn" },
    };
    expect(ids(shownMessages([hello, wake, withdrawn]))).toEqual(["hello", "ask"]);
    // A person's running turn shows at once.
    expect(ids(shownMessages([message("ask", 3, "running")]))).toEqual(["ask"]);
  });
});
