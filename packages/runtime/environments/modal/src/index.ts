import { readFile } from "node:fs/promises";
import {
  type CapabilityIdentifier,
  devcontainerImageUser,
  type EnvironmentPlan,
  listSandboxOutputFiles,
  type ModalVolumeCredential,
  materializeSandboxArtifactFiles,
  modalDevcontainerBase,
  type ProcessOutputChunk,
  type ProcessResult,
  parseModalVolumeCredential,
  parseVolumeSource,
  prepareSandboxOutputDirectory,
  resolvedDevcontainerEnv,
  type SandboxBackend,
  SandboxExecutionEnvironmentProvider,
  type SandboxInstance,
  SandboxWorkspaceEnvironment,
  terminateSandbox,
  type WorkspaceSandboxBuild,
} from "@supertag/worker-sdk";
import { ModalClient, type SandboxCreateParams, type SandboxExecParams } from "modal";
import { FILE_HELPER } from "./files.js";
import { HTTP_HELPER } from "./http.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

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
    return adapt(sandbox);
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

/** A Modal setup sandbox that can snapshot its filesystem into an image. */
export interface ModalSetupSandboxClient extends ModalSandboxClient {
  /** Snapshots the filesystem and returns the new image's ID. */
  snapshotFilesystem(): Promise<string>;
}

/** Where Modal objects live: an app and an optional Modal environment. */
export interface ModalWorkspaceTarget {
  readonly appName: string;
  readonly createAppIfMissing: boolean;
  readonly environment?: string;
}

/** The Modal image operations a Workspace environment needs; replaceable by tests. */
export interface ModalWorkspaceClient {
  /** Builds base layers from a registry image and Dockerfile commands; Modal caches them. */
  buildImage(
    input: ModalWorkspaceTarget & { readonly image: string; readonly commands: readonly string[] },
  ): Promise<string>;
  /** Creates a setup sandbox from an image ID, with unrestricted network. */
  createSetupSandbox(
    input: ModalWorkspaceTarget & {
      readonly imageId: string;
      readonly timeoutMs: number;
      readonly tags: Readonly<Record<string, string>>;
      readonly cpu?: number;
      readonly memoryMiB?: number;
      readonly snapshotTtlMs?: number;
    },
  ): Promise<ModalSetupSandboxClient>;
  /** Deletes an image; an image already gone succeeds. */
  deleteImage(input: { readonly environment?: string; readonly imageId: string }): Promise<void>;
}

export interface ModalWorkspaceEnvironmentOptions {
  /** Existing Modal application. Creation requires createAppIfMissing: true. */
  readonly appName: string;
  /** Private host directory for bundles read back from sandboxes. */
  readonly stagingDirectory: string;
  /** Registry image every cold prepare starts from; it needs python3. */
  readonly image?: string;
  readonly createAppIfMissing?: boolean;
  readonly environment?: string;
  /** The checkout inside every image and Task sandbox. */
  readonly workspaceDirectory?: string;
  /** Directory for bundles in transit inside a sandbox. */
  readonly transferDirectory?: string;
  /** Lifetime of a setup sandbox, which runs `setup`. Default: 30 minutes. */
  readonly setupTimeoutMs?: number;
  readonly sandboxTimeoutMs?: number;
  readonly cpu?: number;
  readonly memoryMiB?: number;
  /** Optional finite lifetime for prepared snapshot images. */
  readonly snapshotTtlMs?: number;
  /** Test/custom-client seams. Modal credentials stay in Modal's own configuration. */
  readonly workspaceClient?: ModalWorkspaceClient;
  readonly sandboxFactory?: ModalSandboxFactory;
}

const SETUP_STDERR_KEPT_CHARACTERS = 4000;
const SETUP_STDERR_LINES = 20;
const SETUP_STDERR_CHARACTERS = 1000;

/**
 * A failed setup's message: the exit code and the last lines of its stderr, at most
 * {@link SETUP_STDERR_LINES} lines and {@link SETUP_STDERR_CHARACTERS} characters. The Worker
 * redacts it with the Task's sensitive values, as it does all Workspace errors. Exit 137 without
 * stderr usually indicates a SIGKILL, which Modal can send when a sandbox exceeds its memory limit.
 */
