import {
  COMMANDS_EXECUTE_CAPABILITY_ID,
  WORKSPACE_CLONE_CAPABILITY_ID as CORE_WORKSPACE_CLONE_CAPABILITY_ID,
  type WorkerProfileRef as CoreWorkerProfileRef,
  UNSANDBOXED_COMMANDS_CAPABILITY_ID,
  WORKSPACE_ENVIRONMENT_CAPABILITY_ID,
} from "@supertag/core";

export interface CapabilityIdentifier {
  readonly id: string;
  readonly version: number;
}

export const TASK_ATTEMPT_EVENT_STREAM_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.task-attempt.events",
  version: 1,
};

export const TASK_ATTEMPT_CANCELLATION_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.task-attempt.cancellation",
  version: 1,
};

export const COORDINATION_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.coordination",
  version: 1,
};

export const SURFACE_COORDINATION_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.coordination.surface",
  version: 1,
};

/** Harness can enforce a per-Attempt ceiling on native child agents. */
export const NATIVE_AGENT_LIMIT_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.harness-limit.native-agents",
  version: 1,
};

/** Harness can interrupt from cumulative provider token reports. This is not a billing ceiling. */
export const REPORTED_TOKEN_LIMIT_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.harness-limit.reported-tokens",
  version: 1,
};

/** Harness can apply a provider-native budget to provider-reported monetary cost. */
export const REPORTED_COST_LIMIT_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.harness-limit.reported-cost",
  version: 1,
};

export const LOCAL_PROCESS_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.execution.local-process",
  version: 1,
};

/**
 * The profile runs its Harness and tools in the local process environment, so a declared
 * checkout can be used in place as a per-Task worktree.
 */
export const WORKSPACE_IN_PLACE_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.workspace.in-place",
  version: 1,
};

/**
 * The profile serves Workspaces in place and its Worker keeps a host-managed clone of a
 * Workspace source when the host declares no checkout.
 */
export const WORKSPACE_CLONE_CAPABILITY: CapabilityIdentifier = {
  id: CORE_WORKSPACE_CLONE_CAPABILITY_ID,
  version: 1,
};

/** A profile can start a Task from a prepared Workspace in its execution provider. */
export const WORKSPACE_ENVIRONMENT_CAPABILITY: CapabilityIdentifier = {
  id: WORKSPACE_ENVIRONMENT_CAPABILITY_ID,
  version: 1,
};

/** A profile's Workspace environment can copy Volume content at Task start. */
export const WORKSPACE_COPY_MOUNT_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.workspace.mount.copy",
  version: 1,
};

/**
 * The profile may run Tasks granted `commands:execute`. A profile whose harness runs commands
 * in the local process environment without its own OS sandbox reports it only when its Worker
 * sets `allowUnsandboxedCommands`.
 */
export const COMMANDS_EXECUTE_CAPABILITY: CapabilityIdentifier = {
  id: COMMANDS_EXECUTE_CAPABILITY_ID,
  version: 1,
};

/** The profile's harness runs commands as the host user, without an OS sandbox. */
export const UNSANDBOXED_COMMANDS_CAPABILITY: CapabilityIdentifier = {
  id: UNSANDBOXED_COMMANDS_CAPABILITY_ID,
  version: 1,
};

export type WorkerProfileRef = CoreWorkerProfileRef;

export interface ContextTypeSupport {
  readonly type: string;
  readonly versions: readonly number[];
}

export interface WorkerProfileCapabilities {
  readonly harness?: string;
  /** Static reason this profile cannot start a named Workspace. */
  readonly workspaceRefusal?: string;
  /** Models the profile's harness serves; the first is its default. */
  readonly models?: readonly string[];
  /** Reasoning efforts the harness applies; omitted when it has no effort option. */
  readonly efforts?: readonly ("low" | "medium" | "high")[];
  readonly profile: WorkerProfileRef;
  readonly capabilities: readonly CapabilityIdentifier[];
  readonly contextTypes: readonly ContextTypeSupport[];
}
export interface WorkerDescriptor {
  readonly profileCapabilities: readonly WorkerProfileCapabilities[];
  readonly id: string;
  readonly type: string;
  readonly capabilities: readonly CapabilityIdentifier[];
  readonly profiles: readonly WorkerProfileRef[];
  /** Context Item contracts this Worker can resolve before Harness execution. */
  readonly contextTypes: readonly ContextTypeSupport[];
  readonly maxConcurrency?: number;
}

export interface WorkerHostDescriptor {
  readonly id: string;
  readonly workers: readonly WorkerDescriptor[];
  /** Available space on the filesystem used for local Task Attempt scratch. */
  readonly diskSpace?: { readonly freeBytes: number; readonly totalBytes: number };
  /**
   * Workspace names with a checkout declared on this host. Only names are advertised; paths
   * stay on the host. Present when at least one advertised profile can use a checkout in place.
   */
  readonly workspaces?: readonly string[];
  /**
   * Placement labels: automatic ones such as `linux`, `arm64`, `harness:codex`, and
   * `workspace:NAME`, plus labels the host operator declared. Lowercase, unique, and
   * self-reported: the Control Plane uses them for placement, never for access.
   */
  readonly labels?: readonly string[];
}

export interface WorkletDescriptor {
  /** Durable control RPC extension; absence means unsupported. */
  readonly controlProtocolVersion?: 1;
  /** Durable transport RPC extension for protocol 13 and later; absence means legacy jobs. */
  readonly durableProtocolVersion?: 1;
  readonly id: string;
  readonly protocolVersion: 1;
  readonly host: WorkerHostDescriptor;
}

export type WorkerHostConditionType = "Connected" | "Draining" | "Ready" | "Unreachable";

export interface WorkerHostCondition {
  readonly type: WorkerHostConditionType;
  readonly status: boolean;
  readonly reason: string;
  readonly lastTransitionAt: string;
}

export interface WorkerHostStatus {
  readonly descriptor: WorkerHostDescriptor;
  readonly workletId: string;
  readonly conditions: readonly WorkerHostCondition[];
  readonly lastHeartbeatAt: string;
  readonly activeAttempts: number;
  readonly capacity: number;
  readonly availableSlots: number;
}

export const PROCESS_INPUT_STREAMING_CAPABILITY = {
  id: "supertag.process-input-streaming",
  version: 1,
} as const;
export const PROCESS_OUTPUT_STREAMING_CAPABILITY = {
  id: "supertag.process-output-streaming",
  version: 1,
} as const;

/** Worker enforces automatic output collection before successful completion and cleanup. */
export const TASK_OUTPUT_POLICY_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.artifacts.output-policy",
  version: 1,
};

/** A profile's Workspace environment supports native read-only mounts at Task start. */
export const WORKSPACE_NATIVE_MOUNT_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.workspace.mount.native",
  version: 1,
};
