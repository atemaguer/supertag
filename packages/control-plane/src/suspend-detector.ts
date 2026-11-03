import { execFile } from "node:child_process";

/**
 * A gap between two clock observations longer than this means the process was suspended, as when
 * a laptop sleeps. The Control Plane observes the clock at least every few seconds: its scheduler
 * ticks every 200 ms and each running Task Attempt renews its lease every 5 seconds.
 */
export const SUSPEND_GAP_MS = 15_000;
/** After a suspend, running Task Attempts have this long to renew leases that expired meanwhile. */
export const RESUME_GRACE_MS = 60_000;

/** One suspend the Control Plane noticed, in epoch milliseconds. */
export interface SuspendResume {
  /** The last moment the process is known to have run before the suspend. */
  readonly suspendedAt: number;
  readonly resumedAt: number;
  readonly source: "clock-jump" | "system-wake";
}

/** A suspend plus whether its start is the host's reported sleep time rather than an estimate. */
interface ObservedSuspend extends SuspendResume {
  readonly reportedSleep: boolean;
}

/** The host's most recent sleep and wake, in epoch milliseconds. */
export interface SystemWake {
  readonly sleptAt?: number;
  readonly wokeAt: number;
}

/**
 * Notices when this process was suspended, from a wall-clock jump or a system wake the host
 * reports. For a short grace afterwards, leases that were still valid when the suspend began stay
 * renewable, so a sleep does not revoke every running Task Attempt.
 */
export class SuspendDetector {
  #last: number | undefined;
  #resume: ObservedSuspend | undefined;
  #lastWake: number | undefined;

  constructor(private readonly onResume: (resume: SuspendResume) => void = () => {}) {}

  /** Records that the process runs at `now`; a long gap since the last call is a suspend. */
  observe(now = Date.now()): void {
    const last = this.#last;
    if (last === undefined || now > last) this.#last = now;
    if (last !== undefined && now - last > SUSPEND_GAP_MS)
      this.#begin({
        suspendedAt: last,
        resumedAt: now,
        source: "clock-jump",
        reportedSleep: false,
      });
  }

  /** Records the host's latest wake. A wake newer than the last one seen starts a grace. */
  systemWake(wake: SystemWake, now = Date.now()): void {
    const previous = this.#lastWake;
    this.#lastWake = wake.wokeAt;
    // The first reading only sets the baseline, unless the wake is recent enough to matter.
    if (previous !== undefined ? wake.wokeAt <= previous : now - wake.wokeAt > RESUME_GRACE_MS)
      return;
    if (wake.wokeAt > now) return;
    const reportedSleep = wake.sleptAt !== undefined && wake.sleptAt < wake.wokeAt;
    this.#begin({
      suspendedAt: reportedSleep ? wake.sleptAt : wake.wokeAt,
      resumedAt: wake.wokeAt,
      source: "system-wake",
      reportedSleep,
    });
  }

  /**
   * During a grace, the moment the suspend began: a lease that expired after it may still renew.
   * Undefined outside a grace.
   */
  renewableSince(now = Date.now()): string | undefined {
    const resume = this.#resume;
    if (
      resume === undefined ||
      now > resume.resumedAt + RESUME_GRACE_MS ||
      now < resume.suspendedAt
    )
      return undefined;
    return new Date(resume.suspendedAt).toISOString();
  }

  /** Whether a lease that expires at `leaseExpiresAt` is still current, counting a grace. */
  leaseCurrent(leaseExpiresAt: string | null | undefined, now = Date.now()): boolean {
    if (!leaseExpiresAt) return false;
    if (leaseExpiresAt > new Date(now).toISOString()) return true;
    const since = this.renewableSince(now);
    return since !== undefined && leaseExpiresAt > since;
  }

  #begin(resume: ObservedSuspend): void {
    const current = this.#resume;
    // A clock jump and a wake report of one suspend overlap: merge them into one grace.
    if (
      current !== undefined &&
      resume.suspendedAt <= current.resumedAt + RESUME_GRACE_MS &&
      resume.resumedAt >= current.suspendedAt
    ) {
      this.#resume = {
        ...current,
        suspendedAt: mergedStart(current, resume),
        resumedAt: Math.max(current.resumedAt, resume.resumedAt),
        reportedSleep: current.reportedSleep || resume.reportedSleep,
      };
      return;
    }
    this.#resume = resume;
    const { reportedSleep: _, ...observed } = resume;
    this.onResume(observed);
  }
}

/**
 * The start of one suspend seen twice. The host's reported sleep time wins over the last clock
 * observation, which may predate the sleep by a stall: a lease that expired during that stall,
 * before the host slept, must not become renewable.
 */
function mergedStart(a: ObservedSuspend, b: ObservedSuspend): number {
  if (a.reportedSleep && b.reportedSleep) return Math.max(a.suspendedAt, b.suspendedAt);
  if (a.reportedSleep) return a.suspendedAt;
  if (b.reportedSleep) return b.suspendedAt;
  return Math.min(a.suspendedAt, b.suspendedAt);
}

/**
 * Parses `sysctl -n kern.sleeptime kern.waketime` from macOS: two lines such as
 * `{ sec = 1791000000, usec = 250000 } Fri Oct  2 18:00:00 2026`. A zero `sec` means never.
 */
export function parseDarwinWake(text: string): SystemWake | undefined {
  const times = [...text.matchAll(/\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/gu)].map(
    (match) => Number(match[1]) * 1000 + Math.floor(Number(match[2]) / 1000),
  );
  const [sleptAt, wokeAt] = times;
  if (wokeAt === undefined || wokeAt <= 0) return undefined;
  return { ...(sleptAt !== undefined && sleptAt > 0 ? { sleptAt } : {}), wokeAt };
}

/** Reads the host's latest sleep and wake on macOS; undefined elsewhere or when unavailable. */
export function readSystemWake(platform: NodeJS.Platform = process.platform) {
  if (platform !== "darwin") return Promise.resolve(undefined);
  return new Promise<SystemWake | undefined>((resolve) => {
    execFile(
      "sysctl",
      ["-n", "kern.sleeptime", "kern.waketime"],
      { timeout: 2_000 },
      (error, stdout) => resolve(error ? undefined : parseDarwinWake(stdout)),
    );
  });
}
