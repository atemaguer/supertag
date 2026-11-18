/**
 * A sandbox provider on a local container runtime (Docker, Podman, or a compatible CLI): the
 * `local-vm` environment's provider, and the reference provider the conformance suite runs
 * against (docs/reference/sandbox-providers.md).
 *
 * Each sandbox is a container with no network, labelled with its owner, whose first process
 * ends at the requested lifetime. Task processes run as the image's unprivileged user, with no
 * capability and no way to gain one. The seal, Capture, and the egress relay run as root through
 * the runtime's own exec, holding only the few capabilities the container keeps for root
 * (`ROOT_CAPABILITIES`), never `--privileged`.
 *
 * Root runs only programs the Workspace user cannot change: at allocation the provider refuses
 * the container when that user can write the interpreter root runs, anything it maps or imports,
 * or a directory on the way to them. It also refuses one holding a setuid or setgid program that
 * user can run, which would hand a Task another identity even without new privileges. With that, the seal is a boundary here: the Task can neither
 * replace the program that stops it nor hide from it. Snapshots are `<runtime> commit` images. A
 * devcontainer's image and layers are built with an empty context, on the host's native platform.
 *
 * The Workspace user's operations go through one long-lived exec server per container
 * (exec-server.ts), started after the process record, so the seal stops it like any Task
 * process; a stopped server is replaced on the next operation.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  listSandboxOutputFiles,
  materializeSandboxArtifactFiles,
  type ProcessSpec,
  prepareSandboxOutputDirectory,
  type SandboxInstance,
  sandboxExecutionEnvironment,
} from "../index.js";
import {
  createEgressRelayHost,
  EGRESS_RELAY_PROGRAM,
  type EgressRelayHost,
} from "./egress-relay.js";
import {
  CAPABILITY_DROP_THEN_EXEC,
  createExecServer,
  EXEC_SERVER_PROGRAM,
  type ExecServer,
} from "./exec-server.js";
import {
  BUILD_TIMEOUT_MS,
  createSandboxWorkspaceSession,
  EGRESS_CLIENT_PORT,
  egressProxy,
  type SandboxEgress,
  type SandboxEnvironment,
  type SandboxOwner,
  type SandboxStopResult,
  type SandboxWorkspace,
  type SandboxWorkspaceProvider,
  type SandboxWorkspaceSession,
} from "./session.js";

const MAX_LIFETIME_MS = 3_600_000;

export interface ContainerProviderOptions {
  /**
   * An image with `python3`, `git`, `/bin/sh`, and an unprivileged `user`: a name, or a
   * Dockerfile with no build context, built on the first allocation that needs it.
   */
  readonly image: string | { readonly dockerfile: string };
  readonly user: string;
  readonly runtime?: string;
  /** The label every owned container carries, so discovery finds only this provider's. */
  readonly label?: string;
  /** `linux/arm64` or `linux/amd64`: always the host's own, never an emulated one. */
  readonly platform?: string;
  /** Builds devcontainer images; a reference provider leaves it off and refuses them. */
  readonly buildImages?: boolean;
  /** The provider's name in messages. */
  readonly name?: string;
  /** Extra `run` flags, such as resource limits. */
  readonly runFlags?: readonly string[];
  /** Progress lines for a long step, such as an image build. */
  readonly log?: (line: string) => void;
  /**
   * Keeps a dependency cache volume per Workspace and Tag (the allocation's `dependencyCache`),
   * at `/supertag/cache`, for package managers' downloads.
   */
  readonly dependencyCaches?: boolean;
  /**
   * Serves the Workspace user's processes from one long-lived exec per container instead of an
   * exec each (see exec-server.ts); on by default.
   */
  readonly execServer?: boolean;
  /**
   * The Worker Host's Codex version, for a Codex host: every image this provider runs gets a
   * last layer installing exactly that `codex` (see `codexLayer`), so its sandboxes can run
   * Codex's exec-server.
   */
  readonly codexVersion?: string;
}

/**
 * Installs one Codex release from npm's Linux package for the image's architecture into
 * `/usr/local/bin/codex`, owned by root: the release's metadata names its tarball and SHA-512,
 * and the tarball must match.
 */
