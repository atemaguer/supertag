import { createHash } from "node:crypto";
import {
  canResumeSessionAfterInput,
  type DurableInboundEvent,
  type Store,
  type TagContextPlan,
  type Task,
  type TaskExecutionRequirements,
  type WorkerProfileRef,
} from "@supertag/core";
import {
  compatibleDescriptorWorkers,
  type SessionStateRef,
  type TaskAttemptEvent,
  type WorkerDescriptor,
  type WorkletDescriptor,
} from "@supertag/worker-sdk";

type Persistence = Pick<
  Store,
  | "findLatestSessionExecutionTask"
  | "findTaskById"
  | "findInboundEventById"
  | "listTaskAttempts"
  | "findSessionState"
  | "listSessionStates"
  | "promoteSessionState"
  | "hasUnconfirmedTeamLiveDelivery"
>;

/**
 * Each SuperTag Session maps to one native harness session. Its latest native state resumes for
 * the same Tag, Session and reply audience, on the harness that produced it; that harness's own
 * state check is the final gate. Permissions, Roles, Context Sets, the Workspace plan and
 * execution settings are not part of the gate: every turn runs under the policy and tools
 * admitted for its own Task, so resuming never carries earlier authority forward.
 */
export class SessionContinuity {
  constructor(private readonly store: Persistence) {}

  /**
   * Live input joins an Attempt that is already running under the active Task's authority, so it
   * also requires the same admitted policy, not only the same Session audience.
   */
  acceptsInput(
    active: { work: DurableInboundEvent; task: Task; workerProfile: WorkerProfileRef },
    incoming: { work: DurableInboundEvent; task: Task },
  ): boolean {
    return (
      incoming.task.surfaceObjectiveId === active.task.surfaceObjectiveId &&
      stableJson(admittedPolicy(incoming.task)) === stableJson(admittedPolicy(active.task)) &&
      sessionCompatibility(incoming.task, surfaceAudience(incoming.work)) ===
        sessionCompatibility(active.task, surfaceAudience(active.work)) &&
      stableJson(incoming.work.event.callback.target) ===
        stableJson(active.work.event.callback.target)
    );
  }

  /** The profile, and its harness, that produced the Session's latest resumable state. */
  async preferredProfile(
    _work: DurableInboundEvent,
    task: Task,
  ): Promise<{ readonly workerProfile: WorkerProfileRef; readonly harnessId: string } | undefined> {
    const state = await this.#latestCompatible(task);
    return state?.workerProfile
      ? { workerProfile: state.workerProfile, harnessId: state.harnessId }
      : undefined;
  }

  async read(
    _work: DurableInboundEvent,
    task: Task,
    harnessId?: string,
  ): Promise<SessionStateRef | undefined> {
    return this.readTask(task, undefined, harnessId);
  }

  /**
   * The Session's latest resumable native state. Given a harness, state another harness produced
   * is not offered. Any profile of the same harness may resume it.
   */
  async readTask(
    task: Task,
    activeAttemptId?: string,
    harnessId?: string,
  ): Promise<SessionStateRef | undefined> {
    const state = await this.#latestCompatible(task, activeAttemptId);
    if (!state || (harnessId !== undefined && state.harnessId !== harnessId)) return undefined;
    return state.ref as unknown as SessionStateRef;
  }

