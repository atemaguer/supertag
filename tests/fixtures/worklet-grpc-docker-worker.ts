/** A real Worker/Worklet process; the Harness is deterministic and makes no model calls. */
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { SharedExecutionEnvironmentProvider } from "../../packages/runtime/environments/shared-execution/src/index.js";
import {
  createWorker,
  DurableLocalWorklet,
  FileAttemptJournal,
  type Harness,
  LocalHarnessRuntimeProvider,
  LocalWorklet,
  type WorkerProfile,
} from "../../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../../packages/runtime/transport/src/index.js";

const id = process.env["WORKER_ID"];
const adminToken = process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"];
const credential = process.env["SUPERTAG_WORKLET_CREDENTIAL"];
if (!id || !adminToken || !credential) throw new Error("Missing Worker configuration");
const tlsCa = await readFile("/certificates/server.crt", "utf8");
const execution = new SharedExecutionEnvironmentProvider({
  baseUrl: "https://execution:8788",
  adminToken,
  environmentId: "docker-grpc-shared",
  transport: "grpc",
  tlsCa,
});
const runtime = new LocalHarnessRuntimeProvider();
const plan = {
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "unrestricted" as const },
};
const harness: Harness = {
  id: "distributed-fixture",
  async describe() {
    return {
      sessions: { resume: false, export: false, scope: "none" as const },
      id: this.id,
      version: "1",
      inputKinds: ["instruction", "tool"],
      streaming: true,
      cancellation: true,
      sessionPersistence: "none",
      runtimePlacements: ["local", "remote"],
      splitExecution: true,
      toolIsolation: { managerOnly: true, schemaIsolation: "hard" },
    };
  },
  async plan() {
    return { runtime: plan, execution: plan };
  },
  async start(_plan, environments, context) {
    const taskId = context.attempt.taskId;
    return {
      async *run(signal) {
        const mode = taskId.split("-")[0];
        if (mode === "profile") {
          yield {
            type: "output.message" as const,
            text: `profile:${context.attempt.workerProfile.id}`,
          };
          return;
        }
        if (mode === "reader") {
          yield {
            type: "output.message" as const,
            text: await environments.execution.read("pooled.txt"),
          };
          return;
        }
        const script =
          mode === "writer"
            ? "const fs=require('fs');fs.appendFileSync('effects.txt','writer\\n');fs.writeFileSync('pooled.txt','pooled conclusion');console.log('written')"
            : mode === "reconnect"
              ? "const fs=require('fs');fs.appendFileSync('effects.txt','reconnect\\n');let n=0;let t=setInterval(()=>{console.log('chunk-'+n++);if(n===150){clearInterval(t);console.log('resumed')}},100)"
              : mode === "survivor"
                ? "setTimeout(()=>{require('fs').appendFileSync('effects.txt','survivor\\n');console.log('survived')},3000)"
                : "require('fs').appendFileSync('effects.txt','" +
                  mode +
                  "\\n');console.log('started');setInterval(()=>console.log('alive'),200)";
        const child = await environments.execution.spawn(
          { command: "node", args: ["-e", script], streamOutput: true },
          signal,
        );
        if (!child.output) throw new Error("Shared process must stream output");
        for await (const chunk of child.output)
          yield { type: "output.delta" as const, text: chunk.text };
        const result = await child.wait();
        if (result.exitCode !== 0)
          throw new Error(`Process stopped: ${result.signal ?? result.exitCode}`);
        yield { type: "output.message" as const, text: result.stdout.trim() };
      },
      async close() {},
    };
  },
};
const profile = (profileId: string): WorkerProfile => ({
  ref: { id: profileId, revision: "1" },
  workerType: "fixture",
  harness: { provider: harness.id },
  runtime: { provider: runtime.id, lifetime: { scope: "attempt" } },
  execution: { provider: execution.id, lifetime: { scope: "attempt" } },
});
const worker = createWorker({
  id: `${id}-worker`,
  profiles: [profile(id), profile(`${id}-specialist`)],
  harnesses: [harness],
  harnessRuntimes: [runtime],
  environments: [execution],
});
const worklet = new LocalWorklet(`${id}-worklet`, id, [worker]);
const durableWorklet = new DurableLocalWorklet(worklet, new FileAttemptJournal("/state/journal"));
const connection = await connectWorklet({
  url: "https://control-plane:8789",
  transport: "grpc",
  tlsCa,
  credential,
  worklet,
  durableWorklet,
  reconnectIntervalMs: 100,
});
process.stdout.write(`${JSON.stringify({ ready: true, hostname: hostname(), id })}\n`);
process.once("SIGTERM", async () => {
  await connection.stop();
  await durableWorklet.shutdown("Fixture stopping");
  process.exit(0);
});
