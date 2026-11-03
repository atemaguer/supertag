/**
 * A Worker Host's artifact copies on its artifact Volume. A host service names the Volume with
 * `artifact-volume: NAME`; a Worklet connected from elsewhere names it with
 * `connect worklet --artifact-volume NAME`. The catalog holds the Volume's source and the name of
 * its credential; this host maps that name to a secret of its own (a host service's
 * `volume-credentials`, or the file `--artifact-volume-credential file:PATH` names) and reads the
 * value only here, in the Worklet process, to build an object-store client. The value never
 * reaches the Control Plane, a Task, a harness, a log line, or `describe` output: errors carry the
 * Volume's name and the provider's error code, never a message from the provider or a credential.
 *
 * Each artifact file is its own object at `attempts/ATTEMPT_ID/sha256/HEX` beneath the Volume's source, the key the
 * catalog derives from the producing Task Attempt and file's digest when this host reports the copy.
 *
 * A consuming host reads another host's copy from a shared Volume with {@link artifactVolumeReader},
 * only at the key the catalog recorded and only after the catalog checked the consumer's grant.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  artifactVolumeKey,
  artifactVolumeKeyDirectory,
  parseVolumeSource,
  type ResolvedArtifactVolumeLocation,
  type TaskWorkspaceVolume,
  type VolumeLocation,
} from "@supertag/core";
import {
  type ArtifactCopies,
  type ArtifactInventoryEntry,
  type ArtifactRef,
  type ArtifactStore,
  FileArtifactStore,
  MAX_ARTIFACT_BYTES,
  missingArtifactError,
  type ResourceRef,
  S3ArtifactStore,
  type VolumeCredentials,
} from "@supertag/worker-sdk";
import { parseVolumeCredentialSecret } from "./host-volumes.js";

/** Why a Worker Host cannot use its artifact Volume now. The message names no secret. */
export class ArtifactVolumeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactVolumeUnavailableError";
  }
}

export interface HostArtifactVolumeOptions {
  /** The Volume named by `artifact-volume` or `--artifact-volume`. */
  readonly volume: string;
  /** Reads the Volume from the catalog: its source and credential name, never a value. */
  readonly lookup: () => Promise<TaskWorkspaceVolume>;
  /**
   * Reads the secret this host maps the Volume's credential name to: an object-store secret, or
   * `{ path: DIR }` consent for a `file://` source. Rejects when it is not mapped or unreadable.
   */
  readonly readCredential: (credential: string) => Promise<string | { readonly path: string }>;
  /** How long one catalog lookup is reused. Default: 30 seconds. */
  readonly lookupTtlMs?: number;
  readonly now?: () => number;
}

/** Errors the content-addressed stores raise themselves; their messages hold no provider text. */
const OWN_MESSAGES = new Set([
  "Artifact exceeds 32 MiB limit",
  "Artifact digest mismatch",
  "Invalid artifact reference or digest",
  "Artifact response missing body",
  "Artifact content must be a regular file",
  "Artifact is not stored",
]);

interface Resolved {
  readonly key: string;
  readonly store: ArtifactCopies;
  readonly secrets: readonly string[];
}

/**
 * Stores this host's artifact copies on its artifact Volume, in the `attempts/ATTEMPT_ID/sha256/HEX` layout beneath
 * the Volume's source. The Volume is read from the catalog at most every `lookupTtlMs`, so
 * applying it after the host starts, or changing its source, takes effect without a restart.
 */
export class HostArtifactVolumeStore implements ArtifactCopies {
  readonly #options: HostArtifactVolumeOptions;
  // Without a private receipt directory, only uploads this process verified are advertised.
  readonly #uploads = new Map<
    string,
    Map<string, ArtifactInventoryEntry & { readonly attemptId: string }>
  >();
  #cached: Resolved | undefined;
  readonly #writtenSources = new WeakMap<ArtifactRef, string>();
  #volume: { readonly at: number; readonly value: Promise<TaskWorkspaceVolume> } | undefined;
  constructor(
    options: HostArtifactVolumeOptions,
    private readonly receiptDirectory?: string,
  ) {
    this.#options = options;
  }

