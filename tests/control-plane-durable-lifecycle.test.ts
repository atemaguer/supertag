import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import { SurfaceSettlement } from "../packages/control-plane/src/surface-settlement.ts";
import type {
  InboundSurfaceEvent,
  SurfaceAccount,
  Tag,
  TagAuthorizationSnapshot,
} from "../packages/core/src/index.ts";
import { emptyTagContextPlan } from "../packages/core/src/index.ts";
import type {
  SessionStateRef,
  TaskAttemptEvent,
  TaskAttemptSpec,
  Worklet,
} from "../packages/runtime/sdk/src/index.ts";
import { DurableLocalWorklet, FileAttemptJournal } from "../packages/runtime/sdk/src/index.ts";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.ts";
import { migrateSqlite as migrateSqliteDatabase } from "./support/database.ts";

// Under a busy full-suite run these tests can exceed vitest's 5-second default timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const dispatch = {
  pollIntervalMs: 5,
  // Ordinary lifecycle tests must not manufacture lease expiry under concurrent suite load.
  leaseDurationMs: 5_000,
  retryBaseMs: 5,
  maxAttempts: 3,
  instanceId: "durable-lifecycle-test",
};

const sessionStores = new WeakMap<Worklet["execute"], DrizzleStore>();
const directories: string[] = [];
const postgresqlCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of postgresqlCleanups.splice(0).reverse()) await cleanup();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Control Plane durable lifecycle", () => {
  it("settles an invalid catalog submission as failure without replaying completed execution", async () => {
    const fixture = await createFixture();
    const worker = testWorker(async () => ({
      text: "Output claim",
      artifacts: [{ artifactId: "uncaptured", paths: ["report.md"] }],
    }));
    const store = fixture.store();
    const controlPlane = fixture.controlPlaneWithStore(store, {
      worklet: worker,
      reply: async () => {},
    });
    await controlPlane.start();
    try {
      await fixture.setupAccount(controlPlane);
      const admission = await controlPlane.ingestSurfaceEvent(event());
      if (!admission.taskId) throw new Error("Expected Task");
      await expect
        .poll(async () => (await store.findTaskById(admission.taskId as string))?.status)
        .toBe("failed");
      const events = await store.listTaskEvents(admission.taskId);
      expect(events.some((event) => event.type === "surface.failure-prepared")).toBe(true);
      expect(events.some((event) => event.type === "surface.settlement-prepared")).toBe(false);
      expect(worker.execute).toHaveBeenCalledTimes(1);
      expect(await store.listTaskAttempts(admission.taskId)).toHaveLength(1);
    } finally {
      await controlPlane.stop();
    }
  });

  it("records selected local durable Worker identity after surface admission", async () => {
    const fixture = await createFixture();
    const directory = await mkdtemp(join(tmpdir(), "supertag-surface-provenance-"));
    directories.push(directory);
    const worklet = new DurableLocalWorklet(
      testWorker(async () => ({ text: "selected locally" })),
      new FileAttemptJournal(join(directory, "journal")),
    );
    const store = fixture.store();
    const controlPlane = fixture.controlPlaneWithStore(store, { worklet, reply: async () => {} });
    await controlPlane.start();
    try {
      await fixture.setupAccount(controlPlane);
      const admission = await controlPlane.ingestSurfaceEvent(event());
      if (!admission.taskId) throw new Error("Expected Task");
      const taskId = admission.taskId;
      await expect
        .poll(async () => (await store.listTaskAttempts(taskId))[0]?.status)
        .toBe("completed");
      expect((await store.listTaskAttempts(admission.taskId))[0]?.workerSnapshot).toMatchObject({
        workerHostId: "test-host",
        workletId: "test-worklet",
        workerId: "test-worker",
        durableExecution: true,
      });
    } finally {
      await controlPlane.stop();
      await worklet.close();
    }
  });
  it("bounds description after selection and admits no Attempt after the lease expires", async () => {
    const fixture = await createFixture(100);
    const worker = testWorker(async () => ({ text: "must not run" }));
    const descriptor = await worker.describe();
    const describeWorker = vi
      .spyOn(worker, "describe")
      .mockResolvedValueOnce(descriptor)
      .mockImplementation(() => new Promise(() => {}));
    const errors = vi.fn();
    const controlPlane = fixture.controlPlane({
      worklet: worker,
      reply: async () => {},
      onDispatchError: errors,
    });
    await controlPlane.start();
    try {
      await fixture.setupAccount(controlPlane);
      await controlPlane.ingestSurfaceEvent(event());
      await vi.waitFor(() => expect(describeWorker).toHaveBeenCalledTimes(2));
      const start = Date.now();
      await controlPlane.stop();
      expect(Date.now() - start).toBeLessThan(12_500);
      expect(
        errors.mock.calls.some(
          ([error]) => error instanceof Error && error.message.includes("timed out"),
        ),
      ).toBe(true);
      expect(taskAttemptRows(fixture.databasePath)).toEqual([]);
      expect(worker.execute).not.toHaveBeenCalled();
    } finally {
      await controlPlane.stop();
    }
  }, 60_000);
  it("reports scheduling lookup failures without consuming an Attempt and recovers on retry", async () => {
    const fixture = await createFixture();
    const store = fixture.store();
    const failure = new Error("continuity lookup unavailable");
    const lookup = vi.spyOn(store, "findLatestSessionExecutionTask").mockRejectedValue(failure);
    const onDispatchError = vi.fn();
    const worker = testWorker(async () => ({ text: "recovered" }));
    const reply = vi.fn(async () => {});
    const controlPlane = fixture.controlPlaneWithStore(store, {
      worklet: worker,
      reply,
      onDispatchError,
    });

    await controlPlane.start();
    try {
      await fixture.setupAccount(controlPlane);
      await controlPlane.ingestSurfaceEvent(event());
      await vi.waitFor(() => expect(onDispatchError).toHaveBeenCalledWith(failure));
      expect(taskRows(fixture.databasePath)[0]?.status).toBe("pending");
      expect(taskAttemptRows(fixture.databasePath)).toEqual([]);
      expect(worker.execute).not.toHaveBeenCalled();

      lookup.mockRestore();
      await vi.waitFor(() =>
        expect(durableRows(fixture.databasePath)[0]?.status).toBe("completed"),
      );
      expect(worker.execute).toHaveBeenCalledOnce();
      expect(taskRows(fixture.databasePath)[0]?.status).toBe("completed");
    } finally {
      lookup.mockRestore();
      await controlPlane.stop();
    }
  });

  it("creates a pending Task at admission before any Worker attempt exists", async () => {
    const fixture = await createFixture();
    const controlPlane = fixture.controlPlane({});

    await controlPlane.start();
    await fixture.setupAccount(controlPlane);
    const admission = await controlPlane.ingestSurfaceEvent(event());

    expect(admission).toMatchObject({ status: "accepted", taskId: expect.any(String) });
    expect(taskRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ id: admission.taskId, status: "pending", startedAt: null }),
    ]);
    expect(taskAttemptRows(fixture.databasePath)).toEqual([]);
    expect(taskEventRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ sequence: 1, type: "task.admitted", attemptId: null }),
      // Tasks start at low effort, so admission records that selection.
      expect.objectContaining({ sequence: 2, type: "task.execution-resolved", attemptId: null }),
    ]);
    await controlPlane.stop();
  });

  it("cancels pending admission durably before a Worker is available", async () => {
    const fixture = await createFixture();
    const controlPlane = fixture.controlPlane({});
    await controlPlane.start();
    try {
      await fixture.setupAccount(controlPlane);
      const admission = await controlPlane.ingestSurfaceEvent(event());
      if (!admission.taskId) throw new Error("Expected admitted Task");
      await expect(controlPlane.requestTaskCancellation(admission.taskId)).resolves.toMatchObject({
        accepted: true,
        task: { status: "cancelled" },
      });
      expect(durableRows(fixture.databasePath)[0]?.status).toBe("completed");
      expect(taskAttemptRows(fixture.databasePath)).toEqual([]);
    } finally {
      await controlPlane.stop();
    }
    const worker = testWorker(async () => {
      throw new Error("Cancelled pending work cannot execute");
    });
    const reply = vi.fn(async () => {});
    const restarted = fixture.controlPlane({ worklet: worker, reply });
    await restarted.start();
    try {
      await vi.waitFor(() =>
        expect(
          outboundRows(fixture.databasePath).some(
            (row) => row.presentation === "final-result" && row.status === "delivered",
          ),
        ).toBe(true),
      );
      expect(worker.execute).not.toHaveBeenCalled();
      expect(taskRows(fixture.databasePath)[0]?.status).toBe("cancelled");
    } finally {
      await restarted.stop();
    }
  });

  it("leaves a Task pending when no Worker advertises its required profile", async () => {
    const fixture = await createFixture();
    const incompatibleWorker: Worklet = {
      id: "incompatible-worklet",
      describe: async () => ({
        id: "incompatible-worklet",
        protocolVersion: 1,
        host: {
          id: "incompatible-host",
          workers: [
            {
              profileCapabilities: [
                { profile: { id: "research", revision: "1" }, capabilities: [], contextTypes: [] },
              ],
              id: "research-only",
              type: "test",
              capabilities: [],
              profiles: [{ id: "research", revision: "1" }],
              contextTypes: [],
            },
          ],
        },
      }),
      execute: vi.fn(() => {
        throw new Error("An incompatible Worker must not receive the Task");
      }),
    };
    const onDispatchError = vi.fn();
    const controlPlane = fixture.controlPlane({
      worklet: incompatibleWorker,
      reply: vi.fn(async () => {}),
      onDispatchError,
    });

    await controlPlane.start();
    await fixture.setupAccount(controlPlane);
    const admission = await controlPlane.ingestSurfaceEvent(event(), {
      execution: { profile: { id: "default", revision: "1" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(durableRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ status: "pending", attemptCount: 0 }),
    ]);
    expect(taskRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ id: admission.taskId, status: "pending" }),
    ]);
    expect(incompatibleWorker.execute).not.toHaveBeenCalled();
    expect(onDispatchError).not.toHaveBeenCalled();
    await controlPlane.stop();
  });

  it("returns after durable admission and before starting Worker execution", async () => {
    const fixture = await createFixture();
    const execution = deferred<{ readonly text: string }>();
    const order: string[] = [];
    const worker = testWorker(async () => {
      order.push("worker");
      return execution.promise;
    });
    const reply = vi.fn(async () => {});
    const controlPlane = fixture.controlPlane({ worklet: worker, reply });

    await controlPlane.start();
    await fixture.setupAccount(controlPlane);
    const result = await controlPlane.ingestSurfaceEvent(event()).then((admission) => {
      order.push("admitted");
      return admission;
    });

    expect(result).toMatchObject({ status: "accepted" });
    expect(order[0]).toBe("admitted");
    expect(durableRows(fixture.databasePath)).toHaveLength(1);
    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    expect(reply.mock.calls[0]?.[1].markdown).toBe("Got it. I’m looking into this now.");

    execution.resolve({ text: "durably handled" });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
    await controlPlane.stop();
  });

  it("renews the assignment lease while a healthy Worker is still executing", async () => {
    const fixture = await createFixture(1_000);
    const execution = deferred<{ readonly text: string }>();
    const worker = testWorker(() => execution.promise);
    const controlPlane = fixture.controlPlane({ worklet: worker, reply: vi.fn(async () => {}) });

    await controlPlane.start();
    await fixture.setupAccount(controlPlane);
    await controlPlane.ingestSurfaceEvent(event());
    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalledOnce());
    const initialLease = String(durableRows(fixture.databasePath)[0]?.leaseExpiresAt);
    await vi.waitFor(
      () => {
        const active = durableRows(fixture.databasePath)[0];
        expect(active).toMatchObject({ status: "processing", attemptCount: 1 });
        expect(String(active?.leaseExpiresAt) > initialLease).toBe(true);
      },
      { timeout: 2_000 },
    );
    execution.resolve({ text: "completed under a renewed lease" });
    await vi.waitFor(() => expect(durableRows(fixture.databasePath)[0]?.status).toBe("completed"));
    await controlPlane.stop();
  });

  it("creates one work item for duplicate delivery and logical event identities", async () => {
    const fixture = await createFixture();
    const execution = deferred<{ readonly text: string }>();
    const worker = testWorker(() => execution.promise);
    const reply = vi.fn(async () => {});
    const controlPlane = fixture.controlPlane({ worklet: worker, reply });
    const original = event();

    await controlPlane.start();
    await fixture.setupAccount(controlPlane);
    await expect(controlPlane.ingestSurfaceEvent(original)).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(controlPlane.ingestSurfaceEvent(original)).resolves.toMatchObject({
      status: "duplicate",
    });
    await expect(
      controlPlane.ingestSurfaceEvent({ ...original, eventId: "delivery-twin" }),
    ).resolves.toMatchObject({ status: "duplicate" });

    expect(durableRows(fixture.databasePath)).toHaveLength(1);
    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalledOnce());
    execution.resolve({ text: "only once" });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
    await controlPlane.stop();
  });

  it("dispatches admitted work in the background and delivers its reply", async () => {
    const fixture = await createFixture();
    const worker = testWorker(async () => ({ text: "background result" }));
    const reply = vi.fn(async () => {});
    const controlPlane = fixture.controlPlane({ worklet: worker, reply });
    const inbound = event();

    await controlPlane.start();
    const account = await fixture.setupAccount(controlPlane);
    await expect(controlPlane.ingestSurfaceEvent(inbound)).resolves.toMatchObject({
      status: "accepted",
      surfaceAccountId: account.id,
      eventId: inbound.eventId,
    });

    await vi.waitFor(() =>
      expect(
        reply.mock.calls.some((call) => call[1].markdown.startsWith("background result")),
      ).toBe(true),
    );
    expect(worker.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        tag: expect.objectContaining({ name: "Durable Test" }),
        input: expect.objectContaining({
          origin: expect.objectContaining({ sessionKey: inbound.sessionKey }),
        }),
        workerProfile: { id: "default", revision: "1" },
      }),
      expect.any(AbortSignal),
    );
    expect(durableRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ status: "completed", attemptCount: 1 }),
    ]);
    expect(outboundRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ presentation: "acknowledgement", status: "delivered" }),
      expect.objectContaining({ presentation: "final-result", status: "delivered" }),
    ]);
    expect(sessionRows(fixture.databasePath)).toEqual([
      expect.objectContaining({
        sessionKey: inbound.sessionKey,
        state: "open",
      }),
    ]);
    const tasks = taskRows(fixture.databasePath);
    expect(tasks).toEqual([
      expect.objectContaining({
        status: "completed",
      }),
    ]);
    expect(JSON.parse(String(tasks[0]?.["authorizationSnapshot"]))).toMatchObject({
      version: 5,
      tag: { name: "Durable Test" },
    });
    expect(taskAttemptRows(fixture.databasePath)).toEqual([
      expect.objectContaining({
        status: "completed",
        attemptNumber: 1,
        workerSnapshot: expect.stringContaining('"workerHostId":"test-host"'),
      }),
    ]);
    expect(
      taskEventRows(fixture.databasePath).map(({ sequence, type }) => ({ sequence, type })),
    ).toEqual([
      { sequence: 1, type: "task.admitted" },
      { sequence: 2, type: "task.execution-resolved" },
      { sequence: 3, type: "task.started" },
      { sequence: 4, type: "attempt.started" },
      { sequence: 5, type: "execution.started" },
      { sequence: 6, type: "execution.output.message" },
      { sequence: 7, type: "execution.result" },
      { sequence: 8, type: "execution.completed" },
      { sequence: 9, type: "surface.settlement-prepared" },
      { sequence: 10, type: "attempt.completed" },
      { sequence: 11, type: "task.completed" },
    ]);
    await controlPlane.stop();
  });

  it.each([false, true])(
    "cancels an active Task without replay after intent write failure: %s",
    async (failIntentWrite) => {
      // A failed intent write recovers only after its dispatch lease expires.
      const fixture = await createFixture(failIntentWrite ? 1_000 : dispatch.leaseDurationMs);
      let executionReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        executionReady = resolve;
      });
      const worklet: Worklet = {
        id: "cancellable-worklet",
        describe: async () => ({
          id: "cancellable-worklet",
          protocolVersion: 1,
          host: {
            id: "cancellable-host",
            workers: [
              {
                profileCapabilities: [
                  { profile: { id: "default", revision: "1" }, capabilities: [], contextTypes: [] },
                ],
                id: "cancellable-worker",
                type: "test",
                capabilities: [],
                profiles: [{ id: "default", revision: "1" }],
                contextTypes: [],
              },
            ],
          },
        }),
        execute: (spec, signal) => {
          async function* stream(): AsyncIterable<TaskAttemptEvent> {
            const cancellation = new Promise<void>((resolve) => {
              if (signal?.aborted) resolve();
              else signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            // Make cancellation deterministic: the test does not request it until
            // this execution has installed the abort listener it is asserting on.
            executionReady();
            yield {
              type: "execution.started",
              taskId: spec.taskId,
              attemptId: spec.attemptId,
              at: new Date().toISOString(),
              workerId: "cancellable-worker",
            };
            await cancellation;
            signal?.throwIfAborted();
          }
          return stream();
        },
      };
      const store = fixture.store();
      const prepare = store.prepareSurfaceAttempt.bind(store);
      let rejectedIntent = false;
      vi.spyOn(store, "prepareSurfaceAttempt").mockImplementation((input) => {
        if (failIntentWrite && !rejectedIntent) {
          rejectedIntent = true;
          return Promise.reject(new Error("first outcome write failed"));
        }
        return prepare(input);
      });
      const controlPlane = fixture.controlPlaneWithStore(store, {
        worklet,
        reply: vi.fn(async () => {}),
      });

      await controlPlane.start();
      try {
        await fixture.setupAccount(controlPlane);
        const admitted = await controlPlane.ingestSurfaceEvent(event());
        const taskId = admitted.taskId;
        if (taskId === undefined) throw new Error("Expected admitted Task");
        await ready;
        expect(taskRows(fixture.databasePath)[0]?.status).toBe("running");
        await expect(controlPlane.requestTaskCancellation(taskId)).resolves.toMatchObject({
          accepted: true,
        });
        await vi.waitFor(
          () => expect(taskRows(fixture.databasePath)[0]?.status).toBe("cancelled"),
          {
            timeout: failIntentWrite ? 3_000 : 1_000,
          },
        );
        expect(taskAttemptRows(fixture.databasePath)).toHaveLength(1);
        expect(rejectedIntent).toBe(failIntentWrite);
        await vi.waitFor(() =>
          expect(taskEventRows(fixture.databasePath)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "task.cancellation-requested" }),
              expect.objectContaining({ type: "attempt.cancelled" }),
              expect.objectContaining({ type: "task.cancelled" }),
            ]),
          ),
        );
      } finally {
        await controlPlane.stop();
      }
    },
  );

  it("promotes a successful native Session state and supplies it to the next Task in the Session", async () => {
    const fixture = await createFixture();
    const firstSessionState: SessionStateRef = {
      id: "codex-thread-1",
      format: "codex-thread-v1",
      uri: "supertag://worker-sessionStates/codex-thread-1",
      provenance: { provider: "codex", threadId: "thread-1" },
    };
    const secondSessionState: SessionStateRef = {
      id: "codex-thread-2",
      format: "codex-thread-v1",
      uri: "supertag://worker-sessionStates/codex-thread-2",
      provenance: { provider: "codex", threadId: "thread-1" },
    };
    let execution = 0;
    const worker = testWorker(async (spec) => {
      execution += 1;
      if (execution === 1) {
        expect(spec.session?.sessionState).toBeUndefined();
        return { text: "first turn", sessionState: firstSessionState };
      }
      expect(spec.session).toMatchObject({
        sessionState: firstSessionState,
        history: [
          expect.objectContaining({
            result: expect.objectContaining({ summary: "first turn" }),
          }),
        ],
      });
      return { text: "second turn", sessionState: secondSessionState };
    });
    const reply = vi.fn(async () => {});
    const controlPlane = fixture.controlPlane({ worklet: worker, reply });

    await controlPlane.start();
    try {
      await fixture.setupAccount(controlPlane);
      await controlPlane.ingestSurfaceEvent(event());
      await vi.waitFor(() => expect(sessionStateRows(fixture.databasePath)).toHaveLength(1));
      await controlPlane.ingestSurfaceEvent(
        event({
          eventId: "delivery-2",
          logicalEventId: "message:T-DURABLE:C123:1.001",
          text: "<@U_APP> continue",
          occurredAt: "2026-07-31T23:01:00.000Z",
          source: {
            workspaceId: "T-DURABLE",
            channelId: "C123",
            messageTs: "1.001",
            threadTs: "1.000",
          },
        }),
      );

      await vi.waitFor(() => expect(worker.execute).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(sessionStateRows(fixture.databasePath)).toHaveLength(2));
    } finally {
      await controlPlane.stop();
    }
  });

  it("does not resume an older Session state when the latest execution produced none", async () => {
    const fixture = await createFixture();
    const sessionState: SessionStateRef = {
      id: "old",
      format: "test-v1",
      uri: "sessionState://old",
    };
    let count = 0;
    const worker = testWorker(async (spec) => {
      count += 1;
      if (count === 1) return { text: "first", sessionState };
      if (count === 2) expect(spec.session?.sessionState).toEqual(sessionState);
      if (count === 3) {
        expect(spec.session?.sessionState).toBeUndefined();
        expect(spec.session?.history).toHaveLength(2);
      }
      return { text: `turn ${count}` };
    });
    const controlPlane = fixture.controlPlane({ worklet: worker, reply: vi.fn(async () => {}) });
    const verification = fixture.store();
    await controlPlane.start();
    await verification.connect();
    try {
      await fixture.setupAccount(controlPlane);
      for (let n = 1; n <= 3; n++) {
        await controlPlane.ingestSurfaceEvent(
          event({ eventId: `sessionState-${n}`, logicalEventId: `sessionState-${n}` }),
        );
        await vi.waitFor(async () =>
          expect((await verification.listTasks({ status: "completed" })).length).toBe(n),
        );
      }
      expect(worker.execute).toHaveBeenCalledTimes(3);
    } finally {
      await verification.disconnect();
      await controlPlane.stop();
    }
  });

  it.each([
    ["invalid URI", { ref: { id: "new", format: "test-v1", uri: "invalid" } }],
    [
      "invalid provenance",
      {
        ref: { id: "sessionState-2", format: "test-v1", uri: "sessionState://new", provenance: [] },
      },
    ],
    ["unsealed state", { status: "stored" }],
    ["changed profile", { workerProfile: { id: "default", revision: "2" } }],
    ["changed compatibility", { compatibility: "sha256:unrelated" }],
  ])(
    "does not fall back to older native state when the latest Session state has %s",
    async (change, metadataOverride) => {
      const fixture = await createFixture();
      let executions = 0;
      const worker = testWorker(async (spec) => {
        executions += 1;
        if (executions === 3) {
          // A Worker Profile revision does not gate native resume; the latest state still resumes.
          if (change === "changed profile")
            expect(spec.session?.sessionState).toMatchObject({ id: "sessionState-2" });
          else expect(spec.session?.sessionState).toBeUndefined();
          expect(spec.session?.history).toHaveLength(2);
          return { text: "continued from history" };
        }
        return {
          text: `turn ${executions}`,
          sessionState: {
            id: `sessionState-${executions}`,
            format: "test-v1",
            uri: `sessionState://turn-${executions}`,
          },
        };
      });
      const controlPlane = fixture.controlPlane({ worklet: worker, reply: vi.fn(async () => {}) });
      const verification = fixture.store();
      await controlPlane.start();
      await verification.connect();
      try {
        await fixture.setupAccount(controlPlane);
        for (let n = 1; n <= 2; n++) {
          await controlPlane.ingestSurfaceEvent(
            event({ eventId: `turn-${n}`, logicalEventId: `turn-${n}` }),
          );
          await vi.waitFor(async () =>
            expect(await verification.listTasks({ status: "completed" })).toHaveLength(n),
          );
        }
        await vi.waitFor(() => expect(sessionStateRows(fixture.databasePath)).toHaveLength(2));
        const states = sessionStateRows(fixture.databasePath);
        expect(states).toHaveLength(2);
        const latest = states.find((state) => state["id"] === "sessionState-2");
        if (!latest) throw new Error("Expected latest Session state");
        const database = new Database(fixture.databasePath);
        try {
          for (const [column, value] of Object.entries(metadataOverride)) {
            if (!["ref", "workerProfile", "compatibility", "status"].includes(column))
              throw new Error("Unexpected test state column");
            database
              .prepare(`UPDATE SessionState SET ${column} = ? WHERE id = ?`)
              .run(typeof value === "object" ? JSON.stringify(value) : value, latest["id"]);
          }
        } finally {
          database.close();
        }
        await controlPlane.ingestSurfaceEvent(
          event({ eventId: "turn-3", logicalEventId: "turn-3" }),
        );
        await vi.waitFor(async () =>
          expect(await verification.listTasks({ status: "completed" })).toHaveLength(3),
        );
        expect(worker.execute).toHaveBeenCalledTimes(3);
      } finally {
        await verification.disconnect();
        await controlPlane.stop();
      }
    },
  );

  it("keeps native continuation pending while its frozen profile is busy", async () => {
    const fixture = await createFixture();
    const sessionState: SessionStateRef = {
      id: "native-busy",
      format: "native-v1",
      uri: "supertag://sessionStates/busy",
    };
    let executions = 0;
    const base = testWorker(async (spec) => {
      executions++;
      if (executions === 1) return { text: "initial", sessionState };
      expect(spec.workerProfile).toEqual({ id: "default", revision: "1" });
      expect(spec.session?.sessionState).toEqual(sessionState);
      return { text: "resumed" };
    });
    let busy = false;
    const selectExecution = vi.fn(async (_requirements, _plan, options) => {
      if (options?.compatibleProfile) return busy ? undefined : options.compatibleProfile;
      return { id: busy ? "other" : "default", revision: "1" };
    });
    const worker: Worklet = {
      ...base,
      selectExecution,
      describe: async () => {
        const value = await base.describe();
        return {
          ...value,
          host: {
            ...value.host,
            workers: value.host.workers.map((worker) => ({
              ...worker,
              profiles: [...worker.profiles, { id: "other", revision: "1" }],
              profileCapabilities: [...worker.profiles, { id: "other", revision: "1" }].map(
                (profile) => ({
                  profile,
                  capabilities: worker.capabilities,
                  contextTypes: worker.contextTypes,
                }),
              ),
            })),
          },
        };
      },
    };
    const controlPlane = fixture.controlPlane({ worklet: worker, reply: vi.fn(async () => {}) });
    try {
      await controlPlane.start();
      await fixture.setupAccount(controlPlane);
      await controlPlane.ingestSurfaceEvent(event());
      await vi.waitFor(() => expect(sessionStateRows(fixture.databasePath)).toHaveLength(1));
      busy = true;
      const next = await controlPlane.ingestSurfaceEvent(
        event({
          eventId: "busy-next",
          logicalEventId: "message:T-DURABLE:C123:1.009",
          text: "continue",
          occurredAt: "2026-07-31T23:03:00.000Z",
        }),
      );
      await vi.waitFor(() =>
        expect(selectExecution).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({
            compatibleProfile: { id: "default", revision: "1" },
          }),
        ),
      );
      expect(executions).toBe(1);
      expect(taskAttemptRows(fixture.databasePath)).toHaveLength(1);
      expect(taskRows(fixture.databasePath).find((row) => row.id === next.taskId)?.status).toBe(
        "pending",
      );
      busy = false;
      await vi.waitFor(() => expect(executions).toBe(2));
    } finally {
      await controlPlane.stop();
    }
  });

  it("keeps native continuity when the admitted permission envelope changes", async () => {
    const fixture = await createFixture();
    const sessionState: SessionStateRef = {
      id: "native-session-1",
      format: "test-native-v1",
      uri: "supertag://worker-sessionStates/native-session-1",
    };
    let execution = 0;
    let resumed = false;
    const worker = testWorker(async (spec) => {
      execution += 1;
      if (execution === 1) return { text: "authorized first turn", sessionState };
      // The next turn resumes on the producing profile, under the new admitted policy.
      expect(spec.workerProfile).toEqual({ id: "default", revision: "1" });
      expect(spec.session?.sessionState).toEqual(sessionState);
      expect(spec.authorization.permissionSets).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "expanded-access" })]),
      );
      // History still travels as the fallback in case the harness cannot load the state.
      expect(spec.session?.history).toEqual([
        expect.objectContaining({
          result: expect.objectContaining({ summary: "authorized first turn" }),
        }),
      ]);
      resumed = true;
      return { text: "resumed after authorization changed" };
    });
    const selectable: Worklet = {
      ...worker,
      describe: async () => {
        const value = await worker.describe();
        return {
          ...value,
          host: {
            ...value.host,
            workers: value.host.workers.map((item) => ({
              ...item,
              profiles: [...item.profiles, { id: "other", revision: "1" }],
              profileCapabilities: [...item.profiles, { id: "other", revision: "1" }].map(
                (profile) => ({
                  profile,
                  capabilities: item.capabilities,
                  contextTypes: item.contextTypes,
                }),
              ),
            })),
          },
        };
      },
      selectExecution: async (_requirements, _plan, options) =>
        options?.compatibleProfile ?? { id: execution === 0 ? "default" : "other", revision: "1" },
    };
    const controlPlane = fixture.controlPlane({
      worklet: selectable,
      reply: vi.fn(async () => {}),
    });

    await controlPlane.start();
    const account = await fixture.setupAccount(controlPlane);
    await controlPlane.ingestSurfaceEvent(event());
    await vi.waitFor(() => expect(sessionStateRows(fixture.databasePath)).toHaveLength(1));

    const store = fixture.store();
    await store.connect();
    try {
      const route = await store.resolveTagRoute(account.id, "channel:C123");
      if (route === undefined) throw new Error("Expected the durable test Tag route");
      const permissionSet = await store.createTagPermissionSet({
        tagId: route.tagId,
        name: "expanded-access",
      });
      await store.addTagPermission({
        target: "surface",
        permissionSetId: permissionSet.id,
        surfaceAccountId: account.id,
        scope: "channel:C999",
        action: "thread:read",
      });
      await store.activateTagPermissionSet({
        permissionSetId: permissionSet.id,
        tagRouteId: route.id,
      });
    } finally {
      await store.disconnect();
    }

    await controlPlane.ingestSurfaceEvent(
      event({
        eventId: "delivery-permission-change",
        logicalEventId: "message:T-DURABLE:C123:1.002",
        text: "<@U_APP> continue after the permission change",
        occurredAt: "2026-07-31T23:02:00.000Z",
      }),
    );
    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(resumed).toBe(true));
    await controlPlane.stop();
  });

  it("retries from the last completed Session state instead of failed partial native state", async () => {
    const fixture = await createFixture();
    const baseSessionState: SessionStateRef = {
      id: "completed-sessionState",
      format: "test-native-v1",
      uri: "supertag://worker-sessionStates/completed-sessionState",
    };
    const partialSessionState: SessionStateRef = {
      id: "failed-partial-sessionState",
      format: "test-native-v1",
      uri: "supertag://worker-sessionStates/failed-partial-sessionState",
    };
    let execution = 0;
    const worker = testWorker(async (spec) => {
      execution += 1;
      if (execution === 1) return { text: "base turn", sessionState: baseSessionState };
      expect(spec.session?.sessionState).toEqual(baseSessionState);
      if (execution === 2) {
        return {
          text: "partial turn",
          sessionState: partialSessionState,
          failure: "transient failure after native state changed",
        };
      }
      return { text: "successful retry" };
    });
    const controlPlane = fixture.controlPlane({ worklet: worker, reply: vi.fn(async () => {}) });

    await controlPlane.start();
    await fixture.setupAccount(controlPlane);
    await controlPlane.ingestSurfaceEvent(event());
    await vi.waitFor(() => expect(sessionStateRows(fixture.databasePath)).toHaveLength(1));
    await controlPlane.ingestSurfaceEvent(
      event({
        eventId: "delivery-retry",
        logicalEventId: "message:T-DURABLE:C123:1.003",
        text: "<@U_APP> continue with a retry",
        occurredAt: "2026-07-31T23:03:00.000Z",
      }),
    );

    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalledTimes(3));
    expect(sessionStateRows(fixture.databasePath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: baseSessionState.id, status: "resumable" }),
        expect.objectContaining({ id: partialSessionState.id, status: "stored" }),
      ]),
    );
    expect(sessionStateRows(fixture.databasePath)).toHaveLength(2);
    await controlPlane.stop();
  });

  it("does not automatically retry an exhausted surface Task", async () => {
    const fixture = await createFixture();
    const worker = testWorker(async () => ({
      text: "partial work",
      failure: "Token allocation exhausted",
      failureName: "ExecutionBudgetExceededError",
    }));
    const reply = vi.fn(async () => {});
    const controlPlane = fixture.controlPlane({ worklet: worker, reply });
    await controlPlane.start();
    try {
      await fixture.setupAccount(controlPlane);
      await controlPlane.ingestSurfaceEvent(event());
      await vi.waitFor(() =>
        expect(taskRows(fixture.databasePath)).toEqual(
          expect.arrayContaining([expect.objectContaining({ status: "failed" })]),
        ),
      );
      await vi.waitFor(() =>
        expect(
          reply.mock.calls.some((call) =>
            (call as unknown as [unknown, { markdown: string }])[1].markdown.includes(
              "budget was exhausted",
            ),
          ),
        ).toBe(true),
      );
      expect(worker.execute).toHaveBeenCalledTimes(1);
      expect(taskAttemptRows(fixture.databasePath)).toHaveLength(1);
    } finally {
      await controlPlane.stop();
    }
  });

  it("retries Worker and reply failures without producing a duplicate successful reply", async () => {
    const fixture = await createFixture();
    let workerAttempts = 0;
    const worker = testWorker(async () => {
      workerAttempts += 1;
      if (workerAttempts === 1) {
        throw new Error("transient worker failure");
      }
      return { text: "eventually succeeds" };
    });
    let replyAttempts = 0;
    const successfulReplies: string[] = [];
    const reply = vi.fn(async (_event, presentation: { readonly markdown: string }) => {
      replyAttempts += 1;
      if (replyAttempts === 1) {
        throw new Error("transient provider failure");
      }
      successfulReplies.push(presentation.markdown);
    });
    const controlPlane = fixture.controlPlane({ worklet: worker, reply });

    await controlPlane.start();
    await fixture.setupAccount(controlPlane);
    await controlPlane.ingestSurfaceEvent(event());

    await vi.waitFor(() =>
      expect(successfulReplies.some((text) => text.startsWith("eventually succeeds"))).toBe(true),
    );
    expect(successfulReplies).toContain("Got it. I’m looking into this now.");
    expect(worker.execute).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledTimes(3);
    expect(durableRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ status: "completed", attemptCount: 2 }),
    ]);
    expect(outboundRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ presentation: "acknowledgement", status: "delivered" }),
      expect.objectContaining({ presentation: "final-result", status: "delivered" }),
    ]);
    expect(taskRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(taskAttemptRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ attemptNumber: 1, status: "failed" }),
      expect.objectContaining({ attemptNumber: 2, status: "completed" }),
    ]);
    await controlPlane.stop();
  });

  it("does not replay a Task after an external write has started", async () => {
    // This checks write replay safety, not lease expiry. Leave enough time for
    // pre-execution admission under concurrent database/build load.
    const fixture = await createFixture(5_000);
    const worker = writeThenFailWorklet();
    const reply = vi.fn(async () => {});
    const controlPlane = fixture.controlPlane({ worklet: worker, reply });

    await controlPlane.start();
    try {
      await fixture.setupAccount(controlPlane);
      await controlPlane.ingestSurfaceEvent(event({ eventId: "delivery-write-failure" }));

      await vi.waitFor(() =>
        expect(durableRows(fixture.databasePath)).toEqual([
          expect.objectContaining({ status: "failed", attemptCount: 1 }),
        ]),
      );
      expect(worker.execute).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(
          reply.mock.calls.some((call) =>
            call[1].markdown.includes(
              "Automatic retry is disabled because the action may have completed",
            ),
          ),
        ).toBe(true),
      );
      expect(taskAttemptRows(fixture.databasePath)).toEqual([
        expect.objectContaining({ attemptNumber: 1, status: "failed" }),
      ]);
      expect(taskEventRows(fixture.databasePath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "execution.tool.call.started" }),
          expect.objectContaining({ type: "attempt.failed" }),
          expect.objectContaining({ type: "task.failed" }),
        ]),
      );
    } finally {
      await controlPlane.stop();
    }
  });

  it("recovers pending work when a new Control Plane instance starts", async () => {
    const fixture = await createFixture();
    const seedStore = fixture.store();
    const seedControlPlane = fixture.controlPlaneWithStore(seedStore, {});
    await seedControlPlane.start();
    const account = await fixture.setupAccount(seedControlPlane);
    const surface = await seedStore.resolveTagRoute(account.id, event().scope);
    if (surface === undefined) {
      throw new Error("Expected the durable test route to have a Tag route");
    }
    const tag = await seedStore.findTagById(surface.tagId);
    if (tag === undefined) {
      throw new Error("Expected the durable test route to have a Tag");
    }
    const inbound = event();
    await seedStore.admitInboundEvent({
      surfaceAccountId: account.id,
      tagRouteId: surface.id,
      tagId: surface.tagId,
      event: inbound,
      authorization: authorizationSnapshot(tag, surface, account, inbound),
      contextPlan: emptyTagContextPlan("2026-08-01T00:00:00.000Z"),
      maxAttempts: dispatch.maxAttempts,
    });
    await seedControlPlane.stop();

    const worker = testWorker(async () => ({ text: "recovered" }));
    const reply = vi.fn(async () => {});
    const recoveredControlPlane = fixture.controlPlane(
      { worklet: worker, reply },
      "recovered-control-plane",
    );
    await recoveredControlPlane.start();

    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    expect(worker.execute).toHaveBeenCalledOnce();
    expect(durableRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(outboundRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ status: "delivered" }),
    ]);
    await recoveredControlPlane.stop();
  });

  it("stops gracefully by waiting for in-flight reply delivery", async () => {
    const fixture = await createFixture();
    const delivery = deferred<void>();
    const replyStarted = deferred<void>();
    const worker = testWorker(async () => ({ text: "finish before shutdown" }));
    const reply = vi.fn(async () => {
      replyStarted.resolve();
      await delivery.promise;
    });
    const controlPlane = fixture.controlPlane({ worklet: worker, reply });

    await controlPlane.start();
    await fixture.setupAccount(controlPlane);
    await controlPlane.ingestSurfaceEvent(event());
    await replyStarted.promise;

    let stopped = false;
    const stopping = controlPlane.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    delivery.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(outboundRows(fixture.databasePath)).toEqual([
      expect.objectContaining({ presentation: "acknowledgement", status: "delivered" }),
      expect.objectContaining({ presentation: "final-result", status: "delivered" }),
    ]);
    await expect(controlPlane.ingestSurfaceEvent(event())).rejects.toThrow(/not running|stopp/i);
  });
});

