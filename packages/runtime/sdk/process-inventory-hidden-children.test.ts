import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProcessTree } from "../harnesses/claude-code/src/process-tree.js";
import { procInventory } from "./src/process-inventory.js";

// Adapted from fu5-secreview-hidepid artifact dd13fde0-0ea0-4a83-926c-2bc0531699c4.
// The kernel exposes hidden child PIDs through the readable parent’s per-thread children files.
const procs = vi.hoisted(
  () =>
    new Map<
      number,
      { parent: number; started: number; hidden: boolean; owner: number; kill?: string }
    >(),
);
const childReads = vi.hoisted(() => ({
  threads: new Map<number, number[]>(),
  thread: new Map<number, number>(),
  error: "",
  afterRead: (_pid: number): void => {},
}));
const trees: ClaudeProcessTree[] = [];
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readdir: async (path: string) => {
    if (path.endsWith("/task")) {
      const pid = Number(path.split("/")[2]);
      return (childReads.threads.get(pid) ?? [pid]).map(String);
    }
    return [...procs.keys()].map(String);
  },
  readFile: async (path: string) => {
    const pid = Number(path.split("/")[2]);
    const p = procs.get(pid);
    if (!p) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    if (p.hidden) throw Object.assign(new Error("refused"), { code: "EACCES" });
    if (path.endsWith("/stat"))
      return `${pid} (x) S ${[p.parent, ...Array(17).fill(0), p.started].join(" ")}`;
    if (path.endsWith("/children")) {
      const text = [...procs]
        .filter(
          ([child, entry]) =>
            entry.parent === pid &&
            (childReads.thread.get(child) ?? pid) === Number(path.split("/")[4]),
        )
        .map(([child]) => child)
        .join(" ");
      childReads.afterRead(pid);
      if (childReads.error)
        throw Object.assign(new Error(childReads.error), { code: childReads.error });
      return text;
    }
    if (path.endsWith("/environ"))
      return pid === 12 ? "SUPERTAG_INTERNAL_PROCESS_MARKER=M\0" : "PATH=/bin\0";
    throw new Error(`Unexpected read: ${path}`);
  },
  lstat: async (path: string) => ({
    uid: procs.get(Number(path.split("/")[2]))?.owner ?? 0,
    isDirectory: () => true,
  }),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  readFileSync: (path: string) => {
    if (String(path).endsWith("uptime")) return "1.00 1.00";
    const pid = Number(String(path).split("/")[2]);
    const p = procs.get(pid);
    if (!p) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    if (p.hidden) throw Object.assign(new Error("refused"), { code: "EACCES" });
    return `${pid} (x) S ${[p.parent, ...Array(17).fill(0), p.started].join(" ")}`;
  },
}));
afterEach(() => {
  for (const tree of trees.splice(0)) tree.close();
  vi.restoreAllMocks();
  procs.clear();
  childReads.threads.clear();
  childReads.thread.clear();
  childReads.error = "";
  childReads.afterRead = () => {};
});

function setup() {
  vi.spyOn(process, "geteuid").mockReturnValue(1000);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    const p = procs.get(Number(pid));
    if (!p) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    if (p.kill) throw Object.assign(new Error(p.kill), { code: p.kill });
    if (signal === "SIGKILL") procs.delete(Number(pid));
    return true;
  });
  procs.set(10, { parent: 1, started: 100, hidden: false, owner: 1000 });
  return procInventory({ root: "/fake-proc", selfPid: 10, uid: 1000 });
}

