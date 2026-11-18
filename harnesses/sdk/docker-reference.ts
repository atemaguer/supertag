/**
 * A reference sandbox provider on local Docker containers, for tests only. It shows the smallest
 * provider the contract allows (docs/reference/sandbox-providers.md) and runs the conformance
 * suite against a real, separate sandbox: the seal program really stops processes, and a
 * command cannot reach the machine running the tests.
 *
 * Each sandbox is a container with no network, labelled with its owner, whose first process
 * ends at the requested lifetime. Commands run as the image's unprivileged user; the seal runs
 * as root. It builds no devcontainer image. Snapshots are `docker commit` images.
 */
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  listSandboxOutputFiles,
  materializeSandboxArtifactFiles,
  type ProcessSpec,
  prepareSandboxOutputDirectory,
  type SandboxInstance,
  sandboxExecutionEnvironment,
} from "./src/index.js";
import {
  createSandboxWorkspaceSession,
  type SandboxOwner,
  type SandboxStopResult,
  type SandboxWorkspace,
  type SandboxWorkspaceSession,
} from "./src/rust-workspace-provider/index.js";

const MAX_LIFETIME_MS = 3_600_000;
const LABEL = "supertag.reference";

export interface DockerReferenceOptions {
  /** An image with `python3`, `git`, `/bin/sh`, and an unprivileged `user`. */
  readonly image: string;
  readonly user: string;
  readonly runtime?: string;
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

function labels(owner: SandboxOwner): Record<string, string> {
  if (
    owner.hostGeneration < 1n ||
    [owner.hostId, owner.taskId, owner.attemptId, owner.allocationId].some(
      (value) => !value || value.length > 256 || /\p{Cc}/u.test(value),
    )
  )
    throw new Error("Invalid sandbox ownership");
  return {
    [LABEL]: "1",
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

export function createDockerReferenceSession(
  options: DockerReferenceOptions,
): SandboxWorkspaceSession {
  const runtime = options.runtime ?? "docker";
  const exec = (
    id: string,
    argv: readonly string[],
    rest: { user?: string; input?: Uint8Array; signal?: AbortSignal; timeoutMs?: number } = {},
  ) =>
    cli(runtime, ["exec", "-i", "-u", rest.user ?? options.user, "-w", "/tmp", id, ...argv], rest);

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
            "-u",
            options.user,
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

  return createSandboxWorkspaceSession({
    label: "Docker",
    validateOwner: (owner) => void labels(owner),
    async allocate(owner, timeoutMs, signal, environment, artifact) {
      // A reference: it builds no devcontainer image.
      if (environment && (environment.dockerfileCommands.length > 0 || environment.image))
        throw new Error("The reference provider builds no image");
      const owned = labels(owner);
      const seconds = Math.ceil(Math.min(timeoutMs, MAX_LIFETIME_MS) / 1000);
      const created = await cli(
        runtime,
        [
          "run",
          "-d",
          "--rm",
          "--init",
          "--network",
          "none",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "512",
          ...Object.entries(owned).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
          artifact ?? options.image,
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
      const sandbox = instance(id);
      const workspace: SandboxWorkspace = {
        sandboxId: id,
        environment: (root) =>
          sandboxExecutionEnvironment(sandbox, root, {
            id: "docker-reference",
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
          const child = spawn(runtime, ["exec", "-u", options.user, id, "cat", "--", path], {
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
          exec(id, argv, { user: "0", signal: privilegedSignal, timeoutMs: privilegedTimeoutMs }),
      };
      return workspace;
    },
    async stop(owner, sandboxId): Promise<SandboxStopResult> {
      const owned = labels(owner);
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
  });
}
