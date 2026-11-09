import type { CapturedArtifact, WorkerHost } from "@supertag/core";
import type { OperatorReadStore } from "./operator-seams.js";
import { type ArtifactCopyLocations, artifactCopyLocations } from "./task-storage.js";

/** The store reads that place artifact copies. */
export type ArtifactViewStore = Pick<
  OperatorReadStore,
  | "hasArtifactUpload"
  | "listArtifactStorageLocations"
  | "listArtifactVolumeLocations"
  | "listTaskAttempts"
  | "listVolumes"
  | "listWorkerHosts"
>;

/**
 * Each artifact with where its copies are (Worker Hosts and Volumes, never the Control Plane) and
 * whether some file is held only on ephemeral Worker Hosts. Reads hosts, Volumes and Task
 * Attempts once per page.
 */
export async function artifactsWithLocations(
  store: ArtifactViewStore,
  artifacts: readonly CapturedArtifact[],
): Promise<{ readonly artifact: CapturedArtifact; readonly copies: ArtifactCopyLocations }[]> {
  if (artifacts.length === 0) return [];
  const [hosts, volumes, attempts] = await Promise.all([
    store.listWorkerHosts(),
    store.listVolumes(),
    store.listTaskAttempts([...new Set(artifacts.map((artifact) => artifact.taskId))]),
  ]);
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const byId = new Map<string, WorkerHost>(hosts.map((host) => [host.id, host]));
  const names = new Map(volumes.map((volume) => [volume.id, volume.name]));
  const placed = [];
  for (const artifact of artifacts)
    placed.push({
      artifact,
      copies: await artifactCopyLocations(store, artifact, byId, names, attemptsById),
    });
  return placed;
}
