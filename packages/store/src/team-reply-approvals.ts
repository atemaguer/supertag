// biome-ignore-all lint/suspicious/noExplicitAny: Shared dialect transactions.
import { randomUUID } from "node:crypto";
import type { ApprovalRequest, TagApprovalRequirement, TaskAssignment } from "@supertag/core";
import {
  createApprovalRequestInTransaction,
  findObjectiveApprovalGrantInTransaction,
} from "./approval-store.js";
import { nextTaskEventSequence } from "./task-event-sequence.js";

type Flow<T> = Generator<any, T, any>;
interface ReplyApprovalAdmission {
  ungranted: TagApprovalRequirement[];
  grants: { requirement: TagApprovalRequirement; grant: ApprovalRequest }[];
}

/** Same runtime grant checks as ordinary admission, inside the reply admission transaction. */
export function* teamReplyApprovalAdmission(
  tx: any,
  tables: any,
  objectiveId: string,
  approvals: readonly TagApprovalRequirement[] | undefined,
  now: string,
): Flow<ReplyApprovalAdmission> {
  const ungranted: TagApprovalRequirement[] = [];
  const grants: { requirement: TagApprovalRequirement; grant: ApprovalRequest }[] = [];
  for (const requirement of approvals ?? []) {
    if (requirement.target !== "runtime") continue;
    const grant = yield* findObjectiveApprovalGrantInTransaction(
      tx,
      tables,
      objectiveId,
      { target: "runtime", action: requirement.action },
      now,
    );
    if (grant) grants.push({ requirement, grant });
    else ungranted.push(requirement);
  }
  return { ungranted, grants };
}

/** A held reply and its actionable approval request commit together. */
export function* recordTeamReplyApprovals(
  tx: any,
  tables: any,
  assignment: TaskAssignment,
  admission: ReplyApprovalAdmission,
  now: string,
): Flow<void> {
  const event = function* (type: string, payload: unknown): Flow<void> {
    yield tx
      .insert(tables.taskEvents)
      .values({
        id: randomUUID(),
        taskId: assignment.taskId,
        sequence: yield* nextTaskEventSequence(tx, tables.taskEvents, assignment.taskId),
        type,
        payload,
        createdAt: now,
      })
      .returning();
  };
  for (const { requirement, grant } of admission.grants)
    yield* event("approval.granted-by-scope", {
      requestId: grant.id,
      actions: [{ target: "runtime", action: requirement.action }],
      ruleSources: requirement.permissionSets,
      decidedBy: grant.decidedBy,
      decidedByKind: grant.decidedByKind,
    });
  if (!admission.ungranted.length) return;
  const request = yield* createApprovalRequestInTransaction(tx, tables, {
    objectiveId: assignment.objectiveId,
    taskId: assignment.taskId,
    requestingTagId: assignment.requestedByTagId,
    kind: "task",
    actions: admission.ungranted.map((requirement) => ({
      target: "runtime",
      action: requirement.action,
    })),
    summary: `Start Team reply ${assignment.taskId}: ${assignment.instruction}`,
    ruleSources: admission.ungranted.flatMap((entry) => entry.permissionSets),
    approvers: admission.ungranted.flatMap((entry) => entry.approvers),
  });
  yield* event("approval.requested", {
    requestId: request.id,
    kind: request.kind,
    actions: request.actions,
    ruleSources: request.ruleSources,
    heldBy: "permission",
  });
}
