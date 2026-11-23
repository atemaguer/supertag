// @vitest-environment happy-dom

import { orderTags, type Tag } from "@supertag/client/model";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isSidebarShortcut, relativeTime, type SidebarMode, tagShortcut } from "./sidebar";
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
const separator = () => host.querySelector(".sidebar-resize") as HTMLElement;
const rows = () =>
  [...host.querySelectorAll(".tag-row")].map((row) => row.getAttribute("aria-label"));
const shown = () => shell().style.getPropertyValue("--sidebar-current");

/** Drags the separator from x to each later x, releasing at the last. */
function drag(...xs: number[]) {
  const [start, ...moves] = xs;
  const event = (type: string, clientX: number) =>
    new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX });
  act(() => {
    separator().dispatchEvent(event("pointerdown", start ?? 0));
  });
  for (const x of moves.slice(0, -1))
    act(() => {
      separator().dispatchEvent(event("pointermove", x));
    });
  act(() => {
    separator().dispatchEvent(event("pointerup", moves.at(-1) ?? start ?? 0));
  });
}

const key = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    separator().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });

it("resizes the expanded sidebar by dragging its separator, within its range, and keeps it", () => {
  render();
  expect(shell().dataset.sidebar).toBe("expanded");
  expect(shown()).toBe("256px");
  expect(separator().getAttribute("role")).toBe("separator");
  expect(separator().getAttribute("aria-orientation")).toBe("vertical");
  expect(host.querySelector(".sidebar .connection")?.textContent).toBe("expanded");

  // While dragging, the sidebar follows the pointer; past its maximum it stops.
  act(() => {
    separator().dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 256 }),
    );
  });
  act(() => {
    separator().dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 300 }),
    );
  });
  expect(shown()).toBe("300px");
  expect(shell().dataset.resizing).toBe("true");
  act(() => {
    separator().dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 500 }),
    );
  });
  expect(shown()).toBe("360px");
  expect(shell().dataset.resizing).toBeUndefined();
  expect(localStorage.getItem("supertag.desktop.sidebar-width")).toBe("360");

  // Between the snap point and the minimum it holds at the minimum.
  drag(360, 190, 190);
  expect(shell().dataset.sidebar).toBe("expanded");
  expect(shown()).toBe("220px");

  // A restart restores the width.
  act(() => root.unmount());
  root = createRoot(host);
  render();
  expect(shown()).toBe("220px");
});

it("snaps to the rail when dragged past the threshold, and back out to the last width", () => {
  render();
  drag(256, 200, 120);
  expect(shell().dataset.sidebar).toBe("rail");
  expect(shown()).toBe("84px");
  expect(localStorage.getItem("supertag.desktop.sidebar")).toBe("rail");
  // The rail keeps every Tag and the Gateway: nothing is hidden.
  expect(rows()).toEqual(["Lead, lead Tag", "finch", "moss"]);
  expect(host.querySelector(".sidebar .connection")?.textContent).toBe("rail");

  // A short drag outward stays the rail; past the threshold it expands.
  drag(84, 120);
  expect(shell().dataset.sidebar).toBe("rail");
  drag(84, 200, 280);
  expect(shell().dataset.sidebar).toBe("expanded");
  expect(shown()).toBe("280px");
});

