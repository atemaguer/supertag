import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ARTIFACT_BYTES } from "./artifact-store.js";
import {
  EnvironmentConnections,
  type EnvironmentGuarantees,
  type EnvironmentHttpLimits,
  type EnvironmentHttpRequest,
  type EnvironmentHttpResponse,
} from "./environment-connection.js";
import type {
  CapabilityIdentifier,
  EnvironmentPlan,
  ExecutionEnvironment,
  ExecutionEnvironmentProvider,
  ExecutionEnvironmentSpec,
  ProcessHandle,
  ProcessOutputChunk,
  ProcessResult,
  ProcessSpec,
} from "./index.js";
import {
  childPath,
  type LocalResourceFilter,
  localResourceFilter,
} from "./local-resource-filter.js";
import type { OutputFileEntry, OutputFileQuery } from "./output-files.js";
import {
  ExecutionCleanupError,
  ProcessInputWriter,
  ProcessOutputBuffer,
} from "./process-supervision.js";

export interface SandboxProcess {
  readonly pid?: number;
  wait(): Promise<ProcessResult>;
  write?(bytes: Uint8Array): Promise<void>;
  endInput?(): Promise<void>;
  /** True confirms termination; false must never be treated as successful cleanup. */
  terminate(): Promise<boolean>;
}
export interface SandboxArtifactFiles {
  readonly directory: string;
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
}
export interface SandboxInstance {
  readonly id: string;
  /** Exact native mount links created by the provider, keyed by the declared mount path. */
  readonly nativeMountSymlinkTargets?: Readonly<Record<string, string>>;
  prepareOutputDirectory?(root: string, path: string): Promise<void>;
  listOutputFiles?(root: string, query: OutputFileQuery): Promise<readonly OutputFileEntry[]>;
  /** Fresh exclusive directory, descriptor-relative writes, no overwrites or symlink traversal.
   * The instance must be isolated to one Attempt; these are writable copies, not readonly mounts. */
  materializeArtifactFiles?(input: SandboxArtifactFiles): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Exclusive writes must reject existing files or symbolic links. */
  write(
    path: string,
    bytes: Uint8Array,
    options: { exclusive: boolean; mode?: number },
  ): Promise<void>;
  /** Enforce the bound and reject symbolic links in every path component before reading. */
  read(path: string, options: { maximumBytes: number; rejectSymlinks: true }): Promise<Uint8Array>;
  makeReadOnly(path: string): Promise<void>;
  /**
   * Deliver output in order through `onOutput`. When it returns a promise, the consumer is
   * applying backpressure: read no further output for this process until it settles.
   */
  start(
    spec: ProcessSpec,
    options: {
      signal?: AbortSignal;
      onOutput(chunk: ProcessOutputChunk): void | Promise<void>;
    },
  ): Promise<SandboxProcess>;
  /** Unary HTTP executed inside this sandbox; never via the Worker Host network. */
  requestHttp?(
    port: number,
    request: EnvironmentHttpRequest,
    limits: EnvironmentHttpLimits,
    signal: AbortSignal,
  ): Promise<EnvironmentHttpResponse>;
  /** True confirms the entire sandbox stopped. */
  terminate(): Promise<boolean>;
}
export interface SandboxBackend {
  readonly guarantees?: EnvironmentGuarantees;
  readonly capabilities: {
    readonly networkModes: readonly EnvironmentPlan["network"]["mode"][];
    readonly readOnlyMounts: boolean;
    readonly boundedSymlinkSafeReads: boolean;
    readonly streamOutput: boolean;
    readonly streamInput?: boolean;
    readonly outputFiles?: boolean;
  };
  create(input: {
    taskId: string;
    attemptId: string;
    tagId: string;
    network: EnvironmentPlan["network"];
    signal?: AbortSignal;
  }): Promise<SandboxInstance>;
}
export interface SandboxExecutionEnvironmentProviderOptions {
  readonly id: string;
  readonly backend: SandboxBackend;
  readonly rootDirectory?: string;
  readonly capabilities?: readonly CapabilityIdentifier[];
  readonly maxOutputCharacters?: number;
}
/** Shared attempt-scoped preparation and lifecycle; vendor behavior stays in the backend. */
export class SandboxExecutionEnvironmentProvider implements ExecutionEnvironmentProvider {
  readonly id: string;
  readonly guarantees?: EnvironmentGuarantees;
  readonly capabilities: readonly CapabilityIdentifier[];
  constructor(readonly options: SandboxExecutionEnvironmentProviderOptions) {
    this.id = options.id;
    if (options.backend.guarantees) this.guarantees = options.backend.guarantees;
    this.capabilities = [
      ...(options.capabilities ?? []),
      ...(options.backend.capabilities.outputFiles
        ? [{ id: "supertag.environment.output-files", version: 1 }]
        : []),
      ...(options.backend.capabilities.streamInput
        ? [{ id: "supertag.process-input-streaming", version: 1 }]
        : []),
      ...(options.backend.capabilities.streamOutput
        ? [{ id: "supertag.process-output-streaming", version: 1 }]
        : []),
    ];
  }
  async provision(
    spec: ExecutionEnvironmentSpec,
    signal?: AbortSignal,
  ): Promise<ExecutionEnvironment> {
    if (spec.profile.execution.lifetime.scope !== "attempt")
      throw new Error("Sandbox providers support only attempt-scoped environments");
    signal?.throwIfAborted();
    const supported = this.options.backend.capabilities;
    if (!supported.networkModes.includes(spec.plan.network.mode))
      throw new Error("Sandbox backend cannot enforce requested network policy");
    if (spec.plan.mounts.some((mount) => mount.readOnly) && !supported.readOnlyMounts)
      throw new Error("Sandbox backend cannot enforce read-only mounts");
    if (!supported.boundedSymlinkSafeReads)
      throw new Error("Sandbox backend must support bounded symlink-safe reads");
    const base = posix.normalize(this.options.rootDirectory ?? "/workspace/supertag");
    if (!posix.isAbsolute(base) || base === "/")
      throw new Error("Sandbox root must be an absolute non-root path");
    const root = posix.join(
      base,
      segment(spec.task.taskId),
      "attempts",
      segment(spec.task.attemptId),
    );
    const sandbox = await this.options.backend.create({
      taskId: spec.task.taskId,
      attemptId: spec.task.attemptId,
      tagId: spec.task.tag.id,
      network: spec.plan.network,
      ...(signal ? { signal } : {}),
    });
    try {
      signal?.throwIfAborted();
      await sandbox.mkdir(root);
      return new SandboxEnvironment(sandbox, root, this.options, true);
    } catch (error) {
      await terminate(sandbox);
      throw error;
    }
  }
}
/**
 * The execution environment of a sandbox the caller already created, rooted at `rootDirectory`
 * inside it, such as a Workspace checkout. Disposing it terminates the sandbox. Stopping one of
 * its processes, by kill, timeout, or cancellation, terminates only that process: the caller owns
 * the sandbox until it disposes it, for example after committing the checkout.
 */
