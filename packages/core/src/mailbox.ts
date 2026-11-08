/**
 * A Tag's Mailbox: plain text messages from other Tags. Each message is delivered as a turn of
 * the recipient's inbox Session (`inboxSessionKey`); messages that arrive while a turn runs are
 * handled together in the next one. A message's status is the status of the Task that handled it.
 */

/** Characters in one message. */
export const TAG_MESSAGE_TEXT_MAX = 8000;
/**
 * How many inbox turns a chain of messages may pass through. A message sent from an inbox turn
 * carries one more hop than the messages that turn handled; above this it is refused.
 */
export const INBOX_MAX_HOPS = 4;
/** Messages one Task may send. */
export const INBOX_SENDS_PER_TASK = 3;

/**
 * `pending` until an inbox turn takes it; then `handled` when that Task completed, or `failed`
 * when it failed or was cancelled.
 */
export type TagMessageStatus = "pending" | "handled" | "failed";

export interface TagMessage {
  readonly id: string;
  readonly senderTagId: string;
  readonly recipientTagId: string;
  /** The Objective the sending turn worked under, when it had one. */
  readonly objectiveId?: string;
  /** The Task that sent the message. */
  readonly sourceTaskId?: string;
  /** The Workstream post whose `to` delivered this message. */
  readonly workstreamPostId?: string;
  readonly text: string;
  /** Inbox turns the chain that produced this message already passed through; 0 outside one. */
  readonly hops: number;
  /** The inbox turn that took the message; absent while it waits. */
  readonly taskId?: string;
  readonly status: TagMessageStatus;
  readonly createdAt: string;
}

export interface DeliverTagMessageInput {
  readonly senderTagId: string;
  readonly recipientTagId: string;
  readonly text: string;
  readonly hops: number;
  readonly objectiveId?: string;
  readonly sourceTaskId?: string;
  readonly workstreamPostId?: string;
}

/** The recipient accepts messages from the sender, in addition to its Team members. */
export interface TagMessagingGrant {
  readonly senderTagId: string;
  readonly recipientTagId: string;
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
  /** Replaces the Tags the recipient accepts messages from; an empty list removes every grant. */
  setTagMessagingGrants(recipientTagId: string, senderTagIds: readonly string[]): Promise<void>;
  /** Grants in which the Tag is the sender or the recipient. */
  listTagMessagingGrants(tagId: string): Promise<readonly TagMessagingGrant[]>;
  /** True when the two Tags share a Team, or the recipient has a grant for the sender. */
  mayMessage(senderTagId: string, recipientTagId: string): Promise<boolean>;
  /**
   * Stores one message. The caller checked `mayMessage` and the hop and send limits. `admit` is
   * false while the recipient's inbox Session already has a pending, unclaimed turn, which will
   * take this message too; otherwise the caller admits a turn for it.
   */
  deliverTagMessage(
    input: DeliverTagMessageInput,
  ): Promise<{ readonly message: TagMessage; readonly admit: boolean }>;
  /**
   * Binds every unbound message to the Tag to this inbox Task and returns all messages bound to
   * it, oldest first. Idempotent: a retried Attempt gets the same messages and any new ones.
   */
  bindInboxMessages(taskId: string, tagId: string): Promise<readonly TagMessage[]>;
  /** Tags with unbound messages, oldest message first, so the sweep can admit an inbox turn. */
  listTagsWithUnboundMessages(limit: number): Promise<readonly string[]>;
  /** Messages the Tag sent or received, newest first; the cursor continues toward older ones. */
  listTagMessageHistory(
    tagId: string,
    options?: TagMessageHistoryOptions,
  ): Promise<TagMessageHistoryPage>;
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

export function mailboxObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TagMessagingError(400, "Expected a JSON object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0)
    throw new TagMessagingError(
      400,
      `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  return record;
}

/** Message text: 1 to {@link TAG_MESSAGE_TEXT_MAX} characters after trimming. */
export function tagMessageText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > TAG_MESSAGE_TEXT_MAX)
    throw new TagMessagingError(400, `text must contain 1–${TAG_MESSAGE_TEXT_MAX} characters`);
  return value.trim();
}

/** The arguments of `send_message`: the recipient Tag's name or ID, and the text. */
export function parseSendMessage(value: unknown): { readonly to: string; readonly text: string } {
  const record = mailboxObject(value, ["to", "text"]);
  return { to: mailboxText(record["to"], "to"), text: tagMessageText(record["text"]) };
}
