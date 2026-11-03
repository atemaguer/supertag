/** Pending and processing messages admitted per recipient across all Objectives. */
export const TAG_MAILBOX_MAX_OUTSTANDING = 100;

/** Internal Tag messaging is separate from surface conversations and Task acceptance. */
export const TAG_MESSAGE_TYPES = [
  "note",
  "question",
  "blocker",
  "evidence",
  "decision",
  "message",
  "delegation.requested",
  "delegation.accepted",
  "delegation.declined",
  "clarification.requested",
  "progress.updated",
  "result.submitted",
  "cancellation.requested",
  "priority.proposed",
  "priority.accepted",
  "priority.declined",
] as const;
export type TagMessageType = (typeof TAG_MESSAGE_TYPES)[number];
export type TagMessageStatus = "pending" | "processing" | "processed" | "failed";

export interface SendTagMessageInput {
  readonly recipientTagId: string;
  /** Optional direct addressee; exactly the resolved recipient. */
  readonly to?: readonly string[];
  /** Stable Team address; recipientTagId is the resolved lead. */
  readonly recipientTeamId?: string;
  /** Correlation only: messaging does not create or accept an objective. */
  readonly objectiveId: string;
  readonly type: TagMessageType;
  readonly body: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly inReplyTo?: string;
}
export interface TagMessage extends SendTagMessageInput {
  /** Trusted author for a system-delivered operator reply; never accepted from agent input. */
  readonly operatorId?: string;
  readonly id: string;
  readonly senderTagId: string;
  readonly status: TagMessageStatus;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly processedAt?: string;
  readonly bodyPrunedAt?: string;
}
export interface TagMessageDelivery {
  readonly message: TagMessage;
  /** Opaque fencing token; never put it in an agent prompt or shared artifact. */
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}
export interface TagMessagingGrant {
  readonly senderTagId: string;
  readonly recipientTagId: string;
  readonly messageTypes: readonly TagMessageType[];
}
export interface TagMailboxCredential {
  readonly id: string;
  readonly tagId: string;
  readonly createdAt: string;
}
export interface TagMessageHistoryCursor {
  readonly createdAt: string;
  readonly id: string;
}
export interface TagMessageHistoryOptions {
  readonly before?: TagMessageHistoryCursor;
  readonly limit?: number;
}
export interface TagMessageHistoryPage {
  readonly items: readonly TagMessage[];
  readonly nextCursor?: TagMessageHistoryCursor;
}
export interface TagMailboxStore {
  /** Trusted operator projection: unanswered questions/blockers between current Team members. */
  listOpenTeamMessages(
    teamId: string,
    objectiveId: string,
    limit?: number,
  ): Promise<readonly TagMessage[]>;
  /** Internal Control Plane receipt, never populated from tool arguments. */
  recordOperatorInputReceipt(input: {
    readonly taskId: string;
    readonly attemptCount: number;
    readonly messageIds: readonly string[];
  }): Promise<void>;
  /** Objective-scoped sent and received history, newest first; cursor continues toward older messages. */
  listObjectiveTagMessageHistory(
    tagId: string,
    objectiveId: string,
    options?: TagMessageHistoryOptions,
  ): Promise<TagMessageHistoryPage>;
  /** Internal owner-brief query: durable unhandled operator input, newest first. */
  listUnhandledOperatorInputs(
    objectiveId: string,
    limit?: number,
    offset?: number,
  ): Promise<readonly TagMessage[]>;
  listTagMessageHistory(
    tagId: string,
    options?: TagMessageHistoryOptions,
  ): Promise<TagMessageHistoryPage>;
  /** Internal owner-brief read: newest 50 operator messages for this recipient and Objective. */
  listObjectiveOperatorMessages(
    objectiveId: string,
    recipientTagId: string,
  ): Promise<{
    readonly items: readonly TagMessage[];
    /** First older message beyond the bounded read; its body is not included. */
    readonly olderMessage?: TagMessageHistoryCursor;
  }>;
  pruneTagMessageBodies(input: {
    readonly before: string;
    readonly limit?: number;
  }): Promise<{ readonly pruned: number }>;
  setTagMessagingGrant(grant: TagMessagingGrant): Promise<void>;
  listTagMessagingGrants(tagId: string): Promise<readonly TagMessagingGrant[]>;
  createTagMailboxCredential(
    input: TagMailboxCredential & { readonly tokenHash: string },
  ): Promise<void>;
  findTagMailboxCredential(tokenHash: string): Promise<TagMailboxCredential | undefined>;
  revokeTagMailboxCredential(id: string): Promise<boolean>;
  enqueueTagMessage(
    input: SendTagMessageInput & { readonly senderTagId: string },
    options?: {
      readonly forceTaskDelivery?: boolean;
      readonly sourceTaskId?: string;
      readonly sourceAttemptCount?: number;
    },
  ): Promise<{ readonly message: TagMessage; readonly duplicate: boolean }>;
  listTagMessages(tagId: string, limit?: number): Promise<readonly TagMessage[]>;
  /**
   * Settles the Tag's oldest pending direct messages within a Team in the Objective, at most
   * `limit` (1-200), and returns them as `processed`. Settled messages stop counting toward the
   * sender's limit and become prunable, including same-Team messages to the Objective owner.
   */
  takeTeamDirectMessages(input: {
    readonly tagId: string;
    readonly objectiveId: string;
    readonly limit: number;
  }): Promise<readonly TagMessage[]>;
  /** Optional recipient scope also checks current Team access for direct messages. */
  getTagMessage(
    messageId: string,
    recipient?: { readonly tagId: string; readonly objectiveId: string },
  ): Promise<TagMessage | undefined>;
  listTagMessageReplies(messageId: string, limit?: number): Promise<readonly TagMessage[]>;
  /** Latest priority proposal and its response for each bounded Task ID. */
  listTaskPriorityMessages(
    objectiveId: string,
    taskIds: readonly string[],
  ): Promise<readonly TagMessage[]>;
  claimTagMessage(input: {
    readonly tagId: string;
    readonly credentialId: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<TagMessageDelivery | undefined>;
  settleTagMessage(input: {
    readonly tagId: string;
    readonly credentialId: string;
    readonly messageId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly status: "pending" | "processed" | "failed";
  }): Promise<boolean>;
  renewTagMessage(input: {
    readonly tagId: string;
    readonly credentialId: string;
    readonly messageId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean>;
}

export class TagMessagingError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "TagMessagingError";
  }
}

export function mailboxText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    /[\s\p{Cc}]/u.test(value)
  ) {
    throw new TagMessagingError(
      400,
      `${field} must be a nonempty identifier of at most 200 characters`,
    );
  }
  return value;
}

