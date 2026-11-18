// Fakes of the E2B SDK for the provider's tests, shared with the conformance suite. Files and
// processes run on the local machine; the privileged run never executes the seal program.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SandboxOpts } from "e2b";
import { vi } from "vitest";
import {
  createE2BWorkspaceSession,
  type E2BWorkspaceSandbox,
  type E2BWorkspaceTemplateBuild,
} from "./src/rust-provider/session.ts";

export function wait(child: ChildProcess) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (text) => {
      stdout += text;
    });
    child.stderr?.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

/**
 * A fake privileged run. It never executes anything: the seal program kills every process it
 * did not record, so it must never run on the machine running the tests.
 */
/** The relay processes the E2B fake started; each announces itself and records its input. */
export const relayStarts = vi.fn(async (argv: string[], onStdout: (text: string) => void) => {
  const written: string[] = [];
  queueMicrotask(() => onStdout("relay ready 3128\n"));
  return {
    written,
    argv,
    async write(text: string) {
      written.push(text);
    },
    async kill() {},
  };
});

export function fakePrivileged(sealExit = 0) {
  return vi.fn(async (argv: string[]) => {
    const seal = argv.findIndex((value) => value.includes("sealed %d"));
    if (seal < 0)
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          interpreter: "/fixture/python3",
          processes: [
            [1, "7"],
            [2, "9"],
          ],
        })}\n`,
      };
    if (sealExit !== 0) return { exitCode: sealExit, stdout: "" };
    // What follows the seal runs in its process: the capture program, which is safe to run here.
    const then = argv.slice(seal + 2);
    if (!then.length) return { exitCode: 0, stdout: "sealed 2\n" };
    const result = spawnSync("python3", then.slice(1), { encoding: "utf8" });
    return { exitCode: result.status, stdout: `sealed 2\n${result.stdout}` };
  });
}

/** `false` leaves the sandbox without a privileged run, so it can never be sealed. */
export async function fixture(
  cleanups: (() => Promise<void>)[],
  preparedRoot?: string,
  privileged:
    | ((argv: string[]) => Promise<{ exitCode: number; stdout: string }>)
    | false = fakePrivileged(),
) {
  const builds: E2BWorkspaceTemplateBuild[] = [];
  const templates = {
    build: vi.fn(async (spec: E2BWorkspaceTemplateBuild) => {
      builds.push(spec);
      return `built-${builds.length}`;
    }),
  };
  const roots = new Set<string>();
  cleanups.push(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  let alive = false;
  let metadata: Record<string, string> = {};
  let mutationExit: number | undefined;
  const client: E2BWorkspaceSandbox["client"] = {
    sandboxId: "sandbox-one",
    files: {
      async makeDir(path) {
        await mkdir(path, { recursive: true });
        return true;
      },
      async write(path, data) {
        await writeFile(path, typeof data === "string" ? data : new Uint8Array(data));
      },
      async read(path) {
        return readFile(path);
      },
    },
    commands: {
      run: vi.fn(async (command, options) => {
        if (options?.stdin && mutationExit !== undefined) {
          const exitCode = mutationExit;
          mutationExit = undefined;
          return {
            pid: 1,
            async wait() {
              return { exitCode, stdout: "", stderr: "" };
            },
            async kill() {
              return true;
            },
            async sendStdin() {},
            async closeStdin() {},
          };
        }
        // Like E2B's `/bin/bash -l -c`, bash execs a single command, so kill() reaches it. Dash,
        // Linux's /bin/sh, forks instead: kill() would stop only the shell, and the orphan would
        // hold the output pipes open.
        const child = spawn("/bin/bash", ["-c", command], {
          cwd: options?.cwd,
          env: { ...process.env, ...options?.envs },
          signal: options?.signal,
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (options?.background) {
          // Like the E2B SDK, deliver a background command's output as it arrives.
          child.stdout?.setEncoding("utf8").on("data", (text) => options.onStdout?.(text));
          child.stderr?.setEncoding("utf8").on("data", (text) => options.onStderr?.(text));
        }
        const finished = wait(child);
        if (!options?.stdin) child.stdin?.end();
        if (options?.background) {
          return {
            pid: child.pid ?? 1,
            wait: () => finished,
            async kill() {
              return child.kill("SIGKILL");
            },
            async sendStdin(data: string | Uint8Array) {
              child.stdin?.write(data);
            },
            async closeStdin() {
              child.stdin?.end();
            },
          };
        }
        return finished;
      }) as E2BWorkspaceSandbox["client"]["commands"]["run"],
    },
    async kill() {
      alive = false;
      return true;
    },
  };
  const writeTransfer = vi.fn(async (path: string, bytes: Uint8Array) => {
    roots.add(dirname(path));
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  });
  const readTransfer = vi.fn(async (path: string) => {
    const bytes = await readFile(path);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  });
  const snapshot = vi.fn(async () => "snapshot-prepared");
  const factory = {
    create: vi.fn(async (options: SandboxOpts) => {
      alive = true;
      metadata = options.metadata ?? {};
      return {
        client,
        writeTransfer,
        readTransfer,
        snapshot,
        ...(privileged ? { runPrivileged: privileged, startPrivileged: relayStarts } : {}),
      };
    }),
    deleteSnapshot: vi.fn(async (_snapshotId: string) => {}),
  };
  const inventory = {
    find: vi.fn(async () => (alive ? [{ sandboxId: client.sandboxId, metadata }] : [])),
    get: vi.fn(async () => (alive ? { sandboxId: client.sandboxId, metadata } : undefined)),
    kill: vi.fn(async () => {
      alive = false;
    }),
  };
  const session = createE2BWorkspaceSession({
    factory,
    inventory,
    templates,
    template: "test-template",
    ...(preparedRoot === undefined ? {} : { preparedRoot }),
  });
  return {
    session,
    snapshot,
    templates,
    factory,
    inventory,
    client,
    writeTransfer,
    readTransfer,
    failMutation(exitCode: number) {
      mutationExit = exitCode;
    },
  };
}
