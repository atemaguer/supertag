import {
  assertExecutionInRange,
  defaultExecution,
  ExecutionRangeError,
  type ExecutionSelection,
  type ExecutionSettings,
  ExecutionUnchangedError,
  escalateExecution,
  escalatesExecution,
  isExecutionEffort,
  type ResolvedExecution,
  selfEscalateExecution,
  TagMessagingError,
  type TaskExecutionRequirements,
} from "@supertag/core";
import {
  descriptorSupportsExecution,
  profileAppliesEffort,
  profileDefaultModel,
  type WorkerDescriptor,
  type WorkerProfileRef,
} from "@supertag/worker-sdk";

/** Event recording a Task's resolved execution and why, appended when SuperTag accepts it. */
export const EXECUTION_RESOLVED_EVENT = "task.execution-resolved";

/** A finished Task whose outcome may raise the next Task's execution. */
export interface EscalationSource {
  readonly taskId: string;
  readonly status: string;
  readonly result?: Readonly<Record<string, unknown>> | null;
  /** The source Task's resolved execution. */
  readonly execution: ResolvedExecution;
}

/**
 * Resolves one Task's harness, model, and effort when SuperTag accepts it. A model or effort the
 * delegating actor chose wins and must fall within the Tag's range. Otherwise a failed or
 * rejected source Task raises the selection one step; otherwise the range's defaults apply.
 */
