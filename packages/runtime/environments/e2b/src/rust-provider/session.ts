import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxExecutionEnvironment } from "@supertag/worker-sdk";
import {
  createSandboxWorkspaceSession,
  type SandboxEnvironment,
  type SandboxWorkspaceSession,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { Sandbox, type SandboxOpts, Template } from "e2b";
import { E2BExecutionEnvironmentProvider } from "../index.js";
import { adaptE2B, type E2BSandboxClient, shellQuote } from "../sandbox.js";
import {
  e2bSandboxInventory,
  type SandboxInventory,
  sandboxOwnershipMetadata,
  stopOwnedSandbox,
} from "./ownership.js";

const MAX_LIFETIME_MS = 3_600_000;
const API_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 120_000;

export interface E2BWorkspaceSandbox {
  readonly client: E2BSandboxClient;
  writeTransfer(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  readTransfer(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  /** Snapshots this sandbox; later sandboxes are created from the snapshot ID. */
  snapshot(signal: AbortSignal): Promise<string>;
}

/**
 * One template build from a devcontainer translation. `dockerfile` starts from the devcontainer's
 * registry image; without one, the build starts from the operator's template and sets `user`.
 */
export interface E2BWorkspaceTemplateBuild {
  readonly name: string;
  readonly dockerfile?: string;
  readonly fromTemplate?: string;
  readonly user?: string;
}

export interface E2BWorkspaceTemplates {
  /** Builds a template and returns its template ID. */
  build(spec: E2BWorkspaceTemplateBuild): Promise<string>;
}

interface E2BWorkspaceSessionOptions {
  readonly template?: string;
  readonly factory?: {
    create(options: SandboxOpts): Promise<E2BWorkspaceSandbox>;
    /** Deletes a prepared snapshot; one already gone counts as deleted. */
    deleteSnapshot(snapshotId: string): Promise<void>;
  };
  readonly inventory?: SandboxInventory;
  readonly templates?: E2BWorkspaceTemplates;
  readonly preparedRoot?: string;
}

export const nativeWorkspaceTemplates: E2BWorkspaceTemplates = {
  async build(spec) {
    if (spec.dockerfile === undefined) {
      if (spec.fromTemplate === undefined || spec.user === undefined)
        throw new Error("E2B Workspace template build is incomplete");
      const template = Template().fromTemplate(spec.fromTemplate).setUser(spec.user);
      return (await Template.build(template, spec.name)).templateId;
    }
    // A private, empty build context: the Dockerfile can name no Worker Host file.
    const context = await mkdtemp(join(tmpdir(), "supertag-e2b-build-"));
    try {
      const path = join(context, "Dockerfile");
      await writeFile(path, spec.dockerfile, { flag: "wx", mode: 0o600 });
      const template = Template({ fileContextPath: context }).fromDockerfile(path);
      const steps = (template as unknown as { instructions?: Array<{ type?: string }> })
        .instructions;
      if (
        !Array.isArray(steps) ||
        steps.some((step) => step.type === "COPY" || step.type === "ADD")
      )
        throw new Error("E2B devcontainer build.dockerfile could not be verified");
      return (await Template.build(template, spec.name)).templateId;
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  },
};

/** The same translation names the same template, so E2B reuses its cached layers. */
export function e2bWorkspaceTemplateBuild(
  environment: SandboxEnvironment,
  template: string,
): E2BWorkspaceTemplateBuild | undefined {
  if (environment.dockerfileCommands.length === 0) return undefined;
  const build =
    environment.image === undefined
      ? { fromTemplate: template, ...(environment.user ? { user: environment.user } : {}) }
      : {
          dockerfile: `${[`FROM ${environment.image}`, ...environment.dockerfileCommands].join("\n")}\n`,
        };
  const name = `supertag-workspace-${createHash("sha256")
    .update(JSON.stringify(build))
    .digest("hex")
    .slice(0, 32)}`;
  return { name, ...build };
}

const nativeFactory = {
  async create(options: SandboxOpts): Promise<E2BWorkspaceSandbox> {
    const client = await Sandbox.create(options);
    return {
      client,
      async writeTransfer(path, bytes, signal) {
        // Use an exact view of the trusted Host buffer. The SDK accepts an upload stream.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
        await client.files.write(path, stream, { signal, requestTimeoutMs: TRANSFER_TIMEOUT_MS });
      },
      readTransfer(path, signal) {
        return client.files.read(path, {
          format: "stream",
          signal,
          requestTimeoutMs: API_TIMEOUT_MS,
          streamIdleTimeoutMs: API_TIMEOUT_MS,
        });
      },
      async snapshot(signal) {
        signal.throwIfAborted();
        return (await client.createSnapshot({ requestTimeoutMs: TRANSFER_TIMEOUT_MS })).snapshotId;
      },
    };
  },
  async deleteSnapshot(snapshotId: string) {
    // Deleting a snapshot that is already gone succeeds.
    await Sandbox.deleteSnapshot(snapshotId, { requestTimeoutMs: API_TIMEOUT_MS });
  },
};

export function createE2BWorkspaceSession(
  options: E2BWorkspaceSessionOptions = {},
): SandboxWorkspaceSession {
  const template = options.template ?? process.env["SUPERTAG_E2B_TEMPLATE"] ?? "base";
  if (!template.trim() || template.length > 256 || /\p{Cc}/u.test(template))
    throw new Error("Invalid E2B Workspace template");
  const factory = options.factory ?? nativeFactory;
  const templates = options.templates ?? nativeWorkspaceTemplates;
  const inventory = options.inventory ?? e2bSandboxInventory({ requestTimeoutMs: API_TIMEOUT_MS });
  return createSandboxWorkspaceSession(
    {
      label: "E2B",
      validateOwner: sandboxOwnershipMetadata,
      async allocate(owner, timeoutMs, signal, environment, artifact) {
        const metadata = sandboxOwnershipMetadata(owner);
        // A prepared snapshot already holds the devcontainer's image and setup.
        const build =
          artifact === undefined && environment
            ? e2bWorkspaceTemplateBuild(environment, template)
            : undefined;
        const built = artifact ?? (build === undefined ? template : await templates.build(build));
        signal.throwIfAborted();
        const sandbox = await factory.create({
          template: built,
          metadata: { ...metadata },
          timeoutMs: Math.min(timeoutMs, MAX_LIFETIME_MS),
          requestTimeoutMs: 30_000,
          allowInternetAccess: false,
          secure: true,
          lifecycle: { onTimeout: "kill", autoResume: false },
          signal,
        });
        signal.throwIfAborted();
        const sandboxId = sandbox.client.sandboxId;
        if (!sandboxId || sandboxId.length > 256 || /\p{Cc}/u.test(sandboxId))
          throw new Error("Invalid sandbox identity");
        const identity = await inventory.get(sandboxId);
        if (
          identity?.sandboxId !== sandboxId ||
          !Object.entries(metadata).every(([key, value]) => identity.metadata[key] === value)
        )
          throw new Error("Unexpected sandbox ownership");
        return {
          sandboxId,
          environment: (root) =>
            sandboxExecutionEnvironment(
              adaptE2B(sandbox.client),
              root,
              new E2BExecutionEnvironmentProvider({ maxOutputCharacters: 65_536 }).options,
            ),
          run: (argv, timeoutMs, signal) =>
            sandbox.client.commands.run(argv.map(shellQuote).join(" "), {
              cwd: "/tmp",
              timeoutMs,
              signal,
            }),
          writeTransfer: (path, bytes, signal) => sandbox.writeTransfer(path, bytes, signal),
          readTransfer: (path, signal) => sandbox.readTransfer(path, signal),
          snapshot: (signal) => sandbox.snapshot(signal),
        };
      },
      stop: (owner, sandboxId) => stopOwnedSandbox(inventory, owner, sandboxId),
      removeArtifact: (artifact) => factory.deleteSnapshot(artifact),
    },
    options.preparedRoot === undefined ? {} : { preparedRoot: options.preparedRoot },
  );
}
