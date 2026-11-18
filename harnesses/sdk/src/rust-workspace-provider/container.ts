/**
 * A sandbox provider on a local container runtime (Docker, Podman, or a compatible CLI): the
 * `local-vm` environment's provider, and the reference provider the conformance suite runs
 * against (docs/reference/sandbox-providers.md).
 *
 * Each sandbox is a container with no network, labelled with its owner, whose first process
 * ends at the requested lifetime. Task processes run as the image's unprivileged user with every
 * capability dropped and no way to gain privileges, so the seal, which runs as root through the
 * runtime's own exec, is a boundary here: the Task cannot replace the interpreter or hide from
 * it. Snapshots are `<runtime> commit` images. A devcontainer's image and layers are built with
 * an empty context, on the host's native platform.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
}

/** The allocation limit when the provider's own image may be built first. */
export const CONTAINER_ALLOCATE_TIMEOUT_MS = BUILD_TIMEOUT_MS;

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
        // Every other process runs as the container's own unprivileged user.
        ...(rest.privileged ? ["--privileged", "-u", "0"] : []),
        "-w",
        "/tmp",
        id,
        ...argv,
      ],
      rest,
    );

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
        if ((await exec(id, ["mkdir", "-p", "--", path])).exitCode !== 0)
          throw new Error("Directory could not be made");
      },
      async write(path, bytes, write) {
        const result = await exec(
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
        const result = await exec(id, [
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
        if ((await exec(id, ["chmod", "-R", "a-w", "--", path])).exitCode !== 0)
          throw new Error("Path could not be made read-only");
      },
      async start(spec: ProcessSpec, start) {
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
            ...argv,
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
    return found.exitCode === 0 && /^sha256:[0-9a-f]{64}$/u.test(id) ? id : undefined;
  }

  /**
   * Builds an image once per Dockerfile and platform, with no build context: `-` reads the
   * Dockerfile from standard input. A build an earlier run left is reused by its tag.
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
        const built = await cli(runtime, ["build", "--platform", platform, "-t", tag, "-"], {
          input: new TextEncoder().encode(dockerfile),
          signal,
          timeoutMs: BUILD_TIMEOUT_MS,
        });
        const id = built.exitCode === 0 ? await imageId(tag) : undefined;
        if (id === undefined) throw new Error("The Workspace image could not be built");
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
   * Starts the egress relay in the container as one long-lived exec, as root with no
   * capability, so no Task process can signal or replace it. Its standard input and output carry
   * every Task connection to the Attempt's egress proxy on this host; the container keeps no
   * network. It starts before the session records the container's processes, so the seal spares it.
   */
  async function startEgressRelay(id: string, egress: SandboxEgress): Promise<EgressRelayHost> {
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
        "python3",
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
    if (dockerfile === "") return own.id;
    if (!options.buildImages) throw new Error("This provider builds no image");
    return (await build(dockerfile, signal)).id;
  }

  return {
    label: options.name ?? "Container",
    validateOwner: (owner) => void labels(owner, label),
    async allocate(owner, timeoutMs, signal, environment, artifact, egress) {
      // Every process but the seal's runs as this user; a devcontainer's `user` replaces it.
      const user = environment?.user || options.user;
      const runs = artifact ?? (await image(environment, signal));
      const owned = labels(owner, label);
      const seconds = Math.ceil(Math.min(timeoutMs, MAX_LIFETIME_MS) / 1000);
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
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "512",
          "--user",
          user,
          ...(options.runFlags ?? []),
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
      const sandbox = instance(id);
      const relay = egress ? await startEgressRelay(id, egress) : undefined;
      if (relay) relays.set(id, relay);
      const workspace: SandboxWorkspace = {
        sandboxId: id,
        ...(relay ? { egressRelay: true as const } : {}),
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
          exec(id, argv, { signal: runSignal, timeoutMs: runTimeoutMs }),
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
          const image = committed.stdout.trim();
          if (committed.exitCode !== 0 || !/^sha256:[0-9a-f]{64}$/u.test(image))
            throw new Error("Container could not be committed");
          return image;
        },
        runPrivileged: (argv, privilegedTimeoutMs, privilegedSignal) =>
          exec(id, argv, {
            privileged: true,
            signal: privilegedSignal,
            timeoutMs: privilegedTimeoutMs,
          }),
      };
      return workspace;
    },
    async stop(owner, sandboxId): Promise<SandboxStopResult> {
      if (sandboxId !== undefined) {
        relays.get(sandboxId)?.close();
        relays.delete(sandboxId);
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
