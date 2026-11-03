import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_MOUNT_UPLOAD_OBJECT_BYTES,
  MAX_MOUNT_UPLOAD_OBJECTS,
  type MountManifest,
  mountManifestDigest,
  parseMountOutputManifests,
  type WorkspaceMount,
} from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { FakeS3 } from "../../../tests/support/fake-s3.ts";
import { listHostMountUploadFiles, uploadWorkspaceMount } from "./src/volume-copy.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function fixture(maxBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "copy-write-test-"));
  roots.push(root);
  const source = join(root, "source");
  const mountPath = join(root, "mount");
  await mkdir(source);
  await mkdir(mountPath);
  await writeFile(join(source, "same.txt"), "same");
  await writeFile(join(mountPath, "same.txt"), "same");
  const mount: WorkspaceMount = {
    volume: "data",
    path: mountPath,
    strategy: "copy",
    access: "read-write",
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
  const objects = [{ key: "same.txt", size: 4, sha256: digest("same") }];
  const input: MountManifest = {
    volume: "data",
    source: pathToFileURL(source).href,
    path: mountPath,
    strategy: "copy",
    access: "read-write",
    objectCount: 1,
    totalBytes: 4,
    copiedAt: new Date().toISOString(),
    digest: mountManifestDigest(pathToFileURL(source).href, objects),
    objects,
  };
  return { source, mountPath, mount, input };
}

describe("read-write copy upload", () => {
  it("uploads only changed files to an S3-compatible source with one PUT per key", async () => {
    const { mountPath, mount, input } = await fixture();
    const s3 = await FakeS3.start("copy-write-key");
    try {
      s3.bucket("data");
      s3.put("data", "prefix/same.txt", "same");
      await writeFile(join(mountPath, "new.txt"), "new");
      const source = `s3://data/prefix?region=us-east-1&endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`;
      const result = await uploadWorkspaceMount({
        mount,
        input: { ...input, source },
        volume: {
          volume: "data",
          source,
          credentials: async () => ({
            accessKeyId: "copy-write-key",
            secretAccessKey: "test-secret",
          }),
        },
        files: () => listHostMountUploadFiles(mountPath),
      });
      expect(result.status).toBe("complete");
      expect(Buffer.from(s3.object("data", "prefix/new.txt") ?? []).toString()).toBe("new");
      expect(
        s3.requests.filter((request) => request.method === "PUT").map((request) => request.key),
      ).toEqual(["prefix/new.txt"]);
    } finally {
      await s3.close();
    }
  });

  it("does not retry a failed S3 PUT or expose credentials in its manifest", async () => {
    const { mountPath, mount, input } = await fixture();
    const s3 = await FakeS3.start("copy-write-key");
    try {
      s3.bucket("data");
      s3.echoError = "AccessDenied";
      await writeFile(join(mountPath, "new.txt"), "new");
      const source = `s3://data/prefix?endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`;
      const result = await uploadWorkspaceMount({
        mount,
        input: { ...input, source },
        volume: {
          volume: "data",
          source,
          credentials: async () => ({
            accessKeyId: "copy-write-key",
            secretAccessKey: "test-secret",
          }),
        },
        files: () => listHostMountUploadFiles(mountPath),
      });
      expect(result.status).toBe("partial");
      expect(result.notAttempted).toEqual(["new.txt"]);
      expect(s3.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("copy-write-key");
      expect(JSON.stringify(result)).not.toContain("test-secret");
    } finally {
      await s3.close();
    }
  });
  it("uploads changed and created regular files, skips unchanged and symlinks", async () => {
    const { source, mountPath, mount, input } = await fixture();
    await writeFile(join(mountPath, "changed.txt"), "changed");
    await symlink(join(source, "same.txt"), join(mountPath, "link.txt"));
    const result = await uploadWorkspaceMount({
      mount,
      input,
      volume: { volume: "data", source: input.source },
      files: () => listHostMountUploadFiles(mountPath),
    });
    expect(result.status).toBe("complete");
    expect(result.objects).toEqual([{ key: "changed.txt", size: 7, sha256: digest("changed") }]);
    expect(result.skipped).toBe(1);
    expect(parseMountOutputManifests([result])).toHaveLength(1);
    expect(await readFile(join(source, "changed.txt"), "utf8")).toBe("changed");
    expect(await readFile(join(source, "same.txt"), "utf8")).toBe("same");
  });

  it("refuses all writes before upload when the changed set exceeds maxBytes", async () => {
    const { source, mountPath, mount, input } = await fixture(4);
    await writeFile(join(mountPath, "new.txt"), "large");
    const result = await uploadWorkspaceMount({
      mount,
      input,
      volume: { volume: "data", source: input.source },
      files: () => listHostMountUploadFiles(mountPath),
    });
    expect(result.status).toBe("refused");
    expect(result.notAttempted).toEqual(["new.txt"]);
    expect(parseMountOutputManifests([result])).toHaveLength(1);
    await expect(readFile(join(source, "new.txt"))).rejects.toThrow();
  });

  it("refuses too many objects or one oversized object before any write", async () => {
    const { mount, input } = await fixture();
    const written: string[] = [];
    const files = Array.from({ length: MAX_MOUNT_UPLOAD_OBJECTS + 1 }, (_, index) => ({
      key: `new-${index}.txt`,
      size: 1,
      sha256: digest("x"),
      read: async () => Buffer.from("x"),
    }));
    for (const selected of [
      files,
      [
        {
          key: "oversized.txt",
          size: MAX_MOUNT_UPLOAD_OBJECT_BYTES + 1,
          sha256: digest("x"),
          read: async () => Buffer.from("x"),
        },
      ],
    ]) {
      const result = await uploadWorkspaceMount({
        mount: { ...mount, maxBytes: 20 * 1024 ** 3 },
        input,
        volume: { volume: "data", source: input.source },
        files: async () => selected,
        put: async (key) => {
          written.push(key);
        },
      });
      expect(result.status).toBe("refused");
      expect(result.objects).toEqual([]);
      expect(parseMountOutputManifests([result])).toHaveLength(1);
    }
    expect(written).toEqual([]);
  });

  it("stops on first failure and records successful and unattempted keys", async () => {
    const { mountPath, mount, input } = await fixture();
    await writeFile(join(mountPath, "a.txt"), "a");
    await writeFile(join(mountPath, "b.txt"), "b");
    await writeFile(join(mountPath, "c.txt"), "c");
    const written: string[] = [];
    const result = await uploadWorkspaceMount({
      mount,
      input,
      volume: { volume: "data", source: input.source },
      files: () => listHostMountUploadFiles(mountPath),
      put: async (key) => {
        written.push(key);
        if (key === "b.txt") throw new Error("fake store failure");
      },
    });
    expect(written).toEqual(["a.txt", "b.txt"]);
    expect(result.status).toBe("partial");
    expect(result.objects.map((file) => file.key)).toEqual(["a.txt"]);
    expect(result.error).toEqual({ key: "b.txt", reason: "fake store failure" });
    expect(result.notAttempted).toEqual(["b.txt", "c.txt"]);
    expect(parseMountOutputManifests([result])).toHaveLength(1);
  });
});