/** Names each rejected field, so a caller can tell which one this Control Plane does not know. */
function unknownFieldsMessage(fields: readonly string[], subject = ""): string {
  return `Unknown ${subject}field${fields.length === 1 ? "" : "s"}: ${fields.join(", ")}`;
}

export function mailboxObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TagMessagingError(400, "Expected a JSON object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TagMessagingError(400, unknownFieldsMessage(unknown));
  return record;
}

export function parseTagMessageInput(value: unknown): SendTagMessageInput {
  const record = mailboxObject(value, [
    "recipientTagId",
    "to",
    "recipientTeamId",
    "objectiveId",
    "type",
    "body",
    "idempotencyKey",
    "inReplyTo",
  ]);
  if (!TAG_MESSAGE_TYPES.includes((record["type"] ?? "note") as TagMessageType)) {
    throw new TagMessagingError(400, "Unknown message type");
  }
  const body = record["body"];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TagMessagingError(400, "Message body must be a JSON object");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(body);
  } catch {
    throw new TagMessagingError(400, "Message body must be JSON serializable");
  }
  if (new TextEncoder().encode(encoded).length > 65_536) {
    throw new TagMessagingError(413, "Message body exceeds 64 KiB");
  }
  const type = (record["type"] ?? "note") as TagMessageType;
  const to = record["to"];
  if (to !== undefined && (!Array.isArray(to) || to.length !== 1))
    throw new TagMessagingError(400, "to must contain only the direct recipient Tag");
  const recipientTagId = mailboxText(
    record["recipientTagId"] ?? (Array.isArray(to) ? to[0] : undefined),
    "recipientTagId",
  );
  if (Array.isArray(to) && to[0] !== recipientTagId)
    throw new TagMessagingError(400, "to must contain only the direct recipient Tag");
  if (
    [
      "delegation.accepted",
      "delegation.declined",
      "priority.accepted",
      "priority.declined",
    ].includes(type) &&
    record["inReplyTo"] === undefined
  )
    throw new TagMessagingError(400, `${type} must reply to its proposal`);
  if (type.startsWith("priority.")) validatePriorityBody(type, body as Record<string, unknown>);
  return {
    recipientTagId,
    ...(record["recipientTeamId"] === undefined
      ? {}
      : { recipientTeamId: mailboxText(record["recipientTeamId"], "recipientTeamId") }),
    objectiveId: mailboxText(record["objectiveId"], "objectiveId"),
    idempotencyKey: mailboxText(record["idempotencyKey"], "idempotencyKey"),
    type,
    body: JSON.parse(encoded) as Record<string, unknown>,
    ...(record["inReplyTo"] === undefined
      ? {}
      : { inReplyTo: mailboxText(record["inReplyTo"], "inReplyTo") }),
  };
}

function validatePriorityBody(type: TagMessageType, body: Record<string, unknown>): void {
  const allowed = ["taskId", "priority", "rationale"];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new TagMessagingError(400, unknownFieldsMessage(unknown, "priority message body "));
  mailboxText(body["taskId"], "body.taskId");
  if (!["urgent", "high", "normal", "low"].includes(body["priority"] as string))
    throw new TagMessagingError(400, "body.priority must be urgent, high, normal, or low");
  if (type === "priority.proposed" && body["rationale"] === undefined)
    throw new TagMessagingError(400, "Priority proposals require a rationale");
  if (
    body["rationale"] !== undefined &&
    (typeof body["rationale"] !== "string" ||
      !body["rationale"].trim() ||
      body["rationale"].length > 2000)
  )
    throw new TagMessagingError(400, "body.rationale must be nonempty and at most 2000 characters");
}
