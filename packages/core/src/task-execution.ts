import { EXECUTION_EFFORTS, isExecutionEffort } from "./execution-settings.js";
import type { TaskExecutionRequirements, TaskOutputPolicy, WorkerProfileRef } from "./index.js";

export function parseTaskExecutionRequirements(value: unknown): TaskExecutionRequirements {
  if (!isObject(value)) throw new Error("Task execution requirements must be an object");
  for (const key of Object.keys(value)) {
    if (
      ![
        "requires",
        "prefers",
        "profile",
        "harness",
        "model",
        "effort",
        "limits",
        "outputs",
      ].includes(key)
    )
      throw new Error(`Unknown Task execution requirement: ${key}`);
  }
  const capabilities = (key: "requires" | "prefers") => {
    const items = value[key];
    if (items === undefined) return undefined;
    if (!Array.isArray(items)) throw new Error(`Task execution ${key} must be an array`);
    return items.map((item) => {
      if (
        !isObject(item) ||
        Object.keys(item).some((key) => key !== "id" && key !== "version") ||
        typeof item["id"] !== "string" ||
        !Number.isSafeInteger(item["version"]) ||
        (item["version"] as number) < 1
      )
        throw new Error("Invalid execution capability");
      return { id: required(item["id"], "Capability id"), version: item["version"] as number };
    });
  };
  const requires = capabilities("requires");
  const prefers = capabilities("prefers");
  const outputs =
    value["outputs"] === undefined ? undefined : parseTaskOutputPolicy(value["outputs"]);
  const limits = executionLimits(value["limits"]);
  const model = value["model"];
  if (
    model !== undefined &&
    (typeof model !== "string" || !model.trim() || model.trim().length > 200)
  )
    throw new Error("Task execution model must be a model name");
  const effort = value["effort"];
  if (effort !== undefined && !isExecutionEffort(effort))
    throw new Error(`Task execution effort must be ${EXECUTION_EFFORTS.join(", ")}`);
  return {
    ...(requires === undefined ? {} : { requires }),
    ...(prefers === undefined ? {} : { prefers }),
    ...(value["profile"] === undefined ? {} : { profile: profileFromJson(value["profile"]) }),
    ...(value["harness"] === undefined
      ? {}
      : { harness: required(value["harness"] as string, "Harness id") }),
    ...(model === undefined ? {} : { model: (model as string).trim() }),
    ...(effort === undefined ? {} : { effort }),
    ...(limits === undefined ? {} : { limits }),
    ...(outputs === undefined ? {} : { outputs }),
  };
}

function executionLimits(value: unknown): TaskExecutionRequirements["limits"] | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error("Task execution limits must be an object");
  for (const key of Object.keys(value)) {
    if (!["maxNativeAgents", "maxReportedTokens", "maxReportedCost"].includes(key))
      throw new Error(`Unknown Task execution limit: ${key}`);
  }
  const maxNativeAgents = optionalInteger(value["maxNativeAgents"], 0, "maxNativeAgents");
  const maxReportedTokens = optionalInteger(value["maxReportedTokens"], 1, "maxReportedTokens");
  const maxReportedCost = reportedCostLimit(value["maxReportedCost"]);
  if (
    maxNativeAgents === undefined &&
    maxReportedTokens === undefined &&
    maxReportedCost === undefined
  )
    throw new Error("Task execution limits must not be empty");
  return {
    ...(maxNativeAgents === undefined ? {} : { maxNativeAgents }),
    ...(maxReportedTokens === undefined ? {} : { maxReportedTokens }),
    ...(maxReportedCost === undefined ? {} : { maxReportedCost }),
  };
}

function reportedCostLimit(
  value: unknown,
): NonNullable<TaskExecutionRequirements["limits"]>["maxReportedCost"] | undefined {
  if (value === undefined) return undefined;
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => key !== "amountMinor" && key !== "currency") ||
    !Number.isSafeInteger(value["amountMinor"]) ||
    Number(value["amountMinor"]) < 0 ||
    typeof value["currency"] !== "string" ||
    !/^[A-Z]{3}$/u.test(value["currency"])
  )
    throw new Error(
      "maxReportedCost must use a nonnegative amountMinor and uppercase three-letter currency code",
    );
  return { amountMinor: Number(value["amountMinor"]), currency: value["currency"] };
}

function optionalInteger(value: unknown, minimum: number, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  return value as number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}
function profileFromJson(value: unknown): WorkerProfileRef {
  if (!isObject(value) || Object.keys(value).some((key) => key !== "id" && key !== "revision"))
    throw new Error("Invalid Worker Profile reference");
  return {
    id: required(value["id"], "Worker Profile id"),
    revision: required(value["revision"], "Worker Profile revision"),
  };
}

/** Normalizes the language-neutral policy before it becomes immutable Task state. */
export function parseTaskOutputPolicy(value: unknown): Required<TaskOutputPolicy> {
  if (!isObject(value)) throw new Error("Task output policy must be an object");
  for (const key of Object.keys(value)) {
    if (
      !["directory", "required", "include", "exclude", "git", "maxFiles", "maxBytes"].includes(key)
    )
      throw new Error(`Unknown Task output policy field: ${key}`);
    if (value[key] === null) throw new Error(`Output ${key} must not be null`);
  }
  const path = (value: unknown, pattern: boolean): string => {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 1024 ||
      /[\\:!{}[\]]/u.test(value) ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      value.startsWith("/") ||
      value.split("/").some((part) => !part || part === "." || part === "..") ||
      (!pattern && /[*?]/u.test(value))
    )
      throw new Error(
        "Output paths must be safe relative POSIX paths; patterns support only *, ** and ?",
      );
    return value;
  };
  const directory = path(value["directory"] ?? "outputs", false);
  const patterns = (key: string, fallback: string[]): string[] => {
    const values = value[key] ?? fallback;
    if (!Array.isArray(values) || values.length > 100)
      throw new Error(`Output ${key} must contain at most 100 patterns`);
    return [...new Set(values.map((item) => path(item, true)))];
  };
  const git = value["git"] ?? "reference";
  if (git !== "reference" && git !== "capture" && git !== "ignore")
    throw new Error("Output git must be reference, capture or ignore");
  const bounded = (key: string, fallback: number, maximum: number): number => {
    const result = optionalInteger(value[key] ?? fallback, 1, key) as number;
    if (result > maximum) throw new Error(`Output ${key} exceeds ${maximum}`);
    return result;
  };
  return {
    directory,
    required: patterns("required", []),
    include: patterns("include", [`${directory}/**`]),
    exclude: patterns("exclude", []),
    git,
    maxFiles: bounded("maxFiles", 100, 100),
    maxBytes: bounded("maxBytes", 64 * 1024 * 1024, 64 * 1024 * 1024),
  };
}
