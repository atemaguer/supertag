// @vitest-environment happy-dom

import type { Gateway, GatewayList, Tag, TagAdmin } from "@supertag/client/model";
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../electron/update-state";
import { readSendKey, sendKeyWords, sendsMessage } from "../lib/preferences";
import {
  isSettingsShortcut,
  pendingPage,
  SettingsButton,
  type SettingsConnection,
  SettingsDialog,
  type SettingsPageId,
  type SettingsProps,
  updateLine,
} from "./settings";
import { sidebarMode } from "./sidebar";
import { type UpdateSource, useUpdates } from "./update";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const flush = () => act(async () => {});
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const named = (role: string, name: string) =>
  [...(dialog()?.querySelectorAll<HTMLElement>(`[role="${role}"], ${role}`) ?? [])].find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent) === name,
  );
const button = (name: string) => named("button", name) as HTMLButtonElement | undefined;
const tab = (name: string) => named("tab", name) as HTMLButtonElement;
const heading = () => dialog()?.querySelector(".settings-page h2")?.textContent;
const rows = () =>
  [...(dialog()?.querySelectorAll(".settings-row-label") ?? [])].map((row) => row.textContent);
const gear = () => host.querySelector('button[aria-label="Settings"]') as HTMLButtonElement;

function source(status: UpdateStatus) {
  return {
    status: vi.fn(async () => status),
    subscribe: () => () => {},
    install: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
  } satisfies UpdateSource;
}

const tag = (tagId: string, extra: Partial<Tag> = {}): Tag => ({
  tagId,
  instructions: "",
  allowedActions: ["files:read"],
  revision: 1,
  harnessKind: "codex",
  ...extra,
});
const tags = [tag("finch", { lead: true, workspace: { id: "site", ref: "main" } }), tag("moss")];
const connected = (extra: Partial<SettingsConnection> = {}): SettingsConnection => ({
  gateway: { tags: async () => tags } as unknown as Gateway,
  origin: "https://team.example.com",
  release: { build: "0.3.9", protocol: 7 },
  tags,
  ...extra,
});
const saved: GatewayList = {
  profiles: [
    { name: "Team", origin: "https://team.example.com" },
    { name: "Lab", origin: "https://lab.example.com" },
  ],
};

/** The gear and Settings, as the window wires them. */
function Harness({
  updates: from = source({ state: "idle" }),
  first,
  ...props
}: Partial<Omit<SettingsProps, "updates">> & { updates?: UpdateSource; first?: SettingsPageId }) {
  const updates = useUpdates(from);
  const [page, setPage] = useState<SettingsPageId | undefined>(first);
  const [level, setLevel] = useState<"all" | "questions" | "off">("all");
  const ref = useRef<HTMLButtonElement>(null);
  const pending = pendingPage(updates.status, "0.3.9", props.connection?.release);
  return [
    createElement(SettingsButton, {
      key: "gear",
      button: ref,
      pending: pending !== undefined,
      onOpen: () => setPage(pending ?? "general"),
    }),
    createElement(SettingsDialog, {
      key: "dialog",
      app: "0.3.9",
      gateways: { profiles: [] },
      onSelectGateway: () => {},
      onEditGateway: () => {},
      onDisconnect: () => {},
      notifications: level,
      onNotifications: setLevel,
      returnFocus: ref,
      ...props,
      page,
      onPage: setPage,
      updates,
    }),
  ];
}
async function show(props: Parameters<typeof Harness>[0] = {}) {
  act(() => root.render(createElement(Harness, props)));
  await flush();
}

it("opens with ⌘, on macOS and Ctrl+, elsewhere", () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({
      key: ",",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      ...init,
    }) as KeyboardEvent;
  expect(isSettingsShortcut(key({ metaKey: true }), true)).toBe(true);
  expect(isSettingsShortcut(key({ ctrlKey: true }), false)).toBe(true);
  expect(isSettingsShortcut(key({ ctrlKey: true }), true)).toBe(false);
  expect(isSettingsShortcut(key({ metaKey: true, key: "." }), true)).toBe(false);
});

it("names the page that waits: Updates for an update, About for another Gateway release", () => {
  const same = { build: "0.3.9", protocol: 7 };
  const other = { build: "0.3.3", protocol: 7 };
  expect(pendingPage({ state: "idle" }, "0.3.9", same)).toBeUndefined();
  expect(pendingPage({ state: "off" }, "0.3.9")).toBeUndefined();
  expect(pendingPage({ state: "ready", version: "0.4.0" }, "0.3.9", other)).toBe("updates");
  expect(pendingPage({ state: "error", stage: "check" }, "0.3.9")).toBe("updates");
  expect(pendingPage({ state: "idle" }, "0.3.9", other)).toBe("about");
});

it("words each update status", () => {
  expect(updateLine({ state: "idle" }, false)).toBe("No update is waiting.");
  expect(updateLine({ state: "idle" }, true)).toBe("SuperTag is up to date.");
  expect(updateLine({ state: "off" }, true)).toBe("Updates are off in this build.");
  expect(updateLine({ state: "downloading", version: "0.4.0", percent: 42 }, false)).toBe(
    "Downloading SuperTag 0.4.0 · 42%",
  );
  expect(updateLine({ state: "error", stage: "check" }, true)).toBe("Couldn't check for updates");
});

