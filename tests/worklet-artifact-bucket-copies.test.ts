import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { S3ArtifactStore } from "../packages/runtime/sdk/src/artifact-store.js";
import {
  signArtifactTransferGrant,
  WorkletArtifactStore,
  WorkletArtifactTransferServer,
} from "../packages/runtime/sdk/src/index.js";
import { FakeS3 } from "./support/fake-s3.ts";

const ACCESS_KEY = "AKIAVOLUMEARTIFACTS01";
const SECRET_KEY = "artifact-volume-secret-value-0123456789";

const digestOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A Worker Host keeps its artifact copies in an S3-compatible bucket; no Control Plane is involved. */
describe("Worklet artifact copies in a bucket", () => {
  let s3: FakeS3;
  const bucketStore = (prefix: string) =>
    new S3ArtifactStore({
      bucket: "supertag-artifacts",
      prefix,
      region: "us-east-1",
      endpoint: s3.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });

  beforeEach(async () => {
    s3 = await FakeS3.start(ACCESS_KEY);
    s3.bucket("supertag-artifacts");
  });
  afterEach(async () => {
    await s3.close();
  });

  it("keeps a distributed Worklet's copies on a Volume and serves them to peers", async () => {
    const consumerStore = bucketStore("consumer");
    const published: number[] = [];
    const producer = new WorkletArtifactStore({
      copies: bucketStore("producer"),
      resolve: async () => {
        throw new Error("the producer holds its own copy");
      },
      publish: async ({ sizeBytes }) => {
        published.push(sizeBytes);
      },
    });
    const bytes = Buffer.from("a Worklet copy that outlives its host");
    const stored = await producer.put({ bytes, mediaType: "text/plain" });
    const digest = digestOf(bytes);
    expect(published).toEqual([bytes.byteLength]);
    expect(s3.object("supertag-artifacts", `producer/sha256/${digest}`)).toBeDefined();
    expect(await Array.fromAsync(producer.inventory())).toEqual([
      { digest: `sha256:${digest}`, sizeBytes: bytes.byteLength },
    ]);

    const keys = generateKeyPairSync("ed25519");
    const server = new WorkletArtifactTransferServer({
      workerHostId: "producer-host",
      store: bucketStore("producer"),
      verificationKey: keys.publicKey,
    });
    const transferBaseUrl = await server.listen();
    try {
      const issuedAt = new Date();
      const grant = signArtifactTransferGrant(
        {
          version: 1,
          grantId: "grant-1",
          artifactId: "artifact-1",
          path: "result.txt",
          digest: `sha256:${digest}`,
          sizeBytes: bytes.byteLength,
          sourceWorkerHostId: "producer-host",
          recipientWorkerHostId: "consumer-host",
          recipientConnectionGeneration: 1,
          taskId: "consumer-task",
          attemptId: "consumer-attempt",
          issuedAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
        },
        keys.privateKey,
      );
      const consumer = new WorkletArtifactStore({
        copies: consumerStore,
        resolve: async () => ({
          artifactId: "artifact-1",
          path: "result.txt",
          digest: `sha256:${digest}`,
          sizeBytes: bytes.byteLength,
          locations: [
            {
              workerHostId: "producer-host",
              transferUrl: `${transferBaseUrl}/v1/artifacts/${digest}`,
              grant,
            },
          ],
          volumes: [],
          holders: { workerHostIds: ["producer-host"], volumes: [] },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
      // The consumer's Volume has no copy, so it fetches one from the producer onto its Volume.
      const ref = { ...stored, artifactId: "artifact-1", path: "result.txt" };
      expect(Buffer.from(await consumer.get(ref))).toEqual(bytes);
      expect(
        Buffer.from(s3.object("supertag-artifacts", `consumer/sha256/${digest}`) ?? []),
      ).toEqual(bytes);
    } finally {
      await server.close();
    }
  });
});
