import type { TaskWorkspaceVolume } from "@supertag/core";

/**
 * Object-store credentials a Worker Host resolved for a Volume. They stay in the Worker process:
 * SuperTag uses them to list and download, and never writes them to the Task's environment, the
 * harness input, `.mcp.json`, or a provider call.
 */
export interface VolumeCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** A Volume as one Worker Host reaches it: its source, and its credential for object stores. */
export interface ResolvedVolume {
  /** Provider-held reference for native attachment; never a credential value. */
  readonly nativeCredential?: import("@supertag/core").ModalVolumeCredential;
  readonly volume: string;
  /** The Volume's `source`: `s3://`, `r2://`, or `file://` on this Worker Host. */
  readonly source: string;
  /** Canonical host directory that explicitly consents to a file:// source. */
  readonly consentDirectory?: string;
  /** Resolves the Volume's credential on the Worker Host. Required for `s3://` and `r2://`. */
  credentials?(signal?: AbortSignal): Promise<VolumeCredentials>;
}

/** The Task Attempt a Volume is resolved for. */
export interface VolumeTask {
  readonly taskId: string;
  readonly attemptId: string;
  /**
   * The Volumes its Workspace plan carries, as the Control Plane's catalog held them when it
   * dispatched the Attempt: sources and credential names only.
   */
  readonly volumes?: readonly TaskWorkspaceVolume[];
}

/**
 * Resolves the Volumes that a Task's Workspace mounts name, on the Worker Host. The Worker
 * composition supplies it from the Volume catalog entries the Attempt was dispatched with and the
 * host service's credential mapping; Workspace environments only consume it.
 */
export interface VolumeResolver {
  /**
   * Host directories and files a `file://` Volume may not be in or contain, such as the Worker
   * Host's state directory, so a Volume never copies SuperTag's own state into a Task.
   */
  readonly protectedDirectories?: readonly string[];
  resolve(volume: string, task: VolumeTask, signal?: AbortSignal): Promise<ResolvedVolume>;
  /**
   * Resolves a native mount without opening host copy credentials. Must apply host artifact
   * protection, including normalized source aliases and protected dispatched file Volumes.
   * Native mounts are refused when this guard is unavailable.
   */
  resolveMount?(volume: string, task: VolumeTask, signal?: AbortSignal): Promise<ResolvedVolume>;
}
