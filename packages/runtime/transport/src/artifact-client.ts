import { type DescMessage, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { RegisterWorkerArtifactCopiesResult, ResolvedArtifactTransfer } from "@supertag/core";
import {
  type ArtifactCatalogOperation,
  type ArtifactCatalogTransport,
  ArtifactRequestError,
} from "@supertag/worker-sdk";
import {
  artifactSafeInteger,
  decodeArtifactAcquisition,
  decodeArtifactDiscoveryPage,
  decodeCapturedArtifact,
  decodeResolvedArtifactTransfer,
} from "./artifact-codec.js";
import {
  AcquireRequestSchema,
  ArtifactCatalogService,
  ArtifactHostService,
  CaptureRequestSchema,
  FindRequestSchema,
  InspectRequestSchema,
  RecordUploadRequestSchema,
  RegisterCopiesRequestSchema,
  ResolveTransferRequestSchema,
  SettleRequestSchema,
} from "./gen/supertag/artifact/v1/artifact_pb.js";

interface Options {
  readonly baseUrl: string;
  readonly token: string;
  readonly tlsCa?: string;
}
function origin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Artifact metadata requires HTTPS outside loopback and an origin URL");
  return url.origin;
}
function transport(options: Options) {
  if (!options.token.trim()) throw new Error("Artifact credential required");
  return createGrpcTransport({
    baseUrl: origin(options.baseUrl),
    readMaxBytes: 256 * 1024,
    writeMaxBytes: 256 * 1024,
    idleConnectionTimeoutMs: 1000,
    ...(options.tlsCa ? { nodeOptions: { ca: options.tlsCa } } : {}),
  });
}
function snapshot(value: unknown): JsonValue {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 256 * 1024) throw new Error("Artifact metadata exceeds limit");
  return JSON.parse(json) as JsonValue;
}
function parse<D extends DescMessage>(schema: D, value: unknown) {
  return fromJson(schema, snapshot(value));
}
/** Per-Attempt metadata client. Transport failures are never automatically replayed. */
export class GrpcArtifactCatalogClient implements ArtifactCatalogTransport {
  readonly #client;
  readonly #token: string;
  constructor(options: Options) {
    this.#client = createClient(ArtifactCatalogService, transport(options));
    this.#token = options.token;
  }
  async request<T>(
    operation: ArtifactCatalogOperation,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    input = snapshot(input);
    return (await this.#call(
      operation,
      async (options) => {
        switch (operation) {
          case "find":
            return decodeArtifactDiscoveryPage(
              await this.#client.find(parse(FindRequestSchema, input), options),
            );
          case "inspect":
            return {
              artifact: decodeCapturedArtifact(
                (await this.#client.inspect(parse(InspectRequestSchema, input), options)).artifact,
              ),
            };
          case "capture":
            return {
              artifact: decodeCapturedArtifact(
                (await this.#client.capture(parse(CaptureRequestSchema, input), options)).artifact,
              ),
            };
          case "acquire": {
            const result = await this.#client.acquire(parse(AcquireRequestSchema, input), options);
            return {
              artifact: decodeCapturedArtifact(result.artifact),
              acquisition: decodeArtifactAcquisition(result.acquisition),
            };
          }
          case "settle":
            return {
              acquisition: decodeArtifactAcquisition(
                (await this.#client.settle(parse(SettleRequestSchema, input), options)).acquisition,
              ),
            };
        }
      },
      signal,
    )) as T;
  }
  resolveTransfer(
    input: { readonly artifactId: string; readonly path: string },
    signal?: AbortSignal,
  ): Promise<ResolvedArtifactTransfer> {
    input = { ...input };
    return this.#call(
      "resolve-transfer",
      async (options) =>
        decodeResolvedArtifactTransfer(
          await this.#client.resolveTransfer(parse(ResolveTransferRequestSchema, input), options),
        ),
      signal,
    );
  }
  /** `volume` names the artifact Volume the host stored the bytes on; omitted means on the host. */
  async recordUpload(
    input: {
      readonly digest: string;
      readonly sizeBytes: number;
      readonly volume?: string;
      readonly volumeSource?: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    input = { ...input };
    await this.#call(
      "upload",
      (options) => this.#client.recordUpload(parse(RecordUploadRequestSchema, input), options),
      signal,
    );
  }
  async #call<T>(
    operation: string,
    call: (options: {
      headers: { authorization: string };
      signal: AbortSignal;
      timeoutMs: number;
    }) => Promise<T>,
    parent?: AbortSignal,
  ): Promise<T> {
    const signal = parent
      ? AbortSignal.any([parent, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    try {
      return await call({
        headers: { authorization: `Bearer ${this.#token}` },
        signal,
        timeoutMs: 30_000,
      });
    } catch (error) {
      if (error instanceof ConnectError) {
        const status = (
          {
            [Code.InvalidArgument]: 400,
            [Code.Unauthenticated]: 401,
            [Code.PermissionDenied]: 403,
            [Code.NotFound]: 404,
            [Code.AlreadyExists]: 409,
            [Code.FailedPrecondition]: 409,
            [Code.ResourceExhausted]: 429,
          } as Partial<Record<Code, number>>
        )[error.code];
        if (status) throw new ArtifactRequestError(operation, status);
      }
      throw error;
    }
  }
}
/** Host authority is limited to inventory reports, never catalog reads or transfer grants. */
export class GrpcArtifactHostClient {
  readonly #client;
  constructor(readonly options: Options & { readonly workerHostId: string }) {
    this.#client = createClient(ArtifactHostService, transport(options));
  }
  async registerCopies(input: {
    readonly inventoryRevision: number;
    readonly transferBaseUrl: string;
    readonly copies: readonly { readonly digest: string; readonly sizeBytes: number }[];
  }): Promise<RegisterWorkerArtifactCopiesResult> {
    if (!Number.isSafeInteger(input.inventoryRevision) || input.inventoryRevision < 1)
      throw new Error("Invalid inventory revision");
    const result = await this.#client.registerCopies(
      parse(RegisterCopiesRequestSchema, { ...input, workerHostId: this.options.workerHostId }),
      { headers: { authorization: `Bearer ${this.options.token}` }, timeoutMs: 30_000 },
    );
    return {
      accepted: result.accepted,
      connectionGeneration: artifactSafeInteger(result.connectionGeneration),
      inventoryRevision: artifactSafeInteger(result.inventoryRevision),
    };
  }
  async getTransferKey(): Promise<{ algorithm: string; publicKey: string }> {
    const result = await this.#client.getTransferKey({}, { timeoutMs: 30_000 });
    if (result.algorithm !== "Ed25519" || !result.publicKey)
      throw new Error("Invalid artifact verification key");
    return { algorithm: result.algorithm, publicKey: result.publicKey };
  }
  /** The artifact Volume this host advertises: its source and credential name, never a value. */
  async getArtifactVolume(
    name: string,
  ): Promise<{ readonly name: string; readonly source: string; readonly credential?: string }> {
    const result = await this.#client.getArtifactVolume(
      { workerHostId: this.options.workerHostId, name },
      { headers: { authorization: `Bearer ${this.options.token}` }, timeoutMs: 30_000 },
    );
    if (result.name !== name || !result.source) throw new Error("Invalid artifact Volume");
    return {
      name: result.name,
      source: result.source,
      ...(result.credential === undefined ? {} : { credential: result.credential }),
    };
  }
}
