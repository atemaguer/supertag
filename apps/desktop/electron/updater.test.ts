import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { UpdateStatus } from "./update-state";
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  hasTeam,
  InstallNote,
  latestRelease,
  localFeed,
  type MacEngine,
  UPDATES_OFF,
  Updater,
  type UpdaterHost,
  upToDate,
} from "./updater";

/** electron-updater's macOS updater, driven by hand: each check runs `onCheck`. */
function fakeEngine(onCheck: (emit: (event: string, value?: unknown) => void) => Promise<void>) {
  const listeners = new Map<string, (value?: unknown) => void>();
  const emit = (event: string, value?: unknown) => listeners.get(event)?.(value);
  const engine = {
    on(event: string, listener: (value?: unknown) => void) {
      listeners.set(event, listener);
      return engine;
    },
    checkForUpdates: vi.fn(() => onCheck(emit)),
    quitAndInstall: vi.fn(),
  };
  return { engine: engine as unknown as MacEngine & typeof engine, emit };
}

function host(overrides: Partial<UpdaterHost>) {
  const published: UpdateStatus[] = [];
  const said: string[] = [];
  const timers: { kind: string; ms: number; run: () => void }[] = [];
  const full: UpdaterHost = {
    version: "0.3.5",
    mode: "install",
    publish: (status) => published.push(status),
    openExternal: vi.fn(async () => {}),
    say: (message) => said.push(message),
    noteInstall: vi.fn(),
    forgetInstall: vi.fn(),
    log() {},
    setTimeout: (run, ms) => timers.push({ kind: "timeout", ms, run }),
    setInterval: (run, ms) => timers.push({ kind: "interval", ms, run }),
    ...overrides,
  };
  return { host: full, published, said, timers };
}

it("checks shortly after launch and then every few hours", () => {
  const { host: h, timers } = host({});
  new Updater(h).start();
  expect(timers.map(({ kind, ms }) => [kind, ms])).toEqual([
    ["timeout", FIRST_CHECK_MS],
    ["interval", CHECK_EVERY_MS],
  ]);
  expect(CHECK_EVERY_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
});

it("downloads on macOS, then restarts into the update after noting it", async () => {
  const { engine } = fakeEngine(async (emit) => {
    emit("checking-for-update");
    emit("update-available", { version: "0.3.6" });
    emit("download-progress", { percent: 42.5 });
    emit("update-downloaded", { version: "0.3.6" });
  });
  const { host: h, published } = host({ engine: () => engine });
  const updater = new Updater(h);
  await updater.check(false);
  expect(published).toEqual([
    { state: "checking", manual: false },
    { state: "downloading", version: "0.3.6", percent: 0 },
    { state: "downloading", version: "0.3.6", percent: 42 },
    { state: "ready", version: "0.3.6" },
  ]);
  // A downloaded update is never checked past.
  await updater.check(false);
  expect(engine.checkForUpdates).toHaveBeenCalledOnce();

  await updater.install();
  expect(h.noteInstall).toHaveBeenCalledWith("0.3.5", "0.3.6");
  expect(engine.quitAndInstall).toHaveBeenCalledOnce();
  expect(updater.status).toEqual({ state: "installing", version: "0.3.6" });
  expect(h.forgetInstall).not.toHaveBeenCalled();
  // A second click while Squirrel.Mac works does nothing.
  await updater.install();
  expect(engine.quitAndInstall).toHaveBeenCalledOnce();
});

it("shows Squirrel.Mac refusing an update as the install's error, and forgets the note", async () => {
  const { engine, emit } = fakeEngine(async (emit) => {
    emit("update-available", { version: "0.3.6" });
    emit("update-downloaded", { version: "0.3.6" });
  });
  const log = vi.fn();
  const { host: h, published } = host({ engine: () => engine, log });
  const updater = new Updater(h);
  await updater.check(false);
  await updater.install();
  // What an unsigned build gets from Squirrel.Mac, after quitAndInstall returned.
  emit("error", new Error("Could not get code signature for running application"));
  expect(published.at(-1)).toEqual({ state: "error", stage: "install", version: "0.3.6" });
  expect(h.forgetInstall).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith("The update failed (installing):", expect.any(Error));
  // The banner's "Download from GitHub" now opens the release page.
  await updater.install();
  expect(h.openExternal).toHaveBeenCalledWith(
    "https://github.com/atemaguer/supertag/releases/tag/v0.3.6",
  );

  // quitAndInstall throwing at once is the same failure.
  const throwing = fakeEngine(async (emit) => emit("update-downloaded", { version: "0.3.6" }));
  throwing.engine.quitAndInstall.mockImplementation(() => {
    throw new Error("no feed");
  });
  const other = host({ engine: () => throwing.engine });
  const second = new Updater(other.host);
  await second.check(false);
  await second.install();
  expect(second.status).toEqual({ state: "error", stage: "install", version: "0.3.6" });
});

it("says a menu check found nothing newer, and stays quiet otherwise", async () => {
  const { engine } = fakeEngine(async (emit) => {
    emit("checking-for-update");
    emit("update-not-available");
  });
  const { host: h, said } = host({ engine: () => engine });
  const updater = new Updater(h);
  await updater.check(false);
  expect(said).toEqual([]);
  await updater.check(true);
  expect(said).toEqual([upToDate("0.3.5")]);
});

it("joins a check that is already running", async () => {
  let finish = () => {};
  const { engine } = fakeEngine(
    (emit) =>
      new Promise((resolve) => {
        emit("checking-for-update");
        finish = () => {
          emit("update-not-available");
          resolve();
        };
      }),
  );
  const { host: h, said } = host({ engine: () => engine });
  const updater = new Updater(h);
  const background = updater.check(false);
  const asked = updater.check(true);
  finish();
  await Promise.all([background, asked]);
  expect(engine.checkForUpdates).toHaveBeenCalledOnce();
  expect(said).toEqual([upToDate("0.3.5")]);
});

it("shows a failed download, and opens its release page instead", async () => {
  const { engine } = fakeEngine(async (emit) => {
    emit("checking-for-update");
    emit("update-available", { version: "0.3.6" });
    emit("error", new Error("socket hang up"));
    throw new Error("socket hang up");
  });
  const log = vi.fn();
  const { host: h, published } = host({ engine: () => engine, log });
  const updater = new Updater(h);
  await updater.check(false);
  expect(published.at(-1)).toEqual({ state: "error", stage: "download", version: "0.3.6" });
  expect(log).toHaveBeenCalled();
  await updater.install();
  expect(h.openExternal).toHaveBeenCalledWith(
    "https://github.com/atemaguer/supertag/releases/tag/v0.3.6",
  );
  expect(engine.quitAndInstall).not.toHaveBeenCalled();
});

it("on Linux only finds a newer release and opens its page", async () => {
  let latest: string | undefined = "0.3.6";
  const {
    host: h,
    published,
    said,
  } = host({
    mode: "download",
    latestRelease: async () => latest,
  });
  const updater = new Updater(h);
  await updater.check(false);
  expect(updater.status).toEqual({ state: "available", version: "0.3.6" });
  await updater.install();
  expect(h.openExternal).toHaveBeenCalledWith(
    "https://github.com/atemaguer/supertag/releases/tag/v0.3.6",
  );
  expect(published).toContainEqual({ state: "available", version: "0.3.6" });

  // Nothing newer: a menu check says so.
  latest = "0.3.5";
  const current = new Updater({ ...h, latestRelease: async () => latest });
  await current.check(true);
  expect(current.status).toEqual({ state: "idle" });
  expect(said).toEqual([upToDate("0.3.5")]);
});

it("does nothing in a build whose updates are off, and says so from the menu", async () => {
  const engine = vi.fn();
  const { host: h, said, timers } = host({ mode: "off", engine });
  const updater = new Updater(h);
  updater.start();
  await updater.check(true);
  expect(timers).toEqual([]);
  expect(engine).not.toHaveBeenCalled();
  expect(said).toEqual([UPDATES_OFF]);
  await expect(updater.install()).rejects.toBe(UPDATES_OFF);
});

it("reads the latest published release from GitHub's release page", async () => {
  const answer = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status });
  const fetch = vi.fn(answer(200, { tag_name: "v0.3.6" }));
  expect(await latestRelease(fetch)).toBe("0.3.6");
  expect(fetch).toHaveBeenCalledWith("https://github.com/atemaguer/supertag/releases/latest", {
    headers: { Accept: "application/json" },
  });
  expect(await latestRelease(answer(200, { tag_name: "v0.4.0-alpha.1" }))).toBeUndefined();
  expect(await latestRelease(answer(200, { tag_name: "nightly" }))).toBeUndefined();
  await expect(latestRelease(answer(404, {}))).rejects.toThrow("404");
});

