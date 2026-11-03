import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProcessEntry,
  type ProcessInventory,
  platformProcessInventory,
} from "@supertag/worker-sdk/internal/process-inventory";
import { describe, expect, it, vi } from "vitest";
import { CursorProcessTree } from "./src/process-tree.js";

const inventoryAvailable = await platformProcessInventory()
  .snapshot({})
  .then(
    () => true,
    () => false,
  );

const ROOT = 900_001;
const TOOL = 900_002;
const GRANDCHILD = 900_003;
const OPERATOR_SHELL = 900_004;
const WORKER_UID = 1000;

async function fixture(baselineInaccessible = false) {
  const entries = new Map<number, ProcessEntry & { uid: number }>([
    [process.pid, { pid: process.pid, parent: 2, started: "1", uid: WORKER_UID }],
    [2, { pid: 2, parent: 1, started: "1", uid: 0 }],
    [1, { pid: 1, parent: 0, started: "1", uid: 0 }],
    ...(baselineInaccessible
      ? ([[OPERATOR_SHELL, { pid: OPERATOR_SHELL, parent: 1, started: "1", uid: 0 }]] as const)
      : []),
  ]);
  const marked = new Set<number>();
  const uncertain = new Set<number>();
  const hidden = new Set<number>();
  const inaccessible = new Set<number>();
  if (baselineInaccessible) inaccessible.add(OPERATOR_SHELL);
  const signalled: Array<[number, string]> = [];
  let beforeSignal = (_pid: number, _signal: string) => {};
  const inventory: ProcessInventory = {
    snapshot: vi.fn(async (request) => ({
      entries: [...entries.values()].map((entry) => ({ ...entry })),
      marked: new Set(marked),
      inaccessible: new Set(inaccessible),
      uncertain: new Set([
        ...uncertain,
        ...[...entries.values()]
          .filter(
            (entry) =>
              hidden.has(entry.pid) &&
              entry.uid === WORKER_UID &&
              request.marker !== undefined &&
              request.since !== undefined &&
              BigInt(entry.started) >= BigInt(request.since),
          )
          .map((entry) => entry.pid),
      ]),
      inDirectory: new Set(),
    })),
    started: async (pid) => entries.get(pid)?.started,
    async signal(pid, started, signal) {
      beforeSignal(pid, signal);
      // Real inventories recheck identity immediately before signalling.
      if (entries.get(pid)?.started !== started) return;
      signalled.push([pid, signal]);
      if (signal === "SIGKILL") remove(pid);
    },
    now: () => "2",
  };
  const tree = await CursorProcessTree.prepare(inventory);
  function add(pid: number, parent: number, marker = false, started = "2", uid = WORKER_UID) {
    entries.set(pid, { pid, parent, started, uid });
    if (marker) marked.add(pid);
  }
  function remove(pid: number) {
    entries.delete(pid);
    marked.delete(pid);
  }
  return {
    tree,
    inventory,
    entries,
    uncertain,
    hidden,
    inaccessible,
    signalled,
    add,
    remove,
    group(pid: number, group: number) {
      const entry = entries.get(pid);
      if (!entry) throw new Error(`Missing fixture PID ${pid}`);
      entry.group = group;
    },
    session(pid: number, session: number) {
      const entry = entries.get(pid);
      if (!entry) throw new Error(`Missing fixture PID ${pid}`);
      entry.session = session;
    },
    onSignal(callback: typeof beforeSignal) {
      beforeSignal = callback;
    },
    async start(alive = () => entries.has(ROOT)) {
      tree.start(ROOT, alive);
      await tree.scan();
    },
  };
}

