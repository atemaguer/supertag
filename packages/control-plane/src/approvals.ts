import { createHash } from "node:crypto";
import {
  APPROVAL_REASON_MAX_LENGTH,
  type ApprovalActionDescriptor,
  type ApprovalRequest,
  type ApprovalRequestStatus,
  type ApprovalScope,
  approvalActionsMatch,
  approvalRequirementFor,
  approversAdmitOperator,
  approversIncludeTag,
  describeApprovalAction,
  mailboxObject,
  mailboxText,
  mcpApprovalRequirementCovers,
  parseApprovalActionDescriptor,
  type Store,
  sanitizeApprovalText,
  type TagApprovalRequirement,
  TagMessagingError,
  type TaskAssignment,
} from "@supertag/core";

type ApprovalPersistence = Pick<
  Store,
  | "appendTaskEvent"
  | "createApprovalRequest"
  | "decideApprovalRequest"
  | "expireApprovalRequest"
  | "findObjectiveApprovalGrant"
  | "findTagById"
  | "findTaskById"
  | "getApprovalRequest"
  | "getObjective"
  | "getSurfaceObjective"
  | "getTaskAssignment"
  | "listApprovalRequests"
  | "listTagPermissionSets"
  | "listTagPermissions"
  | "listTaskAttempts"
  | "requestActionApproval"
  | "updateTaskAssignment"
>;

/** Identity of the Task whose Attempt asks for, or decides, an approval. */
export interface ApprovalCaller {
  readonly taskId: string;
  readonly attemptId: string | null;
  readonly tagId: string;
  readonly objectiveId: string | null;
}

export interface ApprovalDecisionInput {
  readonly requestId: string;
  readonly decision: "approve" | "deny";
  readonly scope?: ApprovalScope;
  readonly validUntil?: string;
  readonly reason?: string;
}

export interface ApprovalSummary {
  readonly pending: number;
  readonly decidedLastDay: { readonly approved: number; readonly denied: number };
}

const TERMINAL_ASSIGNMENT = ["accepted", "rejected", "cancelled", "failed"];
const TERMINAL_TASK = ["completed", "failed", "cancelled"];

/**
 * Durable approval lifecycle for `approval: required` permissions: request, match an existing
 * decision, decide, and notify. Deterministic; no natural-language policy is evaluated here.
 */
