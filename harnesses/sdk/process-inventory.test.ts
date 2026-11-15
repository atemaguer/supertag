import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessDescendants } from "./src/process-descendants.ts";
import {
  type ProcessInventory,
  type ProcessInventoryRequest,
  type ProcessInventorySnapshot,
  ProcessInventoryUnavailableError,
  parseProcStat,
  parseProcUptime,
  platformProcessInventory,
  procInventory,
  resolveLsof,
} from "./src/process-inventory.ts";

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const path = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  scratch.push(path);
  return path;
}

/** An in-memory inventory; `signal` rechecks `started` as the real ones do. */
function fakeInventory(
  snapshot: () => ProcessInventorySnapshot,
  started: (pid: number) => string | undefined,
  now?: string,
): ProcessInventory {
  return {
    snapshot: async () => snapshot(),
    started: async (pid) => started(pid),
    async signal(pid, expected, signal) {
      if (started(pid) === expected) process.kill(pid, signal);
    },
    now: () => now,
  };
}

/** Live PIDs whose command name is `comm`, read from /proc. */
function findByComm(comm: string): number[] {
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = readFileSync(`/proc/${name}/stat`, "utf8");
      if (text.includes(`(${comm})`) && !/\) [ZX] /.test(text)) found.push(Number(name));
    } catch {}
  }
  return found;
}

function stat(pid: number, comm: string, state: string, parent: number, started: number): string {
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime
  // stime cutime cstime priority nice threads itrealvalue starttime vsize ...
  const rest = [parent, pid, pid, 0, -1, 4194560, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, started];
  return `${pid} (${comm}) ${state} ${rest.join(" ")} 1000 2000\n`;
}