describe("Cursor descendant cleanup", () => {
  it("ignores a process that was inaccessible before launch", async () => {
    const f = await fixture(true);
    f.add(ROOT, process.pid, true);
    await f.start();
    f.remove(ROOT);
    await f.tree.confirm(Date.now() + 1000);
  });

  it("does not confirm a newly inaccessible process that may have detached", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    await f.start();
    f.add(TOOL, 1);
    f.inaccessible.add(TOOL);
    f.remove(ROOT);
    await expect(f.tree.confirm(Date.now() + 50)).rejects.toThrow("unconfirmed");
    f.remove(TOOL);
    f.inaccessible.delete(TOOL);
    await f.tree.confirm(Date.now() + 1000);
  });

  it("remembers detached children after they clear their marker and reparent", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.add(TOOL, ROOT); // Different process group/session; parentage still establishes ownership.
    await f.start();
    f.remove(ROOT);
    f.add(TOOL, 1);
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([
      [TOOL, "SIGSTOP"],
      [TOOL, "SIGKILL"],
    ]);
  });

  it("finds an unmarked double fork in the live launcher's isolated group", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    await f.start();
    // Both intermediate parents forked and exited between scans.
    f.add(GRANDCHILD, 1);
    f.group(GRANDCHILD, ROOT);
    f.hidden.add(GRANDCHILD);
    await f.tree.terminate(Date.now() + 1000);
    f.remove(ROOT);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([
      [GRANDCHILD, "SIGSTOP"],
      [GRANDCHILD, "SIGKILL"],
    ]);
  });

  it.each(["group", "session"] as const)(
    "finds an unmarked orphan by %s when the isolated launcher exits between scans",
    async (ownership) => {
      const f = await fixture();
      f.add(ROOT, process.pid, true);
      f.group(ROOT, ROOT);
      if (ownership === "session") f.session(ROOT, ROOT);
      await f.start();
      // Neither intermediate parent nor the launcher survives to anchor the next scan.
      f.remove(ROOT);
      f.add(GRANDCHILD, 1);
      f.group(GRANDCHILD, ownership === "group" ? ROOT : GRANDCHILD);
      if (ownership === "session") f.session(GRANDCHILD, ROOT);
      await f.tree.terminate(Date.now() + 1000);
      await f.tree.confirm(Date.now() + 1000);
      expect(f.signalled).toEqual([
        [GRANDCHILD, "SIGSTOP"],
        [GRANDCHILD, "SIGKILL"],
      ]);
    },
  );

  it("drops the isolated launcher's IDs after an empty scan", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.session(ROOT, ROOT);
    await f.start();
    f.remove(ROOT);
    await f.tree.scan();
    f.add(GRANDCHILD, 1);
    f.group(GRANDCHILD, ROOT);
    f.session(GRANDCHILD, ROOT);
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([]);
    expect(f.entries.has(GRANDCHILD)).toBe(true);
  });

  it("keeps a group discoverable after its leader exits while an observed member survives", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.add(TOOL, ROOT);
    for (const pid of [ROOT, TOOL]) f.group(pid, ROOT);
    await f.start();
    f.remove(ROOT);
    f.add(GRANDCHILD, 1);
    f.group(GRANDCHILD, ROOT);
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled.map(([pid]) => pid)).toEqual([TOOL, GRANDCHILD, TOOL, GRANDCHILD]);
  });

  it("does not adopt a reused group when all observed members have gone", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    await f.start(() => f.entries.get(ROOT)?.started === "2");
    f.remove(ROOT);
    f.add(ROOT, process.pid, false, "3");
    f.add(TOOL, ROOT, false, "3");
    for (const pid of [ROOT, TOOL]) f.group(pid, ROOT);
    // The original ChildProcess handle has exited, even though its PID is now present again.
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([]);
  });

  it("does not use an unrelated group shared by a marked process", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.add(TOOL, 1, true);
    f.add(GRANDCHILD, 1);
    f.group(ROOT, ROOT);
    for (const pid of [TOOL, GRANDCHILD]) f.group(pid, OPERATOR_SHELL);
    await f.start();
    await f.tree.terminate(Date.now() + 1000);
    f.remove(ROOT);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([
      [TOOL, "SIGSTOP"],
      [TOOL, "SIGKILL"],
    ]);
  });

  it("does not let a marker-only group leader claim another host group after moving", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.add(TOOL, 1, true);
    f.group(TOOL, TOOL);
    f.session(TOOL, OPERATOR_SHELL);
    await f.start();
    f.group(TOOL, OPERATOR_SHELL);
    f.add(GRANDCHILD, 1);
    f.group(GRANDCHILD, OPERATOR_SHELL);
    f.session(GRANDCHILD, OPERATOR_SHELL);
    await f.tree.terminate(Date.now() + 1000);
    f.remove(ROOT);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled.map(([pid]) => pid)).toEqual([TOOL, TOOL]);
  });

  it.each(["leader", "member"] as const)(
    "claims a tool group through its tracked %s after the parent exits",
    async (anchor) => {
      const f = await fixture();
      f.add(ROOT, process.pid, true);
      f.group(ROOT, ROOT);
      f.add(TOOL, ROOT);
      // A job-control shell can change groups; its group leader may already have exited.
      f.group(TOOL, anchor === "leader" ? TOOL : OPERATOR_SHELL);
      f.add(GRANDCHILD, 1);
      f.group(GRANDCHILD, anchor === "leader" ? TOOL : OPERATOR_SHELL);
      f.hidden.add(GRANDCHILD);
      await f.start();
      f.remove(ROOT);
      await f.tree.terminate(Date.now() + 1000);
      await f.tree.confirm(Date.now() + 1000);
      expect(f.signalled.map(([pid]) => pid)).toEqual([TOOL, GRANDCHILD, TOOL, GRANDCHILD]);
    },
  );

  it("keeps a tool group through a surviving member, then drops its reused number", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.add(TOOL, ROOT);
    f.group(TOOL, TOOL);
    f.add(GRANDCHILD, 1);
    f.group(GRANDCHILD, TOOL);
    await f.start();
    f.remove(TOOL);
    f.add(OPERATOR_SHELL, 1);
    f.group(OPERATOR_SHELL, TOOL);
    await f.tree.scan();
    f.remove(ROOT);
    f.remove(GRANDCHILD);
    await f.tree.terminate(Date.now() + 1000);
    expect(f.signalled.map(([pid]) => pid)).toEqual([OPERATOR_SHELL, OPERATOR_SHELL]);
    // The old group has no surviving identity. Its ID is now an unrelated process's PID.
    f.add(TOOL, process.pid, false, "3");
    f.group(TOOL, TOOL);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.entries.has(TOOL)).toBe(true);
  });

  it("finds a new job-control group in an owned session without an observed leader", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.session(ROOT, ROOT);
    await f.start();
    f.add(GRANDCHILD, 1);
    f.group(GRANDCHILD, GRANDCHILD);
    f.session(GRANDCHILD, ROOT);
    f.hidden.add(GRANDCHILD);
    await f.tree.terminate(Date.now() + 1000);
    f.remove(ROOT);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled.map(([pid]) => pid)).toEqual([GRANDCHILD, GRANDCHILD]);
  });

  it("keeps a session through a surviving member after its leader exits", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.session(ROOT, ROOT);
    f.add(TOOL, ROOT);
    f.group(TOOL, TOOL);
    f.session(TOOL, ROOT);
    await f.start();
    f.remove(ROOT);
    f.add(GRANDCHILD, 1);
    f.group(GRANDCHILD, GRANDCHILD);
    f.session(GRANDCHILD, ROOT);
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled.map(([pid]) => pid)).toEqual([TOOL, GRANDCHILD, TOOL, GRANDCHILD]);
  });

  it("keeps a tracked member's session through one missing detail scan", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.session(ROOT, ROOT);
    f.add(TOOL, ROOT);
    f.group(TOOL, TOOL);
    f.session(TOOL, ROOT);
    await f.start();
    f.remove(ROOT);
    const member = f.entries.get(TOOL);
    if (!member) throw new Error("Missing tracked member");
    member.parent = 1;
    delete member.session;
    await f.tree.scan();
    f.session(TOOL, ROOT);
    f.add(GRANDCHILD, 1);
    f.group(GRANDCHILD, GRANDCHILD);
    f.session(GRANDCHILD, ROOT);
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled.map(([pid]) => pid)).toEqual([TOOL, GRANDCHILD, TOOL, GRANDCHILD]);
  });

  it("keeps an unreadable parent's child unresolved inside a tracked session", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.session(ROOT, ROOT);
    f.add(TOOL, ROOT);
    f.group(TOOL, ROOT);
    f.session(TOOL, ROOT);
    await f.start();
    f.remove(ROOT);
    f.inaccessible.add(ROOT);
    f.uncertain.add(ROOT);
    f.add(GRANDCHILD, ROOT);
    f.group(GRANDCHILD, ROOT);
    f.session(GRANDCHILD, ROOT);
    await f.tree.terminate(Date.now() + 1000);
    expect(f.signalled).toEqual([
      [TOOL, "SIGSTOP"],
      [TOOL, "SIGKILL"],
    ]);
    await expect(f.tree.confirm(Date.now() + 25)).rejects.toThrow(/unconfirmed|timed out/);
    f.inaccessible.delete(ROOT);
    f.uncertain.delete(ROOT);
    f.remove(GRANDCHILD);
    f.add(OPERATOR_SHELL, 1);
    f.group(OPERATOR_SHELL, ROOT);
    f.session(OPERATOR_SHELL, ROOT);
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.entries.has(OPERATOR_SHELL)).toBe(true);
    expect(f.signalled.map(([pid]) => pid)).toEqual([TOOL, TOOL]);
  });

  it("does not claim a marked process's unrelated session", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.add(TOOL, 1, true);
    f.add(GRANDCHILD, 1);
    f.session(TOOL, OPERATOR_SHELL);
    f.session(GRANDCHILD, OPERATOR_SHELL);
    await f.start();
    await f.tree.terminate(Date.now() + 1000);
    f.remove(ROOT);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled.map(([pid]) => pid)).toEqual([TOOL, TOOL]);
  });

  it("does not use a newly marked process to anchor a reused session", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.session(ROOT, ROOT);
    await f.start(() => f.entries.get(ROOT)?.started === "2");
    f.remove(ROOT);
    // The original session ended. An unrelated session reused its number, and a newly
    // marked process alone must not establish ownership of that shared host session.
    // Reuse requires a new leader with the old numeric PID.
    f.add(ROOT, 1, false, "3");
    f.group(ROOT, ROOT);
    f.session(ROOT, ROOT);
    f.add(TOOL, 1, true, "3");
    f.add(GRANDCHILD, 1, false, "3");
    f.session(TOOL, ROOT);
    f.session(GRANDCHILD, ROOT);
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled.map(([pid]) => pid)).toEqual([TOOL, TOOL]);
  });

  it("finds a marked double fork even when both parents exit before the first scan", async () => {
    const f = await fixture();
    f.add(GRANDCHILD, 1, true);
    await f.start();
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([
      [GRANDCHILD, "SIGSTOP"],
      [GRANDCHILD, "SIGKILL"],
    ]);
  });

  it("links a marker-hidden setsid tool while the reported runner is stopped", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.session(ROOT, ROOT);
    await f.start();
    f.add(TOOL, ROOT);
    f.group(TOOL, TOOL);
    f.session(TOOL, TOOL);
    f.hidden.add(TOOL);
    f.onSignal((pid, signal) => {
      if (pid === ROOT && signal === "SIGCONT") {
        const tool = f.entries.get(TOOL);
        if (!tool) throw new Error("Missing tool process");
        tool.parent = 1;
        f.remove(ROOT);
      }
    });
    await f.tree.scanWhileRunnerStopped();
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toContainEqual([TOOL, "SIGKILL"]);
  });

  it("fails the stopped scan when the runner identity disappears at SIGSTOP", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.group(ROOT, ROOT);
    f.session(ROOT, ROOT);
    await f.start();
    f.onSignal((pid, signal) => {
      if (pid === ROOT && signal === "SIGSTOP") f.remove(ROOT);
    });
    await expect(f.tree.scanWhileRunnerStopped()).rejects.toThrow(/before SIGSTOP/);
    f.tree.close();
  });

  // Inventories expose parentage for both users, but only return matching markers.
  // Neither a same-user readable environment nor another user's process is ownership.
  it.each([
    ["same user", 1],
    ["other user", 1],
    ["same user", 2],
    ["other user", 2],
  ] as const)("ignores an unrelated %s orphan reparented to %i", async (user, parent) => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    await f.start();
    f.add(GRANDCHILD, parent, false, "2", user === "same user" ? WORKER_UID : 2000);
    f.remove(ROOT);
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([]);
    expect(f.entries.has(GRANDCHILD)).toBe(true);
  });

  it.each([OPERATOR_SHELL, 1, 2])(
    "ignores a new hidden same-user process outside the tracked chain (parent %i)",
    async (parent) => {
      const f = await fixture();
      f.add(OPERATOR_SHELL, 2, false, "1");
      f.add(ROOT, process.pid, true);
      await f.start();
      f.add(TOOL, parent, false, "3");
      f.hidden.add(TOOL);
      f.remove(ROOT);
      await f.tree.terminate(Date.now() + 1000);
      await f.tree.confirm(Date.now() + 1000);
      expect(f.signalled).toEqual([]);
      expect(f.entries.has(TOOL)).toBe(true);
    },
  );

  it("withholds confirmation for hidden processes linked through a tracked parent", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    await f.start();
    // Reverse inventory order exercises the full parent chain, not just one pass.
    f.add(GRANDCHILD, TOOL, false, "3");
    f.add(TOOL, ROOT, false, "3");
    f.hidden.add(TOOL);
    f.hidden.add(GRANDCHILD);
    await f.tree.scan();
    f.remove(ROOT);
    f.inventory.signal = async () => {};
    await f.tree.terminate(Date.now() + 1000);
    await expect(f.tree.confirm(Date.now() + 25)).rejects.toThrow(/unconfirmed|timed out/);
  });

  it("rescans stopped parents before killing, to catch a last fork", async () => {
    const f = await fixture();
    f.add(TOOL, 1, true);
    await f.start();
    f.onSignal((pid, signal) => {
      if (pid === TOOL && signal === "SIGSTOP") f.add(GRANDCHILD, TOOL);
    });
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([
      [TOOL, "SIGSTOP"],
      [GRANDCHILD, "SIGSTOP"],
      [TOOL, "SIGKILL"],
      [GRANDCHILD, "SIGKILL"],
    ]);
  });

  it("does not signal a reused PID or a negative PGID after the leader exits", async () => {
    const f = await fixture();
    f.add(TOOL, 1, true);
    await f.start();
    f.onSignal((pid, signal) => {
      if (signal === "SIGKILL") {
        f.remove(pid);
        f.add(pid, process.pid, false, "3");
      }
    });
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([[TOOL, "SIGSTOP"]]);
  });

  it("does not attribute pre-existing orphans or another Worker's children to Cursor", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.add(TOOL, process.pid);
    await f.start();
    f.remove(ROOT);
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([]);
  });

  it("withholds confirmation when inventory cannot resolve a process identity", async () => {
    const f = await fixture();
    await f.start();
    f.uncertain.add(TOOL);
    await f.tree.terminate(Date.now() + 1000);
    await expect(f.tree.confirm(Date.now() + 25)).rejects.toThrow(/unconfirmed|timed out/);
    expect(f.signalled).toEqual([]);
  });

  it("remembers a descendant whose identity becomes inaccessible across repeated scans", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.add(TOOL, ROOT);
    await f.start();
    f.remove(ROOT);
    f.remove(TOOL); // /proc still lists the PID, but denies its identity and marker reads.
    f.inaccessible.add(TOOL);
    f.uncertain.add(TOOL);
    // Without the parent's start time, it could be a reused PID with unrelated children.
    f.add(GRANDCHILD, TOOL);
    await f.tree.terminate(Date.now() + 1000);
    for (let scan = 0; scan < 2; scan++)
      await expect(f.tree.confirm(Date.now() + 25)).rejects.toThrow(/unconfirmed|timed out/);
    expect(f.signalled).toEqual([]);
    // A readable reused PID releases the old identity without claiming its replacement.
    f.inaccessible.clear();
    f.uncertain.clear();
    f.add(TOOL, OPERATOR_SHELL, false, "4");
    await f.tree.terminate(Date.now() + 1000);
    // Its previously linked descendant remains unresolved even after the parent PID is reused.
    await expect(f.tree.confirm(Date.now() + 25)).rejects.toThrow(/unconfirmed|timed out/);
    f.remove(GRANDCHILD);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([]);
  });

  it("resumes descendant cleanup when its original identity becomes readable again", async () => {
    const f = await fixture();
    f.add(ROOT, process.pid, true);
    f.add(TOOL, ROOT);
    await f.start();
    f.remove(ROOT);
    f.remove(TOOL);
    f.inaccessible.add(TOOL);
    f.uncertain.add(TOOL);
    await f.tree.terminate(Date.now() + 1000);
    expect(f.signalled).toEqual([]);
    f.inaccessible.clear();
    f.uncertain.clear();
    f.add(TOOL, 1); // Reparenting does not erase previously established ownership.
    await f.tree.terminate(Date.now() + 1000);
    await f.tree.confirm(Date.now() + 1000);
    expect(f.signalled).toEqual([
      [TOOL, "SIGSTOP"],
      [TOOL, "SIGKILL"],
    ]);
  });

  it("withholds confirmation for a marked descendant that survives SIGKILL", async () => {
    const f = await fixture();
    f.add(TOOL, 1, true);
    await f.start();
    f.inventory.signal = async (pid, _started, signal) => {
      f.signalled.push([pid, signal]);
    };
    await f.tree.terminate(Date.now() + 1000);
    await expect(f.tree.confirm(Date.now() + 25)).rejects.toThrow(/unconfirmed|timed out/);
    expect(f.signalled).toEqual([
      [TOOL, "SIGSTOP"],
      [TOOL, "SIGKILL"],
    ]);
  });

  it("propagates denied signals without claiming cleanup", async () => {
    const f = await fixture();
    f.add(TOOL, 1, true);
    await f.start();
    f.onSignal(() => {
      throw new Error("EPERM");
    });
    await expect(f.tree.terminate(Date.now() + 1000)).rejects.toThrow("EPERM");
    expect(f.signalled).toEqual([]);
  });

  it("requires an available baseline and fresh inventory at cleanup", async () => {
    const f = await fixture();
    const error = new Error("inventory unavailable");
    vi.mocked(f.inventory.snapshot).mockRejectedValue(error);
    await expect(CursorProcessTree.prepare(f.inventory)).rejects.toThrow(error);
    await expect(f.tree.terminate(Date.now() + 1000)).rejects.toThrow(error);
  });

  it("still rejects baseline uncertainty without a permission refusal", async () => {
    const f = await fixture();
    f.uncertain.add(TOOL);
    await expect(CursorProcessTree.prepare(f.inventory)).rejects.toThrow(
      "Process baseline is incomplete",
    );
  });

  it("does not turn an expired deadline into confirmed termination", async () => {
    const f = await fixture();
    await expect(f.tree.terminate(Date.now() - 1)).rejects.toThrow("timed out");
    await expect(f.tree.confirm(Date.now() - 1)).rejects.toThrow("timed out");
  });
});