export function resolveTaskExecution(input: {
  readonly range: ExecutionSettings;
  readonly requested: TaskExecutionRequirements;
  /** The delegating actor's choice, or nothing for work SuperTag starts itself. */
  readonly chosen: { readonly model?: string; readonly effort?: ResolvedExecution["effort"] };
  readonly chosenByTagId?: string;
  readonly source?: EscalationSource;
  readonly subject: string;
}): { readonly execution: TaskExecutionRequirements; readonly selection: ExecutionSelection } {
  const { range, chosen } = input;
  const { model: _model, effort: _effort, ...rest } = input.requested;
  try {
    assertExecutionInRange(
      range,
      {
        ...(rest.harness === undefined ? {} : { harness: rest.harness }),
        ...(chosen.model === undefined ? {} : { model: chosen.model }),
        ...(chosen.effort === undefined ? {} : { effort: chosen.effort }),
      },
      input.subject,
    );
  } catch (error) {
    if (error instanceof ExecutionRangeError) throw new TagMessagingError(400, error.message);
    throw error;
  }
  const defaults = defaultExecution(range);
  const harness = rest.harness ?? defaults.harness;
  let selection: ExecutionSelection;
  if (chosen.model !== undefined || chosen.effort !== undefined) {
    const model = chosen.model ?? defaults.model;
    const effort = chosen.effort ?? defaults.effort;
    selection = {
      source: "chosen",
      ...(input.chosenByTagId === undefined ? {} : { chosenByTagId: input.chosenByTagId }),
      ...(harness === undefined ? {} : { harness }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    };
  } else if (input.source !== undefined && escalatesExecution(input.source)) {
    const step = escalateExecution(range, {
      ...input.source.execution,
      ...(harness === undefined ? {} : { harness }),
    });
    selection = {
      source: "escalated",
      ...step.execution,
      escalatedFromTaskId: input.source.taskId,
      ...(step.change === undefined ? { escalationExhausted: true } : { escalation: step.change }),
    };
  } else
    selection = {
      source: "default",
      ...defaults,
      ...(harness === undefined ? {} : { harness }),
    };
  return {
    execution: {
      ...rest,
      ...(selection.harness === undefined ? {} : { harness: selection.harness }),
      ...(selection.model === undefined ? {} : { model: selection.model }),
      ...(selection.effort === undefined ? {} : { effort: selection.effort }),
    },
    selection,
  };
}

/**
 * Validates an escalate_task request from the actor working a Task: an effort, a model, or both,
 * inside the Tag's allowed range and different from what the Task runs with now. Returns the
 * Task's next execution and a readable change such as `effort low → high`.
 */
export function resolveSelfEscalation(input: {
  readonly range: ExecutionSettings;
  readonly current: TaskExecutionRequirements;
  readonly effort: unknown;
  readonly model: unknown;
  readonly subject: string;
}): { readonly execution: TaskExecutionRequirements; readonly change: string } {
  const { effort, model } = input;
  if (effort !== undefined && !isExecutionEffort(effort))
    throw new TagMessagingError(400, "effort must be low, medium, or high");
  if (
    model !== undefined &&
    (typeof model !== "string" || !model.trim() || model.trim().length > 200)
  )
    throw new TagMessagingError(400, "model must be a model name");
  try {
    const next = selfEscalateExecution(
      input.range,
      {
        ...(input.current.model === undefined ? {} : { model: input.current.model }),
        ...(input.current.effort === undefined ? {} : { effort: input.current.effort }),
      },
      {
        ...(effort === undefined ? {} : { effort }),
        ...(model === undefined ? {} : { model: (model as string).trim() }),
      },
      input.subject,
    );
    return {
      execution: {
        ...input.current,
        ...(next.execution.model === undefined ? {} : { model: next.execution.model }),
        ...(next.execution.effort === undefined ? {} : { effort: next.execution.effort }),
      },
      change: next.change,
    };
  } catch (error) {
    if (error instanceof ExecutionRangeError) throw new TagMessagingError(400, error.message);
    if (error instanceof ExecutionUnchangedError) throw new TagMessagingError(409, error.message);
    throw error;
  }
}

const LIMIT_KEYS = ["maxNativeAgents", "maxReportedTokens", "maxReportedCost"] as const;

/**
 * Requested execution limits that no connected profile on the Tag's Worker Hosts enforces.
 * Returns undefined when no bound host is connected, since a host that connects later may.
 */
export function unsatisfiableLimits(
  workers: readonly WorkerDescriptor[],
  requested: TaskExecutionRequirements,
): { readonly unmet: readonly string[]; readonly satisfiable: readonly string[] } | undefined {
  const limits = requested.limits;
  if (limits === undefined || workers.length === 0) return undefined;
  const candidates = workers.flatMap((worker) =>
    worker.profiles.map((profile) => ({ worker, profile })),
  );
  const enforced = (key: (typeof LIMIT_KEYS)[number], value: unknown) =>
    candidates.some(({ worker, profile }) =>
      descriptorSupportsExecution(worker, profile, {
        ...(requested.harness === undefined ? {} : { harness: requested.harness }),
        limits: { [key]: value },
      }),
    );
  const sample = {
    maxNativeAgents: 0,
    maxReportedTokens: 1,
    maxReportedCost: { amountMinor: 0, currency: "USD" },
  };
  const unmet = LIMIT_KEYS.filter(
    (key) => limits[key] !== undefined && !enforced(key, limits[key]),
  );
  if (unmet.length === 0) return undefined;
  return {
    unmet,
    satisfiable: LIMIT_KEYS.filter((key) => enforced(key, limits[key] ?? sample[key])),
  };
}

/** What one Task Attempt runs with, recorded on the Attempt, including an ignored effort. */
export function attemptExecutionRecord(
  execution: TaskExecutionRequirements,
  worker: WorkerDescriptor | undefined,
  profile: WorkerProfileRef,
): Record<string, unknown> {
  const harness =
    worker?.profileCapabilities?.find(
      (entry) => entry.profile.id === profile.id && entry.profile.revision === profile.revision,
    )?.harness ?? execution.harness;
  const hostModel = worker === undefined ? undefined : profileDefaultModel(worker, profile);
  const model = execution.model ?? hostModel;
  const effortApplied =
    execution.effort === undefined || worker === undefined
      ? undefined
      : profileAppliesEffort(worker, profile, execution.effort);
  return {
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    modelSource: execution.model !== undefined ? "task" : "host-default",
    ...(execution.effort === undefined ? {} : { effort: execution.effort }),
    ...(effortApplied === false
      ? {
          effortIgnored: `${harness ?? "This harness"} has no reasoning-effort option; effort ${execution.effort} was ignored`,
        }
      : {}),
  };
}

/** Whether a selection says anything beyond "the host's defaults", and so is worth recording. */
export function recordsSelection(selection: ExecutionSelection): boolean {
  return (
    selection.source !== "default" ||
    selection.harness !== undefined ||
    selection.model !== undefined ||
    selection.effort !== undefined
  );
}
