import {
  type LiveMount,
  type MountManifest,
  type MountOutputManifest,
  parseLiveMounts,
  parseMountManifests,
  parseMountOutputManifests,
} from "@supertag/core";
import type { TaskAttemptEvent } from "@supertag/worker-sdk";

/**
 * The manifests a Worker reported for the Workspace's `copy` mounts in `workspace.mounts.copied`,
 * after the copies are in place and before the harness starts. Like the Workspace MCP digest,
 * manifests that fail validation are not recorded.
 */
export function workspaceMountManifests(
  event: TaskAttemptEvent,
): readonly MountManifest[] | undefined {
  if (event.type !== "workspace.mounts.copied") return undefined;
  try {
    return parseMountManifests(event.mounts);
  } catch {
    return undefined;
  }
}

/** Persist output evidence before advancing the Worklet journal cursor. */
export function workspaceMountOutputManifests(
  event: TaskAttemptEvent,
): readonly MountOutputManifest[] | undefined {
  return event.type === "workspace.mounts.written"
    ? parseMountOutputManifests(event.mounts)
    : undefined;
}

/** A write failure is terminal even if the Worker also delivered its git result. */
export function workspaceMountOutputFailure(
  events: readonly TaskAttemptEvent[],
): string | undefined {
  for (const event of events) {
    const manifests = workspaceMountOutputManifests(event);
    const failed = manifests?.find((item) => item.status !== "complete");
    if (failed)
      return `Workspace mount ${failed.volume} at ${failed.path}, key ${failed.error?.key ?? "unknown"}: ${failed.error?.reason ?? failed.status}`;
  }
  return undefined;
}

/** Invalid attachment evidence must fail before the raw event can enter the journal. */
export function workspaceLiveMounts(event: TaskAttemptEvent): readonly LiveMount[] | undefined {
  return event.type === "workspace.mounts.attached" ? parseLiveMounts(event.mounts) : undefined;
}
