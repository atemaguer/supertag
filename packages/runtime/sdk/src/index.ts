import type { OutputFileEntry, OutputFileQuery } from "./output-files.js";

export {
  childPath,
  type LocalResourceFilter,
  localResourceFilter,
} from "./local-resource-filter.js";
export type { OutputFileEntry, OutputFileQuery } from "./output-files.js";
export type {
  SplitExecutionBridge,
  SplitExecutionBridgeOptions,
  SplitExecutionToolDefinition,
  SplitExecutionToolName,
  SplitExecutionToolResult,
} from "./split-execution-bridge.js";

import type { LiveMount, TagApprovalRequirement } from "@supertag/core";
import type { CapabilityIdentifier, WorkerProfileRef } from "./execution-capabilities.js";

export type { CapabilityIdentifier, WorkerProfileRef } from "./execution-capabilities.js";

export type { WorkletPlacementReservation } from "./execution-selection.js";
export type {
  DevcontainerCommand,
  DevcontainerSubset,
  FinalizedWork,
  GitAuthor,
  GitObjects,
  PreparedWorkspace,
  TaskCheckout,
  WorkspaceCommit,
  WorkspaceDefinition,
  WorkspaceEnvironment,
  WorkspaceEnvironmentCapabilities,
  WorkspaceHarnessRequirement,
} from "./workspace-environment.js";
export type { WorkspaceMcpServerDefinition } from "./workspace-mcp.js";

import type {
  EnvironmentConnection,
  EnvironmentConnectionOptions,
  EnvironmentGuarantees,
} from "./environment-connection.js";

export { MAX_ARTIFACT_BYTES } from "./artifact-store.js";
export type {
  EnvironmentConnection,
  EnvironmentConnectionOptions,
  EnvironmentGuarantees,
  EnvironmentHttpRequest,
  EnvironmentHttpResponse,
} from "./environment-connection.js";

export { ExecutionCleanupError, ProcessOutputBuffer } from "./process-supervision.js";
export type { ResolvedVolume, VolumeCredentials, VolumeResolver } from "./volume-copy.js";

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TaskResult as CoreTaskResult,
  InboundEventActor,
  JsonRecord,
  TagAuthorizationSnapshot,
  TagContextPlan,
  TaskExecutionRequirements,
  TaskHistoryEntry,
  TaskWorkspacePlan,
} from "@supertag/core";

export type TaskResult = CoreTaskResult;
export type { ArtifactSelection } from "@supertag/core";

export interface TaskOrigin {
  /** Namespaced collaboration surface type, such as slack or github. */
  readonly surface: string;
  readonly accountId: string;
  readonly scope: string;
  readonly sessionKey: string;
  readonly occurredAt: string;
  readonly source?: JsonRecord;
  readonly metadata?: JsonRecord;
}

export interface TaskMessage {
  readonly id: string;
  readonly role: "requester" | "teammate" | "system";
  readonly text: string;
  readonly actor?: InboundEventActor;
}

export interface ResourceRef {
  readonly uri: string;
  readonly mediaType?: string;
  readonly digest?: string;
  readonly provenance?: JsonRecord;
  /** Catalog identity and selected entry path for an admitted artifact input. */
  readonly artifactId?: string;
  readonly path?: string;
}

export interface ArtifactRef extends ResourceRef {
  readonly id: string;
  readonly name?: string;
}

export interface SessionStateRef extends ResourceRef {
  readonly id: string;
  readonly format: string;
}

export interface TaskInput {
  readonly origin: TaskOrigin;
  readonly messages: readonly TaskMessage[];
  readonly attachments?: readonly ResourceRef[];
}

export interface TaskAttemptSessionContext {
  readonly id: string;
  /** Private Session storage transport; confers no coordination tool authority. */
  readonly persistence?: { readonly controlPlaneUrl: string; readonly token: string };
  /**
   * Native state produced by the last successfully completed Task in
   * this Session. The Control Plane admits only Session state whose security and
   * compatibility envelope is valid for this Attempt; the harness still
   * decides whether it understands the native format.
   */
  readonly sessionState?: SessionStateRef;
  /** Canonical, bounded replay fallback from completed Tasks in this Session. */
  readonly history?: readonly TaskHistoryEntry[];
}

