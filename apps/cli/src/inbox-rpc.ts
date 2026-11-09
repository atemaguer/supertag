import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type { CoordinationOperatorPrincipal } from "@supertag/control-plane";
import { objectiveMessageDeliveryId } from "@supertag/core";
import {
  ApprovalSchema,
  ErrorReason,
  type InboxService,
  type MessageObjectiveResponse,
  MessageObjectiveResponseSchema,
} from "@supertag/operator-api";
import {
  APPROVAL_SCOPE,
  APPROVAL_STATUS,
  approvalMessage,
  INBOX_KIND,
  inboxItemMessage,
  OBJECTIVE_STATUS,
} from "./objective-protos.js";
import {
  drainingError,
  operatorAuditTarget,
  operatorError,
  operatorPrincipal,
} from "./operator-rpc-context.js";
import type { OperatorControl, OperatorQueries, OperatorReadStore } from "./operator-seams.js";

export interface InboxServiceDependencies {
  readonly store: OperatorReadStore;
  readonly queries: Pick<OperatorQueries, "readCoordinationInbox" | "listApprovalRequests">;
  /** Decides approvals and admits answers as turns. */
  readonly control: Pick<OperatorControl, "accepting" | "decideApproval" | "messageObjective">;
}

/** `InboxService`: what waits on a person, and the decisions that settle it. */
export function inboxService(
  dependencies: InboxServiceDependencies,
): ServiceImpl<typeof InboxService> {
  const { store, queries, control } = dependencies;
  return {
    async listInboxItems(request, context) {
      const kind = INBOX_KIND.word(request.kind);
      const page = await queries.readCoordinationInbox(
        {
          ...(request.objectiveId === "" ? {} : { objectiveId: request.objectiveId }),
          ...(kind === undefined ? {} : { kind }),
          ...(request.nextActorTagId === "" ? {} : { nextActorId: request.nextActorTagId }),
          ...(request.pageToken === "" ? {} : { cursor: request.pageToken }),
          limit: pageSizeOf(request.pageSize, 50, 100),
        },
        callerPrincipal(context),
      );
      return {
        asOf: timestampFromDate(new Date(page.asOf)),
        items: page.items.map(inboxItemMessage),
        tagNames: { ...page.tagNames },
        truncatedKinds: page.truncatedKinds.map((truncated) => INBOX_KIND.value(truncated)),
        nextPageToken: page.nextCursor ?? "",
      };
    },

    async listApprovals(request, context) {
      const status = APPROVAL_STATUS.word(request.status);
      const before = approvalCursor(request.pageToken);
      const page = await queries.listApprovalRequests(
        {
          ...(request.objectiveId === "" ? {} : { objectiveId: request.objectiveId }),
          status: status ?? "all",
          ...(before === undefined ? {} : { before }),
          limit: pageSizeOf(request.pageSize, 100, 500),
        },
        callerPrincipal(context),
      );
      return {
        approvals: page.requests.map(approvalMessage),
        nextPageToken: page.next === undefined ? "" : approvalToken(page.next),
      };
    },

    async approve(request, context) {
      const id = requiredId(request.id, context, "ApprovalRequest");
      await assertAccepting(control);
      const scope = APPROVAL_SCOPE.word(request.scope);
      const decided = await control.decideApproval(
        {
          requestId: id,
          decision: "approve",
          ...(scope === undefined ? {} : { scope }),
          ...(request.validUntil === undefined
            ? {}
            : { validUntil: timestampDate(request.validUntil).toISOString() }),
        },
        callerPrincipal(context),
      );
      return create(ApprovalSchema, approvalMessage(decided));
    },

    async deny(request, context) {
      const id = requiredId(request.id, context, "ApprovalRequest");
      await assertAccepting(control);
      if (!request.reason.replace(/\p{Cc}/gu, "").trim())
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "A denial requires a reason",
          [{ path: "reason", description: "why, not only whitespace" }],
        );
      const decided = await control.decideApproval(
        { requestId: id, decision: "deny", reason: request.reason },
        callerPrincipal(context),
      );
      return create(ApprovalSchema, approvalMessage(decided));
    },

    async answerQuestion(request, context) {
      const taskId = /^question:(.+)$/su.exec(request.key)?.[1];
      const task = taskId === undefined ? undefined : await store.findTaskById(taskId);
      if (task?.objectiveId === undefined)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "The key names no question item",
          [{ path: "key", description: "the key of an inbox item of kind question" }],
        );
      const objectiveId = task.objectiveId;
      const note = context.values.get(operatorAuditTarget);
      if (note !== undefined) note.target = `Objective/${objectiveId}`;
      assertObjectiveScope(context, objectiveId);
      const text = request.text.trim();
      if (!text)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "The answer is empty",
          [{ path: "text", description: "the answer, not only whitespace" }],
        );
      const objective = await objectiveOrNotFound(store, objectiveId);
      const owner = await store.findTagById(objective.ownerTagId);
      const tag = owner?.name ?? objective.ownerTagId;
      if (!(await questionWaits(store, objective, task.id))) {
        const earlier =
          request.idempotencyKey === ""
            ? undefined
            : await answeredWith(
                store,
                task,
                objectiveMessageDeliveryId(objectiveId, request.idempotencyKey),
              );
        if (earlier !== undefined)
          return create(MessageObjectiveResponseSchema, { taskId: earlier, tag, duplicate: true });
        throw operatorError(
          Code.FailedPrecondition,
          ErrorReason.CONFLICT,
          `The question of Objective ${objectiveId} no longer waits on an answer`,
        );
      }
      await assertAccepting(control);
      const result = await control.messageObjective(
        {
          objectiveId,
          text,
          idempotencyKey: request.idempotencyKey || randomUUID(),
        },
        callerPrincipal(context),
      );
      return messageResponse(result, tag);
    },
  };
}

