/**
 * Execution settings choose the harness, model, and reasoning effort a Tag's Tasks run with.
 * A Role sets the default and allowed range for its Tags; a Tag's own settings override the
 * Role's. Each Task records one resolved selection when SuperTag accepts it.
 */

/** Reasoning effort levels, lowest first. Each harness maps them to its own option. */
export const EXECUTION_EFFORTS = ["low", "medium", "high"] as const;
export type ExecutionEffort = (typeof EXECUTION_EFFORTS)[number];

/**
 * The efforts a Tag allows when neither it nor its Roles set any. Tasks start at the first, low,
 * and the delegating actor or the Task's own assignee may raise it.
 */
export const DEFAULT_EXECUTION_EFFORTS: readonly ExecutionEffort[] = EXECUTION_EFFORTS;

/** Most models one Role or Tag may allow. */
export const MAX_EXECUTION_MODELS = 32;

/** The harness, models, and efforts a Role or Tag allows. In each list the first is the default. */
export interface ExecutionSettings {
  readonly harness?: string;
  readonly model?: readonly string[];
  readonly effort?: readonly ExecutionEffort[];
}

/** One Task's selection: absent fields fall to the Worker Host's defaults. */
export interface ResolvedExecution {
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: ExecutionEffort;
}

/** Why a Task runs with its selection. */
export type ExecutionSelectionSource = "default" | "chosen" | "escalated";

export interface ExecutionSelection extends ResolvedExecution {
  readonly source: ExecutionSelectionSource;
  /** The delegating Tag, when it chose the model or effort. */
  readonly chosenByTagId?: string;
  /** The Task whose failure or rejection raised this selection. */
  readonly escalatedFromTaskId?: string;
  /** Readable change, such as `effort medium → high`. */
  readonly escalation?: string;
  /** Set when escalation found nothing higher in the allowed range. */
  readonly escalationExhausted?: true;
}

/** A requested model or effort outside the assignee's allowed range. */
export class ExecutionRangeError extends Error {
  override readonly name = "ExecutionRangeError";
}

const HARNESS = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

export function isExecutionEffort(value: unknown): value is ExecutionEffort {
  return typeof value === "string" && (EXECUTION_EFFORTS as readonly string[]).includes(value);
}

/**
 * Validates `spec.execution` on a Role or Tag. A single value means "only this"; a list means
 * "these, the first by default". Returns lists in canonical form, or undefined when empty.
 */
