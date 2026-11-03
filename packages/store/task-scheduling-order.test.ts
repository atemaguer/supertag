import type { TeamTaskPriority } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { compareTaskSchedulingOrder } from "./src/task-assignment-store.js";

const origin = Date.parse("2030-01-01T00:00:00.000Z");
const task = (taskId: string, priority: TeamTaskPriority, eligibleMinutes: number) => ({
  taskId,
  priority,
  availableAt: new Date(origin + eligibleMinutes * 60_000).toISOString(),
});
const order = (tasks: ReturnType<typeof task>[], nowMinutes: number): ReturnType<typeof task>[] =>
  tasks.toSorted((left, right) =>
    compareTaskSchedulingOrder(left, right, origin + nowMinutes * 60_000),
  );

describe("Task scheduling order", () => {
  it("uses accepted priority and stable FIFO order for newly eligible work", () => {
    expect(
      order(
        [
          task("normal-later", "normal", 2),
          task("urgent", "urgent", 3),
          task("normal", "normal", 1),
        ],
        4,
      ).map(({ taskId }) => taskId),
    ).toEqual(["urgent", "normal", "normal-later"]);
  });

  it("promotes waiting work one tier every fifteen minutes", () => {
    const waiting = task("waiting-low", "low", 0);
    const freshUrgent = task("fresh-urgent", "urgent", 44);
    expect(order([waiting, freshUrgent], 44)[0]?.taskId).toBe("fresh-urgent");
    expect(order([waiting, freshUrgent], 45)[0]?.taskId).toBe("waiting-low");
  });

  it("does not age a Task before it becomes eligible", () => {
    expect(order([task("future-low", "low", 60), task("normal", "normal", 0)], 45)[0]?.taskId).toBe(
      "normal",
    );
  });
});
