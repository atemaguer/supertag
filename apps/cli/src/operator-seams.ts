import type { DescMethod } from "@bufbuild/protobuf";
import type {
  CoordinationOperatorPrincipal,
  ObjectiveController,
  TaskExecutionLimitReport,
  TaskExecutionPlacementReport,
} from "@supertag/control-plane";
import type {
  AuthKey,
  ConnectedSurfaceProvider,
  CreateObjectiveInput,
  CreateTeamInput,
  Objective,
  OperatorToken,
  ResolvedArtifactTransfer,
  Store,
  SurfaceAccount,
  TagMessagingGrant,
  Task,
  Team,
  UpdateObjectiveStatusInput,
  UpdateTeamInput,
  WorkerHost,
} from "@supertag/core";
import type { VerifiedSurfaceAccount } from "@supertag/surface-sdk";

/**
 * What an operator RPC does to the Organization's state. `read` changes nothing. `data_write`
 * only adds records: messages, posts, progress events, artifacts. `control` changes the state of
 * Objectives, Tasks, assignments, budgets, approvals, hosts, credentials or resources, and so
 * goes through `OperatorControl`, which only the Control Plane implements.
 */
export type OperatorRpcClass = "read" | "data_write" | "control";

/**
 * The class of every operator RPC, by `PACKAGE.SERVICE/METHOD`. A message to a Tag or an
 * Objective is `control`: it admits the next turn as a Task.
 */
