import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  artifactVolumeLabel,
  gitRefComponent,
  MCP_SERVER_NAME,
  mcpLoginLabel,
  mcpServerLabel,
  parseVolumeName,
  parseWorkerHostLabels,
  SKILL_CONTEXT_TYPE,
  type TaskWorkspaceVolume,
  volumeCredentialLabel,
} from "@supertag/core";
import { stateDirectory } from "@supertag/store";
import { createClaudeCodeWorker } from "@supertag/worker-claude-code";
import { createCodexWorker } from "@supertag/worker-codex";
import { createCursorWorker } from "@supertag/worker-cursor";
import {
  EnvironmentGitHubCredentialProvider,
  GitHubPullRequestPublisher,
  GitHubRepositoryWorkspaceResolver,
  GitHubWorkspaceSourceCredentials,
} from "@supertag/worker-github";
import { createOpenCodeWorker } from "@supertag/worker-opencode";
import {
  ArtifactContextResolver,
  type ArtifactCopies,
  AttemptJournalOwnedError,
  type ContextResolver,
  ContextResolverRegistry,
  DurableLocalWorklet,
  type ExecutionEnvironmentProvider,
  FileArtifactStore,
  FileAttemptJournal,
  type FileSkillResolver,
  HttpMcpToolProvider,
  InMemorySessionStateStore,
  LocalHarnessRuntimeProvider,
  type LocalMountRoot,
  LocalWorklet,
  type McpServerDefinition,
  type McpServerEnvironment,
  type McpServerHeaders,
  resolveLocalMountRoot,
  type TaskAttemptSpec,
  ToolProviderRegistry,
  type UncertainAttempt,
  type VolumeResolver,
  type WorkletArtifactListenOptions,
  WorkletArtifactStore,
  WorkletArtifactTransferServer,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
} from "@supertag/worker-sdk";
import {
  GrpcArtifactCatalogClient,
  GrpcArtifactHostClient,
  GrpcCoordinationClient,
  GrpcSessionStateStore,
  WorkletConnection,
} from "@supertag/worker-transport";
import { artifactTransferVerificationKey } from "./artifact-transfer-key.js";
import {
  artifactVolumeCredentialFile,
  artifactVolumeReader,
  HostArtifactVolumeStore,
} from "./artifact-volume.js";
import { type ControlPlaneTarget, normalizeControlPlaneUrl } from "./control-plane-client.js";
import { readHostDiskSpace } from "./disk-space.js";
import { createHostEnvironmentProvider, type HostEnvironment } from "./host-environment.js";
import { hostVolumeResolver } from "./host-volumes.js";
import { openCodeProviderEnvironment } from "./opencode-provider.js";
import { EPHEMERAL_HOST_STORAGE, EPHEMERAL_ONLY_COPY_WARNING } from "./storage-durability.js";
import { scanRunningAttempts } from "./worker-changed-paths.js";
import { machineWorkerConcurrency, parseWorkerConcurrency } from "./worker-concurrency.js";
import { managementUrlFromWorkletUrl, resolveWorkletCredential } from "./worker-host-join.js";
import { readWorkerHostCredential } from "./worker-hosts.js";
import {
  assertGitCheckouts,
  parseWorkletWorkspaces,
  type WorkletWorkspaces,
} from "./worklet-workspaces.js";

export { readWorkerHostCredential } from "./worker-hosts.js";

/** How `connect worklet` reaches the management API when it must obtain a credential. */
export interface WorkletCommandContext {
  /** Management API URL named explicitly. */
  readonly managementUrl?: string;
  /** Saved Control Plane URL, used when a gRPC Worklet URL cannot serve the management API. */
  readonly defaultManagementUrl?: string;
  /** Operator credentials on this machine, if any. */
  readonly operatorTarget?: () => Promise<ControlPlaneTarget | undefined>;
}

/** The default time limit of each Task Attempt: 60 minutes. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60 * 60_000;

/**
 * How much longer than a Task Attempt's time limit a remote sandbox may live: time to stage
 * inputs, read outputs, and finalize. The provider terminates it after that, whatever the host.
 */
export const SANDBOX_CLEANUP_MARGIN_MS = 10 * 60_000;

export async function runWorkletCommand(
  args: readonly string[],
  context: WorkletCommandContext = {},
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(workletHelp());
    return;
  }
  const { values } = parseArgs({
    args,
    options: {
      "worklet-url": { type: "string" },
      "auth-key": { type: "string" },
      harness: { type: "string", multiple: true },
      "codex-execution-mode": { type: "string" },
      transport: { type: "string" },
      workspace: { type: "string", multiple: true },
      label: { type: "string", multiple: true },
      "worker-profile": { type: "string" },
      "worker-profile-revision": { type: "string", default: "1" },
      model: { type: "string", multiple: true },
      "allow-unsandboxed-commands": { type: "boolean", default: false },
      concurrency: { type: "string" },
      "timeout-ms": { type: "string", default: String(DEFAULT_ATTEMPT_TIMEOUT_MS) },
      "worklet-id": { type: "string" },
      "worker-host": { type: "string" },
      "worker-id": { type: "string" },
      "artifact-control-plane": { type: "string" },
      "artifact-transfer-host": { type: "string", default: "127.0.0.1" },
      "artifact-transfer-port": { type: "string", default: "0" },
      "artifact-transfer-url": { type: "string" },
      "artifact-transfer-allow-http": { type: "boolean", default: false },
      "artifact-volume": { type: "string" },
      "artifact-volume-credential": { type: "string" },
    },
    strict: true,
  });
  const workletUrl = values["worklet-url"];
  if (workletUrl === undefined) {
    throw new Error("connect worklet requires --worklet-url");
  }
  const transport =
    values.transport ??
    (["ws:", "wss:"].includes(new URL(workletUrl).protocol) ? "websocket" : "grpc");
  if (transport !== "websocket" && transport !== "grpc")
    throw new Error("--transport must be websocket or grpc");
  if ((values.harness?.length ?? 0) > 1)
    throw new Error(
      "Pass one --harness. To serve several harnesses from one Worker Host, describe it as a host service in supertag.yaml and run supertag up.",
    );
  const harness = parseHarness(values.harness?.[0] ?? "codex");
  const models = parseWorkletModels(values.model ?? [], harness);
  const codexExecutionMode = parseCodexExecutionMode(values["codex-execution-mode"], [harness]);
  const allowUnsandboxedCommands = values["allow-unsandboxed-commands"];
  if (allowUnsandboxedCommands && harness === "codex")
    throw new Error(
      "--allow-unsandboxed-commands is for claude-code, cursor and opencode; codex sandboxes commands",
    );
  const tlsCaPath = process.env["SUPERTAG_WORKLET_TLS_CA_FILE"];
  const tlsCa = tlsCaPath ? await readFile(tlsCaPath, "utf8") : undefined;
  const requestedWorkerHostId = values["worker-host"]?.trim();
  if (values["worker-host"] !== undefined && !requestedWorkerHostId)
    throw new Error("--worker-host must not be empty");
  const workletId = (values["worklet-id"] ?? `local-${harness}`).trim();
  if (workletId.length === 0) {
    throw new Error("--worklet-id must not be empty");
  }
  const workerId = (values["worker-id"] ?? `local-${harness}`).trim();
  if (workerId.length === 0) {
    throw new Error("--worker-id must not be empty");
  }
  const timeoutMs = parseTimeout(values["timeout-ms"]);
  const concurrency =
    values.concurrency === undefined
      ? machineWorkerConcurrency()
      : parseConcurrencyFlag(values.concurrency);
  const profileId = (values["worker-profile"] ?? `local-${harness}`).trim();
  const profileRevision = values["worker-profile-revision"].trim();
  if (profileId.length === 0 || profileRevision.length === 0) {
    throw new Error("--worker-profile and --worker-profile-revision must not be empty");
  }
  const workspaces = parseWorkletWorkspaces(values.workspace);
  await assertGitCheckouts(workspaces.checkouts);
  const labels = parseWorkerHostLabels(values.label ?? [], "--label");
  const workspace =
    workspaces.defaultPath ?? process.env["SUPERTAG_WORKER_WORKSPACE"] ?? process.cwd();
  const artifacts = parseArtifactOptions(values, workletUrl, transport);
  // Validate the Worklet URL before a one-off Auth Key could be spent on a doomed connection.
  workletApiUrl(workletUrl, transport);
  const authKey = await readAuthKey(
    values["auth-key"]?.trim() || process.env["SUPERTAG_AUTH_KEY"]?.trim(),
  );
  const resolvedCredential = await resolveWorkletCredential({
    // A WebSocket Worklet URL shares the management API's listener; a gRPC listener never serves
    // it, so fall back to the saved Control Plane there.
    controlPlane: normalizeControlPlaneUrl(
      context.managementUrl ??
        (transport === "websocket" || context.defaultManagementUrl === undefined
          ? managementUrlFromWorkletUrl(workletUrl)
          : context.defaultManagementUrl),
    ),
    ...(requestedWorkerHostId ? { requestedWorkerHostId } : {}),
    ...(authKey ? { authKey } : {}),
    ...(context.operatorTarget ? { operatorTarget: context.operatorTarget } : {}),
  });
  if (resolvedCredential.notice) process.stdout.write(`${resolvedCredential.notice}\n`);
  for (const warning of workletStorageWarnings(resolvedCredential, artifacts.volume?.name))
    process.stderr.write(`${warning}\n`);
  const worklet = await startWorkletRuntime({
    url: workletUrl,
    transport,
    ...(tlsCa === undefined ? {} : { tlsCa }),
    credential: resolvedCredential,
    workletId,
    journalId: workerId,
    workers: [
      {
        harness,
        workerId,
        profileId,
        profileRevision,
        concurrency,
        ...(codexExecutionMode === undefined ? {} : { codexExecutionMode }),
        ...(models.length === 0 ? {} : { models }),
        ...(allowUnsandboxedCommands ? { allowUnsandboxedCommands } : {}),
      },
    ],
    workspace,
    workspaces,
    labels,
    timeoutMs,
    artifacts,
  });

  let requestStop: (() => void) | undefined;
  const stopping = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const stop = () => requestStop?.();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await Promise.race([worklet.started, stopping]);
    await stopping;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await worklet.stop();
  }
}