// This deliberately uses the platform inventory: run on both macOS and Linux hosts.
it.skipIf(!inventoryAvailable)(
  "leaves an unrelated real double fork alive while confirming the marked tree",
  async () => {
    const inventory = platformProcessInventory();
    const tree = await CursorProcessTree.prepare(inventory);
    const directory = await mkdtemp(join(tmpdir(), "cursor-unrelated-orphan-"));
    const pidFile = join(directory, "pid");
    const root = spawn("/bin/sleep", ["30"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SUPERTAG_INTERNAL_PROCESS_MARKER: tree.marker },
    });
    const rootExited = once(root, "exit");
    let unrelated: { pid: number; started: string } | undefined;
    try {
      if (!root.pid) throw new Error("Missing marked process PID");
      tree.start(root.pid, () => root.exitCode === null && root.signalCode === null);
      await tree.scan();
      const initial = await inventory.snapshot({});
      expect(initial.entries.find((entry) => entry.pid === root.pid)?.group).toBe(root.pid);
      const environment = { ...process.env };
      delete environment.SUPERTAG_INTERNAL_PROCESS_MARKER;
      // The intermediate shell exits, leaving a separate session's sleeper with init/launchd.
      const launcher = spawn(
        "/bin/sh",
        ["-c", '(sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$1")', "sh", pidFile],
        {
          detached: true,
          stdio: "ignore",
          env: environment,
        },
      );
      await once(launcher, "exit");
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Missing unrelated PID");
      const started = await inventory.started(pid);
      if (!started) throw new Error("Unrelated sleeper exited early");
      unrelated = { pid, started };
      await expect
        .poll(async () => {
          const snapshot = await inventory.snapshot({ marker: tree.marker });
          expect(snapshot.marked.has(pid)).toBe(false);
          const entry = snapshot.entries.find((entry) => entry.pid === pid);
          expect(entry?.group).not.toBe(root.pid);
          const parent = entry?.parent;
          const entries = new Map(snapshot.entries.map((entry) => [entry.pid, entry.parent]));
          const reapers = new Set([1]);
          for (
            let ancestor = entries.get(process.pid);
            ancestor && !reapers.has(ancestor);
            ancestor = entries.get(ancestor)
          )
            reapers.add(ancestor);
          return parent !== undefined && reapers.has(parent);
        })
        .toBe(true);
      root.kill("SIGSTOP");
      await tree.terminate(Date.now() + 5000);
      root.kill("SIGKILL");
      await rootExited;
      await tree.confirm(Date.now() + 5000);
      expect(await inventory.started(pid)).toBe(started);
      process.kill(pid, 0);
    } finally {
      tree.close();
      root.kill("SIGKILL");
      await rootExited;
      if (unrelated) await inventory.signal(unrelated.pid, unrelated.started, "SIGKILL");
      else {
        // Inspection itself can fail after the sleeper starts. Still reap our test process.
        const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (Number.isSafeInteger(pid) && pid > 1) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

it.skipIf(!inventoryAvailable).each([
  ["inherited", false],
  ["cleared", false],
  ["cleared", true],
] as const)(
  "kills a real double-forked system binary (%s marker, launcher exits: %s)",
  async (marker, exitRoot) => {
    const inventory = platformProcessInventory();
    const tree = await CursorProcessTree.prepare(inventory);
    const directory = await mkdtemp(join(tmpdir(), "cursor-system-orphan-"));
    const pidFile = join(directory, "pid");
    const root = spawn(
      process.execPath,
      [
        "-e",
        `
          const { spawn } = require('node:child_process');
          process.stdin.once('data', () => {
            const env = { ...process.env };
            if (process.argv[2] === 'cleared') delete env.SUPERTAG_INTERNAL_PROCESS_MARKER;
            const launcher = spawn('/bin/sh', [
              '-c', '(/bin/sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$1")',
              'sh', process.argv[1],
            ], { env, stdio: 'ignore' });
            launcher.once('exit', () => process.stdout.write('launched\\n', () => {
              if (process.argv[3] === 'exit') process.exit(0);
            }));
          });
        `,
        pidFile,
        marker,
        exitRoot ? "exit" : "stay",
      ],
      {
        detached: true,
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, SUPERTAG_INTERNAL_PROCESS_MARKER: tree.marker },
      },
    );
    const rootExited = once(root, "exit");
    let orphan: { pid: number; started: string } | undefined;
    try {
      if (!root.pid) throw new Error("Missing marked process PID");
      tree.start(root.pid, () => root.exitCode === null && root.signalCode === null);
      await tree.scan();
      // Force both forks and parent exits into the gap between scans, even on loaded hosts.
      tree.close();
      const launched = once(root.stdout, "data");
      root.stdin.write("launch\n");
      await launched;
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Missing orphan PID");
      const started = await inventory.started(pid);
      if (!started) throw new Error("System sleeper exited early");
      orphan = { pid, started };
      const snapshot = await inventory.snapshot({ marker: tree.marker });
      const entry = snapshot.entries.find((entry) => entry.pid === pid);
      expect(entry).toBeDefined();
      expect(entry?.parent).not.toBe(root.pid);
      // macOS hides Apple's system-binary environments; Linux exercises marker removal too.
      if (marker === "cleared" || process.platform === "darwin")
        expect(snapshot.marked.has(pid)).toBe(false);
      if (exitRoot) await rootExited;
      else root.kill("SIGSTOP");
      await tree.terminate(Date.now() + 5000);
      if (!exitRoot) root.kill("SIGKILL");
      await rootExited;
      await tree.confirm(Date.now() + 5000);
      // A false-positive confirmation alone must not let the escaped sleeper pass this test.
      await expect.poll(() => inventory.started(pid)).toBeUndefined();
    } finally {
      tree.close();
      root.kill("SIGKILL");
      await rootExited;
      if (orphan) await inventory.signal(orphan.pid, orphan.started, "SIGKILL");
      else {
        const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (Number.isSafeInteger(pid) && pid > 1) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);