/** Immutable, surface-neutral input admitted by the Control Plane for one attempt. */
export interface TaskAttemptSpec {
  readonly version: 2;
  readonly taskId: string;
  readonly attemptId: string;
  readonly tag: {
    readonly id: string;
    readonly name: string;
  };
  readonly input: TaskInput;
  readonly authorization: TagAuthorizationSnapshot;
  /** Privileged transport configuration; never include in model context. */
  readonly coordination?: {
    readonly controlPlaneUrl: string;
    readonly token: string;
    readonly objectiveId?: string;
    readonly scope?: "surface";
  };
  readonly contextPlan: TagContextPlan;
  readonly workspacePlan: TaskWorkspacePlan;
  readonly workerProfile: WorkerProfileRef;
  readonly execution: TaskExecutionRequirements;
  /** Control Plane placement authority derived from the Tag's current Worker Host bindings. */
  readonly placement?: {
    readonly allowedWorkerHostIds: readonly string[];
    readonly workerHostId?: string;
    readonly workletId?: string;
    readonly workerId?: string;
    readonly reservation?: import("./execution-selection.js").WorkletPlacementReservation;
    /**
     * A turn of an Objective's conversation or of a surface conversation. It may use the Worker's coordination
     * slot, one slot beyond maxConcurrency that delegated work and work Sessions never use, so it
     * starts when they fill the Worker.
     */
    readonly coordinationSlot?: boolean;
  };
  readonly session?: TaskAttemptSessionContext;
}

export interface ProviderConfiguration {
  readonly provider: string;
  readonly configuration?: JsonRecord;
}

export type EnvironmentLifetime =
  | { readonly scope: "attempt" }
  | { readonly scope: "session"; readonly idleTimeoutSeconds: number }
  | { readonly scope: "host" };

export interface WorkerProfile {
  readonly ref: WorkerProfileRef;
  readonly workerType: string;
  readonly harness: ProviderConfiguration;
  /** Omit to host the Harness in the same environment selected for workspace execution. */
  readonly runtime?: ProviderConfiguration & { readonly lifetime: EnvironmentLifetime };
  readonly execution: ProviderConfiguration & { readonly lifetime: EnvironmentLifetime };
  /** Trusted, non-secret policy instructions supplied by this immutable profile. */
  readonly instructions?: readonly InstructionInput[];
  readonly limits?: {
    readonly timeoutMs?: number;
    readonly cpu?: number;
    readonly memoryMb?: number;
    readonly diskMb?: number;
  };
}

interface RuntimeInputBase {
  readonly id: string;
  readonly required: boolean;
  readonly sourceItemKey?: string;
}

export interface ToolAuthorization {
  readonly provider: string;
  readonly resources: readonly {
    readonly surfaceAccountId: string;
    readonly scope: string;
    readonly reference?: string;
  }[];
  /**
   * Granted actions on these resources that a Permission Set marks `approval: required`.
   * The Worker asks the Control Plane before forwarding each such call and fails closed.
   */
  readonly approvalRequired?: readonly ToolApprovalRequirement[];
  /** Opaque Worker-local handle for the Attempt's approval channel; never a credential. */
  readonly approvalChannel?: string;
  /**
   * Set for tools of one MCP server granted with `target: mcp`. The grants, not `resources`,
   * decide which tools and resources each call may use.
   */
  readonly mcp?: ToolMcpAuthorization;
}

/** The `target: mcp` grants and approval requirements that apply to one MCP server. */
export interface ToolMcpAuthorization {
  readonly server: string;
  readonly grants: readonly import("@supertag/core").TagMcpGrant[];
  /** The grants marked `approval: required` that cover this server's tools. */
  readonly approvalRequired?: readonly Extract<TagApprovalRequirement, { target: "mcp" }>[];
}

export interface ToolApprovalRequirement {
  readonly surfaceAccountId: string;
  readonly scope: string;
  readonly action: string;
}

/** One semantically authorized operation, independent of its execution mechanism. */
export interface ToolOperation {
  readonly name: string;
  readonly effect: "read" | "write";
  readonly actions: readonly string[];
  readonly inputSchema?: JsonRecord;
  /** Declarative, provider-owned mapping from MCP arguments to an admitted resource. */
  readonly resourceArgumentPolicies?: readonly ToolResourceArgumentPolicy[];
}

