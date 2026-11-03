import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import type { ArtifactCatalog } from "@supertag/control-plane";
import {
  type ArtifactAcquisition,
  ArtifactCatalogError,
  type ArtifactDiscoveryPage,
  type CapturedArtifact,
  TagMessagingError,
  type WorkerHost,
} from "@supertag/core";
import { MAX_ARTIFACT_BYTES } from "@supertag/worker-sdk";
import {
  ARTIFACT_GRPC_MAX_METADATA_BYTES,
  ArtifactCatalogService,
  ArtifactHostService,
  artifactSafeInteger,
  decodeArtifactEntry,
  encodeArtifactAcquisition,
  encodeArtifactDiscoveryPage,
  encodeCapturedArtifact,
  encodeResolvedArtifactTransfer,
} from "@supertag/worker-transport";

/** Metadata-only API edge; catalog owners retain authorization, receipts and generation fencing. */
export function registerArtifactGrpcRoutes(
  router: ConnectRouter,
  catalog: ArtifactCatalog,
  options: {
    readonly beginRequest?: () => () => void;
    readonly directTransfers?: {
      readonly publicKey: string;
      readonly authenticateWorkerHost: (
        id: string,
        token: string | undefined,
      ) => Promise<WorkerHost | undefined>;
    };
  } = {},
): void {
  let active = 0;
  async function run<T>(
    context: HandlerContext,
    operation: (token: string | undefined) => Promise<T>,
  ): Promise<T> {
    const timeout = context.timeoutMs();
    if (timeout === undefined || timeout > 60_000)
      throw new ConnectError(
        "Artifact calls require a deadline of at most 60 seconds",
        Code.InvalidArgument,
      );
    if (active >= 64)
      throw new ConnectError("Artifact metadata capacity exhausted", Code.ResourceExhausted);
    const release = options.beginRequest?.();
    active++;
    try {
      if (context.signal.aborted)
        throw new ConnectError("Artifact request cancelled", Code.Canceled);
      const authorization = context.requestHeader.get("authorization");
      return await operation(
        authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined,
      );
    } catch (error) {
      throw artifactError(error);
    } finally {
      active--;
      release?.();
    }
  }
  const limits = {
    maxTimeoutMs: 60_000,
    readMaxBytes: ARTIFACT_GRPC_MAX_METADATA_BYTES,
    writeMaxBytes: ARTIFACT_GRPC_MAX_METADATA_BYTES,
  };
  router.service(
    ArtifactCatalogService,
    {
      find: (request, context) =>
        run(context, async (token) => {
          const result = (await catalog.command(
            "find",
            {
              ...(request.query === undefined ? {} : { query: request.query }),
              ...(request.kind === undefined ? {} : { kind: request.kind }),
              ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
              ...(request.limit === undefined ? {} : { limit: request.limit }),
              ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            },
            token,
          )) as ArtifactDiscoveryPage;
          return encodeArtifactDiscoveryPage(result);
        }),
      inspect: (request, context) =>
        run(context, async (token) => {
          const result = (await catalog.command(
            "inspect",
            { artifactId: request.artifactId },
            token,
          )) as { artifact: CapturedArtifact };
          return { artifact: encodeCapturedArtifact(result.artifact) };
        }),
      capture: (request, context) =>
        run(context, async (token) => {
          const result = (await catalog.command(
            "capture",
            {
              operationId: request.operationId,
              title: request.title,
              kind: request.kind,
              entries: request.entries.map(decodeArtifactEntry),
              ...(request.summary === undefined ? {} : { summary: request.summary }),
              ...(request.harnessSession === undefined
                ? {}
                : {
                    harnessSession: {
                      harnessId: request.harnessSession.harnessId,
                      id: request.harnessSession.id,
                    },
                  }),
            },
            token,
          )) as { artifact: CapturedArtifact };
          return { artifact: encodeCapturedArtifact(result.artifact) };
        }),
      acquire: (request, context) =>
        run(context, async (token) => {
          const result = (await catalog.command(
            "acquire",
            {
              operationId: request.operationId,
              artifactId: request.artifactId,
              paths: request.paths,
              delivery: request.delivery,
              ...(request.destination === undefined ? {} : { destination: request.destination }),
            },
            token,
          )) as { artifact: CapturedArtifact; acquisition: ArtifactAcquisition };
          return {
            artifact: encodeCapturedArtifact(result.artifact),
            acquisition: encodeArtifactAcquisition(result.acquisition),
          };
        }),
      settle: (request, context) =>
        run(context, async (token) => {
          const result = (await catalog.command(
            "settle",
            { id: request.id, status: request.status },
            token,
          )) as { acquisition: ArtifactAcquisition };
          return { acquisition: encodeArtifactAcquisition(result.acquisition) };
        }),
      recordUpload: (request, context) =>
        run(context, async (token) => {
          if (
            !/^sha256:[a-f0-9]{64}$/u.test(request.digest) ||
            request.sizeBytes > MAX_ARTIFACT_BYTES
          )
            throw new ConnectError("Invalid artifact upload receipt", Code.InvalidArgument);
          await catalog.recordUpload(
            token,
            request.digest,
            request.sizeBytes,
            request.volume,
            request.volumeSource,
          );
          return {};
        }),
      resolveTransfer: (request, context) =>
        run(context, async (token) =>
          encodeResolvedArtifactTransfer(
            await catalog.resolveTransfer(token, {
              artifactId: request.artifactId,
              path: request.path,
            }),
          ),
        ),
    },
    limits,
  );
  router.service(
    ArtifactHostService,
    {
      getTransferKey: (_, context) =>
        run(context, async () => {
          if (!options.directTransfers)
            throw new ConnectError("Direct artifact transfer is not configured", Code.Unavailable);
          return { algorithm: "Ed25519", publicKey: options.directTransfers.publicKey };
        }),
      getArtifactVolume: (request, context) =>
        run(context, async (token) => {
          const transfers = options.directTransfers;
          if (!transfers)
            throw new ConnectError("Direct artifact transfer is not configured", Code.Unavailable);
          const host = await transfers.authenticateWorkerHost(request.workerHostId, token);
          if (!host)
            throw new ConnectError("Worker Host authentication failed", Code.Unauthenticated);
          return catalog.workerHostArtifactVolume(host, request.name);
        }),
      registerCopies: (request, context) =>
        run(context, async (token) => {
          const transfers = options.directTransfers;
          if (!transfers)
            throw new ConnectError("Direct artifact transfer is not configured", Code.Unavailable);
          const host = await transfers.authenticateWorkerHost(request.workerHostId, token);
          if (!host)
            throw new ConnectError("Worker Host authentication failed", Code.Unauthenticated);
          const result = await catalog.registerWorkerArtifactCopies({
            workerHostId: host.id,
            connectionGeneration: host.connectionGeneration,
            inventoryRevision: artifactSafeInteger(request.inventoryRevision),
            transferBaseUrl: request.transferBaseUrl,
            copies: request.copies.map((copy) => ({
              digest: copy.digest,
              sizeBytes: copy.sizeBytes,
            })),
            observedAt: new Date().toISOString(),
          });
          return {
            accepted: result.accepted,
            connectionGeneration: BigInt(result.connectionGeneration),
            inventoryRevision: BigInt(result.inventoryRevision),
          };
        }),
    },
    limits,
  );
}
function artifactError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof ArtifactCatalogError || error instanceof TagMessagingError) {
    const code =
      {
        400: Code.InvalidArgument,
        401: Code.Unauthenticated,
        403: Code.PermissionDenied,
        404: Code.NotFound,
        409: Code.FailedPrecondition,
        413: Code.ResourceExhausted,
        503: Code.Unavailable,
      }[error.statusCode] ?? Code.Internal;
    return new ConnectError(
      code === Code.Internal ? "Artifact metadata unavailable" : error.message,
      code,
    );
  }
  return new ConnectError("Artifact metadata unavailable", Code.Internal);
}
