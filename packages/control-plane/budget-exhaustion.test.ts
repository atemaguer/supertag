import { expect, it } from "vitest";
import type { TaskEvent } from "../core/src/index.js";
import { budgetExhaustionResult } from "./src/budget-exhaustion.js";

const event = (name: string, attemptId = "current"): TaskEvent => ({
  id: "event",
  taskId: "task",
  attemptId,
  sequence: 1,
  type: "execution.failed",
  payload: { error: { name, message: "budget exceeded" } },
  createdAt: new Date().toISOString(),
});
it("classifies only authoritative exhaustion from the settling Attempt", () => {
  const fallback = { error: "Recovered durable execution failed" };
  expect(
    budgetExhaustionResult([event("ExecutionBudgetExceededError")], "current", fallback),
  ).toEqual({
    ...fallback,
    failureKind: "budget-exhausted",
    budgetExhaustion: { attemptId: "current", requiresAuthorization: true },
  });
  expect(budgetExhaustionResult([event("Error")], "current", fallback)).toBe(fallback);
  expect(
    budgetExhaustionResult(
      [event("ExecutionBudgetExceededError"), event("Error")],
      "current",
      fallback,
    ),
  ).toBe(fallback);
  expect(
    budgetExhaustionResult([event("ExecutionBudgetExceededError", "old")], "current", fallback),
  ).toBe(fallback);
});
