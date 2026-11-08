/**
 * Review findings carried by a Task result. A finding always describes the Task whose result
 * carries it: it has no Task field, and only the settlement of that Task's own Attempt records it.
 */
export type TaskFindingSeverity = "high" | "medium" | "low";

export const TASK_FINDING_SEVERITIES: readonly TaskFindingSeverity[] = ["high", "medium", "low"];

/** Most findings one result may carry. */
export const MAX_TASK_FINDINGS = 50;
/** Longest finding summary or location, in characters. */
export const MAX_TASK_FINDING_TEXT = 500;

export interface TaskFinding {
  /** Control Plane identifier, unique within the Task, such as `F1`. */
  readonly id: string;
  readonly severity: TaskFindingSeverity;
  /** One sentence. */
  readonly summary: string;
  /** `file:line` or another reference. */
  readonly location?: string;
}

const FINDING_ID = /^F[1-9][0-9]{0,2}$/u;
const FINDING_KEYS = new Set(["id", "severity", "summary", "location"]);

/**
 * Validates one finding exactly, including its identifier. Throws on any unknown field, so a
 * finding cannot name another Task.
 */
export function parseTaskFinding(value: unknown): TaskFinding {
  if (!isRecord(value)) throw new Error("Task finding must be an object");
  for (const key of Object.keys(value))
    if (!FINDING_KEYS.has(key)) throw new Error(`Task finding field ${key} is not allowed`);
  const id = value["id"];
  if (typeof id !== "string" || !FINDING_ID.test(id))
    throw new Error("Task finding id must look like F1");
  const severity = value["severity"];
  if (!TASK_FINDING_SEVERITIES.includes(severity as TaskFindingSeverity))
    throw new Error("Task finding severity must be high, medium, or low");
  const summary = findingText(value["summary"], "summary");
  const location =
    value["location"] === undefined ? undefined : findingText(value["location"], "location");
  return {
    id,
    severity: severity as TaskFindingSeverity,
    summary,
    ...(location === undefined ? {} : { location }),
  };
}

/** Validates a stored list of findings, including unique identifiers. */
export function parseTaskFindings(value: unknown): readonly TaskFinding[] {
  if (!Array.isArray(value)) throw new Error("Task findings must be an array");
  if (value.length > MAX_TASK_FINDINGS)
    throw new Error(`A Task result carries at most ${MAX_TASK_FINDINGS} findings`);
  const findings = value.map(parseTaskFinding);
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length)
    throw new Error("Task finding ids must be unique");
  return findings;
}

/**
 * The findings a Control Plane records from a submitted result. A Worker reports the severity,
 * summary, and optional location of each finding: the Control Plane assigns the identifiers
 * `F1`, `F2`, ... in order, whatever identifier the Worker supplied. Unknown fields are refused.
 */
export function recordTaskFindings(value: unknown): readonly TaskFinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Task findings must be an array");
  if (value.length > MAX_TASK_FINDINGS)
    throw new Error(`A Task result carries at most ${MAX_TASK_FINDINGS} findings`);
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error("Task finding must be an object");
    return parseTaskFinding({ ...candidate, id: `F${index + 1}` });
  });
}

/** Findings, highest severity first, in result order within a severity. */
export function orderedTaskFindings(
  findings: readonly TaskFinding[] | undefined,
): readonly TaskFinding[] {
  return TASK_FINDING_SEVERITIES.flatMap((severity) =>
    (findings ?? []).filter((finding) => finding.severity === severity),
  );
}

/**
 * Characters a finding never carries, because findings appear in operator terminals and prompts:
 * every control (Cc), format (Cf), line separator (Zl), paragraph separator (Zp), and lone
 * surrogate (Cs) character, which covers bidirectional controls, zero-width characters, the soft
 * hyphen, and U+061C, U+180E, and U+FEFF; every variation selector (U+180B-180D, U+180F,
 * U+FE00-FE0F, U+E0100-E01EF); the whole tag block U+E0000-E007F;
 * and the invisible-operator block U+2060-206F, including its unassigned code points.
 */