  async #latestCompatible(task: Task, activeAttemptId?: string) {
    const compatibility = await this.compatibility(task);
    if (!compatibility) return undefined;
    for await (const state of this.latest(task, activeAttemptId)) {
      const stored = state.compatibility?.startsWith("budget:")
        ? state.compatibility.slice("budget:".length)
        : state.compatibility;
      if (stored === compatibility) return state;
    }
    return undefined;
  }

  async save(
    _work: DurableInboundEvent,
    task: Task,
    profile: WorkerProfileRef,
    events: readonly TaskAttemptEvent[],
    _createdAt: string,
  ): Promise<void> {
    return this.saveTask(task, profile, events);
  }

  async saveTask(
    task: Task,
    profile: WorkerProfileRef,
    events: readonly TaskAttemptEvent[],
  ): Promise<void> {
    const updated = events.findLast((event) => event.type === "session.updated");
    if (updated?.type !== "session.updated") return;
    // Only an explicit, archived budget stop may promote interrupted native state.
    const terminal = events.findLast(
      (event) =>
        event.attemptId === updated.attemptId &&
        (event.type === "execution.completed" || event.type === "execution.failed"),
    );
    const exhausted =
      terminal?.type === "execution.failed" &&
      terminal.error.name === "ExecutionBudgetExceededError";
    if (terminal?.type !== "execution.completed" && !exhausted) return;
    // The digest is authoritative for withdrawn or uncertain input. Adapters may still archive
    // a transcript containing it; never resume that copy alongside the next activation's digest.
    // Query the whole Attempt, not the bounded Objective delivery list used by operator views.
    if (
      !canResumeSessionAfterInput(
        task.id,
        updated.attemptId,
        events,
        await this.store.hasUnconfirmedTeamLiveDelivery(task.id, updated.attemptId),
      )
    )
      return;
    const state = await this.store.findSessionState(updated.sessionState.id);
    if (!state || stableJson(state.ref) !== stableJson(updated.sessionState))
      throw new Error("Native Session state was not durably archived");
    const compatibility = await this.compatibility(task);
    if (!compatibility) throw new Error("Native Session audience is unavailable");
    await this.store.promoteSessionState({
      id: state.id,
      taskId: task.id,
      attemptId: updated.attemptId,
      compatibility: exhausted ? `budget:${compatibility}` : compatibility,
      workerProfile: profile,
    });
  }

  async compatibility(task: Task): Promise<string | undefined> {
    // Read the immutable admitted audience for every caller, including execution-only HTTP loads.
    if (task.inboundEventId) {
      const work = await this.store.findInboundEventById(task.inboundEventId);
      if (!work || work.tagId !== task.tagId) return undefined;
      return sessionCompatibility(task, surfaceAudience(work));
    }
    if (task.authorizationSnapshot.version === 5) return undefined;
    return sessionCompatibility(task);
  }

  private async *latest(task: Task, activeAttemptId?: string) {
    const currentAttempts = activeAttemptId ? await this.store.listTaskAttempts(task.id) : [];
    const predecessor = currentAttempts
      .filter((attempt) => attempt.id !== activeAttemptId)
      .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
    const source = predecessor
      ? task
      : await this.store.findLatestSessionExecutionTask(task.sessionId, task.id);
    if (!source || (!predecessor && source.status !== "completed")) return;
    const attempts = predecessor ? [predecessor] : await this.store.listTaskAttempts(source.id);
    const latest = attempts.slice().sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
    if (
      latest?.status !== "completed" &&
      !(predecessor && (latest?.status === "cancelled" || latest?.status === "failed"))
    )
      return;
    const states = await this.store.listSessionStates({
      sessionId: task.sessionId,
      taskId: source.id,
      limit: 100,
    });
    for (const state of states) {
      if (state.attemptId !== latest.id || state.status !== "resumable" || !validRef(state.ref))
        continue;
      // Only fenced wait settlement adds this marker. A normally promoted state followed by
      // external cancellation must not become a resumable cancelled predecessor.
      const suspended = state.compatibility?.startsWith("wait:") === true;
      if (latest.status === "cancelled" && !suspended) continue;
      if (latest.status === "failed" && !state.compatibility?.startsWith("budget:")) continue;
      if (latest.status !== "failed" && state.compatibility?.startsWith("budget:")) continue;
      yield suspended ? { ...state, compatibility: (state.compatibility ?? "").slice(5) } : state;
    }
  }
}

/**
 * Hash only what makes saved native state unsafe to resume: the Tag, the Session and the reply
 * audience. Policy, prompts, timestamps and derived conversation history are not part of it.
 */
export function sessionCompatibility(
  task: Task,
  replyAudience?: Readonly<Record<string, unknown>>,
): string {
  return `sha256:${createHash("sha256")
    .update(
      stableJson({
        version: 4,
        tagId: task.tagId,
        sessionId: task.sessionId,
        audience: task.authorizationSnapshot.origin,
        replyAudience,
      }),
    )
    .digest("hex")}`;
}

/** The harness a Worker advertises for a profile, if any. */
export function profileHarness(
  workers: readonly WorkerDescriptor[],
  profile: WorkerProfileRef,
): string | undefined {
  for (const worker of workers)
    for (const entry of worker.profileCapabilities ?? [])
      if (
        entry.harness !== undefined &&
        entry.profile.id === profile.id &&
        entry.profile.revision === profile.revision
      )
        return entry.harness;
  return undefined;
}

