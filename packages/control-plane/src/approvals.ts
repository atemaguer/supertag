import { createHash } from "node:crypto";
import {
  APPROVAL_REASON_MAX_LENGTH,
  type ApprovalRequest,
  type ApprovalRequestStatus,
  type ApprovalScope,
  approvalRequirementFor,
  approversAdmitOperator,
  describeApprovalAction,
  isInboxSessionKey,
  mailboxObject,
  mailboxText,
  objectiveIdOfSessionKey,
  parseApprovalActionDescriptor,
  type Store,
  sanitizeApprovalText,
  type TagApprovalRequirement,
  TagMessagingError,
  type Task,
} from "@supertag/core";

type ApprovalPersistence = Pick<
  Store,
  | "appendTaskEvent"
  | "decideApprovalRequest"
  | "expireApprovalRequest"
  | "findInboundEventById"
  | "findTaskById"
  | "getApprovalRequest"
  | "listApprovalRequests"
  | "listSessionTaskIds"
  | "requestActionApproval"
>;

/** Identity of the Task whose Attempt asks for an approval. */
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

const TERMINAL_TASK = ["completed", "failed", "cancelled"];

/** Called once an action request is decided. */
export type ApprovalDecisionListener = (request: ApprovalRequest) => Promise<void>;

/** What a decided request tells its requester: the decision, its scope, and what to do next. */
export function approvalDecisionText(
  request: Pick<ApprovalRequest, "id" | "status" | "scope" | "validUntil" | "reason">,
): string {
  const approved = request.status === "approved";
  return [
    `Approval request ${request.id} was ${request.status}${
      approved && request.scope
        ? ` (scope: ${request.scope}${request.validUntil ? ` until ${request.validUntil}` : ""})`
        : ""
    }.`,
    request.reason ? `Reason: ${request.reason}` : "",
    approved
      ? "Retry the same call to continue."
      : "Choose another approach or explain why the action is needed.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Durable approval lifecycle for `approval: required` permissions: request, match an existing
 * decision, decide, and notify. Deterministic; no natural-language policy is evaluated here.
 */
export class ApprovalCoordinator {
  constructor(
    private readonly store: ApprovalPersistence,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  private decisionListener: ApprovalDecisionListener | undefined;
  /** Resumes the Session a decided action request kept waiting; set by the Control Plane. */
  setDecisionListener(listener: ApprovalDecisionListener) {
    this.decisionListener = listener;
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
    // A waiting Session's next Task retries the action its previous Task waited on, so the action
    // matches requests across the Session's Tasks. Earlier Tasks' requests nobody waits on any
    // more expire first, so the retry never waits on one of them.
    const sessionTaskIds = await this.waitingSessionTaskIds(task);
    if (sessionTaskIds !== undefined)
      for (const taskId of sessionTaskIds) {
        if (taskId === caller.taskId) continue;
        for (const stale of await this.store.listApprovalRequests({
          taskId,
          kind: "surface-action",
          status: "pending",
          limit: 500,
        }))
          if (await this.taskFinished(stale)) await this.store.expireApprovalRequest(stale.id);
      }
    const result = await this.store.requestActionApproval({
      ...(sessionTaskIds === undefined ? {} : { coveringTaskIds: sessionTaskIds }),
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

  async decideAsOperator(value: unknown, operatorId: string) {
    const input = parseDecision(value);
    const request = await this.store.getApprovalRequest(input.requestId);
    if (!request) throw new TagMessagingError(404, "Approval request not found");
    if (!approversAdmitOperator(request.approvers, operatorId))
      throw new TagMessagingError(
        403,
        "The Permission Sets that require this approval name other operator approvers",
      );
    return this.decide(request, input, operatorId);
  }

  async get(id: string) {
    return this.store.getApprovalRequest(id);
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

  /** One digest per Objective of pending requests. The key changes whenever the pending set changes. */
  async digests(): Promise<readonly { objectiveId: string; text: string; key: string }[]> {
    const pending = (await this.store.listApprovalRequests({ status: "pending", limit: 200 }))
      .filter((request) => request.objectiveId !== null)
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
    operatorId: string,
  ): Promise<ApprovalRequest> {
    if (request.status === "pending" && (await this.taskFinished(request))) {
      await this.store.expireApprovalRequest(request.id);
      throw new TagMessagingError(409, "The requesting Task already finished; request expired");
    }
    const scope = input.decision === "approve" ? (input.scope ?? "once") : undefined;
    const decided = await this.store.decideApprovalRequest({
      id: request.id,
      decision: input.decision,
      ...(scope === undefined ? {} : { scope }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      decidedBy: operatorId,
      decidedByKind: "operator",
    });
    await this.event(
      request.taskId,
      input.decision === "approve" ? "approval.approved" : "approval.denied",
      eventPayload(decided),
    );
    // Best effort: the Control Plane's sweep continues a waiting Session this misses.
    if (this.decisionListener)
      try {
        await this.decisionListener(decided);
      } catch (error) {
        this.onError(error);
      }
    return decided;
  }

  /**
   * Whether a request can no longer be used because its Task finished. A Task of a waiting
   * Session that completed waiting on the request has not: the request stays pending while the
   * Task is its Session's latest, and its decision continues the Session in the next Task.
   */
  private async taskFinished(request: ApprovalRequest): Promise<boolean> {
    const task = await this.store.findTaskById(request.taskId);
    if (!task) return true;
    if (!TERMINAL_TASK.includes(task.status)) return false;
    if (task.status !== "completed") return true;
    const approvals = task.outcome?.["approvals"];
    if (!Array.isArray(approvals) || !approvals.includes(request.id)) return true;
    const sessionTaskIds = await this.waitingSessionTaskIds(task);
    return sessionTaskIds?.at(-1) !== task.id;
  }

  /**
   * The Task ids, oldest first, of a Session whose Tasks end waiting on approval: a work Session,
   * an Objective's Session or a Tag's inbox. Undefined for a conversation's Task.
   */
  private async waitingSessionTaskIds(task: Task): Promise<readonly string[] | undefined> {
    if (!task.inboundEventId) return undefined;
    const inbound = await this.store.findInboundEventById(task.inboundEventId);
    if (!inbound || !sessionWaitsOnApproval(inbound)) return undefined;
    return this.store.listSessionTaskIds(task.sessionId);
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

/**
 * Whether a turn's Task ends waiting on a pending approval request, so the decision continues its
 * Session: every turn except a conversation's own.
 */
export function sessionWaitsOnApproval(inbound: {
  readonly sessionKey: string;
  readonly event: { readonly internal?: { readonly kind: string } };
}): boolean {
  return (
    inbound.event.internal?.kind === "work_session" ||
    objectiveIdOfSessionKey(inbound.sessionKey) !== undefined ||
    isInboxSessionKey(inbound.sessionKey)
  );
}

/** One pending request in a notice: its id, the action it names, and the sets that require it. */
function approvalRequestLine(request: ApprovalRequest): string {
  return `- ${request.id}: ${request.summary}${request.ruleSources.length ? ` (required by ${request.ruleSources.join(", ")})` : ""}`;
}

function approvalReviewHint(objectiveId?: string): string {
  return `Review with supertag list approval${objectiveId === undefined ? "" : ` --objective ${objectiveId}`}, then supertag approve request ID or supertag deny request ID --reason TEXT.`;
}

/** The admitted requirement a request falls under, in fixed SuperTag words. */
function describeApprovalRequirement(requirement: TagApprovalRequirement): string {
  if (requirement.target === "runtime") return `runtime ${requirement.action}`;
  if (requirement.target === "mcp")
    return `MCP ${requirement.action}${requirement.resource === undefined ? "" : ` on ${requirement.resource}`}`;
  return `${requirement.action} on ${requirement.scope} (account ${requirement.surfaceAccountId})`;
}

/**
 * The notice a work Session's pending approval request posts to its conversation. It names the
 * Tag's admitted requirement the request falls under, never the work Session's own summary: no
 * text a work Session writes reaches a person without a Tag turn. A chat message never decides
 * it; the approval commands do, and `supertag list approval` shows the request in full.
 */
export function workSessionApprovalNotice(
  title: string,
  request: ApprovalRequest,
  requirement: TagApprovalRequirement,
): string {
  return [
    `Work Session ${JSON.stringify(title)} is waiting for approval:`,
    `- ${request.id}: ${describeApprovalRequirement(requirement)} (required by ${requirement.permissionSets.join(", ")})`,
    approvalReviewHint(request.objectiveId ?? undefined),
    "The work Session continues on its own once you decide.",
  ].join("\n");
}

/**
 * Tells the conversation that a decision on a request its work Session waited on did not continue
 * the work Session, in fixed SuperTag words: the work Session's own text never appears here.
 */
export function workSessionNotContinuedNotice(
  title: string,
  requests: readonly Pick<ApprovalRequest, "id" | "status">[],
  reason: "permissions" | "budget",
): string {
  const decided = requests.map((request) => `${request.id} (${request.status})`).join(", ");
  return [
    `Work Session ${JSON.stringify(title)} did not continue after approval request ${decided} was decided:`,
    reason === "permissions"
      ? "this conversation's permissions changed since it last ran. Start a new work Session if the work should go on."
      : "the turn that started it has too little of its token and cost limits left. Send a new message to continue it.",
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