export class ApprovalCoordinator {
  constructor(
    private readonly store: ApprovalPersistence,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** Runtime approvals a Task admission must hold for, after existing Objective-scope grants. */
  async taskAdmission(
    objectiveId: string,
    approvals: readonly TagApprovalRequirement[] | undefined,
  ): Promise<{
    readonly ungranted: readonly TagApprovalRequirement[];
    readonly grants: readonly { requirement: TagApprovalRequirement; grant: ApprovalRequest }[];
  }> {
    const ungranted: TagApprovalRequirement[] = [];
    const grants: { requirement: TagApprovalRequirement; grant: ApprovalRequest }[] = [];
    for (const requirement of approvals ?? []) {
      if (requirement.target !== "runtime") continue;
      const grant = await this.store.findObjectiveApprovalGrant(objectiveId, {
        target: "runtime",
        action: requirement.action,
      });
      if (grant) grants.push({ requirement, grant });
      else ungranted.push(requirement);
    }
    return { ungranted, grants };
  }

  /** Record the durable request for a Task admitted with pending approval. */
  async recordTaskAdmission(
    assignment: TaskAssignment,
    admission: Awaited<ReturnType<ApprovalCoordinator["taskAdmission"]>>,
    managerRequested: boolean,
  ): Promise<void> {
    try {
      for (const { requirement, grant } of admission.grants)
        await this.event(assignment.taskId, "approval.granted-by-scope", {
          requestId: grant.id,
          actions: [{ target: "runtime", action: requirement.action }],
          ruleSources: requirement.permissionSets,
          decidedBy: grant.decidedBy,
          decidedByKind: grant.decidedByKind,
        });
      if (assignment.approval !== "pending") return;
      const [existing] = await this.store.listApprovalRequests({
        taskId: assignment.taskId,
        kind: "task",
        limit: 1,
      });
      if (existing) return;
      const tag = await this.store.findTagById(assignment.assignedTagId);
      const actions = admission.ungranted.map((requirement) => ({
        target: "runtime" as const,
        action: requirement.action,
      }));
      const request = await this.store.createApprovalRequest({
        objectiveId: assignment.objectiveId,
        taskId: assignment.taskId,
        requestingTagId: assignment.requestedByTagId,
        kind: "task",
        actions,
        summary: `Start Task ${assignment.taskId} for ${tag?.name ?? assignment.assignedTagId}${
          actions.length
            ? ` with ${actions.map((action) => action.action).join(", ")}`
            : " (requested by its manager)"
        }: ${assignment.instruction}`,
        ruleSources: [...new Set(admission.ungranted.flatMap((entry) => entry.permissionSets))],
        approvers: [...new Set(admission.ungranted.flatMap((entry) => entry.approvers))],
      });
      await this.event(assignment.taskId, "approval.requested", {
        requestId: request.id,
        kind: request.kind,
        actions: request.actions,
        ruleSources: request.ruleSources,
        heldBy: actions.length ? "permission" : "manager",
        ...(actions.length && managerRequested ? { managerRequested: true } : {}),
      });
    } catch (error) {
      this.onError(error);
    }
  }

  /** Worker-side check before forwarding one surface or MCP action marked `approval: required`. */
  async requestAction(caller: ApprovalCaller, value: unknown) {
    const input = mailboxObject(value, ["objectiveId", "action", "argumentsDigest", "summary"]);
    const action = parseApprovalActionDescriptor(input["action"]);
    if (action.target === "runtime")
      throw new TagMessagingError(400, "Action approval covers surface and MCP actions");
    const task = await this.store.findTaskById(caller.taskId);
    if (!task) throw new TagMessagingError(404, "Task not found");
    const requirement = approvalRequirementFor(task.authorizationSnapshot.approvals, action);
    if (!requirement) return { status: "granted" as const, reason: "Approval is not required" };
    const summary = sanitizeApprovalText(
      typeof input["summary"] === "string" && input["summary"].trim()
        ? input["summary"]
        : describeApprovalAction(action),
    );
    const result = await this.store.requestActionApproval({
      objectiveId: caller.objectiveId,
      taskId: caller.taskId,
      attemptId: caller.attemptId,
      requestingTagId: caller.tagId,
      kind: "surface-action",
      actions: [action],
      argumentsDigest: mailboxText(input["argumentsDigest"], "argumentsDigest"),
      summary,
      ruleSources: requirement.permissionSets,
      approvers: requirement.approvers,
    });
    const request = result.request;
    if (result.status === "granted")
      await this.event(
        caller.taskId,
        result.via === "objective" ? "approval.granted-by-scope" : "approval.consumed",
        {
          requestId: request.id,
          actions: [action],
          ruleSources: requirement.permissionSets,
          decidedBy: request.decidedBy,
          decidedByKind: request.decidedByKind,
        },
        caller.attemptId,
      );
    else if (result.status === "pending" && result.created)
      await this.event(
        caller.taskId,
        "approval.requested",
        {
          requestId: request.id,
          kind: request.kind,
          actions: request.actions,
          argumentsDigest: request.argumentsDigest,
          ruleSources: request.ruleSources,
        },
        caller.attemptId,
      );
    return {
      status: result.status,
      requestId: request.id,
      ...(result.status === "granted" ? { scope: result.via } : {}),
      ...(result.status === "denied" && request.reason ? { reason: request.reason } : {}),
      ruleSources: request.ruleSources,
    };
  }

  /** One request for a lead's expected plan; approval creates Objective-scope grants. */
  async requestPlan(caller: ApprovalCaller, value: unknown) {
    const input = mailboxObject(value, ["objectiveId", "actions", "summary"]);
    if (!caller.objectiveId) throw new TagMessagingError(400, "Plan approval needs an Objective");
    if (!Array.isArray(input["actions"]) || input["actions"].length === 0)
      throw new TagMessagingError(400, "actions must list at least one expected action");
    if (input["actions"].length > 50)
      throw new TagMessagingError(400, "A plan approval covers at most 50 actions");
    const actions = input["actions"].map(parseApprovalActionDescriptor);
    const summary = boundedText(input["summary"], "summary", 2000);
    const uncovered: ApprovalActionDescriptor[] = [];
    for (const action of actions)
      if (!(await this.store.findObjectiveApprovalGrant(caller.objectiveId, action)))
        uncovered.push(action);
    if (uncovered.length === 0)
      return { status: "granted" as const, reason: "Every action already has an Objective grant" };
    const rules = await this.rulesFor(uncovered);
    const [existing] = (
      await this.store.listApprovalRequests({
        objectiveId: caller.objectiveId,
        taskId: caller.taskId,
        kind: "plan",
        status: "pending",
        limit: 20,
      })
    ).filter(
      (request) =>
        request.actions.length === uncovered.length &&
        uncovered.every((action) =>
          request.actions.some((candidate) => approvalActionsMatch(candidate, action)),
        ),
    );
    if (existing) return { status: "pending" as const, requestId: existing.id };
    const request = await this.store.createApprovalRequest({
      objectiveId: caller.objectiveId,
      taskId: caller.taskId,
      attemptId: caller.attemptId,
      requestingTagId: caller.tagId,
      kind: "plan",
      actions: uncovered,
      summary,
      ruleSources: rules.ruleSources,
      approvers: rules.approvers,
    });
    await this.event(
      caller.taskId,
      "approval.requested",
      {
        requestId: request.id,
        kind: request.kind,
        actions: request.actions,
        ruleSources: request.ruleSources,
      },
      caller.attemptId,
    );
    return { status: "pending" as const, requestId: request.id };
  }

  async decideAsTag(caller: ApprovalCaller, value: unknown) {
    const input = parseDecision(value);
    const request = await this.store.getApprovalRequest(input.requestId);
    if (!request || request.objectiveId !== caller.objectiveId)
      throw new TagMessagingError(404, "Approval request not found");
    const tag = await this.store.findTagById(caller.tagId);
    if (!tag) throw new TagMessagingError(404, "Tag not found");
    if (request.requestingTagId === tag.id || (await this.assigneeOf(request)) === tag.id)
      throw new TagMessagingError(403, "A Tag cannot decide its own approval request");
    if (!approversIncludeTag(request.approvers, tag))
      throw new TagMessagingError(
        403,
        "This Tag is not an approver for the Permission Sets that require this approval",
      );
    return this.decide(request, input, { kind: "tag", id: tag.id });
  }

  async decideAsOperator(value: unknown, operatorId: string) {
    const input = parseDecision(value);
    const request = await this.store.getApprovalRequest(input.requestId);
    if (!request) throw new TagMessagingError(404, "Approval request not found");
    if (!approversAdmitOperator(request.approvers, operatorId))
      throw new TagMessagingError(
        403,
        "The Permission Sets that require this approval name other operator approvers",
      );
    return this.decide(request, input, { kind: "operator", id: operatorId });
  }

  async get(id: string) {
    return this.store.getApprovalRequest(id);
  }

  /** Mark approvals applied through the direct Task approval path as decided. */
  async settleTaskApproved(taskId: string, operatorId: string): Promise<void> {
    for (const request of await this.store.listApprovalRequests({
      taskId,
      kind: "task",
      status: "pending",
    })) {
      try {
        const decided = await this.store.decideApprovalRequest({
          id: request.id,
          decision: "approve",
          scope: "once",
          decidedBy: operatorId,
          decidedByKind: "operator",
        });
        await this.event(taskId, "approval.approved", eventPayload(decided));
      } catch (error) {
        this.onError(error);
      }
    }
  }

  async list(filter: {
    readonly objectiveId?: string;
    readonly status?: ApprovalRequestStatus;
    readonly limit?: number;
  }): Promise<readonly ApprovalRequest[]> {
    const requests = await this.store.listApprovalRequests(filter);
    // Requests whose Task already finished can never be used; expire them lazily.
    return Promise.all(
      requests.map(async (request) =>
        request.status === "pending" && (await this.taskFinished(request))
          ? ((await this.store.expireApprovalRequest(request.id)) ?? request)
          : request,
      ),
    ).then((values) =>
      filter.status === undefined
        ? values
        : values.filter((value) => value.status === filter.status),
    );
  }

  /**
   * One digest per Objective of pending action and plan requests. Task approvals keep their
   * existing per-Task notice. The key changes whenever the pending set changes.
   */
  async digests(): Promise<readonly { objectiveId: string; text: string; key: string }[]> {
    const pending = (await this.store.listApprovalRequests({ status: "pending", limit: 200 }))
      .filter((request) => request.kind !== "task" && request.objectiveId !== null)
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    const byObjective = new Map<string, ApprovalRequest[]>();
    for (const request of pending) {
      const objectiveId = request.objectiveId as string;
      byObjective.set(objectiveId, [...(byObjective.get(objectiveId) ?? []), request]);
    }
    return [...byObjective].map(([objectiveId, requests]) => {
      const shown = requests.slice(0, 10);
      const text = [
        `${requests.length} approval request${requests.length === 1 ? " is" : "s are"} waiting in Objective ${objectiveId}:`,
        ...shown.map(approvalRequestLine),
        ...(requests.length > shown.length ? [`…and ${requests.length - shown.length} more.`] : []),
        approvalReviewHint(objectiveId),
      ].join("\n");
      const key = `approval-digest:${createHash("sha256")
        .update(JSON.stringify([objectiveId, requests.map((request) => request.id)]))
        .digest("hex")}`;
      return { objectiveId, text, key };
    });
  }

  async summary(objectiveId: string, now = new Date()): Promise<ApprovalSummary> {
    const [pending, decided] = await Promise.all([
      this.store.listApprovalRequests({ objectiveId, status: "pending", limit: 500 }),
      this.store.listApprovalRequests({
        objectiveId,
        decidedAfter: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
        limit: 500,
      }),
    ]);
    return {
      pending: pending.length,
      decidedLastDay: {
        approved: decided.filter((request) => request.status === "approved").length,
        denied: decided.filter((request) => request.status === "denied").length,
      },
    };
  }

  private async decide(
    request: ApprovalRequest,
    input: ApprovalDecisionInput,
    decider: { readonly kind: "operator" | "tag"; readonly id: string },
  ): Promise<ApprovalRequest> {
    if (request.status === "pending" && (await this.taskFinished(request))) {
      await this.store.expireApprovalRequest(request.id);
      throw new TagMessagingError(409, "The requesting Task already finished; request expired");
    }
    const scope =
      input.decision === "approve"
        ? (input.scope ?? (request.kind === "plan" ? "objective" : "once"))
        : undefined;
    if (request.kind === "plan" && scope === "once")
      throw new TagMessagingError(400, "A plan approval applies to the Objective; omit --scope");
    const objective = request.objectiveId
      ? await this.store.getObjective(request.objectiveId)
      : undefined;
    const verb = input.decision === "approve" ? "approved" : "denied";
    const text = [
      `Approval request ${request.id} was ${verb}${scope ? ` (scope: ${scope}${input.validUntil ? ` until ${input.validUntil}` : ""})` : ""}.`,
      input.reason ? `Reason: ${input.reason}` : "",
      input.decision === "approve"
        ? request.kind === "surface-action"
          ? "Retry the same call to continue."
          : ""
        : "Choose another approach or explain why the action is needed.",
    ]
      .filter(Boolean)
      .join("\n");
    const decided = await this.store.decideApprovalRequest({
      id: request.id,
      decision: input.decision,
      ...(scope === undefined ? {} : { scope }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      decidedBy: decider.id,
      decidedByKind: decider.kind,
      ...(objective
        ? {
            message: {
              senderTagId: decider.kind === "tag" ? decider.id : objective.ownerTagId,
              ...(decider.kind === "operator" ? { operatorId: decider.id } : {}),
              body: {
                message: text.slice(0, 8000),
                approval: {
                  requestId: request.id,
                  decision: verb,
                  kind: request.kind,
                  taskId: request.taskId,
                  scope: scope ?? null,
                  validUntil: input.validUntil ?? null,
                  reason: input.reason ?? null,
                },
              },
            },
          }
        : {}),
    });
    await this.event(
      request.taskId,
      input.decision === "approve" ? "approval.approved" : "approval.denied",
      eventPayload(decided),
    );
    if (request.kind === "task" && objective) {
      const change =
        input.decision === "approve"
          ? { expectedStatus: "queued" as const, approval: "approved" as const }
          : { expectedStatus: "queued" as const, status: "cancelled" as const };
      try {
        await this.store.updateTaskAssignment(request.taskId, change, objective.ownerTagId, {
          administrator: true,
        });
      } catch (error) {
        // The Task may already be approved or cancelled through the direct Task path.
        if (!(error instanceof TagMessagingError && error.statusCode === 409)) throw error;
      }
    }
    return decided;
  }

  private async rulesFor(actions: readonly ApprovalActionDescriptor[]) {
    const sets = await this.store.listTagPermissionSets();
    const ruleSources = new Set<string>();
    const approvers = new Set<string>();
    for (const set of sets) {
      const permissions = await this.store.listTagPermissions({ permissionSetId: set.id });
      const requires = permissions.some(
        (permission) =>
          permission.approval === "required" &&
          actions.some((action) =>
            permission.target === "mcp"
              ? action.target === "mcp" &&
                mcpApprovalRequirementCovers(
                  {
                    target: "mcp",
                    action: permission.action,
                    ...(permission.resource === undefined ? {} : { resource: permission.resource }),
                    permissionSets: [],
                    approvers: [],
                  },
                  action,
                )
              : approvalActionsMatch(
                  permission.target === "runtime"
                    ? { target: "runtime", action: permission.action }
                    : {
                        target: "surface",
                        action: permission.action,
                        surfaceAccountId: permission.surfaceAccountId,
                        scope: permission.scope,
                      },
                  action,
                ),
          ),
      );
      if (!requires) continue;
      ruleSources.add(set.name);
      for (const approver of set.approvers ?? []) approvers.add(approver);
    }
    return { ruleSources: [...ruleSources], approvers: [...approvers] };
  }

  private async assigneeOf(request: ApprovalRequest): Promise<string | undefined> {
    if (request.kind !== "task") return undefined;
    return (await this.store.getTaskAssignment(request.taskId))?.assignedTagId;
  }

  private async taskFinished(request: ApprovalRequest): Promise<boolean> {
    if (request.kind === "plan") return false;
    if (request.objectiveId) {
      const assignment = await this.store.getTaskAssignment(request.taskId);
      if (assignment) return TERMINAL_ASSIGNMENT.includes(assignment.status);
    }
    const task = await this.store.findTaskById(request.taskId);
    return !task || TERMINAL_TASK.includes(task.status);
  }

  private async event(
    taskId: string,
    type: string,
    payload: Record<string, unknown>,
    attemptId?: string | null,
  ): Promise<void> {
    try {
      await this.store.appendTaskEvent({
        taskId,
        ...(attemptId ? { attemptId } : {}),
        type,
        payload: JSON.parse(JSON.stringify(payload)),
      });
    } catch (error) {
      this.onError(error);
    }
  }
}

/** One pending request in a notice: its id, the action it names, and the sets that require it. */
function approvalRequestLine(request: ApprovalRequest): string {
  return `- ${request.id}: ${request.summary}${request.ruleSources.length ? ` (required by ${request.ruleSources.join(", ")})` : ""}`;
}

function approvalReviewHint(objectiveId?: string): string {
  return `Review with supertag list approval${objectiveId === undefined ? "" : ` --objective ${objectiveId}`}, then supertag approve request ID or supertag deny request ID --reason TEXT.`;
}

/**
 * The notice a work Session's pending approval request posts to its conversation. A chat message
 * never decides it; the approval commands do.
 */
export function workSessionApprovalNotice(title: string, request: ApprovalRequest): string {
  return [
    `Work Session ${JSON.stringify(title)} is waiting for approval:`,
    approvalRequestLine(request),
    approvalReviewHint(request.objectiveId ?? undefined),
  ].join("\n");
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new TagMessagingError(
      400,
      `${field} must be nonempty text of at most ${maximum} characters`,
    );
  return value.trim();
}

function parseDecision(value: unknown): ApprovalDecisionInput {
  const input = mailboxObject(value, [
    "objectiveId",
    "requestId",
    "decision",
    "scope",
    "validUntil",
    "reason",
  ]);
  const decision = input["decision"];
  if (decision !== "approve" && decision !== "deny")
    throw new TagMessagingError(400, "decision must be approve or deny");
  const scope = input["scope"];
  if (scope !== undefined && scope !== "once" && scope !== "objective")
    throw new TagMessagingError(400, "scope must be once or objective");
  if (decision === "deny" && (scope !== undefined || input["validUntil"] !== undefined))
    throw new TagMessagingError(400, "A denial takes only a reason");
  const reason =
    input["reason"] === undefined
      ? undefined
      : sanitizeApprovalText(
          boundedText(input["reason"], "reason", APPROVAL_REASON_MAX_LENGTH),
          APPROVAL_REASON_MAX_LENGTH,
        );
  if (decision === "deny" && !reason)
    throw new TagMessagingError(400, "A denial requires a reason");
  return {
    requestId: mailboxText(input["requestId"], "requestId"),
    decision,
    ...(scope === undefined ? {} : { scope }),
    ...(input["validUntil"] === undefined
      ? {}
      : { validUntil: mailboxText(input["validUntil"], "validUntil") }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function eventPayload(request: ApprovalRequest) {
  return {
    requestId: request.id,
    kind: request.kind,
    actions: request.actions,
    ruleSources: request.ruleSources,
    scope: request.scope,
    validUntil: request.validUntil,
    decidedBy: request.decidedBy,
    decidedByKind: request.decidedByKind,
    reason: request.reason,
  };
}
