// @vitest-environment happy-dom

import type { ApprovalDetails, Gateway, InboxItem, Message, Tag } from "@supertag/client/model";
import { clearConversationCache, clearOutbox } from "@supertag/client/react";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationPane, type Draft } from "./conversation";
import {
  ApprovalCard,
  oneLine,
  outcomeLine,
  type PendingApproval,
  tagApprovals,
  useApprovalCards,
} from "./needs-you";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const tag: Tag = {
  tagId: "moss",
  instructions: "",
  allowedActions: [],
  revision: 1,
  harnessKind: "codex",
};
const pending: PendingApproval = {
  approvalId: "apr_1",
  tagId: "moss",
  summary: "commands:execute on git push",
};
const details = (state = "pending"): ApprovalDetails => ({
  approvalId: "apr_1",
  action: "commands:execute",
  resource: "git push",
  summary: "",
  arguments: '{\n  "command": "git push origin main"\n}',
  pending: state === "pending",
  state,
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  clearConversationCache();
  clearOutbox();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => {});
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((entry) => entry.textContent === name);
function type(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = field instanceof HTMLInputElement ? HTMLInputElement : HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

it("picks a Tag's approval requests out of the inbox, and words outcomes and chips", () => {
  const item = (kind: InboxItem["kind"], approval?: PendingApproval): InboxItem => ({
    key: approval?.approvalId ?? kind,
    kind,
    objectiveId: "",
    taskId: "t",
    reason: "",
    actionableSinceMs: 0,
    ...(approval ? { approval } : {}),
  });
  const inbox = [
    item("question"),
    item("approval", pending),
    item("approval", { ...pending, approvalId: "apr_2", tagId: "finch" }),
  ];
  expect(tagApprovals(inbox, "moss")).toEqual([pending]);
  expect(tagApprovals(inbox, "kite")).toEqual([]);
  expect(outcomeLine({ state: "approved", byYou: true })).toBe("Approved once by you");
  expect(outcomeLine({ state: "denied", byYou: true, reason: "not on main" })).toBe(
    "Denied by you: not on main",
  );
  // Decided elsewhere: the Gateway says how, not who.
  expect(outcomeLine({ state: "approved" })).toBe("Approved");
  expect(oneLine("Close **#812**,\nor keep `both`?")).toBe("Close #812, or keep both?");
});

/** The cards of one Tag, as the conversation shows them. */
function Cards({
  gateway,
  approvals,
  onReply = () => {},
}: {
  gateway: Gateway;
  approvals: readonly PendingApproval[];
  onReply?: Parameters<typeof ApprovalCard>[0]["onReply"];
}) {
  const { cards, decide } = useApprovalCards(gateway, approvals);
  return cards.map((card) =>
    createElement(ApprovalCard, { key: card.approvalId, gateway, card, decide, onReply }),
  );
}

it("approves once on request, with nothing chosen by default, and collapses to its outcome", async () => {
  const decideApproval = vi.fn(async () => details("approved"));
  const gateway = { approval: async () => details(), decideApproval } as unknown as Gateway;
  const onReply = vi.fn();
  act(() => root.render(createElement(Cards, { gateway, approvals: [pending], onReply })));
  await flush();
  const card = host.querySelector("section") as HTMLElement;
  // The card names what is asked and shows the exact arguments.
  expect(card.textContent).toContain("commands:execute on git push");
  expect(card.querySelector("pre")?.textContent).toContain("git push origin main");
  // Approve, Deny, Reply in that order, and none of them has the focus.
  expect([...card.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual([
    "Approve once",
    "Deny",
    "Reply",
  ]);
  expect(card.contains(document.activeElement)).toBe(false);
  act(() => button("Reply")?.click());
  expect(onReply).toHaveBeenCalledWith({ key: "apr_1", text: pending.summary });
  expect(decideApproval).not.toHaveBeenCalled();

  await act(async () => button("Approve once")?.click());
  await flush();
  expect(decideApproval).toHaveBeenCalledWith("apr_1", true, "");
  expect(host.querySelector("section")).toBeNull();
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "Approved once by you · commands:execute on git push",
  );
});

it("denies only with a reason, and says when the Gateway refuses", async () => {
  const decideApproval = vi
    .fn<NonNullable<Gateway["decideApproval"]>>()
    .mockRejectedValueOnce("Only an operator can decide this.")
    .mockResolvedValueOnce(details("denied"));
  const gateway = { approval: async () => details(), decideApproval } as unknown as Gateway;
  act(() => root.render(createElement(Cards, { gateway, approvals: [pending] })));
  await flush();
  act(() => button("Deny")?.click());
  const reason = host.querySelector("input") as HTMLInputElement;
  expect(reason.getAttribute("aria-label")).toBe("Why it is denied");
  // Without a reason nothing is sent.
  await act(async () => (host.querySelector("form") as HTMLFormElement).requestSubmit());
  expect(decideApproval).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Say why it is denied.");

  act(() => type(reason, " not on main "));
  await act(async () => (host.querySelector("form") as HTMLFormElement).requestSubmit());
  await flush();
  expect(decideApproval).toHaveBeenCalledWith("apr_1", false, "not on main");
  // Refused: the card stays, with the reason and the Gateway's words.
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Only an operator can decide this.",
  );
  await act(async () => (host.querySelector("form") as HTMLFormElement).requestSubmit());
  await flush();
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "Denied by you: not on main · commands:execute on git push",
  );
});

it("shows how a request decided somewhere else ended", async () => {
  const approval = vi.fn(async () => details("denied"));
  const gateway = { approval } as unknown as Gateway;
  act(() => root.render(createElement(Cards, { gateway, approvals: [pending] })));
  await flush();
  expect(host.querySelector("section")).not.toBeNull();
  // It left the inbox without this window deciding it.
  act(() => root.render(createElement(Cards, { gateway, approvals: [] })));
  await flush();
  expect(host.querySelector("section")).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "Denied · commands:execute on git push",
  );
});

