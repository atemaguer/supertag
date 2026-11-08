import type { Objective } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { evaluateObjectiveLimits, objectiveShouldLimit } from "./src/objective-limits.js";

describe("Objective limit transition", () => {
  const now = "2026-10-03T07:20:00.000Z";
  const base = {
    status: "working",
    createdAt: "2026-10-01T07:00:00.000Z",
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

  it("records the pool's warning and exhaustion once, against the limit observed", () => {
    const spend = (amountMinor: number) => ({
      amountMinor,
      currency: "USD",
      unknownAttemptIds: [],
      estimatedCostAttempts: 0,
    });
    const warned = evaluateObjectiveLimits(base, now, spend(80));
    expect(warned.budgetWarnings).toMatchObject([{ fraction: 0.8, limitMinor: 100 }]);
    expect(warned.budgetExhausted).toBeUndefined();
    expect(warned.reportedSpend).toMatchObject({ amountMinor: 80, observedAt: now });

    const later = "2026-10-03T08:20:00.000Z";
    const spent = evaluateObjectiveLimits(
      { ...base, limitState: warned } as Objective,
      later,
      spend(140),
    );
    expect(spent.budgetWarnings).toMatchObject([{ at: now }]);
    expect(spent.budgetExhausted).toMatchObject({ limitMinor: 100, spentMinor: 140, at: later });

    // Raising the budget makes the observations against the old limit inert.
    const raised = evaluateObjectiveLimits(
      { ...base, budgetLimitMinor: 500, limitState: spent } as Objective,
      later,
      spend(140),
    );
    expect(raised.budgetWarnings).toBeUndefined();
    expect(raised.budgetExhausted).toBeUndefined();
  });

  it("keeps the Objective's recorded summary across later sweeps", () => {
    const objective = {
      ...base,
      status: "limited",
      limitState: { summary: { text: "Progress recorded", at: now } },
    } as Objective;
    expect(evaluateObjectiveLimits(objective, now, undefined)).toMatchObject({
      summary: { text: "Progress recorded" },
    });
  });
});