it("tells a Developer ID signature from an ad-hoc one", () => {
  expect(hasTeam("Identifier=ai.supertag.desktop\nTeamIdentifier=ABCDE12345\n")).toBe(true);
  expect(hasTeam("Signature=adhoc\nTeamIdentifier=not set\n")).toBe(false);
  expect(hasTeam("")).toBe(false);
});

it("takes a local update feed only on this machine", () => {
  expect(localFeed("http://127.0.0.1:8765/")).toBe("http://127.0.0.1:8765/");
  expect(localFeed("http://localhost:8765/feed")).toBe("http://localhost:8765/feed");
  expect(localFeed("https://example.com/")).toBeUndefined();
  expect(localFeed("http://10.0.0.2/")).toBeUndefined();
  expect(localFeed("nonsense")).toBeUndefined();
  expect(localFeed(undefined)).toBeUndefined();
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "supertag-update-note-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("notes an install for the first launch of the new version only", async () => {
  const file = path.join(dir, "update.json");
  new InstallNote(dir, "0.3.5").write("0.3.5", "0.3.6");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ from: "0.3.5", to: "0.3.6" });
  expect((await stat(file)).mode & 0o777).toBe(0o600);

  const updated = new InstallNote(dir, "0.3.6");
  expect(updated.installed()).toBe(true);
  updated.done();
  expect(updated.installed()).toBe(false);
  expect(new InstallNote(dir, "0.3.6").installed()).toBe(false);

  // An install that never happened: the old version launches again and drops the note.
  await writeFile(file, JSON.stringify({ from: "0.3.5", to: "0.3.6" }));
  expect(new InstallNote(dir, "0.3.5").installed()).toBe(false);
  await expect(stat(file)).rejects.toThrow();
  // No note, or a broken one, is nothing to do.
  expect(new InstallNote(dir, "0.3.6").installed()).toBe(false);
  await writeFile(file, "{");
  expect(new InstallNote(dir, "0.3.6").installed()).toBe(false);
});
