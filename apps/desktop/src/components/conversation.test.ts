// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Gateway, Message, Tag } from "../gateway";
import { clearConversationCache } from "../lib/conversation-cache";
import { clearOutbox } from "../lib/outbox";
import { ConversationPane, type Draft } from "./conversation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom has no ResizeObserver, which the transcript's stick-to-bottom scrolling uses.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const tag: Tag = {
  tagId: "lead",
  instructions: "",
  allowedActions: [],
  revision: 1,
  harnessKind: "codex",
};

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

function Pane({ gateway }: { gateway: Gateway }) {
  const [draft, setDraft] = useState<Draft>({ text: "" });
  return createElement(ConversationPane, {
    gateway,
    tag,
    draft,
    updateDraft: (update) => setDraft(update),
    onWriteChange: () => {},
  });
}

const flush = () => act(async () => {});

function type(text: string) {
  const field = host.querySelector("textarea") as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

it("shows a sent message at once, keeps it with a retry when it fails, and retries it once", async () => {
  const sent: Message = {
    order: 1,
    task: { taskId: "t1", tagId: "lead", sessionId: "s", prompt: "Ship it", state: "queued" },
  };
  let accepted = false;
  const send = vi
    .fn<Gateway["send"]>()
    .mockRejectedValueOnce(new Error("The Gateway is unavailable."))
    .mockImplementationOnce(async () => {
      accepted = true;
      return sent;
    });
  const gateway: Gateway = {
    tags: async () => [tag],
    conversations: async () => [],
    messages: async () => ({ conversationId: "c1", messages: accepted ? [sent] : [] }),
    send,
    events: async () => [],
    saveArtifact: async () => false,
    markRead: async () => {
      throw new Error("not listed");
    },
    scope: "test",
    readCache: async () => undefined,
    writeCache: async () => {},
  };
  act(() => root.render(createElement(Pane, { gateway })));
  await flush();
  act(() => type("Ship it"));
  await act(async () => {
    (host.querySelector("form") as HTMLFormElement).requestSubmit();
  });
  await flush();
  // The composer is clear and the message stays in the transcript, not delivered.
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  expect(host.querySelector('[data-delivery="Not delivered"]')?.textContent).toContain(
    "Not delivered",
  );
  expect(host.querySelector(".prompt-text")?.textContent).toBe("Ship it");
  const operation = send.mock.calls[0]?.[2];

  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  await act(async () => retry?.click());
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
  // The retry reuses the operation, so the Gateway accepts the message at most once.
  expect(send.mock.calls[1]).toEqual(["lead", "Ship it", operation]);
  expect(host.querySelector('[data-delivery="Not delivered"]')).toBeNull();
  expect(host.querySelector('[data-delivery="Sent"]')?.textContent).toBe("Sent");
});

it("moves a message that was not delivered back to the composer to edit", async () => {
  const gateway: Gateway = {
    tags: async () => [tag],
    conversations: async () => [],
    messages: async () => ({ conversationId: "c1", messages: [] }),
    send: async () => {
      throw new Error("refused");
    },
    events: async () => [],
    saveArtifact: async () => false,
    markRead: async () => {
      throw new Error("not listed");
    },
    scope: "test",
    readCache: async () => undefined,
    writeCache: async () => {},
  };
  act(() => root.render(createElement(Pane, { gateway })));
  await flush();
  act(() => type("Draft text"));
  await act(async () => {
    (host.querySelector("form") as HTMLFormElement).requestSubmit();
  });
  await flush();
  const edit = [...host.querySelectorAll("button")].find((b) => b.textContent === "Edit");
  act(() => edit?.click());
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Draft text");
  expect(host.querySelector(".delivery")).toBeNull();
});

it("resizes the Task activity pane between its limits, remembers it, and resets on double-click", async () => {
  localStorage.clear();
  const done: Message = {
    order: 1,
    task: { taskId: "t1", tagId: "lead", sessionId: "s", prompt: "Ship it", state: "succeeded" },
  };
  const gateway: Gateway = {
    tags: async () => [tag],
    conversations: async () => [],
    messages: async () => ({ conversationId: "c1", messages: [done] }),
    send: async () => done,
    events: async () => [],
    saveArtifact: async () => false,
    markRead: async () => {
      throw new Error("not listed");
    },
    scope: "test",
    readCache: async () => undefined,
    writeCache: async () => {},
  };
  const open = async () => {
    act(() => root.render(createElement(Pane, { gateway })));
    await flush();
    Object.defineProperty(host.querySelector(".work-area"), "clientWidth", { value: 1000 });
    act(() => (host.querySelector(".task-status") as HTMLButtonElement).click());
    await flush();
  };
  await open();
  const frame = () => host.querySelector(".activity-frame") as HTMLElement;
  const handle = () => host.querySelector(".activity-resize") as HTMLElement;
  const pointer = (type: string, clientX: number) =>
    act(() => {
      handle().dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          clientX,
        }),
      );
    });
  expect(frame().style.width).toBe("320px");
  expect(handle().getAttribute("aria-valuemin")).toBe("280");

  // Dragging the left edge left widens the pane.
  pointer("pointerdown", 500);
  pointer("pointermove", 400);
  expect(frame().style.width).toBe("420px");
  // It stops where the conversation would be narrower than 420px, here 580px.
  pointer("pointerup", 0);
  expect(frame().style.width).toBe("580px");
  expect(handle().getAttribute("aria-valuemax")).toBe("580");
  expect(localStorage.getItem("supertag.desktop.activity-width")).toBe("580");
  pointer("pointerdown", 0);
  pointer("pointerup", 900);
  expect(frame().style.width).toBe("280px");

  const key = (key: string) =>
    act(() => {
      handle().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  key("ArrowLeft");
  expect(frame().style.width).toBe("296px");
  key("ArrowRight");
  key("ArrowRight");
  expect(frame().style.width).toBe("280px");

  act(() => {
    handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(frame().style.width).toBe("320px");
  key("ArrowLeft");
  act(() => root.unmount());
  root = createRoot(host);
  await open();
  expect(frame().style.width).toBe("336px");
});

it("shows the Tag's messages and its result as the conversation's follow pushes them", async () => {
  const turn = (state: string, events: Message["events"] = [], result?: string): Message => ({
    order: 1,
    events,
    task: { taskId: "t1", tagId: "lead", sessionId: "c1", prompt: "Fix the build", state, result },
  });
  let push:
    | ((update: Parameters<Parameters<NonNullable<Gateway["follow"]>>[1]>[0]) => void)
    | undefined;
  const stop = vi.fn(async () => {});
  const messages = vi.fn<Gateway["messages"]>(async () => ({
    conversationId: "c1",
    messages: [turn("queued")],
  }));
  const gateway: Gateway = {
    tags: async () => [tag],
    conversations: async () => [],
    messages,
    send: async () => turn("queued"),
    events: async () => [],
    saveArtifact: async () => false,
    markRead: async () => {
      throw new Error("not listed");
    },
    follow: async (_read, receive) => {
      push = receive;
      return stop;
    },
    scope: "test",
    readCache: async () => undefined,
    writeCache: async () => {},
  };
  act(() => root.render(createElement(Pane, { gateway })));
  await flush();
  const reads = messages.mock.calls.length;
  const changed = (message: Message) =>
    act(() =>
      push?.({
        kind: "changed",
        messages: { conversationId: "c1", incremental: true, messages: [message] },
      }),
    );
  act(() => push?.({ kind: "ready" }));
  act(() =>
    push?.({ kind: "changed", waits: [{ taskId: "t1", reason: "No Worker Host is bound" }] }),
  );
  expect(host.querySelector(".task-wait")?.textContent).toBe("No Worker Host is bound");
  const intent = { sequence: 1, kind: "message" as const, text: "I'll look at the build." };
  changed(turn("running", [intent]));
  expect(host.querySelector(".task-wait")).toBeNull();
  expect(host.textContent).toContain("I'll look at the build.");
  // The answer streams into its own bubble as it is written, until it is recorded.
  act(() => push?.({ kind: "changed", texts: [{ taskId: "t1", text: "The build " }] }));
  expect(host.querySelector(".writing")?.textContent).toContain("The build");
  act(() => push?.({ kind: "changed", texts: [{ taskId: "t1", text: "The build passes" }] }));
  expect(host.querySelector(".writing")?.textContent).toContain("The build passes");
  const answer = { sequence: 2, kind: "message" as const, text: "The build passes." };
  act(() =>
    push?.({
      kind: "changed",
      messages: {
        conversationId: "c1",
        incremental: true,
        messages: [turn("running", [intent, answer])],
      },
      texts: [{ taskId: "t1", text: "" }],
    }),
  );
  expect(host.querySelector(".writing")).toBeNull();
  expect(host.querySelectorAll(".tag-message")).toHaveLength(2);
  changed(turn("succeeded", [intent, answer], "The build passes."));
  expect(host.textContent).toContain("The build passes.");
  // Pushed changes need no reads of the conversation.
  expect(messages).toHaveBeenCalledTimes(reads);
  act(() => root.unmount());
  root = createRoot(host);
  await flush();
  expect(stop).toHaveBeenCalled();
});

it("shows a turn's reply after the messages that joined it, in the order they were sent", async () => {
  const turn = (taskId: string, order: number, prompt: string, extra: Partial<Message> = {}) =>
    ({
      order,
      task: { taskId, tagId: "lead", sessionId: "c1", prompt, state: "succeeded" },
      ...extra,
    }) as Message;
  const first = turn("t1", 1, "Fix the build");
  first.task.result = "Fixed the build and the tests.";
  const joined = (taskId: string, order: number, prompt: string) =>
    turn(taskId, order, prompt, { liveInput: { taskId: "t1", state: "accepted" } });
  const page = [first, joined("t2", 2, "Also the tests"), joined("t3", 3, "Thanks")];
  const gateway: Gateway = {
    tags: async () => [tag],
    conversations: async () => [],
    messages: async () => ({ conversationId: "c1", messages: [...page].reverse() }),
    send: async () => first,
    events: async () => [],
    saveArtifact: async () => false,
    markRead: async () => {
      throw new Error("not listed");
    },
    scope: "test",
    readCache: async () => undefined,
    writeCache: async () => {},
  };
  act(() => root.render(createElement(Pane, { gateway })));
  await flush();
  const shown = [...host.querySelectorAll(".prompt-text, .result-text")].map(
    (bubble) => bubble.textContent,
  );
  expect(shown).toEqual([
    "Fix the build",
    "Also the tests",
    "Thanks",
    "Fixed the build and the tests.",
  ]);
  expect(host.querySelectorAll(".result-text")).toHaveLength(1);
});
