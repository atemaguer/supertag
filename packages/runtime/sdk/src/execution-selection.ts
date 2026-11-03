import { randomUUID } from "node:crypto";
import type {
  TagContextPlan,
  TaskExecutionRequirements,
  UnsandboxedCommandHold,
} from "@supertag/core";
import {
  COORDINATION_CAPABILITY,
  NATIVE_AGENT_LIMIT_CAPABILITY,
  REPORTED_COST_LIMIT_CAPABILITY,
  REPORTED_TOKEN_LIMIT_CAPABILITY,
  SURFACE_COORDINATION_CAPABILITY,
  TASK_OUTPUT_POLICY_CAPABILITY,
  type WorkerDescriptor,
  type WorkerProfileRef,
} from "./execution-capabilities.js";
import type { SchedulableWorklet, Worklet } from "./index.js";
import { probeWorklet } from "./worklet-probe.js";

export interface ExecutionSelectionOptions {
  readonly requiresCoordination?: boolean;
  readonly requiresSurfaceCoordination?: boolean;
  /**
   * The placement is for an Objective owner's activation, which may also use each Worker's
   * coordination slot: one slot beyond its maxConcurrency that delegated work never uses.
   */
  readonly coordinationSlot?: boolean;
  readonly compatibleProfile?: WorkerProfileRef;
  /** Worker Hosts authorized by the Tag binding. Empty means no placement is eligible. */
  readonly allowedWorkerHostIds?: readonly string[];
}

/**
 * Task Attempts a Worker may run at once for one placement: its maxConcurrency, plus the
 * coordination slot when the placement is for an Objective owner's activation. Owners therefore
 * start even when delegated Tasks fill every slot, including on a single-slot Worker.
 */
export function workerSlots(
  worker: Pick<WorkerDescriptor, "maxConcurrency">,
  coordinationSlot: boolean | undefined,
): number {
  return (worker.maxConcurrency ?? 1) + (coordinationSlot ? 1 : 0);
}

/** A host-local scheduling decision returned to the Control Plane before Attempt creation. */
export interface WorkletExecutionPlacement {
  readonly workerHostId: string;
  readonly workletId: string;
  readonly workerId: string;
  readonly workerProfile: WorkerProfileRef;
  /** Expiring host-local capacity hold consumed by execution admission. */
  readonly reservation?: WorkletPlacementReservation;
}

export interface WorkletPlacementReservation {
  readonly id: string;
  readonly expiresAt: string;
}

interface PlacementReservationRecord extends WorkletPlacementReservation {
  readonly workerId: string;
  readonly workerProfile: WorkerProfileRef;
  readonly expiresAtMs: number;
}

