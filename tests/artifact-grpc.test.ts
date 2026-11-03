import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { registerArtifactGrpcRoutes } from "../apps/cli/src/artifact-grpc.js";
import { artifactVolumeReader } from "../apps/cli/src/artifact-volume.js";
import { ArtifactCatalog, ObjectiveController } from "../packages/control-plane/src/index.js";
import {
  type AdmitTaskAssignmentInput,
  type ArtifactAcquisition,
  type ArtifactDiscoveryPage,
  type ArtifactTransferGrantClaims,
  artifactVolumeLabel,
  type CapturedArtifact,
  type TagContextPlan,
  TagMessagingError,
  type TaskAssignment,
} from "../packages/core/src/index.js";
import { FileArtifactStore } from "../packages/runtime/sdk/src/index.js";
import {
  GrpcArtifactCatalogClient,
  GrpcArtifactHostClient,
} from "../packages/runtime/transport/src/artifact-client.js";
import { ArtifactCatalogService } from "../packages/runtime/transport/src/artifact-codec.js";
import {
  type RemoteWorkletServer,
  startWorkletGrpcServer,
} from "../packages/runtime/transport/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const transportRequire = createRequire(
  new URL("../packages/runtime/transport/package.json", import.meta.url),
);
const { createClient } = transportRequire("@connectrpc/connect");
const { createGrpcTransport } = transportRequire("@connectrpc/connect-node");

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !process.env["SUPERTAG_POSTGRES_URL"])(
    `${dialect} artifact catalog gRPC`,
    () => {
      const cleanup: (() => Promise<void>)[] = [];
      afterEach(async () => {
        for (const close of cleanup.splice(0).reverse()) await close();
      });

      async function fixture(shared = false) {
        const directory = await mkdtemp(join(tmpdir(), "artifact-catalog-grpc-"));
        cleanup.push(() => rm(directory, { recursive: true, force: true }));
        const pg =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(process.env["SUPERTAG_POSTGRES_URL"] as string)
            : undefined;
        if (pg) cleanup.push(pg.cleanup);
        const url = pg?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        let store = new DrizzleStore({ url });
        await store.connect();
        cleanup.push(() => store.disconnect());
        const owner = await store.createTag({ name: "owner" });
        const researcher = await store.createTag({ name: "researcher" });
        const engineer = await store.createTag({ name: "engineer" });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Reuse previous work",
        });
        const team = await store.createTeam(
          {
            id: randomUUID(),
            objectiveId: objective.id,
            name: "product",
            leadTagId: owner.id,
            memberTagIds: [researcher.id, engineer.id],
            maxConcurrency: 10,
          },
          owner.id,
        );
        for (const id of ["host-a", "host-b"]) {
          await store.enrollWorkerHost({
            id,
            credentialId: `credential/${id}`,
            enrolledAt: new Date().toISOString(),
          });
          await store.claimWorkerHostConnection({
            workerHostId: id,
            credentialRevision: 1,
            workletId: `worklet-${id}`,
            protocolVersion: 17,
            workerSnapshot: { labels: shared ? [artifactVolumeLabel("shared")] : [] },
            capacity: 10,
            availableSlots: 10,
            activeAttempts: 0,
            ready: true,
            observedAt: new Date().toISOString(),
          });
        }
        const callers = new Map<string, TaskAssignment>();
        const attempts = new Map<string, string>();
        async function worker(
          token: string,
          tag = engineer,
          teamId = team.id,
          contextPlan?: TagContextPlan,
          inputArtifacts?: AdmitTaskAssignmentInput["inputArtifacts"],
          targetObjectiveId = objective.id,
        ) {
          const at = new Date().toISOString();
          const assignment = await store.admitTaskAssignment({
            taskId: randomUUID(),
            objectiveId: targetObjectiveId,
            teamId,
            assignedTagId: tag.id,
            requestedByTagId: owner.id,
            ...(inputArtifacts ? { inputArtifacts } : {}),
            instruction: "Use recorded work",
            acceptanceCriteria: ["Evidence"],
            execution: {},
            workspacePlan: { version: 1, status: "none" },
            contextPlan: contextPlan ?? { version: 7, capturedAt: at, sets: [] },
            authorizationSnapshot: {
              version: 4,
              capturedAt: at,
              tag: { id: tag.id, name: tag.name },
              origin: {
                kind: "internal",
                objectiveId: targetObjectiveId,
                requestedByTagId: owner.id,
              },
              requester: { id: owner.id, kind: "bot" },
              permissionSets: [],
              resources: [],
              runtimeActions: [],
            },
          });
          const attempt = await store.createTaskAttempt({
            taskId: assignment.taskId,
            attemptNumber: 1,
            workerProfile: { id: "test", revision: "1" },
            workerSnapshot: {
              workerHostId: tag.id === researcher.id ? "host-a" : "host-b",
              connectionGeneration: 1,
            },
            startedAt: at,
          });
          callers.set(token, { ...assignment, attemptCount: 1 });
          attempts.set(token, attempt.id);
          return assignment;
        }
        const source = await worker("writer", researcher);
        const consumer = await worker("reader");
        let coordinator = new ObjectiveController(store, undefined);
        const authority = {
          async authenticateExecution(token: string | undefined) {
            const caller = callers.get(token ?? "");
            if (!caller) throw new TagMessagingError(401, "Expired Attempt");
            return caller;
          },
          authorizeArtifactSource: (
            ...args: Parameters<ObjectiveController["authorizeArtifactSource"]>
          ) => coordinator.authorizeArtifactSource(...args),
          artifactDiscoveryTaskIds: (
            ...args: Parameters<ObjectiveController["artifactDiscoveryTaskIds"]>
          ) => coordinator.artifactDiscoveryTaskIds(...args),
        };
        const signed: ArtifactTransferGrantClaims[] = [];
        const grants = {
          sign(claims: ArtifactTransferGrantClaims) {
            signed.push(claims);
            return `grant-${claims.grantId}`;
          },
        };
        let catalog = new ArtifactCatalog(store, authority, grants);
        let accepting = true;
        const openListener = (port = 0) =>
          startWorkletGrpcServer({
            port,
            remote: {} as RemoteWorkletServer,
            registerRoutes: (router) =>
              registerArtifactGrpcRoutes(router, catalog, {
                beginRequest: () => {
                  if (!accepting) throw new Error("draining");
                  return () => {};
                },
                directTransfers: {
                  publicKey: "public-key",
                  authenticateWorkerHost: async (id, token) => {
                    const host = await store.findWorkerHostById(id);
                    return token === `token-${id}` &&
                      host?.enrollmentStatus === "active" &&
                      host.connectionStatus === "connected"
                      ? host
                      : undefined;
                  },
                },
              }),
          });
        let listener = await openListener();
        cleanup.push(() => listener.close());
        const baseUrl = listener.url;
        const client = (token: string) => new GrpcArtifactCatalogClient({ baseUrl, token });
        const host = (workerHostId = "host-a", token = `token-${workerHostId}`) =>
          new GrpcArtifactHostClient({ baseUrl, token, workerHostId });
        async function capture() {
          const bytes = Buffer.from("Artifact evidence");
          const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          const writer = client("writer");
          await writer.recordUpload({ digest, sizeBytes: bytes.length });
          const definition = {
            operationId: "capture-1",
            title: "Evidence",
            kind: "research",
            harnessSession: { harnessId: "codex", id: "native-thread" },
            entries: [
              {
                path: "result.txt",
                uri: `supertag-artifact:${digest}`,
                digest,
                sizeBytes: bytes.length,
              },
            ],
          };
          const { artifact } = await writer.request<{ artifact: CapturedArtifact }>(
            "capture",
            definition,
          );
          return { artifact, definition, digest, bytes };
        }
        return {
          get store() {
            return store;
          },
          client,
          host,
          capture,
          callers,
          signed,
          source,
          consumer,
          attempts,
          baseUrl,
          async restart() {
            await listener.close();
            await store.disconnect();
            store = new DrizzleStore({ url });
            await store.connect();
            coordinator = new ObjectiveController(store, undefined);
            catalog = new ArtifactCatalog(store, authority, grants);
            listener = await openListener(Number(new URL(baseUrl).port));
          },
          drain() {
            accepting = false;
          },
        };
      }

      it("preserves capture identity and native provenance across listener/database restart", async () => {
        const f = await fixture();
        const { artifact, definition } = await f.capture();
        await f.restart();
        const duplicate = await f
          .client("writer")
          .request<{ artifact: CapturedArtifact }>("capture", definition);
        expect(duplicate.artifact).toEqual(artifact);
        await expect(
          f.client("writer").request("capture", { ...definition, title: "changed" }),
        ).rejects.toThrow();
        const found = await f.client("reader").request<ArtifactDiscoveryPage>("find", { limit: 1 });
        expect(found.artifacts[0]?.harnessSession).toEqual(definition.harnessSession);
        expect(found.artifacts[0]).not.toHaveProperty("entries");
        const inspected = await f
          .client("reader")
          .request<{ artifact: CapturedArtifact }>("inspect", { artifactId: artifact.id });
        expect(inspected.artifact).toEqual(artifact);
      });

      it("acquires and settles exact metadata and grants direct transfer only after admission", async () => {
        const f = await fixture();
        const { artifact, digest, bytes } = await f.capture();
        await f.host().registerCopies({
          inventoryRevision: 1,
          transferBaseUrl: "https://host-a.example",
          copies: [{ digest, sizeBytes: bytes.length }],
        });
        const reader = f.client("reader");
        await expect(
          reader.resolveTransfer({ artifactId: artifact.id, path: "result.txt" }),
        ).rejects.toThrow();
        const input = {
          operationId: "read-1",
          artifactId: artifact.id,
          paths: ["result.txt"],
          delivery: "read",
        };
        const acquired = await reader.request<{
          artifact: CapturedArtifact;
          acquisition: ArtifactAcquisition;
        }>("acquire", input);
        const replay = await reader.request<typeof acquired>("acquire", input);
        expect(replay).toEqual(acquired);
        const resolved = await reader.resolveTransfer({
          artifactId: artifact.id,
          path: "result.txt",
        });
        expect(resolved).toMatchObject({
          artifactId: artifact.id,
          digest,
          sizeBytes: bytes.length,
          locations: [
            {
              workerHostId: "host-a",
              transferUrl: expect.stringContaining("host-a.example"),
              grant: expect.any(String),
            },
          ],
        });
        expect(f.signed[0]).toMatchObject({
          taskId: f.consumer.taskId,
          attemptId: f.attempts.get("reader"),
          recipientWorkerHostId: "host-b",
          recipientConnectionGeneration: 1,
          sourceWorkerHostId: "host-a",
        });
        const settled = await reader.request<{ acquisition: ArtifactAcquisition }>("settle", {
          id: acquired.acquisition.id,
          status: "delivered",
        });
        expect(settled.acquisition.status).toBe("delivered");
        expect(await f.host().getTransferKey()).toEqual({
          algorithm: "Ed25519",
          publicKey: "public-key",
        });
        f.callers.delete("reader");
        await expect(
          reader.resolveTransfer({ artifactId: artifact.id, path: "result.txt" }),
        ).rejects.toThrow();
      });

      it("separates host inventory credentials from Attempt catalog authority", async () => {
        const f = await fixture();
        const { artifact, digest, bytes } = await f.capture();
        await expect(
          f.client("token-host-a").request("inspect", { artifactId: artifact.id }),
        ).rejects.toThrow();
        await expect(
          f.host("host-a", "writer").registerCopies({
            inventoryRevision: 1,
            transferBaseUrl: "https://host-a.example",
            copies: [{ digest, sizeBytes: bytes.length }],
          }),
        ).rejects.toThrow();
        const inventory = {
          inventoryRevision: 3,
          transferBaseUrl: "https://host-a.example",
          copies: [{ digest, sizeBytes: bytes.length }],
        };
        const registered = await f.host().registerCopies(inventory);
        expect(registered).toEqual({
          accepted: true,
          connectionGeneration: 1,
          inventoryRevision: 3,
        });
        expect(await f.host().registerCopies({ ...inventory, inventoryRevision: 2 })).toMatchObject(
          { accepted: false },
        );
        f.callers.delete("reader");
        await expect(
          f.client("reader").request("inspect", { artifactId: artifact.id }),
        ).rejects.toThrow();
      });

      it("isolates a forged shared-Volume receipt from the victim Attempt's bytes", async () => {
        const f = await fixture(true);
        const directory = await mkdtemp(join(tmpdir(), "artifact-volume-isolation-"));
        cleanup.push(() => rm(directory, { recursive: true, force: true }));
        const { volume } = await f.store.applyVolume({
          name: "shared",
          source: pathToFileURL(directory).href,
          credential: "team",
        });
        const { artifact: victim, definition, digest, bytes } = await f.capture();
        const receipt = {
          digest,
          sizeBytes: bytes.length,
          volume: volume.name,
          volumeSource: volume.source,
        };
        await f.client("writer").recordUpload(receipt);
        // Mallory knows only the digest, advertises the same Volume, and reports a fake upload.
        await f.client("reader").recordUpload(receipt);
        const { artifact: forged } = await f
          .client("reader")
          .request<{ artifact: CapturedArtifact }>("capture", definition);
        const copies = await f.store.listArtifactVolumeLocations({
          digest,
          sizeBytes: bytes.length,
        });
        const victimKey = `attempts/${victim.attemptId}/sha256/${digest.slice(7)}`;
        const forgedKey = `attempts/${forged.attemptId}/sha256/${digest.slice(7)}`;
        expect(copies.map((copy) => copy.key).sort()).toEqual([victimKey, forgedKey].sort());
        const catalog = new ArtifactCatalog(f.store, {} as never);
        // Only the victim wrote bytes. Both operator and worker reads of the forged artifact
        // must stay in Mallory's empty namespace, even with the shared Volume mapped.
        const ref = await new FileArtifactStore(join(directory, "attempts", victim.attemptId)).put({
          bytes,
        });
        const read = artifactVolumeReader({
          readVolumeCredential: async () => ({ path: directory }),
        });
        await f.client("reader").request("acquire", {
          operationId: "read-forged",
          artifactId: forged.id,
          paths: ["result.txt"],
          delivery: "read",
        });
        const operator = await catalog.resolveOperatorDownload("operator", forged.id, {
          path: "result.txt",
        });
        const worker = await f
          .client("reader")
          .resolveTransfer({ artifactId: forged.id, path: "result.txt" });
        for (const resolved of [operator, worker]) {
          expect(resolved.volumes.map((copy) => copy.key)).toEqual([forgedKey]);
          for (const location of resolved.volumes)
            await expect(read(location, ref, bytes.length)).rejects.toMatchObject({
              code: "ENOENT",
            });
        }
        const authorized = await catalog.resolveOperatorDownload("operator", victim.id, {
          path: "result.txt",
        });
        const victimLocation = authorized.volumes[0];
        if (!victimLocation) throw new Error("Missing victim copy");
        expect(Buffer.from((await read(victimLocation, ref, bytes.length)) ?? [])).toEqual(bytes);
        // The storage boundary refuses a host claiming another host's Attempt namespace.
        await expect(
          f.store.recordArtifactVolumeCopy({
            volumeId: volume.id,
            source: volume.source,
            key: victimKey,
            digest,
            sizeBytes: bytes.length,
            workerHostId: "host-b",
            observedAt: new Date().toISOString(),
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(
          (await f.store.listArtifactVolumeLocations({ digest, sizeBytes: bytes.length }))
            .filter((copy) => copy.key === victimKey)
            .map((copy) => copy.workerHostId),
        ).toEqual(["host-a"]);
      });

      it("records a copy on the artifact Volume its Attempt's host advertises, at the digest's key", async () => {
        const f = await fixture();
        const { volume } = await f.store.applyVolume({
          name: "artifacts",
          source: "s3://team-artifacts/hosts",
          credential: "team",
        });
        const bytes = Buffer.from("Artifact on a Volume");
        const hex = createHash("sha256").update(bytes).digest("hex");
        const receipt = {
          digest: `sha256:${hex}`,
          sizeBytes: bytes.length,
          volume: "artifacts",
          volumeSource: volume.source,
        };
        // A host reads only the Volume it advertises as its artifact Volume, with its own credential.
        await expect(f.host("host-a").getArtifactVolume("artifacts")).rejects.toThrow(
          /does not advertise Volume artifacts as its artifact Volume/u,
        );
        await expect(f.client("writer").recordUpload(receipt)).rejects.toThrow(
          "Artifact catalog upload failed (403)",
        );
        await f.store.claimWorkerHostConnection({
          workerHostId: "host-a",
          credentialRevision: 1,
          workletId: "worklet-host-a",
          protocolVersion: 17,
          workerSnapshot: { labels: [artifactVolumeLabel("artifacts")] },
          capacity: 10,
          availableSlots: 10,
          activeAttempts: 0,
          ready: true,
          observedAt: new Date().toISOString(),
        });
        expect(await f.host("host-a").getArtifactVolume("artifacts")).toEqual({
          name: "artifacts",
          source: "s3://team-artifacts/hosts",
          credential: "team",
        });
        await expect(f.host("host-a", "writer").getArtifactVolume("artifacts")).rejects.toThrow();
        await expect(f.host("host-b").getArtifactVolume("artifacts")).rejects.toThrow();
        // No copies exist yet: changing A to B is allowed, but A's receipt cannot claim B.
        await f.store.applyVolume({
          name: volume.name,
          source: "s3://team-artifacts/replacement",
          credential: "team",
        });
        await expect(f.client("writer").recordUpload(receipt)).rejects.toThrow(
          "Artifact catalog upload failed (409)",
        );
        expect(
          await f.store.listArtifactVolumeLocations({
            digest: receipt.digest,
            sizeBytes: bytes.length,
          }),
        ).toEqual([]);
        const [writerAttempt] = await f.store.listTaskAttempts(f.source.taskId);
        if (!writerAttempt) throw new Error("Missing writer Attempt");
        expect(
          await f.store.hasArtifactUpload({
            attemptId: writerAttempt.id,
            digest: receipt.digest,
            sizeBytes: bytes.length,
          }),
        ).toBe(false);
        await expect(
          f
            .client("writer")
            .recordUpload({ digest: receipt.digest, sizeBytes: bytes.length, volume: volume.name }),
        ).rejects.toThrow("Artifact catalog upload failed (400)");
        await f.store.applyVolume({ name: volume.name, source: volume.source, credential: "team" });
        await f.client("writer").recordUpload(receipt);
        expect(
          await f.store.listArtifactVolumeLocations({
            digest: receipt.digest,
            sizeBytes: bytes.length,
          }),
        ).toEqual([
          expect.objectContaining({
            volumeId: volume.id,
            key: `attempts/${writerAttempt.id}/sha256/${hex}`,
            workerHostId: "host-a",
            status: "available",
          }),
        ]);
        expect(await f.store.listVolumeIdsHoldingArtifacts()).toEqual([volume.id]);
        // host-b's Attempt cannot claim a copy on a Volume host-b does not store artifacts on.
        await expect(f.client("reader").recordUpload(receipt)).rejects.toThrow(
          "Artifact catalog upload failed (403)",
        );
        await expect(
          f.client("writer").recordUpload({ ...receipt, volume: "../artifacts" }),
        ).rejects.toThrow("Artifact catalog upload failed (400)");
      });

      it("rejects malformed metadata and unavailable authority before state changes", async () => {
        const f = await fixture();
        await expect(
          f.client("writer").recordUpload({ digest: "invalid", sizeBytes: 1 }),
        ).rejects.toThrow();
        await expect(
          f
            .client("writer")
            .recordUpload({ digest: `sha256:${"a".repeat(64)}`, sizeBytes: 32 * 1024 * 1024 + 1 }),
        ).rejects.toThrow();
        await expect(f.client("writer").request("find", { limit: 0 })).rejects.toThrow();
        await expect(
          f.client("writer").request("capture", {
            operationId: "x",
            title: "x",
            kind: "x",
            entries: [],
            taskId: "forged",
          }),
        ).rejects.toThrow();
        f.drain();
        await expect(f.client("writer").request("find", {})).rejects.toThrow();
      });

      it("requires bounded deadlines for metadata calls", async () => {
        const f = await fixture();
        const raw = createClient(
          ArtifactCatalogService,
          createGrpcTransport({ baseUrl: f.baseUrl }),
        );
        await expect(
          raw.find({}, { headers: { authorization: "Bearer reader" } }),
        ).rejects.toMatchObject({ code: 3 });
        await expect(
          raw.find({}, { headers: { authorization: "Bearer reader" }, timeoutMs: 120_000 }),
        ).rejects.toMatchObject({ code: 3 });
      });
    },
  );
}
