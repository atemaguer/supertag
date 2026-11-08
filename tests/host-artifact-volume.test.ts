import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { HostServiceWorklet, hostArtifactVolumeStore } from "../apps/cli/src/worker.js";
import {
  COORDINATION_CAPABILITY,
  DurableLocalWorklet,
  FileAttemptJournal,
  SURFACE_COORDINATION_CAPABILITY,
  WORKSPACE_COPY_MOUNT_CAPABILITY,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { connectDurableTestWorklet } from "./support/durable-test-connection.js";
import { FakeS3 } from "./support/fake-s3.ts";
import { hostArtifactStore } from "./support/host-artifact-store.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

afterEach(() => vi.unstubAllEnvs());

const ACCESS_KEY = "AKIAHOSTARTIFACTS001";
const SECRET_KEY = "host-artifact-volume-secret-0123456789";

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
  return files;
}

it("stores a captured artifact on the producing host's artifact Volume, and the catalog records where", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-host-artifact-volume-"));
  vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "worker-state"));
  const controlPlaneState = join(directory, "control-plane");
  const databaseUrl = `file:${join(controlPlaneState, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  const s3 = await FakeS3.start(ACCESS_KEY);
  s3.bucket("team-artifacts");
  const volume = (
    await store.applyVolume({
      name: "artifacts",
      source: `s3://team-artifacts/hosts?region=us-east-1&endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`,
      credential: "team-artifacts",
    })
  ).volume;
  await store.applyVolume({ name: "other", source: "s3://elsewhere/x", credential: "other" });
  const owner = await store.createTag({ name: "owner" });
  await store.bindTagWorkerHost(owner.id, "producer-host");
  const canary = `volume-canary-${randomUUID()}`;
  const bytes = Buffer.concat([Buffer.from(canary), randomBytes(2048)]);
  const hex = createHash("sha256").update(bytes).digest("hex");
  const digest = `sha256:${hex}`;
  // The credential is read on the host only, when the Volume is used, by the name the catalog
  // gives; the Control Plane never sees the value.
  const credentialReads: string[] = [];
  const readCredential = async (name: string) => {
    credentialReads.push(name);
    return JSON.stringify({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
  };
  let hostCredential = "";
  let controlPlaneUrl = "";
  const results: {
    artifactId: string;
    foreignReceipt: number;
    foreignLookup: number;
  }[] = [];
  const errors: unknown[] = [];
  const profile = { id: "deterministic", revision: "1" };
  const worker: Worker = {
    async describe() {
      return {
        profileCapabilities: [
          {
            profile: profile,
            capabilities: [
              { id: "supertag.task-attempt.events", version: 1 },
              COORDINATION_CAPABILITY,
              SURFACE_COORDINATION_CAPABILITY,
            ],
            contextTypes: [],
          },
        ],
        id: "producer",
        type: "deterministic",
        profiles: [profile],
        contextTypes: [],
        maxConcurrency: 1,
        capabilities: [
          { id: "supertag.task-attempt.events", version: 1 },
          COORDINATION_CAPABILITY,
          SURFACE_COORDINATION_CAPABILITY,
        ],
      };
    },
    async *execute(spec) {
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at: "" };
      const now = () => ({ ...identity, at: new Date().toISOString() });
      yield { ...now(), type: "execution.started", workerId: "producer" };
      try {
        const coordination = spec.coordination;
        if (!coordination) throw new Error("Missing Attempt coordination");
        const authorization = `Bearer ${coordination.token}`;
        const copies = hostArtifactVolumeStore({
          name: "artifacts",
          readCredential,
          token: hostCredential,
          workerHostId: "producer-host",
          controlPlane: controlPlaneUrl,
        });
        const host = hostArtifactStore(copies, { volume: "artifacts" })(spec);
        // Cache A, then change the source before the first copy is recorded. The stale write
        // must not create a receipt or claim a copy at B; retry refreshes and writes to B.
        await copies.source();
        await store.applyVolume({
          name: volume.name,
          source: volume.source.replace("/hosts?", "/replacement?"),
          credential: "team-artifacts",
        });
        await expect(host.put({ bytes })).rejects.toThrow(/409/);
        expect(
          await store.listArtifactVolumeLocations({ digest, sizeBytes: bytes.byteLength }),
        ).toEqual([]);
        expect(
          await store.hasArtifactUpload({
            attemptId: spec.attemptId,
            digest,
            sizeBytes: bytes.byteLength,
          }),
        ).toBe(false);
        const ref = await host.put({ bytes });
        expect(ref.digest).toBe(digest);
        // Each upload resolves the host credential, including the refused stale-source write.
        expect(credentialReads).toEqual(["team-artifacts", "team-artifacts"]);
        // Reading the accepted copy resolves it once more so rotated credentials take effect.
        expect(Buffer.from(await host.get(ref))).toEqual(bytes);
        const captured = await fetch(`${controlPlaneUrl}/internal/v1/artifacts/catalog/capture`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({
            operationId: "report",
            title: "Report on the artifact Volume",
            kind: "report",
            entries: [
              {
                path: "outputs/report.bin",
                uri: ref.uri,
                digest: ref.digest,
                sizeBytes: bytes.byteLength,
              },
            ],
          }),
        });
        expect(captured.status, await captured.clone().text()).toBe(200);
        const { artifact } = (await captured.json()) as { artifact: { id: string } };
        // A receipt naming a Volume this host does not store artifacts on is refused, and the
        // host cannot read that Volume's catalog entry either.
        const foreign = await fetch(`${controlPlaneUrl}/internal/v1/artifacts/catalog/upload`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({
            digest,
            sizeBytes: bytes.byteLength,
            volume: "other",
            volumeSource: volume.source,
          }),
        });
        const lookup = await fetch(`${controlPlaneUrl}/internal/v1/artifacts/volume?name=other`, {
          headers: {
            authorization: `Bearer ${hostCredential}`,
            "x-supertag-worker-host-id": "producer-host",
          },
        });
        results.push({
          artifactId: artifact.id,
          foreignReceipt: foreign.status,
          foreignLookup: lookup.status,
        });
      } catch (error) {
        errors.push(error);
        throw error;
      }
      yield {
        ...now(),
        type: "output.message",
        message: { role: "teammate", text: "Report stored on the artifact Volume" },
      };
      yield { ...now(), type: "execution.completed" };
    },
  };
  // The host advertises its artifact Volume the way supertag up and connect worklet do.
  const local = new HostServiceWorklet(
    "producer-worklet",
    "producer-host",
    [worker],
    {},
    [],
    undefined,
    undefined,
    "artifacts",
  );
  const durable = new DurableLocalWorklet(
    local,
    new FileAttemptJournal(join(directory, "journal")),
  );
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  let connection: Awaited<ReturnType<typeof connectDurableTestWorklet>> | undefined;
  try {
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      stateDirectory: controlPlaneState,
      workletTransport: "remote",
      adminToken: "test-admin",
      credentialVault: new FileGatewayCredentialVault(join(controlPlaneState, "vault.json")),
    });
    controlPlaneUrl = runtime.url;
    hostCredential = await enrollWorkerHost(controlPlaneUrl, "test-admin", "producer-host");
    connection = await connectDurableTestWorklet({
      url: `${controlPlaneUrl.replace(/^http/u, "ws")}/worklets`,
      credential: hostCredential,
      worklet: local,
      durableWorklet: durable,
      reconnectIntervalMs: 20,
    });
    // Applying the Objective manifest starts its own conversation's first turn.
    const startTaskId = await applyAndStart(store, controlPlaneUrl, "on-volume", {
      owner: owner.name,
      outcome: "Keep artifacts on the artifact Volume",
    });
    await expect.poll(() => results.length + errors.length, { timeout: 15000 }).toBe(1);
    expect(errors).toEqual([]);
    const [result] = results;
    if (!result) throw new Error("The producer did not run");
    expect(result.foreignReceipt).toBe(403);
    expect(result.foreignLookup).toBe(403);
    expect(credentialReads).toEqual(["team-artifacts", "team-artifacts", "team-artifacts"]);

    const [producerAttempt] = await store.listTaskAttempts(startTaskId);
    if (!producerAttempt) throw new Error("Missing producer Attempt");
    // The accepted copy is at B, written with the host's credential. The refused write
    // at A remains unclaimed by the catalog.
    expect(
      Buffer.from(
        s3.object("team-artifacts", `replacement/attempts/${producerAttempt.id}/sha256/${hex}`) ??
          [],
      ),
    ).toEqual(bytes);
    expect(
      s3.requests.filter((request) => request.method === "PUT").map((request) => request.key),
    ).toEqual([
      `hosts/attempts/${producerAttempt.id}/sha256/${hex}`,
      `replacement/attempts/${producerAttempt.id}/sha256/${hex}`,
    ]);
    expect(new Set(s3.requests.map((request) => request.accessKeyId))).toEqual(
      new Set([ACCESS_KEY]),
    );
    // The catalog records the Volume copy and its writer, and describe task shows the Volume.
    expect(
      await store.listArtifactVolumeLocations({ digest, sizeBytes: bytes.byteLength }),
    ).toEqual([
      expect.objectContaining({
        volumeId: volume.id,
        key: `attempts/${producerAttempt.id}/sha256/${hex}`,
        workerHostId: "producer-host",
        status: "available",
      }),
    ]);
    expect(await store.listVolumeIdsHoldingArtifacts()).toEqual([volume.id]);
    const task = (await (
      await fetch(`${controlPlaneUrl}/api/v1/tasks/${encodeURIComponent(startTaskId)}`, {
        headers: { authorization: "Bearer test-admin" },
      })
    ).json()) as { status: { storage: { artifacts: { locations: unknown[] }[] } } };
    expect(task.status.storage.artifacts).toEqual([
      expect.objectContaining({
        locations: expect.arrayContaining([{ kind: "volume", volume: "artifacts" }]),
      }),
    ]);
  } finally {
    await connection?.stop();
    await runtime?.close();
    await durable.shutdown("Test finished");
    await store.disconnect();
    await s3.close();
  }
  try {
    // Nothing the Control Plane wrote holds the bytes or the Volume credential.
    for (const file of await filesUnder(controlPlaneState)) {
      const content = await readFile(file);
      expect(content.includes(Buffer.from(canary)), file).toBe(false);
      expect(content.includes(Buffer.from(SECRET_KEY)), file).toBe(false);
      expect(content.includes(Buffer.from(ACCESS_KEY)), file).toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("refuses through Objective placement to mount a Volume a Worker Host stores artifacts on", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-artifact-mount-guard-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  await store.applyVolume({ name: "artifacts", source: "s3://shared/hosts", credential: "art" });
  // The same location spelled another way: r2:// with AWS's endpoint, and percent-encoding.
  await store.applyVolume({
    name: "alias",
    source: "r2://shared/ho%73ts/sha256?endpoint=https://s3.eu-west-1.amazonaws.com",
    credential: "art",
  });
  await store.applyWorkspace({
    name: "research",
    delivery: "branch",
    source: "https://example.com/research.git",
    mounts: [{ volume: "alias", path: "/mnt/data", access: "read-only", strategy: "copy" }],
  });
  const owner = await store.createTag({ name: "owner" });
  await store.bindTagWorkerHost(owner.id, "host");
  const ran: string[] = [];
  const profile = { id: "deterministic", revision: "1" };
  const capabilities = [
    { id: "supertag.task-attempt.events", version: 1 },
    COORDINATION_CAPABILITY,
    SURFACE_COORDINATION_CAPABILITY,
    WORKSPACE_COPY_MOUNT_CAPABILITY,
    { id: "supertag.workspace.clone", version: 1 },
  ];
  const worker: Worker = {
    async describe() {
      return {
        id: "mounting",
        type: "deterministic",
        profiles: [profile],
        contextTypes: [],
        maxConcurrency: 1,
        capabilities,
        profileCapabilities: [{ profile, harness: "codex", capabilities, contextTypes: [] }],
      };
    },
    async *execute(spec) {
      ran.push(spec.taskId);
      yield {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
        type: "execution.completed",
      };
    },
  };
  // The host maps the Volume's credential, so only the artifact guard can refuse the mount.
  const local = new HostServiceWorklet(
    "host-worklet",
    "host",
    [worker],
    {},
    [],
    undefined,
    async () => ["art"],
    "artifacts",
  );
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  let connection: Awaited<ReturnType<typeof connectDurableTestWorklet>> | undefined;
  try {
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "test-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    const credential = await enrollWorkerHost(runtime.url, "test-admin", "host");
    connection = await connectDurableTestWorklet({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet: local,
      reconnectIntervalMs: 20,
    });
    const startTaskId = await applyAndStart(store, runtime.url, "guarded", {
      owner: owner.name,
      outcome: "Never mount artifacts",
      workspaces: ["research"],
    });
    await expect
      .poll(
        async () =>
          (await store.listTaskEvents(startTaskId)).find(
            (event) => event.type === "task.scheduling-incompatible",
          )?.payload,
        { timeout: 10000 },
      )
      .toMatchObject({
        status: "incompatible",
        workspaceRefusals: [
          "Volume alias overlaps artifact Volume artifacts and cannot be mounted",
        ],
      });
    expect(ran).toEqual([]);
  } finally {
    await connection?.stop();
    await runtime?.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

/**
 * Applies an Objective manifest, which creates the Objective and starts the first turn of its own
 * conversation, and returns that turn's Task.
 */
async function applyAndStart(
  store: DrizzleStore,
  controlPlaneUrl: string,
  name: string,
  spec: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${controlPlaneUrl}/api/v1/objectives`, {
    method: "POST",
    headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
    body: JSON.stringify({
      apiVersion: "supertag/v1",
      kind: "Objective",
      metadata: { name },
      spec,
    }),
  });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  let taskId: string | undefined;
  await expect
    .poll(
      async () => {
        const session = await store.findObjectiveOwnerSession(name);
        if (!session) return false;
        taskId = (await store.listTasks({ sessionId: session.id }))[0]?.id;
        return taskId !== undefined;
      },
      { timeout: 10000 },
    )
    .toBe(true);
  if (taskId === undefined) throw new Error(`Objective ${name} opened no turn`);
  return taskId;
}
