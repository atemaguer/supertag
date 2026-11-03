import { type KeyLike, sign, verify } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  type AnyArtifactTransferGrantClaims,
  artifactUnavailableMessage,
  type ResolvedArtifactTransfer,
  type ResolvedArtifactTransferLocation,
  type ResolvedArtifactVolumeLocation,
} from "@supertag/core";
import {
  type ArtifactCopies,
  type ArtifactInventoryEntry,
  type ArtifactStore,
  FileArtifactStore,
  MAX_ARTIFACT_BYTES,
  type StreamingArtifactStore,
} from "./artifact-store.js";
import type { ArtifactRef, ResourceRef } from "./index.js";

export const WORKLET_ARTIFACT_TRANSFER_PATH = "/v1/artifacts";
export const MAX_ARTIFACT_TRANSFER_GRANT_BYTES = 16 * 1024;
export const MAX_ARTIFACT_TRANSFER_GRANT_TTL_MS = 15 * 60_000;

export interface ArtifactTransferGrantExpectations {
  readonly sourceWorkerHostId: string;
  readonly digest: string;
  readonly now?: Date;
}

/** Creates a compact bearer grant. Its Ed25519 signature can be checked without a Control Plane call. */
export function signArtifactTransferGrant(
  claims: AnyArtifactTransferGrantClaims,
  privateKey: KeyLike,
): string {
  validateArtifactTransferGrantClaims(claims, new Date(claims.issuedAt));
  const payload = Buffer.from(JSON.stringify(claims), "utf8");
  if (payload.byteLength > MAX_ARTIFACT_TRANSFER_GRANT_BYTES)
    throw new Error("Artifact transfer grant is too large");
  const signature = sign(null, payload, privateKey);
  return `${payload.toString("base64url")}.${signature.toString("base64url")}`;
}

/** Verifies signature, source binding, content binding, lifetime, and all bounded claim fields. */
export function verifyArtifactTransferGrant(
  token: string,
  publicKey: KeyLike,
  expectations: ArtifactTransferGrantExpectations,
): AnyArtifactTransferGrantClaims {
  if (!token || token.length > MAX_ARTIFACT_TRANSFER_GRANT_BYTES * 2)
    throw new Error("Invalid artifact transfer grant");
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !/^[A-Za-z0-9_-]+$/u.test(parts[0]) ||
    !/^[A-Za-z0-9_-]+$/u.test(parts[1])
  )
    throw new Error("Invalid artifact transfer grant");
  const payload = Buffer.from(parts[0], "base64url");
  const signature = Buffer.from(parts[1], "base64url");
  if (
    payload.toString("base64url") !== parts[0] ||
    signature.toString("base64url") !== parts[1] ||
    payload.byteLength > MAX_ARTIFACT_TRANSFER_GRANT_BYTES ||
    !verify(null, payload, publicKey, signature)
  )
    throw new Error("Invalid artifact transfer grant signature");
  let claims: unknown;
  try {
    claims = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("Invalid artifact transfer grant payload");
  }
  validateArtifactTransferGrantClaims(claims, expectations.now ?? new Date());
  if (claims.sourceWorkerHostId !== expectations.sourceWorkerHostId)
    throw new Error("Artifact transfer grant is for another source Worker Host");
  if (claims.digest !== expectations.digest)
    throw new Error("Artifact transfer grant does not match the requested content");
  return claims;
}

/** The claims both shapes carry: the file, its source host, and the grant's lifetime. */
const COMMON_GRANT_KEYS = [
  "version",
  "grantId",
  "artifactId",
  "path",
  "digest",
  "sizeBytes",
  "sourceWorkerHostId",
  "issuedAt",
  "expiresAt",
] as const;
/** A consuming Task Attempt's Worker Host. */
const WORKER_HOST_RECIPIENT_KEYS = [
  "recipientWorkerHostId",
  "recipientConnectionGeneration",
  "taskId",
  "attemptId",
] as const;
/** An operator's `supertag download artifact`. */
const OPERATOR_RECIPIENT_KEYS = ["recipientOperatorId"] as const;

