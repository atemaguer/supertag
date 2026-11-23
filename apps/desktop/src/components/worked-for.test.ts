// @vitest-environment happy-dom

import type { Message } from "@supertag/client/model";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationEntry } from "./conversation-entry";
import { durationWords, workedForMs } from "./worked-for";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const turn = (tookMs?: number, state = "succeeded"): Message => ({
  order: 1,
  task: {
    taskId: "t1",
    tagId: "finch",
    sessionId: "s",
    prompt: "Fix the test",
    state,
    result: state === "succeeded" ? "Fixed." : undefined,
    createdAtMs: 1_000_000,
  },
  ...(tookMs === undefined ? {} : { completedAtMs: 1_000_000 + tookMs }),
});

it("measures a finished turn, and words it in at most two units", () => {
  expect(workedForMs(turn(134_000))).toBe(134_000);
  expect(workedForMs(turn(30_000))).toBe(30_000);
  // Shorter turns, and turns whose times the Gateway did not record, get no pointer.
  expect(workedForMs(turn(29_999))).toBeUndefined();
  expect(workedForMs(turn())).toBeUndefined();
  expect(durationWords(48_000)).toBe("48s");
  expect(durationWords(134_000)).toBe("2m 14s");
  expect(durationWords(120_000)).toBe("2m");
  expect(durationWords(3_780_000)).toBe("1h 3m");
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const pointer = () =>
  [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Worked for"),
  );

it("points from a long turn's reply to its Task activity, and shows no activity itself", () => {
  const onActivity = vi.fn();
  const events = [
    { sequence: 1, kind: "activity" as const, text: "Running cargo test" },
    { sequence: 2, kind: "activity" as const, text: "Reading src/deadline.rs" },
  ];
  act(() =>
    root.render(createElement(ConversationEntry, { message: turn(134_000), events, onActivity })),
  );
  const button = pointer() as HTMLButtonElement;
  expect(button.textContent).toBe("Worked for 2m 14s");
  expect(button.getAttribute("aria-label")).toBe("Worked for 2m 14s · View Task activity");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  // Nothing of what the turn did is in the conversation.
  expect(host.textContent).not.toMatch(/cargo|deadline\.rs/);
  act(() => button.click());
  expect(onActivity).toHaveBeenCalledWith("t1", button);
  // It does not expand in place.
  expect(host.textContent).not.toMatch(/cargo|deadline\.rs/);

  act(() =>
    root.render(
      createElement(ConversationEntry, {
        message: turn(134_000),
        events,
        activeTask: "t1",
        onActivity,
      }),
    ),
  );
  expect(pointer()?.getAttribute("aria-expanded")).toBe("true");
});

it("shows no pointer for a short turn or one still running", () => {
  const onActivity = vi.fn();
  act(() => root.render(createElement(ConversationEntry, { message: turn(12_000), onActivity })));
  expect(pointer()).toBeUndefined();
  act(() =>
    root.render(
      createElement(ConversationEntry, { message: turn(undefined, "running"), onActivity }),
    ),
  );
  expect(pointer()).toBeUndefined();
});
