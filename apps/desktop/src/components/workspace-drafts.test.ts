// @vitest-environment happy-dom

import type { Gateway, Tag } from "@supertag/client/model";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Workspace } from "./workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const tags: Tag[] = ["lead", "moss"].map((tagId) => ({
  tagId,
  instructions: "",
  allowedActions: [],
  revision: 1,
  harnessKind: "codex",
}));
const gateway: Gateway = {
  tags: async () => tags,
  conversations: async () => [],
  messages: async () => ({ conversationId: "", messages: [] }),
  send: async () => {
    throw new Error("unused");
  },
  markRead: async () => {
    throw new Error("unused");
  },
  events: async () => [],
  scope: "test",
  readCache: async () => undefined,
  writeCache: async () => {},
};

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render() {
  await act(async () =>
    root.render(
      createElement(Workspace, {
        gateway,
        initialTags: tags,
        selector: () => null,
        draftScope: "https://cp.example",
        switching: false,
        connectionError: "",
        onWriteChange: () => {},
      }),
    ),
  );
  await act(async () => {});
}

const field = () => host.querySelector("textarea") as HTMLTextAreaElement;
function type(text: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field(), text);
  field().dispatchEvent(new Event("input", { bubbles: true }));
}
const select = (name: string) =>
  act(async () => (host.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement).click());

it("keeps each Tag's unsent draft across Tag switches and restarts", async () => {
  await render();
  act(() => type("For lead"));
  await select("moss");
  await act(async () => {});
  expect(field().value).toBe("");
  act(() => type("For moss"));
  await select("lead");
  await act(async () => {});
  expect(field().value).toBe("For lead");
  expect(
    JSON.parse(localStorage.getItem("supertag.desktop.drafts.https://cp.example") ?? ""),
  ).toEqual({
    lead: "For lead",
    moss: "For moss",
  });

  act(() => root.unmount());
  root = createRoot(host);
  await render();
  expect(field().value).toBe("For lead");
});
