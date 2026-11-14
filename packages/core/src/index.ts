import type { TagApprovalRequirement } from "./approval.js";
import type { ExecutionEffort } from "./execution-settings.js";
import type { WorkspaceDelivery } from "./workspace.js";

export * from "./approval.js";
export * from "./artifact-catalog.js";
export * from "./cursor-pricing.js";
export * from "./execution-settings.js";
export * from "./live-mount.js";
export * from "./mailbox.js";
export * from "./mcp-grant.js";
export * from "./mount-manifest.js";
export * from "./role.js";
export * from "./task-findings.js";
export * from "./volume.js";
export * from "./workspace.js";

/** A collaboration surface that a SurfaceAccount connects. */
export type ConnectedSurfaceProvider = "github" | "lark" | "linear" | "slack" | "teams";

/**
 * Where a conversation happens: a connected surface, or `cli` for a private operator
 * conversation that the Control Plane answers without an external delivery.
 */
export type SurfaceProvider = "cli" | ConnectedSurfaceProvider;

/** Immutable reference to one revision of a Worker execution profile. */
export interface WorkerProfileRef {
  readonly id: string;
  readonly revision: string;
}

/** Automatic output collection recorded when a Task is accepted. Paths are workspace-relative. */
export interface TaskOutputPolicy {
  readonly directory?: string;
  /** Required file patterns; each must match at least one eligible captured file. */
  readonly required?: readonly string[];
  /** File patterns to preserve in addition to required deliverables. */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly git?: "reference" | "capture" | "ignore";
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

/** Requirements for scheduling a Task; selections are frozen on each Attempt. */
export interface TaskExecutionRequirements {
  readonly outputs?: TaskOutputPolicy;
  readonly requires?: readonly { readonly id: string; readonly version: number }[];
  readonly prefers?: readonly { readonly id: string; readonly version: number }[];
  readonly profile?: WorkerProfileRef;
  readonly harness?: string;
  /** The model the Worker passes to its harness. Placement requires a host that offers it. */
  readonly model?: string;
  /** Reasoning effort; harnesses without an effort option ignore it and record that. */
  readonly effort?: ExecutionEffort;
  /** Required Harness controls. Unsupported controls make the Task ineligible. */
  readonly limits?: {
    /** Maximum number of native child agents active or observed in this Attempt. */
    readonly maxNativeAgents?: number;
    /** Interrupt after cumulative provider token reports reach this value. May overshoot a report. */
    readonly maxReportedTokens?: number;
    /** Provider-native budget over reported cost. Enforcement may stop after the ceiling is crossed. */
    readonly maxReportedCost?: {
      /** Budget in the currency's minor unit, such as cents for USD. */
      readonly amountMinor: number;
      /** Uppercase three-letter currency code accepted by the selected Harness. */
      readonly currency: string;
    };
  };
}

/** Portable identity of one Context Item contract implemented by a Worker resolver. */
export interface ContextTypeRef {
  readonly type: string;
  readonly version: number;
}

/** Explains whether access comes from the invocation location or an explicit Permission Set. */
export type TagAuthorizationSource = "origin" | "permission-set";

export interface TagAuthorizationResource {
  readonly surfaceAccountId: string;
  readonly provider: SurfaceProvider;
  readonly scope: string;
  /** Canonical, non-secret locator when the Surface can provide one. */
  readonly reference?: string;
  readonly actions: readonly string[];
  readonly sources: readonly TagAuthorizationSource[];
}

/**
 * Immutable collaboration authorization captured when the Control Plane admits a Task.
 * The Worklet uses the selected profile and this policy to provision the
 * harness, workspace, and MCP environment without routing tool calls through
 * the collaboration-surface Gateway.
 */
export interface SurfaceTagAuthorizationSnapshot {
  readonly version: 5;
  readonly capturedAt: string;
  readonly tag: {
    readonly id: string;
    readonly name: string;
  };
  readonly origin: {
    readonly tagRouteId: string;
    readonly surfaceAccountId: string;
    readonly provider: SurfaceProvider;
    readonly scope: string;
  };
  readonly requester: InboundEventActor;
  readonly permissionSets: readonly {
    readonly id: string;
    readonly name: string;
    /** Frozen approvers of this set; omitted when the set names none. */
    readonly approvers?: readonly string[];
  }[];
  /** Applicable Roles and assignment revisions frozen before durable admission. */
  readonly roles?: readonly import("./role.js").TagRoleSnapshot[];
  readonly resources: readonly TagAuthorizationResource[];
  /** Semantic Harness/runtime capabilities admitted by active Permission Sets. */
  readonly runtimeActions: readonly string[];
  /** MCP server tools admitted by active Permission Sets. Omitted when none. */
  readonly mcp?: readonly import("./mcp-grant.js").TagMcpGrant[];
  /**
   * Granted actions that a Permission Set marks `approval: required`. Omitted when none; each
   * entry names the requiring sets and their frozen approvers.
   */
  readonly approvals?: readonly TagApprovalRequirement[];
}

/** Authority for internal work is explicit; no surface route is fabricated. */
export interface InternalTagAuthorizationSnapshot
  extends Omit<SurfaceTagAuthorizationSnapshot, "version" | "origin"> {
  readonly version: 4;
  readonly origin: {
    readonly kind: "internal";
    readonly objectiveId: string;
    readonly requestedByTagId: string;
  };
}
export type TagAuthorizationSnapshot =
  | SurfaceTagAuthorizationSnapshot
  | InternalTagAuthorizationSnapshot;

export interface TagContextPlanItem extends ContextTypeRef {
  readonly id: string;
  readonly itemKey: string;
  readonly required: boolean;
  readonly config: JsonRecord;
  /** Optional immutable data captured by a trusted Gateway built-in before dispatch. */
  readonly snapshot?: JsonRecord;
}

export interface TagContextPlanSet {
  readonly id: string;
  readonly name: string;
  readonly items: readonly TagContextPlanItem[];
}

/**
 * Immutable selection of shared artifacts and skills for a Task.
 * This does not authorize access: Worklets enforce authorization separately.
 */
export interface TagContextPlan {
  readonly version: 7;
  readonly capturedAt: string;
  readonly sets: readonly TagContextPlanSet[];
}

export type JsonRecord = Readonly<Record<string, unknown>>;

export type TaskReferenceRelationship =
  | "changed"
  | "inspected"
  | "mentioned"
  | "originated-in"
  | "produced";

/** Stable, provider-aware identity used for deterministic matching of related work. */
export interface TaskReference {
  readonly provider: SurfaceProvider;
  readonly surfaceAccountId?: string;
  readonly resourceType:
    | "artifact"
    | "channel"
    | "file"
    | "issue"
    | "project"
    | "pull-request"
    | "repository"
    | "thread";
  readonly resourceId?: string;
  readonly reference: string;
  readonly relationship: TaskReferenceRelationship;
}

export interface TaskResult {
  readonly summary: string;
  readonly decisions: readonly {
    readonly text: string;
    readonly status?: "accepted" | "proposed";
  }[];
  readonly changes: readonly {
    readonly summary: string;
    readonly reference?: string;
  }[];
  readonly unresolved: readonly string[];
  /** Review findings about this Task. The Control Plane assigns their ids. */
  readonly findings: readonly import("./task-findings.js").TaskFinding[];
  readonly references: readonly TaskReference[];
  readonly artifacts: readonly import("./artifact-catalog.js").ArtifactSelection[];
}

export interface TaskWorkspaceTarget {
  readonly provider: SurfaceProvider;
  readonly surfaceAccountId: string;
  readonly scope: string;
  readonly reference?: string;
  readonly actions: readonly string[];
}

/**
 * Immutable operational workspace decision captured when a Task is admitted.
 * It is intentionally separate from Context Sets: Context equips a Task, while
 * this plan identifies the repository in which the Worker should operate.
 */
export type TaskWorkspacePlan =
  | { readonly version: 1; readonly status: "none" }
  | {
      readonly version: 1;
      readonly status: "selected";
      readonly selectedBy: "default" | "origin" | "request";
      readonly target: TaskWorkspaceTarget;
    }
  | {
      readonly version: 1;
      readonly status: "selection-required";
      readonly choices: readonly TaskWorkspaceTarget[];
    }
  | {
      readonly version: 1;
      readonly status: "unavailable";
      readonly requested: readonly string[];
    }
  | TaskNamedWorkspacePlan;

/**
 * A named Workspace captured at admission. The Worker Host resolves the name to its declared
 * checkout and works on `branch` in a per-Task git worktree.
 */
export interface TaskNamedWorkspacePlan {
  readonly version: 1;
  readonly status: "workspace";
  readonly workspace: string;
  /**
   * The Workspace source captured at admission. Hosts without a declared checkout clone it;
   * pull-request delivery pushes the Task branch to it.
   */
  readonly source?: string;
  /**
   * Base for a new Task branch. Absent: the checkout's current branch, or the source's default
   * branch for a host-managed clone, else `main`.
   */
  readonly ref?: string;
  /** Reserved branch candidate; the Worker records a suffixed name if Git already has it. */
  readonly branch: string;
  /**
   * Branch a Worker recorded for an earlier Attempt of the Task, or for an earlier Task of its
   * Session, carried by the Control Plane.
   */
  readonly branchPin?: string;
  /** Full Worker-recorded commit for branchPin; required to adopt it on a fresh Worker Host. */
  readonly branchPinHead?: string;
  /** Pull request previously recorded for the pinned branch. Delivery rechecks it by number. */
  readonly branchPinPullRequest?: Pick<
    import("./workspace.js").WorkspacePullRequest,
    "repository" | "number"
  >;
  readonly delivery: WorkspaceDelivery;
  /** One shell command run once in each new Task worktree. */
  readonly setup?: string;
  /** Server names selected from the .mcp.json of the Task's base commit at Task start. */
  readonly mcp?: readonly string[];
  /**
   * Digest of the selected MCP configuration that the Task's first Attempt recorded, carried to
   * later Attempts. An Attempt whose configuration differs is refused before any server starts.
   */
  readonly mcpPin?: string;
  /** Skill names selected from the host checkout at Task start. */
  readonly skills?: readonly string[];
  /** Selected GitHub-hosted Skills captured when the Task was accepted. */
  readonly skillCatalog?: import("./workspace.js").WorkspaceSkillCatalog;
  /** Operator-declared data mounts captured when this Task was accepted. */
  readonly mounts?: readonly import("./workspace.js").WorkspaceMount[];
  /**
   * The Volumes `mounts` name, read from the Volume catalog when the Control Plane dispatches an
   * Attempt. Only sources and credential names; the Worker Host resolves each credential itself.
   */
  readonly volumes?: readonly import("./volume.js").TaskWorkspaceVolume[];
  /** Host-observed first-attempt pins, carried to later Attempts for fail-closed retries. */
  readonly skillPins?: readonly {
    readonly name: string;
    readonly source: string;
    readonly digest: string;
  }[];
}

/** Derived continuity view of canonical Task state, never a separate stored resource. */
export interface TaskHistoryEntry {
  readonly taskId: string;
  readonly sessionId: string;
  readonly tagId: string;
  readonly requestText?: string;
  readonly result: TaskResult;
  readonly completedAt: string;
}

export interface InboundEventActor {
  readonly id: string;
  readonly displayName?: string;
  readonly kind: "bot" | "user" | "unknown";
}
