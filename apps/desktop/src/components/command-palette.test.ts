// @vitest-environment happy-dom

import type { Tag } from "@supertag/client/model";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keyboardShortcuts, type PaletteAction, searchPalette, snippet } from "./command-palette";
import { gatewayActions } from "./gateway-selector";
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
const tags = [
  tag("finch", { name: "Finch" }),
  tag("lead", { name: "Lead", lead: true }),
  tag("moss"),
];
const summaries = {
  finch: { preview: "The lockfile is current.", lastActivityMs: 2_000 },
  moss: { preview: "You: Run the tests", lastActivityMs: 1_000 },
};
const messages: Record<string, string[]> = {
  moss: ["All green.", "Please check the staging deploy before Friday's release"],
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

function render(props: Partial<Parameters<typeof WorkspaceShell>[0]> = {}) {
  const onSelectTag = vi.fn();
  const onNewTag = vi.fn();
  const addGateway = vi.fn();
  const actions: PaletteAction[] = [{ id: "add-gateway", label: "Add Gateway", run: addGateway }];
  act(() =>
    root.render(
      createElement(
        WorkspaceShell,
        {
          tags,
          tag: tags[0],
          connected: true,
          summaries,
          selector: () => null,
          onSelectTag,
          onNewTag,
          actions,
          messageTexts: (tagId) => messages[tagId] ?? [],
          ...props,
        },
        null,
      ),
    ),
  );
  return { onSelectTag, onNewTag, addGateway };
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const input = () => dialog()?.querySelector("input") as HTMLInputElement;
const section = (heading: string) =>
  [...document.querySelectorAll("[cmdk-group]")].find(
    (group) => group.querySelector("[cmdk-group-heading]")?.textContent === heading,
  );
const labels = (heading: string) =>
  [...(section(heading)?.querySelectorAll(".palette-label") ?? [])].map((row) => row.textContent);
const selected = () =>
  document.querySelector('[cmdk-item][data-selected="true"] .palette-label')?.textContent;

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("opens with Ctrl+K, listing the Tags in sidebar order and then the actions", () => {
  render();
  expect(dialog()).toBeNull();
  press("k", { ctrlKey: true });
  expect(input().placeholder).toBe("Search Tags, conversations, settings…");
  expect(document.activeElement).toBe(input());
  expect(labels("Tags")).toEqual(["Lead", "Finch", "moss"]);
  const finch = [...(section("Tags")?.querySelectorAll("[cmdk-item]") ?? [])][1];
  expect(finch?.querySelector(".avatar")).not.toBeNull();
  expect(finch?.querySelector(".palette-caption")?.textContent).toBe("The lockfile is current.");
  expect(finch?.querySelector("[data-slot=command-shortcut]")?.textContent).toBe("Ctrl+2");
  expect(labels("Actions")).toEqual(["New Tag", "Keyboard shortcuts", "Add Gateway"]);
  expect(selected()).toBe("Lead");
});

it("filters both sections as you type, matching cached message text", () => {
  render();
  press("k", { ctrlKey: true });
  type("lockfile");
  expect(labels("Tags")).toEqual(["Finch"]);
  expect(section("Actions")).toBeUndefined();

  // A word only in an earlier message finds the Tag, captioned with that message.
  type("staging deploy");
  expect(labels("Tags")).toEqual(["moss"]);
  expect(section("Tags")?.querySelector(".palette-caption")?.textContent).toBe(
    "Please check the staging deploy before Friday's release",
  );

  type("gateway");
  expect(section("Tags")).toBeUndefined();
  expect(labels("Actions")).toEqual(["Add Gateway"]);

  type("nothing like this");
  expect(dialog()?.textContent).toContain("No results");
});

it("opens the selected Tag with Enter after moving with the arrow keys, and closes", () => {
  const { onSelectTag } = render();
  press("k", { ctrlKey: true });
  press("ArrowDown", {}, input());
  expect(selected()).toBe("Finch");
  press("ArrowDown", {}, input());
  press("ArrowUp", {}, input());
  expect(selected()).toBe("Finch");
  press("Enter", {}, input());
  expect(onSelectTag).toHaveBeenCalledExactlyOnceWith("finch");
  expect(dialog()).toBeNull();
});

it("opens a Tag with Ctrl+1…9 inside the palette, once", () => {
  const { onSelectTag } = render();
  press("k", { ctrlKey: true });
  type("moss");
  // The shortcut follows the sidebar's order, not the filtered list's.
  press("3", { ctrlKey: true }, input());
  expect(onSelectTag).toHaveBeenCalledExactlyOnceWith("moss");
  expect(dialog()).toBeNull();
});

it("closes with Esc and with Ctrl+K, forgetting the search", () => {
  render();
  press("k", { ctrlKey: true });
  type("moss");
  press("Escape", {}, input());
  expect(dialog()).toBeNull();
  press("k", { ctrlKey: true });
  expect(input().value).toBe("");
  press("k", { ctrlKey: true }, input());
  expect(dialog()).toBeNull();
});

it("runs actions: New Tag, the keyboard shortcuts, and the Gateway settings", () => {
  const { onNewTag, addGateway } = render();
  press("k", { ctrlKey: true });
  type("new tag");
  press("Enter", {}, input());
  expect(onNewTag).toHaveBeenCalledOnce();
  expect(dialog()).toBeNull();

  press("k", { ctrlKey: true });
  type("add gateway");
  press("Enter", {}, input());
  expect(addGateway).toHaveBeenCalledOnce();

  press("k", { ctrlKey: true });
  type("keyboard");
  press("Enter", {}, input());
  expect(dialog()?.textContent).toContain("Keyboard shortcuts");
  expect(dialog()?.querySelectorAll(".shortcut-row").length).toBe(keyboardShortcuts().length);
});

it("keeps New Tag, without running it, when this connection cannot create Tags", () => {
  const { onNewTag } = render({ onNewTag: undefined, newTagRefusal: "Operators only" });
  press("k", { ctrlKey: true });
  const item = [...document.querySelectorAll("[cmdk-item]")].find(
    (row) => row.querySelector(".palette-label")?.textContent === "New Tag",
  );
  expect(item?.getAttribute("data-disabled")).toBe("true");
  expect(item?.querySelector(".palette-caption")?.textContent).toBe("Operators only");
  expect(onNewTag).not.toHaveBeenCalled();
});

it("offers actions without Tags while disconnected", () => {
  render({ tags: [], summaries: {}, connected: false });
  act(() => (document.querySelector('.sidebar [aria-label="Search"]') as HTMLElement).click());
  expect(section("Tags")).toBeUndefined();
  expect(labels("Actions")).toEqual(["New Tag", "Keyboard shortcuts", "Add Gateway"]);
});

it("searches names, IDs, previews and messages, needing every word", () => {
  const actions = [{ id: "a", label: "Add Gateway", keywords: "connect", run() {} }];
  const texts = (tagId: string) => messages[tagId] ?? [];
  const found = (query: string) => searchPalette(query, tags, summaries, actions, texts);
  expect(found("").tags.map((entry) => entry.tag.tagId)).toEqual(["finch", "lead", "moss"]);
  expect(found("LEAD").tags.map((entry) => entry.index)).toEqual([1]);
  expect(found("run tests").tags.map((entry) => entry.tag.tagId)).toEqual(["moss"]);
  expect(found("friday release").tags[0]?.caption).toMatch(/staging deploy/);
  expect(found("friday lockfile").tags).toEqual([]);
  expect(found("connect").actions).toEqual(actions);
  expect(snippet(`${"a".repeat(100)} needle ${"b".repeat(100)}`, "needle", 40)).toMatch(
    /^….*needle.*…$/,
  );
});

it("offers the Gateway menu's choices as actions", () => {
  const onSelect = vi.fn();
  const onNotifications = vi.fn();
  const actions = gatewayActions({
    active: "https://team.example",
    profiles: [
      { name: "Team", origin: "https://team.example" },
      { name: "Lab", origin: "https://lab.example" },
    ],
    local: { origin: "http://127.0.0.1:7600" },
    busy: false,
    switching: false,
    notifications: "all",
    onSelect,
    onEdit: vi.fn(),
    onDisconnect: vi.fn(),
    onNotifications,
  });
  expect(actions.map((action) => action.label)).toEqual([
    "Switch to Local",
    "Switch to Lab",
    "Add Gateway",
    "Edit Gateway · Team",
    "Edit Gateway · Lab",
    "Notifications · All messages",
    "Notifications · Questions only",
    "Notifications · Off",
    "Disconnect",
  ]);
  actions[1]?.run();
  expect(onSelect).toHaveBeenCalledWith("https://lab.example");
  actions[6]?.run();
  expect(onNotifications).toHaveBeenCalledWith("questions");
});

it("opens the shown Tag's memory, in its details panel, as the Tag's name does", () => {
  const onTagDetails = vi.fn();
  render({ onTagDetails });
  press("k", { ctrlKey: true });
  type("remember");
  expect(labels("Actions")).toEqual(["Memory"]);
  press("Enter", {}, input());
  expect(onTagDetails).toHaveBeenCalledWith(true);
  expect(dialog()).toBeNull();
  // Without the panel, or without a Tag in view, there is nothing to open.
  render();
  press("k", { ctrlKey: true });
  type("memory");
  expect(section("Actions")).toBeUndefined();
});
