import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import { coordinationInboxCommands } from "../packages/core/src/index.js";
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