  get volume(): string {
    return this.#options.volume;
  }

  /** Bind all writes and fetched copies to this execution's namespace. */
  forAttempt(attemptId: string): ArtifactCopies {
    artifactVolumeKey(attemptId, `sha256:${"0".repeat(64)}`);
    return {
      put: (input) => this.#put(input, attemptId),
      get: (ref) => this.#get(ref, attemptId),
      putStream: (ref, chunks) => this.#putStream(ref, chunks, attemptId),
      stream: (ref) => this.#stream(ref, attemptId),
      inventory: () => this.inventory(),
      discard: (ref) => this.#discard(ref, attemptId),
    };
  }

  async put(_input: Parameters<ArtifactStore["put"]>[0]): Promise<ArtifactRef> {
    throw new Error("Artifact Volume writes require a Task Attempt");
  }

  async #put(input: Parameters<ArtifactStore["put"]>[0], attemptId: string): Promise<ArtifactRef> {
    const resolved = await this.#resolve(attemptId);
    try {
      const ref = await resolved.store.put(input);
      this.#writtenSources.set(ref, resolved.source);
      return ref;
    } catch (error) {
      throw this.#failure(error, resolved.secrets);
    }
  }

  /** Receipt bound to this write, even if another upload refreshes the cached Volume. */
  uploadReceipt(ref: ArtifactRef): { readonly volume: string; readonly volumeSource: string } {
    const volumeSource = this.#writtenSources.get(ref);
    if (volumeSource === undefined) throw new Error("Artifact has no Volume write receipt");
    return { volume: this.volume, volumeSource };
  }

  /** Advertise a write only after the catalog accepts its publication. */
  async acceptUpload(ref: ArtifactRef, sizeBytes: number, attemptId: string): Promise<void> {
    const { volumeSource } = this.uploadReceipt(ref);
    if (!ref.digest) throw new Error("Invalid artifact reference or digest");
    await this.#recordUpload(
      { digest: ref.digest, sizeBytes, attemptId },
      this.#uploadScope(volumeSource),
    );
  }

  /** A refused publication must resolve the Volume again before another write. */
  invalidate(): void {
    this.#volume = undefined;
    this.#cached = undefined;
  }

  get(ref: ResourceRef): Promise<Uint8Array> {
    return this.#get(ref);
  }

  async #get(ref: ResourceRef, attemptId?: string): Promise<Uint8Array> {
    const resolved = await this.#resolve(attemptId, ref);
    try {
      return await resolved.store.get(ref);
    } catch (error) {
      throw this.#failure(error, resolved.secrets);
    }
  }

  async putStream(_ref: ResourceRef, _chunks: AsyncIterable<Uint8Array>): Promise<ArtifactRef> {
    throw new Error("Artifact Volume writes require a Task Attempt");
  }

  async #putStream(
    ref: ResourceRef,
    chunks: AsyncIterable<Uint8Array>,
    attemptId: string,
  ): Promise<ArtifactRef> {
    const resolved = await this.#resolve(attemptId);
    try {
      const written = await resolved.store.putStream(ref, chunks);
      this.#writtenSources.set(written, resolved.source);
      return written;
    } catch (error) {
      throw this.#failure(error, resolved.secrets);
    }
  }

  stream(ref: ResourceRef): AsyncIterable<Uint8Array> {
    return this.#stream(ref);
  }

  async *#stream(ref: ResourceRef, attemptId?: string): AsyncIterable<Uint8Array> {
    const resolved = await this.#resolve(attemptId, ref);
    try {
      yield* resolved.store.stream(ref);
    } catch (error) {
      throw this.#failure(error, resolved.secrets);
    }
  }

  async *inventory(): AsyncIterable<ArtifactInventoryEntry> {
    const scope = this.#uploadScope((await this.#lookup()).source);
    if (this.receiptDirectory === undefined) {
      for (const { digest, sizeBytes } of this.#uploads.get(scope)?.values() ?? [])
        yield { digest, sizeBytes };
      return;
    }
    const directory = join(this.receiptDirectory, scope);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const hex of entries) {
      if (!/^[a-f0-9]{64}$/u.test(hex)) continue;
      const receipt = await this.#readUpload(`sha256:${hex}`, scope);
      if (receipt) yield { digest: `sha256:${hex}`, sizeBytes: receipt.sizeBytes };
    }
  }

  discard(ref: ResourceRef): Promise<void> {
    return this.#discard(ref);
  }

  async #discard(ref: ResourceRef, attemptId?: string): Promise<void> {
    const resolved = await this.#resolve(attemptId, ref);
    try {
      await resolved.store.discard(ref);
      const digest = ref.digest ?? ref.uri.replace(/^supertag-artifact:/u, "");
      const scope = resolved.uploadScope;
      const receipt = await this.#readUpload(digest, scope);
      if (attemptId !== undefined && receipt?.attemptId !== attemptId) return;
      this.#uploads.get(scope)?.delete(digest);
      if (this.receiptDirectory !== undefined && /^sha256:[a-f0-9]{64}$/u.test(digest))
        await rm(join(this.receiptDirectory, scope, digest.slice("sha256:".length)), {
          force: true,
        });
    } catch (error) {
      throw this.#failure(error, resolved.secrets);
    }
  }

  // Scope private receipts to the source, not its rotatable credential or a shared listing.
  #uploadScope(source: string): string {
    return createHash("sha256")
      .update(JSON.stringify([this.volume, source]))
      .digest("hex");
  }

  async #recordUpload(
    copy: ArtifactInventoryEntry & { readonly attemptId: string },
    scope: string,
  ): Promise<void> {
    if (this.receiptDirectory === undefined) {
      let uploads = this.#uploads.get(scope);
      if (!uploads) {
        uploads = new Map();
        this.#uploads.set(scope, uploads);
      }
      uploads.set(copy.digest, copy);
      return;
    }
    const directory = join(this.receiptDirectory, scope);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.upload-${randomUUID()}`);
    try {
      await writeFile(
        temporary,
        JSON.stringify({ attemptId: copy.attemptId, sizeBytes: copy.sizeBytes }),
        { mode: 0o600, flag: "wx", flush: true },
      );
      await rename(temporary, join(directory, copy.digest.slice("sha256:".length)));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #readUpload(
    digest: string,
    scope: string,
  ): Promise<{ readonly attemptId: string; readonly sizeBytes: number } | undefined> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new Error("Invalid artifact reference or digest");
    if (this.receiptDirectory === undefined) return this.#uploads.get(scope)?.get(digest);
    let content: string;
    try {
      content = await readFile(join(this.receiptDirectory, scope, digest.slice(7)), "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const receipt = JSON.parse(content) as { attemptId: string; sizeBytes: number };
    artifactVolumeKey(receipt.attemptId, digest);
    if (
      !Number.isSafeInteger(receipt.sizeBytes) ||
      receipt.sizeBytes < 0 ||
      receipt.sizeBytes > MAX_ARTIFACT_BYTES
    )
      throw new Error("Invalid artifact upload receipt");
    return receipt;
  }

  /**
   * The Volume's current source as the catalog holds it, for the Workspace-mount guard. Rejects
   * when the catalog cannot be read, so a caller refuses rather than guesses.
   */
  async source(): Promise<string> {
    return (await this.#lookup()).source;
  }

  #lookup(): Promise<TaskWorkspaceVolume> {
    const now = (this.#options.now ?? Date.now)();
    const ttl = this.#options.lookupTtlMs ?? 30_000;
    if (this.#volume === undefined || now - this.#volume.at >= ttl) {
      const value = this.#options.lookup();
      // A failed lookup is not reused: the next operation asks again.
      value.catch(() => {
        if (this.#volume?.value === value) this.#volume = undefined;
      });
      this.#volume = { at: now, value };
    }
    return this.#volume.value;
  }

  async #resolve(
    attemptId?: string,
    ref?: ResourceRef,
  ): Promise<Resolved & { readonly source: string; readonly uploadScope: string }> {
    let volume: TaskWorkspaceVolume;
    try {
      volume = await this.#lookup();
    } catch {
      throw new ArtifactVolumeUnavailableError(
        `Artifact Volume ${this.#options.volume} could not be read from the catalog; apply a Volume with this name and check this Worker Host's connection`,
      );
    }
    if (attemptId === undefined) {
      if (!ref) throw new Error("Artifact Volume writes require a Task Attempt");
      const digest = ref.digest ?? ref.uri.replace(/^supertag-artifact:/u, "");
      attemptId = (await this.#readUpload(digest, this.#uploadScope(volume.source)))?.attemptId;
      if (attemptId === undefined) throw missingArtifactError();
    }
    this.#cached = await openArtifactVolume(
      { ...volume, name: this.#options.volume },
      this.#options.readCredential,
      `attempts/${attemptId}`,
      this.#cached,
    );
    return {
      ...this.#cached,
      source: volume.source,
      uploadScope: this.#uploadScope(volume.source),
    };
  }

  #failure(error: unknown, secrets: readonly string[]): Error {
    return artifactVolumeFailure(this.#options.volume, error, secrets);
  }
}