const postgresqlUrl = process.env["SUPERTAG_POSTGRES_URL"];
interface TestPostgresqlClient {
  query(text: string, values?: readonly string[]): Promise<unknown>;
  release(): void;
}
interface TestPostgresqlPool {
  connect(): Promise<TestPostgresqlClient>;
  end(): Promise<void>;
}
const PostgresqlPool = createRequire(new URL("../packages/store/package.json", import.meta.url))(
  "pg",
).Pool as new (options: {
  readonly connectionString: string;
}) => TestPostgresqlPool;

describe.each(["sqlite", "postgresql"] as const)("%s surface settlement recovery", (provider) => {
  it.skipIf(provider === "postgresql" && postgresqlUrl === undefined)(
    "terminalizes admission failures before any Attempt and publishes the error once",
    async () => {
      const fixture = await (provider === "sqlite"
        ? createFixture(10_000)
        : createPostgresqlFixture(10_000));
      const store = fixture.store();
      const worker = testWorker(async () => ({ text: "must not run" }));
      const controlPlane = fixture.controlPlaneWithStore(
        store,
        {
          worklet: worker,
          reply: async () => {},
          onInboundEvent: async () => {
            throw new Error("ingress unavailable");
          },
        },
        "pre-attempt-exhaustion",
      );
      await controlPlane.start();
      try {
        await fixture.setupAccount(controlPlane);
        const admission = await controlPlane.ingestSurfaceEvent(fixture.event());
        if (!admission.taskId || !admission.inboundEventId) throw new Error("Missing admission");
        await vi.waitFor(async () =>
          expect(
            (await store.findInboundEventById(admission.inboundEventId as string))?.status,
          ).toBe("failed"),
        );
        expect((await store.findInboundEventById(admission.inboundEventId))?.attemptCount).toBe(3);
        expect((await store.findTaskById(admission.taskId))?.status).toBe("failed");
        expect(await store.listTaskAttempts(admission.taskId)).toEqual([]);
        expect(await store.findOutboundReply(admission.inboundEventId, "final")).toMatchObject({
          presentation: "error",
        });
        expect(worker.execute).not.toHaveBeenCalled();
      } finally {
        await controlPlane.stop();
      }
    },
  );
  it
    .skipIf(provider === "postgresql" && postgresqlUrl === undefined)
    .each(["before-attempt", "unsafe-write", "retryable"] as const)(
    "recovers %s failure intent without spending retry budget or replaying work",
    async (kind) => {
      const fixture = await (provider === "sqlite"
        ? createFixture(10_000)
        : createPostgresqlFixture(10_000));
      const store = fixture.store();
      const unavailable = new Error("failure settlement unavailable");
      vi.spyOn(store, "settleSurfaceFailure").mockRejectedValue(unavailable);
      const worker =
        kind === "unsafe-write"
          ? writeThenFailWorklet()
          : testWorker(async () => {
              throw new Error("transient execution error");
            });
      const errors = vi.fn();
      const first = fixture.controlPlaneWithStore(
        store,
        {
          worklet: worker,
          reply: async () => {},
          onDispatchError: errors,
          ...(kind === "before-attempt"
            ? {
                onInboundEvent: async () => {
                  throw new Error("ingress hook failed");
                },
              }
            : {}),
        },
        "failure-first",
      );
      await first.start();
      let taskId: string;
      let inboundEventId: string;
      try {
        await fixture.setupAccount(first);
        const admission = await first.ingestSurfaceEvent(fixture.event());
        if (!admission.taskId || !admission.inboundEventId) throw new Error("Missing admission");
        taskId = admission.taskId;
        inboundEventId = admission.inboundEventId;
        await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(unavailable));
        await vi.waitFor(async () =>
          expect(
            (await store.listTaskEvents(taskId)).some(
              (entry) => entry.type === "surface.failure-prepared",
            ),
          ).toBe(true),
        );
        expect((await store.findInboundEventById(inboundEventId))?.attemptCount).toBe(1);
        expect(worker.execute).toHaveBeenCalledTimes(kind === "before-attempt" ? 0 : 1);
        expect(await store.findOutboundReply(inboundEventId, "final")).toBeUndefined();
      } finally {
        await first.stop();
      }
      await expireStoppedRecoveryLease(fixture.store(), inboundEventId);
      const recoveryStore = fixture.store();
      let concurrentSettlement = false;
      if (kind === "retryable") {
        const claim = recoveryStore.claimDueInboundEvent.bind(recoveryStore);
        vi.spyOn(recoveryStore, "claimDueInboundEvent").mockImplementationOnce(async (input) => {
          expect(input.recoveryOnly).toBe(true);
          // A second owner consumes the failure after our recovery-only preflight.
          const competing = await claim({ ...input, leaseOwner: "competing-recovery" });
          if (!competing) throw new Error("Competing owner could not claim failure intent");
          const settlement = new SurfaceSettlement(recoveryStore);
          const prepared = await settlement.pending(taskId);
          if (!prepared) throw new Error("Missing prepared failure");
          expect(await settlement.commit(prepared, inboundEventId, "competing-recovery")).toBe(
            "pending",
          );
          concurrentSettlement = true;
          return claim(input);
        });
      }
      const recovery = fixture.controlPlaneWithStore(recoveryStore, {}, "failure-recovery");
      await recovery.start();
      try {
        await vi.waitFor(async () =>
          expect((await recoveryStore.findInboundEventById(inboundEventId))?.status).toBe(
            kind === "unsafe-write" ? "failed" : "pending",
          ),
        );
        expect((await recoveryStore.findInboundEventById(inboundEventId))?.attemptCount).toBe(1);
        if (kind === "retryable") expect(concurrentSettlement).toBe(true);
        expect(
          (await recoveryStore.listTaskEvents(taskId)).filter(
            (entry) => entry.type === "surface.failure-settled",
          ),
        ).toHaveLength(1);
        if (kind === "unsafe-write") {
          expect((await recoveryStore.findTaskById(taskId))?.status).toBe("failed");
          expect(await recoveryStore.findOutboundReply(inboundEventId, "final")).toMatchObject({
            presentation: "error",
          });
        }
      } finally {
        await recovery.stop();
      }
      if (kind !== "unsafe-write") {
        const finalStore = fixture.store();
        const succeeding = testWorker(async () => ({ text: "retry completed" }));
        const last = fixture.controlPlaneWithStore(
          finalStore,
          { worklet: succeeding, reply: async () => {} },
          "failure-retry",
        );
        await last.start();
        try {
          await vi.waitFor(async () =>
            expect((await finalStore.findInboundEventById(inboundEventId))?.status).toBe(
              "completed",
            ),
          );
          expect((await finalStore.findInboundEventById(inboundEventId))?.attemptCount).toBe(2);
          expect(succeeding.execute).toHaveBeenCalledOnce();
          expect(
            (await finalStore.listTaskAttempts(taskId)).map((attempt) => attempt.status),
          ).toEqual(kind === "before-attempt" ? ["completed"] : ["failed", "completed"]);
        } finally {
          await last.stop();
        }
      }
    },
  );
  it.skipIf(provider === "postgresql" && postgresqlUrl === undefined).each([false, true])(
    "recovers a prepared outcome without rerunning execution (stale preflight: %s)",
    async (stalePreflight) => {
      const fixture = await (provider === "sqlite"
        ? createFixture(10_000)
        : createPostgresqlFixture(10_000));
      const store = fixture.store();
      const failure = new Error("terminal storage unavailable");
      vi.spyOn(store, "settleSurfaceAttempt").mockRejectedValue(failure);
      const prepare = store.prepareSurfaceAttempt.bind(store);
      let preparationWrites = 0;
      vi.spyOn(store, "prepareSurfaceAttempt").mockImplementation((input) => {
        if (++preparationWrites > 1)
          return Promise.reject(new Error("redundant intent write unavailable"));
        return prepare(input);
      });
      const onDispatchError = vi.fn();
      const worker = testWorker(async () => ({ text: "executed exactly once" }));
      const reply = vi.fn(async () => {});
      const first = fixture.controlPlaneWithStore(
        store,
        { worklet: worker, reply, onDispatchError },
        "settlement-first",
      );
      await first.start();
      let taskId: string;
      let inboundEventId: string;
      try {
        await fixture.setupAccount(first);
        const admission = await first.ingestSurfaceEvent(fixture.event());
        if (!admission.taskId || !admission.inboundEventId)
          throw new Error("Expected durable admission");
        taskId = admission.taskId;
        inboundEventId = admission.inboundEventId;
        await vi.waitFor(() => expect(onDispatchError).toHaveBeenCalledWith(failure));
        expect((await store.findTaskById(taskId))?.status).toBe("running");
        expect((await store.findInboundEventById(inboundEventId))?.status).toBe("processing");
        expect(await store.findOutboundReply(inboundEventId, "final")).toBeUndefined();
        expect(worker.execute).toHaveBeenCalledOnce();
        expect(preparationWrites).toBe(1);
        await expect(first.requestTaskCancellation(taskId)).resolves.toMatchObject({
          accepted: false,
        });
      } finally {
        await first.stop();
      }

      await expireStoppedRecoveryLease(fixture.store(), inboundEventId);
      const workerlessStore = fixture.store();
      const recoveryWorklet = testWorker(async () => {
        throw new Error("Prepared execution cannot run again");
      });
      if (stalePreflight) vi.spyOn(workerlessStore, "listTaskEvents").mockResolvedValueOnce([]);
      const workerless = fixture.controlPlaneWithStore(
        workerlessStore,
        stalePreflight ? { worklet: recoveryWorklet, reply } : {},
        "settlement-workerless",
      );
      await workerless.start();
      try {
        await vi.waitFor(async () =>
          expect((await workerlessStore.findInboundEventById(inboundEventId))?.status).toBe(
            "completed",
          ),
        );
        expect((await workerlessStore.findTaskById(taskId))?.status).toBe("completed");
        if (!stalePreflight)
          expect((await workerlessStore.findOutboundReply(inboundEventId, "final"))?.status).toBe(
            "pending",
          );
        expect(recoveryWorklet.execute).not.toHaveBeenCalled();
        expect((await workerlessStore.findTaskById(taskId))?.result).toBeDefined();
        expect(await workerlessStore.listCapturedArtifacts({ taskId })).toMatchObject({
          artifacts: [],
        });
      } finally {
        await workerless.stop();
      }

      const recoveredStore = fixture.store();
      const unavailable: Worklet = {
        id: "unavailable",
        describe: vi.fn(async () => {
          throw new Error("Worker is offline");
        }),
        execute: vi.fn(() => {
          throw new Error("Completed execution must not be repeated");
        }),
      };
      const recovered = fixture.controlPlaneWithStore(
        recoveredStore,
        { worklet: unavailable, reply },
        "settlement-recovered",
      );
      await recovered.start();
      try {
        await vi.waitFor(async () =>
          expect((await recoveredStore.findInboundEventById(inboundEventId))?.status).toBe(
            "completed",
          ),
        );
        expect((await recoveredStore.findTaskById(taskId))?.status).toBe("completed");
        const attempts = await recoveredStore.listTaskAttempts(taskId);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.status).toBe("completed");
        await vi.waitFor(async () =>
          expect((await recoveredStore.findOutboundReply(inboundEventId, "final"))?.status).toBe(
            "delivered",
          ),
        );
        expect(unavailable.execute).not.toHaveBeenCalled();
        expect(worker.execute).toHaveBeenCalledOnce();
        expect(
          reply.mock.calls.filter((call) => call[1].markdown.startsWith("executed exactly once")),
        ).toHaveLength(1);
      } finally {
        await recovered.stop();
      }
    },
  );
});