export const OPERATOR_RPC_CLASSES: Readonly<Record<string, OperatorRpcClass>> = {
  "supertag.operator.v1.ConversationService/SendMessage": "control",
  "supertag.operator.v1.ConversationService/GetMessage": "read",
  "supertag.operator.v1.ConversationService/FollowMessage": "read",
  "supertag.operator.v1.ConversationService/ListConversations": "read",
  "supertag.operator.v1.ConversationService/ListMessages": "read",
  "supertag.operator.v1.EventService/Watch": "read",
  "supertag.operator.v1.InboxService/ListInboxItems": "read",
  "supertag.operator.v1.InboxService/ListApprovals": "read",
  "supertag.operator.v1.InboxService/Approve": "control",
  "supertag.operator.v1.InboxService/Deny": "control",
  "supertag.operator.v1.InboxService/AnswerQuestion": "control",
  "supertag.operator.v1.ObjectiveService/CreateObjective": "control",
  "supertag.operator.v1.ObjectiveService/ListObjectives": "read",
  "supertag.operator.v1.ObjectiveService/GetObjective": "read",
  "supertag.operator.v1.ObjectiveService/DescribeObjective": "read",
  "supertag.operator.v1.ObjectiveService/MessageObjective": "control",
  "supertag.operator.v1.ObjectiveService/UpdateObjective": "control",
  "supertag.operator.v1.ObjectiveService/ApproveObjective": "control",
  "supertag.operator.v1.ObjectiveService/CancelObjective": "control",
  "supertag.operator.v1.ObjectiveService/PauseObjective": "control",
  "supertag.operator.v1.ObjectiveService/ResumeObjective": "control",
  "supertag.operator.v1.OrganizationService/GetStatus": "read",
  "supertag.operator.v1.OrganizationService/GetOrganization": "read",
  "supertag.operator.v1.OrganizationService/GetSpend": "read",
  "supertag.operator.v1.OrganizationService/ListAuditEntries": "read",
  "supertag.operator.v1.OrganizationService/GetMetrics": "read",
  "supertag.operator.v1.HostService/ListWorkerHosts": "read",
  "supertag.operator.v1.HostService/GetWorkerHost": "read",
  "supertag.operator.v1.HostService/EnrollWorkerHost": "control",
  "supertag.operator.v1.HostService/RotateWorkerHostCredential": "control",
  "supertag.operator.v1.HostService/RevokeWorkerHostCredential": "control",
  "supertag.operator.v1.HostService/DrainWorkerHost": "control",
  "supertag.operator.v1.HostService/ResumeWorkerHost": "control",
  "supertag.operator.v1.HostService/BindWorkerHost": "control",
  "supertag.operator.v1.HostService/UnbindWorkerHost": "control",
  "supertag.operator.v1.HostService/CreateAuthKey": "control",
  "supertag.operator.v1.HostService/ListAuthKeys": "read",
  "supertag.operator.v1.HostService/GetAuthKey": "read",
  "supertag.operator.v1.HostService/RevokeAuthKey": "control",
  "supertag.operator.v1.AccessService/CreateOperatorToken": "control",
  "supertag.operator.v1.AccessService/ListOperatorTokens": "read",
  "supertag.operator.v1.AccessService/GetOperatorToken": "read",
  "supertag.operator.v1.AccessService/RevokeOperatorToken": "control",
  "supertag.operator.v1.SurfaceService/SetUpSurface": "control",
  "supertag.operator.v1.SurfaceService/ListSurfaceAccounts": "read",
  "supertag.operator.v1.SurfaceService/GetSurfaceAccount": "read",
  "supertag.operator.v1.SurfaceService/AddTagLocation": "control",
  "supertag.operator.v1.SurfaceService/RemoveTagLocation": "control",
  "supertag.operator.v1.SurfaceService/ActivateSet": "control",
  "supertag.operator.v1.SurfaceService/DeactivateSet": "control",
  "supertag.operator.v1.WorkService/ListTasks": "read",
  "supertag.operator.v1.WorkService/GetTask": "read",
  "supertag.operator.v1.WorkService/ListTaskEvents": "read",
  "supertag.operator.v1.WorkService/InspectTaskExecution": "data_write",
  "supertag.operator.v1.WorkService/CancelTask": "control",
  "supertag.operator.v1.WorkService/ListSessions": "read",
  "supertag.operator.v1.WorkService/GetSession": "read",
  "supertag.operator.v1.WorkService/ListSessionStates": "read",
  "supertag.operator.v1.WorkService/GetSessionState": "read",
  "supertag.operator.v1.WorkService/ListArtifacts": "read",
  "supertag.operator.v1.WorkService/GetArtifact": "read",
  "supertag.operator.v1.WorkService/ResolveArtifactDownload": "control",
  "supertag.operator.v1.TeamService/CreateTeam": "control",
  "supertag.operator.v1.TeamService/ListTeams": "read",
  "supertag.operator.v1.TeamService/GetTeam": "read",
  "supertag.operator.v1.TeamService/UpdateTeam": "control",
  "supertag.operator.v1.TeamService/DeleteTeam": "control",
  "supertag.operator.v1.MailboxService/ListTagMessages": "read",
  "supertag.operator.v1.MailboxService/GrantMailbox": "control",
  "supertag.operator.v1.MailboxService/RevokeMailbox": "control",
  "supertag.operator.v1.MailboxService/ListMailboxGrants": "read",
  "supertag.operator.v1.MailboxService/ListWorkstreamPosts": "read",
};

/** An RPC's class; undefined when `OPERATOR_RPC_CLASSES` does not name it. */
export function operatorRpcClass(method: DescMethod): OperatorRpcClass | undefined {
  return OPERATOR_RPC_CLASSES[`${method.parent.typeName}/${method.name}`];
}

/** The store reads operator RPC handlers make. None of them changes state. */
export const OPERATOR_READ_STORE_METHODS = [
  "findAuthKeyByName",
  "findCapturedArtifact",
  "findInboundEventById",
  "findOperatorTokenByName",
  "findOutboundReply",
  "findSessionById",
  "findSessionByTagAndKey",
  "findSessionState",
  "findSurfaceAccount",
  "findSurfaceAccountByName",
  "findTagById",
  "findTagByName",
  "findTaskById",
  "findWorkSessionReport",
  "findWorkerHostById",
  "getObjective",
  "getTeam",
  "hasArtifactUpload",
  "listApprovalRequests",
  "listArtifactStorageLocations",
  "listArtifactVolumeLocations",
  "listAuditEntries",
  "listAuthKeys",
  "listCapturedArtifacts",
  "listObjectiveSessions",
  "listObjectives",
  "listOpenObjectives",
  "listOperatorTokens",
  "listRunningTaskAttempts",
  "listSessionStates",
  "listSessionTaskIds",
  "listSessions",
  "listSurfaceAccounts",
  "listTagMessageHistory",
  "listTagMessagingGrants",
  "listTagWorkerHostBindings",
  "listTags",
  "listTaskAttempts",
  "listTaskEvents",
  "listTasks",
  "listTeamPosts",
  "listTeams",
  "listTeamsOfTag",
  "listVolumes",
  "listWorkSessions",
  "listWorkerHosts",
  "readCoordinationMetrics",
  "readSpend",
  "sessionTaskSummaries",
] as const satisfies readonly (keyof Store)[];

