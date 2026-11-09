import type { TaskAttemptRunningCommand } from "@supertag/control-plane";
import {
  type Objective,
  type SpendUsage,
  storedTaskFindings,
  type Tag,
  type Task,
  type TaskAttempt,
} from "@supertag/core";
import { COORDINATION_CAPABILITY } from "@supertag/worker-sdk";
import type { WorkerHostResource } from "./control-plane-resources.js";
import { type DiskSpace, lowDiskWarning } from "./disk-space.js";

/** Running Task Attempts against total capacity for one harness on one Worker Host. */
export interface HarnessLoad {
  readonly harness: string;
  readonly running: number;
  /** Regular slots plus owner-only coordination slots. */
  readonly capacity: number;
  readonly coordinationCapacity: number;
}

/** What the organization is doing right now, as `supertag status` shows it. */
export interface OrganizationStatus {
  readonly asOf: string;
  readonly workerHosts: readonly {
    readonly id: string;
    readonly phase: WorkerHostResource["status"]["phase"];
    readonly running: number;
    /** Regular slots plus owner-only coordination slots. */
    readonly capacity: number;
    readonly coordinationCapacity: number;
    readonly harnesses: readonly HarnessLoad[];
    readonly diskSpace?: DiskSpace;
    readonly diskWarning?: string;
  }[];
  readonly tags: readonly {
    readonly id: string;
    readonly name: string;
    /** Tasks whose Attempts are running now; empty when the Tag is idle. */
    readonly runningTaskIds: readonly string[];
    /**
     * The command each running Task's harness reports as running, when it reports commands.
     * The text is AI-authored and untrusted; it is plain, single-line text.
     */
    readonly runningCommands: readonly {
      readonly taskId: string;
      readonly command: string;
      readonly startedAt: string;
    }[];
  }[];
  /** Objectives that are not completed or cancelled, newest first. */
  readonly objectives: readonly {
    readonly id: string;
    readonly status: Objective["status"];
    readonly ownerTagId: string;
    readonly ownerName: string;
    readonly deadline: string | null;
    /** Provider-reported spend in minor units, such as 1380 for $13.80; 0 when none is known. */
    readonly spentMinor: number;
    readonly budgetLimitMinor: number | null;
    /** The budget's currency; null when the budget counts allocation units. */
    readonly currency: string | null;
    /** The currency of spentMinor; null when spend counts allocation units. */
    readonly spendCurrency: string | null;
    /** Usage with no published model price, when present. */
    readonly unpricedAttempts?: number;
    readonly unpricedTokens?: number;
    readonly highFindings?: readonly {
      readonly taskId: string;
      readonly id: string;
      readonly summary: string;
      readonly location?: string;
    }[];
  }[];
}

/** What `supertag status` prints: the organization plus the operator inbox. */
export interface OrganizationStatusView extends OrganizationStatus {
  readonly objectives: readonly (OrganizationStatus["objectives"][number] & {
    /** Operator inbox items for this Objective. */
    readonly needsOperator: number;
  })[];
  /** truncated: the inbox scan hit its limit, so items is a lower bound. */
  readonly inbox: { readonly items: number; readonly truncated: boolean };
}

