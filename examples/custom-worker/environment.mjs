import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * A small attempt-scoped local Environment Provider.
 *
 * It demonstrates the boundary a remote or managed provider implements:
 * provision an environment, prepare its approved plan, then clean it up.
 * This example is not a security sandbox; production providers must enforce
 * their own network, mount, and secret policies.
 */
export class ExampleEnvironmentProvider {
  id = "example-local-environment";
  capabilities = [{ id: "example.execution.local", version: 1 }];

  async provision() {
    const rootDirectory = await mkdtemp(resolve(tmpdir(), "supertag-example-"));
    return new ExampleEnvironment(rootDirectory);
  }
}

class ExampleEnvironment {
  placement = "local";

  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
    this.id = `example-local:${rootDirectory}`;
    this.disposed = false;
  }

  async prepare(plan) {
    this.#assertOpen();
    if (plan.mounts.length > 0 || plan.secretBindings.length > 0) {
      throw new Error("Example Environment supports staged files only");
    }
    for (const file of plan.files) {
      const path = this.resolvePath(file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        file.content,
        file.mode === undefined ? undefined : { mode: file.mode },
      );
    }
  }

  resolvePath(path) {
    this.#assertOpen();
    const destination = resolve(this.rootDirectory, path);
    const traversal = relative(this.rootDirectory, destination);
    if (traversal.startsWith("..") || isAbsolute(traversal)) {
      throw new Error(`Environment path escapes its root: ${path}`);
    }
    return destination;
  }

  async read(path) {
    return await readFile(this.resolvePath(path), "utf8");
  }

  async spawn(process, signal) {
    this.#assertOpen();
    if (signal?.aborted === true) throw signal.reason;
    const child = spawn(process.command, process.args ?? [], {
      cwd: process.cwd ?? this.rootDirectory,
      env: { ...process.env, ...(process.environment ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(process.stdin);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const stop = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", stop, { once: true });
    const wait = new Promise((resolveProcess, rejectProcess) => {
      child.once("error", rejectProcess);
      child.once("close", (exitCode, processSignal) => {
        signal?.removeEventListener("abort", stop);
        resolveProcess({
          exitCode,
          ...(processSignal === null ? {} : { signal: processSignal }),
          stdout,
          stderr,
        });
      });
    });
    return {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      wait: async () => await wait,
      kill: (requestedSignal = "SIGTERM") => child.kill(requestedSignal),
    };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.rootDirectory, { recursive: true, force: true });
  }

  #assertOpen() {
    if (this.disposed) throw new Error(`Execution Environment ${this.id} has been disposed`);
  }
}
