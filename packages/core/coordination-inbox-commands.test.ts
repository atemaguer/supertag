import { expect, it } from "vitest";
import { coordinationInboxCommands } from "./src/coordination-inbox.js";

it("shows existing decision commands for Task review and budget items", () => {
  const item = {
    key: "task_review:task with 'quotes'",
    objectiveId: "objective-a",
    evidence: [{ kind: "task" as const, id: "task with 'quotes'" }],
  };
  const review = coordinationInboxCommands({ ...item, kind: "task_review", approval: undefined });
  expect(review[0]).toContain("supertag coordinate update_task --input ");
  expect(review[0]).toContain("accept-review.json");
  expect(review[1]).toContain("reject-review.json");
  expect(review[2]).toContain("supertag describe task 'task with ");
  const budget = coordinationInboxCommands({ ...item, kind: "task_budget", approval: undefined });
  expect(budget[0]).toContain("supertag coordinate update_task --input ");
  expect(budget[0]).toContain("renew-budget.json");
});