export interface ToolResourceArgumentPolicy {
  readonly match: "scope" | "reference";
  readonly prefix?: string;
  readonly separator?: string;
  readonly components: readonly {
    /**
     * Alternative argument paths for one required resource component. A path names a top-level
     * argument, or a nested one with dots, such as `params.container_id`.
     */
    readonly arguments: readonly string[];
  }[];
  /**
   * Apply this policy only when the argument at `argument` equals `equals`. A call that matches
   * no policy names no checkable resource, so a resource-scoped grant refuses it.
   */
  readonly when?: { readonly argument: string; readonly equals: string };
}

/** The Task-scoped external capability a Harness may expose. */
export interface ToolCapability {
  readonly id: string;
  readonly provider: string;
  readonly operations: readonly ToolOperation[];
  readonly authorization: ToolAuthorization;
}

interface ToolRuntimeBindingBase {
  readonly name: string;
  readonly secretRefs?: readonly string[];
}

export type ToolRuntimeBinding =
  | (ToolRuntimeBindingBase & { readonly kind: "worker-local"; readonly handle: string })
  | (ToolRuntimeBindingBase & {
      readonly kind: "mcp-http";
      readonly url: string;
      readonly runtimeHeaders?: Readonly<Record<string, string>>;
    })
  | (ToolRuntimeBindingBase & {
      readonly kind: "mcp-stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly runtimeEnvironment?: Readonly<Record<string, string>>;
    })
  | (ToolRuntimeBindingBase & {
      readonly kind: "native";
      /** Worker-installed adapter identity, such as octokit or a custom function registry. */
      readonly adapter: string;
      readonly configuration: JsonRecord;
    });

export type RuntimeInput =
  | (RuntimeInputBase & {
      readonly kind: "instruction";
      readonly content: string;
      readonly scope: "task" | "workspace" | "project";
      readonly priority: number;
    })
  | (RuntimeInputBase & { readonly kind: "skill"; readonly source: ResourceRef })
  | (RuntimeInputBase & {
      readonly kind: "tool";
      /**
       * Limits this capability to the Harness's root manager. Harness-native
       * children must not receive its binding or credential and cannot invoke it.
       * The Harness reports separately whether it can hard-isolate the schema.
       */
      readonly audience?: "manager";
      readonly capability: ToolCapability;
      readonly binding: ToolRuntimeBinding;
    })
  | (RuntimeInputBase & {
      readonly kind: "workspace";
      readonly source: ResourceRef;
      readonly mountPath?: string;
      readonly readOnly: boolean;
      /** Provider-native preparation that produced this Task checkout, when available. */
      readonly prepared?: import("./workspace-environment.js").PreparedWorkspace;
      /**
       * `copy` (default) stages the source into the execution environment. `in-place` names a
       * local directory, such as a per-Task git worktree, that the Harness uses directly; only
       * colocated local process profiles accept it. `execution-root` means the checkout is
       * already in the execution environment, at `mountPath` relative to its root, as in a remote
       * Workspace sandbox: nothing is staged into it, and the Harness stages its own files at the
       * root, beside the checkout, so they are never committed.
       */
      readonly placement?: "copy" | "in-place" | "execution-root";
    })
  | (RuntimeInputBase & { readonly kind: "resource"; readonly source: ResourceRef })
  | (RuntimeInputBase & {
      readonly kind: "history";
      readonly content: string;
      readonly source: ResourceRef;
      readonly trust: "untrusted-history";
    })
  | (RuntimeInputBase & {
      readonly kind: "secret";
      readonly secretRef: string;
      readonly target: string;
    })
  | (RuntimeInputBase & {
      readonly kind: "sessionState";
      readonly sessionState: SessionStateRef;
    })
  | (RuntimeInputBase & {
      readonly kind: "harness-specific";
      readonly harness: string;
      readonly schemaVersion: number;
      readonly configuration: JsonRecord;
    });

export type InstructionInput = Extract<RuntimeInput, { readonly kind: "instruction" }>;

export type ToolInput = Extract<RuntimeInput, { readonly kind: "tool" }>;