async function fakeProc(
  entries: Array<{
    pid: number;
    parent: number;
    started: number;
    state?: string;
    comm?: string;
    environ?: string[];
    cwd?: string;
    uid?: number;
    unreadableEnviron?: boolean;
  }>,
): Promise<string> {
  const root = await temporary("fake-proc-");
  await writeFile(join(root, "uptime"), "1 1\n");
  await mkdir(join(root, "self"));
  for (const entry of entries) {
    const base = join(root, String(entry.pid));
    await mkdir(base);
    await writeFile(
      join(base, "stat"),
      stat(entry.pid, entry.comm ?? "node", entry.state ?? "S", entry.parent, entry.started),
    );
    const uid = entry.uid ?? process.getuid?.() ?? 0;
    await writeFile(join(base, "status"), `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    if (entry.environ) await writeFile(join(base, "environ"), `${entry.environ.join("\0")}\0`);
    if (entry.unreadableEnviron) {
      await writeFile(join(base, "environ"), "");
      await chmod(join(base, "environ"), 0);
    }
    if (entry.cwd) await symlink(entry.cwd, join(base, "cwd"));
  }
  return root;
}

describe("parseProcStat", () => {
  it("reads state, parent, and start time after a command name with spaces and parentheses", () => {
    expect(parseProcStat(stat(42, "evil) R 1 (x", "S", 7, 123456))).toEqual({
      pid: 42,
      state: "S",
      parent: 7,
      group: 42,
      session: 42,
      started: "123456",
    });
  });

  it("distinguishes a job-control group from its Linux session", () => {
    const record = stat(42, "bash", "S", 7, 123456).replace("S 7 42 42 ", "S 7 42 8 ");
    expect(parseProcStat(record)).toMatchObject({ group: 42, session: 8 });
    expect(parseProcStat(record.replace("S 7 42 8 ", "S 7 42 invalid "))).toBeUndefined();
  });

  it("rejects a truncated record", () => {
    expect(parseProcStat("42 (node) S 7 42")).toBeUndefined();
    expect(parseProcStat("garbage")).toBeUndefined();
  });
});

describe("Linux /proc inventory", () => {
  it("does not count malformed process identity as termination", async () => {
    const root = await fakeProc([
      { pid: 10, parent: 1, started: 100 },
      { pid: 11, parent: 10, started: 101 },
    ]);
    await writeFile(join(root, "11", "stat"), "truncated");
    await expect(
      procInventory({ root, selfPid: 10 }).snapshot({ requireComplete: true }),
    ).rejects.toBeInstanceOf(ProcessInventoryUnavailableError);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps hidden process identities uncertain in a complete inventory",
    async () => {
      const root = await fakeProc([
        { pid: 10, parent: 1, started: 100 },
        { pid: 11, parent: 10, started: 101 },
      ]);
      await chmod(join(root, "11", "stat"), 0);
      // This fake PID is signalable, independent of the host process table.
      vi.spyOn(process, "kill").mockReturnValue(true);
      const snapshot = await procInventory({ root, selfPid: 10 }).snapshot({
        requireComplete: true,
      });
      expect([...snapshot.uncertain]).toEqual([11]);
    },
  );

  it("lists live processes, skips zombies and vanished entries, and reads markers and cwds", async () => {
    const attempt = await temporary("fake-attempt-");
    const outside = await temporary("fake-outside-");
    const root = await fakeProc([
      { pid: 10, parent: 1, started: 100, environ: ["PATH=/bin"], cwd: outside },
      {
        pid: 11,
        parent: 1,
        started: 101,
        comm: "tool) Z 1 (",
        environ: ["A=1", "SUPERTAG_INTERNAL_PROCESS_MARKER=m-1"],
        cwd: outside,
      },
      // A marker that only shares a prefix belongs to another Attempt.
      { pid: 12, parent: 1, started: 102, environ: ["SUPERTAG_INTERNAL_PROCESS_MARKER=m-10"] },
      { pid: 13, parent: 10, started: 103, cwd: join(attempt, "nested") },
      { pid: 14, parent: 10, started: 104, cwd: `${attempt}-sibling` },
      {
        pid: 15,
        parent: 11,
        started: 105,
        state: "Z",
        environ: ["SUPERTAG_INTERNAL_PROCESS_MARKER=m-1"],
      },
    ]);
    // A PID directory without stat vanished between readdir and read.
    await mkdir(join(root, "16"));
    const snapshot = await procInventory({ root, selfPid: 10 }).snapshot({
      marker: "m-1",
      directory: attempt,
    });
    expect(snapshot.entries.map((entry) => entry.pid).sort()).toEqual([10, 11, 12, 13, 14]);
    expect(snapshot.entries.find((entry) => entry.pid === 13)).toEqual({
      pid: 13,
      parent: 10,
      group: 13,
      session: 13,
      started: "103",
    });
    expect([...snapshot.marked]).toEqual([11]);
    expect([...snapshot.inDirectory]).toEqual([13]);
  });

  it("reads environments only for processes the caller does not already track", async () => {
    const root = await fakeProc([
      { pid: 10, parent: 1, started: 100 },
      { pid: 11, parent: 1, started: 101, environ: ["SUPERTAG_INTERNAL_PROCESS_MARKER=m-1"] },
    ]);
    const snapshot = await procInventory({ root, selfPid: 10 }).snapshot({
      marker: "m-1",
      known: (entry) => entry.pid === 11,
    });
    expect([...snapshot.marked]).toEqual([]);
  });

  it("limits the directory sweep to this user's processes", async () => {
    const attempt = await temporary("fake-attempt-");
    const root = await fakeProc([
      { pid: 10, parent: 1, started: 100 },
      { pid: 11, parent: 1, started: 101, cwd: attempt },
    ]);
    const uid = (process.getuid?.() ?? 0) + 1;
    const snapshot = await procInventory({ root, selfPid: 10, uid }).snapshot({
      directory: attempt,
    });
    expect([...snapshot.inDirectory]).toEqual([]);
  });

  /**
   * Makes PID 11's environ and status FIFOs, so each read blocks until the test answers it.
   * The scan reads stat, environ, status, cwd, then stat again. Answering status proves the
   * previous reader closed environ, so the next environ writer reaches only the retry.
   */
  async function blockingProc(): Promise<{
    root: string;
    answer(started: number, environ: string): Promise<void>;
  }> {
    const root = await fakeProc([
      { pid: 10, parent: 1, started: 100 },
      { pid: 11, parent: 1, started: 101 },
    ]);
    const base = join(root, "11");
    await rm(join(base, "status"));
    execFileSync("mkfifo", [join(base, "environ"), join(base, "status")]);
    const feed = async (path: string, text: string, before?: () => Promise<void>) => {
      const writer = await open(path, "w");
      try {
        await before?.();
        await writer.write(text);
      } finally {
        await writer.close();
      }
    };
    const uid = process.getuid?.() ?? 0;
    return {
      root,
      async answer(started, environ) {
        // The reader has read stat once it opens environ; change identity before answering.
        await feed(join(base, "environ"), environ, () =>
          writeFile(join(base, "stat"), stat(11, "node", "S", 1, started)),
        );
        await feed(join(base, "status"), `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
      },
    };
  }

  it("drops marker evidence when the PID is reused while its environment is read", async () => {
    const directory = await temporary("fake-attempt-");
    const proc = await blockingProc();
    const scan = procInventory({ root: proc.root, selfPid: 10 }).snapshot({
      marker: "m-1",
      directory,
    });
    await proc.answer(999, "SUPERTAG_INTERNAL_PROCESS_MARKER=m-1\0");
    // The retry reads the new process, which carries no marker.
    await proc.answer(999, "PATH=/bin\0");
    const snapshot = await scan;
    expect(snapshot.entries.find((entry) => entry.pid === 11)?.started).toBe("999");
    expect([...snapshot.marked]).toEqual([]);
    expect([...snapshot.uncertain]).toEqual([]);
  });

  it("reports a PID whose start time keeps changing as uncertain, not gone", async () => {
    const directory = await temporary("fake-attempt-");
    const proc = await blockingProc();
    const scan = procInventory({ root: proc.root, selfPid: 10 }).snapshot({
      marker: "m-1",
      directory,
    });
    await proc.answer(998, "SUPERTAG_INTERNAL_PROCESS_MARKER=m-1\0");
    await proc.answer(999, "SUPERTAG_INTERNAL_PROCESS_MARKER=m-1\0");
    const snapshot = await scan;
    expect(snapshot.entries.map((entry) => entry.pid)).toEqual([10]);
    expect([...snapshot.marked]).toEqual([]);
    expect([...snapshot.uncertain]).toEqual([11]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports a same-user process with an unreadable environment as uncertain",
    async () => {
      const uid = process.getuid?.() ?? 1000;
      const root = await fakeProc([
        { pid: 10, parent: 1, started: 100 },
        // Started before the tracked root: not this Attempt's.
        { pid: 11, parent: 1, started: 101, unreadableEnviron: true },
        { pid: 12, parent: 1, started: 300, unreadableEnviron: true },
        // Another user's process is out of scope even when it started later.
        { pid: 13, parent: 1, started: 301, unreadableEnviron: true, uid: uid + 1 },
        // The caller already tracks this one, so its environment is not needed.
        { pid: 14, parent: 1, started: 302, unreadableEnviron: true },
      ]);
      const snapshot = await procInventory({ root, selfPid: 10, uid }).snapshot({
        marker: "m-1",
        since: "200",
        known: (entry) => entry.pid === 14,
      });
      expect(snapshot.entries.map((entry) => entry.pid).sort()).toEqual([10, 11, 12, 13, 14]);
      expect([...snapshot.marked]).toEqual([]);
      expect([...snapshot.uncertain]).toEqual([12]);
    },
  );

  it("reads concurrently without opening every entry at once", async () => {
    const root = await fakeProc(
      Array.from({ length: 200 }, (_, index) => ({ pid: 10 + index, parent: 1, started: index })),
    );
    const snapshot = await procInventory({ root, selfPid: 10 }).snapshot({});
    expect(snapshot.entries).toHaveLength(200);
  });

  it("reads one PID's start time for the signal-time identity check", async () => {
    const root = await fakeProc([
      { pid: 10, parent: 1, started: 100 },
      { pid: 11, parent: 1, started: 101, state: "Z" },
    ]);
    const inventory = procInventory({ root, selfPid: 10 });
    await expect(inventory.started(10)).resolves.toBe("100");
    await expect(inventory.started(11)).resolves.toBeUndefined();
    await expect(inventory.started(12)).resolves.toBeUndefined();
  });

  it("reads a boot-relative start-time bound from /proc/uptime", async () => {
    expect(parseProcUptime("12345.67 9.00\n")).toBe("1234566");
    expect(parseProcUptime("1 1\n")).toBe("99");
    expect(parseProcUptime("0.00 0.00\n")).toBe("0");
    expect(parseProcUptime("garbage")).toBeUndefined();
    const root = await fakeProc([{ pid: 10, parent: 1, started: 100 }]);
    expect(procInventory({ root, selfPid: 10 }).now()).toBe("99");
    // Without a clock, the bound falls back to boot so nothing escapes it.
    await rm(join(root, "uptime"));
    expect(procInventory({ root, selfPid: 10 }).now()).toBe("0");
  });

  it("signals a PID only while its start time matches", async () => {
    const root = await fakeProc([
      { pid: 10, parent: 1, started: 100 },
      { pid: 11, parent: 1, started: 101, state: "Z" },
    ]);
    const inventory = procInventory({ root, selfPid: 10 });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await inventory.signal(10, "99", "SIGTERM");
    await inventory.signal(11, "101", "SIGTERM");
    await inventory.signal(12, "102", "SIGTERM");
    expect(kill).not.toHaveBeenCalled();
    await inventory.signal(10, "100", "SIGTERM");
    expect(kill.mock.calls).toEqual([[10, "SIGTERM"]]);
  });

  it("reports an unavailable inventory instead of an empty one", async () => {
    const missing = join(await temporary("fake-proc-"), "missing");
    await expect(procInventory({ root: missing }).snapshot({})).rejects.toBeInstanceOf(
      ProcessInventoryUnavailableError,
    );
    // A restricted /proc that hides this Worker cannot prove that processes ended.
    const hidden = await fakeProc([{ pid: 11, parent: 1, started: 101 }]);
    await expect(procInventory({ root: hidden, selfPid: 10 }).snapshot({})).rejects.toThrow(
      /does not list this Worker/,
    );
    // An unexpected read error is not a vanished process.
    const broken = await fakeProc([{ pid: 10, parent: 1, started: 100 }]);
    await mkdir(join(broken, "11", "stat"), { recursive: true });
    await expect(procInventory({ root: broken, selfPid: 10 }).snapshot({})).rejects.toBeInstanceOf(
      ProcessInventoryUnavailableError,
    );
  });
});

