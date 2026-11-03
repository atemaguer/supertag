import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlane,
  EPHEMERAL_WORKER_HOST_GRACE_MS,
  EPHEMERAL_WORKER_HOST_JOIN_TIMEOUT_MS,
} from "../packages/control-plane/src/index.ts";
import { emptyTagContextPlan, type InboundSurfaceEvent } from "../packages/core/src/index.ts";
import type {
  AttemptReceipt,
  TaskAttemptSpec,
  Worklet,
  WorkletDescriptor,
} from "../packages/runtime/sdk/src/index.ts";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const PostgresqlPool = createRequire(new URL("../packages/store/package.json", import.meta.url))(
  "pg",
).Pool as new (options: {
  connectionString: string;
  max: number;
}) => { query(text: string, values?: unknown[]): Promise<unknown>; end(): Promise<void> };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(dialect: "sqlite" | "postgresql", worklet?: Worklet) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-ephemeral-host-"));
  const isolated =
    dialect === "postgresql" && postgres
      ? await createIsolatedPostgresDatabase(postgres)
      : undefined;
  const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    ...(worklet === undefined ? {} : { worklet, reply: async () => {} }),
    dispatch: { pollIntervalMs: 5, retryBaseMs: 5, maxAttempts: 3, leaseDurationMs: 5_000 },
  });
  await controlPlane.start();
  cleanups.push(async () => {
    await controlPlane.stop();
    await isolated?.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  const sql = async (text: string, values: unknown[]) => {
    if (dialect === "sqlite") {
      const database = new Database(join(directory, "state.db"));
      try {
        database.prepare(text.replaceAll(/\$\d+/gu, "?")).run(...values);
      } finally {
        database.close();
      }
      return;
    }
    const pool = new PostgresqlPool({ connectionString: url, max: 1 });
    try {
      await pool.query(text, values);
    } finally {
      await pool.end();
    }
  };
  return { store, controlPlane, sql };
}

async function joinHost(
  controlPlane: ControlPlane,
  store: DrizzleStore,
  input: { key: string; host: string; ephemeral: boolean; tag?: string },
) {
  const tag =
    (await store.findTagByName(input.tag ?? "builder")) ??
    (await store.createTag({ name: input.tag ?? "builder" }));
  const existing = await controlPlane.findAuthKey(input.key);
  const secret = existing
    ? undefined
    : (
        await controlPlane.createAuthKey({
          name: input.key,
          tags: [tag.name],
          reusable: true,
          ephemeral: input.ephemeral,
        })
      ).secret;
  if (!secret) throw new Error("Use a new key name per join in these tests");
  const joined = await controlPlane.redeemAuthKey(secret, input.host);
  return { tag, host: joined.workerHost };
}

async function connectAndDrop(store: DrizzleStore, workerHostId: string, disconnectedAt: string) {
  const claimed = await store.claimWorkerHostConnection({
    workerHostId,
    credentialRevision: 1,
    workletId: `${workerHostId}-worklet`,
    protocolVersion: 13,
    workerSnapshot: { id: workerHostId, workers: [] },
    capacity: 1,
    availableSlots: 1,
    activeAttempts: 0,
    ready: true,
    observedAt: new Date(Date.parse(disconnectedAt) - 1000).toISOString(),
  });
  if (!claimed) throw new Error("Connection claim failed");
  await store.releaseWorkerHostConnection({
    workerHostId,
    connectionGeneration: claimed.connectionGeneration,
    disconnectedAt,
  });
}

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} ephemeral Worker Hosts`,
    () => {
      it("removes disconnected ephemeral hosts after the grace period and keeps persistent ones", async () => {
        const { store, controlPlane } = await fixture(dialect);
        const { tag } = await joinHost(controlPlane, store, {
          key: "ci-1",
          host: "runner",
          ephemeral: true,
        });
        await joinHost(controlPlane, store, { key: "ci-2", host: "idle", ephemeral: true });
        await joinHost(controlPlane, store, { key: "laptop", host: "laptop", ephemeral: false });
        const disconnectedAt = new Date().toISOString();
        await connectAndDrop(store, "runner", disconnectedAt);
        await connectAndDrop(store, "laptop", disconnectedAt);
        const now = Date.parse(disconnectedAt);

        // Within the grace period a host may still reconnect.
        expect(
          await controlPlane.sweepEphemeralWorkerHosts(now + EPHEMERAL_WORKER_HOST_GRACE_MS - 1),
        ).toEqual([]);
        expect(
          await controlPlane.sweepEphemeralWorkerHosts(now + EPHEMERAL_WORKER_HOST_GRACE_MS),
        ).toEqual(["runner"]);
        expect(await store.findWorkerHostById("runner")).toMatchObject({
          enrollmentStatus: "revoked",
          revocationReason: "EphemeralDisconnected",
          ephemeral: true,
        });
        // Removal unbinds the host from its Tags.
        expect((await store.listTagWorkerHostBindings(tag.id)).map((b) => b.workerHostId)).toEqual([
          "idle",
          "laptop",
        ]);
        // A host that joined but never connected gets a longer join window.
        expect(
          await controlPlane.sweepEphemeralWorkerHosts(
            Date.now() + EPHEMERAL_WORKER_HOST_JOIN_TIMEOUT_MS + 1000,
          ),
        ).toEqual(["idle"]);
        expect((await store.findWorkerHostById("laptop"))?.enrollmentStatus).toBe("active");
        // A removed host cannot authenticate again.
        expect(
          await controlPlane.authenticateWorkerHostCredential("runner", "anything"),
        ).toBeUndefined();
      });

      it("requeues an Objective Task whose ephemeral host was removed, but not a persistent host's", async () => {
        const worklet = idleWorklet();
        const { store, controlPlane, sql } = await fixture(dialect, worklet);
        // Requeue and its audit event are separate writes. Hold the latter to exercise the
        // same ordering PostgreSQL exposes when several suites compete for the database.
        let releaseEvent = () => {};
        const eventGate = new Promise<void>((resolve) => {
          releaseEvent = resolve;
        });
        const append = store.appendTaskEvent.bind(store);
        const delayedEvent = vi
          .spyOn(store, "appendTaskEvent")
          .mockImplementation(async (input) => {
            if (input.type === "task.worker-host-removed") await eventGate;
            return append(input);
          });
        cleanups.push(async () => {
          releaseEvent();
          delayedEvent.mockRestore();
        });
        controlPlane.objectives.activateCoordination({ url: "http://127.0.0.1:9" });
        await joinHost(controlPlane, store, { key: "ci", host: "runner", ephemeral: true });
        await joinHost(controlPlane, store, { key: "laptop", host: "laptop", ephemeral: false });
        const lost = await runningAssignment(store, "runner");
        const kept = await runningAssignment(store, "laptop");
        for (const taskId of [lost.taskId, kept.taskId])
          await sql(`UPDATE "TaskAssignment" SET "leaseExpiresAt" = $1 WHERE "taskId" = $2`, [
            new Date(Date.now() - 1000).toISOString(),
            taskId,
          ]);
        const disconnectedAt = new Date(
          Date.now() - EPHEMERAL_WORKER_HOST_GRACE_MS - 1000,
        ).toISOString();
        await connectAndDrop(store, "runner", disconnectedAt);
        await connectAndDrop(store, "laptop", disconnectedAt);

        await expect
          .poll(async () => (await store.getTaskAssignment(lost.taskId))?.status, { timeout: 5000 })
          .toBe("queued");
        setImmediate(releaseEvent);
        const attempts = await store.listTaskAttempts(lost.taskId);
        expect(attempts[0]).toMatchObject({
          status: "failed",
          outcome: { workerHostRemoved: "runner" },
        });
        await expect
          .poll(async () => (await store.listTaskEvents(lost.taskId)).map((event) => event.type), {
            timeout: 5000,
          })
          .toContain("task.worker-host-removed");
        expect((await store.findWorkerHostById("runner"))?.enrollmentStatus).toBe("revoked");
        // Persistent hosts keep the stricter evidence rule: unknown execution stays reserved.
        expect((await store.getTaskAssignment(kept.taskId))?.status).toBe("running");
        expect((await store.listTaskAttempts(kept.taskId))[0]?.status).toBe("running");
      });
    },
  );

describe("surface Tasks on ephemeral Worker Hosts", () => {
  for (const ephemeral of [true, false])
    it(
      ephemeral
        ? "retries an interrupted Attempt elsewhere after its ephemeral host is removed"
        : "keeps the evidence rule for an interrupted Attempt on a persistent host",
      async () => {
        const worklet = switchingDurableWorklet(["runner", "laptop"]);
        const { store, controlPlane } = await fixture("sqlite", worklet);
        const { tag } = await joinHost(controlPlane, store, {
          key: "ci",
          host: "runner",
          ephemeral,
        });
        await store.bindTagWorkerHost(tag.id, "laptop");
        const account = await controlPlane.setupSurfaceAccount({
          provider: "slack",
          externalAccountId: "T-EPHEMERAL",
          displayName: "Ephemeral",
          authMethod: "slack-socket-mode",
          configuration: { transport: "socket" },
          secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
        });
        await store.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: account.id,
          scope: "channel:C1",
        });
        const admission = await controlPlane.ingestSurfaceEvent(slackEvent());
        const taskId = admission.taskId;
        if (!taskId) throw new Error("Expected a Task");
        await expect
          .poll(async () => (await store.findTaskById(taskId))?.status, { timeout: 5000 })
          .toBe("failed");
        const attempts = (await store.listTaskAttempts(taskId)).toSorted(
          (a, b) => a.attemptNumber - b.attemptNumber,
        );
        if (ephemeral) {
          // The first Attempt counted as stopped; the retry ran on the other host.
          expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
          expect(worklet.accepted).toEqual(["runner", "laptop"]);
          expect(await store.findWorkerHostById("runner")).toMatchObject({
            enrollmentStatus: "revoked",
            revocationReason: "EphemeralDisconnected",
          });
        } else {
          expect(attempts).toHaveLength(1);
          expect(worklet.accepted).toEqual(["runner"]);
          expect((await store.findWorkerHostById("runner"))?.enrollmentStatus).toBe("active");
        }
      },
    );
});

async function runningAssignment(store: DrizzleStore, workerHostId: string) {
  const id = randomUUID();
  const owner = await store.createTag({ name: `owner-${id}` });
  await store.createObjective({ id, ownerTagId: owner.id, outcome: "Keep builds green." });
  await store.createTeam({
    id,
    objectiveId: id,
    leadTagId: owner.id,
    memberTagIds: [],
    maxConcurrency: 1,
    name: id,
  });
  const at = new Date().toISOString();
  await store.admitTaskAssignment({
    taskId: id,
    objectiveId: id,
    teamId: id,
    requestedByTagId: owner.id,
    assignedTagId: owner.id,
    instruction: "Build the release",
    acceptanceCriteria: ["Release built"],
    execution: {},
    authorizationSnapshot: {
      version: 4,
      capturedAt: at,
      tag: { id: owner.id, name: owner.name },
      origin: { kind: "internal", objectiveId: id, requestedByTagId: owner.id },
      requester: { id: owner.id, kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    contextPlan: emptyTagContextPlan(at),
    workspacePlan: { version: 1, status: "none" },
  });
  const claimed = await store.claimTaskAssignment({
    taskId: id,
    leaseOwner: "lost-control-plane",
    leaseSeconds: 5,
  });
  if (!claimed) throw new Error("Missing claim");
  await store.createTaskAttempt({
    workerProfile: { id: "default", revision: "1" },
    taskId: id,
    attemptNumber: claimed.attemptCount,
    workerSnapshot: {
      durableExecution: true,
      kind: "assignment",
      placement: { workerHostId },
    },
    startedAt: at,
  });
  return claimed;
}

function descriptor(hostId: string): WorkletDescriptor {
  return {
    id: "test-worklet",
    protocolVersion: 1,
    host: {
      id: hostId,
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
  };
}

/** A Worklet with no Workers; nothing it is offered can run. */
function idleWorklet(): Worklet {
  return {
    id: "idle-worklet",
    describe: async () => ({
      id: "idle-worklet",
      protocolVersion: 1,
      host: { id: "idle", workers: [] },
    }),
    execute: () => {
      throw new Error("No Workers");
    },
  };
}

/**
 * A durable Worklet that places each Attempt on the next host in `hosts` and never learns the
 * outcome, like a host that vanished mid-execution.
 */
function switchingDurableWorklet(hosts: readonly string[]) {
  const accepted: string[] = [];
  let current = 0;
  const unknown = (spec: Pick<TaskAttemptSpec, "attemptId" | "taskId">): AttemptReceipt => ({
    attemptId: spec.attemptId,
    taskId: spec.taskId,
    specDigest: "unknown",
    status: "unknown",
  });
  return {
    accepted,
    id: "test-worklet",
    describe: async () => descriptor(hosts[Math.min(current, hosts.length - 1)] ?? "none"),
    execute: () => {
      throw new Error("Durable execution only");
    },
    async accept(spec: TaskAttemptSpec) {
      accepted.push(hosts[Math.min(current, hosts.length - 1)] ?? "none");
      current += 1;
      return unknown(spec);
    },
    async inspect() {
      return undefined;
    },
    async *events() {},
    async cancel(attemptId: string) {
      return { ...unknown({ attemptId, taskId: "" }), lastSequence: 0 };
    },
  } satisfies Worklet & Record<string, unknown>;
}

function slackEvent(): InboundSurfaceEvent {
  return {
    eventId: `delivery-${randomUUID()}`,
    logicalEventId: `message:T-EPHEMERAL:C1:${randomUUID()}`,
    provider: "slack",
    externalAccountId: "T-EPHEMERAL",
    kind: "mention",
    scope: "channel:C1",
    sessionKey: "slack:T-EPHEMERAL:C1:1.000",
    actor: { id: "U1", kind: "user" },
    text: "<@U_APP> build the release",
    occurredAt: "2026-09-30T00:00:00.000Z",
    callback: {
      provider: "slack",
      mode: "slack_thread",
      threadKey: "T-EPHEMERAL|C1|1.000",
      target: { channelId: "C1", threadTs: "1.000" },
    },
    source: { workspaceId: "T-EPHEMERAL", channelId: "C1", messageTs: "1.000", threadTs: "1.000" },
    metadata: { slackEventType: "app_mention" },
  };
}
