import type { WorkspaceMount } from "@supertag/core";
import type { EnvironmentPlan, ExecutionEnvironment } from "./index.js";
import type { VolumeResolver } from "./volume-copy.js";
import type { WorkspaceMcpServerDefinition } from "./workspace-mcp.js";

// ---------------------------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------------------------

/** Git objects built on the Worker Host: a bundle file and the SHA-256 digest of its bytes. */
export interface GitObjects {
  /** Host path of a `git bundle` file. */
  readonly bundle: string;
  readonly digest: string;
}

/** The commit identity a provider commits Task work with. */
export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

/**
 * The validated subset of a trusted commit's `devcontainer.json` that providers translate.
 * Read and validated by the Worker before `prepare`; local ignores it.
 */
export interface DevcontainerSubset {
  readonly image?: string;
  readonly build?: {
    readonly dockerfile: string;
    /** Resolved path and bytes read with git from the trusted commit. */
    readonly dockerfilePath?: string;
    readonly dockerfileContent?: string;
    /** SHA-256 of the Dockerfile at the trusted commit; part of every prepared digest. */
    readonly dockerfileDigest: string;
    readonly context?: string;
    readonly args?: Readonly<Record<string, string>>;
  };
  readonly onCreateCommand?: DevcontainerCommand;
  readonly updateContentCommand?: DevcontainerCommand;
  readonly postCreateCommand?: DevcontainerCommand;
  readonly containerEnv?: Readonly<Record<string, string>>;
  readonly remoteEnv?: Readonly<Record<string, string>>;
  readonly remoteUser?: string;
  readonly containerUser?: string;
  readonly workspaceFolder?: string;
}

/** A devcontainer lifecycle command in any of its three forms. */
export type DevcontainerCommand =
  | string
  | readonly string[]
  | Readonly<Record<string, string | readonly string[]>>;

/** What a Task's Harness needs installed in a prepared environment, from its Worker Profile. */
export interface WorkspaceHarnessRequirement {
  readonly commands: readonly string[];
  readonly install?: string;
}

/**
 * One Workspace as every provider sees it, built by the Worker from the Task's plan and its host
 * repository. Everything here comes from the trusted commit or the operator; nothing an AI actor
 * wrote.
 */
export interface WorkspaceDefinition {
  readonly workspace: string;
  /** Normalized source URL; `file:` only for local. */
  readonly source: string;
  /**
   * The newest commit both the Task's base and the Workspace's operator-chosen ref contain. Setup,
   * MCP servers, Skills, and devcontainer settings are read only from it.
   */
  readonly trustedCommit: string;
  /**
   * A bundle of the trusted commit, built on the host, for providers that prepare away from it.
   * Absent for a provider whose `capabilities.setupOnHost` is true: local prepares from the host
   * repository itself.
   */
  readonly content?: GitObjects;
  /** Host repository for data-only reads while staging a trusted Docker build context. */
  readonly trustedRepository?: string;
  readonly setup?: string;
  /** From the trusted commit, already validated. */
  readonly devcontainer?: DevcontainerSubset;
  /**
   * The selected MCP servers as the trusted commit declares them, and their digest, as a Task's
   * `mcpPin` records it. Resolved servers can hold host credentials, so they stay with the Worker
   * and never reach a provider; see {@link WorkspaceMcpServerDefinition}.
   */
  readonly mcp?: {
    readonly digest: string;
    readonly servers: readonly WorkspaceMcpServerDefinition[];
  };
  readonly harness: WorkspaceHarnessRequirement;
  /**
   * The Task the prepared environment belongs to, set exactly when the provider's
   * `capabilities.sharedPrepare` is false. It is then part of the prepared digest.
   */
  readonly taskId?: string;
  /**
   * Warm prepare: an artifact this host prepared for the same definition at an ancestor of the
   * trusted commit. The provider starts from it and runs `setup` again on the new trusted commit.
   * Set only by {@link PreparedWorkspaceCache}; never part of the prepared digest.
   */
  readonly warmFrom?: PreparedWorkspace;
}

/** A provider-native artifact prepared from one definition, reused by digest. */
export interface PreparedWorkspace {
  /** `sha256:` digest of the definition's cache key; see {@link preparedWorkspaceDigest}. */
  readonly digest: string;
  /** The provider that owns the artifact, such as `local`, `e2b`, or `modal`. */
  readonly provider: string;
  /** Provider-native artifact: a worktree path, template name, or image ID. */
  readonly artifact: string;
  readonly trustedCommit: string;
  /** Checkout directory inside a remote prepared artifact. */
  readonly workspaceDirectory?: string;
}

