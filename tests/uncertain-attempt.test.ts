import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import {
  coordinationInboxCommands,
  EXECUTION_UNCONFIRMED_BLOCK_REASON,
} from "../packages/core/src/index.js";
import {
  DurableLocalWorklet,
  ExecutionCleanupError,
  FileAttemptJournal,
  type UncertainAttempt,
  type Worklet,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { startObjectiveSession } from "./support/objective-session.js";

// Item 146 of the dogfood log: an Attempt whose cleanup exceeded its bound became `unknown`, the
// Control Plane logged "may have executed ... automatic replay is disabled", and the Task kept
// showing running with an expired lease while nobody was told. The Objective's own turns run on
// the same surface path as every other Session, so this is where that is covered now.

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const profile = { id: "uncertain-profile", revision: "1" };

/** A Worklet whose Attempt starts and then cannot confirm its cleanup. */
function cleanupTimeoutWorklet(detail = ""): Worklet {
  return {
    id: "uncertain-worklet",
    async describe() {
      return {
        id: "uncertain-worklet",
        protocolVersion: 1,
        host: {
          id: "uncertain-host",
          workers: [
            {
              profileCapabilities: [
                {
                  profile,
                  capabilities: [{ id: "supertag.coordination", version: 1 }],
                  contextTypes: [],
                },
              ],
              id: "uncertain-worker",
              type: "test",
              profiles: [profile],
              capabilities: [{ id: "supertag.coordination", version: 1 }],
              contextTypes: [],
              maxConcurrency: 1,
            },
          ],
        },
      };
    },
    async *execute(spec) {
      yield {
        type: "execution.started" as const,
        workerId: "uncertain-worker",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
      };
      throw new ExecutionCleanupError(
        `Execution cleanup exceeded 5 seconds (credential ${spec.coordination?.token ?? ""})${detail}`,
      );
    },
  };
}

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const)
  it.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect}: an Objective turn whose Attempt is uncertain blocks its Session and reaches the operator inbox`,
    async () => {
      vi.stubEnv("PROVIDER_API_KEY", "host-provider-secret");
      const state = await mkdtemp(join(tmpdir(), "supertag-uncertain-"));
      cleanups.push(() => rm(state, { recursive: true, force: true }));
      const isolated =
        dialect === "postgresql"
          ? await createIsolatedPostgresDatabase(postgres as string)
          : undefined;
      if (isolated) cleanups.push(() => isolated.cleanup());
      const url = isolated?.url ?? `file:${join(state, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());

      const reported: (readonly UncertainAttempt[])[] = [];
      const durable = new DurableLocalWorklet(
        cleanupTimeoutWorklet(
          " host-provider-secret https://url-user:url-password@example.test/path",
        ),
        new FileAttemptJournal(join(state, "hosts", "laptop", "attempt-journal")),
        { onUncertainAttempts: (attempts) => reported.push(attempts) },
      );
      cleanups.push(() => durable.close());
      const onDispatchError = vi.fn();
      const controlPlane = new ControlPlane({
        store,
        credentialVault: new FileGatewayCredentialVault(join(state, "vault.json")),
        worklet: durable,
        reply: async () => ({ externalMessageId: randomUUID() }),
        dispatch: { pollIntervalMs: 10, retryBaseMs: 10, maxAttempts: 3, onDispatchError },
      });
      await controlPlane.start();
      cleanups.push(() => controlPlane.stop());

      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      await store.bindTagWorkerHost(owner.id, "uncertain-host");
      const session = await startObjectiveSession({
        store,
        controlPlane,
        ownerTagId: owner.id,
        objective: { outcome: "Recover uncertain work" },
      });

      // The turn stays running: SuperTag never replays an Attempt it could not confirm.
      const event = await expect
        .poll(
          async () => {
            const task = await store.findTaskById(session.startTaskId);
            const inbound = task?.inboundEventId
              ? await store.findInboundEventById(task.inboundEventId)
              : undefined;
            return inbound?.sessionBlocked === true ? inbound : undefined;
          },
          { timeout: 15_000 },
        )
        .toBeTruthy()
        .then(async () => {
          const task = await store.findTaskById(session.startTaskId);
          return store.findInboundEventById(task?.inboundEventId as string);
        });
      expect(event?.lastError).toContain("Execution completion could not be confirmed");
      // The Attempt is recorded once and never replayed, and the turn stays unfinished work.
      expect(await store.listTaskAttempts(session.startTaskId)).toHaveLength(1);
      expect((await store.findTaskById(session.startTaskId))?.outcome?.["error"]).toContain(
        "automatic replay is disabled",
      );
      const taskEvents = await store.listTaskEvents(session.startTaskId);
      expect(taskEvents.map((entry) => entry.type)).toContain("execution.uncertain");
      const uncertain = taskEvents.findLast((entry) => entry.type === "execution.uncertain");
      expect(JSON.stringify(uncertain?.payload)).toContain("ExecutionCleanupError");
      // The Attempt credential and the host's secrets are redacted before anything stores them.
      expect(JSON.stringify(uncertain?.payload)).toContain("https://[REDACTED]@example.test/path");
      expect(onDispatchError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("automatic replay is disabled"),
        }),
      );

      // Nothing the host reported carries the Attempt credential or host secrets.
      const attemptId = (await store.listTaskAttempts(session.startTaskId))[0]?.id as string;
      const inbox = await store.readCoordinationInbox({ objectiveId: session.objective.id });
      const item = inbox.items.find((entry) => entry.uncertainAttempt?.attemptId === attemptId);
      for (const view of [event, inbox, taskEvents]) {
        const serialized = JSON.stringify(view);
        for (const secret of ["host-provider-secret", "url-user", "url-password"])
          expect(serialized).not.toContain(secret);
      }

      // The operator inbox holds the Task, with the command that settles the Attempt.
      expect(item).toMatchObject({
        kind: "task_attention",
        objectiveId: session.objective.id,
        operatorEligible: true,
        reason: expect.stringContaining("stop the host service first"),
      });
      if (!item) throw new Error("Missing uncertain inbox item");
      // The inbox names the Attempt's recorded Worker, so the recover command is runnable.
      expect(item.uncertainAttempt).toMatchObject({
        attemptId,
        workerHostId: "uncertain-host",
        workerId: "uncertain-worker",
      });
      expect(coordinationInboxCommands(item)[0]).toBe(
        `supertag recover worklet --worker-id uncertain-worker --task ${session.startTaskId} --attempt ${attemptId} --confirm-stopped --reason TEXT`,
      );

      // The host reports the same Attempt for `supertag ps`.
      expect(reported.at(-1)).toEqual([
        expect.objectContaining({
          attemptId,
          taskId: session.startTaskId,
          workerId: "uncertain-worker",
          uncertainty: expect.objectContaining({ name: "ExecutionCleanupError" }),
        }),
      ]);
    },
    60_000,
  );

