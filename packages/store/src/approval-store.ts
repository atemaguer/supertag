// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.
import { randomUUID } from "node:crypto";
import {
  type ActionApprovalResult,
  APPROVAL_REASON_MAX_LENGTH,
  type ApprovalActionDescriptor,
  type ApprovalRequest,
  type ApprovalRequestListFilter,
  type ApprovalRequestStore,
  approvalActionsMatch,
  type CreateApprovalRequestInput,
  type DatabaseProvider,
  type DecideApprovalRequestInput,
  mailboxText,
  normalizeApprovers,
  parseApprovalActionDescriptor,
  sanitizeApprovalText,
  TagMessagingError,
} from "@supertag/core";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";

type Flow<T> = Generator<any, T, any>;

const KINDS = ["surface-action"] as const;
const STATUSES = ["pending", "approved", "denied", "expired"] as const;

export class DrizzleApprovalRequestStore implements ApprovalRequestStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  private transaction<T>(work: (tx: any) => Flow<T>): Promise<T> {
    return runDialectTransaction(this.db, this.provider, work);
  }

  async requestActionApproval(
    input: CreateApprovalRequestInput & { readonly now?: string },
  ): Promise<ActionApprovalResult> {
    const values = requestValues(input);
    const [action] = values.actions;
    if (values.actions.length !== 1 || !action)
      throw new TagMessagingError(400, "An action request covers exactly one action");
    const now = input.now ?? new Date().toISOString();
    const t = this.tables.approvalRequests;
    const self = this;
    return this.transaction(function* (tx) {
      if (values.objectiveId) {
        const grant = yield* self.objectiveGrant(tx, values.objectiveId, action, now);
        if (grant) return { status: "granted" as const, via: "objective" as const, request: grant };
      }
      // A work Session matches across its Tasks, so its next Task's retry finds the decision.
      const covering = input.coveringTaskIds?.length
        ? [
            ...new Set([
              values.taskId,
              ...input.coveringTaskIds.map((id) => mailboxText(id, "taskId")),
            ]),
          ]
        : [values.taskId];
      const rows = (yield tx
        .select()
        .from(t)
        .where(and(inArray(t.taskId, covering), eq(t.kind, values.kind)))
        .orderBy(desc(t.createdAt), desc(t.id))) as any[];
      const matching = rows.filter(
        (row) =>
          row.argumentsDigest === values.argumentsDigest &&
          Array.isArray(row.actions) &&
          row.actions.length === 1 &&
          approvalActionsMatch(row.actions[0], action),
      );
      const approved = matching.find(
        (row) =>
          row.status === "approved" &&
          row.scope === "once" &&
          row.consumedAt === null &&
          (row.validUntil === null || row.validUntil > now),
      );
      if (approved) {
        const [consumed] = yield tx
          .update(t)
          .set({ consumedAt: now, updatedAt: now })
          .where(and(eq(t.id, approved.id), isNull(t.consumedAt)))
          .returning();
        if (consumed)
          return { status: "granted" as const, via: "once" as const, request: fromRow(consumed) };
      }
      const pending = matching.find((row) => row.status === "pending");
      if (pending) return { status: "pending" as const, request: fromRow(pending), created: false };
      // A denial holds for every covered Task: a work Session that retries a denied action, in
      // this Task or a later one, gets the same answer; new work takes a new work Session.
      const latest = matching[0];
      if (latest?.status === "denied")
        return { status: "denied" as const, request: fromRow(latest) };
      const [created] = yield tx
        .insert(t)
        .values({ ...values, id: randomUUID(), status: "pending", createdAt: now, updatedAt: now })
        .returning();
      return { status: "pending" as const, request: fromRow(created), created: true };
    });
  }

  async findObjectiveApprovalGrant(
    objectiveId: string,
    action: ApprovalActionDescriptor,
    now = new Date().toISOString(),
  ): Promise<ApprovalRequest | undefined> {
    const self = this;
    return this.transaction(function* (tx) {
      return yield* self.objectiveGrant(tx, objectiveId, action, now);
    });
  }

  private *objectiveGrant(
    tx: any,
    objectiveId: string,
    action: ApprovalActionDescriptor,
    now: string,
  ): Flow<ApprovalRequest | undefined> {
    const t = this.tables.approvalRequests;
    const rows = (yield tx
      .select()
      .from(t)
      .where(
        and(eq(t.objectiveId, objectiveId), eq(t.status, "approved"), eq(t.scope, "objective")),
      )
      .orderBy(desc(t.decidedAt), desc(t.id))) as any[];
    const grant = rows.find(
      (row) =>
        (row.validUntil === null || row.validUntil > now) &&
        Array.isArray(row.actions) &&
        row.actions.some((candidate: ApprovalActionDescriptor) =>
          approvalActionsMatch(candidate, action),
        ),
    );
    return grant ? fromRow(grant) : undefined;
  }

  async createApprovalRequest(input: CreateApprovalRequestInput): Promise<ApprovalRequest> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(this.tables.approvalRequests)
      .values({
        ...requestValues(input),
        id: randomUUID(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return fromRow(created);
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequest | undefined> {
    const t = this.tables.approvalRequests;
    const [row] = await this.db
      .select()
      .from(t)
      .where(eq(t.id, mailboxText(id, "id")))
      .limit(1);
    return row ? fromRow(row) : undefined;
  }

  async listApprovalRequests(
    filter: ApprovalRequestListFilter = {},
  ): Promise<readonly ApprovalRequest[]> {
    const t = this.tables.approvalRequests;
    const limit = filter.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new TagMessagingError(400, "limit must be an integer between 1 and 500");
    if (filter.status !== undefined && !STATUSES.includes(filter.status))
      throw new TagMessagingError(400, "Unknown approval status");
    if (filter.kind !== undefined && !KINDS.includes(filter.kind))
      throw new TagMessagingError(400, "Unknown approval kind");
    const conditions = [
      filter.objectiveId === undefined ? undefined : eq(t.objectiveId, filter.objectiveId),
      filter.taskId === undefined ? undefined : eq(t.taskId, filter.taskId),
      filter.kind === undefined ? undefined : eq(t.kind, filter.kind),
      filter.status === undefined ? undefined : eq(t.status, filter.status),
      filter.decidedAfter === undefined ? undefined : gte(t.decidedAt, filter.decidedAfter),
    ].filter((condition) => condition !== undefined);
    const rows = await this.db
      .select()
      .from(t)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit);
    return rows.map(fromRow);
  }

  async decideApprovalRequest(input: DecideApprovalRequestInput): Promise<ApprovalRequest> {
    const id = mailboxText(input.id, "id");
    if (input.decision !== "approve" && input.decision !== "deny")
      throw new TagMessagingError(400, "decision must be approve or deny");
    const scope = input.decision === "approve" ? (input.scope ?? "once") : null;
    if (scope !== null && scope !== "once" && scope !== "objective")
      throw new TagMessagingError(400, "scope must be once or objective");
    const reason =
      input.reason === undefined
        ? null
        : sanitizeApprovalText(String(input.reason), APPROVAL_REASON_MAX_LENGTH);
    if (input.decision === "deny" && !reason)
      throw new TagMessagingError(400, "A denial requires a reason");
    const decidedBy = mailboxText(input.decidedBy, "decidedBy");
    if (input.decidedByKind !== "operator" && input.decidedByKind !== "tag")
      throw new TagMessagingError(400, "Invalid decider");
    const now = new Date().toISOString();
    let validUntil: string | null = null;
    if (input.validUntil !== undefined) {
      if (input.decision !== "approve")
        throw new TagMessagingError(400, "validUntil applies only to approvals");
      const parsed = Date.parse(input.validUntil);
      if (!Number.isFinite(parsed) || parsed <= Date.parse(now))
        throw new TagMessagingError(400, "validUntil must be a future ISO-8601 timestamp");
      validUntil = new Date(parsed).toISOString();
    }
    const t = this.tables.approvalRequests;
    return this.transaction(function* (tx) {
      const [row] = yield tx.select().from(t).where(eq(t.id, id)).limit(1);
      if (!row) throw new TagMessagingError(404, "Approval request not found");
      if (row.status !== "pending")
        throw new TagMessagingError(409, `Approval request is already ${row.status}`);
      if (scope === "objective" && row.objectiveId === null)
        throw new TagMessagingError(
          400,
          "Objective scope requires a request made within an Objective",
        );
      const [updated] = yield tx
        .update(t)
        .set({
          status: input.decision === "approve" ? "approved" : "denied",
          scope,
          validUntil,
          decidedBy,
          decidedByKind: input.decidedByKind,
          decidedAt: now,
          reason,
          updatedAt: now,
        })
        .where(and(eq(t.id, id), eq(t.status, "pending")))
        .returning();
      if (!updated) throw new TagMessagingError(409, "Approval request changed; reload it");
      return fromRow(updated);
    });
  }

  async expireApprovalRequest(id: string): Promise<ApprovalRequest | undefined> {
    const t = this.tables.approvalRequests;
    const now = new Date().toISOString();
    const [row] = await this.db
      .update(t)
      .set({ status: "expired", decidedAt: now, updatedAt: now })
      .where(and(eq(t.id, mailboxText(id, "id")), inArray(t.status, ["pending"])))
      .returning();
    return row ? fromRow(row) : undefined;
  }
}

/**
 * Expires pending approval requests when an Objective closes. The caller holds the Objective
 * lock and runs this in the transaction that records the closing status.
 */
export function* expireClosedObjectiveApprovals(
  tx: any,
  tables: any,
  objectiveId: string,
  status: "completed" | "cancelled",
  at: string,
): Flow<void> {
  const a = tables.approvalRequests;
  yield tx
    .update(a)
    .set({
      status: "expired",
      decidedAt: at,
      reason: status === "cancelled" ? "Objective cancelled" : "Objective completed",
      updatedAt: at,
    })
    .where(and(eq(a.objectiveId, objectiveId), eq(a.status, "pending")))
    .returning();
}

function requestValues(input: CreateApprovalRequestInput) {
  if (!KINDS.includes(input.kind)) throw new TagMessagingError(400, "Unknown approval kind");
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 50)
    throw new TagMessagingError(400, "An approval request covers between 1 and 50 actions");
  const summary = sanitizeApprovalText(String(input.summary ?? ""));
  if (!summary) throw new TagMessagingError(400, "An approval request requires a summary");
  const digest = input.argumentsDigest ?? null;
  if (digest !== null && !/^sha256:[0-9a-f]{64}$/u.test(digest))
    throw new TagMessagingError(400, "argumentsDigest must be a sha256 digest");
  return {
    objectiveId: input.objectiveId === null ? null : mailboxText(input.objectiveId, "objectiveId"),
    taskId: mailboxText(input.taskId, "taskId"),
    attemptId: input.attemptId ?? null,
    requestingTagId: mailboxText(input.requestingTagId, "requestingTagId"),
    kind: input.kind,
    actions: input.actions.map(parseApprovalActionDescriptor),
    argumentsDigest: digest,
    summary,
    ruleSources: [...new Set(input.ruleSources.map(String))].sort(),
    approvers: normalizeApprovers(input.approvers),
  };
}

function fromRow(row: any): ApprovalRequest {
  return {
    id: row.id,
    objectiveId: row.objectiveId ?? null,
    taskId: row.taskId,
    attemptId: row.attemptId ?? null,
    requestingTagId: row.requestingTagId,
    kind: row.kind,
    actions: Array.isArray(row.actions) ? row.actions : [],
    argumentsDigest: row.argumentsDigest ?? null,
    summary: row.summary,
    ruleSources: Array.isArray(row.ruleSources) ? row.ruleSources : [],
    approvers: Array.isArray(row.approvers) ? row.approvers : [],
    status: row.status,
    scope: row.scope ?? null,
    validUntil: row.validUntil ?? null,
    decidedBy: row.decidedBy ?? null,
    decidedByKind: row.decidedByKind ?? null,
    decidedAt: row.decidedAt ?? null,
    reason: row.reason ?? null,
    consumedAt: row.consumedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
