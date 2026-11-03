import { createHash } from "node:crypto";
import {
  type AdmitTaskAssignmentInput,
  normalizeTaskItems,
  parseArtifactSelection,
  TagMessagingError,
} from "@supertag/core";

interface AssignmentDefinition {
  readonly items: readonly string[];
  readonly dependencies: readonly string[];
  readonly cost: number;
  readonly inputArtifacts: NonNullable<AdmitTaskAssignmentInput["inputArtifacts"]>;
  readonly fingerprint: string;
}

/** Validates definition values only; live authority and budget checks stay in admission's transaction. */
export function parseAssignmentDefinition(input: AdmitTaskAssignmentInput): AssignmentDefinition {
  for (const [key, value] of Object.entries({
    taskId: input.taskId,
    objectiveId: input.objectiveId,
    teamId: input.teamId,
    requestedByTagId: input.requestedByTagId,
    assignedTagId: input.assignedTagId,
  })) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 200 ||
      /[\s\p{Cc}]/u.test(value)
    )
      throw new TagMessagingError(400, `Invalid ${key}`);
  }
  if (
    typeof input.instruction !== "string" ||
    !input.instruction.trim() ||
    input.instruction.length > 32000
  )
    throw new TagMessagingError(400, "instruction is required and must be bounded");
  if (
    !Array.isArray(input.acceptanceCriteria) ||
    input.acceptanceCriteria.length < 1 ||
    input.acceptanceCriteria.length > 50 ||
    input.acceptanceCriteria.some((x) => typeof x !== "string" || !x.trim() || x.length > 2000)
  )
    throw new TagMessagingError(400, "Bounded acceptanceCriteria required");
  let items: string[];
  try {
    items = normalizeTaskItems(input.items);
  } catch (error) {
    throw new TagMessagingError(400, (error as Error).message);
  }
  if (input.dependencies !== undefined && !Array.isArray(input.dependencies))
    throw new TagMessagingError(400, "dependencies must be an array of Task IDs");
  const dependencies = [...new Set(input.dependencies ?? [])].sort();
  if (
    dependencies.length > 100 ||
    dependencies.some((x) => typeof x !== "string" || !x || x === input.taskId)
  )
    throw new TagMessagingError(400, "Invalid dependencies");
  if (
    input.followupSources &&
    (!input.followupSources.parentTaskId ||
      !Array.isArray(input.followupSources.taskIds) ||
      input.followupSources.taskIds.length < 1 ||
      input.followupSources.taskIds.length > 50 ||
      new Set(input.followupSources.taskIds).size !== input.followupSources.taskIds.length ||
      input.followupSources.taskIds.some((id) => typeof id !== "string" || !id || id.length > 200))
  )
    throw new TagMessagingError(400, "Invalid follow-up sources");
  const cost = input.maxCostMinor ?? 0;
  const inputArtifacts = input.inputArtifacts === undefined ? [] : input.inputArtifacts;
  if (
    !Array.isArray(inputArtifacts) ||
    inputArtifacts.length > 20 ||
    inputArtifacts.some(
      (ref) => !validLocalArtifactSelector(ref) && !validPublishedArtifactSelector(ref),
    )
  )
    throw new TagMessagingError(400, "Invalid inputArtifacts selectors");
  if (!Number.isSafeInteger(cost) || cost < 0)
    throw new TagMessagingError(400, "maxCostMinor must be a nonnegative safe integer");
  return {
    items,
    dependencies,
    cost,
    inputArtifacts,
    fingerprint: assignmentFingerprint(input, items, dependencies, cost, inputArtifacts),
  };
}

function validLocalArtifactSelector(ref: unknown): boolean {
  if (!validArtifactSelection(ref)) return false;
  const candidate = ref as Record<string, unknown>;
  return (
    (candidate["requireAccepted"] === undefined ||
      typeof candidate["requireAccepted"] === "boolean") &&
    Object.keys(candidate).every((key) => ["artifactId", "paths", "requireAccepted"].includes(key))
  );
}
function validPublishedArtifactSelector(ref: unknown): boolean {
  if (!validArtifactSelection(ref)) return false;
  const candidate = ref as Record<string, unknown>;
  return (
    typeof candidate["publicationApprovalId"] === "string" &&
    Boolean(candidate["publicationApprovalId"]) &&
    candidate["publicationApprovalId"].length <= 200 &&
    Object.keys(candidate).every((key) =>
      ["publicationApprovalId", "artifactId", "paths"].includes(key),
    )
  );
}
function validArtifactSelection(ref: unknown): boolean {
  try {
    parseArtifactSelection(ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persisted assignment identity uses this exact positional projection. Empty
 * artifact selectors and items add no element, preserving earlier fingerprints.
 * Execution, authorization, context and workspace snapshots are captured once;
 * retries retain those admitted snapshots rather than redefining the assignment.
 */
function assignmentFingerprint(
  input: AdmitTaskAssignmentInput,
  items: readonly string[],
  dependencies: readonly string[],
  cost: number,
  inputArtifacts: AssignmentDefinition["inputArtifacts"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.objectiveId,
        input.workstreamId ?? null,
        input.teamId,
        input.requestedByTagId,
        input.assignedTagId,
        input.instruction,
        input.acceptanceCriteria,
        dependencies,
        input.requiresApproval ?? false,
        cost,
        input.parentTaskId ?? null,
        ...(inputArtifacts.length ? [inputArtifacts] : []),
        ...(input.followupSources ? [input.followupSources] : []),
        ...(items.length ? [{ items }] : []),
      ]),
    )
    .digest("hex");
}
