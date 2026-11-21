/**
 * The app's own updates, in the main process. A check runs shortly after launch and then every
 * few hours while the app is open. On macOS a newer published release downloads in the background
 * (electron-updater, from the GitHub Release's latest-mac.yml and zip) and installs when the user
 * restarts the app from the window; on Linux the app only says a newer release exists and opens
 * its page, because a Debian package can't replace itself. Development and unsigned builds never
 * check.
 *
 * Restarting to update leaves a note, so the next launch restarts the local services with the
 * new build's CLI (`supertag up` restarts services that run a different build).
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
  type UpdateEvent,
  type UpdateStatus,
  validVersion,
} from "./update-state";

/** How long after launch the first check waits, so it never slows the window down. */
export const FIRST_CHECK_MS = 15_000;
/** How often the app checks again while it is open. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/** What the app hears from electron-updater's macOS updater. */
export interface MacEngine {
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available", listener: (info: { version: string }) => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
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
  /** Notes that the next launch runs `to`, after this one's `from`. */
  noteInstall(from: string, to: string): void;
  /** Drops that note: the install failed and this version runs on. */
  forgetInstall(): void;
  log(message: string, error?: unknown): void;
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

  constructor(private readonly host: UpdaterHost) {
    this.current = host.mode === "off" ? { state: "off" } : { state: "idle" };
  }

  get status(): UpdateStatus {
    return this.current;
  }

  /** Starts checking: once shortly after launch, then every few hours. */
  start() {
    if (this.host.mode === "off") return;
    this.host.setTimeout(() => void this.check(false), FIRST_CHECK_MS);
    this.host.setInterval(() => void this.check(false), CHECK_EVERY_MS);
  }

  private apply(event: UpdateEvent) {
    const next = nextUpdateStatus(this.current, event);
    if (next === this.current) return;
    this.current = next;
    if (next.state === "error" && next.stage === "install") this.host.forgetInstall();
    this.host.publish(next);
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
    // Squirrel.Mac's own failures, such as a signature it refuses, come here too, after
    // "Restart to update"; they make the install's error state.
    engine.on("error", (error) => {
      this.host.log(`The update failed (${this.current.state}):`, error);
      this.apply({ kind: "failed" });
    });
    this.engine = engine;
    return engine;
  }

  /**
   * Checks for a newer release; `manual` when the user asked from the menu, which then says
   * when there is none, or that the check failed. A check while one runs joins it, and a
   * downloaded update is never checked past.
   */
  check(manual: boolean): Promise<void> {
    if (this.current.state === "off") {
      if (manual) this.host.say(UPDATES_OFF);
      return Promise.resolve();
    }
    if (this.current.state === "ready" || this.current.state === "installing") {
      return Promise.resolve();
    }
    if (this.checking) {
      this.manual ||= manual;
      return this.checking;
    }
    this.manual = manual;
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
   * The window's "Restart to update" or "Download": restarts into a downloaded update, or else
   * opens the release page.
   */
  async install(): Promise<void> {
    const status = this.current;
    if (status.state === "off") throw UPDATES_OFF;
    if (status.state === "installing") return;
    if (status.state === "ready" && this.host.mode === "install") {
      this.apply({ kind: "installing" });
      this.host.noteInstall(this.host.version, status.version);
      try {
        // Squirrel.Mac verifies and installs the zip, then quits and relaunches the app; a
        // failure arrives as an "error" event instead.
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
 * The note restarting to update leaves for the next launch, `update.json` beside the app's other
 * configuration: the version it updated from and to. The first launch of the new version finds
 * it and restarts the local services once.
 */
export class InstallNote {
  private readonly file: string;
  private pending: boolean;

  constructor(directory: string, version: string) {
    this.file = path.join(directory, "update.json");
    let note: { from?: unknown; to?: unknown } | undefined;
    try {
      note = JSON.parse(readFileSync(this.file, "utf8")) as { from?: unknown; to?: unknown };
    } catch {
      note = undefined;
    }
    this.pending = note?.to === version && note.from !== version;
    // A note this launch isn't the new version of: the install never happened.
    if (note !== undefined && !this.pending) this.done();
  }

  /** Whether this launch is the first of the version an install noted, until `done`. */
  installed(): boolean {
    return this.pending;
  }

  done() {
    this.pending = false;
    rmSync(this.file, { force: true });
  }

  write(from: string, to: string) {
    writeFileSync(this.file, `${JSON.stringify({ from, to })}\n`, { mode: 0o600 });
  }
}
