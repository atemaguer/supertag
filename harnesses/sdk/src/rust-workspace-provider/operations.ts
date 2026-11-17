import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  ExecutionEnvironment,
  ProcessHandle,
  ProcessSpec,
  SplitExecutionToolResult,
} from "../index.js";
import { createWorkspaceToolBridge } from "../split-execution-bridge.js";

export type WorkspaceOperation =
  | {
      readonly kind: "read";
      readonly path: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | {
      readonly kind: "edit";
      readonly path: string;
      readonly oldText: string;
      readonly newText: string;
      readonly replaceAll?: boolean;
    }
  | { readonly kind: "glob"; readonly pattern: string; readonly path?: string }
  | {
      readonly kind: "grep";
      readonly pattern: string;
      readonly path?: string;
      readonly glob?: string;
      readonly outputMode?: "content" | "files_with_matches" | "count";
      readonly offset?: number;
      readonly headLimit?: number;
    }
  | { readonly kind: "ls"; readonly path?: string }
  | { readonly kind: "command"; readonly command: string; readonly timeoutMs?: number };

export interface WorkspaceOperationsOptions {
  /** A trusted, Attempt-exclusive sandbox. Its lifetime is owned by the caller. */
  readonly environment: ExecutionEnvironment;
  readonly workspaceRoot: string;
  readonly readOnlyRoots?: readonly string[];
  readonly allowedActions: readonly string[];
  /** The Task's path scope over the checkout, applied after symlinks resolve. */
  readonly fileScope?: {
    readonly write: readonly string[];
    readonly readOnly: readonly string[];
    readonly hidden: readonly string[];
  };
  readonly limits?: {
    readonly maxOutputBytes?: number;
    readonly maxReadBytes?: number;
    readonly commandTimeoutMs?: number;
  };
}

const MAX_PATH_BYTES = 4096;
const MAX_PATTERN_BYTES = 2048;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;

// E2B's command handle accumulates the streams even with output callbacks.
// Keep the streams separate and drain excess bytes in the sandbox.
const BOUNDED_PROCESS = `import os, selectors, subprocess, sys
limit = int(sys.argv[1])
with subprocess.Popen(sys.argv[2:], stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
    with selectors.DefaultSelector() as streams:
        streams.register(child.stdout, selectors.EVENT_READ, sys.stdout.buffer)
        streams.register(child.stderr, selectors.EVENT_READ, sys.stderr.buffer)
        remaining = {sys.stdout.buffer: limit, sys.stderr.buffer: limit}
        while streams.get_map():
            for key, _ in streams.select():
                data = os.read(key.fd, 8192)
                if not data:
                    streams.unregister(key.fileobj)
                    continue
                output = key.data
                prefix = data[:remaining[output]]
                if prefix:
                    output.write(prefix)
                    output.flush()
                    remaining[output] -= len(prefix)
    status = child.wait()
sys.exit(status if status >= 0 else 128 - status)`;

/**
 * How much longer than a command's own deadline the host waits before stopping its process
 * through the provider. On Modal that stop ends the whole sandbox, so the command's wrapper
 * enforces the deadline inside the sandbox first.
 */
export const COMMAND_GRACE_MS = 15_000;

// A Workspace command keeps its own lifecycle in the sandbox: it runs in a new session, whose
// group ID is recorded in the private root so a cancel can stop it with a fresh process, and at
// its deadline the group is killed and the wrapper exits 124. Processes that leave the group
// (setsid, nohup into another session) end when the session seals the sandbox before capture.
const COMMAND_PROCESS = String.raw`import os, selectors, signal, subprocess, sys, time
limit = int(sys.argv[1])
deadline = time.monotonic() + int(sys.argv[2]) / 1000
record = sys.argv[3]
os.makedirs(os.path.dirname(record), mode=0o700, exist_ok=True)
# A cancel that arrives before the group exists leaves a stop marker instead.
if os.path.exists(record + ".stop"):
    sys.exit(130)
child = subprocess.Popen(sys.argv[4:], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         stdin=subprocess.DEVNULL, start_new_session=True)
with open(record + ".tmp", "w") as out:
    out.write(str(child.pid))
os.rename(record + ".tmp", record)
if os.path.exists(record + ".stop"):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except OSError:
        pass
expired = False
with selectors.DefaultSelector() as streams:
    streams.register(child.stdout, selectors.EVENT_READ, sys.stdout.buffer)
    streams.register(child.stderr, selectors.EVENT_READ, sys.stderr.buffer)
    remaining = {sys.stdout.buffer: limit, sys.stderr.buffer: limit}
    while streams.get_map():
        left = deadline - time.monotonic()
        if left <= 0:
            expired = True
            break
        for key, _ in streams.select(min(left, 1.0)):
            data = os.read(key.fd, 8192)
            if not data:
                streams.unregister(key.fileobj)
                continue
            output = key.data
            prefix = data[:remaining[output]]
            if prefix:
                output.write(prefix)
                output.flush()
                remaining[output] -= len(prefix)
while not expired:
    try:
        status = child.wait(timeout=max(0.01, deadline - time.monotonic()))
        break
    except subprocess.TimeoutExpired:
        if time.monotonic() >= deadline:
            expired = True
if expired:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except OSError:
        pass
    child.wait()
    sys.stderr.write("\nCommand stopped at its %d ms deadline\n" % int(sys.argv[2]))
    sys.stderr.flush()
    status = 124
for leftover in (record, record + ".stop"):
    try:
        os.unlink(leftover)
    except OSError:
        pass
sys.exit(status if status >= 0 else 128 - status)`;

// Stops a recorded command's process group. The record is in the sandbox, so its value is only
// trusted to be a group other than the sandbox's init.
// It never waits: the marker stops a command that has not recorded its group yet, because the
// wrapper checks for it right after recording.
const STOP_COMMAND = `import os, signal, sys
record = sys.argv[1]
os.makedirs(os.path.dirname(record), mode=0o700, exist_ok=True)
open(record + ".stop", "a").close()
try:
    with open(record) as recorded:
        group = int(recorded.read(32))
except (OSError, ValueError):
    sys.exit(0)
# The record is in the sandbox, so only a group it can prove is this command's is stopped: the
# group's leader leads its own session, and its parent is the wrapper started for this record.
def stat(pid):
    with open("/proc/%d/stat" % pid, "rb") as handle:
        raw = handle.read(4096)
    return raw[raw.rindex(b")") + 2:].split()
try:
    leader = stat(group)
    ppid, pgrp, session = int(leader[1]), int(leader[2]), int(leader[3])
    with open("/proc/%d/cmdline" % ppid, "rb") as handle:
        parent = handle.read(1 << 20).split(b"\0")
except (OSError, ValueError, IndexError):
    sys.exit(0)
if group > 1 and pgrp == group and session == group and record.encode() in parent:
    try:
        os.killpg(group, signal.SIGKILL)
    except OSError:
        pass`;

// The shell both checks and enters the physical Workspace before starting the
// command. An image's login scripts and default environment are not needed.
const WORKSPACE_COMMAND = `set -eu
root=$(pwd -P)
workspace="$root/$1"
cd "$workspace"
if [ "$(pwd -P)" != "$workspace" ]; then
  printf '%s\\n' 'Workspace root was redirected' >&2
  exit 1
fi
exec /bin/sh -c "$2"`;

function relativePath(value: string, label: string, allowRoot = false): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.split("/").includes("..") ||
    /\p{Cc}/u.test(value) ||
    (!allowRoot && value === ".")
  )
    throw new Error(`${label} must be a bounded relative path without traversal`);
  return value;
}

