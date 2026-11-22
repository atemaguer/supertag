/**
 * The app's own updates, in the main process. A check runs shortly after launch, then every hour
 * while the app is open and when its window comes to the front. On macOS a newer published
 * release downloads in the background (electron-updater, from the GitHub Release's latest-mac.yml
 * and zip). Squirrel.Mac then stages it: it takes the zip from electron-updater, unpacks it and
 * verifies its signature, which takes many seconds for an app this size. Only then is the update
 * ready, so "Restart to update" has nothing left to do but quit, swap the app and open it. A
 * staged update also installs when the app quits for any other reason: Squirrel.Mac offers no
 * staging without that. On Linux the app only says a newer release exists and opens its page,
 * because a Debian package can't replace itself. Development and unsigned builds never check.
 *
 * A staged update leaves a note, so the next launch restarts the local services with the new
 * build's CLI (`supertag up` restarts services that run a different build).
 *
 * Each phase writes a line with its duration to the app's log, and the first launch of the new
 * version says how long the restart took.
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compareVersions,
  isPrerelease,
  nextUpdateStatus,
  RELEASES_URL,
  releasePage,
  statusVersion,
  type UpdateEvent,
  type UpdateStatus,
  validVersion,
} from "./update-state";

/** How long after launch the first check waits, so it never slows the window down. */
export const FIRST_CHECK_MS = 15_000;
/** How often the app checks again while it is open. */
export const CHECK_EVERY_MS = 60 * 60 * 1000;
/** The window coming to the front checks too, unless a check ran within this. */
export const FOCUS_CHECK_MS = 15 * 60 * 1000;

