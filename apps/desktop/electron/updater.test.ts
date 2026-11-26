import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { UpdateStatus } from "./update-state";
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  FOCUS_CHECK_MS,
  hasTeam,
  InstallNote,
  latestRelease,
  localFeed,
  type MacEngine,
  UPDATES_OFF,
  Updater,
  type UpdaterHost,
  updatedLine,
  upToDate,
} from "./updater";

/**
 * electron-updater's macOS updater, driven by hand: each check runs `onCheck`, and `staged`
 * is Squirrel.Mac saying it unpacked and verified the download.
 */
function fakeEngine(onCheck: (emit: (event: string, value?: unknown) => void) => Promise<void>) {
  const listeners = new Map<string, (value?: unknown) => void>();
  const emit = (event: string, value?: unknown) => listeners.get(event)?.(value);
  const engine = {
    on(event: string, listener: (value?: unknown) => void) {
      listeners.set(event, listener);
      return engine;
    },
    onStaged(listener: () => void) {
      listeners.set("staged", listener);
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
  const logged: string[] = [];
  const clock = { now: 1_000_000 };
  const full: UpdaterHost = {
    version: "0.3.5",
    mode: "install",
    publish: (status) => published.push(status),
    openExternal: vi.fn(async () => {}),
    say: (message) => said.push(message),
    noteInstall: vi.fn(),
    log() {},
    info: (message) => logged.push(message),
    now: () => clock.now,
    setTimeout: (run, ms) => timers.push({ kind: "timeout", ms, run }),
    setInterval: (run, ms) => timers.push({ kind: "interval", ms, run }),
    ...overrides,
  };
  return { host: full, published, said, timers, logged, clock };
}

it("checks shortly after launch and then every hour", () => {
  const { host: h, timers } = host({});
  new Updater(h).start();
  expect(timers.map(({ kind, ms }) => [kind, ms])).toEqual([
    ["timeout", FIRST_CHECK_MS],
    ["interval", CHECK_EVERY_MS],
  ]);
  expect(CHECK_EVERY_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
});

it("checks when the window comes to the front, unless a check ran a short while ago", async () => {
  const { engine } = fakeEngine(async (emit) => {
    emit("checking-for-update");
    emit("update-not-available");
  });
  const { host: h, clock } = host({ engine: () => engine });
  const updater = new Updater(h);
  updater.start();
  // The window's first focus leaves the first check to its timer.
  updater.noticed();
  expect(engine.checkForUpdates).not.toHaveBeenCalled();
  clock.now += FOCUS_CHECK_MS;
  updater.noticed();
  expect(engine.checkForUpdates).toHaveBeenCalledOnce();
  // Joins the check the focus started, then runs one of its own, as the hourly timer does.
  await updater.check(false);
  await updater.check(false);
  clock.now += FOCUS_CHECK_MS - 1;
  updater.noticed();
  expect(engine.checkForUpdates).toHaveBeenCalledTimes(2);
  clock.now += 1;
  updater.noticed();
  expect(engine.checkForUpdates).toHaveBeenCalledTimes(3);
});

it("downloads and stages on macOS without being asked, and is ready only once staged", async () => {
  const { engine, emit } = fakeEngine(async (emit) => {
    emit("checking-for-update");
    emit("update-available", { version: "0.3.6" });
    emit("download-progress", { percent: 42.5 });
    emit("update-downloaded", { version: "0.3.6" });
  });
  const { host: h, published, logged, clock } = host({ engine: () => engine });
  const updater = new Updater(h);
  await updater.check(false);
  expect(published).toEqual([
    { state: "checking", manual: false },
    { state: "downloading", version: "0.3.6", percent: 0 },
    { state: "downloading", version: "0.3.6", percent: 42 },
    { state: "preparing", version: "0.3.6" },
  ]);
  // Downloaded is not ready: restarting now would wait for Squirrel.Mac, so nothing restarts,
  // nothing is noted, and no check hands Squirrel.Mac the zip a second time.
  expect(h.noteInstall).not.toHaveBeenCalled();
  await updater.check(true);
  updater.noticed();
  expect(engine.checkForUpdates).toHaveBeenCalledOnce();
  await updater.install();
  expect(engine.quitAndInstall).not.toHaveBeenCalled();

  clock.now += 12_000;
  emit("staged");
  expect(published.at(-1)).toEqual({ state: "ready", version: "0.3.6" });
  // A quit installs it from here on, so the next launch is told already.
  expect(h.noteInstall).toHaveBeenLastCalledWith("0.3.5", "0.3.6");
  // A staged update is never checked past.
  await updater.check(false);
  expect(engine.checkForUpdates).toHaveBeenCalledOnce();

  clock.now += 60_000;
  await updater.install();
  expect(h.noteInstall).toHaveBeenLastCalledWith("0.3.5", "0.3.6", clock.now);
  expect(engine.quitAndInstall).toHaveBeenCalledOnce();
  expect(updater.status).toEqual({ state: "installing", version: "0.3.6" });
  // A second click while the app quits does nothing.
  await updater.install();
  expect(engine.quitAndInstall).toHaveBeenCalledOnce();
  clock.now += 300;
  updater.quitting();

  expect(logged).toEqual([
    "Update 0.3.6: found, downloading.",
    "Update 0.3.6: downloaded in 0 ms, staging.",
    "Update 0.3.6: staged in 12000 ms, installs on restart or quit.",
    "Update 0.3.6: restart requested.",
    "Update 0.3.6: quitting to install, 300 ms after the restart was requested.",
  ]);
});

it("logs that an ordinary quit installs a staged update", async () => {
  const { engine, emit } = fakeEngine(async (emit) => {
    emit("update-available", { version: "0.3.6" });
    emit("update-downloaded", { version: "0.3.6" });
  });
  const { host: h, logged } = host({ engine: () => engine });
  const updater = new Updater(h);
  updater.quitting();
  await updater.check(false);
  updater.quitting();
  expect(logged.at(-1)).toBe("Update 0.3.6: downloaded in 0 ms, staging.");
  emit("staged");
  updater.quitting();
  expect(logged.at(-1)).toBe("Update 0.3.6: installs now that SuperTag quits.");
  expect(engine.quitAndInstall).not.toHaveBeenCalled();
});

it("shows Squirrel.Mac refusing an update as the install's error", async () => {
  const { engine, emit } = fakeEngine(async (emit) => {
    emit("update-available", { version: "0.3.6" });
    emit("update-downloaded", { version: "0.3.6" });
  });
  const log = vi.fn();
  const { host: h, published } = host({ engine: () => engine, log });
  const updater = new Updater(h);
  await updater.check(false);
  // What an unsigned build gets from Squirrel.Mac while it stages the download.
  emit("error", new Error("Could not get code signature for running application"));
  expect(published.at(-1)).toEqual({
    state: "error",
    stage: "install",
    version: "0.3.6",
    cause: "signature",
    message: "Could not get code signature for running application",
  });
  expect(log).toHaveBeenCalledWith("The update failed (preparing):", expect.any(Error));
  expect(h.noteInstall).not.toHaveBeenCalled();
  // The banner's "Download from GitHub" now opens the release page.
  await updater.install();
  expect(h.openExternal).toHaveBeenCalledWith(
    "https://github.com/atemaguer/supertag/releases/tag/v0.3.6",
  );
  expect(engine.quitAndInstall).not.toHaveBeenCalled();

  // A later check tries it again behind the banner, which changes only once it is staged.
  const before = published.length;
  await updater.check(false);
  expect(engine.checkForUpdates).toHaveBeenCalledTimes(2);
  expect(published).toHaveLength(before);
  emit("staged");
  expect(updater.status).toEqual({ state: "ready", version: "0.3.6" });

  // A failure after "Restart to update", or quitAndInstall throwing at once, is the same error.
  await updater.install();
  emit("error", new Error("ShipIt could not be started"));
  expect(updater.status).toEqual({
    state: "error",
    stage: "install",
    version: "0.3.6",
    message: "ShipIt could not be started",
  });

  const throwing = fakeEngine(async (emit) => emit("update-downloaded", { version: "0.3.6" }));
  throwing.engine.quitAndInstall.mockImplementation(() => {
    throw new Error("no feed");
  });
  const other = host({ engine: () => throwing.engine });
  const second = new Updater(other.host);
  await second.check(false);
  throwing.emit("staged");
  await second.install();
  expect(second.status).toEqual({
    state: "error",
    stage: "install",
    version: "0.3.6",
    message: "no feed",
  });
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
  // The next check downloads it again without being asked.
  await updater.check(false);
  expect(engine.checkForUpdates).toHaveBeenCalledTimes(2);
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
  const old = new InstallNote(dir, "0.3.5");
  expect(old.updated()).toBeUndefined();
  old.write("0.3.5", "0.3.6");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ from: "0.3.5", to: "0.3.6" });
  expect((await stat(file)).mode & 0o777).toBe(0o600);

  // Installed by an ordinary quit: no restart to time.
  const updated = new InstallNote(dir, "0.3.6");
  expect(updated.installed()).toBe(true);
  expect(updated.updated()).toEqual({ from: "0.3.5" });
  updated.done();
  expect(updated.installed()).toBe(false);
  expect(updated.updated()).toEqual({ from: "0.3.5" });
  expect(new InstallNote(dir, "0.3.6").installed()).toBe(false);

  // "Restart to update" adds when it was asked.
  old.write("0.3.5", "0.3.6", 1_700_000_000_000);
  expect(new InstallNote(dir, "0.3.6").updated()).toEqual({
    from: "0.3.5",
    restartedAt: 1_700_000_000_000,
  });
  // Only a version and a time are read from it.
  await writeFile(file, JSON.stringify({ from: "x\ny", to: "0.3.6", restartedAt: "soon" }));
  const odd = new InstallNote(dir, "0.3.6");
  expect(odd.installed()).toBe(true);
  expect(odd.updated()).toBeUndefined();

  // An install that never happened: the old version launches again and drops the note.
  await writeFile(file, JSON.stringify({ from: "0.3.5", to: "0.3.6" }));
  const same = new InstallNote(dir, "0.3.5");
  expect(same.installed()).toBe(false);
  expect(same.updated()).toBeUndefined();
  await expect(stat(file)).rejects.toThrow();
  // No note, or a broken one, is nothing to do.
  expect(new InstallNote(dir, "0.3.6").installed()).toBe(false);
  await writeFile(file, "{");
  expect(new InstallNote(dir, "0.3.6").installed()).toBe(false);
});

it("says how long the first launch after an update took", () => {
  expect(updatedLine({ from: "0.3.5", restartedAt: 10_000 }, "0.3.6", 24_500.4, 25_300)).toBe(
    "Updated from 0.3.5 to 0.3.6: launched 14500 ms after the restart was requested, window shown 800 ms after launch, 15300 ms in all.",
  );
  expect(updatedLine({ from: "0.3.5" }, "0.3.6", 24_500, 25_300)).toBe(
    "Updated from 0.3.5 to 0.3.6, installed when SuperTag quit: window shown 800 ms after launch.",
  );
});
