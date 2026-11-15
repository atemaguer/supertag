import { execFile } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { access, lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";

import { darwinProcessDetails } from "./darwin-process-details.js";

const run = promisify(execFile);

export interface ProcessEntry {
  pid: number;
  parent: number;
  /** POSIX process group, when the inventory exposes it. */
  group?: number;
  /** POSIX session ID, read from Linux /proc or macOS getsid(2). */
  session?: number;
  /** Opaque start-time identity. A reused PID has a different value. */
  started: string;
}

export interface ProcessInventoryRequest {
  /** Fail closed on hidden or malformed entries, including entries with unknown signal permission. */
  requireComplete?: boolean;
  /** Report processes whose environment carries this Attempt process marker. */
  marker?: string;
  /** Skip the marker check for processes the caller already tracks. */
  known?(entry: ProcessEntry): boolean;
  /** Report this user's processes whose working directory lies inside this real path. */
  directory?: string;
  /**
   * A bound from {@link ProcessInventory.now}. A same-user process that started at or after it
   * and whose marker or directory cannot be read is reported as uncertain.
   */
  since?: string;
}

export interface ProcessInventorySnapshot {
  entries: ProcessEntry[];
  marked: Set<number>;
  inDirectory: Set<number>;
  /** PIDs that may be in scope but could not be checked. They are never signalled. */
  uncertain: Set<number>;
  /**
   * Listed PIDs whose identity reads were refused by the kernel. This includes inaccessible
   * processes excluded from `uncertain` by user/signal checks. Absence of an entry for these
   * PIDs does not prove exit; callers with established ownership must retain that ownership.
   */
  inaccessible?: Set<number>;
  /** Inaccessible PIDs whose ownership is unknown or may still be this Worker's user. */
  unresolvedInaccessible?: Set<number>;
}

export interface ProcessInventory {
  /** Throws {@link ProcessInventoryUnavailableError}; an empty result never means "gone". */
  snapshot(request: ProcessInventoryRequest): Promise<ProcessInventorySnapshot>;
  /** Reads one PID's current start time, or undefined when no such process exists. */
  started(pid: number): Promise<string | undefined>;
  /**
   * Child PIDs from a readable parent's kernel child lists, even when a child hides its
   * own identity. Returns no children if the parent's start time changed or it exited.
   * These PIDs alone are not identities and must never be used to signal a process.
   */
  children?(pid: number, started: string): Promise<number[]>;
  /**
   * Signals PID only while its start time still equals `started`, rechecked as close to the
   * signal as the platform allows. A PID that no longer exists is skipped.
   */
  signal(pid: number, started: string, signal: NodeJS.Signals): Promise<void>;
  /**
   * A start-time bound read now, for {@link ProcessInventoryRequest.since}. Every process
   * started later has a start time at or after it. Undefined when the inventory never reports
   * uncertain processes.
   */
  now(): string | undefined;
}

export class ProcessInventoryUnavailableError extends Error {
  override readonly name = "ProcessInventoryUnavailableError";
}

const MARKER_VARIABLE = "SUPERTAG_INTERNAL_PROCESS_MARKER";
/** Linux reports /proc start times in USER_HZ ticks, 100 a second on supported architectures. */
const USER_HZ = 100n;
/** Bounds open /proc reads so a large process table cannot exhaust file descriptors. */
const PROC_READ_CONCURRENCY = 32;

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Signals PID, treating a process that already ended as signalled. */
function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

/**
 * Converts /proc/uptime to a start-time bound in ticks, one tick early because the kernel
 * rounds start times down. A larger real tick rate only moves the bound earlier.
 */
export function parseProcUptime(text: string): string | undefined {
  const match = text.match(/^(\d+)(?:\.(\d+))?\s/);
  if (!match) return undefined;
  const ticks =
    BigInt(match[1] ?? "0") * USER_HZ + BigInt((match[2] ?? "").padEnd(2, "0").slice(0, 2));
  return String(ticks > 0n ? ticks - 1n : 0n);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Errors that mean a /proc entry vanished. */
function vanished(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ESRCH";
}

/** Errors that mean the kernel refused to show this entry to the Worker. */
function refused(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EACCES" || code === "EPERM";
}

/**
 * Parses /proc/PID/stat. The command name sits in parentheses and may contain spaces or
 * parentheses itself, so fields are read after the last ')'.
 */
export function parseProcStat(
  text: string,
):
  | { pid: number; state: string; parent: number; group: number; session: number; started: string }
  | undefined {
  const close = text.lastIndexOf(")");
  const open = text.indexOf(" (");
  if (close < 0 || open < 0 || open > close) return undefined;
  const pid = Number(text.slice(0, open));
  // Fields after the command: state(3) ppid(4) ... starttime(22).
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const parent = Number(fields[1]);
  const group = Number(fields[2]);
  const session = Number(fields[3]);
  const started = fields[19];
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(parent) ||
    parent < 0 ||
    !Number.isSafeInteger(group) ||
    group < 0 ||
    !Number.isSafeInteger(session) ||
    session < 0 ||
    !state ||
    !started ||
    !/^\d+$/.test(started)
  )
    return undefined;
  return { pid, state, parent, group, session, started };
}

/** Reads the real and effective user IDs from /proc/PID/status. */
export function parseProcUids(text: string): number[] | undefined {
  const line = text.split("\n").find((candidate) => candidate.startsWith("Uid:"));
  const fields = line?.slice(4).trim().split(/\s+/).slice(0, 2).map(Number);
  if (fields?.length !== 2 || !fields.every(Number.isSafeInteger)) return undefined;
  return fields;
}

async function boundedEach<T>(
  items: readonly T[],
  limit: number,
  each: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await each(items[next++] as T);
    }),
  );
}

