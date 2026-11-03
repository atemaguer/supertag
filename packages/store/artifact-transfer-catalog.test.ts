import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimWorkerHostConnectionInput } from "@supertag/core";
import {
  ArtifactCatalogError,
  artifactVolumeLabel,
  MAX_WORKER_ARTIFACT_COPIES,
} from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { artifactProducer } from "../../tests/support/artifact-producer.js";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const hex = (character: string) => character.repeat(64);
// Hosts advertise the Volumes they store artifacts on, as `artifact-volume` makes them.
const artifactVolumes = {
  labels: ["shared-artifacts", "shared"].map((name) => artifactVolumeLabel(name)),
};
const at = (second: number) => `2030-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`;

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Worklet artifact catalog`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];

      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-artifact-locations-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "store.db")}`;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        await store.enrollWorkerHost({
          id: "host-a",
          credentialId: "worker-host/a/1",
          enrolledAt: at(1),
        });
        const connected = await store.claimWorkerHostConnection(observation(1, 2));
        expect(connected?.connectionGeneration).toBe(1);
        return { store, url, attempt: await artifactProducer(store, "host-a") };
      }

      const observation = (
        credentialRevision: number,
        second: number,
      ): ClaimWorkerHostConnectionInput => ({
        workerHostId: "host-a",
        credentialRevision,
        workletId: "worklet-a",
        protocolVersion: 1,
        durableProtocolVersion: 1,
        workerSnapshot: artifactVolumes,
        capacity: 1,
        availableSlots: 1,
        activeAttempts: 0,
        ready: true,
        observedAt: at(second),
      });

      it("persists bounded batches and fences stale revisions and connections", async () => {
        const { store, url } = await fixture();
        await expect(
          store.registerWorkerArtifactCopies({
            workerHostId: "host-a",
            connectionGeneration: 1,
            inventoryRevision: 1,
            transferBaseUrl: "https://host-a.internal:9443",
            copies: [
              { digest: digest("a"), sizeBytes: 12 },
              { digest: digest("b"), sizeBytes: 24 },
            ],
            observedAt: at(3),
          }),
        ).resolves.toEqual({ accepted: true, connectionGeneration: 1, inventoryRevision: 1 });
        await expect(
          store.registerWorkerArtifactCopies({
            workerHostId: "host-a",
            connectionGeneration: 1,
            inventoryRevision: 1,
            transferBaseUrl: "https://stale.invalid",
            copies: [{ digest: digest("a"), sizeBytes: 999 }],
            observedAt: at(4),
          }),
        ).resolves.toEqual({ accepted: false, connectionGeneration: 1, inventoryRevision: 1 });
        await expect(
          store.registerWorkerArtifactCopies({
            workerHostId: "host-a",
            connectionGeneration: 1,
            inventoryRevision: 2,
            transferBaseUrl: "https://host-a.internal:9443",
            copies: [{ digest: digest("a"), sizeBytes: 13 }],
            observedAt: at(4),
          }),
        ).rejects.toMatchObject({ statusCode: 409 });

        await store.disconnect();
        const restarted = new DrizzleStore({ url });
        await restarted.connect();
        cleanups.push(() => restarted.disconnect());
        expect(
          await restarted.listArtifactStorageLocations({
            digest: digest("a"),
            sizeBytes: 12,
            status: "available",
          }),
        ).toEqual([
          expect.objectContaining({
            workerHostId: "host-a",
            transferBaseUrl: "https://host-a.internal:9443",
            connectionGeneration: 1,
            inventoryRevision: 1,
            status: "available",
          }),
        ]);

        const replacement = await restarted.claimWorkerHostConnection(observation(1, 5));
        expect(replacement?.connectionGeneration).toBe(2);
        expect(
          await restarted.listArtifactStorageLocations({
            digest: digest("a"),
            sizeBytes: 12,
            status: "available",
          }),
        ).toEqual([]);
        await expect(
          restarted.registerWorkerArtifactCopies({
            workerHostId: "host-a",
            connectionGeneration: 1,
            inventoryRevision: 2,
            transferBaseUrl: "https://host-a.internal:9443",
            copies: [{ digest: digest("a"), sizeBytes: 12 }],
            observedAt: at(6),
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await restarted.registerWorkerArtifactCopies({
          workerHostId: "host-a",
          connectionGeneration: 2,
          inventoryRevision: 1,
          transferBaseUrl: "https://host-a.internal:9555",
          copies: [{ digest: digest("a"), sizeBytes: 12 }],
          observedAt: at(7),
        });
        expect(
          await restarted.listArtifactStorageLocations({
            digest: digest("a"),
            sizeBytes: 12,
            status: "available",
          }),
        ).toEqual([
          expect.objectContaining({
            transferBaseUrl: "https://host-a.internal:9555",
            connectionGeneration: 2,
          }),
        ]);
      });

      it("refuses a copy written to a stale Volume source without locking the replacement", async () => {
        const { store, attempt } = await fixture();
        const spec = {
          name: "shared-artifacts",
          source: "s3://acme-artifacts/old",
          credential: "artifact-keys",
        };
        const { volume } = await store.applyVolume(spec);
        const copy = {
          volumeId: volume.id,
          source: volume.source,
          key: `attempts/${attempt.id}/sha256/${hex("a")}`,
          digest: digest("a"),
          sizeBytes: 12,
          workerHostId: "host-a",
          observedAt: at(3),
        };
        // The host has written to A, but an operator changes the source before its receipt arrives.
        const replacement = { ...spec, source: "s3://acme-artifacts/new" };
        await store.applyVolume(replacement);
        await expect(store.recordArtifactVolumeCopy(copy)).rejects.toMatchObject({
          statusCode: 409,
        });
        expect(
          await store.listArtifactVolumeLocations({ digest: copy.digest, sizeBytes: 12 }),
        ).toEqual([]);
        expect(await store.listVolumeIdsHoldingArtifacts()).toEqual([]);
        // The failed receipt neither locks B nor claims that the bytes are there.
        await store.applyVolume({ ...spec, source: "s3://acme-artifacts/third" });
        await store.applyVolume(replacement);
        await store.recordArtifactVolumeCopy({ ...copy, source: replacement.source });
        await expect(store.applyVolume(spec)).rejects.toThrow(/artifact copies/);
      });

      it.each(["copy", "source"])(
        "serializes concurrent source changes and copy inserts (%s starts first)",
        async (first) => {
          const { store, attempt } = await fixture();
          const spec = {
            name: "shared-artifacts",
            source: "s3://acme-artifacts/old",
            credential: "artifact-keys",
          };
          const { volume } = await store.applyVolume(spec);
          const copy = {
            volumeId: volume.id,
            source: volume.source,
            key: `attempts/${attempt.id}/sha256/${hex("a")}`,
            digest: digest("a"),
            sizeBytes: 12,
            workerHostId: "host-a",
            observedAt: at(3),
          };
          const record = () => store.recordArtifactVolumeCopy(copy);
          const change = () => store.applyVolume({ ...spec, source: "s3://acme-artifacts/new" });
          const results = await Promise.allSettled(
            first === "copy" ? [record(), change()] : [change(), record()],
          );
          expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          const current = await store.findVolumeByName(spec.name);
          const copies = await store.listArtifactVolumeLocations({
            digest: copy.digest,
            sizeBytes: 12,
          });
          expect(copies).toHaveLength(current?.source === volume.source ? 1 : 0);
        },
      );

      it("records which Volume holds a copy, separately from the host that wrote it", async () => {
        const { store, url, attempt } = await fixture();
        const { volume } = await store.applyVolume({
          name: "shared-artifacts",
          source: "s3://acme-artifacts/supertag",
          credential: "artifact-keys",
        });
        const copy = {
          volumeId: volume.id,
          source: volume.source,
          key: `attempts/${attempt.id}/sha256/${hex("a")}`,
          digest: digest("a"),
          sizeBytes: 12,
          workerHostId: "host-a",
          observedAt: at(3),
        };
        expect(await store.recordArtifactVolumeCopy(copy)).toEqual({
          volumeId: volume.id,
          key: copy.key,
          digest: digest("a"),
          sizeBytes: 12,
          workerHostId: "host-a",
          status: "available",
          observedAt: at(3),
        });
        // Recording the same copy again only refreshes it; one key never names other content.
        await store.recordArtifactVolumeCopy({ ...copy, observedAt: at(4) });
        await expect(
          store.recordArtifactVolumeCopy({ ...copy, sizeBytes: 13 }),
        ).rejects.toMatchObject({ statusCode: 409 });
        // Nor can it name content other than its own digest.
        await expect(
          store.recordArtifactVolumeCopy({ ...copy, digest: digest("b") }),
        ).rejects.toMatchObject({ statusCode: 400 });
        const restarted = new DrizzleStore({ url });
        await restarted.connect();
        cleanups.push(() => restarted.disconnect());
        expect(
          await restarted.listArtifactVolumeLocations({
            digest: digest("a"),
            sizeBytes: 12,
            status: "available",
          }),
        ).toEqual([expect.objectContaining({ volumeId: volume.id, observedAt: at(4) })]);
        // The Volume copy is a location in its own right, not a Worklet transfer endpoint.
        expect(
          await restarted.listArtifactStorageLocations({ digest: digest("a"), sizeBytes: 12 }),
        ).toEqual([]);
        expect(
          await restarted.listArtifactVolumeLocations({ digest: digest("a"), sizeBytes: 13 }),
        ).toEqual([]);
      });

      it("rejects another host claiming an Attempt key and permits independent identical uploads", async () => {
        const { store, attempt } = await fixture();
        await store.enrollWorkerHost({
          id: "host-b",
          credentialId: "worker-host/b/1",
          enrolledAt: at(1),
        });
        await store.claimWorkerHostConnection({
          ...observation(1, 2),
          workerHostId: "host-b",
          workletId: "worklet-b",
        });
        const peer = await artifactProducer(store, "host-b");
        const { volume } = await store.applyVolume({
          name: "shared-artifacts",
          source: "s3://acme-artifacts/supertag",
          credential: "artifact-keys",
        });
        const copy = {
          volumeId: volume.id,
          source: volume.source,
          key: `attempts/${attempt.id}/sha256/${hex("a")}`,
          digest: digest("a"),
          sizeBytes: 12,
          workerHostId: "host-a",
          observedAt: at(3),
        };
        await store.recordArtifactVolumeCopy(copy);
        for (const key of [
          copy.key,
          `attempts/${attempt.id.toUpperCase()}/sha256/${hex("a")}`,
          `attempts/missing/sha256/${hex("a")}`,
        ]) {
          await expect(
            store.recordArtifactVolumeCopy({ ...copy, key, workerHostId: "host-b" }),
          ).rejects.toMatchObject({ statusCode: 403 });
        }
        const peerCopy = {
          ...copy,
          key: `attempts/${peer.id}/sha256/${hex("a")}`,
          workerHostId: "host-b",
        };
        await store.recordArtifactVolumeCopy(peerCopy);
        await store.recordArtifactVolumeCopy({ ...peerCopy, observedAt: at(4) });
        expect(
          await store.listArtifactVolumeLocations({ digest: digest("a"), sizeBytes: 12 }),
        ).toEqual([
          expect.objectContaining({ key: copy.key, workerHostId: "host-a" }),
          expect.objectContaining({ key: peerCopy.key, workerHostId: "host-b" }),
        ]);
        await store.closeTaskAttempt({
          attemptId: attempt.id,
          status: "completed",
          endedAt: at(5),
        });
        await expect(store.recordArtifactVolumeCopy(copy)).rejects.toMatchObject({
          statusCode: 409,
        });
      });

      it("admits one of several concurrent records of different content under one key", async () => {
        const { store, attempt } = await fixture();
        await store.enrollWorkerHost({
          id: "host-b",
          credentialId: "worker-host/b/1",
          enrolledAt: at(1),
        });
        await store.claimWorkerHostConnection({
          ...observation(1, 2),
          workerHostId: "host-b",
          workletId: "worklet-b",
        });
        const { volume } = await store.applyVolume({
          name: "shared-artifacts",
          source: "s3://acme-artifacts/supertag",
          credential: "artifact-keys",
        });
        // One digest's key, claimed with different sizes: only one record can describe it.
        const sizes = [10, 11, 12, 13, 14, 15];
        const results = await Promise.allSettled(
          sizes.map((sizeBytes) =>
            store.recordArtifactVolumeCopy({
              volumeId: volume.id,
              source: volume.source,
              key: `attempts/${attempt.id}/sha256/${hex("a")}`,
              digest: digest("a"),
              sizeBytes,
              workerHostId: "host-a",
              observedAt: at(3),
            }),
          ),
        );
        const admitted = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        expect(admitted).toHaveLength(1);
        for (const result of results)
          if (result.status === "rejected")
            expect(result.reason).toMatchObject({ statusCode: 409 });
        const stored = (
          await Promise.all(
            sizes.map((sizeBytes) =>
              store.listArtifactVolumeLocations({ digest: digest("a"), sizeBytes }),
            ),
          )
        ).flat();
        expect(stored).toEqual([admitted[0]]);
      });

      it("refuses Volume copies with unsafe keys, unknown Volumes, or unenrolled hosts", async () => {
        const { store, attempt } = await fixture();
        const { volume } = await store.applyVolume({
          name: "shared",
          source: "file:///srv/shared",
          credential: "shared",
        });
        const copy = {
          volumeId: volume.id,
          source: volume.source,
          key: `attempts/${attempt.id}/sha256/${hex("c")}`,
          digest: digest("c"),
          sizeBytes: 1,
          workerHostId: "host-a",
          observedAt: at(3),
        };
        for (const key of [
          "",
          "/absolute",
          "a/../b",
          "./a",
          "a//b",
          "a\\b",
          "x".repeat(1025),
          // A key must name this copy's own content.
          "artifacts/one",
          `sha256/${hex("d")}`,
          `sha256/${hex("c")}/extra`,
          `../sha256/${hex("c")}`,
        ])
          await expect(store.recordArtifactVolumeCopy({ ...copy, key })).rejects.toMatchObject({
            statusCode: 400,
          });
        await expect(
          store.recordArtifactVolumeCopy({ ...copy, digest: "sha256:short" }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
          store.recordArtifactVolumeCopy({ ...copy, volumeId: "missing-volume" }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
          store.recordArtifactVolumeCopy({ ...copy, workerHostId: "unknown-host" }),
        ).rejects.toMatchObject({ statusCode: 409 });
        // A host that does not store its artifacts on this Volume cannot record copies there.
        await store.enrollWorkerHost({
          id: "host-c",
          credentialId: "worker-host/c/1",
          enrolledAt: at(1),
        });
        await store.claimWorkerHostConnection({
          ...observation(1, 2),
          workerHostId: "host-c",
          workletId: "worklet-c",
          workerSnapshot: { labels: [artifactVolumeLabel("other")] },
        });
        await expect(
          store.recordArtifactVolumeCopy({ ...copy, workerHostId: "host-c" }),
        ).rejects.toMatchObject({ statusCode: 403 });
        // A Volume with recorded copies cannot be deleted.
        await store.recordArtifactVolumeCopy(copy);
        await expect(store.deleteVolume("shared")).rejects.toThrow(/1 artifact copies/);
        expect(
          await store.listArtifactVolumeLocations({ digest: digest("c"), sizeBytes: 1 }),
        ).toHaveLength(1);
      });

      it("rejects ambiguous or oversized inventory batches", async () => {
        const { store } = await fixture();
        const base = {
          workerHostId: "host-a",
          connectionGeneration: 1,
          inventoryRevision: 1,
          transferBaseUrl: "https://host-a.internal",
          observedAt: at(3),
        };
        await expect(
          store.registerWorkerArtifactCopies({
            ...base,
            copies: [
              { digest: digest("a"), sizeBytes: 1 },
              { digest: digest("a"), sizeBytes: 1 },
            ],
          }),
        ).rejects.toBeInstanceOf(ArtifactCatalogError);
        await expect(
          store.registerWorkerArtifactCopies({
            ...base,
            transferBaseUrl: "https://user:password@host-a.internal",
            copies: [],
          }),
        ).rejects.toBeInstanceOf(ArtifactCatalogError);
        await expect(
          store.registerWorkerArtifactCopies({
            ...base,
            copies: Array.from({ length: MAX_WORKER_ARTIFACT_COPIES + 1 }, (_, index) => ({
              digest: `sha256:${index.toString(16).padStart(64, "0")}`,
              sizeBytes: index,
            })),
          }),
        ).rejects.toBeInstanceOf(ArtifactCatalogError);
      });
    },
  );
