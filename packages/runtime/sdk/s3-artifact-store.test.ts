import { createHash } from "node:crypto";
import { type GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  MAX_ARTIFACT_BYTES,
  S3ArtifactStore,
  type S3ArtifactStoreOptions,
} from "./src/artifact-store.js";

function fakeCloud() {
  const objects = new Map<string, Uint8Array>();
  const writes: PutObjectCommand[] = [];
  const reads: GetObjectCommand[] = [];
  let cancelled = false;
  let declaredSize: number | undefined;
  const client = {
    async send(command: PutObjectCommand | GetObjectCommand) {
      if (command instanceof PutObjectCommand) {
        writes.push(command);
        objects.set(command.input.Key ?? "", Uint8Array.from(command.input.Body as Uint8Array));
        return {};
      }
      reads.push(command);
      const bytes = objects.get(command.input.Key ?? "");
      if (!bytes) throw new Error("NoSuchKey");
      return {
        ...(declaredSize === undefined ? {} : { ContentLength: declaredSize }),
        Body: {
          transformToWebStream() {
            return new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
              },
              pull(controller) {
                controller.close();
              },
              cancel() {
                cancelled = true;
              },
            });
          },
        },
      };
    },
  } as unknown as NonNullable<S3ArtifactStoreOptions["client"]>;
  return {
    objects,
    writes,
    reads,
    client,
    get cancelled() {
      return cancelled;
    },
    setDeclaredSize(size: number) {
      declaredSize = size;
    },
  };
}

describe("cloud artifact storage", () => {
  it("uses stable content keys across hosts without exposing cloud locations", async () => {
    const cloud = fakeCloud();
    const first = new S3ArtifactStore({
      bucket: "private-bucket",
      prefix: "/org/",
      client: cloud.client,
    });
    const bytes = Uint8Array.from([0, 255, 3]);
    const reference = await first.put({ bytes, name: "result.bin" });
    const second = new S3ArtifactStore({
      bucket: "private-bucket",
      prefix: "org",
      client: cloud.client,
    });
    expect(await second.get(reference)).toEqual(Buffer.from(bytes));
    expect(await first.put({ bytes })).toMatchObject({
      uri: reference.uri,
      digest: reference.digest,
    });
    expect(cloud.objects.size).toBe(1);
    expect(cloud.writes[0]?.input).toMatchObject({
      Bucket: "private-bucket",
      Key: `org/sha256/${reference.id}`,
      ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
    });
    expect(JSON.stringify(reference)).not.toContain("private-bucket");
  });

  it("rejects forged references before access and detects corrupt or missing content", async () => {
    const cloud = fakeCloud();
    const store = new S3ArtifactStore({ bucket: "bucket", client: cloud.client });
    const ref = await store.put({ bytes: Buffer.from("original") });
    await expect(store.get({ ...ref, digest: "sha256:wrong" })).rejects.toThrow("Invalid artifact");
    expect(cloud.reads).toHaveLength(0);
    cloud.objects.set(`supertag/artifacts/sha256/${ref.id}`, Buffer.from("changed"));
    await expect(store.get(ref)).rejects.toThrow("digest mismatch");
    cloud.objects.clear();
    await expect(store.get(ref)).rejects.toThrow("NoSuchKey");
  });

  it("bounds uploads and streaming downloads, including absent length headers", async () => {
    const cloud = fakeCloud();
    const store = new S3ArtifactStore({ bucket: "bucket", client: cloud.client });
    const oversized = new Uint8Array(MAX_ARTIFACT_BYTES + 1);
    await expect(store.put({ bytes: oversized })).rejects.toThrow("32 MiB");
    expect(cloud.writes).toHaveLength(0);
    const ref = await store.put({ bytes: Buffer.from("small") });
    cloud.objects.set(`supertag/artifacts/sha256/${ref.id}`, oversized);
    await expect(store.get(ref)).rejects.toThrow("32 MiB");
    cloud.setDeclaredSize(MAX_ARTIFACT_BYTES + 1);
    await expect(store.get(ref)).rejects.toThrow("32 MiB");
    expect(cloud.cancelled).toBe(true);
  });

  it("rejects credential-bearing endpoints and escaping prefixes", () => {
    expect(
      () =>
        new S3ArtifactStore({ bucket: "bucket", endpoint: "https://user:password@example.com" }),
    ).toThrow("credentials");
    expect(() => new S3ArtifactStore({ bucket: "bucket", prefix: "../elsewhere" })).toThrow(
      "prefix",
    );
  });
});
