import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { emptyTagContextPlan, type TagAuthorizationSnapshot } from "@supertag/core";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import {
  DurableLocalWorklet,
  ExecutionCleanupError,
  FileAttemptJournal,
  type HarnessControlCommand,
  LocalHarnessExecutionControl,
  LocalWorklet,
  REPORTED_TOKEN_LIMIT_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worker,
  type Worklet,
} from "./src/index.js";

// Under a busy full-suite run these tests can exceed vitest's 5-second default timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

it("persists once, reconnects by cursor, redacts tokens, and holds capacity through cancellation cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-worklet-"));
  let starts = 0;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worklet: Worklet = {
    id: "local",
    async describe() {
      return {
        id: "local",
        protocolVersion: 1,
        host: {
          id: "host",
          workers: [
            {
              profileCapabilities: [
                {
                  profile: { id: "static", revision: "1" },
                  capabilities: [{ id: "supertag.coordination", version: 1 }],
                  contextTypes: [],
                },
              ],
              id: "worker",
              type: "test",
              profiles: [{ id: "static", revision: "1" }],
              contextTypes: [],
              maxConcurrency: 1,
              capabilities: [{ id: "supertag.coordination", version: 1 }],
            },
          ],
        },
      };
    },
    async *execute(spec, signal) {
      starts++;
      yield {
        type: "output.delta",
        text: spec.coordination?.token ?? "",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: "now",
      };
      if (!signal?.aborted)
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      await cleanup;
    },
  };
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  const spec = {
    ...taskAttemptSpec(),
    coordination: {
      controlPlaneUrl: "http://localhost",
      objectiveId: "objective",
      token: "secret-token-value",
    },
  };
  try {
    expect(await durable.selectExecution({}, spec.contextPlan)).toEqual(spec.workerProfile);
    await expect(durable.accept({ ...spec, execution: { harness: "codex" } })).rejects.toThrow(
      /capacity/,
    );
    const receipts = await Promise.all([durable.accept(spec), durable.accept(spec)]);
    expect(await durable.selectExecution({}, spec.contextPlan)).toBeUndefined();
    expect(receipts[0]?.specDigest).toBe(receipts[1]?.specDigest);
    await expect(durable.accept({ ...spec, taskId: "different" })).rejects.toThrow(/conflict/);
    await expect(durable.accept({ ...spec, attemptId: "second" })).rejects.toThrow(/capacity/);
    const observer = new AbortController();
    for await (const entry of durable.events(spec.attemptId, 0, observer.signal)) {
      expect(entry.sequence).toBe(1);
      expect(entry.event).toMatchObject({ text: "[REDACTED]" });
      observer.abort();
    }
    expect((await durable.inspect(spec.attemptId))?.status).toBe("running");
    expect(starts).toBe(1);
    await durable.cancel(spec.attemptId, "stop");
    await expect(durable.accept({ ...spec, attemptId: "second" })).rejects.toThrow(/capacity/);
    release();
    for await (const _ of durable.events(spec.attemptId, 1)) {
      throw new Error("Cursor replayed old event");
    }
    expect((await durable.inspect(spec.attemptId))?.status).toBe("cancelled");
    await expect(
      new DurableLocalWorklet(worklet, new FileAttemptJournal(directory)).inspect(spec.attemptId),
    ).rejects.toThrow();
    await durable.close();
    const restarted = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    expect((await restarted.accept(spec)).status).toBe("cancelled");
    expect(starts).toBe(1);
    await restarted.close();
    for (const name of await readdir(directory))
      expect(await readFile(join(directory, name), "utf8")).not.toContain("secret-token-value");
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

it("replays an applied Harness limit report after a durable Worklet restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-worklet-limits-"));
  const worklet: Worklet = {
    id: "limited",
    async describe() {
      return {
        id: "limited",
        protocolVersion: 1,
        host: {
          id: "host",
          workers: [
            {
              profileCapabilities: [
                {
                  profile: { id: "static", revision: "1" },
                  capabilities: [REPORTED_TOKEN_LIMIT_CAPABILITY],
                  contextTypes: [],
                },
              ],
              id: "worker",
              type: "test",
              profiles: [{ id: "static", revision: "1" }],
              contextTypes: [],
              maxConcurrency: 1,
              capabilities: [REPORTED_TOKEN_LIMIT_CAPABILITY],
            },
          ],
        },
      };
    },
    async *execute(spec) {
      const identity = {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: "2026-09-12T00:00:00.000Z",
      };
      yield { type: "execution.started", ...identity, workerId: "worker" } as const;
      yield {
        type: "execution.limits.applied",
        ...identity,
        requested: { maxReportedTokens: 1_000 },
        applied: {
          maxNativeAgents: { limit: 0, method: "harness-guard" },
          maxReportedTokens: { limit: 800, method: "interrupt-on-report" },
        },
      } as const;
      yield { type: "execution.completed", ...identity } as const;
    },
  };
  const spec = {
    ...taskAttemptSpec(),
    execution: { limits: { maxReportedTokens: 1_000 } },
  } satisfies TaskAttemptSpec;
  try {
    const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    await durable.accept(spec);
    const first: { readonly event: TaskAttemptEvent }[] = [];
    for await (const entry of durable.events(spec.attemptId, 0)) first.push(entry);
    expect(first.map(({ event }) => event.type)).toEqual([
      "execution.started",
      "execution.limits.applied",
      "execution.completed",
    ]);
    await durable.close();

    const restarted = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    const replayed: { readonly event: TaskAttemptEvent }[] = [];
    for await (const entry of restarted.events(spec.attemptId, 0)) replayed.push(entry);
    expect(replayed[1]?.event).toMatchObject({
      type: "execution.limits.applied",
      requested: { maxReportedTokens: 1_000 },
      applied: {
        maxNativeAgents: { limit: 0, method: "harness-guard" },
        maxReportedTokens: { limit: 800, method: "interrupt-on-report" },
      },
    });
    await restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects an unknown Worker event before writing it to the attempt journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-worklet-"));
  const journal = new FileAttemptJournal(directory);
  try {
    await journal.initialize();
    const inspection = {
      attemptId: "attempt",
      taskId: "task",
      specDigest: "digest",
      status: "running" as const,
      lastSequence: 0,
    };
    journal.putInspection(inspection);
    expect(() =>
      journal.append(inspection, {
        type: "future.unknown",
        taskId: "task",
        attemptId: "attempt",
        at: new Date().toISOString(),
      } as unknown as TaskAttemptEvent),
    ).toThrow(/Invalid Worker event type/);
    expect(journal.readEvents("attempt")).toEqual([]);
    expect(journal.inspections()).toEqual([inspection]);
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("recovers unfinished receipts as unknown without execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-worklet-"));
  const journal = new FileAttemptJournal(directory);
  await journal.initialize();
  await journal.write({
    inspection: {
      attemptId: "orphan",
      taskId: "task",
      specDigest: "digest",
      status: "running",
      lastSequence: 0,
    },
    events: [],
  });
  await journal.close();
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  await writeFile(
    join(directory, "owner.lock"),
    JSON.stringify({ pid: child.pid, host: hostname(), ownership: "sqlite" }),
    { mode: 0o600 },
  );
  const worklet: Worklet = {
    id: "local",
    async describe() {
      return { id: "local", protocolVersion: 1, host: { id: "host", workers: [] } };
    },
    execute() {
      throw new Error("Must never restart");
    },
  };
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  try {
    expect((await durable.inspect("orphan"))?.status).toBe("unknown");
    await durable.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("operator shutdown waits for iterator cleanup and releases the journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-shutdown-"));
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const worklet: Worklet = {
    id: "local",
    async describe() {
      return {
        id: "local",
        protocolVersion: 1,
        host: {
          id: "host",
          workers: [
            {
              profileCapabilities: [
                { profile: { id: "static", revision: "1" }, capabilities: [], contextTypes: [] },
              ],
              id: "worker",
              type: "test",
              profiles: [{ id: "static", revision: "1" }],
              capabilities: [],
              contextTypes: [],
            },
          ],
        },
      };
    },
    async *execute(spec, signal) {
      entered();
      yield {
        type: "execution.started",
        workerId: "worker",
        attemptId: spec.attemptId,
        taskId: spec.taskId,
        at: "now",
      };
      if (!signal?.aborted)
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      await cleanup;
    },
  };
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  try {
    await durable.accept(taskAttemptSpec());
    await running;
    let stopped = false;
    const shutdown = durable.shutdown("operator stop").then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    await expect(durable.accept({ ...taskAttemptSpec(), attemptId: "later" })).rejects.toThrow(
      /closing/,
    );
    finish();
    await shutdown;
    const restarted = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    expect((await restarted.inspect("attempt-1"))?.status).toBe("cancelled");
    await restarted.close();
  } finally {
    finish();
    await rm(directory, { recursive: true, force: true });
  }
});