it("moves between pages by click and arrow keys, and returns to the gear on Esc", async () => {
  await show({ connection: connected() });
  expect(dialog()).toBeNull();
  act(() => gear().click());
  expect(heading()).toBe("General");
  expect(tab("General").getAttribute("aria-selected")).toBe("true");
  // Nothing in the dialog is focused at first, so Enter changes nothing.
  expect(document.activeElement?.getAttribute("role")).toBe("dialog");

  act(() => tab("About").click());
  expect(heading()).toBe("About");
  const press = (key: string) =>
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  act(() => tab("About").focus());
  press("ArrowDown");
  expect(heading()).toBe("Gateways");
  expect(document.activeElement).toBe(tab("Gateways"));
  press("ArrowUp");
  press("ArrowUp");
  expect(heading()).toBe("Updates");
  press("Home");
  expect(heading()).toBe("General");
  press("End");
  expect(heading()).toBe("Permissions");
  // A narrow window's select names the same pages.
  const select = dialog()?.querySelector("select") as HTMLSelectElement;
  expect([...select.options].map((option) => option.value)).toEqual([
    "general",
    "notifications",
    "shortcuts",
    "updates",
    "about",
    "gateways",
    "tags",
    "permissions",
  ]);

  press("Escape");
  await vi.waitFor(async () => {
    await flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(gear());
  });
});

it("opens on the page a link names, and the gear on the page that waits", async () => {
  await show({ first: "shortcuts" });
  expect(heading()).toBe("Keyboard shortcuts");
  expect(dialog()?.querySelectorAll("kbd").length).toBeGreaterThan(5);
  act(() => root.unmount());
  root = createRoot(host);

  const updates = source({ state: "ready", version: "0.4.0" });
  await show({ updates, connection: connected() });
  expect(gear().dataset.pending).toBe("true");
  act(() => gear().click());
  expect(heading()).toBe("Updates");
  expect(rows()).toEqual(["SuperTag 0.4.0 is ready."]);
  act(() => button("Restart to update")?.click());
  expect(updates.install).toHaveBeenCalledTimes(1);
});

it("filters rows across pages as you search, and says when nothing matches", async () => {
  await show({ connection: connected(), gateways: saved });
  act(() => gear().click());
  const search = dialog()?.querySelector('input[type="search"]') as HTMLInputElement;
  const type = (text: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, text);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  type("sidebar");
  expect(heading()).toBe("Search");
  expect(rows()).toEqual(["Sidebar", "Fold the sidebar into a rail, or expand it"]);
  expect([...(dialog()?.querySelectorAll("h3") ?? [])].map((entry) => entry.textContent)).toEqual([
    "General",
    "Keyboard shortcuts",
  ]);
  // A found control works where it is found.
  act(() => named("radio", "Rail")?.click());
  expect(sidebarMode()).toBe("rail");
  type("zzz");
  expect(rows()).toEqual([]);
  expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe('Nothing matches "zzz".');
  // Choosing a page leaves the search.
  act(() => tab("Tags").click());
  expect(search.value).toBe("");
  expect(heading()).toBe("Tags");
});

it("sets the send key, the sidebar and notifications on this device", async () => {
  const onNotifications = vi.fn();
  await show({ onNotifications });
  act(() => gear().click());
  const checked = (group: string) =>
    [...(named("radiogroup", group)?.querySelectorAll('[aria-checked="true"]') ?? [])].map(
      (entry) => entry.textContent,
    );
  expect(checked("Send messages with")).toEqual(["Enter"]);
  act(() => named("radio", "Ctrl+Enter")?.click());
  expect(readSendKey()).toBe("mod-enter");
  expect(checked("Send messages with")).toEqual(["Ctrl+Enter"]);
  // The shortcut list follows the choice.
  act(() => tab("Keyboard shortcuts").click());
  expect(dialog()?.textContent).toContain("Ctrl+Enter");

  act(() => tab("General").click());
  expect(checked("Sidebar")).toEqual(["Expanded"]);
  act(() => named("radio", "Rail")?.click());
  expect(sidebarMode()).toBe("rail");

  act(() => tab("Notifications").click());
  act(() => named("radio", "Questions only")?.click());
  expect(onNotifications).toHaveBeenCalledWith("questions");
});

it("sends with the chosen key and no other", () => {
  const key = (init: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>) => ({
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...init,
  });
  expect(sendsMessage(key({}), "enter", true)).toBe(true);
  expect(sendsMessage(key({ shiftKey: true }), "enter", true)).toBe(false);
  expect(sendsMessage(key({}), "mod-enter", true)).toBe(false);
  expect(sendsMessage(key({ metaKey: true }), "mod-enter", true)).toBe(true);
  expect(sendsMessage(key({ ctrlKey: true }), "mod-enter", false)).toBe(true);
  expect(sendKeyWords("mod-enter", true)).toEqual({ send: "⌘Enter", line: "Enter" });
});

