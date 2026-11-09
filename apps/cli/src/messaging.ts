import { parseArgs } from "node:util";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
  type ListMailboxGrantsResponse,
  ListMailboxGrantsResponseSchema,
  ListTagMessagesResponseSchema,
  type MailboxGrant,
} from "@supertag/operator-api";
import type { ControlPlaneTarget } from "./control-plane-client.js";
import { mailboxClient } from "./operator-client.js";
import { refusedAsError } from "./tag-conversation.js";
import { mailboxLimit } from "./workstreams.js";

export function tagMessagingHelp(): string {
  return `Usage:
  supertag grant mailbox RECIPIENT --sender SENDER
  supertag revoke mailbox RECIPIENT --sender SENDER
  supertag list mailbox-grant --mailbox TAG
  supertag list message --mailbox TAG [--limit N]

Use Tag names. Tags in the same Team may message one another; a grant lets RECIPIENT accept
messages from SENDER as well. Grants are directional and do not grant execution authority.
A Tag manifest's acceptsMessagesFrom lists the same grants.
list message shows the messages the Tag sent or received, newest first, each with its status:
pending until the Tag's inbox takes it, then handled or failed with the turn that took it.
`;
}

export async function runTagMessagingCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
): Promise<string> {
  const [command, ...rest] = args;
  const mailbox = mailboxClient({ url: target.url, token: target.token, warnOnSkew: true });
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    strict: true,
    options: { limit: { type: "string" } },
  });
  const tag = (name: string | undefined): string => {
    if (!name) throw new Error("A Tag name is required");
    return name;
  };
  if (command === "grant" || command === "revoke") {
    if (positionals.length !== 2 || values.limit !== undefined) throw new Error(tagMessagingHelp());
    const grant = { sender: tag(positionals[0]), recipient: tag(positionals[1]) };
    await refusedAsError(() =>
      command === "grant" ? mailbox.grantMailbox(grant) : mailbox.revokeMailbox(grant),
    );
    return command === "grant"
      ? `${positionals[1]} accepts messages from ${positionals[0]}.\n`
      : `Revoked the grant: ${positionals[1]} no longer accepts messages from ${positionals[0]} outside a shared Team.\n`;
  }
  if (command === "messages") {
    if (positionals.length !== 1) throw new Error(tagMessagingHelp());
    const limit = values.limit === undefined ? 0 : mailboxLimit(values.limit);
    const page = await refusedAsError(() =>
      mailbox.listTagMessages({ tag: tag(positionals[0]), pageSize: limit }),
    );
    return `${toJsonString(ListTagMessagesResponseSchema, page, { prettySpaces: 2 })}\n`;
  }
  if (command === "grants") {
    if (positionals.length !== 1 || values.limit !== undefined) throw new Error(tagMessagingHelp());
    const name = tag(positionals[0]);
    const grants: MailboxGrant[] = [];
    const tagNames: Record<string, string> = {};
    let pageToken = "";
    do {
      const page: ListMailboxGrantsResponse = await refusedAsError(() =>
        mailbox.listMailboxGrants({ tag: name, pageSize: 500, pageToken }),
      );
      grants.push(...page.grants);
      Object.assign(tagNames, page.tagNames);
      pageToken = page.nextPageToken;
    } while (pageToken !== "");
    return `${toJsonString(
      ListMailboxGrantsResponseSchema,
      create(ListMailboxGrantsResponseSchema, { grants, tagNames }),
      { prettySpaces: 2 },
    )}\n`;
  }
  throw new Error(tagMessagingHelp());
}
