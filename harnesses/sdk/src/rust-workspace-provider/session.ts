import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ExecutionEnvironment, ProcessHandle, SplitExecutionToolResult } from "../index.js";
import {
  type CopyDownloadPart,
  type CopyUploadPart,
  cleanCommand,
  createWorkspaceCopies,
  digest,
  readTransfer,
  type WorkspaceCopies,
} from "./copies.js";
import { WorkspaceConfigurationError } from "./errors.js";
import { type InputFile, inputManifest, inputRoot } from "./input-files.js";
import { createWorkspaceOperations, type WorkspaceOperation } from "./operations.js";
import {
  createProcessSeal,
  lastLine,
  type PrivilegedRun,
  type ProcessSeal,
} from "./process-seal.js";

export const MAX_TRANSFER = 256 * 1024 * 1024;
const API_TIMEOUT_MS = 15_000;
const ALLOCATE_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 120_000;
/** A devcontainer image build before allocation, or its setup commands after staging. */
export const BUILD_TIMEOUT_MS = 20 * 60_000;

/** The Workspace part of a Task's path scope, which the file tools apply. */
export interface WorkspaceFileScope {
  readonly write: readonly string[];
  readonly readOnly: readonly string[];
  readonly hidden: readonly string[];
}

function validFileScope(scope: WorkspaceFileScope): boolean {
  return [scope.write, scope.readOnly, scope.hidden].every(
    (entries) =>
      Array.isArray(entries) &&
      entries.length <= 16_384 &&
      entries.every(
        (entry) =>
          typeof entry === "string" &&
          entry.length > 0 &&
          Buffer.byteLength(entry) <= 1024 &&
          !/\p{Cc}/u.test(entry) &&
          !entry.startsWith("/") &&
          !entry.split("/").includes(".."),
      ),
  );
}

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
  /**
   * Runs trusted provider code as the sandbox's privileged user, for sealing (see
   * process-seal.ts). Workspace commands are admitted only in a sandbox that provides it.
   */
  runPrivileged?: PrivilegedRun;
  /** True when the provider started the egress relay the allocation asked for. */
  readonly egressRelay?: true;
  /** Variables every Task command gets, such as package managers' cache directories. */
  readonly commandEnvironment?: Readonly<Record<string, string>>;
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

/** A Task's network through the sandbox's egress relay; see egress-relay.ts. */
export interface SandboxEgress {
  /** The Attempt's egress proxy on the Worker Host's loopback, `127.0.0.1:PORT`. */
  readonly proxy: string;
  /** Variables every Workspace command gets: the proxy URL through the relay, placeholders. */
  readonly variables: Readonly<Record<string, string>>;
  readonly caPem: string;
}

/** The relay's loopback port in the sandbox, where Task clients connect. */
export const EGRESS_CLIENT_PORT = 3128;

/** The proxy's loopback address as a host and port, or undefined when it is anything else. */
export function egressProxy(egress: SandboxEgress): { host: string; port: number } | undefined {
  const match = /^127\.0\.0\.1:([0-9]{1,5})$/u.exec(egress.proxy);
  const port = Number(match?.[1]);
  return match && port >= 1 && port <= 65_535 ? { host: "127.0.0.1", port } : undefined;
}