/** What the app hears from electron-updater's macOS updater, and from Squirrel.Mac under it. */
export interface MacEngine {
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available", listener: (info: { version: string }) => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  /**
   * Squirrel.Mac staged the downloaded update: Electron's own `autoUpdater` saying
   * "update-downloaded", which electron-updater keeps to itself.
   */
  onStaged(listener: () => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdaterHost {
  /** This app's version. */
  version: string;
  /** How this platform updates: macOS installs, Linux opens the release page; none is off. */
  mode: "install" | "download" | "off";
  /** macOS only: electron-updater, created once updates are on. */
  engine?(): MacEngine;
  /** Linux only: the newest published release's version, or nothing. */
  latestRelease?(): Promise<string | undefined>;
  /** Sends a new status to the window. */
  publish(status: UpdateStatus): void;
  openExternal(url: string): Promise<void>;
  /** Answers a check from the menu that shows nothing in the window: up to date, or off. */
  say(message: string): void;
  /**
   * Notes that the next launch runs `to`, after this one's `from`; `restartedAt` is when the user
   * restarted to update, and absent while the update only waits for a restart or a quit.
   */
  noteInstall(from: string, to: string, restartedAt?: number): void;
  /** Logs a failure. */
  log(message: string, error?: unknown): void;
  /** Logs a phase of an update and how long it took. */
  info(message: string): void;
  /** The time, in milliseconds. */
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  setInterval(run: () => void, ms: number): unknown;
}

/** What a check from the menu says in a build that never updates. */
export const UPDATES_OFF =
  "This build of SuperTag doesn't update itself. Download the latest release from GitHub.";

/** What a check from the menu says when nothing is newer. */
export const upToDate = (version: string) => `SuperTag ${version} is the latest version.`;

export class Updater {
  private current: UpdateStatus;
  private engine: MacEngine | undefined;
  private checking: Promise<void> | undefined;
  private manual = false;
  private checkedAt: number | undefined;
  /** When the phase the log times next began. */
  private since: number | undefined;
  private restartedAt: number | undefined;

  constructor(private readonly host: UpdaterHost) {
    this.current = host.mode === "off" ? { state: "off" } : { state: "idle" };
  }

  get status(): UpdateStatus {
    return this.current;
  }

  /** Starts checking: once shortly after launch, then every hour. */
  start() {
    if (this.host.mode === "off") return;
    // The first check is the timer's, not the window's first focus.
    this.checkedAt = this.host.now();
    this.host.setTimeout(() => void this.check(false), FIRST_CHECK_MS);
    this.host.setInterval(() => void this.check(false), CHECK_EVERY_MS);
  }

  /** The window came to the front: checks, unless a check ran a short while ago. */
  noticed() {
    if (this.host.mode === "off") return;
    if (this.checkedAt !== undefined && this.host.now() - this.checkedAt < FOCUS_CHECK_MS) return;
    void this.check(false);
  }

  /** The app is quitting: says so in the log when that installs an update. */
  quitting() {
    const status = this.current;
    if (this.host.mode !== "install") return;
    if (status.state === "installing" && this.restartedAt !== undefined) {
      const took = this.host.now() - this.restartedAt;
      this.host.info(
        `Update ${status.version}: quitting to install, ${took} ms after the restart was requested.`,
      );
    } else if (status.state === "ready") {
      this.host.info(`Update ${status.version}: installs now that SuperTag quits.`);
    }
  }

  private apply(event: UpdateEvent) {
    const previous = this.current;
    const next = nextUpdateStatus(previous, event);
    if (next === previous) return;
    this.current = next;
    this.entered(previous, next);
    this.host.publish(next);
  }

  /** Logs the phase `next` begins with how long the last one took, and notes a staged update. */
  private entered(previous: UpdateStatus, next: UpdateStatus) {
    if (this.host.mode !== "install") return;
    if (next.state === previous.state && statusVersion(next) === statusVersion(previous)) return;
    const now = this.host.now();
    const took = this.since === undefined ? "" : ` in ${now - this.since} ms`;
    this.since = undefined;
    switch (next.state) {
      case "downloading":
        this.since = now;
        this.host.info(`Update ${next.version}: found, downloading.`);
        break;
      case "preparing":
        this.since = now;
        this.host.info(`Update ${next.version}: downloaded${took}, staging.`);
        break;
      case "ready":
        // From here a quit installs it too, so the next launch must know.
        this.host.noteInstall(this.host.version, next.version);
        this.host.info(`Update ${next.version}: staged${took}, installs on restart or quit.`);
        break;
      case "installing":
        this.restartedAt = now;
        this.host.noteInstall(this.host.version, next.version, now);
        this.host.info(`Update ${next.version}: restart requested.`);
        break;
      default:
        break;
    }
  }

  private mac(): MacEngine {
    if (this.engine) return this.engine;
    const engine = this.host.engine?.();
    if (!engine) throw new Error("no macOS updater");
    engine.on("checking-for-update", () => this.apply({ kind: "checking", manual: this.manual }));
    engine.on("update-available", ({ version }) =>
      this.apply({ kind: "found", version, download: true }),
    );
    engine.on("update-not-available", () => this.apply({ kind: "none" }));
    engine.on("download-progress", ({ percent }) => this.apply({ kind: "progress", percent }));
    engine.on("update-downloaded", ({ version }) => this.apply({ kind: "downloaded", version }));
    engine.onStaged(() => {
      const version = statusVersion(this.current);
      if (version !== undefined) this.apply({ kind: "staged", version });
    });
    // Squirrel.Mac's own failures, such as a signature it refuses, come here too, while it
    // stages the update or after "Restart to update"; they make the install's error state.
    engine.on("error", (error) => {
      this.host.log(`The update failed (${this.current.state}):`, error);
      this.apply({ kind: "failed" });
    });
    this.engine = engine;
    return engine;
  }

  /**
   * Checks for a newer release; `manual` when the user asked from the menu, which then says
   * when there is none, or that the check failed. A check while one runs joins it. An update
   * that is downloading, staging or ready is never checked past: a second check would have
   * electron-updater hand Squirrel.Mac the zip again while it works on it.
   */
  check(manual: boolean): Promise<void> {
    if (this.current.state === "off") {
      if (manual) this.host.say(UPDATES_OFF);
      return Promise.resolve();
    }
    if (
      this.current.state === "downloading" ||
      this.current.state === "preparing" ||
      this.current.state === "ready" ||
      this.current.state === "installing"
    ) {
      return Promise.resolve();
    }
    if (this.checking) {
      this.manual ||= manual;
      return this.checking;
    }
    this.manual = manual;
    this.checkedAt = this.host.now();
    this.checking = this.run().finally(() => {
      const asked = this.manual;
      this.checking = undefined;
      this.manual = false;
      if (asked && this.current.state === "idle") this.host.say(upToDate(this.host.version));
    });
    return this.checking;
  }

  private async run() {
    if (this.host.mode === "install") {
      // electron-updater reports through its events; its promise also rejects on a failure.
      await this.mac()
        .checkForUpdates()
        .catch(() => {});
      return;
    }
    this.apply({ kind: "checking", manual: this.manual });
    let latest: string | undefined;
    try {
      latest = await this.host.latestRelease?.();
    } catch (error) {
      this.host.log("Could not check for a newer release:", error);
      this.apply({ kind: "failed" });
      return;
    }
    if (latest !== undefined && compareVersions(latest, this.host.version) > 0) {
      this.apply({ kind: "found", version: latest, download: false });
    } else {
      this.apply({ kind: "none" });
    }
  }

  /**
   * The window's "Restart to update" or "Download": restarts into a staged update, or else
   * opens the release page.
   */
  async install(): Promise<void> {
    const status = this.current;
    if (status.state === "off") throw UPDATES_OFF;
    if (status.state === "installing") return;
    if (status.state === "ready" && this.host.mode === "install") {
      this.apply({ kind: "installing" });
      try {
        // The update is staged, so this quits the app at once; Squirrel.Mac's ShipIt then swaps
        // the app and opens it. A failure arrives as an "error" event instead.
        this.mac().quitAndInstall();
      } catch (error) {
        this.host.log("Could not install the update:", error);
        this.apply({ kind: "failed" });
      }
      return;
    }
    const version = "version" in status ? status.version : undefined;
    await this.host.openExternal(releasePage(version)).catch(() => {
      throw "Could not open the release page in your browser.";
    });
  }
}

/**
 * The newest published release, as GitHub's release page names it: the latest release, which is
 * never a draft or a pre-release. The web endpoint, not the API, so its rate limit never applies.
 */
export async function latestRelease(
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>,
): Promise<string | undefined> {
  const response = await fetch(`${RELEASES_URL}/latest`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const body = (await response.json()) as { tag_name?: unknown };
  const tag = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/u, "") : undefined;
  return tag !== undefined && validVersion(tag) && !isPrerelease(tag) ? tag : undefined;
}

/**
 * Whether the app bundle at `bundle` carries a Developer ID signature, which macOS's updater
 * needs: an ad-hoc signed local build has no team. Reads `codesign --display`.
 */
export function teamSigned(bundle: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/usr/bin/codesign", ["--display", "--verbose=2", bundle], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      resolve(false);
      return;
    }
    const chunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      resolve(code === 0 && hasTeam(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

/** Whether `codesign --display --verbose=2` printed a team identifier. */
export function hasTeam(printed: string): boolean {
  const team = /^TeamIdentifier=(.+)$/mu.exec(printed)?.[1]?.trim();
  return team !== undefined && team !== "" && team !== "not set";
}

/**
 * A local, unsigned build's update feed for exercising the flow: an `http` URL on this machine
 * from SUPERTAG_DESKTOP_UPDATE_FEED. A signed build ignores it.
 */
export function localFeed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * The note a staged update leaves for the next launch, `update.json` beside the app's other
 * configuration: the version it updates from and to, and when the user restarted to update, if
 * they did rather than quit. The first launch of the new version finds it and restarts the local
 * services once. A launch of any other version drops it: the install never happened.
 */
export class InstallNote {
  private readonly file: string;
  private pending: boolean;
  private readonly update: { from: string; restartedAt?: number } | undefined;

  constructor(directory: string, version: string) {
    this.file = path.join(directory, "update.json");
    let note: { from?: unknown; to?: unknown; restartedAt?: unknown } | undefined;
    try {
      note = JSON.parse(readFileSync(this.file, "utf8")) as typeof note;
    } catch {
      note = undefined;
    }
    this.pending = note?.to === version && note.from !== version;
    if (this.pending && typeof note?.from === "string" && validVersion(note.from)) {
      const at = note.restartedAt;
      this.update = {
        from: note.from,
        ...(typeof at === "number" && Number.isFinite(at) ? { restartedAt: at } : {}),
      };
    }
    // A note this launch isn't the new version of: the install never happened.
    if (note !== undefined && !this.pending) this.done();
  }

  /** Whether this launch is the first of the version an install noted, until `done`. */
  installed(): boolean {
    return this.pending;
  }

  /** What this launch updated from, when it is the first of a new version; `done` keeps it. */
  updated(): { from: string; restartedAt?: number } | undefined {
    return this.update;
  }

  done() {
    this.pending = false;
    rmSync(this.file, { force: true });
  }

  write(from: string, to: string, restartedAt?: number) {
    const note = restartedAt === undefined ? { from, to } : { from, to, restartedAt };
    writeFileSync(this.file, `${JSON.stringify(note)}\n`, { mode: 0o600 });
  }
}

/**
 * The log line of the first launch after an update: how long the window took from the launch,
 * and from "Restart to update" when that is what installed it. Times are in milliseconds.
 */
export function updatedLine(
  update: { from: string; restartedAt?: number },
  to: string,
  launchedAt: number,
  shownAt: number,
): string {
  const shown = `window shown ${Math.round(shownAt - launchedAt)} ms after launch`;
  if (update.restartedAt === undefined) {
    return `Updated from ${update.from} to ${to}, installed when SuperTag quit: ${shown}.`;
  }
  const launched = Math.round(launchedAt - update.restartedAt);
  const all = Math.round(shownAt - update.restartedAt);
  return `Updated from ${update.from} to ${to}: launched ${launched} ms after the restart was requested, ${shown}, ${all} ms in all.`;
}
