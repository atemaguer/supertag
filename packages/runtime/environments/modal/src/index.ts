import {
  type CapabilityIdentifier,
  type EnvironmentPlan,
  type ModalVolumeCredential,
  parseModalVolumeCredential,
  parseVolumeSource,
  type SandboxBackend,
  SandboxExecutionEnvironmentProvider,
  type SandboxInstance,
} from "@supertag/worker-sdk";
import { ModalClient, type SandboxCreateParams, type SandboxExecParams } from "modal";
import { adaptModal } from "./sandbox.js";

function modalImage(client: ModalClient, image: string) {
  return /^im-(?:[A-Za-z0-9]{22}|[A-Za-z0-9]{26})$/u.test(image)
    ? client.images.fromId(image)
    : client.images.fromRegistry(image);
}

export const MODAL_REMOTE_SANDBOX_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.execution.remote-sandbox.modal",
  version: 1,
};

/** The binary-stream subset of the native Modal SDK used by this adapter. */
export interface ModalProcessClient {
  readonly stdin: { writeBytes(bytes: Uint8Array): Promise<void>; close(): Promise<void> };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): Promise<number>;
}
export interface ModalSandboxClient {
  readonly sandboxId: string;
  readonly nativeMountSymlinkTargets?: Readonly<Record<string, string>>;
  exec(
    command: string[],
    options: SandboxExecParams & { mode: "binary" },
  ): Promise<ModalProcessClient>;
  terminate(options: { wait: true }): Promise<number>;
}
export interface ModalSandboxFactory {
  create(input: {
    appName: string;
    image: string;
    imageId?: string;
    createAppIfMissing: boolean;
    environment?: string;
    params: SandboxCreateParams;
    nativeMounts?: readonly ModalNativeMount[];
  }): Promise<ModalSandboxClient>;
}
/** Host-only attachment metadata. Never added to a Harness Plan or sandbox environment. */
export interface ModalNativeMount {
  readonly volume: string;
  readonly path: string;
  readonly source: string;
  readonly access?: "read-only" | "read-write";
  readonly nativeCredential?: ModalVolumeCredential;
}

function nativeLocation(mount: ModalNativeMount) {
  const refuse = (why: string): never => {
    throw new Error(`Workspace mount ${mount.volume}: ${why}`);
  };
  let location: ReturnType<typeof parseVolumeSource>;
  try {
    location = parseVolumeSource(mount.source);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : "invalid Volume source");
  }
  if (location.scheme === "file")
    return refuse("Modal native mounts cannot attach file:// sources; use copy");
  if (location.prefix.includes("%"))
    return refuse("Modal native prefixes must use literal characters, not percent encoding");
  if (location.scheme === "modal-volume") {
    let credential: ModalVolumeCredential;
    try {
      credential = parseModalVolumeCredential(mount.nativeCredential);
    } catch {
      return refuse("modal-volume:// requires host modal-volume consent");
    }
    if (!("modal-volume" in credential) || credential["modal-volume"] !== location.name)
      return refuse(
        `host modal-volume consent must match source Volume name ${location.name} exactly`,
      );
    return location;
  }
  if (location.prefix && !location.prefix.endsWith("/"))
    return refuse("Modal bucket mount prefixes must end in /");
  if (location.scheme !== "gs") {
    if (location.forcePathStyle === true)
      return refuse("Modal CloudBucketMount does not support forcePathStyle=true");
    if (location.endpoint !== undefined && new URL(location.endpoint).pathname !== "/")
      return refuse("Modal CloudBucketMount endpoints must have no path");
    if (location.endpoint !== undefined && location.region !== undefined)
      return refuse(
        "Modal CloudBucketMount cannot combine an explicit endpoint with a signing region",
      );
  }
  let credential: ModalVolumeCredential;
  try {
    credential = parseModalVolumeCredential(mount.nativeCredential);
  } catch {
    return refuse("native mounts require a provider-held modal-secret or modal-oidc-role mapping");
  }
  if ("modal-volume" in credential)
    return refuse("modal-volume consent cannot authorize a bucket mount");
  if ("modal-oidc-role" in credential && location.scheme !== "s3")
    return refuse("OIDC roles support S3 sources only");
  return location;
}

