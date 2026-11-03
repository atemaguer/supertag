/**
 * Storage durability, as `ps`, `describe`, `up`, and `connect worklet` report it.
 *
 * A Worker Host's storage is ephemeral when it joined with an ephemeral Auth Key (its
 * `status.ephemeral`): it is removed after it disconnects, and its Task files and artifact copies
 * go with it. Every other Worker Host is persistent. A Worker Host whose Workers run Task Attempts
 * in a remote sandbox (Modal, e2b) keeps Task files in that sandbox, which is always ephemeral.
 * The Control Plane keeps no artifact bytes, so an artifact is only as durable as the Worker Hosts
 * or Volumes that hold its copies.
 */

/** What `ps` and `describe worker-host` print for an ephemeral Worker Host. */
export const EPHEMERAL_HOST_STORAGE =
  "Ephemeral storage: Task files and artifacts on this host are lost if it stops.";

/** What `ps` and `describe worker-host` print for a host whose Tasks run in remote sandboxes. */
export function sandboxStorage(provider: string): string {
  return `Ephemeral storage: Task files in ${provider} sandboxes are lost when each sandbox stops.`;
}

/** What `ps` prints for an ephemeral host whose artifacts are kept on its artifact Volume. */
export function ephemeralHostWithArtifactVolume(volume: string): string {
  return `Ephemeral storage: Task files on this host are lost if it stops; its artifacts are kept on Volume ${volume}.`;
}

/**
 * The storage lines for one Worker Host; persistent hosts get none. An ephemeral host without an
 * artifact Volume holds the only copy of its artifacts, so the line says they are lost with it.
 */
export function hostStorageLines(host: {
  readonly ephemeral: boolean;
  readonly sandbox?: string | undefined;
  readonly artifactVolume?: string | undefined;
}): string[] {
  return [
    ...(host.ephemeral
      ? [
          host.artifactVolume === undefined
            ? EPHEMERAL_HOST_STORAGE
            : ephemeralHostWithArtifactVolume(host.artifactVolume),
        ]
      : []),
    ...(host.sandbox === undefined ? [] : [sandboxStorage(host.sandbox)]),
  ];
}

/** Execution placement recorded for a host's recent and running Task Attempts. */
export interface HostStorageEvidence {
  readonly sandboxes: readonly string[];
  readonly placementUnknown: boolean;
}

export const UNKNOWN_TASK_STORAGE =
  "Warning: Task storage durability is unknown; no complete execution placement is recorded. Sandbox files may be lost when execution stops.";

/**
 * The `connect worklet` warning for an ephemeral host: it keeps the only copy of the artifacts
 * its Tasks capture, since the Control Plane stores none. Connecting continues: temporary output
 * is a valid choice.
 */
export const EPHEMERAL_ONLY_COPY_WARNING =
  "Warning: this ephemeral Worker Host would hold the only copy of the artifacts its Tasks capture; the Control Plane keeps no copy, so they are lost if it stops.";

/**
 * What `up` warns about a host service whose storage is ephemeral: one that joined with an
 * ephemeral Auth Key, or whose `environment` runs Tasks in remote sandboxes. A host service keeps
 * the artifacts its Tasks capture on its `artifact-volume` when it names one, else under its own
 * state directory, and the Control Plane keeps no copy: an ephemeral host without an artifact
 * Volume loses them when it stops, while sandboxes lose only their Task files. `up` still starts it.
 */
export function hostServiceStorageWarnings(
  service: {
    readonly name: string;
    readonly environment?: { readonly provider: string };
    readonly artifactVolume?: string;
  },
  ephemeral: boolean,
): string[] {
  const kept =
    service.artifactVolume !== undefined
      ? `artifacts its Tasks capture are kept on Volume ${service.artifactVolume}.`
      : ephemeral
        ? "artifacts its Tasks capture are kept only on this ephemeral host."
        : "artifacts its Tasks capture are kept on this host.";
  return [
    ...(ephemeral
      ? [
          service.artifactVolume === undefined
            ? `Warning: host service ${service.name} joined as an ephemeral Worker Host. ${EPHEMERAL_HOST_STORAGE.slice(0, -1)}; the Control Plane keeps no copy of its artifacts.`
            : `Warning: host service ${service.name} joined as an ephemeral Worker Host. ${EPHEMERAL_HOST_STORAGE.slice(0, -1)}; artifacts its Tasks capture are kept on Volume ${service.artifactVolume}.`,
        ]
      : []),
    ...(service.environment === undefined
      ? []
      : [
          `Warning: host service ${service.name} runs Tasks in ${service.environment.provider} sandboxes. ${sandboxStorage(service.environment.provider).slice(0, -1)}; ${kept}`,
        ]),
  ];
}
