import type { TagMessage } from "./mailbox.js";
import type { Objective, ObjectiveStatus } from "./objective.js";

/** A message addressed to an Objective's operator, independent of external surfaces. */
export interface ObjectiveMailboxMessage {
  readonly id: string;
  readonly objectiveId: string;
  readonly senderTagId: string;
  readonly sourceTaskId: string;
  readonly type: "message" | "progress.updated";
  readonly needsReply: boolean;
  readonly body: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  /** `resolved`: a question withdrawn by its owner or closed on cancellation. */
  readonly status: "pending" | "replied" | "reported" | "resolved";
  readonly replyMessageId: string | null;
  readonly repliedByOperatorId: string | null;
  readonly resolvedAt: string | null;
  /** Reason a question left the inbox unanswered. */
  readonly resolutionReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ObjectiveMailboxStore {
  enqueueObjectiveMessage(
    input: Pick<
      ObjectiveMailboxMessage,
      "objectiveId" | "senderTagId" | "sourceTaskId" | "type" | "body" | "idempotencyKey"
    > & {
      readonly needsReply?: boolean;
      readonly sourceAttemptCount?: number;
      readonly inReplyTo?: string;
    },
  ): Promise<{ readonly message: ObjectiveMailboxMessage; readonly duplicate: boolean }>;
  getObjectiveMessage(id: string): Promise<ObjectiveMailboxMessage | undefined>;
  listObjectiveMessages(input: {
    readonly objectiveId?: string;
    readonly pendingOnly?: boolean;
    /** Select owner reports only. */
    readonly reportOnly?: boolean;
    readonly after?: { readonly createdAt: string; readonly id: string };
    readonly limit?: number;
    /** List newest first; `after` then continues to older messages. Default oldest first. */
    readonly newestFirst?: boolean;
  }): Promise<readonly ObjectiveMailboxMessage[]>;
  /** Trusted operator path. Atomically records one reply, including after owner withdrawal. */
  replyToObjectiveMessage(input: {
    readonly messageId: string;
    readonly objectiveId: string;
    readonly recipientTagId: string;
    readonly body: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly operatorId: string;
  }): Promise<{ readonly message: TagMessage; readonly duplicate: boolean }>;
  /**
   * Trusted operator path. Delivers one operator-authored message to the Objective owner's
   * Mailbox. It links an answer to a pending or withdrawn question when `inReplyTo` names it, and
   * returns a blocked or ready_for_review Objective to working. A completed Objective is
   * refused unless `reopen` is set. Never changes allocation or budget.
   */
  sendOperatorObjectiveMessage(
    input: OperatorObjectiveMessageInput,
  ): Promise<OperatorObjectiveMessageResult>;
}
export interface OperatorObjectiveMessageInput {
  readonly objectiveId: string;
  readonly message: string;
  readonly idempotencyKey: string;
  readonly operatorId: string;
  /** Explicit pending or withdrawn owner question to answer. */
  readonly inReplyTo?: string;
  /** Required to message a completed Objective; moves it back to working. */
  readonly reopen?: boolean;
}
export interface OperatorObjectiveMessageResult {
  readonly message: TagMessage;
  readonly duplicate: boolean;
  /** The pending operator-inbox message this answered, if any. */
  readonly repliedToMessageId: string | null;
  readonly objective: Objective;
  readonly statusChange: { readonly from: ObjectiveStatus; readonly to: ObjectiveStatus } | null;
}
