import type { JsonRecord, Task, TaskAttempt, TaskHistoryEntry } from "./index.js";

/** The acknowledgement window starts when the dispatch is durably prepared. */
export const SESSION_INPUT_ACK_TIMEOUT_MS = 10_000;

export interface InboundControlDelivery {
  readonly inboundEventId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly command: JsonRecord;
  readonly workerHostId?: string;
  readonly workerId?: string;
  /**
   * `withdrawn`: the harness confirms its model never read the input before the target
   * Task Attempt's final response. The follower Task then runs on its own.
   */
  readonly status: "pending" | "dispatching" | "accepted" | "rejected" | "unknown" | "withdrawn";
  readonly detail?: JsonRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface PrepareInboundControlDeliveryInput {
  readonly inboundEventId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly command: JsonRecord;
  readonly workerHostId?: string;
  readonly workerId?: string;
}
export interface SessionInputStore {
  findLatestSessionExecutionTask(
    sessionId: string,
    excludeTaskId: string,
  ): Promise<Task | undefined>;
  blockInboundSession(
    inboundEventId: string,
    reason: string,
    fence?: { readonly leaseOwner: string; readonly now: string },
  ): Promise<void>;
  findActiveSessionAttempt(
    inboundEventId: string,
  ): Promise<{ readonly task: Task; readonly attempt: TaskAttempt } | undefined>;
  prepareInboundControlDelivery(
    input: PrepareInboundControlDeliveryInput,
  ): Promise<{ readonly created: boolean; readonly delivery: InboundControlDelivery } | undefined>;
  findInboundControlDelivery(inboundEventId: string): Promise<InboundControlDelivery | undefined>;
  finishInboundControlDelivery(input: {
    readonly inboundEventId: string;
    readonly status: "accepted" | "rejected" | "unknown";
    readonly detail?: JsonRecord;
  }): Promise<InboundControlDelivery>;
  /**
   * Queues one durable recovery notice when a target Task Attempt ends with an unknown
   * delivery, or when a dispatching delivery's acknowledgement window expires.
   * The notice fences late acknowledgements and withdrawal; uncertain input is never
   * replayed automatically.
   */
  enqueueUnresolvedSessionInputReplies(input: {
    readonly text: string;
    readonly now: string;
  }): Promise<void>;
  /**
   * Undoes the delivery of an input the target Task Attempt reports withdrawn. An `accepted`, `unknown`, or
   * still-`dispatching` delivery becomes `withdrawn`; its settled follower inbound event
   * and Task return to `pending`, so the message runs as its own Task. Returns undefined when
   * nothing changed: another Task Attempt, another status, a repeated withdrawal, or a
   * terminal recovery notice already queued for the operator.
   */
  withdrawInboundControlDelivery(input: {
    readonly inboundEventId: string;
    readonly taskId: string;
    readonly attemptId: string;
  }): Promise<
    { readonly delivery: InboundControlDelivery; readonly followerTaskId?: string } | undefined
  >;
  refreshPendingTaskSessionHistory(
    taskId: string,
    sessionHistory: readonly TaskHistoryEntry[],
  ): Promise<Task>;
}