interface WorkletCommandValues {
  readonly "artifact-control-plane"?: string | undefined;
  readonly "artifact-volume"?: string | undefined;
  readonly "artifact-volume-credential"?: string | undefined;
  readonly "artifact-transfer-host": string;
  readonly "artifact-transfer-port": string;
  readonly "artifact-transfer-url"?: string | undefined;
  readonly "artifact-transfer-allow-http": boolean;
}

function parseCodexExecutionMode(
  value: string | undefined,
  harnesses: readonly WorkletHarness[],
): "exec" | "app-server" | undefined {
  if (value === undefined) return undefined;
  if (!harnesses.includes("codex"))
    throw new Error("--codex-execution-mode requires --harness codex");
  if (value !== "exec" && value !== "app-server")
    throw new Error("--codex-execution-mode must be exec or app-server");
  return value;
}

/**
 * Models from repeated `--model MODEL` or `--model HARNESS=MODEL`. The first is the default; the
 * Worker advertises all of them, so Tasks may choose any.
 */
export function parseWorkletModels(
  values: readonly string[],
  harness: WorkletHarness,
): readonly string[] {
  const models: string[] = [];
  for (const value of values) {
    const separator = value.indexOf("=");
    const named = separator > 0 ? value.slice(0, separator).trim() : undefined;
    const model = (separator > 0 ? value.slice(separator + 1) : value).trim();
    if (named !== undefined && named !== harness)
      throw new Error(
        `--model ${value} names harness ${named}, but this Worklet runs ${harness}. To serve several harnesses from one Worker Host, describe it as a host service in supertag.yaml and run supertag up.`,
      );
    if (!model) throw new Error("--model must name a model");
    if (!models.includes(model)) models.push(model);
  }
  return models;
}

function parseConcurrencyFlag(value: string): number {
  try {
    return parseWorkerConcurrency(value);
  } catch (error) {
    throw new Error(`--concurrency ${errorMessage(error)}`);
  }
}

function parseTimeout(value: string): number {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("--timeout-ms must be greater than zero");
  return timeoutMs;
}

/**
 * What `connect worklet` warns about this host's storage. It warns and never refuses: temporary
 * output is a valid choice, as long as it is a known one.
 */
export function workletStorageWarnings(
  credential: { readonly ephemeral?: boolean },
  artifactVolume?: string,
): string[] {
  if (credential.ephemeral !== true) return [];
  // With an artifact Volume, the copies its Tasks capture outlive the host.
  return artifactVolume === undefined
    ? [EPHEMERAL_HOST_STORAGE, EPHEMERAL_ONLY_COPY_WARNING]
    : [EPHEMERAL_HOST_STORAGE];
}

function parseArtifactOptions(
  values: WorkletCommandValues,
  workletUrl: string,
  transport: string,
): WorkletRuntimeOptions["artifacts"] {
  // Over gRPC, artifact metadata shares the Worklet listener; otherwise it uses the HTTP API.
  const artifactControlPlane =
    values["artifact-control-plane"] ??
    (transport === "grpc" ? undefined : httpControlPlaneUrl(workletUrl));
  const artifactPort = Number(values["artifact-transfer-port"]);
  if (!Number.isInteger(artifactPort) || artifactPort < 0 || artifactPort > 65_535)
    throw new Error("--artifact-transfer-port must be an integer from 0 through 65535");
  const volume = parseArtifactVolumeOptions(values);
  return {
    ...(volume === undefined ? {} : { volume }),
    ...(artifactControlPlane === undefined ? {} : { controlPlane: artifactControlPlane }),
    transferHost: values["artifact-transfer-host"],
    transferPort: artifactPort,
    ...(values["artifact-transfer-url"] === undefined
      ? {}
      : { transferUrl: values["artifact-transfer-url"] }),
    allowInsecureHttp: values["artifact-transfer-allow-http"],
  };
}

/**
 * `--artifact-volume NAME` with `--artifact-volume-credential file:PATH`: this Worklet stores its
 * artifact copies on the Volume, reaching it with the credential in the file. Each needs the
 * other, and the credential is only ever read from the file, never taken as a value.
 */
function parseArtifactVolumeOptions(
  values: WorkletCommandValues,
): WorkletRuntimeOptions["artifacts"]["volume"] {
  const name = values["artifact-volume"]?.trim();
  const credential = values["artifact-volume-credential"]?.trim();
  if (name === undefined && credential === undefined) return undefined;
  if (!name) throw new Error("--artifact-volume-credential requires --artifact-volume NAME");
  try {
    parseVolumeName(name, "--artifact-volume");
  } catch (error) {
    throw new Error(errorMessage(error));
  }
  if (!credential)
    throw new Error(
      `--artifact-volume ${name} requires --artifact-volume-credential file:PATH, the credential its Volume names`,
    );
  const read = artifactVolumeCredentialFile(credential);
  // One file maps whichever credential name the Volume's catalog entry carries.
  return { name, readCredential: () => read() };
}

export type WorkletHarness = "claude-code" | "codex" | "cursor" | "opencode";

/** One built-in Worker a Worklet registers: a harness and the identity it runs under. */
export interface WorkletHarnessWorker {
  readonly harness: WorkletHarness;
  /** Worker and credential namespace, such as local-codex. */
  readonly workerId: string;
  readonly profileId: string;
  readonly profileRevision: string;
  /** Models the harness serves; the first is its default. */
  readonly models?: readonly string[];
  /** Task Attempts this Worker runs at once. Default: 2. */
  readonly concurrency?: number;
  readonly codexExecutionMode?: "exec" | "app-server";
  /**
   * Lets Claude Code or OpenCode run Tasks granted `commands:execute`. They have no OS sandbox
   * here, so those commands run as the host user. Codex ignores it.
   */
  readonly allowUnsandboxedCommands?: boolean;
}