const CODEX_INSTALL = `import base64, hashlib, io, json, os, platform, sys, tarfile, urllib.request
version = sys.argv[1]
arch, triple = {"aarch64": ("arm64", "aarch64"), "x86_64": ("x64", "x86_64")}[platform.machine()]
registry = "https://registry.npmjs.org/@openai/codex/"
with urllib.request.urlopen(f"{registry}{version}-linux-{arch}", timeout=60) as answer:
    dist = json.load(answer)["dist"]
algorithm, _, digest = dist["integrity"].partition("-")
if algorithm != "sha512" or not dist["tarball"].startswith(registry):
    sys.exit("unexpected Codex package metadata")
with urllib.request.urlopen(dist["tarball"], timeout=600) as answer:
    data = answer.read()
if base64.b64encode(hashlib.sha512(data).digest()).decode() != digest:
    sys.exit("the Codex package does not match its integrity")
member = f"package/vendor/{triple}-unknown-linux-musl/bin/codex"
binary = tarfile.open(fileobj=io.BytesIO(data)).extractfile(member).read()
with open("/usr/local/bin/codex", "wb") as target:
    target.write(binary)
os.chmod("/usr/local/bin/codex", 0o755)
`;

/** A Codex version as `codex --version` prints it, without its `codex-cli ` prefix. */
export function validCodexVersion(version: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]{1,32})?$/u.test(version);
}

/** A last image layer installing Codex `version` on `image`, ending as `user` again. */
export function codexLayer(image: string, user: string, version: string): string {
  if (!validCodexVersion(version)) throw new Error("The Codex version is invalid");
  return [
    `FROM ${image}`,
    "USER root",
    `RUN ${JSON.stringify(["python3", "-I", "-S", "-c", CODEX_INSTALL, version])}`,
    `USER ${user}`,
    "",
  ].join("\n");
}

/** Where a dependency cache volume is mounted, and what points package managers at it. */
export const DEPENDENCY_CACHE = "/supertag/cache";
const CACHE_LABEL = "supertag.local-vm.cache";
/** A cache volume older than this is removed when no container uses it. */
const CACHE_MAX_AGE_MS = 14 * 24 * 3_600_000;
/** At most this many cache volumes stay; the oldest unused ones go first. */
const MAX_CACHES = 64;
export const DEPENDENCY_CACHE_VARIABLES: Readonly<Record<string, string>> = {
  npm_config_cache: `${DEPENDENCY_CACHE}/npm`,
  npm_config_store_dir: `${DEPENDENCY_CACHE}/pnpm`,
  YARN_CACHE_FOLDER: `${DEPENDENCY_CACHE}/yarn`,
  PIP_CACHE_DIR: `${DEPENDENCY_CACHE}/pip`,
  UV_CACHE_DIR: `${DEPENDENCY_CACHE}/uv`,
  GOMODCACHE: `${DEPENDENCY_CACHE}/go/mod`,
  GOCACHE: `${DEPENDENCY_CACHE}/go/build`,
};

/** The allocation limit when the provider's own image may be built first. */
export const CONTAINER_ALLOCATE_TIMEOUT_MS = BUILD_TIMEOUT_MS;

/**
 * What root keeps in the container: stopping the Task's processes, reading and returning its
 * files. Only root holds them; a Task process, never root and unable to gain privileges, holds
 * none.
 */
export const ROOT_CAPABILITIES = ["KILL", "DAC_OVERRIDE", "DAC_READ_SEARCH", "CHOWN", "FOWNER"];

/**
 * Run as the Workspace user right after the container starts, with the image's `python3`: prints
 * the interpreter's real path, then every path root would run or read that this user can write.
 * Covered: `/usr/bin/env`, the PATH root uses, every file the interpreter maps (itself, its
 * libraries, the dynamic loader), the loader's configuration, every module directory of an
 * isolated interpreter, recursively, `git` (which Capture runs as root) with its helpers and
 * libraries, and every directory on the way to each of them.
 */
