import {
  artifactVolumeKey,
  type CapturedArtifact,
  type Store,
  type TaskAttempt,
  type WorkerHost,
} from "@supertag/core";

/** Most artifacts `describe task` places; a Task with more says so. */
export const TASK_STORAGE_ARTIFACTS = 20;

/** One place an artifact's bytes are kept. The Control Plane is never one. */
export type TaskArtifactLocation =
  | {
      readonly kind: "worker-host";
      readonly workerHostId: string;
      /** The host joined with an ephemeral Auth Key: the copy is lost if it stops. */
      readonly ephemeral: boolean;
      /** The host was removed, so its copy is gone. */
      readonly removed: boolean;
    }
  | {
      readonly kind: "volume";
      /** The Volume's name, with its ID as a fallback if the name lookup is incomplete. */
      readonly volume: string;
    };

/** Where one artifact the Task captured lives. */
export interface TaskArtifactStorage {
  readonly artifactId: string;
  readonly title: string;
  readonly files: number;
  readonly locations: readonly TaskArtifactLocation[];
  /**
   * Some file was produced on an ephemeral Worker Host and has no accepted Volume upload.
   * Its host copy may already be unavailable; inventory omission never clears this risk.
   */
  readonly ephemeralOnly: boolean;
}

/** Where a Task's files and artifacts live, and which are held only on ephemeral storage. */
export interface TaskStorage {
  /** The latest Task Attempt's Task files: a Workspace checkout on its host, or a sandbox. */
  readonly taskFiles?: {
    readonly workerHostId: string;
    readonly ephemeral: boolean;
    /** The remote sandbox provider the Attempt ran in, which is always ephemeral. */
    readonly sandbox?: string;
    /** The Control Plane has no execution placement record for this Attempt. */
    readonly placementUnknown?: boolean;
  };
  readonly artifacts: readonly TaskArtifactStorage[];
  /** The Task captured more artifacts than {@link TASK_STORAGE_ARTIFACTS}. */
  readonly moreArtifacts: boolean;
}

/**
 * Where a Task's files and artifacts live, from the catalog's evidence only; each artifact's
 * copies are placed by {@link artifactCopyLocations}.
 */
export async function taskStorage(
  store: Pick<
    Store,
    | "listTaskAttempts"
    | "hasArtifactUpload"
    | "listCapturedArtifacts"
    | "listArtifactStorageLocations"
    | "listArtifactVolumeLocations"
    | "listWorkerHosts"
    | "listVolumes"
  >,
  taskId: string,
  latest: TaskAttempt | undefined,
  executionEnvironment: { readonly provider: string; readonly placement: string } | null,
): Promise<TaskStorage> {
  const page = await store.listCapturedArtifacts({ taskId, limit: TASK_STORAGE_ARTIFACTS });
  const hosts = new Map<string, WorkerHost>(
    (await store.listWorkerHosts()).map((host) => [host.id, host]),
  );
  const volumeNames = new Map(
    page.artifacts.length === 0
      ? []
      : (await store.listVolumes()).map((volume) => [volume.id, volume.name]),
  );
  const artifacts: TaskArtifactStorage[] = [];
  const attempts = new Map(
    (page.artifacts.length === 0 ? [] : await store.listTaskAttempts(taskId)).map((attempt) => [
      attempt.id,
      attempt,
    ]),
  );
  for (const artifact of page.artifacts)
    artifacts.push({
      artifactId: artifact.id,
      title: artifact.title,
      files: artifact.entries.length,
      ...(await artifactCopyLocations(store, artifact, hosts, volumeNames, attempts)),
    });
  const workerHostId = latest?.workerSnapshot["workerHostId"];
  const host = typeof workerHostId === "string" ? hosts.get(workerHostId) : undefined;
  const sandbox =
    executionEnvironment?.placement === "remote" ? executionEnvironment.provider : undefined;
  return {
    ...(typeof workerHostId === "string"
      ? {
          taskFiles: {
            workerHostId,
            ephemeral: host?.ephemeral === true,
            ...(executionEnvironment === null || executionEnvironment.placement === "managed"
              ? { placementUnknown: true }
              : {}),
            ...(sandbox === undefined ? {} : { sandbox }),
          },
        }
      : {}),
    artifacts,
    moreArtifacts: page.nextCursor !== undefined,
  };
}

