import type {
  ApprovalRequest,
  DurableInboundEvent,
  ObjectiveStatus,
  TagMessageInput,
  Task,
} from "@supertag/core";
import type { ContinueSessionRequest, StartSessionRequest } from "./work-sessions.js";

/** `start_session` input; `tag` delegates the work Session to another Tag. */
export type DelegatedStartRequest = StartSessionRequest & { readonly tag?: string };

/** What `start_session` and `continue_session` return to the calling turn. */
export interface StartSessionResult {
  readonly sessionId: string;
  readonly title: string;
  readonly status: "started" | "queued";
}

export interface MessageObjectiveInput {
  readonly objectiveId: string;
  readonly text: string;
  readonly operatorId: string;
  readonly idempotencyKey: string;
}

export interface MessageObjectiveResult {
  readonly duplicate: boolean;
  readonly taskId: string;
  /** The status the message moved the Objective out of, back to working, when it moved it. */
  readonly statusChange?: ObjectiveStatus;
}

export interface SendMessageInput extends TagMessageInput {
  readonly workstreamPostId?: string;
}

export interface SendMessageResult {
  readonly messageId: string;
  readonly session: string;
  readonly status: "queued" | "batched" | "recorded";
}

/** What the Control Plane does for Session tools and Objective entry points; installed by it. */
export interface SessionHandlers {
  /** `start_session`: opens a work Session, on this Tag or a delegated one, and admits its Task. */
  start(
    task: Task,
    inbound: DurableInboundEvent,
    request: DelegatedStartRequest,
  ): Promise<StartSessionResult>;
  /** `continue_session`: admits the next Task of one of the conversation's work Sessions. */
  continue(
    task: Task,
    inbound: DurableInboundEvent,
    request: ContinueSessionRequest,
  ): Promise<StartSessionResult>;
  /** Posts a Task's pending approval request to its conversation, once. */
  approvalNotice(task: Task, inbound: DurableInboundEvent, requestId: string): Promise<void>;
  /** An action request was decided: continue the Session whose Task ended waiting on it. */
  approvalDecided(request: ApprovalRequest): Promise<void>;
  /** Admits the first turn of the Objective's conversation. */
  startObjective(objectiveId: string): Promise<{ readonly taskId: string }>;
  /** Delivers an operator message to the Objective's conversation. */
  messageObjective(input: MessageObjectiveInput): Promise<MessageObjectiveResult>;
  /**
   * `send_message`: delivers a message to another Tag's inbox. With `workstreamPostId` it carries
   * an addressed Workstream post to one of the Tags it names.
   */
  sendMessage(task: Task, input: SendMessageInput): Promise<SendMessageResult>;
  /**
   * Admits SuperTag's text as a turn of the Objective's conversation, once per key
   * (`objectiveNoticeDeliveryId`). A limit warning is an `objective_notice`; an account of what
   * changed, such as the resume summary, is an `objective_message` from SuperTag.
   */
  deliverObjectiveNotice(
    objectiveId: string,
    key: string,
    text: string,
    reason?: "objective_notice" | "objective_message",
  ): Promise<void>;
  /** Posts SuperTag's notice, such as the completion summary, to the home thread once per key. */
  postObjectiveNotice(objectiveId: string, key: string, text: string): Promise<void>;
  /**
   * Cancels every open Task of the Objective's Sessions, except `exceptTaskId` (the Task that
   * completed it), and fails their pending turns; returns the cancelled Task ids.
   */
  cancelObjectiveTasks(
    objectiveId: string,
    reason: string,
    exceptTaskId?: string,
  ): Promise<readonly string[]>;
}
