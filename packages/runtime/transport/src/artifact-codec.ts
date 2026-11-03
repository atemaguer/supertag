import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type {
  ArtifactAcquisition,
  ArtifactDiscoveryPage,
  CapturedArtifact,
  CapturedArtifactEntry,
  CapturedArtifactSummary,
  ResolvedArtifactTransfer,
} from "@supertag/core";
import {
  type Acquisition,
  AcquisitionSchema,
  type Artifact,
  ArtifactSchema,
  type Entry,
  EntrySchema,
  type FindResponse,
  FindResponseSchema,
  type ResolveTransferResponse,
  ResolveTransferResponseSchema,
  type Summary,
} from "./gen/supertag/artifact/v1/artifact_pb.js";

export * from "./gen/supertag/artifact/v1/artifact_pb.js";
export const ARTIFACT_GRPC_MAX_METADATA_BYTES = 256 * 1024;

export function artifactSafeInteger(value: bigint | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new ConnectError("Invalid artifact integer", Code.InvalidArgument);
  return result;
}

export function encodeArtifactEntry(value: CapturedArtifactEntry): Entry {
  return create(EntrySchema, { ...value, sizeBytes: artifactSafeInteger(value.sizeBytes) });
}
export function decodeArtifactEntry(value: Entry): CapturedArtifactEntry {
  return {
    path: value.path,
    uri: value.uri,
    digest: value.digest,
    sizeBytes: artifactSafeInteger(value.sizeBytes),
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
  };
}

export function encodeCapturedArtifact(value: CapturedArtifact): Artifact {
  return create(ArtifactSchema, {
    ...value,
    entries: value.entries.map(encodeArtifactEntry),
    inputs: value.inputs.map((input) => ({
      artifactId: input.artifactId,
      paths: [...input.paths],
    })),
  });
}
export function decodeCapturedArtifact(value: Artifact | undefined): CapturedArtifact {
  if (!value) throw new ConnectError("Missing artifact", Code.DataLoss);
  return {
    ...decodeSummaryFields(value),
    operationId: value.operationId,
    entries: value.entries.map(decodeArtifactEntry),
    inputs: value.inputs.map((input) => ({
      artifactId: input.artifactId,
      paths: [...input.paths],
    })),
  };
}

export function encodeArtifactDiscoveryPage(value: ArtifactDiscoveryPage): FindResponse {
  return create(FindResponseSchema, {
    artifacts: value.artifacts.map((artifact) => ({
      ...artifact,
      sizeBytes: BigInt(artifactSafeInteger(artifact.sizeBytes)),
    })),
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
  });
}
export function decodeArtifactDiscoveryPage(value: FindResponse): ArtifactDiscoveryPage {
  return {
    artifacts: value.artifacts.map((artifact) => ({
      ...decodeSummaryFields(artifact),
      entryCount: artifact.entryCount,
      sizeBytes: artifactSafeInteger(artifact.sizeBytes),
    })),
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
  };
}
function decodeSummaryFields(
  value: Artifact | Summary,
): Omit<CapturedArtifactSummary, "sizeBytes" | "entryCount"> {
  if (!value.id || !value.taskId || !value.attemptId || !value.tagId || !value.sessionId)
    throw new ConnectError("Invalid artifact identity", Code.DataLoss);
  return {
    id: value.id,
    taskId: value.taskId,
    attemptId: value.attemptId,
    tagId: value.tagId,
    sessionId: value.sessionId,
    title: value.title,
    kind: value.kind,
    createdAt: value.createdAt,
    ...(value.objectiveId === undefined ? {} : { objectiveId: value.objectiveId }),
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    ...(value.harnessSession === undefined
      ? {}
      : {
          harnessSession: {
            id: value.harnessSession.id,
            harnessId: value.harnessSession.harnessId,
          },
        }),
  };
}

export function encodeArtifactAcquisition(value: ArtifactAcquisition): Acquisition {
  return create(AcquisitionSchema, { ...value, paths: [...value.paths] });
}
export function decodeArtifactAcquisition(value: Acquisition | undefined): ArtifactAcquisition {
  if (
    !value?.id ||
    !value.artifactId ||
    !value.taskId ||
    !value.attemptId ||
    (value.delivery !== "read" && value.delivery !== "materialize") ||
    !["authorized", "delivered", "failed", "uncertain"].includes(value.status)
  )
    throw new ConnectError("Invalid artifact acquisition", Code.DataLoss);
  return {
    id: value.id,
    operationId: value.operationId,
    artifactId: value.artifactId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    paths: [...value.paths],
    delivery: value.delivery,
    status: value.status as ArtifactAcquisition["status"],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.destination === undefined ? {} : { destination: value.destination }),
  };
}

export function encodeResolvedArtifactTransfer(
  value: ResolvedArtifactTransfer,
): ResolveTransferResponse {
  return create(ResolveTransferResponseSchema, {
    ...value,
    locations: [...value.locations],
    volumes: [...value.volumes],
    holders: {
      workerHostIds: [...value.holders.workerHostIds],
      volumes: [...value.holders.volumes],
    },
  });
}
export function decodeResolvedArtifactTransfer(
  value: ResolveTransferResponse,
): ResolvedArtifactTransfer {
  return {
    artifactId: value.artifactId,
    path: value.path,
    digest: value.digest,
    sizeBytes: artifactSafeInteger(value.sizeBytes),
    expiresAt: value.expiresAt,
    locations: value.locations.map((location) => ({
      workerHostId: location.workerHostId,
      transferUrl: location.transferUrl,
      grant: location.grant,
    })),
    volumes: value.volumes.map((volume) => ({
      volume: volume.volume,
      source: volume.source,
      ...(volume.credential === undefined ? {} : { credential: volume.credential }),
      key: volume.key,
    })),
    holders: {
      workerHostIds: [...(value.holders?.workerHostIds ?? [])],
      volumes: [...(value.holders?.volumes ?? [])],
    },
  };
}
