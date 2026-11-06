import { expect, it } from "vitest";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import {
  collectTaskAttemptEvents,
  createWorker,
  type Harness,
  LocalExecutionEnvironmentProvider,
  type TaskAttemptSpec,
} from "../packages/runtime/sdk/src/index.js";
import { redactText, streamRedactionBoundary } from "../packages/runtime/sdk/src/redaction.js";

const secret = "explicit-secret-credential";

it("holds a streamed tail that could still complete a sensitive value", () => {
  expect(streamRedactionBoundary("the key is explicit-se", [secret])).toBe("the key is ".length);
  expect(streamRedactionBoundary("plain text ", [secret])).toBe("plain text ".length);
  // A whole value crossing into a held tail is held with it.
  expect(streamRedactionBoundary("ab abcd", ["abcd", "cdxyz"])).toBe(3);
  // Encodings and low-confidence words are held too.
  const base64 = Buffer.from(secret).toString("base64");
  expect(streamRedactionBoundary(`b64 ${base64.slice(0, 10)}`, [secret])).toBe(4);
  expect(streamRedactionBoundary("password is Sup", [{ lowConfidence: "supertag" }])).toBe(12);
  // URL userinfo and Basic credentials end only at whitespace.
  expect(streamRedactionBoundary("see https://user:pa", [])).toBe(4);
  expect(streamRedactionBoundary("Authorization: Basic dXNl", [])).toBe(15);
  expect(redactText("Basic dXNlcjpwYXNz", [])).toBe("Basic [REDACTED]");
});

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
