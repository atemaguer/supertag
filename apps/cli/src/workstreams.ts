import { parseArgs } from "node:util";
import { type JsonValue, toJson } from "@bufbuild/protobuf";
import type { WorkstreamPost } from "@supertag/core";
import { ListWorkstreamPostsResponseSchema } from "@supertag/operator-api";
import { isoOf } from "./objective-protos.js";
import { mailboxClient, type OperatorClientOptions, refusedAsError } from "./operator-client.js";

export function workstreamHelp(): string {
  return `Usage:
  supertag list workstream-post --team TEAM [--after-sequence N] [--limit N]

Every Team has one Workstream: the shared record of its members' posts, which every member
reads. A post wakes nobody; a post addressed to Tags is delivered to each of them as a Mailbox
message. Without --after-sequence the newest posts are listed; with it, the posts after that
sequence number, oldest first.
`;
}

/** Lists a Team's Workstream posts as proto3 JSON; `args` are the `list workstream-post` options. */
export async function listWorkstreamPosts(
  client: { readonly operator: OperatorClientOptions },
  args: readonly string[],
): Promise<JsonValue> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      team: { type: "string" },
      limit: { type: "string" },
      "after-sequence": { type: "string" },
    },
  });
  if (positionals.length > 0 || !values.team) throw new Error(workstreamHelp());
  const limit = values.limit === undefined ? 0 : mailboxLimit(values.limit);
  const after =
    values["after-sequence"] === undefined
      ? undefined
      : wholeNumber(values["after-sequence"], "afterSequence");
  const page = await refusedAsError(() =>
    mailboxClient(client.operator).listWorkstreamPosts({
      team: values.team as string,
      pageSize: limit,
      ...(after === undefined ? {} : { afterSequence: BigInt(after) }),
    }),
  );
  return toJson(ListWorkstreamPostsResponseSchema, page);
}

/** Reads a Team's Workstream posts after a sequence number, oldest first, one page per call. */
export function workstreamPosts(client: { readonly operator: OperatorClientOptions }) {
  const mailbox = mailboxClient(client.operator);
  return async (
    teamId: string,
    afterSequence: number,
    limit: number,
  ): Promise<readonly WorkstreamPost[]> =>
    (
      await refusedAsError(() =>
        mailbox.listWorkstreamPosts({
          team: teamId,
          afterSequence: BigInt(afterSequence),
          pageSize: limit,
        }),
      )
    ).posts.map((post) => ({
      id: post.id,
      teamId: post.teamId,
      authorTagId: post.authorTagId,
      to: post.toTagIds,
      body: post.body,
      ...(post.sourceTaskId === "" ? {} : { sourceTaskId: post.sourceTaskId }),
      sequence: Number(post.sequence),
      createdAt: isoOf(post.createdAt) ?? "",
    }));
}

/** A `--limit` of messages or posts: an integer from 1 to 200. */
export function mailboxLimit(value: string): number {
  const limit = wholeNumber(value, "limit");
  if (limit < 1 || limit > 200) throw new Error("limit must be between 1 and 200");
  return limit;
}

function wholeNumber(value: string, flag: string): number {
  const number = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number))
    throw new Error(`${flag} must be an integer`);
  return number;
}
