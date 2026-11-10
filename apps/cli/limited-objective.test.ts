import { describe, expect, it } from "vitest";
import { formatObjectiveOverview } from "./src/objective-overview.js";
import type { ObjectiveOverviewView } from "./src/objective-protos.js";

/** The overview of an Objective stopped at its budget, with one work Session beneath it. */
function limitedView(overrides: Partial<ObjectiveOverviewView> = {}): ObjectiveOverviewView {
  return {
    objective: {
      id: "launch",
      status: "limited",
      outcome: "Ship launch",
      ownerTagId: "owner",
      revision: 3,
      completionSummary: null,
      limitSummary: "Progress: code done. Open: review. Blocker: budget. Next: raise it.",
      reportedSpendMinor: 125,
    },
    pool: { limitMinor: 100, currency: "USD", spentMinor: 125 },
    unpricedModels: {},
    tagNames: { owner: "planner" },
    team: null,
    conditions: [],
    attention: [],
    sessions: [],
    highFindings: [],
    commitReviews: [],
    writes: [],
    ...overrides,
  } as unknown as ObjectiveOverviewView;
}

describe("limited Objective description", () => {
  it("shows the owner's summary, overrun, and the commands that resume it", () => {
    const output = formatObjectiveOverview(limitedView());
    expect(output).toContain("Objective launch: limited");
    expect(output).toContain("Limit summary: Progress: code done. Open: review.");
    // The pool covers the Objective's conversation and every Session beneath it.
    expect(output).toContain("Budget: $1.25 of $1.00 spent; overrun $0.25");
    expect(output).toContain("supertag update objective launch --budget-minor AMOUNT");
    expect(output).toContain("supertag update objective launch --deadline ISO_TIME");
  });

  it("lists the high findings of the Sessions' latest turns, or none", () => {
    expect(formatObjectiveOverview(limitedView())).not.toContain("High findings");
    expect(
      formatObjectiveOverview(
        limitedView({
          highFindings: [
            { taskId: "review-a", id: "F1", summary: "Missing authorization.", location: "a.ts:4" },
          ],
        }),
      ),
    ).toContain("High findings (1):\n  review-a F1: Missing authorization. (a.ts:4)");
  });
});