/** Describes a call using its provided, non-secret semantic capability envelope. */
export function describeToolCall(
  inputs: readonly ToolInput[],
  request: {
    readonly id: string;
    readonly binding: { readonly kind: ToolRuntimeBinding["kind"]; readonly name: string };
    readonly operation: string;
    readonly arguments?: unknown;
  },
): ToolCall {
  const tool = inputs.find((candidate) => {
    return (
      candidate.binding.kind === request.binding.kind &&
      candidate.binding.name === request.binding.name &&
      candidate.capability.operations.some((operation) => operation.name === request.operation)
    );
  });
  if (tool === undefined) {
    throw new Error(
      `Harness called unavailable ${request.binding.kind} operation ${request.binding.name}/${request.operation}`,
    );
  }
  const operation = tool.capability.operations.find(
    (candidate) => candidate.name === request.operation,
  );
  if (operation === undefined) throw new Error(`Missing tool operation ${request.operation}`);
  const argumentsRecord = boundedJsonRecord(request.arguments);
  return {
    id: request.id,
    capabilityId: tool.capability.id,
    provider: tool.capability.provider,
    binding: request.binding,
    operation: request.operation,
    effect: operation.effect,
    actions: operation.actions,
    resources: tool.capability.authorization.resources,
    ...(argumentsRecord === undefined ? {} : { arguments: argumentsRecord }),
  };
}

function boundedJsonRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_000) return { omitted: "arguments exceeded 16000 bytes" };
  return JSON.parse(serialized) as JsonRecord;
}

export interface StagedFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly mode?: number;
}

export interface MountSpec {
  readonly source: ResourceRef;
  readonly destination: string;
  readonly readOnly: boolean;
}

export interface SecretBinding {
  readonly secretRef: string;
  readonly target: string;
}

