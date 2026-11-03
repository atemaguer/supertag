import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactVolumeLabel,
  parseVolumeCredentialName,
  parseVolumeSource,
  parseVolumeSpec,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { artifactProducer } from "./support/artifact-producer.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

describe("Volume validation", () => {
  it("parses object-store and Worker Host sources", () => {
    expect(parseVolumeSource("s3://acme-data/datasets/v3/")).toEqual({
      scheme: "s3",
      bucket: "acme-data",
      prefix: "datasets/v3/",
    });
    expect(
      parseVolumeSource("r2://acme.models?endpoint=https://account.r2.cloudflarestorage.com"),
    ).toEqual({
      scheme: "r2",
      bucket: "acme.models",
      endpoint: "https://account.r2.cloudflarestorage.com",
      prefix: "",
    });
    expect(parseVolumeSource("file:///srv/nfs//datasets/")).toEqual({
      scheme: "file",
      path: "/srv/nfs/datasets",
    });
  });

  it.each([
    ["https://acme.s3.amazonaws.com/data", /must start with/],
    ["S3://acme/data", /must start with/],
    ["s3://AKIAEXAMPLE:secret@acme/data", /no credentials/],
    ["s3://acme/data?X-Amz-Signature=abc", /query string/],
    ["s3://acme/data#part", /fragment/],
    ["s3://ab/data", /bucket of 3-63/],
    ["s3://acme//data", /must not start with a slash/],
    ["s3://acme/a/../b", /\.\. segments/],
    ["file://host/srv/data", /file:\/\/\/ABSOLUTE\/PATH/],
    ["file:///srv/../etc", /\.\. segments/],
    ["file:///srv/data\n", /control characters/],
    [`s3://acme/${"a".repeat(1100)}`, /at most 1024/],
  ])("refuses source %s", (source, message) => {
    expect(() => parseVolumeSource(source)).toThrow(message);
  });

  it("requires a credential name for every source, including file sources", () => {
    expect(parseVolumeSpec({ source: "s3://acme-data/x", credential: "acme-data" })).toEqual({
      source: "s3://acme-data/x",
      credential: "acme-data",
    });
    expect(parseVolumeSpec({ source: "file:///srv/data", credential: "srv-data" })).toEqual({
      source: "file:///srv/data",
      credential: "srv-data",
    });
    expect(() =>
      parseVolumeSpec({
        source: "r2://acme-data?endpoint=https://account.r2.cloudflarestorage.com",
      }),
    ).toThrow(/credential is required/);
    expect(() => parseVolumeSpec({ source: "file:///srv/data" })).toThrow(
      /credential is required for a file:\/\/ source/,
    );
    expect(() => parseVolumeSpec({ credential: "acme" })).toThrow(/source is required/);
    expect(() => parseVolumeSpec({ source: "file:///srv", mounts: [] })).toThrow(
      /unknown fields: mounts/,
    );
  });

  it.each([
    "AKIAIOSFODNN7EXAMPLE",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "akiaiosfodnn7example",
    "ghp_abcdefghijklmnop1234",
    "a1b2c3d4e5f6a7b8c9d0e1f2",
    "acme-0123456789abcdef0123",
    "",
    { environment: "AWS_SECRET_ACCESS_KEY" },
  ])("refuses credential %j that is not a plain name", (credential) => {
    expect(() => parseVolumeCredentialName(credential)).toThrow(/credential/);
  });

  it.each(["acme-data", "datasets_ro", "r2-prod", "s3-backup-2026"])(
    "accepts credential name %s",
    (credential) => {
      expect(parseVolumeCredentialName(credential)).toBe(credential);
    },
  );
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Volumes`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-volume-store-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(async () => {
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      });
      return store;
    }

    it("creates, replaces, finds, lists, and deletes Volumes", async () => {
      const store = await fixture();
      const created = await store.applyVolume({
        name: "datasets",
        source: "s3://acme-data/datasets/v3/",
        credential: "acme-data",
      });
      expect(created.created).toBe(true);
      expect(created.volume).toMatchObject({
        name: "datasets",
        source: "s3://acme-data/datasets/v3/",
        credential: "acme-data",
        revision: 1,
      });

      const unchanged = await store.applyVolume({
        name: "datasets",
        source: "s3://acme-data/datasets/v3/",
        credential: "acme-data",
      });
      expect(unchanged).toEqual({ volume: created.volume, created: false });

      // Replacing changes the source and the credential name.
      const replaced = await store.applyVolume({
        name: "datasets",
        source: "file:///srv/datasets",
        credential: "srv-datasets",
      });
      expect(replaced.created).toBe(false);
      expect(replaced.volume.revision).toBe(2);
      expect(replaced.volume.credential).toBe("srv-datasets");
      expect(await store.findVolumeByName("datasets")).toEqual(replaced.volume);

      await store.applyVolume({
        name: "corpus",
        source: "r2://acme-corpus?endpoint=https://account.r2.cloudflarestorage.com",
        credential: "r2",
      });
      expect((await store.listVolumes()).map((volume) => volume.name)).toEqual([
        "corpus",
        "datasets",
      ]);
      expect(await store.findVolumeByName("missing")).toBeUndefined();

      expect(await store.deleteVolume("corpus")).toBe(true);
      expect(await store.deleteVolume("corpus")).toBe(false);
      expect((await store.listVolumes()).map((volume) => volume.name)).toEqual(["datasets"]);
    });

    it.each(["delete", "source"] as const)(
      "refuses %s while artifact copies exist",
      async (operation) => {
        const store = await fixture();
        const spec = {
          name: "artifacts",
          source: "file:///srv/artifacts",
          credential: "artifacts",
        };
        const { volume } = await store.applyVolume(spec);
        const at = new Date().toISOString();
        await store.enrollWorkerHost({
          id: "producer",
          credentialId: "producer-key",
          enrolledAt: at,
        });
        await store.claimWorkerHostConnection({
          workerHostId: "producer",
          credentialRevision: 1,
          workletId: "producer-worklet",
          protocolVersion: 17,
          workerSnapshot: { labels: [artifactVolumeLabel("artifacts")] },
          capacity: 1,
          availableSlots: 1,
          activeAttempts: 0,
          ready: true,
          observedAt: at,
        });
        const attempt = await artifactProducer(store, "producer");
        for (const hex of ["a", "b"]) {
          await store.recordArtifactVolumeCopy({
            volumeId: volume.id,
            source: volume.source,
            workerHostId: "producer",
            key: `attempts/${attempt.id}/sha256/${hex.repeat(64)}`,
            digest: `sha256:${hex.repeat(64)}`,
            sizeBytes: 1,
            observedAt: at,
          });
        }
        const change =
          operation === "delete"
            ? store.deleteVolume(spec.name)
            : store.applyVolume({ ...spec, source: "file:///srv/replacement" });
        await expect(change).rejects.toThrow(/2 artifact copies.*Keep this Volume.*new Volume/);
        expect(await store.findVolumeByName(spec.name)).toEqual(volume);
        expect(
          await store.listArtifactVolumeLocations({
            digest: `sha256:${"a".repeat(64)}`,
            sizeBytes: 1,
          }),
        ).toHaveLength(1);
        expect(await store.applyVolume(spec)).toEqual({ volume, created: false });
        expect(
          (await store.applyVolume({ ...spec, credential: "rotated" })).volume.credential,
        ).toBe("rotated");
        await store.revokeWorkerHost({ workerHostId: "producer", revokedAt: at });
        if (operation === "delete") await expect(store.deleteVolume(spec.name)).resolves.toBe(true);
        else
          await expect(
            store.applyVolume({ ...spec, source: "file:///srv/replacement" }),
          ).resolves.toMatchObject({ volume: { source: "file:///srv/replacement" } });
      },
    );

    it("refuses invalid names and specs before storing", async () => {
      const store = await fixture();
      await expect(store.applyVolume({ name: "Data", source: "file:///srv" })).rejects.toThrow(
        /Volume name/,
      );
      await expect(
        store.applyVolume({
          name: "data",
          source: "s3://acme-data",
          credential: "AKIAIOSFODNN7EXAMPLE",
        }),
      ).rejects.toThrow(/never a secret value/);
      await expect(store.applyVolume({ name: "data", source: "file:///srv" })).rejects.toThrow(
        /credential is required for a file:\/\/ source/,
      );
      expect(await store.listVolumes()).toEqual([]);
    });
  });
}