/** One placement tier's Session constraint; `undefined` skips the tier. */
export type SessionPlacementChoice =
  | {
      readonly requirements: TaskExecutionRequirements;
      readonly compatibleProfile?: WorkerProfileRef;
    }
  | undefined;

/** One placement tier: the hosts it allows and the requirements it adds. */
export interface SessionPlacementTier {
  readonly allowedWorkerHostIds: readonly string[];
  readonly requirements: TaskExecutionRequirements;
}

/**
 * Narrows placement to the profile that produced the Session's native state or, when no tier
 * can run that profile, to another profile of the same harness. The decision is made once
 * across every tier, so an earlier tier without the harness cannot replay the Session while a
 * later tier could resume it. A matching but busy profile waits for capacity, since another
 * harness could only replay. With no match in any tier, placement is unconstrained and the
 * Session continues from replay. A tier that cannot satisfy the decision returns `undefined`
 * and is skipped.
 */
export function sessionPlacement(
  descriptor: WorkletDescriptor,
  tiers: readonly SessionPlacementTier[],
  contextPlan: TagContextPlan,
  preferred: { readonly workerProfile: WorkerProfileRef; readonly harnessId: string },
): readonly SessionPlacementChoice[] {
  const tierWorkers = (tier: SessionPlacementTier) =>
    descriptor.host.workers.filter((worker) =>
      tier.allowedWorkerHostIds.some(
        (workerHostId) =>
          descriptor.host.id === workerHostId || worker.id.startsWith(`${workerHostId}/`),
      ),
    );
  const compatibleProfile = preferred.workerProfile;
  if (
    tiers.some(
      (tier) =>
        compatibleDescriptorWorkers(tierWorkers(tier), tier.requirements, contextPlan, {
          compatibleProfile,
        }).length > 0,
    )
  )
    return tiers.map((tier) => ({ requirements: tier.requirements, compatibleProfile }));
  const sameHarness = (tier: SessionPlacementTier): TaskExecutionRequirements | undefined =>
    tier.requirements.profile ||
    (tier.requirements.harness && tier.requirements.harness !== preferred.harnessId)
      ? undefined
      : { ...tier.requirements, harness: preferred.harnessId };
  if (
    tiers.some((tier) => {
      const requirements = sameHarness(tier);
      return (
        requirements !== undefined &&
        compatibleDescriptorWorkers(tierWorkers(tier), requirements, contextPlan).length > 0
      );
    })
  )
    return tiers.map((tier) => {
      const requirements = sameHarness(tier);
      return requirements === undefined ? undefined : { requirements };
    });
  return tiers.map((tier) => ({ requirements: tier.requirements }));
}

/** The authority a running Attempt was admitted with; live input must not change it. */
function admittedPolicy(task: Task): unknown {
  const authorization = task.authorizationSnapshot;
  return {
    roles: authorization.roles ?? [],
    permissionSets: authorization.permissionSets,
    resources: authorization.resources,
    runtimeActions: authorization.runtimeActions,
    mcp: authorization.mcp,
    approvals: authorization.approvals,
    contextSets: task.contextPlan.sets,
    workspace: task.workspacePlan,
    execution: task.execution,
  };
}

function surfaceAudience(work: DurableInboundEvent): Readonly<Record<string, unknown>> {
  return {
    provider: work.event.provider,
    surfaceAccountId: work.surfaceAccountId,
    scope: work.event.scope,
    sessionKey: work.event.sessionKey,
    callback: work.event.callback,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, canonical(value)]),
  );
}

function validRef(value: Readonly<Record<string, unknown>>): boolean {
  if (
    typeof value["id"] !== "string" ||
    !value["id"] ||
    typeof value["format"] !== "string" ||
    !value["format"] ||
    typeof value["uri"] !== "string"
  )
    return false;
  if (
    value["provenance"] !== undefined &&
    (!value["provenance"] ||
      typeof value["provenance"] !== "object" ||
      Array.isArray(value["provenance"]))
  )
    return false;
  try {
    new URL(value["uri"]);
    return true;
  } catch {
    return false;
  }
}
