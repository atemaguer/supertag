import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ExecutionCleanupError, type HarnessRuntime } from "@supertag/worker-sdk";
import {
  createWorkspaceToolBridge,
  MAILBOX_SEND_ACTION,
  spawnOwnedProcess,
  WORKSTREAM_POST_ACTION,
} from "@supertag/worker-sdk/internal/rust-harness";
import type { CursorSplitExecutor } from "../index.js";
import { localCursorCommand } from "../local-command.js";

const FILE_READ_TOOLS = new Set(["read", "grep", "glob", "ls"]);
const ACTIONS = new Set([
  "files:read",
  "files:write",
  "commands:execute",
  "web:search",
  WORKSTREAM_POST_ACTION,
  MAILBOX_SEND_ACTION,
]);

export function validateActions(actions: readonly string[], allowUnsandboxedCommands: boolean) {
  if (actions.some((action) => !ACTIONS.has(action)))
    throw new Error("Cursor does not support an accepted action");
  if (
    actions.includes("commands:execute") &&
    (!actions.includes("files:write") || !allowUnsandboxedCommands)
  )
    throw new Error("Cursor command access requires files:write and Worker Host opt-in");
}

/** A Workspace Volume copy the Worker Host staged for this Attempt. */
export interface WorkspaceCopy {
  readonly destination: string;
  readonly readWrite: boolean;
}

export async function createWorkspace(
  actions: readonly string[],
  timeoutMs: number,
  runnerEntrypoint?: string,
  remote?: CursorSplitExecutor,
  copies: readonly WorkspaceCopy[] = [],
) {
  const environment = process.env;
  const scratchPath = environment["SUPERTAG_ADAPTER_STATE_DIRECTORY"] ?? "";
  const workspacePath = environment["SUPERTAG_WORKSPACE_DIRECTORY"] ?? "";
  if (!isAbsolute(scratchPath) || (!remote && !isAbsolute(workspacePath)))
    throw new Error("Cursor requires Worker Host-owned execution directories");
  const info = await lstat(scratchPath);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Cursor state is not privately owned");
  const scratch = await realpath(scratchPath);
  const workspace = remote ? "." : await realpath(workspacePath);
  if (!remote && !(await lstat(workspace)).isDirectory())
    throw new Error("Cursor Workspace is missing");

  // Cursor's native SDK stays in an empty directory. All file and command access goes
  // through the Attempt's workspace tools, which never inherit the SDK's credentials.
  const home = join(scratch, "cursor-home");
  const nativeWorkspace = join(home, "workspace");
  const storeDirectory = join(home, "store");
  const commandHome = join(scratch, "cursor-command-home");
  await mkdir(home, { mode: 0o700 });
  await mkdir(nativeWorkspace, { mode: 0o700 });
  await mkdir(commandHome, { mode: 0o700 });
  const runtime: Pick<HarnessRuntime, "spawn" | "placement"> = {
    placement: "local",
    spawn(spec, signal) {
      return spawnOwnedProcess({
        spec:
          runnerEntrypoint && spec.command === process.execPath
            ? { ...spec, args: [runnerEntrypoint] }
            : spec,
        cwd: spec.cwd ?? (remote ? nativeWorkspace : workspace),
        environment: { PATH: "/usr/bin:/bin", HOME: commandHome, TMPDIR: join(scratch, "tmp") },
        ...(signal ? { signal } : {}),
        inheritProcessGroup: true,
        maximumOutput: 64 * 1024,
        // The enclosing Rust guardian records process ownership before bootstrap.
        record: async () => {},
      });
    },
  };
  if (remote)
    return { home, nativeWorkspace, storeDirectory, workspace, runtime, executor: remote };
  // A local copy is a canonical directory outside the checkout. The file tools reach it as one
  // more root: read-only copies only for reading, read-write copies also for writing.
  for (const copy of copies)
    if (!isAbsolute(copy.destination) || (await realpath(copy.destination)) !== copy.destination)
      throw new Error("Cursor Workspace copy is not a canonical local directory");
  const files = createWorkspaceToolBridge({
    environment: {
      // Every root must be inside the environment root, so copies widen it to the filesystem
      // root; each root is then checked against its own canonical path.
      rootDirectory: copies.length ? "/" : workspace,
      resolvePath: (path) => resolve(workspace, path),
      async read(path) {
        // Used for edit. Refuse oversized files and FIFOs before reading their contents.
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 8 * 1024 * 1024)
            throw new Error("Workspace file is unavailable or exceeds the edit limit");
          return await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      },
      spawn: runtime.spawn,
    },
    workspaceRoot: workspace,
    readOnlyRoots: copies.filter((copy) => !copy.readWrite).map((copy) => copy.destination),
    writableRoots: copies.filter((copy) => copy.readWrite).map((copy) => copy.destination),
    permissions: { filesWrite: actions.includes("files:write"), commandsExecute: false },
  });
  // The local command adapter has a credential-free HOME and invokes a non-login shell.
  const commands = actions.includes("commands:execute")
    ? localCursorCommand(runtime, workspace, commandHome, timeoutMs)
    : undefined;
  const tools = [
    ...files.tools.filter(
      ({ name }) => !FILE_READ_TOOLS.has(name) || actions.includes("files:read"),
    ),
    ...(commands?.tools ?? []),
  ];
  const calls = new Set<ReturnType<CursorSplitExecutor["call"]>>();
  let closing = false;
  async function settle(operation: "cancelAll" | "dispose") {
    closing = true;
    try {
      await Promise.all([files[operation](), commands?.[operation]()]);
    } finally {
      // A tool may have settled its process handle and still be delivering its
      // final cleanup error to the runner. Wait for those calls to observe it.
      await Promise.allSettled([...calls]);
    }
  }
  const executor: CursorSplitExecutor = {
    tools,
    async call(name, input, signal) {
      if (closing) throw new Error("Cursor workspace tools are closing");
      if (!tools.some((tool) => tool.name === name)) throw new Error("Cursor tool is not admitted");
      const call = (name === "command" && commands ? commands : files).call(name, input, signal);
      calls.add(call);
      try {
        return await call;
      } finally {
        calls.delete(call);
      }
    },
    cancelAll: () => settle("cancelAll"),
    async dispose() {
      try {
        await settle("dispose");
      } catch (cause) {
        throw new ExecutionCleanupError("Cursor workspace cleanup could not be confirmed", {
          cause,
        });
      }
    },
  };
  return { home, nativeWorkspace, storeDirectory, workspace, runtime, executor };
}
