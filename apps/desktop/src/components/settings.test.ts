// @vitest-environment happy-dom

import type { NotificationLevel } from "@supertag/client/model";
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../electron/update-state";
import {
  isSettingsShortcut,
  SettingsButton,
  SettingsDialog,
  settingsPending,
  updateLine,
} from "./settings";
import { type UpdateSource, useUpdates } from "./update";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const flush = () => act(async () => {});
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const inDialog = (name: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find((entry) => entry.textContent === name);
const gear = () => host.querySelector('button[aria-label="Settings"]') as HTMLButtonElement;

function source(status: UpdateStatus) {
  return {
    status: vi.fn(async () => status),
    subscribe: () => () => {},
    install: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
  } satisfies UpdateSource;
}

/** The gear and its dialog, as the window wires them. */
function Harness({
  updates: from,
  gateway,
  onNotifications,
}: {
  updates: UpdateSource;
  gateway?: { build: string; protocol: number };
  onNotifications?(level: NotificationLevel): void;
}) {
  const updates = useUpdates(from);
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<NotificationLevel>("all");
  const button = useRef<HTMLButtonElement>(null);
  return [
    createElement(SettingsButton, {
      key: "gear",
      button,
      pending: settingsPending(updates.status, "0.3.9", gateway),
      onOpen: () => setOpen(true),
    }),
    createElement(SettingsDialog, {
      key: "dialog",
      open,
      onOpenChange: setOpen,
      app: "0.3.9",
      gatewayName: gateway ? "Local" : undefined,
      gateway,
      updates,
      notifications: level,
      onNotifications: (next) => {
        setLevel(next);
        onNotifications?.(next);
      },
      returnFocus: button,
    }),
  ];
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
  expect(isSettingsShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
  expect(isSettingsShortcut(key({ metaKey: true, key: "." }), true)).toBe(false);
});

it("marks the gear only while an update or a release warning waits", () => {
  const same = { build: "0.3.9", protocol: 7 };
  expect(settingsPending({ state: "idle" }, "0.3.9", same)).toBe(false);
  expect(settingsPending({ state: "off" }, "0.3.9")).toBe(false);
  expect(settingsPending({ state: "ready", version: "0.4.0" }, "0.3.9", same)).toBe(true);
  expect(settingsPending({ state: "downloading", version: "0.4.0", percent: 3 }, "0.3.9")).toBe(
    true,
  );
  expect(settingsPending({ state: "error", stage: "check" }, "0.3.9")).toBe(true);
  expect(settingsPending({ state: "idle" }, "0.3.9", { build: "0.3.3", protocol: 7 })).toBe(true);
});

it("words each update status, and says up to date only after a check asked for here", () => {
  expect(updateLine({ state: "idle" }, false)).toBe("");
  expect(updateLine({ state: "idle" }, true)).toBe("SuperTag is up to date.");
  expect(updateLine({ state: "off" }, true)).toBe("Updates are off in this build.");
  expect(updateLine({ state: "checking", manual: true }, true)).toBe("Checking for updates…");
  expect(updateLine({ state: "downloading", version: "0.4.0", percent: 42 }, false)).toBe(
    "Downloading SuperTag 0.4.0 · 42%",
  );
  expect(updateLine({ state: "available", version: "0.4.0" }, false)).toBe(
    "SuperTag 0.4.0 is available.",
  );
  expect(updateLine({ state: "error", stage: "check" }, true)).toBe("Couldn't check for updates");
});

it("shows the releases, checks for updates, and returns to the gear on Esc", async () => {
  const updates = source({ state: "idle" });
  act(() =>
    root.render(createElement(Harness, { updates, gateway: { build: "0.3.9", protocol: 7 } })),
  );
  await flush();
  expect(gear().getAttribute("title")).toBe("Settings");
  expect(gear().dataset.pending).toBeUndefined();
  expect(dialog()).toBeNull();

  act(() => gear().click());
  const facts = [...(dialog()?.querySelectorAll("dl > *") ?? [])].map((entry) => entry.textContent);
  expect(facts).toEqual([
    "SuperTag",
    "0.3.9",
    "Gateway",
    "Local",
    "Gateway release",
    "0.3.9 · Protocol 7",
  ]);
  // The same release: no warning, and nothing said of updates until asked.
  expect(dialog()?.textContent).not.toContain("another release");
  expect(dialog()?.textContent).not.toContain("up to date");
  act(() => inDialog("Check for updates")?.click());
  expect(updates.check).toHaveBeenCalledTimes(1);
  expect(dialog()?.textContent).toContain("SuperTag is up to date.");

  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  // The dialog hands the focus back as it finishes closing.
  await vi.waitFor(async () => {
    await flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(gear());
  });
});

it("offers a ready update and warns of a Gateway on another release, with a dot on the gear", async () => {
  const updates = source({ state: "ready", version: "0.4.0" });
  act(() =>
    root.render(createElement(Harness, { updates, gateway: { build: "0.3.3", protocol: 7 } })),
  );
  await flush();
  expect(gear().dataset.pending).toBe("true");
  expect(gear().getAttribute("aria-description")).toBeTruthy();
  act(() => gear().click());
  expect(dialog()?.textContent).toContain("This Gateway runs another release than the app.");
  expect(dialog()?.textContent).toContain("SuperTag 0.4.0 is ready.");
  act(() => inDialog("Restart to update")?.click());
  expect(updates.install).toHaveBeenCalledTimes(1);
});

it("has no update to check for in a build with updates off, and says so", async () => {
  const updates = source({ state: "off" });
  act(() => root.render(createElement(Harness, { updates })));
  await flush();
  act(() => gear().click());
  expect(dialog()?.textContent).toContain("Updates are off in this build.");
  expect(inDialog("Check for updates")?.disabled).toBe(true);
  // Disconnected: it names no Gateway release.
  expect(dialog()?.textContent).toContain("Not connected");
  expect(dialog()?.textContent).not.toContain("Gateway release");
});

it("chooses what this device notifies about", async () => {
  const onNotifications = vi.fn();
  act(() =>
    root.render(createElement(Harness, { updates: source({ state: "idle" }), onNotifications })),
  );
  await flush();
  act(() => gear().click());
  const choices = [...(dialog()?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])];
  expect(choices.map((choice) => choice.closest("label")?.textContent)).toEqual([
    "All messages",
    "Questions only",
    "Off",
  ]);
  expect(choices.map((choice) => choice.checked)).toEqual([true, false, false]);
  act(() => choices[1]?.click());
  expect(onNotifications).toHaveBeenCalledWith("questions");
  expect(choices.map((choice) => choice.checked)).toEqual([false, true, false]);
});