export interface ProcessOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface ProcessSpec {
  /** Keep bounded process stdin open for bidirectional protocols; incompatible with stdin. */
  readonly streamInput?: boolean;
  /**
   * Request lossless bounded live output; unsupported providers must reject. A consumer that falls
   * behind pauses the process at its output pipe, so read `output` while awaiting `wait()`.
   */
  readonly streamOutput?: boolean;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  /**
   * Start with exactly `environment` over the provider's base, without the variables a prepared
   * plan set. Sandbox and shared execution environments honor it.
   */
  readonly replaceEnvironment?: boolean;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessHandle {
  write?(bytes: Uint8Array): Promise<void>;
  endInput?(): Promise<void>;
  readonly output?: AsyncIterable<ProcessOutputChunk>;
  readonly pid?: number;
  wait(): Promise<ProcessResult>;
  kill(signal?: NodeJS.Signals): void;
}

export interface EnvironmentPlan {
  readonly files: readonly StagedFile[];
  readonly mounts: readonly MountSpec[];
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly secretBindings: readonly SecretBinding[];
  readonly network: {
    readonly mode: "none" | "allowlist" | "unrestricted";
    readonly allowedHosts?: readonly string[];
  };
}

export interface ExecutionEnvironmentSpec {
  readonly task: TaskAttemptSpec;
  readonly profile: WorkerProfile;
  readonly plan: EnvironmentPlan;
}

export interface EnvironmentAccess {
  /** Absent guarantees are unknown, never inferred from placement. */
  readonly guarantees?: EnvironmentGuarantees;
  /** Credential-free provider identity and lifetime evidence for audit and recovery. */
  readonly provenance?: JsonRecord;
  connect?(
    process: ProcessHandle,
    options: EnvironmentConnectionOptions,
    signal?: AbortSignal,
  ): Promise<EnvironmentConnection>;
  readonly id: string;
  readonly placement: "local" | "remote" | "managed";
  readonly rootDirectory: string;
  prepare(plan: EnvironmentPlan): Promise<void>;
  resolvePath(path: string): string;
  read(path: string): Promise<string>;
  readBytes?(path: string): Promise<Uint8Array>;
  /** Bounded, symlink-safe enumeration within this Attempt workspace. */
  listOutputFiles?(query: OutputFileQuery): Promise<readonly OutputFileEntry[]>;
  prepareOutputDirectory?(path: string): Promise<void>;
  /** Creates a fresh exclusive directory, rejects collisions, and confines all file writes.
   * Providers must not expose these files to other authorization scopes. */
  materializeArtifactFiles?(input: {
    readonly directory: string;
    readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  }): Promise<string>;
  spawn(process: ProcessSpec, signal?: AbortSignal): Promise<ProcessHandle>;
  dispose(reason: "completed" | "failed" | "cancelled"): Promise<void>;
}

/** Access used to host a Harness process and its private runtime state. */
export interface HarnessRuntime extends EnvironmentAccess {}

/** Access used for workspace operations requested by a Harness. */
export interface ExecutionEnvironment extends EnvironmentAccess {
  /** Successfully attached native sources; providers explicitly project fields, never credentials. */
  readonly liveMounts?: readonly LiveMount[];
}

export interface ExecutionEnvironmentProvider {
  readonly guarantees?: EnvironmentGuarantees;
  /** Prepared Workspace translation, when this provider can serve named Workspaces. */
  readonly workspaceEnvironment?: import("./workspace-environment.js").WorkspaceEnvironment;
  /** Recover provably abandoned provider-owned resources before advertising Worker capacity. */
  recover?(): Promise<void>;
  readonly id: string;
  readonly capabilities: readonly CapabilityIdentifier[];
  provision(spec: ExecutionEnvironmentSpec, signal?: AbortSignal): Promise<ExecutionEnvironment>;
}

export interface ExecutionUsage {
  /** Cumulative reported tokens for this Attempt, excluding prior session history usage. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** Tokens written to Cursor's prompt cache when the provider reports them. */
  readonly cacheWriteTokens?: number;
  /** Reasoning tokens are a subset of outputTokens. */
  readonly reasoningTokens?: number;
  readonly totalTokens: number;
  /** False when reports do not cover the full Attempt or every descendant, including interruptions. Not a billing guarantee. */
  readonly complete: boolean;
  /** Provider-reported actual charge, separate from Objective reservation maxCostMinor. */
  readonly reportedCost?: {
    readonly amountMinor: number;
    readonly currency: string;
    readonly estimated?: boolean;
  };
  /** Model the Harness has no price for, so tokens are recorded but cost is unknown. */
  readonly unpricedModel?: string;
}

export interface NativeAgentActivity {
  readonly id: string;
  readonly parentId?: string;
  readonly status: "running" | "completed" | "failed" | "interrupted";
}

/**
 * One shell command a harness runs itself, such as a Codex command execution or a Claude Code
 * Bash call. Report it when it starts and again when it ends, with the same id, so status views
 * can show what is running and for how long.
 */
export interface NativeCommandActivity {
  readonly id: string;
  /**
   * The command line. It is AI-authored and untrusted: the Worker removes control characters
   * and cuts it to 200 characters before it leaves the Worker.
   */
  readonly command: string;
  readonly status: "running" | "completed" | "failed";
}

export type HarnessEvent =
  | { readonly type: "usage.updated"; readonly usage: ExecutionUsage }
  | { readonly type: "agent.updated"; readonly agent: NativeAgentActivity }
  | { readonly type: "command.updated"; readonly command: NativeCommandActivity }
  | { readonly type: "output.delta"; readonly text: string }
  | {
      readonly type: "output.message";
      readonly text: string;
      /**
       * This is the Attempt's final response: nothing the harness reports after it, and no
       * cancellation or time limit that fires after it, changes the Attempt's outcome.
       * Claim a response at receipt with HarnessRunOptions.claimFinalResponse when delivery
       * may be delayed. Without a claim, the Worker must receive this event before cancellation.
       */
      readonly final?: boolean;
    }
  | {
      /**
       * Control `input` the harness acknowledged `accepted` but whose model never read it, because
       * the Attempt's final response came first and the harness stopped. Its sender treats it as
       * not delivered, so it falls back to the recipient's next turn.
       */
      readonly type: "input.withdrawn";
      readonly commandId: string;
    }
  | { readonly type: "progress.updated"; readonly progress: TaskProgress }
  | { readonly type: "result"; readonly result: TaskResult }
  | { readonly type: "artifact.created"; readonly artifact: ArtifactRef }
  | { readonly type: "session.updated"; readonly sessionState: SessionStateRef }
  | { readonly type: "tool.call.started"; readonly call: ToolCall }
  | {
      readonly type: "tool.call.completed";
      readonly call: ToolCall;
      readonly outcome?: ToolCallOutcome;
    }
  | {
      readonly type: "tool.call.failed";
      readonly call: ToolCall;
      readonly error: { readonly message: string };
    }
  | {
      readonly type: "approval.requested";
      readonly request: {
        readonly id: string;
        readonly description: string;
        readonly data?: JsonRecord;
      };
    };

export type TaskProgressItemStatus = "active" | "blocked" | "completed" | "pending";

/** A bounded, user-facing snapshot of the work currently underway. */
export interface TaskProgress {
  readonly summary: string;
  readonly items?: readonly {
    readonly id: string;
    readonly text: string;
    readonly status: TaskProgressItemStatus;
  }[];
}

/** Portable, bounded record of one harness-initiated external tool call. */
export interface ToolCall {
  readonly id: string;
  readonly capabilityId: string;
  readonly provider: string;
  readonly binding: {
    readonly kind: ToolRuntimeBinding["kind"];
    readonly name: string;
  };
  readonly operation: string;
  readonly effect: "read" | "write";
  readonly actions: readonly string[];
  readonly resources: readonly {
    readonly surfaceAccountId: string;
    readonly scope: string;
    readonly reference?: string;
  }[];
  readonly arguments?: JsonRecord;
}

/** Bounded, portable evidence returned by a successful external action. */
export interface ToolCallOutcome {
  readonly references: readonly string[];
}

const SAFE_PROCESS_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
] as const;

