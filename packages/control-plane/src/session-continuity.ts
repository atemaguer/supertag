import { createHash } from "node:crypto";
import {
  canResumeSessionAfterInput,
  type DurableInboundEvent,
  type Store,
  type Task,
  type WorkerProfileRef,
} from "@supertag/core";
import type { SessionStateRef, TaskAttemptEvent } from "@supertag/worker-sdk";

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

/** Session-owned native state with explicit, policy-compatible recovery boundaries. */
export class SessionContinuity {
  constructor(private readonly store: Persistence) {}

  acceptsInput(
    active: { work: DurableInboundEvent; task: Task; workerProfile: WorkerProfileRef },
    incoming: { work: DurableInboundEvent; task: Task },
  ): boolean {
    return (
      incoming.task.surfaceObjectiveId === active.task.surfaceObjectiveId &&
      stableJson(incoming.task.execution) === stableJson(active.task.execution) &&
      sessionCompatibility(incoming.task, active.workerProfile, surfaceAudience(incoming.work)) ===
        sessionCompatibility(active.task, active.workerProfile, surfaceAudience(active.work)) &&
      stableJson(incoming.work.event.callback.target) ===
        stableJson(active.work.event.callback.target)
    );
  }

  async preferredProfile(
    _work: DurableInboundEvent,
    task: Task,
  ): Promise<WorkerProfileRef | undefined> {
    for await (const state of this.latest(task)) {
      if (
        state.workerProfile &&
        state.compatibility === (await this.compatibility(task, state.workerProfile))
      )
        return state.workerProfile;
    }
    return undefined;
  }

  async read(
    _work: DurableInboundEvent,
    task: Task,
    profile: WorkerProfileRef,
  ): Promise<SessionStateRef | undefined> {
    return this.readTask(task, profile);
  }

  async readTask(
    task: Task,
    profile: WorkerProfileRef,
    activeAttemptId?: string,
  ): Promise<SessionStateRef | undefined> {
    const compatibility = await this.compatibility(task, profile);
    if (!compatibility) return undefined;
    for await (const state of this.latest(task, activeAttemptId)) {
      if (
        state.workerProfile?.id === profile.id &&
        state.workerProfile.revision === profile.revision &&
        state.compatibility ===
          (state.compatibility?.startsWith("budget:")
            ? `budget:${await this.compatibility(withoutBudgetLimits(task), profile)}`
            : compatibility)
      )
        return state.ref as unknown as SessionStateRef;
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
    const compatibility = await this.compatibility(
      exhausted ? withoutBudgetLimits(task) : task,
      profile,
    );
    if (!compatibility) throw new Error("Native Session audience is unavailable");
    await this.store.promoteSessionState({
      id: state.id,
      taskId: task.id,
      attemptId: updated.attemptId,
      compatibility: exhausted ? `budget:${compatibility}` : compatibility,
      workerProfile: profile,
    });
  }

  async compatibility(task: Task, profile: WorkerProfileRef): Promise<string | undefined> {
    // Read the immutable admitted audience for every caller, including execution-only HTTP loads.
    if (task.inboundEventId) {
      const work = await this.store.findInboundEventById(task.inboundEventId);
      if (!work || work.tagId !== task.tagId) return undefined;
      return sessionCompatibility(task, profile, surfaceAudience(work));
    }
    if (task.authorizationSnapshot.version === 5) return undefined;
    return sessionCompatibility(task, profile);
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

/** Hash policy, not changing prompts, timestamps or derived conversation history. */
export function sessionCompatibility(
  task: Task,
  workerProfile: WorkerProfileRef,
  replyAudience?: Readonly<Record<string, unknown>>,
): string {
  const authorization = task.authorizationSnapshot;
  return `sha256:${createHash("sha256")
    .update(
      stableJson({
        version: 3,
        tagId: task.tagId,
        sessionId: task.sessionId,
        workerProfile,
        audience: authorization.origin,
        replyAudience,
        roles: authorization.roles ?? [],
        permissionSets: authorization.permissionSets,
        resources: authorization.resources,
        runtimeActions: authorization.runtimeActions,
        // Omitted when absent, so Sessions without MCP grants keep their compatibility.
        ...(authorization.mcp === undefined ? {} : { mcp: authorization.mcp }),
        contextSets: task.contextPlan.sets,
        workspace: task.workspacePlan,
        execution: task.execution,
      }),
    )
    .digest("hex")}`;
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

/** A renewed spending allocation changes no tool authority or execution topology. */
function withoutBudgetLimits(task: Task): Task {
  const {
    maxReportedTokens: _tokens,
    maxReportedCost: _cost,
    ...limits
  } = task.execution.limits ?? {};
  const { limits: _limits, ...execution } = task.execution;
  return {
    ...task,
    execution: { ...execution, ...(Object.keys(limits).length ? { limits } : {}) },
  };
}
