import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ProcessEntry,
  type ProcessInventory,
  platformProcessInventory,
} from "./process-inventory.js";

/** Tracks descendants by process identity, including children that reparent and chdir. */
export class ProcessDescendants {
  readonly #root: number;
  readonly #attemptRoot: string | undefined;
  readonly #marker: string | undefined;
  readonly #since: string | undefined;
  readonly #inventory: ProcessInventory;
  readonly #tracked = new Map<number, string>();
  #visible = new Map<number, string>();
  #uncertain = new Set<number>();
  #rootInitialized = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<void> | undefined;

  private constructor(
    root: number,
    attemptRoot: string | undefined,
    marker: string | undefined,
    since: string | undefined,
    inventory: ProcessInventory,
  ) {
    this.#root = root;
    this.#since = since;
    this.#inventory = inventory;
    this.#attemptRoot = attemptRoot === undefined ? undefined : realpathSync(resolve(attemptRoot));
    this.#marker = marker;
    void this.scan().catch(() => {});
    // Background ticks list identities only, at most once a second. Marker and directory
    // checks, which read environments and cwds, run only in fresh teardown scans.
    this.#timer = setInterval(() => void this.scan().catch(() => {}), 1_000);
    this.#timer.unref();
  }

  /**
   * Reads the start-time bound to pass as `since`. Read it before spawning, so a root that
   * exits before the first scan still bounds the processes it left behind.
   */
  static now(inventory = platformProcessInventory()): string | undefined {
    return inventory.now();
  }

  /** Tracks one spawned root. `since` comes from {@link now} before the spawn. */
  static start(
    root: number,
    marker: string,
    since: string | undefined,
    inventory = platformProcessInventory(),
  ): ProcessDescendants {
    return new ProcessDescendants(root, undefined, marker, since, inventory);
  }

  /**
   * Inventory the whole Attempt directory only after its processes have stopped. `since`
   * comes from {@link now} when the environment was created.
   */
  static sweepAttempt(
    root: string,
    since: string | undefined,
    inventory = platformProcessInventory(),
  ): ProcessDescendants {
    return new ProcessDescendants(0, root, undefined, since, inventory);
  }

  async scan(fresh = false): Promise<void> {
    if (this.#pending) {
      if (!fresh) return this.#pending;
      // A failed in-flight scan must not substitute for signal-time inspection.
      await this.#pending.catch(() => {});
    }
    const next = (async () => {
      // Directory and marker scope come without identity. Start time, read in the same
      // snapshot, establishes that a PID still belongs to the process we observed.
      const { entries, marked, inDirectory, uncertain } = await this.#inventory.snapshot({
        ...(this.#marker === undefined || !fresh ? {} : { marker: this.#marker }),
        ...(this.#attemptRoot === undefined || !fresh ? {} : { directory: this.#attemptRoot }),
        // Anything started after the spawn may belong to it; unreadable ones stay uncertain.
        ...(this.#since === undefined ? {} : { since: this.#since }),
        known: (entry) => this.#tracked.get(entry.pid) === entry.started,
      });
      const current = new Map(entries.map((entry) => [entry.pid, entry]));
      for (const [pid, started] of this.#tracked) {
        if (current.get(pid)?.started !== started) this.#tracked.delete(pid);
      }
      for (const pid of [...inDirectory, ...marked]) {
        const entry = current.get(pid);
        if (entry) this.#tracked.set(pid, entry.started);
      }
      if (!this.#rootInitialized) {
        this.#rootInitialized = true;
        const root = current.get(this.#root);
        // A PID that started before the spawn was reused after the root exited.
        if (root && (this.#since === undefined || BigInt(root.started) >= BigInt(this.#since)))
          this.#tracked.set(this.#root, root.started);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const entry of entries) {
          if (!this.#tracked.has(entry.parent) || this.#tracked.has(entry.pid)) continue;
          this.#tracked.set(entry.pid, entry.started);
          changed = true;
        }
      }
      this.#visible = new Map(this.#tracked);
      // Only a fresh scan checks markers and directories, so only it can settle uncertainty.
      if (fresh) this.#uncertain = this.#linked(uncertain, current);
    })();
    const pending: Promise<void> = next.finally(() => {
      // A newer scan may have replaced this one; clear only our own promise.
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }

  /**
   * Keeps the uncertain PIDs that could belong to this Attempt. A tracked process's children
   * are already tracked, so the rest are orphans. An orphan reparents to init or to a
   * subreaper among its ancestors, which are the Worker's ancestors; the Worker sets no
   * subreaper, so its other children are its own spawns. An uncertain PID is linked when it
   * has no readable entry, or its parent is a possible reaper, tracked, or linked itself.
   */
  #linked(uncertain: ReadonlySet<number>, current: ReadonlyMap<number, ProcessEntry>): Set<number> {
    const reapers = new Set([1]);
    for (
      let pid = current.get(process.pid)?.parent;
      pid !== undefined && pid > 0 && !reapers.has(pid);
      pid = current.get(pid)?.parent
    )
      reapers.add(pid);
    const linked = new Set<number>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const pid of uncertain) {
        if (linked.has(pid) || this.#tracked.has(pid)) continue;
        const parent = current.get(pid)?.parent;
        if (
          parent === undefined ||
          reapers.has(parent) ||
          this.#tracked.has(parent) ||
          linked.has(parent)
        ) {
          linked.add(pid);
          changed = true;
        }
      }
    }
    return linked;
  }

  async signalKnown(signal: NodeJS.Signals): Promise<void> {
    await this.scan(true);
    for (const [pid, started] of this.#visible) {
      if (pid === this.#root) continue;
      // The inventory rechecks identity right before the signal; a reused PID is skipped.
      await this.#inventory.signal(pid, started, signal);
    }
  }

  async gone(): Promise<boolean> {
    // Confirming cleanup needs the marker and directory checks that background ticks skip.
    await this.scan(true);
    // An uncertain process may still be ours, so it is never counted as gone.
    return (
      this.#uncertain.size === 0 &&
      [...this.#visible.keys()].every((pid) => this.#root !== 0 && pid === this.#root)
    );
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    await this.#pending;
  }
}
