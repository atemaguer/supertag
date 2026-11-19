import { expect, it } from "vitest";
import type { Conversation, Message } from "./gateway";
import { latestHistory } from "./history";
import { type AlertContext, alertId, alertsFor, unreadTotal } from "./notifications";

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
