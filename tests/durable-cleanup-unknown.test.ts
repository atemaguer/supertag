import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyTagContextPlan, type TagAuthorizationSnapshot } from "../packages/core/src/index.ts";
import {
  createWorker,
  DurableLocalWorklet,
  ExecutionCleanupError,
  type ExecutionEnvironment,
  FileAttemptJournal,
  type Harness,
  LocalWorklet,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.ts";

it("keeps cancelled cleanup failures unknown and reserves capacity across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-unknown-"));
  const worker: Worker = {
    async describe() {
      return {
        profileCapabilities: [
          { profile: { id: "static", revision: "1" }, capabilities: [], contextTypes: [] },
        ],
        id: "worker",
        type: "test",
        profiles: [{ id: "static", revision: "1" }],
        capabilities: [],
        contextTypes: [],
        maxConcurrency: 1,
      };
    },
    async *execute(spec, signal) {
      yield {
        type: "execution.started",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: "now",
        workerId: "worker",
      };
      if (!signal?.aborted)
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      throw new ExecutionCleanupError("child ownership unresolved");
    },
  };
  const worklet = new LocalWorklet("local", "host", [worker]);
  let durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  const spec = taskAttemptSpec();
  try {
    await durable.accept(spec);
    await expect.poll(async () => (await durable.inspect(spec.attemptId))?.status).toBe("running");
    await durable.cancel(spec.attemptId, "stop");
    await expect.poll(async () => (await durable.inspect(spec.attemptId))?.status).toBe("unknown");
    await expect(durable.accept({ ...spec, attemptId: "second" })).rejects.toThrow(/capacity/);
    await durable.close();
    durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    expect((await durable.inspect(spec.attemptId))?.status).toBe("unknown");
    await expect(durable.accept({ ...spec, attemptId: "second" })).rejects.toThrow(/capacity/);
  } finally {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["completed", "failed", "uncertain", "nested"] as const)(
  "durably retains redacted cleanup causes after a %s Harness run without terminal proof",
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "cleanup-evidence-"));
    const secret = "cleanup-private-token";
    const cause = new Error(`Termination not confirmed using ${secret}`);
    cause.cause = cause;
    cause.stack = "PRIVATE_STACK_MUST_NOT_APPEAR";
    Object.assign(cause, { privateData: "PRIVATE_FIELD_MUST_NOT_APPEAR" });
    const environment: ExecutionEnvironment = {
      id: "fixture",
      placement: "local",
      rootDirectory: "/fixture",
      prepare: async () => {},
      read: async () => "",
      resolvePath: (path) => `/fixture/${path}`,
      spawn: async () => {
        throw new Error("unused");
      },
      dispose: async () => {
        if (outcome !== "uncertain") throw cause;
      },
    };
    const plan = {
      files: [],
      mounts: [],
      environmentVariables: {},
      secretBindings: [],
      network: { mode: "none" as const },
    };
    const harness: Harness = {
      id: "fixture",
      describe: async () => ({
        sessions: { resume: false, export: false, scope: "none" as const },
        id: "fixture",
        version: "1",
        inputKinds: [],
        streaming: true,
        cancellation: true,
        sessionPersistence: "none",
      }),
      resolve: async () => ({ capabilities: await harness.describe() }),
      plan: async () => ({ runtime: plan, execution: plan }),
      start: async () => ({
        async *run() {
          if (outcome === "failed") throw new Error(`Model request failed using ${secret}`);
          if (outcome === "nested") {
            const diagnostic = new Error(`Native DNS lookup failed using ${secret}`);
            const primary = new Error(`Native request failed using ${secret}`, {
              cause: diagnostic,
            });
            diagnostic.cause = primary;
            diagnostic.stack = "PRIVATE_STACK_MUST_NOT_APPEAR";
            Object.assign(diagnostic, { privateData: "PRIVATE_FIELD_MUST_NOT_APPEAR" });
            throw new ExecutionCleanupError("Claude MCP cleanup could not be confirmed", {
              cause: new AggregateError([
                primary,
                ...Array.from(
                  { length: 20 },
                  (_, index) => new Error(`MCP cleanup ${index} ${secret}`),
                ),
              ]),
            });
          }
          if (outcome === "uncertain")
            throw new ExecutionCleanupError("Process ownership uncertain", { cause });
          yield { type: "output.message", text: "Work finished" };
        },
        close: async () => {
          if (outcome !== "uncertain")
            throw new Error(`Close refused ${"x".repeat(130)} ${secret} ${"x".repeat(500)}`, {
              cause,
            });
        },
      }),
    };
    const spec = taskAttemptSpec();
    const worker = createWorker({
      id: "worker",
      redactValues: [secret],
      profiles: [
        {
          ref: spec.workerProfile,
          workerType: "fixture",
          harness: { provider: "fixture" },
          execution: { provider: "fixture", lifetime: { scope: "attempt" } },
        },
      ],
      harnesses: [harness],
      environments: [{ id: "fixture", capabilities: [], provision: async () => environment }],
    });
    const durable = new DurableLocalWorklet(
      new LocalWorklet("local", "host", [worker]),
      new FileAttemptJournal(directory),
    );
    try {
      await durable.accept(spec);
      await expect
        .poll(async () => (await durable.inspect(spec.attemptId))?.status)
        .toBe("unknown");
      await durable.close();
      const reopened = new FileAttemptJournal(directory);
      try {
        const records = await reopened.readAll();
        expect(records[0]?.inspection.status).toBe("unknown");
        const events = records[0]?.events.map((entry) => entry.event) ?? [];
        expect(
          events.some(
            (event) => event.type === "execution.failed" || event.type === "execution.completed",
          ),
        ).toBe(false);
        const progress = events.filter((event) => event.type === "progress.updated");
        expect(progress).toHaveLength(1);
        expect(progress[0]?.progress.summary).toContain("cleanup could not be confirmed");
        const items = progress[0]?.progress.items ?? [];
        expect(items.length).toBeLessThanOrEqual(8);
        expect(items.every((item) => item.status === "blocked" && item.text.length <= 160)).toBe(
          true,
        );
        const stored = JSON.stringify(records);
        if (outcome !== "nested")
          expect(stored).toContain("Termination not confirmed using [REDACTED]");
        if (outcome === "failed")
          expect(stored).toContain(
            "Original execution error: Error: Model request failed using [REDACTED]",
          );
        if (outcome === "nested") {
          expect(items[0]?.text).toContain("Original execution error: ExecutionCleanupError:");
          expect(stored).toContain("Native request failed using [REDACTED]");
          expect(stored).toContain("Native DNS lookup failed using [REDACTED]");
          expect(stored).toContain("Harness execution cleanup failed");
          expect(stored).toContain("Close refused");
        } else if (outcome !== "uncertain") {
          expect(stored).toContain("Harness execution cleanup failed");
          expect(stored).toContain("Execution environment cleanup failed");
        }
        expect(stored).not.toContain(secret);
        expect(stored).not.toContain("cleanup-private");
        expect(stored).not.toContain("PRIVATE_STACK");
        expect(stored).not.toContain("PRIVATE_FIELD");
      } finally {
        await reopened.close();
      }
    } finally {
      await durable.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("redacts host-resolved values from a thrown Worker error's stored uncertainty reason", async () => {
  // Only the Worker knows `secret` is sensitive: it is not in the spec the journal redacts by.
  const directory = await mkdtemp(join(tmpdir(), "cleanup-reason-"));
  const secret = "host-resolved-private-value";
  const environment: ExecutionEnvironment = {
    id: "fixture",
    placement: "local",
    rootDirectory: "/fixture",
    prepare: async () => {},
    read: async () => "",
    resolvePath: (path) => `/fixture/${path}`,
    spawn: async () => {
      throw new Error("unused");
    },
    dispose: async () => {},
  };
  const plan = {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" as const },
  };
  const harness: Harness = {
    id: "fixture",
    describe: async () => ({
      sessions: { resume: false, export: false, scope: "none" as const },
      id: "fixture",
      version: "1",
      inputKinds: [],
      streaming: true,
      cancellation: true,
      sessionPersistence: "none",
    }),
    resolve: async () => ({ capabilities: await harness.describe() }),
    plan: async () => ({ runtime: plan, execution: plan }),
    start: async () => ({
      // biome-ignore lint/correctness/useYield: the run ends by throwing.
      async *run() {
        throw new ExecutionCleanupError(`Process tree holding ${secret} did not exit`);
      },
      close: async () => {},
    }),
  };
  const spec = taskAttemptSpec();
  const worker = createWorker({
    id: "worker",
    redactValues: [secret],
    profiles: [
      {
        ref: spec.workerProfile,
        workerType: "fixture",
        harness: { provider: "fixture" },
        execution: { provider: "fixture", lifetime: { scope: "attempt" } },
      },
    ],
    harnesses: [harness],
    environments: [{ id: "fixture", capabilities: [], provision: async () => environment }],
  });
  const durable = new DurableLocalWorklet(
    new LocalWorklet("local", "host", [worker]),
    new FileAttemptJournal(directory),
  );
  try {
    await durable.accept(spec);
    await expect.poll(async () => (await durable.inspect(spec.attemptId))?.status).toBe("unknown");
    expect((await durable.inspect(spec.attemptId))?.uncertainty).toMatchObject({
      name: "ExecutionCleanupError",
      message: "Process tree holding [REDACTED] did not exit",
    });
    await durable.close();
    const reopened = new FileAttemptJournal(directory);
    try {
      const records = await reopened.readAll();
      const uncertain = records[0]?.events.find(
        (entry) => entry.event.type === "execution.uncertain",
      );
      expect(JSON.stringify(uncertain)).toContain("Process tree holding [REDACTED] did not exit");
      expect(JSON.stringify(records)).not.toContain(secret);
    } finally {
      await reopened.close();
    }
  } finally {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function taskAttemptSpec(workerProfile = { id: "static", revision: "1" }): TaskAttemptSpec {
  const capturedAt = "2026-08-02T00:00:00.000Z";
  const authorization: TagAuthorizationSnapshot = {
    version: 5,
    capturedAt,
    tag: { id: "tag-1", name: "Engineering" },
    origin: {
      tagRouteId: "surface-1",
      surfaceAccountId: "account-1",
      provider: "slack",
      scope: "channel:general",
    },
    requester: { id: "user-1", kind: "user" },
    permissionSets: [{ id: "permissions-1", name: "engineering" }],
    resources: [
      {
        surfaceAccountId: "account-1",
        provider: "slack",
        scope: "channel:general",
        actions: ["history:read"],
        sources: ["permission-set"],
      },
    ],
    runtimeActions: [],
  };
  return {
    execution: {},
    version: 1,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "slack",
        accountId: "account-1",
        scope: "channel:general",
        sessionKey: "slack:account-1:general:thread-1",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text: "How does this work?" }],
    },
    authorization,
    contextPlan: emptyTagContextPlan(capturedAt),
    workerProfile,
  };
}
