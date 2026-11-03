/**
 * Durable operator channel notifications: summaries of new inbox items sent to a configured
 * destination that is not a reply to an inbound event.
 */
export type OperatorNotificationStatus = "pending" | "delivering" | "delivered" | "failed";

export interface OperatorNotification {
  readonly id: string;
  /** Canonical destination key, such as `slack:T0123/C0456`. */
  readonly destination: string;
  readonly objectiveId: string;
  /** Inbox item occurrences this message covers. */
  readonly itemKeys: readonly string[];
  readonly text: string;
  /** Sent without waiting for the batching window because running work waits on it. */
  readonly immediate: boolean;
  readonly status: OperatorNotificationStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastError: string | null;
  readonly externalMessageId: string | null;
  readonly deliveredAt: string | null;
  readonly failedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecordOperatorNotificationInput {
  readonly destination: string;
  readonly objectiveId: string;
  readonly itemKeys: readonly string[];
  readonly text: string;
  readonly immediate: boolean;
  readonly createdAt: string;
  readonly maxAttempts: number;
  /**
   * Refuse when this destination already has a message for the Objective created after this
   * instant. Omit to bypass the window.
   */
  readonly windowStartedAt?: string;
}

export interface CompleteOperatorNotificationInput {
  readonly id: string;
  readonly leaseOwner: string;
  readonly deliveredAt: string;
  readonly externalMessageId?: string;
}

export interface RetryOperatorNotificationInput {
  readonly id: string;
  readonly leaseOwner: string;
  readonly error: string;
  readonly retryAt: string;
  readonly failedAt: string;
}

export interface OperatorNotificationStore {
  /** Delivery records for the requested inbox occurrences, across configured destinations. */
  listOperatorNotificationsForItems(
    itemKeys: readonly string[],
  ): Promise<ReadonlyMap<string, readonly OperatorNotification[]>>;
  /** The subset of item occurrences already recorded for a destination. */
  listNotifiedInboxItems(destination: string, itemKeys: readonly string[]): Promise<Set<string>>;
  /** The newest message for one destination and Objective. */
  latestOperatorNotification(
    destination: string,
    objectiveId: string,
  ): Promise<OperatorNotification | undefined>;
  /**
   * Atomically record a message and claim its item occurrences. Returns undefined, recording
   * nothing, when any occurrence was already claimed or the window refuses it.
   */
  recordOperatorNotification(
    input: RecordOperatorNotificationInput,
  ): Promise<OperatorNotification | undefined>;
  claimNextOperatorNotification(input: {
    readonly leaseOwner: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<OperatorNotification | undefined>;
  completeOperatorNotification(input: CompleteOperatorNotificationInput): Promise<boolean>;
  retryOperatorNotification(input: RetryOperatorNotificationInput): Promise<"failed" | "pending">;
  getOperatorNotification(id: string): Promise<OperatorNotification | undefined>;
}
