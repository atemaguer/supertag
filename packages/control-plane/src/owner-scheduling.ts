import type { TaskAssignment } from "@supertag/core";

/**
 * Orders queued Tasks so that each Objective owner's own Tasks come before delegated Tasks.
 *
 * An owner reviews results and plans the next round. If its Team's Tasks took every Worker slot
 * first, submitted results would wait for a slot the owner never gets. The sort is stable, so
 * accepted priority, aging, and availability order still apply within each group.
 */
export async function ownerActivationsFirst<
  T extends Pick<TaskAssignment, "taskId" | "objectiveId" | "assignedTagId">,
>(
  tasks: readonly T[],
  objectiveOwner: (objectiveId: string) => Promise<string | undefined>,
): Promise<T[]> {
  const owners = new Map<string, string | undefined>();
  const owned = new Set<string>();
  for (const task of tasks) {
    if (!owners.has(task.objectiveId))
      owners.set(task.objectiveId, await objectiveOwner(task.objectiveId).catch(() => undefined));
    if (owners.get(task.objectiveId) === task.assignedTagId) owned.add(task.taskId);
  }
  return tasks.toSorted(
    (left, right) => Number(owned.has(right.taskId)) - Number(owned.has(left.taskId)),
  );
}