/** What `read` handlers, and the reads of other handlers, query the store with. */
export type OperatorReadStore = Pick<Store, (typeof OPERATOR_READ_STORE_METHODS)[number]>;

/** How a Task's latest Task Attempt ran, and its Worker Host's execution receipt when read. */
export interface TaskExecutionInspection {
  readonly availability: "not_started" | "unsupported" | "unavailable" | "available";
  readonly attemptId?: string;
  readonly receipt?: object;
  readonly limits: TaskExecutionLimitReport;
  readonly placement: TaskExecutionPlacementReport;
}

/**
 * Data writes an operator RPC makes besides the state transitions of `OperatorControl`: they only
 * add records, such as progress events, and are safe to repeat. The Worker Host connections they
 * use live in the Control Plane, so a Gateway replica forwards them to it.
 */
export interface OperatorDataWrites {
  /**
   * Asks the Worker Host that ran the Task's latest durable Task Attempt for its execution
   * receipt, first recording the Worker events the receipt names and the store lacks. Recording
   * an event already recorded adds nothing.
   */
  readonly inspectTaskExecution: (taskId: string) => Promise<TaskExecutionInspection>;
}

/** The Control Plane's state as GetStatus reports it. */
export interface ControlPlaneStatus {
  readonly accepting: boolean;
  readonly startedAt: string;
  readonly controllers: readonly { readonly name: string; readonly phase: string }[];
}

/**
 * Reads that apply the Control Plane's authorization and projections over the store. None of them
 * changes the state of anything. Besides the store they read the Control Plane's own
 * configuration (notification delivery, the embedded Worklet) and controllers, so a Gateway
 * replica forwards them to the Control Plane rather than computing them itself.
 */
export interface OperatorQueries {
  readonly readCoordinationInbox: ObjectiveController["readCoordinationInbox"];
  readonly listApprovalRequests: ObjectiveController["listApprovalRequests"];
  readonly readObjectiveOverview: ObjectiveController["readObjectiveOverview"];
  readonly objectiveRunnable: ObjectiveController["objectiveRunnable"];
  readonly controlPlaneStatus: () => Promise<ControlPlaneStatus>;
  /**
   * Every Worker Host: the stored ones, or the embedded Worklet's own host when the Control Plane
   * runs one that is not scheduled through the store.
   */
  readonly listWorkerHosts: () => Promise<readonly WorkerHost[]>;
}

/**
 * A place on a collaboration surface, as `SurfaceService` names it. Set the fields the provider
 * needs; `account` selects the Surface Account by ID, external account ID or manifest name.
 */
export interface OperatorSurfaceLocation {
  readonly provider: ConnectedSurfaceProvider;
  readonly account?: string;
  readonly channelId?: string;
  readonly chatId?: string;
  readonly teamId?: string;
  readonly team?: string;
  readonly repoId?: string;
  readonly repo?: string;
}

/** A location resolved on its Surface Account. */
export interface ResolvedSurfaceLocation {
  readonly tag: { readonly id: string; readonly name: string };
  readonly provider: ConnectedSurfaceProvider;
  /** The location for people, such as a Slack channel ID or `chat oc_123`. */
  readonly location: string;
  readonly surfaceAccountId: string;
  readonly accountDisplayName: string;
}

