import { expect, it } from "vitest";
import { formatObjectiveOverview } from "./src/objective-overview.js";
import type { ObjectiveOverviewView } from "./src/objective-protos.js";

it("summarizes files and bytes per Volume and flags partial writes", () => {
  const view = {
    objective: {
      id: "publish",
      status: "completed",
      outcome: "Publish reports",
      ownerTagId: "owner",
      completionSummary: null,
    },
    pool: { limitMinor: 100, currency: "USD", spentMinor: 0 },
    unpricedModels: {},
    conditions: [],
    sessions: [],
    highFindings: [],
    attention: [],
    team: null,
    tagNames: { owner: "owner" },
    writes: [
      { volume: "archive", files: 3, bytes: 120, partial: 0, refused: 0 },
      { volume: "reports", files: 2, bytes: 75, partial: 1, refused: 0 },
    ],
  } as unknown as ObjectiveOverviewView;

  const output = formatObjectiveOverview(view);
  expect(output).toContain("Writes:\n  archive: 3 files / 120 bytes written");
  expect(output).toContain("  reports: 2 files / 75 bytes written; 1 partial");
  expect(output).not.toContain("archive: 3 files / 120 bytes written; 0 partial");
});
