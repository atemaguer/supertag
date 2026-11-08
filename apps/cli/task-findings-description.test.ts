import { expect, it } from "vitest";
import { describeFindings, describeTask } from "./src/resources.js";

const high = {
  id: "F2",
  severity: "high",
  summary: "The query skips tenant scoping.",
  location: "src/query.ts:42",
};
const low = { id: "F1", severity: "low", summary: "A comment is stale." };

it("describes a Task's findings by severity, highest first", () => {
  const description = describeTask({
    apiVersion: "v1",
    kind: "Task",
    metadata: { id: "review-export" },
    spec: { sessionId: "session-1" },
    status: { phase: "completed", findings: { high: [high], medium: [], low: [low] } },
  });
  expect(description).toContain(
    [
      "Findings: 1 high, 1 low",
      "  F2 [high] The query skips tenant scoping. (src/query.ts:42)",
      "  F1 [low] A comment is stale.",
    ].join("\n"),
  );
});

it("omits the findings section when the result reported none", () => {
  expect(describeFindings(undefined)).toEqual([]);
  expect(describeFindings({ high: [], medium: [], low: [] })).toEqual([]);
});

it("describes unreadable stored findings instead of hiding them", () => {
  expect(describeFindings({ unreadable: "Stored Task result findings are invalid: x" })).toEqual([
    "Findings: unreadable (Stored Task result findings are invalid: x)",
  ]);
});
