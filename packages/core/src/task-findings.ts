/**
 * Review findings carried by a Task result. A finding always describes the Task whose result
 * carries it: it has no Task field, and only the settlement of that Task's own Attempt records it.
 * A finding later closes as fixed or accepted through `update_task`, or as fixed through an
 * accepted re-review result; see {@link closeTaskFinding}.
 */
export type TaskFindingSeverity = "high" | "medium" | "low";
export type TaskFindingStatus = "open" | "fixed" | "accepted";

export const TASK_FINDING_SEVERITIES: readonly TaskFindingSeverity[] = ["high", "medium", "low"];
export const TASK_FINDING_STATUSES: readonly TaskFindingStatus[] = ["open", "fixed", "accepted"];

/** Most findings one result may carry. */
export const MAX_TASK_FINDINGS = 50;
/** Longest finding summary, location, or reason, in characters. */
export const MAX_TASK_FINDING_TEXT = 500;

export interface TaskFinding {
  /** Control Plane identifier, unique within the Task, such as `F1`. */
  readonly id: string;
  readonly severity: TaskFindingSeverity;
  /** One sentence. */
  readonly summary: string;
  /** `file:line` or another reference. */
  readonly location?: string;
  readonly status: TaskFindingStatus;
  /** Why an accepted finding stays as it is. Required when `status` is `accepted`. */
  readonly reason?: string;
  /** The commit or Task that fixed the finding. Required when `status` is `fixed`. */
  readonly fixedBy?: string;
  /** Who closed the finding. Required when `status` is not `open`. */
  readonly closedBy?: TaskFindingCloser;
  /** When the finding closed. Required when `status` is not `open`. */
  readonly closedAt?: string;
}

/**
 * Who closed a finding: a Tag, through `update_task` or through the accepted re-review Task it
 * names in `taskId`, or an operator through the administrative API.
 */
export type TaskFindingCloser =
  | { readonly tagId: string; readonly taskId?: string }
  | { readonly operatorId: string };

/** One finding on another Task, as a re-review result names it. */
export interface TaskFindingReference {
  readonly taskId: string;
  readonly findingId: string;
}

/** A requested closure: a finding fixed by a commit or Task, or accepted with a reason. */
export type TaskFindingClosure =
  | { readonly id: string; readonly status: "fixed"; readonly fixedBy: string }
  | { readonly id: string; readonly status: "accepted"; readonly reason: string };

const FINDING_ID = /^F[1-9][0-9]{0,2}$/u;
const FINDING_KEYS = new Set([
  "id",
  "severity",
  "summary",
  "location",
  "status",
  "reason",
  "fixedBy",
  "closedBy",
  "closedAt",
]);
/** Fields the Control Plane owns: a Worker's values for them are ignored. */
const RECORDED_KEYS = new Set(["id", "status", "reason", "fixedBy", "closedBy", "closedAt"]);

/**
 * Validates one finding exactly, including its identifier and status. Throws on any unknown
 * field, so a finding cannot name another Task or carry unrecognized closure data.
 */
