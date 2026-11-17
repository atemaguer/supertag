// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "../control-plane";
import { LiveConversationEntry } from "./conversation-entry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HELD =
  "Waiting: Worker Host laptop's only Claude Code slot is held by an uncertain Task Attempt that may have executed. Once you confirm its execution stopped: supertag task resolve-attempt t0 a0 --decision retry --evidence TEXT";

afterEach(() => vi.useRealTimers());

function render(message: Message, readWait: (taskId: string) => Promise<string | null>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const show = (next: Message) =>
    act(() =>
      root.render(
        createElement(LiveConversationEntry, {
          message: next,
          readEvents: async () => [],
          readWait,
          onActivity: () => {},
          onSaveArtifact: async () => false,
        }),
      ),
    );
  show(message);
  return {
    host,
    show,
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it("says why a queued message waits instead of showing only the typing dots", async () => {
  vi.useFakeTimers();
  const queued: Message = {
    order: 1,
    task: { taskId: "t1", tagId: "test", sessionId: "s", prompt: "Hi", state: "queued" },
  };
  const readWait = vi.fn(async () => HELD);
  const view = render(queued, readWait);
  // A turn that starts at once never shows a reason.
  expect(view.host.querySelector(".task-wait")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(readWait).toHaveBeenCalledWith("t1");
  expect(view.host.querySelector(".typing-bubble")).not.toBeNull();
  expect(view.host.querySelector(".task-wait")?.textContent).toBe(HELD);

  // Once it runs, the reason goes and is no longer read.
  view.show({ ...queued, task: { ...queued.task, state: "running" } });
  expect(view.host.querySelector(".task-wait")).toBeNull();
  const reads = readWait.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(readWait).toHaveBeenCalledTimes(reads);
  view.close();
});

it("shows only the dots when the reason cannot be read", async () => {
  vi.useFakeTimers();
  const queued: Message = {
    order: 1,
    task: { taskId: "t2", tagId: "test", sessionId: "s", prompt: "Hi", state: "queued" },
  };
  const view = render(queued, async () => {
    throw new Error("Control Plane unavailable");
  });
  await act(() => vi.advanceTimersByTimeAsync(7_000));
  expect(view.host.querySelector(".typing-bubble")).not.toBeNull();
  expect(view.host.querySelector(".task-wait")).toBeNull();
  view.close();
});
