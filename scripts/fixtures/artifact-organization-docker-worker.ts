/** Real model-backed Worker Host for the opt-in Docker organization artifact validation. */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CodexHarness } from "supertag-ai/harnesses/codex";
import { connectWorklet } from "supertag-ai/transport";
import {
  createWorker,
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalExecutionEnvironmentProvider,
  LocalWorklet,
} from "supertag-ai/worker";

const id = process.env["WORKER_ID"];
const credential = process.env["SUPERTAG_WORKLET_CREDENTIAL"];
if (!id || !credential) throw new Error("Missing Worker Host enrollment configuration");
const stateDirectory = resolve(process.env["SUPERTAG_STATE_DIR"] ?? "/state");
const attemptDirectory = join(stateDirectory, "attempts");
const seedDirectory = join(stateDirectory, "seed");
await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
await mkdir(seedDirectory, { recursive: true, mode: 0o700 });
// Native subscription auth is staged into this container's private HOME externally.
// Do not allow inherited API credentials to change the model billing path.
for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete process.env[key];
const timeoutMs = Number(process.env["SUPERTAG_LIVE_ATTEMPT_MS"] ?? 300000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
  throw new Error("SUPERTAG_LIVE_ATTEMPT_MS must be a positive integer");

const harness = new CodexHarness({
  workspace: seedDirectory,
  model: process.env["SUPERTAG_LIVE_CODEX_MODEL"] ?? "gpt-5.6-luna",
  executionMode: "app-server",
  sandboxMode: "native",
  maxNativeAgents: 0,
  timeoutMs,
});
const start = harness.start.bind(harness);
// Observe actual native provenance independently of catalog metadata, without changing execution.
harness.start = async (...args) => {
  const execution = await start(...args);
  const attempt = args[2].attempt;
  const run = execution.run.bind(execution);
  execution.run = async function* (...runArgs) {
    try {
      yield* run(...runArgs);
    } finally {
      if (execution.session)
        process.stdout.write(
          `${JSON.stringify({
            type: "native-session",
            taskId: attempt.taskId,
            attemptId: attempt.attemptId,
            harnessSession: execution.session,
          })}\n`,
        );
    }
  };
  return execution;
};
const environment = new LocalExecutionEnvironmentProvider({
  temporaryDirectory: attemptDirectory,
});
const worker = createWorker({
  id: `${id}-worker`,
  profiles: [
    {
      ref: { id, revision: "1" },
      workerType: "supertag",
      harness: { provider: harness.id },
      execution: { provider: environment.id, lifetime: { scope: "attempt" } },
    },
  ],
  harnesses: [harness],
  environments: [environment],
  maxConcurrency: 1,
  redactValues: [credential],
});
const worklet = new LocalWorklet(`${id}-worklet`, id, [worker]);
const durableWorklet = new DurableLocalWorklet(
  worklet,
  new FileAttemptJournal(join(stateDirectory, "journal")),
);
const connection = await connectWorklet({
  url: process.env["SUPERTAG_WORKLET_URL"] ?? "wss://control-plane:8790/worklets",
  credential,
  worklet,
  durableWorklet,
  reconnectIntervalMs: 500,
  onError: (error) => {
    process.stderr.write(`${String(error).replaceAll(credential, "[redacted]")}\n`);
  },
});
process.stdout.write("Artifact organization Worker ready\n");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    try {
      await durableWorklet.shutdown("Artifact organization validation stopped");
      await connection.stop();
      process.exitCode = 0;
    } catch {
      process.stderr.write("Artifact organization Worker shutdown failed\n");
      process.exitCode = 1;
    }
  });