/**
 * A Worklet whose first Attempt is uncertain and whose later Attempts succeed. With `cancel`,
 * the first Attempt instead runs until it is cancelled and takes a moment to clean up.
 * `recoverExecutionCleanup` reports whether the Worker can now verify that execution stopped.
 */
function firstAttemptUncertainWorklet(state: {
  cleanupVerifiable: boolean;
  readonly executions: string[];
  readonly cancel?: boolean;
  /** When set, the first Attempt of this Tag is the uncertain one; other Tags' Attempts succeed. */
  uncertainTagId?: string;
}): Worklet {
  const base = cleanupTimeoutWorklet();
  return {
    id: base.id,
    describe: () => base.describe(),
    async recoverExecutionCleanup() {
      return state.cleanupVerifiable;
    },
    async *execute(spec, signal) {
      const first =
        state.uncertainTagId === undefined
          ? state.executions.length === 0
          : spec.tag.id === state.uncertainTagId && !state.executions.includes("first");
      state.executions.push(first ? "first" : spec.taskId);
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId };
      yield {
        ...identity,
        type: "execution.started" as const,
        workerId: "uncertain-worker",
        at: new Date().toISOString(),
      };
      if (first && state.cancel) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        // Cleanup takes a moment after the abort; the Worker confirms it by returning.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return;
      }
      if (first) throw new ExecutionCleanupError("Execution cleanup exceeded 5 seconds");
      const at = new Date().toISOString();
      yield {
        ...identity,
        at,
        type: "output.message",
        message: { role: "teammate", text: "Done" },
      };
      yield {
        ...identity,
        at,
        type: "result",
        result: {
          summary: "Done",
          decisions: [],
          changes: [],
          unresolved: [],
          findings: [],
          references: [],
          artifacts: [],
        },
      };
      yield { ...identity, at, type: "execution.completed" };
    },
  };
}

