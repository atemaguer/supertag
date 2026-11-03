/** Beta domain contracts for SuperTag resources, identity, context, and work. */

/** A reusable organizational responsibility that can be assigned to Tags. */
export interface Role {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly instructions: string;
  readonly contextSetIds: readonly string[];
  readonly permissionSetIds: readonly string[];
  readonly status: RoleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RoleStatus = "active" | "retired";

export interface CreateRoleInput {
  readonly name: string;
  readonly purpose: string;
  readonly instructions?: string;
  readonly contextSetIds?: readonly string[];
  readonly permissionSetIds?: readonly string[];
}

export interface UpdateRoleInput {
  readonly purpose?: string;
  readonly instructions?: string;
  readonly contextSetIds?: readonly string[];
  readonly permissionSetIds?: readonly string[];
  readonly status?: RoleStatus;
}

export type {
  ActivateTagContextSetInput,
  ActivateTagPermissionSetInput,
  AddTagContextItemInput,
  AddTagPermissionInput,
  AppendTaskEventInput,
  Artifact,
  ArtifactSelection,
  CallbackRoute,
  CloseTaskAttemptInput,
  CloseTaskInput,
  ContextTypeRef,
  CreateArtifactInput,
  CreateTagContextSetInput,
  CreateTagInput,
  CreateTagPermissionSetInput,
  CreateTaskAttemptInput,
  CredentialValue,
  InboundEventActor,
  InboundEventKind,
  InboundSurfaceEvent,
  JsonRecord,
  OpenSessionInput,
  OpenTaskInput,
  OutboundPresentation,
  Session,
  StartTaskInput,
  SurfaceAccount,
  SurfaceAccountInput,
  SurfaceProvider,
  Tag,
  TagArtifactContextConfig,
  TagArtifactContextSnapshot,
  TagArtifactSelectionPolicy,
  TagAuthorizationResource,
  TagAuthorizationSnapshot,
  TagAuthorizationSource,
  TagContextActivation,
  TagContextItem,
  TagContextPlan,
  TagContextPlanItem,
  TagContextPlanSet,
  TagContextSet,
  TagId,
  TagPermission,
  TagPermissionActivation,
  TagPermissionSet,
  TagSkillContextConfig,
  Task,
  TaskAttempt,
  TaskAttemptStatus,
  TaskEvent,
  TaskHistoryEntry,
  TaskHistoryFilter,
  TaskReference,
  TaskReferenceRelationship,
  TaskResult,
  TaskStatus,
  TaskWorkspacePlan,
  TaskWorkspaceTarget,
  WorkerProfileRef,
} from "../../core/src/index.js";
export {
  ARTIFACT_CONTEXT_TYPE,
  emptyTagContextPlan,
  SKILL_CONTEXT_TYPE,
  tagIdSchema,
} from "../../core/src/index.js";
