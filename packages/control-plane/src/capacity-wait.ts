import type { TaskAttempt, TaskClaimDecline } from "@supertag/core";
import { type WorkerDescriptor, workerSlots } from "@supertag/worker-sdk";

/** The Task event recording why a compatible Task is still queued. */
export const SCHEDULING_WAITING_EVENT = "task.scheduling-waiting";

/** Task events that record the latest scheduling check, in the order they were observed. */
export function isSchedulingEvent(event: { readonly type: string }): boolean {
  return (
    event.type === "task.scheduling-incompatible" ||
    event.type === "task.scheduling-compatible" ||
    event.type === SCHEDULING_WAITING_EVENT
  );
}

/** One eligible Worker Host and the Task Attempts that fill its matching Workers. */
export interface CapacityWaitHost {
  readonly workerHostId: string;
  /** Harnesses of the Workers on this host that could run the Task. */
  readonly harnesses: readonly string[];
  /** Task Attempts those Workers run at once, together. */
  readonly capacity: number;
  /** Tasks whose running Attempts occupy those Workers. */
  readonly busyTaskIds: readonly string[];
}

/** A dependency that is not yet accepted, with its status, or null when it cannot be read. */
export interface DependencyWaitEntry {
  readonly taskId: string;
  readonly status: string | null;
}

/**
 * Why a queued Task has not started. `dependencies` means some of its dependencies are not yet
 * accepted, so it is not offered for placement; `capacity` means every matching Worker on the
 * eligible hosts is busy; `unavailable` means no eligible host has a matching Worker connected
 * right now; `claim` means a Worker was free but the Control Plane declined to start the Task,
 * for the stated cause, such as its Team's maxConcurrency being full.
 */
export type SchedulingWait =
  | {
      readonly version: 1;
      readonly status: "waiting";
      readonly reason: "dependencies";
      readonly dependencies: readonly DependencyWaitEntry[];
    }
  | {
      readonly version: 1;
      readonly status: "waiting";
      readonly reason: "capacity";
      readonly hosts: readonly CapacityWaitHost[];
    }
  | { readonly version: 1; readonly status: "waiting"; readonly reason: "unavailable" }
  | {
      readonly version: 1;
      readonly status: "waiting";
      readonly reason: "claim";
      readonly claim: TaskClaimDecline;
    };

/**
 * Returns a wait naming the dependencies that are not accepted, in declared order, or undefined
 * when every dependency is accepted. A dependency that cannot be read counts as not accepted.
 */
export async function dependencyWait(
  dependencies: readonly string[],
  status: (taskId: string) => Promise<string | undefined>,
): Promise<SchedulingWait | undefined> {
  const pending: DependencyWaitEntry[] = [];
  for (const taskId of dependencies) {
    const current = (await status(taskId)) ?? null;
    if (current !== "accepted") pending.push({ taskId, status: current });
  }
  return pending.length === 0
    ? undefined
    : { version: 1, status: "waiting", reason: "dependencies", dependencies: pending };
}

/**
 * Builds a capacity wait from the Worklet descriptor and the stored running Attempts. Workers of
 * a remote host appear in the descriptor as `HOST/WORKER`; an embedded Worklet's Workers carry
 * plain IDs under the descriptor's own host.
 */
export function schedulingWait(input: {
  readonly descriptorHostId: string;
  readonly compatibleWorkers: readonly WorkerDescriptor[];
  readonly allowedWorkerHostIds: readonly string[];
  readonly runningAttempts: readonly TaskAttempt[];
  /** The Task is an Objective owner's activation, which may also use each coordination slot. */
  readonly coordinationSlot?: boolean;
}): SchedulingWait {
  const hosts: CapacityWaitHost[] = [];
  for (const workerHostId of [...new Set(input.allowedWorkerHostIds)].toSorted()) {
    const workers = input.compatibleWorkers.filter(
      (worker) =>
        input.descriptorHostId === workerHostId || worker.id.startsWith(`${workerHostId}/`),
    );
    if (workers.length === 0) continue;
    const workerIds = new Set(
      workers.flatMap((worker) => [
        worker.id,
        worker.id.startsWith(`${workerHostId}/`)
          ? worker.id.slice(workerHostId.length + 1)
          : worker.id,
      ]),
    );
    const busyTaskIds = input.runningAttempts
      .filter((attempt) => {
        const placement = attemptPlacement(attempt);
        return (
          placement.workerHostId === workerHostId &&
          placement.workerId !== undefined &&
          workerIds.has(placement.workerId)
        );
      })
      .map((attempt) => attempt.taskId);
    hosts.push({
      workerHostId,
      harnesses: [
        ...new Set(
          workers.flatMap((worker) =>
            (worker.profileCapabilities ?? []).flatMap((entry) =>
              entry.harness === undefined ? [] : [entry.harness],
            ),
          ),
        ),
      ].toSorted(),
      capacity: workers.reduce(
        (total, worker) => total + workerSlots(worker, input.coordinationSlot),
        0,
      ),
      busyTaskIds: [...new Set(busyTaskIds)].toSorted(),
    });
  }
  return hosts.length === 0
    ? { version: 1, status: "waiting", reason: "unavailable" }
    : { version: 1, status: "waiting", reason: "capacity", hosts };
}

function attemptPlacement(attempt: TaskAttempt): {
  readonly workerHostId?: string;
  readonly workerId?: string;
} {
  const snapshot = attempt.workerSnapshot;
  const placement =
    typeof snapshot["placement"] === "object" &&
    snapshot["placement"] !== null &&
    !Array.isArray(snapshot["placement"])
      ? (snapshot["placement"] as Record<string, unknown>)
      : {};
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const workerHostId = text(snapshot["workerHostId"]) ?? text(placement["workerHostId"]);
  const workerId = text(snapshot["workerId"]) ?? text(placement["workerId"]);
  return {
    ...(workerHostId === undefined ? {} : { workerHostId }),
    ...(workerId === undefined ? {} : { workerId }),
  };
}
