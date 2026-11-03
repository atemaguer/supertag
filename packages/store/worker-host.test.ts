import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimWorkerHostConnectionInput } from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Worker Host state`, () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-worker-host-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      let url = `file:${join(directory, "store.db")}`;
      if (dialect === "postgresql") {
        const isolated = await createIsolatedPostgresDatabase(postgres as string);
        url = isolated.url;
        cleanups.push(isolated.cleanup);
      }
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      const other = new DrizzleStore({ url });
      await store.connect();
      await other.connect();
      cleanups.push(
        () => other.disconnect(),
        () => store.disconnect(),
      );
      return { url, store, other };
    }

    const at = (second: number) => `2030-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`;
    const observation = (
      workerHostId: string,
      credentialRevision: number,
      second: number,
    ): ClaimWorkerHostConnectionInput => ({
      workerHostId,
      credentialRevision,
      workletId: `${workerHostId}-worklet`,
      protocolVersion: 13,
      durableProtocolVersion: 1,
      controlProtocolVersion: 1,
      workerSnapshot: {
        workers: [{ id: "research", maxConcurrency: 3, capabilities: ["web"] }],
      },
      capacity: 3,
      availableSlots: 2,
      activeAttempts: 1,
      ready: true,
      observedAt: at(second),
    });

    it("persists enrollment and the latest observed state across restart", async () => {
      const { url, store } = await fixture();
      expect(
        await store.enrollWorkerHost({
          id: "research-host",
          credentialId: "worker-host/research/1",
          enrolledAt: at(1),
        }),
      ).toMatchObject({
        id: "research-host",
        credentialId: "worker-host/research/1",
        credentialRevision: 1,
        enrollmentStatus: "active",
        connectionGeneration: 0,
        connectionStatus: "disconnected",
      });
      const connected = await store.claimWorkerHostConnection(observation("research-host", 1, 2));
      expect(connected).toMatchObject({
        connectionGeneration: 1,
        connectionStatus: "connected",
        protocolVersion: 13,
        capacity: 3,
        availableSlots: 2,
        activeAttempts: 1,
        ready: true,
        lastSeenAt: at(2),
      });

      await store.disconnect();
      const restarted = new DrizzleStore({ url });
      await restarted.connect();
      try {
        expect(await restarted.findWorkerHostById("research-host")).toEqual(connected);
        expect(await restarted.listWorkerHosts()).toEqual([connected]);
      } finally {
        await restarted.disconnect();
      }
    });

    it("atomically fences stale connection generations", async () => {
      const { store, other } = await fixture();
      await store.enrollWorkerHost({
        id: "build-host",
        credentialId: "worker-host/build/1",
        enrolledAt: at(1),
      });
      const first = await store.claimWorkerHostConnection(observation("build-host", 1, 2));
      const second = await other.claimWorkerHostConnection(observation("build-host", 1, 3));
      expect(first?.connectionGeneration).toBe(1);
      expect(second?.connectionGeneration).toBe(2);

      await expect(
        store.updateWorkerHostObservation({
          ...observation("build-host", 1, 4),
          connectionGeneration: 1,
          availableSlots: 0,
          ready: false,
        }),
      ).resolves.toBeUndefined();
      await expect(
        store.releaseWorkerHostConnection({
          workerHostId: "build-host",
          connectionGeneration: 1,
          disconnectedAt: at(4),
        }),
      ).resolves.toBe(false);
      await expect(
        other.updateWorkerHostObservation({
          ...observation("build-host", 1, 5),
          connectionGeneration: 2,
          availableSlots: 0,
          ready: false,
        }),
      ).resolves.toEqual({ draining: false });
      await expect(
        other.releaseWorkerHostConnection({
          workerHostId: "build-host",
          connectionGeneration: 2,
          disconnectedAt: at(6),
        }),
      ).resolves.toBe(true);
      expect(await store.findWorkerHostById("build-host")).toMatchObject({
        connectionGeneration: 2,
        connectionStatus: "disconnected",
        ready: false,
        draining: false,
        lastSeenAt: at(5),
        disconnectedAt: at(6),
      });
    });

    it("persists successful and rejected authentication evidence", async () => {
      const { store } = await fixture();
      await store.enrollWorkerHost({
        id: "audited-host",
        credentialId: "worker-host/audited/1",
        enrolledAt: at(1),
      });
      await expect(
        store.recordWorkerHostAuthenticationFailure("audited-host", at(2)),
      ).resolves.toBe(true);
      await expect(
        store.recordWorkerHostAuthenticationFailure("audited-host", at(3)),
      ).resolves.toBe(true);
      await expect(
        store.claimWorkerHostConnection(observation("audited-host", 1, 4)),
      ).resolves.toMatchObject({
        lastAuthenticatedAt: at(4),
        failedAuthenticationCount: 2,
        lastAuthenticationFailureAt: at(3),
      });
      await store.revokeWorkerHost({ workerHostId: "audited-host", revokedAt: at(5) });
      await expect(
        store.recordWorkerHostAuthenticationFailure("audited-host", at(6)),
      ).resolves.toBe(false);
    });

    it("rotates credentials with revision CAS and never permits credential reuse", async () => {
      const { store, other } = await fixture();
      await store.enrollWorkerHost({
        id: "secure-host",
        credentialId: "worker-host/secure/1",
        enrolledAt: at(1),
      });
      const connected = await store.claimWorkerHostConnection(observation("secure-host", 1, 2));
      const [winner, stale] = await Promise.all([
        store.rotateWorkerHostCredential({
          workerHostId: "secure-host",
          expectedCredentialRevision: 1,
          credentialId: "worker-host/secure/2",
          rotatedAt: at(3),
        }),
        other.rotateWorkerHostCredential({
          workerHostId: "secure-host",
          expectedCredentialRevision: 1,
          credentialId: "worker-host/secure/stale",
          rotatedAt: at(3),
        }),
      ]);
      expect([winner, stale].filter(Boolean)).toHaveLength(1);
      const current = await store.findWorkerHostById("secure-host");
      expect(current).toMatchObject({
        credentialRevision: 2,
        connectionGeneration: (connected?.connectionGeneration ?? 0) + 1,
        connectionStatus: "disconnected",
        ready: false,
      });
      await expect(
        store.claimWorkerHostConnection(observation("secure-host", 1, 4)),
      ).resolves.toBeUndefined();
      await expect(
        store.claimWorkerHostConnection(observation("secure-host", 2, 4)),
      ).resolves.toMatchObject({ connectionStatus: "connected" });

      await expect(
        store.rotateWorkerHostCredential({
          workerHostId: "secure-host",
          expectedCredentialRevision: 2,
          credentialId: "worker-host/secure/1",
          rotatedAt: at(5),
        }),
      ).rejects.toThrow();
      expect((await store.findWorkerHostById("secure-host"))?.credentialRevision).toBe(2);
    });

    it("keeps an operator drain across heartbeats and reconnects until explicitly resumed", async () => {
      const { store } = await fixture();
      await store.enrollWorkerHost({
        id: "drain-host",
        credentialId: "worker-host/drain/1",
        enrolledAt: at(1),
      });
      const first = await store.claimWorkerHostConnection(observation("drain-host", 1, 2));
      expect(await store.setWorkerHostDraining("drain-host", true, at(3))).toMatchObject({
        draining: true,
        ready: false,
        availableSlots: 0,
      });
      await expect(
        store.updateWorkerHostObservation({
          ...observation("drain-host", 1, 4),
          connectionGeneration: first?.connectionGeneration ?? 0,
        }),
      ).resolves.toEqual({ draining: true });
      expect(await store.findWorkerHostById("drain-host")).toMatchObject({
        draining: true,
        ready: false,
        availableSlots: 0,
        lastSeenAt: at(4),
      });

      const replacement = await store.claimWorkerHostConnection(observation("drain-host", 1, 5));
      expect(replacement).toMatchObject({ draining: true, ready: false, availableSlots: 0 });
      expect(await store.setWorkerHostDraining("drain-host", false, at(6))).toMatchObject({
        connectionGeneration: replacement?.connectionGeneration,
        connectionStatus: "connected",
        draining: false,
        ready: true,
        availableSlots: 2,
      });
      await expect(
        store.updateWorkerHostObservation({
          ...observation("drain-host", 1, 7),
          connectionGeneration: replacement?.connectionGeneration ?? 0,
        }),
      ).resolves.toEqual({ draining: false });
      expect(await store.findWorkerHostById("drain-host")).toMatchObject({
        draining: false,
        ready: true,
        availableSlots: 2,
      });
      await store.releaseWorkerHostConnection({
        workerHostId: "drain-host",
        connectionGeneration: replacement?.connectionGeneration ?? 0,
        disconnectedAt: at(8),
      });
      expect(await store.setWorkerHostDraining("drain-host", false, at(9))).toMatchObject({
        connectionStatus: "disconnected",
        ready: false,
        availableSlots: 0,
      });
    });

    it("revocation is durable, idempotent, and fences the active connection", async () => {
      const { store } = await fixture();
      await store.enrollWorkerHost({
        id: "revoked-host",
        credentialId: "worker-host/revoked/1",
        enrolledAt: at(1),
      });
      const connection = await store.claimWorkerHostConnection(observation("revoked-host", 1, 2));
      const revoked = await store.revokeWorkerHost({
        workerHostId: "revoked-host",
        revokedAt: at(3),
        reason: "compromised",
      });
      expect(revoked).toMatchObject({
        enrollmentStatus: "revoked",
        connectionStatus: "disconnected",
        connectionGeneration: (connection?.connectionGeneration ?? 0) + 1,
        draining: true,
        ready: false,
        revokedAt: at(3),
        revocationReason: "compromised",
      });
      await expect(
        store.updateWorkerHostObservation({
          ...observation("revoked-host", 1, 4),
          connectionGeneration: connection?.connectionGeneration ?? 0,
        }),
      ).resolves.toBeUndefined();
      await expect(
        store.claimWorkerHostConnection(observation("revoked-host", 1, 4)),
      ).resolves.toBeUndefined();
      await expect(
        store.revokeWorkerHost({ workerHostId: "revoked-host", revokedAt: at(5) }),
      ).resolves.toEqual(revoked);
      await expect(
        store.setWorkerHostDraining("revoked-host", false, at(6)),
      ).resolves.toBeUndefined();
    });
  });
