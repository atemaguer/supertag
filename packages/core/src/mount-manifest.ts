import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parseVolumeName, parseVolumeSource } from "./volume.js";

/**
 * One file a `copy` mount placed in a Task Attempt's environment: its key relative to the
 * Volume's source, its size, and how the source identifies that version of it. Object stores
 * report an ETag (and a version ID where versioning is on); `file://` sources have neither, so
 * the Worker Host records the SHA-256 of the bytes it copied.
 */
export interface MountManifestObject {
  readonly key: string;
  readonly size: number;
  readonly etag?: string;
  readonly versionId?: string;
  readonly sha256?: string;
}

/**
 * What a `copy` mount placed in one Task Attempt's environment, recorded on the Task Attempt.
 * `digest` covers the source and every object, so two Attempts that copied the same content have
 * the same digest, and a changed source shows as a different one.
 */
export interface MountManifest {
  readonly volume: string;
  /** The Volume's source when it was copied, such as `s3://bucket/prefix/`; never a credential. */
  readonly source: string;
  /** Absolute path of the copy inside the Task Attempt's environment. */
  readonly path: string;
  readonly strategy: "copy";
  readonly access: "read-only" | "read-write";
  readonly objectCount: number;
  readonly totalBytes: number;
  /** `sha256:<hex>` over the source and the objects, in key order. */
  readonly digest: string;
  readonly copiedAt: string;
  /** Every copied object, in key order. */
  readonly objects: readonly MountManifestObject[];
}

/** Most objects one `copy` mount may hold; listing stops, before any download, above it. */
export const MAX_MOUNT_OBJECTS = 10_000;
/** Most bytes a `copy` mount may hold when its Workspace mount sets no `maxBytes`: 1 GiB. */
export const DEFAULT_MOUNT_MAX_BYTES = 1024 * 1024 * 1024;
/** Largest explicit copy limit: 20 GiB per mount. */
export const MAX_MOUNT_MAX_BYTES = 20 * 1024 * 1024 * 1024;
/**
 * Most bytes, as JSON, the manifests of one Task Attempt's `copy` mounts may take together: 2 MiB,
 * so they fit in one Worker event below the 3 MiB document and 4 MiB message limits. The Worker
 * Host counts each listed object against it and refuses, before downloading, a copy whose
 * manifest would not fit, for example 10,000 objects with keys near 200 bytes.
 */
