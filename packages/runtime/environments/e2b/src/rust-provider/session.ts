import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { type ExecutionEnvironment, sandboxExecutionEnvironment } from "@supertag/worker-sdk";
import { Sandbox, type SandboxOpts } from "e2b";
import { E2BExecutionEnvironmentProvider } from "../index.js";
import { adaptE2B, type E2BSandboxClient, shellQuote } from "../sandbox.js";
import { createWorkspaceOperations, type WorkspaceOperation } from "./operations.js";
import {
  e2bSandboxInventory,
  type SandboxInventory,
  type SandboxOwner,
  sandboxOwnershipMetadata,
  stopOwnedSandbox,
} from "./ownership.js";

const MAX_TRANSFER = 256 * 1024 * 1024;
const MAX_LIFETIME_MS = 3_600_000;
const API_TIMEOUT_MS = 15_000;
const ALLOCATE_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 120_000;

export interface E2BWorkspaceSandbox {
  readonly client: E2BSandboxClient;
  writeTransfer(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  readTransfer(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

interface E2BWorkspaceSessionOptions {
  readonly template?: string;
  readonly factory?: { create(options: SandboxOpts): Promise<E2BWorkspaceSandbox> };
  readonly inventory?: SandboxInventory;
}

interface StageHeader {
  readonly startCommit: string;
  readonly bundle: { readonly sha256: string; readonly byteLength: bigint };
}

interface CapturedTree {
  readonly tree: { readonly sha256: string; readonly byteLength: bigint };
  readonly bytes: Uint8Array;
}

const nativeFactory = {
  async create(options: SandboxOpts): Promise<E2BWorkspaceSandbox> {
    const client = await Sandbox.create(options);
    return {
      client,
      async writeTransfer(path, bytes, signal) {
        // Use an exact view of the trusted Host buffer. The SDK accepts an upload stream.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
        await client.files.write(path, stream, { signal, requestTimeoutMs: TRANSFER_TIMEOUT_MS });
      },
      readTransfer(path, signal) {
        return client.files.read(path, {
          format: "stream",
          signal,
          requestTimeoutMs: API_TIMEOUT_MS,
          streamIdleTimeoutMs: API_TIMEOUT_MS,
        });
      },
    };
  },
};

function cleanCommand(...args: string[]): string {
  return ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", ...args]
    .map(shellQuote)
    .join(" ");
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
  sandbox: E2BWorkspaceSandbox,
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
      if (value.byteLength > byteLength - offset) throw new Error("E2B tree exceeds its receipt");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    signal.throwIfAborted();
    if (offset !== byteLength) throw new Error("E2B tree is shorter than its receipt");
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
): ExecutionEnvironment {
  const observe = async <T>(operation: () => Promise<T>, mutation = false): Promise<T> => {
    try {
      return await operation();
    } catch {
      if (mutation) markUncertain();
      throw new Error("E2B Workspace file operation did not settle");
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
            // E2B can report the wrapper's exit without stopping its child.
            if (mutation && result.exitCode !== 0) markUncertain();
            return result;
          }, mutation),
      };
    },
  };
}