type ProcRead =
  | { kind: "gone" }
  | { kind: "unstable" }
  | {
      kind: "live";
      entry: ProcessEntry;
      marked: boolean;
      inDirectory: boolean;
      uncertain: boolean;
    };

/** Linux inventory from /proc. Reads environments and cwds only where a request needs them. */
export function procInventory(
  options: { root?: string; selfPid?: number; uid?: number } = {},
): ProcessInventory {
  const root = options.root ?? "/proc";
  const selfPid = options.selfPid ?? process.pid;
  const uid = options.uid ?? process.getuid?.();
  const readStat = async (base: string, name: string) => {
    const parsed = parseProcStat(await readFile(join(base, "stat"), "utf8"));
    if (!parsed || String(parsed.pid) !== name)
      throw new ProcessInventoryUnavailableError(`Unreadable process identity in ${base}`);
    if (parsed.state === "Z" || parsed.state === "X" || parsed.state === "x") return undefined;
    return parsed;
  };
  const readOne = async (
    base: string,
    name: string,
    request: ProcessInventoryRequest,
    needle: string | undefined,
  ): Promise<ProcRead> => {
    const parsed = await readStat(base, name);
    if (!parsed) return { kind: "gone" };
    const entry = {
      pid: parsed.pid,
      parent: parsed.parent,
      group: parsed.group,
      session: parsed.session,
      started: parsed.started,
    };
    let marked = false;
    let inDirectory = false;
    let unreadable = false;
    if (needle !== undefined && !request.known?.(entry)) {
      try {
        marked = (await readFile(join(base, "environ"), "latin1")).split("\0").includes(needle);
      } catch (error) {
        // A vanished process is settled by the second stat read below.
        if (refused(error)) unreadable = true;
        else if (!vanished(error)) throw error;
      }
    }
    // Read process credentials directly; directory ownership alone cannot identify both UIDs.
    let sameUser = true;
    if (uid !== undefined && (request.directory !== undefined || unreadable)) {
      const owners = parseProcUids(await readFile(join(base, "status"), "utf8"));
      if (!owners) throw new Error(`Unreadable process status in ${base}`);
      sameUser = owners.includes(uid);
    }
    if (request.directory !== undefined && sameUser) {
      try {
        inDirectory = within(await readlink(join(base, "cwd")), request.directory);
      } catch (error) {
        if (refused(error)) unreadable = true;
        else if (!vanished(error)) throw error;
      }
    }
    // The PID may have exited and been reused while its environment or cwd was read.
    const again = await readStat(base, name);
    if (!again) return { kind: "gone" };
    if (
      again.started !== parsed.started ||
      again.parent !== parsed.parent ||
      again.group !== parsed.group ||
      again.session !== parsed.session
    )
      return { kind: "unstable" };
    const uncertain =
      unreadable &&
      sameUser &&
      !marked &&
      !inDirectory &&
      request.since !== undefined &&
      BigInt(parsed.started) >= BigInt(request.since);
    return { kind: "live", entry, marked, inDirectory, uncertain };
  };
  return {
    async snapshot(request) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (error) {
        throw new ProcessInventoryUnavailableError(`Process inventory is unavailable: ${root}`, {
          cause: error,
        });
      }
      if (request.since !== undefined && !/^\d+$/.test(request.since))
        throw new TypeError("since must be a /proc start time");
      const entries: ProcessEntry[] = [];
      const marked = new Set<number>();
      const inDirectory = new Set<number>();
      const uncertain = new Set<number>();
      const inaccessible = new Set<number>();
      const unresolvedInaccessible = new Set<number>();
      const needle =
        request.marker === undefined ? undefined : `${MARKER_VARIABLE}=${request.marker}`;
      await boundedEach(
        names.filter((name) => /^[1-9]\d*$/.test(name)),
        PROC_READ_CONCURRENCY,
        async (name) => {
          const base = join(root, name);
          try {
            // A reused PID changes start time; read it again once, then report it uncertain.
            let read = await readOne(base, name, request, needle);
            if (read.kind === "unstable") read = await readOne(base, name, request, needle);
            if (read.kind === "gone") return;
            if (read.kind === "unstable") {
              uncertain.add(Number(name));
              return;
            }
            entries.push(read.entry);
            if (read.marked) marked.add(read.entry.pid);
            if (read.inDirectory) inDirectory.add(read.entry.pid);
            if (read.uncertain) uncertain.add(read.entry.pid);
          } catch (error) {
            // hidepid=1 refuses other users' entries; the Worker's own entry must stay visible.
            if (vanished(error)) return;
            if (refused(error)) {
              try {
                // The kernel checks the sender's real/effective UID against the target's
                // real/saved UID. Setuid descendants remain signalable through their real UID.
                process.kill(Number(name), 0);
                inaccessible.add(Number(name));
              } catch (probeError) {
                const code = errorCode(probeError);
                if (code === "ESRCH") return;
                if (code === "EPERM") {
                  try {
                    // Signal permission ignores the target's effective UID. A process
                    // retaining ours can still write the workspace, so keep it uncertain.
                    const owner = (await lstat(base)).uid;
                    inaccessible.add(Number(name));
                    // A same-euid process made non-dumpable after setresuid can look
                    // root-owned here. It is indistinguishable from a root daemon:
                    // treating every such PID as unknown would reject every baseline.
                    if (owner !== process.geteuid?.()) return;
                    unresolvedInaccessible.add(Number(name));
                  } catch (ownerError) {
                    if (errorCode(ownerError) === "ENOENT") return;
                    // Unknown ownership cannot prove this process is out of scope.
                    unresolvedInaccessible.add(Number(name));
                  }
                }
                // An unexpected probe failure cannot prove this process is out of scope.
                else unresolvedInaccessible.add(Number(name));
              }
              if (request.requireComplete || request.since !== undefined)
                uncertain.add(Number(name));
              return;
            }
            throw new ProcessInventoryUnavailableError(`Process inventory could not read ${base}`, {
              cause: error,
            });
          }
        },
      );
      // A restricted /proc (for example hidepid) that hides this Worker cannot prove anything.
      if (!entries.some((entry) => entry.pid === selfPid))
        throw new ProcessInventoryUnavailableError(
          `Process inventory is unavailable: ${root} does not list this Worker`,
        );
      return { entries, marked, inDirectory, uncertain, inaccessible, unresolvedInaccessible };
    },
    async started(pid) {
      const name = String(pid);
      try {
        return (await readStat(join(root, name), name))?.started;
      } catch (error) {
        if (vanished(error)) return undefined;
        throw new ProcessInventoryUnavailableError(`Process inventory could not read PID ${pid}`, {
          cause: error,
        });
      }
    },
    async children(pid, started) {
      const name = String(pid);
      const base = join(root, name);
      const parent = async () => {
        try {
          return await readStat(base, name);
        } catch (error) {
          if (vanished(error)) return undefined;
          throw error;
        }
      };
      try {
        if ((await parent())?.started !== started) return [];
        const children = new Set<number>();
        let failure: unknown;
        try {
          // Any thread can fork. The leader's children file alone misses those children.
          const task = join(base, "task");
          const threads = (await readdir(task)).filter((tid) => /^[1-9]\d*$/.test(tid));
          await boundedEach(threads, PROC_READ_CONCURRENCY, async (tid) => {
            let text: string;
            try {
              text = await readFile(join(task, tid, "children"), "utf8");
            } catch (error) {
              if (vanished(error)) {
                try {
                  await lstat(join(task, tid));
                } catch (threadError) {
                  if (vanished(threadError)) return; // This thread exited during the scan.
                  throw threadError;
                }
              }
              throw error; // A missing children file on a live thread is not an empty list.
            }
            for (const value of text.trim().split(/\s+/).filter(Boolean)) {
              const child = Number(value);
              if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(child))
                throw new Error(`Unreadable child PID in ${task}/${tid}/children`);
              children.add(child);
            }
          });
        } catch (error) {
          failure = error;
        }
        // Never attach children from a replacement parent, including after a failed read.
        if ((await parent())?.started !== started) return [];
        if (failure) throw failure;
        return [...children];
      } catch (error) {
        throw new ProcessInventoryUnavailableError(
          `Process inventory could not read children of PID ${pid}`,
          {
            cause: error,
          },
        );
      }
    },
    async signal(pid, started, signal) {
      const name = String(pid);
      let text: string;
      try {
        // Read synchronously so no event-loop turn separates the identity check from kill().
        text = readFileSync(join(root, name, "stat"), "utf8");
      } catch (error) {
        if (vanished(error)) return;
        throw new ProcessInventoryUnavailableError(`Process inventory could not read PID ${pid}`, {
          cause: error,
        });
      }
      const parsed = parseProcStat(text);
      if (parsed?.pid !== pid || parsed.started !== started || /^[ZXx]$/.test(parsed.state)) return;
      kill(pid, signal);
    },
    now() {
      try {
        // Same boot-relative clock as /proc/PID/stat, including inside a time namespace.
        return parseProcUptime(readFileSync(join(root, "uptime"), "utf8")) ?? "0";
      } catch {
        // Without a clock, every same-user process since boot may be this Attempt's.
        return "0";
      }
    },
  };
}