describe("lsof resolution", () => {
  it("accepts only an executable owned by the expected user and not group or world writable", async () => {
    const directory = await temporary("lsof-");
    const owner = process.getuid?.() ?? 0;
    const writable = join(directory, "writable");
    const good = join(directory, "good");
    for (const path of [writable, good]) {
      await writeFile(path, "#!/bin/sh\n");
      await chmod(path, 0o755);
    }
    await chmod(writable, 0o775);
    const missing = join(directory, "missing");
    await expect(resolveLsof([missing, writable, "relative", good], owner)).resolves.toBe(good);
    // A file owned by anyone else, such as a user-installed lsof, is refused.
    await expect(resolveLsof([good], owner + 1)).rejects.toBeInstanceOf(
      ProcessInventoryUnavailableError,
    );
  });

  it("rejects symbolic links and a group- or world-writable directory", async () => {
    const owner = process.getuid?.() ?? 0;
    const directory = await temporary("lsof-links-");
    const good = join(directory, "good");
    await writeFile(good, "#!/bin/sh\n");
    await chmod(good, 0o755);
    await chmod(directory, 0o755);
    const link = join(directory, "link");
    await symlink(good, link);
    await expect(resolveLsof([link], owner)).rejects.toBeInstanceOf(
      ProcessInventoryUnavailableError,
    );
    // A link in a parent component is refused as well.
    const linkedDirectory = join(await temporary("lsof-parent-"), "bin");
    await symlink(directory, linkedDirectory);
    await expect(resolveLsof([join(linkedDirectory, "good")], owner)).rejects.toBeInstanceOf(
      ProcessInventoryUnavailableError,
    );
    await expect(resolveLsof([good], owner)).resolves.toBe(good);
    for (const mode of [0o775, 0o757]) {
      await chmod(directory, mode);
      await expect(resolveLsof([good], owner)).rejects.toBeInstanceOf(
        ProcessInventoryUnavailableError,
      );
    }
    await chmod(directory, 0o755);
  });

  it("never searches PATH", async () => {
    const directory = await temporary("lsof-path-");
    await writeFile(join(directory, "lsof"), "#!/bin/sh\n");
    await chmod(join(directory, "lsof"), 0o755);
    vi.stubEnv("PATH", directory);
    try {
      await expect(resolveLsof([join(directory, "missing")])).rejects.toBeInstanceOf(
        ProcessInventoryUnavailableError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("ProcessDescendants with an inventory", () => {
  it("never reads an unavailable inventory as all processes gone", async () => {
    const unavailable = fakeInventory(
      () => {
        throw new ProcessInventoryUnavailableError("Process inventory is unavailable");
      },
      () => {
        throw new ProcessInventoryUnavailableError("Process inventory is unavailable");
      },
      "0",
    );
    const sweep = ProcessDescendants.sweepAttempt(tmpdir(), "0", unavailable);
    try {
      await expect(sweep.gone()).rejects.toBeInstanceOf(ProcessInventoryUnavailableError);
      await expect(sweep.signalKnown("SIGTERM")).rejects.toBeInstanceOf(
        ProcessInventoryUnavailableError,
      );
    } finally {
      await sweep.close().catch(() => {});
    }
  });

  it("signals only marked processes and descendants whose start time still matches", async () => {
    let reused = false;
    const entries = () => [
      { pid: 900_001, parent: 1, started: "1" },
      { pid: 900_002, parent: reused ? 1 : 900_001, started: reused ? "9" : "2" },
      { pid: 900_003, parent: 1, started: "3" },
    ];
    const inventory = fakeInventory(
      () => ({
        entries: entries(),
        marked: new Set([900_001]),
        inDirectory: new Set(),
        uncertain: new Set(),
      }),
      (pid) => entries().find((entry) => entry.pid === pid)?.started,
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const tracker = ProcessDescendants.start(900_000, "m-1", undefined, inventory);
    try {
      await tracker.signalKnown("SIGTERM");
      expect(kill.mock.calls.map(([pid]) => pid).sort()).toEqual([900_001, 900_002]);
      kill.mockClear();
      // The child exited and an unrelated process reused its PID with a new start time.
      reused = true;
      await tracker.signalKnown("SIGTERM");
      expect(kill.mock.calls.map(([pid]) => pid)).toEqual([900_001]);
    } finally {
      await tracker.close();
    }
  });

  it("skips a PID reused between the scan and the signal", async () => {
    let reused = false;
    const inventory = fakeInventory(
      () => ({
        entries: [
          { pid: 900_001, parent: 1, started: "1" },
          { pid: 900_002, parent: 900_001, started: "2" },
        ],
        marked: new Set([900_001]),
        inDirectory: new Set(),
        uncertain: new Set(),
      }),
      // The scan saw start time "2"; by signal time an unrelated process holds the PID.
      (pid) => (pid === 900_002 && reused ? "9" : String(pid - 900_000)),
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const tracker = ProcessDescendants.start(900_000, "m-1", undefined, inventory);
    try {
      await tracker.scan();
      reused = true;
      await tracker.signalKnown("SIGKILL");
      expect(kill.mock.calls.map(([pid]) => pid)).toEqual([900_001]);
    } finally {
      await tracker.close();
    }
  });

  it("never counts an uncertain process as gone and never signals it", async () => {
    let uncertain = new Set([900_005]);
    const inventory = fakeInventory(
      () => ({
        entries: [
          { pid: 900_000, parent: 1, started: "1" },
          { pid: 900_005, parent: 1, started: "5" },
        ],
        marked: new Set(),
        inDirectory: new Set(),
        uncertain,
      }),
      (pid) => String(pid - 900_000 || 1),
      "1",
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const tracker = ProcessDescendants.start(900_000, "m-1", "1", inventory);
    try {
      await tracker.scan(true);
      await expect(tracker.gone()).resolves.toBe(false);
      await tracker.signalKnown("SIGKILL");
      expect(kill).not.toHaveBeenCalled();
      uncertain = new Set();
      await tracker.scan(true);
      await expect(tracker.gone()).resolves.toBe(true);
    } finally {
      await tracker.close();
    }
  });

  it("passes the pre-spawn bound to every scan, even after the root exits", async () => {
    const requests: Array<string | undefined> = [];
    const inventory = fakeInventory(
      () => ({ entries: [], marked: new Set(), inDirectory: new Set(), uncertain: new Set() }),
      () => undefined,
      "500",
    );
    const snapshot = inventory.snapshot;
    inventory.snapshot = async (request) => {
      requests.push(request.since);
      return snapshot(request);
    };
    const tracker = ProcessDescendants.start(900_000, "m-1", "500", inventory);
    try {
      await tracker.scan(true);
      await tracker.scan(true);
      expect(requests.every((since) => since === "500")).toBe(true);
    } finally {
      await tracker.close();
    }
  });

  it("does not adopt a root PID that started before the spawn", async () => {
    const entries = [
      // The root exited before the first scan and an older process now shows under its PID.
      { pid: 900_000, parent: 1, started: "100" },
      { pid: 900_001, parent: 900_000, started: "101" },
    ];
    const inventory = fakeInventory(
      () => ({ entries, marked: new Set(), inDirectory: new Set(), uncertain: new Set() }),
      (pid) => entries.find((entry) => entry.pid === pid)?.started,
      "500",
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const tracker = ProcessDescendants.start(900_000, "m-1", "500", inventory);
    try {
      await tracker.signalKnown("SIGKILL");
      expect(kill).not.toHaveBeenCalled();
      await expect(tracker.gone()).resolves.toBe(true);
    } finally {
      await tracker.close();
    }
  });

  it("keeps only uncertain processes that can be linked to the Attempt", async () => {
    // The Worker runs under 800_001, which may reap orphans; the Worker itself does not.
    const worker = process.pid;
    const entries = [
      { pid: 800_001, parent: 1, started: "1" },
      { pid: worker, parent: 800_001, started: "2" },
      { pid: 800_002, parent: 1, started: "3" },
      { pid: 900_000, parent: worker, started: "600" },
      // Orphans adopted by init or a Worker ancestor may be this Attempt's.
      { pid: 900_010, parent: 1, started: "610" },
      { pid: 900_011, parent: 800_001, started: "611" },
      // A child of a linked uncertain process is linked too.
      { pid: 900_012, parent: 900_010, started: "612" },
      // Another Attempt's root and an unrelated program's helper cannot hold our orphans.
      { pid: 900_020, parent: worker, started: "620" },
      { pid: 900_021, parent: 800_002, started: "621" },
    ];
    let uncertain = new Set([900_010, 900_011, 900_012, 900_020, 900_021, 900_030]);
    const inventory = fakeInventory(
      () => ({ entries, marked: new Set(), inDirectory: new Set(), uncertain }),
      (pid) => entries.find((entry) => entry.pid === pid)?.started,
      "500",
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const tracker = ProcessDescendants.start(900_000, "m-1", "500", inventory);
    try {
      await tracker.scan(true);
      await expect(tracker.gone()).resolves.toBe(false);
      await tracker.signalKnown("SIGKILL");
      expect(kill).not.toHaveBeenCalled();
      // 900_030 had no readable entry at all, so it stays linked while it exists.
      for (const linked of [[900_010], [900_011], [900_010, 900_012], [900_030]]) {
        uncertain = new Set([...linked, 900_020, 900_021]);
        await tracker.scan(true);
        await expect(tracker.gone()).resolves.toBe(false);
      }
      // Once its parent proves readable and unmarked, 900_012 descends from another program.
      uncertain = new Set([900_012]);
      await tracker.scan(true);
      await expect(tracker.gone()).resolves.toBe(true);
      uncertain = new Set([900_020, 900_021]);
      await tracker.scan(true);
      await expect(tracker.gone()).resolves.toBe(true);
    } finally {
      await tracker.close();
    }
  });
});

const linuxUser = process.platform === "linux" && process.getuid?.() !== 0;

/** Starts a same-user process that hides its environment and cwd with PR_SET_DUMPABLE. */
const HIDDEN_PYTHON =
  "import ctypes,time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); print('ready', flush=True); time.sleep(30)";

it.runIf(linuxUser)(
  "lets an unrelated non-dumpable process end cleanup and signals a hidden descendant",
  async () => {
    const marker = `dumpable-${process.pid}-${Date.now()}`;
    const since = ProcessDescendants.now();
    // The root's own child hides itself; its parentage still ties it to the Attempt.
    const root = spawn("/bin/sh", ["-c", `python3 -c "${HIDDEN_PYTHON}" & wait`], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, SUPERTAG_INTERNAL_PROCESS_MARKER: marker },
    });
    // Another Worker child, such as another Attempt's process, hides itself too.
    const unrelated = spawn("python3", ["-c", HIDDEN_PYTHON], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let tracker: ProcessDescendants | undefined;
    try {
      if (!root.pid || !unrelated.pid) throw new Error("Child did not start");
      tracker = ProcessDescendants.start(root.pid, marker, since);
      await Promise.all(
        [root, unrelated].map(
          (child) => new Promise<void>((resolve) => child.stdout?.once("data", () => resolve())),
        ),
      );
      await tracker.signalKnown("SIGKILL");
      await new Promise((resolve) => root.once("exit", resolve));
      const until = Date.now() + 5000;
      while (!(await tracker.gone()) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(tracker.gone()).resolves.toBe(true);
      expect(() => process.kill(unrelated.pid ?? 0, 0)).not.toThrow();
    } finally {
      unrelated.kill("SIGKILL");
      root.kill("SIGKILL");
      await tracker?.close();
    }
  },
  15_000,
);

// Security review PoC: a root that exits before the first scan leaves a detached child that is
// non-dumpable from exec, because its binary is execute-only.
it.runIf(linuxUser)(
  "keeps a non-dumpable orphan of an exited root uncertain until it ends",
  async () => {
    const directory = await temporary("inventory-orphan-");
    const binary = join(directory, "pocsleep");
    copyFileSync("/bin/sleep", binary);
    chmodSync(binary, 0o111);
    for (let round = 0; round < 5; round++) {
      const marker = `orphan-${process.pid}-${round}`;
      const since = ProcessDescendants.now();
      const root = spawn("/bin/sh", ["-c", `cd / && ${binary} 300 >/dev/null 2>&1 & exit 0`], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, SUPERTAG_INTERNAL_PROCESS_MARKER: marker },
      });
      const tracker = ProcessDescendants.start(root.pid ?? 0, marker, since);
      try {
        await new Promise((resolve) => root.once("exit", resolve));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const [orphan] = findByComm("pocsleep");
        expect(orphan).toBeDefined();
        await tracker.scan(true);
        await expect(tracker.gone()).resolves.toBe(false);
        // Uncertain processes are never signalled; cleanup stays unconfirmed instead.
        await tracker.signalKnown("SIGKILL");
        expect(findByComm("pocsleep")).toEqual([orphan]);
        process.kill(orphan ?? 0, "SIGKILL");
        const until = Date.now() + 5000;
        while (!(await tracker.gone()) && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 50));
        await expect(tracker.gone()).resolves.toBe(true);
      } finally {
        for (const pid of findByComm("pocsleep")) process.kill(pid, "SIGKILL");
        await tracker.close();
      }
    }
  },
  60_000,
);

it("finds a marked child and its working directory on this platform", async () => {
  const directory = await temporary("inventory-live-");
  const marker = `live-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: directory,
    env: { ...process.env, SUPERTAG_INTERNAL_PROCESS_MARKER: marker },
    stdio: "ignore",
  });
  try {
    const pid = child.pid;
    if (!pid) throw new Error("Child did not start");
    const inventory = platformProcessInventory();
    let snapshot = await inventory.snapshot({ marker, directory });
    const until = Date.now() + 5000;
    while ((!snapshot.marked.has(pid) || !snapshot.inDirectory.has(pid)) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      snapshot = await inventory.snapshot({ marker, directory });
    }
    expect(snapshot.marked.has(pid)).toBe(true);
    expect(snapshot.inDirectory.has(pid)).toBe(true);
    expect(snapshot.entries.find((entry) => entry.pid === pid)?.parent).toBe(process.pid);
    expect(snapshot.marked.has(process.pid)).toBe(false);
  } finally {
    child.kill("SIGKILL");
  }
}, 15_000);

describe("ProcessDescendants polling cost", () => {
  it("lists identities once a second and reads markers only in teardown scans", async () => {
    vi.useFakeTimers();
    try {
      const requests: ProcessInventoryRequest[] = [];
      const inventory = fakeInventory(
        () => ({ entries: [], marked: new Set(), inDirectory: new Set(), uncertain: new Set() }),
        () => undefined,
      );
      const snapshot = inventory.snapshot;
      inventory.snapshot = async (request) => {
        requests.push(request);
        return snapshot(request);
      };
      const descendants = ProcessDescendants.start(999_999, "marker", undefined, inventory);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(requests.length).toBeLessThanOrEqual(4);
      expect(requests.every((request) => request.marker === undefined)).toBe(true);
      await descendants.gone();
      expect(requests.at(-1)?.marker).toBe("marker");
      await descendants.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
