import type { ObjectiveOverview } from "@supertag/control-plane";
import { describe, expect, it } from "vitest";
import { formatObjectiveOverview } from "./src/objective-overview.js";

describe("limited Objective description", () => {
  it("shows the owner's summary, overrun, and commands to resume", () => {
    const view = {
      objective: {
        id: "launch",
        status: "limited",
        outcome: "Ship launch",
        ownerTagId: "owner",
        revision: 3,
        completionSummary: null,
        limitState: {
          summary: {
            text: "Progress: code done. Open: review. Blocker: budget. Next: raise it.",
            at: "2026-10-03T07:00:00Z",
          },
          reportedSpend: { amountMinor: 125, currency: "USD", unknownAttemptIds: [] },
        },
      },
      allocation: { limitMinor: 100, currency: "USD" },
      performance: { total: 0, states: {}, review: { awaiting: 0 } },
      conditions: [],
      tasks: [],
      teams: [],
      attention: [],
      writes: [],
      scope: {},
      pageUsage: { provider: { observedCostByCurrency: {} }, reportedTokens: null },
    } as unknown as ObjectiveOverview;
    const output = formatObjectiveOverview(view);
    expect(output).toContain("Limit summary: Progress: code done. Open: review.");
    expect(output).toContain("overrun $0.25");
    expect(output).toContain("supertag update objective launch --budget-minor AMOUNT");
    // An older Control Plane omits open high findings: the view says so instead of implying none.
    expect(output).toContain("Open high findings: not reported by this Control Plane");
    const withHighs = formatObjectiveOverview({
      ...view,
      openHighFindings: [
        { taskId: "review-a", id: "F1", summary: "Missing authorization.", location: "a.ts:4" },
      ],
    } as unknown as ObjectiveOverview);
    expect(withHighs).toContain(
      "Open high findings (1):\n  review-a F1: Missing authorization. (a.ts:4)",
    );
    expect(
      formatObjectiveOverview({ ...view, openHighFindings: [] } as unknown as ObjectiveOverview),
    ).not.toContain("Open high findings");
  });
});