/**
 * Standard locations only. The file and its directory must be real, owned by `owner` (root),
 * and not group or world writable, so no other user can replace lsof or swap a link.
 */
export async function resolveLsof(
  candidates = ["/usr/sbin/lsof", "/usr/bin/lsof", "/usr/local/bin/lsof"],
  owner = 0,
): Promise<string> {
  const trusted = (info: { uid: number; mode: number }) =>
    info.uid === owner && (info.mode & 0o022) === 0;
  for (const candidate of candidates) {
    if (!candidate.startsWith("/")) continue;
    try {
      // A symbolic link in any component could point somewhere writable.
      if ((await realpath(candidate)) !== candidate) continue;
      const [file, parent] = await Promise.all([lstat(candidate), lstat(dirname(candidate))]);
      if (!file.isFile() || !trusted(file) || !parent.isDirectory() || !trusted(parent)) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new ProcessInventoryUnavailableError(
    `Process inventory is unavailable: no root-owned lsof in ${candidates.join(", ")}`,
  );
}

/** macOS identities from ps, native session/environment reads, and lsof working directories. */
export function psInventory(options: { selfPid?: number } = {}): ProcessInventory {
  const selfPid = options.selfPid ?? process.pid;
  let lsof: Promise<string> | undefined;
  return {
    async snapshot(request) {
      const [listing, scoped] = await Promise.all([
        psListing(),
        request.directory === undefined
          ? Promise.resolve(new Set<number>())
          : (async () => {
              lsof ??= resolveLsof();
              const { stdout } = await run(
                await lsof.catch((error: unknown) => {
                  lsof = undefined;
                  throw error;
                }),
                [
                  "-a",
                  "-n",
                  "-P",
                  "-R",
                  "-d",
                  "cwd",
                  "-u",
                  String(process.getuid?.() ?? ""),
                  "-FpRn",
                ],
                { maxBuffer: 8 * 1024 * 1024 },
              );
              const found = new Set<number>();
              let pid = 0;
              for (const line of stdout.split("\n")) {
                if (line.startsWith("p")) pid = Number(line.slice(1));
                else if (
                  line.startsWith("n") &&
                  pid > 0 &&
                  within(line.slice(1), request.directory ?? "")
                )
                  found.add(pid);
              }
              return found;
            })(),
      ]);
      const before = parsePsListing(listing.stdout, request.requireComplete);
      let details: Awaited<ReturnType<typeof darwinProcessDetails>>;
      try {
        details = await darwinProcessDetails(
          before.map((entry) => ({
            pid: entry.pid,
            inspectMarker: request.marker !== undefined && !request.known?.(entry),
          })),
          request.marker,
        );
      } catch (error) {
        throw new ProcessInventoryUnavailableError("macOS process details are unavailable", {
          cause: error,
        });
      }
      // Never attach session or environment data to a reused PID. Parent/group changes
      // also invalidate the join (including setsid between the helper and this listing).
      const after = new Map(
        parsePsListing((await psListing()).stdout, request.requireComplete).map((entry) => [
          entry.pid,
          entry,
        ]),
      );
      const entries: ProcessEntry[] = [];
      const marked = new Set<number>();
      const uncertain = new Set<number>();
      const inaccessible = new Set<number>();
      for (const entry of before) {
        const again = after.get(entry.pid);
        if (!again) continue;
        const detail = details.get(entry.pid);
        if (detail === "denied") {
          if (entry.pid === selfPid)
            throw new ProcessInventoryUnavailableError(
              "Process inventory cannot inspect this Worker on macOS",
            );
          scoped.delete(entry.pid);
          entries.push(again);
          inaccessible.add(entry.pid);
          if (request.known?.(again) && again.started === entry.started) uncertain.add(entry.pid);
          continue;
        }
        // getsid(2) can report ESRCH while ps still lists an exiting process.
        // Keep its identity for parent-chain discovery, even without a session.
        // Only a previously tracked identity can make this scan uncertain.
        if (detail === null) {
          scoped.delete(entry.pid);
          entries.push(again);
          if (request.known?.(again) && again.started === entry.started) {
            uncertain.add(entry.pid);
          }
          continue;
        }
        if (
          again.started !== entry.started ||
          again.parent !== entry.parent ||
          again.group !== entry.group ||
          !detail
        ) {
          // Retain the current identity, but do not infer ownership from stale details.
          entries.push(again);
          if (scoped.has(entry.pid)) scoped.delete(entry.pid);
          if (!detail && again.started === entry.started) uncertain.add(entry.pid);
          continue;
        }
        entries.push({ ...again, session: detail.session });
        if (detail.marked && request.marker !== undefined && !request.known?.(again))
          marked.add(entry.pid);
      }
      if (!entries.some((entry) => entry.pid === selfPid))
        throw new ProcessInventoryUnavailableError(
          "Process inventory is unavailable: ps does not list this Worker",
        );
      return { entries, marked, inDirectory: scoped, uncertain, inaccessible };
    },
    async started(pid) {
      try {
        const { stdout } = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
          timeout: 5_000,
        });
        const started = normalizeLstart(stdout);
        return started || undefined;
      } catch (error) {
        // ps exits 1 with no output when the PID does not exist.
        const failure = error as { code?: unknown; stdout?: unknown };
        if (failure.code === 1 && !String(failure.stdout ?? "").trim()) return undefined;
        throw new ProcessInventoryUnavailableError(`Process inventory could not read PID ${pid}`, {
          cause: error,
        });
      }
    },
    async signal(pid, started, signal) {
      // ps runs as a separate process, so this check and kill() stay a few milliseconds apart.
      if ((await this.started(pid)) === started) kill(pid, signal);
    },
    now: () => undefined,
  };
}

function psListing() {
  return run("/bin/ps", ["-ww", "-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 5_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function parsePsListing(text: string, requireComplete?: boolean): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const match = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:\S+\s+){4}\S+)(?:\s+(.+))?$/);
    if (!match) {
      if (requireComplete && line.trim())
        throw new ProcessInventoryUnavailableError(
          "Process inventory contains an unreadable ps entry",
        );
      continue;
    }
    if (match[4]?.startsWith("Z")) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const group = Number(match[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parent)) continue;
    entries.push({ pid, parent, group, started: normalizeLstart(match[5] ?? "") });
  }
  return entries;
}

function normalizeLstart(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function platformProcessInventory(platform = process.platform): ProcessInventory {
  if (platform === "linux") return procInventory();
  if (platform === "darwin") return psInventory();
  throw new ProcessInventoryUnavailableError(`Unsupported process inventory platform: ${platform}`);
}
