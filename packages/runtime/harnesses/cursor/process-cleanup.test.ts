import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { HarnessRuntime, ProcessHandle } from "@supertag/worker-sdk";
import { platformProcessInventory } from "@supertag/worker-sdk/internal/process-inventory";
import { afterAll, afterEach, expect, it } from "vitest";
import { type CursorRunRequest, runCursor } from "./src/index.js";

const inventory = platformProcessInventory();
const inventoryAvailable = await inventory.snapshot({}).then(
  () => true,
  () => false,
);
const testTmp = process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir();
const dirs: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
const childPids: number[] = [];
const originalKey = process.env["CURSOR_API_KEY"];
process.env["CURSOR_API_KEY"] = "cursor-cleanup-test-key";
afterAll(() => {
  if (originalKey === undefined) delete process.env["CURSOR_API_KEY"];
  else process.env["CURSOR_API_KEY"] = originalKey;
});

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of dirs) {
    const pid = Number(await readFile(join(dir, "tool.pid"), "utf8").catch(() => "0"));
    if (pid > 1) childPids.push(pid);
  }
  for (const pid of childPids) {
    const snapshot = await inventory.snapshot({}).catch(() => undefined);
    for (const entry of snapshot?.entries ?? [])
      if (entry.pid === pid || entry.group === pid)
        await inventory.signal(entry.pid, entry.started, "SIGKILL");
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("close", () => resolve());
        }),
    ),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  children.length = 0;
  childPids.length = 0;
});

function request(dir: string, timeoutMs = 5_000): CursorRunRequest {
  return {
    prompt: "work",
    workspace: dir,
    timeoutMs,
    home: dir,
    storeDirectory: dir,
    agentId: "agent-fixture",
    mcpServers: {},
    tools: [],
    disallowedTools: [],
    toolInputs: [],
  };
}

const fakeRunner = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const mode = process.argv[1], pidFile = process.argv[2];
let started = false;
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
if (mode === 'crash') process.on('SIGCONT', () => process.exit(2));
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'close') process.exit(0);
  if (frame.type === 'start' && !started) {
    started = true;
    const tool = spawn('/bin/sh', ['-c', 'sleep 30'], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    writeFileSync(pidFile, String(tool.pid));
    process.stdout.write(JSON.stringify({ type: 'agent', agentId: 'agent-fixture' }) + '\\n');
    if (mode === 'normal') {
      process.stdout.write(JSON.stringify({ type: 'result', status: 'finished', result: 'done' }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;

function runtime(mode: string, pidFile: string): HarnessRuntime {
  return {
    placement: "local",
    id: "fake-cursor",
    rootDirectory: testTmp,
    resolvePath: (path) => join(testTmp, path),
    async prepare() {},
    async read() {
      return "";
    },
    async dispose() {},
    async spawn(spec): Promise<ProcessHandle> {
      const child = spawn(process.execPath, ["-e", fakeRunner, mode, pidFile], {
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          ...process.env,
          SUPERTAG_INTERNAL_PROCESS_MARKER: spec.environment?.["SUPERTAG_INTERNAL_PROCESS_MARKER"],
        },
      });
      children.push(child);
      const output = (async function* () {
        for await (const text of createInterface({ input: child.stdout }))
          yield { stream: "stdout" as const, text: `${text}\n` };
      })();
      const result = new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          child.once("close", (exitCode) => resolve({ exitCode, stdout: "", stderr: "" }));
        },
      );
      return {
        pid: child.pid,
        output,
        write: async (bytes) => {
          child.stdin.write(bytes);
        },
        wait: () => result,
        kill: (signal = "SIGTERM") => {
          child.kill(signal);
        },
      };
    },
  } as HarnessRuntime;
}

async function fixture(timeoutMs?: number) {
  const dir = await mkdtemp(join(testTmp, "cursor-cleanup-"));
  dirs.push(dir);
  return { dir, pidFile: join(dir, "tool.pid"), request: request(dir, timeoutMs) };
}

async function toolPid(path: string): Promise<number> {
  const pid = Number(await readFile(path, "utf8"));
  childPids.push(pid);
  return pid;
}

it.skipIf(!inventoryAvailable)(
  "confirms final cleanup of a detached tool shell after a normal result",
  async () => {
    const f = await fixture();
    const events = await Array.fromAsync(runCursor(f.request, runtime("normal", f.pidFile)));
    expect(events.at(-1)).toEqual({ type: "output.message", text: "done", final: true });
    const pid = await toolPid(f.pidFile);
    expect((await inventory.snapshot({})).entries.some((entry) => entry.pid === pid)).toBe(false);
  },
  15_000,
);

it.skipIf(!inventoryAvailable)(
  "confirms cleanup after the runner crashes",
  async () => {
    const f = await fixture();
    await expect(
      Array.fromAsync(runCursor(f.request, runtime("crash", f.pidFile))),
    ).rejects.toThrow(/exited unsuccessfully/);
    expect(await inventory.started(await toolPid(f.pidFile))).toBeUndefined();
  },
  15_000,
);

it.skipIf(!inventoryAvailable).each([
  ["cancel", "hang", 5_000],
  ["timeout", "hang", 1_500],
  ["SIGTERM-ignoring runner", "ignore-term", 5_000],
] as const)(
  "confirms cleanup after %s",
  async (name, mode, timeoutMs) => {
    const f = await fixture(timeoutMs);
    const controller = new AbortController();
    const pending = Array.fromAsync(
      runCursor(f.request, runtime(mode, f.pidFile), controller.signal),
    );
    const failure = expect(pending).rejects.toThrow();
    if (name !== "timeout") {
      await expect
        .poll(() =>
          readFile(f.pidFile, "utf8")
            .then(Boolean)
            .catch(() => false),
        )
        .toBe(true);
      controller.abort();
    }
    await failure;
    expect(await inventory.started(await toolPid(f.pidFile))).toBeUndefined();
  },
  15_000,
);