export class WorkletPlacementReservations {
  readonly #entries = new Map<string, PlacementReservationRecord>();
  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new Error("Placement reservation TTL must be greater than zero");
  }
  count(workerId: string): number {
    this.#prune();
    return [...this.#entries.values()].filter((entry) => entry.workerId === workerId).length;
  }
  /** Earliest hold expiry for capacity a caller is waiting on, including an already-due hold. */
  nextExpiry(workerIds: readonly string[]): number | undefined {
    let earliest: number | undefined;
    for (const entry of this.#entries.values()) {
      if (workerIds.includes(entry.workerId))
        earliest = Math.min(earliest ?? entry.expiresAtMs, entry.expiresAtMs);
    }
    return earliest;
  }
  reserve(workerId: string, workerProfile: WorkerProfileRef): WorkletPlacementReservation {
    this.#prune();
    const expiresAtMs = this.now() + this.ttlMs;
    const entry: PlacementReservationRecord = {
      id: randomUUID(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      workerId,
      workerProfile: { ...workerProfile },
    };
    this.#entries.set(entry.id, entry);
    return { id: entry.id, expiresAt: entry.expiresAt };
  }
  release(reservation: WorkletPlacementReservation): void {
    this.#entries.delete(reservation.id);
  }
  consume(
    reservation: WorkletPlacementReservation,
    workerId: string,
    workerProfile: WorkerProfileRef,
  ): "accepted" | "expired" | "missing" | "mismatch" {
    const entry = this.#entries.get(reservation.id);
    if (!entry) return "missing";
    this.#entries.delete(reservation.id);
    if (entry.expiresAtMs <= this.now()) return "expired";
    if (
      reservation.expiresAt !== entry.expiresAt ||
      entry.workerId !== workerId ||
      entry.workerProfile.id !== workerProfile.id ||
      entry.workerProfile.revision !== workerProfile.revision
    )
      return "mismatch";
    return "accepted";
  }
  #prune(): void {
    const now = this.now();
    for (const [id, entry] of this.#entries) if (entry.expiresAtMs <= now) this.#entries.delete(id);
  }
}

export interface ExecutionCandidateMismatch {
  readonly workerId: string;
  readonly profile: WorkerProfileRef;
  /** Stable requirement paths the advertised profile cannot satisfy. */
  readonly unmetRequirements: readonly string[];
}

export interface ExecutionSelectionIncompatibility {
  readonly version: 1;
  readonly status: "incompatible";
  readonly unmetRequirements: readonly string[];
  readonly candidates: readonly ExecutionCandidateMismatch[];
  /** Host MCP servers whose `oauth: true` login lapsed; `supertag mcp login NAME` clears each. */
  readonly mcpLogins?: readonly string[];
  /**
   * Bound hosts whose matching harnesses run commands without a sandbox, for a Task granted
   * `commands:execute`; the host's `allow-unsandboxed-commands` setting clears each.
   */
  readonly unsandboxedCommands?: readonly UnsandboxedCommandHold[];
  /** Static Workspace provider refusals from otherwise eligible hosts. */
  readonly workspaceRefusals?: readonly string[];
}

export function descriptorSupportsExecution(
  descriptor: WorkerDescriptor,
  profile: WorkerProfileRef,
  requirements: TaskExecutionRequirements,
): boolean {
  if (!requirements || typeof requirements !== "object") return false;
  const selected = descriptorForProfile(descriptor, profile);
  if (!selected) return false;
  if (
    requirements.profile &&
    (requirements.profile.id !== profile.id || requirements.profile.revision !== profile.revision)
  )
    return false;
  if (
    requirements.harness &&
    !descriptor.profileCapabilities?.some(
      (entry) =>
        entry.profile.id === profile.id &&
        entry.profile.revision === profile.revision &&
        entry.harness === requirements.harness,
    )
  )
    return false;
  if (
    requirements.model !== undefined &&
    !profileServesModel(descriptor, profile, requirements.model)
  )
    return false;
  if (
    requirements.limits?.maxNativeAgents !== undefined &&
    !selected.capabilities.some(
      (capability) =>
        capability.id === NATIVE_AGENT_LIMIT_CAPABILITY.id &&
        capability.version === NATIVE_AGENT_LIMIT_CAPABILITY.version,
    )
  )
    return false;
  if (
    requirements.limits?.maxReportedTokens !== undefined &&
    !selected.capabilities.some(
      (capability) =>
        capability.id === REPORTED_TOKEN_LIMIT_CAPABILITY.id &&
        capability.version === REPORTED_TOKEN_LIMIT_CAPABILITY.version,
    )
  )
    return false;
  if (
    requirements.limits?.maxReportedCost !== undefined &&
    !selected.capabilities.some(
      (capability) =>
        capability.id === REPORTED_COST_LIMIT_CAPABILITY.id &&
        capability.version === REPORTED_COST_LIMIT_CAPABILITY.version,
    )
  )
    return false;
  if (
    requirements.outputs !== undefined &&
    !selected.capabilities.some(
      (capability) =>
        capability.id === TASK_OUTPUT_POLICY_CAPABILITY.id && capability.version === 1,
    )
  )
    return false;
  return (requirements.requires ?? []).every((required) =>
    selected.capabilities.some(
      (capability) => capability.id === required.id && capability.version === required.version,
    ),
  );
}

/**
 * Explain a structural scheduling failure independently of transient capacity.
 * Undefined means at least one advertised profile can satisfy the Task.
 */
export function explainDescriptorExecutionIncompatibility(
  workers: readonly WorkerDescriptor[],
  requirements: TaskExecutionRequirements,
  contextPlan: TagContextPlan,
  options: ExecutionSelectionOptions = {},
): ExecutionSelectionIncompatibility | undefined {
  let advertised = workers.flatMap((worker) =>
    worker.profiles.map((profile) => ({ worker, profile })),
  );
  // Discovery is open-ended: an exact profile or Harness that is not currently
  // advertised may still connect. Diagnose only after a relevant profile exists.
  for (const expected of [options.compatibleProfile, requirements.profile]) {
    if (!expected) continue;
    advertised = advertised.filter(
      ({ profile }) => profile.id === expected.id && profile.revision === expected.revision,
    );
    if (advertised.length === 0) return undefined;
  }
  if (!options.compatibleProfile && !requirements.profile && requirements.harness) {
    advertised = advertised.filter(({ worker, profile }) =>
      worker.profileCapabilities?.some(
        (entry) =>
          entry.profile.id === profile.id &&
          entry.profile.revision === profile.revision &&
          entry.harness === requirements.harness,
      ),
    );
    if (advertised.length === 0) return undefined;
  }
  if (advertised.length === 0) return undefined;
  const candidates = advertised
    .map(({ worker, profile }) => ({
      workerId: worker.id,
      profile,
      unmetRequirements: selectionMismatches(worker, profile, requirements, contextPlan, options),
    }))
    .toSorted(
      (a, b) =>
        a.workerId.localeCompare(b.workerId) ||
        a.profile.id.localeCompare(b.profile.id) ||
        a.profile.revision.localeCompare(b.profile.revision),
    );
  if (candidates.some((candidate) => candidate.unmetRequirements.length === 0)) return undefined;
  const unmetRequirements = [
    ...new Set(candidates.flatMap((candidate) => candidate.unmetRequirements)),
  ].toSorted();
  return { version: 1, status: "incompatible", unmetRequirements, candidates };
}

/**
 * Workers with at least one advertised profile that satisfies the Task, ignoring capacity. A
 * Task that has such Workers but no placement is waiting for a free slot.
 */
export function compatibleDescriptorWorkers(
  workers: readonly WorkerDescriptor[],
  requirements: TaskExecutionRequirements,
  contextPlan: TagContextPlan,
  options: ExecutionSelectionOptions = {},
): readonly WorkerDescriptor[] {
  return workers.filter((worker) =>
    worker.profiles.some(
      (profile) =>
        selectionMismatches(worker, profile, requirements, contextPlan, options).length === 0,
    ),
  );
}

function selectionMismatches(
  descriptor: WorkerDescriptor,
  profile: WorkerProfileRef,
  requirements: TaskExecutionRequirements,
  contextPlan: TagContextPlan,
  options: ExecutionSelectionOptions,
): string[] {
  const unmet = new Set<string>();
  const selected = descriptorForProfile(descriptor, profile);
  if (!selected) unmet.add("worker.profile-advertisement");
  if (
    requirements.profile &&
    (requirements.profile.id !== profile.id || requirements.profile.revision !== profile.revision)
  )
    unmet.add("execution.profile");
  if (
    requirements.harness &&
    !descriptor.profileCapabilities?.some(
      (entry) =>
        entry.profile.id === profile.id &&
        entry.profile.revision === profile.revision &&
        entry.harness === requirements.harness,
    )
  )
    unmet.add("execution.harness");
  if (
    requirements.model !== undefined &&
    !profileServesModel(descriptor, profile, requirements.model)
  )
    unmet.add("execution.model");
  if (requirements.outputs !== undefined)
    requireCapability(selected, TASK_OUTPUT_POLICY_CAPABILITY, "execution.outputs", unmet);
  if (requirements.limits?.maxNativeAgents !== undefined)
    requireCapability(
      selected,
      NATIVE_AGENT_LIMIT_CAPABILITY,
      "execution.limits.maxNativeAgents",
      unmet,
    );
  if (requirements.limits?.maxReportedTokens !== undefined)
    requireCapability(
      selected,
      REPORTED_TOKEN_LIMIT_CAPABILITY,
      "execution.limits.maxReportedTokens",
      unmet,
    );
  if (requirements.limits?.maxReportedCost !== undefined)
    requireCapability(
      selected,
      REPORTED_COST_LIMIT_CAPABILITY,
      "execution.limits.maxReportedCost",
      unmet,
    );
  for (const required of requirements.requires ?? [])
    requireCapability(
      selected,
      required,
      `execution.requires.${required.id}@${required.version}`,
      unmet,
    );
  for (const item of contextPlan.sets.flatMap((set) => set.items).filter((item) => item.required)) {
    if (
      !selected?.contextTypes.some(
        (support) => support.type === item.type && support.versions.includes(item.version),
      )
    )
      unmet.add(`context.${item.type}@${item.version}`);
  }
  if (
    options.compatibleProfile &&
    (options.compatibleProfile.id !== profile.id ||
      options.compatibleProfile.revision !== profile.revision)
  )
    unmet.add("execution.compatibleProfile");
  if (options.requiresCoordination && !descriptorSupportsCoordination(descriptor, profile))
    unmet.add("coordination");
  if (
    options.requiresSurfaceCoordination &&
    !descriptorSupportsSurfaceCoordination(descriptor, profile)
  )
    unmet.add("coordination.surface");
  return [...unmet].toSorted();
}

/** Whether the profile advertises the model. A profile that lists no models serves none by name. */
export function profileServesModel(
  descriptor: WorkerDescriptor,
  profile: WorkerProfileRef,
  model: string,
): boolean {
  return (
    descriptor.profileCapabilities?.some(
      (entry) =>
        entry.profile.id === profile.id &&
        entry.profile.revision === profile.revision &&
        entry.models?.includes(model) === true,
    ) ?? false
  );
}

/** The model a profile's harness uses when a Task names none: its first advertised model. */
export function profileDefaultModel(
  descriptor: WorkerDescriptor,
  profile: WorkerProfileRef,
): string | undefined {
  return descriptor.profileCapabilities?.find(
    (entry) => entry.profile.id === profile.id && entry.profile.revision === profile.revision,
  )?.models?.[0];
}

/** Whether the profile's harness applies a reasoning effort. */
export function profileAppliesEffort(
  descriptor: WorkerDescriptor,
  profile: WorkerProfileRef,
  effort: "low" | "medium" | "high",
): boolean {
  return (
    descriptor.profileCapabilities?.some(
      (entry) =>
        entry.profile.id === profile.id &&
        entry.profile.revision === profile.revision &&
        entry.efforts?.includes(effort) === true,
    ) ?? false
  );
}

function requireCapability(
  descriptor: WorkerDescriptor | undefined,
  capability: { readonly id: string; readonly version: number },
  path: string,
  unmet: Set<string>,
) {
  if (
    !descriptor?.capabilities.some(
      (advertised) => advertised.id === capability.id && advertised.version === capability.version,
    )
  )
    unmet.add(path);
}

export function executionPreferenceScore(
  descriptor: WorkerDescriptor,
  profile: WorkerProfileRef,
  requirements: TaskExecutionRequirements,
): number {
  const selected = descriptorForProfile(descriptor, profile);
  return (requirements.prefers ?? []).filter((preferred) =>
    selected?.capabilities.some(
      (capability) => capability.id === preferred.id && capability.version === preferred.version,
    ),
  ).length;
}

/** Select among advertised configurations; capacity-aware Worklets implement selectExecution. */
export async function selectWorkletExecution(
  worklet: Worklet,
  requirements: TaskExecutionRequirements,
  contextPlan: TagContextPlan,
  options: ExecutionSelectionOptions = {},
): Promise<WorkerProfileRef | undefined> {
  if (worklet.selectExecution) {
    const select = worklet.selectExecution.bind(worklet);
    const selected = await probeWorklet(() => select(requirements, contextPlan, options));
    if (selected === undefined) return undefined;
    const workers = (await probeWorklet(() => worklet.describe())).host.workers;
    return selectDescriptorExecution(
      workers.map((worker) => ({
        ...worker,
        profiles: worker.profiles.filter(
          (profile) => profile.id === selected.id && profile.revision === selected.revision,
        ),
      })),
      requirements,
      contextPlan,
      options,
    );
  }
  const workers = (await probeWorklet(() => worklet.describe())).host.workers;
  if ("canExecute" in worklet && typeof worklet.canExecute === "function") {
    const canExecute = worklet.canExecute.bind(worklet) as SchedulableWorklet["canExecute"];
    const available = await Promise.all(
      workers.map(async (worker) => ({
        ...worker,
        profiles: (
          await Promise.all(
            worker.profiles.map(async (profile) =>
              (await probeWorklet(() => canExecute(profile, contextPlan))) ? profile : undefined,
            ),
          )
        ).filter((profile): profile is WorkerProfileRef => profile !== undefined),
      })),
    );
    return selectDescriptorExecution(available, requirements, contextPlan, options);
  }
  return selectDescriptorExecution(workers, requirements, contextPlan, options);
}

export async function selectWorkletPlacement(
  worklet: Worklet,
  requirements: TaskExecutionRequirements,
  contextPlan: TagContextPlan,
  options: ExecutionSelectionOptions = {},
): Promise<WorkletExecutionPlacement | undefined> {
  if (worklet.selectPlacement) {
    const placement = await probeWorklet(() =>
      worklet.selectPlacement?.(requirements, contextPlan, options),
    );
    if (!placement) return undefined;
    if (
      options.allowedWorkerHostIds !== undefined &&
      !options.allowedWorkerHostIds.includes(placement.workerHostId)
    )
      return undefined;
    return placement;
  }
  const workerProfile = await selectWorkletExecution(worklet, requirements, contextPlan, options);
  if (!workerProfile) return undefined;
  const descriptor = await probeWorklet(() => worklet.describe());
  const worker = descriptor.host.workers.find((candidate) =>
    candidate.profiles.some(
      (profile) => profile.id === workerProfile.id && profile.revision === workerProfile.revision,
    ),
  );
  if (!worker) return undefined;
  return {
    workerHostId: descriptor.host.id,
    workletId: descriptor.id,
    workerId: worker.id,
    workerProfile,
  };
}

export function selectDescriptorExecution(
  workers: readonly WorkerDescriptor[],
  requirements: TaskExecutionRequirements,
  contextPlan: TagContextPlan,
  options: ExecutionSelectionOptions = {},
  active: (workerId: string) => number = () => 0,
): WorkerProfileRef | undefined {
  return workers
    .flatMap((worker) => worker.profiles.map((profile) => ({ worker, profile })))
    .filter(
      ({ worker, profile }) =>
        active(worker.id) < workerSlots(worker, options.coordinationSlot) &&
        descriptorSupportsExecution(worker, profile, requirements) &&
        (!options.compatibleProfile ||
          (profile.id === options.compatibleProfile.id &&
            profile.revision === options.compatibleProfile.revision)) &&
        descriptorSupportsRequiredContext(worker, contextPlan, profile) &&
        (!options.requiresCoordination || descriptorSupportsCoordination(worker, profile)) &&
        (!options.requiresSurfaceCoordination ||
          descriptorSupportsSurfaceCoordination(worker, profile)),
    )
    .sort(
      (a, b) =>
        executionPreferenceScore(b.worker, b.profile, requirements) -
          executionPreferenceScore(a.worker, a.profile, requirements) ||
        active(a.worker.id) / (a.worker.maxConcurrency ?? 1) -
          active(b.worker.id) / (b.worker.maxConcurrency ?? 1) ||
        a.worker.id.localeCompare(b.worker.id) ||
        a.profile.id.localeCompare(b.profile.id) ||
        a.profile.revision.localeCompare(b.profile.revision),
    )[0]?.profile;
}

/** Resolve only explicit profile-local claims. */
export function descriptorForProfile(
  descriptor: WorkerDescriptor,
  profile: WorkerProfileRef,
): WorkerDescriptor | undefined {
  if (
    !descriptor.profiles.some(
      (candidate) => candidate.id === profile.id && candidate.revision === profile.revision,
    )
  )
    return undefined;
  if (!Array.isArray(descriptor.profileCapabilities))
    throw new Error(`Worker ${descriptor.id} must declare profileCapabilities`);
  const matches = descriptor.profileCapabilities.filter(
    (candidate) =>
      candidate.profile.id === profile.id && candidate.profile.revision === profile.revision,
  );
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (!match) return undefined;
  return { ...descriptor, capabilities: match.capabilities, contextTypes: match.contextTypes };
}
export function descriptorSupportsSurfaceCoordination(
  descriptor: WorkerDescriptor,
  profile: WorkerProfileRef,
): boolean {
  const selected = descriptorForProfile(descriptor, profile);
  return (
    selected?.capabilities.some(
      (capability) =>
        capability.id === SURFACE_COORDINATION_CAPABILITY.id &&
        capability.version === SURFACE_COORDINATION_CAPABILITY.version,
    ) ?? false
  );
}
export function descriptorSupportsCoordination(
  descriptor: WorkerDescriptor,
  profile: WorkerProfileRef,
): boolean {
  const selected = descriptorForProfile(descriptor, profile);
  return (
    selected?.capabilities.some(
      (capability) =>
        capability.id === COORDINATION_CAPABILITY.id &&
        capability.version === COORDINATION_CAPABILITY.version,
    ) ?? false
  );
}
export function descriptorSupportsRequiredContext(
  descriptor: WorkerDescriptor,
  plan: TagContextPlan,
  profile: WorkerProfileRef,
): boolean {
  const selected = descriptorForProfile(descriptor, profile);
  if (!selected) return false;
  return plan.sets
    .flatMap((set) => set.items)
    .filter((item) => item.required)
    .every((item) =>
      selected.contextTypes.some(
        (support) => support.type === item.type && support.versions.includes(item.version),
      ),
    );
}
