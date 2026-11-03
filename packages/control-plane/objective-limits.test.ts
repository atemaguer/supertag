import type { Objective } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { evaluateObjectiveLimits, objectiveShouldLimit } from "./src/objective-limits.js";

describe("Objective limit transition", () => {
  const now = "2026-10-03T07:20:00.000Z";
  const base = {
    status: "working",
    deadline: null,
    budgetLimitMinor: 100,
    budgetCurrency: "USD",
  } as Objective;
  const exhausted = {
    budgetExhausted: { limitMinor: 100, spentMinor: 100, at: now },
  };

  it("waits for running Task Attempts at budget exhaustion", () => {
    expect(objectiveShouldLimit(base, exhausted, [{ status: "running" }], now, 60_000)).toBe(false);
    expect(objectiveShouldLimit(base, exhausted, [{ status: "submitted" }], now, 60_000)).toBe(
      true,
    );
  });

  it("waits for deadline grace and running Attempts to end", () => {
    const objective = { ...base, budgetLimitMinor: null, deadline: "2026-10-03T07:00:00.000Z" };
    expect(objectiveShouldLimit(objective, {}, [], "2026-10-03T07:00:30.000Z", 60_000)).toBe(false);
    expect(objectiveShouldLimit(objective, {}, [{ status: "running" }], now, 60_000)).toBe(false);
    expect(objectiveShouldLimit(objective, {}, [{ status: "submitted" }], now, 60_000)).toBe(true);
  });

  it("retains the active summary Task identity across later limit sweeps", () => {
    const objective = {
      ...base,
      status: "limited",
      limitState: {
        summaryTaskId: "objective:limit-summary:2",
        summary: { text: "Progress recorded", at: now },
      },
    } as Objective;
    expect(evaluateObjectiveLimits(objective, now, undefined)).toMatchObject({
      summaryTaskId: "objective:limit-summary:2",
      summary: { text: "Progress recorded" },
    });
  });
});