export interface WorkletRuntimeOptions {
  readonly localMountRoot?: string;
  /** Worklet API URL: a gRPC listener origin or a WebSocket-capable Control Plane URL. */
  readonly url: string;
  readonly transport: "websocket" | "grpc";
  readonly tlsCa?: string;
  readonly credential: { readonly token: string; readonly workerHostId: string };
  readonly workletId: string;
  /** Names the attempt journal under ~/.supertag/workers/ID. */
  readonly journalId: string;
  /** Keeps the attempt journal here instead, such as in a host service's directory. */
  readonly journalDirectory?: string;
  readonly workers: readonly WorkletHarnessWorker[];
  /**
   * The remote sandbox provider every Worker runs Task Attempts in, from a host service's
   * `environment`. Omitted means the local process environment.
   */
  readonly environment?: HostEnvironment;
  /** Folder Tasks without a Workspace may inspect as a copy. */
  readonly workspace: string;
  readonly workspaces: WorkletWorkspaces;
  readonly labels: readonly string[];
  /** Names configured by a host service, advertised only by its Worklet. */
  readonly hostVolumeCredentialNames?: () => Promise<readonly string[]>;
  /**
   * Reads the secret a host service's `volume-credentials` maps a Volume credential name to.
   * The value stays in this process. Omitted: every Volume is refused, naming it.
   */
  readonly readVolumeCredential?: (
    credential: string,
  ) => Promise<string | { readonly path: string }>;
  /** Reads only a provider-held reference; never opens a copy credential. */
  readonly readVolumeMountCredential?: (
    credential: string,
  ) => Promise<import("@supertag/core").ModalVolumeCredential>;
  /** Files besides SuperTag's state directory that a `file://` Volume may never copy. */
  readonly volumeProtectedPaths?: readonly string[];
  /** MCP servers declared by a host service, separate from operator labels. */
  readonly hostMcpServerNames?: readonly string[];
  /** Host MCP servers whose `oauth: true` login lapsed; read whenever the host describes itself. */
  readonly hostMcpLoginsNeeded?: () => Promise<ReadonlySet<string>>;
  /** HTTP and stdio MCP servers this host provides, by name, for `target: mcp` grants. */
  readonly mcpServers?: Readonly<Record<string, McpServerDefinition>>;
  /**
   * Supplies each server's authentication headers per Task Attempt. The policy proxy holds them;
   * the harness never sees them. Omitted means no headers.
   */
  readonly mcpHeaders?: McpServerHeaders;
  /**
   * Supplies each stdio server's environment per Task Attempt. Only the server process the
   * Worker launches receives it; the harness never does. Omitted means none.
   */
  readonly mcpEnvironment?: McpServerEnvironment;
  /**
   * Values for `${SUPERTAG_MCP_*}` references in a Workspace `.mcp.json`. Omitted means the
   * Worker's environment; other names are refused either way.
   */
  readonly workspaceMcpVariables?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly skills?: FileSkillResolver;
  /**
   * This Worker Host's artifact storage. The Control Plane stores no bytes: every Worklet keeps
   * the copies its Tasks capture and serves them to other Worklets over its transfer endpoint.
   */
  readonly artifacts: {
    /** The HTTP API for artifact metadata; unused over gRPC, which shares the Worklet listener. */
    readonly controlPlane?: string;
    readonly transferHost: string;
    readonly transferPort: number;
    readonly transferUrl?: string;
    readonly allowInsecureHttp: boolean;
    /**
     * Every consumer runs on this machine, as for host services under `supertag up`, so a
     * loopback transfer address reaches them. Otherwise loopback is never advertised.
     */
    readonly consumersOnThisMachine?: boolean;
    /**
     * Where this host's copies live, overriding `volume`; the Worklet's state directory when
     * neither is set. Its credential stays in this process.
     */
    readonly copies?: ArtifactCopies;
    /**
     * This host's artifact Volume, from a host service's `artifact-volume` or `connect worklet
     * --artifact-volume`: copies are stored on it instead of the state directory, and no
     * Workspace may mount it. `readCredential` maps the credential name the Volume's catalog
     * entry carries to this host's secret, read only in this process.
     */
    readonly volume?: {
      readonly name: string;
      readonly readCredential: (credential: string) => Promise<string | { readonly path: string }>;
    };
  };
  readonly onConnected?: () => void;
  readonly onDisconnected?: () => void;
  /** Observes each Task Attempt a Worker starts and finishes, such as for draining. */
  readonly onAttempt?: {
    started(spec: TaskAttemptSpec): void;
    finished(spec: TaskAttemptSpec): void;
  };
  /** Receives the journal's uncertain Task Attempts whenever they may have changed. */
  readonly onUncertainAttempts?: (attempts: readonly UncertainAttempt[]) => void;
  /** Reports redacted cleanup causes on this Worker Host. */
  readonly onCleanupFailure?: (failure: {
    readonly attemptId: string;
    readonly diagnostics: readonly string[];
  }) => void;
}

export interface WorkletRuntimeHandle {
  readonly workletId: string;
  readonly workerHostId: string;
  /** Settles when the first connection attempt finishes; reconnection continues afterwards. */
  readonly started: Promise<void>;
  /**
   * Sets how many Task Attempts each Worker runs at once, without a restart. The Control Plane
   * sees it on the next heartbeat. A lower limit starts nothing new on a Worker until its running
   * Task Attempts fit under it.
   */
  setConcurrency(concurrency: number): void;
  stop(): Promise<void>;
}

/**
 * Builds a Worklet with one built-in Worker per harness and connects it outbound. `connect
 * worklet` registers one Worker; `supertag up` registers one per configured harness.
 */
export class HostServiceWorklet extends LocalWorklet {
  readonly #serverNames: readonly string[];
  readonly #volumeCredentialNames: () => Promise<readonly string[]>;
  readonly #needsLogin: () => Promise<ReadonlySet<string>>;
  readonly #artifactVolume: string | undefined;
  #baseLabels: readonly string[] | undefined;

  /**
   * `needsLogin` names the `auth: { oauth: true }` servers whose login lapsed. The host
   * advertises `mcp-login:NAME` for them instead of `mcp:NAME`, so Tasks that need them are held.
   */
  constructor(
    id: string,
    hostId: string,
    workers: ConstructorParameters<typeof LocalWorklet>[2],
    options: ConstructorParameters<typeof LocalWorklet>[3],
    serverNames: readonly string[],
    needsLogin: () => Promise<ReadonlySet<string>> = async () => new Set(),
    volumeCredentialNames: () => Promise<readonly string[]> = async () => [],
    artifactVolume?: string,
  ) {
    super(id, hostId, workers, options);
    this.#artifactVolume = artifactVolume;
    if (serverNames.some((name) => !MCP_SERVER_NAME.test(name)))
      throw new Error("Invalid host MCP server name");
    this.#serverNames = serverNames;
    this.#volumeCredentialNames = volumeCredentialNames;
    this.#needsLogin = needsLogin;
  }

