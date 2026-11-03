import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ArtifactRef, ResourceRef } from "./index.js";
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
export interface ArtifactStore {
  put(input: {
    readonly bytes: Uint8Array;
    readonly name?: string;
    readonly mediaType?: string;
  }): Promise<ArtifactRef>;
  get(ref: ResourceRef): Promise<Uint8Array>;
  /**
   * Whether this store holds the referenced bytes, without reading them. Throws when the store
   * cannot be asked.
   */
  has?(ref: ResourceRef): Promise<boolean>;
}

/** Optional streaming operations used by Worklet-to-Worklet transfers. */
export interface StreamingArtifactStore extends ArtifactStore {
  putStream(ref: ResourceRef, chunks: AsyncIterable<Uint8Array>): Promise<ArtifactRef>;
  stream(ref: ResourceRef): AsyncIterable<Uint8Array>;
}

export interface ArtifactInventoryEntry {
  readonly digest: string;
  readonly sizeBytes: number;
}

/**
 * Where a Worklet in the distributed layout keeps its copies: a directory on the Worker Host by
 * default, or a Volume. A missing copy rejects with an error whose `code` is `ENOENT`.
 */
export interface ArtifactCopies extends StreamingArtifactStore {
  /** Enumerates present copies for inventory reconciliation. */
  inventory(): AsyncIterable<ArtifactInventoryEntry>;
  /** Removes one unusable copy before a verified replacement is fetched. */
  discard(ref: ResourceRef): Promise<void>;
}