/**
 * Opens the content-addressed store at `directory` beneath a Volume's source: an S3-compatible
 * client built from the host's own mapped secret, or a directory inside the `file://` consent
 * directory the host maps. `previous` is reused while nothing it was built from changed.
 */
async function openArtifactVolume(
  volume: TaskWorkspaceVolume,
  readCredential: (credential: string) => Promise<string | { readonly path: string }>,
  directory: string,
  previous?: Resolved,
): Promise<Resolved> {
  const name = volume.name;
  const unavailable = (why: string) =>
    new ArtifactVolumeUnavailableError(`Artifact Volume ${name} ${why}`);
  let location: VolumeLocation;
  try {
    location = parseVolumeSource(volume.source);
  } catch {
    throw unavailable("has an invalid source");
  }
  if (location.scheme === "gs" || location.scheme === "modal-volume")
    throw unavailable(
      "uses a mount-only source; artifact storage requires file:// or S3-compatible storage",
    );
  const credential = volume.credential;
  if (credential === undefined)
    throw unavailable("names no credential for this Worker Host to map");
  let mapped: string | { readonly path: string };
  try {
    mapped = await readCredential(credential);
  } catch {
    throw unavailable(`needs a readable mapping for credential ${credential} on this Worker Host`);
  }
  if (location.scheme === "file") {
    if (typeof mapped !== "object" || !isAbsolute(mapped.path))
      throw unavailable("needs a { path: DIR } credential mapping for a file:// source");
    let allowed: string;
    let root: string;
    try {
      [allowed, root] = await Promise.all([realpath(mapped.path), realpath(location.path)]);
    } catch {
      throw unavailable("has a file:// source or consent directory that does not exist");
    }
    const rest = relative(allowed, root);
    if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest))
      throw unavailable("has a file:// source outside its consent directory");
    // `directory` holds only plain segments (see artifactVolumeKeyDirectory), so it stays inside.
    const target = directory ? join(root, ...directory.split("/")) : root;
    const key = `file:${volume.source}:${allowed}:${target}`;
    if (previous?.key === key) return previous;
    const source = location.path;
    const consent = mapped.path;
    // Rechecked before and after each write and on each read: a directory swapped for a symlink
    // after this resolution would otherwise redirect the store outside the consent directory.
    const verify = async () => {
      let now: readonly string[];
      try {
        now = await Promise.all([realpath(consent), realpath(source)]);
      } catch {
        throw unavailable("has a file:// source or consent directory that does not exist");
      }
      if (now[0] !== allowed || now[1] !== root)
        throw unavailable("has a file:// source outside its consent directory");
      // Check every existing ancestor before recursive mkdir. A missing final directory
      // does not prove that its parent (notably `attempts`) stays inside the Volume.
      let current = root;
      for (const segment of directory.split("/").filter(Boolean)) {
        current = join(current, segment);
        try {
          if (!(await lstat(current)).isDirectory() || (await realpath(current)) !== current)
            throw unavailable("has a file:// source outside its consent directory");
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
      }
    };
    return { key, store: new FileArtifactStore(target, { verify }), secrets: [] };
  }
  if (typeof mapped !== "string")
    throw unavailable("needs an object-store secret mapping, not a path");
  let credentials: VolumeCredentials;
  try {
    credentials = parseVolumeCredentialSecret(name, mapped);
  } catch (error) {
    // The parser's reasons name fields, never values.
    throw new ArtifactVolumeUnavailableError(
      error instanceof Error ? error.message : unavailable("has an unreadable secret").message,
    );
  }
  const prefix = [location.prefix.replace(/\/+$/u, ""), directory].filter(Boolean).join("/");
  const key = `${volume.source}:${prefix}:${createHash("sha256").update(mapped).digest("hex")}`;
  if (previous?.key === key) return previous;
  return {
    key,
    store: new S3ArtifactStore({
      bucket: location.bucket,
      prefix,
      region: location.region ?? (location.scheme === "r2" ? "auto" : "us-east-1"),
      ...(location.endpoint === undefined ? {} : { endpoint: location.endpoint }),
      ...(location.forcePathStyle === undefined ? {} : { forcePathStyle: location.forcePathStyle }),
      credentials,
    }),
    secrets: [
      credentials.secretAccessKey,
      credentials.accessKeyId,
      ...(credentials.sessionToken === undefined ? [] : [credentials.sessionToken]),
    ],
  };
}