/** Where one artifact's copies are, and whether some file of it is held only on ephemeral hosts. */
export interface ArtifactCopyLocations {
  readonly locations: readonly TaskArtifactLocation[];
  readonly ephemeralOnly: boolean;
}

/**
 * Where an artifact's files are kept, from the catalog's evidence only: the producing Worker
 * Host's upload receipt and inventory, and Volume copies attributed to that same host,
 * as for transfer grants. The Control
 * Plane holds no bytes. A Worklet's advertisement is the host's own claim, and a removed host's
 * copy is gone. Durability follows the producer's enrollment record, regardless of inventory
 * omission. Only a matching upload receipt on an existing Volume can clear ephemeral risk.
 * The receipt and Volume record can come from one host report; neither proves a byte write.
 * Worklet transfer URLs and Volume keys are never projected.
 */
export async function artifactCopyLocations(
  store: Pick<
    Store,
    "listArtifactStorageLocations" | "listArtifactVolumeLocations" | "hasArtifactUpload"
  >,
  artifact: Pick<CapturedArtifact, "entries" | "taskId" | "attemptId">,
  hosts: ReadonlyMap<string, WorkerHost>,
  volumeNames: ReadonlyMap<string, string>,
  attempts: ReadonlyMap<string, TaskAttempt>,
): Promise<ArtifactCopyLocations> {
  const producer = attempts.get(artifact.attemptId)?.workerSnapshot["workerHostId"];
  // Match transfer resolution: a digest alone does not make another host's copy serveable.
  if (typeof producer !== "string" || !producer) return { locations: [], ephemeralOnly: false };
  const hostLocation = (workerHostId: string) => {
    const host = hosts.get(workerHostId);
    return {
      kind: "worker-host" as const,
      workerHostId,
      ephemeral: host?.ephemeral === true,
      removed: host === undefined || host.enrollmentStatus === "revoked",
    };
  };
  const locations = new Map<string, TaskArtifactLocation>();
  let ephemeralOnly = false;
  for (const entry of artifact.entries) {
    const query = {
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
    };
    const [hostInventory, volumeInventory] = await Promise.all([
      // "available" queries require a live transfer connection. Inventory without that
      // filter still records holders when their Worklet disconnects or reconnects.
      store.listArtifactStorageLocations(query),
      store.listArtifactVolumeLocations(query),
    ]);
    const uploaded = await store.hasArtifactUpload({
      attemptId: artifact.attemptId,
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
    });
    // Inventory names a digest, not a producing Attempt. Require the same upload evidence
    // as download resolution before treating an advertisement as this artifact's copy.
    const copies = uploaded ? hostInventory.filter((copy) => copy.workerHostId === producer) : [];
    const volumeCopies = volumeInventory.filter(
      (copy) =>
        copy.workerHostId === producer &&
        copy.key === artifactVolumeKey(artifact.attemptId, entry.digest),
    );
    const onVolumes = [
      ...new Set(
        volumeCopies
          .filter(
            (copy) => copy.status === "available" && uploaded && volumeNames.has(copy.volumeId),
          )
          .map((copy) => volumeNames.get(copy.volumeId) ?? copy.volumeId),
      ),
    ];
    for (const volume of onVolumes) locations.set(`volume:${volume}`, { kind: "volume", volume });
    // Endpoint-free Worklets still publish a receipt after storing bytes. Use the exact
    // producing Attempt, not the latest Attempt or another host with matching content.
    // A Volume receipt is not evidence of an additional host-local copy. Recorded
    // inventory takes precedence over a receipt; neither is a live check of the bytes.
    const localProducer =
      volumeCopies.length === 0 &&
      !copies.some((copy) => copy.workerHostId === producer) &&
      uploaded
        ? [producer]
        : [];
    const held = [
      ...new Set([
        ...copies.filter((copy) => copy.status === "available").map((copy) => copy.workerHostId),
        ...localProducer,
      ]),
    ].map(hostLocation);
    for (const location of held) locations.set(`host:${location.workerHostId}`, location);
    // Enrollment and authenticated Attempt placement decide the risk, not the host's
    // mutable inventory. Omitting or withdrawing a copy cannot make ephemeral output durable.
    if (onVolumes.length === 0 && hosts.get(producer)?.ephemeral === true) ephemeralOnly = true;
  }
  return { locations: [...locations.values()], ephemeralOnly };
}
