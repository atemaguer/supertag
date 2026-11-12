import { describe, expect, it, vi } from "vitest";
import type { Message } from "../gateway";
import {
  earlierHistory,
  emptyHistory,
  latestHistory,
  readHistory,
  receivedMessage,
} from "./history";

function message(taskId: string, sessionId = "session"): Message {
  return {
    task: { taskId, sessionId, tagId: "lead", prompt: taskId, state: "succeeded" },
    conversation: "planning",
  };
}

describe("Watch history refresh", () => {
  it("catches up across pages, preserves earlier history and deduplicates a local receipt", async () => {
    let history = latestHistory(emptyHistory, {
      messages: [message("three")],
      nextCursor: "earlier",
    });
    history = earlierHistory(history, history, {
      messages: [message("two")],
      nextCursor: "load-one",
    });
    history = receivedMessage(history, message("six"));
    const read = vi.fn(async (cursor?: string) => {
      switch (cursor) {
        case undefined:
          return { messages: [message("six")], nextCursor: "first" };
        case "first":
          return { messages: [message("five"), message("four")], nextCursor: "second" };
        case "second":
          return { messages: [message("three")], nextCursor: "earlier" };
        default:
          throw new Error("unexpected cursor");
      }
    });
    const fresh = await readHistory(read, history, new AbortController().signal);
    history = latestHistory(history, fresh);
    expect(read.mock.calls).toEqual([[undefined], ["first"], ["second"]]);
    expect(history.messages.map(({ task }) => task.taskId)).toEqual([
      "two",
      "three",
      "four",
      "five",
      "six",
    ]);
    expect(history.cursor).toBe("load-one");
    expect(receivedMessage(history, message("six"))).toBe(history);
  });

  it("does not mix Sessions or merge a delayed older page after replacement", async () => {
    const old = latestHistory(emptyHistory, { messages: [message("old")], nextCursor: "prior" });
    const read = vi.fn(async () => ({
      messages: [message("new", "replacement")],
      nextCursor: "new-page",
    }));
    const page = await readHistory(read, old, new AbortController().signal);
    const current = latestHistory(old, page);
    expect(read).toHaveBeenCalledOnce();
    expect(current.messages).toEqual([message("new", "replacement")]);
    expect(current.cursor).toBe("new-page");
    expect(earlierHistory(current, old, { messages: [message("stale")] })).toBe(current);
  });

  it("stops paging if the view closes during a read", async () => {
    const before = latestHistory(emptyHistory, { messages: [message("old")] });
    const abort = new AbortController();
    const read = vi.fn(async () => {
      abort.abort();
      return { messages: [message("new")], nextCursor: "more" };
    });
    await expect(readHistory(read, before, abort.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledOnce();
  });
});
