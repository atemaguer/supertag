// @vitest-environment happy-dom
import type { Alert, Conversation } from "@supertag/client/model";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Notifier, readLevel, saveLevel, useDesktopNotifications } from "./notifications";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conversation = (tagId: string, extra: Partial<Conversation> = {}): Conversation => ({
  tagId,
  conversationId: `conversation-${tagId}`,
  preview: "",
  previewFromTag: true,
  lastActivityAtMs: 1,
  latestOrder: 1,
  readOrder: 1,
  unreadCount: 0,
  working: false,
  ...extra,
});
const reply = conversation("lead", {
  latestOrder: 2,
  unreadCount: 1,
  preview: "The fix for #412 is ready for review\nDetails follow",
});

beforeEach(() => localStorage.clear());

it("saves the device's level, and forgets it at the default", () => {
  expect(readLevel()).toBe("all");
  saveLevel("questions");
  expect(readLevel()).toBe("questions");
  saveLevel("all");
  expect(localStorage.getItem("supertag.desktop.notifications")).toBeNull();
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

it("shows notifications from fresh reads, keeps the badge, and opens a clicked Tag", () => {
  const shown: Alert[] = [];
  const badges: number[] = [];
  let click: ((tagId: string) => void) | undefined;
  const notifier: Notifier = {
    show: (alert) => shown.push(alert),
    badge: (count) => badges.push(count),
    clicks(open) {
      click = open;
      return () => {
        click = undefined;
      };
    },
  };
  const onOpen = vi.fn();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  function Probe(props: { conversations: Conversation[]; fresh: boolean }) {
    useDesktopNotifications({
      ...props,
      openTagId: "moss",
      name: (tagId) => tagId,
      onOpen,
      notifier,
    });
    return null;
  }
  const render = (conversations: Conversation[], fresh: boolean) =>
    act(() => root.render(createElement(Probe, { conversations, fresh })));
  // A cached list never notifies; the first fresh read sets what is known.
  render([reply], false);
  render([conversation("lead")], true);
  expect(shown).toEqual([]);
  render([reply, conversation("moss", { unreadCount: 2 })], true);
  expect(shown.map(({ key }) => key)).toEqual(["reply:lead"]);
  // The open conversation in the focused window is not counted.
  expect(badges.at(-1)).toBe(1);
  act(() => click?.("lead"));
  expect(onOpen).toHaveBeenCalledWith("lead");
  act(() => root.unmount());
  root = createRoot(host);
  expect(badges.at(-1)).toBe(0);
  expect(click).toBeUndefined();
});
