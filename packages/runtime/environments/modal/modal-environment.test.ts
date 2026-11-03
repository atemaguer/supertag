import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import type {
  ExecutionEnvironmentSpec,
  HarnessPlan,
  ProcessOutputChunk,
} from "@supertag/worker-sdk";
import { describe, expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../../tests/support/repository-execution.ts";
import {
  ModalExecutionEnvironmentProvider,
  type ModalSandboxClient,
  type ModalSandboxFactory,
} from "./src/index.ts";

function spec(plan: Partial<HarnessPlan> = {}): ExecutionEnvironmentSpec {
  return {
    task: repositoryAttempt("modal"),
    profile: {
      ref: { id: "test", revision: "1" },
      workerType: "test",
      harness: { provider: "test" },
      execution: { provider: "modal", lifetime: { scope: "attempt" } },
    },
    plan: {
      files: [],
      mounts: [],
      environmentVariables: {},
      secretBindings: [],
      network: { mode: "none" },
      ...plan,
    },
  };
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "supertag-modal-test-")));
  const processes: { pid: number | undefined; done: Promise<number> }[] = [];
  const exec = vi.fn<ModalSandboxClient["exec"]>(async (command, options) => {
    const [program, ...args] = command;
    if (!program) throw new Error("missing program");
    const child = spawn(program, args, {
      cwd: options.workdir,
      env: { PATH: process.env["PATH"], ...options.env },
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    child.stdin.on("error", () => {});
    const done = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 137));
    });
    processes.push({ pid: child.pid, done });
    return {
      stdin: {
        writeBytes: (bytes) =>
          new Promise<void>((resolve, reject) =>
            child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())),
          ),
        close: () =>
          new Promise<void>((resolve, reject) => {
            child.stdin.once("error", reject);
            child.stdin.end(resolve);
          }),
      },
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      wait: () => done,
    };
  });
  const terminate = vi.fn(async () => {
    for (const child of processes)
      if (child.pid)
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        } catch {}
    await Promise.all(processes.map((child) => child.done));
    return 137;
  });
  const sandbox: ModalSandboxClient = { sandboxId: "local-sdk-contract", exec, terminate };
  const create = vi.fn<ModalSandboxFactory["create"]>(async () => sandbox);
  const provider = new ModalExecutionEnvironmentProvider({
    appName: "existing-app",
    rootDirectory: directory,
    sandboxFactory: { create },
    cpu: 1,
    memoryMiB: 256,
  });
  return {
    directory,
    provider,
    create,
    sandbox,
    exec,
    terminate,
    async cleanup() {
      await terminate();
      await writable(directory);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function stdoutLineReader(output: AsyncIterator<ProcessOutputChunk>): () => Promise<string> {
  let buffered = "";
  return async () => {
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline + 1);
        buffered = buffered.slice(newline + 1);
        return line;
      }
      const next = await output.next();
      if (next.done) throw new Error("Modal stdout ended before a complete response line");
      if (next.value.stream === "stdout") buffered += next.value.text;
    }
  };
}

