import { beforeEach, expect, it, vi } from "vitest";
import { psInventory } from "./src/process-inventory.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: run }) };
});

beforeEach(() => run.mockReset());

it.each([undefined, "attempt-marker"])(
  "reads macOS process groups and identities with marker %s",
  async (marker) => {
    run.mockImplementation(async (file: string) => {
      if (file === "/usr/bin/perl")
        return { stdout: "101 101 1\n102 101 0\n103 103 0\n", stderr: "" };
      return {
        stdout: [
          "101 1 101 Ss Tue Oct 6 10:00:00 2026 node SUPERTAG_INTERNAL_PROCESS_MARKER=attempt-marker",
          "102 1 101 S Tue Oct 6 10:00:01 2026 /bin/sleep 30",
          "103 1 103 S Tue Oct 6 10:00:01 2026 /bin/sleep 30",
          "104 1 101 Z Tue Oct 6 10:00:01 2026 <defunct>",
        ].join("\n"),
        stderr: "",
      };
    });
    const snapshot = await psInventory({ selfPid: 101 }).snapshot({
      ...(marker === undefined ? {} : { marker }),
      requireComplete: true,
    });
    expect(snapshot.entries).toEqual([
      { pid: 101, parent: 1, group: 101, session: 101, started: "Tue Oct 6 10:00:00 2026" },
      { pid: 102, parent: 1, group: 101, session: 101, started: "Tue Oct 6 10:00:01 2026" },
      { pid: 103, parent: 1, group: 103, session: 103, started: "Tue Oct 6 10:00:01 2026" },
    ]);
    expect([...snapshot.marked]).toEqual(marker === undefined ? [] : [101]);
    expect(run.mock.calls[0]?.[1]).toContain("pid=,ppid=,pgid=,stat=,lstart=");
  },
);

it("rejects an unreadable group column in a complete macOS inventory", async () => {
  run.mockResolvedValue({
    stdout: "101 1 ? Ss Tue Oct 6 10:00:00 2026\n",
    stderr: "",
  });
  await expect(psInventory({ selfPid: 101 }).snapshot({ requireComplete: true })).rejects.toThrow(
    "unreadable ps entry",
  );
});

it("does not treat a marker in ps command arguments as an environment marker", async () => {
  run.mockImplementation(async (file: string) => ({
    stdout:
      file === "/usr/bin/perl"
        ? "101 101 0\n"
        : "101 1 101 S Tue Oct 6 10:00:00 2026 node SUPERTAG_INTERNAL_PROCESS_MARKER=attempt-marker\n",
    stderr: "",
  }));
  const snapshot = await psInventory({ selfPid: 101 }).snapshot({ marker: "attempt-marker" });
  expect([...snapshot.marked]).toEqual([]);
});

it.each([
  "101 1 101 S Tue Oct 6 10:00:02 2026",
  "101 1 102 S Tue Oct 6 10:00:00 2026",
  "101 2 101 S Tue Oct 6 10:00:00 2026",
])("does not join native details across an identity or membership change: %s", async (after) => {
  let listings = 0;
  run.mockImplementation(async (file: string) => ({
    stdout:
      file === "/usr/bin/perl"
        ? "101 101 1\n"
        : ++listings === 1
          ? "101 1 101 S Tue Oct 6 10:00:00 2026\n"
          : `${after}\n`,
    stderr: "",
  }));
  const snapshot = await psInventory({ selfPid: 101 }).snapshot({ marker: "attempt-marker" });
  expect(snapshot.entries[0]?.session).toBeUndefined();
  expect(snapshot.marked.size).toBe(0);
});

it("fails closed when the native helper cannot run", async () => {
  run.mockImplementation(async (file: string) => {
    if (file === "/usr/bin/perl") throw new Error("missing or denied helper");
    return { stdout: "101 1 101 S Tue Oct 6 10:00:00 2026\n", stderr: "" };
  });
  await expect(psInventory({ selfPid: 101 }).snapshot({})).rejects.toThrow(
    "macOS process details are unavailable",
  );
});

it("keeps an unrelated exiting process without making the scan uncertain", async () => {
  run.mockImplementation(async (file: string) => ({
    stdout:
      file === "/usr/bin/perl"
        ? "101 101 0\n102 gone\n"
        : "101 1 101 S Tue Oct 6 10:00:00 2026\n102 1 102 S Tue Oct 6 10:00:01 2026\n",
    stderr: "",
  }));
  const snapshot = await psInventory({ selfPid: 101 }).snapshot({ requireComplete: true });
  expect(snapshot.entries.map(({ pid }) => pid)).toEqual([101, 102]);
  expect([...snapshot.uncertain]).toEqual([]);
});

it("keeps a tracked process uncertain when its session vanishes", async () => {
  run.mockImplementation(async (file: string) => ({
    stdout:
      file === "/usr/bin/perl"
        ? "101 101 0\n102 gone\n"
        : "101 1 101 S Tue Oct 6 10:00:00 2026\n102 101 102 S Tue Oct 6 10:00:01 2026\n",
    stderr: "",
  }));
  const snapshot = await psInventory({ selfPid: 101 }).snapshot({
    requireComplete: true,
    known: (entry) => entry.pid === 102,
  });
  expect(snapshot.entries.map(({ pid }) => pid)).toEqual([101, 102]);
  expect([...snapshot.uncertain]).toEqual([102]);
});

it("continues past a denied unrelated macOS process", async () => {
  run.mockImplementation(async (file: string) => ({
    stdout:
      file === "/usr/bin/perl"
        ? "101 101 0\n102 denied\n"
        : "101 1 101 S Tue Oct 6 10:00:00 2026\n102 1 102 S Tue Oct 6 10:00:01 2026\n",
    stderr: "",
  }));
  const snapshot = await psInventory({ selfPid: 101 }).snapshot({ requireComplete: true });
  expect(snapshot.entries.map(({ pid }) => pid)).toEqual([101, 102]);
  expect([...(snapshot.inaccessible ?? [])]).toEqual([102]);
  expect([...snapshot.uncertain]).toEqual([]);
});

it("keeps a tracked macOS process uncertain when getsid is denied", async () => {
  run.mockImplementation(async (file: string) => ({
    stdout:
      file === "/usr/bin/perl"
        ? "101 101 0\n102 denied\n"
        : "101 1 101 S Tue Oct 6 10:00:00 2026\n102 101 101 S Tue Oct 6 10:00:01 2026\n",
    stderr: "",
  }));
  const snapshot = await psInventory({ selfPid: 101 }).snapshot({
    requireComplete: true,
    known: (entry) => entry.pid === 102,
  });
  expect([...snapshot.uncertain]).toEqual([102]);
});

it("keeps a new child with an unreadable session for parent-chain discovery", async () => {
  run.mockImplementation(async (file: string) => ({
    stdout:
      file === "/usr/bin/perl"
        ? "101 101 0\n102 101 0\n103 gone\n"
        : "101 1 101 S Tue Oct 6 10:00:00 2026\n102 101 101 S Tue Oct 6 10:00:01 2026\n103 102 101 S Tue Oct 6 10:00:02 2026\n",
    stderr: "",
  }));
  const snapshot = await psInventory({ selfPid: 101 }).snapshot({
    requireComplete: true,
    known: (entry) => entry.pid === 102,
  });
  expect(snapshot.entries.map(({ pid }) => pid)).toEqual([101, 102, 103]);
  expect(snapshot.entries[2]?.session).toBeUndefined();
  expect([...snapshot.uncertain]).toEqual([]);
});
