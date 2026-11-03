import type { CoordinationInboxKind } from "./coordination-inbox.js";
import type { TaskAssignmentStatus, TeamTaskPriority } from "./task-assignment.js";

export interface CoordinationMetricSnapshot {
  readonly capturedAt: string;
  readonly tags: number;
  readonly roles: number;
  readonly roleAssignments: number;
  readonly surfaceAccounts: number;
  readonly permissionSets: number;
  readonly contextSets: number;
  readonly sessions: number;
  readonly tasks: Readonly<
    Record<"total" | "pending" | "running" | "completed" | "failed" | "cancelled", number>
  >;
  readonly taskAssignments: Readonly<Record<"total" | TaskAssignmentStatus, number>>;
  readonly recovery: {
    readonly unknownControlDeliveries: number;
    readonly blockedSessions: number;
    readonly durableExecutionsAwaitingReconciliation: number;
  };
  readonly coordinationInbox: {
    readonly pending: number;
    readonly byKind: Readonly<Record<CoordinationInboxKind, number>>;
    readonly oldestActionableAt: string | null;
    readonly oldestActionableAgeSeconds: number | null;
  };
  readonly usage: {
    /** Attempts with at least one cumulative provider usage observation. */
    readonly reportingAttempts: number;
    readonly totalTokens: number;
    readonly incompleteAttempts: number;
    readonly reportedCostByCurrency: Readonly<Record<string, number>>;
  };
  readonly nativeAgents: {
    readonly peakConcurrent: number;
    readonly tokenLimitInterruptions: number;
    readonly agentLimitInterruptions: number;
  };
  readonly scheduling: {
    readonly queued: number;
    readonly oldestQueuedAt: string | null;
    readonly oldestQueuedAgeSeconds: number | null;
    readonly placedAttempts: number;
    readonly averageQueueDurationMs: number;
    readonly maximumQueueDurationMs: number;
    readonly averagePlacementDurationMs: number;
    readonly maximumPlacementDurationMs: number;
    readonly admissionRejections: number;
    /** Queue pressure and observed wait time for each accepted scheduling priority. */
    readonly byPriority: Readonly<
      Record<
        TeamTaskPriority,
        {
          readonly queued: number;
          readonly oldestQueuedAt: string | null;
          readonly oldestQueuedAgeSeconds: number | null;
          readonly placedAttempts: number;
          readonly averageQueueDurationMs: number;
          readonly maximumQueueDurationMs: number;
        }
      >
    >;
    readonly reservations: {
      readonly consumed: number;
      readonly active: number;
      readonly expired: number;
    };
    readonly workerHosts: readonly {
      readonly id: string;
      readonly phase: "connected" | "draining" | "unreachable";
      readonly activeAttempts: number;
      readonly capacity: number;
      readonly availableSlots: number;
      readonly utilization: number;
    }[];
  };
  readonly mailbox: {
    readonly backlog: number;
    readonly retrying: number;
    readonly retryAttempts: number;
    readonly failed: number;
    readonly oldestPendingAt: string | null;
  };
  readonly replyDelivery: {
    readonly backlog: number;
    readonly retrying: number;
    readonly retryAttempts: number;
    readonly failed: number;
    readonly oldestPendingAt: string | null;
  };
}

export interface CoordinationMetricsStore {
  readCoordinationMetrics(input?: { readonly asOf?: string }): Promise<CoordinationMetricSnapshot>;
}
