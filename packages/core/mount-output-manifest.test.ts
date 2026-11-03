import { describe, expect, it } from "vitest";
import {
  computeMountUploadChangeSet,
  MAX_MOUNT_UPLOAD_OBJECT_BYTES,
  MAX_MOUNT_UPLOAD_OBJECTS,
  type MountManifest,
  mountManifestDigest,
  parseMountOutputManifests,
} from "./src/mount-manifest.js";

const a = `sha256:${"a".repeat(64)}`;
const b = `sha256:${"b".repeat(64)}`;
const input: MountManifest = {
  volume: "data",
  source: "file:///data",
  path: "/mnt/data",
  strategy: "copy",
  access: "read-write",
  objectCount: 2,
  totalBytes: 3,
  copiedAt: "2026-10-07T00:00:00Z",
  objects: [
    { key: "same", size: 1, sha256: a },
    { key: "changed", size: 2, sha256: a },
  ],
  digest: mountManifestDigest("file:///data", [
    { key: "same", size: 1, sha256: a },
    { key: "changed", size: 2, sha256: a },
  ]),
};

describe("mount output manifests", () => {
  it("selects created and changed regular files, skipping unchanged files and deletions", () => {
    const result = computeMountUploadChangeSet(
      input,
      [
        { key: "same", size: 1, sha256: a },
        { key: "changed", size: 2, sha256: b },
        { key: "created", size: 3, sha256: a },
      ],
      10,
    );
    expect(result).toEqual({
      status: "complete",
      objects: [
        { key: "changed", size: 2, sha256: b },
        { key: "created", size: 3, sha256: a },
      ],
      skipped: 1,
      notAttempted: [],
    });
  });

  it("refuses the whole set before upload when count, object size, or total size exceeds a bound", () => {
    const files = Array.from({ length: MAX_MOUNT_UPLOAD_OBJECTS + 1 }, (_, i) => ({
      key: `new-${i}`,
      size: 1,
      sha256: a,
    }));
    expect(computeMountUploadChangeSet(input, files, 2000)).toMatchObject({
      status: "refused",
      objects: [],
      notAttempted: files.map((file) => file.key),
    });
    expect(
      computeMountUploadChangeSet(
        input,
        [{ key: "huge", size: MAX_MOUNT_UPLOAD_OBJECT_BYTES + 1, sha256: a }],
        20 * 1024 ** 3,
      ),
    ).toMatchObject({ status: "refused", objects: [], error: { key: "huge" } });
    expect(
      computeMountUploadChangeSet(input, [{ key: "new", size: 11, sha256: a }], 10),
    ).toMatchObject({ status: "refused", objects: [], error: { key: "new" } });
  });

  it("validates a partial manifest with failed key and remaining keys", () => {
    const manifest = {
      volume: "data",
      source: "file:///data",
      path: "/mnt/data",
      status: "partial",
      uploadedAt: "2026-10-07T00:00:00Z",
      objects: [{ key: "changed", size: 2, sha256: b }],
      skipped: 1,
      error: { key: "created", reason: "upload failed" },
      notAttempted: ["created"],
    };
    expect(parseMountOutputManifests([manifest])).toEqual([manifest]);
    expect(() =>
      parseMountOutputManifests([
        { ...manifest, objects: [{ key: "changed", size: 2, sha256: "bad" }] },
      ]),
    ).toThrow(/sha256/u);
    expect(() => parseMountOutputManifests([{ ...manifest, credential: "secret" }])).toThrow(
      /unsupported fields/u,
    );
  });
});