it("toggles the rail by double-clicking the separator, with Enter, and with Ctrl+B", () => {
  render();
  act(() => {
    separator().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(shell().dataset.sidebar).toBe("rail");
  act(() => {
    separator().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(shell().dataset.sidebar).toBe("expanded");
  key("Enter");
  expect(shell().dataset.sidebar).toBe("rail");
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
  });
  expect(shell().dataset.sidebar).toBe("expanded");
  expect(localStorage.getItem("supertag.desktop.sidebar")).toBe("expanded");
});

it("resizes with the arrow keys, collapsing below the minimum and expanding from the rail", () => {
  render();
  key("ArrowRight");
  expect(shown()).toBe("272px");
  expect(separator().getAttribute("aria-valuenow")).toBe("272");
  for (let step = 0; step < 3; step++) key("ArrowLeft");
  expect(shown()).toBe("224px");
  key("ArrowLeft");
  expect(shell().dataset.sidebar).toBe("rail");
  key("ArrowRight");
  expect(shell().dataset.sidebar).toBe("expanded");
  expect(shown()).toBe("224px");
});

it("starts as the rail when that was the saved choice", () => {
  localStorage.setItem("supertag.desktop.sidebar", "rail");
  render();
  expect(shell().dataset.sidebar).toBe("rail");
});

it("opens the lead from the first roster row and exposes its name in rail mode", () => {
  const { onSelectTag } = render({
    tag: tags[1],
    summaries: { lead: { preview: "Review is ready.", unread: true } },
  });
  const lead = host.querySelector('.tag-row[data-lead="true"]') as HTMLButtonElement;
  expect(rows()).toEqual(["Lead, lead Tag", "finch", "moss"]);
  expect(lead.getAttribute("aria-current")).toBe("true");
  expect(lead.closest(".sidebar-tags")?.previousElementSibling?.className).toBe("sidebar-heading");
  expect(host.querySelector(".sidebar-gateway .connection")).not.toBeNull();
  expect(lead.nextElementSibling?.textContent).toBe("Conversations");
  expect(lead.querySelector(".lead-badge")).not.toBeNull();
  expect(lead.querySelector(".tag-monogram")?.textContent).toBe("LE");
  expect(lead.querySelector(".tag-row-name")?.textContent).toBe("Lead");
  expect(lead.querySelector(".tag-row-preview")?.textContent).toBe("Review is ready.");
  act(() => lead.click());
  expect(onSelectTag).toHaveBeenCalledWith("lead");

  key("Enter");
  const folded = host.querySelector('.tag-row[data-lead="true"]') as HTMLButtonElement;
  expect(folded.getAttribute("aria-label")).toBe("Lead, lead Tag");
  expect(folded.querySelector(".tag-row-name")).toBeNull();
  act(() => folded.click());
  expect(onSelectTag).toHaveBeenCalledTimes(2);
});

it("starts with the most recently active Tag when there is no lead", () => {
  render({
    tags: [tag("finch"), tag("moss")],
    summaries: { moss: { lastActivityMs: Date.now() } },
  });
  expect(rows()).toEqual(["moss", "finch"]);
  expect(host.querySelector('.tag-row[data-lead="true"]')).toBeNull();
});

it.each([
  [true, "No Tags available"],
  [false, "Connect to see your Tags"],
] as const)("explains an empty roster when connected is %s", (connected, message) => {
  render({ tags: [], tag: undefined, connected });
  expect(rows()).toEqual([]);
  expect(host.querySelector(".sidebar-empty")?.textContent).toBe(message);
  expect(host.querySelector(".sidebar .connection")).not.toBeNull();
});

it("shows a row's preview, time, unread, and working state when it has them", () => {
  const now = Date.now();
  render({
    summaries: {
      finch: { preview: "The lockfile is current.", lastActivityMs: now - 60_000, unread: true },
      moss: { working: true, lastActivityMs: now },
    },
  });
  // The newest activity first, below the lead; a state is announced with the name.
  expect(rows()).toEqual(["Lead, lead Tag", "moss, Working", "finch"]);
  const [, moss, finch] = [...host.querySelectorAll(".tag-row")] as HTMLElement[];
  expect(finch?.dataset.status).toBe("unread");
  expect(finch?.querySelector(".tag-row-preview")?.textContent).toBe("The lockfile is current.");
  expect(finch?.querySelector(".tag-row-time")?.textContent).toBeTruthy();
  expect(finch?.querySelector(".tag-row-unread")).not.toBeNull();
  expect(finch?.getAttribute("aria-description")).toBe("Unread messages");
  expect(moss?.dataset.status).toBe("working");
  expect(moss?.querySelector(".tag-state")?.textContent).toBe("Working");
  expect(moss?.querySelector(".tag-state")?.getAttribute("aria-hidden")).toBe("true");
});

it("says a Tag needs you while its question is unanswered, before that it is working", () => {
  render({
    summaries: {
      finch: { asking: true, working: true, unread: true, preview: "Close #812?" },
      moss: { unread: true, preview: "Done." },
    },
  });
  const [, finch, moss] = [...host.querySelectorAll(".tag-row")] as HTMLElement[];
  expect(finch?.getAttribute("aria-label")).toBe("finch, Needs you");
  expect(finch?.dataset.status).toBe("asking");
  expect(finch?.querySelector(".tag-state")?.textContent).toBe("Needs you");
  expect(finch?.querySelector(".tag-row-unread")).not.toBeNull();
  // Unread replies alone are not a question: no state word, only the dot.
  expect(moss?.getAttribute("aria-label")).toBe("moss");
  expect(moss?.querySelector(".tag-state")).toBeNull();
  expect(moss?.querySelector(".tag-row-unread")).not.toBeNull();
});

it("names the lead Tag's state with it, and keeps a dot for each state on the rail", () => {
  render({ summaries: { lead: { working: true }, moss: { asking: true } } });
  const lead = host.querySelector('.tag-row[data-lead="true"]') as HTMLElement;
  expect(lead.getAttribute("aria-label")).toBe("Lead, lead Tag, Working");
  expect(lead.querySelector(".tag-state")?.textContent).toBe("Working");
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
  });
  const moss = host.querySelector('.tag-row[aria-label="moss, Needs you"]') as HTMLElement;
  expect(moss.querySelector(".tag-row-badge")).not.toBeNull();
  expect(moss.querySelector(".tag-state")).toBeNull();
  expect(moss.getAttribute("title")).toBe("moss: Needs you");
});

