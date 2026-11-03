import { HostArtifactVolumeStore } from "../../apps/cli/src/artifact-volume.js";
import { attemptArtifactMetadata } from "../../apps/cli/src/worker.js";
import type { ResolvedArtifactTransfer } from "../../packages/core/src/index.js";
import {
  type ArtifactCopies,
  FileArtifactStore,
  type TaskAttemptSpec,
  WorkletArtifactStore,
  type WorkletArtifactStoreSettings,
} from "../../packages/runtime/sdk/src/index.js";

/**
 * A Worker Host's artifact storage for tests, the way a Worklet keeps it: bytes stay in `copies`
 * on this host, and only metadata goes to the Control Plane's catalog, through the Attempt's
 * execution credential (rebound after a Control Plane restart, as the Worklet does). Workers given
 * the same `copies` share one host's copies; nothing here sends artifact bytes to the Control
 * Plane. With `volume`, `copies` is the host's artifact Volume and receipts name it, as the
 * Worklet's are; `readVolume` reads other hosts' copies on Volumes this host maps.
 */
export function hostArtifactStore(
  copies: string | ArtifactCopies,
  options: {
    readonly volume?: string;
    readonly readVolume?: WorkletArtifactStoreSettings["readVolume"];
  } = {},
): (spec: TaskAttemptSpec) => WorkletArtifactStore {
  const local = typeof copies === "string" ? new FileArtifactStore(copies) : copies;
  return (spec) => {
    const metadata = spec.coordination ? attemptArtifactMetadata(spec.coordination) : undefined;
    const catalog = <T>(operation: string, body: unknown): Promise<T> => {
      if (!metadata) throw new Error("Artifact metadata requires Attempt authority");
      return metadata<T>(`/internal/v1/artifacts/catalog/${operation}`, body);
    };
    return new WorkletArtifactStore({
      copies: local instanceof HostArtifactVolumeStore ? local.forAttempt(spec.attemptId) : local,
      ...(options.readVolume === undefined ? {} : { readVolume: options.readVolume }),
      ...(options.volume === undefined ? {} : { sharedCopies: true }),
      publish: async ({ ref, sizeBytes }) => {
        try {
          await catalog("upload", {
            digest: ref.digest,
            sizeBytes,
            ...(local instanceof HostArtifactVolumeStore ? local.uploadReceipt(ref) : {}),
          });
        } catch (error) {
          if (local instanceof HostArtifactVolumeStore) local.invalidate();
          throw error;
        }
        if (local instanceof HostArtifactVolumeStore)
          await local.acceptUpload(ref, sizeBytes, spec.attemptId);
      },
      resolve: (ref) =>
        catalog<ResolvedArtifactTransfer>("resolve-transfer", {
          artifactId: ref.artifactId,
          path: ref.path,
        }),
    });
  };
}