// Dogfood, 2026-11-08: a work Session's Task was running when the Control Plane and its Worker
// Host were both killed. On restart the Task failed as uncertain and blocked its Session; the
// Worker then confirmed the Attempt had stopped, but nothing ever released the Session, so its
// next turn stayed pending forever and the inbox kept asking for a recovery that was refused.
for (const dialect of ["sqlite", "postgresql"] as const)
  for (const recovery of ["worker-confirms", "operator-recovers", "cancellation-cleanup"] as const)
    it.skipIf(dialect === "postgresql" && !postgres)(
      `${dialect}: once execution is confirmed stopped (${recovery}), the uncertain Task stays failed and its Session's later turns run`,
      async () => {
        const state = await mkdtemp(join(tmpdir(), "supertag-uncertain-release-"));
        cleanups.push(() => rm(state, { recursive: true, force: true }));
        const isolated =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(postgres as string)
            : undefined;
        if (isolated) cleanups.push(() => isolated.cleanup());
        const url = isolated?.url ?? `file:${join(state, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const journalPath = join(state, "hosts", "laptop", "attempt-journal");
        const worker = {
          cleanupVerifiable: false,
          executions: [] as string[],
          ...(recovery === "cancellation-cleanup" ? { cancel: true } : {}),
        };
        /** One Control Plane and its Worker Host; both stop together, as after kill -9. */
        const start = async () => {
          const durable = new DurableLocalWorklet(
            firstAttemptUncertainWorklet(worker),
            new FileAttemptJournal(journalPath),
          );
          const controlPlane = new ControlPlane({
            store,
            credentialVault: new FileGatewayCredentialVault(join(state, "vault.json")),
            worklet: durable,
            reply: async () => ({ externalMessageId: randomUUID() }),
            dispatch: { pollIntervalMs: 10, retryBaseMs: 10, maxAttempts: 3 },
          });
          await controlPlane.start();
          let stopped = false;
          const stop = async () => {
            if (stopped) return;
            stopped = true;
            await controlPlane.stop();
            await durable.close();
          };
          cleanups.push(stop);
          return { controlPlane, stop };
        };
        let running = await start();

        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        await store.bindTagWorkerHost(owner.id, "uncertain-host");
        const session = await startObjectiveSession({
          store,
          controlPlane: running.controlPlane,
          ownerTagId: owner.id,
          objective: { outcome: "Release a stopped Session" },
        });
        const firstTask = await store.findTaskById(session.startTaskId);
        const firstEventId = firstTask?.inboundEventId as string;
        if (recovery === "cancellation-cleanup") {
          await expect
            .poll(
              async () =>
                (await store.listTaskEvents(session.startTaskId)).some(
                  (event) => event.type === "execution.started",
                ),
              { timeout: 15_000 },
            )
            .toBe(true);
          await running.controlPlane.requestTaskCancellation(session.startTaskId);
        }
        await expect
          .poll(async () => (await store.findInboundEventById(firstEventId))?.sessionBlocked, {
            timeout: 15_000,
          })
          .toBe(true);
        const attemptId = (await store.listTaskAttempts(session.startTaskId))[0]?.id as string;

        // A later turn of the same Session waits while the execution may still be running.
        const later = await running.controlPlane.messageObjective({
          objectiveId: session.objective.id,
          text: "Carry on with the next step",
          operatorId: "operator",
          idempotencyKey: randomUUID(),
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect((await store.findTaskById(later.taskId))?.status).toBe("pending");
        expect(await store.listTaskAttempts(later.taskId)).toHaveLength(0);
        const blockedInbox = await store.readCoordinationInbox({
          objectiveId: session.objective.id,
        });
        expect(
          blockedInbox.items.some((item) => item.uncertainAttempt?.attemptId === attemptId),
        ).toBe(true);

        if (recovery !== "cancellation-cleanup") {
          // Both stop at once; the Worker Host comes back with its journal.
          await running.stop();
          if (recovery === "worker-confirms") worker.cleanupVerifiable = true;
          else {
            // What `supertag recover worklet --confirm-stopped` records, with the host stopped.
            const journal = new FileAttemptJournal(journalPath);
            await journal.initialize();
            journal.confirmStopped(attemptId, session.startTaskId, "Verified nothing still runs");
            await journal.close();
          }
          running = await start();
        }

        // The Worker's terminal receipt releases the Session: the later turn runs.
        await expect
          .poll(async () => (await store.findTaskById(later.taskId))?.status, {
            timeout: 30_000,
          })
          .toBe("completed");
        const released = await store.findInboundEventById(firstEventId);
        expect(released?.sessionBlocked).toBe(false);
        // The uncertain Task stays as it settled and is never replayed.
        expect((await store.findTaskById(session.startTaskId))?.status).toBe(
          recovery === "cancellation-cleanup" ? "cancelled" : "failed",
        );
        expect(await store.listTaskAttempts(session.startTaskId)).toHaveLength(1);
        expect(worker.executions.filter((entry) => entry === "first")).toHaveLength(1);
        expect(worker.executions).not.toContain(session.startTaskId);
        // Describe shows the cleanup evidence, and the inbox no longer asks for a recovery.
        const placement = (await running.controlPlane.inspectTaskExecution(session.startTaskId))
          .placement;
        expect(placement.cleanup).toBe("confirmed");
        const inbox = await store.readCoordinationInbox({ objectiveId: session.objective.id });
        expect(inbox.items.some((item) => item.uncertainAttempt?.attemptId === attemptId)).toBe(
          false,
        );
      },
      90_000,
    );

// Review of the fix above: the release sweep read the oldest blocked turns first, so 20 that could
// never be released hid every later one. Only an Attempt's own cleanup releases its Session, so
// other block reasons keep wording that promises nothing, and a removed ephemeral Worker Host
// counts as evidence that its Attempt stopped.
it("releases a stopped Session behind 20 that stay blocked, and leaves other block reasons alone", async () => {
  const state = await mkdtemp(join(tmpdir(), "supertag-uncertain-sweep-"));
  cleanups.push(() => rm(state, { recursive: true, force: true }));
  const file = join(state, "state.db");
  const url = `file:${file}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  cleanups.push(() => store.disconnect());
  const worker: Parameters<typeof firstAttemptUncertainWorklet>[0] = {
    cleanupVerifiable: false,
    executions: [],
    cancel: true,
  };
  const durable = new DurableLocalWorklet(
    firstAttemptUncertainWorklet(worker),
    new FileAttemptJournal(join(state, "hosts", "laptop", "attempt-journal")),
  );
  cleanups.push(() => durable.close());
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(state, "vault.json")),
    worklet: durable,
    reply: async () => ({ externalMessageId: randomUUID() }),
    dispatch: { pollIntervalMs: 10, retryBaseMs: 10, maxAttempts: 3 },
  });
  await controlPlane.start();
  cleanups.push(() => controlPlane.stop());
  const others = await store.createTag({ name: `others-${randomUUID()}` });
  const owner = await store.createTag({ name: `owner-${randomUUID()}` });
  for (const tag of [others, owner]) await store.bindTagWorkerHost(tag.id, "uncertain-host");
  worker.uncertainTagId = owner.id;

  // Settled turns of other Sessions, blocked afterwards.
  const settled = [];
  for (let index = 0; index < 22; index += 1)
    settled.push(
      await startObjectiveSession({
        store,
        controlPlane,
        ownerTagId: others.id,
        objective: { outcome: `Settled ${index}` },
      }),
    );
  for (const session of settled)
    await expect
      .poll(async () => (await store.findTaskById(session.startTaskId))?.status, {
        timeout: 20_000,
      })
      .toBe("completed");
  const [ephemeralTurn, otherReasonTurn, ...stuck] = await Promise.all(
    settled.map(async (session) => {
      const task = await store.findTaskById(session.startTaskId);
      const [attempt] = await store.listTaskAttempts(session.startTaskId);
      return {
        session,
        taskId: session.startTaskId,
        eventId: task?.inboundEventId as string,
        attemptId: attempt?.id as string,
      };
    }),
  );
  if (!ephemeralTurn || !otherReasonTurn) throw new Error("Missing settled turns");
  // An ephemeral Worker Host that was removed after its reconnect grace.
  const { secret } = await controlPlane.createAuthKey({
    name: `ci-${randomUUID().slice(0, 8)}`,
    tags: [others.name],
    reusable: false,
    ephemeral: true,
  });
  const ephemeralHost = (await controlPlane.redeemAuthKey(secret, "ci-runner")).workerHost;
  await controlPlane.revokeWorkerHostCredential(ephemeralHost.id, "EphemeralDisconnected");
  // Twenty Attempts ran on a Worker Host that is gone, so nothing can release their Sessions.
  const db = new Database(file);
  const moveAttempt = db.prepare(
    `update "TaskAttempt" set "workerSnapshot" = json_set("workerSnapshot", '$.workerHostId', ?) where "id" = ?`,
  );
  moveAttempt.run(ephemeralHost.id, ephemeralTurn.attemptId);
  for (const turn of stuck) moveAttempt.run("decommissioned-host", turn.attemptId);
  db.close();
  for (const turn of [ephemeralTurn, ...stuck])
    await store.blockInboundSession(turn.eventId, EXECUTION_UNCONFIRMED_BLOCK_REASON);
  // A block whose Attempt stopping does not resolve it.
  await store.blockInboundSession(otherReasonTurn.eventId, "Control delivery outcome unknown");
  expect(
    await store.releaseInboundSession({
      inboundEventId: otherReasonTurn.eventId,
      attemptId: otherReasonTurn.attemptId,
    }),
  ).toBe(false);
  const blockedPage = await store.listBlockedSessionAttempts({ limit: 100 });
  expect(blockedPage.map((row) => row.inboundEventId)).not.toContain(otherReasonTurn.eventId);
  expect(blockedPage).toHaveLength(21);
  const ids = blockedPage.map((row) => row.inboundEventId);
  expect(ids).toEqual(ids.toSorted());
  expect(
    (await store.listBlockedSessionAttempts({ after: ids[9] as string, limit: 100 })).map(
      (row) => row.inboundEventId,
    ),
  ).toEqual(ids.slice(10));

  // The Session that can be released is blocked after all of them.
  const session = await startObjectiveSession({
    store,
    controlPlane,
    ownerTagId: owner.id,
    objective: { outcome: "Release a stopped Session behind stuck ones" },
  });
  await expect
    .poll(
      async () =>
        (await store.listTaskEvents(session.startTaskId)).some(
          (event) => event.type === "execution.started",
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await controlPlane.requestTaskCancellation(session.startTaskId);
  const firstEventId = (await store.findTaskById(session.startTaskId))?.inboundEventId as string;
  await expect
    .poll(async () => (await store.findInboundEventById(firstEventId))?.sessionBlocked, {
      timeout: 15_000,
    })
    .toBe(true);
  const later = await controlPlane.messageObjective({
    objectiveId: session.objective.id,
    text: "Carry on with the next step",
    operatorId: "operator",
    idempotencyKey: randomUUID(),
  });
  await expect
    .poll(async () => (await store.findTaskById(later.taskId))?.status, { timeout: 60_000 })
    .toBe("completed");
  expect((await store.findTaskById(session.startTaskId))?.status).toBe("cancelled");
  expect(await store.listTaskAttempts(session.startTaskId)).toHaveLength(1);

  // The removed ephemeral host released its Session, with that evidence recorded.
  await expect
    .poll(async () => (await store.findInboundEventById(ephemeralTurn.eventId))?.sessionBlocked, {
      timeout: 30_000,
    })
    .toBe(false);
  expect(
    (await store.listTaskEvents(ephemeralTurn.taskId)).find(
      (event) => event.type === "task.worker-host-removed",
    )?.payload,
  ).toMatchObject({ workerHostId: ephemeralHost.id, requeued: false });
  for (const turn of [otherReasonTurn, ...stuck])
    expect((await store.findInboundEventById(turn.eventId))?.sessionBlocked).toBe(true);

  // Only the Attempt-cleanup reasons promise that the Session resumes.
  const inbox = await store.readCoordinationInbox({
    objectiveId: otherReasonTurn.session.objective.id,
  });
  const item = inbox.items.find((entry) => entry.kind === "task_attention");
  expect(item?.reason).toContain("Control delivery outcome unknown");
  expect(item?.reason).not.toContain("resumes");
  expect(item?.reason).not.toContain("recover command");
  const stuckInbox = await store.readCoordinationInbox({
    objectiveId: stuck[0]?.session.objective.id as string,
  });
  expect(stuckInbox.items.find((entry) => entry.kind === "task_attention")?.reason).toContain(
    "The Session resumes once its Worker Host records that the Attempt stopped",
  );
}, 120_000);