it("has no search field of its own: the search button beside New Tag opens the palette", () => {
  render({ onNewTag: vi.fn() });
  expect(host.querySelector(".sidebar h2")?.textContent).toBe("Tags");
  expect(host.querySelector(".sidebar input")).toBeNull();
  const actions = [...host.querySelectorAll(".sidebar-top-actions button")].map((button) =>
    button.getAttribute("aria-label"),
  );
  expect(actions).toEqual(["Search", "New Tag"]);
  act(() => (host.querySelector('.sidebar [aria-label="Search"]') as HTMLButtonElement).click());
  expect(document.querySelector('[role="dialog"] input')?.getAttribute("placeholder")).toBe(
    "Search Tags, conversations, settings…",
  );
  expect(rows()).toEqual(["Lead, lead Tag", "finch", "moss"]);
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

it("opens Tags with Ctrl+1…9 and Ctrl+↑/↓, and New Tag with Ctrl+N", () => {
  const onNewTag = vi.fn();
  const { onSelectTag } = render({ onNewTag });
  const press = (key: string) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true }));
    });
  press("1");
  expect(onSelectTag).toHaveBeenLastCalledWith("lead");
  press("3");
  expect(onSelectTag).toHaveBeenLastCalledWith("moss");
  press("ArrowDown");
  expect(onSelectTag).toHaveBeenLastCalledWith("moss");
  press("ArrowUp");
  expect(onSelectTag).toHaveBeenLastCalledWith("lead");
  press("n");
  expect(onNewTag).toHaveBeenCalledOnce();
  press("f");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  press("k");
  expect(document.activeElement).toBe(document.querySelector('[role="dialog"] input'));

  const key = (init: Partial<KeyboardEvent>) => ({
    key: "1",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    target: null,
    ...init,
  });
  expect(tagShortcut(key({ metaKey: true }), true)).toEqual({ kind: "nth", index: 0 });
  expect(tagShortcut(key({ ctrlKey: true }), true)).toBeUndefined();
  // In a field with text, ⌘↑ moves the cursor instead.
  const field = { value: "draft" } as unknown as EventTarget;
  expect(tagShortcut(key({ key: "ArrowUp", metaKey: true, target: field }), true)).toBeUndefined();
  expect(tagShortcut(key({ key: "ArrowUp", metaKey: true }), true)).toEqual({
    kind: "step",
    by: -1,
  });
});

it("shows a working Tag's row by its state word, never a line of its activity", () => {
  render({ summaries: { moss: { working: true, preview: "You: Run the tests" } } });
  const moss = [...host.querySelectorAll(".tag-row")].find(
    (row) => row.getAttribute("aria-label") === "moss, Working",
  ) as HTMLElement;
  expect(moss.querySelector(".tag-state")?.textContent).toBe("Working");
  expect(moss.textContent).not.toMatch(/Run/);
});
