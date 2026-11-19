// @vitest-environment happy-dom

import type { Message } from "@supertag/client/model";
import { nextWaits } from "@supertag/client/react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
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

  // A running turn that waits for the Worker Host holding its Session's last delivery says so.
  const holder =
    "Waiting for Worker Host laptop, which holds this Session's last delivery and is not connected to the Control Plane; start that host, or cancel the Task";
  view.show(
    { ...queued, task: { ...queued.task, state: "running", waitingForHolder: "laptop" } },
    holder,
  );
  expect(view.host.querySelector(".task-wait")?.textContent).toBe(holder);
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