  override async describe() {
    const descriptor = await super.describe();
    this.#baseLabels = descriptor.host.labels ?? [];
    return {
      ...descriptor,
      host: { ...descriptor.host, labels: await this.#labels(this.#baseLabels) },
    };
  }

  /**
   * The host's labels with each MCP server's current login state. A connected host sends them
   * on its next heartbeat when a login lapses or is restored, so placement follows it.
   */
  async hostLabels(): Promise<readonly string[]> {
    if (this.#baseLabels === undefined) await this.describe();
    return this.#labels(this.#baseLabels ?? []);
  }

  async #labels(base: readonly string[]): Promise<string[]> {
    const needsLogin = this.#serverNames.length === 0 ? new Set() : await this.#needsLogin();
    const volumeCredentialNames = await this.#volumeCredentialNames();
    return [
      ...new Set([
        ...base,
        ...volumeCredentialNames.map(volumeCredentialLabel),
        ...(this.#artifactVolume === undefined ? [] : [artifactVolumeLabel(this.#artifactVolume)]),
        ...this.#serverNames.map((name) =>
          needsLogin.has(name) ? mcpLoginLabel(name) : mcpServerLabel(name),
        ),
      ]),
    ].sort();
  }
}

/**
 * Where a Worklet's artifact transfer endpoint listens, or undefined when no consumer could
 * reach it. A loopback or unspecified listen address reaches only this machine, so it is
 * advertised only when every consumer runs here; an advertised URL or a specific address the
 * operator chose is advertised as configured.
 */
export function artifactTransferListen(
  artifacts: Pick<
    WorkletRuntimeOptions["artifacts"],
    "transferHost" | "transferPort" | "transferUrl" | "allowInsecureHttp" | "consumersOnThisMachine"
  >,
): WorkletArtifactListenOptions | undefined {
  if (
    artifacts.transferUrl === undefined &&
    artifacts.consumersOnThisMachine !== true &&
    reachesOnlyThisMachine(artifacts.transferHost)
  )
    return undefined;
  return {
    host: artifacts.transferHost,
    port: artifacts.transferPort,
    ...(artifacts.transferUrl === undefined ? {} : { advertiseUrl: artifacts.transferUrl }),
    allowInsecureHttp: artifacts.allowInsecureHttp,
  };
}

/** Loopback, or an unspecified address that a Worklet would advertise as loopback. */
function reachesOnlyThisMachine(host: string): boolean {
  const address = host
    .trim()
    .replace(/^\[(.*)\]$/u, "$1")
    .toLowerCase();
  if (address === "" || address === "localhost" || address === "0.0.0.0" || address === "::")
    return true;
  if (isIP(address) === 4) return address.startsWith("127.");
  return address === "::1" || address.startsWith("::ffff:127.");
}

export async function startWorkletRuntime(
  options: WorkletRuntimeOptions,
): Promise<WorkletRuntimeHandle> {
  assertHostEnvironmentWorkers(options.environment, options.workers);
  const onCleanupFailure =
    options.onCleanupFailure ??
    ((failure: { attemptId: string; diagnostics: readonly string[] }) => {
      process.stderr.write(
        `Task Attempt ${failure.attemptId} cleanup confirmation failed: ${failure.diagnostics.join("; ")}\n`,
      );
    });
  return startValidatedWorkletRuntime(options, onCleanupFailure);
}

/** Refuse incompatible host-service configurations before providers or Workers start. */
export function assertHostEnvironmentWorkers(
  environment: HostEnvironment | undefined,
  workers: readonly WorkletHarnessWorker[],
): void {
  if (!environment) return;
  for (const worker of workers) {
    if (worker.harness === "opencode") {
      throw new Error(
        `opencode cannot run with ${environment.provider} environment: OpenCode would need provider keys inside the sandbox; use claude-code, codex or cursor, or remove environment`,
      );
    }
    if (worker.harness === "codex" && worker.codexExecutionMode === "exec") {
      throw new Error(
        `codex-execution-mode exec cannot run with ${environment.provider} environment; set codex-execution-mode to app-server or remove the setting`,
      );
    }
    if (worker.allowUnsandboxedCommands) {
      throw new Error(
        `${worker.harness} cannot use allow-unsandboxed-commands with ${environment.provider} environment; remove allow-unsandboxed-commands because commands run in the sandbox`,
      );
    }
  }
}

async function startValidatedWorkletRuntime(
  options: WorkletRuntimeOptions,
  onCleanupFailure: NonNullable<WorkletRuntimeOptions["onCleanupFailure"]>,
): Promise<WorkletRuntimeHandle> {
  const { transport, tlsCa, workletId, workspaces, labels, timeoutMs, skills } = options;
  const localMountRoot =
    options.localMountRoot === undefined
      ? undefined
      : await resolveLocalMountRoot(options.localMountRoot);
  const credential = options.credential.token;
  const workerStateDirectory = stateDirectory();
  const artifactControlPlane = options.artifacts.controlPlane;
  const workerHostId = options.credential.workerHostId.trim();
  const artifactDirectory = join(workerStateDirectory, "artifacts");
  const artifactVolume = options.artifacts.volume;
  let transferBaseUrl: string | undefined;
  let inventoryRevision = 0;
  let inventoryRegistration = Promise.resolve();
  const grpcUrl = workletApiUrl(options.url, transport);
  const hostArtifacts =
    transport === "grpc"
      ? new GrpcArtifactHostClient({
          baseUrl: grpcUrl,
          token: credential,
          workerHostId,
          ...(tlsCa ? { tlsCa } : {}),
        })
      : undefined;
  // The producing host keeps each copy on its artifact Volume when it has one, else under its
  // state directory. Only the host reads the Volume's credential.
  const volumeStore =
    options.artifacts.copies === undefined && artifactVolume !== undefined
      ? hostArtifactVolumeStore({
          ...artifactVolume,
          token: credential,
          workerHostId,
          ...(hostArtifacts === undefined ? {} : { hostArtifacts }),
          ...(artifactControlPlane === undefined ? {} : { controlPlane: artifactControlPlane }),
        })
      : undefined;
  const localCopies = new FileArtifactStore(artifactDirectory);
  const artifactCopies: ArtifactCopies = options.artifacts.copies ?? volumeStore ?? localCopies;
  const volumes = workletVolumeResolver(
    options,
    workerStateDirectory,
    artifactVolume === undefined
      ? undefined
      : {
          name: artifactVolume.name,
          source: async () => {
            if (volumeStore) return volumeStore.source();
            throw new Error("Artifact Volume is not read on this host");
          },
        },
  );
  const catalogFor = (spec: TaskAttemptSpec) => {
    if (!spec.coordination) throw new Error("Artifact metadata requires Attempt authority");
    return new GrpcArtifactCatalogClient({
      baseUrl: grpcUrl,
      token: spec.coordination.token,
      ...(tlsCa ? { tlsCa } : {}),
    });
  };
  const registerCopies = (
    copies: readonly { readonly digest: string; readonly sizeBytes: number }[],
  ): Promise<void> => {
    const registration = inventoryRegistration.then(async () => {
      if (transferBaseUrl === undefined) return;
      inventoryRevision += 1;
      if (hostArtifacts) {
        await hostArtifacts.registerCopies({ inventoryRevision, transferBaseUrl, copies });
        return;
      }
      if (artifactControlPlane === undefined)
        throw new Error("Artifact Control Plane is unavailable");
      await artifactRequest(artifactControlPlane, "/internal/v1/artifacts/worklet-copies", {
        method: "PUT",
        token: credential,
        workerHostId,
        body: { inventoryRevision, transferBaseUrl, copies },
      });
    });
    inventoryRegistration = registration.catch(() => undefined);
    return registration;
  };
  // A consumer reads another host's copy on a shared Volume with this host's own mapping, never
  // a credential from elsewhere, and only at the key the catalog names after checking its grant.
  const readVolume = artifactVolumeReader({
    ...(artifactVolume === undefined ? {} : { artifactVolume }),
    ...(options.readVolumeCredential === undefined
      ? {}
      : { readVolumeCredential: options.readVolumeCredential }),
  });
  const artifactStore = (spec: TaskAttemptSpec) => {
    const metadata = spec.coordination ? attemptArtifactMetadata(spec.coordination) : undefined;
    return new WorkletArtifactStore({
      copies: volumeStore?.forAttempt(spec.attemptId) ?? artifactCopies,
      // Copies on a Volume sit beside other hosts' copies, so reads go through the catalog.
      sharedCopies: artifactCopies !== localCopies,
      readVolume,
      allowInsecureHttp: options.artifacts.allowInsecureHttp,
      resolve: async (ref) => {
        if (!spec.coordination || !metadata || !ref.artifactId || !ref.path)
          throw new Error("Direct artifact transfer requires catalog identity");
        if (hostArtifacts)
          return catalogFor(spec).resolveTransfer({
            artifactId: ref.artifactId,
            path: ref.path,
          });
        return metadata("/internal/v1/artifacts/catalog/resolve-transfer", {
          artifactId: ref.artifactId,
          path: ref.path,
        });
      },
      publish: async ({ ref, sizeBytes }) => {
        if (!spec.coordination || !metadata || !ref.digest)
          throw new Error("Artifact publication requires Attempt coordination");
        // Bind the receipt to this write's Volume source. Refusal must refresh the next write
        // before this host can advertise the copy.
        const receipt = {
          digest: ref.digest,
          sizeBytes,
          ...(volumeStore === undefined ? {} : volumeStore.uploadReceipt(ref)),
        };
        try {
          if (hostArtifacts) await catalogFor(spec).recordUpload(receipt);
          else await metadata("/internal/v1/artifacts/catalog/upload", receipt);
        } catch (error) {
          volumeStore?.invalidate();
          throw error;
        }
        await volumeStore?.acceptUpload(ref, sizeBytes, spec.attemptId);
        await registerCopies([{ digest: ref.digest, sizeBytes }]);
      },
    });
  };
  // A Worklet serves its own copies: the Control Plane never carries artifact bytes. Without an
  // address its consumers can reach, it serves nothing and registers no copies for transfer.
  const transferListen = artifactTransferListen(options.artifacts);
  let artifactServer: WorkletArtifactTransferServer | undefined;
  if (transferListen !== undefined) {
    let transferKey: { readonly publicKey: string };
    if (hostArtifacts) transferKey = await hostArtifacts.getTransferKey();
    else if (artifactControlPlane === undefined)
      throw new Error("Artifact Control Plane is unavailable");
    else
      transferKey = await artifactRequest<{ publicKey: string }>(
        artifactControlPlane,
        "/internal/v1/artifacts/transfer-key",
        { method: "GET" },
      );
    artifactServer = new WorkletArtifactTransferServer({
      workerHostId,
      store: artifactCopies,
      verificationKey: artifactTransferVerificationKey(transferKey.publicKey),
      onError: (error) =>
        process.stderr.write(`Artifact transfer server error: ${errorMessage(error)}\n`),
    });
    transferBaseUrl = await artifactServer.listen(transferListen);
  }
  const unavailableSkills: ContextResolver = {
    type: SKILL_CONTEXT_TYPE,
    versions: [1],
    outputKinds: ["skill"],
    async resolve(item) {
      throw new Error(`Worker Host has no Skill catalog for ${item.itemKey}`);
    },
  };
  const contextResolvers = new ContextResolverRegistry([
    new ArtifactContextResolver(),
    skills ?? unavailableSkills,
  ]);
  const sessionStorage: SessionStorageOptions =
    transport === "grpc"
      ? {
          coordinationFetch: (spec: TaskAttemptSpec) => {
            if (!spec.coordination) throw new Error("Coordination requires Attempt authority");
            return new GrpcCoordinationClient({
              baseUrl: grpcUrl,
              token: spec.coordination.token,
              ...(tlsCa ? { tlsCa } : {}),
            }).fetch;
          },
          artifactCatalogTransport: catalogFor,
          sessionStateStore: (spec: TaskAttemptSpec) => {
            const authority = spec.session?.persistence ?? spec.coordination;
            return authority
              ? new GrpcSessionStateStore({
                  baseUrl: grpcUrl,
                  token: authority.token,
                  ...(tlsCa === undefined ? {} : { tlsCa }),
                })
              : new InMemorySessionStateStore();
          },
        }
      : {};
  // One provider serves every Worker: its sandboxes, and its prepared Workspaces by digest.
  const executionEnvironment =
    options.environment === undefined
      ? undefined
      : await createHostEnvironmentProvider(options.environment, {
          stagingDirectory: join(workerStateDirectory, "environment-staging"),
          sandboxTimeoutMs: timeoutMs + SANDBOX_CLEANUP_MARGIN_MS,
        });
  const workers = options.workers.map((spec) =>
    createHarnessWorker(spec, {
      ...(executionEnvironment === undefined ? {} : { executionEnvironment }),
      ...(options.environment === undefined ? {} : { splitHostEnvironment: true }),
      mcpServers: options.mcpServers ?? {},
      ...(options.mcpHeaders === undefined ? {} : { mcpHeaders: options.mcpHeaders }),
      ...(options.mcpEnvironment === undefined ? {} : { mcpEnvironment: options.mcpEnvironment }),
      ...(options.workspaceMcpVariables === undefined
        ? {}
        : { workspaceMcpVariables: options.workspaceMcpVariables }),
      checkouts: workspaces.checkouts,
      worktreeRoot: join(workerStateDirectory, "workspaces"),
      volumes,
      ...(localMountRoot === undefined ? {} : { localMountRoot }),
      shared: {
        ...sessionStorage,
        onCleanupFailure,
        workspace: options.workspace,
        timeoutMs,
        redactValues: [credential],
        contextResolvers,
        artifactStore,
      },
    }),
  );
  const runningWorktrees = new Map<string, string>();
  const observed = workers.map((worker) =>
    observeAttempts(worker, {
      started(spec) {
        // Remote execution may leave a host-side preparation copy. It is not the live worktree.
        if (executionEnvironment === undefined && spec.workspacePlan.status === "workspace")
          runningWorktrees.set(
            spec.attemptId,
            join(
              workerStateDirectory,
              "workspaces",
              spec.workspacePlan.workspace,
              "worktrees",
              gitRefComponent(spec.taskId),
            ),
          );
        options.onAttempt?.started(spec);
      },
      finished(spec) {
        runningWorktrees.delete(spec.attemptId);
        options.onAttempt?.finished(spec);
      },
    }),
  );
  const localWorklet = new HostServiceWorklet(
    workletId,
    workerHostId,
    observed,
    { workspaces: workspaces.checkouts.map((checkout) => checkout.name), labels },
    options.hostMcpServerNames ?? [],
    options.hostMcpLoginsNeeded,
    options.hostVolumeCredentialNames,
    artifactVolume?.name,
  );
  const durableWorklet = new DurableLocalWorklet(
    localWorklet,
    new FileAttemptJournal(
      options.journalDirectory ??
        join(workerStateDirectory, "workers", options.journalId, "attempt-journal"),
    ),
    options.onUncertainAttempts === undefined
      ? {}
      : { onUncertainAttempts: options.onUncertainAttempts },
  );
  const client = new WorkletConnection({
    diskSpace: readHostDiskSpace,
    changedPaths: async () =>
      (
        await scanRunningAttempts(
          [...runningWorktrees].map(([attemptId, worktree]) => ({ attemptId, worktree })),
        )
      ).filter((report) => runningWorktrees.has(report.attemptId)),
    url: grpcUrl,
    transport,
    ...(tlsCa === undefined ? {} : { tlsCa }),
    credential,
    worklet: localWorklet,
    durableWorklet,
    onError: (error) => {
      process.stderr.write(`Worklet connection error: ${errorMessage(error)}\n`);
    },
    onConnected: () => {
      process.stdout.write(
        `Worklet ${workletId} connected to the SuperTag Control Plane API Server\n`,
      );
      options.onConnected?.();
      void reconcileArtifactInventory(artifactCopies, registerCopies).catch((error) => {
        process.stderr.write(`Artifact inventory reconciliation failed: ${errorMessage(error)}\n`);
      });
    },
    onDisconnected: () => {
      if (!stopping) process.stderr.write(`Worklet ${workletId} disconnected; reconnecting\n`);
      options.onDisconnected?.();
    },
  });
  let stopping = false;
  const started = client.start();
  // The caller observes the first connection through `started`; keep a rejection handled.
  started.catch(() => undefined);
  let stopped: Promise<void> | undefined;
  return {
    workletId,
    workerHostId,
    started,
    setConcurrency: (concurrency) => {
      localWorklet.setWorkerConcurrency(concurrency);
      client.heartbeat();
    },
    stop: () => {
      stopping = true;
      stopped ??= (async () => {
        await client.stop();
        await artifactServer?.close();
        await durableWorklet.shutdown("Worklet stopped");
      })();
      return stopped;
    },
  };
}

/**
 * A Worker Host's artifact copies on its artifact Volume. The Volume's source and credential name
 * come from the catalog through this host's own credential (gRPC when `hostArtifacts` is given,
 * else the HTTP API at `controlPlane`); the credential value comes from `readCredential`, here.
 */
export function hostArtifactVolumeStore(options: {
  readonly name: string;
  readonly readCredential: (credential: string) => Promise<string | { readonly path: string }>;
  readonly token: string;
  readonly workerHostId: string;
  readonly hostArtifacts?: Pick<GrpcArtifactHostClient, "getArtifactVolume">;
  readonly controlPlane?: string;
}): HostArtifactVolumeStore {
  const { name, hostArtifacts, controlPlane } = options;
  return new HostArtifactVolumeStore(
    {
      volume: name,
      readCredential: options.readCredential,
      lookup: async () => {
        if (hostArtifacts) return hostArtifacts.getArtifactVolume(name);
        if (controlPlane === undefined) throw new Error("Artifact Control Plane is unavailable");
        const volume = await artifactRequest<Partial<TaskWorkspaceVolume> | undefined>(
          controlPlane,
          `/internal/v1/artifacts/volume?name=${encodeURIComponent(name)}`,
          { method: "GET", token: options.token, workerHostId: options.workerHostId },
        );
        if (
          volume?.name !== name ||
          typeof volume.source !== "string" ||
          (volume.credential !== undefined && typeof volume.credential !== "string")
        )
          throw new Error("Invalid artifact Volume");
        return {
          name: volume.name,
          source: volume.source,
          ...(volume.credential === undefined ? {} : { credential: volume.credential }),
        };
      },
    },
    join(
      stateDirectory(),
      "artifact-upload-receipts",
      createHash("sha256").update(options.workerHostId).digest("hex"),
    ),
  );
}

/**
 * The Volume resolver every Worker on this Worklet copies Workspace mounts with. Volumes come
 * from the catalog entries each Attempt is dispatched with, credentials from this host's
 * `volume-credentials` mapping, read in this process only. A `file://` source may never be in or
 * contain SuperTag's state directory or a file a secret comes from.
 */
export function workletVolumeResolver(
  options: Pick<
    WorkletRuntimeOptions,
    "readVolumeCredential" | "readVolumeMountCredential" | "volumeProtectedPaths"
  >,
  workerStateDirectory: string,
  artifactVolume?: { readonly name: string; readonly source: () => Promise<string> },
): VolumeResolver {
  return hostVolumeResolver({
    ...(options.readVolumeMountCredential === undefined
      ? {}
      : { readMountCredential: options.readVolumeMountCredential }),
    ...(artifactVolume === undefined ? {} : { artifactVolume }),
    readCredential:
      options.readVolumeCredential ??
      (async (name) => {
        throw new Error(`no volume-credentials mapping for ${name}`);
      }),
    protectedDirectories: [workerStateDirectory, ...(options.volumeProtectedPaths ?? [])],
  });
}

/** A Worker whose `execute` reports when each Task Attempt starts and finishes. */
function observeAttempts<T extends object>(
  worker: T,
  observer: NonNullable<WorkletRuntimeOptions["onAttempt"]>,
): T {
  return new Proxy(worker, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "execute" && typeof value === "function")
        return (spec: TaskAttemptSpec, signal?: AbortSignal) => {
          const events = (
            value as (spec: TaskAttemptSpec, signal?: AbortSignal) => AsyncIterable<unknown>
          ).call(target, spec, signal);
          return (async function* () {
            observer.started(spec);
            try {
              yield* events;
            } finally {
              observer.finished(spec);
            }
          })();
        };
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

type SessionStorageOptions = Partial<
  Pick<
    Parameters<typeof createCodexWorker>[0],
    "coordinationFetch" | "artifactCatalogTransport" | "sessionStateStore"
  >
>;

export interface SharedWorkerOptions extends SessionStorageOptions {
  readonly onCleanupFailure?: (failure: {
    readonly attemptId: string;
    readonly diagnostics: readonly string[];
  }) => void;
  readonly workspace: string;
  readonly timeoutMs: number;
  readonly redactValues: readonly string[];
  readonly contextResolvers: ContextResolverRegistry;
  readonly artifactStore?: (spec: TaskAttemptSpec) => WorkletArtifactStore;
}

/** Builds one built-in Worker with credentials and tools from its own Worker namespace. */
export function createHarnessWorker(
  spec: WorkletHarnessWorker,
  context: {
    readonly mcpServers: Readonly<Record<string, McpServerDefinition>>;
    readonly mcpHeaders?: McpServerHeaders;
    readonly mcpEnvironment?: McpServerEnvironment;
    readonly workspaceMcpVariables?: Readonly<Record<string, string>>;
    /** A remote sandbox provider for Task Attempts; omitted means the local process environment. */
    readonly executionEnvironment?: ExecutionEnvironmentProvider;
    /** Host services keep split-capable harness processes on this Worker Host. */
    readonly splitHostEnvironment?: boolean;
    readonly checkouts: WorkletWorkspaces["checkouts"];
    readonly worktreeRoot: string;
    readonly localMountRoot?: LocalMountRoot;
    /** Resolves Workspace copy mounts' Volumes and credentials on this Worker Host. */
    readonly volumes?: VolumeResolver;
    readonly shared: SharedWorkerOptions;
  },
) {
  const { workerId, profileId, profileRevision, harness } = spec;
  if (context.splitHostEnvironment && context.executionEnvironment === undefined)
    throw new Error(
      `${harness} split host environment requires an e2b or Modal execution provider; configure environment on the host service`,
    );
  if (context.splitHostEnvironment && harness === "codex" && spec.codexExecutionMode === "exec")
    throw new Error(
      "codex-execution-mode exec cannot run with environment; set codex-execution-mode to app-server or remove the setting",
    );
  const githubCredentials = new EnvironmentGitHubCredentialProvider();
  const workspaceResolvers = new WorkspaceResolverRegistry([
    // Named Workspaces: per-Task worktrees of checkouts declared with --workspace NAME=PATH,
    // or of a host-managed clone of the Workspace source when no checkout is declared.
    new WorkspaceEnvironmentResolver({
      checkouts: context.checkouts,
      worktreeRoot: context.worktreeRoot,
      ...(context.localMountRoot === undefined ? {} : { localMountRoot: context.localMountRoot }),
      cloneSources: true,
      ...(context.volumes === undefined ? {} : { volumes: context.volumes }),
      ...(context.workspaceMcpVariables === undefined
        ? {}
        : { mcpVariables: context.workspaceMcpVariables }),
      sourceCredentials: new GitHubWorkspaceSourceCredentials({ credentials: githubCredentials }),
      pullRequests: new GitHubPullRequestPublisher({ credentials: githubCredentials }),
      ...(context.executionEnvironment?.workspaceEnvironment === undefined
        ? {}
        : {
            environments: {
              [context.executionEnvironment.id]: context.executionEnvironment.workspaceEnvironment,
            },
          }),
    }),
    new GitHubRepositoryWorkspaceResolver({
      credentials: githubCredentials,
    }),
  ]);
  const toolProviders = new ToolProviderRegistry([
    // `target: mcp` grants reach the host's MCP servers only through the policy proxy, which
    // also launches stdio servers.
    new HttpMcpToolProvider({
      servers: context.mcpServers,
      workspaceServers: (attemptId) => workspaceResolvers.mcpServersForAttempt(attemptId),
      ...(context.mcpHeaders === undefined ? {} : { headers: context.mcpHeaders }),
      ...(context.mcpEnvironment === undefined ? {} : { environment: context.mcpEnvironment }),
    }),
  ]);
  const common = {
    ...context.shared,
    ...(context.executionEnvironment === undefined
      ? {}
      : { executionEnvironment: context.executionEnvironment }),
    redactValues: [...context.shared.redactValues],
    workerId,
    profileId,
    profileRevision,
    workspaceResolvers,
    toolProviders,
    maxConcurrency: spec.concurrency ?? machineWorkerConcurrency(),
    ...(spec.allowUnsandboxedCommands === true && harness !== "codex"
      ? { allowUnsandboxedCommands: true }
      : {}),
  };
  if (context.splitHostEnvironment && spec.allowUnsandboxedCommands) {
    throw new Error(
      `${harness} cannot use allow-unsandboxed-commands with environment; remove allow-unsandboxed-commands because commands run in the sandbox`,
    );
  }
  const harnessRuntime =
    context.splitHostEnvironment &&
    (harness === "claude-code" || harness === "cursor" || harness === "codex")
      ? new LocalHarnessRuntimeProvider()
      : undefined;
  const models = spec.models ?? [];
  if (harness === "codex")
    return createCodexWorker({
      ...common,
      ...(harnessRuntime === undefined ? {} : { harnessRuntime }),
      executionMode: context.splitHostEnvironment
        ? "app-server"
        : (spec.codexExecutionMode ?? "exec"),
      ...(models.length === 0 ? {} : { models }),
    });
  if (harness === "cursor")
    return createCursorWorker({
      ...common,
      ...(harnessRuntime === undefined ? {} : { harnessRuntime }),
      ...(models.length === 0 ? {} : { models }),
    });
  if (harness === "opencode")
    return createOpenCodeWorker({
      ...common,
      model: requiredOpenCodeModel(models[0]),
      models,
      providerEnvironment: Object.assign(
        {},
        ...models.map((model) => openCodeProviderEnvironment(model)),
      ),
    });
  return createClaudeCodeWorker({
    ...common,
    ...(harnessRuntime === undefined ? {} : { harnessRuntime }),
    ...(models.length === 0 ? {} : { models }),
  });
}

function requiredOpenCodeModel(value: string | undefined): string {
  if (!value?.trim()) throw new Error("OpenCode requires --model provider/model");
  return value.trim();
}

function parseHarness(value: string): WorkletHarness {
  if (value === "claude-code" || value === "codex" || value === "cursor" || value === "opencode") {
    return value;
  }
  throw new Error("--harness must be claude-code, codex, cursor, or opencode");
}

export function workletApiUrl(
  input: string,
  transport: "websocket" | "grpc" = "websocket",
): string {
  const url = new URL(input);
  if (transport === "grpc") {
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error("Worklet gRPC requires HTTPS outside loopback");
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error(
        "Worklet gRPC URL must be a listener origin without credentials, path, query, or fragment",
      );
    return url.toString();
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("The Worklet URL must use http:, https:, ws:, or wss:");
  }
  if (
    url.protocol === "ws:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost" &&
    url.hostname !== "[::1]"
  )
    throw new Error("Remote Worklet API URLs must use HTTPS or WSS");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "The Worklet URL must not contain credentials, query parameters, or a fragment",
    );
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/worklets";
  }
  return url.toString();
}

function httpControlPlaneUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(
      "Artifact metadata needs --artifact-control-plane HTTP_URL for this Worklet URL",
    );
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

async function artifactRequest<T = unknown>(
  controlPlaneUrl: string,
  path: string,
  options: {
    readonly method: "GET" | "POST" | "PUT";
    readonly token?: string;
    readonly workerHostId?: string;
    readonly body?: unknown;
  },
): Promise<T> {
  const base = new URL(controlPlaneUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid artifact Control Plane URL");
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    throw new Error("Artifact Control Plane requires HTTPS outside loopback");
  const response = await fetch(new URL(path, `${base.origin}/`), {
    method: options.method,
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.workerHostId === undefined
        ? {}
        : { "x-supertag-worker-host-id": options.workerHostId }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const diagnostic = (await response.text()).slice(0, 4096);
    throw new ArtifactMetadataRequestError(
      response.status,
      `Artifact metadata request failed (HTTP ${response.status})${diagnostic ? `: ${diagnostic}` : ""}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

class ArtifactMetadataRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactMetadataRequestError";
  }
}

/**
 * One Attempt's HTTP artifact metadata requests. A restarted Control Plane can refuse the
 * Attempt's original execution credential, so a 401 rebinds it once and retries, as the catalog
 * client and the gRPC authority renewal do; a frozen output then publishes without rerunning.
 */
export function attemptArtifactMetadata(coordination: {
  readonly controlPlaneUrl: string;
  readonly token: string;
}): <T = unknown>(path: string, body: unknown) => Promise<T> {
  let token = coordination.token;
  let rebinding: Promise<void> | undefined;
  const rebind = (used: string) =>
    (rebinding ??= (async () => {
      const value = await artifactRequest<{ token?: unknown } | undefined>(
        coordination.controlPlaneUrl,
        "/internal/v1/coordination/rebind",
        { method: "POST", token: used },
      );
      if (typeof value?.token !== "string" || !value.token || value.token.length > 4096)
        throw new Error("Invalid artifact authority rebind credential");
      token = value.token;
    })().finally(() => {
      rebinding = undefined;
    }));
  return async <T>(path: string, body: unknown): Promise<T> => {
    for (let rebound = false; ; rebound = true) {
      const used = token;
      try {
        return await artifactRequest<T>(coordination.controlPlaneUrl, path, {
          method: "POST",
          token: used,
          body,
        });
      } catch (error) {
        if (rebound || !(error instanceof ArtifactMetadataRequestError) || error.status !== 401)
          throw error;
      }
      if (token === used) await rebind(used);
    }
  };
}

async function reconcileArtifactInventory(
  store: ArtifactCopies,
  register: (
    copies: readonly { readonly digest: string; readonly sizeBytes: number }[],
  ) => Promise<void>,
): Promise<void> {
  let batch: { digest: string; sizeBytes: number }[] = [];
  let found = false;
  for await (const copy of store.inventory()) {
    found = true;
    batch.push(copy);
    if (batch.length === 1000) {
      await register(batch);
      batch = [];
    }
  }
  if (batch.length || !found) await register(batch);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workletHelp(): string {
  return `Usage:
  supertag connect worklet [--worklet-url URL] [options]

Connects this machine to a Control Plane as a Worker Host in the foreground, with one harness,
until Ctrl-C. It is the low-level command for scripts and custom setups: it reads only its flags,
never supertag.yaml.

To keep a Worker Host running in the background, serve several harnesses, or start it after a
restart, describe it as a host service in supertag.yaml and run supertag up. supertag init
writes one for this machine.

Options:
  --worklet-url URL          Execution listener; independent of the saved management endpoint
  --transport websocket|grpc  Outbound Worklet connection (default: grpc for HTTP(S), websocket for WS(S))
                             For gRPC, --worklet-url names the gRPC listener URL
  --harness claude-code|codex|cursor|opencode
                             Harness implementation (default: codex)
  --workspace NAME=PATH      Declare a checkout of Workspace NAME (repeatable). Tasks that name
                             the Workspace get their own git worktree on a supertag/... branch.
                             Workspaces with a source and no declared checkout are cloned under
                             the state directory when every profile runs locally
  --workspace PATH           Folder other Tasks may inspect as a copy (default: current directory)
  --label LABEL              Placement label for this Worker Host, such as gpu (repeatable).
                             Automatic labels cover the OS (linux, macos, windows), CPU (x64,
                             arm64), harness:NAME, and workspace:NAME. Labels are self-reported
                             and choose among hosts a Tag may use; they never grant access
  --codex-execution-mode exec|app-server
                             Codex mode (default: exec); app-server supports reported token limits
  --worker-profile ID        Worker profile advertised by this Worklet (default: local-HARNESS)
  --worker-profile-revision REVISION
                             Immutable profile revision accepted by this Worklet (default: 1)
  --model [HARNESS=]MODEL    A model the harness serves; repeat to offer several, the first
                             being the default. Tasks run only on hosts that offer their
                             model. OpenCode requires one, as provider/model
  --allow-unsandboxed-commands
                             Let claude-code, cursor or opencode run Tasks granted
                             commands:execute. They have no enforceable sandbox, so those
                             commands run as you; give their Tags only trusted work. Codex
                             sandboxes commands and needs none
  --concurrency N            Task Attempts the Worker runs at once, 1 through 16 (default:
                             floor(min(CPU cores, memory GB / 3) / 2), kept from 2 through 8).
                             Each Attempt in a Workspace gets its own git worktree
  --timeout-ms MS            Per-Task-Attempt time limit (default: 3600000, 60 minutes)
  --worklet-id ID            Worklet identity (default: local-HARNESS)
  --auth-key KEY|file:PATH   Join as a new Worker Host with an Auth Key (or SUPERTAG_AUTH_KEY).
                             file:PATH reads the key from a file, keeping it out of ps and history.
                             Ignored when this machine already stores a credential for the
                             Control Plane
  --worker-host ID           Worker Host identity (default: this machine's hostname). When joining,
                             the Control Plane picks ID-2, ID-3, ... if ID is taken
  --worker-id ID             Worker and credential namespace (default: local-HARNESS)
  --artifact-control-plane URL
                             HTTP API URL for artifact metadata (default: from a WebSocket Worklet URL;
                             unused over gRPC)
  --artifact-transfer-host HOST
                             Direct-transfer listen host (default: 127.0.0.1); a loopback or
                             unspecified host is not advertised without --artifact-transfer-url
  --artifact-transfer-port PORT
                             Direct-transfer listen port; 0 chooses a free port (default: 0)
  --artifact-transfer-url URL
                             HTTPS origin advertised to other Worklets
  --artifact-transfer-allow-http
                             Permit HTTP for isolated development and private-network tests
  --artifact-volume NAME     Store the artifacts this host's Tasks capture on Volume NAME instead
                             of the state directory, so they outlive the host and hosts mapped
                             to the Volume can read them. No Workspace may mount it. Requires
                             --artifact-volume-credential
  --artifact-volume-credential file:PATH
                             The credential the Volume names, read from a file on this host:
                             a JSON object with accessKeyId and secretAccessKey (optionally
                             sessionToken), or {"path": "/DIR"} to consent to a file:// Volume
                             inside DIR. Only file:PATH is accepted; the value stays on this host

Runs a Worklet on a Worker Host, registers one built-in TypeScript Worker, and connects outbound to the Control Plane's Worklet API. Custom SDK Workers are normal applications started by their own language runtime.

The Worker Host credential is resolved in this order:
  1. A credential stored under ~/.supertag/worker-hosts/ for this Control Plane
  2. An Auth Key from --auth-key or SUPERTAG_AUTH_KEY; the host joins, gets the key's Tags, and
     stores its credential (ephemeral hosts keep it only in memory)
  3. Operator credentials for this Control Plane on this machine; the host is enrolled directly
     and an operator binds Tags with "supertag update tag TAG --add-worker-host ID"
A host credential is never accepted as a flag. Joining uses the management API: SUPERTAG_CONTROL_PLANE or the global
--control-plane option when set, else the origin of a WebSocket Worklet URL, else the saved
Control Plane, because a separate gRPC listener does not serve it. Agent SDKs run
ephemerally with only the tools admitted by the Task's Permission Set; user MCP/settings
configuration remains disabled. Without --worklet-url, the API endpoint of the active Control
Plane configured by "supertag connect control-plane" is used. SUPERTAG_WORKER_WORKSPACE may
provide the workspace path.

A private gRPC certificate authority can be supplied through SUPERTAG_WORKLET_TLS_CA_FILE.
TLS is required outside loopback. The transport never falls back after dispatch.
Distributed artifact storage keeps immutable bytes under ~/.supertag/artifacts and registers only
metadata with the Control Plane. Production deployments should advertise an HTTPS transfer origin.

GitHub repository source and pull-request delivery use a host-local GITHUB_TOKEN. MCP tools,
including the GitHub, Slack, Linear, Teams, and Lark presets, come from the host service's mcp
servers and their auth or env references.
`;
}

export async function runWorkletRecoveryCommand(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: supertag recover worklet --worker-id ID --task ID --attempt ID --confirm-stopped --reason TEXT [--host NAME]\n\nRun on the original Worker Host with its existing state directory. Stop the host service first\n(supertag down SERVICE), or end its supertag connect worklet process: a running host owns its\njournal. supertag ps and the operator inbox show each uncertain Attempt with this command.\nFinds the journal under workers/ID/attempt-journal or, for a host service, the\nhosts/SERVICE/attempt-journal whose stored credential matches the Attempt's Worker Host.\nRefuses ambiguous host services and names them; pass --host NAME (the host service name in\nsupertag.yaml) to select one. Symlinked journal paths are skipped.\nFirst verify all local and remote execution for this Attempt has stopped. This records your\nconfirmation; on reconnect SuperTag releases its reservation and lets its Session take new\nturns. Its outcome remains unknown and it never runs again.\n",
    );
    return;
  }
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      "worker-id": { type: "string" },
      task: { type: "string" },
      attempt: { type: "string" },
      "confirm-stopped": { type: "boolean" },
      reason: { type: "string" },
      host: { type: "string" },
    },
  });
  const worker = values["worker-id"];
  if (!worker || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(worker))
    throw new Error("A safe --worker-id is required");
  if (
    !values.task?.trim() ||
    !values.attempt?.trim() ||
    !values["confirm-stopped"] ||
    !values.reason?.trim()
  )
    throw new Error(
      "Requires --task, --attempt, --confirm-stopped, and --reason after verifying execution stopped",
    );
  if (values.host !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(values.host))
    throw new Error("A safe --host service name is required");
  const journal = await openRecoveryJournal(worker, values.attempt, values.host);
  try {
    const receipt = journal.confirmStopped(
      values.attempt,
      values.task,
      `Operator ${userInfo().username} on ${hostname()} confirmed stopped execution. Reason: ${values.reason}`,
    );
    process.stdout.write(
      `Recorded cleanup confirmation for ${receipt.attemptId}. Outcome remains unknown. Reconnect the Worklet to reconcile Control Plane state and capacity and release its Session.\n`,
    );
  } finally {
    await journal.close();
  }
}

type DirectoryIdentity = { dev: number; ino: number };

/**
 * Walks `components` below the real state directory without following symlinks. Each component
 * is opened with O_NOFOLLOW | O_DIRECTORY and its descriptor's device and inode must match the
 * lstat of its path, so a component swapped for a symlink is never accepted. Returns the
 * canonical path and per-component identities, or undefined when a component is missing or
 * is not a real directory.
 */
async function realDirectoryBelowState(
  components: readonly string[],
): Promise<{ path: string; identities: DirectoryIdentity[] } | undefined> {
  let path = await realpath(stateDirectory());
  const identities: DirectoryIdentity[] = [];
  for (const component of components) {
    path = join(path, component);
    let handle: FileHandle | undefined;
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) return undefined;
      handle = await open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      const opened = await handle.stat();
      if (!opened.isDirectory() || opened.dev !== entry.dev || opened.ino !== entry.ino)
        return undefined;
      identities.push({ dev: opened.dev, ino: opened.ino });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ELOOP: O_NOFOLLOW met a symlink swapped in after lstat. ENOTDIR: not a directory.
      if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }
  return { path, identities };
}

/** True when `components` still resolve, symlink-free, to exactly the directories pinned earlier. */
async function sameDirectoriesBelowState(
  components: readonly string[],
  pinned: readonly DirectoryIdentity[],
): Promise<boolean> {
  const current = await realDirectoryBelowState(components);
  return (
    current !== undefined &&
    current.identities.length === pinned.length &&
    current.identities.every(
      (identity, index) =>
        identity.dev === pinned[index]?.dev && identity.ino === pinned[index]?.ino,
    )
  );
}

/**
 * Finds the journal holding an Attempt: a foreground Worker's `workers/ID/attempt-journal`, or a
 * host service's `hosts/SERVICE/attempt-journal`, whose credential must match the Worker Host
 * recorded on this Attempt. Symlinked paths are skipped, and each opened journal's
 * directories are re-verified by device and inode before recovery writes to it, so a component
 * swapped for a symlink cannot redirect the write out of the state directory. When both the
 * Worker journal and a host journal record the Attempt, recovery refuses rather than guess.
 */
async function openRecoveryJournal(
  worker: string,
  attemptId: string,
  host?: string,
): Promise<FileAttemptJournal> {
  const candidates: string[][] = host ? [] : [["workers", worker, "attempt-journal"]];
  const services = (await realDirectoryBelowState(["hosts"]))
    ? (await readdir(join(await realpath(stateDirectory()), "hosts"))).sort()
    : [];
  if (host !== undefined && !services.includes(host))
    throw new Error(
      `Unknown host service ${host}. Candidate host services: ${services.length ? services.join(", ") : "none"}`,
    );
  for (const service of host === undefined ? services : [host])
    candidates.push(["hosts", service, "attempt-journal"]);
  const opened: {
    label: string;
    journal: FileAttemptJournal;
    records: boolean;
    matchingHost: boolean;
    workerHostId?: string;
  }[] = [];
  const failures: string[] = [];
  // Journals a running host service or Worklet holds; they cannot be read until it stops.
  const owned: string[][] = [];
  const closeAll = () => Promise.all(opened.map(({ journal }) => journal.close()));
  for (const components of candidates) {
    const label = components.join("/");
    // Do not create an empty journal for a mistyped identity.
    const pinned = await realDirectoryBelowState(components);
    if (!pinned) continue;
    const journal = new FileAttemptJournal(pinned.path);
    try {
      await journal.initialize();
    } catch (error) {
      if (error instanceof AttemptJournalOwnedError) owned.push(components);
      failures.push(`${components.slice(0, 2).join("/")}: ${(error as Error).message}`);
      continue;
    }
    if (!(await sameDirectoriesBelowState(components, pinned.identities))) {
      await journal.close();
      await closeAll();
      throw new Error(`Journal path ${label} changed while it was opened; refusing to recover`);
    }
    const inspection = journal
      .inspections()
      .find((entry) => entry.attemptId === attemptId && entry.workerId === worker);
    const records = inspection !== undefined;
    let matchingHost = components[0] === "workers";
    if (records && components[0] === "hosts") {
      const credentialPath = join(
        await realpath(stateDirectory()),
        "hosts",
        components[1] ?? "",
        "credential.json",
      );
      const credential = await readWorkerHostCredential(credentialPath).catch(() => undefined);
      if (!(await sameDirectoriesBelowState(components, pinned.identities))) {
        await journal.close();
        await closeAll();
        throw new Error(`Journal path ${label} changed while it was opened; refusing to recover`);
      }
      // --host is the operator's explicit selection and overrides credential inference.
      matchingHost =
        host !== undefined ||
        (credential !== undefined &&
          inspection.workerHostId !== undefined &&
          credential.workerHostId === inspection.workerHostId);
    }
    if (components[0] === "workers" || records)
      opened.push({
        label,
        journal,
        records,
        matchingHost,
        ...(inspection?.workerHostId === undefined
          ? {}
          : { workerHostId: inspection.workerHostId }),
      });
    else await journal.close();
  }
  // A locked journal on the recorded Worker Host could hold a live copy of the Attempt.
  // A different host service cannot, provided its credential identifies a different Host.
  // Without one unambiguous recorded Host, keep treating every locked journal as a candidate.
  const recordedHosts = opened.filter(
    ({ label, records, matchingHost, workerHostId }) =>
      label.startsWith("hosts/") && records && matchingHost && workerHostId !== undefined,
  );
  const recordedHostId =
    host === undefined &&
    recordedHosts.length === 1 &&
    !opened.some(({ label, records }) => label.startsWith("workers/") && records)
      ? recordedHosts[0]?.workerHostId
      : undefined;
  const possiblyRelevantOwned: string[][] = [];
  for (const components of owned) {
    if (recordedHostId !== undefined && components[0] === "hosts") {
      const credential = await readWorkerHostCredential(
        join(await realpath(stateDirectory()), "hosts", components[1] ?? "", "credential.json"),
      ).catch(() => undefined);
      if (credential?.workerHostId !== undefined && credential.workerHostId !== recordedHostId)
        continue;
    }
    possiblyRelevantOwned.push(components);
  }
  if (possiblyRelevantOwned.length > 0) {
    await closeAll();
    throw new Error(ownedJournalMessage(possiblyRelevantOwned));
  }
  // A foreground Worker journal has no credential to compare, so a host journal that also
  // records the Attempt competes with it whether or not its credential matches.
  const workerRecords = opened.some(
    ({ records, label }) => records && label.startsWith("workers/"),
  );
  const recording = opened.filter(
    ({ records, matchingHost }) => records && (matchingHost || workerRecords),
  );
  if (recording.length > 1) {
    await closeAll();
    throw new Error(
      `Cannot identify the host service for Attempt ${attemptId} and Worker ${worker}. Candidate journals: ${recording.map(({ label }) => label).join(", ")}${(() => {
        const hosts = recording
          .filter(({ label }) => label.startsWith("hosts/"))
          .map(({ label }) => label.split("/")[1]);
        return hosts.length ? `. Candidate host services: ${hosts.join(", ")}` : "";
      })()}. Select the original Worker Host with --host NAME${workerRecords ? ", or move the stale journal aside," : ""} before recovering`,
    );
  }
  // The journal that records the Attempt wins; otherwise keep the foreground Worker journal,
  // which reports the identity mismatch itself.
  const chosen =
    recording[0] ??
    (opened.some(({ records }) => records)
      ? undefined
      : opened.find(({ label }) => label.startsWith("workers/")));
  await Promise.all(
    opened.filter((entry) => entry !== chosen).map(({ journal }) => journal.close()),
  );
  if (chosen) return chosen.journal;
  const unverified = opened.filter(({ records }) => records).map(({ label }) => label);
  if (unverified.length === 0)
    throw new Error(
      `No attempt journal for Worker ${worker} records Attempt ${attemptId} under workers/${worker}/attempt-journal or hosts/*/attempt-journal${failures.length ? `. Skipped: ${failures.join("; ")}` : ""}`,
    );
  throw new Error(
    `Cannot identify a journal for Attempt ${attemptId} and Worker ${worker}. Candidate journals: ${unverified.length ? unverified.join(", ") : "none"}. Each host service needs a credential matching the Attempt's recorded Worker Host${failures.length ? `. Skipped: ${failures.join("; ")}` : ""}`,
  );
}

/** Why recovery cannot read journals a running host service or Worklet owns, and what to do. */
function ownedJournalMessage(owned: readonly string[][]): string {
  const services = owned.filter(([kind]) => kind === "hosts").map(([, service]) => service ?? "");
  const workers = owned.filter(([kind]) => kind === "workers").map(([, worker]) => worker ?? "");
  const held = owned.map((components) => components.join("/")).join(", ");
  const steps = [
    ...services.map((service) => `supertag down ${service}`),
    ...(workers.length ? ["end its supertag connect worklet process"] : []),
  ];
  return `${held} ${owned.length > 1 ? "are" : "is"} owned by a running process, so the Attempt cannot be recovered while it runs. Stop the host service first (${steps.join("; ")}), confirm the Attempt's execution stopped, then run this command again${services.length ? ` and start the host with ${services.map((service) => `supertag up ${service}`).join(", ")}` : ""}.`;
}

/** Accepts an Auth Key or, as Tailscale does, `file:PATH` naming a file that holds one. */
export async function readAuthKey(value: string | undefined): Promise<string | undefined> {
  if (!value?.startsWith("file:")) return value || undefined;
  const path = value.slice("file:".length);
  if (!path) throw new Error("--auth-key file: requires a path");
  const key = (await readFile(path, "utf8")).trim();
  if (!key) throw new Error(`Auth Key file ${path} is empty`);
  return key;
}