/** Builds the organization view from stored records. Pure, so the API and tests share it. */
export function organizationStatus(input: {
  readonly asOf: string;
  readonly workerHosts: readonly WorkerHostResource[];
  readonly tags: readonly Tag[];
  readonly runningAttempts: readonly TaskAttempt[];
  /** The Tag of each Task with a running Attempt. */
  readonly taskTagIds: ReadonlyMap<string, string>;
  /** The running command of each Task whose harness reports one. */
  readonly runningCommands?: ReadonlyMap<string, TaskAttemptRunningCommand>;
  readonly objectives: readonly Objective[];
  /** The Tasks of each Objective's Sessions, for their reported findings. */
  readonly objectiveTasks?: ReadonlyMap<string, readonly Pick<Task, "id" | "result">[]>;
  readonly objectiveSpend?: ReadonlyMap<string, SpendUsage>;
}): OrganizationStatus {
  const placements = input.runningAttempts.map((attempt) => ({
    taskId: attempt.taskId,
    ...attemptPlacement(attempt),
  }));
  const workerHosts = input.workerHosts
    .filter((host) => host.status.phase !== "revoked")
    .map((host) => {
      const id = host.metadata.id;
      const diskWarning = lowDiskWarning(host.status.diskSpace);
      const onHost = placements.filter((placement) => placement.workerHostId === id);
      const loads = new Map<
        string,
        { running: number; capacity: number; coordinationCapacity: number }
      >();
      let coordinationCapacity = 0;
      for (const worker of host.status.workers) {
        const ownerSlot = worker.profileCapabilities?.some((profile) =>
          profile.capabilities?.some(
            (capability) =>
              capability.id === COORDINATION_CAPABILITY.id &&
              capability.version === COORDINATION_CAPABILITY.version,
          ),
        )
          ? 1
          : 0;
        coordinationCapacity += ownerSlot;
        // A Worker serving several harnesses shares one capacity, so it is shown under all of them.
        const harnesses = [
          ...new Set(
            (worker.profileCapabilities ?? []).flatMap((entry) =>
              entry.harness === undefined ? [] : [entry.harness],
            ),
          ),
        ].toSorted();
        const served = harnesses.length ? harnesses : [worker.type];
        const ids = new Set([worker.id, `${id}/${worker.id}`]);
        const onWorker = onHost.filter(
          (placement) => placement.workerId !== undefined && ids.has(placement.workerId),
        );
        // A Worker serving several harnesses counts its capacity under each of them, and each
        // running Attempt under the harness it runs on.
        for (const harness of served) {
          const load = loads.get(harness) ?? {
            running: 0,
            capacity: 0,
            coordinationCapacity: 0,
          };
          load.capacity += (worker.maxConcurrency ?? 1) + ownerSlot;
          load.coordinationCapacity += ownerSlot;
          load.running += onWorker.filter((placement) =>
            placement.harness === undefined ? harness === served[0] : placement.harness === harness,
          ).length;
          loads.set(harness, load);
        }
      }
      return {
        id,
        phase: host.status.phase,
        running: onHost.length,
        capacity: host.status.capacity + coordinationCapacity,
        coordinationCapacity,
        harnesses: [...loads]
          .map(([harness, load]) => ({ harness, ...load }))
          .toSorted((left, right) => left.harness.localeCompare(right.harness)),
        ...(host.status.diskSpace === undefined
          ? {}
          : {
              diskSpace: host.status.diskSpace,
              ...(diskWarning === undefined ? {} : { diskWarning }),
            }),
      };
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const busy = new Map<string, Set<string>>();
  for (const placement of placements) {
    const tagId = input.taskTagIds.get(placement.taskId);
    if (tagId === undefined) continue;
    busy.set(tagId, (busy.get(tagId) ?? new Set()).add(placement.taskId));
  }
  const tagNames = new Map(input.tags.map((tag) => [tag.id, tag.name]));
  const tags = input.tags
    .filter((tag) => tag.status !== "retired")
    .map((tag) => {
      const runningTaskIds = [...(busy.get(tag.id) ?? [])].toSorted();
      return {
        id: tag.id,
        name: tag.name,
        runningTaskIds,
        runningCommands: runningTaskIds.flatMap((taskId) => {
          const running = input.runningCommands?.get(taskId);
          return running === undefined ? [] : [{ taskId, ...running }];
        }),
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const objectives = input.objectives
    .filter((objective) => objective.status !== "completed" && objective.status !== "cancelled")
    .toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )
    .map((objective) => {
      const reported = objective.limitState?.reportedSpend;
      const usage = input.objectiveSpend?.get(objective.id);
      const unpricedAttempts = Object.values(usage?.unpricedModels ?? {}).reduce(
        (a, b) => a + b,
        0,
      );
      return {
        id: objective.id,
        status: objective.status,
        ownerTagId: objective.ownerTagId,
        ownerName: tagNames.get(objective.ownerTagId) ?? objective.ownerTagId,
        deadline: objective.deadline ?? null,
        spentMinor: reported?.amountMinor ?? 0,
        budgetLimitMinor: objective.budgetLimitMinor ?? null,
        currency: objective.budgetCurrency ?? null,
        spendCurrency: reported?.currency ?? objective.budgetCurrency ?? null,
        ...(unpricedAttempts > 0
          ? { unpricedAttempts, unpricedTokens: usage?.unpricedTokens ?? 0 }
          : {}),
        highFindings: (input.objectiveTasks?.get(objective.id) ?? []).flatMap((task) =>
          storedTaskFindings(task.result)
            .filter((finding) => finding.severity === "high")
            .map((finding) => ({
              taskId: task.id,
              id: finding.id,
              summary: finding.summary,
              ...(finding.location ? { location: finding.location } : {}),
            })),
        ),
      };
    });
  return { asOf: input.asOf, workerHosts, tags, objectives };
}

function attemptPlacement(attempt: TaskAttempt): {
  readonly workerHostId?: string;
  readonly workerId?: string;
  readonly harness?: string;
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
  const harness = text(snapshot["harness"]) ?? text(placement["harness"]);
  return {
    ...(harness === undefined ? {} : { harness }),
    ...(workerHostId === undefined ? {} : { workerHostId }),
    ...(workerId === undefined ? {} : { workerId }),
  };
}