function validateArtifactTransferGrantClaims(
  value: unknown,
  now: Date,
): asserts value is AnyArtifactTransferGrantClaims {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid artifact transfer grant claims");
  const claims = value as Record<string, unknown>;
  // Exactly one recipient shape, with no other keys: a grant names one consumer.
  const recipientKeys =
    "recipientOperatorId" in claims ? OPERATOR_RECIPIENT_KEYS : WORKER_HOST_RECIPIENT_KEYS;
  const keys: readonly string[] = [...COMMON_GRANT_KEYS, ...recipientKeys];
  if (Object.keys(claims).length !== keys.length || keys.some((key) => !(key in claims)))
    throw new Error("Invalid artifact transfer grant claims");
  if (claims["version"] !== 1) throw new Error("Unsupported artifact transfer grant version");
  const strings =
    recipientKeys === OPERATOR_RECIPIENT_KEYS
      ? ["recipientOperatorId"]
      : ["recipientWorkerHostId", "taskId", "attemptId"];
  for (const key of ["grantId", "artifactId", "path", "sourceWorkerHostId", ...strings]) {
    const field = claims[key];
    if (
      typeof field !== "string" ||
      !field ||
      field.length > 1024 ||
      [...field].some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error(`Invalid artifact transfer grant ${key}`);
  }
  if (typeof claims["digest"] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(claims["digest"]))
    throw new Error("Invalid artifact transfer grant digest");
  if (
    typeof claims["sizeBytes"] !== "number" ||
    !Number.isSafeInteger(claims["sizeBytes"]) ||
    claims["sizeBytes"] < 0 ||
    claims["sizeBytes"] > MAX_ARTIFACT_BYTES
  )
    throw new Error("Invalid artifact transfer grant size");
  if (
    recipientKeys === WORKER_HOST_RECIPIENT_KEYS &&
    (typeof claims["recipientConnectionGeneration"] !== "number" ||
      !Number.isSafeInteger(claims["recipientConnectionGeneration"]) ||
      claims["recipientConnectionGeneration"] < 1)
  )
    throw new Error("Invalid artifact transfer recipient generation");
  if (typeof claims["issuedAt"] !== "string" || typeof claims["expiresAt"] !== "string")
    throw new Error("Invalid artifact transfer grant lifetime");
  const issuedAt = Date.parse(claims["issuedAt"]);
  const expiresAt = Date.parse(claims["expiresAt"]);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(issuedAt).toISOString() !== claims["issuedAt"] ||
    new Date(expiresAt).toISOString() !== claims["expiresAt"] ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_ARTIFACT_TRANSFER_GRANT_TTL_MS ||
    issuedAt > now.getTime() + 60_000 ||
    expiresAt <= now.getTime()
  )
    throw new Error("Artifact transfer grant is expired or has an invalid lifetime");
}

export interface WorkletArtifactTransferServerOptions {
  readonly workerHostId: string;
  readonly store: ArtifactStore;
  readonly verificationKey: KeyLike;
  readonly onError?: (error: unknown) => void;
}

export interface WorkletArtifactListenOptions {
  readonly host?: string;
  readonly port?: number;
  /** Public base URL through which other Worklets reach this endpoint. */
  readonly advertiseUrl?: string;
  /** Development-only escape hatch for isolated Docker/private-network tests. */
  readonly allowInsecureHttp?: boolean;
}