function boundedText(value: string, label: string, maximum: number, required = false): string {
  if (typeof value !== "string" || (required && !value) || Buffer.byteLength(value) > maximum)
    throw new Error(`${label} is missing or exceeds its byte limit`);
  return value;
}

function integer(value: number | undefined, minimum: number): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum))
    throw new Error("Invalid numeric workspace operation argument");
  return value;
}

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const size = value ?? fallback;
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum)
    throw new Error("Workspace operation limit is out of range");
  return size;
}

function bridgeArguments(operation: WorkspaceOperation): Record<string, unknown> {
  const directory = (path: string | undefined) => relativePath(path ?? ".", "Directory", true);
  switch (operation.kind) {
    case "read":
      return {
        file_path: relativePath(operation.path, "File"),
        offset: integer(operation.offset, 1),
        limit: integer(operation.limit, 1),
      };
    case "write":
      return {
        file_path: relativePath(operation.path, "File"),
        content: boundedText(operation.content, "File content", MAX_TEXT_BYTES),
      };
    case "edit":
      return {
        file_path: relativePath(operation.path, "File"),
        old_string: boundedText(operation.oldText, "Old text", MAX_TEXT_BYTES, true),
        new_string: boundedText(operation.newText, "New text", MAX_TEXT_BYTES),
        replace_all: operation.replaceAll,
      };
    case "glob":
      return {
        pattern: boundedText(operation.pattern, "Glob pattern", MAX_PATTERN_BYTES, true),
        path: directory(operation.path),
      };
    case "grep":
      if (
        operation.outputMode !== undefined &&
        !["content", "files_with_matches", "count"].includes(operation.outputMode)
      )
        throw new Error("Invalid grep output mode");
      return {
        pattern: boundedText(operation.pattern, "Grep pattern", MAX_PATTERN_BYTES, true),
        path: directory(operation.path),
        glob:
          operation.glob === undefined
            ? undefined
            : boundedText(operation.glob, "Grep glob", MAX_PATTERN_BYTES, true),
        output_mode: operation.outputMode,
        offset: integer(operation.offset, 0),
        head_limit: integer(operation.headLimit, 1),
      };
    case "ls":
      return { path: directory(operation.path) };
    case "command":
      if (operation.command.includes("\0")) throw new Error("Command contains a null byte");
      return {
        command: boundedText(operation.command, "Command", MAX_COMMAND_BYTES, true),
        timeout: integer(operation.timeoutMs, 1),
      };
  }
}

