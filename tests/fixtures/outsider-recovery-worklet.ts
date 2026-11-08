import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DurableLocalWorklet,
  defaultTaskResult,
  FileAttemptJournal,
  LocalExecutionEnvironmentProvider,
  LocalWorklet,
  type Worker,
} from "../../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../../packages/runtime/transport/src/index.js";

const [url, directory, hostId] = process.argv.slice(2) as [string, string, string];
const credential = process.env["SUPERTAG_TEST_WORKLET_CREDENTIAL"];
if (!credential) throw new Error("Missing test credential");
/**
 * Which turn the Control Plane sent. Task ids are generated, so the turn names itself in its
 * request text: `interrupt` blocks until the Attempt is cancelled, anything else replies.
 */
function turnOf(spec: {
  readonly input: { readonly messages: readonly { readonly text?: string }[] };
}) {
  const text = spec.input.messages.map((message) => message.text ?? "").join(" ");
  return text.includes("INTERRUPT") ? "interrupt" : "after-restart";
}

const worker: Worker = {
  async describe() {
    return {
      profileCapabilities: [
        {
          profile: { id: "recovery", revision: "1" },
          capabilities: [{ id: "supertag.coordination", version: 1 }],
          contextTypes: [],
        },
      ],
      id: "recovery-worker",
      type: "test",
      profiles: [{ id: "recovery", revision: "1" }],
      contextTypes: [],
      capabilities: [{ id: "supertag.coordination", version: 1 }],
      maxConcurrency: 1,
    };
  },
  async *execute(spec, signal) {
    const identity = {
      taskId: spec.taskId,
      attemptId: spec.attemptId,
      at: new Date().toISOString(),
    };
    const turn = turnOf(spec);
    await appendFile(join(directory, "executions"), `${turn}\n`);
    yield { ...identity, type: "execution.started", workerId: "recovery-worker" };
    if (turn === "interrupt")
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    // The durable Worklet records cancellation from the abort; there is no cancelled event.
    if (signal?.aborted) return;
    yield {
      ...identity,
      type: "output.message",
      message: { role: "teammate", text: "Deterministic result" },
    };
    yield { ...identity, type: "result", result: defaultTaskResult("Deterministic result") };
    yield { ...identity, type: "execution.completed" };
  },
};
let selectedWorker = worker;
if (process.env["SUPERTAG_LIVE_CLEANUP_RECOVERY"] === "1") {
  const { createCodexWorker } = await import("../../packages/runtime/harnesses/codex/src/index.js");
  const temporaryDirectory = join(directory, "attempt-roots");
  await mkdir(temporaryDirectory, { recursive: true });
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const native = createCodexWorker({
    workerId: "recovery-worker",
    profileId: "recovery",
    workspace,
    executionEnvironment: new LocalExecutionEnvironmentProvider({ temporaryDirectory }),
    timeoutMs: 180000,
  });
  selectedWorker = {
    describe: () => native.describe(),
    recoverExecutionCleanup: (task, attempt, digest) =>
      native.recoverExecutionCleanup?.(task, attempt, digest) ?? Promise.resolve(false),
    async *execute(spec, signal) {
      await appendFile(join(directory, "executions"), `${turnOf(spec)}\n`);
      yield* native.execute(spec, signal);
    },
  };
}
const local = new LocalWorklet(hostId, hostId, [selectedWorker]);
const durable = new DurableLocalWorklet(local, new FileAttemptJournal(join(directory, "journal")));
const connection = await connectWorklet({
  url,
  credential,
  worklet: local,
  durableWorklet: durable,
  reconnectIntervalMs: 50,
});
process.stdout.write("ready\n");
process.once("SIGTERM", () => {
  void (async () => {
    await durable.shutdown("Test shutdown");
    await connection.stop();
    process.exit(0);
  })();
});
