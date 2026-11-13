import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ExecutionEnvironment, ProcessHandle } from "../index.js";
import { type InputFile, inputManifest, inputRoot } from "./input-files.js";
import { createWorkspaceOperations, type WorkspaceOperation } from "./operations.js";

export const MAX_TRANSFER = 256 * 1024 * 1024;
const API_TIMEOUT_MS = 15_000;
const ALLOCATE_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 120_000;

export interface SandboxOwner {
  readonly hostId: string;
  readonly hostGeneration: bigint;
  readonly taskId: string;
  readonly attemptId: string;
  readonly allocationId: string;
}

export type SandboxStopResult =
  | { readonly state: "stopped"; readonly sandboxId: string }
  | { readonly state: "uncertain" };

export interface SandboxWorkspace {
  readonly sandboxId: string;
  environment(root: string): ExecutionEnvironment;
  run(
    argv: string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{
    readonly exitCode: number | null;
    readonly stdout: string;
  }>;
  writeTransfer(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  readTransfer(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

export interface SandboxWorkspaceProvider {
  readonly label: string;
  validateOwner(owner: SandboxOwner): void;
  allocate(owner: SandboxOwner, timeoutMs: number, signal: AbortSignal): Promise<SandboxWorkspace>;
  stop(owner: SandboxOwner, sandboxId?: string): Promise<SandboxStopResult>;
}

function cleanCommand(...args: string[]): string[] {
  return ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", ...args];
}

interface StageHeader {
  readonly startCommit: string;
  readonly bundle: { readonly sha256: string; readonly byteLength: bigint };
  readonly inputFiles?: readonly InputFile[];
  /** The trusted commit Workspace stdio MCP servers run from, beside the checkout. */
  readonly mcpCommit?: string;
}

export interface McpServerStart {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

const MCP_PATH = "/usr/local/bin:/usr/bin:/bin";

function validMcpStart({ name, command, args }: McpServerStart): boolean {
  const text = (value: string, maximum: number) =>
    value.length > 0 && value.length <= maximum && !/\p{Cc}/u.test(value);
  return (
    /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(name) &&
    text(command, 4096) &&
    command.trim() === command &&
    args.length <= 64 &&
    args.every((arg) => arg.length <= 4096 && !/\p{Cc}/u.test(arg))
  );
}

interface CapturedTree {
  readonly tree: { readonly sha256: string; readonly byteLength: bigint };
  readonly bytes: Uint8Array;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactOwner(left: SandboxOwner, right: SandboxOwner): boolean {
  return (
    left.hostId === right.hostId &&
    left.hostGeneration === right.hostGeneration &&
    left.taskId === right.taskId &&
    left.attemptId === right.attemptId &&
    left.allocationId === right.allocationId
  );
}

async function readTransfer(
  sandbox: SandboxWorkspace,
  path: string,
  byteLength: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const stream = await sandbox.readTransfer(path, signal);
  const reader = stream.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const bytes = new Uint8Array(byteLength);
  try {
    let offset = 0;
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > byteLength - offset)
        throw new Error("Workspace tree exceeds its receipt");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    signal.throwIfAborted();
    if (offset !== byteLength) throw new Error("Workspace tree is shorter than its receipt");
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function observedEnvironment(
  environment: ExecutionEnvironment,
  markUncertain: () => void,
  label: string,
): ExecutionEnvironment {
  const observe = async <T>(operation: () => Promise<T>, mutation = false): Promise<T> => {
    try {
      return await operation();
    } catch {
      if (mutation) markUncertain();
      throw new Error(`${label} Workspace file operation did not settle`);
    }
  };
  return {
    id: environment.id,
    placement: environment.placement,
    rootDirectory: environment.rootDirectory,
    prepare: (plan) => environment.prepare(plan),
    dispose: (reason) => environment.dispose(reason),
    resolvePath: (path) => environment.resolvePath(path),
    read: (path) => observe(() => environment.read(path)),
    async spawn(spec, signal) {
      // The file bridge supplies stdin only to its fixed write process.
      const mutation = spec.stdin !== undefined;
      const process = await observe(() => environment.spawn(spec, signal), mutation);
      return {
        ...process,
        wait: () =>
          observe(async () => {
            const result = await process.wait();
            // An interrupted wrapper can leave its child running.
            if (mutation && result.exitCode !== 0) markUncertain();
            return result;
          }, mutation),
      };
    },
  };
}

/** One private helper owns at most one allocation. A fresh helper may recover Stop alone. */
export function createSandboxWorkspaceSession(provider: SandboxWorkspaceProvider) {
  const workspaceError = (message: string) => new Error(`${provider.label} Workspace ${message}`);
  const lifetime = new AbortController();
  let toolTail = Promise.resolve();
  let phase:
    | "new"
    | "allocating"
    | "allocated"
    | "staging"
    | "staged"
    | "capturing"
    | "captured"
    | "closed" = "new";
  let owner: SandboxOwner | undefined;
  let sandbox: SandboxWorkspace | undefined;
  let sandboxId: string | undefined;
  let root: string | undefined;
  let allowedActions: readonly string[] = [];
  let stagedInputRoot = "";
  let tools: ReturnType<typeof createWorkspaceOperations> | undefined;
  let captured: CapturedTree | undefined;
  let mcpStaged = false;
  const mcpServers = new Set<ProcessHandle>();
  let uncertain = false;
  let allocationStarted = false;
  let hostRecordedSandbox = false;
  let stoppedSandboxId: string | undefined;

  function signalFor(caller?: AbortSignal, timeout = TRANSFER_TIMEOUT_MS): AbortSignal {
    return AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(timeout),
      ...(caller ? [caller] : []),
    ]);
  }

  async function runTransfer(mode: "stage" | "capture", args: string[], signal: AbortSignal) {
    if (!sandbox || !root) throw workspaceError("allocation is unavailable");
    return sandbox.run(
      cleanCommand("python3", "-I", "-S", "-c", TREE_PROGRAM, mode, root, ...args),
      TRANSFER_TIMEOUT_MS,
      signal,
    );
  }

  /** Workspace MCP servers end before capture or Stop, so none can change the tree after. */
  async function stopMcpServers(): Promise<void> {
    const running = [...mcpServers];
    mcpServers.clear();
    await Promise.all(
      running.map(async (server) => {
        server.kill("SIGKILL");
        await server.wait().catch(() => undefined);
      }),
    );
  }

  async function stop(request: { owner: SandboxOwner; sandboxId?: string }) {
    provider.validateOwner(request.owner);
    if (owner && !exactOwner(owner, request.owner)) throw workspaceError("owner differs");
    const knownId = sandboxId ?? stoppedSandboxId;
    if (allocationStarted && !knownId && request.sandboxId !== undefined)
      throw workspaceError("allocation identity is unverified");
    if (knownId && request.sandboxId !== undefined && request.sandboxId !== knownId)
      throw workspaceError("sandbox differs");
    if (stoppedSandboxId) return { state: "stopped" as const, sandboxId: stoppedSandboxId };
    // Closing authority prevents any new tool admissions while provider Stop runs.
    phase = "closed";
    captured = undefined;
    owner ??= { ...request.owner };
    lifetime.abort();
    await stopMcpServers();
    const result = await provider.stop(owner, knownId ?? request.sandboxId);
    if (result.state === "stopped") stoppedSandboxId = result.sandboxId;
    return result;
  }

  return {
    async allocate(
      request: { owner: SandboxOwner; timeoutMs: number; allowedActions: readonly string[] },
      caller?: AbortSignal,
    ): Promise<{ sandboxId: string }> {
      if (phase !== "new") throw workspaceError("allocation already attempted");
      provider.validateOwner(request.owner);
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
        throw workspaceError("sandbox lifetime is invalid");
      if (request.allowedActions.includes("commands:execute"))
        throw workspaceError("does not support commands:execute");
      const signal = signalFor(caller, ALLOCATE_TIMEOUT_MS);
      signal.throwIfAborted();
      phase = "allocating";
      allocationStarted = true;
      owner = { ...request.owner };
      allowedActions = [...request.allowedActions];
      try {
        sandbox = await provider.allocate(owner, request.timeoutMs, signal);
        signal.throwIfAborted();
        sandboxId = sandbox.sandboxId;
        if (!sandboxId || sandboxId.length > 256 || /\p{Cc}/u.test(sandboxId))
          throw new Error("Invalid sandbox identity");
        root = `/tmp/supertag-workspace-${randomUUID()}`;
        phase = "allocated";
        return { sandboxId };
      } catch {
        throw workspaceError("allocation could not be verified");
      }
    },
    async stage(
      header: StageHeader,
      bytes: Uint8Array,
      caller?: AbortSignal,
      inputs: Uint8Array = new Uint8Array(),
    ): Promise<void> {
      if (phase !== "allocated" || !sandbox || !root)
        throw workspaceError("must be allocated before staging");
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(header.startCommit))
        throw workspaceError("start commit is invalid");
      if (
        header.mcpCommit !== undefined &&
        (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(header.mcpCommit) ||
          header.mcpCommit.length !== header.startCommit.length)
      )
        throw workspaceError("trusted MCP commit is invalid");
      if (
        bytes.byteLength < 1 ||
        bytes.byteLength > MAX_TRANSFER ||
        BigInt(bytes.byteLength) !== header.bundle.byteLength ||
        !/^[0-9a-f]{64}$/u.test(header.bundle.sha256) ||
        digest(bytes) !== header.bundle.sha256
      )
        throw workspaceError("bundle length or digest differs from its receipt");
      const files = header.inputFiles ?? [];
      if (
        inputManifest(files) !== inputs.byteLength ||
        bytes.byteLength + inputs.byteLength > MAX_TRANSFER ||
        (files.length > 0 && (!owner || !allowedActions.includes("files:read")))
      )
        throw workspaceError("input manifest does not match the transfer");
      const expectedRoot = files.length && owner ? inputRoot(owner.attemptId) : "";
      let offset = 0;
      for (const file of files) {
        const end = offset + Number(file.blob?.byteLength);
        if (
          !file.path.startsWith(`${expectedRoot}/`) ||
          digest(inputs.subarray(offset, end)) !== file.blob?.sha256
        )
          throw workspaceError("input bytes or destination differ from the receipt");
        offset = end;
      }
      const signal = signalFor(caller);
      signal.throwIfAborted();
      phase = "staging";
      // The Host journals the verified ID before it begins Stage.
      hostRecordedSandbox = true;
      try {
        const prepared = await sandbox.run(
          cleanCommand(
            "/bin/sh",
            "-c",
            'mkdir -m 700 -- "$1" && cd "$1" && pwd -P',
            "prepare-workspace",
            root,
          ),
          API_TIMEOUT_MS,
          signal,
        );
        const physicalRoot = prepared.stdout.trim();
        if (
          prepared.exitCode !== 0 ||
          !posix.isAbsolute(physicalRoot) ||
          posix.normalize(physicalRoot) !== physicalRoot ||
          /\p{Cc}/u.test(physicalRoot) ||
          posix.basename(physicalRoot) !== posix.basename(root)
        )
          throw new Error("Private sandbox root could not be created");
        root = physicalRoot;
        await sandbox.writeTransfer(`${root}/source.bundle`, bytes, signal);
        if (files.length > 0) {
          const manifest = Buffer.from(
            JSON.stringify(
              files.map(({ path, blob }) => ({
                path,
                sha256: blob?.sha256,
                size: Number(blob?.byteLength),
              })),
            ),
          );
          await sandbox.writeTransfer(`${root}/input-manifest.json`, manifest, signal);
          await sandbox.writeTransfer(`${root}/input-files.bin`, inputs, signal);
        }
        const result = await runTransfer(
          "stage",
          [
            header.startCommit,
            header.bundle.sha256,
            bytes.byteLength.toString(),
            expectedRoot,
            header.mcpCommit ?? "",
          ],
          signal,
        );
        if (result.exitCode !== 0 || result.stdout.trim() !== "staged")
          throw new Error("Pinned bundle could not be materialized");
        signal.throwIfAborted();
        stagedInputRoot = expectedRoot;
        mcpStaged = header.mcpCommit !== undefined;
        const environment = sandbox.environment(root);
        tools = createWorkspaceOperations({
          environment: observedEnvironment(
            environment,
            () => {
              uncertain = true;
            },
            provider.label,
          ),
          workspaceRoot: "checkout",
          readOnlyRoots: stagedInputRoot ? [`checkout/${stagedInputRoot}`] : [],
          allowedActions,
        });
        phase = "staged";
      } catch {
        throw workspaceError("bundle could not be staged");
      }
    },
    async execute(operation: WorkspaceOperation, caller?: AbortSignal) {
      if (phase !== "staged" || !tools) throw workspaceError("tools are not staged or were sealed");
      if (
        "path" in operation &&
        operation.path?.split("/").some((part) => part.toLowerCase() === ".git")
      )
        throw workspaceError("tools cannot access Git metadata");
      const workspace = tools;
      const signal = signalFor(caller);
      const pending = toolTail.then(() => {
        if (uncertain) throw workspaceError("mutation did not settle");
        return workspace.execute(operation, signal);
      });
      // Serialize the file lane so parallel edits cannot read the same old bytes
      // and overwrite one another. The individual caller still sees its error.
      toolTail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
    /**
     * Starts one Workspace stdio MCP server in the trusted copy beside the checkout, with only a
     * fixed PATH and LANG: no Worker Host variable and no variable a Harness plan set.
     */
    async startMcpServer(start: McpServerStart, caller?: AbortSignal): Promise<ProcessHandle> {
      if (phase !== "staged" || !sandbox || !root)
        throw workspaceError("must be staged before an MCP server starts");
      if (!mcpStaged) throw workspaceError("has no trusted MCP copy");
      if (!validMcpStart(start)) throw workspaceError("MCP server launch is invalid");
      const signal = caller ? AbortSignal.any([lifetime.signal, caller]) : lifetime.signal;
      signal.throwIfAborted();
      const server = await sandbox.environment(root).spawn(
        {
          command: "/usr/bin/env",
          args: ["-i", `PATH=${MCP_PATH}`, "LANG=C.UTF-8", start.command, ...start.args],
          cwd: "mcp",
          environment: {},
          replaceEnvironment: true,
          streamInput: true,
          streamOutput: true,
        },
        signal,
      );
      if (!server.write || !server.endInput || !server.output) {
        server.kill("SIGKILL");
        throw workspaceError("cannot stream MCP server input and output");
      }
      if (phase !== "staged") {
        server.kill("SIGKILL");
        throw workspaceError("tools were sealed");
      }
      mcpServers.add(server);
      void server.wait().then(
        () => mcpServers.delete(server),
        () => mcpServers.delete(server),
      );
      return server;
    },
    async capture(caller?: AbortSignal): Promise<CapturedTree> {
      caller?.throwIfAborted();
      if (phase === "captured" && captured) return captured;
      if (phase !== "staged" || !sandbox || !root || !tools)
        throw workspaceError("must be staged before capture");
      phase = "capturing";
      const signal = signalFor(caller);
      try {
        // Close admissions first. Allow active file processes to settle naturally.
        // Abort/transport uncertainty while a tool ran permanently prevents capture.
        await toolTail;
        await stopMcpServers();
        await tools.dispose();
        if (uncertain) throw workspaceError("was modified by an unsettled operation");
        signal.throwIfAborted();
        const result = await runTransfer("capture", [stagedInputRoot], signal);
        const receipt = /^([1-9][0-9]{0,8}) ([0-9a-f]{64})$/u.exec(result.stdout.trim());
        if (result.exitCode !== 0 || !receipt?.[1] || !receipt[2])
          throw workspaceError("capture did not produce a receipt");
        const byteLength = Number(receipt[1]);
        if (byteLength < 13 || byteLength > MAX_TRANSFER)
          throw workspaceError("tree is out of range");
        const bytes = await readTransfer(sandbox, `${root}/return.tree`, byteLength, signal);
        if (digest(bytes) !== receipt[2])
          throw workspaceError("tree digest differs from its receipt");
        signal.throwIfAborted();
        captured = { tree: { sha256: receipt[2], byteLength: BigInt(byteLength) }, bytes };
        phase = "captured";
        return captured;
      } catch {
        throw workspaceError("tree could not be captured");
      }
    },
    stop,
    async close(): Promise<void> {
      // Before Stage, discovery may be the only evidence for the Host's
      // unacknowledged allocation. Keep it available for durable recovery.
      if (owner && hostRecordedSandbox) await stop({ owner });
      else {
        phase = "closed";
        lifetime.abort();
      }
    },
  };
}

export type SandboxWorkspaceSession = ReturnType<typeof createSandboxWorkspaceSession>;

// Run only trusted transfer code in the sandbox. Git objects are materialized
// directly so workspace .gitattributes, hooks and local Git config cannot run
// filters or change the accepted bytes. The repository stays outside checkout.
const TREE_PROGRAM = String.raw`import contextlib, hashlib, json, os, stat, struct, subprocess, sys

MAX_TREE = 256 * 1024 * 1024
MAX_MANIFEST = 16 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_ENTRIES = 100000
MAX_LINK = 4096
CHUNK = 65536
MODES = ("100644", "100755", "120000")
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
os.umask(0o077)
mode, root = sys.argv[1:3]
checkout = os.path.join(root, "checkout")

def check(condition):
    if not condition:
        raise ValueError("invalid Workspace transfer")

def components(path):
    raw = path.encode("utf-8")
    parts = path.split("/")
    check(0 < len(raw) <= 4096 and b"\0" not in raw and b"\\" not in raw)
    check(len(parts) <= 129)
    check(all(part not in ("", ".", "..") and part.lower() != ".git" for part in parts))
    return parts

def validate_link(path, body):
    check(0 < len(body) <= MAX_LINK)
    target = body.decode("utf-8")
    check(not target.startswith("/") and "\\" not in target and "\0" not in target)
    depth = len(components(path)) - 1
    for part in target.split("/"):
        if part == "..":
            check(depth > 0)
            depth -= 1
        elif part not in ("", "."):
            check(part.lower() != ".git")
            depth += 1
    return target

def file_hash(path):
    digest = hashlib.sha256()
    length = 0
    with open(path, "rb") as file:
        while data := file.read(CHUNK):
            length += len(data)
            check(length <= MAX_TREE)
            digest.update(data)
    return length, digest.hexdigest()

def git_command(args, bound=0):
    with subprocess.Popen(git + args,
                          stdout=subprocess.PIPE if bound else subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL) as process:
        try:
            result = process.stdout.read(bound + 1) if bound else b""
            check(len(result) <= bound)
            check(process.wait() == 0)
            return result
        finally:
            if process.poll() is None:
                process.kill()

def materialize(commit, destination):
    raw_tree = git_command(["ls-tree", "-rz", "--full-tree", commit], MAX_MANIFEST)
    entries = raw_tree.split(b"\0")
    check(entries.pop() == b"" and len(entries) <= MAX_ENTRIES)
    os.mkdir(destination)
    with subprocess.Popen(git + ["cat-file", "--batch"],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL) as objects:
        total = 0
        try:
            for entry in entries:
                metadata, raw_path = entry.split(b"\t", 1)
                file_mode, kind, oid = metadata.decode("ascii").split(" ")
                check(file_mode in MODES and kind == "blob")
                path = raw_path.decode("utf-8")
                target = os.path.join(destination, *components(path))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                objects.stdin.write(oid.encode("ascii") + b"\n")
                objects.stdin.flush()
                actual_oid, kind, raw_size = objects.stdout.readline(128).split()
                check(actual_oid == oid.encode("ascii") and kind == b"blob")
                size = int(raw_size)
                total += size
                check(0 <= size <= MAX_FILE and total <= MAX_TREE)
                if file_mode == "120000":
                    check(size <= MAX_LINK)
                    body = objects.stdout.read(size)
                    check(len(body) == size)
                    os.symlink(validate_link(path, body), target)
                else:
                    with open(target, "xb") as file:
                        remaining = size
                        while remaining:
                            data = objects.stdout.read(min(CHUNK, remaining))
                            check(bool(data))
                            file.write(data)
                            remaining -= len(data)
                        os.fchmod(file.fileno(), 0o755 if file_mode == "100755" else 0o644)
                check(objects.stdout.read(1) == b"\n")
            objects.stdin.close()
            check(objects.wait() == 0)
        finally:
            if objects.poll() is None:
                objects.kill()

def stage(commit, expected_hash, expected_length, input_root, mcp_commit=""):
    bundle = os.path.join(root, "source.bundle")
    check(file_hash(bundle) == (int(expected_length), expected_hash))
    object_format = "sha1" if len(commit) == 40 else "sha256"
    git_command(["init", "--bare", "--template=", "--object-format=" + object_format])
    heads = git_command(["bundle", "list-heads", bundle], 4096).splitlines()
    check(len(heads) == 1)
    fields = heads[0].split()
    check(len(fields) == 2 and fields[0] == commit.encode("ascii") and
          fields[1].startswith(b"refs/heads/supertag-deliveries/"))
    git_command(["bundle", "verify", bundle])
    git_command(["bundle", "unbundle", bundle])
    check(git_command(["cat-file", "-t", commit], 64) == b"commit\n")
    materialize(commit, checkout)
    if mcp_commit:
        # Workspace stdio MCP servers run from the trusted commit, outside the checkout.
        check(len(mcp_commit) == len(commit))
        check(git_command(["cat-file", "-t", mcp_commit], 64) == b"commit\n")
        git_command(["merge-base", "--is-ancestor", mcp_commit, commit])
        materialize(mcp_commit, os.path.join(root, "mcp"))
    os.unlink(bundle)
    if input_root:
        stage_inputs(input_root)
    print("staged")

@contextlib.contextmanager
def open_dir(root_fd, parts):
    with contextlib.ExitStack() as opened:
        fd = root_fd
        for part in parts:
            fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            opened.callback(os.close, fd)
        yield fd

def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def stage_inputs(input_root):
    parent, attempt = components(input_root)
    check(parent == "inputs" and len(attempt) == 64 and all(c in "0123456789abcdef" for c in attempt))
    manifest_path = os.path.join(root, "input-manifest.json")
    body_path = os.path.join(root, "input-files.bin")
    with open(manifest_path, "rb") as source:
        raw = source.read(128 * 1024 + 1)
        check(len(raw) <= 128 * 1024)
        files = json.loads(raw)
    check(0 < len(files) <= 100)
    with contextlib.ExitStack() as opened:
        checkout_fd = os.open(checkout, DIR_FLAGS)
        opened.callback(os.close, checkout_fd)
        try:
            os.mkdir(parent, dir_fd=checkout_fd)
        except FileExistsError:
            pass
        root_parent = opened.enter_context(open_dir(checkout_fd, (parent,)))
        os.mkdir(attempt, dir_fd=root_parent)
        input_fd = opened.enter_context(open_dir(root_parent, (attempt,)))
        body = opened.enter_context(open(body_path, "rb"))
        total = 0
        for entry in files:
            parts = components(entry["path"])
            check(tuple(parts[:2]) == (parent, attempt) and len(parts) >= 4)
            check(parts[2].startswith("artifact-") and len(parts[2]) == 73)
            check(all(c in "0123456789abcdef" for c in parts[2][9:]))
            check(all(part.lower() != ".supertag" for part in parts))
            remaining = entry["size"]
            check(type(remaining) is int and 0 <= remaining <= 32 * 1024 * 1024)
            total += remaining
            check(total <= 64 * 1024 * 1024)
            with contextlib.ExitStack() as dirs:
                destination = input_fd
                for part in parts[2:-1]:
                    try:
                        os.mkdir(part, dir_fd=destination)
                    except FileExistsError:
                        pass
                    destination = dirs.enter_context(open_dir(destination, (part,)))
                flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
                fd = os.open(parts[-1], flags, 0o400, dir_fd=destination)
                digest = hashlib.sha256()
                with os.fdopen(fd, "wb") as file:
                    while remaining:
                        data = body.read(min(CHUNK, remaining))
                        check(bool(data))
                        file.write(data)
                        digest.update(data)
                        remaining -= len(data)
                    check(digest.hexdigest() == entry["sha256"])
        check(not body.read(1))
    os.unlink(manifest_path)
    os.unlink(body_path)

def capture(input_root):
    entries = []
    directories = []
    body_length = 0
    manifest_length = 0
    root_fd = os.open(checkout, DIR_FLAGS)

    def collect(directory_fd, prefix):
        nonlocal body_length, manifest_length
        directories.append((prefix, fingerprint(os.fstat(directory_fd))))
        check(len(directories) <= MAX_ENTRIES)
        with os.scandir(directory_fd) as children:
            for child in children:
                path = "/".join((*prefix, child.name))
                if input_root and path == input_root:
                    continue
                parts = components(path)
                info = child.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    with open_dir(directory_fd, (child.name,)) as child_fd:
                        check(fingerprint(os.fstat(child_fd)) == fingerprint(info))
                        collect(child_fd, tuple(parts))
                    continue
                if stat.S_ISLNK(info.st_mode):
                    body = os.readlink(child.name, dir_fd=directory_fd).encode("utf-8")
                    validate_link(path, body)
                    size, file_mode = len(body), "120000"
                else:
                    check(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                    size = info.st_size
                    file_mode = "100755" if info.st_mode & 0o111 else "100644"
                check(0 <= size <= MAX_FILE)
                body_length += size
                entry = {"path": path, "mode": file_mode, "size": size}
                manifest_length += len(json.dumps(entry, ensure_ascii=False,
                                                  separators=(",", ":")).encode("utf-8")) + 1
                check(body_length <= MAX_TREE and manifest_length <= MAX_MANIFEST and
                      len(entries) < MAX_ENTRIES)
                entries.append((entry, fingerprint(info)))

    try:
        collect(root_fd, ())
        entries.sort(key=lambda item: item[0]["path"].encode("utf-8"))
        manifest = json.dumps({"entries": [entry for entry, _ in entries]},
                              ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        check(len(manifest) <= MAX_MANIFEST and 13 + len(manifest) + body_length <= MAX_TREE)
        destination = os.path.join(root, "return.tree")
        with open(destination, "xb") as tree:
            tree.write(b"STWTREE1\n" + struct.pack(">I", len(manifest)) + manifest)
            for entry, expected in entries:
                *parents, name = components(entry["path"])
                with open_dir(root_fd, parents) as directory_fd:
                    before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    check(fingerprint(before) == expected)
                    if entry["mode"] == "120000":
                        body = os.readlink(name, dir_fd=directory_fd).encode("utf-8")
                        check(len(body) == entry["size"])
                        validate_link(entry["path"], body)
                        tree.write(body)
                    else:
                        with os.fdopen(os.open(name, FILE_FLAGS, dir_fd=directory_fd), "rb") as file:
                            check(fingerprint(os.fstat(file.fileno())) == expected)
                            remaining = entry["size"]
                            while remaining:
                                data = file.read(min(CHUNK, remaining))
                                check(bool(data))
                                tree.write(data)
                                remaining -= len(data)
                            check(not file.read(1) and fingerprint(os.fstat(file.fileno())) == expected)
                    after = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    check(fingerprint(after) == expected)
            for parts, expected in directories:
                with open_dir(root_fd, parts) as directory_fd:
                    check(fingerprint(os.fstat(directory_fd)) == expected)
    finally:
        os.close(root_fd)
    length, digest = file_hash(destination)
    print(length, digest)

git = ["git", "--git-dir=" + os.path.join(root, "objects.git")]
for setting in ("core.hooksPath=/dev/null", "core.fsmonitor=false",
                "core.attributesFile=/dev/null", "protocol.allow=never"):
    git.extend(("-c", setting))
os.environ.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
                  GIT_ATTR_NOSYSTEM="1", GIT_NO_REPLACE_OBJECTS="1",
                  GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")

try:
    if mode == "stage":
        stage(*sys.argv[3:])
    elif mode == "capture":
        capture(*sys.argv[3:])
    else:
        raise ValueError("unknown transfer")
except Exception:
    sys.exit(1)`;