/**
 * A provider failure as the Volume name and the provider's error code and HTTP status. The
 * provider's message, response, and cause are dropped: a signature error can echo the access
 * key ID, and a misbehaving endpoint can echo anything.
 */
function artifactVolumeFailure(volume: string, error: unknown, secrets: readonly string[]): Error {
  // A missing copy keeps its ENOENT code, so a Worklet fetches it from a peer instead.
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return missingArtifactError();
  // A refusal this store raised itself carries no provider text.
  if (error instanceof ArtifactVolumeUnavailableError) return error;
  // Rebuilt, so a provider error that happens to use one of these messages loses its fields.
  if (error instanceof Error && OWN_MESSAGES.has(error.message)) return new Error(error.message);
  const record = (error ?? {}) as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const code = [record.name, record.code].find(
    (value): value is string =>
      typeof value === "string" &&
      /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(value) &&
      value !== "Error" &&
      !secrets.some((secret) => secret !== "" && value.includes(secret)),
  );
  const status = record.$metadata?.httpStatusCode;
  const detail = [
    code,
    typeof status === "number" && Number.isInteger(status) ? `HTTP ${status}` : undefined,
  ]
    .filter((value) => value !== undefined)
    .join(", ");
  return new Error(`Artifact Volume ${volume} request failed${detail ? ` (${detail})` : ""}`);
}