describe.runIf(postgresqlUrl !== undefined)("PostgreSQL Control Plane durable lifecycle", () => {
  it("recovers durably admitted safe work after Control Plane and store reconnect", async () => {
    // This exercises pending admission recovery, not lease expiry. Allow the
    // healthy owner time for PostgreSQL round trips under concurrent suite load.
    const fixture = await createPostgresqlFixture(10_000);
    const seedStore = fixture.store();
    const seedControlPlane = fixture.controlPlaneWithStore(
      seedStore,
      {},
      "postgresql-seed-control-plane",
    );

    await seedControlPlane.start();
    const { tag } = await fixture.setupAccount(seedControlPlane);
    const inbound = fixture.event();
    const admission = await seedControlPlane.ingestSurfaceEvent(inbound);
    expect(admission).toMatchObject({ status: "accepted", taskId: expect.any(String) });
    if (admission.taskId === undefined) throw new Error("Expected the admitted PostgreSQL Task");
    await seedControlPlane.stop();

    const reconnectedStore = fixture.store();
    await reconnectedStore.connect();
    const reconnectedTasks = await reconnectedStore.listTasks({ tagId: tag.id });
    expect(reconnectedTasks).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(reconnectedTasks[0]?.id).toBe(admission.taskId);
    await reconnectedStore.disconnect();

    const worker = testWorker(async () => ({ text: "recovered from PostgreSQL" }));
    const reply = vi.fn(async () => {});
    const recoveredControlPlane = fixture.controlPlane(
      { worklet: worker, reply },
      "postgresql-recovered-control-plane",
    );
    await recoveredControlPlane.start();

    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
    const verificationStore = fixture.store();
    await verificationStore.connect();
    await vi.waitFor(async () =>
      expect(await verificationStore.listTasks({ tagId: tag.id })).toEqual([
        expect.objectContaining({ status: "completed" }),
      ]),
    );
    expect(await verificationStore.listTaskAttempts(admission.taskId)).toEqual([
      expect.objectContaining({ attemptNumber: 1, status: "completed" }),
    ]);
    await verificationStore.disconnect();
    await recoveredControlPlane.stop();
  });

  it("does not replay a write-started in-doubt attempt after reconnect", async () => {
    const fixture = await createPostgresqlFixture();
    const writeStartedWorker = writeThenFailWorklet();
    const firstControlPlane = fixture.controlPlane(
      { worklet: writeStartedWorker, reply: vi.fn(async () => {}) },
      "postgresql-write-control-plane",
    );

    await firstControlPlane.start();
    const { tag } = await fixture.setupAccount(firstControlPlane);
    await firstControlPlane.ingestSurfaceEvent(
      fixture.event({ eventId: `write-${fixture.suffix}` }),
    );

    const verificationStore = fixture.store();
    await verificationStore.connect();
    await vi.waitFor(async () =>
      expect(await verificationStore.listTasks({ tagId: tag.id })).toEqual([
        expect.objectContaining({ status: "failed" }),
      ]),
    );
    const [failedTask] = await verificationStore.listTasks({ tagId: tag.id });
    if (failedTask === undefined) throw new Error("Expected the failed PostgreSQL Task");
    expect(await verificationStore.listTaskAttempts(failedTask.id)).toEqual([
      expect.objectContaining({ attemptNumber: 1, status: "failed" }),
    ]);
    await vi.waitFor(async () =>
      expect(await verificationStore.listTaskEvents(failedTask.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "execution.tool.call.started" }),
          expect.objectContaining({ type: "attempt.failed" }),
          expect.objectContaining({ type: "task.failed" }),
        ]),
      ),
    );
    await verificationStore.disconnect();
    await firstControlPlane.stop();

    const replayWorker = testWorker(async () => ({ text: "must not run" }));
    const recoveredControlPlane = fixture.controlPlane(
      { worklet: replayWorker, reply: vi.fn(async () => {}) },
      "postgresql-after-write-control-plane",
    );
    await recoveredControlPlane.start();
    // This Task is already terminal; allow several dispatcher polls to prove it is not replayed.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(replayWorker.execute).not.toHaveBeenCalled();
    const reconnectedStore = fixture.store();
    await reconnectedStore.connect();
    expect(await reconnectedStore.listTasks({ tagId: tag.id })).toEqual([
      expect.objectContaining({ id: failedTask.id, status: "failed" }),
    ]);
    expect(await reconnectedStore.listTaskAttempts(failedTask.id)).toHaveLength(1);
    await reconnectedStore.disconnect();
    await recoveredControlPlane.stop();
  });
});