async function nativeAttachments(
  client: ModalClient,
  mounts: readonly ModalNativeMount[],
): Promise<Pick<SandboxCreateParams, "volumes" | "cloudBucketMounts">> {
  const volumes: NonNullable<SandboxCreateParams["volumes"]> = {};
  const cloudBucketMounts: NonNullable<SandboxCreateParams["cloudBucketMounts"]> = {};
  const mountedVolumes = new Set<string>();
  for (const mount of mounts) {
    const location = nativeLocation(mount);
    if (location.scheme === "modal-volume") {
      if (mountedVolumes.has(location.name))
        throw new Error(
          `Workspace mount ${mount.volume}: Modal Volume ${location.name} is already mounted; use separate Volumes for separate mount paths`,
        );
      mountedVolumes.add(location.name);
    }
    try {
      if (location.scheme === "modal-volume") {
        volumes[mount.path] = (
          await client.volumes.fromName(location.name, {
            createIfMissing: false,
          })
        ).withMountOptions({
          readOnly: mount.access !== "read-write",
          ...(location.prefix ? { subPath: location.prefix } : {}),
        });
      } else {
        const credential = parseModalVolumeCredential(mount.nativeCredential);
        if ("modal-volume" in credential)
          throw new Error("Bucket mounts require bucket credentials");
        const endpoint =
          location.scheme === "gs"
            ? "https://storage.googleapis.com"
            : (location.endpoint ??
              (location.region && location.scheme === "s3"
                ? `https://s3.${location.region}.amazonaws.com${location.region.startsWith("cn-") ? ".cn" : ""}`
                : undefined));
        cloudBucketMounts[mount.path] = client.cloudBucketMounts.create(location.bucket, {
          readOnly: mount.access !== "read-write",
          ...(location.prefix ? { keyPrefix: location.prefix } : {}),
          ...(endpoint === undefined ? {} : { bucketEndpointUrl: endpoint }),
          ...("modal-secret" in credential
            ? { secret: await client.secrets.fromName(credential["modal-secret"]) }
            : { oidcAuthRoleArn: credential["modal-oidc-role"] }),
        });
      }
    } catch {
      // A provider response must never turn a credential value into Task diagnostics.
      throw new Error(
        `Workspace mount ${mount.volume}: Modal could not resolve its provider-held attachment`,
      );
    }
  }
  return {
    ...(Object.keys(volumes).length ? { volumes } : {}),
    ...(Object.keys(cloudBucketMounts).length ? { cloudBucketMounts } : {}),
  };
}

export interface ModalSandboxBackendOptions {
  /** Existing Modal application. Creation requires createAppIfMissing: true. */
  readonly appName: string;
  /** Registry image containing python3 plus the selected Harness executable. */
  readonly image?: string;
  /** Existing Modal image ID, instead of a registry image. */
  readonly imageId?: string;
  readonly createAppIfMissing?: boolean;
  readonly environment?: string;
  readonly sandboxTimeoutMs?: number;
  readonly cpu?: number;
  readonly memoryMiB?: number;
  /** Backend-local client seam. Credentials never enter Task Attempt specifications. */
  readonly sandboxFactory?: ModalSandboxFactory;
}
export interface ModalExecutionEnvironmentProviderOptions extends ModalSandboxBackendOptions {
  readonly rootDirectory?: string;
  readonly maxOutputCharacters?: number;
}

export const nativeModalSandboxFactory: ModalSandboxFactory = {
  async create(input) {
    for (const mount of input.nativeMounts ?? []) nativeLocation(mount);
    const client = new ModalClient(input.environment ? { environment: input.environment } : {});
    try {
      const app = await client.apps.fromName(input.appName, {
        createIfMissing: input.createAppIfMissing,
      });
      const image = input.imageId
        ? await client.images.fromId(input.imageId)
        : await modalImage(client, input.image);
      const attachments = await nativeAttachments(client, input.nativeMounts ?? []);
      const sandbox = await client.sandboxes.create(app, image, {
        ...input.params,
        ...attachments,
      });
      return {
        sandboxId: sandbox.sandboxId,
        // Modal implements a Volume attachment as a link to its provider-managed mount point.
        nativeMountSymlinkTargets: Object.fromEntries(
          Object.entries(attachments.volumes ?? {}).map(([path, volume]) => [
            path,
            `/__modal/volumes/${volume.volumeId}`,
          ]),
        ),
        exec: (command, options) => sandbox.exec(command, options),
        async terminate(options) {
          // Closing the client before confirmed termination would discard recovery evidence.
          const code = await sandbox.terminate(options);
          client.close();
          return code;
        },
      };
    } catch (error) {
      client.close();
      throw error;
    }
  },
};

