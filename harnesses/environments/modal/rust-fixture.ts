// Fakes of the Modal client for the provider's tests, shared with the conformance suite. Files
// and processes run on the local machine; the privileged exec never executes the seal program.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { ModalSandboxClient } from "./src/index.ts";
import {
  createModalWorkspaceSession,
  type ModalWorkspaceScope,
} from "./src/rust-provider/session.ts";

export const sandboxId = "sb-0000000000000000000000";

export function collected(child: ChildProcess) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (text) => {
      stdout += text;
    });
    child.stderr?.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 137, stdout, stderr }));
    child.stdin?.end();
  });
}

/**
 * A fake privileged exec. It never executes anything: the seal program kills every process it
 * did not record, so it must never run on the machine running the tests.
 */
export function fakePrivileged(sealExit = 0) {
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text) controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  return vi.fn<ModalSandboxClient["exec"]>(async (command) => {
    const seal = command.findIndex((value) => value.includes("sealed %d"));
    let exitCode = 0;
    let stdout = `${JSON.stringify({
      interpreter: "/fixture/python3",
      processes: [
        [1, "3"],
        [2, "4"],
      ],
    })}\n`;
    if (seal >= 0) {
      // What follows the seal runs in its process: the capture program, safe to run here.
      const then = command.slice(seal + 2);
      if (sealExit !== 0) [exitCode, stdout] = [sealExit, ""];
      else if (!then.length) stdout = "sealed 1\n";
      else {
        const result = spawnSync("python3", then.slice(1), { encoding: "utf8" });
        [exitCode, stdout] = [result.status ?? 1, `sealed 1\n${result.stdout}`];
      }
    }
    return {
      stdin: { async writeBytes() {}, async close() {} },
      stdout: stream(stdout),
      stderr: stream(""),
      async wait() {
        return exitCode;
      },
    };
  });
}

/** `false` leaves the sandbox without a privileged exec, so it can never be sealed. */
export async function fixture(
  cleanups: (() => Promise<void>)[],
  privileged: ReturnType<typeof fakePrivileged> | false = fakePrivileged(),
  preparedRoot?: string,
) {
  const roots = new Set<string>();
  const children: { child: ChildProcess; done: Promise<number>; running: boolean }[] = [];
  let allocated = false;
  let finished = false;
  let tags: Record<string, string> = {};
  let nextExit: number | undefined;
  const reap = async () => {
    for (const record of children) {
      if (record.running && record.child.pid) {
        try {
          process.kill(
            process.platform === "win32" ? record.child.pid : -record.child.pid,
            "SIGKILL",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    await Promise.all(children.map((record) => record.done));
  };
  cleanups.push(async () => {
    await reap();
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  const exec = vi.fn<ModalSandboxClient["exec"]>(async (command, options) => {
    for (const value of command) {
      if (/^\/tmp\/supertag-workspace-[a-f0-9-]{36}$/u.test(value)) roots.add(value);
    }
    if (nextExit !== undefined && command.includes("split-write")) {
      const code = nextExit;
      nextExit = undefined;
      return {
        stdin: { async writeBytes() {}, async close() {} },
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        async wait() {
          return code;
        },
      };
    }
    const [program, ...args] = command;
    if (!program) throw new Error("Missing fixture program");
    const child = spawn(program, args, {
      cwd: options.workdir,
      env: { PATH: process.env["PATH"], ...options.env },
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    child.stdin.on("error", () => {});
    const done = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 137));
    });
    const record = { child, done, running: true };
    void done
      .finally(() => {
        record.running = false;
      })
      .catch(() => undefined);
    children.push(record);
    return {
      stdin: {
        writeBytes: (bytes) =>
          new Promise<void>((resolve, reject) => {
            child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
          }),
        close: () =>
          new Promise<void>((resolve, reject) => {
            child.stdin.once("error", reject);
            child.stdin.end(resolve);
          }),
      },
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      wait: () => done,
    };
  });
  const terminate = vi.fn<ModalSandboxClient["terminate"]>(async () => {
    await reap();
    finished = true;
    return 137;
  });
  const snapshotFilesystem = vi.fn(async () => "im-prepared0000000000000000");
  const sandbox = {
    sandboxId,
    exec,
    terminate,
    snapshotFilesystem,
    ...(privileged ? { execPrivileged: privileged } : {}),
  };
  const create = vi.fn<ModalWorkspaceScope["create"]>(async (params) => {
    allocated = true;
    tags = { ...params.tags };
    return sandbox;
  });
  const inventory = {
    find: vi.fn<ModalWorkspaceScope["inventory"]["find"]>(async () =>
      allocated && !finished ? [{ sandboxId, metadata: tags }] : [],
    ),
    get: vi.fn<ModalWorkspaceScope["inventory"]["get"]>(async (id) => {
      if (!allocated || id !== sandboxId) throw new Error("No matching sandbox");
      return { sandboxId, metadata: tags };
    }),
    poll: vi.fn<ModalWorkspaceScope["inventory"]["poll"]>(async () => (finished ? 137 : null)),
    terminate: vi.fn<ModalWorkspaceScope["inventory"]["terminate"]>(() =>
      terminate({ wait: true }),
    ),
  };
  const close = vi.fn();
  const deleteImage = vi.fn<ModalWorkspaceScope["deleteImage"]>(async () => {});
  const open = vi.fn(
    async (): Promise<ModalWorkspaceScope> => ({ create, inventory, deleteImage, close }),
  );
  const session = createModalWorkspaceSession({
    open,
    ...(preparedRoot === undefined ? {} : { preparedRoot }),
  });
  cleanups.push(() => session.close());
  return {
    session,
    open,
    create,
    deleteImage,
    snapshotFilesystem,
    close,
    inventory,
    exec,
    terminate,
    recovery() {
      const value = createModalWorkspaceSession({ open });
      cleanups.push(() => value.close());
      return value;
    },
    failNextProcess(code: number) {
      nextExit = code;
    },
    runningChildren() {
      return children.filter((record) => record.running).length;
    },
  };
}