/** Worklet-scoped HTTP server for direct, grant-authorized artifact reads. */
export class WorkletArtifactTransferServer {
  readonly #server: Server;
  #advertisedUrl: string | undefined;
  constructor(readonly options: WorkletArtifactTransferServerOptions) {
    if (!options.workerHostId.trim()) throw new Error("Artifact server requires a Worker Host id");
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        options.onError?.(error);
        if (!response.headersSent) {
          response.writeHead(500, { "cache-control": "no-store", connection: "close" });
          response.end();
        } else response.destroy();
      });
    });
  }
  get url(): string | undefined {
    return this.#advertisedUrl;
  }
  async listen(options: WorkletArtifactListenOptions = {}): Promise<string> {
    if (this.#server.listening) throw new Error("Artifact transfer server is already listening");
    const host = options.host ?? "127.0.0.1";
    const advertised =
      options.advertiseUrl === undefined
        ? undefined
        : validateTransferUrl(options.advertiseUrl, options.allowInsecureHttp ?? false);
    if (advertised && advertised.pathname !== "/")
      throw new Error("Worklet artifact transfer base URL must not include a path");
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(options.port ?? 0, host, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (!address || typeof address === "string")
      throw new Error("Artifact server address unavailable");
    const url =
      advertised ??
      validateTransferUrl(
        `http://${loopbackAdvertisement(host)}:${address.port}`,
        options.allowInsecureHttp ?? false,
      );
    url.pathname = "/";
    this.#advertisedUrl = url.origin;
    return this.#advertisedUrl;
  }
  async close(): Promise<void> {
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
    this.#advertisedUrl = undefined;
  }
  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://worklet.invalid");
    const match = /^\/v1\/artifacts\/([a-f0-9]{64})$/u.exec(url.pathname);
    if (request.method !== "GET" || !match || url.search) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    const digest = `sha256:${match[1]}`;
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      response.writeHead(401, { "cache-control": "no-store", "www-authenticate": "Bearer" });
      response.end();
      return;
    }
    let claims: AnyArtifactTransferGrantClaims;
    try {
      claims = verifyArtifactTransferGrant(authorization.slice(7), this.options.verificationKey, {
        sourceWorkerHostId: this.options.workerHostId,
        digest,
      });
    } catch {
      response.writeHead(403, { "cache-control": "no-store" });
      response.end();
      return;
    }
    const ref: ResourceRef = {
      uri: `supertag-artifact:${digest}`,
      digest,
      artifactId: claims.artifactId,
      path: claims.path,
    };
    let iterator: AsyncIterator<Uint8Array> | undefined;
    let first: IteratorResult<Uint8Array>;
    try {
      if (isStreamingArtifactStore(this.options.store))
        iterator = this.options.store.stream(ref)[Symbol.asyncIterator]();
      else iterator = chunksFor(await this.options.store.get(ref))[Symbol.asyncIterator]();
      first = await iterator.next();
    } catch {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
      "content-length": String(claims.sizeBytes),
      "x-supertag-artifact-digest": digest,
    });
    let size = 0;
    try {
      let item = first;
      while (!item.done) {
        size += item.value.byteLength;
        if (size > claims.sizeBytes || size > MAX_ARTIFACT_BYTES)
          throw new Error("Stored artifact size does not match transfer grant");
        if (!response.write(item.value)) await once(response, "drain");
        item = await iterator.next();
      }
      if (size !== claims.sizeBytes)
        throw new Error("Stored artifact size does not match transfer grant");
      response.end();
    } finally {
      await iterator.return?.();
    }
  }
}

export interface WorkletArtifactPublication {
  readonly ref: ArtifactRef;
  readonly sizeBytes: number;
}

export type WorkletArtifactStoreOptions = WorkletArtifactStoreSettings &
  (
    | {
        /** A private directory on the Worker Host for this Worklet's copies. */
        readonly directory: string;
        readonly copies?: undefined;
      }
    | {
        /** Where this Worklet's copies live instead of a directory, such as a Volume. */
        readonly copies: ArtifactCopies;
        readonly directory?: undefined;
      }
  );