function setupFailure(exitCode: number | null, stderr: string): string {
  const tail = stderr
    .trim()
    .split(/\r?\n/u)
    .slice(-SETUP_STDERR_LINES)
    .join("\n")
    .slice(-SETUP_STDERR_CHARACTERS);
  const status = exitCode === null ? "no exit code" : `exit ${exitCode}`;
  if (tail !== "") return `Modal Workspace setup failed (${status}): ${tail}`;
  return exitCode === 137
    ? "Modal Workspace setup failed (exit 137) with no stderr: exit 137 usually means the setup process received SIGKILL, often for exceeding the sandbox's memory limit"
    : `Modal Workspace setup failed (${status}) with no stderr`;
}

/**
 * Base layers every cold prepare adds after the devcontainer's commands and before the content:
 * git and, when a stdio MCP server runs in the sandbox, Node.js, both as root; then the harness
 * install as the user the devcontainer's last `USER` selected.
 */
function baseLayers(
  devcontainerCommands: readonly string[],
  install: string | undefined,
  mcpRuntimeInstall: string | undefined,
): string[] {
  const user = devcontainerCommands.findLast((command) => /^USER\s/iu.test(command));
  return [
    ...(user === undefined ? [] : ["USER root"]),
    'RUN ["/bin/sh", "-c", "command -v git >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*)"]',
    ...(mcpRuntimeInstall === undefined
      ? []
      : [`RUN ${JSON.stringify(["/bin/sh", "-c", mcpRuntimeInstall])}`]),
    ...(user === undefined ? [] : [user]),
    ...(install === undefined ? [] : [`RUN ${JSON.stringify(["/bin/sh", "-c", install])}`]),
  ];
}

async function withModal<T>(
  environment: string | undefined,
  work: (client: ModalClient) => Promise<T>,
): Promise<T> {
  const client = new ModalClient(environment ? { environment } : {});
  try {
    return await work(client);
  } finally {
    client.close();
  }
}

