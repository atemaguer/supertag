import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { artifactTransferVerificationKey } from "../apps/cli/src/artifact-transfer-key.js";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { conversationClient } from "../apps/cli/src/operator-client.js";
import {
  DurableLocalWorklet,
  FileArtifactStore,
  FileAttemptJournal,
  LocalWorklet,
  type Worker,
  WorkletArtifactTransferServer,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { hostArtifactStore } from "./support/host-artifact-store.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

/** Every regular file beneath a directory, for scanning what the Control Plane wrote. */
async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
  return files;
}

it.each([true, false])(
  "captures without Control Plane bytes (transfer endpoint: %s)",
  captureWithoutControlPlaneBytes,
  30000,
);

async function captureWithoutControlPlaneBytes(advertise: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-no-cp-bytes-"));
  // The Control Plane's state and the Worker Host's copies are separate directories, as they are
  // on separate machines, so anything under the first was written by the Control Plane.
  const controlPlaneState = join(directory, "control-plane");
  const hostCopies = join(directory, "worker-host", "artifacts");
  const databaseUrl = `file:${join(controlPlaneState, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  const owner = await store.createTag({ name: "owner" });
  await store.bindTagWorkerHost(owner.id, "producer-host");

  // Distinctive bytes: a text canary and random binary, so a scan cannot match by accident.
  const canary = `artifact-canary-${randomUUID()}`;
  const bytes = Buffer.concat([Buffer.from(canary), randomBytes(4096), Buffer.from(canary)]);
  const hex = createHash("sha256").update(bytes).digest("hex");
  const digest = `sha256:${hex}`;
  let hostCredential = "";
  let transferBaseUrl = "";
  const attempts: {
    readonly byteRoutes: Record<string, number>;
    readonly artifactId: string;
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
              { id: "supertag.coordination", version: 1 },
              { id: "supertag.coordination.surface", version: 1 },
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
          { id: "supertag.coordination", version: 1 },
          { id: "supertag.coordination.surface", version: 1 },
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
        const controlPlane = new URL(coordination.controlPlaneUrl).origin;
        const authorization = `Bearer ${coordination.token}`;
        // The host keeps the bytes and records only a metadata receipt with the catalog.
        const ref = await hostArtifactStore(hostCopies)(spec).put({ bytes });
        expect(ref.digest).toBe(digest);
        const captured = await fetch(`${controlPlane}/internal/v1/artifacts/catalog/capture`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({
            operationId: "report",
            title: "Report kept on its Worker Host",
            kind: "report",
            entries: [
              {
                path: "outputs/report.bin",
                uri: ref.uri,
                digest: ref.digest,
                sizeBytes: bytes.byteLength,
                mediaType: "application/octet-stream",
              },
            ],
          }),
        });
        expect(captured.status, await captured.clone().text()).toBe(200);
        const { artifact } = (await captured.json()) as { artifact: { id: string } };
        // The host advertises its verified copy, the way a Worklet's inventory does.
        if (advertise) {
          const advertised = await fetch(`${controlPlane}/internal/v1/artifacts/worklet-copies`, {
            method: "PUT",
            headers: {
              authorization: `Bearer ${hostCredential}`,
              "x-supertag-worker-host-id": "producer-host",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              inventoryRevision: 1,
              transferBaseUrl,
              copies: [{ digest, sizeBytes: bytes.byteLength }],
            }),
          });
          expect(advertised.status, await advertised.clone().text()).toBe(200);
        }
        // With a live execution credential, every way a Worker could hand the Control Plane bytes
        // is refused: the removed byte routes, raw bytes to the receipt route, and inline content.
        const byteRoutes: Record<string, number> = {};
        for (const [name, path, method, body] of [
          ["put", `/internal/v1/artifacts/${hex}`, "PUT", bytes],
          ["get", `/internal/v1/artifacts/${hex}`, "GET", undefined],
          ["post", `/internal/v1/artifacts/${hex}`, "POST", bytes],
          ["upload-bytes", "/internal/v1/artifacts/catalog/upload", "POST", bytes],
          [
            "inline-capture",
            "/internal/v1/artifacts/catalog/capture",
            "POST",
            Buffer.from(
              JSON.stringify({
                operationId: "inline",
                title: "Inline",
                kind: "report",
                entries: [],
                content: bytes.toString("base64"),
              }),
            ),
          ],
        ] as const) {
          const response = await fetch(`${controlPlane}${path}`, {
            method,
            headers: {
              authorization,
              "content-type":
                name === "inline-capture" ? "application/json" : "application/octet-stream",
            },
            ...(body === undefined ? {} : { body }),
          });
          byteRoutes[name] = response.status;
          expect(Buffer.from(await response.arrayBuffer()).includes(Buffer.from(canary))).toBe(
            false,
          );
        }
        attempts.push({ byteRoutes, artifactId: artifact.id });
      } catch (error) {
        errors.push(error);
        throw error;
      }
      yield {
        ...now(),
        type: "output.message",
        message: { role: "teammate", text: "Report captured on this host" },
      };
      yield { ...now(), type: "execution.completed" };
    },
  };
  const local = new LocalWorklet("producer-worklet", "producer-host", [worker]);
  const durable = new DurableLocalWorklet(
    local,
    new FileAttemptJournal(join(directory, "journal")),
  );
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  let connection: Awaited<ReturnType<typeof connectWorklet>> | undefined;
  let server: WorkletArtifactTransferServer | undefined;
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
    const controlPlaneUrl = runtime.url;
    hostCredential = await enrollWorkerHost(controlPlaneUrl, "test-admin", "producer-host");
    // The producing host serves its own copies, verifying grants with the catalog's public key.
    if (advertise) {
      const key = (await (
        await fetch(`${controlPlaneUrl}/internal/v1/artifacts/transfer-key`)
      ).json()) as { publicKey: string };
      server = new WorkletArtifactTransferServer({
        workerHostId: "producer-host",
        store: new FileArtifactStore(hostCopies),
        verificationKey: artifactTransferVerificationKey(key.publicKey),
      });
      transferBaseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    }
    connection = await connectWorklet({
      url: `${controlPlaneUrl.replace(/^http/u, "ws")}/worklets`,
      credential: hostCredential,
      worklet: local,
      durableWorklet: durable,
      reconnectIntervalMs: 20,
    });
    const { taskId } = await conversationClient({
      url: controlPlaneUrl,
      token: "test-admin",
    }).sendMessage({ tag: owner.name, text: "Produce the artifact" });
    await expect.poll(() => attempts.length + errors.length, { timeout: 15000 }).toBe(1);
    expect(errors).toEqual([]);
    const [attempt] = attempts;
    if (!attempt) throw new Error("The producer did not run");
    expect(attempt.byteRoutes).toEqual({
      put: 404,
      get: 404,
      post: 404,
      "upload-bytes": 400,
      "inline-capture": 400,
    });
    await expect
      .poll(async () => (await store.findTaskById(taskId))?.status, {
        timeout: 15000,
      })
      .not.toBe("running");

    // The catalog knows the artifact, its producer, and which host holds its copy.
    const admin = (path: string) =>
      fetch(`${controlPlaneUrl}${path}`, { headers: { authorization: "Bearer test-admin" } });
    const listed = (await (await admin(`/api/v1/artifacts?task=${taskId}`)).json()) as {
      items: { metadata: { id: string }; spec: { attemptId: string; entries: unknown[] } }[];
    };
    expect(listed.items).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ id: attempt.artifactId }),
        spec: expect.objectContaining({
          entries: [expect.objectContaining({ digest, sizeBytes: bytes.byteLength })],
        }),
      }),
    ]);
    expect(
      await store.listArtifactStorageLocations({
        digest,
        sizeBytes: bytes.byteLength,
        status: "available",
      }),
    ).toEqual(
      advertise
        ? [expect.objectContaining({ workerHostId: "producer-host", transferBaseUrl })]
        : [],
    );
    const task = (await (await admin(`/api/v1/tasks/${taskId}`)).json()) as {
      status: { storage: { artifacts: { locations: unknown[] }[] } };
    };
    expect(task.status.storage.artifacts).toEqual([
      expect.objectContaining({
        locations: [
          {
            kind: "worker-host",
            workerHostId: "producer-host",
            ephemeral: false,
            removed: false,
          },
        ],
      }),
    ]);
    // Disconnecting changes reachability, not the catalog's record of who holds bytes.
    await connection.stop();
    connection = undefined;
    await expect
      .poll(async () => (await store.findWorkerHostById("producer-host"))?.connectionStatus)
      .not.toBe("connected");
    expect(
      await store.listArtifactStorageLocations({
        digest,
        sizeBytes: bytes.byteLength,
        status: "available",
      }),
    ).toEqual([]);
    const disconnected = await (await admin(`/api/v1/tasks/${taskId}`)).json();
    expect(disconnected.status.storage.artifacts).toEqual(task.status.storage.artifacts);
    const disconnectedList = await (await admin(`/api/v1/artifacts?task=${taskId}`)).json();
    expect(disconnectedList.items[0].status.locations).toEqual(
      task.status.storage.artifacts[0]?.locations,
    );
    // An operator cannot fetch the bytes from the Control Plane either.
    const content = await admin(
      `/api/v1/artifacts/${encodeURIComponent(attempt.artifactId)}/content?path=outputs%2Freport.bin`,
    );
    expect(content.status).toBe(404);
    expect(Buffer.from(await content.arrayBuffer()).includes(Buffer.from(canary))).toBe(false);

    // The bytes are on the Worker Host, intact.
    expect(
      Buffer.from(
        await new FileArtifactStore(hostCopies).get({
          uri: `supertag-artifact:sha256:${hex}`,
          digest,
        }),
      ),
    ).toEqual(bytes);
  } finally {
    await connection?.stop();
    await runtime?.close();
    await server?.close();
    await durable.shutdown("Test finished");
    await store.disconnect();
  }
  try {
    // Nothing the Control Plane wrote, its database and journals included, holds the bytes, and
    // it keeps no artifact directory.
    await expect(stat(join(controlPlaneState, "artifacts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const written = await filesUnder(controlPlaneState);
    expect(written.some((file) => file.endsWith("state.db"))).toBe(true);
    for (const file of written) {
      const content = await readFile(file);
      expect(content.includes(Buffer.from(canary)), file).toBe(false);
      expect(content.includes(bytes.subarray(canary.length, canary.length + 64)), file).toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
