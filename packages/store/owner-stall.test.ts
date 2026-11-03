import { describe, expect, it } from "vitest";
import { ownerStallWork } from "./src/owner-stall.js";

const objective = {
  id: "release",
  ownerTagId: "owner",
  status: "working",
  executionStartedAt: "2026-10-06T00:00:00.000Z",
};
const root = {
  taskId: "release:start",
  objectiveId: "release",
  teamId: "release:leadership",
  assignedTagId: "owner",
  requestedByTagId: "owner",
  parentTaskId: null,
  sourceMessageId: null,
  status: "cancelled",
  attemptCount: 1,
  updatedAt: "2026-10-06T00:01:00.000Z",
  result: null,
};

describe("owner stall work", () => {
  it("names open findings and unhandled operator input, then clears for an owner activation", () => {
    const finding = {
      ...root,
      taskId: "review",
      parentTaskId: root.taskId,
      assignedTagId: "reviewer",
      status: "accepted",
      result: {
        taskResult: {
          findings: [{ id: "F1", severity: "high", summary: "Repair checkout", status: "open" }],
        },
      },
    };
    const message = {
      id: "operator-1",
      objectiveId: objective.id,
      recipientTagId: objective.ownerTagId,
      operatorId: "person",
      status: "pending",
      createdAt: "2026-10-06T00:02:00.000Z",
    };
    expect(ownerStallWork(objective, [root, finding], [message])?.waiting).toEqual([
      "open finding review F1",
      "unhandled operator input operator-1",
    ]);
    expect(
      ownerStallWork(objective, [{ ...root, status: "running" }, finding], [message]),
    ).toBeUndefined();
    expect(
      ownerStallWork(objective, [root, finding], [{ ...message, status: "processed" }])?.waiting,
    ).toEqual(["open finding review F1"]);
  });

  it("waits for delegated work in flight before naming submitted Tasks or findings", () => {
    const submitted = {
      ...root,
      taskId: "builder",
      parentTaskId: root.taskId,
      status: "submitted",
    };
    const review = { ...root, taskId: "review", parentTaskId: "builder:followup" };
    const message = {
      id: "operator-1",
      objectiveId: objective.id,
      recipientTagId: objective.ownerTagId,
      operatorId: "person",
      status: "pending",
      createdAt: "2026-10-06T00:02:00.000Z",
    };
    for (const status of ["queued", "running", "waiting"])
      expect(
        ownerStallWork(objective, [root, submitted, { ...review, status }], []),
      ).toBeUndefined();
    expect(
      ownerStallWork(objective, [root, submitted, { ...review, status: "running" }], [message])
        ?.waiting,
    ).toEqual(["unhandled operator input operator-1"]);
    expect(
      ownerStallWork(objective, [root, submitted, { ...review, status: "accepted" }], [])?.waiting,
    ).toEqual(["submitted Task builder"]);
  });

  it("keeps the inbox notice while the one stall wake is queued", () => {
    const submitted = {
      ...root,
      taskId: "builder",
      parentTaskId: root.taskId,
      status: "submitted",
    };
    const wake = { ...root, taskId: "release:stall-wake:abc", status: "queued" };
    expect(ownerStallWork(objective, [root, submitted, wake], [], true)?.waiting).toEqual([
      "submitted Task builder",
    ]);
    expect(
      ownerStallWork(objective, [root, submitted, { ...wake, status: "running" }], [], true),
    ).toBeUndefined();
  });
});
