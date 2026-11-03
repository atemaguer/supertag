/** Deterministic Worker Host used by the distributed scheduling Docker acceptance test. */
import {
  COORDINATION_CAPABILITY,
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type TaskAttemptSpec,
  type Worker,
} from "../../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../../packages/runtime/transport/src/index.js";

const hostId = process.env["WORKER_HOST_ID"];
const credential = process.env["SUPERTAG_WORKLET_CREDENTIAL"];
const profileId = process.env["WORKER_PROFILE_ID"] ?? "general";
const capacity = Number(process.env["WORKER_CAPACITY"] ?? "1");
if (!hostId || !credential) throw new Error("Missing Worker Host configuration");
if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid Worker capacity");

const worker: Worker = {
  async describe() {
    const profile = { id: profileId, revision: "1" };
    const capabilities = [
      COORDINATION_CAPABILITY,
      { id: profileId === "special" ? "specialized" : "general", version: 1 },
    ];
    return {
      id: `${hostId}-worker`,
      type: "deterministic-scheduling",
      profiles: [profile],
      capabilities,
      contextTypes: [],
      profileCapabilities: [
        { profile, harness: `fixture-${profileId}`, capabilities, contextTypes: [] },
      ],
      maxConcurrency: capacity,
    };
  },
  async *execute(spec: TaskAttemptSpec, signal?: AbortSignal) {
    const instruction = spec.input.messages.find((message) => message.role === "requester")?.text;
    const match = /hold=(\d+)/u.exec(instruction ?? "");
    const holdMs = match ? Number(match[1]) : 25;
    const identity = {
      taskId: spec.taskId,
      attemptId: spec.attemptId,
      at: new Date().toISOString(),
    };
    yield { ...identity, type: "execution.started", workerId: `${hostId}-worker` };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, holdMs);
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Execution aborted"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    yield {
      ...identity,
      at: new Date().toISOString(),
      type: "output.message",
      message: { role: "teammate", text: `Completed on ${hostId}` },
    };
    yield { ...identity, at: new Date().toISOString(), type: "execution.completed" };
  },
};

const local = new LocalWorklet(`${hostId}-worklet`, hostId, [worker]);
const durable = new DurableLocalWorklet(local, new FileAttemptJournal("/state/journal"));
await connectWorklet({
  url: "wss://control-plane:8790/worklets",
  credential,
  worklet: local,
  durableWorklet: durable,
});
process.stdout.write(`Scheduling Worker ready: ${hostId}\n`);
await new Promise(() => {});
