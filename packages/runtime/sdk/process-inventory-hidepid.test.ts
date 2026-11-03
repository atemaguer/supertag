import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProcessTree } from "../harnesses/claude-code/src/process-tree.js";
import { procInventory } from "./src/process-inventory.js";

const proc = vi.hoisted(() => ({
  owner: 2000,
  hiddenSelf: false,
  statError: "",
  visible: false,
  absent: false,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readdir: async (path: string) =>
    path.endsWith("/task") ? [path.split("/")[2]] : proc.absent ? ["10"] : ["10", "11"],
  readFile: async (path: string) => {
    if ((path.startsWith("/fake-proc/11/") && !proc.visible) || proc.hiddenSelf)
      throw Object.assign(new Error("refused"), { code: "EACCES" });
    if (path.endsWith("/stat")) {
      const pid = path.split("/")[2];
      return `${pid} (worker) S ${[1, ...Array(17).fill(0), 100].join(" ")}`;
    }
    if (path.endsWith("/environ")) return "PATH=/bin\0";
    if (path.endsWith("/children")) return "";
    throw new Error(`Unexpected read: ${path}`);
  },
  lstat: async () => {
    if (proc.statError) throw Object.assign(new Error(proc.statError), { code: proc.statError });
    return { uid: proc.owner, isDirectory: () => true };
  },
}));

function inventory(owner = 2000, hiddenSelf = false) {
  Object.assign(proc, { owner, hiddenSelf, statError: "", visible: false, absent: false });
  return procInventory({ root: "/fake-proc", selfPid: 10, uid: 1000 });
}

afterEach(() => vi.restoreAllMocks());

function probe(code?: string) {
  return vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    expect(signal).toBe(0);
    if (code) throw Object.assign(new Error(code), { code });
    return true;
  });
}