/**
 * How a Worker Host maps a Volume's credential name to its own secret: its artifact Volume's
 * credential (a connected Worklet's `--artifact-volume-credential` file, or a host service's
 * `volume-credentials` entry), and, on a host service, any other `volume-credentials` entry.
 */
export interface ArtifactVolumeMappings {
  readonly artifactVolume?: {
    readonly name: string;
    readonly readCredential: (credential: string) => Promise<string | { readonly path: string }>;
  };
  readonly readVolumeCredential?: (
    credential: string,
  ) => Promise<string | { readonly path: string }>;
}

/**
 * Reads one copy the catalog recorded on a Volume, with this host's own mapping for the Volume,
 * for a Worklet's artifact store. Its caller passes only locations from a transfer resolution, so
 * the catalog has already checked the consumer's grant. It reads exactly the recorded key and
 * verifies the bytes against the entry's digest and size. It resolves undefined when this host
 * has no mapping for the Volume; the credential's value never leaves this process.
 */
export function artifactVolumeReader(
  mappings: ArtifactVolumeMappings,
): (
  location: ResolvedArtifactVolumeLocation,
  ref: ResourceRef,
  sizeBytes: number,
) => Promise<Uint8Array | undefined> {
  const cache = new Map<string, Resolved>();
  return async (location, ref, sizeBytes) => {
    const readCredential =
      location.volume === mappings.artifactVolume?.name
        ? mappings.artifactVolume.readCredential
        : mappings.readVolumeCredential;
    if (readCredential === undefined || location.credential === undefined) return undefined;
    try {
      await readCredential(location.credential);
    } catch {
      // This host does not map the Volume's credential, so it cannot read the Volume.
      return undefined;
    }
    if (!ref.digest) throw new Error("Invalid artifact reference or digest");
    const directory = artifactVolumeKeyDirectory(location.key, ref.digest);
    const cacheKey = `${location.volume}\u0000${directory}`;
    const resolved = await openArtifactVolume(
      { name: location.volume, source: location.source, credential: location.credential },
      readCredential,
      directory,
      cache.get(cacheKey),
    );
    // Bounded: per-Attempt key directories would otherwise grow it for the host's lifetime.
    cache.delete(cacheKey);
    cache.set(cacheKey, resolved);
    if (cache.size > 32) cache.delete(cache.keys().next().value as string);
    let bytes: Uint8Array;
    try {
      // Asking a directory store first never creates directories on the shared Volume.
      if (resolved.store instanceof FileArtifactStore && !(await resolved.store.has(ref)))
        throw missingArtifactError();
      bytes = await resolved.store.get(ref);
    } catch (error) {
      throw artifactVolumeFailure(location.volume, error, resolved.secrets);
    }
    if (bytes.byteLength !== sizeBytes) throw new Error("Artifact digest mismatch");
    return bytes;
  };
}

