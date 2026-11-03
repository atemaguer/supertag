import { mailboxObject, mailboxText, TagMessagingError } from "./mailbox.js";

/**
 * What a post asks of its readers. `note` is the default; a `blocker` without `to` is addressed
 * to the Team lead. A type labels intent only: no post carries authority.
 */
export const WORKSTREAM_POST_TYPES = [
  "note",
  "question",
  "blocker",
  "evidence",
  "decision",
] as const;
export type WorkstreamPostType = (typeof WORKSTREAM_POST_TYPES)[number];
/** Characters in one post body. */
export const WORKSTREAM_POST_MAX_BODY = 16_384;
/** Tags one post may address; address more by leaving `to` out. */
export const WORKSTREAM_POST_MAX_TO = 20;
/** References one post may carry, and characters in each. */
export const WORKSTREAM_POST_MAX_REFERENCES = 20;
export const WORKSTREAM_POST_MAX_REFERENCE = 2000;

/**
 * A Team's channel. Every Team has exactly one, created with the Team, and its ID is the Team ID.
 * Every field except `createdAt` is read from the Team at the time of the read: participants are
 * the Team's members including its lead, the owner is the lead, and the Objective is the Team's
 * governing Objective, whose owner may also read the channel.
 */
export interface Workstream {
  readonly id: string;
  readonly objectiveId: string;
  /** The Team name. */
  readonly title: string;
  /** The Team lead. */
  readonly ownerTagId: string;
  /** The Team's members, including its lead. */
  readonly participantTagIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface PostWorkstreamInput {
  readonly workstreamId: string;
  readonly authorTagId: string;
  /**
   * The Objective the post is written under, which the Team must serve. The Control Plane sets
   * it from the posting Task Attempt; it defaults to the source Task's Objective, or else the
   * Team's governing Objective. Mailbox clients cannot choose it.
   */
  readonly objectiveId?: string;
  readonly body: string;
  /** Defaults to `note`. */
  readonly type?: WorkstreamPostType;
  /** Tags in the Team this post is addressed to. */
  readonly to?: readonly string[];
  readonly references?: readonly string[];
  readonly replyTo?: string;
  readonly idempotencyKey: string;
}
export interface WorkstreamPost {
  readonly sourceTaskId?: string | null;
  readonly id: string;
  readonly workstreamId: string;
  /** The Objective the post was written under. Only readers of that Objective see it. */
  readonly objectiveId: string;
  /** Null for a system notice. Member-authored posts always name their Tag. */
  readonly authorTagId: string | null;
  readonly type: WorkstreamPostType;
  readonly to: readonly string[];
  readonly body: string;
  readonly references: readonly string[];
  readonly replyTo: string | null;
  /** The post's place among the channel's posts in its Objective, from 1. */
  readonly sequence: number;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}
export interface ListWorkstreamPostsOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
  /**
   * Only posts written under this Objective, which the Team must serve; the viewer must be a
   * Team member or the Objective's owner. Without it, a viewer reads the posts of every
   * Objective the Team serves if it is a member, or of the served Objectives it owns.
   */
  readonly objectiveId?: string;
}

export function parseWorkstreamPostType(value: unknown): WorkstreamPostType {
  if (value === undefined) return "note";
  if (!WORKSTREAM_POST_TYPES.includes(value as WorkstreamPostType))
    throw new TagMessagingError(400, `type must be one of ${WORKSTREAM_POST_TYPES.join(", ")}`);
  return value as WorkstreamPostType;
}