/** The principal the Objective controller authorizes and scopes a call with. */
export function callerPrincipal(context: HandlerContext): CoordinationOperatorPrincipal {
  const caller = context.values.get(operatorPrincipal);
  if (caller === undefined)
    throw operatorError(Code.Internal, ErrorReason.INTERNAL, "Control Plane internal error");
  return caller.principal;
}

/** Refuses an Objective outside the caller's Objective scope. */
export function assertObjectiveScope(context: HandlerContext, objectiveId: string): void {
  const scope = callerPrincipal(context).scopes.objectiveIds;
  if (scope !== undefined && !scope.includes(objectiveId))
    throw operatorError(
      Code.PermissionDenied,
      ErrorReason.PERMISSION_DENIED,
      "Operator is not permitted to access this Objective",
    );
}

/** A request's ID, which names the audit target; `InvalidArgument` when empty. */
export function requiredId(id: string, context: HandlerContext, kind: string): string {
  if (id === "")
    throw operatorError(Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT, "id is required", [
      { path: "id", description: "the ID" },
    ]);
  const note = context.values.get(operatorAuditTarget);
  if (note !== undefined) note.target = `${kind}/${id}`;
  return id;
}

/** New work is refused while the Control Plane drains. */
export async function assertAccepting(control: Pick<OperatorControl, "accepting">): Promise<void> {
  if (!(await control.accepting())) throw drainingError();
}

/** A request's page size: 0 means `fallback`, and more than `max` means `max`. */
export function pageSizeOf(value: number, fallback: number, max: number): number {
  if (value < 0)
    throw operatorError(
      Code.InvalidArgument,
      ErrorReason.INVALID_ARGUMENT,
      "page_size must not be negative",
      [{ path: "page_size", description: `0 to ${max}` }],
    );
  return value === 0 ? fallback : Math.min(value, max);
}

export async function objectiveOrNotFound(store: OperatorReadStore, id: string) {
  try {
    return await store.getObjective(id);
  } catch {
    throw operatorError(Code.NotFound, ErrorReason.NOT_FOUND, `Objective ${id} does not exist`);
  }
}

export function messageResponse(
  result: { readonly taskId: string; readonly duplicate: boolean; readonly statusChange?: string },
  tag: string,
): MessageObjectiveResponse {
  return create(MessageObjectiveResponseSchema, {
    taskId: result.taskId,
    tag,
    duplicate: result.duplicate,
    statusChange:
      result.statusChange === undefined ? 0 : OBJECTIVE_STATUS.value(result.statusChange),
  });
}

/** Whether the question `taskId` asked is still the Objective's latest turn, waiting on an answer. */
async function questionWaits(
  store: OperatorReadStore,
  objective: { readonly id: string; readonly status: string },
  taskId: string,
): Promise<boolean> {
  if (objective.status === "completed" || objective.status === "cancelled") return false;
  const task = await store.findTaskById(taskId);
  if (task === undefined || task.status !== "completed") return false;
  const question = task.outcome?.["question"];
  if (typeof question !== "string" || !question.trim()) return false;
  const session = await store.findSessionById(task.sessionId);
  if (
    session === undefined ||
    session.parentSessionId !== undefined ||
    session.sessionKey !== `objective:${objective.id}`
  )
    return false;
  return (await store.listSessionTaskIds(session.id)).at(-1) === taskId;
}

/** The turn after `question` that an earlier answer with this delivery ID started. */
async function answeredWith(
  store: OperatorReadStore,
  question: { readonly id: string; readonly sessionId: string },
  deliveryId: string,
): Promise<string | undefined> {
  const ids = await store.listSessionTaskIds(question.sessionId);
  for (const id of ids.slice(ids.indexOf(question.id) + 1)) {
    const task = await store.findTaskById(id);
    if (!task?.inboundEventId) continue;
    const inbound = await store.findInboundEventById(task.inboundEventId);
    if (inbound?.event.eventId === deliveryId) return task.id;
  }
  return undefined;
}

function approvalToken(next: { readonly createdAt: string; readonly id: string }): string {
  return Buffer.from(JSON.stringify([next.createdAt, next.id])).toString("base64url");
}

function approvalCursor(token: string): { createdAt: string; id: string } | undefined {
  if (token === "") return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
    )
      return { createdAt: value[0], id: value[1] };
  } catch {}
  throw operatorError(
    Code.InvalidArgument,
    ErrorReason.INVALID_ARGUMENT,
    "The page token is not valid",
    [{ path: "page_token", description: "a next_page_token from the previous page" }],
  );
}
