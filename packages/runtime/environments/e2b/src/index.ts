import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  type CapabilityIdentifier,
  devcontainerImageUser,
  type EnvironmentPlan,
  listSandboxOutputFiles,
  materializeSandboxArtifactFiles,
  materializeTrustedBuildContext,
  type ProcessSpec,
  prepareSandboxOutputDirectory,
  resolvedDevcontainerEnv,
  type SandboxBackend,
  SandboxExecutionEnvironmentProvider,
  type SandboxInstance,
  SandboxWorkspaceEnvironment,
  validatedDevcontainerDockerfile,
  type WorkspaceSandboxBuild,
} from "@supertag/worker-sdk";
import {
  ApiClient,
  CommandExitError,
  ConnectionConfig,
  Sandbox,
  type SandboxOpts,
  Template,
} from "e2b";
export const E2B_REMOTE_SANDBOX_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.execution.remote-sandbox.e2b",
  version: 1,
};
interface E2BCommandResultLike {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface E2BCommandHandleLike {
  readonly pid: number;
  wait(): Promise<E2BCommandResultLike>;
  kill(): Promise<boolean>;
  sendStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
}

interface E2BCommandOptionsLike {
  readonly background?: boolean;
  readonly cwd?: string;
  readonly envs?: Record<string, string>;
  readonly onStdout?: (data: string) => void | Promise<void>;
  readonly onStderr?: (data: string) => void | Promise<void>;
  readonly stdin?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Minimal E2B surface used by the provider and replaceable by tests. */
export interface E2BSandboxClient {
  readonly sandboxId: string;
  readonly files: {
    makeDir(path: string): Promise<boolean>;
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    read(path: string, options?: { format: "bytes" }): Promise<string | Uint8Array>;
  };
  readonly commands: {
    run(
      command: string,
      options: E2BCommandOptionsLike & { readonly background: true },
    ): Promise<E2BCommandHandleLike>;
    run(command: string, options?: E2BCommandOptionsLike): Promise<E2BCommandResultLike>;
  };
  kill(): Promise<boolean>;
}

export interface E2BSandboxFactory {
  create(options: SandboxOpts): Promise<E2BSandboxClient>;
}

export interface E2BExecutionEnvironmentProviderOptions {
  /** E2B template or snapshot name. Defaults to E2B's `base` template. */
  readonly template?: string;
  /** Base directory created inside each sandbox. */
  readonly rootDirectory?: string;
  /** Sandbox lifetime enforced by E2B. */
  readonly sandboxTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxOutputCharacters?: number;
  /** Test/custom-client seam. Authentication must still remain outside Worker Profiles. */
  readonly sandboxFactory?: E2BSandboxFactory;
}

const defaultSandboxFactory: E2BSandboxFactory = {
  async create(options) {
    return await Sandbox.create(options);
  },
};
const E2B_BACKEND: Pick<SandboxBackend, "guarantees" | "capabilities"> = {
  guarantees: {
    filesystemIsolation: "sandbox",
    networkPolicy: "enforced",
    processTreeTermination: true,
    scopedHttp: false,
  },
  capabilities: {
    networkModes: ["none", "allowlist", "unrestricted"],
    readOnlyMounts: true,
    boundedSymlinkSafeReads: true,
    outputFiles: true,
    streamOutput: true,
    streamInput: true,
  },
};
/** E2B adapter; portable preparation and lifecycle live in SandboxExecutionEnvironmentProvider. */
export class E2BExecutionEnvironmentProvider extends SandboxExecutionEnvironmentProvider {
  constructor(options: E2BExecutionEnvironmentProviderOptions = {}) {
    const backend: SandboxBackend = {
      ...E2B_BACKEND,
      async create(input) {
        const sandbox = await (options.sandboxFactory ?? defaultSandboxFactory).create({
          metadata: {
            "supertag.taskId": input.taskId,
            "supertag.attemptId": input.attemptId,
            "supertag.tagId": input.tagId,
          },
          ...networkOptions(input.network),
          ...(options.template === undefined ? {} : { template: options.template }),
          ...(options.sandboxTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.sandboxTimeoutMs }),
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return adaptE2B(sandbox);
      },
    };
    super({
      id: "e2b",
      backend,
      capabilities: [E2B_REMOTE_SANDBOX_CAPABILITY],
      rootDirectory: options.rootDirectory ?? "/home/user/supertag-tasks",
      ...(options.maxOutputCharacters === undefined
        ? {}
        : { maxOutputCharacters: options.maxOutputCharacters }),
    });
  }
}
/** One E2B template build for a prepared Workspace. Everything in it is trusted. */
export interface E2BTemplateBuildSpec {
  /** New template name, unique to this host. */
  readonly name: string;
  /** The template to start from: the base, or an earlier prepared template for a warm build. */
  readonly from: string;
  readonly baseKind?: "template" | "image" | "dockerfile";
  readonly dockerfile?: string;
  readonly containerEnv?: Readonly<Record<string, string>>;
  readonly remoteEnv?: Readonly<Record<string, string>>;
  /** `remoteUser`, `containerUser`, or the Dockerfile's last `USER`; owns what prepare writes. */
  readonly user?: string;
  readonly workspaceFolder?: string;
  /** Harness install command from the Worker Profile; absent for a warm build. */
  readonly harnessInstall?: string;
  /** Installs Node.js, as root, for a stdio MCP server in the sandbox; absent for a warm build. */
  readonly mcpRuntimeInstall?: string;
  /** The stdio MCP server's trusted copy beside the checkout, created with it for `user`. */
  readonly mcpDirectory?: string;
  /** Private host build context with trusted blobs and a content bundle. */
  readonly contextDirectory: string;
  /** The content bundle's file name inside `contextDirectory`. */
  readonly contentFile: string;
  /** Where the build places the content bundle. */
  readonly contentDestination: string;
  /** The prepare script, run with `sh -c` after the bundle is in place. */
  readonly script: string;
  readonly signal?: AbortSignal;
}

/** The E2B template operations a Workspace environment needs; replaceable by tests. */
export interface E2BTemplateClient {
  /** Builds a template and returns its template ID. */
  build(spec: E2BTemplateBuildSpec): Promise<string>;
  /** Deletes a template; a template already gone succeeds. */
  delete(templateId: string): Promise<void>;
}

export interface E2BWorkspaceEnvironmentOptions {
  /** Private host directory for bundles read back from sandboxes. */
  readonly stagingDirectory: string;
  /** Template every cold prepare starts from. Defaults to E2B's `base` template. */
  readonly template?: string;
  /** The checkout inside every template and Task sandbox. */
  readonly workspaceDirectory?: string;
  /** Directory for bundles in transit inside a sandbox. */
  readonly transferDirectory?: string;
  readonly sandboxTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Test/custom-client seams. E2B credentials stay in E2B's own environment variables. */
  readonly templateClient?: E2BTemplateClient;
  readonly sandboxFactory?: E2BSandboxFactory;
}

export const nativeTemplateClient: E2BTemplateClient = {
  async build(spec) {
    const builder = Template({ fileContextPath: spec.contextDirectory });
    let template =
      spec.baseKind === "dockerfile"
        ? builder.fromDockerfile(await stageE2BDockerfile(spec))
        : spec.baseKind === "image"
          ? builder.fromImage(spec.from)
          : builder.fromTemplate(spec.from);
    // Defense in depth: inspect the SDK's own parsed steps before it can hash/upload local files.
    if (spec.baseKind === "dockerfile") {
      const steps = (template as unknown as { instructions?: Array<{ type?: string }> })
        .instructions;
      if (!Array.isArray(steps))
        throw new Error("E2B devcontainer build.dockerfile could not be verified");
      for (const step of steps)
        if (step.type === "COPY" || step.type === "ADD")
          throw new Error(`E2B devcontainer build.dockerfile cannot use ${step.type}`);
    }
    if (spec.mcpRuntimeInstall !== undefined)
      template = template.runCmd(spec.mcpRuntimeInstall, { user: "root" });
    if (spec.harnessInstall !== undefined) template = template.runCmd(spec.harnessInstall);
    if (spec.user) template = template.setUser("root");
    const owned = [
      posix.dirname(spec.contentDestination),
      spec.workspaceFolder ?? "/home/user/workspace",
      ...(spec.mcpDirectory === undefined ? [] : [spec.mcpDirectory]),
    ]
      .map(shellQuote)
      .join(" ");
    template = template.runCmd(`mkdir -p ${owned}`);
    if (spec.user) template = template.runCmd(`chown -R ${shellQuote(spec.user)} ${owned}`);
    template = template.copy(spec.contentFile, spec.contentDestination, {
      mode: 0o600,
      ...(spec.user ? { user: spec.user } : {}),
    });
    const env = { ...spec.containerEnv, ...spec.remoteEnv };
    if (Object.keys(env).length > 0) template = template.setEnvs(env);
    if (spec.workspaceFolder) template = template.setWorkdir(spec.workspaceFolder);
    if (spec.user) template = template.setUser(spec.user);
    template = template.runCmd(`sh -c ${shellQuote(spec.script)}`);
    return (await Template.build(template, spec.name)).templateId;
  },
  async delete(templateId) {
    const client = new ApiClient(new ConnectionConfig());
    const result = await client.api.DELETE("/templates/{templateID}", {
      params: { path: { templateID: templateId } },
    });
    if (result.error !== undefined && result.response.status !== 404)
      throw new Error(
        `E2B template ${templateId} could not be deleted (${result.response.status})`,
      );
  },
};

/** Gives the SDK a path that can only name a file inside this build's private context. */
export async function stageE2BDockerfile(spec: E2BTemplateBuildSpec): Promise<string> {
  if (spec.dockerfile === undefined)
    throw new Error("E2B devcontainer build.dockerfile is missing");
  const source = validatedDevcontainerDockerfile(spec.dockerfile, undefined);
  const path = join(spec.contextDirectory, `.supertag-${randomUUID()}.Dockerfile`);
  await writeFile(path, source, { flag: "wx", mode: 0o600 });
  return path;
}

/**
 * Named Workspaces on E2B. `prepare` builds a template from the base (or, warm, from an earlier
 * prepared template): Node.js for a stdio MCP server, harness install, the trusted commit's
 * bundle copied in, checkout, and
 * `setup`, all inside E2B's build. `start` creates the Task's sandbox from the template with the
 * Task's network policy. Task sandboxes are never turned into templates.
 */
export class E2BWorkspaceEnvironment extends SandboxWorkspaceEnvironment {
  constructor(options: E2BWorkspaceEnvironmentOptions) {
    const templates = options.templateClient ?? nativeTemplateClient;
    const sandboxes = options.sandboxFactory ?? defaultSandboxFactory;
    const base = options.template ?? "base";
    super({
      stagingDirectory: options.stagingDirectory,
      driver: {
        provider: "e2b",
        base,
        workspaceDirectory: options.workspaceDirectory ?? "/home/user/workspace",
        transferDirectory: options.transferDirectory ?? "/home/user/.supertag-transfer",
        backend: E2B_BACKEND,
        refuse(definition) {
          if (definition.devcontainer?.build && !definition.trustedRepository)
            return "E2B devcontainer build.context needs the trusted repository";
          try {
            resolvedDevcontainerEnv(
              definition.devcontainer,
              definition.devcontainer?.workspaceFolder ?? "/home/user/workspace",
            );
            if (definition.devcontainer?.build) {
              const build = definition.devcontainer.build;
              if (build.dockerfileContent === undefined)
                return "E2B devcontainer build.dockerfile content is missing";
              validatedDevcontainerDockerfile(build.dockerfileContent, build.args);
              devcontainerImageUser(definition.devcontainer);
            }
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
          return undefined;
        },
        async build(input: WorkspaceSandboxBuild) {
          input.signal?.throwIfAborted();
          // A private build context holding only the bundle, so nothing else on the host uploads.
          await mkdir(options.stagingDirectory, { recursive: true, mode: 0o700 });
          const context = await mkdtemp(join(options.stagingDirectory, "e2b-context-"));
          try {
            const devcontainer = input.devcontainer;
            if (devcontainer?.build) {
              if (!input.trustedRepository)
                throw new Error("E2B devcontainer build.context needs a trusted repository");
              await materializeTrustedBuildContext({
                repository: input.trustedRepository,
                trustedCommit: input.trustedCommit,
                context: devcontainer.build.context ?? ".",
                destination: context,
              });
            }
            const user = devcontainerImageUser(devcontainer);
            const contentFile = `.supertag-content-${input.name}.bundle`;
            await copyFile(input.content.bundle, join(context, contentFile));
            return await templates.build({
              name: input.name,
              from: input.from ?? devcontainer?.image ?? base,
              baseKind:
                input.from !== undefined
                  ? "template"
                  : devcontainer?.build
                    ? "dockerfile"
                    : devcontainer?.image
                      ? "image"
                      : "template",
              ...(devcontainer?.build?.dockerfileContent === undefined
                ? {}
                : {
                    dockerfile: validatedDevcontainerDockerfile(
                      devcontainer.build.dockerfileContent,
                      devcontainer.build.args,
                    ),
                  }),
              ...(devcontainer === undefined
                ? {}
                : {
                    containerEnv: resolvedDevcontainerEnv(devcontainer, input.workspaceDirectory),
                  }),
              ...(user === undefined ? {} : { user }),
              workspaceFolder: input.workspaceDirectory,
              ...(input.mcpDirectory === undefined ? {} : { mcpDirectory: input.mcpDirectory }),
              ...(input.from === undefined && input.mcpRuntimeInstall !== undefined
                ? { mcpRuntimeInstall: input.mcpRuntimeInstall }
                : {}),
              ...(input.from === undefined &&
              input.harness.commands.length > 0 &&
              input.harness.install !== undefined
                ? { harnessInstall: input.harness.install }
                : {}),
              contextDirectory: context,
              contentFile,
              contentDestination: input.contentPath,
              script: input.script,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
          } finally {
            await rm(context, { recursive: true, force: true });
          }
        },
        async create(input) {
          const sandbox = await sandboxes.create({
            template: input.artifact,
            metadata: {
              "supertag.taskId": input.taskId,
              "supertag.attemptId": input.attemptId,
            },
            ...networkOptions(input.network),
            ...(options.sandboxTimeoutMs === undefined
              ? {}
              : { timeoutMs: options.sandboxTimeoutMs }),
            ...(options.requestTimeoutMs === undefined
              ? {}
              : { requestTimeoutMs: options.requestTimeoutMs }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          return adaptE2B(sandbox);
        },
        remove: (artifact) => templates.delete(artifact),
      },
    });
  }
}

function adaptE2B(sandbox: E2BSandboxClient): SandboxInstance {
  const instance: SandboxInstance = {
    id: sandbox.sandboxId,
    prepareOutputDirectory: (root, path) => prepareSandboxOutputDirectory(instance, root, path),
    listOutputFiles: (root, query) => listSandboxOutputFiles(instance, root, query),
    materializeArtifactFiles: (input) => materializeSandboxArtifactFiles(instance, input),
    async mkdir(path) {
      await sandbox.files.makeDir(path);
    },
    async write(path, bytes, options) {
      const handle = await sandbox.commands.run(`python3 -c ${shellQuote(EXCLUSIVE_WRITE)}`, {
        background: true,
        stdin: true,
        envs: {
          SUPERTAG_FILE_PATH: path,
          SUPERTAG_FILE_MODE: String(options.mode ?? 0o600),
          SUPERTAG_FILE_EXCLUSIVE: String(options.exclusive),
        },
        timeoutMs: 30000,
      });
      await handle.sendStdin(Buffer.from(bytes).toString("base64"));
      await handle.closeStdin();
      try {
        const result = await handle.wait();
        if (result.exitCode !== 0) throw new Error("Staged file could not be written exclusively");
      } catch {
        throw new Error("Staged file could not be written exclusively");
      }
    },
    async read(path, options) {
      const result = await sandbox.commands.run(`python3 -c ${shellQuote(BOUNDED_READ)}`, {
        envs: { SUPERTAG_FILE_PATH: path, SUPERTAG_FILE_LIMIT: String(options.maximumBytes) },
        timeoutMs: 5000,
      });
      if (result.exitCode !== 0)
        throw new Error("Output must be a bounded regular file without symbolic links");
      if (result.stdout.length > 4 * Math.ceil(options.maximumBytes / 3))
        throw new Error("Artifact transport exceeded bound");
      const bytes = new Uint8Array(Buffer.from(result.stdout, "base64"));
      if (bytes.byteLength > options.maximumBytes)
        throw new Error("Expected bounded binary artifact");
      return bytes;
    },
    async makeReadOnly(path) {
      const result = await sandbox.commands.run(`chmod -R a-w ${shellQuote(path)}`);
      if (result.exitCode !== 0) throw new Error("Failed to make E2B mount read-only");
    },
    async start(spec, options) {
      const handle = await sandbox.commands.run(renderCommand(spec), {
        background: true,
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        ...(spec.environment === undefined ? {} : { envs: { ...spec.environment } }),
        ...(spec.stdin === undefined && !spec.streamInput ? {} : { stdin: true }),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        // The E2B SDK awaits these callbacks before reading the next event, so returning the
        // consumer's promise stops reading this command's output stream until it drains.
        onStdout: (text) => options.onOutput({ stream: "stdout", text }),
        onStderr: (text) => options.onOutput({ stream: "stderr", text }),
      });
      if (spec.stdin !== undefined) {
        await handle.sendStdin(spec.stdin);
        await handle.closeStdin();
      }
      return {
        pid: handle.pid,
        terminate: () => handle.kill(),
        ...(spec.streamInput
          ? {
              write: (bytes: Uint8Array) => handle.sendStdin(bytes),
              endInput: () => handle.closeStdin(),
            }
          : {}),
        async wait() {
          try {
            return await handle.wait();
          } catch (error) {
            if (error instanceof CommandExitError)
              return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
            throw error;
          }
        },
      };
    },
    terminate: () => sandbox.kill(),
  };
  return instance;
}
function renderCommand(spec: ProcessSpec): string {
  return [spec.command, ...(spec.args ?? [])].map(shellQuote).join(" ");
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function networkOptions(
  network: EnvironmentPlan["network"],
): Pick<SandboxOpts, "allowInternetAccess" | "network"> {
  switch (network.mode) {
    case "none":
      return { allowInternetAccess: false };
    case "unrestricted":
      return { allowInternetAccess: true };
    case "allowlist": {
      const hosts = network.allowedHosts ?? [];
      if (hosts.length === 0) {
        throw new Error("An E2B network allowlist must contain at least one host");
      }
      return { network: { allowOut: [...hosts] } };
    }
  }
}

// Walk directory descriptors rather than checking paths before a separate read.
// O_NONBLOCK prevents an attacker substituting a FIFO before the regular-file check.
const BOUNDED_READ = `import os, stat, base64
parts = os.environ["SUPERTAG_FILE_PATH"].split("/")
limit = int(os.environ["SUPERTAG_FILE_LIMIT"])
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
try:
 for part in [p for p in parts if p]:
  if part in (".", ".."): raise ValueError("invalid path")
  flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
  next_fd = os.open(part, flags, dir_fd=fd)
  os.close(fd)
  fd = next_fd
 if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError("not regular")
 chunks = []
 remaining = limit + 1
 while remaining:
  chunk = os.read(fd, min(65536, remaining))
  if not chunk: break
  chunks.append(chunk)
  remaining -= len(chunk)
 data = b"".join(chunks)
 if len(data) > limit: raise ValueError("too large")
 print(base64.b64encode(data).decode("ascii"), end="")
finally:
 os.close(fd)
`;

const EXCLUSIVE_WRITE = `import os, sys, base64
parts = [p for p in os.environ["SUPERTAG_FILE_PATH"].split("/") if p]
if not parts or any(p in (".", "..") for p in parts): raise ValueError("invalid path")
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
try:
 for part in parts[:-1]:
  next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
  os.close(fd)
  fd = next_fd
 flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
 flags |= os.O_EXCL if os.environ["SUPERTAG_FILE_EXCLUSIVE"] == "true" else os.O_TRUNC
 out = os.open(parts[-1], flags, int(os.environ["SUPERTAG_FILE_MODE"]), dir_fd=fd)
 with os.fdopen(out, "wb") as target:
  target.write(base64.b64decode(sys.stdin.buffer.read(), validate=True))
finally:
 os.close(fd)
`;