interface ControlPlaneHandlers {
  readonly onInboundEvent?: ConstructorParameters<typeof ControlPlane>[0]["onInboundEvent"];
  readonly worklet?: Worklet;
  readonly reply?: ConstructorParameters<typeof ControlPlane>[0]["reply"];
  readonly onDispatchError?: NonNullable<
    ConstructorParameters<typeof ControlPlane>[0]["dispatch"]
  >["onDispatchError"];
}

async function createFixture(leaseDurationMs = dispatch.leaseDurationMs) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-durable-control-plane-"));
  directories.push(directory);
  const databasePath = join(directory, "supertag.db");
  await migrateSqlite(databasePath);
  const secretPath = join(directory, "secrets.json");
  const store = () => new DrizzleStore({ url: `file:${databasePath}` });
  const workerHosts = new WeakMap<ControlPlane, Promise<string>>();
  const controlPlaneWithStore = (
    controlPlaneStore: DrizzleStore,
    handlers: ControlPlaneHandlers,
    instanceId = dispatch.instanceId,
  ) => {
    if (handlers.worklet) sessionStores.set(handlers.worklet.execute, controlPlaneStore);
    const controlPlane = new ControlPlane({
      store: controlPlaneStore,
      credentialVault: new FileGatewayCredentialVault(secretPath),
      ...handlers,
      dispatch: {
        ...dispatch,
        leaseDurationMs,
        instanceId,
        ...(handlers.onDispatchError ? { onDispatchError: handlers.onDispatchError } : {}),
      },
    });
    workerHosts.set(
      controlPlane,
      handlers.worklet
        ?.describe()
        .then((descriptor) => descriptor.host.id)
        .catch(() => "fixture-host") ?? Promise.resolve("fixture-host"),
    );
    return controlPlane;
  };
  const controlPlane = (handlers: ControlPlaneHandlers, instanceId?: string) =>
    controlPlaneWithStore(store(), handlers, instanceId);
  const setupAccount = async (target: ControlPlane): Promise<SurfaceAccount> => {
    const account = await target.setupSurfaceAccount({
      provider: "slack",
      externalAccountId: "T-DURABLE",
      displayName: "Durable Test",
      authMethod: "slack-socket-mode",
      configuration: { transport: "socket" },
      secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
    });
    const routeStore = store();
    await routeStore.connect();
    try {
      const tag = await routeStore.createTag({ name: "Durable Test" });
      await routeStore.bindTagWorkerHost(tag.id, await (workerHosts.get(target) ?? "fixture-host"));
      await routeStore.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
      });
    } finally {
      await routeStore.disconnect();
    }
    return account;
  };
  return { databasePath, controlPlane, controlPlaneWithStore, setupAccount, store, event };
}