export function parseTaskFinding(value: unknown): TaskFinding {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Task finding must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!FINDING_KEYS.has(key)) throw new Error(`Task finding field ${key} is not allowed`);
  const id = record["id"];
  if (typeof id !== "string" || !FINDING_ID.test(id))
    throw new Error("Task finding id must look like F1");
  const severity = record["severity"];
  if (!TASK_FINDING_SEVERITIES.includes(severity as TaskFindingSeverity))
    throw new Error("Task finding severity must be high, medium, or low");
  const status = record["status"];
  if (!TASK_FINDING_STATUSES.includes(status as TaskFindingStatus))
    throw new Error("Task finding status must be open, fixed, or accepted");
  const summary = findingText(record["summary"], "summary");
  const location =
    record["location"] === undefined ? undefined : findingText(record["location"], "location");
  const reason =
    record["reason"] === undefined ? undefined : findingText(record["reason"], "reason");
  if (status === "accepted" && reason === undefined)
    throw new Error("An accepted Task finding requires a reason");
  if (status !== "accepted" && reason !== undefined)
    throw new Error("Only an accepted Task finding has a reason");
  const fixedBy =
    record["fixedBy"] === undefined ? undefined : findingText(record["fixedBy"], "fixedBy");
  if (status === "fixed" && fixedBy === undefined)
    throw new Error("A fixed Task finding requires fixedBy");
  if (status !== "fixed" && fixedBy !== undefined)
    throw new Error("Only a fixed Task finding has fixedBy");
  const closedBy =
    record["closedBy"] === undefined ? undefined : parseTaskFindingCloser(record["closedBy"]);
  const closedAt = record["closedAt"] === undefined ? undefined : timestamp(record["closedAt"]);
  if (status === "open" && (closedBy !== undefined || closedAt !== undefined))
    throw new Error("An open Task finding has no closedBy or closedAt");
  if (status !== "open" && (closedBy === undefined || closedAt === undefined))
    throw new Error("A closed Task finding requires closedBy and closedAt");
  return {
    id,
    severity: severity as TaskFindingSeverity,
    summary,
    ...(location === undefined ? {} : { location }),
    status: status as TaskFindingStatus,
    ...(reason === undefined ? {} : { reason }),
    ...(fixedBy === undefined ? {} : { fixedBy }),
    ...(closedBy === undefined ? {} : { closedBy }),
    ...(closedAt === undefined ? {} : { closedAt }),
  };
}

function parseTaskFindingCloser(value: unknown): TaskFindingCloser {
  if (!isRecord(value)) throw new Error("Task finding closedBy must be an object");
  const keys = Object.keys(value).sort().join(",");
  if (keys === "operatorId") return { operatorId: findingText(value["operatorId"], "closedBy") };
  if (keys === "tagId") return { tagId: findingText(value["tagId"], "closedBy") };
  if (keys === "tagId,taskId")
    return {
      tagId: findingText(value["tagId"], "closedBy"),
      taskId: findingText(value["taskId"], "closedBy"),
    };
  throw new Error("Task finding closedBy names a tagId, with an optional taskId, or an operatorId");
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    throw new Error("Task finding closedAt must be a timestamp");
  return value;
}

/**
 * Validates a requested closure from `update_task`: `{ id, status: "fixed", fixedBy }` naming
 * the commit or Task that fixed it, or `{ id, status: "accepted", reason }`.
 */
export function parseTaskFindingClosure(value: unknown): TaskFindingClosure {
  if (!isRecord(value)) throw new Error("finding must be an object");
  const id = value["id"];
  if (typeof id !== "string" || !FINDING_ID.test(id))
    throw new Error("finding.id must look like F1");
  const status = value["status"];
  const keys = Object.keys(value).sort().join(",");
  if (status === "fixed" && keys === "fixedBy,id,status")
    return { id, status, fixedBy: findingText(value["fixedBy"], "fixedBy") };
  if (status === "accepted" && keys === "id,reason,status")
    return { id, status, reason: findingText(value["reason"], "reason") };
  throw new Error(
    'finding must be { id, status: "fixed", fixedBy } or { id, status: "accepted", reason }',
  );
}

/**
 * Closes one open finding and returns the new list. Throws when the finding is missing or
 * already closed. Callers decide who may close which severity before calling this.
 */
export function closeTaskFinding(
  findings: readonly TaskFinding[],
  closure: TaskFindingClosure,
  closedBy: TaskFindingCloser,
  closedAt: string,
): readonly TaskFinding[] {
  const index = findings.findIndex((finding) => finding.id === closure.id);
  const current = findings[index];
  if (!current) throw new Error(`Task finding ${closure.id} does not exist`);
  if (current.status !== "open") throw new Error(`Task finding ${closure.id} is already closed`);
  const { reason: _reason, fixedBy: _fixedBy, ...open } = current;
  const closed = parseTaskFinding({
    ...open,
    status: closure.status,
    ...(closure.status === "fixed" ? { fixedBy: closure.fixedBy } : { reason: closure.reason }),
    closedBy,
    closedAt,
  });
  return findings.map((finding, position) => (position === index ? closed : finding));
}

