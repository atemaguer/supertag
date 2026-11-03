import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactTransferGrantClaims, ResolvedArtifactTransfer } from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileArtifactStore,
  signArtifactTransferGrant,
  verifyArtifactTransferGrant,
  WorkletArtifactStore,
  WorkletArtifactTransferClient,
  WorkletArtifactTransferServer,
} from "./src/index.js";

const keys = generateKeyPairSync("ed25519");
const servers: WorkletArtifactTransferServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function claims(
  digest: string,
  sizeBytes: number,
  overrides: Partial<ArtifactTransferGrantClaims> = {},
): ArtifactTransferGrantClaims {
  const issuedAt = new Date();
  return {
    version: 1,
    grantId: "grant-1",
    artifactId: "artifact-1",
    path: "result.txt",
    digest,
    sizeBytes,
    sourceWorkerHostId: "producer-host",
    recipientWorkerHostId: "consumer-host",
    recipientConnectionGeneration: 7,
    taskId: "consumer-task",
    attemptId: "consumer-attempt",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("Worklet-hosted direct artifact transfer", () => {
  it("persists on the producer host and transfers directly after the producing Worker is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-worklet-artifacts-"));
    const producerDirectory = join(root, "producer", "artifacts");
    const producer = new FileArtifactStore(producerDirectory);
    const bytes = Buffer.from("durable result from a completed Worker");
    const stored = await producer.put({ bytes, mediaType: "text/plain" });
    const digest = stored.digest as string;

    // The serving process opens the same Worklet-owned state after the producer has exited.
    const server = new WorkletArtifactTransferServer({
      workerHostId: "producer-host",
      store: new FileArtifactStore(producerDirectory),
      verificationKey: keys.publicKey,
    });
    servers.push(server);
    const transferBaseUrl = await server.listen();
    const grant = signArtifactTransferGrant(claims(digest, bytes.byteLength), keys.privateKey);
    const resolved: ResolvedArtifactTransfer = {
      artifactId: "artifact-1",
      path: "result.txt",
      digest,
      sizeBytes: bytes.byteLength,
      locations: [
        {
          workerHostId: "producer-host",
          transferUrl: `${transferBaseUrl}/v1/artifacts/${stored.id}`,
          grant,
        },
      ],
      volumes: [],
      holders: { workerHostIds: ["producer-host"], volumes: [] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let resolutions = 0;
    const consumer = new WorkletArtifactStore({
      directory: join(root, "consumer", "artifacts"),
      resolve: async () => {
        resolutions++;
        return resolved;
      },
    });
    const ref = {
      ...stored,
      artifactId: "artifact-1",
      path: "result.txt",
    };

    await expect(consumer.get(ref)).resolves.toEqual(bytes);
    await writeFile(join(root, "consumer", "artifacts", "sha256", stored.id), "corrupt");
    await expect(consumer.get(ref)).resolves.toEqual(bytes);
    await server.close();
    await expect(consumer.get(ref)).resolves.toEqual(bytes);
    expect(resolutions).toBe(2);
    await expect(Array.fromAsync(consumer.inventory())).resolves.toEqual([
      { digest, sizeBytes: bytes.byteLength },
    ]);
  });

  it("rejects tampered, expired, wrong-source, and wrong-content bearer grants locally", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const valid = claims(digest, 1);
    const token = signArtifactTransferGrant(valid, keys.privateKey);
    expect(
      verifyArtifactTransferGrant(token, keys.publicKey, {
        sourceWorkerHostId: "producer-host",
        digest,
      }),
    ).toEqual(valid);
    expect(() =>
      verifyArtifactTransferGrant(`${token.slice(0, -1)}x`, keys.publicKey, {
        sourceWorkerHostId: "producer-host",
        digest,
      }),
    ).toThrow("signature");
    expect(() =>
      verifyArtifactTransferGrant(token, keys.publicKey, {
        sourceWorkerHostId: "other-host",
        digest,
      }),
    ).toThrow("another source");
    expect(() =>
      verifyArtifactTransferGrant(token, keys.publicKey, {
        sourceWorkerHostId: "producer-host",
        digest: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow("requested content");
    expect(() =>
      verifyArtifactTransferGrant(token, keys.publicKey, {
        sourceWorkerHostId: "producer-host",
        digest,
        now: new Date(Date.parse(valid.expiresAt) + 1),
      }),
    ).toThrow("expired");
  });

  it("falls back across locations and never publishes corrupt partial bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-worklet-transfer-corrupt-"));
    const destination = new FileArtifactStore(join(root, "artifacts"));
    const expected = Buffer.from("expected");
    const digest = `sha256:${createHash("sha256").update(expected).digest("hex")}`;
    const ref = {
      uri: `supertag-artifact:${digest}`,
      digest,
      artifactId: "artifact-1",
      path: "result.txt",
    };
    const requested: string[] = [];
    const client = new WorkletArtifactTransferClient({
      store: destination,
      fetch: async (input) => {
        requested.push(String(input));
        const body = String(input).includes("bad") ? Buffer.from("corrupt!") : expected;
        return new Response(body, {
          headers: {
            "content-length": String(expected.byteLength),
            "x-supertag-artifact-digest": digest,
          },
        });
      },
    });
    const locations = [
      {
        workerHostId: "bad",
        transferUrl: `https://bad.example/v1/artifacts/${digest.slice(7)}`,
        grant: "bad-grant",
      },
      {
        workerHostId: "good",
        transferUrl: `https://good.example/v1/artifacts/${digest.slice(7)}`,
        grant: "good-grant",
      },
    ];

    await expect(client.fetch(ref, locations, expected.byteLength)).resolves.toMatchObject({
      digest,
    });
    await expect(destination.get(ref)).resolves.toEqual(expected);
    expect(requested).toHaveLength(2);
    await expect(Array.fromAsync(destination.inventory())).resolves.toHaveLength(1);
  });

  it("publishes local content only after it is durably stored", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-worklet-publish-"));
    const seen: string[] = [];
    const store = new WorkletArtifactStore({
      directory: join(root, "artifacts"),
      resolve: async () => {
        throw new Error("local content must not resolve remotely");
      },
      publish: async ({ ref }) => {
        seen.push(Buffer.from(await store.local.get(ref)).toString("utf8"));
      },
    });

    const ref = await store.put({ bytes: Buffer.from("complete") });
    expect(seen).toEqual(["complete"]);
    await expect(store.get(ref)).resolves.toEqual(Buffer.from("complete"));
  });
});

