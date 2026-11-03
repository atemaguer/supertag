import { expect, it } from "vitest";
import { describeFindingClosures, describeOpenFindings, describeTask } from "./src/resources.js";

const high = {
  id: "F2",
  severity: "high",
  summary: "The query skips tenant scoping.",
  location: "src/query.ts:42",
  status: "open",
};
const low = { id: "F1", severity: "low", summary: "A comment is stale.", status: "open" };

it("describes a Task's open findings by severity, highest first", () => {
  const description = describeTask({
    apiVersion: "v1",
    kind: "Task",
    metadata: { id: "review-export" },
    spec: { sessionId: "session-1" },
    status: { phase: "completed", openFindings: { high: [high], medium: [], low: [low] } },
  });
  expect(description).toContain(
    [
      "Open findings: 1 high, 1 low",
      "  F2 [high] The query skips tenant scoping. (src/query.ts:42)",
      "  F1 [low] A comment is stale.",
    ].join("\n"),
  );
});

it("omits the findings section when none are open", () => {
  expect(describeOpenFindings(undefined)).toEqual([]);
  expect(describeOpenFindings({ high: [], medium: [], low: [] })).toEqual([]);
});

it("describes unreadable stored findings instead of hiding them", () => {
  expect(
    describeOpenFindings({ unreadable: "Stored Task result findings are invalid: x" }),
  ).toEqual(["Open findings: unreadable (Stored Task result findings are invalid: x)"]);
});

it("shows which findings a re-review confirms fixed and what accepting it closed", () => {
  const fixedFindings = [
    { taskId: "review-export", findingId: "F1" },
    { taskId: "review-other", findingId: "F2" },
  ];
  const describe = (status: Record<string, unknown>) =>
    describeTask({
      apiVersion: "v1",
      kind: "Task",
      metadata: { id: "re-review-export" },
      spec: { sessionId: "session-1" },
      status: { phase: "completed", ...status },
    });
  expect(describe({ fixedFindings })).toContain(
    [
      "Confirms fixed (accepting closes these findings):",
      "  review-export F1",
      "  review-other F2",
    ].join("\n"),
  );
  expect(
    describe({
      fixedFindings,
      findingClosures: [
        { ...fixedFindings[0], outcome: "closed" },
        { ...fixedFindings[1], outcome: "refused", reason: "No such finding" },
      ],
    }),
  ).toContain(
    [
      "Finding closures:",
      "  review-export F1: closed",
      "  review-other F2: refused (No such finding)",
    ].join("\n"),
  );
  expect(describeFindingClosures(undefined, undefined)).toEqual([]);
});
