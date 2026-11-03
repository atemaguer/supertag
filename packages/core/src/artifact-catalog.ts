import type { SurfaceProvider, TaskReference } from "./index.js";

export const MAX_WORKER_ARTIFACT_COPIES = 1_000;

/** Exact immutable files selected from a captured artifact. */
export interface ArtifactSelection {
  readonly artifactId: string;
  readonly paths: readonly string[];
}

export function parseArtifactSelection(value: unknown): ArtifactSelection {
  const input = value as Partial<ArtifactSelection> | null;
  if (
    !input ||
    typeof input.artifactId !== "string" ||
    !input.artifactId ||
    input.artifactId.length > 512 ||
    !Array.isArray(input.paths) ||
    input.paths.length < 1 ||
    input.paths.length > 100
  )
    throw new ArtifactCatalogError(
      400,
      "Artifact selection requires an artifactId and 1–100 paths",
    );
  const paths = input.paths.map(validateArtifactPath).sort();
  if (new Set(paths).size !== paths.length)
    throw new ArtifactCatalogError(400, "Artifact selection paths must be unique");
  return { artifactId: input.artifactId, paths };
}

/** Immutable captured work; the catalog records identity independently from byte locations. */
export interface CapturedArtifactEntry {
  readonly path: string;
  readonly uri: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly mediaType?: string;
}
export interface ArtifactHarnessSession {
  readonly harnessId: string;
  readonly id: string;
}
export interface CommitCapturedArtifactInput {
  readonly operationId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly tagId: string;
  readonly objectiveId?: string;
  readonly sessionId: string;
  /** Native Harness conversation that produced this artifact, when available. */
  readonly harnessSession?: ArtifactHarnessSession;
  readonly title: string;
  readonly summary?: string;
  readonly kind: string;
  readonly entries: readonly CapturedArtifactEntry[];
  /** Server-recorded supplied inputs, not an assertion that every file was used. */
  readonly inputs?: readonly ArtifactSelection[];
}
export interface CapturedArtifact extends CommitCapturedArtifactInput {
  readonly inputs: readonly ArtifactSelection[];
  readonly id: string;
  readonly createdAt: string;
}
export interface CapturedArtifactFilter {
  /** Trusted Context selection, applied before artifact pagination. */
  readonly source?: {
    readonly tagId: string;
    readonly tagRouteId: string;
    readonly provider: SurfaceProvider;
    readonly surfaceAccountId: string;
    readonly scope: string;
    readonly excludeSessionKey: string;
    readonly completedAfter: string;
    readonly relatedTo: readonly Pick<
      TaskReference,
      "provider" | "surfaceAccountId" | "resourceType" | "resourceId" | "reference"
    >[];
  };
  readonly newestFirst?: boolean;
  readonly artifactIds?: readonly string[];
  /** Additional exact artifacts admitted to an Attempt outside its ordinary scope. */
  readonly includeArtifactIds?: readonly string[];
  readonly taskIds?: readonly string[];
  readonly objectiveId?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly query?: string;
  readonly kind?: string;
  readonly limit?: number;
  /** Opaque cursor returned by the preceding page. */
  readonly cursor?: string;
}
export interface CapturedArtifactPage {
  readonly artifacts: readonly CapturedArtifact[];
  readonly nextCursor?: string;
}
/** Bounded discovery projection. Inspect the selected artifact to retrieve its manifest. */
export interface CapturedArtifactSummary
  extends Omit<CapturedArtifact, "entries" | "operationId" | "inputs"> {
  readonly entryCount: number;
  readonly sizeBytes: number;
}
export interface ArtifactDiscoveryPage {
  readonly artifacts: readonly CapturedArtifactSummary[];
  readonly nextCursor?: string;
}
export interface AcquireCapturedArtifactInput {
  readonly operationId: string;
  readonly artifactId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly paths: readonly string[];
  readonly delivery: "read" | "materialize";
  readonly destination?: string;
}
export interface ArtifactAcquisition extends AcquireCapturedArtifactInput {
  readonly id: string;
  readonly status: "authorized" | "delivered" | "failed" | "uncertain";
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A content-addressed copy currently advertised by one Worker Host's Worklet. */
export interface ArtifactStorageLocation {
  readonly workerHostId: string;
  readonly connectionGeneration: number;
  readonly inventoryRevision: number;
  readonly transferBaseUrl: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly status: "available" | "unavailable";
  readonly observedAt: string;
  readonly unavailableAt?: string;
}

/**
 * A content-addressed copy kept on a Volume. Any Worker Host mapped to that Volume can read it, so
 * hosts that cannot reach each other share the artifact through it. `key` is the object key or
 * relative path beneath the Volume's source. `workerHostId` names the host that wrote it, while
 * that host is enrolled; it is provenance, not where to fetch the copy from.
 */
export interface ArtifactVolumeLocation {
  readonly volumeId: string;
  readonly key: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly workerHostId?: string;
  readonly status: "available" | "unavailable";
  readonly observedAt: string;
  readonly unavailableAt?: string;
}

/** A Worker Host's claim that it wrote one verified copy to a Volume. */
export interface RecordArtifactVolumeCopyInput {
  readonly volumeId: string;
  /** Exact catalog source used for the write; checked under the Volume row lock. */
  readonly source: string;
  readonly key: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly workerHostId: string;
  readonly observedAt: string;
}

/**
 * Bounded durable inventory batch from the current connection generation.
 * Reconnection uses new monotonic revisions; omission never means deletion.
 */
export interface RegisterWorkerArtifactCopiesInput {
  readonly workerHostId: string;
  readonly connectionGeneration: number;
  readonly inventoryRevision: number;
  readonly transferBaseUrl: string;
  readonly copies: readonly {
    readonly digest: string;
    readonly sizeBytes: number;
  }[];
  readonly observedAt: string;
}

export interface RegisterWorkerArtifactCopiesResult {
  readonly accepted: boolean;
  readonly connectionGeneration: number;
  readonly inventoryRevision: number;
}

/** Signed claims carried between the Control Plane and serving Worklets; never artifact bytes. */
export interface ArtifactTransferGrantClaims {
  readonly version: 1;
  readonly grantId: string;
  readonly artifactId: string;
  readonly path: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly sourceWorkerHostId: string;
  readonly recipientWorkerHostId: string;
  readonly recipientConnectionGeneration: number;
  readonly taskId: string;
  readonly attemptId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * Signed claims for an operator's `supertag download artifact`: the same file, source host, and
 * lifetime scope as {@link ArtifactTransferGrantClaims}, issued to an authenticated operator
 * instead of a Task Attempt's Worker Host.
 */
export interface OperatorArtifactTransferGrantClaims {
  readonly version: 1;
  readonly grantId: string;
  readonly artifactId: string;
  readonly path: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly sourceWorkerHostId: string;
  readonly recipientOperatorId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Any claims a serving Worklet accepts: for a consuming Task Attempt's host or an operator. */
export type AnyArtifactTransferGrantClaims =
  | ArtifactTransferGrantClaims
  | OperatorArtifactTransferGrantClaims;

export interface ResolvedArtifactTransferLocation {
  readonly workerHostId: string;
  readonly transferUrl: string;
  readonly grant: string;
}

/**
 * A copy the catalog recorded on a Volume, as a consuming Worker Host reads it: the Volume's
 * source, the name of its credential (never a value; the host maps the name itself), and the key
 * beneath the source where the copy is. The host reads only this key, after the catalog checked
 * the consumer's grant, and verifies the bytes against the entry's digest.
 */
export interface ResolvedArtifactVolumeLocation {
  readonly volume: string;
  readonly source: string;
  readonly credential?: string;
  readonly key: string;
}

/** Where an artifact file is held, for an error when a consumer can reach none of it. */
export interface ArtifactHolders {
  /** Worker Hosts holding a copy, starting with the host whose Attempt captured it. */
  readonly workerHostIds: readonly string[];
  /** Volumes holding a copy, by name. */
  readonly volumes: readonly string[];
}

export interface ResolvedArtifactTransfer {
  readonly artifactId: string;
  readonly path: string;
  readonly digest: string;
  readonly sizeBytes: number;
  /** Serving Worker Hosts' transfer endpoints, each with a grant for this file and consumer. */
  readonly locations: readonly ResolvedArtifactTransferLocation[];
  /** Copies on Volumes the consuming host advertises a mapping for. */
  readonly volumes: readonly ResolvedArtifactVolumeLocation[];
  readonly holders: ArtifactHolders;
  readonly expiresAt: string;
}

/**
 * The message for an artifact file a consuming Worker Host can reach no copy of. It names where
 * the file is and says a shared Volume would make it reachable: the Control Plane never relays
 * artifact bytes, so hosts that cannot reach each other share through a common Volume.
 */
export function artifactUnavailableMessage(input: {
  readonly artifactId: string;
  readonly path: string;
  readonly holders: ArtifactHolders;
}): string {
  const list = (values: readonly string[]) =>
    values.length < 3
      ? values.join(" and ")
      : `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
  const { workerHostIds, volumes } = input.holders;
  const where = [
    ...(workerHostIds.length
      ? [`Worker Host${workerHostIds.length === 1 ? "" : "s"} ${list(workerHostIds)}`]
      : []),
    ...(volumes.length ? [`Volume${volumes.length === 1 ? "" : "s"} ${list(volumes)}`] : []),
  ];
  return `Artifact ${input.artifactId} file ${input.path} is unavailable to this Worker Host: ${
    where.length ? `it is held by ${where.join(" and on ")}, and` : "no host or Volume holds it, so"
  } this host can reach no copy. An artifact Volume shared with a host that holds it would make it reachable.`;
}

export interface ArtifactCatalogStore {
  recordArtifactUpload(input: {
    attemptId: string;
    taskId: string;
    digest: string;
    sizeBytes: number;
  }): Promise<void>;
  hasArtifactUpload(input: {
    attemptId: string;
    digest: string;
    sizeBytes: number;
  }): Promise<boolean>;
  /** Caller must verify uploaded content and authorize capture before committing metadata. */
  commitCapturedArtifact(input: CommitCapturedArtifactInput): Promise<CapturedArtifact>;
  findCapturedArtifact(id: string): Promise<CapturedArtifact | undefined>;
  /** Caller supplies authorized scopes; storage does not grant discovery permission. */
  listCapturedArtifacts(filter: CapturedArtifactFilter): Promise<CapturedArtifactPage>;
  /** Caller authorizes access before recording intent; this does not deliver bytes. */
  acquireCapturedArtifact(input: AcquireCapturedArtifactInput): Promise<ArtifactAcquisition>;
  settleArtifactAcquisition(input: {
    id: string;
    attemptId: string;
    status: Exclude<ArtifactAcquisition["status"], "authorized">;
  }): Promise<ArtifactAcquisition>;
  getArtifactAcquisition(id: string): Promise<ArtifactAcquisition | undefined>;
  listArtifactAcquisitions(input: {
    attemptId: string;
    artifactId?: string;
  }): Promise<readonly ArtifactAcquisition[]>;
  /** Current and historical Worklet copy advertisements; never grants access by themselves. */
  registerWorkerArtifactCopies(
    input: RegisterWorkerArtifactCopiesInput,
  ): Promise<RegisterWorkerArtifactCopiesResult>;
  listArtifactStorageLocations(input: {
    digest: string;
    sizeBytes: number;
    status?: ArtifactStorageLocation["status"];
  }): Promise<readonly ArtifactStorageLocation[]>;
  /**
   * Records a copy a Worker Host wrote to a Volume, or marks it available again. The host must
   * advertise the Volume as its artifact Volume. The key's running Task Attempt must belong to
   * that host, and the key must be `attempts/ATTEMPT_ID/sha256/HEX` for the
   * copy's digest. Never grants access: a reader still needs an admitted input or acquisition.
   */
  recordArtifactVolumeCopy(input: RecordArtifactVolumeCopyInput): Promise<ArtifactVolumeLocation>;
  listArtifactVolumeLocations(input: {
    digest: string;
    sizeBytes: number;
    status?: ArtifactVolumeLocation["status"];
  }): Promise<readonly ArtifactVolumeLocation[]>;
  /**
   * IDs of Volumes the catalog records any artifact copy on, available or not. No Workspace may
   * mount them: a mount would hand a Task every artifact there, bypassing artifact grants.
   */
  listVolumeIdsHoldingArtifacts(): Promise<readonly string[]>;
}
export class ArtifactCatalogError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactCatalogError";
  }
}
export function validateArtifactPath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 1024 ||
    !path.isWellFormed() ||
    path.normalize("NFC") !== path ||
    /\p{Default_Ignorable_Code_Point}|\p{Cn}|\p{Co}/u.test(path) ||
    /[\\:]/.test(path) ||
    // Control, format, separator, and invisible filler/variation characters, except ASCII space.
    /(?!\u0020)[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\u3164\uffa0\u115f\u1160\u2800]|[\u034f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u.test(
      path,
    ) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new ArtifactCatalogError(400, "Artifact paths must be normalized relative file paths");
  return path;
}
export function validateArtifactHarnessSession(
  value: unknown,
): asserts value is ArtifactHarnessSession {
  const session = value as Partial<ArtifactHarnessSession> | null;
  if (
    !session ||
    typeof session !== "object" ||
    Array.isArray(session) ||
    Object.keys(session).some((key) => key !== "harnessId" && key !== "id") ||
    [session.harnessId, session.id].some(
      (value) =>
        typeof value !== "string" ||
        !value.trim() ||
        [...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    ) ||
    (typeof session.harnessId === "string" && session.harnessId.length > 512) ||
    (typeof session.id === "string" && session.id.length > 1024)
  )
    throw new ArtifactCatalogError(400, "Invalid artifact harnessSession");
}
export function validateCapturedArtifactInput(input: CommitCapturedArtifactInput): void {
  if (input.harnessSession !== undefined) validateArtifactHarnessSession(input.harnessSession);
  if (input.inputs !== undefined) {
    if (!Array.isArray(input.inputs) || input.inputs.length > 100)
      throw new ArtifactCatalogError(400, "Artifact inputs must contain at most 100 selections");
    let paths = 0;
    for (const value of input.inputs) paths += parseArtifactSelection(value).paths.length;
    if (paths > 1000)
      throw new ArtifactCatalogError(400, "Artifact inputs exceed 1000 selected paths");
  }

  for (const field of [
    "operationId",
    "taskId",
    "attemptId",
    "tagId",
    "sessionId",
    "title",
    "kind",
  ] as const) {
    const value = input[field];
    if (typeof value !== "string" || !value.trim() || value.length > 512)
      throw new ArtifactCatalogError(400, `Invalid artifact ${field}`);
  }
  if (
    input.objectiveId !== undefined &&
    (typeof input.objectiveId !== "string" || !input.objectiveId || input.objectiveId.length > 512)
  )
    throw new ArtifactCatalogError(400, "Invalid artifact objectiveId");
  if (
    input.summary !== undefined &&
    (typeof input.summary !== "string" || input.summary.length > 16000)
  )
    throw new ArtifactCatalogError(400, "Invalid artifact summary");
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 100)
    throw new ArtifactCatalogError(400, "Artifacts require between 1 and 100 files");
  const paths = new Set<string>();
  for (const entry of input.entries) {
    if (!entry || typeof entry !== "object")
      throw new ArtifactCatalogError(400, "Invalid artifact entry");
    validateArtifactPath(entry.path);
    if (
      paths.has(entry.path) ||
      [...paths].some(
        (path) => path.startsWith(`${entry.path}/`) || entry.path.startsWith(`${path}/`),
      )
    )
      throw new ArtifactCatalogError(400, "Artifact file paths overlap");
    paths.add(entry.path);
    if (
      !/^sha256:[a-f0-9]{64}$/.test(entry.digest) ||
      entry.uri !== `supertag-artifact:${entry.digest}`
    )
      throw new ArtifactCatalogError(400, "Artifact URI and SHA-256 digest must match");
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0)
      throw new ArtifactCatalogError(400, "Invalid artifact file size");
    if (
      entry.mediaType !== undefined &&
      (typeof entry.mediaType !== "string" || !entry.mediaType || entry.mediaType.length > 256)
    )
      throw new ArtifactCatalogError(400, "Invalid artifact media type");
  }
}
