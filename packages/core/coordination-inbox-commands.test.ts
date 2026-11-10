import { expect, it } from "vitest";
import { coordinationInboxCommands } from "./src/coordination-inbox.js";

const item = {
  key: "objective_budget:objective with 'quotes'",
  objectiveId: "objective with 'quotes'",
  evidence: [{ kind: "task" as const, id: "task", status: "running", attemptCount: 1 }],
  approval: undefined,
  uncertainAttempt: undefined,
};

it("shows the budget and deadline commands for Objective limit items", () => {
  expect(coordinationInboxCommands({ ...item, kind: "objective_budget" })).toEqual([
    `supertag update objective 'objective with '\\''quotes'\\''' --budget-minor N`,
  ]);
  expect(
    coordinationInboxCommands({
      ...item,
      kind: "objective_limit",
      key: "objective_limit:objective:deadline-60",
    }),
  ).toEqual([`supertag update objective 'objective with '\\''quotes'\\''' --deadline ISO-8601`]);
  expect(
    coordinationInboxCommands({
      ...item,
      kind: "objective_limit",
      key: "objective_limit:objective:budget-0.8",
    }),
  ).toEqual([`supertag update objective 'objective with '\\''quotes'\\''' --budget-minor N`]);
});

it("offers CLI actions only for items with a supported command", () => {
  expect(coordinationInboxCommands({ ...item, kind: "question" })).toEqual([]);
});

it("decides an approval request, and lists them when the item carries none", () => {
  expect(
    coordinationInboxCommands({
      ...item,
      kind: "approval",
      approval: {
        requestId: "request-1",
        requestKind: "surface-action",
        summary: "Push the branch",
        requestingTagId: "tag",
        taskId: "task",
        blocking: true,
      },
    }),
  ).toEqual([
    "supertag approve request request-1",
    "supertag deny request request-1 --reason TEXT",
  ]);
  expect(coordinationInboxCommands({ ...item, kind: "approval" })[0]).toBe(
    `supertag list approval --objective 'objective with '\\''quotes'\\'''`,
  );
  // A Tag's inbox turn asks for approval outside any Objective.
  expect(coordinationInboxCommands({ ...item, kind: "approval", objectiveId: null })).toEqual([
    "supertag list approval",
  ]);
});