/** One Task Attempt's checkout of its branch, started from a prepared artifact. */
export interface TaskCheckout {
  readonly taskId: string;
  readonly attemptId: string;
  /** Operator-defined mounts, resolved from the Task's admission plan. */
  readonly mounts?: readonly WorkspaceMount[];
  /**
   * Resolves the Volumes `mounts` name, with their credentials, on the Worker Host. `start`
   * downloads each `copy` mount through it and delivers files only; nothing it returns is passed
   * to a provider or the Task. Required when `mounts` is not empty.
   */
  readonly volumes?: VolumeResolver;
  /** The Task branch, `supertag/<objective>/<task>`. */
  readonly branch: string;
  /** The commit Task changes are measured from. */
  readonly base: string;
  /** The commit to check out: the branch head, a reviewed commit, or the base. */
  readonly head: string;
  /** Objects from the trusted commit to `head`, for remote providers only. */
  readonly objects?: GitObjects;
  /** The Task's network policy, mounts, and files. */
  readonly plan: EnvironmentPlan;
}

/** The Task branch after `finalize` committed whatever the Attempt left. */
export interface FinalizedWork {
  readonly head: string;
  /** True when the Attempt left changes that `finalize` committed. */
  readonly committed: boolean;
  /** Objects from the base to `head`, read out of a remote sandbox. Absent for local. */
  readonly objects?: GitObjects;
  /** Direct writes uploaded from read-write copy mounts, including partial failures. */
  readonly mountOutputManifests?: readonly import("@supertag/core").MountOutputManifest[];
}

/** What a provider can do, so the Worker can choose and refuse without calling it. */
export interface WorkspaceEnvironmentCapabilities {
  /** Supported Workspace mount strategies; absent means no mounts. */
  readonly mounts?: {
    readonly strategies: readonly ("copy" | "mount")[];
    readonly access: readonly ("read-only" | "read-write")[];
  };
  /** True when one prepared artifact serves many Tasks; false means one artifact per Task. */
  readonly sharedPrepare: boolean;
  /** True only for local: `setup` runs on the Worker Host. */
  readonly setupOnHost: boolean;
  /** True when the provider serves checkouts an operator declared, not only sources. */
  readonly declaredCheckouts: boolean;
  /** True when the provider translates `devcontainer.json`. */
  readonly devcontainer: boolean;
  /** Where Workspace stdio MCP servers run. */
  readonly mcpStdio: "host" | "sandbox";
}

/** The commit `finalize` makes. */
export interface WorkspaceCommit {
  readonly message: string;
  readonly author: GitAuthor;
}

/**
 * An execution environment provider's translation of a Workspace. `refuse` runs before any
 * provider call; `prepare` reads only trusted content; `start` is per Task Attempt; `finalize`
 * runs for every outcome; `evict` discards a prepared artifact.
 */
export interface WorkspaceEnvironment {
  /** Provider name recorded in {@link PreparedWorkspace.provider}. */
  readonly provider: string;
  /** The provider's base, such as a template or image; part of every prepared digest. */
  readonly base?: string;
  readonly capabilities: WorkspaceEnvironmentCapabilities;
  /**
   * Where `prepare` places the copy of the trusted commit that Workspace stdio MCP servers run
   * from: an absolute path inside every Task sandbox, outside the checkout. Set exactly when
   * `capabilities.mcpStdio` is `sandbox`.
   */
  readonly mcpDirectory?: string;
  /**
   * Remote providers: the Harness's view of a started Task checkout, rooted at the checkout's
   * parent so that files the Harness stages or writes at its root, such as credentials, session
   * state, inputs, and outputs, never enter the checkout `finalize` commits. The view refuses a
   * plan that stages into the checkout. Set together with `checkoutPath`.
   */
  harnessEnvironment?(started: ExecutionEnvironment): ExecutionEnvironment;
  /** Where the checkout sits within `harnessEnvironment`'s view, as a relative path. */
  readonly checkoutPath?: string;
  /** A reason naming what this provider cannot run, or undefined. Makes no provider call. */
  refuse(definition: WorkspaceDefinition): string | undefined;
  /** Source-specific native refusal, without provider calls. */
  refuseMount?(
    mount: WorkspaceMount,
    volume: import("./volume-copy.js").ResolvedVolume,
  ): string | undefined;
  prepare(definition: WorkspaceDefinition, signal?: AbortSignal): Promise<PreparedWorkspace>;
  start(
    prepared: PreparedWorkspace,
    task: TaskCheckout,
    signal?: AbortSignal,
  ): Promise<ExecutionEnvironment>;
  /** Commits the Attempt's work, for every outcome. No changes means `committed: false`. */
  finalize(
    environment: ExecutionEnvironment,
    commit: WorkspaceCommit,
    signal?: AbortSignal,
  ): Promise<FinalizedWork>;
  evict(prepared: PreparedWorkspace): Promise<void>;
}
