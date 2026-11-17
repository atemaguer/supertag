// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Conversation, Message } from "../gateway";
import { latestHistory } from "./history";
import {
  type Alert,
  type AlertContext,
  alertId,
  alertsFor,
  type Notifier,
  readLevel,
  saveLevel,
  unreadTotal,
  useDesktopNotifications,
} from "./notifications";

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
const known = (...conversations: Conversation[]) =>
  new Map(conversations.map((entry) => [entry.tagId, entry]));
const context = (extra: Partial<AlertContext> = {}): AlertContext => ({
  focused: false,
  level: "all",
  name: (tagId) => (tagId === "lead" ? "Lead" : tagId),
  ...extra,
});
const reply = conversation("lead", {
  latestOrder: 2,
  unreadCount: 1,
  preview: "The fix for #412 is ready for review\nDetails follow",
});

beforeEach(() => localStorage.clear());

it("notifies a Tag's reply only when its conversation is not in view", () => {
  const before = known(conversation("lead"));
  // The first read only sets what is known.
  expect(alertsFor(undefined, [reply], context())).toEqual([]);
  expect(alertsFor(before, [reply], context())).toEqual([
    {
      key: "reply:lead",
      tagId: "lead",
      title: "Lead",
      body: "The fix for #412 is ready for review",
      question: false,
    },
  ]);
  // Unfocused with the conversation open, or focused on another Tag, it notifies.
  expect(alertsFor(before, [reply], context({ openTagId: "lead" }))).toHaveLength(1);
  expect(alertsFor(before, [reply], context({ focused: true, openTagId: "moss" }))).toHaveLength(1);
  // Never for the conversation open in the focused window.
  expect(alertsFor(before, [reply], context({ focused: true, openTagId: "lead" }))).toEqual([]);
});

it("never notifies for the caller's own message, a running turn, or nothing new", () => {
  const before = known(conversation("lead"));
  const own = conversation("lead", { latestOrder: 2, previewFromTag: false, preview: "Hi" });
  expect(alertsFor(before, [own], context())).toEqual([]);
  // A running turn has not raised the unread count yet.
  const running = conversation("lead", { latestOrder: 2, working: true });
  expect(alertsFor(before, [running], context())).toEqual([]);
  expect(alertsFor(known(reply), [reply], context())).toEqual([]);
  // A quiet turn never reaches the list: the latest order stays where it was.
  expect(alertsFor(known(reply), [{ ...reply, working: false }], context())).toEqual([]);
});

it("coalesces a Tag's replies and keeps a question apart", () => {
  const three = { ...reply, latestOrder: 5, unreadCount: 3 };
  const [alert] = alertsFor(known(reply), [three], context());
  expect(alert).toMatchObject({ key: "reply:lead", body: "3 new messages" });
  expect(alertId("reply:lead")).toBe(alertId("reply:lead"));
  expect(alertId("reply:lead")).not.toBe(alertId("question:lead"));

  const question = {
    ...three,
    latestOrder: 6,
    unreadCount: 4,
    asking: true,
    preview: "Which branch should I release?",
  };
  expect(alertsFor(known(three), [question], context())).toEqual([
    {
      key: "question:lead",
      tagId: "lead",
      title: "Lead",
      body: "Which branch should I release?",
      question: true,
    },
  ]);
  // A question that is read no longer notifies.
  expect(alertsFor(known(three), [{ ...question, unreadCount: 0 }], context())).toEqual([]);
});

it("follows the device's level: all, questions only, or off", () => {
  const question = { ...reply, latestOrder: 3, unreadCount: 2, asking: true };
  const before = known(conversation("lead"), conversation("moss"));
  const moss = conversation("moss", { latestOrder: 4, unreadCount: 1, preview: "Done" });
  expect(alertsFor(before, [question, moss], context()).map(({ key }) => key)).toEqual([
    "question:lead",
    "reply:moss",
  ]);
  expect(
    alertsFor(before, [question, moss], context({ level: "questions" })).map(({ key }) => key),
  ).toEqual(["question:lead"]);
  expect(alertsFor(before, [question, moss], context({ level: "off" }))).toEqual([]);

  expect(readLevel()).toBe("all");
  saveLevel("questions");
  expect(readLevel()).toBe("questions");
  saveLevel("all");
  expect(localStorage.getItem("supertag.desktop.notifications")).toBeNull();
});

it("badges the unread total, but the conversation in front", () => {
  const list = [
    conversation("lead", { unreadCount: 2 }),
    conversation("moss", { unreadCount: 3 }),
    conversation("finch"),
  ];
  expect(unreadTotal(list)).toBe(5);
  expect(unreadTotal(list, "moss")).toBe(2);
  expect(unreadTotal([])).toBe(0);
});

it("drops a turn that finished quietly from the conversation", () => {
  const message = (taskId: string, order: number, extra = {}): Message => ({
    task: { taskId, tagId: "lead", sessionId: "s", state: "succeeded", ...extra },
    order,
  });
  const held = latestHistory(
    { messages: [], loading: true, read: false },
    {
      conversationId: "c",
      messages: [message("check", 2, { state: "running" }), message("hello", 1)],
    },
  );
  expect(held.messages.map(({ task }) => task.taskId)).toEqual(["hello", "check"]);
  const after = latestHistory(held, {
    conversationId: "c",
    incremental: true,
    messages: [message("check", 2, { quiet: true, result: "CI is green" })],
  });
  expect(after.messages.map(({ task }) => task.taskId)).toEqual(["hello"]);
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