/**
 * Reads the credential `connect worklet --artifact-volume-credential file:PATH` names, each time
 * it is needed, so a rotated file takes effect. The file holds the object-store secret (a JSON
 * object with accessKeyId and secretAccessKey, and optionally sessionToken), or
 * `{ "path": "/DIR" }` to consent to a `file://` Volume inside DIR. Errors name the path, never
 * the contents.
 */
export function artifactVolumeCredentialFile(
  value: string,
): () => Promise<string | { readonly path: string }> {
  if (!value.startsWith("file:"))
    throw new Error(
      "--artifact-volume-credential takes file:PATH; the credential is never passed as a value",
    );
  const path = value.slice("file:".length);
  if (!path) throw new Error("--artifact-volume-credential file: requires a path");
  return async () => {
    let text: string;
    try {
      text = (await readFile(path, "utf8")).trim();
    } catch {
      throw new Error(`Artifact Volume credential file ${path} cannot be read`);
    }
    if (!text) throw new Error(`Artifact Volume credential file ${path} is empty`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      typeof (parsed as Record<string, unknown>)["path"] === "string"
    ) {
      const directory = (parsed as { path: string }).path;
      const isDirectory = isAbsolute(directory)
        ? await stat(directory).then(
            (entry) => entry.isDirectory(),
            () => false,
          )
        : false;
      if (!isDirectory)
        throw new Error(`Artifact Volume credential file ${path} must name an existing directory`);
      return { path: directory };
    }
    return text;
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
