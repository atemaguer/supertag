// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Tag } from "../control-plane";
import { isSidebarShortcut, type SelectorPlacement, WorkspaceShell } from "./workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tags: Tag[] = [
  { tagId: "finch", instructions: "", allowedActions: [], revision: 1, harnessKind: "codex" },
  { tagId: "moss", instructions: "", allowedActions: [], revision: 1, harnessKind: "codex" },
];

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

function render(onSelectTag = vi.fn(), placements: SelectorPlacement[] = []) {
  act(() =>
    root.render(
      createElement(WorkspaceShell, {
        tags,
        tag: tags[0],
        conversation: "default",
        names: ["default"],
        connected: true,
        selector: (placement) => {
          placements.push(placement);
          return createElement("button", { type: "button", className: "connection" }, placement);
        },
        onSelectTag,
      }),
    ),
  );
  return { onSelectTag, placements };
}

const shell = () => host.querySelector(".shell") as HTMLElement;
const toggle = () => host.querySelector(".sidebar-toggle") as HTMLButtonElement;

it("collapses and reopens the sidebar from its toggle, and remembers the choice", () => {
  render();
  expect(shell().dataset.sidebar).toBe("open");
  expect(toggle().getAttribute("aria-label")).toBe("Hide sidebar (Ctrl+B)");
  expect(host.querySelector(".rail-bottom .connection")?.textContent).toBe("rail");

  act(() => toggle().click());
  expect(shell().dataset.sidebar).toBe("collapsed");
  expect(toggle().getAttribute("aria-label")).toBe("Show sidebar (Ctrl+B)");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("#sidebar")?.hasAttribute("inert")).toBe(true);
  // The Control Plane stays reachable beside the toggle.
  expect(host.querySelector(".window-controls .connection")?.textContent).toBe("top");
  expect(localStorage.getItem("supertag.desktop.sidebar")).toBe("collapsed");

  act(() => toggle().click());
  expect(shell().dataset.sidebar).toBe("open");
  expect(localStorage.getItem("supertag.desktop.sidebar")).toBe("open");
});

it("starts collapsed when that was the saved choice", () => {
  localStorage.setItem("supertag.desktop.sidebar", "collapsed");
  render();
  expect(shell().dataset.sidebar).toBe("collapsed");
});

it("toggles with Ctrl+B outside macOS and ⌘B on macOS", () => {
  render();
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
  });
  expect(shell().dataset.sidebar).toBe("collapsed");
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true }));
  });
  expect(shell().dataset.sidebar).toBe("collapsed");

  const press = (init: Partial<KeyboardEvent>) => ({
    key: "b",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...init,
  });
  expect(isSidebarShortcut(press({ metaKey: true }), true)).toBe(true);
  expect(isSidebarShortcut(press({ ctrlKey: true }), true)).toBe(false);
  expect(isSidebarShortcut(press({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
  expect(isSidebarShortcut(press({ ctrlKey: true, isComposing: true }), false)).toBe(false);
});

it("switches Tags from the conversation pill while the sidebar is collapsed", () => {
  localStorage.setItem("supertag.desktop.sidebar", "collapsed");
  const { onSelectTag } = render();
  const pill = host.querySelector(".identity-pill") as HTMLButtonElement;
  act(() => {
    pill.focus();
    pill.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const items = [...document.querySelectorAll('[role="menuitemradio"]')];
  expect(items.map((item) => item.textContent)).toEqual(["finch", "moss", "Default"]);
  const moss = items[1] as HTMLElement;
  act(() => moss.click());
  expect(onSelectTag).toHaveBeenCalledWith("moss");
});
