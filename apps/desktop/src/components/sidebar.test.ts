// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Tag } from "../control-plane";
import { isSidebarShortcut, orderTags, relativeTime, type SidebarMode } from "./sidebar";
import { WorkspaceShell } from "./workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tag = (tagId: string, extra: Partial<Tag> = {}): Tag => ({
  tagId,
  instructions: "",
  allowedActions: [],
  revision: 1,
  harnessKind: "codex",
  ...extra,
});
const tags = [tag("finch"), tag("lead", { name: "Lead", lead: true }), tag("moss")];

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

function render(props: Partial<Parameters<typeof WorkspaceShell>[0]> = {}) {
  const onSelectTag = vi.fn();
  const modes: SidebarMode[] = [];
  act(() =>
    root.render(
      createElement(
        WorkspaceShell,
        {
          tags,
          tag: tags[0],
          connected: true,
          selector: (mode) => {
            modes.push(mode);
            return createElement("button", { type: "button", className: "connection" }, mode);
          },
          onSelectTag,
          ...props,
        },
        null,
      ),
    ),
  );
  return { onSelectTag, modes };
}

const shell = () => host.querySelector(".shell") as HTMLElement;
const toggle = () => host.querySelector(".sidebar-toggle") as HTMLButtonElement;
const rows = () =>
  [...host.querySelectorAll(".tag-row")].map((row) => row.getAttribute("aria-label"));

it("switches between the expanded sidebar and the rail, and remembers the choice", () => {
  render();
  expect(shell().dataset.sidebar).toBe("expanded");
  expect(toggle().getAttribute("aria-label")).toBe("Collapse sidebar (Ctrl+B)");
  expect(host.querySelector(".sidebar .connection")?.textContent).toBe("expanded");

  act(() => toggle().click());
  expect(shell().dataset.sidebar).toBe("rail");
  expect(toggle().getAttribute("aria-label")).toBe("Expand sidebar (Ctrl+B)");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  // The rail keeps every Tag and the Control Plane: nothing is hidden.
  expect(rows()).toEqual(["finch", "moss"]);
  expect(host.querySelector(".sidebar .connection")?.textContent).toBe("rail");
  expect(localStorage.getItem("supertag.desktop.sidebar")).toBe("rail");

  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
  });
  expect(shell().dataset.sidebar).toBe("expanded");
  expect(localStorage.getItem("supertag.desktop.sidebar")).toBe("expanded");
});

it("starts as the rail when that was the saved choice", () => {
  localStorage.setItem("supertag.desktop.sidebar", "rail");
  render();
  expect(shell().dataset.sidebar).toBe("rail");
});

it("puts the lead Tag in the top slot, named when expanded, and opens it on click", () => {
  const { onSelectTag } = render();
  const lead = host.querySelector(".lead-tag") as HTMLButtonElement;
  expect(lead.getAttribute("aria-label")).toBe("Lead, lead Tag");
  expect(lead.querySelector(".lead-badge")).not.toBeNull();
  expect(lead.querySelector(".lead-name")?.textContent).toBe("Lead");
  expect(rows()).not.toContain("Lead");
  act(() => lead.click());
  expect(onSelectTag).toHaveBeenCalledWith("lead");

  act(() => toggle().click());
  expect(host.querySelector(".lead-tag .lead-name")).toBeNull();
});

it("shows the SuperTag mascot in the top slot when there is no lead Tag", () => {
  render({ tags: [tag("finch"), tag("moss")] });
  expect(host.querySelector(".lead-tag")).toBeNull();
  expect(host.querySelector(".sidebar-mascot")?.getAttribute("alt")).toBe("SuperTag");
  expect(rows()).toEqual(["finch", "moss"]);
});

it("shows a row's preview, time, unread, and working state when it has them", () => {
  const now = Date.now();
  render({
    summaries: {
      finch: { preview: "The lockfile is current.", lastActivityMs: now - 60_000, unread: true },
      moss: { working: true, lastActivityMs: now },
    },
  });
  // The newest activity first, below the lead.
  expect(rows()).toEqual(["moss", "finch"]);
  const [moss, finch] = [...host.querySelectorAll(".tag-row")] as HTMLElement[];
  expect(finch?.dataset.status).toBe("unread");
  expect(finch?.querySelector(".tag-row-preview")?.textContent).toBe("The lockfile is current.");
  expect(finch?.querySelector(".tag-row-time")?.textContent).toBeTruthy();
  expect(finch?.querySelector(".tag-row-unread")).not.toBeNull();
  expect(moss?.dataset.status).toBe("working");
  expect(moss?.querySelector(".working-dots")).not.toBeNull();
  expect(moss?.getAttribute("aria-description")).toBe("Working");
});

it("searches the expanded list by name", () => {
  render();
  act(() => (host.querySelector('[aria-label="Search Tags"]') as HTMLButtonElement).click());
  const input = host.querySelector(".sidebar-search input") as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "mo");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(rows()).toEqual(["moss"]);
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector(".sidebar-search")).toBeNull();
  expect(rows()).toEqual(["finch", "moss"]);
});

it("recognises the sidebar shortcut and orders and times rows", () => {
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
  expect(isSidebarShortcut(press({ ctrlKey: true }), false)).toBe(true);
  expect(isSidebarShortcut(press({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
  expect(orderTags(tags).lead?.tagId).toBe("lead");
  expect(orderTags(tags).others.map((entry) => entry.tagId)).toEqual(["finch", "moss"]);
  const now = new Date(2026, 10, 16, 15, 0).getTime();
  expect(relativeTime(now - 25 * 3_600_000, now)).toBe("Yesterday");
  expect(relativeTime(now - 30 * 86_400_000, now)).toMatch(/Oct/);
});