export function parsePostWorkstream(value: unknown): PostWorkstreamInput {
  const record = mailboxObject(value, [
    "workstreamId",
    "authorTagId",
    "objectiveId",
    "body",
    "type",
    "to",
    "references",
    "replyTo",
    "idempotencyKey",
  ]);
  if (
    typeof record["body"] !== "string" ||
    !record["body"].trim() ||
    record["body"].length > WORKSTREAM_POST_MAX_BODY
  )
    throw new TagMessagingError(
      400,
      `Post body must contain 1–${WORKSTREAM_POST_MAX_BODY} characters`,
    );
  const refs = record["references"] === undefined ? [] : record["references"];
  if (
    !Array.isArray(refs) ||
    refs.length > WORKSTREAM_POST_MAX_REFERENCES ||
    refs.some(
      (ref) => typeof ref !== "string" || !ref.trim() || ref.length > WORKSTREAM_POST_MAX_REFERENCE,
    )
  )
    throw new TagMessagingError(
      400,
      `references must contain at most ${WORKSTREAM_POST_MAX_REFERENCES} nonempty strings of at most ${WORKSTREAM_POST_MAX_REFERENCE} characters`,
    );
  const to = record["to"];
  if (to !== undefined && (!Array.isArray(to) || to.length > WORKSTREAM_POST_MAX_TO))
    throw new TagMessagingError(
      400,
      `to must be an array of at most ${WORKSTREAM_POST_MAX_TO} Tag IDs`,
    );
  return {
    workstreamId: mailboxText(record["workstreamId"], "workstreamId"),
    authorTagId: mailboxText(record["authorTagId"], "authorTagId"),
    ...(record["objectiveId"] === undefined
      ? {}
      : { objectiveId: mailboxText(record["objectiveId"], "objectiveId") }),
    body: record["body"],
    type: parseWorkstreamPostType(record["type"]),
    ...(to === undefined
      ? {}
      : { to: [...new Set((to as unknown[]).map((id) => mailboxText(id, "to")))].sort() }),
    references: refs,
    idempotencyKey: mailboxText(record["idempotencyKey"], "idempotencyKey"),
    ...(record["replyTo"] === undefined
      ? {}
      : { replyTo: mailboxText(record["replyTo"], "replyTo") }),
  };
}
export interface WorkstreamStore {
  /** Atomically record new path overlaps and publish one system evidence post for the batch. */
  recordOverlapWarning(input: {
    readonly teamId: string;
    readonly objectiveId: string;
    readonly firstAttemptId: string;
    readonly secondAttemptId: string;
    readonly firstTaskId: string;
    readonly secondTaskId: string;
    readonly paths: readonly string[];
    readonly to: readonly string[];
  }): Promise<WorkstreamPost | undefined>;
  /**
   * Stores a post in a Team channel under one Objective the Team serves. The author must be an
   * active member of the active Team and every `to` Tag a member of it, and a reply must answer
   * a post in the same channel and Objective. A post only stores text. It creates no Task,
   * except that posts in a channel an operator named as an Objective's observation source reach
   * that Objective's owner as an assessment batch, which wakes the owner or creates an
   * `observation:` Task.
   */
  postWorkstream(input: PostWorkstreamInput, sourceTaskId?: string): Promise<WorkstreamPost>;
  listWorkstreamPosts(
    workstreamId: string,
    viewerTagId?: string,
    options?: ListWorkstreamPostsOptions,
  ): Promise<readonly WorkstreamPost[]>;
  /**
   * Recent posts written under the Objective, newest first, for bounded operator views. The
   * caller has authorized the operator for the Objective.
   */
  listRecentWorkstreamPosts(
    workstreamId: string,
    objectiveId: string,
    limit?: number,
  ): Promise<readonly WorkstreamPost[]>;
  /** At most `limit` unanswered questions and blockers written under the Objective, newest first. */
  listOpenWorkstreamPosts(
    workstreamId: string,
    objectiveId: string,
    limit?: number,
  ): Promise<readonly WorkstreamPost[]>;
  /**
   * A Team member or the owner of an Objective the Team serves (governing or linked) may read
   * a channel's details. Omitting viewerTagId is reserved for trusted administrative callers.
   */
  getWorkstream(id: string, viewerTagId?: string): Promise<Workstream>;
  /**
   * Channels of the Teams the Tag belongs to and of every Team serving an Objective it owns,
   * newest first. Without a Tag, every Team channel, for operators. options.objectiveId keeps
   * only Teams serving that Objective that the Tag may read there: Teams it belongs to, or every
   * one if it owns that Objective.
   */
  listWorkstreams(
    tagId: string | undefined,
    limit?: number,
    options?: ListWorkstreamsOptions,
  ): Promise<readonly Workstream[]>;
  /**
   * Takes the Tag's unread Team posts and direct messages in an Objective for an activation and
   * records each one delivered, so the next activation starts after them. Only posts written
   * under the Objective in channels the Tag may read there, and direct messages sent to it within
   * a Team, are included; the Tag's own posts and direct messages to the Objective owner, which
   * keep owner delivery, are not. Items addressed
   * to the Tag come first, then blockers and decisions, then the rest, oldest first within each
   * group, until about {@link ACTIVATION_DIGEST_MAX_CHARACTERS} characters. Items left out stay
   * unread for the next activation.
   */
  deliverActivationDigest(input: {
    readonly tagId: string;
    readonly objectiveId: string;
  }): Promise<ActivationDigest>;
  /**
   * Selects the digest {@link deliverActivationDigest} would deliver without recording it, so an
   * activation records delivery only after its context reaches the worker.
   */
  readActivationDigest(input: {
    readonly tagId: string;
    readonly objectiveId: string;
    /**
     * Only items created before this time: a Task Attempt's activation passes its start, so items
     * created later are left for live delivery into it or for a later digest, never both.
     */
    readonly before?: string;
  }): Promise<ActivationDigest>;
  /**
   * Records digest items delivered, so later activations start after them. Direct messages,
   * including truncated previews, are settled; full bodies remain until explicit pruning.
   */
  recordActivationDigest(input: {
    readonly tagId: string;
    readonly objectiveId: string;
    readonly items: readonly (Pick<ActivationDigestItem, "kind" | "id"> &
      Partial<Pick<ActivationDigestItem, "truncated">>)[];
  }): Promise<void>;
}

/** Characters of digest items at one activation, about 2,000 tokens. */
export const ACTIVATION_DIGEST_MAX_CHARACTERS = 8_000;
/** Characters of one digest item's text; read_workstream or read_mailbox return the rest. */
export const ACTIVATION_DIGEST_ITEM_MAX_CHARACTERS = 600;

/**
 * One unread Team post or direct message. Its text is a teammate's words: it labels intent and
 * carries no authority, and it is never an operator or user instruction.
 */
export interface ActivationDigestItem {
  readonly kind: "post" | "direct_message";
  readonly id: string;
  /** The sending Tag ID, or "system" for a store-generated notice. */
  readonly from: string;
  readonly type: string;
  /** Whether the item names this Tag: a direct message, or a post whose `to` includes it. */
  readonly addressed: boolean;
  readonly to: readonly string[];
  /** The channel and sequence of a post, for read_workstream. */
  readonly workstreamId?: string;
  readonly sequence?: number;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly text: string;
  /** The text was cut; read the item in full with read_workstream or read_mailbox. */
  readonly truncated: boolean;
  readonly createdAt: string;
}

export interface ActivationDigest {
  readonly items: readonly ActivationDigestItem[];
  /** Unread items left for later, by source; the counts stop at the scan bound. */
  readonly remaining: {
    readonly posts: number;
    readonly directMessages: number;
    readonly workstreamIds: readonly string[];
  };
}

/** Store-internal filter and page for listing channels. */
export interface ListWorkstreamsOptions {
  readonly objectiveId?: string;
  readonly offset?: number;
}