function validEgress(egress: SandboxEgress): boolean {
  const entries = Object.entries(egress.variables);
  return (
    egressProxy(egress) !== undefined &&
    entries.length <= 64 &&
    entries.every(
      ([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) &&
        value.length <= 4096 &&
        !/[\0\r\n]/u.test(value),
    ) &&
    egress.caPem.length > 0 &&
    egress.caPem.length <= 1_048_576 &&
    egress.caPem.includes("-----BEGIN CERTIFICATE-----")
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
    /**
     * When present, the sandbox allows no egress but the relay, which the provider starts before
     * the session records the sandbox's own processes, so sealing spares it.
     */
    egress?: SandboxEgress,
    /**
     * A key for a dependency cache the provider may keep for this Workspace and Tag across Task
     * Attempts; see `RemoteWorkspaceAllocateRequest.dependency_cache`.
     */
    dependencyCache?: string,
  ): Promise<SandboxWorkspace>;
  stop(owner: SandboxOwner, sandboxId?: string): Promise<SandboxStopResult>;
  /**
   * Whether the provider confirms that this owner's sandbox no longer exists. Asked only after a
   * Workspace call failed. Resolve true only on the provider's own answer that the sandbox is
   * gone; a timeout, a network error, or any doubt is false. A true answer makes the Worker Host
   * replace the sandbox from the turn's starting files.
   */
  sandboxGone?(owner: SandboxOwner, sandboxId: string): Promise<boolean>;
  /** Deletes a prepared artifact; one already gone counts as deleted. */
  removeArtifact(artifact: string): Promise<void>;
}

/**
 * Where a preparation sandbox places the trusted checkout, and where every Task sandbox from its
 * artifact finds it. The setup lines name the checkout path, so it never changes.
 */
export const PREPARED_ROOT = "/tmp/supertag-workspace-prepared";

/** How long the provider may take to say whether a sandbox still exists. */
const SANDBOX_GONE_CHECK_MS = 10_000;

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

/** A stdio server the session starts in the staged sandbox. */
export type StdioServerStart =
  | ({ readonly kind: "mcp" } & McpServerStart)
  | { readonly kind: "codexExecServer" };

/**
 * `CODEX_HOME` for Codex's exec-server: an empty directory owned by the sandbox's privileged user
 * that the Workspace user cannot write. Codex reads its configuration layers, such as MCP
 * servers, from here; the Workspace user's own `~/.codex` is never read.
 */
export const CODEX_HOME = "/opt/supertag-codex-home";
/**
 * Recreates `CODEX_HOME` empty, owned by the privileged user, mode 0555, under a parent the
 * Workspace user cannot write. Exits non-zero when it cannot.
 */
const CODEX_PREPARE = `import os, shutil, stat, sys
home = sys.argv[1]
parent = os.path.dirname(home)
info = os.lstat(parent)
if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
    sys.exit(3)
if os.path.lexists(home):
    if os.path.isdir(home) and not os.path.islink(home):
        shutil.rmtree(home)
    else:
        os.unlink(home)
os.mkdir(home, 0o555)
os.chmod(home, 0o555)
info = os.lstat(home)
if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o555 or os.listdir(home):
    sys.exit(4)
`;

const MCP_PATH = "/usr/local/bin:/usr/bin:/bin";
/**
 * How long a stdio server (a Workspace MCP server or Codex's exec-server) may take to stop once its input ends: the supervisor's own
 * grace, terminate, and kill steps, plus margin. A server still running after it leaves the
 * Workspace unsettled, so capture refuses rather than waits.
 */
const STDIO_STOP_MS = 5_000;

/**
 * Runs one stdio server (the command after its JSON environment) in its own process group and forwards this process's input to
 * it. When the input ends, the server gets half a second to exit, then SIGTERM, then two seconds,
 * then the whole group gets SIGKILL, so children the server forked cannot hold its output open
 * or outlive it. The same happens when the server exits by itself. Stopping a server never stops
 * the sandbox: on Modal a process's terminate is the sandbox's.
 */
const STDIO_SUPERVISOR = `import json, os, select, signal, sys, threading
environment = json.loads(sys.argv[1])
command = sys.argv[2:]
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
  options: {
    readonly preparedRoot?: string;
    /** The allocation limit, for a provider whose first allocation builds its own image. */
    readonly allocateTimeoutMs?: number;
  } = {},
) {
  const preparedRoot = options.preparedRoot ?? PREPARED_ROOT;
  const allocateTimeoutMs = options.allocateTimeoutMs ?? ALLOCATE_TIMEOUT_MS;
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
  let fileScope: WorkspaceFileScope | undefined;
  let setupCommands: readonly string[] = [];
  /** A preparation sandbox, which Snapshot records; never a Task sandbox. */
  let preparing = false;
  /** The sandbox started from a prepared artifact, so its checkout already exists. */
  let fromArtifact = false;
  let stagedInputRoot = "";
  let tools: ReturnType<typeof createWorkspaceOperations> | undefined;
  let captured: CapturedTree | undefined;
  let mcpStaged = false;
  /** The Codex version the image holds, checked at allocation; set only for a Codex Attempt. */
  let codexVersion: string | undefined;
  /** The commit Stage materialized; Capture indexes it to tell ignored files from tracked ones. */
  let stagedCommit = "";
  /** Present when the Task may run commands: the sandbox is sealed before Capture. */
  let seal: ProcessSeal | undefined;
  /** The Task may run commands; with any stdio server started, the seal is required. */
  let commands = false;
  let stdioStarted = false;
  /** The provider confirmed the sandbox gone: every later call reports it without asking again. */
  let sandboxLost = false;
  /** The Task's network through the relay; its CA is written at Stage. */
  let egress: SandboxEgress | undefined;
  /** This Attempt's Workspace copies, once the first is staged. */
  let copies: WorkspaceCopies | undefined;
  const stdioServers = new Set<ProcessHandle>();
  const stdioStops = new WeakMap<ProcessHandle, Promise<boolean>>();
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
   * Ends a stdio server's input, so its supervisor stops the server's process group, and
   * waits at most STDIO_STOP_MS for it to exit. Never kills the process: on Modal that stops the
   * sandbox. Resolves false when the exit was not confirmed in time.
   */
  function stopStdioServer(server: ProcessHandle): Promise<boolean> {
    let stopping = stdioStops.get(server);
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
              timer = setTimeout(() => resolve(false), STDIO_STOP_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      })();
      stdioStops.set(server, stopping);
    }
    return stopping;
  }

  /**
   * Checks, as the Workspace user, that the image's `codex` on the fixed PATH is exactly
   * `version`, then recreates the read-only `CODEX_HOME` as the privileged user. A mismatch or a
   * sandbox that cannot do either is a configuration the operator must fix.
   */
  async function prepareCodex(
    workspace: SandboxWorkspace,
    version: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!seal || !workspace.runPrivileged)
      throw new WorkspaceConfigurationError(
        `${provider.label} cannot run Codex: its sandbox must be sealable and run privileged setup`,
      );
    const found = await workspace.run(cleanCommand("codex", "--version"), 30_000, signal);
    const reported = found.exitCode === 0 ? found.stdout.trim() : "";
    if (reported !== `codex-cli ${version}`)
      throw new WorkspaceConfigurationError(
        `${provider.label} sandbox image must contain codex ${version} on PATH /usr/local/bin:/usr/bin:/bin to match this Worker Host; found ${
          /^codex-cli [0-9A-Za-z.-]{1,48}$/u.test(reported) ? reported.slice(10) : "none"
        }`,
      );
    const prepared = await workspace.runPrivileged(
      cleanCommand("python3", "-I", "-S", "-c", CODEX_PREPARE, CODEX_HOME),
      30_000,
      signal,
    );
    if (prepared.exitCode !== 0)
      throw new WorkspaceConfigurationError(
        `${provider.label} cannot create the read-only Codex configuration directory ${CODEX_HOME}: its parent must exist, be owned by root, and be writable by no one else`,
      );
    return version;
  }

  /**
   * Stdio servers end before capture or Stop, so none can change the tree after. A server
   * that did not stop in time leaves the Workspace unsettled, so capture refuses.
   */
  async function stopStdioServers(): Promise<void> {
    const running = [...stdioServers];
    stdioServers.clear();
    const stopped = await Promise.all(running.map(stopStdioServer));
    if (stopped.includes(false)) uncertain = true;
  }

  function lostResult() {
    return {
      text: `The ${provider.label} sandbox no longer exists.`,
      isError: true,
      sandboxLost: true,
    };
  }

  /** Asks the provider, once per failure, whether the staged sandbox is gone. */
  async function confirmedGone(): Promise<boolean> {
    if (sandboxLost) return true;
    const check = provider.sandboxGone;
    const id = sandboxId;
    const who = owner;
    if (!check || !id || !who || phase !== "staged") return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const gone = await Promise.race([
        check.call(provider, who, id),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), SANDBOX_GONE_CHECK_MS);
        }),
      ]);
      sandboxLost = gone === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
    return sandboxLost;
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
    await stopStdioServers();
    const result = await provider.stop(owner, knownId ?? request.sandboxId);
    if (result.state === "stopped") stoppedSandboxId = result.sandboxId;
    return result;
  }

  /**
   * Variables a Task command gets beyond PATH and LANG: the sandbox's own, such as package
   * managers' cache directories, and with a network scope the relay's proxy and CA.
   */
  function commandVariables(): Record<string, string> | undefined {
    if (!((egress && root) || sandbox?.commandEnvironment)) return undefined;
    return {
      ...sandbox?.commandEnvironment,
      ...egress?.variables,
      ...Object.fromEntries(
        [
          "SSL_CERT_FILE",
          "REQUESTS_CA_BUNDLE",
          "CURL_CA_BUNDLE",
          "NODE_EXTRA_CA_CERTS",
          "GIT_SSL_CAINFO",
          "PIP_CERT",
        ]
          .filter(() => egress && root)
          .map((name) => [name, `${root}/egress-ca.pem`]),
      ),
    };
  }

  /** The file tools: staged inputs and read-only copies may only be read. */
  function createTools() {
    if (!sandbox || !root) throw workspaceError("allocation is unavailable");
    const commandEnvironment = commandVariables();
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
      ...(fileScope ? { fileScope } : {}),
      ...(commandEnvironment ? { commandEnvironment } : {}),
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
        fileScope?: WorkspaceFileScope;
        environment?: SandboxEnvironment;
        preparedArtifact?: string;
        prepare?: boolean;
        egress?: SandboxEgress;
        dependencyCache?: string;
        /** The Worker Host's Codex version, for a Codex Attempt: the image must hold it. */
        codexVersion?: string;
      },
      caller?: AbortSignal,
    ): Promise<{ sandboxId: string }> {
      if (phase !== "new") throw workspaceError("allocation already attempted");
      provider.validateOwner(request.owner);
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
        throw workspaceError("sandbox lifetime is invalid");
      const { environment, preparedArtifact } = request;
      if (environment !== undefined && !validSandboxEnvironment(environment))
        throw workspaceError("devcontainer environment is invalid");
      if (preparedArtifact !== undefined && !validPreparedArtifact(preparedArtifact))
        throw workspaceError("prepared artifact is invalid");
      if (request.fileScope !== undefined && !validFileScope(request.fileScope))
        throw workspaceError("path scope is invalid");
      // Only commands use the network in the sandbox; the relay serves nothing else.
      if (
        request.egress !== undefined &&
        (!validEgress(request.egress) || !request.allowedActions.includes("commands:execute"))
      )
        throw workspaceError("egress is invalid");
      // A preparation sandbox holds trusted content only and exposes no file tools.
      if (request.prepare && request.allowedActions.length > 0)
        throw workspaceError("preparation sandbox takes no file actions");
      // A preparation sandbox's result becomes trusted, so no Task-written cache reaches it.
      if (
        request.dependencyCache !== undefined &&
        (request.prepare || !/^[0-9a-f]{64}$/u.test(request.dependencyCache))
      )
        throw workspaceError("dependency cache is invalid");
      if (
        request.codexVersion !== undefined &&
        (request.prepare ||
          !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]{1,32})?$/u.test(request.codexVersion))
      )
        throw workspaceError("Codex version is invalid");
      const build =
        request.prepare ||
        (preparedArtifact === undefined && (environment?.dockerfileCommands.length ?? 0) > 0);
      const signal = signalFor(caller, build ? BUILD_TIMEOUT_MS : allocateTimeoutMs);
      signal.throwIfAborted();
      phase = "allocating";
      allocationStarted = true;
      owner = { ...request.owner };
      allowedActions = [...request.allowedActions];
      fileScope = request.fileScope;
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
          request.egress,
          request.dependencyCache,
        );
        signal.throwIfAborted();
        sandboxId = sandbox.sandboxId;
        if (!sandboxId || sandboxId.length > 256 || /\p{Cc}/u.test(sandboxId))
          throw new Error("Invalid sandbox identity");
        if (request.egress && !sandbox.egressRelay)
          throw new Error("Sandbox egress relay is unavailable");
        egress = request.egress;
        // Commands and stdio servers are Task-driven processes that may outlive their
        // call, so every sandbox records its own processes first, before any of them exists.
        commands = request.allowedActions.includes("commands:execute");
        if (sandbox.runPrivileged) {
          const recording = createProcessSeal(sandbox.runPrivileged);
          try {
            await recording.record(signal);
            seal = recording;
          } catch (error) {
            // Without commands the record matters only if a stdio server runs; then
            // Capture refuses. An image the record cannot run in never fails a file-only Task.
            if (commands) throw error;
          }
        }
        // Only a sandbox that can be sealed admits commands.
        if (commands && !seal) throw new Error("Sandbox cannot be sealed");
        if (request.codexVersion !== undefined)
          codexVersion = await prepareCodex(sandbox, request.codexVersion, signal);
        root = preparing || fromArtifact ? preparedRoot : `/tmp/supertag-workspace-${randomUUID()}`;
        phase = "allocated";
        return { sandboxId };
      } catch (error) {
        // A configuration the operator must fix is named; anything else stays opaque.
        if (error instanceof WorkspaceConfigurationError) throw error;
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
        const physicalRoot = lastLine(prepared.stdout);
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
        // The proxy re-signs every TLS connection, so its CA alone is the commands' trust store.
        if (egress)
          await sandbox.writeTransfer(
            `${root}/egress-ca.pem`,
            new TextEncoder().encode(egress.caPem),
            signal,
          );
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
        if (result.exitCode !== 0 || lastLine(result.stdout) !== "staged")
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
        stagedCommit = header.startCommit;
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
    /** Whether this allocation admitted commands (its Task allows them and it can be sealed). */
    admitsCommands(): boolean {
      return commands && seal !== undefined;
    },
    async execute(operation: WorkspaceOperation, caller?: AbortSignal) {
      if (sandboxLost) return lostResult();
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
      // A failed call may mean the sandbox died; only the provider's confirmation says so.
      let result: SplitExecutionToolResult;
      try {
        result = await pending;
      } catch (error) {
        if (await confirmedGone()) return lostResult();
        throw error;
      }
      if (result.isError && (await confirmedGone())) return lostResult();
      return result;
    },
    /** Stops a server startStdioServer returned; see stopStdioServer. */
    async stopStdioServer(server: ProcessHandle): Promise<void> {
      if (!(await stopStdioServer(server))) uncertain = true;
    },
    /**
     * Starts one stdio server under the supervisor, with an exact environment and nothing
     * inherited from the Worker Host or a Harness plan:
     * - a Workspace MCP server in the trusted copy beside the checkout, with only PATH and LANG;
     * - Codex's exec-server in the checkout, with what a Task command gets plus the read-only
     *   `CODEX_HOME`. Codex applies its environment policy to this environment for every command
     *   it runs, so it is the whole environment those commands can inherit.
     */
    async startStdioServer(start: StdioServerStart, caller?: AbortSignal): Promise<ProcessHandle> {
      if (phase !== "staged" || !sandbox || !root)
        throw workspaceError("must be staged before a stdio server starts");
      let launch: { cwd: string; environment: Record<string, string>; argv: string[] };
      if (start.kind === "mcp") {
        if (!mcpStaged) throw workspaceError("has no trusted MCP copy");
        if (!validMcpStart(start)) throw workspaceError("MCP server launch is invalid");
        launch = {
          cwd: "mcp",
          environment: { PATH: MCP_PATH, LANG: "C.UTF-8" },
          argv: [start.command, ...start.args],
        };
      } else {
        if (codexVersion === undefined) throw workspaceError("was not allocated for Codex");
        launch = {
          cwd: "checkout",
          environment: {
            PATH: MCP_PATH,
            LANG: "C.UTF-8",
            ...commandVariables(),
            CODEX_HOME,
          },
          argv: ["codex", "exec-server", "--listen", "stdio"],
        };
      }
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
            STDIO_SUPERVISOR,
            JSON.stringify(launch.environment),
            ...launch.argv,
          ],
          cwd: launch.cwd,
          environment: {},
          replaceEnvironment: true,
          streamInput: true,
          streamOutput: true,
        },
        lifetime.signal,
      );
      stdioServers.add(server);
      stdioStarted = true;
      void server.wait().then(
        () => stdioServers.delete(server),
        () => stdioServers.delete(server),
      );
      const refuse = async (message: string) => {
        if (!(await stopStdioServer(server))) uncertain = true;
        return workspaceError(message);
      };
      if (!server.write || !server.endInput || !server.output)
        throw await refuse("cannot stream the stdio server's input and output");
      if (phase !== "staged") throw await refuse("tools were sealed");
      caller?.addEventListener("abort", () => void stopStdioServer(server), { once: true });
      if (caller?.aborted) void stopStdioServer(server);
      return server;
    },
    /**
     * `keep` names checkout paths returned even when ignored, such as the Task output directory.
     * Every other untracked path the checkout's ignore rules match stays in the sandbox, and so
     * does every `.git` entry.
     */
    async capture(caller?: AbortSignal, keep: readonly string[] = []): Promise<CapturedTree> {
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
        await stopStdioServers();
        await tools.dispose();
        if (uncertain) throw workspaceError("was modified by an unsettled operation");
        signal.throwIfAborted();
        if (
          keep.length > 64 ||
          keep.some(
            (path) =>
              !path ||
              Buffer.byteLength(path) > 1024 ||
              /\p{Cc}/u.test(path) ||
              posix.isAbsolute(path) ||
              posix.normalize(path) !== path ||
              path.split("/").includes(".."),
          )
        )
          throw workspaceError("capture keep list is invalid");
        // Staged inputs and Workspace copies never return in the tree.
        const captureArgs = [
          stagedCommit,
          JSON.stringify(keep),
          stagedInputRoot,
          ...(copies?.root() ? [copies.root() as string] : []),
        ];
        // Nothing a Task-driven process left running may change the tree while it is read: the
        // seal and the capture run as one privileged process, with no gap between them.
        let result: { exitCode: number | null; stdout: string };
        if (commands || stdioStarted) {
          if (!seal) {
            uncertain = true;
            throw workspaceError("could not be sealed");
          }
          const sealed = await seal.sealThen(
            [TREE_PROGRAM, "capture", root, ...captureArgs],
            TRANSFER_TIMEOUT_MS,
            signal,
          );
          if (!sealed.sealed) {
            uncertain = true;
            throw workspaceError("could not be sealed");
          }
          result = sealed;
        } else {
          result = await runTransfer("capture", captureArgs, signal);
        }
        const receipt = /^([1-9][0-9]{0,8}) ([0-9a-f]{64})$/u.exec(lastLine(result.stdout));
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
const TREE_PROGRAM = String.raw`import contextlib, hashlib, json, os, shutil, stat, struct, subprocess, sys, tempfile

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

def ignored_paths(commit):
    # Untracked paths the checkout's .gitignore files match, against an index of the staged
    # commit, so a tracked file is never left out. Directories end with "/". The Git directory
    # is a fresh one made here, borrowing only objects.git's objects, so no Task-written config,
    # info/exclude or core.excludesFile applies; the checkout's own .gitignore files do, as they
    # do at local delivery. Skipping only ever leaves files out; it never adds or redirects one.
    global git
    scratch = tempfile.mkdtemp(prefix="capture-git-", dir=root)
    saved = git
    try:
        for part in ("objects", "objects/info", "refs"):
            os.mkdir(os.path.join(scratch, part))
        with open(os.path.join(scratch, "HEAD"), "w") as head:
            head.write("ref: refs/heads/capture\n")
        with open(os.path.join(scratch, "objects", "info", "alternates"), "w") as alternates:
            alternates.write(os.path.join(root, "objects.git", "objects") + "\n")
        git = ["git", "--git-dir=" + scratch] + saved[2:]
        for setting in ("core.excludesFile=/dev/null", "core.untrackedCache=false"):
            git.extend(("-c", setting))
        os.environ["GIT_INDEX_FILE"] = os.path.join(scratch, "index")
        git_command(["read-tree", commit])
        raw = git_command(["--work-tree=" + checkout,
                           "ls-files", "-z", "--others", "--ignored", "--exclude-standard",
                           "--directory", "--no-empty-directory"], MAX_MANIFEST)
    finally:
        git = saved
        os.environ.pop("GIT_INDEX_FILE", None)
        shutil.rmtree(scratch, ignore_errors=True)
    files, directories = set(), set()
    for item in raw.split(b"\0"):
        if item:
            path = item.decode("utf-8")
            if path.endswith("/"):
                directories.add(path.rstrip("/"))
            else:
                files.add(path)
    return files, directories

def capture(commit, keep_json, *excluded):
    excluded = {root for root in excluded if root}
    keep = json.loads(keep_json)
    check(isinstance(keep, list) and all(isinstance(path, str) and path for path in keep))
    check(len(commit) in (40, 64) and all(c in "0123456789abcdef" for c in commit))
    ignored_files, ignored_directories = ignored_paths(commit)

    def kept(path):
        return any(path == item or path.startswith(item + "/") or item.startswith(path + "/")
                   for item in keep)

    def ignored(path):
        if path in ignored_files:
            return True
        parts = path.split("/")
        return any("/".join(parts[:end]) in ignored_directories for end in range(1, len(parts) + 1))

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
                # Git metadata a command created, and ignored output such as dependencies,
                # stay in the sandbox.
                if path in excluded or child.name.lower() == ".git":
                    continue
                if ignored(path) and not kept(path):
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
        # As root after the seal, write only into the private root the provider's own user
        # created at Stage, and give the tree to that user by descriptor, never by path: the
        # Task could swap the path for a link between the two.
        private = os.lstat(root)
        check(stat.S_ISDIR(private.st_mode) and not stat.S_ISLNK(private.st_mode))
        check(os.geteuid() != 0 or private.st_mode & 0o777 == 0o700)
        with open(destination, "xb") as tree:
            if os.geteuid() == 0:
                os.fchown(tree.fileno(), private.st_uid, private.st_gid)
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