async function createPostgresqlFixture(leaseDurationMs = dispatch.leaseDurationMs) {
  if (postgresqlUrl === undefined) throw new Error("SUPERTAG_POSTGRES_URL is required");
  const suffix = randomUUID().replaceAll("-", "");
  const externalAccountId = `T${suffix.slice(0, 20).toUpperCase()}`;
  const channelId = `C${suffix.slice(0, 20).toUpperCase()}`;
  const tagName = `PostgreSQL Durable ${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "supertag-postgresql-durable-"));
  directories.push(directory);
  // Control Plane dispatch consumes the entire database, including other fixtures' replies.
  // Isolate this lifecycle rather than weakening its exact delivery assertions.
  const databaseName = `supertag_lifecycle_${suffix}`;
  const admin = new PostgresqlPool({ connectionString: postgresqlUrl });
  const adminClient = await admin.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    adminClient.release();
    await admin.end();
  }
  const isolated = new URL(postgresqlUrl);
  isolated.pathname = `/${databaseName}`;
  const fixtureUrl = isolated.toString();
  const stores: DrizzleStore[] = [];
  const store = () => {
    const value = new DrizzleStore({ url: fixtureUrl });
    stores.push(value);
    return value;
  };
  const controlPlanes: ControlPlane[] = [];
  const workerHosts = new WeakMap<ControlPlane, Promise<string>>();
  const controlPlaneWithStore = (
    controlPlaneStore: DrizzleStore,
    handlers: ControlPlaneHandlers,
    instanceId: string,
  ) => {
    const controlPlane = new ControlPlane({
      store: controlPlaneStore,
      credentialVault: new FileGatewayCredentialVault(join(directory, "credentials.json")),
      ...handlers,
      dispatch: {
        ...dispatch,
        leaseDurationMs,
        instanceId,
        ...(handlers.onDispatchError ? { onDispatchError: handlers.onDispatchError } : {}),
      },
    });
    controlPlanes.push(controlPlane);
    workerHosts.set(
      controlPlane,
      handlers.worklet
        ?.describe()
        .then((descriptor) => descriptor.host.id)
        .catch(() => "fixture-host") ?? Promise.resolve("fixture-host"),
    );
    return controlPlane;
  };
  const controlPlane = (handlers: ControlPlaneHandlers, instanceId: string) =>
    controlPlaneWithStore(store(), handlers, instanceId);
  const setupAccount = async (target: ControlPlane) => {
    const account = await target.setupSurfaceAccount({
      provider: "slack",
      externalAccountId,
      displayName: tagName,
      authMethod: "slack-socket-mode",
      configuration: { transport: "socket" },
      secrets: { botToken: "xoxb-postgresql-test", appToken: "xapp-postgresql-test" },
    });
    const routeStore = store();
    await routeStore.connect();
    try {
      const tag = await routeStore.createTag({ name: tagName });
      await routeStore.bindTagWorkerHost(tag.id, await (workerHosts.get(target) ?? "fixture-host"));
      const route = await routeStore.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: `channel:${channelId}`,
      });
      return { account, route, tag };
    } finally {
      await routeStore.disconnect();
    }
  };
  const fixtureEvent = (overrides: Partial<InboundSurfaceEvent> = {}) =>
    event({
      eventId: `delivery-${suffix}`,
      logicalEventId: `message:${externalAccountId}:${channelId}:1.000`,
      externalAccountId,
      scope: `channel:${channelId}`,
      sessionKey: `slack:${externalAccountId}:${channelId}:1.000`,
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: `${externalAccountId}|${channelId}|1.000`,
        target: { channelId, threadTs: "1.000" },
      },
      source: {
        workspaceId: externalAccountId,
        channelId,
        messageTs: "1.000",
        threadTs: "1.000",
      },
      ...overrides,
    });

  postgresqlCleanups.push(async () => {
    await Promise.allSettled(controlPlanes.map((target) => target.stop()));
    await Promise.allSettled(stores.map((value) => value.disconnect()));
    const pool = new PostgresqlPool({ connectionString: postgresqlUrl });
    const client = await pool.connect();
    try {
      await client.query(`DROP DATABASE "${databaseName}"`);
    } finally {
      client.release();
      await pool.end();
    }
  });
  await migrateDatabase({ url: fixtureUrl });

  return {
    event: fixtureEvent,
    controlPlane,
    controlPlaneWithStore,
    setupAccount,
    store,
    suffix,
  };
}

// Recovery cases exercise durable intent consumption, not scheduler latency. Keep the
// running owner's lease long enough for concurrent PostgreSQL suites, then expire
// it explicitly only after that owner has stopped and cannot renew it.
async function expireStoppedRecoveryLease(store: DrizzleStore, inboundEventId: string) {
  await store.connect();
  try {
    const inbound = await store.findInboundEventById(inboundEventId);
    expect(inbound?.status).toBe("processing");
    if (!inbound?.leaseOwner) throw new Error("Expected stopped recovery lease owner");
    const expiredAt = Date.now() - 1_000;
    expect(
      await store.renewInboundEventLease({
        inboundEventId,
        leaseOwner: inbound.leaseOwner,
        now: new Date(expiredAt - 1_000).toISOString(),
        leaseExpiresAt: new Date(expiredAt).toISOString(),
      }),
    ).toBe(true);
  } finally {
    await store.disconnect();
  }
}

async function migrateSqlite(databasePath: string): Promise<void> {
  await migrateSqliteDatabase(databasePath);
}

function durableRows(databasePath: string): Array<Record<string, unknown>> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT * FROM DurableInboundEvent ORDER BY createdAt").all();
  } finally {
    database.close();
  }
}

function outboundRows(databasePath: string): Array<Record<string, unknown>> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT * FROM OutboundReply ORDER BY createdAt").all();
  } finally {
    database.close();
  }
}

function sessionRows(databasePath: string): Array<Record<string, unknown>> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT * FROM Session ORDER BY createdAt").all();
  } finally {
    database.close();
  }
}

function taskRows(databasePath: string): Array<Record<string, unknown>> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT * FROM Task ORDER BY createdAt").all();
  } finally {
    database.close();
  }
}

function taskAttemptRows(databasePath: string): Array<Record<string, unknown>> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT * FROM TaskAttempt ORDER BY attemptNumber").all();
  } finally {
    database.close();
  }
}

function taskEventRows(databasePath: string): Array<Record<string, unknown>> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT * FROM TaskEvent ORDER BY sequence").all();
  } finally {
    database.close();
  }
}

function sessionStateRows(databasePath: string): Array<Record<string, unknown>> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT * FROM SessionState ORDER BY createdAt").all();
  } finally {
    database.close();
  }
}

function testWorker(
  handle: (spec: TaskAttemptSpec) => Promise<{
    readonly text: string;
    readonly artifacts?: readonly { artifactId: string; paths: readonly string[] }[];
    readonly sessionState?: SessionStateRef;
    readonly failure?: string;
    readonly failureName?: string;
  }>,
): Worklet & { execute: ReturnType<typeof vi.fn<Worklet["execute"]>> } {
  const execute = vi.fn((spec: TaskAttemptSpec): AsyncIterable<TaskAttemptEvent> => {
    async function* stream(): AsyncIterable<TaskAttemptEvent> {
      const at = "2026-08-02T00:00:00.000Z";
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at };
      yield { type: "execution.started", ...identity, workerId: "test-worker" };
      const result = await handle(spec);
      yield {
        type: "output.message",
        ...identity,
        message: { role: "teammate", text: result.text },
      };
      yield {
        type: "result",
        ...identity,
        result: {
          summary: result.text,
          decisions: [],
          changes: [],
          unresolved: [],
          findings: [],
          references: [],
          artifacts: result.artifacts ?? [],
        },
      };
      if (result.sessionState !== undefined) {
        const store = sessionStores.get(execute);
        if (!store) throw new Error("Test Worker needs a Session storage adapter");
        await store.putSessionState({
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          harnessId: "test",
          ref: { ...result.sessionState },
          data: { transcript: result.text },
        });
        yield { type: "session.updated", ...identity, sessionState: result.sessionState };
      }
      if (result.failure !== undefined) {
        yield {
          type: "execution.failed",
          ...identity,
          error: { name: result.failureName ?? "TestWorkerError", message: result.failure },
        };
        return;
      }
      yield { type: "execution.completed", ...identity };
    }
    return stream();
  });
  return {
    id: "test-worklet",
    describe: async () => ({
      id: "test-worklet",
      protocolVersion: 1,
      host: {
        id: "test-host",
        workers: [
          {
            profileCapabilities: [
              { profile: { id: "default", revision: "1" }, capabilities: [], contextTypes: [] },
            ],
            id: "test-worker",
            type: "test",
            capabilities: [],
            profiles: [{ id: "default", revision: "1" }],
            contextTypes: [],
          },
        ],
      },
    }),
    execute,
  };
}

function writeThenFailWorklet(): Worklet & {
  execute: ReturnType<typeof vi.fn<Worklet["execute"]>>;
} {
  const execute = vi.fn((spec: TaskAttemptSpec): AsyncIterable<TaskAttemptEvent> => {
    async function* stream(): AsyncIterable<TaskAttemptEvent> {
      const identity = {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: "2026-08-15T00:00:00.000Z",
      };
      yield { type: "execution.started", ...identity, workerId: "write-worker" };
      yield {
        type: "tool.call.started",
        ...identity,
        call: {
          id: "write-call-1",
          capabilityId: "linear:account-1",
          provider: "linear",
          binding: { kind: "mcp-http", name: "linear" },
          operation: "create_issue",
          effect: "write",
          actions: ["issues:create"],
          resources: [{ surfaceAccountId: "account-1", scope: "team:T1" }],
        },
      };
      throw new Error("connection closed after the provider accepted the request");
    }
    return stream();
  });
  return {
    id: "write-worklet",
    describe: async () => ({
      id: "write-worklet",
      protocolVersion: 1,
      host: {
        id: "write-host",
        workers: [
          {
            profileCapabilities: [
              { profile: { id: "default", revision: "1" }, capabilities: [], contextTypes: [] },
            ],
            id: "write-worker",
            type: "test",
            capabilities: [],
            profiles: [{ id: "default", revision: "1" }],
            contextTypes: [],
          },
        ],
      },
    }),
    execute,
  };
}

function authorizationSnapshot(
  tag: Pick<Tag, "id" | "name">,
  surface: { readonly id: string; readonly scope: string },
  account: SurfaceAccount,
  inbound: InboundSurfaceEvent,
): TagAuthorizationSnapshot {
  return {
    version: 5,
    capturedAt: "2026-08-01T00:00:00.000Z",
    tag: { id: tag.id, name: tag.name },
    origin: {
      tagRouteId: surface.id,
      surfaceAccountId: account.id,
      provider: account.provider,
      scope: surface.scope,
    },
    requester: inbound.actor,
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function event(overrides: Partial<InboundSurfaceEvent> = {}): InboundSurfaceEvent {
  return {
    eventId: "delivery-1",
    logicalEventId: "message:T-DURABLE:C123:1.000",
    provider: "slack",
    externalAccountId: "T-DURABLE",
    kind: "mention",
    scope: "channel:C123",
    sessionKey: "slack:T-DURABLE:C123:1.000",
    actor: { id: "U123", kind: "user" },
    text: "<@U_APP> handle this durably",
    occurredAt: "2026-07-31T23:00:00.000Z",
    callback: {
      provider: "slack",
      mode: "slack_thread",
      threadKey: "T-DURABLE|C123|1.000",
      target: { channelId: "C123", threadTs: "1.000" },
    },
    source: {
      workspaceId: "T-DURABLE",
      channelId: "C123",
      messageTs: "1.000",
      threadTs: "1.000",
    },
    metadata: { slackEventType: "app_mention" },
    ...overrides,
  };
}
