import { expect, it } from "vitest";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import {
  collectTaskAttemptEvents,
  createWorker,
  type Harness,
  LocalExecutionEnvironmentProvider,
  type TaskAttemptSpec,
} from "../packages/runtime/sdk/src/index.js";

const secret = "explicit-secret-credential";

it("redacts a credential a harness streams across several deltas", async () => {
  const pieces = ["The token is ", "explicit-", "secret", "-cred", "ential, done."];
  const harness: Harness = {
    id: "probe",
    describe: async () => ({
      sessions: { resume: false, export: false, scope: "none" as const },
      id: "probe",
      version: "1",
      inputKinds: [],
      streaming: true,
      cancellation: true,
      sessionPersistence: "none",
    }),
    plan: async () => {
      const plan = {
        files: [],
        mounts: [],
        environmentVariables: {},
        secretBindings: [],
        network: { mode: "none" as const },
      };
      return { runtime: plan, execution: plan, outputs: [] };
    },
    start: async () => ({
      async *run() {
        for (const text of pieces) yield { type: "output.delta" as const, text };
      },
      close: async () => {},
    }),
  };
  const profile = {
    ref: { id: "probe", revision: "1" },
    workerType: "supertag",
    harness: { provider: "probe" },
    execution: { provider: "local-execution", lifetime: { scope: "attempt" as const } },
  };
  const worker = createWorker({
    id: "probe-worker",
    profiles: [profile],
    harnesses: [harness],
    environments: [new LocalExecutionEnvironmentProvider()],
    redactValues: [secret],
  });
  const at = "2026-11-06T00:00:00.000Z";
  const spec = {
    version: 1,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "Probe" },
    input: { messages: [] },
    authorization: {},
    contextPlan: emptyTagContextPlan(at),
    execution: {},
    workerProfile: profile.ref,
  } as unknown as TaskAttemptSpec;
  const events = await collectTaskAttemptEvents(worker.execute(spec));
  const deltas = events.flatMap((event) => (event.type === "output.delta" ? [event.text] : []));
  expect(deltas.join("")).toBe("The token is [REDACTED], done.");
  for (const delta of deltas) {
    expect(delta).not.toContain("explicit");
    expect(delta).not.toContain("cred");
  }
});