/** Projects only process-launch plumbing plus explicitly named credentials. */
export function minimalProcessEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  additionalKeys: readonly string[] = [],
): Readonly<Record<string, string>> {
  const allowed = new Set<string>([...SAFE_PROCESS_ENVIRONMENT_KEYS, ...additionalKeys]);
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => allowed.has(entry[0]) && entry[1] !== undefined,
    ),
  );
}

export async function digestContextPackage(
  root: string,
  limits: { readonly maxFiles: number; readonly maxBytes: number },
): Promise<string> {
  const rootStatus = await lstat(root).catch((error: unknown) => {
    throw new Error(`Context package path is unavailable: ${root}`, { cause: error });
  });
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error(`Context package path must be a non-symbolic directory: ${root}`);
  }
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const visit = async (path: string, packagePath: string): Promise<void> => {
    const status = await lstat(path).catch((error: unknown) => {
      throw new Error(`Context package path is unavailable: ${root}`, { cause: error });
    });
    if (status.isSymbolicLink()) {
      throw new Error(`Context package cannot contain symbolic links: ${packagePath || "."}`);
    }
    if (status.isDirectory()) {
      hash.update(`directory\0${packagePath}\0`);
      for (const entry of (await readdir(path)).toSorted()) {
        await visit(join(path, entry), packagePath === "" ? entry : `${packagePath}/${entry}`);
      }
      return;
    }
    if (!status.isFile()) {
      throw new Error(`Context package contains unsupported entry: ${packagePath}`);
    }
    files += 1;
    bytes += status.size;
    if (files > limits.maxFiles || bytes > limits.maxBytes) {
      throw new Error(
        `Context package exceeds Worker limits (${limits.maxFiles} files, ${limits.maxBytes} bytes)`,
      );
    }
    hash.update(`file\0${packagePath}\0${status.mode & 0o777}\0${status.size}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
  };
  await visit(root, "");
  return `sha256:${hash.digest("hex")}`;
}

export {
  type ModalVolumeCredential,
  parseModalVolumeCredential,
  parseVolumeSource,
} from "@supertag/core";
export type { EnvironmentHttpLimits } from "./environment-connection.js";
export {
  listSandboxOutputFiles,
  materializeSandboxArtifactFiles,
  prepareSandboxOutputDirectory,
  type SandboxBackend,
  SandboxExecutionEnvironmentProvider,
  type SandboxExecutionEnvironmentProviderOptions,
  type SandboxInstance,
  type SandboxProcess,
  sandboxExecutionEnvironment,
} from "./sandbox-environment.js";
