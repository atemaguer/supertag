import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProcessInventory,
  procInventory,
  psInventory,
} from "@supertag/worker-sdk/internal/process-inventory";
import { afterEach, expect, it, vi } from "vitest";
import { CursorProcessTree } from "./src/process-tree.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: run }) };
});

const scratch: string[] = [];
afterEach(async () => {
  run.mockReset();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function recording(source: ProcessInventory, signals: number[]): ProcessInventory {
  return {
    snapshot: (request) => source.snapshot(request),
    started: (pid) => source.started(pid),
    now: () => source.now(),
    signal: async (pid) => {
      signals.push(pid);
    },
  };
}

it("finds a Cursor helper through the macOS ps inventory", async () => {
  run.mockImplementation(async (file: string) => ({
    stdout:
      file === "/usr/bin/perl"
        ? "101 101 1\n102 101 0\n"
        : "101 1 101 Ss Tue Oct 6 10:00:00 2026 node\n102 101 101 S Tue Oct 6 10:00:01 2026 helper\n",
    stderr: "",
  }));
  const signals: number[] = [];
  const tree = await CursorProcessTree.prepare(recording(psInventory({ selfPid: 101 }), signals));
  try {
    tree.start(101, () => true);
    await tree.signalDescendants("SIGTERM", Date.now() + 2_000);
    expect(signals).toContain(102);
  } finally {
    tree.close();
  }
});

function stat(pid: number, parent: number, group: number, started: number): string {
  const rest = [parent, group, 101, 0, -1, 4194560, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, started];
  return `${pid} (node) S ${rest.join(" ")} 1000 2000\n`;
}

it("finds a Cursor helper through the Linux proc inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-proc-"));
  scratch.push(root);
  await writeFile(join(root, "uptime"), "1 1\n");
  await mkdir(join(root, "self"));
  for (const [pid, parent, group] of [
    [101, 1, 101],
    [102, 101, 101],
  ] as const) {
    const base = join(root, String(pid));
    await mkdir(base);
    await writeFile(join(base, "stat"), stat(pid, parent, group, 2));
    const uid = process.getuid?.() ?? 0;
    await writeFile(join(base, "status"), `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    await writeFile(join(base, "environ"), "");
  }
  const signals: number[] = [];
  const tree = await CursorProcessTree.prepare(
    recording(procInventory({ root, selfPid: 101 }), signals),
  );
  try {
    await writeFile(
      join(root, "101", "environ"),
      `SUPERTAG_INTERNAL_PROCESS_MARKER=${tree.marker}\0`,
    );
    tree.start(101, () => true);
    await tree.signalDescendants("SIGTERM", Date.now() + 2_000);
    expect(signals).toContain(102);
  } finally {
    tree.close();
  }
});
