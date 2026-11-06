import { z } from "zod";
import type { ApprovalRequestStore, TagApprovalRequirement } from "./approval.js";
import type { ArtifactCatalogStore } from "./artifact-catalog.js";
import type { ArtifactPublicationStore } from "./artifact-publication.js";
import type { AuditStore } from "./audit.js";
import type { AuthKeyStore } from "./auth-key.js";
import type { CoordinationInboxStore } from "./coordination-inbox.js";
import type { ExecutionEffort, ExecutionSettings } from "./execution-settings.js";
import type { LiveMount } from "./live-mount.js";
import type { TagMailboxStore } from "./mailbox.js";
import type { CoordinationMetricsStore } from "./metrics.js";
import type { MountManifest, MountOutputManifest } from "./mount-manifest.js";
import type { ObjectiveStore } from "./objective.js";
import type { ObjectiveMailboxStore } from "./objective-mailbox.js";
import type { OperatorNotificationStore } from "./operator-notification.js";
import type { OperatorTokenStore } from "./operator-token.js";
import type { ResourceManagementStore } from "./resource-management.js";
import type { RoleStore } from "./role.js";
import type { InternalTurn, SessionAudience, SessionAudienceStore } from "./session-audience.js";
import type { SessionInputStore } from "./session-input.js";
import type { SessionStatePersistence } from "./session-state.js";
import type { SpendStore } from "./spend.js";
import type { TaskAssignmentStore } from "./task-assignment.js";
import type { TeamStore } from "./team.js";
import type { TeamLiveDeliveryStore } from "./team-live-delivery.js";
import type { VolumeStore } from "./volume.js";
import type { WorkerHostStore } from "./worker-host.js";
import type { WorkspaceDelivery, WorkspaceStore } from "./workspace.js";
import type { WorkstreamStore } from "./workstream.js";

export * from "./approval.js";
export * from "./artifact-catalog.js";
export * from "./artifact-publication.js";
export * from "./audit.js";
export * from "./auth-key.js";
export * from "./codex-pricing.js";
export * from "./command-activity.js";
export * from "./command-sandbox.js";
export * from "./commitment-view.js";
export * from "./coordination-inbox.js";
export * from "./cursor-pricing.js";
export * from "./execution-settings.js";
export * from "./live-mount.js";
export { isLoopbackAddress } from "./loopback.js";
export * from "./mailbox.js";
export * from "./mcp-grant.js";
export * from "./metrics.js";
export * from "./mount-manifest.js";
export * from "./objective.js";
export * from "./objective-items.js";
export * from "./objective-limits.js";
export * from "./objective-mailbox.js";
export * from "./operator-notification.js";
export * from "./operator-token.js";
export * from "./resource-management.js";
export * from "./role.js";
export * from "./session-audience.js";
export * from "./session-input.js";
export * from "./session-state.js";
export * from "./spend.js";
export * from "./surface-objective-command.js";
export * from "./task-assignment.js";
export * from "./task-execution.js";
export * from "./task-findings.js";
export * from "./team.js";
export * from "./team-live-delivery.js";
export * from "./volume.js";
export * from "./worker-host.js";
export * from "./worker-host-label.js";
export * from "./workspace.js";
export * from "./workstream.js";

export const tagIdSchema = z.string().trim().min(1).brand<"TagId">();
export type TagId = z.infer<typeof tagIdSchema>;

export type DatabaseProvider = "sqlite" | "postgresql";

/** A collaboration surface that a SurfaceAccount connects. */
export type ConnectedSurfaceProvider = "github" | "lark" | "linear" | "slack" | "teams";

/**
 * Where a conversation happens: a connected surface, or `cli` for `supertag message tag`, which
 * the Control Plane answers itself without an external delivery.
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

export interface CreateTagInput {
  readonly name: string;
}

/** Durable permission for one Worker Host to execute Tasks assigned to a Tag. */
export interface TagWorkerHostBinding {
  readonly tagId: string;
  readonly workerHostId: string;
  readonly createdAt: string;
}

/**
 * `active` Tags receive work. Deleting a Tag retires it: the row stays so Tasks, Sessions,
 * Objectives, and approvals keep their reference, and its name becomes free for a new Tag.
 */
export type TagStatus = "active" | "retired";