describe("hidepid refused entries", () => {
  it("excludes another user's unreadable PID from the baseline and marker scans", async () => {
    probe("EPERM");
    const source = inventory();
    for (const request of [
      { requireComplete: true },
      { requireComplete: true, marker: "m", since: "0" },
    ]) {
      const snapshot = await source.snapshot(request);
      expect(snapshot.entries.map((entry) => entry.pid)).toEqual([10]);
      expect([...snapshot.uncertain]).toEqual([]);
    }
    const tree = await ClaudeProcessTree.prepare(source);
    try {
      await tree.scan();
      await tree.confirm(Date.now() + 1000);
    } finally {
      tree.close();
    }
  });

  it("excludes a root-owned unsignalable PID, also matching same-euid setresuid", async () => {
    const kill = probe("EPERM");
    const source = inventory(0);
    expect([...(await source.snapshot({ requireComplete: true })).uncertain]).toEqual([]);
    expect(kill).toHaveBeenCalledWith(11, 0);
    const tree = await ClaudeProcessTree.prepare(source);
    tree.close();
  });

  it("rejects a same-euid non-dumpable process from the Claude baseline", async () => {
    probe("EPERM");
    vi.spyOn(process, "geteuid").mockReturnValue(1000);
    const source = inventory(1000);
    const snapshot = await source.snapshot({ requireComplete: true });
    expect([...snapshot.uncertain]).toEqual([11]);
    await expect(ClaudeProcessTree.prepare(source)).rejects.toThrow(
      "Process baseline is incomplete",
    );
  });

  it("rejects a baseline PID when ownership cannot be read", async () => {
    probe("EPERM");
    const source = inventory();
    proc.statError = "EACCES";
    await expect(ClaudeProcessTree.prepare(source)).rejects.toThrow(
      "Process baseline is incomplete",
    );
  });

  it.each([{ owner: 2000, euid: 1000, uncertain: [] }])(
    "checks refused unsignalable owner $owner against effective UID $euid",
    async ({ owner, euid, uncertain }) => {
      probe("EPERM");
      vi.spyOn(process, "geteuid").mockReturnValue(euid);
      const source = inventory(owner);
      for (const request of [{ requireComplete: true }, { marker: "m", since: "0" }]) {
        expect([...(await source.snapshot(request)).uncertain]).toEqual(uncertain);
      }
      const tree = await ClaudeProcessTree.prepare(source);
      try {
        await tree.confirm(Date.now() + 1000);
      } finally {
        tree.close();
      }
      expect([...(await source.snapshot({})).uncertain]).toEqual([]);
    },
  );

  it.each([
    { code: "ENOENT", uncertain: [] },
    { code: "EACCES", uncertain: [11] },
    { code: "EIO", uncertain: [11] },
  ])("handles ownership lookup error $code after EPERM", async ({ code, uncertain }) => {
    probe("EPERM");
    const source = inventory();
    proc.statError = code;
    for (const request of [{ requireComplete: true }, { marker: "m", since: "0" }]) {
      expect([...(await source.snapshot(request)).uncertain]).toEqual(uncertain);
    }
  });

  it.each([
    { owner: 2000, euid: 1000, label: "setuid to another non-root user" },
    { owner: 0, euid: 1000, label: "setuid-root" },
    { owner: 2000, euid: 2000, label: "different Worker effective uid" },
    { owner: 1000, euid: 1000, label: "same user" },
  ])(
    "keeps signalable $label uncertain for directory cleanup but outside the Claude tree",
    async ({ owner, euid }) => {
      const kill = probe();
      vi.spyOn(process, "geteuid").mockReturnValue(euid);
      const source = inventory(owner);
      for (const request of [{ requireComplete: true }, { marker: "m", since: "0" }]) {
        expect([...(await source.snapshot(request)).uncertain]).toEqual([11]);
      }
      expect(kill).toHaveBeenCalledWith(11, 0);
      const tree = await ClaudeProcessTree.prepare(source);
      try {
        await tree.terminate(Date.now() + 1000);
        await tree.confirm(Date.now() + 1000);
      } finally {
        tree.close();
      }
      expect([...(await source.snapshot({})).uncertain]).toEqual([]);
    },
  );

  it.each([
    { owner: 0, code: undefined, label: "setuid-root" },
    { owner: 1000, code: undefined, label: "same-user non-dumpable" },
    { owner: 0, code: "EPERM", label: "non-dumpable after setresuid retaining euid" },
  ])("ignores unrelated $label identities hidden mid-Attempt", async ({ owner, code }) => {
    const kill = probe(code);
    vi.spyOn(process, "geteuid").mockReturnValue(1000);
    const source = inventory(owner);
    proc.absent = true;
    const tree = await ClaudeProcessTree.prepare(source);
    try {
      proc.absent = false;
      await tree.scan();
      await tree.terminate(Date.now() + 1000);
      await tree.confirm(Date.now() + 1000);
      expect(kill).toHaveBeenCalledWith(11, 0);
    } finally {
      tree.close();
    }
  });

  it("keeps a new same-euid inaccessible process unknown during cleanup", async () => {
    probe("EPERM");
    vi.spyOn(process, "geteuid").mockReturnValue(1000);
    const source = inventory(1000);
    proc.absent = true;
    const tree = await ClaudeProcessTree.prepare(source);
    try {
      proc.absent = false;
      await expect(tree.confirm(Date.now() + 25)).rejects.toThrow(/unconfirmed|timed out/);
      proc.absent = true;
      await tree.confirm(Date.now() + 1000);
    } finally {
      tree.close();
    }
  });

  it.each([undefined, "EPERM"])(
    "remembers an owned identity hidden after tracking (probe %s)",
    async (code) => {
      probe(code);
      vi.spyOn(process, "geteuid").mockReturnValue(1000);
      const source = inventory(0);
      proc.visible = true;
      const tree = await ClaudeProcessTree.prepare(source);
      const signal = vi.spyOn(source, "signal");
      let alive = true;
      try {
        tree.start(11, () => alive);
        await tree.scan();
        tree.close();
        proc.visible = false;
        alive = false;
        await tree.terminate(Date.now() + 1000);
        await expect(tree.confirm(Date.now() + 25)).rejects.toThrow(/unconfirmed|timed out/);
        await expect(tree.confirm(Date.now() + 25)).rejects.toThrow(/unconfirmed|timed out/);
        expect(signal).not.toHaveBeenCalled();
        proc.absent = true;
        await tree.confirm(Date.now() + 1000);
      } finally {
        tree.close();
      }
    },
  );

  it.each([
    { code: "ESRCH", uncertain: [] },
    { code: "EIO", uncertain: [11] },
  ])("handles probe error $code", async ({ code, uncertain }) => {
    const kill = probe(code);
    const source = inventory(code === "ESRCH" ? 0 : 2000);
    for (const request of [{ requireComplete: true }, { marker: "m", since: "0" }]) {
      expect([...(await source.snapshot(request)).uncertain]).toEqual(uncertain);
    }
    expect(kill).toHaveBeenCalledWith(11, 0);
  });

  it("still rejects an inventory that hides the Worker", async () => {
    probe("EPERM");
    await expect(inventory(2000, true).snapshot({ requireComplete: true })).rejects.toThrow(
      "does not list this Worker",
    );
  });
});