export const nativeModalWorkspaceClient: ModalWorkspaceClient = {
  buildImage: (input) =>
    withModal(input.environment, async (client) => {
      const app = await client.apps.fromName(input.appName, {
        createIfMissing: input.createAppIfMissing,
      });
      const base = await modalImage(client, input.image);
      const image = await base.dockerfileCommands([...input.commands]).build(app);
      return image.imageId;
    }),
  async createSetupSandbox(input) {
    const client = new ModalClient(input.environment ? { environment: input.environment } : {});
    try {
      const app = await client.apps.fromName(input.appName, {
        createIfMissing: input.createAppIfMissing,
      });
      const image = await client.images.fromId(input.imageId);
      const sandbox = await client.sandboxes.create(app, image, {
        timeoutMs: input.timeoutMs,
        ...(input.cpu === undefined ? {} : { cpu: input.cpu, cpuLimit: input.cpu }),
        ...(input.memoryMiB === undefined
          ? {}
          : { memoryMiB: input.memoryMiB, memoryLimitMiB: input.memoryMiB }),
        tags: { ...input.tags },
      });
      return {
        sandboxId: sandbox.sandboxId,
        exec: (command, options) => sandbox.exec(command, options),
        // The host cache evicts prepared images; Modal keeps them until then.
        snapshotFilesystem: async () =>
          (
            await sandbox.snapshotFilesystem({
              timeoutMs: 300_000,
              ttlMs: input.snapshotTtlMs ?? null,
            })
          ).imageId,
        async terminate(options) {
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
  deleteImage: (input) =>
    withModal(input.environment, async (client) => {
      await client.images.delete(input.imageId).catch((error: unknown) => {
        if (!/not.?found/iu.test(error instanceof Error ? error.message : String(error)))
          throw error;
      });
    }),
};

/**
 * Named Workspaces on Modal. `prepare` builds cached base layers (git, Node.js for a stdio MCP
 * server, and the harness install),
 * then starts a setup sandbox with network from them (or, warm, from an earlier prepared image),
 * writes the trusted commit's bundle, checks it out, runs `setup`, and snapshots the filesystem
 * into the prepared image. Modal refuses local files in image builds, hence the setup sandbox.
 * `start` creates the Task's sandbox from that image with the Task's network policy. Only setup
 * sandboxes are ever snapshotted.
 */
export class ModalWorkspaceEnvironment extends SandboxWorkspaceEnvironment {
  constructor(options: ModalWorkspaceEnvironmentOptions) {
    if (!options.appName.trim()) throw new Error("Modal appName is required");
    const client = options.workspaceClient ?? nativeModalWorkspaceClient;
    const sandboxes = options.sandboxFactory ?? nativeModalSandboxFactory;
    const base = options.image ?? "python:3.13-slim";
    const target: ModalWorkspaceTarget = {
      appName: options.appName,
      createAppIfMissing: options.createAppIfMissing ?? false,
      ...(options.environment ? { environment: options.environment } : {}),
    };
    const backend = new ModalSandboxBackend({ appName: options.appName });
    super({
      stagingDirectory: options.stagingDirectory,
      driver: {
        provider: "modal",
        mounts: { strategies: ["copy", "mount"], access: ["read-only", "read-write"] },
        refuseMount(mount, volume) {
          try {
            nativeLocation({
              volume: mount.volume,
              path: mount.path,
              source: volume.source,
              ...(volume.nativeCredential === undefined
                ? {}
                : { nativeCredential: volume.nativeCredential }),
            });
            return undefined;
          } catch (error) {
            return `Workspace mount ${mount.volume}: ${error instanceof Error ? error.message : "unsupported Modal source"}`;
          }
        },
        base,
        workspaceDirectory: options.workspaceDirectory ?? "/workspace/repo",
        transferDirectory: options.transferDirectory ?? "/workspace/.supertag-transfer",
        backend: { guarantees: backend.guarantees, capabilities: backend.capabilities },
        refuse(definition) {
          try {
            modalDevcontainerBase(definition.devcontainer, base);
            devcontainerImageUser(definition.devcontainer);
            resolvedDevcontainerEnv(
              definition.devcontainer,
              definition.devcontainer?.workspaceFolder ?? "/workspace/repo",
            );
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        async build(input: WorkspaceSandboxBuild) {
          input.signal?.throwIfAborted();
          const devcontainerBase = modalDevcontainerBase(input.devcontainer, base);
          const env = resolvedDevcontainerEnv(input.devcontainer, input.workspaceDirectory);
          const user = devcontainerImageUser(input.devcontainer);
          const envLayers = Object.entries(env).map(
            ([name, value]) => `ENV ${name}=${JSON.stringify(value)}`,
          );
          const owned = [
            input.workspaceDirectory,
            input.contentPath.slice(0, input.contentPath.lastIndexOf("/")),
            ...(input.mcpDirectory === undefined ? [] : [input.mcpDirectory]),
          ]
            .map(shellQuote)
            .join(" ");
          const userLayers =
            user === undefined
              ? []
              : [
                  // The Dockerfile may have switched away from root; `user` owns what prepare writes.
                  "USER root",
                  `RUN ${JSON.stringify(["/bin/sh", "-c", `mkdir -p ${owned} && chown -R ${shellQuote(user)} ${owned}`])}`,
                  `USER ${user}`,
                ];
          let temporaryBase: string | undefined;
          let preparedImage: string | undefined;
          let setupInstance: SandboxInstance | undefined;
          const failures: unknown[] = [];
          try {
            if (input.from === undefined)
              temporaryBase = await client.buildImage({
                ...target,
                image: devcontainerBase.image,
                commands: [
                  ...devcontainerBase.commands,
                  ...baseLayers(
                    devcontainerBase.commands,
                    input.harness.commands.length > 0 ? input.harness.install : undefined,
                    input.mcpRuntimeInstall,
                  ),
                  ...envLayers,
                  ...userLayers,
                ],
              });
            const from = input.from ?? (temporaryBase as string);
            const content = new Uint8Array(await readFile(input.content.bundle));
            const setup = await client.createSetupSandbox({
              ...target,
              imageId: from,
              timeoutMs: options.setupTimeoutMs ?? 1_800_000,
              ...(options.cpu === undefined ? {} : { cpu: options.cpu }),
              ...(options.memoryMiB === undefined ? {} : { memoryMiB: options.memoryMiB }),
              ...(options.snapshotTtlMs === undefined
                ? {}
                : { snapshotTtlMs: options.snapshotTtlMs }),
              tags: { "supertag.prepared": input.digest },
            });
            const instance = adapt(setup);
            setupInstance = instance;
            input.signal?.throwIfAborted();
            await instance.mkdir(input.contentPath.slice(0, input.contentPath.lastIndexOf("/")));
            await instance.write(input.contentPath, content, { exclusive: true, mode: 0o600 });
            let stderr = "";
            const process = await instance.start(
              { command: "sh", args: ["-c", input.script] },
              {
                ...(input.signal === undefined ? {} : { signal: input.signal }),
                onOutput: (chunk) => {
                  if (chunk.stream === "stderr")
                    stderr = (stderr + chunk.text).slice(-SETUP_STDERR_KEPT_CHARACTERS);
                },
              },
            );
            const result = await process.wait();
            if (result.exitCode !== 0) throw new Error(setupFailure(result.exitCode, stderr));
            preparedImage = await setup.snapshotFilesystem();
          } catch (error) {
            failures.push(error);
          }
          if (setupInstance) {
            try {
              await terminateSandbox(setupInstance);
            } catch (error) {
              failures.push(error);
            }
          }
          if (temporaryBase) {
            try {
              await client.deleteImage({
                ...(options.environment ? { environment: options.environment } : {}),
                imageId: temporaryBase,
              });
            } catch (error) {
              failures.push(
                new Error(`Modal temporary image ${temporaryBase} could not be deleted`, {
                  cause: error,
                }),
              );
            }
          }
          if (failures.length > 0) {
            if (preparedImage) {
              try {
                await client.deleteImage({
                  ...(options.environment ? { environment: options.environment } : {}),
                  imageId: preparedImage,
                });
              } catch (error) {
                failures.push(
                  new Error(`Modal prepared image ${preparedImage} could not be deleted`, {
                    cause: error,
                  }),
                );
              }
            }
            if (failures.length === 1) throw failures[0];
            throw new AggregateError(failures, "Modal Workspace preparation and cleanup failed");
          }
          return preparedImage as string;
        },
        async create(input) {
          input.signal?.throwIfAborted();
          const sandbox = await sandboxes.create({
            ...target,
            image: base,
            imageId: input.artifact,
            ...(input.nativeMounts === undefined
              ? {}
              : {
                  nativeMounts: input.nativeMounts.map(({ mount, volume }) => ({
                    volume: mount.volume,
                    path: mount.path,
                    source: volume.source,
                    access: mount.access,
                    ...(volume.nativeCredential === undefined
                      ? {}
                      : { nativeCredential: volume.nativeCredential }),
                  })),
                }),
            params: {
              ...networkOptions(input.network),
              timeoutMs: options.sandboxTimeoutMs ?? 300_000,
              ...(options.cpu === undefined ? {} : { cpu: options.cpu, cpuLimit: options.cpu }),
              ...(options.memoryMiB === undefined
                ? {}
                : { memoryMiB: options.memoryMiB, memoryLimitMiB: options.memoryMiB }),
              tags: {
                "supertag.taskId": input.taskId,
                "supertag.attemptId": input.attemptId,
              },
            },
          });
          return adapt(sandbox);
        },
        remove: (artifact) =>
          client.deleteImage({
            ...(options.environment ? { environment: options.environment } : {}),
            imageId: artifact,
          }),
      },
    });
  }
}

function adapt(sandbox: ModalSandboxClient): SandboxInstance {
  let termination: Promise<boolean> | undefined;
  const terminate = () =>
    (termination ??= sandbox
      .terminate({ wait: true })
      .then(() => true)
      .catch((error) => {
        termination = undefined;
        throw error;
      }));
  async function file(
    operation: string,
    path: string,
    maximumBytes: number,
    input?: Uint8Array,
    mode?: number,
  ): Promise<Uint8Array> {
    const process = await sandbox.exec(
      ["python3", "-c", FILE_HELPER, operation, path, String(maximumBytes), String(mode ?? 0o600)],
      { mode: "binary", timeoutMs: 30_000 },
    );
    const output = collect(process.stdout, maximumBytes);
    const errors = collect(process.stderr, 8192);
    // Attach failure handlers while stdin is being sent to avoid unhandled rejections.
    const completion = Promise.all([output, errors, process.wait()]);
    void completion.catch(() => {});
    if (input) await process.stdin.writeBytes(input);
    await process.stdin.close();
    const [bytes, , exitCode] = await completion;
    if (exitCode !== 0)
      throw new Error(`Modal ${operation} failed for a bounded, non-symlink file path`);
    return bytes;
  }
  const instance: SandboxInstance = {
    id: sandbox.sandboxId,
    ...(sandbox.nativeMountSymlinkTargets === undefined
      ? {}
      : { nativeMountSymlinkTargets: sandbox.nativeMountSymlinkTargets }),
    prepareOutputDirectory: (root, path) => prepareSandboxOutputDirectory(instance, root, path),
    listOutputFiles: (root, query) => listSandboxOutputFiles(instance, root, query),
    materializeArtifactFiles: (input) => materializeSandboxArtifactFiles(instance, input),
    async requestHttp(port, request, limits, signal) {
      signal.throwIfAborted();
      const process = await sandbox.exec(["python3", "-c", HTTP_HELPER], {
        mode: "binary",
        timeoutMs: limits.timeoutMs,
      });
      const completion = Promise.all([
        collect(process.stdout, 4 * Math.ceil(limits.maxResponseBytes / 3) + 65536),
        collect(process.stderr, 8192),
        process.wait(),
      ]);
      void completion.catch(() => {});
      await process.stdin.writeBytes(
        new TextEncoder().encode(
          JSON.stringify({
            port,
            ...limits,
            path: request.path,
            ...(request.method ? { method: request.method } : {}),
            ...(request.headers ? { headers: request.headers } : {}),
            body: request.body ? Buffer.from(request.body).toString("base64") : "",
          }),
        ),
      );
      await process.stdin.close();
      const [output, , exitCode] = await completion;
      if (exitCode !== 0) throw new Error("Modal scoped HTTP request failed");
      const response = JSON.parse(new TextDecoder().decode(output)) as {
        status: number;
        headers: Record<string, string>;
        body: string;
      };
      return {
        status: response.status,
        headers: response.headers,
        body: new Uint8Array(Buffer.from(response.body, "base64")),
      };
    },
    mkdir: async (path) => {
      await file("mkdir", path, 0);
    },
    write: async (path, bytes, options) => {
      if (!options.exclusive) throw new Error("Modal staging requires exclusive writes");
      await file("write", path, 0, bytes, options.mode);
    },
    read: (path, options) => file("read", path, options.maximumBytes),
    makeReadOnly: async (path) => {
      await file("readonly", path, 0);
    },
    async start(spec, options) {
      options.signal?.throwIfAborted();
      if (spec.streamInput && spec.stdin !== undefined)
        throw new Error("Choose streamInput or stdin, not both");
      const process = await sandbox.exec([spec.command, ...(spec.args ?? [])], {
        mode: "binary",
        ...(spec.cwd ? { workdir: spec.cwd } : {}),
        ...(spec.environment ? { env: { ...spec.environment } } : {}),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      });
      const stdout = forward(process.stdout, "stdout", options.onOutput);
      const stderr = forward(process.stderr, "stderr", options.onOutput);
      const completion: Promise<ProcessResult> = Promise.all([stdout, stderr, process.wait()]).then(
        ([out, err, exitCode]) => ({ exitCode, stdout: out, stderr: err }),
      );
      void completion.catch(() => {});
      if (spec.stdin !== undefined)
        await process.stdin.writeBytes(new TextEncoder().encode(spec.stdin));
      if (!spec.streamInput) await process.stdin.close();
      return {
        wait: () => completion,
        terminate,
        ...(spec.streamInput
          ? {
              write: (bytes: Uint8Array) => process.stdin.writeBytes(bytes),
              endInput: () => process.stdin.close(),
            }
          : {}),
      };
    },
    terminate,
  };
  return instance;
}
async function collect(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("Modal file transport exceeded its byte bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
async function forward(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
  emit: (chunk: ProcessOutputChunk) => void | Promise<void>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  const push = async (text: string) => {
    if (!text) return;
    tail = (tail + text).slice(-32000);
    // Modal output streams are pull-based: not reading propagates backpressure to the sandbox.
    await emit({ stream: name, text });
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await push(decoder.decode(value, { stream: true }));
    }
    await push(decoder.decode());
    return tail;
  } finally {
    reader.releaseLock();
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
