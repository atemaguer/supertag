import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactCatalogError,
  type ArtifactTransferGrantClaims,
  type ArtifactVolumeLocation,
  artifactVolumeLabel,
  type CapturedArtifact,
  type Task,
  type TaskAttempt,
  volumeCredentialLabel,
} from "@supertag/core";
import { describe, expect, it, vi } from "vitest";
import { artifactProducer } from "../../tests/support/artifact-producer.js";
import { DrizzleStore, migrateDatabase } from "../store/src/index.js";
import { ArtifactCatalog } from "./src/artifact-catalog.js";

const digest = `sha256:${"a".repeat(64)}`;
const artifact: CapturedArtifact = {
  id: "artifact-1",
  operationId: "capture-1",
  taskId: "producer-task",
  attemptId: "producer-attempt",
  tagId: "producer",
  sessionId: "session-1",
  title: "Evidence",
  kind: "research",
  inputs: [],
  entries: [
    {
      path: "results/evidence.txt",
      uri: `supertag-artifact:${digest}`,
      digest,
      sizeBytes: 12,
    },
  ],
  createdAt: "2030-01-01T00:00:00.000Z",
};

describe("direct artifact transfer catalog", () => {
  function fixture(snapshot: Record<string, unknown> = {}) {
    const task = {
      id: "consumer-task",
      tagId: "consumer",
      sessionId: "session-1",
      trigger: {
        inputArtifacts: [
          {
            artifactId: artifact.id,
            path: artifact.entries[0]?.path,
            digest,
          },
        ],
      },
      contextPlan: { sets: [] },
    } as unknown as Task;
    const attempt = {
      id: "consumer-attempt",
      taskId: task.id,
      attemptNumber: 1,
      workerSnapshot: {
        workerHostId: "consumer-host",
        connectionGeneration: 7,
        ...snapshot,
      },
      status: "running",
    } as unknown as TaskAttempt;
    const producerAttempt = {
      id: artifact.attemptId,
      taskId: artifact.taskId,
      attemptNumber: 1,
      workerSnapshot: { workerHostId: "producer-host", connectionGeneration: 3 },
      status: "completed",
    } as unknown as TaskAttempt;
    const store = {
      findTaskById: vi.fn(async () => task),
      listTaskAttempts: vi.fn(async (taskId: string) =>
        taskId === artifact.taskId ? [producerAttempt] : [attempt],
      ),
      findCapturedArtifact: vi.fn(async () => artifact),
      getArtifactPublication: vi.fn(),
      getArtifactConsumptionApproval: vi.fn(),
      listArtifactAcquisitions: vi.fn(async () => []),
      findWorkerHostById: vi.fn(async () => ({
        id: "consumer-host",
        enrollmentStatus: "active",
        connectionStatus: "connected",
        connectionGeneration: 7,
        labels: [] as string[],
        workerSnapshot: {},
      })),
      listArtifactVolumeLocations: vi.fn(async (): Promise<ArtifactVolumeLocation[]> => []),
      listVolumes: vi.fn(async () => [
        {
          id: "volume-shared",
          name: "shared",
          source: "s3://team-artifacts/hosts",
          credential: "team-artifacts",
          revision: 1,
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
        {
          id: "volume-private",
          name: "private",
          source: "s3://private-artifacts/hosts",
          credential: "private-artifacts",
          revision: 1,
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
      ]),
      listArtifactStorageLocations: vi.fn(async () => [
        {
          workerHostId: "producer-host",
          connectionGeneration: 3,
          inventoryRevision: 4,
          transferBaseUrl: "https://producer.internal:7443",
          digest,
          sizeBytes: 12,
          status: "available",
          observedAt: "2030-01-01T00:00:01.000Z",
        },
      ]),
    };
    const signed: ArtifactTransferGrantClaims[] = [];
    const catalog = new ArtifactCatalog(
      store as never,
      {
        authenticateExecution: async () => ({
          kind: "surface" as const,
          taskId: task.id,
          attemptId: attempt.id,
        }),
        authorizeArtifactSource: async () => undefined,
        artifactDiscoveryTaskIds: async () => undefined,
      },
      {
        sign(claims) {
          signed.push(claims);
          return `signed-${claims.grantId}`;
        },
        now: () => new Date("2030-01-01T00:00:02.000Z"),
        ttlMs: 30_000,
      },
    );
    return { catalog, signed, store };
  }

  it.each([
    ["127.0.0.1", true, true],
    ["::1", true, true],
    ["::ffff:127.0.0.1", true, true],
    ["::ffff:7f00:1", true, true],
    ["192.0.2.1", true, false],
    [undefined, true, false],
    ["localhost", true, false],
    ["::ffff:0:0", true, false],
    ["127.0.0.1", false, false],
  ])(
    "gates loopback downloads on both socket peers: %s / %s",
    async (operatorAddress, hostLocal, allowed) => {
      const { catalog, store, signed } = fixture();
      const [location] = await store.listArtifactStorageLocations();
      if (!location) throw new Error("fixture");
      store.listArtifactStorageLocations.mockResolvedValue([
        { ...location, transferBaseUrl: "http://127.0.0.1:7443" },
      ]);
      const hostConnectionIsLoopback = vi.fn(() => hostLocal);
      const result = await catalog.resolveOperatorDownload(
        "operator",
        artifact.id,
        {
          path: "results/evidence.txt",
        },
        { operatorAddress, hostConnectionIsLoopback, publicUrl: "http://127.0.0.1:3434" },
      );
      expect(result.locations).toHaveLength(allowed ? 1 : 0);
      expect(signed).toHaveLength(allowed ? 1 : 0);
      if (allowed) expect(hostConnectionIsLoopback).toHaveBeenCalledWith("producer-host", 3);
    },
  );

  it.each([
    ["https://supertag.example", "127.0.0.1", false],
    [undefined, "127.0.0.1", false],
    ["http://localhost:3434", "127.0.0.1", true],
    ["http://[::1]:3434", "[::1]", true],
    ["http://127.0.0.1:3434", "[::7f00:1]", true],
    ["https://supertag.example", "[::7f00:1]", false],
    ["http://127.0.0.1:3434", "sub.localhost", false],
    ["http://127.0.0.1:3434", "localhost.localdomain", false],
    ["http://127.0.0.1:3434", "ip6-loopback", false],
    ["http://127.0.0.1:3434", "localhost.", false],
  ])("checks public URL %s and endpoint %s", async (publicUrl, host, allowed) => {
    const { catalog, store, signed } = fixture();
    const [location] = await store.listArtifactStorageLocations();
    if (!location) throw new Error("fixture");
    store.listArtifactStorageLocations.mockResolvedValue([
      { ...location, transferBaseUrl: `http://${host}:7443` },
    ]);
    const result = await catalog.resolveOperatorDownload(
      "operator",
      artifact.id,
      { path: "results/evidence.txt" },
      { publicUrl, operatorAddress: "127.0.0.1", hostConnectionIsLoopback: () => true },
    );
    expect(result.locations).toHaveLength(allowed ? 1 : 0);
    expect(signed).toHaveLength(allowed ? 1 : 0);
  });

  it.each([
    "localhost",
    "localhost.",
    "sub.localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "localhost4",
    "localhost4.localdomain4",
    "localhost6",
    "localhost6.localdomain6",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "[::ffff:0:0]",
    "[::]",
    "0.0.0.0",
  ])("withholds local endpoint %s without trusted connection evidence", async (host) => {
    const { catalog, store } = fixture();
    const [location] = await store.listArtifactStorageLocations();
    if (!location) throw new Error("fixture");
    store.listArtifactStorageLocations.mockResolvedValue([
      { ...location, transferBaseUrl: `http://${host}:7443` },
    ]);
    expect(
      (
        await catalog.resolveOperatorDownload("operator", artifact.id, {
          path: "results/evidence.txt",
        })
      ).locations,
    ).toEqual([]);
  });

  it.each(["0.0.0.0", "[::]", "[::ffff:0:0]"])(
    "never offers unspecified destination %s even for local peers",
    async (host) => {
      const { catalog, store } = fixture();
      const [location] = await store.listArtifactStorageLocations();
      if (!location) throw new Error("fixture");
      store.listArtifactStorageLocations.mockResolvedValue([
        { ...location, transferBaseUrl: `http://${host}:7443` },
      ]);
      expect(
        (
          await catalog.resolveOperatorDownload(
            "operator",
            artifact.id,
            { path: "results/evidence.txt" },
            {
              publicUrl: "http://127.0.0.1:3434",
              operatorAddress: "127.0.0.1",
              hostConnectionIsLoopback: () => true,
            },
          )
        ).locations,
      ).toEqual([]);
    },
  );

  it("derives the recipient from the exact Attempt and signs metadata-only locations", async () => {
    const { catalog, signed } = fixture();
    const resolved = await catalog.resolveTransfer("attempt-token", {
      artifactId: artifact.id,
      path: "results/evidence.txt",
    });
    expect(resolved).toEqual({
      artifactId: artifact.id,
      path: "results/evidence.txt",
      digest,
      sizeBytes: 12,
      locations: [
        {
          workerHostId: "producer-host",
          transferUrl: `https://producer.internal:7443/v1/artifacts/${"a".repeat(64)}`,
          grant: expect.stringMatching(/^signed-/u),
        },
      ],
      volumes: [],
      holders: { workerHostIds: ["producer-host"], volumes: [] },
      expiresAt: "2030-01-01T00:00:32.000Z",
    });
    expect(signed).toEqual([
      expect.objectContaining({
        version: 1,
        artifactId: artifact.id,
        path: "results/evidence.txt",
        digest,
        sourceWorkerHostId: "producer-host",
        recipientWorkerHostId: "consumer-host",
        recipientConnectionGeneration: 7,
        taskId: "consumer-task",
        attemptId: "consumer-attempt",
        issuedAt: "2030-01-01T00:00:02.000Z",
        expiresAt: "2030-01-01T00:00:32.000Z",
      }),
    ]);
  });

  it("grants only from the host that captured the artifact, not every holder of its digest", async () => {
    const { catalog, signed, store } = fixture();
    // Another Objective's host holds the same digest; knowing a digest grants nothing.
    store.listArtifactStorageLocations.mockResolvedValue([
      {
        workerHostId: "other-objective-host",
        connectionGeneration: 2,
        inventoryRevision: 1,
        transferBaseUrl: "https://other.internal:7443",
        digest,
        sizeBytes: 12,
        status: "available",
        observedAt: "2030-01-01T00:00:00.500Z",
      },
      {
        workerHostId: "producer-host",
        connectionGeneration: 3,
        inventoryRevision: 4,
        transferBaseUrl: "https://producer.internal:7443",
        digest,
        sizeBytes: 12,
        status: "available",
        observedAt: "2030-01-01T00:00:01.000Z",
      },
    ]);
    const resolved = await catalog.resolveTransfer("attempt-token", {
      artifactId: artifact.id,
      path: "results/evidence.txt",
    });
    expect(resolved.locations.map((location) => location.workerHostId)).toEqual(["producer-host"]);
    expect(signed.map((claims) => claims.sourceWorkerHostId)).toEqual(["producer-host"]);

    store.listArtifactStorageLocations.mockResolvedValue([
      {
        workerHostId: "other-objective-host",
        connectionGeneration: 2,
        inventoryRevision: 1,
        transferBaseUrl: "https://other.internal:7443",
        digest,
        sizeBytes: 12,
        status: "available",
        observedAt: "2030-01-01T00:00:00.500Z",
      },
    ]);
    signed.length = 0;
    await expect(
      catalog.resolveTransfer("attempt-token", {
        artifactId: artifact.id,
        path: "results/evidence.txt",
      }),
    ).rejects.toMatchObject<Partial<ArtifactCatalogError>>({ statusCode: 409 });
    expect(signed).toEqual([]);
  });

  it("fails closed without authenticated Attempt placement", async () => {
    const { catalog } = fixture({ workerHostId: undefined, connectionGeneration: undefined });
    await expect(
      catalog.resolveTransfer("attempt-token", {
        artifactId: artifact.id,
        path: "results/evidence.txt",
      }),
    ).rejects.toMatchObject<Partial<ArtifactCatalogError>>({ statusCode: 409 });
  });

  it("does not accept caller-selected recipient placement", async () => {
    const { catalog } = fixture();
    await expect(
      catalog.resolveTransfer("attempt-token", {
        artifactId: artifact.id,
        path: "results/evidence.txt",
        recipientWorkerHostId: "attacker-host",
      }),
    ).rejects.toMatchObject<Partial<ArtifactCatalogError>>({ statusCode: 400 });
  });

  function volumeCopy(volumeId: string, key: string): ArtifactVolumeLocation {
    return {
      volumeId,
      key,
      digest,
      sizeBytes: 12,
      workerHostId: "producer-host",
      status: "available",
      observedAt: "2030-01-01T00:00:01.000Z",
    };
  }

  it("names Volume copies at their recorded keys only to a host that maps the Volume", async () => {
    const { catalog, signed, store } = fixture();
    store.listArtifactStorageLocations.mockResolvedValue([]);
    store.listArtifactVolumeLocations.mockResolvedValue([
      volumeCopy("volume-shared", `attempts/producer-attempt/sha256/${"a".repeat(64)}`),
      volumeCopy("volume-private", `attempts/producer-attempt/sha256/${"a".repeat(64)}`),
    ]);
    // The consumer stores artifacts on `shared` and maps no credential for `private`.
    store.findWorkerHostById.mockResolvedValue({
      id: "consumer-host",
      enrollmentStatus: "active",
      connectionStatus: "connected",
      connectionGeneration: 7,
      labels: [artifactVolumeLabel("shared")],
      workerSnapshot: {},
    });
    const resolved = await catalog.resolveTransfer("attempt-token", {
      artifactId: artifact.id,
      path: "results/evidence.txt",
    });
    expect(resolved.locations).toEqual([]);
    expect(resolved.volumes).toEqual([
      {
        volume: "shared",
        source: "s3://team-artifacts/hosts",
        credential: "team-artifacts",
        key: `attempts/producer-attempt/sha256/${"a".repeat(64)}`,
      },
    ]);
    expect(resolved.holders).toEqual({
      workerHostIds: ["producer-host"],
      volumes: ["private", "shared"],
    });
    // A Volume read needs no transfer grant: the consumer reads with its own mapping.
    expect(signed).toEqual([]);

    // A host service mapping the credential through volume-credentials can read it too.
    store.findWorkerHostById.mockResolvedValue({
      id: "consumer-host",
      enrollmentStatus: "active",
      connectionStatus: "connected",
      connectionGeneration: 7,
      labels: [],
      workerSnapshot: { labels: [volumeCredentialLabel("private-artifacts")] },
    });
    const viaCredential = await catalog.resolveTransfer("attempt-token", {
      artifactId: artifact.id,
      path: "results/evidence.txt",
    });
    expect(viaCredential.volumes.map((volume) => volume.volume)).toEqual(["private"]);
  });

  it.each(["worker", "operator"])(
    "offers only the producing host's Volume copies to a %s",
    async (consumer) => {
      const { catalog, store } = fixture();
      store.findWorkerHostById.mockResolvedValue({
        id: "consumer-host",
        enrollmentStatus: "active",
        connectionStatus: "connected",
        connectionGeneration: 7,
        labels: [artifactVolumeLabel("shared"), artifactVolumeLabel("private")],
        workerSnapshot: {},
      });
      const own = volumeCopy("volume-shared", `attempts/producer-attempt/sha256/${"a".repeat(64)}`);
      const victim = {
        ...volumeCopy("volume-private", `victim/sha256/${"a".repeat(64)}`),
        workerHostId: "victim-host",
      };
      store.listArtifactVolumeLocations.mockResolvedValue([victim, own]);
      const resolve = () =>
        consumer === "worker"
          ? catalog.resolveTransfer("attempt-token", {
              artifactId: artifact.id,
              path: "results/evidence.txt",
            })
          : catalog.resolveOperatorDownload("operator", artifact.id, {
              path: "results/evidence.txt",
            });
      const resolved = await resolve();
      expect(resolved.volumes.map((copy) => copy.volume)).toEqual(["shared"]);
      expect(resolved.holders.volumes).toEqual(["shared"]);

      // A receipt naming a known digest must not let the producer substitute a victim's copy.
      store.listArtifactStorageLocations.mockResolvedValue([]);
      store.listArtifactVolumeLocations.mockResolvedValue([victim]);
      if (consumer === "worker") await expect(resolve()).rejects.toMatchObject({ statusCode: 409 });
      else
        expect(await resolve()).toMatchObject({
          locations: [],
          volumes: [],
          holders: { workerHostIds: ["producer-host"], volumes: [] },
        });
    },
  );

  it.each(["worker", "operator"])(
    "refuses another Attempt's key even on the producing host for a %s",
    async (consumer) => {
      const { catalog, store } = fixture();
      store.listArtifactStorageLocations.mockResolvedValue([]);
      store.findWorkerHostById.mockResolvedValue({
        id: "consumer-host",
        enrollmentStatus: "active",
        connectionStatus: "connected",
        connectionGeneration: 7,
        labels: [artifactVolumeLabel("shared")],
        workerSnapshot: {},
      });
      store.listArtifactVolumeLocations.mockResolvedValue([
        volumeCopy("volume-shared", `attempts/victim-attempt/sha256/${"a".repeat(64)}`),
      ]);
      if (consumer === "worker") {
        await expect(
          catalog.resolveTransfer("attempt-token", {
            artifactId: artifact.id,
            path: "results/evidence.txt",
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
      } else {
        expect(
          (
            await catalog.resolveOperatorDownload("operator", artifact.id, {
              path: "results/evidence.txt",
            })
          ).volumes,
        ).toEqual([]);
      }
    },
  );

  it("offers the producer's shared-Volume copy when another host wrote identical bytes first", async () => {
    const { catalog, store } = fixture();
    store.findWorkerHostById.mockResolvedValue({
      id: "consumer-host",
      enrollmentStatus: "active",
      connectionStatus: "connected",
      connectionGeneration: 7,
      labels: [artifactVolumeLabel("shared")],
      workerSnapshot: {},
    });
    // Use persisted rows so this regression exercises the first-writer bug, not a mock
    // that assumes the store already retained both holders.
    const directory = await mkdtemp(join(tmpdir(), "supertag-shared-volume-"));
    const url = `file:${join(directory, "store.db")}`;
    const persisted = new DrizzleStore({ url });
    try {
      await migrateDatabase({ url });
      await persisted.connect();
      const { volume } = await persisted.applyVolume({
        name: "shared",
        source: "s3://team-artifacts/hosts",
        credential: "team-artifacts",
      });
      store.listVolumes.mockResolvedValue([volume]);
      store.listArtifactStorageLocations.mockResolvedValue([]);
      store.listArtifactVolumeLocations.mockImplementation(async () => [
        ...(await persisted.listArtifactVolumeLocations({
          digest,
          sizeBytes: 12,
          status: "available",
        })),
      ]);
      for (const workerHostId of ["earlier-host", "producer-host"]) {
        await persisted.enrollWorkerHost({
          id: workerHostId,
          credentialId: `credential-${workerHostId}`,
          enrolledAt: artifact.createdAt,
        });
        await persisted.claimWorkerHostConnection({
          workerHostId,
          credentialRevision: 1,
          workletId: `worklet-${workerHostId}`,
          protocolVersion: 1,
          durableProtocolVersion: 1,
          workerSnapshot: { labels: [artifactVolumeLabel("shared")] },
          capacity: 1,
          availableSlots: 1,
          activeAttempts: 0,
          ready: true,
          observedAt: artifact.createdAt,
        });
      }
      const earlierAttempt = await artifactProducer(persisted, "earlier-host");
      const producerAttempt = await artifactProducer(persisted, "producer-host");
      store.findCapturedArtifact.mockResolvedValue({
        ...artifact,
        taskId: producerAttempt.taskId,
        attemptId: producerAttempt.id,
      });
      const originalAttempts = store.listTaskAttempts.getMockImplementation();
      store.listTaskAttempts.mockImplementation(async (taskId) =>
        taskId === producerAttempt.taskId
          ? [producerAttempt]
          : ((await originalAttempts?.(taskId)) ?? []),
      );
      const copy = {
        volumeId: volume.id,
        source: volume.source,
        key: `attempts/producer-attempt/sha256/${"a".repeat(64)}`,
        digest,
        sizeBytes: 12,
        observedAt: artifact.createdAt,
      };
      await persisted.recordArtifactVolumeCopy({
        ...copy,
        key: `attempts/${earlierAttempt.id}/sha256/${"a".repeat(64)}`,
        workerHostId: "earlier-host",
      });
      const resolve = () =>
        catalog.resolveTransfer("attempt-token", {
          artifactId: artifact.id,
          path: "results/evidence.txt",
        });
      // Merely mapping the same Volume never establishes the producer as a holder.
      await expect(resolve()).rejects.toMatchObject({ statusCode: 409 });
      await persisted.recordArtifactVolumeCopy({
        ...copy,
        key: `attempts/${producerAttempt.id}/sha256/${"a".repeat(64)}`,
        workerHostId: "producer-host",
      });
      const resolved = await resolve();
      expect(resolved.volumes.map((copy) => copy.volume)).toEqual(["shared"]);
      expect(resolved.holders).toEqual({ workerHostIds: ["producer-host"], volumes: ["shared"] });
      expect(
        (
          await catalog.resolveOperatorDownload("operator", artifact.id, {
            path: "results/evidence.txt",
          })
        ).volumes.map((copy) => copy.volume),
      ).toEqual(["shared"]);
    } finally {
      await persisted.disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checks the consumer's grant before naming any Volume copy", async () => {
    const { catalog, store } = fixture();
    store.findTaskById.mockResolvedValue({
      id: "consumer-task",
      tagId: "consumer",
      sessionId: "session-1",
      trigger: { inputArtifacts: [] },
      contextPlan: { sets: [] },
    } as unknown as Task);
    store.listArtifactVolumeLocations.mockResolvedValue([
      volumeCopy("volume-shared", `attempts/producer-attempt/sha256/${"a".repeat(64)}`),
    ]);
    await expect(
      catalog.resolveTransfer("attempt-token", {
        artifactId: artifact.id,
        path: "results/evidence.txt",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(store.listArtifactVolumeLocations).not.toHaveBeenCalled();
    expect(store.listArtifactStorageLocations).not.toHaveBeenCalled();
  });

  it("names the holding hosts and Volumes, and suggests a shared Volume, when none is reachable", async () => {
    const { catalog, store } = fixture();
    store.listArtifactStorageLocations.mockResolvedValue([]);
    store.listArtifactVolumeLocations.mockResolvedValue([
      volumeCopy("volume-private", `attempts/producer-attempt/sha256/${"a".repeat(64)}`),
    ]);
    await expect(
      catalog.resolveTransfer("attempt-token", {
        artifactId: artifact.id,
        path: "results/evidence.txt",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Artifact artifact-1 file results/evidence.txt is unavailable to this Worker Host: it is held by Worker Host producer-host and on Volume private, and this host can reach no copy. An artifact Volume shared with a host that holds it would make it reachable.",
    });
  });
});
