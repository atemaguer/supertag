import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ProcessEntry,
  type ProcessInventory,
  platformProcessInventory,
} from "@supertag/worker-sdk/internal/process-inventory";
import { armCursorStopWatchdog } from "./stop-watchdog.js";

/**
 * Best-effort discovery, conservative confirmation. Parentage alone loses double forks;
 * inherited markers, owned process groups, and sessions find them after reparenting.
 * The isolated launcher anchors its group/session while members remain, even if it exits.
 * A daemon that clears its marker and leaves every observed group/session/parent chain
 * before the first scan can still escape; see docs/reference/worker.md#process-escape-limits.
 */
export class CursorProcessTree {
  readonly marker = randomUUID();
  readonly #tracked = new Map<number, string>();
  /** Permission failures present before launch cannot belong to this Attempt. */
  readonly #baselineInaccessible = new Map<number, string>();
  // A hidden parent or child-list PID is linked to the tree but is not an identity
  // that can authorize a signal. Keep readable descendants linked after reparenting.
  readonly #unresolved = new Map<number, string | undefined>();
  #unreadable = new Set<number>();
  #groupMembers = new Map<number, { group: number; started: string }>();
  #sessionMembers = new Map<number, { session: number; started: string }>();
  /** The detached launcher proves these IDs belong to this tree until membership ends. */
  #isolatedLauncher: { started: string; group: boolean; session: boolean } | undefined;
  /** Tracked processes in the launcher's isolated session or a session created below it. */
  readonly #isolated = new Set<number>();
  #sessions = new Set<number>();
  readonly #since: string | undefined;
  #root = 0;
  #rootStarted: string | undefined;
  #rootAlive = () => false;
  #uncertain = false;
  #failure: unknown;
  #pending: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    readonly inventory: ProcessInventory,
    entries: ProcessEntry[],
    inaccessible: ReadonlySet<number>,
  ) {
    this.#since = inventory.now();
    for (const entry of entries)
      if (inaccessible.has(entry.pid)) this.#baselineInaccessible.set(entry.pid, entry.started);
  }

  static async prepare(inventory = platformProcessInventory()): Promise<CursorProcessTree> {
    const snapshot = await inventory.snapshot({ requireComplete: true });
    if (
      [...snapshot.uncertain].some(
        (pid) => !snapshot.inaccessible?.has(pid) || snapshot.unresolvedInaccessible?.has(pid),
      )
    )
      throw new Error("Process baseline is incomplete");
    return new CursorProcessTree(inventory, snapshot.entries, snapshot.inaccessible ?? new Set());
  }

  start(pid: number, alive: () => boolean): Promise<void> {
    this.#root = pid;
    this.#rootAlive = alive;
    const tick = () => void this.scan().catch((error: unknown) => (this.#failure ??= error));
    const initial = this.scan();
    void initial.catch((error: unknown) => (this.#failure ??= error));
    this.#timer = setInterval(tick, 1_000);
    this.#timer.unref();
    return initial;
  }

  async scan(): Promise<void> {
    const next = (this.#pending ?? Promise.resolve())
      .catch((error: unknown) => {
        this.#failure ??= error;
      })
      .then(() => this.#scan());
    this.#pending = next;
    try {
      await next;
    } finally {
      if (this.#pending === next) this.#pending = undefined;
    }
  }

  /** Keep a reported child linked to its runner while taking a full inventory. */
  async scanWhileRunnerStopped(): Promise<void> {
    const started = this.#rootStarted;
    // A terminal frame is valid only while its runner still anchors child
    // ownership. A fallback scan after it exits cannot prove a marker-hidden,
    // reparented tool belongs to this Attempt.
    if (!started || !this.#rootAlive())
      throw new Error("Cursor runner exited before its process tree could be scanned");
    // The inventory rechecks the root's start identity before either signal.
    // Cursor's SDK does not document child-process cleanup, so the runner must
    // remain available as ownership evidence during this scan.
    // https://cursor.com/docs/sdk/typescript.md
    // Unlike Claude Code's teardown stop, this scan runs during normal work.
    // A separate watchdog resumes this exact process identity if the Worker dies
    // inside the stop window. Its five-second lease also bounds a hung inventory.
    const release = await armCursorStopWatchdog(this.#root, started);
    let continued = false;
    try {
      await this.inventory.signal(this.#root, started, "SIGSTOP");
      try {
        if (!this.#rootAlive() || (await this.inventory.started(this.#root)) !== started)
          throw new Error("Cursor runner exited before SIGSTOP process discovery");
        await this.scan();
      } finally {
        await this.inventory.signal(this.#root, started, "SIGCONT");
        continued = true;
      }
    } finally {
      await release(continued);
    }
  }

  async #scan(): Promise<void> {
    const snapshot = await this.inventory.snapshot({
      marker: this.marker,
      requireComplete: true,
      ...(this.#since === undefined ? {} : { since: this.#since }),
      known: (entry) => this.#tracked.get(entry.pid) === entry.started,
    });
    const current = new Map(snapshot.entries.map((entry) => [entry.pid, entry]));
    this.#unreadable = new Set(
      [...snapshot.uncertain, ...(snapshot.inaccessible ?? [])].filter((pid) => !current.has(pid)),
    );
    for (const [pid, started] of this.#tracked)
      if (!this.#unreadable.has(pid) && current.get(pid)?.started !== started) {
        this.#tracked.delete(pid);
        this.#isolated.delete(pid);
      }
    for (const [pid, started] of this.#unresolved)
      if (
        !this.#unreadable.has(pid) &&
        (!current.has(pid) ||
          this.#tracked.has(pid) ||
          (started !== undefined && current.get(pid)?.started !== started))
      )
        this.#unresolved.delete(pid);
    // Seed group/session continuity only from surviving identities, before new marker matches.
    // A saved numeric ID alone cannot establish ownership after its members disappear.
    const groups = new Set<number>();
    for (const [pid, member] of this.#groupMembers) {
      const entry = current.get(pid);
      if (entry?.started === member.started && entry.group === member.group)
        groups.add(member.group);
    }
    // A detached launcher's group/session cannot be joined from another session.
    // Keep its ownership through the first orphan-only scan. Retire it as soon as
    // membership disappears or the launcher's PID has a different start identity.
    const launcher = this.#isolatedLauncher;
    const reusedLauncher =
      launcher !== undefined &&
      current.has(this.#root) &&
      current.get(this.#root)?.started !== launcher.started;
    if (
      launcher?.group &&
      !reusedLauncher &&
      snapshot.entries.some((entry) => entry.group === this.#root)
    )
      groups.add(this.#root);
    const sessions = new Set<number>();
    if (
      launcher?.session &&
      !reusedLauncher &&
      snapshot.entries.some((entry) => entry.session === this.#root)
    )
      sessions.add(this.#root);
    for (const entry of snapshot.entries) {
      if (this.#tracked.has(entry.pid) && entry.session && this.#sessions.has(entry.session))
        sessions.add(entry.session);
      // A parent change between the two macOS ps listings discards this scan's
      // session detail. The same tracked identity still anchors its last session.
      const saved = this.#sessionMembers.get(entry.pid);
      if (
        this.#tracked.has(entry.pid) &&
        entry.session === undefined &&
        saved?.started === entry.started &&
        this.#sessions.has(saved.session)
      )
        sessions.add(saved.session);
    }
    const candidateRoot = current.get(this.#root);
    if (candidateRoot && snapshot.marked.has(this.#root) && this.#rootStarted === undefined)
      this.#rootStarted = candidateRoot.started;
    const rootOwned =
      candidateRoot !== undefined &&
      candidateRoot.started === this.#rootStarted &&
      this.#rootAlive();
    for (const entry of snapshot.entries) {
      if (snapshot.marked.has(entry.pid) || (entry.pid === this.#root && rootOwned))
        this.#tracked.set(entry.pid, entry.started);
    }
    // detached:true guarantees the launcher's session is isolated. Only this proof
    // (not a marker or PGID alone) is inherited.
    const root = current.get(this.#root);
    if (root?.group === this.#root && rootOwned) {
      this.#isolated.add(root.pid);
      this.#isolatedLauncher = {
        started: root.started,
        group: true,
        session: root.session === this.#root,
      };
    }
    const isolatedGroups = new Set<number>();
    const inspected = new Set<number>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of snapshot.entries) {
        const hiddenParent =
          this.#unresolved.has(entry.parent) ||
          (this.#tracked.has(entry.parent) && this.#unreadable.has(entry.parent));
        if (hiddenParent && !this.#tracked.has(entry.pid)) {
          if (!this.#unresolved.has(entry.pid)) {
            this.#unresolved.set(entry.pid, entry.started);
            changed = true;
          }
          continue;
        }
        // A child-list link records possible ownership, but a stale parent row
        // cannot prove it. Group/session continuity must not turn that link into
        // signal authority when its parent is unreadable or already gone.
        if (this.#unresolved.has(entry.pid)) {
          if (this.#tracked.has(entry.parent) && !this.#unreadable.has(entry.parent))
            this.#unresolved.delete(entry.pid);
          else continue;
        }
        const inGroup = entry.group !== undefined && groups.has(entry.group);
        const inSession = entry.session !== undefined && sessions.has(entry.session);
        if (
          (this.#tracked.has(entry.parent) && !this.#unreadable.has(entry.parent)) ||
          inGroup ||
          inSession
        ) {
          if (!this.#tracked.has(entry.pid)) {
            this.#tracked.set(entry.pid, entry.started);
            changed = true;
          }
          if (
            (this.#isolated.has(entry.parent) ||
              (entry.group !== undefined && isolatedGroups.has(entry.group)) ||
              inSession) &&
            !this.#isolated.has(entry.pid)
          ) {
            this.#isolated.add(entry.pid);
            changed = true;
          }
        }
        if (!this.#tracked.has(entry.pid)) continue;
        // The launcher and detached tool shells lead their own groups. An isolated
        // descendant cannot join an unrelated host session; its new job-control group
        // is owned too, even if that group's leader exited before this scan.
        // Marker-only processes may share host groups: their membership alone is insufficient.
        if (
          entry.group &&
          (entry.group === entry.pid || this.#isolated.has(entry.pid)) &&
          !groups.has(entry.group)
        ) {
          groups.add(entry.group);
          changed = true;
        }
        if (entry.group && this.#isolated.has(entry.pid) && !isolatedGroups.has(entry.group)) {
          isolatedGroups.add(entry.group);
          changed = true;
        }
        if (entry.session === entry.pid && !sessions.has(entry.session)) {
          sessions.add(entry.session);
          changed = true;
        }
      }
      if (!this.inventory.children) continue;
      for (const entry of snapshot.entries) {
        if (
          inspected.has(entry.pid) ||
          (!this.#tracked.has(entry.pid) && !this.#unresolved.has(entry.pid))
        )
          continue;
        inspected.add(entry.pid);
        // The inventory checks this parent's start time on both sides of the read.
        for (const child of await this.inventory.children(entry.pid, entry.started)) {
          if (this.#tracked.has(child) || this.#unresolved.has(child)) continue;
          this.#unresolved.set(child, undefined);
          changed = true;
        }
      }
    }
    this.#groupMembers = new Map();
    for (const entry of snapshot.entries) {
      if (entry.group && groups.has(entry.group) && this.#tracked.has(entry.pid))
        this.#groupMembers.set(entry.pid, { group: entry.group, started: entry.started });
    }
    this.#sessionMembers = new Map();
    for (const entry of snapshot.entries) {
      if (!this.#tracked.has(entry.pid)) continue;
      const session = entry.session ?? this.#sessionsForMissingMember(entry);
      if (session && sessions.has(session))
        this.#sessionMembers.set(entry.pid, { session, started: entry.started });
    }
    this.#sessions = sessions;
    // The saved launcher bridges only the first scan after it exits. A newly
    // discovered member then becomes the ordinary identity anchor; an empty
    // group/session cannot keep a bare numeric ID alive for later scans.
    if (!root || root.started !== this.#isolatedLauncher?.started)
      this.#isolatedLauncher = undefined;
    // The closure above already includes every child of a tracked or newly linked parent.
    // A hidden environment outside that chain or owned group is not evidence of ownership.
    // An unreadable identity still prevents confirmation: its parent chain cannot be checked.
    this.#uncertain =
      this.#unresolved.size > 0 ||
      (snapshot.unresolvedInaccessible?.size ?? 0) > 0 ||
      [...(snapshot.inaccessible ?? [])].some(
        (pid) =>
          current.get(pid)?.started !== this.#baselineInaccessible.get(pid) &&
          !this.#tracked.has(pid),
      ) ||
      [...snapshot.uncertain, ...(snapshot.inaccessible ?? [])].some(
        (pid) =>
          this.#tracked.has(pid) ||
          pid === this.#root ||
          (!current.has(pid) && !snapshot.inaccessible?.has(pid)),
      );
  }

  #sessionsForMissingMember(entry: ProcessEntry): number | undefined {
    const saved = this.#sessionMembers.get(entry.pid);
    return saved?.started === entry.started ? saved.session : undefined;
  }

  /** Root must already be stopped. Stop all discovered descendants before killing any. */
  async signalDescendants(signal: NodeJS.Signals, deadline: number): Promise<void> {
    this.#within(deadline);
    await this.scan();
    for (const [pid, started] of this.#tracked) {
      if (pid === this.#root || this.#unreadable.has(pid)) continue;
      this.#within(deadline);
      await this.inventory.signal(pid, started, signal);
    }
  }

  /** Freeze descendants before killing them so they cannot fork during teardown. */
  async terminate(deadline: number): Promise<void> {
    this.close();
    const stopped = new Map<number, string>();
    while (true) {
      this.#within(deadline);
      await this.scan();
      const fresh = [...this.#tracked].filter(
        ([pid, started]) =>
          pid !== this.#root && !this.#unreadable.has(pid) && stopped.get(pid) !== started,
      );
      if (fresh.length === 0) break;
      for (const [pid, started] of fresh) {
        this.#within(deadline);
        await this.inventory.signal(pid, started, "SIGSTOP");
        stopped.set(pid, started);
      }
    }
    for (const [pid, started] of stopped) {
      this.#within(deadline);
      await this.inventory.signal(pid, started, "SIGKILL");
    }
  }

  async confirm(deadline: number): Promise<void> {
    do {
      this.#within(deadline);
      await this.scan();
      if (this.#failure) throw this.#failure;
      if (!this.#uncertain && this.#tracked.size === 0) return;
      await delay(Math.min(20, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new Error("Cursor descendant termination or ownership is unconfirmed");
  }

  #within(deadline: number): void {
    if (Date.now() >= deadline) throw new Error("Cursor process inspection timed out");
  }

  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