export const MAX_MOUNT_MANIFEST_BYTES = 2 * 1024 * 1024;
/** Maximum changed objects uploaded from one copy mount in one Task Attempt. */
export const MAX_MOUNT_UPLOAD_OBJECTS = 1_000;
/** Maximum size of one uploaded object: 5 GiB. */
export const MAX_MOUNT_UPLOAD_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_KEY_LENGTH = 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/** The manifest digest: SHA-256 of the source and the objects as canonical JSON, in key order. */
export function mountManifestDigest(
  source: string,
  objects: readonly MountManifestObject[],
): string {
  const canonical = JSON.stringify({
    source,
    objects: objects
      .toSorted((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .map((object) => [
        object.key,
        object.size,
        object.etag ?? null,
        object.versionId ?? null,
        object.sha256 ?? null,
      ]),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Validates manifests a Worker reported for a Task Attempt. The digest must match the objects,
 * so a stored manifest is internally consistent; it is evidence of what the Worker Host copied,
 * not of the source's current state.
 */
export function parseMountManifests(value: unknown): readonly MountManifest[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Mount manifests must be an array of at most 64 manifests");
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_MOUNT_MANIFEST_BYTES)
    throw new Error(`Mount manifests must take at most ${MAX_MOUNT_MANIFEST_BYTES} bytes as JSON`);
  const paths = new Set<string>();
  return value.map((item, index) => {
    const field = `Mount manifest ${index}`;
    const record = object(item, field);
    const objects = record["objects"];
    if (!Array.isArray(objects) || objects.length > MAX_MOUNT_OBJECTS)
      throw new Error(`${field} objects must be an array of at most ${MAX_MOUNT_OBJECTS}`);
    let total = 0;
    const keys = new Set<string>();
    const parsed = objects.map((entry, position) => {
      const at = `${field} object ${position}`;
      const source = object(entry, at);
      const key = text(source["key"], `${at} key`, MAX_KEY_LENGTH);
      if (keys.has(key)) throw new Error(`${at} repeats key ${key}`);
      keys.add(key);
      const size = source["size"];
      if (!Number.isSafeInteger(size) || (size as number) < 0)
        throw new Error(`${at} size must be a nonnegative integer`);
      total += size as number;
      const etag = optionalText(source["etag"], `${at} etag`, 256);
      const versionId = optionalText(source["versionId"], `${at} versionId`, 1024);
      const sha256 = optionalText(source["sha256"], `${at} sha256`, 71);
      if (sha256 !== undefined && !DIGEST.test(sha256))
        throw new Error(`${at} sha256 must be sha256:<hex>`);
      return {
        key,
        size: size as number,
        ...(etag === undefined ? {} : { etag }),
        ...(versionId === undefined ? {} : { versionId }),
        ...(sha256 === undefined ? {} : { sha256 }),
      } satisfies MountManifestObject;
    });
    const source = text(record["source"], `${field} source`, 1024);
    const path = text(record["path"], `${field} path`, 4096);
    if (!path.startsWith("/")) throw new Error(`${field} path must be absolute`);
    if (paths.has(path)) throw new Error(`${field} repeats path ${path}`);
    paths.add(path);
    if (record["strategy"] !== "copy") throw new Error(`${field} strategy must be copy`);
    if (record["access"] !== "read-only" && record["access"] !== "read-write")
      throw new Error(`${field} access must be read-only or read-write`);
    if (record["objectCount"] !== parsed.length)
      throw new Error(`${field} objectCount must equal its objects`);
    if (record["totalBytes"] !== total) throw new Error(`${field} totalBytes must equal its sizes`);
    const digest = text(record["digest"], `${field} digest`, 71);
    if (digest !== mountManifestDigest(source, parsed))
      throw new Error(`${field} digest does not match its objects`);
    const copiedAt = text(record["copiedAt"], `${field} copiedAt`, 64);
    if (Number.isNaN(Date.parse(copiedAt))) throw new Error(`${field} copiedAt must be a time`);
    return {
      volume: text(record["volume"], `${field} volume`, 63),
      source,
      path,
      strategy: "copy",
      access: record["access"],
      objectCount: parsed.length,
      totalBytes: total,
      digest,
      copiedAt,
      objects: parsed,
    } satisfies MountManifest;
  });
}

/** A regular file under a copied mount. The caller must exclude symlinks before listing. */
export interface MountUploadFile {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
}

export interface MountOutputManifest {
  readonly volume: string;
  readonly source: string;
  readonly path: string;
  readonly status: "complete" | "partial" | "refused";
  readonly uploadedAt: string;
  /** Successfully uploaded objects only. */
  readonly objects: readonly MountUploadFile[];
  readonly skipped: number;
  /** Failed key and reason, including a refused bound. */
  readonly error?: { readonly key: string; readonly reason: string };
  /** Changed keys not uploaded, including the failed key. */
  readonly notAttempted: readonly string[];
}

export type MountUploadChangeSet = Pick<
  MountOutputManifest,
  "status" | "objects" | "skipped" | "error" | "notAttempted"
>;

/** Compare copied SHA-256 digests and reject the complete changed set before any upload. */
export function computeMountUploadChangeSet(
  input: MountManifest,
  files: readonly MountUploadFile[],
  maxBytes: number = DEFAULT_MOUNT_MAX_BYTES,
): MountUploadChangeSet {
  if (input.strategy !== "copy" || input.access !== "read-write")
    throw new Error("Upload change sets require a read-write copy manifest");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MOUNT_MAX_BYTES)
    throw new Error("Mount upload maxBytes is invalid");
  const copied = new Map(input.objects.map((entry) => [entry.key, entry]));
  const seen = new Set<string>();
  const changed: MountUploadFile[] = [];
  let skipped = 0;
  let total = 0;
  let refusal: MountOutputManifest["error"];
  for (const file of files) {
    const key = mountUploadKey(file.key, "Mount upload key");
    if (seen.has(key)) throw new Error(`Mount upload repeats key ${key}`);
    seen.add(key);
    if (!Number.isSafeInteger(file.size) || file.size < 0)
      throw new Error(`Mount upload ${key} size must be a nonnegative integer`);
    if (!DIGEST.test(file.sha256)) throw new Error(`Mount upload ${key} sha256 is invalid`);
    const original = copied.get(key);
    if (original?.sha256 === file.sha256 && original.size === file.size) {
      skipped++;
      continue;
    }
    changed.push({ key, size: file.size, sha256: file.sha256 });
    total += file.size;
    if (!refusal && file.size > MAX_MOUNT_UPLOAD_OBJECT_BYTES)
      refusal = { key, reason: `Object exceeds ${MAX_MOUNT_UPLOAD_OBJECT_BYTES} bytes` };
    if (!refusal && total > maxBytes)
      refusal = { key, reason: `Upload exceeds mount maxBytes ${maxBytes}` };
  }
  if (!refusal && changed.length > MAX_MOUNT_UPLOAD_OBJECTS)
    refusal = {
      key: changed[MAX_MOUNT_UPLOAD_OBJECTS]?.key ?? "unknown",
      reason: `Upload exceeds ${MAX_MOUNT_UPLOAD_OBJECTS} objects`,
    };
  if (refusal)
    return {
      status: "refused",
      objects: [],
      skipped,
      error: refusal,
      notAttempted: changed.map((file) => file.key),
    };
  return { status: "complete", objects: changed, skipped, notAttempted: [] };
}

/** Validate the Worker Host's write evidence before it enters durable Attempt state. */
export function parseMountOutputManifests(value: unknown): readonly MountOutputManifest[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Mount output manifests must be an array of at most 64 manifests");
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_MOUNT_MANIFEST_BYTES)
    throw new Error(
      `Mount output manifests must take at most ${MAX_MOUNT_MANIFEST_BYTES} bytes as JSON`,
    );
  const paths = new Set<string>();
  return value.map((item, index) => {
    const field = `Mount output manifest ${index}`;
    const record = object(item, field);
    if (
      Object.keys(record).some(
        (key) =>
          ![
            "volume",
            "source",
            "path",
            "status",
            "uploadedAt",
            "objects",
            "skipped",
            "error",
            "notAttempted",
          ].includes(key),
      )
    )
      throw new Error(`${field} contains unsupported fields`);
    const volume = text(record["volume"], `${field} volume`, 63);
    parseVolumeName(volume, `${field} volume`);
    const source = text(record["source"], `${field} source`, 1024);
    parseVolumeSource(source, `${field} source`);
    const path = text(record["path"], `${field} path`, 4096);
    if (
      !path.startsWith("/") ||
      posix.normalize(path) !== path ||
      path.endsWith("/") ||
      paths.has(path)
    )
      throw new Error(`${field} path must be unique and absolute`);
    paths.add(path);
    const status = record["status"];
    if (status !== "complete" && status !== "partial" && status !== "refused")
      throw new Error(`${field} status is invalid`);
    const uploadedAt = text(record["uploadedAt"], `${field} uploadedAt`, 64);
    if (Number.isNaN(Date.parse(uploadedAt))) throw new Error(`${field} uploadedAt must be a time`);
    const entries = record["objects"];
    if (!Array.isArray(entries) || entries.length > MAX_MOUNT_UPLOAD_OBJECTS)
      throw new Error(`${field} objects exceed ${MAX_MOUNT_UPLOAD_OBJECTS}`);
    const keys = new Set<string>();
    const objects = entries.map((entry, position) => {
      const value = object(entry, `${field} object ${position}`);
      if (Object.keys(value).some((key) => !["key", "size", "sha256"].includes(key)))
        throw new Error(`${field} object ${position} contains unsupported fields`);
      const key = mountUploadKey(value["key"], `${field} object ${position} key`);
      if (keys.has(key)) throw new Error(`${field} repeats key ${key}`);
      keys.add(key);
      const size = value["size"];
      if (
        !Number.isSafeInteger(size) ||
        (size as number) < 0 ||
        (size as number) > MAX_MOUNT_UPLOAD_OBJECT_BYTES
      )
        throw new Error(`${field} object ${key} size is invalid`);
      const sha256 = text(value["sha256"], `${field} object ${key} sha256`, 71);
      if (!DIGEST.test(sha256)) throw new Error(`${field} object ${key} sha256 is invalid`);
      return { key, size: size as number, sha256 };
    });
    const skipped = record["skipped"];
    if (!Number.isSafeInteger(skipped) || (skipped as number) < 0)
      throw new Error(`${field} skipped must be a nonnegative integer`);
    const remaining = record["notAttempted"];
    if (
      !Array.isArray(remaining) ||
      remaining.some((key) => !validMountUploadKey(key) || keys.has(key))
    )
      throw new Error(`${field} notAttempted keys are invalid`);
    if (new Set(remaining).size !== remaining.length)
      throw new Error(`${field} repeats notAttempted key`);
    const error =
      record["error"] === undefined ? undefined : object(record["error"], `${field} error`);
    if (error && Object.keys(error).some((key) => !["key", "reason"].includes(key)))
      throw new Error(`${field} error contains unsupported fields`);
    const parsedError =
      error === undefined
        ? undefined
        : {
            key: text(error["key"], `${field} error key`, MAX_KEY_LENGTH),
            reason: text(error["reason"], `${field} error reason`, 1024),
          };
    if (status === "complete" && (parsedError || remaining.length))
      throw new Error(`${field} complete status cannot have an error or remaining keys`);
    if (status !== "complete" && (!parsedError || !remaining.includes(parsedError.key)))
      throw new Error(`${field} ${status} status requires an error key in notAttempted`);
    if (status === "refused" && objects.length > 0)
      throw new Error(`${field} refused status cannot have uploaded objects`);
    return {
      volume,
      source,
      path,
      status,
      uploadedAt,
      objects,
      skipped: skipped as number,
      ...(parsedError === undefined ? {} : { error: parsedError }),
      notAttempted: remaining as string[],
    };
  });
}

function validMountUploadKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_KEY_LENGTH &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\p{Cc}]/u.test(value) &&
    value
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          Buffer.byteLength(segment) <= 255,
      )
  );
}

function mountUploadKey(value: unknown, field: string): string {
  if (!validMountUploadKey(value)) throw new Error(`${field} is not a safe relative key`);
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(`${field} must be a string of 1-${max} characters`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, field, max);
}
