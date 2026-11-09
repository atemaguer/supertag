import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactsWithLocations } from "../apps/cli/src/artifact-resources.ts";
import { taskStorage } from "../apps/cli/src/task-storage.ts";
import { FileArtifactStore, S3ArtifactStore } from "../packages/runtime/sdk/src/artifact-store.ts";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

interface Copy {
  readonly workerHostId: string;
  readonly status?: "available" | "unavailable";
}

/**
 * A catalog with one artifact per entry list, Worklet copies and Volume copies by digest, and
 * known hosts. The Control Plane holds no bytes, so the catalog is the only evidence.
 */
function catalog(
  artifacts: Record<string, string>,
  copies: Record<string, readonly Copy[]>,
  hosts: readonly { id: string; ephemeral: boolean; enrollmentStatus?: string }[],
  volumeCopies: Record<
    string,
    readonly { volumeId: string; workerHostId?: string; status?: "available" | "unavailable" }[]
  > = {},
) {
  return {
    listTaskAttempts: vi.fn(async () => [
      { id: "attempt-1", workerSnapshot: { workerHostId: "ci-7" } },
      { id: "attempt-2", workerSnapshot: { workerHostId: "build-1" } },
    ]),
    hasArtifactUpload: vi.fn(
      async ({ digest: key }: { digest: string }) =>
        (copies[key]?.length ?? 0) > 0 ||
        (volumeCopies[key] ?? []).some((copy) => (copy.workerHostId ?? "ci-7") === "ci-7"),
    ),
    listCapturedArtifacts: vi.fn(async () => ({
      artifacts: Object.entries(artifacts).map(([id, letters]) => ({
        id,
        title: id,
        taskId: "task-1",
        attemptId: "attempt-1",
        entries: [...letters].map((letter) => ({
          path: `${letter}.txt`,
          uri: `supertag-artifact:${digest(letter)}`,
          digest: digest(letter),
          sizeBytes: 1,
        })),
      })),
    })),
    listArtifactStorageLocations: vi.fn(
      async ({ digest: key, status }: { digest: string; status?: string }) =>
        (copies[key] ?? [])
          .map((copy) => ({
            workerHostId: copy.workerHostId,
            digest: key,
            sizeBytes: 1,
            connectionGeneration: 1,
            inventoryRevision: 1,
            transferBaseUrl: "https://10.0.0.7:9443/private",
            status: copy.status ?? "available",
            observedAt: "2026-10-05T00:00:00.000Z",
          }))
          .filter((copy) => status === undefined || copy.status === status),
    ),
    listArtifactVolumeLocations: vi.fn(
      async ({ digest: key, status }: { digest: string; status?: string }) =>
        (volumeCopies[key] ?? [])
          .map((copy) => ({
            volumeId: copy.volumeId,
            workerHostId: copy.workerHostId ?? "ci-7",
            key: `attempts/attempt-1/sha256/${key.slice("sha256:".length)}`,
            digest: key,
            sizeBytes: 1,
            status: copy.status ?? "available",
            observedAt: "2026-10-05T00:00:00.000Z",
          }))
          .filter((copy) => status === undefined || copy.status === status),
    ),
    listVolumes: vi.fn(async () => [{ id: "volume-shared", name: "shared" }]),
    listWorkerHosts: vi.fn(async () =>
      hosts.map((host) => ({
        id: host.id,
        ephemeral: host.ephemeral,
        enrollmentStatus: host.enrollmentStatus ?? "active",
        workerSnapshot: {},
      })),
    ),
  };
}

async function storageOf(store: ReturnType<typeof catalog>) {
  const result = await taskStorage(
    store as never,
    "task-1",
    { workerSnapshot: { workerHostId: "ci-7" } } as never,
    { provider: "local", placement: "local" },
  );
  return Object.fromEntries(result.artifacts.map((item) => [item.artifactId, item]));
}

it("batches producing Attempts once across an artifact list page", async () => {
  const store = catalog({ first: "a", second: "b", third: "c" }, {}, HOSTS);
  const page = await store.listCapturedArtifacts();
  const third = page.artifacts[2];
  if (!third) throw new Error("Missing third artifact");
  third.taskId = "task-2";
  store.listCapturedArtifacts.mockResolvedValue(page);
  const placed = await artifactsWithLocations(store as never, page.artifacts as never);
  expect(placed).toHaveLength(3);
  expect(store.listTaskAttempts).toHaveBeenCalledTimes(1);
  expect(store.listTaskAttempts).toHaveBeenCalledWith(["task-1", "task-2"]);
});