describe("permission-hidden children", () => {
  // BYPASS from fu5-rereview-hidepid-fail-safe artifact 35a3a6bd-73c6-488c-b6fe-649ee5514f01.
  it.each(["linked hidden child", "hidden tracked PID"])(
    "BYPASS: retains an env-scrubbed readable descendant of a %s after reparenting",
    async (parentKind) => {
      const source = setup();
      const tree = await ClaudeProcessTree.prepare(source);
      trees.push(tree);
      procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
      tree.start(12, () => procs.has(12));
      await tree.scan();
      if (parentKind === "hidden tracked PID") {
        procs.set(11, { parent: 12, started: 160, hidden: false, owner: 1000 });
        await tree.scan();
      }
      // 11 becomes non-dumpable and forks 13, which execs `env -i sleep 600`.
      procs.set(11, { parent: 12, started: 160, hidden: true, owner: 0 });
      procs.set(13, { parent: 11, started: 170, hidden: false, owner: 1000 });
      for (let scan = 0; scan < 5; scan++) await tree.scan();
      procs.delete(11);
      procs.set(13, { parent: 1, started: 170, hidden: false, owner: 1000 });
      tree.close();
      await tree.terminate(Date.now() + 1000);
      procs.delete(12);
      await expect(tree.confirm(Date.now() + 50)).rejects.toThrow(/unconfirmed|timed out/);
      expect(procs.has(13)).toBe(true);
      expect(vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
      procs.delete(13);
      await tree.confirm(Date.now() + 1000);
    },
  );

  it("links multiple readable and hidden generations in one scan", async () => {
    const source = setup();
    const tree = await ClaudeProcessTree.prepare(source);
    trees.push(tree);
    procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
    tree.start(12, () => procs.has(12));
    await tree.scan();
    tree.close();
    // Reverse listing order; 13's child list must link hidden 14 before 15 can be linked.
    procs.set(15, { parent: 14, started: 190, hidden: false, owner: 1000 });
    procs.set(14, { parent: 13, started: 180, hidden: true, owner: 0 });
    procs.set(13, { parent: 11, started: 170, hidden: false, owner: 1000 });
    procs.set(11, { parent: 12, started: 160, hidden: true, owner: 0 });
    await tree.scan();
    for (const pid of [11, 12, 13, 14]) procs.delete(pid);
    procs.set(15, { parent: 1, started: 190, hidden: false, owner: 1000 });
    await tree.terminate(Date.now() + 1000);
    await expect(tree.confirm(Date.now() + 50)).rejects.toThrow(/unconfirmed|timed out/);
    expect(vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    procs.delete(15);
    await tree.confirm(Date.now() + 1000);
  });

  it("releases a readable unresolved descendant when its start time proves PID reuse", async () => {
    const source = setup();
    const tree = await ClaudeProcessTree.prepare(source);
    trees.push(tree);
    procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
    procs.set(11, { parent: 12, started: 160, hidden: true, owner: 0 });
    procs.set(13, { parent: 11, started: 170, hidden: false, owner: 1000 });
    tree.start(12, () => procs.has(12));
    await tree.scan();
    tree.close();
    procs.delete(12);
    procs.delete(11);
    procs.set(13, { parent: 1, started: 999, hidden: false, owner: 1000 });
    await tree.terminate(Date.now() + 1000);
    await tree.confirm(Date.now() + 1000);
    expect(procs.has(13)).toBe(true);
    expect(vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  });

  it("retains a descendant that hides its identity after its unresolved link was recorded", async () => {
    const source = setup();
    const tree = await ClaudeProcessTree.prepare(source);
    trees.push(tree);
    procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
    procs.set(11, { parent: 12, started: 160, hidden: true, owner: 0 });
    procs.set(13, { parent: 11, started: 170, hidden: false, owner: 1000 });
    tree.start(12, () => procs.has(12));
    await tree.scan();
    tree.close();
    procs.delete(12);
    procs.delete(11);
    procs.set(13, { parent: 1, started: 170, hidden: true, owner: 0, kill: "EPERM" });
    await tree.terminate(Date.now() + 1000);
    await expect(tree.confirm(Date.now() + 50)).rejects.toThrow(/unconfirmed|timed out/);
    expect(vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    procs.delete(13);
    await tree.confirm(Date.now() + 1000);
  });

  it("allows normal cleanup once readable parentage independently proves ownership", async () => {
    const source = setup();
    const tree = await ClaudeProcessTree.prepare(source);
    trees.push(tree);
    procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
    procs.set(11, { parent: 12, started: 160, hidden: true, owner: 0 });
    procs.set(13, { parent: 11, started: 170, hidden: false, owner: 1000 });
    tree.start(12, () => procs.has(12));
    await tree.scan();
    tree.close();
    procs.set(11, { parent: 12, started: 160, hidden: false, owner: 1000 });
    await tree.terminate(Date.now() + 1000);
    procs.delete(12);
    await tree.confirm(Date.now() + 1000);
    expect(procs.has(11)).toBe(false);
    expect(procs.has(13)).toBe(false);
  });

  it("retains readable child-list links absent from the snapshot's parent chain", async () => {
    const source = setup();
    const tree = await ClaudeProcessTree.prepare(source);
    trees.push(tree);
    procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
    tree.start(12, () => procs.has(12));
    await tree.scan();
    tree.close();
    const snapshot = source.snapshot.bind(source);
    vi.spyOn(source, "snapshot").mockImplementationOnce(async (request) => {
      const result = await snapshot(request);
      procs.set(13, { parent: 12, started: 170, hidden: false, owner: 1000 });
      // A readable row can become stale before child lists are read, including on PID reuse.
      result.entries.push({ pid: 13, parent: 1, started: "120" });
      return result;
    });
    await tree.scan();
    procs.delete(12);
    procs.set(13, { parent: 1, started: 170, hidden: false, owner: 1000 });
    await tree.terminate(Date.now() + 1000);
    await expect(tree.confirm(Date.now() + 50)).rejects.toThrow(/unconfirmed|timed out/);
    expect(vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    procs.delete(13);
    await tree.confirm(Date.now() + 1000);
  });

  it.each([
    { label: "setuid", owner: 0, kill: undefined },
    { label: "non-dumpable", owner: 1000, kill: undefined },
    { label: "setresuid retaining effective uid", owner: 0, kill: "EPERM" },
  ])(
    "withholds confirmation for a $label child hidden before its first scan",
    async ({ owner, kill }) => {
      const source = setup();
      const tree = await ClaudeProcessTree.prepare(source);
      trees.push(tree);
      procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 }); // Claude root
      tree.start(12, () => procs.has(12));
      await tree.scan();
      // Root forks 11, which calls prctl(PR_SET_DUMPABLE, 0) at once: /proc/11 is root-owned and refused.
      procs.set(11, { parent: 12, started: 160, hidden: true, owner, kill });
      tree.close();
      await tree.terminate(Date.now() + 1000);
      procs.delete(12); // the Worker kills the root separately
      for (let scan = 0; scan < 2; scan++)
        await expect(tree.confirm(Date.now() + 50)).rejects.toThrow(/unconfirmed|timed out/);
      expect(procs.has(11)).toBe(true); // Cannot signal without its start-time identity.
      expect(
        vi.mocked(process.kill).mock.calls.filter(([pid, signal]) => pid === 11 && signal !== 0),
      ).toEqual([]);
      procs.delete(11);
      await tree.confirm(Date.now() + 1000);
    },
  );

  it("retains uncertainty when an unreadable tracked PID may have been reused (F2 limit)", async () => {
    const source = setup();
    const tree = await ClaudeProcessTree.prepare(source);
    trees.push(tree);
    procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
    procs.set(13, { parent: 12, started: 160, hidden: false, owner: 1000 });
    tree.start(12, () => procs.has(12));
    await tree.scan();
    tree.close();
    // 13 exits and its PID is reused by an unrelated other-user process before the next scan.
    procs.set(13, { parent: 1, started: 170, hidden: true, owner: 2000, kill: "EPERM" });
    procs.delete(12);
    // Changed credentials do not prove reuse. Dropping the old identity would also forget
    // a tracked child that changed users instead of exiting.
    await expect(tree.confirm(Date.now() + 50)).rejects.toThrow(/unconfirmed|timed out/);
    procs.delete(13);
    await tree.confirm(Date.now() + 1000);
  });

  it.each([
    { label: "setuid", owner: 0, kill: undefined },
    { label: "non-dumpable", owner: 1000, kill: undefined },
    { label: "setresuid retaining effective uid", owner: 0, kill: "EPERM" },
  ])(
    "ignores unrelated hidden $label processes and their readable descendants",
    async ({ owner, kill }) => {
      const source = setup();
      const tree = await ClaudeProcessTree.prepare(source);
      trees.push(tree);
      procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
      tree.start(12, () => procs.has(12));
      await tree.scan();
      procs.set(11, { parent: 10, started: 160, hidden: true, owner, kill });
      procs.set(13, { parent: 11, started: 170, hidden: false, owner: 1000 });
      tree.close();
      await tree.terminate(Date.now() + 1000);
      procs.delete(12);
      await tree.confirm(Date.now() + 1000);
      expect(procs.has(11)).toBe(true);
      expect(procs.has(13)).toBe(true);
      expect(vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    },
  );

  it("retains a linked child that becomes readable only after its parent exits", async () => {
    const source = setup();
    const tree = await ClaudeProcessTree.prepare(source);
    trees.push(tree);
    procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
    procs.set(11, { parent: 12, started: 160, hidden: true, owner: 0 });
    tree.start(12, () => procs.has(12));
    await tree.scan();
    tree.close();
    procs.delete(12);
    procs.set(11, { parent: 1, started: 160, hidden: false, owner: 1000 });
    await tree.terminate(Date.now() + 1000);
    await expect(tree.confirm(Date.now() + 50)).rejects.toThrow(/unconfirmed|timed out/);
    expect(procs.has(11)).toBe(true); // A newly readable PID could also be a replacement.
    procs.delete(11);
    await tree.confirm(Date.now() + 1000);
  });

  it("resumes normal cleanup when readable parentage establishes the child's identity", async () => {
    const source = setup();
    const tree = await ClaudeProcessTree.prepare(source);
    trees.push(tree);
    procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
    procs.set(11, { parent: 12, started: 160, hidden: true, owner: 0 });
    tree.start(12, () => procs.has(12));
    await tree.scan();
    tree.close();
    procs.set(11, { parent: 12, started: 160, hidden: false, owner: 1000 });
    await tree.terminate(Date.now() + 1000);
    procs.delete(12);
    await tree.confirm(Date.now() + 1000);
    expect(procs.has(11)).toBe(false);
  });

  it("reads children forked by a non-leader thread of a tracked descendant", async () => {
    const source = setup();
    const tree = await ClaudeProcessTree.prepare(source);
    trees.push(tree);
    procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
    procs.set(13, { parent: 12, started: 155, hidden: false, owner: 1000 });
    procs.set(11, { parent: 13, started: 160, hidden: true, owner: 0 });
    childReads.threads.set(13, [13, 14]);
    childReads.thread.set(11, 14);
    tree.start(12, () => procs.has(12));
    await tree.scan();
    tree.close();
    await tree.terminate(Date.now() + 1000);
    procs.delete(12);
    await expect(tree.confirm(Date.now() + 50)).rejects.toThrow(/unconfirmed|timed out/);
    expect(procs.has(13)).toBe(false);
    expect(procs.has(11)).toBe(true);
    procs.delete(11);
    await tree.confirm(Date.now() + 1000);
  });

  it.each(["ENOENT", "EACCES", "EIO"])(
    "fails closed for a live parent's child-list error %s",
    async (code) => {
      const source = setup();
      procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
      childReads.error = code;
      await expect(source.children?.(12, "150")).rejects.toThrow("could not read children");
    },
  );

  it.each(["exit", "reuse"])(
    "discards child lists if the parent identity changes during reads (%s)",
    async (change) => {
      const source = setup();
      procs.set(12, { parent: 10, started: 150, hidden: false, owner: 1000 });
      procs.set(11, { parent: 12, started: 160, hidden: true, owner: 0 });
      childReads.afterRead = () => {
        if (change === "exit") procs.delete(12);
        else procs.set(12, { parent: 10, started: 200, hidden: false, owner: 1000 });
      };
      await expect(source.children?.(12, "150")).resolves.toEqual([]);
    },
  );
});
