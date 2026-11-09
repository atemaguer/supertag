import { Code, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type {
  TagMessage as TagMessageRecord,
  TagMessageStatus as TagMessageWord,
} from "@supertag/core";
import { ErrorReason, type MailboxService, TagMessageStatus } from "@supertag/operator-api";
import { pageOffset, pageToken } from "./conversation-messages.js";
import { assertAccepting, pageSizeOf } from "./inbox-rpc.js";
import { enumTable, timestampOf, workstreamPostMessage } from "./objective-protos.js";
import { operatorAuditTarget, operatorError } from "./operator-rpc-context.js";
import type { OperatorControl, OperatorReadStore } from "./operator-seams.js";
import { findTeam } from "./team-rpc.js";

const MESSAGE_STATUS = enumTable<TagMessageWord, TagMessageStatus>(
  [
    ["pending", TagMessageStatus.PENDING],
    ["handled", TagMessageStatus.HANDLED],
    ["failed", TagMessageStatus.FAILED],
  ],
  TagMessageStatus.UNSPECIFIED,
);

export interface MailboxServiceDependencies {
  readonly store: Pick<
    OperatorReadStore,
    | "findTagById"
    | "findTagByName"
    | "getTeam"
    | "listTagMessageHistory"
    | "listTagMessagingGrants"
    | "listTeamPosts"
    | "listTeams"
  >;
  /** Grants and revokes Mailbox grants. */
  readonly control: Pick<OperatorControl, "accepting" | "grantMailbox" | "revokeMailbox">;
}

/** `MailboxService`: what Tags say to one another, as an operator reads it. */
export function mailboxService(
  dependencies: MailboxServiceDependencies,
): ServiceImpl<typeof MailboxService> {
  const { store, control } = dependencies;

  const tagIdOf = async (name: string, path: string): Promise<string> => {
    if (name === "")
      throw operatorError(
        Code.InvalidArgument,
        ErrorReason.INVALID_ARGUMENT,
        `${path} is required`,
        [{ path, description: "a Tag's name" }],
      );
    const tag = await store.findTagByName(name);
    if (tag === undefined || tag.status !== "active")
      throw operatorError(Code.NotFound, ErrorReason.NOT_FOUND, `Tag "${name}" does not exist`, [
        { path, description: "a Tag's name" },
      ]);
    return tag.id;
  };

  /** The names of the Tags with these IDs; a deleted Tag has none. */
  const tagNames = async (ids: Iterable<string>): Promise<Record<string, string>> => {
    const tags = await Promise.all([...new Set(ids)].map((id) => store.findTagById(id)));
    return Object.fromEntries(
      tags.flatMap((tag) =>
        tag === undefined || tag.status !== "active" ? [] : [[tag.id, tag.name]],
      ),
    );
  };

  const changeGrant = async (
    request: { readonly sender: string; readonly recipient: string },
    context: HandlerContext,
    change: OperatorControl["grantMailbox"],
  ) => {
    const senderTagId = await tagIdOf(request.sender, "sender");
    const recipientTagId = await tagIdOf(request.recipient, "recipient");
    const note = context.values.get(operatorAuditTarget);
    if (note !== undefined) note.target = `Mailbox/${recipientTagId}`;
    await assertAccepting(control);
    const result = await change({ senderTagId, recipientTagId });
    return {
      grant: {
        senderTagId: result.grant.senderTagId,
        recipientTagId: result.grant.recipientTagId,
      },
      changed: result.changed,
    };
  };

  return {
    async listTagMessages(request) {
      const tagId = await tagIdOf(request.tag, "tag");
      const before = request.pageToken === "" ? undefined : messageCursor(request.pageToken);
      const page = await store.listTagMessageHistory(tagId, {
        limit: pageSizeOf(request.pageSize, 50, 200),
        ...(before === undefined ? {} : { before }),
      });
      return {
        messages: page.items.map(tagMessageMessage),
        tagNames: await tagNames(
          page.items.flatMap((message) => [message.senderTagId, message.recipientTagId]),
        ),
        nextPageToken:
          page.nextCursor === undefined
            ? ""
            : Buffer.from(JSON.stringify([page.nextCursor.createdAt, page.nextCursor.id])).toString(
                "base64url",
              ),
      };
    },

    grantMailbox: (request, context) => changeGrant(request, context, control.grantMailbox),

    revokeMailbox: (request, context) => changeGrant(request, context, control.revokeMailbox),

    async listMailboxGrants(request) {
      const tagId = await tagIdOf(request.tag, "tag");
      const offset = pageOffset(request.pageToken);
      const size = pageSizeOf(request.pageSize, 100, 500);
      const grants = (await store.listTagMessagingGrants(tagId)).toSorted(
        (left, right) =>
          left.senderTagId.localeCompare(right.senderTagId) ||
          left.recipientTagId.localeCompare(right.recipientTagId),
      );
      const page = grants.slice(offset, offset + size);
      return {
        grants: page.map(({ senderTagId, recipientTagId }) => ({ senderTagId, recipientTagId })),
        tagNames: await tagNames(
          page.flatMap((grant) => [grant.senderTagId, grant.recipientTagId]),
        ),
        nextPageToken: offset + size < grants.length ? pageToken(offset + size) : "",
      };
    },

    async listWorkstreamPosts(request) {
      const team = await findTeam(store, request.team);
      const size = pageSizeOf(request.pageSize, 50, 200);
      const continued = request.pageToken === "" ? undefined : postCursor(request.pageToken);
      const after =
        continued ??
        (request.afterSequence === undefined ? undefined : Number(request.afterSequence));
      const page = await store.listTeamPosts(team.id, {
        limit: size,
        ...(after === undefined ? {} : { afterSequence: after }),
      });
      const last = page.at(-1);
      const more =
        after !== undefined &&
        last !== undefined &&
        page.length === size &&
        (await store.listTeamPosts(team.id, { limit: 1, afterSequence: last.sequence })).length > 0;
      return {
        posts: page.map(workstreamPostMessage),
        tagNames: await tagNames(page.flatMap((post) => [post.authorTagId, ...post.to])),
        nextPageToken: more ? `s${last.sequence}` : "",
      };
    },
  };
}

function tagMessageMessage(message: TagMessageRecord) {
  const createdAt = timestampOf(message.createdAt);
  return {
    id: message.id,
    senderTagId: message.senderTagId,
    recipientTagId: message.recipientTagId,
    objectiveId: message.objectiveId ?? "",
    sourceTaskId: message.sourceTaskId ?? "",
    workstreamPostId: message.workstreamPostId ?? "",
    text: message.text,
    hops: message.hops,
    taskId: message.taskId ?? "",
    status: MESSAGE_STATUS.value(message.status),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function invalidToken() {
  return operatorError(
    Code.InvalidArgument,
    ErrorReason.INVALID_ARGUMENT,
    "The page token is not valid",
    [{ path: "page_token", description: "a next_page_token from the previous page" }],
  );
}

function messageCursor(token: string): { readonly createdAt: string; readonly id: string } {
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
  throw invalidToken();
}

function postCursor(token: string): number {
  const match = /^s(0|[1-9][0-9]{0,15})$/u.exec(token);
  if (match === null) throw invalidToken();
  return Number(match[1]);
}
