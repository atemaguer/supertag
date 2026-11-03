import type { Objective } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { objectiveLimitsView } from "./src/objective-summary.js";

describe("Objective limits view", () => {
  it("shows reported overrun after running Attempts finish", () => {
    const objective = {
      status: "limited",
      budgetLimitMinor: 100,
      budgetCurrency: "USD",
      deadline: null,
      limitState: {
        reportedSpend: {
          amountMinor: 135,
          currency: "USD",
          unknownAttemptIds: [],
          observedAt: "2026-10-03T07:00:00.000Z",
        },
        budgetExhausted: { limitMinor: 100, spentMinor: 100, at: "2026-10-03T06:59:00.000Z" },
      },
    } as Objective;
    expect(objectiveLimitsView(objective, "2026-10-03T07:01:00.000Z").budget).toMatchObject({
      limitMinor: 100,
      reportedSpentMinor: 135,
      overrunMinor: 35,
      exhausted: true,
    });
  });
});