/** SuperTag's persistent non-human IAM principal and policy anchor. */
export interface Tag {
  readonly id: string;
  readonly name: string;
  readonly status: TagStatus;
  /** When the Tag was retired; absent while it is active. */
  readonly retiredAt?: string;
  /**
   * Placement labels. A bound Worker Host runs this Tag's Tasks only when it carries every label.
   * Empty means any bound host. Lowercase and sorted.
   */
  readonly runsOn: readonly string[];
  /** Harness, models, and efforts this Tag allows; overrides its Roles' settings field by field. */
  readonly execution?: ExecutionSettings;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TagListFilter {
  /** Include retired Tags. Default: active Tags only. */
  readonly includeRetired?: boolean;
}

export interface FindTagByNameOptions {
  /** Without an active Tag of this name, return the most recently retired one. */
  readonly includeRetired?: boolean;
}

export interface AddTagRouteInput {
  readonly tagId: string;
  readonly surfaceAccountId: string;
  readonly scope: string;
  readonly enabled?: boolean;
  readonly createdBy?: string;
}

/**
 * Internal routing record that selects one Tag for one surface-account scope.
 * Invocation authority comes from the admitted request origin; Context and
 * Permission Set activations independently equip and authorize the Task.
 */
export interface TagRoute {
  readonly id: string;
  readonly tagId: string;
  readonly surfaceAccountId: string;
  readonly scope: string;
  readonly enabled: boolean;
  /**
   * Workspaces an Objective created from this location names. Empty means none, except that
   * GitHub locations then match Workspaces whose `source` is the event's repository.
   */
  readonly workspaces: readonly string[];
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TagRouteListFilter {
  readonly tagId?: string;
  readonly surfaceAccountId?: string;
  readonly enabled?: boolean;
}

export interface CreateTagPermissionSetInput {
  readonly name: string;
  /** Who may decide approval requests governed by this set; see {@link parseApprover}. */
  readonly approvers?: readonly string[];
  readonly createdBy?: string;
}

export interface TagPermissionSet {
  readonly id: string;
  readonly name: string;
  /**
   * `operator:<operatorId>` or `tag:<Tag name or id>` entries allowed to decide approval requests
   * this set governs. Omitted when empty: authorized operators decide.
   */
  readonly approvers?: readonly string[];
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TagPermissionSetListFilter {
  readonly name?: string;
}

/** `required` makes each use of a granted action wait for a recorded approval. */
export type TagPermissionApproval = "required";

interface AddTagPermissionBase {
  readonly permissionSetId: string;
  readonly action: string;
  readonly approval?: TagPermissionApproval;
  readonly createdBy?: string;
}

export interface AddTagSurfacePermissionInput extends AddTagPermissionBase {
  readonly target: "surface";
  readonly surfaceAccountId: string;
  readonly scope: string;
  /** Canonical, non-secret resource locator used for request-time target selection. */
  readonly reference?: string;
}

/**
 * Portable authority for tools supplied by a Harness or its execution runtime.
 * Actions describe capabilities such as `commands:execute` or `browser:use`,
 * never Harness-specific tool names such as `Bash` or `WebSearch`.
 */
export interface AddTagRuntimePermissionInput extends AddTagPermissionBase {
  readonly target: "runtime";
}

/**
 * Authority to call tools of an MCP server: `action` is `server/tool`, where the tool part may
 * use `*` as a wildcard. `resource` limits the grant to calls whose arguments name that resource,
 * and applies only to servers with a resource mapping.
 */
export interface AddTagMcpPermissionInput extends AddTagPermissionBase {
  readonly target: "mcp";
  readonly resource?: string;
}

export type AddTagPermissionInput =
  | AddTagSurfacePermissionInput
  | AddTagRuntimePermissionInput
  | AddTagMcpPermissionInput;

interface TagPermissionBase {
  readonly id: string;
  readonly permissionSetId: string;
  readonly action: string;
  readonly approval?: TagPermissionApproval;
  readonly createdBy?: string;
  readonly createdAt: string;
}

export interface TagSurfacePermission extends TagPermissionBase {
  readonly target: "surface";
  readonly surfaceAccountId: string;
  readonly scope: string;
  readonly reference?: string;
}

export interface TagRuntimePermission extends TagPermissionBase {
  readonly target: "runtime";
}

export interface TagMcpPermission extends TagPermissionBase {
  readonly target: "mcp";
  readonly resource?: string;
}

export type TagPermission = TagSurfacePermission | TagRuntimePermission | TagMcpPermission;

export interface TagPermissionListFilter {
  readonly permissionSetId?: string;
  readonly target?: TagPermission["target"];
  readonly surfaceAccountId?: string;
  readonly scope?: string;
}

export interface ActivateTagPermissionSetInput {
  readonly permissionSetId: string;
  readonly tagRouteId: string;
  readonly createdBy?: string;
}

export interface TagPermissionActivation {
  readonly id: string;
  readonly permissionSetId: string;
  readonly tagRouteId: string;
  readonly createdBy?: string;
  readonly createdAt: string;
}

export interface TagPermissionActivationListFilter {
  readonly permissionSetId?: string;
  readonly tagRouteId?: string;
}

export interface CreateTagContextSetInput {
  readonly name: string;
  readonly createdBy?: string;
}

/** A reusable, permission-neutral collection of Task-composition items. */
export interface TagContextSet {
  readonly id: string;
  readonly name: string;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TagContextSetListFilter {
  readonly name?: string;
}

export interface TagArtifactSelectionPolicy {
  readonly match: "shared-resource";
  readonly maxAgeDays: number;
  readonly limit: number;
}

export const SKILL_CONTEXT_TYPE = "supertag/skill";
export const ARTIFACT_CONTEXT_TYPE = "supertag/artifacts";

/** Portable identity of one Context Item contract implemented by a Worker resolver. */
export interface ContextTypeRef {
  readonly type: string;
  readonly version: number;
}

export type TagSkillContextConfig = JsonRecord & {
  readonly reference: string;
  readonly version?: string;
  readonly digest?: string;
};

export type TagArtifactContextConfig = JsonRecord & {
  /** Exact Tag route from which artifacts from completed Tasks may be selected. */
  readonly sourceRouteId: string;
  readonly selection: TagArtifactSelectionPolicy;
};

export type TagArtifactContextSnapshot = JsonRecord & {
  readonly source: {
    readonly tagRouteId: string;
    readonly surfaceAccountId: string;
    readonly provider: SurfaceProvider;
    readonly scope: string;
  };
  /** Gateway-resolved, immutable cross-Session work admitted for this Task. */
  readonly artifacts: readonly import("./artifact-catalog.js").CapturedArtifactSummary[];
};

export interface AddTagContextItemInput extends ContextTypeRef {
  readonly contextSetId: string;
  /** Stable identity used to make adding an item idempotent. */
  readonly itemKey: string;
  /** Required items fail closed when no compatible Worker resolver is available. */
  readonly required: boolean;
  /** Permission-neutral, non-secret configuration interpreted by the matching Worker resolver. */
  readonly config: JsonRecord;
  readonly createdBy?: string;
}

export interface TagContextItem extends ContextTypeRef {
  readonly id: string;
  readonly contextSetId: string;
  readonly itemKey: string;
  readonly required: boolean;
  readonly config: JsonRecord;
  readonly createdBy?: string;
  readonly createdAt: string;
}

export interface TagContextItemListFilter {
  readonly contextSetId?: string;
}

export interface ActivateTagContextSetInput {
  readonly contextSetId: string;
  readonly tagRouteId: string;
  readonly createdBy?: string;
}

/** Makes one Context Set eligible when the Tag is invoked from one configured location. */
export interface TagContextActivation {
  readonly id: string;
  readonly contextSetId: string;
  readonly tagRouteId: string;
  readonly createdBy?: string;
  readonly createdAt: string;
}

export interface TagContextActivationListFilter {
  readonly contextSetId?: string;
  readonly tagRouteId?: string;
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

export function emptyTagContextPlan(capturedAt: string): TagContextPlan {
  return { version: 7, capturedAt, sets: [] };
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
  /** Review findings about this Task. The Control Plane assigns ids and records each as open. */
  readonly findings: readonly import("./task-findings.js").TaskFinding[];
  /**
   * Findings on earlier Tasks that this re-review reports fixed. They close only when a manager
   * accepts this result, and only on Tasks whose findings this Task's Tag reported.
   */
  readonly fixedFindings?: readonly import("./task-findings.js").TaskFindingReference[];
  readonly references: readonly TaskReference[];
  readonly artifacts: readonly import("./artifact-catalog.js").ArtifactSelection[];
}

export interface Session {
  readonly id: string;
  readonly tagId: string;
  readonly sessionKey: string;
  readonly origin: JsonRecord;
  readonly state: "open";
  readonly audience: SessionAudience;
  /** The requester key that owns a private Session (`sessionRequesterKey`); absent when shared. */
  readonly audienceActorKey?: string;
  /** The conversation Session that started this work Session; absent for a conversation. */
  readonly parentSessionId?: string;
  readonly lastInteractionAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionListFilter {
  readonly tagId?: string;
}

export interface OpenSessionInput {
  readonly tagId: string;
  readonly sessionKey: string;
  readonly origin: JsonRecord;
  /**
   * Makes a new Session private to this requester key. Absent: shared. Only the first open sets
   * the audience; later opens of the same Session never change it.
   */
  readonly audienceActorKey?: string;
  /** Records the conversation Session that started a new work Session. Only the first open sets it. */
  readonly parentSessionId?: string;
  readonly at: string;
}

export type TaskStatus = "cancelled" | "completed" | "failed" | "pending" | "running";

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
  /** Branch recorded by an earlier Task Attempt, carried by the Control Plane. */
  readonly branchPin?: string;
  /** Full Worker-recorded commit for branchPin; required to adopt it on a fresh Worker Host. */
  readonly branchPinHead?: string;
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
  /**
   * The delivered branches of the Task's accepted dependencies in this Workspace, read when the
   * Control Plane dispatches an Attempt. A new Task branch starts from the base merged with each,
   * in order; the Worker merges them before the harness starts.
   */
  readonly dependencyBranches?: readonly TaskWorkspaceDependencyBranch[];
  /** Host-observed first-attempt pins, carried to later Attempts for fail-closed retries. */
  readonly skillPins?: readonly {
    readonly name: string;
    readonly source: string;
    readonly digest: string;
  }[];
}

/** The commit an accepted dependency's Worker recorded delivering on its Task branch. */
export interface TaskWorkspaceDependencyBranch {
  readonly taskId: string;
  readonly branch: string;
  readonly head: string;
}

/** One durable unit of user intent admitted for a Tag within a Session. */
export interface Task {
  /** Objective association captured at admission or by this Task's explicit surface command. */
  readonly surfaceObjectiveId?: string;
  readonly execution: TaskExecutionRequirements;
  readonly id: string;
  readonly inboundEventId: string | null;
  readonly tagId: string;
  readonly sessionId: string;
  readonly actor: InboundEventActor;
  readonly trigger: JsonRecord;
  readonly requestText?: string;
  readonly responseText?: string;
  readonly result?: TaskResult;
  readonly workspacePlan: TaskWorkspacePlan;
  /** Automatic continuity refreshed before execution from earlier Tasks in this Session. */
  readonly sessionHistory: readonly TaskHistoryEntry[];
  readonly authorizationSnapshot: TagAuthorizationSnapshot;
  readonly contextPlan: TagContextPlan;
  readonly status: TaskStatus;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly outcome?: JsonRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskListFilter {
  readonly tagId?: string;
  readonly sessionId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}

export interface OpenTaskInput {
  readonly execution: TaskExecutionRequirements;
  readonly inboundEventId: string;
  readonly tagId: string;
  readonly sessionId: string;
  readonly actor: InboundEventActor;
  readonly trigger: JsonRecord;
  readonly requestText?: string;
  readonly workspacePlan: TaskWorkspacePlan;
  readonly sessionHistory: readonly TaskHistoryEntry[];
  readonly authorizationSnapshot: TagAuthorizationSnapshot;
  readonly contextPlan: TagContextPlan;
  readonly createdAt: string;
}

export interface StartTaskInput {
  readonly taskId: string;
  readonly startedAt: string;
}

export interface CloseTaskInput {
  readonly taskId: string;
  readonly status: Exclude<TaskStatus, "pending" | "running">;
  readonly outcome?: JsonRecord;
  readonly result?: TaskResult;
  readonly responseText?: string;
  readonly endedAt: string;
}

export type TaskAttemptStatus = "cancelled" | "completed" | "failed" | "running";

/** One concrete Worker execution or retry of a Task. */
export interface TaskAttempt {
  readonly workerProfile: WorkerProfileRef;
  readonly id: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly workerSnapshot: JsonRecord;
  readonly mcpServersDigest?: string;
  /** What the Workspace's `copy` mounts placed in this Attempt's environment. */
  readonly mountManifests?: readonly MountManifest[];
  /** Files written back to copy mount sources, including partial or refused uploads. */
  readonly mountOutputManifests?: readonly MountOutputManifest[];
  /** Live sources attached at start; these do not pin their content. */
  readonly liveMounts?: readonly LiveMount[];
  readonly status: TaskAttemptStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome?: JsonRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTaskAttemptInput {
  readonly workerProfile: WorkerProfileRef;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly workerSnapshot: JsonRecord;
  readonly startedAt: string;
}

/** Cancels surface work only before any execution Attempt has been admitted. */
export interface CancelPendingSurfaceTaskInput {
  readonly taskId: string;
  readonly cancelledAt: string;
}

/** Starts one surface execution only while its inbound lease is still authoritative. */
export interface OpenSurfaceTaskAttemptInput extends CreateTaskAttemptInput {
  readonly inboundEventId: string;
  readonly leaseOwner: string;
  readonly now: string;
}

export interface CloseTaskAttemptInput {
  readonly attemptId: string;
  readonly status: Exclude<TaskAttemptStatus, "running">;
  readonly outcome?: JsonRecord;
  readonly endedAt: string;
}

/** Records the authenticated Worker connection that accepted this exact Attempt. */
export interface RecordTaskAttemptWorkerInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly workerHostId: string;
  readonly workletId: string;
  readonly workerId?: string;
  readonly connectionGeneration?: number;
}

export interface TaskEvent {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload?: JsonRecord;
  readonly createdAt: string;
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

export interface TaskHistoryFilter {
  readonly sessionId?: string;
  readonly tagId?: string;
  readonly excludeTaskId?: string;
  readonly relatedTo?: readonly Pick<
    TaskReference,
    "provider" | "surfaceAccountId" | "resourceType" | "resourceId" | "reference"
  >[];
  readonly originSurfaces?: readonly {
    readonly provider: SurfaceProvider;
    readonly surfaceAccountId: string;
    readonly scope: string;
  }[];
  readonly createdAfter?: string;
  /** Only Tasks completed strictly before this time. */
  readonly completedBefore?: string;
  readonly limit?: number;
}

export interface Artifact {
  readonly id: string;
  readonly taskId: string;
  readonly kind: string;
  readonly location: string;
  readonly contentHash?: string;
  readonly sourceReferences?: readonly JsonRecord[];
  readonly metadata?: JsonRecord;
  readonly references: readonly TaskReference[];
  readonly createdAt: string;
}

export interface CreateArtifactInput {
  readonly taskId: string;
  readonly kind: string;
  readonly location: string;
  readonly contentHash?: string;
  readonly sourceReferences?: readonly JsonRecord[];
  readonly metadata?: JsonRecord;
  readonly references?: readonly TaskReference[];
  readonly createdAt: string;
}

export interface ArtifactListFilter {
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly tagId?: string;
  readonly kind?: string;
  readonly relatedTo?: readonly Pick<
    TaskReference,
    "provider" | "resourceType" | "resourceId" | "reference"
  >[];
  readonly originSurfaces?: readonly {
    readonly provider: SurfaceProvider;
    readonly surfaceAccountId: string;
    readonly scope: string;
  }[];
  readonly createdAfter?: string;
  readonly limit?: number;
}

export interface AppendTaskEventInput {
  readonly taskId: string;
  readonly attemptId?: string;
  readonly type: string;
  readonly payload?: JsonRecord;
  readonly createdAt?: string;
}

export type InboundEventKind = "issue" | "issue_comment" | "mention" | "message" | "pull_request";

export interface InboundEventActor {
  readonly id: string;
  readonly displayName?: string;
  readonly kind: "bot" | "user" | "unknown";
}

export interface CallbackRoute {
  readonly provider: SurfaceProvider;
  readonly mode:
    | "cli_conversation"
    | "github_issue_comment"
    | "lark_thread"
    | "linear_issue_comment"
    | "slack_thread"
    | "teams_thread";
  readonly threadKey: string;
  readonly target: Readonly<Record<string, string>>;
}

export interface InboundSurfaceEvent {
  readonly eventId: string;
  readonly logicalEventId: string;
  readonly provider: SurfaceProvider;
  readonly externalAccountId: string;
  readonly kind: InboundEventKind;
  readonly scope: string;
  readonly sessionKey: string;
  readonly actor: InboundEventActor;
  /**
   * True when the conversation is a direct one with one person, such as a Lark direct chat or a
   * person's CLI conversation. Its Session is then private to that requester.
   */
  readonly direct?: boolean;
  /**
   * Set only on turns SuperTag admits itself, never by a surface: a work Session's Task and the
   * report turn that brings its result back to the conversation. See `InternalTurn`.
   */
  readonly internal?: InternalTurn;
  readonly text?: string;
  readonly occurredAt: string;
  readonly callback: CallbackRoute;
  readonly source: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export type DurableInboundEventStatus = "completed" | "failed" | "pending" | "processing";

export interface DurableInboundEvent {
  readonly admissionOrder: number;
  readonly sessionKey: string;
  readonly sessionBlocked: boolean;
  readonly execution: TaskExecutionRequirements;
  readonly id: string;
  readonly surfaceAccountId: string;
  readonly tagRouteId: string;
  readonly tagId: string;
  readonly authorization: SurfaceTagAuthorizationSnapshot;
  readonly contextPlan: TagContextPlan;
  readonly event: InboundSurfaceEvent;
  readonly status: DurableInboundEventStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly lastError?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdmitInboundEventInput {
  readonly execution?: TaskExecutionRequirements;
  readonly surfaceAccountId: string;
  readonly tagRouteId: string;
  readonly tagId: string;
  readonly authorization: SurfaceTagAuthorizationSnapshot;
  readonly contextPlan: TagContextPlan;
  readonly event: InboundSurfaceEvent;
  readonly availableAt?: string;
  readonly maxAttempts?: number;
}

export type AdmitInboundEventResult =
  | { readonly status: "admitted"; readonly work: DurableInboundEvent }
  | { readonly status: "duplicate"; readonly work: DurableInboundEvent };

export interface ClaimDueWorkInput {
  readonly leaseOwner: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface PeekDueWorkInput {
  readonly now: string;
}

export interface ClaimDueInboundEventInput extends ClaimDueWorkInput {
  readonly inboundEventId: string;
  /** Do not claim new execution if another owner already consumed the prepared outcome. */
  readonly recoveryOnly?: boolean;
}

export interface RenewInboundEventLeaseInput {
  readonly inboundEventId: string;
  readonly leaseOwner: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface CompleteInboundEventInput {
  readonly inboundEventId: string;
  readonly leaseOwner: string;
  readonly workerId: string;
  readonly responseText: string;
  readonly completedAt: string;
}

/** Commits one surface execution outcome and its final delivery intent together. */
export interface SettleSurfaceAttemptInput extends CompleteInboundEventInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly status: "completed" | "cancelled";
  readonly outcome: JsonRecord;
  /** Current settlement time for lease fencing; completedAt is the observed outcome time. */
  readonly now: string;
  /** Prevents further Session dispatch while remote cancellation cleanup is uncertain. */
  readonly sessionBlockReason?: string;
  /** Required continuity record, committed with the outcome when supplied. */
  readonly result?: TaskResult;
}

/** A durable failure decision; retrying persistence does not consume another execution claim. */
export interface SettleSurfaceFailureInput {
  readonly inboundEventId: string;
  readonly leaseOwner: string;
  readonly now: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly claimAttemptCount: number;
  readonly error: string;
  readonly retryable: boolean;
  readonly retryAt: string;
  readonly workerId: string;
  readonly responseText: string;
  readonly failedAt: string;
  readonly sessionBlockReason?: string;
}

export interface RetryInboundEventInput {
  readonly inboundEventId: string;
  readonly leaseOwner: string;
  readonly error: string;
  readonly retryAt: string;
  readonly failedAt: string;
  /** False when replay could duplicate an external effect. */
  readonly retryable?: boolean;
}

export type OutboundReplyStatus = "delivered" | "delivering" | "failed" | "pending";

export type OutboundPresentation = "acknowledgement" | "error" | "final-result" | "status";

export interface OutboundReply {
  readonly id: string;
  readonly inboundEventId: string;
  readonly surfaceAccountId: string;
  readonly workerId: string;
  readonly event: InboundSurfaceEvent;
  readonly callback: CallbackRoute;
  readonly presentation: OutboundPresentation;
  /** Stable idempotency key within one inbound event, such as acknowledgement or final. */
  readonly deliveryKey: string;
  /** Canonical Markdown. The destination surface renders it immediately before delivery. */
  readonly text: string;
  /** Monotonic content revision used to fence coalesced status deliveries. */
  readonly revision: number;
  readonly status: OutboundReplyStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly lastError?: string;
  /** Provider message identifier returned after delivery, such as a Slack message timestamp. */
  readonly externalMessageId?: string;
  readonly deliveredAt?: string;
  readonly failedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompleteOutboundReplyInput {
  readonly outboundReplyId: string;
  readonly leaseOwner: string;
  readonly revision: number;
  readonly deliveredAt: string;
  readonly externalMessageId?: string;
}

export interface EnqueueOutboundReplyInput {
  readonly inboundEventId: string;
  readonly workerId: string;
  readonly presentation: OutboundPresentation;
  readonly deliveryKey: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface RetryOutboundReplyInput {
  readonly outboundReplyId: string;
  readonly leaseOwner: string;
  readonly error: string;
  readonly retryAt: string;
  readonly failedAt: string;
}

export interface DeferOutboundReplyInput {
  readonly outboundReplyId: string;
  readonly leaseOwner: string;
  readonly availableAt: string;
}

export interface SurfaceAccountInput {
  readonly provider: SurfaceProvider;
  readonly externalAccountId: string;
  readonly displayName: string;
  readonly authMethod: string;
  /** Stable logical identifier; the configured credential vault owns its physical location. */
  readonly credentialId: string;
  /** A retired account keeps its history but receives and sends nothing, and holds no credential. */
  readonly status: "connected" | "retired";
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly verifiedAt: string;
  /**
   * The SurfaceAccount manifest name. Absent for accounts set up interactively; saving without a
   * name keeps the current one.
   */
  readonly name?: string;
  /**
   * Where each secret came from when a manifest last applied the account. References only; the
   * values live in the credential vault. Saving without references keeps the current ones.
   */
  readonly secretReferences?: Readonly<Record<string, SurfaceSecretReference>>;
}

/**
 * Where a SurfaceAccount manifest takes one secret from: a named secret its caller resolves,
 * an environment variable, or a file. Never the value itself.
 */
export type SurfaceSecretReference =
  | { readonly secretRef: string }
  | { readonly env: string }
  | { readonly file: string };

export interface SurfaceAccount extends SurfaceAccountInput {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CredentialValue = Readonly<Record<string, string>>;

/**
 * Credential persistence owned by the Control Plane composition root and shared with its Gateway.
 * Gateway surface secrets and Control Plane service keys use disjoint logical namespaces;
 * implementations decide whether values live in a local file or an external secret service.
 */
export interface GatewayCredentialVault {
  /** Atomically preserve an existing value or create and return the supplied value. */
  storeIfAbsent?(credentialId: string, value: CredentialValue): Promise<CredentialValue>;
  store(credentialId: string, value: CredentialValue): Promise<void>;
  resolve(credentialId: string): Promise<CredentialValue | undefined>;
  delete(credentialId: string): Promise<void>;
}

export interface Store
  extends ApprovalRequestStore,
    ArtifactCatalogStore,
    ArtifactPublicationStore,
    AuditStore,
    CoordinationInboxStore,
    CoordinationMetricsStore,
    SpendStore,
    TagMailboxStore,
    WorkstreamStore,
    TeamLiveDeliveryStore,
    ObjectiveStore,
    ObjectiveMailboxStore,
    OperatorNotificationStore,
    ResourceManagementStore,
    RoleStore,
    TeamStore,
    TaskAssignmentStore,
    SessionAudienceStore,
    SessionInputStore,
    SessionStatePersistence,
    WorkerHostStore,
    AuthKeyStore,
    OperatorTokenStore,
    VolumeStore,
    WorkspaceStore {
  readonly provider: DatabaseProvider;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  createTag(input: CreateTagInput): Promise<Tag>;
  findTagById(id: string): Promise<Tag | undefined>;
  /** The active Tag with this name, or with `includeRetired`, the latest retired one. */
  findTagByName(name: string, options?: FindTagByNameOptions): Promise<Tag | undefined>;
  /** Active Tags ordered by name; `includeRetired` adds retired ones. */
  listTags(filter?: TagListFilter): Promise<readonly Tag[]>;
  /**
   * Retires an active Tag in one transaction: removes its routes with their Context and
   * Permission Set activations, Worker Host bindings, Mailbox grants in both directions, Mailbox
   * credentials, and active Role assignments, then marks it retired. History rows keep their
   * reference. Refuses while the Tag has pending or running Tasks. Returns the retired Tag.
   */
  retireTag(id: string): Promise<Tag>;
  /**
   * Deletes a Tag with its routes, bindings, Role assignments, grants, Sessions, and Tasks.
   * Fails when coordination records such as Objectives, Teams, or messages still name it.
   * Operators retire Tags instead; this hard delete remains for tests and data repair.
   */
  deleteTag(id: string): Promise<boolean>;
  bindTagWorkerHost(tagId: string, workerHostId: string): Promise<TagWorkerHostBinding>;
  unbindTagWorkerHost(tagId: string, workerHostId: string): Promise<boolean>;
  listTagWorkerHostBindings(tagId: string): Promise<readonly TagWorkerHostBinding[]>;
  /** Replaces the Tag's placement labels; see {@link Tag.runsOn}. */
  setTagRunsOn(tagId: string, runsOn: readonly string[]): Promise<Tag>;
  /** Replaces the Tag's execution settings; undefined clears them. */
  setTagExecution(tagId: string, execution: ExecutionSettings | undefined): Promise<Tag>;
  addTagRoute(input: AddTagRouteInput): Promise<TagRoute>;
  findTagRouteById(id: string): Promise<TagRoute | undefined>;
  listTagRoutes(filter?: TagRouteListFilter): Promise<readonly TagRoute[]>;
  removeTagRoute(id: string): Promise<boolean>;
  /** Replaces the Workspaces a location attaches to Objectives created from it. */
  setTagRouteWorkspaces(id: string, workspaces: readonly string[]): Promise<TagRoute>;
  /** Tag locations whose `workspaces` name this Workspace, oldest first. */
  listLocationsReferencingWorkspace(name: string): Promise<readonly TagRoute[]>;
  resolveTagRoute(surfaceAccountId: string, scope: string): Promise<TagRoute | undefined>;
  addTagPermission(input: AddTagPermissionInput): Promise<TagPermission>;
  /** Set or clear `approval: required` on one permission. */
  setTagPermissionApproval(
    id: string,
    approval: TagPermissionApproval | undefined,
  ): Promise<TagPermission>;
  createTagPermissionSet(input: CreateTagPermissionSetInput): Promise<TagPermissionSet>;
  /** Replace the approvers of one Permission Set; an empty list clears them. */
  setTagPermissionSetApprovers(id: string, approvers: readonly string[]): Promise<TagPermissionSet>;
  findTagPermissionSetById(id: string): Promise<TagPermissionSet | undefined>;
  findTagPermissionSetByName(name: string): Promise<TagPermissionSet | undefined>;
  listTagPermissionSets(filter?: TagPermissionSetListFilter): Promise<readonly TagPermissionSet[]>;
  removeTagPermissionSet(id: string): Promise<boolean>;
  listTagPermissions(filter?: TagPermissionListFilter): Promise<readonly TagPermission[]>;
  removeTagPermission(id: string): Promise<boolean>;
  activateTagPermissionSet(input: ActivateTagPermissionSetInput): Promise<TagPermissionActivation>;
  listTagPermissionActivations(
    filter?: TagPermissionActivationListFilter,
  ): Promise<readonly TagPermissionActivation[]>;
  deactivateTagPermissionSet(permissionSetId: string, tagRouteId: string): Promise<boolean>;
  createTagContextSet(input: CreateTagContextSetInput): Promise<TagContextSet>;
  findTagContextSetById(id: string): Promise<TagContextSet | undefined>;
  findTagContextSetByName(name: string): Promise<TagContextSet | undefined>;
  listTagContextSets(filter?: TagContextSetListFilter): Promise<readonly TagContextSet[]>;
  removeTagContextSet(id: string): Promise<boolean>;
  addTagContextItem(input: AddTagContextItemInput): Promise<TagContextItem>;
  listTagContextItems(filter?: TagContextItemListFilter): Promise<readonly TagContextItem[]>;
  removeTagContextItem(id: string): Promise<boolean>;
  activateTagContextSet(input: ActivateTagContextSetInput): Promise<TagContextActivation>;
  listTagContextActivations(
    filter?: TagContextActivationListFilter,
  ): Promise<readonly TagContextActivation[]>;
  deactivateTagContextSet(contextSetId: string, tagRouteId: string): Promise<boolean>;
  openSession(input: OpenSessionInput): Promise<Session>;
  findSessionById(id: string): Promise<Session | undefined>;
  findSessionByTagAndKey(tagId: string, sessionKey: string): Promise<Session | undefined>;
  listSessions(filter?: SessionListFilter): Promise<readonly Session[]>;
  openTask(input: OpenTaskInput): Promise<Task>;
  startTask(input: StartTaskInput): Promise<Task>;
  closeTask(input: CloseTaskInput): Promise<Task>;
  listTaskHistory(filter?: TaskHistoryFilter): Promise<readonly TaskHistoryEntry[]>;
  findTaskById(id: string): Promise<Task | undefined>;
  listTasks(filter?: TaskListFilter): Promise<readonly Task[]>;
  createTaskAttempt(input: CreateTaskAttemptInput): Promise<TaskAttempt>;
  recordTaskAttemptMcpDigest(
    taskId: string,
    attemptId: string,
    digest: string,
  ): Promise<TaskAttempt>;
  /**
   * Record what the Workspace's `copy` mounts placed in one Attempt's environment. Manifests are
   * write-once per Attempt: the same manifests again are a no-op, different ones are rejected.
   */
  recordTaskAttemptMountManifests(
    taskId: string,
    attemptId: string,
    manifests: readonly MountManifest[],
  ): Promise<TaskAttempt>;
  /** Write-once output evidence for copy mount uploads; replaying identical evidence is safe. */
  recordTaskAttemptMountOutputManifests(
    taskId: string,
    attemptId: string,
    manifests: readonly MountOutputManifest[],
  ): Promise<TaskAttempt>;
  /** Write-once live attachment evidence; identical journal replay is a no-op. */
  recordTaskAttemptLiveMounts(
    taskId: string,
    attemptId: string,
    mounts: readonly LiveMount[],
  ): Promise<TaskAttempt>;
  openSurfaceTaskAttempt(input: OpenSurfaceTaskAttemptInput): Promise<TaskAttempt>;
  cancelPendingSurfaceTask(input: CancelPendingSurfaceTaskInput): Promise<Task | undefined>;
  closeTaskAttempt(input: CloseTaskAttemptInput): Promise<TaskAttempt>;
  recordTaskAttemptWorker(input: RecordTaskAttemptWorkerInput): Promise<TaskAttempt>;
  listTaskAttempts(taskId: string | readonly string[]): Promise<readonly TaskAttempt[]>;
  /** Every Task Attempt still running, oldest first, for capacity diagnosis. */
  listRunningTaskAttempts(): Promise<readonly TaskAttempt[]>;
  /** Replace the last complete scan for a running Task Attempt. */
  recordTaskAttemptChangedPaths(input: {
    readonly attemptId: string;
    readonly paths: readonly string[];
    readonly truncated: boolean;
  }): Promise<void>;
  /** Current reports for running Team Task Attempts, with their Workspace plans. */
  listRunningTaskAttemptChangedPaths(): Promise<
    readonly {
      readonly attemptId: string;
      readonly taskId: string;
      readonly teamId: string;
      readonly tagId: string;
      readonly workspacePlan: TaskWorkspacePlan;
      readonly paths: readonly string[];
      readonly truncated: boolean;
      readonly reportedAt: string;
    }[]
  >;
  /** Atomically insert overlap keys, returning only keys new to this call. */
  recordOverlaps(input: {
    readonly teamId: string;
    readonly firstAttemptId: string;
    readonly secondAttemptId: string;
    readonly paths: readonly string[];
  }): Promise<
    readonly {
      readonly teamId: string;
      readonly lowerAttemptId: string;
      readonly higherAttemptId: string;
      readonly path: string;
    }[]
  >;
  appendTaskEvent(input: AppendTaskEventInput): Promise<TaskEvent>;
  listTaskEvents(taskId: string): Promise<readonly TaskEvent[]>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  findArtifactById(id: string): Promise<Artifact | undefined>;
  listArtifacts(filter?: ArtifactListFilter): Promise<readonly Artifact[]>;
  saveSurfaceAccount(input: SurfaceAccountInput): Promise<SurfaceAccount>;
  /** A connected account by provider identity; retired accounts do not match. */
  findSurfaceAccount(
    provider: SurfaceProvider,
    externalAccountId: string,
  ): Promise<SurfaceAccount | undefined>;
  /** Includes retired accounts, so history can still name them. */
  findSurfaceAccountById(id: string): Promise<SurfaceAccount | undefined>;
  /** A connected account by its SurfaceAccount manifest name. */
  findSurfaceAccountByName(name: string): Promise<SurfaceAccount | undefined>;
  /** Connected accounts only. */
  listSurfaceAccounts(): Promise<readonly SurfaceAccount[]>;
  /**
   * Retires an account: it stays for history, frees its name and references, and stops matching
   * inbound events. Saving the same provider account again reconnects it.
   */
  retireSurfaceAccount(id: string): Promise<SurfaceAccount | undefined>;
  findInboundEventById(id: string): Promise<DurableInboundEvent | undefined>;
  admitInboundEvent(input: AdmitInboundEventInput): Promise<AdmitInboundEventResult>;
  peekNextInboundEvent(input: PeekDueWorkInput): Promise<DurableInboundEvent | undefined>;
  /** Claims execution work or prepared settlement recovery; only execution claims increment attemptCount. */
  claimDueInboundEvent(input: ClaimDueInboundEventInput): Promise<DurableInboundEvent | undefined>;
  renewInboundEventLease(input: RenewInboundEventLeaseInput): Promise<boolean>;
  claimNextInboundEvent(input: ClaimDueWorkInput): Promise<DurableInboundEvent | undefined>;
  completeInboundEvent(input: CompleteInboundEventInput): Promise<OutboundReply>;
  settleSurfaceAttempt(input: SettleSurfaceAttemptInput): Promise<OutboundReply>;
  /** Persists an immutable surface outcome intent while the Attempt still owns the lease. */
  prepareSurfaceAttempt(input: SettleSurfaceAttemptInput): Promise<void>;
  enqueueOutboundReply(input: EnqueueOutboundReplyInput): Promise<OutboundReply>;
  prepareSurfaceFailure(input: SettleSurfaceFailureInput): Promise<void>;
  settleSurfaceFailure(input: SettleSurfaceFailureInput): Promise<"pending" | "failed">;
  retryInboundEvent(input: RetryInboundEventInput): Promise<"failed" | "pending">;
  claimNextOutboundReply(input: ClaimDueWorkInput): Promise<OutboundReply | undefined>;
  findOutboundReply(
    inboundEventId: string,
    deliveryKey: string,
  ): Promise<OutboundReply | undefined>;
  completeOutboundReply(input: CompleteOutboundReplyInput): Promise<boolean>;
  deferOutboundReply(input: DeferOutboundReplyInput): Promise<void>;
  retryOutboundReply(input: RetryOutboundReplyInput): Promise<"failed" | "pending">;
}

export const CORE_VERSION = "0.0.0";
export { OBJECTIVE_STATEMENT_TEMPLATE } from "./objective-statement.js";
