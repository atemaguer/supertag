import {
  listSandboxOutputFiles,
  materializeSandboxArtifactFiles,
  type ProcessSpec,
  prepareSandboxOutputDirectory,
  type SandboxInstance,
} from "@supertag/worker-sdk";
import { CommandExitError } from "e2b";

interface E2BCommandResultLike {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface E2BCommandHandleLike {
  readonly pid: number;
  wait(): Promise<E2BCommandResultLike>;
  kill(): Promise<boolean>;
  sendStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
}

interface E2BCommandOptionsLike {
  readonly background?: boolean;
  readonly cwd?: string;
  readonly envs?: Record<string, string>;
  readonly onStdout?: (data: string) => void | Promise<void>;
  readonly onStderr?: (data: string) => void | Promise<void>;
  readonly stdin?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Minimal E2B surface used by the provider and replaceable by tests. */
export interface E2BSandboxClient {
  readonly sandboxId: string;
  readonly files: {
    makeDir(path: string): Promise<boolean>;
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    read(path: string, options?: { format: "bytes" }): Promise<string | Uint8Array>;
  };
  readonly commands: {
    run(
      command: string,
      options: E2BCommandOptionsLike & { readonly background: true },
    ): Promise<E2BCommandHandleLike>;
    run(command: string, options?: E2BCommandOptionsLike): Promise<E2BCommandResultLike>;
  };
  kill(): Promise<boolean>;
}

/** Shared E2B process and bounded file adapter for the private Workspace provider. */
export function adaptE2B(sandbox: E2BSandboxClient): SandboxInstance {
  const instance: SandboxInstance = {
    id: sandbox.sandboxId,
    prepareOutputDirectory: (root, path) => prepareSandboxOutputDirectory(instance, root, path),
    listOutputFiles: (root, query) => listSandboxOutputFiles(instance, root, query),
    materializeArtifactFiles: (input) => materializeSandboxArtifactFiles(instance, input),
    async mkdir(path) {
      await sandbox.files.makeDir(path);
    },
    async write(path, bytes, options) {
      const handle = await sandbox.commands.run(`python3 -c ${shellQuote(EXCLUSIVE_WRITE)}`, {
        background: true,
        stdin: true,
        envs: {
          SUPERTAG_FILE_PATH: path,
          SUPERTAG_FILE_MODE: String(options.mode ?? 0o600),
          SUPERTAG_FILE_EXCLUSIVE: String(options.exclusive),
        },
        timeoutMs: 30000,
      });
      await handle.sendStdin(Buffer.from(bytes).toString("base64"));
      await handle.closeStdin();
      try {
        const result = await handle.wait();
        if (result.exitCode !== 0) throw new Error("Staged file could not be written exclusively");
      } catch {
        throw new Error("Staged file could not be written exclusively");
      }
    },
    async read(path, options) {
      const result = await sandbox.commands.run(`python3 -c ${shellQuote(BOUNDED_READ)}`, {
        envs: { SUPERTAG_FILE_PATH: path, SUPERTAG_FILE_LIMIT: String(options.maximumBytes) },
        timeoutMs: 5000,
      });
      if (result.exitCode !== 0)
        throw new Error("Output must be a bounded regular file without symbolic links");
      if (result.stdout.length > 4 * Math.ceil(options.maximumBytes / 3))
        throw new Error("Artifact transport exceeded bound");
      const bytes = new Uint8Array(Buffer.from(result.stdout, "base64"));
      if (bytes.byteLength > options.maximumBytes)
        throw new Error("Expected bounded binary artifact");
      return bytes;
    },
    async makeReadOnly(path) {
      const result = await sandbox.commands.run(`chmod -R a-w ${shellQuote(path)}`);
      if (result.exitCode !== 0) throw new Error("Failed to make E2B mount read-only");
    },
    async start(spec, options) {
      const handle = await sandbox.commands.run(renderCommand(spec), {
        background: true,
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        ...(spec.environment === undefined ? {} : { envs: { ...spec.environment } }),
        ...(spec.stdin === undefined && !spec.streamInput ? {} : { stdin: true }),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        // The E2B SDK awaits these callbacks before reading the next event, so returning the
        // consumer's promise stops reading this command's output stream until it drains.
        onStdout: (text) => options.onOutput({ stream: "stdout", text }),
        onStderr: (text) => options.onOutput({ stream: "stderr", text }),
      });
      if (spec.stdin !== undefined) {
        await handle.sendStdin(spec.stdin);
        await handle.closeStdin();
      }
      return {
        pid: handle.pid,
        terminate: () => handle.kill(),
        ...(spec.streamInput
          ? {
              write: (bytes: Uint8Array) => handle.sendStdin(bytes),
              endInput: () => handle.closeStdin(),
            }
          : {}),
        async wait() {
          try {
            return await handle.wait();
          } catch (error) {
            if (error instanceof CommandExitError)
              return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
            throw error;
          }
        },
      };
    },
    terminate: () => sandbox.kill(),
  };
  return instance;
}
function renderCommand(spec: ProcessSpec): string {
  return [spec.command, ...(spec.args ?? [])].map(shellQuote).join(" ");
}
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Walk directory descriptors rather than checking paths before a separate read.
// O_NONBLOCK prevents an attacker substituting a FIFO before the regular-file check.
const BOUNDED_READ = `import os, stat, base64
parts = os.environ["SUPERTAG_FILE_PATH"].split("/")
limit = int(os.environ["SUPERTAG_FILE_LIMIT"])
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
try:
 for part in [p for p in parts if p]:
  if part in (".", ".."): raise ValueError("invalid path")
  flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
  next_fd = os.open(part, flags, dir_fd=fd)
  os.close(fd)
  fd = next_fd
 if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError("not regular")
 chunks = []
 remaining = limit + 1
 while remaining:
  chunk = os.read(fd, min(65536, remaining))
  if not chunk: break
  chunks.append(chunk)
  remaining -= len(chunk)
 data = b"".join(chunks)
 if len(data) > limit: raise ValueError("too large")
 print(base64.b64encode(data).decode("ascii"), end="")
finally:
 os.close(fd)
`;

const EXCLUSIVE_WRITE = `import os, sys, base64
parts = [p for p in os.environ["SUPERTAG_FILE_PATH"].split("/") if p]
if not parts or any(p in (".", "..") for p in parts): raise ValueError("invalid path")
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
try:
 for part in parts[:-1]:
  next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
  os.close(fd)
  fd = next_fd
 flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
 flags |= os.O_EXCL if os.environ["SUPERTAG_FILE_EXCLUSIVE"] == "true" else os.O_TRUNC
 out = os.open(parts[-1], flags, int(os.environ["SUPERTAG_FILE_MODE"]), dir_fd=fd)
 with os.fdopen(out, "wb") as target:
  target.write(base64.b64decode(sys.stdin.buffer.read(), validate=True))
finally:
 os.close(fd)
`;