const asked: Message = {
  order: 1,
  task: {
    taskId: "t1",
    tagId: "moss",
    sessionId: "s",
    prompt: "Triage the issues",
    state: "succeeded",
    result: "Should I close **#812**?",
  },
};

function Pane({ gateway, asking }: { gateway: Gateway; asking: boolean }) {
  const [draft, setDraft] = useState<Draft>({ text: "" });
  return createElement(ConversationPane, {
    gateway,
    tag,
    draft,
    asking,
    updateDraft: (update) => setDraft(update),
    onWriteChange: () => {},
  });
}

it("answers a question from its card: Reply moves to the composer with a chip Esc dismisses", async () => {
  const send = vi.fn<Gateway["send"]>(async (_tagId, text) => ({
    order: 2,
    task: { taskId: "t2", tagId: "moss", sessionId: "s", prompt: text, state: "queued" },
  }));
  const gateway: Gateway = {
    tags: async () => [tag],
    conversations: async () => [],
    messages: async () => ({ conversationId: "c1", messages: [asked] }),
    send,
    events: async () => [],
    markRead: async () => {
      throw new Error("not listed");
    },
    scope: "test",
    readCache: async () => undefined,
    writeCache: async () => {},
  };
  act(() => root.render(createElement(Pane, { gateway, asking: true })));
  await flush();
  const card = host.querySelector("section") as HTMLElement;
  expect(card.textContent).toContain("moss is waiting for your answer.");
  const field = host.querySelector("textarea") as HTMLTextAreaElement;
  const chip = () => host.querySelector(".composer-reply")?.textContent;
  expect(chip()).toBeUndefined();

  act(() => button("Reply")?.click());
  expect(chip()).toBe("Replying to: Should I close #812?");
  expect(document.activeElement).toBe(field);
  expect(button("Reply")?.getAttribute("aria-pressed")).toBe("true");
  // Esc in the composer drops the chip and nothing else.
  act(() => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(chip()).toBeUndefined();

  // Its button dismisses it too, and sending the answer clears it.
  act(() => button("Reply")?.click());
  act(() => (host.querySelector('[aria-label="Stop replying to this"]') as HTMLElement).click());
  expect(chip()).toBeUndefined();
  act(() => button("Reply")?.click());
  act(() => type(field, "Close it"));
  await act(async () => (host.querySelector("form") as HTMLFormElement).requestSubmit());
  await flush();
  expect(send.mock.calls[0]?.slice(0, 2)).toEqual(["moss", "Close it"]);
  expect(chip()).toBeUndefined();

  // Once the question is answered the card goes.
  act(() => root.render(createElement(Pane, { gateway, asking: false })));
  await flush();
  expect(host.querySelector("section")).toBeNull();
});