it("reads producing Attempts once for a Task storage report", async () => {
  const store = catalog({ first: "a", second: "b" }, {}, HOSTS);
  await storageOf(store);
  expect(store.listTaskAttempts).toHaveBeenCalledTimes(1);
});

const HOSTS = [
  { id: "ci-7", ephemeral: true },
  { id: "build-1", ephemeral: false },
  { id: "old-build", ephemeral: false, enrollmentStatus: "revoked" },
];

describe("describe task artifact locations", () => {
  it("does not infer Task placement from a current capability claim", async () => {
    const store = catalog({}, {}, HOSTS);
    const hosts = await store.listWorkerHosts();
    const host = hosts[0];
    if (!host) throw new Error("Missing fixture host");
    host.workerSnapshot = {
      workers: [
        {
          capabilities: [{ id: "supertag.execution.remote-sandbox.modal", version: 1 }],
        },
      ],
    };
    store.listWorkerHosts.mockResolvedValue(hosts);
    const latest = { workerSnapshot: { workerHostId: "ci-7" } } as never;
    expect((await taskStorage(store as never, "task-1", latest, null)).taskFiles).toEqual({
      workerHostId: "ci-7",
      ephemeral: true,
      placementUnknown: true,
    });
    expect(
      (
        await taskStorage(store as never, "task-1", latest, {
          provider: "local",
          placement: "local",
        })
      ).taskFiles,
    ).toEqual({ workerHostId: "ci-7", ephemeral: true });
  });

  it.each(["omitted", "unavailable"])(
    "keeps the producer's ephemeral risk when inventory is %s",
    async (status) => {
      const store = catalog(
        { local: "a" },
        status === "omitted"
          ? {}
          : {
              [digest("a")]: [{ workerHostId: "ci-7", status: "unavailable" }],
            },
        HOSTS,
      );
      expect((await storageOf(store))["local"]).toMatchObject({
        locations: [],
        ephemeralOnly: true,
      });
    },
  );

  it("does not count a claimed Volume copy without the producing Attempt's upload receipt", async () => {
    const store = catalog({ local: "a" }, {}, HOSTS, {
      [digest("a")]: [{ volumeId: "volume-shared" }],
    });
    store.hasArtifactUpload.mockResolvedValue(false);
    expect((await storageOf(store))["local"]?.ephemeralOnly).toBe(true);
    expect(store.hasArtifactUpload).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      digest: digest("a"),
      sizeBytes: 1,
    });
  });

  it("does not count a producer advertisement without an upload for the producing Attempt", async () => {
    const store = catalog({ local: "a" }, { [digest("a")]: [{ workerHostId: "ci-7" }] }, HOSTS);
    store.hasArtifactUpload.mockResolvedValue(false);
    expect((await storageOf(store))["local"]).toMatchObject({
      locations: [],
      ephemeralOnly: true,
    });
    expect(store.hasArtifactUpload).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      digest: digest("a"),
      sizeBytes: 1,
    });
  });

  it.each(["available", "unavailable"] as const)(
    "ignores an unrelated %s Volume copy when placing the producer receipt",
    async (status) => {
      const store = catalog({ local: "a" }, {}, HOSTS, {
        [digest("a")]: [{ volumeId: "volume-shared", workerHostId: "build-1", status }],
      });
      store.hasArtifactUpload.mockResolvedValue(true);
      expect((await storageOf(store))["local"]).toMatchObject({
        locations: [{ kind: "worker-host", workerHostId: "ci-7", ephemeral: true }],
        ephemeralOnly: true,
      });
    },
  );

  it("does not credit unrelated persistent holders, including disconnected inventory", async () => {
    const store = catalog(
      { local: "a" },
      {
        [digest("a")]: [{ workerHostId: "ci-7" }, { workerHostId: "build-1" }],
      },
      HOSTS,
    );
    expect((await storageOf(store))["local"]).toMatchObject({
      locations: [{ kind: "worker-host", workerHostId: "ci-7", ephemeral: true }],
      ephemeralOnly: true,
    });
  });

  it("does not place digest matches when the producing Attempt is unknown", async () => {
    const store = catalog(
      { local: "a" },
      {
        [digest("a")]: [{ workerHostId: "ci-7" }],
      },
      HOSTS,
      { [digest("a")]: [{ volumeId: "volume-shared" }] },
    );
    store.listTaskAttempts.mockResolvedValue([]);
    expect((await storageOf(store))["local"]).toMatchObject({
      locations: [],
      ephemeralOnly: false,
    });
  });

  it("shows the default endpoint-free Worklet receipt and ephemeral warning", async () => {
    const store = catalog({ local: "a" }, {}, HOSTS);
    store.hasArtifactUpload.mockResolvedValue(true);
    expect((await storageOf(store))["local"]).toMatchObject({
      locations: [{ kind: "worker-host", workerHostId: "ci-7", ephemeral: true, removed: false }],
      ephemeralOnly: true,
    });
    expect(store.hasArtifactUpload).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      digest: digest("a"),
      sizeBytes: 1,
    });
  });

  it("does not invent a local copy for an upload held on a Volume", async () => {
    const store = catalog({ local: "a" }, {}, HOSTS, {
      [digest("a")]: [{ volumeId: "volume-shared" }],
    });
    store.hasArtifactUpload.mockResolvedValue(true);
    expect((await storageOf(store))["local"]).toMatchObject({
      locations: [{ kind: "volume", volume: "shared" }],
      ephemeralOnly: false,
    });
  });

  it("does not resurrect an explicitly withdrawn host or Volume copy from its upload receipt", async () => {
    for (const onVolume of [false, true]) {
      const store = catalog(
        { local: "a" },
        onVolume ? {} : { [digest("a")]: [{ workerHostId: "ci-7", status: "unavailable" }] },
        HOSTS,
        onVolume ? { [digest("a")]: [{ volumeId: "volume-shared", status: "unavailable" }] } : {},
      );
      store.hasArtifactUpload.mockResolvedValue(true);
      expect((await storageOf(store))["local"]).toMatchObject({
        locations: [],
        ephemeralOnly: true,
      });
    }
  });

  it("shows a disconnected host's retained inventory without requiring transfer availability", async () => {
    const store = catalog({ local: "a" }, { [digest("a")]: [{ workerHostId: "ci-7" }] }, HOSTS);
    const original = store.listArtifactStorageLocations.getMockImplementation();
    if (!original) throw new Error("Missing catalog fixture");
    store.listArtifactStorageLocations.mockImplementation(async (query) =>
      query.status === "available" ? [] : original(query),
    );
    expect((await storageOf(store))["local"]?.locations).toEqual([
      { kind: "worker-host", workerHostId: "ci-7", ephemeral: true, removed: false },
    ]);
  });

  it("lists only the producing host even when another host has the same digest", async () => {
    const byId = await storageOf(
      catalog(
        { notes: "b" },
        { [digest("b")]: [{ workerHostId: "ci-7" }, { workerHostId: "old-build" }] },
        HOSTS,
      ),
    );
    expect(byId["notes"]).toMatchObject({
      locations: [{ kind: "worker-host", workerHostId: "ci-7", ephemeral: true, removed: false }],
      ephemeralOnly: true,
    });
  });

  it("does not count another producer's persistent host or Volume toward durability", async () => {
    const store = catalog(
      { notes: "b" },
      { [digest("b")]: [{ workerHostId: "ci-7" }, { workerHostId: "build-1" }] },
      HOSTS,
      { [digest("b")]: [{ volumeId: "volume-shared", workerHostId: "build-1" }] },
    );
    expect((await storageOf(store))["notes"]).toMatchObject({
      locations: [{ kind: "worker-host", workerHostId: "ci-7" }],
      ephemeralOnly: true,
    });
  });

  it("does not infer a producing host from the latest Attempt", async () => {
    const store = catalog({ notes: "b" }, { [digest("b")]: [{ workerHostId: "ci-7" }] }, HOSTS);
    store.listTaskAttempts.mockResolvedValue([]);
    expect((await storageOf(store))["notes"]).toMatchObject({
      locations: [],
      ephemeralOnly: false,
    });
  });

  it("reports a host copy and a Volume copy and does not flag it", async () => {
    const store = catalog({ shared: "c" }, { [digest("c")]: [{ workerHostId: "ci-7" }] }, HOSTS, {
      [digest("c")]: [{ volumeId: "volume-shared" }],
    });
    const byId = await storageOf(store);
    expect(byId["shared"]?.locations).toEqual([
      { kind: "volume", volume: "shared" },
      { kind: "worker-host", workerHostId: "ci-7", ephemeral: true, removed: false },
    ]);
    expect(byId["shared"]?.ephemeralOnly).toBe(false);
    // Volume keys, like transfer URLs, are never projected.
    expect(JSON.stringify(byId)).not.toContain("private/sha256");
    expect(store.listArtifactVolumeLocations).toHaveBeenCalledWith({
      digest: digest("c"),
      sizeBytes: 1,
    });
  });

  it("never names the Control Plane as a place, and reports an uncopied file as unrecorded", async () => {
    const byId = await storageOf(catalog({ lost: "d" }, {}, HOSTS));
    expect(byId["lost"]).toMatchObject({ locations: [], ephemeralOnly: true });
  });

  it("does not count deleted Volumes or unavailable copies toward durability", async () => {
    const byId = await storageOf(
      catalog({ notes: "b" }, { [digest("b")]: [{ workerHostId: "ci-7" }] }, HOSTS, {
        [digest("b")]: [
          { volumeId: "volume-gone" },
          { volumeId: "volume-shared", status: "unavailable" },
        ],
      }),
    );
    expect(byId["notes"]).toMatchObject({
      locations: [{ kind: "worker-host", workerHostId: "ci-7" }],
      ephemeralOnly: true,
    });
  });

  it("counts only available Worklet copies", async () => {
    const store = catalog(
      { notes: "b" },
      {
        [digest("b")]: [
          { workerHostId: "ci-7" },
          { workerHostId: "build-1", status: "unavailable" },
        ],
      },
      HOSTS,
    );
    // Even when the catalog returns withdrawn copies, they are not counted.
    store.listArtifactStorageLocations.mockImplementation(async ({ digest: key }) =>
      [
        { workerHostId: "ci-7", status: "available" as const },
        { workerHostId: "build-1", status: "unavailable" as const },
      ].map((copy) => ({
        ...copy,
        digest: key,
        sizeBytes: 1,
        connectionGeneration: 1,
        inventoryRevision: 1,
        transferBaseUrl: "https://10.0.0.7:9443/private",
        observedAt: "2026-10-05T00:00:00.000Z",
      })),
    );
    const byId = await storageOf(store);
    expect(store.listArtifactStorageLocations).toHaveBeenCalledWith({
      digest: digest("b"),
      sizeBytes: 1,
    });
    expect(byId["notes"]).toMatchObject({
      locations: [{ kind: "worker-host", workerHostId: "ci-7" }],
      ephemeralOnly: true,
    });
  });
});

