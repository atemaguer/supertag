import { describe, expect, it } from "vitest";
import { ownerActivationsFirst } from "./src/owner-scheduling.js";

describe("ownerActivationsFirst", () => {
  const owners: Record<string, string> = { alpha: "owner-a", beta: "owner-b" };
  const task = (taskId: string, objectiveId: string, assignedTagId: string) => ({
    taskId,
    objectiveId,
    assignedTagId,
  });

  it("moves Objective owner Tasks ahead of delegated Tasks and keeps each group's order", async () => {
    const queue = [
      task("builder-1", "alpha", "builder"),
      task("builder-2", "alpha", "builder"),
      task("owner-a-review", "alpha", "owner-a"),
      task("other-builder", "beta", "builder"),
      task("owner-b-review", "beta", "owner-b"),
    ];
    const ordered = await ownerActivationsFirst(queue, async (id) => owners[id]);
    expect(ordered.map((entry) => entry.taskId)).toEqual([
      "owner-a-review",
      "owner-b-review",
      "builder-1",
      "builder-2",
      "other-builder",
    ]);
  });

  it("does not treat an owner's Task in another Objective as an owner activation", async () => {
    const queue = [task("delegated", "alpha", "builder"), task("cross", "beta", "owner-a")];
    const ordered = await ownerActivationsFirst(queue, async (id) => owners[id]);
    expect(ordered.map((entry) => entry.taskId)).toEqual(["delegated", "cross"]);
  });

  it("looks up each Objective once and keeps Tasks whose Objective is unknown in place", async () => {
    const lookups: string[] = [];
    const queue = [
      task("missing", "gone", "anyone"),
      task("builder", "alpha", "builder"),
      task("owner", "alpha", "owner-a"),
    ];
    const ordered = await ownerActivationsFirst(queue, async (id) => {
      lookups.push(id);
      if (id === "gone") throw new Error("Objective not found");
      return owners[id];
    });
    expect(ordered.map((entry) => entry.taskId)).toEqual(["owner", "missing", "builder"]);
    expect(lookups).toEqual(["gone", "alpha"]);
  });
});
