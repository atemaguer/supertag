import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../tests/support/repository-execution.ts";
import {
  createWorker,
  type ExecutionEnvironmentSpec,
  type Harness,
  LocalExecutionEnvironmentProvider,
  type ProcessHandle,
} from "./src/index.ts";
import { ProcessDescendants } from "./src/process-descendants.ts";

const ownershipFault = vi.hoisted(() => ({
  failRecord: false,
  // Waited on before the injected record failure, so the launcher has detached its child.
  beforeFail: undefined as (() => Promise<void>) | undefined,
  holdPrepare: undefined as Promise<void> | undefined,
  prepared: undefined as (() => void) | undefined,
  disposing: undefined as (() => void) | undefined,
}));
vi.mock("./src/local-attempt-ownership.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./src/local-attempt-ownership.ts")>();
  return {
    ...original,
    createLocalAttemptOwnership: async (
      ...args: Parameters<typeof original.createLocalAttemptOwnership>
    ) => {
      const ownership = await original.createLocalAttemptOwnership(...args);
      return {
        ...ownership,
        dispose: async () => {
          ownershipFault.disposing?.();
          return ownership.dispose();
        },
        prepareProcess: async () => {
          const prepared = await ownership.prepareProcess();
          ownershipFault.prepared?.();
          await ownershipFault.holdPrepare;
          return {
            record: async (pid: number | undefined) => {
              if (ownershipFault.failRecord) await ownershipFault.beforeFail?.();
              if (ownershipFault.failRecord) throw new Error("Injected ownership record failure");
              return prepared.record(pid);
            },
          };
        },
      };
    },
  };
});

const detachedScript = `
  const { spawn } = require('node:child_process');
  const { writeFileSync } = require('node:fs');
  const child = spawn(process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    { detached: true, stdio: 'ignore', cwd: process.cwd() });
  writeFileSync(process.argv[1], String(child.pid));
  setInterval(() => {}, 1000);
`;

const orphanedScript = detachedScript.replace(
  "  setInterval(() => {}, 1000);\n",
  "  process.exit(0);\n",
);

const escapedScript = `
  const { spawn } = require('node:child_process');
  const { existsSync, writeFileSync } = require('node:fs');
  const child = spawn(process.execPath,
    ['-e', 'process.chdir("/"); process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000)', process.argv[2]],
    { detached: true, stdio: 'ignore', cwd: '/' });
  writeFileSync(process.argv[1], String(child.pid));
  const ready = setInterval(() => {
    if (existsSync(process.argv[2])) { clearInterval(ready); process.exit(0); }
  }, 5);
`;

