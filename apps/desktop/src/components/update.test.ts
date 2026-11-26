// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../electron/update-state";
import {
  installFailure,
  UpdateBanner,
  UpdateButton,
  type UpdateSource,
  updateView,
  useUpdates,
} from "./update";

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

/** A source whose status the test changes, as the main process would push it. */
function source(first: UpdateStatus) {
  const listeners = new Set<(status: UpdateStatus) => void>();
  const fake = {
    status: vi.fn(async () => first),
    subscribe(changed: (status: UpdateStatus) => void) {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    install: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    push(status: UpdateStatus) {
      act(() => {
        for (const changed of listeners) changed(status);
      });
    },
  };
  return fake satisfies UpdateSource;
}

/** The banner and the sidebar's button, wide or in the rail, for `updates`. */
function Harness({ updates, wide }: { updates: UpdateSource; wide: boolean }) {
  const state = useUpdates(updates);
  return createElement(
    "div",
    null,
    createElement(UpdateButton, { updates: state, wide }),
    createElement(UpdateBanner, { updates: state }),
  );
}

/** Renders a fresh window, as a launch would, for `updates`. */
async function show(updates: UpdateSource, wide = true) {
  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness, { updates, wide })));
  return {
    banner: () => host.querySelector(".update-banner") as HTMLElement | null,
    button: () => host.querySelector(".sidebar-update") as HTMLElement | null,
    click(label: string) {
      const target = [...host.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      );
      if (!target) throw new Error(`no ${label} button in ${host.innerHTML}`);
      act(() => target.click());
    },
  };
}

it("shows nothing while there is no update, or updates are off", async () => {
  for (const status of [
    { state: "off" },
    { state: "idle" },
    { state: "checking", manual: true },
  ] as UpdateStatus[]) {
    expect(updateView(status)).toEqual({});
    const shown = await show(source(status));
    expect(shown.banner()).toBeNull();
    expect(shown.button()).toBeNull();
  }
});

it("shows download progress at the sidebar's foot, without a banner", async () => {
  const updates = source({ state: "downloading", version: "0.3.6", percent: 42 });
  const shown = await show(updates);
  expect(shown.banner()).toBeNull();
  const progress = shown.button();
  expect(progress?.getAttribute("role")).toBe("progressbar");
  expect(progress?.getAttribute("aria-valuenow")).toBe("42");
  expect(progress?.textContent).toBe("Downloading 0.3.6 · 42%");
  const bar = progress?.querySelector(".sidebar-update-bar span") as HTMLElement | null;
  expect(bar?.style.width).toBe("42%");
  updates.push({ state: "downloading", version: "0.3.6", percent: 80 });
  expect(shown.button()?.getAttribute("aria-valuenow")).toBe("80");
});

it("says a downloaded update is being prepared, and offers no restart until it is ready", async () => {
  const updates = source({ state: "preparing", version: "0.3.6" });
  const shown = await show(updates);
  expect(shown.banner()).toBeNull();
  const progress = shown.button();
  expect(progress?.getAttribute("role")).toBe("progressbar");
  expect(progress?.hasAttribute("aria-valuenow")).toBe(false);
  expect(progress?.textContent).toBe("Preparing 0.3.6…");
  expect(host.querySelectorAll("button")).toHaveLength(0);
  updates.push({ state: "ready", version: "0.3.6" });
  expect(shown.banner()?.textContent).toContain("it installs when you quit");
  expect(shown.button()?.textContent).toBe("Update to 0.3.6");
});

it("offers a downloaded update in a banner and at the sidebar's foot", async () => {
  const updates = source({ state: "ready", version: "0.3.6" });
  const shown = await show(updates);
  expect(shown.banner()?.querySelector(".update-banner-title")?.textContent).toBe(
    "SuperTag 0.3.6 is ready",
  );
  expect(shown.button()?.textContent).toBe("Update to 0.3.6");
  shown.click("Restart to update");
  expect(updates.install).toHaveBeenCalledOnce();
});