describe("Modal sandbox adapter (deterministic native-client contract)", () => {
  it("keeps native Modal stdin open for interactive exchanges and revokes it on disposal", async () => {
    const f = await fixture();
    try {
      const env = await f.provider.provision(spec());
      const handle = await env.spawn({
        command: "python3",
        args: [
          "-u",
          "-c",
          "import sys\nfor line in sys.stdin: print('response:'+line.strip(), flush=True)",
        ],
        streamInput: true,
        streamOutput: true,
      });
      if (!handle.write || !handle.endInput || !handle.output)
        throw new Error("Missing duplex input");
      const output = handle.output[Symbol.asyncIterator]();
      const readLine = stdoutLineReader(output);
      await handle.write(new TextEncoder().encode("one\n"));
      expect(await readLine()).toBe("response:one\n");
      await handle.write(new TextEncoder().encode("two\n"));
      expect(await readLine()).toBe("response:two\n");
      await handle.endInput();
      expect((await handle.wait()).exitCode).toBe(0);
      await expect(handle.write(new Uint8Array([1]))).rejects.toThrow();
      const pending = await env.spawn({
        command: "python3",
        args: ["-c", "import sys; sys.stdin.read()"],
        streamInput: true,
      });
      await env.dispose("cancelled");
      await expect(pending.write?.(new Uint8Array([1]))).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });
  it("uses in-sandbox HTTP for the owned server and terminates the sandbox on active-request cancellation", async () => {
    const f = await fixture();
    try {
      const env = await f.provider.provision(spec());
      const handle = await env.spawn({
        command: "python3",
        args: [
          "-u",
          "-c",
          `from http.server import BaseHTTPRequestHandler,HTTPServer
import time
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path == "/slow": time.sleep(30)
  self.send_response(200)
  self.end_headers()
  self.wfile.write(bytes([0,255,7]))
 def log_message(self,*args): pass
server=HTTPServer(("127.0.0.1",0),Handler)
print(server.server_port,flush=True)
server.serve_forever()`,
        ],
        streamOutput: true,
      });
      if (!handle.output || !env.connect) throw new Error("Missing connection support");
      let text = "";
      for await (const chunk of handle.output) {
        text += chunk.text;
        if (text.includes("\n")) break;
      }
      const connection = await env.connect(handle, { port: Number(text.trim()) });
      expect(env.guarantees).toMatchObject({
        filesystemIsolation: "sandbox",
        networkPolicy: "enforced",
        scopedHttp: true,
      });
      expect((await connection.request({ path: "/" })).body).toEqual(new Uint8Array([0, 255, 7]));
      const idle = await env.connect(handle, { port: Number(text.trim()) });
      await idle.close();
      expect(f.terminate).not.toHaveBeenCalled();
      const controller = new AbortController();
      const pending = connection.request({ path: "/slow" }, controller.signal);
      const rejected = expect(pending).rejects.toThrow();
      controller.abort(new Error("cancel HTTP"));
      await rejected;
      expect(f.terminate).toHaveBeenCalledWith({ wait: true });
      await env.dispose("cancelled");
    } finally {
      await f.cleanup();
    }
  });
  it("stages a workspace and binary overlay, executes argv safely, streams UTF-8, and reads exact bytes", async () => {
    const f = await fixture();
    const source = await mkdtemp(join(tmpdir(), "modal-source-"));
    try {
      await writeFile(join(source, "seed.txt"), "known revision");
      const task = spec({
        mounts: [
          { source: { uri: pathToFileURL(source).href }, destination: "workspace", readOnly: true },
        ],
        files: [{ path: "workspace/inputs/artifact-1", content: new Uint8Array([0, 255, 8]) }],
        environmentVariables: { BOUND: "yes" },
      });
      const env = await f.provider.provision(task);
      await env.prepare(task.plan);
      expect(await env.readBytes?.("workspace/inputs/artifact-1")).toEqual(
        new Uint8Array([0, 255, 8]),
      );
      expect((await lstat(env.resolvePath("workspace/inputs/artifact-1"))).mode & 0o222).toBe(0);
      const handle = await env.spawn({
        command: "python3",
        args: [
          "-c",
          "import sys,os; print(sys.argv[1]); print(os.environ['BOUND']); sys.stdout.buffer.write('😀'.encode()); sys.stderr.write('review')",
          "$(unsafe); literal",
        ],
        streamOutput: true,
      });
      const chunks = [];
      if (!handle.output) throw new Error("Missing stream");
      for await (const chunk of handle.output) chunks.push(chunk);
      const result = await handle.wait();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("$(unsafe); literal");
      expect(result.stdout).toContain("😀");
      expect(result.stdout).toContain("yes");
      expect(
        chunks.some((chunk) => chunk.stream === "stderr" && chunk.text.includes("review")),
      ).toBe(true);
      expect(f.create).toHaveBeenCalledWith(
        expect.objectContaining({
          appName: "existing-app",
          createAppIfMissing: false,
          params: expect.objectContaining({
            blockNetwork: true,
            cpu: 1,
            cpuLimit: 1,
            memoryMiB: 256,
            memoryLimitMiB: 256,
          }),
        }),
      );
      expect(f.exec.mock.calls.at(-1)?.[0].at(-1)).toBe("$(unsafe); literal");
      await env.dispose("completed");
      await env.dispose("completed");
      expect(f.terminate).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
      await rm(source, { recursive: true, force: true });
    }
  });
  it("materializes binary artifact copies in fresh directories and rejects collisions and symlinks", async () => {
    const f = await fixture();
    try {
      const env = await f.provider.provision(spec());
      if (!env.materializeArtifactFiles) throw new Error("Missing materialization capability");
      const directory = `artifact-${"a".repeat(64)}`;
      const files = [{ path: "research/data.bin", bytes: new Uint8Array([0, 255, 128]) }];
      const destination = await env.materializeArtifactFiles({ directory, files });
      expect(destination).toBe(env.resolvePath(directory));
      expect(await readFile(join(destination, "research/data.bin"))).toEqual(
        Buffer.from([0, 255, 128]),
      );
      expect((await lstat(join(destination, "research/data.bin"))).mode & 0o777).toBe(0o600);
      await expect(env.materializeArtifactFiles({ directory, files })).rejects.toThrow(
        "cannot be overwritten",
      );
      const outside = join(f.directory, "outside");
      await mkdir(outside);
      const linked = `artifact-${"b".repeat(64)}`;
      await symlink(outside, env.resolvePath(linked));
      await expect(env.materializeArtifactFiles({ directory: linked, files })).rejects.toThrow(
        "cannot be overwritten",
      );
      expect(await readdir(outside)).toEqual([]);
      const originalRoot = `${env.rootDirectory}-original`;
      await rename(env.rootDirectory, originalRoot);
      await symlink(outside, env.rootDirectory);
      try {
        await expect(
          env.materializeArtifactFiles({ directory: `artifact-${"e".repeat(64)}`, files }),
        ).rejects.toThrow("cannot be overwritten");
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(env.rootDirectory);
        await rename(originalRoot, env.rootDirectory);
      }
      const invalid = `artifact-${"c".repeat(64)}`;
      await expect(
        env.materializeArtifactFiles({
          directory: invalid,
          files: [
            { path: "a", bytes: new Uint8Array() },
            { path: "a/b", bytes: new Uint8Array() },
          ],
        }),
      ).rejects.toThrow("overlap");
      await expect(lstat(env.resolvePath(invalid))).rejects.toMatchObject({ code: "ENOENT" });
      await env.dispose("completed");
    } finally {
      await f.cleanup();
    }
  });
  it("preserves partial materialization as a collision fence after a write failure", async () => {
    const f = await fixture();
    try {
      const env = await f.provider.provision(spec());
      if (!env.materializeArtifactFiles) throw new Error("Missing materialization capability");
      const directory = `artifact-${"d".repeat(64)}`;
      await expect(
        env.materializeArtifactFiles({
          directory,
          files: [
            { path: "first", bytes: new TextEncoder().encode("original") },
            { path: "x".repeat(256), bytes: new Uint8Array() },
          ],
        }),
      ).rejects.toThrow("cannot be overwritten");
      await expect(
        env.materializeArtifactFiles({
          directory,
          files: [{ path: "first", bytes: new TextEncoder().encode("replacement") }],
        }),
      ).rejects.toThrow("cannot be overwritten");
      expect(await readFile(env.resolvePath(`${directory}/first`), "utf8")).toBe("original");
      await env.dispose("completed");
    } finally {
      await f.cleanup();
    }
  });
  it("rejects overwrite, file and parent symlinks, and oversized reads", async () => {
    const f = await fixture();
    try {
      const env = await f.provider.provision(spec());
      const plan = { ...spec().plan, files: [{ path: "existing", content: "original" }] };
      await env.prepare(plan);
      await expect(env.prepare(plan)).rejects.toThrow("write failed");
      expect(await readFile(env.resolvePath("existing"), "utf8")).toBe("original");
      await symlink(env.resolvePath("existing"), env.resolvePath("link"));
      await expect(env.readBytes?.("link")).rejects.toThrow("read failed");
      await mkdir(join(f.directory, "outside"));
      await symlink(join(f.directory, "outside"), env.resolvePath("parent-link"));
      await expect(
        env.prepare({ ...spec().plan, files: [{ path: "parent-link/escape", content: "bad" }] }),
      ).rejects.toThrow("mkdir failed");
      await writeFile(env.resolvePath("large"), new Uint8Array(32 * 1024 * 1024 + 1));
      await expect(env.readBytes?.("large")).rejects.toThrow("read failed");
      await env.dispose("completed");
    } finally {
      await f.cleanup();
    }
  });
  it("closes stdin, propagates nonzero exit codes, and confirms whole-sandbox cancellation", async () => {
    const f = await fixture();
    try {
      const env = await f.provider.provision(spec());
      const echo = await env.spawn({
        command: "python3",
        args: ["-c", "import sys; print(sys.stdin.read()); sys.exit(7)"],
        stdin: "input bytes",
      });
      expect(await echo.wait()).toMatchObject({ exitCode: 7, stdout: "input bytes\n" });
      const controller = new AbortController();
      const handle = await env.spawn(
        { command: "python3", args: ["-c", "import time; time.sleep(60)"] },
        controller.signal,
      );
      controller.abort(new Error("supervisor cancelled"));
      await expect(handle.wait()).rejects.toThrow("supervisor cancelled");
      expect(f.terminate).toHaveBeenCalledWith({ wait: true });
    } finally {
      await f.cleanup();
    }
  });
  it("maps a domain allowlist without broad CIDR grants and fails closed for malformed hosts", async () => {
    const f = await fixture();
    try {
      const env = await f.provider.provision(
        spec({ network: { mode: "allowlist", allowedHosts: ["api.openai.com", "*.github.com"] } }),
      );
      expect(f.create.mock.calls[0]?.[0].params).toMatchObject({
        outboundCidrAllowlist: [],
        outboundDomainAllowlist: ["api.openai.com", "*.github.com"],
      });
      await env.dispose("completed");
      for (const host of ["https://example.com", "*", "10.0.0.0/8", "host:80"])
        await expect(
          f.provider.provision(spec({ network: { mode: "allowlist", allowedHosts: [host] } })),
        ).rejects.toThrow("domain allowlist");
      expect(f.create).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  });
  it("preserves unknown termination as an ExecutionCleanupError", async () => {
    const f = await fixture();
    try {
      const env = await f.provider.provision(spec());
      f.terminate.mockRejectedValueOnce(new Error("control plane unavailable"));
      await expect(env.dispose("failed")).rejects.toMatchObject({ name: "ExecutionCleanupError" });
      await env.dispose("failed");
    } finally {
      await f.cleanup();
    }
  });
});

describe("Modal process output backpressure", () => {
  it("stops pulling output while a slow consumer drains, losing nothing", async () => {
    const f = await fixture();
    try {
      const env = await f.provider.provision(spec());
      const bytes = 12 * 1024 * 1024; // Past the 8 MiB hard cap for producers that cannot pause.
      const handle = await env.spawn({
        command: process.execPath,
        args: [
          "-e",
          `let s='';for(let i=0;s.length<${bytes};i++)s+=i.toString(36).padStart(8,'0');process.stdout.write(s.slice(0,${bytes}))`,
        ],
        streamOutput: true,
      });
      if (!handle.output) throw new Error("Missing output stream");
      const parts: string[] = [];
      let sinceDelay = 0;
      for await (const chunk of handle.output) {
        if (chunk.stream !== "stdout") continue;
        parts.push(chunk.text);
        sinceDelay += chunk.text.length;
        if (sinceDelay >= 512 * 1024) {
          sinceDelay = 0;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect((await handle.wait()).exitCode).toBe(0);
      let expected = "";
      for (let index = 0; expected.length < bytes; index++)
        expected += index.toString(36).padStart(8, "0");
      expect(parts.join("") === expected.slice(0, bytes)).toBe(true);
      await env.dispose("completed");
    } finally {
      await f.cleanup();
    }
  }, 60_000);
});

async function writable(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chmod(path, info.mode | 0o700);
  if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
}
