// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { Message } from "../control-plane";
import { nextWaits } from "../lib/follow";
import { LiveConversationEntry } from "./conversation-entry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HELD =
  "Waiting: Worker Host laptop's only Claude Code slot is held by an uncertain Task Attempt that may have executed. Once you confirm its execution stopped: supertag task resolve-attempt t0 a0 --decision retry --evidence TEXT";

function render(message: Message, wait?: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const show = (next: Message, nextWait = wait) =>
    act(() =>
      root.render(
        createElement(LiveConversationEntry, {
          message: next,
          readEvents: async () => [],
          wait: nextWait,
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

const queued: Message = {
  order: 1,
  task: { taskId: "t1", tagId: "test", sessionId: "s", prompt: "Hi", state: "queued" },
};

it("says why a queued message waits, as the conversation's follow pushes it", () => {
  const view = render(queued);
  // A turn that starts at once never shows a reason.
  expect(view.host.querySelector(".task-wait")).toBeNull();
  view.show(queued, HELD);
  expect(view.host.querySelector(".typing-bubble")).not.toBeNull();
  expect(view.host.querySelector(".task-wait")?.textContent).toBe(HELD);

  // Once it runs, the reason goes even before the follow clears it.
  view.show({ ...queued, task: { ...queued.task, state: "running" } }, HELD);
  expect(view.host.querySelector(".task-wait")).toBeNull();
  view.close();
});

it("keeps the reasons the follow pushes until it clears them", () => {
  const held = nextWaits(new Map(), { kind: "changed", waits: [{ taskId: "t1", reason: HELD }] });
  expect(held.get("t1")).toBe(HELD);
  expect(nextWaits(held, { kind: "changed", messages: undefined })).toBe(held);
  expect(nextWaits(held, { kind: "ready" })).toBe(held);
  const cleared = nextWaits(held, { kind: "changed", waits: [{ taskId: "t1", reason: "" }] });
  expect(cleared.has("t1")).toBe(false);
});
