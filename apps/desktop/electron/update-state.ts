/**
 * The app's own updates, as the main process tracks them and the window shows them. It imports
 * nothing from Node or Electron, so the renderer and its tests share it.
 *
 * On macOS the app downloads a published release in the background, has Squirrel.Mac unpack and
 * verify it, and only then says it is ready; it installs when the user restarts the app, or
 * quits it. A Debian package can't replace itself, so on Linux the app only says a newer
 * release exists and opens its page.
 */

/** Where releases are published. */
export const RELEASES_URL = "https://github.com/atemaguer/supertag/releases";

/** The release page of `version`, or the latest release when it is unknown. */
export function releasePage(version?: string): string {
  return version === undefined ? `${RELEASES_URL}/latest` : `${RELEASES_URL}/tag/v${version}`;
}

/** What the app knows of its updates. */
export type UpdateStatus =
  /** Updates are off: a development or unsigned build. */
  | { state: "off" }
  /** Nothing to show: up to date, or not checked yet. */
  | { state: "idle" }
  /** Checking for a newer release; only a check from the menu says so. */
  | { state: "checking"; manual: boolean }
  /** macOS: downloading `version` in the background. */
  | { state: "downloading"; version: string; percent: number }
  /** macOS: `version` is downloaded; Squirrel.Mac is unpacking and verifying it. */
  | { state: "preparing"; version: string }
  /** macOS: `version` is unpacked and verified, and installs when the app restarts or quits. */
  | { state: "ready"; version: string }
  /** macOS: the user restarted to update; the app quits and Squirrel.Mac installs `version`. */
  | { state: "installing"; version: string }
  /** Linux: `version` is published; the user downloads it from its release page. */
  | { state: "available"; version: string }
  /** A check from the menu, a download, or an install failed; `version` when it was known. */
  | { state: "error"; stage: "check" | "download" | "install"; version?: string };

/** What the main process hears while it checks, downloads, or fails. */
export type UpdateEvent =
  | { kind: "checking"; manual: boolean }
  /** No newer release. */
  | { kind: "none" }
  /** A newer release: `download` when this platform downloads it itself. */
  | { kind: "found"; version: string; download: boolean }
  | { kind: "progress"; percent: number }
  | { kind: "downloaded"; version: string }
  /** Squirrel.Mac unpacked and verified the download: restarting now only swaps the app. */
  | { kind: "staged"; version: string }
  /** The user restarted to update. */
  | { kind: "installing" }
  /** Whatever failed; the main process logs why. */
  | { kind: "failed" };

/** The version an update status is about, if any. */
export function statusVersion(status: UpdateStatus): string | undefined {
  return "version" in status ? status.version : undefined;
}

/**
 * The status after `event`. An update is ready only once Squirrel.Mac staged it, and stays ready
 * whatever a later check says. A known release outlives a failed background check, and only a
 * check from the menu shows that it runs or that it failed. A failure while preparing or
 * installing is the install's; later checks try that release again without a word, and say so
 * only when it is ready after all.
 */
export function nextUpdateStatus(status: UpdateStatus, event: UpdateEvent): UpdateStatus {
  if (status.state === "off") return status;
  const known = statusVersion(status);
  const refused = status.state === "error" && status.stage === "install";
  switch (event.kind) {
    case "checking":
      return status.state === "idle" || (status.state === "error" && !refused)
        ? { state: "checking", manual: event.manual }
        : status;
    case "none":
      return status.state === "checking" ? { state: "idle" } : status;
    case "found":
      // The same release again changes nothing; a newer one replaces what was known.
      if (known === event.version && (status.state !== "error" || refused)) return status;
      if (
        known !== undefined &&
        status.state !== "error" &&
        compareVersions(event.version, known) < 0
      ) {
        return status;
      }
      return event.download
        ? { state: "downloading", version: event.version, percent: 0 }
        : { state: "available", version: event.version };
    case "progress":
      return status.state === "downloading"
        ? { ...status, percent: Math.max(status.percent, clampPercent(event.percent)) }
        : status;
    case "downloaded":
      return status.state === "ready" || status.state === "installing" || refused
        ? status
        : { state: "preparing", version: event.version };
    case "staged":
      return status.state === "installing" ? status : { state: "ready", version: event.version };
    case "installing":
      return status.state === "ready" ? { state: "installing", version: status.version } : status;
    case "failed":
      if (status.state === "downloading") {
        return { state: "error", stage: "download", version: status.version };
      }
      if (status.state === "preparing" || status.state === "installing") {
        return { state: "error", stage: "install", version: status.version };
      }
      if (status.state === "checking") {
        return status.manual ? { state: "error", stage: "check" } : { state: "idle" };
      }
      return status;
  }
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.floor(percent)));
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Whether `version` is a release such as 0.3.6 or a pre-release such as 0.4.0-alpha.1. */
export function validVersion(version: string): boolean {
  return VERSION.test(version);
}

/** Whether `version` is a pre-release, such as 0.4.0-alpha.1. */
export function isPrerelease(version: string): boolean {
  return VERSION.exec(version)?.[4] !== undefined;
}

/**
 * Orders two versions as semantic versioning does: negative when `a` is older. An invalid
 * version sorts before every valid one.
 */
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const [ours, theirs] = [left[4], right[4]];
  if (ours === undefined || theirs === undefined) {
    // A release sorts after its pre-releases.
    return (ours === undefined ? 1 : 0) - (theirs === undefined ? 1 : 0);
  }
  const a1 = ours.split(".");
  const b1 = theirs.split(".");
  for (let index = 0; index < Math.max(a1.length, b1.length); index += 1) {
    const x = a1[index];
    const y = b1[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = /^\d+$/u;
    if (numeric.test(x) && numeric.test(y)) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return Math.sign(difference);
    } else if (numeric.test(x) !== numeric.test(y)) {
      return numeric.test(x) ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
