import type { ObjectiveOverview } from "@supertag/control-plane";
import { describe, expect, it } from "vitest";
import { formatObjectiveOverview } from "./src/objective-overview.js";

/** The overview of an Objective stopped at its budget, with one work Session beneath it. */
function limitedView(overrides: Partial<ObjectiveOverview> = {}): ObjectiveOverview {
  return {
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
    pool: { limitMinor: 100, currency: "USD", spentMinor: 125 },
    objectiveSpend: { attempts: 2, reportedCostByCurrency: { USD: 125 } },
    tagNames: { owner: "planner" },
    team: null,
    conditions: [],
    attention: [],
    sessions: [],
    highFindings: [],
    conversation: [],
    posts: [],
    writes: [],
    tasks: [],
    pageUsage: { taskIds: [], provider: { observedCostByCurrency: {} } },
    ...overrides,
  } as unknown as ObjectiveOverview;
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
