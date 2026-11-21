import { expect, it } from "vitest";
import {
  compareVersions,
  isPrerelease,
  nextUpdateStatus,
  releasePage,
  type UpdateEvent,
  type UpdateStatus,
} from "./update-state";

const run = (start: UpdateStatus, ...events: UpdateEvent[]) =>
  events.reduce(nextUpdateStatus, start);

it("downloads a newer release on macOS and is ready once it has", () => {
  const idle: UpdateStatus = { state: "idle" };
  expect(
    run(
      idle,
      { kind: "checking", manual: false },
      { kind: "found", version: "0.3.6", download: true },
    ),
  ).toEqual({ state: "downloading", version: "0.3.6", percent: 0 });
  expect(
    run(
      idle,
      { kind: "found", version: "0.3.6", download: true },
      { kind: "progress", percent: 41.7 },
    ),
  ).toEqual({ state: "downloading", version: "0.3.6", percent: 41 });
  expect(
    run(
      idle,
      { kind: "found", version: "0.3.6", download: true },
      { kind: "progress", percent: 100 },
      { kind: "downloaded", version: "0.3.6" },
    ),
  ).toEqual({ state: "ready", version: "0.3.6" });
});

it("keeps progress within 0 to 100 and never moving back", () => {
  const downloading: UpdateStatus = { state: "downloading", version: "0.3.6", percent: 50 };
  expect(run(downloading, { kind: "progress", percent: 20 })).toEqual(downloading);
  expect(run(downloading, { kind: "progress", percent: 250 })).toMatchObject({ percent: 100 });
  expect(run(downloading, { kind: "progress", percent: Number.NaN })).toEqual(downloading);
  // Progress outside a download is ignored.
  expect(run({ state: "idle" }, { kind: "progress", percent: 20 })).toEqual({ state: "idle" });
});

it("only says a newer release exists on Linux", () => {
  expect(run({ state: "idle" }, { kind: "found", version: "0.3.6", download: false })).toEqual({
    state: "available",
    version: "0.3.6",
  });
});

it("stays ready whatever a later check says", () => {
  const ready: UpdateStatus = { state: "ready", version: "0.3.6" };
  expect(
    run(
      ready,
      { kind: "checking", manual: false },
      { kind: "none" },
      { kind: "failed" },
      { kind: "found", version: "0.3.6", download: true },
      { kind: "found", version: "0.3.5", download: true },
    ),
  ).toBe(ready);
});

it("shows a failed download, and a failed check only when the menu asked", () => {
  expect(run({ state: "downloading", version: "0.3.6", percent: 30 }, { kind: "failed" })).toEqual({
    state: "error",
    stage: "download",
    version: "0.3.6",
  });
  expect(run({ state: "idle" }, { kind: "checking", manual: false }, { kind: "failed" })).toEqual({
    state: "idle",
  });
  expect(run({ state: "idle" }, { kind: "checking", manual: true }, { kind: "failed" })).toEqual({
    state: "error",
    stage: "check",
  });
  // A known release outlives a failed background check.
  const available: UpdateStatus = { state: "available", version: "0.3.6" };
  expect(run(available, { kind: "checking", manual: false }, { kind: "failed" })).toBe(available);
  // A later check after a failure tries again.
  expect(
    run(
      { state: "error", stage: "download", version: "0.3.6" },
      { kind: "checking", manual: false },
      { kind: "found", version: "0.3.6", download: true },
    ),
  ).toEqual({ state: "downloading", version: "0.3.6", percent: 0 });
});

it("installs a ready update, and shows a failed install as the install's error", () => {
  const ready: UpdateStatus = { state: "ready", version: "0.3.6" };
  const installing = run(ready, { kind: "installing" });
  expect(installing).toEqual({ state: "installing", version: "0.3.6" });
  // Checks, and the download's own events, leave an install alone.
  expect(
    run(
      installing,
      { kind: "checking", manual: true },
      { kind: "none" },
      { kind: "downloaded", version: "0.3.6" },
    ),
  ).toBe(installing);
  // Squirrel.Mac refusing the update.
  expect(run(installing, { kind: "failed" })).toEqual({
    state: "error",
    stage: "install",
    version: "0.3.6",
  });
  // Only a ready update installs.
  expect(run({ state: "idle" }, { kind: "installing" })).toEqual({ state: "idle" });
});

it("ends a check with nothing newer back at idle", () => {
  expect(run({ state: "idle" }, { kind: "checking", manual: true }, { kind: "none" })).toEqual({
    state: "idle",
  });
});

it("never leaves off", () => {
  const off: UpdateStatus = { state: "off" };
  expect(
    run(
      off,
      { kind: "checking", manual: true },
      { kind: "found", version: "0.3.6", download: true },
      { kind: "downloaded", version: "0.3.6" },
    ),
  ).toBe(off);
});

it("orders versions as semantic versioning does", () => {
  expect(compareVersions("0.3.6", "0.3.5")).toBe(1);
  expect(compareVersions("0.3.5", "0.3.10")).toBe(-1);
  expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("0.4.0-alpha.1", "0.4.0")).toBe(-1);
  expect(compareVersions("0.4.0-alpha.2", "0.4.0-alpha.10")).toBe(-1);
  expect(compareVersions("0.4.0-alpha.1", "0.4.0-beta.1")).toBe(-1);
  expect(compareVersions("0.4.0-alpha", "0.4.0-alpha.1")).toBe(-1);
  expect(compareVersions("0.4.0-1", "0.4.0-alpha")).toBe(-1);
  expect(compareVersions("nonsense", "0.0.1")).toBe(-1);
  expect(isPrerelease("0.4.0-alpha.1")).toBe(true);
  expect(isPrerelease("0.4.0")).toBe(false);
});

it("links a release's page, or the latest one", () => {
  expect(releasePage("0.3.6")).toBe("https://github.com/atemaguer/supertag/releases/tag/v0.3.6");
  expect(releasePage()).toBe("https://github.com/atemaguer/supertag/releases/latest");
});
