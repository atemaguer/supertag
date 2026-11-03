import {
  parseTaskExecutionRequirements,
  type TagContextPlan,
  type TaskExecutionRequirements,
} from "@supertag/core";
import {
  type ExecutionSelectionOptions,
  selectWorkletPlacement,
  type Worklet,
  type WorkletExecutionPlacement,
} from "@supertag/worker-sdk";

/** Disposable scheduling hints. Every hit goes through current eligibility and capacity checks. */
export class ExecutionAffinityCache {
  private readonly entries = new Map<
    string,
    { placement: WorkletExecutionPlacement; expiresAt: number }
  >();
  constructor(
    private readonly maximumEntries = 1000,
    private readonly ttlMs = 300_000,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !Number.isSafeInteger(maximumEntries) ||
      maximumEntries < 1 ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0
    )
      throw new Error("Invalid execution affinity cache bounds");
  }

  async select(
    worklet: Worklet,
    tagId: string,
    requirements: TaskExecutionRequirements,
    contextPlan: TagContextPlan,
    options: ExecutionSelectionOptions = {},
  ): Promise<WorkletExecutionPlacement | undefined> {
    const normalized = parseTaskExecutionRequirements(requirements);
    // An explicit profile is already a hard selection; probing the identical hint
    // again when busy adds no alternative and needlessly doubles scheduling work.
    if (normalized.profile)
      return selectWorkletPlacement(worklet, normalized, contextPlan, options);
    const key = JSON.stringify([
      tagId,
      {
        ...normalized,
        requires: normalized.requires?.toSorted(compareCapability) ?? [],
        prefers: normalized.prefers?.toSorted(compareCapability) ?? [],
      },
      options.allowedWorkerHostIds?.toSorted() ?? null,
      options.requiresCoordination ?? false,
      options.coordinationSlot ?? false,
      options.requiresSurfaceCoordination ?? false,
      options.compatibleProfile ?? null,
    ]);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      if (cached.expiresAt > this.now()) {
        const eligible = await selectWorkletPlacement(
          worklet,
          { ...normalized, profile: cached.placement.workerProfile },
          contextPlan,
          options,
        );
        if (eligible) {
          this.entries.set(key, cached);
          return eligible;
        }
      }
    }
    const selected = await selectWorkletPlacement(worklet, normalized, contextPlan, options);
    if (selected) {
      this.entries.delete(key);
      this.entries.set(key, {
        placement: { ...selected, workerProfile: { ...selected.workerProfile } },
        expiresAt: this.now() + this.ttlMs,
      });
      while (this.entries.size > this.maximumEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    return selected;
  }
}
function compareCapability(
  a: { id: string; version: number },
  b: { id: string; version: number },
): number {
  return a.id.localeCompare(b.id) || a.version - b.version;
}