/**
 * Every state transition an operator RPC makes. Each method takes and returns plain data and is
 * safe to retry: a repeat with the same idempotency key, Objective ID, revision or decision
 * changes nothing more and returns what the first call did, except where a method says it
 * refuses the repeat instead. Methods that act for an operator take its principal and authorize
 * it again.
 */
export interface OperatorControl {
  /** Whether the Control Plane admits new work; false while it drains. */
  readonly accepting: () => Promise<boolean>;
  /**
   * Admits an operator's message to a Tag as a turn. A repeated idempotency key admits nothing;
   * the RPC handler generates one when the caller sent none.
   */
  readonly messageTag: (input: {
    readonly tagName: string;
    readonly operatorId: string;
    readonly session: string;
    readonly text: string;
    readonly idempotencyKey: string;
  }) => Promise<{ readonly taskId?: string; readonly reason?: string }>;
  /**
   * Creates an Objective, or returns the one with its ID. Runtime actions resolve against the
   * owner's Permission Sets once and are frozen into the record; `warnings` names actions the
   * owner may not grant.
   */
  readonly createObjective: (input: {
    readonly objective: CreateObjectiveInput;
    readonly ownerTagId: string;
    readonly requestedRuntimeActions?: readonly string[];
    readonly dryRun: boolean;
  }) => Promise<{ readonly objective: Objective; readonly warnings: readonly string[] }>;
  /** Starts an Objective's conversation; once started, returns the same first Task. */
  readonly startObjective: (objectiveId: string) => Promise<{ readonly taskId: string }>;
  /** An operator's status update, fenced by the expected revision; a repeat is refused as stale. */
  readonly updateObjective: (input: {
    readonly objectiveId: string;
    readonly update: UpdateObjectiveStatusInput;
    readonly operatorId: string;
  }) => Promise<{ readonly objective: Objective; readonly warnings: readonly string[] }>;
  /**
   * Admits an operator's message to an Objective's conversation. A repeated idempotency key with
   * the same text admits nothing; the RPC handler generates one when the caller sent none.
   */
  readonly messageObjective: (
    input: {
      readonly objectiveId: string;
      readonly text: string;
      readonly idempotencyKey: string;
    },
    principal: CoordinationOperatorPrincipal,
  ) => ReturnType<ObjectiveController["messageObjective"]>;
  /** Decides an approval request; the same decision again by the same operator returns it. */
  readonly decideApproval: (
    input: {
      readonly requestId: string;
      readonly decision: "approve" | "deny";
      readonly reason?: string;
      readonly scope?: string;
      readonly validUntil?: string;
    },
    principal: CoordinationOperatorPrincipal,
  ) => ReturnType<ObjectiveController["decideApprovalRequest"]>;
  /** Completes a ready_for_review Objective; a repeat is refused, as it is already completed. */
  readonly approveObjective: ObjectiveController["approveObjective"];
  readonly cancelObjective: ObjectiveController["cancelObjective"];
  readonly pauseObjective: ObjectiveController["pauseObjective"];
  readonly resumeObjective: ObjectiveController["resumeObjective"];
  /**
   * Cancels a pending Task, or asks a running Task's Worker to stop. A repeat while the Worker
   * stops asks it again, and a finished Task is returned unchanged with `accepted` false.
   */
  readonly cancelTask: (
    taskId: string,
    principal: CoordinationOperatorPrincipal,
  ) => Promise<{ readonly accepted: boolean; readonly task: Task }>;
  /**
   * Issues short-lived grants for one artifact file to the operator, and says where its copies
   * are. It changes no state, and each call issues new grants. The grants are signed with the
   * Control Plane's artifact transfer key, so only the Control Plane issues them.
   */
  readonly resolveArtifactDownload: (input: {
    readonly artifactId: string;
    readonly path: string;
    readonly operatorId: string;
    /** The caller's address as the API listener's socket reports it, never a header. */
    readonly operatorAddress: string | undefined;
  }) => Promise<ResolvedArtifactTransfer>;
  /** Creates a Team; the same ID and definition again returns the existing Team. */
  readonly createTeam: (input: CreateTeamInput) => Promise<Team>;
  /**
   * Changes a Team, fenced by its expected revision. A repeat returns the Team unchanged when it
   * already has every value the input sets.
   */
  readonly updateTeam: (id: string, input: UpdateTeamInput) => Promise<Team>;
  /** Deletes a Team and its Workstream posts; false when no such Team exists. */
  readonly deleteTeam: (id: string) => Promise<boolean>;
  /** Lets the recipient accept the sender's messages; `changed` is false when it already did. */
  readonly grantMailbox: (
    grant: TagMessagingGrant,
  ) => Promise<{ readonly grant: TagMessagingGrant; readonly changed: boolean }>;
  /** Removes that grant; `changed` is false when there was none. */
  readonly revokeMailbox: (
    grant: TagMessagingGrant,
  ) => Promise<{ readonly grant: TagMessagingGrant; readonly changed: boolean }>;
  /** Enrolls a Worker Host under a new ID; an ID already enrolled is refused as `AlreadyExists`. */
  readonly enrollWorkerHost: (
    id: string,
  ) => Promise<{ readonly workerHost: WorkerHost; readonly token: string }>;
  /**
   * Replaces a Worker Host's credential while its revision is still the expected one, so a
   * repeat of a rotation that applied is refused as stale and changes nothing.
   */
  readonly rotateWorkerHostCredential: (input: {
    readonly id: string;
    readonly expectedCredentialRevision: number;
  }) => Promise<{ readonly workerHost: WorkerHost; readonly token: string }>;
  /** Revokes a Worker Host; revoking a revoked host returns it unchanged. */
  readonly revokeWorkerHostCredential: (id: string) => Promise<WorkerHost>;
  /** Drains or resumes a Worker Host; setting what it already has changes nothing. */
  readonly setWorkerHostDraining: (input: {
    readonly id: string;
    readonly draining: boolean;
  }) => Promise<WorkerHost>;
  /** Binds or unbinds a Worker Host and a Tag; `changed` is false when it already was so. */
  readonly setTagWorkerHost: (input: {
    readonly tagId: string;
    readonly workerHostId: string;
    readonly bound: boolean;
  }) => Promise<{ readonly workerHostIds: readonly string[]; readonly changed: boolean }>;
  /** Creates an Auth Key; a name already used is refused as `AlreadyExists`. */
  readonly createAuthKey: (input: {
    readonly name: string;
    readonly tags: readonly string[];
    readonly labels: readonly string[];
    readonly reusable: boolean;
    readonly ephemeral: boolean;
  }) => Promise<{ readonly authKey: AuthKey; readonly secret: string }>;
  /** Revokes an Auth Key; revoking a revoked key returns it. Undefined when there is none. */
  readonly revokeAuthKey: (name: string) => Promise<AuthKey | undefined>;
  /** Creates an Operator Token; a name already used is refused as `AlreadyExists`. */
  readonly createOperatorToken: (
    name: string,
  ) => Promise<{ readonly operatorToken: OperatorToken; readonly secret: string }>;
  /** Revokes an Operator Token; revoking a revoked token returns it. Undefined when there is none. */
  readonly revokeOperatorToken: (name: string) => Promise<OperatorToken | undefined>;
  /**
   * Saves a verified Surface Account and its credentials, updating the account with the same
   * provider and external account ID in place.
   */
  readonly setUpSurface: (verified: VerifiedSurfaceAccount) => Promise<SurfaceAccount>;
  /**
   * Adds or removes a Tag's location; `changed` is false when the Tag already had it, or did not.
   * Removing a location also deactivates every set activated there.
   */
  readonly setTagLocation: (input: {
    readonly tag: string;
    readonly location: OperatorSurfaceLocation;
    readonly present: boolean;
  }) => Promise<ResolvedSurfaceLocation & { readonly changed: boolean }>;
  /** Activates or deactivates a Context Set or Permission Set in one of a Tag's locations. */
  readonly setSetActivation: (input: {
    readonly kind: "context-set" | "permission-set";
    readonly set: string;
    readonly tag: string;
    readonly location: OperatorSurfaceLocation;
    readonly active: boolean;
  }) => Promise<ResolvedSurfaceLocation & { readonly set: string }>;
}