function boundEdit(text: string, operation: Extract<WorkspaceOperation, { kind: "edit" }>): void {
  const bytes = Buffer.byteLength(text);
  const growth = Buffer.byteLength(operation.newText) - Buffer.byteLength(operation.oldText);
  if (bytes > MAX_EDIT_BYTES) throw new Error("Workspace edit exceeds its byte limit");
  if (growth <= 0) return;
  let remaining = MAX_EDIT_BYTES - bytes;
  let offset = 0;
  while (true) {
    const index = text.indexOf(operation.oldText, offset);
    if (index === -1) return;
    remaining -= growth;
    if (remaining < 0) throw new Error("Workspace edit exceeds its byte limit");
    if (!operation.replaceAll) return;
    offset = index + operation.oldText.length;
  }
}

function cleanProcess(
  spec: ProcessSpec,
  sandboxRoot: string,
  workspaceRoot: string,
  operation: WorkspaceOperation,
  outputBytes: number,
  command?: { readonly deadlineMs: number; readonly record: string },
): ProcessSpec {
  if (spec.stdin !== undefined && Buffer.byteLength(spec.stdin) > MAX_EDIT_BYTES)
    throw new Error("Workspace input exceeds its byte limit");
  if ((operation.kind === "command") !== (command !== undefined))
    throw new Error("Workspace command lifecycle is missing");
  return {
    ...spec,
    command: "/usr/bin/env",
    args: [
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "LANG=C.UTF-8",
      ...(spec.environment?.["LC_ALL"] === "C" ? ["LC_ALL=C"] : []),
      "python3",
      "-I",
      "-S",
      "-c",
      command ? COMMAND_PROCESS : BOUNDED_PROCESS,
      // Room for path resolution and for the SDK bridge to detect truncation.
      String(Math.max(16 * 1024, outputBytes + 1)),
      ...(command && operation.kind === "command"
        ? [
            String(command.deadlineMs),
            command.record,
            "/bin/sh",
            "-c",
            WORKSPACE_COMMAND,
            "supertag-workspace-command",
            workspaceRoot,
            operation.command,
          ]
        : [spec.command, ...(spec.args ?? [])]),
    ],
    ...(command ? { cwd: sandboxRoot, timeoutMs: command.deadlineMs + COMMAND_GRACE_MS } : {}),
    environment: {},
    replaceEnvironment: true,
  };
}