/**
 * Validates the findings a re-review result reports as fixed: up to {@link MAX_TASK_FINDINGS}
 * unique `{ taskId, findingId }` references. Absent means none.
 */
export function parseFixedTaskFindings(value: unknown): readonly TaskFindingReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Fixed findings must be an array");
  if (value.length > MAX_TASK_FINDINGS)
    throw new Error(`A Task result reports at most ${MAX_TASK_FINDINGS} fixed findings`);
  const references = value.map((candidate) => {
    if (!isRecord(candidate) || Object.keys(candidate).sort().join(",") !== "findingId,taskId")
      throw new Error("A fixed finding is exactly { taskId, findingId }");
    const findingId = candidate["findingId"];
    if (typeof findingId !== "string" || !FINDING_ID.test(findingId))
      throw new Error("A fixed finding's findingId must look like F1");
    return { taskId: findingText(candidate["taskId"], "taskId"), findingId };
  });
  if (
    new Set(references.map((reference) => `${reference.taskId}\u0000${reference.findingId}`))
      .size !== references.length
  )
    throw new Error("Fixed findings must be unique");
  return references;
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
 * The findings a Control Plane records from a submitted result. A Worker reports only the
 * severity, summary, and optional location of each finding: the Control Plane assigns the
 * identifiers `F1`, `F2`, ... in order and records every finding as open, whatever identifier
 * or closure fields (status, reason, fixedBy, closedBy, closedAt) the Worker supplied. Unknown
 * fields are refused.
 */
export function recordTaskFindings(value: unknown): readonly TaskFinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Task findings must be an array");
  if (value.length > MAX_TASK_FINDINGS)
    throw new Error(`A Task result carries at most ${MAX_TASK_FINDINGS} findings`);
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error("Task finding must be an object");
    const reported = Object.fromEntries(
      Object.entries(candidate).filter(([key]) => !RECORDED_KEYS.has(key)),
    );
    return parseTaskFinding({ ...reported, id: `F${index + 1}`, status: "open" });
  });
}

/** Open findings, highest severity first, in result order within a severity. */
export function openTaskFindings(
  findings: readonly TaskFinding[] | undefined,
): readonly TaskFinding[] {
  return TASK_FINDING_SEVERITIES.flatMap((severity) =>
    (findings ?? []).filter(
      (finding) => finding.status === "open" && finding.severity === severity,
    ),
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

/** Open findings counted by severity, in severity order. */
export type OpenTaskFindingsBySeverity = Readonly<
  Record<TaskFindingSeverity, readonly TaskFinding[]>
>;

/** Open findings grouped by severity: `{ high: [...], medium: [...], low: [...] }`. */
export function openTaskFindingsBySeverity(
  findings: readonly TaskFinding[] | undefined,
): OpenTaskFindingsBySeverity {
  const open = openTaskFindings(findings);
  return {
    high: open.filter((finding) => finding.severity === "high"),
    medium: open.filter((finding) => finding.severity === "medium"),
    low: open.filter((finding) => finding.severity === "low"),
  };
}

/**
 * The findings of a stored Task result: an inbound Task's result, or a coordination Task's
 * settled record holding it under `taskResult`; findings outside `taskResult` are never trusted.
 * Invalid stored findings become one open high, so corrupted data cannot silently permit Objective
 * completion or read as having no open findings.
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
 * Open findings of a stored Task result grouped by severity, or `{ unreadable }` naming why the
 * record's findings do not validate. Read views use this so one corrupt record fails closed for
 * its own Task without hiding other Tasks; enforcement uses {@link storedTaskFindings}, which
 * turns invalid findings into an open high.
 */
export type StoredOpenTaskFindings = OpenTaskFindingsBySeverity | { readonly unreadable: string };

export function storedOpenTaskFindings(result: unknown): StoredOpenTaskFindings {
  try {
    return openTaskFindingsBySeverity(strictStoredTaskFindings(result));
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
  status: "open",
};

/** One finding on one line: `F1 [high] Summary (location)`. */
export function taskFindingLine(finding: TaskFinding): string {
  return `${finding.id} [${finding.severity}] ${finding.summary}${
    finding.location === undefined ? "" : ` (${finding.location})`
  }`;
}
