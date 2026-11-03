/**
 * The Worker Host's Volume resolver. A Task Attempt arrives with its mounts' Volumes as the
 * Control Plane's catalog held them: each `source` and the name of its credential, never a value.
 * This host maps the name to a secret through its host service's `volume-credentials` and reads
 * the value only here, in the Worker process, to list and download. The value never enters the
 * Task's environment, the harness, `.mcp.json`, or a provider call.
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type ModalVolumeCredential,
  parseModalVolumeCredential,
  parseVolumeSource,
  protectedVolumePaths,
  type TaskWorkspaceVolume,
  type VolumeLocation,
  volumeLocationsOverlap,
} from "@supertag/core";
import { VolumeCopyError, type VolumeCredentials, type VolumeResolver } from "@supertag/worker-sdk";

export interface HostVolumeResolverOptions {
  readonly readMountCredential?: (credential: string) => Promise<ModalVolumeCredential>;
  /**
   * Reads the secret a host-service mapping names for a credential. Rejects when this host has
   * no mapping for it or cannot read the secret.
   */
  readonly readCredential: (credential: string) => Promise<string | { readonly path: string }>;
  /**
   * Host directories and files a `file://` source may not be in or contain: SuperTag's state
   * directory and the files its secrets come from.
   */
  readonly protectedDirectories: readonly string[];
  /**
   * This host's artifact Volume, when it has one. No Workspace may mount it, or any Volume whose
   * location is, contains, or sits inside its location: object stores compare normalized
   * locations, and `file://` sources compare real paths on this host. `source` rejects when the
   * catalog cannot be read, and every mount is then refused.
   */
  readonly artifactVolume?: { readonly name: string; readonly source: () => Promise<string> };
}

const CREDENTIAL_FIELDS = new Set(["accessKeyId", "secretAccessKey", "sessionToken"]);

/**
 * Resolves each Volume from the catalog entries its Task Attempt was dispatched with. A Volume the
 * Attempt does not carry, or whose credential this host does not map or cannot read, is refused
 * with a reason naming the Volume and never the secret. A `file://` Volume needs a readable
 * mapping too: the mapping is this host's consent to expose that directory.
 */