it("dispatches exactly to the reserved Worker and rejects ambiguous wrappers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-routing-"));
  const selected: string[] = [];
  const worker = (id: string, profiles: string[]): Worker => ({
    async describe() {
      return {
        profileCapabilities: profiles
          .map((id) => ({ id, revision: "1" }))
          .map((profile) => ({ profile, capabilities: [], contextTypes: [] })),
        id,
        type: "test",
        capabilities: [],
        contextTypes: [],
        profiles: profiles.map((id) => ({ id, revision: "1" })),
      };
    },
    async *execute(spec) {
      selected.push(id);
      yield {
        type: "execution.completed",
        attemptId: spec.attemptId,
        taskId: spec.taskId,
        at: "now",
      };
    },
  });
  // Normal LocalWorklet sorting prefers a; durable reservation follows descriptor order z.
  const local = new LocalWorklet("local", "host", [
    worker("z", ["static", "special"]),
    worker("a", ["static"]),
  ]);
  const durable = new DurableLocalWorklet(local, new FileAttemptJournal(directory));
  try {
    await durable.accept(taskAttemptSpec());
    for await (const _ of durable.events("attempt-1")) {
      /* drain */
    }
    expect(selected).toEqual(["z"]);
    expect((await durable.inspect("attempt-1"))?.workerId).toBe("z");
    await durable.accept({
      ...taskAttemptSpec({ id: "special", revision: "1" }),
      attemptId: "special-attempt",
    });
    for await (const _ of durable.events("special-attempt")) {
      /* drain */
    }
    expect(selected).toEqual(["z", "z"]);
    await durable.close();
    const ambiguous: Worklet = {
      id: "generic",
      describe: () => local.describe(),
      execute: (spec, signal) => local.execute(spec, signal),
    };
    const rejected = new DurableLocalWorklet(ambiguous, new FileAttemptJournal(directory));
    await expect(rejected.accept({ ...taskAttemptSpec(), attemptId: "new" })).rejects.toThrow(
      /executeOnWorker/,
    );
    expect(await rejected.inspect("new")).toBeUndefined();
    await rejected.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("stores long streams as individual rows and replays bounded cursor pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-long-"));
  const journal = new FileAttemptJournal(directory);
  try {
    await journal.initialize();
    let inspection = {
      attemptId: "long",
      taskId: "task",
      specDigest: "digest",
      status: "running" as const,
      lastSequence: 0,
    };
    journal.putInspection(inspection);
    const payload = "x".repeat(2048);
    for (let index = 0; index < 1000; index++)
      inspection = journal.append(inspection, {
        type: "output.delta",
        taskId: "task",
        attemptId: "long",
        at: "now",
        text: payload,
      }) as typeof inspection;
    const db = new Database(join(directory, "attempts.sqlite"), { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM events").get()).toEqual({ count: 1000 });
      const stored = db.prepare("SELECT sum(length(event)) AS bytes FROM events").get() as {
        bytes: number;
      };
      expect(stored.bytes).toBeGreaterThan(2_048_000);
      expect(stored.bytes).toBeLessThan(2_300_000);
      expect(db.prepare("SELECT length(inspection) AS bytes FROM receipts").get()).toEqual({
        bytes: JSON.stringify(inspection).length,
      });
    } finally {
      db.close();
    }
    const page = journal.readEvents("long", 850);
    expect(page).toHaveLength(100);
    expect(page[0]?.sequence).toBe(851);
    expect(page.at(-1)?.sequence).toBe(950);
    expect(journal.readEvents("long", 950)).toHaveLength(50);
    await journal.close();
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("recovers committed events after a real supervisor process crash without replaying execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-crash-"));
  const source = new URL("./src/durable-worklet.ts", import.meta.url).href;
  const script = `import { FileAttemptJournal } from ${JSON.stringify(source)};
    const journal = new FileAttemptJournal(${JSON.stringify(directory)});
    await journal.initialize();
    const inspection = { attemptId: "crashed", taskId: "task", specDigest: "digest", status: "running", lastSequence: 0 };
    journal.putInspection(inspection);
    journal.append(inspection, { type: "output.delta", taskId: "task", attemptId: "crashed", at: "now", text: "committed" });
    console.log("COMMITTED"); setInterval(() => {}, 1000);`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--conditions=development", "--input-type=module", "-e", script],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("COMMITTED")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Child exited before commit: ${stderr}`)));
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const worklet: Worklet = {
      id: "local",
      async describe() {
        return { id: "local", protocolVersion: 1, host: { id: "host", workers: [] } };
      },
      execute() {
        throw new Error("Must not restart");
      },
    };
    const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    expect((await durable.inspect("crashed"))?.status).toBe("unknown");
    const replay = [];
    for await (const entry of durable.events("crashed")) replay.push(entry);
    // The committed event, then the journal's record of why the receipt became unknown.
    expect(replay).toHaveLength(2);
    expect(replay[0]?.event).toMatchObject({ text: "committed" });
    expect(replay[1]?.event).toMatchObject({
      type: "execution.uncertain",
      error: { name: "WorkletInterrupted" },
    });
    await durable.close();
  } finally {
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it("streams through append APIs without retaining snapshots and drains all completed pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-pages-"));
  const journal = new FileAttemptJournal(directory);
  const snapshots = vi.spyOn(journal, "write");
  const fullReads = vi.spyOn(journal, "readAll");
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
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
      };
    },
    async *execute(spec) {
      for (let index = 0; index < 251; index++) {
        if (index === 1) await gate;
        yield {
          type: "output.delta",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: "now",
          text: String(index),
        };
      }
      yield {
        type: "execution.completed",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: "now",
      };
    },
  };
  const durable = new DurableLocalWorklet(new LocalWorklet("local", "host", [worker]), journal);
  try {
    await durable.accept(taskAttemptSpec());
    const sequences: number[] = [];
    for await (const entry of durable.events("attempt-1")) {
      sequences.push(entry.sequence);
      if (entry.sequence === 1) {
        resume();
        await expect
          .poll(async () => (await durable.inspect("attempt-1"))?.status)
          .toBe("completed");
      }
    }
    expect(sequences).toEqual(Array.from({ length: 252 }, (_, index) => index + 1));
    expect(snapshots).not.toHaveBeenCalled();
    expect(fullReads).not.toHaveBeenCalled();
    await durable.close();
  } finally {
    resume();
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
    execution: {},
    workerProfile,
  };
}

