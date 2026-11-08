import {
  assertExecutionInRange,
  defaultExecution,
  ExecutionRangeError,
  type ExecutionSelection,
  type ExecutionSettings,
  type ResolvedExecution,
  TagMessagingError,
  type TaskExecutionRequirements,
} from "@supertag/core";
import {
  profileAppliesEffort,
  profileDefaultModel,
  type WorkerDescriptor,
  type WorkerProfileRef,
} from "@supertag/worker-sdk";

/** Event recording a Task's resolved execution and why, appended when SuperTag accepts it. */
export const EXECUTION_RESOLVED_EVENT = "task.execution-resolved";

/**
 * Resolves one Task's harness, model, and effort when SuperTag accepts it. A model or effort the
 * requester chose wins and must fall within the Tag's range; otherwise the range's defaults apply.
 */
export function resolveTaskExecution(input: {
  readonly range: ExecutionSettings;
  readonly requested: TaskExecutionRequirements;
  /** The delegating actor's choice, or nothing for work SuperTag starts itself. */
  readonly chosen: { readonly model?: string; readonly effort?: ResolvedExecution["effort"] };
  readonly chosenByTagId?: string;
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