export function hostVolumeResolver(options: HostVolumeResolverOptions): VolumeResolver {
  return {
    protectedDirectories: options.protectedDirectories,
    async resolveMount(name, task) {
      const volume = await assertHostVolumeMountable(options, name, task);
      const location = parseVolumeSource(volume.source, `Volume ${name} source`);
      let nativeCredential: ModalVolumeCredential;
      try {
        if (volume.credential === undefined || options.readMountCredential === undefined)
          throw new Error();
        nativeCredential = parseModalVolumeCredential(
          await options.readMountCredential(volume.credential),
        );
      } catch {
        throw new VolumeCopyError(
          location.scheme === "modal-volume"
            ? `Volume ${name}: modal-volume:// requires a volume-credentials modal-volume mapping for credential ${volume.credential ?? "(missing)"}`
            : `Volume ${name}: native mounts require a provider-held modal-secret or modal-oidc-role mapping`,
        );
      }
      if (location.scheme === "modal-volume") {
        if (
          !("modal-volume" in nativeCredential) ||
          nativeCredential["modal-volume"] !== location.name
        )
          throw new VolumeCopyError(
            `Volume ${name}: volume-credentials modal-volume mapping must match source Volume name ${location.name} exactly`,
          );
      } else if ("modal-volume" in nativeCredential) {
        throw new VolumeCopyError(
          `Volume ${name}: modal-volume consent cannot authorize a bucket mount`,
        );
      }
      if ("modal-oidc-role" in nativeCredential && location.scheme !== "s3")
        throw new VolumeCopyError(`Volume ${name}: OIDC roles support S3 sources only`);
      return { volume: name, source: volume.source, nativeCredential };
    },
    async resolve(name, task) {
      const artifacts = await artifactVolumeLocation(options.artifactVolume, name);
      const volume = task.volumes?.find((entry) => entry.name === name);
      if (volume === undefined)
        throw new VolumeCopyError(
          `Volume ${name} was not in the Volume catalog when this Task Attempt was dispatched`,
        );
      let location: VolumeLocation;
      try {
        location = parseVolumeSource(volume.source);
      } catch (error) {
        throw new VolumeCopyError(
          `Volume ${name} has an invalid source: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (location.scheme === "gs" || location.scheme === "modal-volume")
        throw new VolumeCopyError(
          `Volume ${name}: ${location.scheme}:// sources are mount-only; copy is unsupported`,
        );
      const credential = volume.credential;
      if (credential === undefined)
        throw new VolumeCopyError(
          `Volume ${name} names no credential, so no host-service mapping on this Worker Host allows copying it`,
        );
      const read = async () => {
        try {
          return await options.readCredential(credential);
        } catch {
          throw new VolumeCopyError(
            `This Worker Host has no readable volume-credentials mapping for credential ${credential} of Volume ${name}`,
          );
        }
      };
      if (location.scheme === "file") {
        const mapped = await read();
        const path = typeof mapped === "object" ? mapped.path : undefined;
        if (typeof path !== "string" || !isAbsolute(path))
          throw new VolumeCopyError(
            `Volume ${name} needs a volume-credentials { path: DIR } mapping for file:// sources`,
          );
        let allowed: string;
        let source: string;
        try {
          [allowed, source] = await Promise.all([realpath(path), realpath(location.path)]);
        } catch {
          throw new VolumeCopyError(
            `Volume ${name} has an unreadable file:// source or consent directory`,
          );
        }
        const within = (child: string, parent: string) => {
          const rest = relative(parent, child);
          return (
            rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
          );
        };
        if (!within(source, allowed))
          throw new VolumeCopyError(
            `Volume ${name} file:// source is outside its host consent directory`,
          );
        const home = await realpath(homedir());
        if (within(home, source))
          throw new VolumeCopyError(
            `Volume ${name} file:// source contains the Worker Host home directory`,
          );
        const protectedDirectories = [
          ...options.protectedDirectories,
          ...protectedVolumePaths(task.volumes),
          ...(artifacts?.location.scheme === "file" ? [artifacts.location.path] : []),
        ];
        for (const directory of protectedDirectories) {
          let current = resolve(directory);
          const missing: string[] = [];
          while (true) {
            try {
              current = join(await realpath(current), ...missing.toReversed());
              break;
            } catch {
              const parent = dirname(current);
              if (parent === current) break;
              missing.push(basename(current));
              current = parent;
            }
          }
          if (within(current, source) || within(source, current))
            throw new VolumeCopyError(
              artifacts?.location.scheme === "file" && directory === artifacts.location.path
                ? `Volume ${name} overlaps artifact Volume ${artifacts.name} and cannot be mounted`
                : `Volume ${name} file:// source overlaps a protected Worker Host directory`,
            );
        }
        const homeRelative = relative(home, source);
        const first = homeRelative.split(sep)[0];
        if (
          (homeRelative === "" ||
            (within(source, home) &&
              (first?.startsWith(".") || first?.toLowerCase() === "library"))) &&
          (homeRelative === "" ? allowed !== home : !within(allowed, `${home}${sep}${first}`))
        )
          throw new VolumeCopyError(
            `Volume ${name} needs explicit host path consent for a home configuration directory`,
          );
        return { volume: name, source: volume.source, consentDirectory: allowed };
      }
      if (
        artifacts !== undefined &&
        artifacts.location.scheme !== "file" &&
        volumeLocationsOverlap(artifacts.location, location)
      )
        throw new VolumeCopyError(
          `Volume ${name} overlaps artifact Volume ${artifacts.name} and cannot be mounted`,
        );
      const value = await read();
      if (typeof value !== "string")
        throw new VolumeCopyError(`Volume ${name} needs an object-store secret mapping`);
      return {
        volume: name,
        source: volume.source,
        credentials: async () => parseVolumeCredentialSecret(name, value),
      };
    },
  };
}

/**
 * Checks a native mount against this host's current artifact location and dispatched protected
 * file Volumes. Returns catalog metadata only; it never reads a copy credential. Providers can
 * consume this through VolumeResolver.resolveMount before attaching a native mount.
 */
export async function assertHostVolumeMountable(
  options: HostVolumeResolverOptions,
  name: string,
  task: Parameters<VolumeResolver["resolve"]>[1],
): Promise<TaskWorkspaceVolume> {
  const artifacts = await artifactVolumeLocation(options.artifactVolume, name);
  const volume = task.volumes?.find((entry) => entry.name === name);
  if (volume === undefined)
    throw new VolumeCopyError(
      `Volume ${name} was not in the Volume catalog when this Task Attempt was dispatched`,
    );
  const location = parseVolumeSource(volume.source, `Volume ${name} source`);
  if (location.scheme === "file" && volume.credential === undefined)
    throw new VolumeCopyError(
      `Volume ${name} is a protected file:// location and cannot be mounted`,
    );
  if (artifacts !== undefined && volumeLocationsOverlap(artifacts.location, location))
    throw new VolumeCopyError(
      `Volume ${name} overlaps artifact Volume ${artifacts.name} and cannot be mounted`,
    );
  for (const protectedVolume of task.volumes ?? []) {
    if (protectedVolume.credential !== undefined) continue;
    const protectedLocation = parseVolumeSource(protectedVolume.source);
    if (protectedLocation.scheme === "file" && volumeLocationsOverlap(protectedLocation, location))
      throw new VolumeCopyError(
        `Volume ${name} overlaps protected file Volume ${protectedVolume.name} and cannot be mounted`,
      );
  }
  // No native provider can attach a host directory without copying it. Refuse explicitly rather
  // than treating a catalog entry or a copy credential as permission to expose host files.
  if (location.scheme === "file")
    throw new VolumeCopyError(`Volume ${name}: native mounts do not support file:// sources`);
  return volume;
}

/**
 * The host's artifact Volume location, refusing a mount of the artifact Volume itself, and every
 * mount when the artifact Volume cannot be read: the guard never guesses.
 */
async function artifactVolumeLocation(
  artifactVolume: HostVolumeResolverOptions["artifactVolume"],
  name: string,
): Promise<{ readonly name: string; readonly location: VolumeLocation } | undefined> {
  if (artifactVolume === undefined) return undefined;
  if (artifactVolume.name === name)
    throw new VolumeCopyError(`Volume ${name} holds artifacts and cannot be mounted`);
  let location: VolumeLocation;
  try {
    location = parseVolumeSource(await artifactVolume.source());
  } catch {
    throw new VolumeCopyError(
      `Volume ${name} cannot be checked against artifact Volume ${artifactVolume.name}, so it is not mounted`,
    );
  }
  return { name: artifactVolume.name, location };
}

/**
 * Parses an object-store credential secret: a JSON object with `accessKeyId` and
 * `secretAccessKey`, and optionally `sessionToken`.
 * Errors name the Volume and the field, never a value.
 */
export function parseVolumeCredentialSecret(volume: string, value: string): VolumeCredentials {
  const refuse = (why: string) =>
    new VolumeCopyError(`The credential secret for Volume ${volume} ${why}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw refuse("must be a JSON object with accessKeyId and secretAccessKey");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw refuse("must be a JSON object with accessKeyId and secretAccessKey");
  const record = parsed as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !CREDENTIAL_FIELDS.has(key));
  // Field names are not echoed either: a malformed secret may hold a value where a name goes.
  if (unknown.length > 0)
    throw refuse(
      `has ${unknown.length} unknown field${unknown.length === 1 ? "" : "s"}; it takes only ${[...CREDENTIAL_FIELDS].join(", ")}`,
    );
  const text = (key: string, required: boolean): string | undefined => {
    const field = record[key];
    if (field === undefined && !required) return undefined;
    if (typeof field !== "string" || field.length === 0)
      throw refuse(`needs ${key} as a non-empty string`);
    return field;
  };
  const accessKeyId = text("accessKeyId", true) as string;
  const secretAccessKey = text("secretAccessKey", true) as string;
  const sessionToken = text("sessionToken", false);
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}