/** The error a store raises for a copy it does not hold. */
export function missingArtifactError(): Error {
  return Object.assign(new Error("Artifact is not stored"), { code: "ENOENT" });
}
/** Durable, content-addressed bytes in a private Control Plane directory. */
export class FileArtifactStore implements ArtifactCopies {
  readonly directory: string;
  readonly #verify: (() => Promise<void>) | undefined;
  /**
   * `verify`, when given, rejects when the directory no longer resolves where it did. It runs
   * around directory creation and before and after it publishes a copy. Verified stores must
   * receive a canonical directory path, so creation cannot adopt a redirected real path.
   */
  constructor(directory: string, options: { readonly verify?: () => Promise<void> } = {}) {
    if (!directory.trim()) throw new Error("Artifact storage requires a directory");
    this.directory = resolve(directory);
    this.#verify = options.verify;
  }
  async #directory(): Promise<string> {
    await this.#verify?.();
    const firstCreated = await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory())
      throw new Error("Artifact directory must be a real directory, not a symlink");
    const root = await realpath(this.directory);
    // A parent can change after the pre-mkdir check. Never retain its redirected destination:
    // restoring the parent before the next verify would otherwise bless that outside path.
    if (this.#verify !== undefined && root !== this.directory)
      throw new Error("Artifact directory resolved outside its verified path");
    await this.#verify?.();
    const directory = resolve(root, "sha256");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory() || (await realpath(directory)) !== directory)
      throw new Error("Artifact content directory must not be a symlink");
    await this.#verify?.();
    // Persist new directory entries as well as the blob inode. The directory is private:
    // untrusted execution environments must never receive filesystem access to this tree.
    const boundary = firstCreated ? dirname(resolve(firstCreated)) : root;
    let current = root;
    while (true) {
      const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (current === boundary || dirname(current) === current) break;
      current = dirname(current);
    }
    await this.#verify?.();
    return directory;
  }
  /** Path checks alone miss an ancestor swapped just for open/link and then restored. */
  async #verifyUpload(file: FileHandle, path: string): Promise<void> {
    await this.#verify?.();
    const parent = dirname(path);
    if (!(await lstat(parent)).isDirectory() || (await realpath(parent)) !== parent)
      throw new Error("Artifact upload directory resolved outside its verified path");
    const opened = await file.stat({ bigint: true });
    const expected = await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      !expected.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    )
      throw new Error("Artifact upload no longer matches its verified path");
    await this.#verify?.();
    if ((await realpath(parent)) !== parent)
      throw new Error("Artifact upload directory resolved outside its verified path");
  }
  /** Best effort: never knowingly remove a replacement inode at the original pathname. */
  async #removeUpload(file: FileHandle, path: string, locateDescriptor = false): Promise<void> {
    const opened = await file.stat({ bigint: true });
    const candidates = new Set([path]);
    // Linux exposes the descriptor's actual location even after an ancestor swap is restored.
    // Node has no macOS F_GETPATH API. Do not guess there, or unlink /dev/fd entries.
    if (locateDescriptor && process.platform === "linux") {
      const actual = await realpath(`/proc/self/fd/${file.fd}`).catch(() => undefined);
      if (actual !== undefined) candidates.add(actual);
    }
    for (const candidate of candidates) {
      try {
        const actual = await realpath(dirname(candidate));
        const target = resolve(actual, basename(candidate));
        const entry = await lstat(target, { bigint: true });
        if (entry.isFile() && entry.dev === opened.dev && entry.ino === opened.ino)
          await unlink(target);
      } catch {
        // A concurrently moved or removed entry may no longer be safely locatable.
      }
    }
  }
  /** Links a complete temporary file as the copy, keeping its descriptor pinned until cleanup. */
  async #publish(
    file: FileHandle,
    temporary: string,
    directory: string,
    ref: ResourceRef,
  ): Promise<void> {
    await this.#verifyUpload(file, temporary);
    const published = resolve(directory, artifactDigest(ref));
    try {
      // Link publishes a complete inode without overwriting concurrent content.
      await link(temporary, published);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await this.get(ref);
      return;
    }
    try {
      await this.#verifyUpload(file, temporary);
      await this.#verifyUpload(file, published);
    } catch (error) {
      await this.#removeUpload(file, published);
      throw error;
    }
  }
  async put(input: Parameters<ArtifactStore["put"]>[0]): Promise<ArtifactRef> {
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES)
      throw new Error("Artifact exceeds 32 MiB limit");
    const bytes = Buffer.from(input.bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const ref: ArtifactRef = {
      id: digest,
      uri: `supertag-artifact:sha256:${digest}`,
      digest: `sha256:${digest}`,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    };
    const directory = await this.#directory();
    const temporary = resolve(directory, `.upload-${randomUUID()}`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await this.#verifyUpload(file, temporary);
      await file.writeFile(bytes);
      await file.sync();
      await this.#publish(file, temporary, directory, ref);
      const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      return ref;
    } finally {
      try {
        await this.#removeUpload(file, temporary, true);
      } finally {
        await file.close();
      }
    }
  }
  async putStream(ref: ResourceRef, chunks: AsyncIterable<Uint8Array>): Promise<ArtifactRef> {
    const digest = artifactDigest(ref);
    const directory = await this.#directory();
    const temporary = resolve(directory, `.upload-${randomUUID()}`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    let size = 0;
    try {
      await this.#verifyUpload(file, temporary);
      for await (const value of chunks) {
        const chunk = Buffer.from(value);
        size += chunk.byteLength;
        if (size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds 32 MiB limit");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
          if (!bytesWritten) throw new Error("Artifact stream write made no progress");
          offset += bytesWritten;
        }
      }
      if (hash.digest("hex") !== digest) throw new Error("Artifact digest mismatch");
      await file.sync();
      await this.#publish(file, temporary, directory, ref);
      const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      return {
        id: digest,
        uri: ref.uri,
        digest: `sha256:${digest}`,
        ...(ref.mediaType === undefined ? {} : { mediaType: ref.mediaType }),
      };
    } finally {
      try {
        await this.#removeUpload(file, temporary, true);
      } finally {
        await file.close();
      }
    }
  }
  async *stream(ref: ResourceRef): AsyncIterable<Uint8Array> {
    const digest = artifactDigest(ref);
    const directory = await this.#directory();
    const file = await open(
      resolve(directory, digest),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const hash = createHash("sha256");
    let size = 0;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Artifact content must be a regular file");
      if (stat.size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds 32 MiB limit");
      while (true) {
        const chunk = Buffer.alloc(Math.min(65536, MAX_ARTIFACT_BYTES + 1 - size));
        const { bytesRead } = await file.read(chunk);
        if (!bytesRead) break;
        const value = chunk.subarray(0, bytesRead);
        size += bytesRead;
        if (size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds 32 MiB limit");
        hash.update(value);
        yield value;
      }
      if (hash.digest("hex") !== digest) throw new Error("Artifact digest mismatch");
    } finally {
      await file.close();
    }
  }
  async has(ref: ResourceRef): Promise<boolean> {
    const digest = artifactDigest(ref);
    try {
      // Never create the directory: asking must not change the store.
      return (await lstat(resolve(this.directory, "sha256", digest))).isFile();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
  /** Enumerates locally present copies for bounded Worklet inventory reconciliation. */
  async *inventory(): AsyncIterable<ArtifactInventoryEntry> {
    const directory = await this.#directory();
    const names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}$/u.test(name)).sort();
    for (const digest of names) {
      const file = await open(
        resolve(directory, digest),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (stat.isFile() && stat.size <= MAX_ARTIFACT_BYTES)
          yield { digest: `sha256:${digest}`, sizeBytes: stat.size };
      } finally {
        await file.close();
      }
    }
  }
  /** Removes one unusable local cache pathname before fetching a verified replacement. */
  async discard(ref: ResourceRef): Promise<void> {
    const digest = artifactDigest(ref);
    const directory = await this.#directory();
    await unlink(resolve(directory, digest)).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  async get(ref: ResourceRef): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.stream(ref)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
}

function artifactDigest(ref: ResourceRef): string {
  const digest = /^supertag-artifact:sha256:([a-f0-9]{64})$/u.exec(ref.uri)?.[1];
  if (!digest || ref.digest !== `sha256:${digest}`)
    throw new Error("Invalid artifact reference or digest");
  return digest;
}

export interface S3ArtifactStoreOptions {
  readonly bucket: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly prefix?: string;
  readonly forcePathStyle?: boolean;
  /**
   * Explicit keys, such as a Volume credential a Worker Host mapped. Without them, and
   * without `client`, the AWS default credential chain applies.
   */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  /** Optional preconfigured client. Otherwise use the AWS default credential chain. */
  readonly client?: Pick<S3Client, "send">;
}

/** Content-addressed cloud bytes. Catalog identity, provenance and authorization live elsewhere. */
export class S3ArtifactStore implements ArtifactCopies {
  readonly #client: Pick<S3Client, "send">;
  readonly #prefix: string;
  /** Settings without `credentials` or `client`, so inspecting the store reveals no key. */
  readonly options: Omit<S3ArtifactStoreOptions, "credentials" | "client">;
  constructor(options: S3ArtifactStoreOptions) {
    const { credentials: _credentials, client: _client, ...settings } = options;
    this.options = settings;
    if (!options.bucket.trim()) throw new Error("Artifact storage requires an S3 bucket");
    if (options.endpoint !== undefined) {
      const endpoint = new URL(options.endpoint);
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error(
          "Invalid artifact S3 endpoint; credentials must use provider configuration",
        );
    }
    this.#prefix = (options.prefix ?? "supertag/artifacts").replace(/^\/+|\/+$/gu, "");
    if (
      this.#prefix.split("/").some((part) => part === "." || part === "..") ||
      this.#prefix.includes("\\")
    )
      throw new Error("Invalid artifact S3 prefix");
    this.#client =
      options.client ??
      new S3Client({
        ...(options.region === undefined ? {} : { region: options.region }),
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
        ...(options.credentials === undefined
          ? {}
          : {
              credentials: {
                accessKeyId: options.credentials.accessKeyId,
                secretAccessKey: options.credentials.secretAccessKey,
                ...(options.credentials.sessionToken === undefined
                  ? {}
                  : { sessionToken: options.credentials.sessionToken }),
              },
            }),
        maxAttempts: 3,
      });
  }
  #key(digest: string): string {
    return `${this.#prefix ? `${this.#prefix}/` : ""}sha256/${digest}`;
  }
  async put(input: Parameters<ArtifactStore["put"]>[0]): Promise<ArtifactRef> {
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES)
      throw new Error("Artifact exceeds 32 MiB limit");
    // Copy before hashing: caller mutation must not change content while the request is in flight.
    const bytes = Buffer.from(input.bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.#key(digest),
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: "application/octet-stream",
        ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    return {
      id: digest,
      uri: `supertag-artifact:sha256:${digest}`,
      digest: `sha256:${digest}`,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    };
  }
  async has(ref: ResourceRef): Promise<boolean> {
    const digest = artifactDigest(ref);
    try {
      await this.#client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.#key(digest) }),
        { abortSignal: AbortSignal.timeout(10_000) },
      );
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      if (
        error instanceof Error &&
        (error.name === "NotFound" || error.name === "NoSuchKey" || status === 404)
      )
        return false;
      throw error;
    }
  }
  async get(ref: ResourceRef): Promise<Uint8Array> {
    const digest = artifactDigest(ref);
    let result: GetObjectCommandOutput;
    try {
      result = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: this.#key(digest),
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
    } catch (error) {
      if (isMissingObject(error)) throw missingArtifactError();
      throw error;
    }
    if (!result.Body) throw new Error("Artifact response missing body");
    const reader = result.Body.transformToWebStream().getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (result.ContentLength !== undefined && result.ContentLength > MAX_ARTIFACT_BYTES)
        throw new Error("Artifact exceeds 32 MiB limit");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds 32 MiB limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error("Artifact digest mismatch");
    return bytes;
  }
  /** Verifies streamed bytes against `ref` before storing them; at most 32 MiB is buffered. */
  async putStream(ref: ResourceRef, chunks: AsyncIterable<Uint8Array>): Promise<ArtifactRef> {
    const digest = artifactDigest(ref);
    const parts: Buffer[] = [];
    let size = 0;
    for await (const value of chunks) {
      size += value.byteLength;
      if (size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds 32 MiB limit");
      parts.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(parts);
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error("Artifact digest mismatch");
    const stored = await this.put({
      bytes,
      ...(ref.mediaType === undefined ? {} : { mediaType: ref.mediaType }),
    });
    return { ...stored, uri: ref.uri };
  }
  async *stream(ref: ResourceRef): AsyncIterable<Uint8Array> {
    const bytes = await this.get(ref);
    for (let offset = 0; offset < bytes.byteLength; offset += 65_536)
      yield bytes.subarray(offset, offset + 65_536);
  }
  /** Lists `sha256/DIGEST` objects beneath the prefix, one bounded page at a time. */
  async *inventory(): AsyncIterable<ArtifactInventoryEntry> {
    const prefix = `${this.#prefix ? `${this.#prefix}/` : ""}sha256/`;
    let token: string | undefined;
    do {
      const page = (await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      )) as {
        Contents?: readonly { Key?: string; Size?: number }[];
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const object of page.Contents ?? []) {
        const name = object.Key?.slice(prefix.length) ?? "";
        if (
          /^[a-f0-9]{64}$/u.test(name) &&
          typeof object.Size === "number" &&
          object.Size <= MAX_ARTIFACT_BYTES
        )
          yield { digest: `sha256:${name}`, sizeBytes: object.Size };
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }
  async discard(ref: ResourceRef): Promise<void> {
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.#key(artifactDigest(ref)) }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  }
}

function isMissingObject(error: unknown): boolean {
  const record = (error ?? {}) as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    record.name === "NoSuchKey" ||
    (record.$metadata?.httpStatusCode === 404 && record.name !== "NoSuchBucket")
  );
}
