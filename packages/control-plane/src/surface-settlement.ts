import type {
  SettleSurfaceAttemptInput,
  SettleSurfaceFailureInput,
  Store,
  TaskAttempt,
  TaskResult,
} from "@supertag/core";

const PREPARED = "surface.settlement-prepared";

export type SurfaceOutcome = Omit<
  SettleSurfaceAttemptInput,
  "inboundEventId" | "leaseOwner" | "now"
>;

export type SurfaceFailureOutcome = Omit<
  SettleSurfaceFailureInput,
  "inboundEventId" | "leaseOwner" | "now"
>;
export type PreparedSurfaceOutcome = SurfaceOutcome | SurfaceFailureOutcome;

export function isSurfaceFailure(
  outcome: PreparedSurfaceOutcome,
): outcome is SurfaceFailureOutcome {
  return "claimAttemptCount" in outcome;
}

type SettlementStore = Pick<
  Store,
  | "listTaskAttempts"
  | "listTaskEvents"
  | "prepareSurfaceAttempt"
  | "settleSurfaceAttempt"
  | "prepareSurfaceFailure"
  | "settleSurfaceFailure"
>;

/**
 * Separates execution outcomes from committing their durable state. The mandatory intent
 * survives a failed settlement or Control Plane restart, so recovery never needs a Worker.
 * Optional history events are deliberately outside this recovery protocol.
 */
export class SurfaceSettlement {
  constructor(private readonly store: SettlementStore) {}

  async pending(taskId: string): Promise<PreparedSurfaceOutcome | undefined> {
    const attempts = await this.store.listTaskAttempts(taskId);
    const latest = attempts.toSorted((a, b) => b.attemptNumber - a.attemptNumber)[0];
    const events = await this.store.listTaskEvents(taskId);
    for (const event of events.toReversed()) {
      if (event.type === "surface.failure-prepared") {
        const outcome = decodeFailure(event.payload, taskId);
        if (
          events.some(
            (entry) =>
              entry.type === "surface.failure-settled" &&
              entry.payload?.["claimAttemptCount"] === outcome.claimAttemptCount,
          )
        )
          continue;
        return outcome;
      }
      if (latest && event.type === PREPARED && event.attemptId === latest.id)
        return decodeOutcome(event.payload, latest);
    }
    return undefined;
  }

  async prepare(
    outcome: PreparedSurfaceOutcome,
    inboundEventId: string,
    leaseOwner: string,
  ): Promise<void> {
    const authority = { inboundEventId, leaseOwner, now: new Date().toISOString() };
    if (isSurfaceFailure(outcome))
      await this.store.prepareSurfaceFailure({ ...outcome, ...authority });
    else await this.store.prepareSurfaceAttempt({ ...outcome, ...authority });
  }

  async commit(
    outcome: PreparedSurfaceOutcome,
    inboundEventId: string,
    leaseOwner: string,
  ): Promise<"pending" | "failed" | "completed" | "cancelled"> {
    const authority = { inboundEventId, leaseOwner, now: new Date().toISOString() };
    if (isSurfaceFailure(outcome))
      return this.store.settleSurfaceFailure({ ...outcome, ...authority });
    await this.store.settleSurfaceAttempt({ ...outcome, ...authority });
    return outcome.status;
  }
}

function decodeOutcome(value: unknown, attempt: TaskAttempt): SurfaceOutcome {
  if (
    !isObject(value) ||
    value["version"] !== 1 ||
    value["taskId"] !== attempt.taskId ||
    value["attemptId"] !== attempt.id ||
    (value["status"] !== "completed" && value["status"] !== "cancelled") ||
    typeof value["workerId"] !== "string" ||
    !value["workerId"] ||
    typeof value["responseText"] !== "string" ||
    typeof value["completedAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["completedAt"])) ||
    !isObject(value["outcome"]) ||
    (value["sessionBlockReason"] !== undefined && typeof value["sessionBlockReason"] !== "string")
  )
    throw new Error(`Invalid prepared surface outcome for Attempt ${attempt.id}`);
  return {
    taskId: attempt.taskId,
    attemptId: attempt.id,
    status: value["status"],
    workerId: value["workerId"],
    responseText: value["responseText"],
    completedAt: value["completedAt"],
    outcome: value["outcome"],
    ...(value["result"] === undefined ? {} : { result: value["result"] as unknown as TaskResult }),
    ...(value["sessionBlockReason"] === undefined
      ? {}
      : { sessionBlockReason: value["sessionBlockReason"] }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeFailure(value: unknown, taskId: string): SurfaceFailureOutcome {
  if (
    !isObject(value) ||
    value["version"] !== 1 ||
    value["taskId"] !== taskId ||
    (value["attemptId"] !== undefined && typeof value["attemptId"] !== "string") ||
    typeof value["claimAttemptCount"] !== "number" ||
    !Number.isInteger(value["claimAttemptCount"]) ||
    value["claimAttemptCount"] < 1 ||
    typeof value["error"] !== "string" ||
    typeof value["retryable"] !== "boolean" ||
    typeof value["retryAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["retryAt"])) ||
    typeof value["workerId"] !== "string" ||
    !value["workerId"] ||
    typeof value["responseText"] !== "string" ||
    typeof value["failedAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["failedAt"])) ||
    (value["sessionBlockReason"] !== undefined && typeof value["sessionBlockReason"] !== "string")
  )
    throw new Error(`Invalid prepared surface failure for Task ${taskId}`);
  return {
    taskId,
    claimAttemptCount: value["claimAttemptCount"],
    error: value["error"],
    retryable: value["retryable"],
    retryAt: value["retryAt"],
    workerId: value["workerId"],
    responseText: value["responseText"],
    failedAt: value["failedAt"],
    ...(value["attemptId"] === undefined ? {} : { attemptId: value["attemptId"] }),
    ...(value["sessionBlockReason"] === undefined
      ? {}
      : { sessionBlockReason: value["sessionBlockReason"] }),
  };
}
