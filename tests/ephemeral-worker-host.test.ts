import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlPlane,
  EPHEMERAL_WORKER_HOST_GRACE_MS,
  EPHEMERAL_WORKER_HOST_JOIN_TIMEOUT_MS,
} from "../packages/control-plane/src/index.ts";
import type { InboundSurfaceEvent } from "../packages/core/src/index.ts";
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
  return { store, controlPlane };
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