export const WRITABLE_ROOT_PROGRAMS = `import os, sys
seen = set()
found = []
def check(path):
    path = os.path.abspath(path)
    while path not in seen:
        seen.add(path)
        # A link itself cannot be changed, only replaced through its directory; its target can.
        if os.path.islink(path):
            check(os.path.join(os.path.dirname(path), os.readlink(path)))
        elif os.path.exists(path) and os.access(path, os.W_OK):
            found.append(path)
        parent = os.path.dirname(path)
        if parent == path:
            break
        path = parent
def tree(root):
    check(root)
    for directory, names, files in os.walk(root):
        for name in names + files:
            check(os.path.join(directory, name))
interpreter = os.path.realpath(sys.executable)
print(interpreter)
for path in ["/usr/bin/env", "/usr/local/bin", "/usr/bin", "/bin", "/etc/ld.so.preload",
             "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d", sys.executable]:
    check(path)
with open("/proc/self/maps") as maps:
    for line in maps:
        fields = line.split(None, 5)
        if len(fields) == 6 and fields[5].startswith("/"):
            check(fields[5].strip())
for entry in sys.path:
    if entry and os.path.isdir(entry):
        tree(entry)
    elif entry:
        check(entry)
# Capture runs git as root: the binary, its helpers, and everything it maps.
import shutil, subprocess
git = shutil.which("git", path="/usr/local/bin:/usr/bin:/bin")
if git:
    check(git)
    helpers = subprocess.run([git, "--exec-path"], capture_output=True, text=True).stdout.strip()
    if helpers.startswith("/") and os.path.isdir(helpers):
        tree(helpers)
    with subprocess.Popen([git, "cat-file", "--batch"], stdin=subprocess.PIPE,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as running:
        try:
            # Let the loader map git's libraries before reading what it mapped.
            __import__("time").sleep(0.3)
            with open("/proc/%d/maps" % running.pid) as maps:
                for line in maps:
                    fields = line.split(None, 5)
                    if len(fields) == 6 and fields[5].startswith("/"):
                        check(fields[5].strip())
        finally:
            running.stdin.close()
for path in found[:20]:
    print("writable " + path)
# A setuid or setgid program the Workspace user can run would give a Task process another user's
# identity, root's above all, and with it the power to stop the seal. The container's own
# filesystem is walked; /proc, /sys, /dev, and other mounts, such as a cache volume, are not.
import stat
root_device = os.lstat("/").st_dev
privileged = []
for directory, names, files in os.walk("/", onerror=lambda error: None):
    if directory in ("/proc", "/sys", "/dev"):
        names[:] = []
        continue
    names[:] = [name for name in names
                if os.lstat(os.path.join(directory, name)).st_dev == root_device]
    for name in files:
        path = os.path.join(directory, name)
        try:
            info = os.lstat(path)
        except OSError:
            continue
        if (stat.S_ISREG(info.st_mode) and info.st_mode & (stat.S_ISUID | stat.S_ISGID)
                and os.access(path, os.X_OK)):
            privileged.append(path)
for path in privileged[:20]:
    print("setuid " + path)`;

/**
 * An image ID as the runtime reports it: Docker prefixes `sha256:`, Podman gives the bare digest.
 * Either runs as reported.
 */
const IMAGE_ID = /^(sha256:)?[0-9a-f]{64}$/u;

/** The host's own Linux platform, so a container never runs under emulation. */
export function nativePlatform(): string {
  return `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`;
}

interface Ran {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the container runtime's CLI. Never through a shell: arguments pass exactly. */
function cli(
  runtime: string,
  args: readonly string[],
  options: { input?: Uint8Array; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.end(options.input ?? new Uint8Array());
  });
}

function labels(owner: SandboxOwner, label: string): Record<string, string> {
  if (
    owner.hostGeneration < 1n ||
    [owner.hostId, owner.taskId, owner.attemptId, owner.allocationId].some(
      (value) => !value || value.length > 256 || /\p{Cc}/u.test(value),
    )
  )
    throw new Error("Invalid sandbox ownership");
  return {
    [label]: "1",
    "supertag.hostId": owner.hostId,
    "supertag.hostGeneration": owner.hostGeneration.toString(),
    "supertag.taskId": owner.taskId,
    "supertag.attemptId": owner.attemptId,
    "supertag.allocationId": owner.allocationId,
  };
}

/** Bounded, symlink-refusing read of one regular file, printed as base64. */
const BOUNDED_READ = `import base64, os, stat, sys
limit = int(sys.argv[2])
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
try:
    for part in [p for p in sys.argv[1].split("/") if p]:
        if part in (".", ".."): raise ValueError("invalid path")
        next_fd = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError("not a regular file")
    data = os.read(fd, limit + 1)
    if len(data) > limit: raise ValueError("too large")
    sys.stdout.write(base64.b64encode(data).decode("ascii"))
finally:
    os.close(fd)
`;

/** Writes stdin to one file without following links; exclusive refuses an existing one. */
const SAFE_WRITE = `import os, sys
parts = [p for p in sys.argv[1].split("/") if p]
if not parts or any(p in (".", "..") for p in parts): raise ValueError("invalid path")
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
try:
    for part in parts[:-1]:
        next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
    flags |= os.O_EXCL if sys.argv[3] == "true" else os.O_TRUNC
    out = os.open(parts[-1], flags, int(sys.argv[2]), dir_fd=fd)
    with os.fdopen(out, "wb") as target:
        target.write(sys.stdin.buffer.read())
finally:
    os.close(fd)
`;

/**
 * A devcontainer's Dockerfile: its image and layers, or the provider's image with only a user.
 * Refuses COPY and ADD: the build context is empty, and a layer may name no host file.
 */
export function containerDockerfile(environment: SandboxEnvironment, image: string): string {
  if (environment.image === undefined && environment.dockerfileCommands.length === 0) return "";
  if (environment.dockerfileCommands.some((line) => /^\s*(COPY|ADD)\b/iu.test(line)))
    throw new Error("A devcontainer layer may not copy files into the image");
  return `${[`FROM ${environment.image ?? image}`, ...environment.dockerfileCommands].join("\n")}\n`;
}

