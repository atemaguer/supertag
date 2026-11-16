import { describe, expect, it } from "vitest";
import type { Message } from "../control-plane";
import {
  earlierHistory,
  emptyHistory,
  latestHistory,
  receivedMessage,
  refreshRequest,
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