it("hides the banner on Later, keeps the sidebar's button, and shows a newer version again", async () => {
  const updates = source({ state: "ready", version: "0.3.6" });
  const shown = await show(updates);
  shown.click("Later");
  expect(shown.banner()).toBeNull();
  expect(shown.button()?.textContent).toBe("Update to 0.3.6");
  shown.click("Update to 0.3.6");
  expect(updates.install).toHaveBeenCalledOnce();
  updates.push({ state: "ready", version: "0.3.7" });
  expect(shown.banner()?.textContent).toContain("SuperTag 0.3.7 is ready");
});

it("on Linux offers the release's download instead of a restart", async () => {
  const updates = source({ state: "available", version: "0.3.6" });
  const shown = await show(updates);
  expect(shown.banner()?.textContent).toContain("SuperTag 0.3.6 is available");
  expect(shown.banner()?.textContent).not.toContain("Restart");
  expect(shown.button()?.textContent).toBe("Download 0.3.6");
  shown.click("Download 0.3.6");
  expect(updates.install).toHaveBeenCalledOnce();
});

it("offers GitHub when a download or a menu check failed", async () => {
  const failed = await show(source({ state: "error", stage: "download", version: "0.3.6" }));
  expect(failed.banner()?.dataset["tone"]).toBe("error");
  expect(failed.banner()?.textContent).toContain("Couldn't download SuperTag 0.3.6");
  expect(failed.button()?.textContent).toBe("Download 0.3.6");
  failed.click("Download from GitHub");

  const unchecked = await show(source({ state: "error", stage: "check" }));
  expect(unchecked.banner()?.textContent).toContain("Couldn't check for updates");
  expect(unchecked.button()).toBeNull();
});

it("shows an install in progress, then a failed install with GitHub instead", async () => {
  const updates = source({ state: "installing", version: "0.3.6" });
  const shown = await show(updates);
  expect(shown.banner()?.textContent).toContain("Installing SuperTag 0.3.6…");
  const restarting = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Restarting…",
  );
  expect(restarting?.disabled).toBe(true);
  expect((shown.button() as HTMLButtonElement).disabled).toBe(true);

  updates.push({ state: "error", stage: "install", version: "0.3.6" });
  expect(shown.banner()?.dataset["tone"]).toBe("error");
  expect(shown.banner()?.querySelector(".update-banner-title")?.textContent).toBe(
    "Couldn't install the update",
  );
  expect(shown.button()?.textContent).toBe("Download 0.3.6");
  shown.click("Download from GitHub");
  expect(updates.install).toHaveBeenCalledOnce();
});

it("says why the install failed", async () => {
  const updates = source({ state: "ready", version: "0.3.6" });
  updates.install.mockRejectedValueOnce("Could not open the release page in your browser.");
  const shown = await show(updates);
  await act(async () => shown.click("Restart to update"));
  expect(shown.banner()?.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not open the release page in your browser.",
  );
});

it("shows only an icon in the rail, named for screen readers", async () => {
  const shown = await show(source({ state: "ready", version: "0.3.6" }), false);
  const button = shown.button();
  expect(button?.textContent).toBe("");
  expect(button?.getAttribute("aria-label")).toBe("Update to 0.3.6");
});

it("says why an update didn't install and what to do about it", () => {
  const banner = (status: UpdateStatus) => updateView(status).banner;
  const failed = { state: "error", stage: "install", version: "0.3.15" } as const;
  expect(banner(failed)?.detail).toBe(
    "SuperTag 0.3.15 didn't install. Download it from GitHub instead.",
  );
  expect(banner({ ...failed, cause: "read-only", message: "Cannot update" })?.detail).toContain(
    "move SuperTag to the Applications folder",
  );
  expect(banner({ ...failed, cause: "signature" })?.detail).toContain("isn't the signed release");
  expect(banner({ ...failed, cause: "permission" })?.detail).toContain("can't be changed");
  // An unknown failure shows what the updater said, once, with one full stop.
  expect(installFailure("0.3.15", undefined, "The disk is full.")).toBe(
    "SuperTag 0.3.15 didn't install: The disk is full. Download it from GitHub instead.",
  );
  // A new cause is a new banner: "Later" on the old one doesn't hide it.
  expect(banner(failed)?.key).not.toBe(banner({ ...failed, cause: "read-only" })?.key);
});
