import { isDeepStrictEqual } from "node:util";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type {
  SessionStateRef,
  SessionStateStore,
  StoredHarnessSessionState,
} from "@supertag/worker-sdk";
import {
  decodeSessionArchive,
  decodeSessionRef,
  encodeSessionArchive,
  encodeSessionRef,
  SaveHeaderSchema,
  SaveRequestSchema,
  SESSION_GRPC_CHUNK_BYTES,
  SESSION_GRPC_MAX_ARCHIVE_BYTES,
  SessionService,
  type StateHeader,
  sessionArchiveDigest,
} from "./session-codec.js";

/** Native state uses per-Attempt authority and a separate bounded archive stream. */
export class GrpcSessionStateStore implements SessionStateStore {
  readonly #client;
  readonly #versions = new Map<string, number>();
  readonly #token: string;

  constructor(options: {
    readonly baseUrl: string;
    readonly token: string;
    readonly tlsCa?: string;
  }) {
    const url = checkedUrl(options.baseUrl);
    if (!options.token.trim()) throw new Error("Session execution credential required");
    this.#token = options.token;
    this.#client = createClient(
      SessionService,
      createGrpcTransport({
        baseUrl: url.origin,
        readMaxBytes: SESSION_GRPC_CHUNK_BYTES + 1024,
        writeMaxBytes: SESSION_GRPC_CHUNK_BYTES + 1024,
        idleConnectionTimeoutMs: 1000,
        ...(options.tlsCa === undefined ? {} : { nodeOptions: { ca: options.tlsCa } }),
      }),
    );
  }

  async save(state: StoredHarnessSessionState): Promise<void> {
    const archive = encodeSessionArchive(state.data);
    const version = (this.#versions.get(state.ref.id) ?? 0) + 1;
    if (!Number.isSafeInteger(version)) throw new Error("Session write version exhausted");
    this.#versions.set(state.ref.id, version);
    const header = create(SaveHeaderSchema, {
      ref: encodeSessionRef(state.ref),
      harnessId: state.harnessId,
      writeVersion: BigInt(version),
      archiveSize: archive.byteLength,
      archiveSha256: sessionArchiveDigest(archive),
    });
    await this.#authorized(async (token, signal) => {
      async function* frames() {
        yield create(SaveRequestSchema, { frame: { case: "header", value: header } });
        for (let offset = 0; offset < archive.byteLength; offset += SESSION_GRPC_CHUNK_BYTES)
          yield create(SaveRequestSchema, {
            frame: {
              case: "chunk",
              value: archive.subarray(offset, offset + SESSION_GRPC_CHUNK_BYTES),
            },
          });
      }
      const result = await this.#client.save(frames(), {
        headers: { authorization: `Bearer ${token}` },
        signal,
        timeoutMs: 30_000,
      });
      if (result.writeVersion !== header.writeVersion)
        throw new Error("Session write acknowledgement mismatch");
    });
  }

  async load(ref: SessionStateRef): Promise<StoredHarnessSessionState | undefined> {
    const request = { ref: encodeSessionRef(ref) };
    const expectedRef = decodeSessionRef(request.ref);
    return this.#authorized(async (token, signal) => {
      let header: StateHeader | undefined;
      let missing = false;
      let size = 0;
      let archive: Uint8Array | undefined;
      let chunkCount = 0;
      for await (const response of this.#client.load(request, {
        headers: { authorization: `Bearer ${token}` },
        signal,
        timeoutMs: 30_000,
      })) {
        const frame = response.frame;
        if (missing) throw new Error("Unexpected Session frame after missing result");
        if (frame.case === "notFound" && frame.value && header === undefined) {
          missing = true;
          continue;
        }
        if (frame.case === "header" && header === undefined) {
          header = frame.value;
          if (
            !header.harnessId.trim() ||
            header.archiveSize < 2 ||
            header.archiveSize > SESSION_GRPC_MAX_ARCHIVE_BYTES ||
            !isDeepStrictEqual(decodeSessionRef(header.ref), expectedRef)
          )
            throw new Error("Invalid Session archive header");
          archive = new Uint8Array(header.archiveSize);
          continue;
        }
        if (
          frame.case !== "chunk" ||
          !header ||
          !archive ||
          ++chunkCount > 1024 ||
          frame.value.byteLength === 0 ||
          frame.value.byteLength > SESSION_GRPC_CHUNK_BYTES
        )
          throw new Error("Invalid Session archive stream");
        size += frame.value.byteLength;
        if (size > header.archiveSize || size > SESSION_GRPC_MAX_ARCHIVE_BYTES)
          throw new Error("Session archive exceeds declared size");
        archive.set(frame.value, size - frame.value.byteLength);
      }
      if (missing) return undefined;
      if (!header || !archive || size !== header.archiveSize)
        throw new Error("Incomplete Session archive");
      if (sessionArchiveDigest(archive) !== header.archiveSha256)
        throw new Error("Session archive digest mismatch");
      return {
        ref: decodeSessionRef(header.ref),
        harnessId: header.harnessId,
        data: decodeSessionArchive(archive),
      };
    });
  }

  async #authorized<T>(call: (token: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    return call(this.#token, AbortSignal.timeout(30_000));
  }
}

function checkedUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Session persistence requires HTTPS outside loopback and an origin URL");
  return url;
}