describe("artifact store presence", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-artifact-has-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("a directory store says whether it holds the bytes, without creating its directory", async () => {
    const empty = new FileArtifactStore(join(directory, "never-created"));
    const ref = { uri: `supertag-artifact:${digest("a")}`, digest: digest("a") };
    await expect(empty.has(ref)).resolves.toBe(false);
    const store = new FileArtifactStore(join(directory, "artifacts"));
    const saved = await store.put({ bytes: Buffer.from("hello") });
    await expect(store.has(saved)).resolves.toBe(true);
    await expect(store.has(ref)).resolves.toBe(false);
  });

  it("a bucket store asks for the object's head and treats not found as absent", async () => {
    const send = vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
      if ((command.input as { Key: string }).Key.endsWith("a".repeat(64))) return {};
      throw Object.assign(new Error("NotFound"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });
    });
    const store = new S3ArtifactStore({ bucket: "b", prefix: "p", client: { send } as never });
    await expect(
      store.has({ uri: `supertag-artifact:${digest("a")}`, digest: digest("a") }),
    ).resolves.toBe(true);
    await expect(
      store.has({ uri: `supertag-artifact:${digest("b")}`, digest: digest("b") }),
    ).resolves.toBe(false);
    expect(send.mock.calls[0]?.[0].constructor.name).toBe("HeadObjectCommand");
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "b",
      Key: `p/sha256/${"a".repeat(64)}`,
    });
    send.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    await expect(
      store.has({ uri: `supertag-artifact:${digest("c")}`, digest: digest("c") }),
    ).rejects.toThrow("denied");
  });
});
