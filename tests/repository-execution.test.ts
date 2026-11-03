import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runRepositoryExecution } from "./support/repository-execution.js";

it("edits the requested Git revision and independently verifies its immutable patch after producer disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repository-execution-"));
  try {
    const result = await runRepositoryExecution(directory);
    expect(result.outcome).toEqual({ passed: true, revision: result.revision, checks: 2 });
    expect(result.producerRemovedBeforeReview).toBe(true);
    expect(result.originalWorkingTree).toBe("uncommitted operator changes\n");
    expect(result.roots[0]).not.toBe(result.roots[1]);
    for (const root of result.roots) await expect(access(root)).rejects.toThrow();
    expect(result.patch.digest).toMatch(/^sha256:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

it.skipIf(process.platform === "win32")(
  "cancels TERM-resistant descendants before removing their execution directory",
  async () => {
    const { readFile } = await import("node:fs/promises");
    const { collectTaskAttemptEvents, createWorker, LocalExecutionEnvironmentProvider } =
      await import("../packages/runtime/sdk/src/index.js");
    const { repositoryAttempt } = await import("./support/repository-execution.js");
    const abort = new AbortController();
    let root = "";
    let pids: number[] = [];
    const harness: import("../packages/runtime/sdk/src/index.js").Harness = {
      id: "stubborn",
      async describe() {
        return {
          sessions: { resume: false, export: false, scope: "none" as const },
          id: "stubborn",
          version: "1",
          inputKinds: [],
          streaming: true,
          cancellation: true,
          sessionPersistence: "none",
        };
      },
      async plan() {
        return {
          runtime: emptyEnvironmentPlan(),
          execution: {
            ...emptyEnvironmentPlan(),
            files: [
              {
                path: "tree.cjs",
                content:
                  "const fs=require('node:fs'),cp=require('node:child_process');process.on('SIGTERM',()=>{});fs.appendFileSync('pids.txt',process.pid+'\\n');const depth=Number(process.argv[2]);if(depth>0)cp.spawn(process.execPath,[__filename,String(depth-1)],{stdio:'ignore'});setInterval(()=>{},1000);",
              },
            ],
          },
        };
      },
      async start(_plan, environments) {
        const environment = environments.execution;
        root = environment.rootDirectory;
        return {
          async *run(signal) {
            const child = await environment.spawn(
              { command: process.execPath, args: ["tree.cjs", "2"], timeoutMs: 15000 },
              signal,
            );
            await child.wait();
            yield { type: "output.message", text: "Should not finish normally" };
          },
          async close() {},
        };
      },
    };
    const worker = createWorker({
      id: "stubborn-worker",
      profiles: [
        {
          ref: { id: "repository", revision: "1" },
          workerType: "stubborn",
          harness: { provider: "stubborn" },
          execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
        },
      ],
      harnesses: [harness],
      environments: [new LocalExecutionEnvironmentProvider()],
    });
    const execution = collectTaskAttemptEvents(
      worker.execute(repositoryAttempt("stubborn"), abort.signal),
    );
    // Attach rejection handling immediately while waiting for process startup.
    const settled = execution.then(
      (events) => ({ events, error: undefined }),
      (error) => ({ events: [], error }),
    );
    try {
      await expect
        .poll(
          async () => {
            if (!root) return 0;
            pids = await readFile(join(root, "pids.txt"), "utf8").then(
              (text) => text.trim().split("\n").map(Number),
              () => [],
            );
            return pids.length;
          },
          { timeout: 5000 },
        )
        .toBe(3);
      const started = Date.now();
      abort.abort(new Error("Stop stubborn repository execution"));
      const result = await settled;
      expect(Date.now() - started).toBeLessThan(10000);
      expect(result.events.some((event) => event.type === "execution.completed")).toBe(false);
      await expect
        .poll(
          () =>
            pids.every((pid) => {
              try {
                process.kill(pid, 0);
                return false;
              } catch (error) {
                return (error as NodeJS.ErrnoException).code === "ESRCH";
              }
            }),
          { timeout: 3000 },
        )
        .toBe(true);
      await expect(access(root)).rejects.toThrow();
    } finally {
      abort.abort();
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await settled;
      if (root) await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);

function emptyEnvironmentPlan() {
  return {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" as const },
  };
}
