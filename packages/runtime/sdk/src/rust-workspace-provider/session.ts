import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ExecutionEnvironment, ProcessHandle } from "../index.js";
import {
  type CopyDownloadPart,
  type CopyUploadPart,
  cleanCommand,
  createWorkspaceCopies,
  digest,
  readTransfer,
  type WorkspaceCopies,
} from "./copies.js";
import { type InputFile, inputManifest, inputRoot } from "./input-files.js";
import { createWorkspaceOperations, type WorkspaceOperation } from "./operations.js";

export const MAX_TRANSFER = 256 * 1024 * 1024;
const API_TIMEOUT_MS = 15_000;
const ALLOCATE_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 120_000;
/** A devcontainer image build before allocation, or its setup commands after staging. */
export const BUILD_TIMEOUT_MS = 20 * 60_000;

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
  /** Records this preparation sandbox's filesystem as a prepared artifact and returns its ID. */
  snapshot(signal: AbortSignal): Promise<string>;
}

/**
 * The Worker Host's translation of the trusted commit's devcontainer subset. The provider builds
 * `dockerfileCommands` on `image` (or on its configured template or image when absent) before the
 * sandbox starts. The image ends as `user`, so every process the session starts, staging
 * included, runs as that user and it owns the checkout and the trusted MCP copy.
 */
export interface SandboxEnvironment {
  readonly image?: string;
  readonly dockerfileCommands: readonly string[];
  readonly user?: string;
  /** Shell lines run in order in the checkout after staging; `"$1"` is the checkout path. */
  readonly setupCommands: readonly string[];
}

export function validSandboxEnvironment(environment: SandboxEnvironment): boolean {
  const line = (value: string) =>
    value.length > 0 && value.length <= 65_536 && !/[\0\r\n]/u.test(value);
  return (
    (environment.image === undefined ||
      (environment.image.length <= 512 && /^[^\s\p{Cc}]+$/u.test(environment.image))) &&
    (environment.user === undefined ||
      /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,63}$/u.test(environment.user)) &&
    environment.dockerfileCommands.length <= 256 &&
    environment.dockerfileCommands.every(line) &&
    // A user is set by the image, so the image is built whenever one is named.
    (environment.user === undefined ||
      environment.dockerfileCommands.at(-1) === `USER ${environment.user}`) &&
    // Without a devcontainer image, the build only sets the user on the operator's base.
    (environment.image === undefined
      ? environment.dockerfileCommands.length <= 1
      : environment.dockerfileCommands.length > 0) &&
    environment.setupCommands.length <= 256 &&
    environment.setupCommands.every(
      (command) => command.length > 0 && command.length <= 65_536 && !command.includes("\0"),
    )
  );
}

export interface SandboxWorkspaceProvider {
  readonly label: string;
  validateOwner(owner: SandboxOwner): void;
  /**
   * Creates the sandbox from `artifact`, a prepared artifact, when one is given: its image and
   * setup are already there, so `environment`'s image is not built.
   */
  allocate(
    owner: SandboxOwner,
    timeoutMs: number,
    signal: AbortSignal,
    environment?: SandboxEnvironment,
    artifact?: string,
  ): Promise<SandboxWorkspace>;
  stop(owner: SandboxOwner, sandboxId?: string): Promise<SandboxStopResult>;
  /** Deletes a prepared artifact; one already gone counts as deleted. */
  removeArtifact(artifact: string): Promise<void>;
}

/**
 * Where a preparation sandbox places the trusted checkout, and where every Task sandbox from its
 * artifact finds it. The setup lines name the checkout path, so it never changes.
 */
export const PREPARED_ROOT = "/tmp/supertag-workspace-prepared";

