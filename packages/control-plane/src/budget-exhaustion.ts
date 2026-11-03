import type { JsonRecord, TaskEvent } from "@supertag/core";

/** Only a Harness-authored terminal signal proves an allocation stopped execution. */
export function budgetExhaustionResult(
  events: readonly TaskEvent[],
  attemptId: string,
  fallback: JsonRecord,
): JsonRecord {
  const terminal = events.findLast(
    (event) =>
      event.attemptId === attemptId &&
      (event.type === "execution.failed" || event.type === "execution.completed"),
  );
  const error = terminal?.payload?.["error"];
  if (
    terminal?.type !== "execution.failed" ||
    error === null ||
    typeof error !== "object" ||
    Array.isArray(error) ||
    (error as Record<string, unknown>)["name"] !== "ExecutionBudgetExceededError"
  )
    return fallback;
  return {
    ...fallback,
    failureKind: "budget-exhausted",
    budgetExhaustion: { attemptId, requiresAuthorization: true },
  };
}