export function createWorkspaceOperations(options: WorkspaceOperationsOptions) {
  const { environment } = options;
  const workspaceRoot = relativePath(options.workspaceRoot, "Workspace root");
  const sandboxRoot = environment.rootDirectory;
  if (
    environment.placement !== "remote" ||
    !posix.isAbsolute(sandboxRoot) ||
    posix.normalize(sandboxRoot) !== sandboxRoot ||
    sandboxRoot === "/" ||
    environment.resolvePath(workspaceRoot) !== posix.join(sandboxRoot, workspaceRoot)
  )
    throw new Error("Workspace root must be inside an isolated sandbox");
  const allowed = new Set(options.allowedActions);
  const permissions = {
    filesWrite: allowed.has("files:write"),
    commandsExecute: allowed.has("commands:execute"),
  };
  const limits = {
    maxOutputBytes: limit(options.limits?.maxOutputBytes, 16 * 1024, 64 * 1024),
    maxReadBytes: limit(options.limits?.maxReadBytes, 30 * 1024, 64 * 1024),
    commandTimeoutMs: limit(options.limits?.commandTimeoutMs, 120_000, 120_000),
  };
  const lifetime = new AbortController();
  const active = new Set<Promise<SplitExecutionToolResult>>();

  return {
    async execute(
      operation: WorkspaceOperation,
      caller?: AbortSignal,
    ): Promise<SplitExecutionToolResult> {
      lifetime.signal.throwIfAborted();
      caller?.throwIfAborted();
      if (operation.kind === "command") {
        if (!permissions.filesWrite || !permissions.commandsExecute)
          throw new Error("Workspace commands require files:write and commands:execute");
      } else if (operation.kind === "write" || operation.kind === "edit") {
        if (!permissions.filesWrite) throw new Error("Workspace writes require files:write");
      } else if (!allowed.has("files:read")) {
        throw new Error("Workspace reads require files:read");
      }
      const args = bridgeArguments(operation);
      const command = operation.kind === "command";
      const signal = AbortSignal.any([
        lifetime.signal,
        // A command enforces its own deadline in the sandbox; the host waits a little longer.
        AbortSignal.timeout(limits.commandTimeoutMs + (command ? COMMAND_GRACE_MS : 0)),
        ...(caller ? [caller] : []),
      ]);
      /**
       * Starts a command with no signal: stopping a process through the provider stops it, and on
       * Modal the whole sandbox. A cancel instead stops the command's group with a fresh process
       * in the sandbox, and the wrapper's deadline stops it otherwise. Only the provider-level
       * timeout, well after that deadline, may still stop it through the provider.
       */
      async function spawnCommand(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessHandle> {
        signal?.throwIfAborted();
        const deadlineMs = Math.min(
          spec.timeoutMs ?? limits.commandTimeoutMs,
          limits.commandTimeoutMs,
        );
        const record = posix.join(sandboxRoot, "commands", randomUUID());
        const process = await environment.spawn(
          cleanProcess(spec, sandboxRoot, workspaceRoot, operation, limits.maxOutputBytes, {
            deadlineMs,
            record,
          }),
        );
        let settled = false;
        let stopping: Promise<void> | undefined;
        const stop = () =>
          (stopping ??= (async () => {
            if (settled) return;
            // No signal and no provider timeout: the stopper ends on its own, and nothing may
            // stop it, or the sandbox with it, through the provider.
            const killer = await environment.spawn({
              command: "/usr/bin/env",
              args: [
                "-i",
                "PATH=/usr/local/bin:/usr/bin:/bin",
                "python3",
                "-I",
                "-S",
                "-c",
                STOP_COMMAND,
                record,
              ],
              cwd: sandboxRoot,
              environment: {},
              replaceEnvironment: true,
            });
            await killer.wait();
          })().catch(() => undefined));
        // Every RPC's signal aborts when the call ends, so the listener goes with the command.
        const abort = () => void stop();
        signal?.addEventListener("abort", abort, { once: true });
        const waiting = process.wait().finally(() => {
          settled = true;
          signal?.removeEventListener("abort", abort);
        });
        void waiting.catch(() => undefined);
        return {
          ...(process.pid === undefined ? {} : { pid: process.pid }),
          wait: () => waiting,
          kill: () => void stop(),
        };
      }
      const bridge = createWorkspaceToolBridge({
        environment: {
          rootDirectory: sandboxRoot,
          resolvePath: (path) => environment.resolvePath(path),
          async read(path) {
            signal.throwIfAborted();
            const text = await environment.read(path);
            signal.throwIfAborted();
            if (operation.kind === "edit") boundEdit(text, operation);
            return text;
          },
          spawn: (spec, signal) =>
            command
              ? spawnCommand(spec, signal)
              : environment.spawn(
                  cleanProcess(spec, sandboxRoot, workspaceRoot, operation, limits.maxOutputBytes),
                  signal,
                ),
        },
        workspaceRoot,
        ...(options.readOnlyRoots ? { readOnlyRoots: options.readOnlyRoots } : {}),
        ...(options.fileScope ? { fileScope: options.fileScope } : {}),
        permissions,
        limits,
      });
      const pending = (async () => {
        try {
          const result = await bridge.call(operation.kind, args, signal);
          signal.throwIfAborted();
          return result;
        } finally {
          await bridge.dispose();
        }
      })();
      active.add(pending);
      try {
        return await pending;
      } finally {
        active.delete(pending);
      }
    },
    async dispose(): Promise<void> {
      lifetime.abort(new Error("Workspace operations are closed"));
      await Promise.allSettled(active);
    },
  };
}
