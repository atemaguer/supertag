// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlPlane, Message, Tag } from "../control-plane";
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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Pane({ controlPlane }: { controlPlane: ControlPlane }) {
  const [draft, setDraft] = useState<Draft>({ text: "" });
  return createElement(ConversationPane, {
    controlPlane,
    tag,
    name: "default",
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
    conversation: "default",
    task: { taskId: "t1", tagId: "lead", sessionId: "s", prompt: "Ship it", state: "queued" },
  };
  let accepted = false;
  const send = vi
    .fn<ControlPlane["send"]>()
    .mockRejectedValueOnce(new Error("The Control Plane is unavailable."))
    .mockImplementationOnce(async () => {
      accepted = true;
      return sent;
    });
  const controlPlane: ControlPlane = {
    tags: async () => [tag],
    conversations: async () => [],
    messages: async () => ({ messages: accepted ? [sent] : [] }),
    send,
    events: async () => [],
    saveArtifact: async () => false,
    scope: "test",
    readCache: async () => undefined,
    writeCache: async () => {},
  };
  act(() => root.render(createElement(Pane, { controlPlane })));
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
  const operation = send.mock.calls[0]?.[3];

  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  await act(async () => retry?.click());
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
  // The retry reuses the operation, so the Control Plane accepts the message at most once.
  expect(send.mock.calls[1]).toEqual(["lead", "default", "Ship it", operation]);
  expect(host.querySelector('[data-delivery="Not delivered"]')).toBeNull();
  expect(host.querySelector('[data-delivery="Sent"]')?.textContent).toBe("Sent");
});

it("moves a message that was not delivered back to the composer to edit", async () => {
  const controlPlane: ControlPlane = {
    tags: async () => [tag],
    conversations: async () => [],
    messages: async () => ({ messages: [] }),
    send: async () => {
      throw new Error("refused");
    },
    events: async () => [],
    saveArtifact: async () => false,
    scope: "test",
    readCache: async () => undefined,
    writeCache: async () => {},
  };
  act(() => root.render(createElement(Pane, { controlPlane })));
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
