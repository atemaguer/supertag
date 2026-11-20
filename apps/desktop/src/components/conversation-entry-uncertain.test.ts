// @vitest-environment happy-dom

import type { AttemptDecisionName, Gateway, Message } from "@supertag/client/model";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConversationEntry } from "./conversation-entry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uncertain: Message = {
  order: 1,
  task: {
    taskId: "t1",
    tagId: "lead",
    sessionId: "conversation/1",
    prompt: "Check CI",
    state: "uncertain",
    attemptId: "a1",
  },
};

function render(message: Message, resolveAttempt?: Gateway["resolveAttempt"]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const show = (next: Message) =>
    act(() =>
      root.render(
        createElement(ConversationEntry, { message: next, onActivity: () => {}, resolveAttempt }),
      ),
    );
  show(message);
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((each) => each.textContent === label);
  return {
    host,
    show,
    button,
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it("offers Retry and Mark failed on an uncertain turn, and records the one chosen", async () => {
  const resolve = vi.fn(async (_task: string, _attempt: string, decision: AttemptDecisionName) => ({
    state: decision === "retry" ? "queued" : "failed",
  }));
  const view = render(uncertain, resolve);
  expect(view.host.textContent).toContain("Interrupted: needs attention");
  expect(view.host.textContent).toContain("Your next messages wait until you decide.");
  await act(async () => view.button("Retry")?.click());
  expect(resolve).toHaveBeenCalledWith("t1", "a1", "retry");
  await act(async () => view.button("Mark failed")?.click());
  expect(resolve).toHaveBeenLastCalledWith("t1", "a1", "failed");

  // Once the follow pushes the decided turn, the actions go.
  view.show({ ...uncertain, task: { ...uncertain.task, state: "failed" } });
  expect(view.button("Retry")).toBeUndefined();
  expect(view.button("Mark failed")).toBeUndefined();
  view.close();
});

it("says why a decision was refused, and enables the actions again", async () => {
  let refuse: (reason: string) => void = () => {};
  const resolve = vi.fn(
    () =>
      new Promise<{ state: string }>((_, reject) => {
        refuse = reject;
      }),
  );
  const view = render(uncertain, resolve);
  await act(async () => view.button("Mark failed")?.click());
  expect(view.button("Marking failed…")?.disabled).toBe(true);
  expect(view.button("Retry")?.disabled).toBe(true);
  await act(async () => refuse("Its Worker Host has not confirmed this turn stopped."));
  expect(view.host.querySelector('[role="alert"]')?.textContent).toBe(
    "Its Worker Host has not confirmed this turn stopped.",
  );
  expect(view.button("Retry")?.disabled).toBe(false);
  view.close();
});

it("offers nothing on other turns, or without a way to decide", () => {
  const failed = render({ ...uncertain, task: { ...uncertain.task, state: "failed" } }, vi.fn());
  expect(failed.button("Retry")).toBeUndefined();
  failed.close();
  const readOnly = render(uncertain);
  expect(readOnly.host.textContent).toContain("Interrupted: needs attention");
  expect(readOnly.button("Retry")).toBeUndefined();
  readOnly.close();
});