it("journals native controls before dispatch and never replays unknown outcomes after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-controls-"));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const journal = new FileAttemptJournal(directory);
  const spec = taskAttemptSpec();
  let dispatches = 0;
  const worker: Worker = {
    async describe() {
      return {
        profileCapabilities: [{ profile: spec.workerProfile, capabilities: [], contextTypes: [] }],
        id: "controlled",
        type: "test",
        profiles: [spec.workerProfile],
        capabilities: [],
        contextTypes: [],
        maxConcurrency: 1,
      };
    },
    async controlCapabilities() {
      return { version: 1, operations: ["input"], inputMode: "steer" };
    },
    async control(command, options) {
      if (
        command.type === "input" &&
        command.requiresInputAuthorization &&
        !(await options?.authorizeInput?.())
      )
        return {
          id: command.id,
          taskId: command.taskId,
          attemptId: command.attemptId,
          status: "rejected",
        };
      dispatches++;
      expect(journal.readControl(command.attemptId, command.id)?.acknowledgement.status).toBe(
        "unknown",
      );
      if (command.id === "uncertain") throw new Error("Native ACK lost");
      return {
        id: command.id,
        taskId: command.taskId,
        attemptId: command.attemptId,
        status: "accepted",
      };
    },
    async *execute(attempt) {
      yield {
        type: "execution.started",
        workerId: "controlled",
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        at: "now",
      };
      await waiting;
      yield {
        type: "execution.completed",
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        at: "now",
      };
    },
  };
  const durable = new DurableLocalWorklet(new LocalWorklet("control", "host", [worker]), journal);
  const command: HarnessControlCommand = {
    id: "first",
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    type: "input",
    text: "private control payload",
  };
  try {
    await durable.accept(spec);
    await vi.waitFor(async () =>
      expect(await durable.controlCapabilities(spec.taskId, spec.attemptId)).toEqual({
        version: 1,
        operations: ["input"],
        inputMode: "steer",
      }),
    );
    expect((await durable.inspect(spec.attemptId))?.control?.inputMode).toBe("steer");
    const authorizeInput = vi.fn(async () => false);
    const guarded = { ...command, id: "revoked", requiresInputAuthorization: true };
    expect((await durable.control(guarded, { authorizeInput })).status).toBe("rejected");
    expect(authorizeInput).toHaveBeenCalledTimes(1);
    expect((await durable.control(command)).status).toBe("accepted");
    expect((await durable.control(command)).status).toBe("accepted");
    expect((await durable.control({ ...command, text: "changed" })).status).toBe("rejected");
    expect((await durable.control({ ...command, id: "wrong-task", taskId: "other" })).status).toBe(
      "rejected",
    );
    expect((await durable.control({ ...command, id: "uncertain" })).status).toBe("unknown");
    expect((await durable.control({ ...command, id: "uncertain" })).status).toBe("unknown");
    expect(dispatches).toBe(2);
    release();
    for await (const _ of durable.events(spec.attemptId)) {
      /* Wait for cleanup. */
    }
    await durable.close();
    const reopened = new DurableLocalWorklet(
      new LocalWorklet("control", "host", [worker]),
      new FileAttemptJournal(directory),
    );
    try {
      expect((await reopened.control(guarded, { authorizeInput })).status).toBe("rejected");
      expect(authorizeInput).toHaveBeenCalledTimes(1);
      expect((await reopened.control(command)).status).toBe("accepted");
      expect((await reopened.control({ ...command, id: "uncertain" })).status).toBe("unknown");
      expect(await reopened.controlCapabilities(spec.taskId, spec.attemptId)).toBeUndefined();
      expect(dispatches).toBe(2);
    } finally {
      await reopened.close();
    }
    const files = await readdir(directory);
    for (const file of files.filter((file) => file.endsWith("sqlite") || file.endsWith("db")))
      expect((await readFile(join(directory, file))).includes(Buffer.from(command.text))).toBe(
        false,
      );
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

it("journals operator acceptance behind a stalled advisory command before its five-second deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-queued-controls-"));
  const spec = taskAttemptSpec();
  const journal = new FileAttemptJournal(directory);
  const injected: string[] = [];
  const control = new LocalHarnessExecutionControl({
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    capabilities: { version: 1, operations: ["input"], inputMode: "queue" },
    dispatch: async (command, signal) => {
      if (command.id === "peer") await new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) return { status: "rejected" };
      injected.push(command.id);
      return { status: "accepted" };
    },
  });
  const worker: Worker = {
    describe: async () => ({
      profileCapabilities: [{ profile: spec.workerProfile, capabilities: [], contextTypes: [] }],
      id: "controlled",
      type: "test",
      profiles: [spec.workerProfile],
      capabilities: [],
      contextTypes: [],
    }),
    controlCapabilities: async () => control.capabilities,
    control: (command) => control.send(command),
    async *execute(attempt, signal) {
      yield {
        type: "execution.started",
        workerId: "controlled",
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        at: "now",
      };
      if (!signal?.aborted)
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
    },
  };
  const durable = new DurableLocalWorklet(new LocalWorklet("control", "host", [worker]), journal);
  const command: HarnessControlCommand = {
    id: "operator",
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    type: "input",
    text: "Operator direction",
  };
  try {
    await durable.accept(spec);
    await vi.waitFor(() => expect(journal.inspections()[0]?.lastSequence).toBe(1));
    vi.useFakeTimers();
    const peer = durable.control({ ...command, id: "peer", advisory: true });
    await vi.advanceTimersByTimeAsync(5);
    const operator = durable.control(command);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await peer).status).toBe("unknown");
    expect((await operator).status).toBe("accepted");
    expect(journal.readControl(spec.attemptId, "operator")?.acknowledgement.status).toBe(
      "accepted",
    );
    expect(await durable.control(command)).toEqual(await operator);
    expect(injected).toEqual(["operator"]);
  } finally {
    vi.useRealTimers();
    await control.close();
    await durable.shutdown("test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["late response", "timeout"])(
  "keeps cancellation and event commits live during capability discovery: %s",
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "durable-probe-"));
    const spec = taskAttemptSpec();
    let finishProbe!: () => void;
    const probe = new Promise<void>((resolve) => {
      finishProbe = resolve;
    });
    const capabilities = vi.fn(async () => {
      await probe;
      return { version: 1 as const, operations: ["input"] as const, inputMode: "steer" as const };
    });
    const dispatch = vi.fn(async (command: HarnessControlCommand) => ({
      ...command,
      status: "accepted" as const,
    }));
    const journal = new FileAttemptJournal(directory);
    const worker: Worker = {
      describe: async () => ({
        profileCapabilities: [{ profile: spec.workerProfile, capabilities: [], contextTypes: [] }],
        id: "worker",
        type: "test",
        profiles: [spec.workerProfile],
        capabilities: [],
        contextTypes: [],
      }),
      controlCapabilities: capabilities,
      control: dispatch,
      async *execute(attempt, signal) {
        yield {
          type: "execution.started",
          workerId: "worker",
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
          at: "now",
        };
        if (!signal?.aborted)
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        yield {
          type: "output.message",
          message: { role: "teammate", text: "cleanup finished" },
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
          at: "now",
        };
      },
    };
    const durable = new DurableLocalWorklet(new LocalWorklet("probe", "host", [worker]), journal);
    try {
      await durable.accept(spec);
      await vi.waitFor(() => expect(journal.inspections()[0]?.lastSequence).toBe(1));
      const command: HarnessControlCommand = {
        id: "input",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        type: "input",
        text: "later",
      };
      vi.useFakeTimers();
      const pending = durable.control(command);
      await vi.advanceTimersByTimeAsync(1);
      expect(capabilities).toHaveBeenCalledOnce();
      await durable.cancel(spec.attemptId, "stop");
      await vi.advanceTimersByTimeAsync(1);
      expect(journal.inspections()[0]).toMatchObject({ status: "cancelled", lastSequence: 2 });
      // Completion revokes a delayed response, and an absent response is bounded.
      if (outcome === "timeout") await vi.advanceTimersByTimeAsync(5000);
      else finishProbe();
      expect((await pending).status).toBe("rejected");
      expect((await durable.control(command)).status).toBe("rejected");
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      finishProbe();
      vi.useRealTimers();
      await durable.shutdown("test cleanup");
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("bounds stalled descriptor discovery without holding cancellation or accepting late results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-description-"));
  const spec = taskAttemptSpec();
  let finishProbe!: () => void;
  const probe = new Promise<void>((resolve) => {
    finishProbe = resolve;
  });
  let blocked = false;
  const describe = vi.fn(async () => {
    if (blocked) await probe;
    return {
      profileCapabilities: [{ profile: spec.workerProfile, capabilities: [], contextTypes: [] }],
      id: "worker",
      type: "test",
      profiles: [spec.workerProfile],
      capabilities: [],
      contextTypes: [],
    };
  });
  const execute = vi.fn(async function* (attempt: TaskAttemptSpec, signal?: AbortSignal) {
    yield {
      type: "execution.started" as const,
      workerId: "worker",
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      at: "now",
    };
    if (!signal?.aborted)
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
  });
  const journal = new FileAttemptJournal(directory);
  const durable = new DurableLocalWorklet(
    new LocalWorklet("probe", "host", [{ describe, execute }]),
    journal,
  );
  try {
    await durable.accept(spec);
    await vi.waitFor(() => expect(journal.inspections()[0]?.lastSequence).toBe(1));
    blocked = true;
    vi.useFakeTimers();
    const pending = durable.accept({ ...spec, attemptId: "late" });
    const rejected = expect(pending).rejects.toThrow("discovery timed out");
    await vi.advanceTimersByTimeAsync(1);
    await durable.cancel(spec.attemptId, "stop");
    await vi.advanceTimersByTimeAsync(1);
    expect(journal.inspections()[0]?.status).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    finishProbe();
    await vi.advanceTimersByTimeAsync(1);
    expect(journal.inspections()).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    finishProbe();
    vi.useRealTimers();
    await durable.shutdown("test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});

it("aborting a durable execution observer preserves work until explicit cancellation finishes cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-observer-"));
  const spec = taskAttemptSpec();
  let starts = 0;
  let cleaned = false;
  let abortReason: unknown;
  const worker: Worker = {
    describe: async () => ({
      profileCapabilities: [{ profile: spec.workerProfile, capabilities: [], contextTypes: [] }],
      id: "worker",
      type: "test",
      profiles: [spec.workerProfile],
      capabilities: [],
      contextTypes: [],
    }),
    async *execute(attempt, signal) {
      starts++;
      signal?.addEventListener("abort", () => {
        abortReason = signal.reason;
      });
      try {
        yield {
          type: "execution.started",
          workerId: "worker",
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
          at: "now",
        };
        if (!signal?.aborted)
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
      } finally {
        cleaned = true;
      }
    },
  };
  const durable = new DurableLocalWorklet(
    new LocalWorklet("observer", "host", [worker]),
    new FileAttemptJournal(directory),
  );
  try {
    const observer = new AbortController();
    const stream = durable.execute(spec, observer.signal)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ type: "execution.started" });
    observer.abort();
    expect((await stream.next()).done).toBe(true);
    expect((await durable.inspect(spec.attemptId))?.status).toBe("running");
    expect(cleaned).toBe(false);
    expect(starts).toBe(1);
    await durable.cancel(spec.attemptId, "explicit cancellation");
    for await (const _ of durable.events(spec.attemptId, 1)) {
      /* Observe cleanup completion. */
    }
    expect((await durable.inspect(spec.attemptId))?.status).toBe("cancelled");
    expect(abortReason).toMatchObject({ name: "AbortError", message: "explicit cancellation" });
    expect(cleaned).toBe(true);
    expect(starts).toBe(1);
  } finally {
    await durable.shutdown("test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});

it("persists cancellation intent for an unknown receipt without releasing uncertain capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-unknown-cancel-"));
  const journal = new FileAttemptJournal(directory);
  await journal.initialize();
  await journal.write({
    inspection: {
      attemptId: "uncertain",
      taskId: "task",
      workerId: "worker",
      specDigest: "digest",
      status: "running",
      lastSequence: 0,
    },
    events: [],
  });
  await journal.close();
  const execute = vi.fn(() => {
    throw new Error("Uncertain work must not replay");
  });
  const worklet: Worklet = {
    id: "local",
    describe: async () => ({
      id: "local",
      protocolVersion: 1,
      host: {
        id: "host",
        workers: [
          {
            profileCapabilities: [
              {
                profile: { id: "static", revision: "1" },
                capabilities: [{ id: "supertag.coordination", version: 1 }],
                contextTypes: [],
              },
            ],
            id: "worker",
            type: "test",
            profiles: [{ id: "static", revision: "1" }],
            contextTypes: [],
            maxConcurrency: 1,
            capabilities: [{ id: "supertag.coordination", version: 1 }],
          },
        ],
      },
    }),
    execute,
  };
  let durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  try {
    expect(await durable.inspect("uncertain")).toMatchObject({ status: "unknown" });
    expect(await durable.selectExecution({}, taskAttemptSpec().contextPlan)).toBeUndefined();
    expect(await durable.cancel("uncertain", "Operator cancelled")).toMatchObject({
      status: "unknown",
      cancellationRequested: true,
    });
    expect(await durable.selectExecution({}, taskAttemptSpec().contextPlan)).toBeUndefined();
    await expect(
      durable.accept({ ...taskAttemptSpec(), attemptId: "replacement" }),
    ).rejects.toThrow(/capacity/);
    await durable.close();
    durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    expect(await durable.inspect("uncertain")).toMatchObject({
      status: "unknown",
      cancellationRequested: true,
    });
    expect(await durable.cancel("uncertain", "Repeated request")).toMatchObject({
      status: "unknown",
      cancellationRequested: true,
    });
    expect(await durable.selectExecution({}, taskAttemptSpec().contextPlan)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails a pre-start cleanup rejection and releases its Worker slot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-pre-start-cleanup-"));
  const worklet: Worklet = {
    id: "local",
    async describe() {
      return {
        id: "local",
        protocolVersion: 1,
        host: {
          id: "host",
          workers: [
            {
              id: "worker",
              type: "test",
              maxConcurrency: 1,
              profiles: [{ id: "static", revision: "1" }],
              contextTypes: [],
              capabilities: [],
              profileCapabilities: [
                { profile: { id: "static", revision: "1" }, capabilities: [], contextTypes: [] },
              ],
            },
          ],
        },
      };
    },
    async *execute() {
      yield* [] as TaskAttemptEvent[];
      throw new ExecutionCleanupError(
        "Worker cleanup failed before this Task Attempt started; restart the Worker Host",
        {
          hostUnsafe: false,
        },
      );
    },
  };
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  try {
    const spec = taskAttemptSpec();
    await durable.accept(spec);
    await expect.poll(async () => (await durable.inspect(spec.attemptId))?.status).toBe("failed");
    const events = [];
    for await (const entry of durable.events(spec.attemptId)) events.push(entry.event);
    expect(events).toEqual([
      expect.objectContaining({
        type: "execution.failed",
        error: expect.objectContaining({
          message: expect.stringContaining("restart the Worker Host"),
        }),
      }),
    ]);
    await expect(durable.accept({ ...spec, attemptId: "next" })).resolves.toMatchObject({
      status: "accepted",
    });
  } finally {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps why a receipt became unknown in the receipt and an execution.uncertain event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-worklet-uncertain-"));
  const worklet: Worklet = {
    id: "local",
    async describe() {
      return {
        id: "local",
        protocolVersion: 1,
        host: {
          id: "host",
          workers: [
            {
              capabilities: [],
              profileCapabilities: [
                { profile: { id: "static", revision: "1" }, capabilities: [], contextTypes: [] },
              ],
              id: "worker",
              type: "test",
              profiles: [{ id: "static", revision: "1" }],
              contextTypes: [],
              maxConcurrency: 1,
            },
          ],
        },
      };
    },
    // The stream ends without execution.completed or execution.failed.
    async *execute(spec) {
      yield {
        type: "execution.started",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: "2026-10-04T20:35:56.000Z",
        workerId: "worker",
      } as const;
    },
  };
  const reports: string[][] = [];
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory), {
    onUncertainAttempts: (attempts) => {
      reports.push(attempts.map((attempt) => attempt.attemptId));
      throw new Error("A failing status reporter never affects execution");
    },
  });
  const spec = taskAttemptSpec();
  try {
    await durable.accept(spec);
    await expect.poll(async () => (await durable.inspect(spec.attemptId))?.status).toBe("unknown");
    expect(await durable.inspect(spec.attemptId)).toMatchObject({
      lastSequence: 2,
      uncertainty: { name: "ExecutionOutcomeUnknown", message: expect.stringContaining("ended") },
    });
    const events = [];
    for await (const entry of durable.events(spec.attemptId)) events.push(entry.event);
    expect(events.at(-1)).toMatchObject({
      type: "execution.uncertain",
      error: { name: "ExecutionOutcomeUnknown" },
    });
    // The unknown receipt still holds the Worker's only slot.
    await expect(durable.accept({ ...spec, attemptId: "attempt-2" })).rejects.toThrow(/capacity/);
    expect(reports.at(-1)).toEqual([spec.attemptId]);
  } finally {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("records a throw after a terminal failure as failed and releases Worker capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-terminal-throw-"));
  const worklet: Worklet = {
    id: "local",
    async describe() {
      return {
        id: "local",
        protocolVersion: 1,
        host: {
          id: "host",
          workers: [
            {
              profileCapabilities: [
                { profile: { id: "static", revision: "1" }, capabilities: [], contextTypes: [] },
              ],
              id: "worker",
              type: "test",
              profiles: [{ id: "static", revision: "1" }],
              contextTypes: [],
              maxConcurrency: 1,
            },
          ],
        },
      };
    },
    async *execute(spec) {
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at: "now" };
      if (spec.attemptId === "completed-then-threw") {
        yield { ...identity, type: "execution.completed" } as const;
        throw new Error("Git delivery failed");
      }
      yield {
        ...identity,
        type: "execution.failed",
        error: { name: "ExecutionError", message: "Harness failed" },
      } as const;
      throw new Error("Git delivery failed");
    },
  };
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  try {
    const spec = taskAttemptSpec();
    await durable.accept(spec);
    await expect.poll(async () => (await durable.inspect(spec.attemptId))?.status).toBe("failed");
    const events = [];
    for await (const entry of durable.events(spec.attemptId)) events.push(entry.event);
    expect(events.map((event) => event.type)).toEqual(["execution.failed", "execution.failed"]);
    expect(events.at(-1)).toMatchObject({
      type: "execution.failed",
      error: { name: "ExecutionError", message: "Harness failed; Error: Git delivery failed" },
    });
    await expect(durable.accept({ ...spec, attemptId: "next" })).resolves.toMatchObject({
      status: "accepted",
    });
    await expect.poll(async () => (await durable.inspect("next"))?.status).toBe("failed");
    await durable.accept({ ...spec, attemptId: "completed-then-threw" });
    await expect
      .poll(async () => (await durable.inspect("completed-then-threw"))?.status)
      .toBe("failed");
    const completedEvents = [];
    for await (const entry of durable.events("completed-then-threw"))
      completedEvents.push(entry.event);
    expect(completedEvents.at(-1)).toMatchObject({
      type: "execution.failed",
      error: { name: "Error", message: "Error: Git delivery failed" },
    });
  } finally {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps a cancelled Attempt cancelled when the Worker throws AbortError after a terminal event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-cancelled-throw-"));
  const worklet: Worklet = {
    id: "local",
    async describe() {
      return {
        id: "local",
        protocolVersion: 1,
        host: {
          id: "host",
          workers: [
            {
              profileCapabilities: [
                { profile: { id: "static", revision: "1" }, capabilities: [], contextTypes: [] },
              ],
              id: "worker",
              type: "test",
              profiles: [{ id: "static", revision: "1" }],
              contextTypes: [],
              maxConcurrency: 1,
            },
          ],
        },
      };
    },
    async *execute(spec, signal) {
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at: "now" };
      yield { ...identity, type: "execution.started", workerId: "worker" } as const;
      if (!signal?.aborted)
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      yield { ...identity, type: "execution.completed" } as const;
      signal?.throwIfAborted();
    },
  };
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  try {
    const spec = taskAttemptSpec();
    await durable.accept(spec);
    await expect.poll(async () => (await durable.inspect(spec.attemptId))?.status).toBe("running");
    await durable.cancel(spec.attemptId, "stop");
    await expect
      .poll(async () => (await durable.inspect(spec.attemptId))?.status)
      .toBe("cancelled");
    const events = [];
    for await (const entry of durable.events(spec.attemptId)) events.push(entry.event);
    expect(events.map((event) => event.type)).toEqual(["execution.started", "execution.completed"]);
  } finally {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails an Attempt whose event is too large for the Worklet transports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-oversized-event-"));
  const worker: Worker = {
    async describe() {
      return {
        profileCapabilities: [
          { profile: { id: "static", revision: "1" }, capabilities: [], contextTypes: [] },
        ],
        id: "worker",
        type: "test",
        capabilities: [],
        contextTypes: [],
        profiles: [{ id: "static", revision: "1" }],
      };
    },
    async *execute(spec) {
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at: "now" };
      yield { ...identity, type: "output.delta", text: "x".repeat(3 * 1024 * 1024) };
      yield { ...identity, type: "execution.completed" };
    },
  };
  const durable = new DurableLocalWorklet(
    new LocalWorklet("local", "host", [worker]),
    new FileAttemptJournal(directory),
  );
  try {
    const spec = taskAttemptSpec();
    await durable.accept(spec);
    await expect.poll(async () => (await durable.inspect(spec.attemptId))?.status).toBe("failed");
    const events = [];
    for await (const entry of durable.events(spec.attemptId)) events.push(entry.event);
    expect(events).toEqual([
      expect.objectContaining({
        type: "execution.failed",
        error: expect.objectContaining({ message: expect.stringContaining("exceeds") }),
      }),
    ]);
  } finally {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Custom Workers can throw before the built-in Worker's redaction runs.
it("F1 preserves journal identities and commit hashes while F4 redacts credential-shaped fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-identities-"));
  vi.stubEnv("SUPERTAG_POSTGRES_URL", "postgresql://supertag:supertag@127.0.0.1:55432/db");
  const artifact = {
    id: "supertag-output",
    uri: `supertag-artifact:sha256:${"a".repeat(64)}`,
    path: "supertag/output.txt",
    name: "supertag-output.txt",
  };
  const sessionState = { ...artifact, format: "supertag-session" };
  vi.stubEnv("TOKEN_ENABLED", "false");
  vi.stubEnv("TOKEN_COUNT", "1");
  vi.stubEnv("HOST_SECRET", "task-identity-1");
  const worker: Worker = {
    async describe() {
      return {
        profileCapabilities: [
          { profile: { id: "static", revision: "1" }, capabilities: [], contextTypes: [] },
        ],
        id: "worker-1",
        type: "test",
        capabilities: [],
        contextTypes: [],
        profiles: [{ id: "static", revision: "1" }],
      };
    },
    async *execute(spec) {
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at: "now" };
      yield {
        ...identity,
        type: "output.delta",
        text: "commit 123456789abcdef false task-identity-1",
      };
      yield {
        ...identity,
        type: "approval.requested",
        request: {
          id: "request-1",
          description: "approve",
          data: {
            SERVICE_AUTH: "private-auth",
            DB_PASS: "private-pass",
            PASSWD: "private-passwd",
            GITHUB_PAT: "private-pat",
            PROVIDER_SK: "private-sk",
            PROVIDER_KEY: "private-key",
            nested: { taskId: "task-identity-1", accessToken: "unregistered-value" },
          },
        },
      };
      yield { ...identity, type: "artifact.created", artifact };
      yield { ...identity, type: "session.updated", sessionState };
      yield { ...identity, type: "input.withdrawn", commandId: "supertag-command" };
      yield { ...identity, type: "execution.completed" };
    },
  };
  const durable = new DurableLocalWorklet(
    new LocalWorklet("local", "host", [worker]),
    new FileAttemptJournal(directory),
  );
  const spec = { ...taskAttemptSpec(), taskId: "task-identity-1" };
  try {
    await durable.accept(spec);
    const events = [];
    for await (const entry of durable.events(spec.attemptId)) events.push(entry.event);
    expect(
      events.every((event) => event.taskId === spec.taskId && event.attemptId === spec.attemptId),
    ).toBe(true);
    expect(events[0]).toMatchObject({ text: "commit 123456789abcdef false [REDACTED]" });
    expect(events[1]).toMatchObject({
      request: {
        data: {
          SERVICE_AUTH: "[REDACTED]",
          DB_PASS: "[REDACTED]",
          PASSWD: "[REDACTED]",
          GITHUB_PAT: "[REDACTED]",
          PROVIDER_SK: "[REDACTED]",
          PROVIDER_KEY: "[REDACTED]",
          nested: { taskId: "[REDACTED]", accessToken: "[REDACTED]" },
        },
      },
    });
    const safeArtifact = {
      ...artifact,
      id: "[REDACTED]-output",
      uri: artifact.uri,
      path: "[REDACTED]/output.txt",
      name: "[REDACTED]-output.txt",
    };
    expect(events[2]).toMatchObject({ type: "artifact.created", artifact: safeArtifact });
    expect(events[3]).toMatchObject({
      type: "session.updated",
      sessionState: { ...safeArtifact, format: "[REDACTED]-session" },
    });
    expect(events[4]).toMatchObject({ type: "input.withdrawn", commandId: "supertag-command" });
    await durable.close();
    const reopened = new DurableLocalWorklet(
      new LocalWorklet("local", "host", [worker]),
      new FileAttemptJournal(directory),
    );
    try {
      const replay = [];
      for await (const entry of reopened.events(spec.attemptId)) replay.push(entry.event);
      expect(replay).toEqual(events);
      expect(await reopened.inspect(spec.attemptId)).toMatchObject({
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        status: "completed",
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await durable.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["error", "string"])(
  "redacts host secrets and URL credentials before journaling a thrown %s",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "durable-worklet-redaction-"));
    vi.stubEnv("PROVIDER_API_KEY", "host-provider-secret");
    vi.stubEnv("HOST_CREDENTIAL", "host-credential-secret");
    const detail =
      "host-provider-secret host-credential-secret https://url-user:url-pass@example.test/path postgresql://db-user:p%40ss@db.test/db";
    const worklet: Worklet = {
      id: "local",
      async describe() {
        return {
          id: "local",
          protocolVersion: 1,
          host: {
            id: "host",
            workers: [
              {
                capabilities: [],
                profileCapabilities: [
                  { profile: { id: "static", revision: "1" }, capabilities: [], contextTypes: [] },
                ],
                id: "worker",
                type: "test",
                profiles: [{ id: "static", revision: "1" }],
                contextTypes: [],
                maxConcurrency: 1,
              },
            ],
          },
        };
      },

      async *execute(spec) {
        yield {
          type: "output.delta",
          text: detail,
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: "now",
        };
        if (kind === "string") throw detail;
        const error = new Error(detail);
        error.name = `Failure ${detail}`;
        throw error;
      },
    };
    const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    const spec = taskAttemptSpec();
    try {
      await durable.accept(spec);
      await expect
        .poll(async () => (await durable.inspect(spec.attemptId))?.status)
        .toBe("unknown");
      const events = [];
      for await (const entry of durable.events(spec.attemptId)) events.push(entry.event);
      const receipt = await durable.inspect(spec.attemptId);
      expect(events.at(-1)).toMatchObject({
        type: "execution.uncertain",
        error: { message: receipt?.uncertainty?.message },
      });
      await durable.close();
      const restarted = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
      try {
        expect(await restarted.inspect(spec.attemptId)).toEqual(receipt);
      } finally {
        await restarted.close();
      }
      const persisted = [JSON.stringify(receipt), JSON.stringify(events)];
      for (const name of await readdir(directory))
        persisted.push(await readFile(join(directory, name), "utf8"));
      for (const text of persisted) {
        for (const secret of [
          "host-provider-secret",
          "host-credential-secret",
          "url-user",
          "url-pass",
          "db-user",
          "p%40ss",
        ])
          expect(text).not.toContain(secret);
      }
      expect(receipt?.uncertainty?.message).toBe(
        "[REDACTED] [REDACTED] https://[REDACTED]@example.test/path postgresql://[REDACTED]@db.test/db",
      );
    } finally {
      await durable.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