const run = promisify(execFile);
/** True while the process runs; a zombie or a vanished PID has ended. */
async function hasLiveCwd(pid: number): Promise<boolean> {
  if (process.platform === "linux") {
    const text = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const state = text?.slice(text.lastIndexOf(")") + 1).trim()[0];
    return state !== undefined && state !== "Z" && state !== "X";
  }
  try {
    const { stdout } = await run("/bin/ps", ["-o", "stat=", "-p", String(pid)]);
    return !stdout.trim().startsWith("Z");
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

it("finds a reparented detached child when tracking starts after launcher exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "reaper-orphan-"));
  const pidFile = join(root, "child.pid");
  const readyFile = join(root, "ready");
  const token = `test-${process.pid}-${Date.now()}`;
  const since = ProcessDescendants.now();
  const launcher = spawn(process.execPath, ["-e", escapedScript, pidFile, readyFile], {
    cwd: root,
    env: { ...process.env, SUPERTAG_INTERNAL_PROCESS_MARKER: token },
  });
  let childPid = 0;
  let tracker: ProcessDescendants | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      launcher.once("error", reject);
      launcher.once("exit", () => resolve());
    });
    childPid = Number(await readFile(pidFile, "utf8"));
    expect(childPid).toBeGreaterThan(0);
    if (!launcher.pid) throw new Error("Launcher did not start");
    expect(await readFile(readyFile, "utf8")).toBe("ready");
    tracker = ProcessDescendants.start(launcher.pid, token, since);
    await tracker.signalKnown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await tracker.signalKnown("SIGKILL");
    const until = Date.now() + 2000;
    while (!(await tracker.gone()) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await tracker.gone()).toBe(true);
    expect(await hasLiveCwd(childPid)).toBe(false);
  } finally {
    await tracker?.close();
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it("reaps a reparented tool child after it changes directory", async () => {
  const env = await new LocalExecutionEnvironmentProvider().provision(spec);
  const pidFile = join(env.rootDirectory, "escaped.pid");
  const readyFile = join(env.rootDirectory, "escaped.ready");
  let childPid = 0;
  let ready = "";
  try {
    const handle = await env.spawn({
      command: process.execPath,
      args: ["-e", escapedScript, pidFile, readyFile],
    });
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      childPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      ready = await readFile(readyFile, "utf8").catch(() => "");
      if (childPid > 0 && ready === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(childPid).toBeGreaterThan(0);
    expect(ready).toBe("ready");
    await expect(handle.wait()).resolves.toMatchObject({ exitCode: 0 });
    expect(await hasLiveCwd(childPid)).toBe(false);
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await env.dispose();
  }
}, 20_000);

it("keeps a sibling process alive when another owned process exits", async () => {
  const env = await new LocalExecutionEnvironmentProvider().provision(spec);
  const sibling = await env.spawn({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });
  try {
    const short = await env.spawn({ command: process.execPath, args: ["-e", ""] });
    await expect(short.wait()).resolves.toMatchObject({ exitCode: 0 });
    if (!sibling.pid) throw new Error("Sibling process did not start");
    expect(() => process.kill(sibling.pid, 0)).not.toThrow();
  } finally {
    await env.dispose();
  }
});

const spec: ExecutionEnvironmentSpec = {
  task: repositoryAttempt("dispose-race"),
  profile: {
    ref: { id: "test", revision: "1" },
    workerType: "test",
    harness: { provider: "test" },
    execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
  },
  plan: {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" },
  },
};

it("removes an Attempt directory without process inventory when no process was launched", async () => {
  const env = await new LocalExecutionEnvironmentProvider().provision(spec);
  const sweep = vi.spyOn(ProcessDescendants, "sweepAttempt").mockImplementation(() => {
    throw new Error("Process inventory is unavailable");
  });
  try {
    await expect(env.dispose("completed")).resolves.toBeUndefined();
    expect(sweep).not.toHaveBeenCalled();
  } finally {
    sweep.mockRestore();
  }
  await expect(access(env.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["completed", "failed", "cancelled"] as const)(
  "removes Attempt scratch after %s execution",
  async (reason) => {
    const env = await new LocalExecutionEnvironmentProvider().provision(spec);
    await env.prepareOutputDirectory?.("scratch");
    const scratch = join(env.rootDirectory, "scratch");
    await writeFile(join(scratch, "temporary.txt"), "temporary");
    await env.dispose(reason);
    await expect(access(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["start", "record"] as const)(
  "sweeps the Attempt directory when a spawn fails in %s",
  async (failure) => {
    const env = await new LocalExecutionEnvironmentProvider().provision(spec);
    const pidFile = join(env.rootDirectory, "partial.pid");
    const sweep = vi.spyOn(ProcessDescendants, "sweepAttempt");
    const start = vi.spyOn(ProcessDescendants, "start");
    if (failure === "start")
      start.mockImplementationOnce(() => {
        throw new Error("Injected process tracking failure");
      });
    else {
      ownershipFault.failRecord = true;
      ownershipFault.beforeFail = async () => {
        const until = Date.now() + 5000;
        while (!(await readFile(pidFile, "utf8").catch(() => "")) && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 25));
      };
    }
    // The detached child survives the launcher's own cleanup, so only the sweep can reap it.
    let childPid = 0;
    try {
      await expect(
        env.spawn({ command: process.execPath, args: ["-e", detachedScript, pidFile] }),
      ).rejects.toThrow(/Injected|Process tree termination could not be confirmed/);
      const until = Date.now() + 5000;
      while (!childPid && Date.now() < until) {
        childPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (!childPid) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(childPid).toBeGreaterThan(0);
      // An unrecorded process leaves ownership uncertain, so the workspace is retained.
      await env.dispose().catch(() => undefined);
      expect(sweep.mock.calls[0]?.[0]).toBe(env.rootDirectory);
      expect(await hasLiveCwd(childPid)).toBe(false);
    } finally {
      ownershipFault.failRecord = false;
      ownershipFault.beforeFail = undefined;
      sweep.mockRestore();
      start.mockRestore();
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
      await rm(env.rootDirectory, { recursive: true, force: true });
    }
  },
  20_000,
);

it("refuses a spawn that resumes after dispose begins", async () => {
  const env = await new LocalExecutionEnvironmentProvider().provision(spec);
  let release = () => {};
  ownershipFault.holdPrepare = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepared = new Promise<void>((resolve) => {
    ownershipFault.prepared = resolve;
  });
  const disposing = vi.fn();
  ownershipFault.disposing = disposing;
  const start = vi.spyOn(ProcessDescendants, "start");
  let spawned: Promise<ProcessHandle> | undefined;
  let disposed: Promise<void> | undefined;
  try {
    spawned = env.spawn({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},1e4)"],
    });
    // Hold a persisted pending record, not an arbitrary interval after spawn().
    await prepared;
    disposed = env.dispose();
    // Attach handlers before checking the blocked state, including on the unfixed path.
    void spawned.catch(() => {});
    void disposed.catch(() => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposing).not.toHaveBeenCalled();
    release();
    await expect(spawned).rejects.toThrow(/has been disposed/);
    await expect(disposed).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    await expect(access(env.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    ownershipFault.holdPrepare = undefined;
    ownershipFault.prepared = undefined;
    ownershipFault.disposing = undefined;
    release();
    await Promise.allSettled([spawned, disposed]);
    await env.dispose().catch(() => {});
    start.mockRestore();
    await rm(env.rootDirectory, { recursive: true, force: true });
  }
});

it("reaps a detached child after its launcher exits before the first scan", async () => {
  const env = await new LocalExecutionEnvironmentProvider().provision(spec);
  const pidFile = join(env.rootDirectory, "orphan.pid");
  let childPid = 0;
  try {
    const handle = await env.spawn({
      command: process.execPath,
      args: ["-e", orphanedScript, pidFile],
    });
    const until = Date.now() + 5000;
    while (!childPid && Date.now() < until) {
      childPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (!childPid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(childPid).toBeGreaterThan(0);
    await expect(handle.wait()).resolves.toMatchObject({ exitCode: 0 });
    expect(await hasLiveCwd(childPid)).toBe(false);
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await env.dispose();
  }
}, 20_000);

it("does not change an external file through a scratch symlink", async () => {
  const env = await new LocalExecutionEnvironmentProvider().provision(spec);
  const external = await mkdtemp(join(tmpdir(), "reaper-symlink-"));
  const target = join(external, "target");
  try {
    await writeFile(target, "keep");
    await chmod(target, 0o400);
    await symlink(target, join(env.rootDirectory, "external-link"));
    expect((await lstat(join(env.rootDirectory, "external-link"))).isSymbolicLink()).toBe(true);
    await env.dispose();
    expect((await stat(target)).mode & 0o777).toBe(0o400);
  } finally {
    await rm(external, { recursive: true, force: true });
  }
});

// A harness child flushing its session transcript while the Attempt directory is removed made
// rmdir fail with ENOTEMPTY, which turned a durable wait into an unknown Task outcome.
it("confirms cleanup when a late writer races removal of the Attempt directory", async () => {
  const env = await new LocalExecutionEnvironmentProvider().provision(spec);
  const projects = join(env.rootDirectory, ".claude-config", "projects", "workspace");
  await mkdir(projects, { recursive: true });
  for (let index = 0; index < 200; index++)
    await writeFile(join(projects, `${index}.jsonl`), "{}\n");
  let writing = true;
  const writer = (async () => {
    const until = Date.now() + 60;
    for (let index = 0; writing && Date.now() < until; index++) {
      await writeFile(join(projects, `late-${index}.jsonl`), "{}\n").catch(() => undefined);
    }
  })();
  try {
    await expect(env.dispose("cancelled")).resolves.toBeUndefined();
  } finally {
    writing = false;
    await writer;
  }
  await expect(access(env.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["completed", "failed", "cancelled"] as const)(
  "kills a detached SIGTERM-ignoring tool child and removes scratch on %s",
  async (reason) => {
    const env = await new LocalExecutionEnvironmentProvider().provision(spec);
    const pidFile = join(env.rootDirectory, "detached.pid");
    const handle = await env.spawn({
      command: process.execPath,
      args: ["-e", detachedScript, pidFile],
    });
    let childPid = 0;
    let confirmed = false;
    try {
      const until = Date.now() + 5000;
      while (!childPid && Date.now() < until) {
        childPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (!childPid) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(childPid).toBeGreaterThan(0);
      await expect(env.dispose(reason)).resolves.toBeUndefined();
      await expect(access(env.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(handle.wait()).resolves.toMatchObject({ signal: "SIGTERM" });
      expect(await hasLiveCwd(childPid)).toBe(false);
      confirmed = true;
    } finally {
      if (!confirmed && childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
      if (!confirmed) handle.kill("SIGKILL");
    }
  },
  20_000,
);

it.each(["completed", "failed", "cancelled"] as const)(
  "reaps a detached tool process when the Worker ends %s",
  async (outcome) => {
    let root = "";
    let childPid = 0;
    let handle: ProcessHandle | undefined;
    let confirmed = false;
    const plan = spec.plan;
    const harness: Harness = {
      id: "reaper-test",
      describe: async () => ({
        sessions: { resume: false, export: false, scope: "none" as const },
        id: "reaper-test",
        version: "1",
        inputKinds: ["instruction"],
        streaming: true,
        cancellation: true,
        sessionPersistence: "none",
      }),
      plan: async () => ({ runtime: plan, execution: plan }),
      start: async (_plan, environments) => {
        const environment = environments.execution;
        root = environment.rootDirectory;
        return {
          async *run(signal) {
            const pidFile = join(root, "detached.pid");
            handle = await environment.spawn({
              command: process.execPath,
              args: ["-e", detachedScript, pidFile],
            });
            const until = Date.now() + 5000;
            while (!childPid && Date.now() < until) {
              childPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
              if (!childPid) await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(childPid).toBeGreaterThan(0);
            yield { type: "output.message" as const, text: "Tool launched" };
            if (outcome === "failed") throw new Error("Harness failed after launching a tool");
            if (outcome === "cancelled")
              await new Promise<void>((resolve) => {
                if (signal?.aborted) resolve();
                else signal?.addEventListener("abort", () => resolve(), { once: true });
              });
          },
          close: async () => {},
        };
      },
    };
    const worker = createWorker({
      id: "reaper-worker",
      profiles: [
        {
          ref: { id: "repository", revision: "1" },
          workerType: "supertag",
          harness: { provider: harness.id },
          execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
        },
      ],
      harnesses: [harness],
      environments: [new LocalExecutionEnvironmentProvider()],
    });
    try {
      const controller = new AbortController();
      const events = [];
      for await (const event of worker.execute(
        repositoryAttempt(`reaper-${outcome}`),
        controller.signal,
      )) {
        events.push(event);
        if (outcome === "cancelled" && event.type === "output.message") controller.abort();
      }
      expect(events.at(-1)?.type, JSON.stringify(events)).toBe(
        outcome === "completed" ? "execution.completed" : "execution.failed",
      );
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await hasLiveCwd(childPid)).toBe(false);
      confirmed = true;
    } finally {
      if (!confirmed && childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
      if (!confirmed) handle?.kill("SIGKILL");
    }
  },
  20_000,
);