/** An E2B snapshot or template ID, or a Modal image ID. */
export function validPreparedArtifact(artifact: string): boolean {
  return /^[A-Za-z0-9._:/-]{1,256}$/u.test(artifact);
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
/**
 * How long a Workspace MCP server may take to stop once its input ends: the supervisor's own
 * grace, terminate, and kill steps, plus margin. A server still running after it leaves the
 * Workspace unsettled, so capture refuses rather than waits.
 */
const MCP_STOP_MS = 5_000;

/**
 * Runs one Workspace MCP server in its own process group and forwards this process's input to
 * it. When the input ends, the server gets half a second to exit, then SIGTERM, then two seconds,
 * then the whole group gets SIGKILL, so children the server forked cannot hold its output open
 * or outlive it. The same happens when the server exits by itself. Stopping a server never stops
 * the sandbox: on Modal a process's terminate is the sandbox's.
 */
const MCP_SUPERVISOR = `import os, select, signal, sys, threading
command = sys.argv[1:]
environment = {"PATH": "${MCP_PATH}", "LANG": "C.UTF-8"}
reader, writer = os.pipe()
pid = os.fork()
if pid == 0:
    try:
        os.setpgid(0, 0)
        os.dup2(reader, 0)
        os.close(reader)
        os.close(writer)
        for number in (signal.SIGPIPE, signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(number, signal.SIG_DFL)
        os.execvpe(command[0], command, environment)
    finally:
        os._exit(127)
os.close(reader)
try:
    os.setpgid(pid, pid)
except OSError:
    pass
exited = threading.Event()
status = [1]
def group(number):
    try:
        os.killpg(pid, number)
    except OSError:
        pass
def stopped(number, frame):
    group(signal.SIGKILL)
    os._exit(128 + number)
for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(number, stopped)
def reap():
    code = os.waitpid(pid, 0)[1]
    status[0] = os.WEXITSTATUS(code) if os.WIFEXITED(code) else 128 + os.WTERMSIG(code)
    exited.set()
threading.Thread(target=reap, daemon=True).start()
# One loop reads input and writes it on without blocking, so the end of input is seen even
# while a busy server leaves its stdin pipe full. Input it has not taken is dropped at stop.
os.set_blocking(writer, False)
pending = bytearray()
open_ = True
while not exited.is_set():
    try:
        readable, writable = select.select([0], [writer] if open_ and pending else [], [], 0.1)[:2]
    except InterruptedError:
        continue
    if writable:
        try:
            del pending[:os.write(writer, pending)]
        except BlockingIOError:
            pass
        except OSError:
            open_ = False
            pending.clear()
    if readable:
        try:
            data = os.read(0, 65536)
        except OSError:
            data = b""
        if not data:
            break
        if open_:
            pending += data
            # A server this far behind its input is stuck: stop it as if its input ended.
            if len(pending) > 16777216:
                break
if not exited.is_set():
    try:
        os.close(writer)
    except OSError:
        pass
    if not exited.wait(0.5):
        group(signal.SIGTERM)
        exited.wait(2)
group(signal.SIGKILL)
exited.wait(1)
os._exit(status[0])
`;

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

function exactOwner(left: SandboxOwner, right: SandboxOwner): boolean {
  return (
    left.hostId === right.hostId &&
    left.hostGeneration === right.hostGeneration &&
    left.taskId === right.taskId &&
    left.attemptId === right.attemptId &&
    left.allocationId === right.allocationId
  );
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

/**
 * One private helper owns at most one allocation. A fresh helper may recover Stop alone.
 *
 * Prepared artifacts: an allocation with `prepare` is a preparation sandbox, where Stage takes
 * the trusted commit alone at {@link PREPARED_ROOT} and runs the setup lines, and `snapshot`
 * records it. A Task allocation from `preparedArtifact` finds that checkout there and Stage
 * updates it like a forced checkout: the prepared commit's tracked files are replaced by the
 * start commit's, and untracked setup output stays. A preparation from `preparedArtifact` is
 * warm: the same update, then its setup lines (updateContentCommand alone).
 */
export function createSandboxWorkspaceSession(
  provider: SandboxWorkspaceProvider,
  options: { readonly preparedRoot?: string } = {},
) {
  const preparedRoot = options.preparedRoot ?? PREPARED_ROOT;
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
  let setupCommands: readonly string[] = [];
  /** A preparation sandbox, which Snapshot records; never a Task sandbox. */
  let preparing = false;
  /** The sandbox started from a prepared artifact, so its checkout already exists. */
  let fromArtifact = false;
  let stagedInputRoot = "";
  let tools: ReturnType<typeof createWorkspaceOperations> | undefined;
  let captured: CapturedTree | undefined;
  let mcpStaged = false;
  /** This Attempt's Workspace copies, once the first is staged. */
  let copies: WorkspaceCopies | undefined;
  const mcpServers = new Set<ProcessHandle>();
  const mcpStops = new WeakMap<ProcessHandle, Promise<boolean>>();
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

  async function runTransfer(
    mode: "stage" | "restage" | "capture",
    args: string[],
    signal: AbortSignal,
  ) {
    if (!sandbox || !root) throw workspaceError("allocation is unavailable");
    return sandbox.run(
      cleanCommand("python3", "-I", "-S", "-c", TREE_PROGRAM, mode, root, ...args),
      TRANSFER_TIMEOUT_MS,
      signal,
    );
  }

  /**
   * Ends a Workspace MCP server's input, so its supervisor stops the server's process group, and
   * waits at most MCP_STOP_MS for it to exit. Never kills the process: on Modal that stops the
   * sandbox. Resolves false when the exit was not confirmed in time.
   */
  function stopMcpServer(server: ProcessHandle): Promise<boolean> {
    let stopping = mcpStops.get(server);
    if (stopping === undefined) {
      stopping = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            (async () => {
              await server.endInput?.().catch(() => undefined);
              await server.wait().catch(() => undefined);
              return true;
            })(),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), MCP_STOP_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      })();
      mcpStops.set(server, stopping);
    }
    return stopping;
  }

  /**
   * Workspace MCP servers end before capture or Stop, so none can change the tree after. A server
   * that did not stop in time leaves the Workspace unsettled, so capture refuses.
   */
  async function stopMcpServers(): Promise<void> {
    const running = [...mcpServers];
    mcpServers.clear();
    const stopped = await Promise.all(running.map(stopMcpServer));
    if (stopped.includes(false)) uncertain = true;
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

  /** The file tools: staged inputs and read-only copies may only be read. */
  function createTools() {
    if (!sandbox || !root) throw workspaceError("allocation is unavailable");
    return createWorkspaceOperations({
      environment: observedEnvironment(
        sandbox.environment(root),
        () => {
          uncertain = true;
        },
        provider.label,
      ),
      workspaceRoot: "checkout",
      readOnlyRoots: [
        ...(stagedInputRoot ? [`checkout/${stagedInputRoot}`] : []),
        ...(copies?.readOnly() ?? []).map((path) => `checkout/${path}`),
      ],
      allowedActions,
    });
  }

  return {
    /** Stages one Workspace copy the Worker Host uploads, beside the checkout. */
    async stageCopy(
      header: { path: string; readWrite: boolean },
      parts: AsyncIterable<CopyUploadPart>,
      caller?: AbortSignal,
    ): Promise<{ files: bigint }> {
      if (phase !== "staged" || !sandbox || !root || !owner)
        throw workspaceError("must be staged before a copy");
      copies ??= createWorkspaceCopies({
        sandbox,
        root,
        attemptId: owner.attemptId,
        label: provider.label,
        lifetime: lifetime.signal,
      });
      const staged = await copies.stage(header, parts, caller);
      tools = createTools();
      return staged;
    },
    /** After capture, a read-write copy's changed and created files. */
    async *captureCopy(
      request: { path: string; maxBytes: bigint },
      caller?: AbortSignal,
    ): AsyncGenerator<CopyDownloadPart> {
      if (phase !== "captured" || !copies)
        throw workspaceError("must be captured before its copies");
      yield* copies.capture(request, caller);
    },
    async allocate(
      request: {
        owner: SandboxOwner;
        timeoutMs: number;
        allowedActions: readonly string[];
        environment?: SandboxEnvironment;
        preparedArtifact?: string;
        prepare?: boolean;
      },
      caller?: AbortSignal,
    ): Promise<{ sandboxId: string }> {
      if (phase !== "new") throw workspaceError("allocation already attempted");
      provider.validateOwner(request.owner);
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
        throw workspaceError("sandbox lifetime is invalid");
      if (request.allowedActions.includes("commands:execute"))
        throw workspaceError("does not support commands:execute");
      const { environment, preparedArtifact } = request;
      if (environment !== undefined && !validSandboxEnvironment(environment))
        throw workspaceError("devcontainer environment is invalid");
      if (preparedArtifact !== undefined && !validPreparedArtifact(preparedArtifact))
        throw workspaceError("prepared artifact is invalid");
      // A preparation sandbox holds trusted content only and exposes no file tools.
      if (request.prepare && request.allowedActions.length > 0)
        throw workspaceError("preparation sandbox takes no file actions");
      const build =
        request.prepare ||
        (preparedArtifact === undefined && (environment?.dockerfileCommands.length ?? 0) > 0);
      const signal = signalFor(caller, build ? BUILD_TIMEOUT_MS : ALLOCATE_TIMEOUT_MS);
      signal.throwIfAborted();
      phase = "allocating";
      allocationStarted = true;
      owner = { ...request.owner };
      allowedActions = [...request.allowedActions];
      // A Task sandbox from a prepared artifact runs no setup: the artifact holds its result.
      setupCommands =
        preparedArtifact !== undefined && !request.prepare
          ? []
          : [...(environment?.setupCommands ?? [])];
      preparing = request.prepare === true;
      fromArtifact = preparedArtifact !== undefined;
      try {
        sandbox = await provider.allocate(
          owner,
          request.timeoutMs,
          signal,
          environment,
          preparedArtifact,
        );
        signal.throwIfAborted();
        sandboxId = sandbox.sandboxId;
        if (!sandboxId || sandboxId.length > 256 || /\p{Cc}/u.test(sandboxId))
          throw new Error("Invalid sandbox identity");
        root = preparing || fromArtifact ? preparedRoot : `/tmp/supertag-workspace-${randomUUID()}`;
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
      if (preparing && (files.length > 0 || header.mcpCommit !== undefined))
        throw workspaceError("preparation sandbox takes the trusted commit alone");
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
        // A prepared artifact already holds the private root, its objects, and the checkout.
        const prepared = await sandbox.run(
          cleanCommand(
            "/bin/sh",
            "-c",
            fromArtifact
              ? 'cd -- "$1" && [ -O . ] && [ -d checkout ] && [ -d objects.git ] && [ -f staged-commit ] && pwd -P'
              : 'mkdir -m 700 -- "$1" && cd "$1" && pwd -P',
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
          fromArtifact ? "restage" : "stage",
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
        if (setupCommands.length > 0) {
          // The devcontainer's lifecycle commands, from the trusted commit, run in the checkout
          // as the image's user with the image's environment: never a Worker Host variable.
          const setupSignal = signalFor(caller, BUILD_TIMEOUT_MS);
          const setup = await sandbox.run(
            [
              "/bin/sh",
              "-c",
              ["set -e", 'cd -- "$1"', ...setupCommands].join("\n"),
              "devcontainer-setup",
              `${root}/checkout`,
            ],
            BUILD_TIMEOUT_MS,
            setupSignal,
          );
          if (setup.exitCode !== 0) throw new Error("devcontainer setup failed");
          signal.throwIfAborted();
        }
        stagedInputRoot = expectedRoot;
        mcpStaged = header.mcpCommit !== undefined;
        if (preparing) {
          phase = "staged";
          return;
        }
        tools = createTools();
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
    /** Stops a server startMcpServer returned; see stopMcpServer. */
    async stopMcpServer(server: ProcessHandle): Promise<void> {
      if (!(await stopMcpServer(server))) uncertain = true;
    },
    async startMcpServer(start: McpServerStart, caller?: AbortSignal): Promise<ProcessHandle> {
      if (phase !== "staged" || !sandbox || !root)
        throw workspaceError("must be staged before an MCP server starts");
      if (!mcpStaged) throw workspaceError("has no trusted MCP copy");
      if (!validMcpStart(start)) throw workspaceError("MCP server launch is invalid");
      caller?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      // Only the session's end cancels the process; a caller's end stops it through its input.
      const server = await sandbox.environment(root).spawn(
        {
          command: "/usr/bin/env",
          args: [
            "-i",
            `PATH=${MCP_PATH}`,
            "LANG=C.UTF-8",
            "python3",
            "-I",
            "-S",
            "-c",
            MCP_SUPERVISOR,
            start.command,
            ...start.args,
          ],
          cwd: "mcp",
          environment: {},
          replaceEnvironment: true,
          streamInput: true,
          streamOutput: true,
        },
        lifetime.signal,
      );
      mcpServers.add(server);
      void server.wait().then(
        () => mcpServers.delete(server),
        () => mcpServers.delete(server),
      );
      const refuse = async (message: string) => {
        if (!(await stopMcpServer(server))) uncertain = true;
        return workspaceError(message);
      };
      if (!server.write || !server.endInput || !server.output)
        throw await refuse("cannot stream MCP server input and output");
      if (phase !== "staged") throw await refuse("tools were sealed");
      caller?.addEventListener("abort", () => void stopMcpServer(server), { once: true });
      if (caller?.aborted) void stopMcpServer(server);
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
        // Staged inputs and Workspace copies never return in the tree.
        const result = await runTransfer(
          "capture",
          [stagedInputRoot, ...(copies?.root() ? [copies.root() as string] : [])],
          signal,
        );
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
    /** Records the staged preparation sandbox as a prepared artifact. */
    async snapshot(caller?: AbortSignal): Promise<string> {
      if (!preparing || phase !== "staged" || !sandbox)
        throw workspaceError("only a staged preparation sandbox is snapshotted");
      const signal = signalFor(caller, BUILD_TIMEOUT_MS);
      try {
        const artifact = await sandbox.snapshot(signal);
        if (!validPreparedArtifact(artifact)) throw new Error("Invalid prepared artifact");
        return artifact;
      } catch {
        throw workspaceError("preparation could not be snapshotted");
      }
    },
    async removeArtifact(artifact: string, caller?: AbortSignal): Promise<void> {
      if (!validPreparedArtifact(artifact)) throw workspaceError("prepared artifact is invalid");
      caller?.throwIfAborted();
      try {
        await provider.removeArtifact(artifact);
      } catch {
        throw workspaceError("prepared artifact could not be deleted");
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

def tracked(commit):
    raw_tree = git_command(["ls-tree", "-rz", "--full-tree", commit], MAX_MANIFEST)
    entries = raw_tree.split(b"\0")
    check(entries.pop() == b"" and len(entries) <= MAX_ENTRIES)
    return entries

def materialize(commit, destination, replace=False):
    entries = tracked(commit)
    if replace:
        check(os.path.isdir(destination) and not os.path.islink(destination))
    else:
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
                parent, inside = os.path.realpath(os.path.dirname(target)), os.path.realpath(destination)
                check(parent == inside or parent.startswith(inside + os.sep))
                if replace and os.path.lexists(target):
                    check(os.path.islink(target) or not os.path.isdir(target))
                    os.unlink(target)
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
    finish_stage(commit, bundle, input_root, mcp_commit)

def finish_stage(commit, bundle, input_root, mcp_commit):
    with open(os.path.join(root, "staged-commit"), "w") as marker:
        marker.write(commit)
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

def restage(commit, expected_hash, expected_length, input_root, mcp_commit=""):
    # A forced checkout of the prepared checkout: the prepared commit's tracked files give way to
    # the start commit's, and untracked setup output stays.
    bundle = os.path.join(root, "source.bundle")
    check(file_hash(bundle) == (int(expected_length), expected_hash))
    with open(os.path.join(root, "staged-commit")) as marker:
        previous = marker.read(65)
    check(len(previous) == len(commit) and all(c in "0123456789abcdef" for c in previous))
    heads = git_command(["bundle", "list-heads", bundle], 4096).splitlines()
    check(len(heads) == 1)
    fields = heads[0].split()
    check(len(fields) == 2 and fields[0] == commit.encode("ascii") and
          fields[1].startswith(b"refs/heads/supertag-deliveries/"))
    git_command(["bundle", "verify", bundle])
    git_command(["bundle", "unbundle", bundle])
    check(git_command(["cat-file", "-t", commit], 64) == b"commit\n")
    check(git_command(["cat-file", "-t", previous], 64) == b"commit\n")
    for entry in tracked(previous):
        target = os.path.join(checkout, *components(entry.split(b"\t", 1)[1].decode("utf-8")))
        if os.path.lexists(target) and (os.path.islink(target) or not os.path.isdir(target)):
            os.unlink(target)
    materialize(commit, checkout, replace=True)
    finish_stage(commit, bundle, input_root, mcp_commit)

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

def capture(*excluded):
    excluded = {root for root in excluded if root}
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
                if path in excluded:
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
    elif mode == "restage":
        restage(*sys.argv[3:])
    elif mode == "capture":
        capture(*sys.argv[3:])
    else:
        raise ValueError("unknown transfer")
except Exception:
    sys.exit(1)`;
