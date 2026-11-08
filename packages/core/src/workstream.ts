import { mailboxObject, mailboxText, TagMessagingError } from "./mailbox.js";

/**
 * A Team's Workstream: the shared record of its members' posts. Every member reads it. A post
 * wakes nobody, except that each Tag in its `to` receives it as a Mailbox message.
 */

/** Characters in one post body. */
export const WORKSTREAM_POST_MAX_BODY = 16_384;
/** Tags one post may address. */
export const WORKSTREAM_POST_MAX_TO = 20;

export interface PostInput {
  readonly teamId: string;
  readonly authorTagId: string;
  readonly body: string;
  /** Team members this post is addressed to. */
  readonly to?: readonly string[];
  /**
   * The Task that posted. With it, the store derives the idempotency key from the Task, `to` and
   * the body, so a retried Attempt that posts the same text again stores nothing new.
   */
  readonly sourceTaskId?: string;
}

export interface WorkstreamPost {
  readonly id: string;
  readonly teamId: string;
  readonly authorTagId: string;
  readonly to: readonly string[];
  readonly body: string;
  readonly sourceTaskId?: string;
  /** The post's place in the Team's Workstream, from 1. */
  readonly sequence: number;
  readonly createdAt: string;
}

export interface ListTeamPostsOptions {
  /** Only posts after this sequence, oldest first. Without it, the newest posts. */
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface WorkstreamStore {
  /**
   * Stores a post. The author and every `to` Tag must be members of the Team. `duplicate` is true
   * when the same Task already posted the same text to the same Tags; the earlier post returns.
   */
  post(input: PostInput): Promise<{ readonly post: WorkstreamPost; readonly duplicate: boolean }>;
  /** A Team's posts in sequence order. */
  listTeamPosts(teamId: string, options?: ListTeamPostsOptions): Promise<readonly WorkstreamPost[]>;
}

/** The arguments of `post`: the text, and optionally the names or IDs of Tags it addresses. */
export function parsePost(value: unknown): {
  readonly text: string;
  readonly to?: readonly string[];
} {
  const record = mailboxObject(value, ["text", "to"]);
  const text = record["text"];
  if (typeof text !== "string" || !text.trim() || text.trim().length > WORKSTREAM_POST_MAX_BODY)
    throw new TagMessagingError(400, `text must contain 1–${WORKSTREAM_POST_MAX_BODY} characters`);
  const to = record["to"];
  if (to === undefined) return { text: text.trim() };
  if (!Array.isArray(to) || to.length === 0 || to.length > WORKSTREAM_POST_MAX_TO)
    throw new TagMessagingError(400, `to must list 1–${WORKSTREAM_POST_MAX_TO} Tags`);
  return {
    text: text.trim(),
    to: [...new Set(to.map((tag) => mailboxText(tag, "to")))].sort(),
  };
}