export interface WorkletArtifactStoreSettings {
  /**
   * Resolve one admitted catalog entry to currently authorized locations: serving hosts' transfer
   * endpoints with grants, and copies on Volumes this host maps. The catalog checks the
   * consumer's grant on every call.
   */
  readonly resolve: (ref: ResourceRef) => Promise<ResolvedArtifactTransfer>;
  /** Called after local durable publication; retries are safe because content is addressed by digest. */
  readonly publish?: (publication: WorkletArtifactPublication) => Promise<void>;
  /**
   * Reads a resolved copy on a Volume with this host's own mapping, at exactly its recorded key,
   * verified against the entry's digest and size; resolves undefined when this host does not map
   * that Volume. Without it, this host reads no Volume copies.
   */
  readonly readVolume?: (
    location: ResolvedArtifactVolumeLocation,
    ref: ResourceRef,
    sizeBytes: number,
  ) => Promise<Uint8Array | undefined>;
  /**
   * Whether `copies` can hold bytes other hosts wrote, as a shared artifact Volume does. Then a
   * read of anything this store did not write or fetch itself passes the catalog's grant check
   * first, so holding a Volume's other copies grants nothing.
   */
  readonly sharedCopies?: boolean;
  readonly allowInsecureHttp?: boolean;
  readonly fetch?: typeof fetch;
}

/**
 * ArtifactStore-compatible local-first storage for one Worklet-hosted Attempt. A copy missing
 * here comes from a Volume this host maps or, failing that, directly from a serving host; the
 * Control Plane only resolves where it is and checks the grant, and never carries the bytes.
 */
export class WorkletArtifactStore implements ArtifactStore {
  readonly local: ArtifactCopies;
  readonly #transfers: WorkletArtifactTransferClient;
  readonly #fetches = new Map<string, Promise<Uint8Array>>();
  /** Digests this store wrote or fetched itself, which it reads from `local` without asking. */
  readonly #held = new Set<string>();
  constructor(readonly options: WorkletArtifactStoreOptions) {
    this.local = options.copies ?? new FileArtifactStore(options.directory);
    this.#transfers = new WorkletArtifactTransferClient({
      store: this.local,
      ...(options.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: options.allowInsecureHttp }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }
  async put(input: Parameters<ArtifactStore["put"]>[0]): Promise<ArtifactRef> {
    const ref = await this.local.put(input);
    if (ref.digest) this.#held.add(ref.digest);
    await this.options.publish?.({ ref, sizeBytes: input.bytes.byteLength });
    return ref;
  }
  async get(ref: ResourceRef): Promise<Uint8Array> {
    const key = ref.digest ?? ref.uri;
    // On a shared Volume, `local` also holds copies other hosts wrote: only this store's own
    // copies are read without the catalog's grant check.
    if (!this.options.sharedCopies || this.#held.has(key)) {
      try {
        return await this.local.get(ref);
      } catch (error) {
        if (!isMissingOrCorruptArtifact(error)) throw error;
        if (isCorruptArtifact(error)) await this.local.discard(ref);
      }
    }
    let fetching = this.#fetches.get(key);
    if (!fetching) {
      fetching = this.#fetch(ref).finally(() => this.#fetches.delete(key));
      this.#fetches.set(key, fetching);
    }
    return fetching;
  }
  async #fetch(ref: ResourceRef): Promise<Uint8Array> {
    // The catalog checks this Attempt's grant for the file before naming any location.
    const resolved = await this.options.resolve(ref);
    validateResolution(ref, resolved);
    const failures: unknown[] = [];
    // A Volume copy first: it needs no reachable peer, and outlives an ephemeral producer.
    for (const location of resolved.volumes) {
      try {
        const bytes = await this.options.readVolume?.(location, ref, resolved.sizeBytes);
        if (bytes !== undefined) return bytes;
      } catch (error) {
        failures.push(error);
      }
    }
    if (resolved.locations.length) {
      try {
        await this.#transfers.fetch(ref, resolved.locations, resolved.sizeBytes);
        if (ref.digest) this.#held.add(ref.digest);
        return await this.local.get(ref);
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(
      failures,
      artifactUnavailableMessage({
        artifactId: resolved.artifactId,
        path: resolved.path,
        holders: resolved.holders,
      }),
    );
  }
  inventory(): AsyncIterable<ArtifactInventoryEntry> {
    return this.local.inventory();
  }
}

export interface WorkletArtifactTransferClientOptions {
  readonly store: StreamingArtifactStore;
  readonly allowInsecureHttp?: boolean;
  readonly fetch?: typeof fetch;
}

/** Fetches bytes directly from a serving Worklet and atomically verifies them into local storage. */
export class WorkletArtifactTransferClient {
  readonly #fetch: typeof fetch;
  constructor(readonly options: WorkletArtifactTransferClientOptions) {
    this.#fetch = options.fetch ?? fetch;
  }
  async fetch(
    ref: ResourceRef,
    locations: readonly ResolvedArtifactTransferLocation[],
    sizeBytes: number,
    signal?: AbortSignal,
  ): Promise<ArtifactRef> {
    if (!locations.length) throw new Error("Artifact has no available direct-transfer location");
    const failures: unknown[] = [];
    for (const location of locations) {
      try {
        const url = validateTransferUrl(
          location.transferUrl,
          this.options.allowInsecureHttp ?? false,
        );
        const digest = artifactHexDigest(ref);
        if (url.pathname !== `${WORKLET_ARTIFACT_TRANSFER_PATH}/${digest}`)
          throw new Error("Resolved Worklet artifact URL does not match the requested digest");
        const timeout = AbortSignal.timeout(30_000);
        const response = await this.#fetch(url, {
          method: "GET",
          headers: { authorization: `Bearer ${location.grant}` },
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`Artifact Worklet transfer failed (HTTP ${response.status})`);
        }
        if (response.headers.get("x-supertag-artifact-digest") !== ref.digest) {
          await response.body.cancel();
          throw new Error("Artifact Worklet response digest does not match request");
        }
        const length = Number(response.headers.get("content-length"));
        if (!Number.isSafeInteger(length) || length !== sizeBytes || length > MAX_ARTIFACT_BYTES) {
          await response.body.cancel();
          throw new Error("Artifact Worklet response size does not match manifest");
        }
        const reader = response.body.getReader();
        const chunks = (async function* () {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) return;
              yield value;
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        })();
        return await this.options.store.putStream(ref, chunks);
      } catch (error) {
        failures.push(error);
        if (signal?.aborted) throw error;
      }
    }
    throw new AggregateError(failures, "Artifact direct transfer failed at every location");
  }
}

