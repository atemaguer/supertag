import type { DescMethod } from "@bufbuild/protobuf";
import type { CoordinationOperatorPrincipal, ObjectiveController } from "@supertag/control-plane";
import type {
  CreateObjectiveInput,
  Objective,
  Store,
  UpdateObjectiveStatusInput,
} from "@supertag/core";

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
};

/** An RPC's class; undefined when `OPERATOR_RPC_CLASSES` does not name it. */
export function operatorRpcClass(method: DescMethod): OperatorRpcClass | undefined {
  return OPERATOR_RPC_CLASSES[`${method.parent.typeName}/${method.name}`];
}

/** The store reads operator RPC handlers make. None of them changes state. */
export const OPERATOR_READ_STORE_METHODS = [
  "findInboundEventById",
  "findOutboundReply",
  "findSessionById",
  "findSessionByTagAndKey",
  "findTagById",
  "findTagByName",
  "findTaskById",
  "findWorkSessionReport",
  "getObjective",
  "getTeam",
  "listApprovalRequests",
  "listObjectives",
  "listSessionTaskIds",
  "listSessions",
  "listTaskEvents",
  "listTasks",
  "listTeams",
  "listWorkSessions",
] as const satisfies readonly (keyof Store)[];

/** What `read` handlers, and the reads of other handlers, query the store with. */
export type OperatorReadStore = Pick<Store, (typeof OPERATOR_READ_STORE_METHODS)[number]>;

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
}