describe("Worklet artifact reads from a shared Volume", () => {
  async function sharedVolume() {
    const root = await mkdtemp(join(tmpdir(), "supertag-shared-volume-"));
    // Another host wrote this copy to the Volume both hosts store artifacts on.
    const volume = new FileArtifactStore(join(root, "volume"));
    const bytes = Buffer.from("another host's artifact on the shared Volume");
    const stored = await volume.put({ bytes });
    const digest = stored.digest as string;
    const ref = { ...stored, artifactId: "artifact-1", path: "result.txt" };
    const resolved: ResolvedArtifactTransfer = {
      artifactId: "artifact-1",
      path: "result.txt",
      digest,
      sizeBytes: bytes.byteLength,
      locations: [],
      volumes: [
        {
          volume: "shared",
          source: "s3://team/hosts",
          credential: "team",
          key: `sha256/${stored.id}`,
        },
      ],
      holders: { workerHostIds: ["producer-host"], volumes: ["shared"] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    return { root, volume, bytes, ref, resolved };
  }

  it("asks the catalog before reading a copy another host wrote to the shared Volume", async () => {
    const { volume, bytes, ref, resolved } = await sharedVolume();
    const reads: string[] = [];
    let granted = false;
    const consumer = new WorkletArtifactStore({
      copies: volume,
      sharedCopies: true,
      resolve: async () => {
        if (!granted)
          throw Object.assign(new Error("Artifact is not an admitted input"), { statusCode: 403 });
        return resolved;
      },
      readVolume: async (location) => {
        reads.push(location.key);
        return bytes;
      },
    });
    // The bytes sit in this host's own store, yet without a grant nothing is read.
    await expect(consumer.get(ref)).rejects.toThrow("Artifact is not an admitted input");
    expect(reads).toEqual([]);
    granted = true;
    await expect(consumer.get(ref)).resolves.toEqual(bytes);
    expect(reads).toEqual([resolved.volumes[0]?.key]);
  });

  it("reads its own copies on the shared Volume without asking", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-shared-volume-own-"));
    let resolutions = 0;
    const producer = new WorkletArtifactStore({
      copies: new FileArtifactStore(join(root, "volume")),
      sharedCopies: true,
      resolve: async () => {
        resolutions++;
        throw new Error("unexpected resolution");
      },
    });
    const bytes = Buffer.from("written by this Attempt");
    const ref = await producer.put({ bytes });
    await expect(producer.get(ref)).resolves.toEqual(bytes);
    expect(resolutions).toBe(0);
  });

  it("falls back from a Volume this host cannot read to direct transfer", async () => {
    const { root, bytes, ref, resolved } = await sharedVolume();
    const producerDirectory = join(root, "producer");
    await new FileArtifactStore(producerDirectory).put({ bytes });
    const server = new WorkletArtifactTransferServer({
      workerHostId: "producer-host",
      store: new FileArtifactStore(producerDirectory),
      verificationKey: keys.publicKey,
    });
    servers.push(server);
    const transferBaseUrl = await server.listen();
    const consumer = new WorkletArtifactStore({
      directory: join(root, "consumer"),
      resolve: async () => ({
        ...resolved,
        locations: [
          {
            workerHostId: "producer-host",
            transferUrl: `${transferBaseUrl}/v1/artifacts/${ref.id}`,
            grant: signArtifactTransferGrant(
              claims(ref.digest as string, bytes.byteLength),
              keys.privateKey,
            ),
          },
        ],
      }),
      // No mapping for the Volume on this host.
      readVolume: async () => undefined,
    });
    await expect(consumer.get(ref)).resolves.toEqual(bytes);
  });

  it("names the hosts and Volumes holding it, and suggests a shared Volume, when none is reachable", async () => {
    const { root, ref, resolved } = await sharedVolume();
    const consumer = new WorkletArtifactStore({
      directory: join(root, "consumer"),
      resolve: async () => ({
        ...resolved,
        locations: [
          {
            workerHostId: "producer-host",
            transferUrl: `http://127.0.0.1:9/v1/artifacts/${ref.id}`,
            grant: "unused",
          },
        ],
      }),
      readVolume: async () => undefined,
    });
    await expect(consumer.get(ref)).rejects.toThrow(
      "Artifact artifact-1 file result.txt is unavailable to this Worker Host: it is held by Worker Host producer-host and on Volume shared, and this host can reach no copy. An artifact Volume shared with a host that holds it would make it reachable.",
    );
  });
});

describe("Operator transfer grants", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const operator = () => {
    const issuedAt = new Date();
    return {
      version: 1 as const,
      grantId: "grant-operator",
      artifactId: "artifact-1",
      path: "result.txt",
      digest,
      sizeBytes: 12,
      sourceWorkerHostId: "producer-host",
      recipientOperatorId: "token:alice",
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
    };
  };

  it("verifies a grant for one operator, bound to the file and source host", () => {
    const grant = signArtifactTransferGrant(operator(), keys.privateKey);
    expect(
      verifyArtifactTransferGrant(grant, keys.publicKey, {
        sourceWorkerHostId: "producer-host",
        digest,
      }),
    ).toMatchObject({ recipientOperatorId: "token:alice", artifactId: "artifact-1" });
    expect(() =>
      verifyArtifactTransferGrant(grant, keys.publicKey, {
        sourceWorkerHostId: "other-host",
        digest,
      }),
    ).toThrow("another source Worker Host");
    expect(() =>
      verifyArtifactTransferGrant(grant, keys.publicKey, {
        sourceWorkerHostId: "producer-host",
        digest,
        now: new Date(Date.now() + 61_000),
      }),
    ).toThrow("expired");
  });

  it("refuses claims naming both an operator and a Worker Host, or neither", () => {
    const both = { ...operator(), ...claims(digest, 12), recipientOperatorId: "token:alice" };
    expect(() => signArtifactTransferGrant(both, keys.privateKey)).toThrow(
      "Invalid artifact transfer grant claims",
    );
    const { recipientOperatorId: _recipient, ...neither } = operator();
    expect(() =>
      signArtifactTransferGrant(neither as unknown as ArtifactTransferGrantClaims, keys.privateKey),
    ).toThrow("Invalid artifact transfer grant claims");
    expect(() =>
      signArtifactTransferGrant({ ...operator(), recipientOperatorId: "" }, keys.privateKey),
    ).toThrow("Invalid artifact transfer grant recipientOperatorId");
  });
});