export function createContainerWorkspaceSession(
  options: ContainerProviderOptions,
): SandboxWorkspaceSession {
  return createSandboxWorkspaceSession(
    containerSandboxProvider(options),
    typeof options.image === "string" ? {} : { allocateTimeoutMs: CONTAINER_ALLOCATE_TIMEOUT_MS },
  );
}

/** The provider under the session, for a test that allocates a container directly. */
export function containerSandboxProvider(
  options: ContainerProviderOptions,
): SandboxWorkspaceProvider {
  const runtime = options.runtime ?? "docker";
  const label = options.label ?? "supertag.container";
  const platform = options.platform ?? nativePlatform();
  const exec = (
    id: string,
    argv: readonly string[],
    rest: {
      privileged?: boolean;
      input?: Uint8Array;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ) =>
    cli(
      runtime,
      [
        "exec",
        "-i",
        // The container drops every capability, so the seal and Capture, which must stop and
        // read the Task's processes and files, get them back here, for this one process only.
        // Root holds only the capabilities the container keeps; every other process runs as
        // the container's own unprivileged user, with none.
        ...(rest.privileged ? ["-u", "0"] : []),
        "-w",
        "/tmp",
        id,
        ...argv,
      ],
      rest,
    );

  /** Each container's exec server, started on the first operation after allocation. */
  const servers = new Map<string, ExecServer>();
  /** Each container's interpreter, checked at allocation. */
  const interpreters = new Map<string, string>();

  /**
   * A Task command outside the exec server: it starts with every capability set empty, as one
   * the server starts does, whatever the runtime handed the Workspace user.
   */
  function withoutCapabilities(id: string, argv: readonly string[]): string[] {
    const interpreter = interpreters.get(id);
    if (!interpreter) throw new Error("Container interpreter is unknown");
    return [interpreter, "-I", "-S", "-c", CAPABILITY_DROP_THEN_EXEC, ...argv];
  }

  /**
   * Runs `argv` as the Workspace user: through the container's exec server when one runs, so it
   * costs a line each way, or through an exec of its own.
   */
  async function userRun(
    id: string,
    argv: readonly string[],
    rest: { input?: Uint8Array; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Ran> {
    const server = servers.get(id);
    if (server) {
      rest.signal?.throwIfAborted();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const process = await server.spawn(
        { argv, cwd: "/tmp", ...(rest.input ? { stdin: rest.input } : {}) },
        (stream, bytes) => (stream === "stdout" ? stdout : stderr).push(Buffer.from(bytes)),
      );
      if (process) {
        const timer = rest.timeoutMs ? setTimeout(() => process.kill(), rest.timeoutMs) : undefined;
        const abort = () => process.kill();
        rest.signal?.addEventListener("abort", abort, { once: true });
        try {
          const exitCode = await process.exited;
          rest.signal?.throwIfAborted();
          return {
            exitCode,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          };
        } finally {
          clearTimeout(timer);
          rest.signal?.removeEventListener("abort", abort);
        }
      }
    }
    return exec(id, withoutCapabilities(id, argv), rest);
  }

  /** The container's owner labels, or undefined when the runtime reports it absent. */
  async function inspect(id: string): Promise<Record<string, string> | undefined> {
    const result = await cli(runtime, ["inspect", "--format", "{{json .Config.Labels}}", id]);
    if (result.exitCode !== 0) {
      if (/no such (object|container)/iu.test(result.stderr)) return undefined;
      throw new Error("Container could not be inspected");
    }
    return JSON.parse(result.stdout) as Record<string, string>;
  }

  function instance(id: string): SandboxInstance {
    const sandbox: SandboxInstance = {
      id,
      prepareOutputDirectory: (root, path) => prepareSandboxOutputDirectory(sandbox, root, path),
      listOutputFiles: (root, query) => listSandboxOutputFiles(sandbox, root, query),
      materializeArtifactFiles: (input) => materializeSandboxArtifactFiles(sandbox, input),
      async mkdir(path) {
        if ((await userRun(id, ["mkdir", "-p", "--", path])).exitCode !== 0)
          throw new Error("Directory could not be made");
      },
      async write(path, bytes, write) {
        const result = await userRun(
          id,
          [
            "python3",
            "-I",
            "-S",
            "-c",
            SAFE_WRITE,
            path,
            String(write.mode ?? 0o600),
            String(write.exclusive),
          ],
          { input: bytes },
        );
        if (result.exitCode !== 0) throw new Error("File could not be written safely");
      },
      async read(path, read) {
        const result = await userRun(id, [
          "python3",
          "-I",
          "-S",
          "-c",
          BOUNDED_READ,
          path,
          String(read.maximumBytes),
        ]);
        if (result.exitCode !== 0)
          throw new Error("Output must be a bounded regular file without symbolic links");
        return new Uint8Array(Buffer.from(result.stdout, "base64"));
      },
      async makeReadOnly(path) {
        if ((await userRun(id, ["chmod", "-R", "a-w", "--", path])).exitCode !== 0)
          throw new Error("Path could not be made read-only");
      },
      async start(spec: ProcessSpec, start) {
        // Defined first: output can arrive with the server's reply that the process started.
        let stdoutText = "";
        let stderrText = "";
        const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
        const decode = async (stream: "stdout" | "stderr", bytes: Uint8Array) => {
          const text = decoders[stream].decode(bytes, { stream: true });
          if (!text) return;
          if (stream === "stdout") stdoutText += text;
          else stderrText += text;
          await start.onOutput({ stream, text });
        };
        const served = await servers.get(id)?.spawn(
          {
            argv: [spec.command, ...(spec.args ?? [])],
            cwd: spec.cwd ?? "/tmp",
            environment: spec.environment ?? {},
            replaceEnvironment: spec.replaceEnvironment === true,
            ...(spec.stdin === undefined ? {} : { stdin: new TextEncoder().encode(spec.stdin) }),
            streamInput: spec.streamInput === true,
          },
          (stream, bytes) => void decode(stream, bytes),
        );
        if (served) {
          start.signal?.addEventListener("abort", () => served.kill(), { once: true });
          return {
            ...(served.pid === undefined ? {} : { pid: served.pid }),
            ...(spec.streamInput
              ? {
                  write: (bytes: Uint8Array) => served.write(bytes),
                  endInput: async () => served.endInput(),
                }
              : {}),
            async wait() {
              const exitCode = await served.exited;
              return { exitCode, stdout: stdoutText, stderr: stderrText };
            },
            async terminate() {
              served.kill();
              return true;
            },
          };
        }
        const environment = Object.entries(spec.environment ?? {}).map(([k, v]) => `${k}=${v}`);
        const argv = spec.replaceEnvironment
          ? ["/usr/bin/env", "-i", ...environment, spec.command, ...(spec.args ?? [])]
          : [spec.command, ...(spec.args ?? [])];
        const child = spawn(
          runtime,
          [
            "exec",
            "-i",
            "-w",
            spec.cwd ?? "/tmp",
            ...(spec.replaceEnvironment ? [] : environment.flatMap((value) => ["-e", value])),
            id,
            ...withoutCapabilities(id, argv),
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        child.stdin.on("error", () => {});
        let stdout = "";
        let stderr = "";
        const forward = (stream: "stdout" | "stderr") => async (text: string) => {
          if (stream === "stdout") stdout += text;
          else stderr += text;
          await start.onOutput({ stream, text });
        };
        child.stdout.setEncoding("utf8").on("data", forward("stdout"));
        child.stderr.setEncoding("utf8").on("data", forward("stderr"));
        const done = new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
        else if (!spec.streamInput) child.stdin.end();
        start.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
        return {
          ...(child.pid === undefined ? {} : { pid: child.pid }),
          ...(spec.streamInput
            ? {
                write: (bytes: Uint8Array) =>
                  new Promise<void>((resolve, reject) =>
                    child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())),
                  ),
                endInput: async () => {
                  child.stdin.end();
                },
              }
            : {}),
          async wait() {
            return { exitCode: await done, stdout, stderr };
          },
          async terminate() {
            return child.kill("SIGKILL");
          },
        };
      },
      async terminate() {
        return (await cli(runtime, ["rm", "-f", id])).exitCode === 0;
      },
    };
    return sandbox;
  }

  interface Built {
    /** The name a later Dockerfile starts `FROM`. */
    readonly tag: string;
    /** The image ID a container runs, so a retagged name changes nothing already built. */
    readonly id: string;
  }
  const builds = new Map<string, Promise<Built>>();

  async function imageId(reference: string): Promise<string | undefined> {
    const found = await cli(runtime, ["image", "inspect", "--format", "{{.Id}}", reference]);
    const id = found.stdout.trim();
    return found.exitCode === 0 && IMAGE_ID.test(id) ? id : undefined;
  }

  /**
   * Builds an image once per Dockerfile and platform, from a context holding the Dockerfile
   * alone, so no host file can enter the image. A build an earlier run left is reused by its tag.
   */
  function build(dockerfile: string, signal: AbortSignal): Promise<Built> {
    const tag = `supertag-workspace:${createHash("sha256")
      .update(`${platform}\n${dockerfile}`)
      .digest("hex")
      .slice(0, 32)}`;
    let pending = builds.get(tag);
    if (pending === undefined) {
      pending = (async () => {
        const existing = await imageId(tag);
        if (existing !== undefined) return { tag, id: existing };
        options.log?.(`Building the Workspace image ${tag} for ${platform}; this runs once.`);
        // The context is a new directory holding only the Dockerfile: every runtime reads that,
        // where Podman and Apple's `container` do not read a Dockerfile from standard input.
        const context = await mkdtemp(join(tmpdir(), "supertag-image-"));
        let built: Ran;
        try {
          await writeFile(join(context, "Dockerfile"), dockerfile, { mode: 0o600 });
          built = await cli(
            runtime,
            [
              "build",
              "--platform",
              platform,
              "-t",
              tag,
              "-f",
              join(context, "Dockerfile"),
              context,
            ],
            { signal, timeoutMs: BUILD_TIMEOUT_MS },
          );
        } finally {
          await rm(context, { recursive: true, force: true });
        }
        const id = built.exitCode === 0 ? await imageId(tag) : undefined;
        if (id === undefined) {
          // The operator's own image definition: its build output may name what went wrong.
          options.log?.(
            `The Workspace image ${tag} could not be built: ${built.stderr.trim().slice(-2_000)}`,
          );
          throw new Error("The Workspace image could not be built");
        }
        options.log?.(`Built the Workspace image ${tag} as ${id}.`);
        return { tag, id };
      })();
      builds.set(tag, pending);
      pending.catch(() => builds.delete(tag));
    }
    return pending;
  }

  const relays = new Map<string, EgressRelayHost>();

  /**
   * Starts the egress relay in the container as one long-lived exec, as root, so no Task
   * process can signal or replace it. Its standard input and output carry
   * every Task connection to the Attempt's egress proxy on this host; the container keeps no
   * network. It starts before the session records the container's processes, so the seal spares it.
   */
  async function startEgressRelay(
    id: string,
    egress: SandboxEgress,
    interpreter: string,
  ): Promise<EgressRelayHost> {
    const proxy = egressProxy(egress);
    if (!proxy) throw new Error("Container egress proxy is invalid");
    const child = spawn(
      runtime,
      [
        "exec",
        "-i",
        "-u",
        "0",
        id,
        "/usr/bin/env",
        "-i",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        // The interpreter checked at allocation, never a name a writable PATH entry could shadow.
        interpreter,
        "-I",
        "-S",
        "-c",
        EGRESS_RELAY_PROGRAM,
        String(EGRESS_CLIENT_PORT),
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    child.stdin.on("error", () => {});
    const host = createEgressRelayHost(
      {
        write: (line) =>
          new Promise<void>((resolve, reject) =>
            child.stdin.write(line, (error) => (error ? reject(error) : resolve())),
          ),
        abort: () => child.kill("SIGKILL"),
      },
      proxy,
    );
    child.stdout.setEncoding("utf8").on("data", (text: string) => host.receive(text));
    child.once("close", () => host.close());
    child.once("error", () => host.close());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        host.started,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Container egress relay did not start")),
            30_000,
          );
        }),
      ]);
    } catch (error) {
      host.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return host;
  }

  /**
   * Removes cache volumes no container uses that are older than `CACHE_MAX_AGE_MS`, or beyond
   * the newest `MAX_CACHES`. A volume in use refuses removal, which is fine.
   */
  async function pruneCaches(): Promise<void> {
    try {
      const listed = await cli(runtime, [
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=${CACHE_LABEL}=1`,
      ]);
      const names = listed.stdout
        .split("\n")
        .filter((name) => /^supertag-cache-[0-9a-f]{40}$/u.test(name));
      if (listed.exitCode !== 0 || names.length === 0) return;
      const inspected = await cli(runtime, [
        "volume",
        "inspect",
        "--format",
        "{{.Name}} {{.CreatedAt}}",
        ...names,
      ]);
      const volumes = inspected.stdout
        .split("\n")
        .map((line) => {
          const [name, ...created] = line.split(" ");
          return { name: name ?? "", created: Date.parse(created.slice(0, 2).join("T")) };
        })
        .filter(({ name, created }) => names.includes(name) && Number.isFinite(created))
        .sort((a, b) => b.created - a.created);
      const now = Date.now();
      const stale = volumes.filter(
        ({ created }, index) => index >= MAX_CACHES || now - created > CACHE_MAX_AGE_MS,
      );
      if (stale.length > 0) await cli(runtime, ["volume", "rm", ...stale.map(({ name }) => name)]);
    } catch {
      /* the next allocation tries again */
    }
  }

  /** The provider's own image, built first when it is a Dockerfile. */
  async function base(signal: AbortSignal): Promise<Built> {
    if (typeof options.image !== "string") return build(options.image.dockerfile, signal);
    return { tag: options.image, id: options.image };
  }

  /** The image a container runs: a snapshot, a devcontainer build, or the provider's own. */
  async function image(
    environment: SandboxEnvironment | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const own = await base(signal);
    const dockerfile = environment ? containerDockerfile(environment, own.tag) : "";
    if (dockerfile !== "" && !options.buildImages) throw new Error("This provider builds no image");
    const built = dockerfile === "" ? own : await build(dockerfile, signal);
    if (options.codexVersion === undefined) return built.id;
    const user = environment?.user || options.user;
    return (await build(codexLayer(built.tag, user, options.codexVersion), signal)).id;
  }

  return {
    label: options.name ?? "Container",
    validateOwner: (owner) => void labels(owner, label),
    async allocate(owner, timeoutMs, signal, environment, artifact, egress, dependencyCache) {
      // Every process but the seal's runs as this user; a devcontainer's `user` replaces it.
      const user = environment?.user || options.user;
      const runs = artifact ?? (await image(environment, signal));
      const owned = labels(owner, label);
      const seconds = Math.ceil(Math.min(timeoutMs, MAX_LIFETIME_MS) / 1000);
      // One cache per Workspace and Tag, image, and platform: another image's packages or
      // platform's binaries never mix in.
      const cache =
        options.dependencyCaches && dependencyCache
          ? `supertag-cache-${createHash("sha256")
              .update(`${dependencyCache}\n${runs}\n${platform}`)
              .digest("hex")
              .slice(0, 40)}`
          : undefined;
      if (cache) {
        void pruneCaches();
        const made = await cli(
          runtime,
          ["volume", "create", "--label", `${CACHE_LABEL}=1`, cache],
          {
            signal,
          },
        );
        if (made.exitCode !== 0) throw new Error("Dependency cache could not be created");
      }
      const created = await cli(
        runtime,
        [
          "run",
          "-d",
          "--rm",
          "--init",
          "--platform",
          platform,
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          ...ROOT_CAPABILITIES.flatMap((capability) => ["--cap-add", capability]),
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "512",
          "--user",
          user,
          ...(options.runFlags ?? []),
          ...(cache
            ? ["--mount", `type=volume,src=${cache},dst=${DEPENDENCY_CACHE},volume-nocopy`]
            : []),
          ...Object.entries(owned).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
          runs,
          "sleep",
          String(seconds),
        ],
        { signal },
      );
      const id = created.stdout.trim();
      if (created.exitCode !== 0 || !/^[0-9a-f]{64}$/u.test(id))
        throw new Error("Container could not be created");
      // The labels the runtime reports are the ownership proof.
      const found = await inspect(id);
      if (!found || !Object.entries(owned).every(([key, value]) => found[key] === value))
        throw new Error("Unexpected container ownership");
      // The seal is a boundary only while no Task process shares root's user ID.
      const uid = await exec(id, ["id", "-u"], { signal });
      if (uid.exitCode !== 0 || !/^[1-9][0-9]*$/u.test(uid.stdout.trim())) {
        await cli(runtime, ["rm", "-f", id]);
        throw new Error("The Workspace user must not be root");
      }
      // Root runs only an interpreter, and only modules, the Workspace user cannot change.
      const programs = await exec(id, ["python3", "-I", "-S", "-c", WRITABLE_ROOT_PROGRAMS], {
        signal,
      });
      const [interpreter, ...flagged] = programs.stdout.trim().split("\n");
      const listed = (prefix: string) =>
        flagged
          .filter((line) => line.startsWith(prefix))
          .map((line) => line.slice(prefix.length))
          .slice(0, 3)
          .join(", ");
      const writable = listed("writable ");
      const setuid = listed("setuid ");
      if (
        programs.exitCode !== 0 ||
        !interpreter ||
        !/^\/[A-Za-z0-9._/+-]{1,255}$/u.test(interpreter) ||
        flagged.length > 0
      ) {
        await cli(runtime, ["rm", "-f", id]);
        throw new Error(
          writable
            ? `The Workspace user can change what the sandbox runs as root: ${writable}`
            : setuid
              ? `The Workspace image has setuid or setgid programs its user can run, which could give a Task root and let it stop the seal; remove their setuid and setgid bits (chmod u-s,g-s): ${setuid}`
              : "The Workspace image has no usable python3",
        );
      }
      // A new cache volume belongs to root; the Workspace user gets its top directory.
      if (cache) {
        const ids = await exec(id, ["sh", "-c", 'echo "$(id -u):$(id -g)"'], { signal });
        const owner = ids.stdout.trim();
        if (
          ids.exitCode !== 0 ||
          !/^[0-9]+:[0-9]+$/u.test(owner) ||
          (
            await exec(id, ["chown", owner, DEPENDENCY_CACHE], {
              privileged: true,
              signal,
            })
          ).exitCode !== 0
        ) {
          await cli(runtime, ["rm", "-f", id]);
          throw new Error("Dependency cache could not be prepared");
        }
      }
      interpreters.set(id, interpreter);
      const sandbox = instance(id);
      const relay = egress ? await startEgressRelay(id, egress, interpreter) : undefined;
      // The exec server starts on the first operation, after the session recorded the
      // container's own processes, so the seal never spares it.
      if (options.execServer !== false)
        servers.set(
          id,
          createExecServer(() => {
            const child = spawn(
              runtime,
              ["exec", "-i", "-w", "/tmp", id, interpreter, "-I", "-S", "-c", EXEC_SERVER_PROGRAM],
              { stdio: "pipe" },
            );
            child.stderr.resume();
            return child;
          }),
        );
      if (relay) relays.set(id, relay);
      const workspace: SandboxWorkspace = {
        sandboxId: id,
        ...(relay ? { egressRelay: true as const } : {}),
        ...(cache ? { commandEnvironment: DEPENDENCY_CACHE_VARIABLES } : {}),
        environment: (root) =>
          sandboxExecutionEnvironment(sandbox, root, {
            id: label,
            maxOutputCharacters: 65_536,
            backend: {
              capabilities: {
                networkModes: ["none"],
                readOnlyMounts: true,
                boundedSymlinkSafeReads: true,
                outputFiles: true,
                streamOutput: true,
                streamInput: true,
              },
              create: () => Promise.reject(new Error("Allocate creates the container")),
            },
          }),
        run: (argv, runTimeoutMs, runSignal) =>
          userRun(id, argv, { signal: runSignal, timeoutMs: runTimeoutMs }),
        async writeTransfer(path, bytes, writeSignal) {
          const result = await exec(id, ["sh", "-c", 'set -C; umask 077; cat > "$1"', "sh", path], {
            input: bytes,
            signal: writeSignal,
          });
          if (result.exitCode !== 0) throw new Error("Transfer could not be written");
        },
        async readTransfer(path, readSignal) {
          const child = spawn(runtime, ["exec", id, "cat", "--", path], {
            stdio: ["ignore", "pipe", "ignore"],
            signal: readSignal,
          });
          child.once("error", () => {});
          return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
        },
        async snapshot(snapshotSignal) {
          const committed = await cli(runtime, ["commit", id], { signal: snapshotSignal });
          // The ID is the last line: Podman may report its progress before it.
          const image = committed.stdout.trim().split("\n").at(-1) ?? "";
          if (committed.exitCode !== 0 || !IMAGE_ID.test(image))
            throw new Error("Container could not be committed");
          return image;
        },
        async runPrivileged(argv, privilegedTimeoutMs, privilegedSignal) {
          try {
            return await exec(id, argv, {
              privileged: true,
              signal: privilegedSignal,
              timeoutMs: privilegedTimeoutMs,
            });
          } finally {
            // A seal stops the exec server with every other Task process: the next operation
            // starts a new one rather than finding the old one gone.
            servers.get(id)?.reset();
          }
        },
      };
      return workspace;
    },
    async stop(owner, sandboxId): Promise<SandboxStopResult> {
      if (sandboxId !== undefined) {
        relays.get(sandboxId)?.close();
        relays.delete(sandboxId);
        servers.get(sandboxId)?.close();
        servers.delete(sandboxId);
        interpreters.delete(sandboxId);
      }
      const owned = labels(owner, label);
      const matches = (found: Record<string, string>) =>
        Object.entries(owned).every(([key, value]) => found[key] === value);
      try {
        let id = sandboxId;
        if (id === undefined) {
          const listed = await cli(runtime, [
            "ps",
            "-aq",
            "--no-trunc",
            ...Object.entries(owned).flatMap(([key, value]) => [
              "--filter",
              `label=${key}=${value}`,
            ]),
          ]);
          const ids = listed.stdout.split("\n").filter(Boolean);
          if (listed.exitCode !== 0) return { state: "uncertain" };
          // Exactly one owned container counts; absence alone proves nothing about an
          // allocation whose response was lost.
          if (ids.length !== 1) return { state: "uncertain" };
          id = ids[0] as string;
        }
        const before = await inspect(id);
        if (before === undefined) return { state: "stopped", sandboxId: id };
        if (!matches(before)) return { state: "uncertain" };
        await cli(runtime, ["rm", "-f", id]).catch(() => undefined);
        return (await inspect(id)) === undefined
          ? { state: "stopped", sandboxId: id }
          : { state: "uncertain" };
      } catch {
        return { state: "uncertain" };
      }
    },
    async removeArtifact(artifact) {
      const result = await cli(runtime, ["rmi", "-f", artifact]);
      if (result.exitCode !== 0 && !/no such image/iu.test(result.stderr))
        throw new Error("Image could not be removed");
    },
  };
}