export function parseExecutionSettings(
  value: unknown,
  field = "execution",
): ExecutionSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object with harness, model, or effort`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => key !== "harness" && key !== "model" && key !== "effort",
  );
  if (unknown.length > 0)
    throw new Error(
      `${field} contains unknown fields: ${unknown.join(", ")}. Use harness, model, or effort`,
    );
  let harness: string | undefined;
  if (record["harness"] !== undefined) {
    const raw = record["harness"];
    harness = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!HARNESS.test(harness))
      throw new Error(`${field}.harness must be a harness name such as codex or claude-code`);
  }
  const model =
    record["model"] === undefined
      ? undefined
      : oneOrMany(record["model"], `${field}.model`, (item) => {
          if (typeof item !== "string" || !item.trim() || item.trim().length > 200)
            throw new Error(`${field}.model entries must be model names`);
          return item.trim();
        });
  if (model !== undefined && model.length > MAX_EXECUTION_MODELS)
    throw new Error(`${field}.model may list at most ${MAX_EXECUTION_MODELS} models`);
  const effort =
    record["effort"] === undefined
      ? undefined
      : oneOrMany(record["effort"], `${field}.effort`, (item) => {
          if (!isExecutionEffort(item))
            throw new Error(`${field}.effort entries must be ${EXECUTION_EFFORTS.join(", ")}`);
          return item;
        });
  if (harness === undefined && model === undefined && effort === undefined) return undefined;
  return {
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function oneOrMany<T>(value: unknown, field: string, item: (value: unknown) => T): readonly T[] {
  const items = Array.isArray(value) ? value.map(item) : [item(value)];
  if (items.length === 0) throw new Error(`${field} must not be empty`);
  if (new Set(items).size !== items.length) throw new Error(`${field} must not repeat a value`);
  return items;
}

/**
 * The allowed range for a Tag: its own settings field by field, then each Role's in order. A
 * model list belongs to its harness, so a Role's models apply only when the harness matches.
 * With no effort set anywhere, the range allows every effort and defaults to low.
 */
export function executionRange(
  tag: ExecutionSettings | undefined,
  roles: readonly (ExecutionSettings | undefined)[] = [],
): ExecutionSettings {
  const sources = [tag, ...roles].filter(
    (settings): settings is ExecutionSettings => settings !== undefined,
  );
  const harness = sources.find((settings) => settings.harness !== undefined)?.harness;
  const sameHarness = (settings: ExecutionSettings) =>
    settings.harness === undefined || harness === undefined || settings.harness === harness;
  const model = sources.find(
    (settings) => settings.model !== undefined && sameHarness(settings),
  )?.model;
  const effort =
    sources.find((settings) => settings.effort !== undefined)?.effort ?? DEFAULT_EXECUTION_EFFORTS;
  return {
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    effort,
  };
}

/** A sentence naming the allowed values, for refusals and descriptions. */
export function describeExecutionRange(range: ExecutionSettings): string {
  return [
    `harness ${range.harness ?? "any the Worker Host offers"}`,
    `model ${range.model?.join(", ") ?? "any the Worker Host offers"}`,
    `effort ${range.effort?.join(", ") ?? EXECUTION_EFFORTS.join(", ")}`,
  ].join("; ");
}

/** Refuses a requested harness, model, or effort outside the range, naming the allowed values. */
export function assertExecutionInRange(
  range: ExecutionSettings,
  requested: ResolvedExecution,
  subject = "This Tag",
): void {
  const problems: string[] = [];
  if (
    requested.harness !== undefined &&
    range.harness !== undefined &&
    requested.harness !== range.harness
  )
    problems.push(`harness ${requested.harness}`);
  if (
    requested.model !== undefined &&
    range.model !== undefined &&
    !range.model.includes(requested.model)
  )
    problems.push(`model ${requested.model}`);
  if (
    requested.effort !== undefined &&
    range.effort !== undefined &&
    !range.effort.includes(requested.effort)
  )
    problems.push(`effort ${requested.effort}`);
  if (problems.length > 0)
    throw new ExecutionRangeError(
      `${subject} does not allow ${problems.join(", ")}. Allowed: ${describeExecutionRange(range)}.`,
    );
}

/** The defaults inside a range: its harness, first model, and first effort. */
export function defaultExecution(range: ExecutionSettings): ResolvedExecution {
  const model = range.model?.[0];
  const effort = range.effort?.[0];
  return {
    ...(range.harness === undefined ? {} : { harness: range.harness }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/** Most times the actor working one Task may change its own execution. */
export const MAX_SELF_ESCALATIONS = 2;

/** Task event recording a self-escalation: who, what changed, and why. */
export const SELF_ESCALATED_EVENT = "task.self-escalated";
/** Task event recorded when an Attempt registers a durable wait; its payload keeps the reason. */
export const WAIT_REGISTERED_EVENT = "task.wait-registered";

/** A self-escalation that would leave the Task's execution as it is. */
export class ExecutionUnchangedError extends Error {
  override readonly name = "ExecutionUnchangedError";
}

/**
 * The execution a Task continues with after its assignee asks for another model or effort.
 * Refuses values outside the range, naming the allowed ones, and a request that changes nothing.
 */
export function selfEscalateExecution(
  range: ExecutionSettings,
  current: ResolvedExecution,
  requested: { readonly model?: string; readonly effort?: ExecutionEffort },
  subject = "This Tag",
): { readonly execution: ResolvedExecution; readonly change: string } {
  if (requested.model === undefined && requested.effort === undefined)
    throw new ExecutionRangeError(
      `Set effort, model, or both. Allowed: ${describeExecutionRange(range)}.`,
    );
  assertExecutionInRange(range, requested, subject);
  const changes: string[] = [];
  if (requested.effort !== undefined && requested.effort !== current.effort)
    changes.push(`effort ${current.effort ?? "default"} → ${requested.effort}`);
  if (requested.model !== undefined && requested.model !== current.model)
    changes.push(`model ${current.model ?? "host default"} → ${requested.model}`);
  if (changes.length === 0) {
    const asked = [
      ...(requested.effort === undefined ? [] : [`effort ${requested.effort}`]),
      ...(requested.model === undefined ? [] : [`model ${requested.model}`]),
    ];
    throw new ExecutionUnchangedError(
      `Nothing would change: this Task already runs with ${asked.join(" and ")}. Allowed: ${describeExecutionRange(range)}.`,
    );
  }
  return {
    execution: {
      ...current,
      ...(requested.model === undefined ? {} : { model: requested.model }),
      ...(requested.effort === undefined ? {} : { effort: requested.effort }),
    },
    change: changes.join(", "),
  };
}

const RANK: Readonly<Record<ExecutionEffort, number>> = { low: 0, medium: 1, high: 2 };

/**
 * The next selection after a failed or rejected Task: one effort step higher within the range,
 * then the next allowed model at the default effort. With no recorded effort, escalation goes to
 * the highest allowed effort. Returns no change when nothing higher is allowed.
 */
export function escalateExecution(
  range: ExecutionSettings,
  prior: ResolvedExecution,
): { readonly execution: ResolvedExecution; readonly change?: string } {
  const ladder = [...(range.effort ?? EXECUTION_EFFORTS)].sort((a, b) => RANK[a] - RANK[b]);
  const harness = prior.harness ?? range.harness;
  const base: ResolvedExecution = {
    ...(harness === undefined ? {} : { harness }),
    ...(prior.model === undefined ? {} : { model: prior.model }),
    ...(prior.effort === undefined ? {} : { effort: prior.effort }),
  };
  const higher =
    prior.effort === undefined
      ? ladder.at(-1)
      : ladder.find((effort) => RANK[effort] > RANK[prior.effort as ExecutionEffort]);
  if (higher !== undefined)
    return {
      execution: { ...base, effort: higher },
      change: `effort ${prior.effort ?? "default"} → ${higher}`,
    };
  const models = range.model ?? [];
  const index = prior.model === undefined ? 0 : models.indexOf(prior.model);
  const next = index < 0 ? undefined : models[index + 1];
  if (next === undefined) return { execution: base };
  const effort = range.effort?.[0];
  const { effort: _effort, ...rest } = base;
  return {
    execution: { ...rest, model: next, ...(effort === undefined ? {} : { effort }) },
    change: `model ${prior.model ?? models[0]} → ${next}`,
  };
}

// Provider usage and rate limits clear with time; retrying immediately only repeats the failure.
export const PROVIDER_LIMIT_FAILURE =
  /hit your [\w ]*limit|usage limit|rate[ -]limit|quota exceeded|too many requests|\b429\b/i;
// Failures that no retry can fix until a person changes credentials, billing, or configuration.
export const OPERATOR_FIX_FAILURE =
  /authenticat|invalid (api )?key|not logged in|credit balance|billing|model[^.]{0,80}(not found|not available|unavailable|does not exist|not supported)/i;
// The Worker Host, its lease, or Worklet admission failed; the work itself was not judged.
const HOST_FAILURE =
  /lease expired|lease lost|worker host [^.]* was removed|explicit reassignment required|admission|disconnected|no remote worklet|at capacity/i;
const INFRASTRUCTURE_FAILURE_KINDS = new Set([
  "budget-exhausted",
  "objective-budget-stop",
  "workspace-integrity",
]);

/**
 * Whether a finished Task should raise the next Task's execution: a rejected result, or a
 * failure that is not about provider limits, credentials, configuration, budgets, or hosts.
 */
export function escalatesExecution(task: {
  readonly status: string;
  readonly result?: Readonly<Record<string, unknown>> | null;
}): boolean {
  if (task.status === "rejected") return true;
  if (task.status !== "failed") return false;
  const result = task.result ?? {};
  if (INFRASTRUCTURE_FAILURE_KINDS.has(String(result["failureKind"] ?? ""))) return false;
  if (result["workerHostRemoved"] !== undefined || result["admissionRejected"] !== undefined)
    return false;
  const error = String(result["error"] ?? "");
  return !(
    PROVIDER_LIMIT_FAILURE.test(error) ||
    OPERATOR_FIX_FAILURE.test(error) ||
    HOST_FAILURE.test(error)
  );
}
