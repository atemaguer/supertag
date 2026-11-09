import { taskExecutionPlacementReport } from "@supertag/control-plane";
import type { WorkerHost } from "@supertag/core";
import type { OperatorReadStore } from "./operator-seams.js";
import type { HostStorageEvidence } from "./storage-durability.js";

/** Bound history reads; running Attempts are included even outside the recent Task window. */
const STORAGE_TASK_SCAN = 200;

/**
 * Read recorded execution placement, never a Worklet's current capability advertisement.
 * Missing history remains unknown instead of asserting that Task storage is persistent.
 */
export async function workerHostStorage(
  store: Pick<
    OperatorReadStore,
    "listTasks" | "listTaskAttempts" | "listRunningTaskAttempts" | "listTaskEvents"
  >,
  hosts: readonly Pick<WorkerHost, "id">[],
): Promise<ReadonlyMap<string, HostStorageEvidence>> {
  if (hosts.length === 0) return new Map();
  const [tasks, running] = await Promise.all([
    store.listTasks({ limit: STORAGE_TASK_SCAN }),
    store.listRunningTaskAttempts(),
  ]);
  const attempts = new Map(
    [...(await store.listTaskAttempts(tasks.map((task) => task.id))), ...running].map((attempt) => [
      attempt.id,
      attempt,
    ]),
  );
  const records = new Map(
    hosts.map((host) => [
      host.id,
      {
        sandboxes: new Set<string>(),
        seen: false,
        unknown: false,
      },
    ]),
  );
  const byTask = new Map<string, (typeof running)[number][]>();
  for (const attempt of attempts.values()) {
    const hostId = attempt.workerSnapshot["workerHostId"];
    if (typeof hostId !== "string" || !records.has(hostId)) continue;
    const group = byTask.get(attempt.taskId) ?? [];
    group.push(attempt);
    byTask.set(attempt.taskId, group);
  }
  for (const [taskId, group] of byTask) {
    const events = await store.listTaskEvents(taskId);
    for (const attempt of group) {
      const record = records.get(attempt.workerSnapshot["workerHostId"] as string);
      if (!record) continue;
      let recorded = false;
      for (const event of events) {
        if (event.attemptId !== attempt.id) continue;
        const environment = taskExecutionPlacementReport(attempt, [event]).executionEnvironment;
        if (environment === null) continue;
        recorded = true;
        if (environment.placement === "remote") record.sandboxes.add(environment.provider);
        // Managed placement does not establish persistent local storage either.
        if (environment.placement === "managed") record.unknown = true;
      }
      record.seen ||= recorded;
      record.unknown ||= !recorded;
    }
  }
  return new Map(
    [...records].map(([id, record]) => [
      id,
      {
        sandboxes: [...record.sandboxes].sort(),
        placementUnknown: !record.seen || record.unknown,
      },
    ]),
  );
}
