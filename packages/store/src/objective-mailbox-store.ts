// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.
import { createHash, randomUUID } from "node:crypto";
import {
  type DatabaseProvider,
  mailboxText,
  type ObjectiveMailboxMessage,
  type ObjectiveMailboxStore,
  type OperatorObjectiveMessageResult,
  parseTagMessageInput,
  TAG_MAILBOX_MAX_OUTSTANDING,
  TagMessagingError,
} from "@supertag/core";
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";
import { publicMessage } from "./mailbox-store.js";
import { lockObjective } from "./objective-lock.js";
import { appendResourceChange } from "./resource-change-store.js";
import { restoreTeamsClosedWithObjective } from "./team-store.js";
import { handleOperatorInputs } from "./unhandled-operator-input.js";

export class DrizzleObjectiveMailboxStore implements ObjectiveMailboxStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}
  async enqueueObjectiveMessage(
    input: Parameters<ObjectiveMailboxStore["enqueueObjectiveMessage"]>[0],
  ) {
    const sourceTaskId = mailboxText(input.sourceTaskId, "sourceTaskId");
    if (input.type !== "message" && input.type !== "progress.updated")
      throw new TagMessagingError(400, "Objective messages use message or progress.updated");
    const parsed = parseTagMessageInput({
      recipientTagId: input.senderTagId,
      objectiveId: input.objectiveId,
      type: input.type,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    });
    if (
      typeof parsed.body["message"] !== "string" ||
      !parsed.body["message"].trim() ||
      parsed.body["message"].length > 8000
    )
      throw new TagMessagingError(
        400,
        input.inReplyTo === undefined
          ? "A bounded body.message is required"
          : "Withdrawal requires a non-empty reason in body.message",
      );
    const needsReply = input.needsReply ?? true;
    const inReplyTo =
      input.inReplyTo === undefined ? undefined : mailboxText(input.inReplyTo, "inReplyTo");
    if (inReplyTo && (parsed.type !== "message" || !needsReply))
      throw new TagMessagingError(400, "Withdraw a question with type message and a reason");
    const fingerprint = digest({ type: parsed.type, body: parsed.body, needsReply, inReplyTo });
    const t = this.tables.objectiveMessages,
      o = this.tables.objectives,
      q = this.tables.taskAssignments,
      tags = this.tables.tags;
    const tables = this.tables;
    return runDialectTransaction(this.db, this.provider, function* (tx: any) {
      yield lockObjective(tx, o, parsed.objectiveId);
      const [objective] = yield tx.select().from(o).where(eq(o.id, parsed.objectiveId));
      const [source] = yield tx.select().from(q).where(eq(q.taskId, sourceTaskId));
      const [sender] = yield tx.select().from(tags).where(eq(tags.id, input.senderTagId));
      if (
        !objective ||
        objective.ownerTagId !== input.senderTagId ||
        sender?.status !== "active" ||
        source?.objectiveId !== objective.id ||
        source.assignedTagId !== input.senderTagId
      )
        throw new TagMessagingError(
          403,
          "Only the Objective owner may address its operator from its own Task",
        );
      const [prior] = yield tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.objectiveId, objective.id),
            eq(t.senderTagId, input.senderTagId),
            eq(t.idempotencyKey, parsed.idempotencyKey),
          ),
        );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new TagMessagingError(409, "Message key already used for different content");
        return { message: project(prior), duplicate: true };
      }
      if (objective.status === "completed" || objective.status === "cancelled")
        throw new TagMessagingError(409, `Objective is ${objective.status}`);
      if (inReplyTo) {
        const [question] = yield tx.select().from(t).where(eq(t.id, inReplyTo));
        if (
          !question ||
          question.objectiveId !== objective.id ||
          question.senderTagId !== input.senderTagId
        )
          throw new TagMessagingError(
            403,
            "Only the owner who asked this Objective question may withdraw it",
          );
        if (!question.needsReply || question.replyMessageId || question.resolvedAt)
          throw new TagMessagingError(409, "Objective question is no longer pending");
        const reason = (parsed.body["message"] as string).trim();
        if (!reason) throw new TagMessagingError(400, "Withdrawal requires a non-empty reason");
        const at = new Date().toISOString();
        const [withdrawn] = yield tx
          .update(t)
          .set({
            resolvedAt: at,
            resolutionReason: `Withdrawn by owner: ${reason}`,
            updatedAt: at,
          })
          .where(and(eq(t.id, question.id), isNull(t.resolvedAt), isNull(t.replyMessageId)))
          .returning();
        if (!withdrawn) throw new TagMessagingError(409, "Objective question is no longer pending");
        return { message: project(withdrawn), duplicate: false };
      }
      const [count] = yield tx
        .select({ total: sql`count(*)` })
        .from(t)
        .where(
          and(
            eq(t.objectiveId, objective.id),
            eq(t.needsReply, true),
            isNull(t.replyMessageId),
            isNull(t.resolvedAt),
          ),
        );
      if (Number(count.total) >= TAG_MAILBOX_MAX_OUTSTANDING)
        throw new TagMessagingError(
          429,
          "Objective operator mailbox is at its outstanding message limit",
        );
      const at = new Date().toISOString();
      if (!needsReply) {
        const since = new Date(Date.parse(at) - 60 * 60 * 1000).toISOString();
        const [reports] = yield tx
          .select({ total: sql`count(*)` })
          .from(t)
          .where(
            and(eq(t.objectiveId, objective.id), eq(t.needsReply, false), gt(t.createdAt, since)),
          );
        if (Number(reports.total) >= TAG_MAILBOX_MAX_OUTSTANDING)
          throw new TagMessagingError(429, "Objective owner report limit reached for this hour");
      }
      const [row] = yield tx
        .insert(t)
        .values({
          id: randomUUID(),
          objectiveId: objective.id,
          senderTagId: input.senderTagId,
          sourceTaskId,
          type: parsed.type,
          needsReply,
          body: parsed.body,
          idempotencyKey: parsed.idempotencyKey,
          fingerprint,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      yield* handleOperatorInputs(
        tx,
        tables,
        objective,
        sourceTaskId,
        input.sourceAttemptCount,
        at,
        "objective-message",
        row.id,
      );
      return { message: project(row), duplicate: false };
    });
  }
  async getObjectiveMessage(id: string) {
    mailboxText(id, "messageId");
    const t = this.tables.objectiveMessages;
    const [row] = await this.db.select().from(t).where(eq(t.id, id));
    return row ? project(row) : undefined;
  }
  async listObjectiveMessages(
    input: Parameters<ObjectiveMailboxStore["listObjectiveMessages"]>[0],
  ) {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TagMessagingError(400, "limit must be 1–100");
    if (input.objectiveId !== undefined) mailboxText(input.objectiveId, "objectiveId");
    if (input.after !== undefined) {
      if (
        input.after === null ||
        typeof input.after !== "object" ||
        Array.isArray(input.after) ||
        typeof input.after.createdAt !== "string" ||
        !Number.isFinite(Date.parse(input.after.createdAt))
      )
        throw new TagMessagingError(400, "Invalid mailbox cursor");
      mailboxText(input.after.id, "after.id");
    }
    const t = this.tables.objectiveMessages;
    const past = input.newestFirst ? lt : gt;
    const order = input.newestFirst ? desc : asc;
    return (
      await this.db
        .select()
        .from(t)
        .where(
          and(
            input.objectiveId === undefined ? undefined : eq(t.objectiveId, input.objectiveId),
            input.pendingOnly
              ? and(eq(t.needsReply, true), isNull(t.replyMessageId), isNull(t.resolvedAt))
              : undefined,
            input.reportOnly ? eq(t.needsReply, false) : undefined,
            input.after
              ? or(
                  past(t.createdAt, input.after.createdAt),
                  and(eq(t.createdAt, input.after.createdAt), past(t.id, input.after.id)),
                )
              : undefined,
          ),
        )
        .orderBy(order(t.createdAt), order(t.id))
        .limit(limit)
    ).map(project);
  }
  async replyToObjectiveMessage(
    input: Parameters<ObjectiveMailboxStore["replyToObjectiveMessage"]>[0],
  ) {
    mailboxText(input.messageId, "messageId");
    const operatorId = input.operatorId;
    if (typeof operatorId !== "string" || !operatorId.trim() || operatorId.length > 200)
      throw new TagMessagingError(401, "Invalid operator principal");
    const parsed = parseTagMessageInput({
      recipientTagId: input.recipientTagId,
      objectiveId: input.objectiveId,
      type: "message",
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      inReplyTo: input.messageId,
    });
    if (
      typeof parsed.body["message"] !== "string" ||
      !parsed.body["message"].trim() ||
      parsed.body["message"].length > 8000
    )
      throw new TagMessagingError(400, "A bounded body.message is required");
    const fingerprint = digest({ ...parsed, operatorId });
    const t = this.tables.objectiveMessages,
      m = this.tables.tagMessages,
      o = this.tables.objectives,
      tags = this.tables.tags;
    return runDialectTransaction(this.db, this.provider, function* (tx: any) {
      yield lockObjective(tx, o, parsed.objectiveId);
      const [objective] = yield tx.select().from(o).where(eq(o.id, parsed.objectiveId));
      const [request] = yield tx.select().from(t).where(eq(t.id, input.messageId));
      if (!objective || request?.objectiveId !== objective.id)
        throw new TagMessagingError(404, "Objective message not found");
      if (!request.needsReply)
        throw new TagMessagingError(409, "Owner report does not request a reply");
      if (request.replyMessageId) {
        const [reply] = yield tx.select().from(m).where(eq(m.id, request.replyMessageId));
        if (reply?.fingerprint !== fingerprint)
          throw new TagMessagingError(409, "Objective message already has a different reply");
        return { message: publicMessage(reply), duplicate: true };
      }
      if (objective.ownerTagId !== parsed.recipientTagId)
        throw new TagMessagingError(409, "Objective owner changed; refresh before replying");
      const [recipient] = yield tx.select().from(tags).where(eq(tags.id, parsed.recipientTagId));
      if (recipient?.status !== "active")
        throw new TagMessagingError(409, "Reply requires an active owner");
      // Match ordinary sends' recipient serialization so reply capacity cannot race another sender.
      yield tx
        .update(tags)
        .set({ id: parsed.recipientTagId })
        .where(eq(tags.id, parsed.recipientTagId))
        .returning();
      const [count] = yield tx
        .select({ total: sql`count(*)` })
        .from(m)
        .where(
          and(
            eq(m.recipientTagId, parsed.recipientTagId),
            or(eq(m.status, "pending"), eq(m.status, "processing")),
          ),
        );
      if (Number(count.total) >= TAG_MAILBOX_MAX_OUTSTANDING)
        throw new TagMessagingError(429, "Recipient mailbox is at its outstanding message limit");
      const at = new Date().toISOString();
      // The owner address routes this trusted system message; operatorId records its actual author.
      const [reply] = yield tx
        .insert(m)
        .values({
          ...parsed,
          id: randomUUID(),
          senderTagId: objective.ownerTagId,
          operatorId,
          fingerprint,
          status: "pending",
          attemptCount: 0,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing({ target: [m.senderTagId, m.idempotencyKey] })
        .returning();
      if (!reply) throw new TagMessagingError(409, "Reply idempotency key is already in use");
      yield tx
        .update(t)
        .set({ replyMessageId: reply.id, repliedByOperatorId: operatorId, updatedAt: at })
        .where(eq(t.id, request.id))
        .returning();
      return { message: publicMessage(reply), duplicate: false };
    });
  }
  async sendOperatorObjectiveMessage(
    input: Parameters<ObjectiveMailboxStore["sendOperatorObjectiveMessage"]>[0],
  ): Promise<OperatorObjectiveMessageResult> {
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    const idempotencyKey = mailboxText(input.idempotencyKey, "idempotencyKey");
    const operatorId = input.operatorId;
    if (typeof operatorId !== "string" || !operatorId.trim() || operatorId.length > 200)
      throw new TagMessagingError(401, "Invalid operator principal");
    if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 8000)
      throw new TagMessagingError(400, "The message must contain 1–8000 characters");
    const body = { message: input.message.trim() };
    const reopen = input.reopen === true;
    const inReplyTo =
      input.inReplyTo === undefined ? undefined : mailboxText(input.inReplyTo, "inReplyTo");
    const fingerprint = digest({ objectiveId, type: "message", body, operatorId, inReplyTo });
    const t = this.tables.objectiveMessages,
      m = this.tables.tagMessages,
      o = this.tables.objectives,
      tags = this.tables.tags,
      tables = this.tables;
    return runDialectTransaction(this.db, this.provider, function* (tx: any) {
      yield lockObjective(tx, o, objectiveId);
      const [objective] = yield tx.select().from(o).where(eq(o.id, objectiveId));
      if (!objective) throw new TagMessagingError(404, "Objective not found");
      const [prior] = yield tx
        .select()
        .from(m)
        .where(and(eq(m.senderTagId, objective.ownerTagId), eq(m.idempotencyKey, idempotencyKey)));
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.objectiveId !== objectiveId)
          throw new TagMessagingError(409, "Message key already used for different content");
        return {
          message: publicMessage(prior),
          duplicate: true,
          repliedToMessageId: prior.inReplyTo ?? null,
          objective,
          statusChange: null,
        };
      }
      if (objective.status === "cancelled" && !inReplyTo)
        throw new TagMessagingError(
          409,
          "Objective is cancelled; create a new Objective to continue the work",
        );
      if (objective.status === "completed" && !reopen && !inReplyTo)
        throw new TagMessagingError(
          409,
          "Objective is completed; reopen it to send changes (supertag message objective ID TEXT --reopen)",
        );
      const [recipient] = yield tx.select().from(tags).where(eq(tags.id, objective.ownerTagId));
      if (recipient?.status !== "active")
        throw new TagMessagingError(409, "The Objective owner is not active");
      // Match ordinary sends' recipient serialization so capacity cannot race another sender.
      yield tx
        .update(tags)
        .set({ id: objective.ownerTagId })
        .where(eq(tags.id, objective.ownerTagId))
        .returning();
      const [count] = yield tx
        .select({ total: sql`count(*)` })
        .from(m)
        .where(
          and(
            eq(m.recipientTagId, objective.ownerTagId),
            or(eq(m.status, "pending"), eq(m.status, "processing")),
          ),
        );
      if (Number(count.total) >= TAG_MAILBOX_MAX_OUTSTANDING)
        throw new TagMessagingError(429, "Owner mailbox is at its outstanding message limit");
      const [request] = inReplyTo
        ? yield tx
            .select()
            .from(t)
            .where(and(eq(t.id, inReplyTo), eq(t.objectiveId, objective.id)))
        : [];
      if (inReplyTo && !request) throw new TagMessagingError(404, "Objective question not found");
      if (
        request &&
        (!request.needsReply ||
          request.replyMessageId ||
          (request.resolvedAt &&
            request.resolutionReason !== "Objective cancelled" &&
            !request.resolutionReason?.startsWith("Withdrawn by owner: ")))
      )
        throw new TagMessagingError(409, "Objective question is no longer pending");
      const [pendingQuestion] =
        objective.status === "blocked" && !request
          ? yield tx
              .select({ id: t.id })
              .from(t)
              .where(
                and(
                  eq(t.objectiveId, objective.id),
                  eq(t.needsReply, true),
                  isNull(t.replyMessageId),
                  isNull(t.resolvedAt),
                ),
              )
              .limit(1)
          : [];
      const at = new Date().toISOString();
      // The owner address routes this trusted system message; operatorId records its actual author.
      const [delivered] = yield tx
        .insert(m)
        .values({
          ...parseTagMessageInput({
            recipientTagId: objective.ownerTagId,
            objectiveId: objective.id,
            type: "message",
            body,
            idempotencyKey,
            ...(request ? { inReplyTo: request.id } : {}),
          }),
          id: randomUUID(),
          senderTagId: objective.ownerTagId,
          operatorId,
          fingerprint,
          status: "pending",
          attemptCount: 0,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (request)
        yield tx
          .update(t)
          .set({ replyMessageId: delivered.id, repliedByOperatorId: operatorId, updatedAt: at })
          .where(eq(t.id, request.id))
          .returning();
      let current = objective;
      let statusChange: OperatorObjectiveMessageResult["statusChange"] = null;
      // An unrelated message must not release an owner blocked on a question.
      if (
        objective.status !== "working" &&
        objective.status !== "cancelled" &&
        !(objective.status === "completed" && request) &&
        (objective.status !== "blocked" || !pendingQuestion || request || reopen)
      ) {
        [current] = yield tx
          .update(o)
          .set({
            status: "working",
            completionSummary: null,
            revision: sql`${o.revision} + 1`,
            updatedAt: at,
          })
          .where(eq(o.id, objective.id))
          .returning();
        statusChange = { from: objective.status, to: "working" };
        if (objective.status === "completed")
          yield* restoreTeamsClosedWithObjective(tx, tables, objective.id, at);
        yield* appendResourceChange(tx, tables, {
          resourceType: "objective",
          resourceId: objective.id,
          fromRevision: objective.revision,
          toRevision: current.revision,
          actorTagId: null,
          operatorId,
          sourceTaskId: null,
          sourceMessageId: delivered.id,
          changes: {
            status: { previous: objective.status, next: "working" },
            ...(objective.completionSummary == null
              ? {}
              : { completionSummary: { previous: objective.completionSummary, next: null } }),
          },
          createdAt: at,
        });
      }
      return {
        message: publicMessage(delivered),
        duplicate: false,
        repliedToMessageId: request?.id ?? null,
        objective: current,
        statusChange,
      };
    });
  }
}
function project(row: any): ObjectiveMailboxMessage {
  const { fingerprint: _, ...message } = row;
  return {
    ...message,
    status: !row.needsReply
      ? "reported"
      : row.replyMessageId
        ? "replied"
        : row.resolvedAt
          ? "resolved"
          : "pending",
  };
}
function digest(value: unknown): string {
  const canonical = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : v !== null && typeof v === "object"
        ? `{${Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
            .join(",")}}`
        : JSON.stringify(v);
  return createHash("sha256").update(canonical(value)).digest("hex");
}