it("checks for updates, and says so when a build has none", async () => {
  const updates = source({ state: "idle" });
  await show({ updates, first: "updates" });
  expect(rows()).toEqual(["No update is waiting."]);
  act(() => button("Check for updates")?.click());
  expect(updates.check).toHaveBeenCalledTimes(1);
  expect(rows()).toEqual(["SuperTag is up to date."]);
  act(() => root.unmount());
  root = createRoot(host);
  await show({ updates: source({ state: "off" }), first: "updates" });
  expect(rows()).toEqual(["Updates are off in this build."]);
  expect(button("Check for updates")?.disabled).toBe(true);
});

it("names the releases, and warns when the Gateway runs another", async () => {
  await show({ first: "about", connection: connected(), gateways: saved });
  expect(dialog()?.textContent).toContain("Team · 0.3.9 · Protocol 7");
  expect(dialog()?.textContent).not.toContain("another release");
  act(() => root.unmount());
  root = createRoot(host);
  await show({
    connection: connected({ release: { build: "0.3.3", protocol: 7 } }),
    gateways: saved,
  });
  // The gear is dotted, and opens the page that says why.
  expect(gear().dataset.pending).toBe("true");
  act(() => gear().click());
  expect(heading()).toBe("About");
  expect(dialog()?.textContent).toContain("This Gateway runs another release than the app.");
  act(() => root.unmount());
  root = createRoot(host);
  await show({ first: "about" });
  expect(dialog()?.textContent).toContain("Not connected");
});

it("lists the saved Gateways, and connects, edits, adds and disconnects", async () => {
  const onSelectGateway = vi.fn();
  const onEditGateway = vi.fn();
  const onDisconnect = vi.fn();
  const props = {
    connection: connected(),
    gateways: saved,
    onSelectGateway,
    onEditGateway,
    onDisconnect,
  };
  await show({ first: "gateways", ...props });
  expect(rows()).toEqual(["TeamConnected", "Lab"]);
  expect(dialog()?.textContent).toContain("https://team.example.com · Release 0.3.9 · Protocol 7");
  act(() => button("Connect to Lab")?.click());
  expect(onSelectGateway).toHaveBeenCalledWith("https://lab.example.com");
  act(() => button("Disconnect from Team")?.click());
  expect(onDisconnect).toHaveBeenCalledTimes(1);
  // The Gateway form is its own dialog, so Settings closes for it.
  act(() => button("Edit Lab")?.click());
  expect(onEditGateway).toHaveBeenCalledWith(saved.profiles[1]);
  await flush();
  expect(dialog()).toBeNull();

  act(() => root.unmount());
  root = createRoot(host);
  await show({ first: "gateways", onEditGateway });
  expect(dialog()?.textContent).toContain("No Gateway is saved yet.");
  act(() => button("Add Gateway")?.click());
  expect(onEditGateway).toHaveBeenLastCalledWith();
});

it("lists the Tags read-only, and opens one's details", async () => {
  const onOpenTag = vi.fn();
  await show({ first: "tags", connection: connected(), onOpenTag });
  expect(rows()).toEqual(["finchLead", "moss"]);
  expect(dialog()?.textContent).toContain("Codex · Workspace site (main)");
  expect(dialog()?.textContent).toContain("Read-only");
  expect(dialog()?.querySelectorAll(".avatar")).toHaveLength(2);
  act(() => button("Open moss")?.click());
  expect(onOpenTag).toHaveBeenCalledWith("moss");
  await flush();
  expect(dialog()).toBeNull();
});

it("shows each Tag's allowed actions read-only, with how to change them", async () => {
  const connection = connected({ tags: [tags[0] as Tag, tag("kite", { allowedActions: [] })] });
  connection.gateway = { tags: async () => connection.tags } as unknown as Gateway;
  await show({ first: "permissions", connection });
  expect(
    [...(dialog()?.querySelectorAll("section") ?? [])].map((card) => card.textContent),
  ).toEqual(["finchfiles:read", "kiteNo allowed actions"]);
  expect(dialog()?.textContent).toContain("supertag apply");
  expect(dialog()?.querySelectorAll("section button, section input")).toHaveLength(0);
});

it("shows the Worker Hosts page only to a connection that may read them", async () => {
  await show({ connection: connected() });
  act(() => gear().click());
  expect(named("tab", "Worker Hosts")).toBeUndefined();
  act(() => root.unmount());
  root = createRoot(host);

  const gateway = {
    tags: async () => tags,
    hostPhases: async () => ({ ready: 2, unreachable: 1 }),
  } as unknown as Gateway;
  const tagAdmin = {
    options: async () => ({ harnesses: ["codex", "claude_code"], workspaces: ["site"] }),
  } as unknown as TagAdmin;
  await show({ first: "hosts", connection: connected({ gateway, tagAdmin }) });
  await flush();
  expect(
    [...(dialog()?.querySelectorAll(".settings-value") ?? [])].map((entry) => entry.textContent),
  ).toEqual(["2 ready, 1 unreachable", "Codex, Claude Code", "site"]);
  expect(dialog()?.textContent).toContain("Read-only");
});