/** Modal implementation of the same backend contract used by custom sandbox providers. */
export class ModalSandboxBackend implements SandboxBackend {
  readonly guarantees = {
    filesystemIsolation: "sandbox",
    networkPolicy: "enforced",
    processTreeTermination: true,
    scopedHttp: true,
  } as const;
  readonly capabilities = {
    networkModes: ["none", "allowlist", "unrestricted"] as const,
    readOnlyMounts: true,
    boundedSymlinkSafeReads: true,
    outputFiles: true,
    streamOutput: true,
    streamInput: true,
  };
  constructor(readonly options: ModalSandboxBackendOptions) {
    if (!options.appName.trim()) throw new Error("Modal appName is required");
    if (options.image && options.imageId)
      throw new Error("Choose a Modal image ID or registry image, not both");
    for (const value of [options.sandboxTimeoutMs, options.cpu, options.memoryMiB]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0))
        throw new Error("Modal resource and lifetime bounds must be positive");
    }
  }
  async create(input: Parameters<SandboxBackend["create"]>[0]): Promise<SandboxInstance> {
    input.signal?.throwIfAborted();
    const sandbox = await (this.options.sandboxFactory ?? nativeModalSandboxFactory).create({
      appName: this.options.appName,
      image: this.options.image ?? "python:3.13-slim",
      ...(this.options.imageId ? { imageId: this.options.imageId } : {}),
      createAppIfMissing: this.options.createAppIfMissing ?? false,
      ...(this.options.environment ? { environment: this.options.environment } : {}),
      params: {
        ...networkOptions(input.network),
        timeoutMs: this.options.sandboxTimeoutMs ?? 300_000,
        ...(this.options.cpu === undefined
          ? {}
          : { cpu: this.options.cpu, cpuLimit: this.options.cpu }),
        ...(this.options.memoryMiB === undefined
          ? {}
          : { memoryMiB: this.options.memoryMiB, memoryLimitMiB: this.options.memoryMiB }),
        tags: {
          "supertag.taskId": input.taskId,
          "supertag.attemptId": input.attemptId,
          "supertag.tagId": input.tagId,
        },
      },
    });
    // Provisioner checks cancellation again and terminates a sandbox created during an abort.
    return adaptModal(sandbox);
  }
}
export class ModalExecutionEnvironmentProvider extends SandboxExecutionEnvironmentProvider {
  constructor(options: ModalExecutionEnvironmentProviderOptions) {
    super({
      id: "modal",
      backend: new ModalSandboxBackend(options),
      capabilities: [MODAL_REMOTE_SANDBOX_CAPABILITY],
      rootDirectory: options.rootDirectory ?? "/workspace/supertag",
      ...(options.maxOutputCharacters === undefined
        ? {}
        : { maxOutputCharacters: options.maxOutputCharacters }),
    });
  }
}

function networkOptions(network: EnvironmentPlan["network"]): SandboxCreateParams {
  switch (network.mode) {
    case "none":
      return { blockNetwork: true };
    case "unrestricted":
      return {};
    case "allowlist": {
      const hosts = network.allowedHosts ?? [];
      if (
        !hosts.length ||
        hosts.some((host) => !/^(?:\*\.)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))
      )
        throw new Error("Modal requires a nonempty domain allowlist without URLs, ports, or CIDRs");
      // Modal combines CIDR and domain grants additively. Empty CIDRs prevent broad IP egress.
      return { outboundCidrAllowlist: [], outboundDomainAllowlist: [...hosts] };
    }
  }
}
