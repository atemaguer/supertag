import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { S3ArtifactStore } from "../packages/runtime/sdk/src/artifact-store.ts";

const { S3Client, CreateBucketCommand, GetObjectCommand, PutObjectCommand } = createRequire(
  new URL("../packages/runtime/sdk/package.json", import.meta.url),
)("@aws-sdk/client-s3");
const execute = promisify(execFile);
// Explicit release fixture; no account credentials or paid cloud services are used.
const image = "minio/minio:RELEASE.2025-04-22T22-12-26Z";

it.skipIf(process.env["SUPERTAG_S3_CONTAINER_TEST"] !== "1")(
  "round-trips and verifies artifact bytes through independent AWS SDK clients against MinIO",
  async () => {
    const container = `supertag-artifact-s3-${randomUUID()}`;
    const credentials = {
      accessKeyId: "artifact-fixture",
      secretAccessKey: "artifact-fixture-password",
    };
    const clients: Array<{ destroy(): void }> = [];
    try {
      await execute(
        "docker",
        [
          "run",
          "--detach",
          "--rm",
          "--name",
          container,
          "-p",
          "127.0.0.1::9000",
          "-e",
          "MINIO_ROOT_USER",
          "-e",
          "MINIO_ROOT_PASSWORD",
          image,
          "server",
          "/data",
        ],
        {
          timeout: 60_000,
          env: {
            ...process.env,
            MINIO_ROOT_USER: credentials.accessKeyId,
            MINIO_ROOT_PASSWORD: credentials.secretAccessKey,
          },
        },
      );
      const { stdout } = await execute("docker", ["port", container, "9000/tcp"], {
        timeout: 5000,
      });
      const port = /:(\d+)\s*$/.exec(stdout.trim())?.[1];
      if (!port) throw new Error("Missing MinIO fixture port");
      const endpoint = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 20_000;
      let healthy = false;
      while (Date.now() < deadline) {
        healthy = await fetch(`${endpoint}/minio/health/ready`, {
          signal: AbortSignal.timeout(1000),
        })
          .then((response) => response.ok)
          .catch(() => false);
        if (healthy) break;
        await delay(100);
      }
      if (!healthy) throw new Error("MinIO fixture did not become ready within 20 seconds");
      const client = () => {
        const result = new S3Client({
          endpoint,
          region: "us-east-1",
          forcePathStyle: true,
          credentials,
          maxAttempts: 1,
        });
        clients.push(result);
        return result;
      };
      const admin = client();
      const bucket = "artifact-fixture";
      await admin.send(new CreateBucketCommand({ Bucket: bucket }));
      const writer = new S3ArtifactStore({
        bucket,
        prefix: "integration/artifacts",
        client: client(),
      });
      const reader = new S3ArtifactStore({
        bucket,
        prefix: "integration/artifacts",
        client: client(),
      });
      const bytes = Uint8Array.from({ length: 8193 }, (_, index) => index % 256);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const ref = await writer.put({
        bytes,
        name: "research.bin",
        mediaType: "application/octet-stream",
      });
      expect(ref.digest).toBe(`sha256:${digest}`);
      expect(ref.uri).toBe(`supertag-artifact:sha256:${digest}`);
      expect(await reader.get(ref)).toEqual(Buffer.from(bytes));
      expect(await writer.put({ bytes })).toMatchObject({ uri: ref.uri, digest: ref.digest });
      // Exercise independent Worker-like clients while bounding open connections.
      const producers = Array.from({ length: 100 }, (_, index) => ({
        bytes: Buffer.from(`worker-${index}: durable output`),
        store: new S3ArtifactStore({ bucket, prefix: "integration/fanout", client: client() }),
      }));
      for (let offset = 0; offset < producers.length; offset += 10) {
        await Promise.all(
          producers.slice(offset, offset + 10).map(async ({ bytes, store }) => {
            const output = await store.put({ bytes });
            const consumer = new S3ArtifactStore({
              bucket,
              prefix: "integration/fanout",
              client: client(),
            });
            expect(await consumer.get(output)).toEqual(bytes);
            // Retry publication through another client and verify stable identity.
            expect(await consumer.put({ bytes })).toMatchObject({
              uri: output.uri,
              digest: output.digest,
            });
            // Every independent consumer also reads the common producer artifact.
            const sharedReader = new S3ArtifactStore({
              bucket,
              prefix: "integration/artifacts",
              client: client(),
            });
            expect(await sharedReader.get(ref)).toEqual(
              Buffer.from(Uint8Array.from({ length: 8193 }, (_, index) => index % 256)),
            );
          }),
        );
      }
      const key = `integration/artifacts/sha256/${digest}`;
      const stored = await admin.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }),
      );
      expect(stored.ChecksumSHA256).toBe(Buffer.from(digest, "hex").toString("base64"));
      expect(await stored.Body.transformToByteArray()).toEqual(bytes);
      const empty = await writer.put({ bytes: new Uint8Array() });
      expect(await reader.get(empty)).toHaveLength(0);
      await admin.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from("tampered content") }),
      );
      await expect(reader.get(ref)).rejects.toThrow("Artifact digest mismatch");
    } finally {
      for (const client of clients) client.destroy();
      await execute("docker", ["rm", "--force", container], { timeout: 15_000 });
    }
  },
  120_000,
);