const HIDDEN_CHARACTER =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u2060-\u206f\u{e0000}-\u{e007f}]|\p{Variation_Selector}|\p{Default_Ignorable_Code_Point}|\p{Cn}|\p{Co}/u;

function findingText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Task finding ${field} must be text`);
  // Checked before trimming, so a leading or trailing hidden character is refused, not removed.
  if (HIDDEN_CHARACTER.test(value))
    throw new Error(
      `Task finding ${field} must be one line without control, bidirectional, or invisible characters`,
    );
  const text = value.trim();
  if (text.length === 0) throw new Error(`Task finding ${field} must not be empty`);
  if (text.length > MAX_TASK_FINDING_TEXT)
    throw new Error(`Task finding ${field} exceeds ${MAX_TASK_FINDING_TEXT} characters`);
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Findings grouped by severity, in severity order. */
export type TaskFindingsBySeverity = Readonly<Record<TaskFindingSeverity, readonly TaskFinding[]>>;

/** Findings grouped by severity: `{ high: [...], medium: [...], low: [...] }`. */
export function taskFindingsBySeverity(
  findings: readonly TaskFinding[] | undefined,
): TaskFindingsBySeverity {
  const all = findings ?? [];
  return {
    high: all.filter((finding) => finding.severity === "high"),
    medium: all.filter((finding) => finding.severity === "medium"),
    low: all.filter((finding) => finding.severity === "low"),
  };
}

/**
 * The findings of a stored Task result, held under `taskResult`; findings outside `taskResult`
 * are never trusted. Invalid stored findings become one high finding, so corrupted data cannot
 * read as having no findings.
 */
export function storedTaskFindings(result: unknown): readonly TaskFinding[] {
  try {
    return strictStoredTaskFindings(result);
  } catch {
    return [invalidStoredFinding];
  }
}

/** Stored findings, throwing with the reason when the record's findings do not validate. */
function strictStoredTaskFindings(result: unknown): readonly TaskFinding[] {
  if (!isRecord(result)) return [];
  const taskResult = result["taskResult"];
  if (taskResult === undefined) return [];
  if (!isRecord(taskResult))
    throw new Error("Stored Task result findings are invalid: taskResult must be an object");
  if (taskResult["findings"] === undefined) return [];
  try {
    return parseTaskFindings(taskResult["findings"]);
  } catch (error) {
    throw new Error(
      `Stored Task result findings are invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Findings of a stored Task result grouped by severity, or `{ unreadable }` naming why the
 * record's findings do not validate. Read views use this so one corrupt record fails closed for
 * its own Task without hiding other Tasks; {@link storedTaskFindings} instead turns invalid
 * findings into one high finding.
 */
export type StoredTaskFindingsBySeverity = TaskFindingsBySeverity | { readonly unreadable: string };

export function storedTaskFindingsBySeverity(result: unknown): StoredTaskFindingsBySeverity {
  try {
    return taskFindingsBySeverity(strictStoredTaskFindings(result));
  } catch (error) {
    // The message can echo stored text, such as an unknown field name: show it without hidden
    // characters.
    const message = error instanceof Error ? error.message : String(error);
    return {
      unreadable: message
        .replace(new RegExp(HIDDEN_CHARACTER.source, "gu"), "?")
        .slice(0, MAX_TASK_FINDING_TEXT),
    };
  }
}

const invalidStoredFinding: TaskFinding = {
  id: "F1",
  severity: "high",
  summary: "Stored Task findings are invalid; inspect and repair the Task result.",
};

/** One finding on one line: `F1 [high] Summary (location)`. */
export function taskFindingLine(finding: TaskFinding): string {
  return `${finding.id} [${finding.severity}] ${finding.summary}${
    finding.location === undefined ? "" : ` (${finding.location})`
  }`;
}