/** One private helper owns at most one allocation. A fresh helper may recover Stop alone. */
export function createE2BWorkspaceSession(options: E2BWorkspaceSessionOptions = {}) {
  const template = options.template ?? process.env["SUPERTAG_E2B_TEMPLATE"] ?? "base";
  if (!template.trim() || template.length > 256 || /\p{Cc}/u.test(template))
    throw new Error("Invalid E2B Workspace template");
  const factory = options.factory ?? nativeFactory;
  const inventory = options.inventory ?? e2bSandboxInventory({ requestTimeoutMs: API_TIMEOUT_MS });
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
  let sandbox: E2BWorkspaceSandbox | undefined;
  let sandboxId: string | undefined;
  let root: string | undefined;
  let allowedActions: readonly string[] = [];
  let tools: ReturnType<typeof createWorkspaceOperations> | undefined;
  let captured: CapturedTree | undefined;
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
    if (!sandbox || !root) throw new Error("E2B Workspace allocation is unavailable");
    return sandbox.client.commands.run(
      cleanCommand("python3", "-I", "-S", "-c", TREE_PROGRAM, mode, root, ...args),
      { cwd: "/tmp", timeoutMs: TRANSFER_TIMEOUT_MS, signal },
    );
  }

  async function stop(request: { owner: SandboxOwner; sandboxId?: string }) {
    sandboxOwnershipMetadata(request.owner);
    if (owner && !exactOwner(owner, request.owner)) throw new Error("E2B Workspace owner differs");
    const knownId = sandboxId ?? stoppedSandboxId;
    if (allocationStarted && !knownId && request.sandboxId !== undefined)
      throw new Error("E2B Workspace allocation identity is unverified");
    if (knownId && request.sandboxId !== undefined && request.sandboxId !== knownId)
      throw new Error("E2B Workspace sandbox differs");
    if (stoppedSandboxId) return { state: "stopped" as const, sandboxId: stoppedSandboxId };
    // Closing authority prevents any new tool admissions while provider Stop runs.
    phase = "closed";
    captured = undefined;
    owner ??= { ...request.owner };
    lifetime.abort();
    const result = await stopOwnedSandbox(inventory, owner, knownId ?? request.sandboxId);
    if (result.state === "stopped") stoppedSandboxId = result.sandboxId;
    return result;
  }

  return {
    async allocate(
      request: { owner: SandboxOwner; timeoutMs: number; allowedActions: readonly string[] },
      caller?: AbortSignal,
    ): Promise<{ sandboxId: string }> {
      if (phase !== "new") throw new Error("E2B Workspace allocation already attempted");
      const metadata = sandboxOwnershipMetadata(request.owner);
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
        throw new Error("Invalid E2B Workspace sandbox lifetime");
      if (request.allowedActions.includes("commands:execute"))
        throw new Error("E2B Workspace does not support commands:execute");
      const signal = signalFor(caller, ALLOCATE_TIMEOUT_MS);
      signal.throwIfAborted();
      phase = "allocating";
      allocationStarted = true;
      owner = { ...request.owner };
      allowedActions = [...request.allowedActions];
      try {
        sandbox = await factory.create({
          template,
          metadata: { ...metadata },
          timeoutMs: Math.min(request.timeoutMs, MAX_LIFETIME_MS),
          requestTimeoutMs: 30_000,
          allowInternetAccess: false,
          secure: true,
          lifecycle: { onTimeout: "kill", autoResume: false },
          signal,
        });
        signal.throwIfAborted();
        const createdId = sandbox.client.sandboxId;
        if (!createdId || createdId.length > 256 || /\p{Cc}/u.test(createdId))
          throw new Error("Invalid sandbox identity");
        const identity = await inventory.get(createdId);
        if (
          identity?.sandboxId !== createdId ||
          !Object.entries(metadata).every(([key, value]) => identity.metadata[key] === value)
        )
          throw new Error("Unexpected sandbox ownership");
        signal.throwIfAborted();
        sandboxId = createdId;
        root = `/tmp/supertag-workspace-${randomUUID()}`;
        phase = "allocated";
        return { sandboxId };
      } catch {
        throw new Error("E2B Workspace allocation could not be verified");
      }
    },
    async stage(header: StageHeader, bytes: Uint8Array, caller?: AbortSignal): Promise<void> {
      if (phase !== "allocated" || !sandbox || !root)
        throw new Error("E2B Workspace must be allocated before staging");
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(header.startCommit))
        throw new Error("Invalid E2B Workspace start commit");
      if (
        bytes.byteLength < 1 ||
        bytes.byteLength > MAX_TRANSFER ||
        BigInt(bytes.byteLength) !== header.bundle.byteLength ||
        !/^[0-9a-f]{64}$/u.test(header.bundle.sha256) ||
        digest(bytes) !== header.bundle.sha256
      )
        throw new Error("E2B Workspace bundle length or digest differs from its receipt");
      const signal = signalFor(caller);
      signal.throwIfAborted();
      phase = "staging";
      // The Host journals the verified ID before it begins Stage.
      hostRecordedSandbox = true;
      try {
        const prepared = await sandbox.client.commands.run(
          cleanCommand(
            "/bin/sh",
            "-c",
            'mkdir -m 700 -- "$1" && cd "$1" && pwd -P',
            "prepare-workspace",
            root,
          ),
          { cwd: "/tmp", timeoutMs: API_TIMEOUT_MS, signal },
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
        const result = await runTransfer(
          "stage",
          [header.startCommit, header.bundle.sha256, bytes.byteLength.toString()],
          signal,
        );
        if (result.exitCode !== 0 || result.stdout.trim() !== "staged")
          throw new Error("Pinned bundle could not be materialized");
        signal.throwIfAborted();
        const environment = sandboxExecutionEnvironment(
          adaptE2B(sandbox.client),
          root,
          new E2BExecutionEnvironmentProvider({ maxOutputCharacters: 65_536 }).options,
        );
        tools = createWorkspaceOperations({
          environment: observedEnvironment(environment, () => {
            uncertain = true;
          }),
          workspaceRoot: "checkout",
          allowedActions,
        });
        phase = "staged";
      } catch {
        throw new Error("E2B Workspace bundle could not be staged");
      }
    },
    async execute(operation: WorkspaceOperation, caller?: AbortSignal) {
      if (phase !== "staged" || !tools)
        throw new Error("E2B Workspace tools are not staged or were sealed");
      if (
        "path" in operation &&
        operation.path?.split("/").some((part) => part.toLowerCase() === ".git")
      )
        throw new Error("E2B Workspace tools cannot access Git metadata");
      const workspace = tools;
      const signal = signalFor(caller);
      const pending = toolTail.then(() => {
        if (uncertain) throw new Error("A previous E2B Workspace mutation did not settle");
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
    async capture(caller?: AbortSignal): Promise<CapturedTree> {
      caller?.throwIfAborted();
      if (phase === "captured" && captured) return captured;
      if (phase !== "staged" || !sandbox || !root || !tools)
        throw new Error("E2B Workspace must be staged before capture");
      phase = "capturing";
      const signal = signalFor(caller);
      try {
        // Close admissions first. Allow active file processes to settle naturally.
        // Abort/transport uncertainty while a tool ran permanently prevents capture.
        await toolTail;
        await tools.dispose();
        if (uncertain) throw new Error("E2B Workspace was modified by an unsettled operation");
        signal.throwIfAborted();
        const result = await runTransfer("capture", [], signal);
        const receipt = /^([1-9][0-9]{0,8}) ([0-9a-f]{64})$/u.exec(result.stdout.trim());
        if (result.exitCode !== 0 || !receipt?.[1] || !receipt[2])
          throw new Error("E2B Workspace capture did not produce a receipt");
        const byteLength = Number(receipt[1]);
        if (byteLength < 13 || byteLength > MAX_TRANSFER)
          throw new Error("E2B Workspace tree is out of range");
        const bytes = await readTransfer(sandbox, `${root}/return.tree`, byteLength, signal);
        if (digest(bytes) !== receipt[2])
          throw new Error("E2B Workspace tree digest differs from its receipt");
        signal.throwIfAborted();
        captured = { tree: { sha256: receipt[2], byteLength: BigInt(byteLength) }, bytes };
        phase = "captured";
        return captured;
      } catch {
        throw new Error("E2B Workspace tree could not be captured");
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

def stage(commit, expected_hash, expected_length):
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
    raw_tree = git_command(["ls-tree", "-rz", "--full-tree", commit], MAX_MANIFEST)
    entries = raw_tree.split(b"\0")
    check(entries.pop() == b"" and len(entries) <= MAX_ENTRIES)
    os.mkdir(checkout)
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
                destination = os.path.join(checkout, *components(path))
                os.makedirs(os.path.dirname(destination), exist_ok=True)
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
                    os.symlink(validate_link(path, body), destination)
                else:
                    with open(destination, "xb") as file:
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
    os.unlink(bundle)
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

def capture():
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
        capture()
    else:
        raise ValueError("unknown transfer")
except Exception:
    sys.exit(1)`;