function validateResolution(ref: ResourceRef, value: ResolvedArtifactTransfer): void {
  if (
    !ref.artifactId ||
    !ref.path ||
    value.artifactId !== ref.artifactId ||
    value.path !== ref.path ||
    value.digest !== ref.digest ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    value.sizeBytes > MAX_ARTIFACT_BYTES ||
    !Array.isArray(value.locations) ||
    !Array.isArray(value.volumes) ||
    value.volumes.some(
      (volume) =>
        typeof volume?.volume !== "string" ||
        typeof volume.source !== "string" ||
        typeof volume.key !== "string" ||
        (volume.credential !== undefined && typeof volume.credential !== "string"),
    ) ||
    !Array.isArray(value.holders?.workerHostIds) ||
    !Array.isArray(value.holders?.volumes)
  )
    throw new Error("Resolved artifact transfer does not match the requested catalog entry");
}

function artifactHexDigest(ref: ResourceRef): string {
  const digest = /^supertag-artifact:sha256:([a-f0-9]{64})$/u.exec(ref.uri)?.[1];
  if (!digest || ref.digest !== `sha256:${digest}`)
    throw new Error("Invalid artifact reference or digest");
  return digest;
}

function isStreamingArtifactStore(store: ArtifactStore): store is StreamingArtifactStore {
  return "stream" in store && typeof store.stream === "function";
}

function isMissingOrCorruptArtifact(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("code" in error && error.code === "ENOENT") || isCorruptArtifact(error))
  );
}

function isCorruptArtifact(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      "Artifact digest mismatch",
      "Artifact exceeds 32 MiB limit",
      "Artifact content must be a regular file",
    ].includes(error.message)
  );
}

async function* chunksFor(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024)
    yield bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.byteLength));
}

function validateTransferUrl(value: string, allowInsecureHttp: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Invalid Worklet artifact transfer URL");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (allowInsecureHttp || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Worklet artifact transfer requires HTTPS outside loopback");
  return url;
}

function loopbackAdvertisement(host: string): string {
  if (host === "::" || host === "0.0.0.0") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
