import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { artifactVolumeReader } from "../apps/cli/src/artifact-volume.js";
import { runArtifactCommand } from "../apps/cli/src/artifacts.js";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { HostServiceWorklet, hostArtifactVolumeStore } from "../apps/cli/src/worker.js";
import {
  COORDINATION_CAPABILITY,
  DurableLocalWorklet,
  FileArtifactStore,
  FileAttemptJournal,
  SURFACE_COORDINATION_CAPABILITY,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { openTestTask } from "./support/artifact-producer.js";
import { FakeS3 } from "./support/fake-s3.ts";
import { hostArtifactStore } from "./support/host-artifact-store.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

afterEach(() => vi.unstubAllEnvs());

const ACCESS_KEY = "AKIASHAREDVOLUME0001";
const SECRET_KEY = "shared-volume-secret-0123456789abcdef";

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
  return files;
}

interface Entry {
  readonly path: string;
  readonly uri: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

/**
 * Two Worker Hosts that cannot reach each other: neither runs a transfer endpoint, so the catalog
 * has no host to name for a direct download. Both map the same artifact Volume (here the local
 * fake S3), so the consumer reads the producer's copy there, with its own mapping and only after
 * the Control Plane checks its grant. A third host that maps no shared Volume gets an error naming
 * where the artifact is. The Control Plane never holds the bytes or the Volume's credential.
 */
it("shares an artifact between two unreachable Worker Hosts through a shared Volume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-shared-volume-transfer-"));
  vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "worker-state"));
  const controlPlaneState = join(directory, "control-plane");
  const databaseUrl = `file:${join(controlPlaneState, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  const s3 = await FakeS3.start(ACCESS_KEY);
  s3.bucket("team-artifacts");
  await store.applyVolume({
    name: "shared",
    source: `s3://team-artifacts/hosts?region=us-east-1&endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`,
    credential: "team-artifacts",
  });
  const producerTag = await store.createTag({ name: "Producer" });
  const consumerTag = await store.createTag({ name: "Consumer" });
  const isolatedTag = await store.createTag({ name: "Isolated" });
  await store.bindTagWorkerHost(producerTag.id, "producer-host");
  await store.bindTagWorkerHost(consumerTag.id, "consumer-host");
  await store.bindTagWorkerHost(isolatedTag.id, "isolated-host");
  await store.createTeam({
    id: "team",
    name: "Sharing",
    memberTagIds: [producerTag.id, consumerTag.id, isolatedTag.id],
    maxConcurrency: 3,
  });
  await store.createObjective({
    id: "share",
    ownerTagId: producerTag.id,
    teamId: "team",
    outcome: "Share",
  });
  /** Which part of the exchange each dispatched Task plays. */
  const roles = new Map<string, "produce" | "consume" | "isolated">();

  const canary = `shared-volume-canary-${randomUUID()}`;
  const report = Buffer.concat([Buffer.from(canary), randomBytes(4096)]);
  const reportHex = createHash("sha256").update(report).digest("hex");
  // A second artifact on the same Volume that the consumer is never granted.
  const secret = Buffer.concat([Buffer.from(`ungranted-${canary}`), randomBytes(1024)]);
  const secretHex = createHash("sha256").update(secret).digest("hex");

  // Each host maps the Volume's credential name to its own secret, read only on that host.
  const credentialReads: Record<string, string[]> = {};
  const hostSecret = (host: string) => async (name: string) => {
    credentialReads[host] = [...(credentialReads[host] ?? []), name];
    return JSON.stringify({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
  };
  const hostCredentials: Record<string, string> = {};
  let controlPlaneUrl = "";
  const volumeCopies = (host: string) =>
    hostArtifactVolumeStore({
      name: "shared",
      readCredential: hostSecret(host),
      token: hostCredentials[host] ?? "",
      workerHostId: host,
      controlPlane: controlPlaneUrl,
    });
  const produced: Record<string, string> = {};
  const consumed: {
    report?: Buffer;
    ungranted?: string;
    unavailable?: string;
    secretReads?: number;
  } = {};
  const errors: unknown[] = [];

  const catalog = async <T>(spec: TaskAttemptSpec, operation: string, body: unknown) => {
    const coordination = spec.coordination;
    if (!coordination) throw new Error("Missing Attempt coordination");
    const response = await fetch(`${controlPlaneUrl}/internal/v1/artifacts/catalog/${operation}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${coordination.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as T;
  };
  const input = async (spec: TaskAttemptSpec, artifactId: string) => {
    const { artifact } = await catalog<{ artifact: { entries: Entry[] } }>(spec, "inspect", {
      artifactId,
    });
    const entry = artifact.entries[0];
    if (!entry) throw new Error("Missing input entry");
    return { uri: entry.uri, digest: entry.digest, artifactId, path: entry.path };
  };
  const run = async (spec: TaskAttemptSpec) => {
    const role = roles.get(spec.taskId);
    if (role === "produce") {
      const host = hostArtifactStore(volumeCopies("producer-host"), { volume: "shared" })(spec);
      for (const [name, bytes] of [
        ["report", report],
        ["secret", secret],
      ] as const) {
        const ref = await host.put({ bytes });
        const { artifact } = await catalog<{ artifact: { id: string } }>(spec, "capture", {
          operationId: name,
          title: name,
          kind: "report",
          entries: [
            {
              path: `outputs/${name}.bin`,
              uri: ref.uri,
              digest: ref.digest,
              sizeBytes: bytes.length,
            },
          ],
        });
        produced[name] = artifact.id;
      }
      return;
    }
    if (role === "consume") {
      // The consumer's own store is the shared Volume itself, so the ungranted copy is right
      // there; reading it still needs the catalog's grant.
      const host = hostArtifactStore(volumeCopies("consumer-host"), {
        volume: "shared",
        readVolume: artifactVolumeReader({
          artifactVolume: { name: "shared", readCredential: hostSecret("consumer-host") },
        }),
      })(spec);
      consumed.report = Buffer.from(await host.get(await input(spec, produced["report"] ?? "")));
      const before = s3.downloads.length;
      await host
        .get({
          uri: `supertag-artifact:sha256:${secretHex}`,
          digest: `sha256:${secretHex}`,
          artifactId: produced["secret"] ?? "",
          path: "outputs/secret.bin",
        })
        .then(
          () => {
            consumed.ungranted = "read";
          },
          (error: unknown) => {
            consumed.ungranted = error instanceof Error ? error.message : String(error);
          },
        );
      consumed.secretReads = s3.downloads
        .slice(before)
        .filter((request) => request.key?.endsWith(secretHex)).length;
      return;
    }
    if (role === "isolated") {
      // This host keeps copies under its state directory and maps no shared Volume.
      const host = hostArtifactStore(new FileArtifactStore(join(directory, "isolated")), {
        readVolume: artifactVolumeReader({}),
      })(spec);
      await host.get(await input(spec, produced["report"] ?? "")).then(
        () => {
          consumed.unavailable = "read";
        },
        (error: unknown) => {
          consumed.unavailable = error instanceof Error ? error.message : String(error);
        },
      );
    }
  };
  const worker = (id: string): Worker => ({
    async describe() {
      const profile = { id: "deterministic", revision: "1" };
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
        id,
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
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId };
      const at = () => new Date().toISOString();
      const role = roles.get(spec.taskId);
      yield { ...identity, at: at(), type: "execution.started", workerId: id };
      try {
        await run(spec);
      } catch (error) {
        errors.push(error);
        throw error;
      }
      yield {
        ...identity,
        at: at(),
        type: "output.message",
        message: { role: "teammate", text: `${role} done` },
      };
      // The producer's result selects the report, so it can be another Task's input.
      if (role === "produce")
        yield {
          ...identity,
          at: at(),
          type: "result",
          result: {
            summary: "Report captured on the shared Volume",
            decisions: [],
            changes: [],
            unresolved: [],
            findings: [],
            references: [],
            artifacts: [{ artifactId: produced["report"] ?? "", paths: ["outputs/report.bin"] }],
          },
        };
      yield { ...identity, at: at(), type: "execution.completed" };
    },
  });

  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  const connections: Awaited<ReturnType<typeof connectWorklet>>[] = [];
  const durables: DurableLocalWorklet[] = [];
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
    for (const [host, artifactVolume] of [
      ["producer-host", "shared"],
      ["consumer-host", "shared"],
      ["isolated-host", undefined],
    ] as const) {
      hostCredentials[host] = await enrollWorkerHost(controlPlaneUrl, "test-admin", host);
      // No transfer endpoint on any host: they cannot reach each other.
      const worklet = new HostServiceWorklet(
        `${host}-worklet`,
        host,
        [worker(host)],
        {},
        [],
        undefined,
        undefined,
        artifactVolume,
      );
      const durable = new DurableLocalWorklet(
        worklet,
        new FileAttemptJournal(join(directory, `${host}-journal`)),
      );
      durables.push(durable);
      connections.push(
        await connectWorklet({
          url: `${controlPlaneUrl.replace(/^http/u, "ws")}/worklets`,
          credential: hostCredentials[host] ?? "",
          worklet,
          durableWorklet: durable,
          reconnectIntervalMs: 20,
        }),
      );
    }
    /** One Session turn of a Team member under the shared Objective, which dispatch picks up. */
    const turn = async (
      role: "produce" | "consume" | "isolated",
      tag: { id: string; name: string },
      inputArtifacts?: readonly Record<string, unknown>[],
    ) => {
      const { task } = await openTestTask(store, {
        tagId: tag.id,
        tagName: tag.name,
        objectiveId: "share",
        requestText: `${role} the report`,
        ...(inputArtifacts ? { trigger: { inputArtifacts: [...inputArtifacts] } } : {}),
      });
      roles.set(task.id, role);
      return task.id;
    };
    const completed = (taskId: string) =>
      expect
        .poll(async () => (await store.findTaskById(taskId))?.status, { timeout: 20000 })
        .toBe("completed");
    /** The producer's pinned entry for one of its captured files. */
    const pin = async (artifactId: string, path: string) => {
      const artifact = await store.findCapturedArtifact(artifactId);
      const entry = artifact?.entries.find((candidate) => candidate.path === path);
      if (!artifact || !entry) throw new Error(`Missing ${path} of artifact ${artifactId}`);
      return {
        artifactId,
        path,
        uri: entry.uri,
        digest: entry.digest,
        sizeBytes: entry.sizeBytes,
        provenance: { taskId: artifact.taskId, attemptId: artifact.attemptId },
      };
    };

    const produceTaskId = await turn("produce", producerTag);
    await completed(produceTaskId);
    expect(errors).toEqual([]);
    const reportId = produced["report"];
    if (!reportId) throw new Error("The producer did not capture the report");
    const reportArtifact = await store.findCapturedArtifact(reportId);
    if (!reportArtifact) throw new Error("Missing report artifact");
    // The producer wrote both copies to the shared Volume, and no host advertises a transfer
    // endpoint for them.
    expect(
      Buffer.from(
        s3.object(
          "team-artifacts",
          `hosts/attempts/${reportArtifact.attemptId}/sha256/${reportHex}`,
        ) ?? [],
      ),
    ).toEqual(report);
    expect(
      await store.listArtifactStorageLocations({
        digest: `sha256:${reportHex}`,
        sizeBytes: report.length,
      }),
    ).toEqual([]);

    const pinned = [await pin(reportId, "outputs/report.bin")];
    const consumeTaskId = await turn("consume", consumerTag, pinned);
    const isolatedTaskId = await turn("isolated", isolatedTag, pinned);
    await completed(consumeTaskId);
    await completed(isolatedTaskId);
    expect(errors).toEqual([]);

    // The consumer read the producer's copy from the shared Volume with its own mapping.
    expect(consumed.report).toEqual(report);
    expect(credentialReads["consumer-host"]).toContain("team-artifacts");
    // The ungranted artifact's bytes are on the same Volume, yet the catalog refused before any
    // read of them.
    expect(consumed.ungranted).toMatch(/not an admitted input/u);
    expect(consumed.secretReads).toBe(0);
    // A host with no shared Volume learns where the artifact is and how to reach it.
    expect(consumed.unavailable).toContain(
      `Artifact ${reportId} file outputs/report.bin is unavailable to this Worker Host: it is held by Worker Host producer-host and on Volume shared`,
    );
    expect(consumed.unavailable).toContain(
      "An artifact Volume shared with a host that holds it would make it reachable.",
    );

    // The operator's machine reads the same copy with its own mapping for the Volume's credential.
    const operator = new ControlPlaneClient({ url: controlPlaneUrl, token: "test-admin" });
    const saved = join(directory, "operator-report.bin");
    expect(
      await runArtifactCommand(
        operator,
        "download",
        [reportId, "--path", "outputs/report.bin", "--out", saved],
        { readVolumeCredential: hostSecret("operator") },
      ),
    ).toContain("digest verified");
    expect(await readFile(saved)).toEqual(report);
    // Only the operator's own mapping for that one credential name was read.
    expect(new Set(credentialReads["operator"])).toEqual(new Set(["team-artifacts"]));
    // Without a mapping, nothing is written and the report says where the copies are.
    const unmapped = join(directory, "unmapped.bin");
    await expect(
      runArtifactCommand(
        operator,
        "download",
        [reportId, "--path", "outputs/report.bin", "--out", unmapped],
        {
          readVolumeCredential: async (name) => {
            throw new Error(`No volume-credentials entry on this machine maps ${name}`);
          },
        },
      ),
    ).rejects.toThrow(
      /can reach no copy[\s\S]*Copies are held by Worker Host producer-host, Volume shared\.[\s\S]*maps no volume-credentials entry team-artifacts/u,
    );
    await expect(readFile(unmapped)).rejects.toMatchObject({ code: "ENOENT" });
    // Listings say where each copy is: on the shared Volume, never on the Control Plane.
    const listed = JSON.parse(
      await runArtifactCommand(operator, "list", ["--task", produceTaskId]),
    ) as { artifacts: { id: string; copies: unknown; ephemeralOnly?: boolean }[] };
    const listedReport = listed.artifacts.find((item) => item.id === reportId);
    expect(listedReport?.copies).toEqual([{ volume: { volume: "shared" } }]);
    expect(listedReport?.ephemeralOnly).toBeUndefined();
  } finally {
    for (const connection of connections) await connection.stop();
    await runtime?.close();
    for (const durable of durables) await durable.shutdown("Test finished");
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
}, 60000);