export function sandboxExecutionEnvironment(
  sandbox: SandboxInstance,
  rootDirectory: string,
  options: SandboxExecutionEnvironmentProviderOptions,
): ExecutionEnvironment {
  const root = posix.normalize(rootDirectory);
  if (!posix.isAbsolute(root) || root === "/")
    throw new Error("Sandbox root must be an absolute non-root path");
  return new SandboxEnvironment(sandbox, root, options, false);
}
class SandboxEnvironment implements ExecutionEnvironment {
  readonly placement = "remote" as const;
  readonly id: string;
  readonly guarantees?: EnvironmentGuarantees;
  readonly provenance;
  readonly #http: EnvironmentConnections;
  readonly #inputWriters = new Set<ProcessInputWriter>();
  readonly materializeArtifactFiles?: (input: SandboxArtifactFiles) => Promise<string>;
  readonly prepareOutputDirectory?: (path: string) => Promise<void>;
  #disposed = false;
  #disposing: Promise<void> | undefined;
  #variables: Readonly<Record<string, string>> = {};
  constructor(
    readonly sandbox: SandboxInstance,
    readonly rootDirectory: string,
    readonly options: SandboxExecutionEnvironmentProviderOptions,
    /** True when stopping any process stops the whole Attempt-scoped sandbox. */
    readonly stopsSandboxWithProcess: boolean,
  ) {
    this.id = `${options.id}:${sandbox.id}`;
    this.provenance = { sandboxId: sandbox.id };
    // Present only when the backend can create directories, so callers can detect support.
    if (sandbox.prepareOutputDirectory) {
      const prepare = sandbox.prepareOutputDirectory.bind(sandbox);
      this.prepareOutputDirectory = async (path) => {
        this.resolvePath(path);
        await prepare(this.rootDirectory, path);
      };
    }
    if (sandbox.materializeArtifactFiles) {
      const materialize = sandbox.materializeArtifactFiles.bind(sandbox);
      this.materializeArtifactFiles = async (input) => {
        validateSandboxArtifactFiles(input);
        if (!/^artifact-[a-f0-9]{64}$/.test(input.directory))
          throw new Error("Invalid artifact directory");
        const directory = this.resolvePath(input.directory);
        await materialize({ ...input, directory });
        return directory;
      };
    }
    if (options.backend.guarantees) this.guarantees = options.backend.guarantees;
    this.#http = new EnvironmentConnections({
      verify: async () => {
        if (!sandbox.requestHttp) throw new Error("Sandbox backend does not support scoped HTTP");
      },
      request: async (_process, port, request, limits, signal) => {
        if (!sandbox.requestHttp) throw new Error("Sandbox backend does not support scoped HTTP");
        let abort!: () => void;
        let stopping: Promise<void> | undefined;
        const stopped = new Promise<never>((_resolve, reject) => {
          abort = () => {
            stopping ??= this.#stopSandbox();
            void stopping.then(() => reject(signal.reason), reject);
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        try {
          const response = await Promise.race([
            sandbox.requestHttp(port, request, limits, signal),
            stopped,
          ]);
          if (stopping) await stopping;
          signal.throwIfAborted();
          return response;
        } catch (error) {
          if (stopping) await stopping;
          throw error;
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
    });
  }
  resolvePath(path: string): string {
    if (this.#disposed) throw new Error(`Execution Environment ${this.id} has been disposed`);
    const result = posix.resolve(this.rootDirectory, path),
      relative = posix.relative(this.rootDirectory, result);
    if (relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative))
      throw new Error(`Environment path escapes its root: ${path}`);
    return result;
  }
  async prepare(plan: EnvironmentPlan): Promise<void> {
    this.resolvePath(".");
    if (
      plan.mounts.some((mount) => mount.readOnly) &&
      !this.options.backend.capabilities.readOnlyMounts
    )
      throw new Error("Sandbox backend cannot enforce read-only mounts");
    if (plan.secretBindings.length)
      throw new Error("Sandbox preparation requires resolved Worker-local secret bindings");
    const readonlyPaths: string[] = [];
    for (const mount of plan.mounts) {
      const url = new URL(mount.source.uri);
      if (url.protocol !== "file:")
        throw new Error("Sandbox staging requires resolved file: resources");
      const destination = this.resolvePath(mount.destination);
      const source = fileURLToPath(url);
      await stage(this.sandbox, source, destination, await localResourceFilter(source), "");
      if (mount.readOnly) readonlyPaths.push(destination);
    }
    for (const file of plan.files) {
      const path = this.resolvePath(file.path);
      await this.sandbox.mkdir(posix.dirname(path));
      await this.sandbox.write(
        path,
        typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
        { exclusive: true, ...(file.mode === undefined ? {} : { mode: file.mode }) },
      );
    }
    for (const path of readonlyPaths.toReversed()) await this.sandbox.makeReadOnly(path);
    this.#variables = plan.environmentVariables;
  }
  async read(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }
  async readBytes(path: string): Promise<Uint8Array> {
    const bytes = await this.sandbox.read(this.resolvePath(path), {
      maximumBytes: MAX_ARTIFACT_BYTES,
      rejectSymlinks: true,
    });
    if (bytes.byteLength > MAX_ARTIFACT_BYTES)
      throw new Error("Sandbox read exceeds artifact bound");
    return bytes;
  }
  async listOutputFiles(query: OutputFileQuery): Promise<readonly OutputFileEntry[]> {
    if (!this.sandbox.listOutputFiles)
      throw new Error("Sandbox backend does not support output enumeration");
    for (const root of query.roots) this.resolvePath(root);
    return this.sandbox.listOutputFiles(this.rootDirectory, query);
  }
  async spawn(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessHandle> {
    if (spec.streamInput && spec.stdin !== undefined)
      throw new Error("Choose streamInput or stdin, not both");
    if (spec.streamInput && !this.options.backend.capabilities.streamInput)
      throw new Error("Sandbox backend cannot stream process input");
    if (spec.streamOutput && !this.options.backend.capabilities.streamOutput)
      throw new Error("Sandbox backend cannot stream process output");
    signal?.throwIfAborted();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const output = spec.streamOutput ? new ProcessOutputBuffer() : undefined;
    let stdout = "",
      stderr = "";
    const maximum = this.options.maxOutputCharacters ?? 32000;
    const timer =
      spec.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => controller.abort(new Error("Sandbox process timed out")),
            spec.timeoutMs,
          );
    let process: SandboxProcess;
    try {
      process = await this.sandbox.start(
        {
          ...spec,
          cwd: this.resolvePath(spec.cwd ?? "."),
          environment: spec.replaceEnvironment
            ? { ...spec.environment }
            : { ...this.#variables, ...spec.environment },
        },
        {
          signal: combined,
          onOutput: (chunk) => {
            if (chunk.stream === "stdout") stdout = (stdout + chunk.text).slice(-maximum);
            else stderr = (stderr + chunk.text).slice(-maximum);
            try {
              // Backends that await this pause at high water; others meet the hard cap.
              if (output && !output.push(chunk)) return output.drained();
            } catch (error) {
              controller.abort(error);
            }
            return undefined;
          },
        },
      );
    } catch (error) {
      clearTimeout(timer);
      if (this.stopsSandboxWithProcess) await this.dispose();
      throw error;
    }
    if (spec.streamInput && (!process.write || !process.endInput)) {
      clearTimeout(timer);
      if (this.stopsSandboxWithProcess) await this.dispose();
      else await terminateProcess(this.sandbox, process);
      throw new Error("Sandbox backend did not provide process input streaming");
    }
    const writer = spec.streamInput
      ? new ProcessInputWriter({
          write: (bytes) =>
            process.write
              ? process.write(bytes)
              : Promise.reject(new Error("Missing process input")),
          end: () =>
            process.endInput
              ? process.endInput()
              : Promise.reject(new Error("Missing process input")),
        })
      : undefined;
    if (writer) this.#inputWriters.add(writer);
    let stopping: Promise<void> | undefined;
    let rejectStopped!: (reason: unknown) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    void stopped.catch(() => {});
    // Attempt-scoped cancellation stops the whole sandbox, including descendants. A caller-owned
    // sandbox outlives its processes, so stopping one terminates only that process.
    const stop = () =>
      (stopping ??= this.stopsSandboxWithProcess
        ? this.dispose()
        : terminateProcess(this.sandbox, process));
    const abort = () => {
      writer?.revoke(combined.reason);
      void stop().then(
        () => rejectStopped(combined.reason ?? new Error("Sandbox process cancelled")),
        rejectStopped,
      );
    };
    combined.addEventListener("abort", abort, { once: true });
    if (combined.aborted) abort();
    const waiting = (async () => {
      try {
        const result = await Promise.race([process.wait(), stopped]);
        // An observed exit confirms a single process stopped, even if terminate lost the race.
        if (stopping)
          await (this.stopsSandboxWithProcess ? stopping : stopping.catch(() => undefined));
        combined.throwIfAborted();
        return {
          ...result,
          stdout: stdout || result.stdout.slice(-maximum),
          stderr: stderr || result.stderr.slice(-maximum),
        };
      } catch (error) {
        if (stopping) await stopping;
        throw error;
      } finally {
        clearTimeout(timer);
        combined.removeEventListener("abort", abort);
        writer?.revoke(new Error("Process exited"));
        if (writer) this.#inputWriters.delete(writer);
        output?.close();
      }
    })();
    void waiting.catch(() => {});
    const handle: ProcessHandle = {
      ...(process.pid === undefined ? {} : { pid: process.pid }),
      ...(output ? { output } : {}),
      ...(writer
        ? { write: (bytes: Uint8Array) => writer.write(bytes), endInput: () => writer.end() }
        : {}),
      wait: () => waiting,
      kill: () => {
        if (this.stopsSandboxWithProcess) {
          controller.abort(new Error("Sandbox process cancelled"));
          return;
        }
        // Only this process: wait() resolves with its exit once termination is confirmed, and
        // rejects with a cleanup error when the backend cannot confirm it.
        writer?.revoke(new Error("Sandbox process killed"));
        void stop().catch(rejectStopped);
      },
    };
    this.#http.register(handle);
    return handle;
  }
  connect(...args: Parameters<EnvironmentConnections["connect"]>) {
    this.resolvePath(".");
    return this.#http.connect(...args);
  }
  async dispose(): Promise<void> {
    for (const writer of this.#inputWriters) writer.revoke();
    await this.#http.close();
    await this.#stopSandbox();
  }
  async #stopSandbox(): Promise<void> {
    for (const writer of this.#inputWriters) writer.revoke();
    if (this.#disposed) return;
    this.#disposing ??= terminate(this.sandbox)
      .then(() => {
        this.#disposed = true;
      })
      .catch((error) => {
        this.#disposing = undefined;
        throw error;
      });
    await this.#disposing;
  }
}
async function stage(
  sandbox: SandboxInstance,
  source: string,
  destination: string,
  include: LocalResourceFilter | undefined,
  path: string,
): Promise<void> {
  if (include !== undefined && !include(path)) return;
  const stat = await lstat(source);
  if (stat.isSymbolicLink())
    throw new Error(`Workspace resource contains unsupported symbolic link ${source}`);
  if (stat.isDirectory()) {
    await sandbox.mkdir(destination);
    for (const name of await readdir(source))
      await stage(
        sandbox,
        join(source, name),
        posix.join(destination, name),
        include,
        childPath(path, name),
      );
    return;
  }
  if (!stat.isFile()) throw new Error("Unsupported workspace entry");
  await sandbox.mkdir(posix.dirname(destination));
  await sandbox.write(destination, await readFile(source), {
    exclusive: true,
    mode: stat.mode & 0o777,
  });
}
function segment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) || "task";
}

/** Terminates one sandbox process, never the sandbox, waiting at most 5 seconds for confirmation. */
async function terminateProcess(sandbox: SandboxInstance, process: SandboxProcess): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const confirmed = await Promise.race([
      process.terminate(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Sandbox process termination timed out")), 5000);
      }),
    ]);
    if (!confirmed) throw new Error("Sandbox process termination was not confirmed");
  } catch (cause) {
    throw new ExecutionCleanupError(
      `Sandbox ${sandbox.id} process ${process.pid ?? "(no pid)"} termination was not confirmed`,
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function terminate(sandbox: SandboxInstance): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const confirmed = await Promise.race([
      sandbox.terminate(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Sandbox termination timed out")), 5000);
      }),
    ]);
    if (!confirmed) throw new Error("Sandbox termination was not confirmed");
  } catch (cause) {
    throw new ExecutionCleanupError(`Sandbox ${sandbox.id} cleanup was not confirmed`, { cause });
  } finally {
    clearTimeout(timer);
  }
}

/** Linux/Python implementation used by the built-in E2B and Modal adapters.
 * Custom backends may implement the SandboxInstance operation without Python. */
export async function materializeSandboxArtifactFiles(
  sandbox: SandboxInstance,
  input: SandboxArtifactFiles,
): Promise<void> {
  validateSandboxArtifactFiles(input);
  if (
    !posix.isAbsolute(input.directory) ||
    !/^artifact-[a-f0-9]{64}$/.test(posix.basename(input.directory))
  )
    throw new Error("Invalid artifact directory");
  const process = await sandbox.start(
    {
      command: "python3",
      args: ["-c", SANDBOX_ARTIFACT_FILES_HELPER, input.directory],
      stdin: JSON.stringify(
        input.files.map((file) => ({
          path: file.path,
          data: Buffer.from(file.bytes).toString("base64"),
        })),
      ),
      timeoutMs: 30000,
    },
    { onOutput() {} },
  );
  const result = await process.wait();
  if (result.exitCode !== 0)
    throw new Error(
      "Artifact materialization failed; partial directory is preserved and cannot be overwritten",
    );
}
function validateSandboxArtifactFiles(input: SandboxArtifactFiles): void {
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 100)
    throw new Error("Artifact materialization requires 1 through 100 files");
  const paths = new Set<string>();
  let total = 0;
  for (const file of input.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      file.path.length > 1024 ||
      /[\\:]/.test(file.path) ||
      [...file.path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      file.path.split("/").some((part: string) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid artifact file path");
    if (
      paths.has(file.path) ||
      [...paths].some(
        (path) => path.startsWith(`${file.path}/`) || file.path.startsWith(`${path}/`),
      )
    )
      throw new Error("Artifact file paths overlap");
    paths.add(file.path);
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > MAX_ARTIFACT_BYTES)
      throw new Error("Artifact file exceeds byte limit");
    total += file.bytes.byteLength;
    if (total > 64 * 1024 * 1024)
      throw new Error("Artifact materialization exceeds total byte limit");
  }
}
const SANDBOX_ARTIFACT_FILES_HELPER = `import os, sys, json, base64, re
path = sys.argv[1]
parts = path.split("/")
if not path.startswith("/") or any(p in (".", "..") for p in parts): raise ValueError("invalid destination")
parts = [p for p in parts if p]
if not parts or not re.fullmatch(r"artifact-[a-f0-9]{64}", parts[-1]): raise ValueError("invalid destination")
raw = sys.stdin.buffer.read(90 * 1024 * 1024 + 1)
if len(raw) > 90 * 1024 * 1024: raise ValueError("too much input")
files = json.loads(raw)
if not isinstance(files, list) or not 1 <= len(files) <= 100: raise ValueError("invalid files")
seen, decoded, total = set(), [], 0
for item in files:
 name = item["path"]
 if not isinstance(name, str) or len(name) > 1024 or any(not p or p in (".", "..") for p in name.split("/")) or any(ord(c) < 32 or ord(c) == 127 or c in ":" + chr(92) for c in name): raise ValueError("invalid file path")
 if name in seen or any(name.startswith(p + "/") or p.startswith(name + "/") for p in seen): raise ValueError("overlapping paths")
 seen.add(name)
 data = base64.b64decode(item["data"], validate=True)
 total += len(data)
 if len(data) > 32 * 1024 * 1024 or total > 64 * 1024 * 1024: raise ValueError("too many bytes")
 decoded.append((name, data))
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
try:
 for part in parts[:-1]:
  next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
  os.close(fd)
  fd = next_fd
 os.mkdir(parts[-1], 0o700, dir_fd=fd)
 root = os.open(parts[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
 try:
  for name, data in decoded:
   parent = os.dup(root)
   try:
    segments = name.split("/")
    for segment in segments[:-1]:
     try: os.mkdir(segment, 0o700, dir_fd=parent)
     except FileExistsError: pass
     next_fd = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
     os.close(parent)
     parent = next_fd
    out = os.open(segments[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    with os.fdopen(out, "wb") as target: target.write(data)
   finally: os.close(parent)
 finally: os.close(root)
finally: os.close(fd)
`;

/** Built-in Linux adapters use Python; custom providers implement the same bounded manifest operation. */
export async function listSandboxOutputFiles(
  sandbox: SandboxInstance,
  root: string,
  query: OutputFileQuery,
): Promise<readonly OutputFileEntry[]> {
  const process = await sandbox.start(
    {
      command: "python3",
      args: ["-c", SANDBOX_OUTPUT_LIST_HELPER, root],
      stdin: JSON.stringify(query),
      timeoutMs: 30000,
    },
    { onOutput() {} },
  );
  const result = await process.wait();
  if (result.exitCode !== 0) throw new Error("Sandbox output enumeration failed");
  const entries: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(entries) || entries.length > query.maxFiles)
    throw new Error("Invalid sandbox output manifest");
  return entries.map((entry: { path: unknown; sizeBytes: unknown }) => {
    if (
      typeof entry.path !== "string" ||
      entry.path.startsWith("/") ||
      entry.path.split("/").some((p) => !p || p === ".." || p === ".") ||
      typeof entry.sizeBytes !== "number" ||
      entry.sizeBytes < 0 ||
      !Number.isSafeInteger(entry.sizeBytes)
    )
      throw new Error("Invalid sandbox output manifest entry");
    return { path: entry.path, sizeBytes: entry.sizeBytes };
  });
}
const SANDBOX_OUTPUT_LIST_HELPER = `import os,sys,json,stat,re
root=sys.argv[1]; query=json.load(sys.stdin); entries={}; visited=0
excluded=re.compile(r"^(?:\\.git|node_modules|\\.venv|venv|__pycache__|\\.cache|inputs|\\.ssh|\\.aws|\\.gnupg|\\.supertag|artifact-[a-f0-9]{64}|\\.env(?:\\..*)?)$|.*\\.(?:pem|key|p12|pfx)$")
def matches(path,pattern):
 expression=''; i=0
 while i<len(pattern):
  c=pattern[i]
  if c=='*' and i+1<len(pattern) and pattern[i+1]=='*':
   i+=1
   if i+1<len(pattern) and pattern[i+1]=='/': i+=1; expression+='(?:.*/)?'
   else: expression+='.*'
  elif c=='*': expression+='[^/]*'
  elif c=='?': expression+='[^/]'
  else: expression+=re.escape(c)
  i+=1
 return re.fullmatch(expression,path) is not None
def may_contain(path,pattern):
 parts=path.split('/'); segments=pattern.split('/')
 for i,part in enumerate(parts):
  if i>=len(segments): return False
  if '**' in segments[i]: return True
  if not matches(part,segments[i]): return False
 return len(parts)<len(segments)
def visit(path,selected_root):
 global visited
 selected_path='' if path==selected_root else path[len(selected_root)+(1 if selected_root else 0):]
 if selected_path:
  if any(matches(selected_path,p) or matches(selected_path+'/',p) for p in query.get('exclude',[])): return
  if 'include' in query and not any(matches(selected_path,p) or may_contain(selected_path,p) for p in query['include']): return
 visited+=1
 if visited>query['maxFiles']*4+1000: raise ValueError('entry limit')
 parts=path.split('/') if path else []
 if any(p in ('.','..','') for p in parts): raise ValueError('invalid root')
 if any(excluded.match(p) for p in parts): return
 target=root
 for p in parts:
  target=os.path.join(target,p)
  if not os.path.lexists(target): return
  if stat.S_ISLNK(os.lstat(target).st_mode): raise ValueError('symlink')
 s=os.lstat(target)
 if stat.S_ISDIR(s.st_mode):
  for name in sorted(os.listdir(target)):
   if not excluded.match(name): visit(path+'/'+name if path else name,selected_root)
 elif stat.S_ISREG(s.st_mode):
  if 'include' in query and not any(matches(selected_path,p) for p in query['include']): return
  entries[path]={'path':path,'sizeBytes':s.st_size}
  if len(entries)>query['maxFiles']: raise ValueError('file limit')
 else: raise ValueError('not regular')
for path in query['roots']: visit(path,path)
print(json.dumps(list(entries.values())))
`;

export async function prepareSandboxOutputDirectory(
  sandbox: SandboxInstance,
  root: string,
  path: string,
): Promise<void> {
  const process = await sandbox.start(
    {
      command: "python3",
      args: ["-c", SANDBOX_OUTPUT_DIRECTORY_HELPER, root, path],
      timeoutMs: 30000,
    },
    { onOutput() {} },
  );
  if ((await process.wait()).exitCode !== 0)
    throw new Error("Sandbox output directory preparation failed");
}
const SANDBOX_OUTPUT_DIRECTORY_HELPER = `import os,sys
root,path=sys.argv[1:]
parts=path.split('/')
if any(not p or p in ('.','..') or ':' in p or chr(92) in p for p in parts): raise ValueError('invalid output directory')
fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts:
  try: os.mkdir(part,0o700,dir_fd=fd)
  except FileExistsError: pass
  child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  os.close(fd); fd=child
finally: os.close(fd)
`;
