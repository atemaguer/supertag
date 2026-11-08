import { parseArgs } from "node:util";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";

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
  const client = new ControlPlaneClient(target);
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    strict: true,
    options: { limit: { type: "string" } },
  });
  const tagId = async (name: string | undefined): Promise<string> => {
    if (!name) throw new Error("A Tag name is required");
    const tag = await client.getTag(name);
    if (!tag.metadata.id) throw new Error("Tag has no ID");
    return tag.metadata.id;
  };
  const endpoint = "/api/v1/tag-messaging";
  if (command === "grant" || command === "revoke") {
    if (positionals.length !== 2 || values.limit !== undefined) throw new Error(tagMessagingHelp());
    await client.request(`${endpoint}/grants`, {
      method: command === "grant" ? "PUT" : "DELETE",
      body: JSON.stringify({
        senderTagId: await tagId(positionals[0]),
        recipientTagId: await tagId(positionals[1]),
      }),
    });
    return command === "grant"
      ? `${positionals[1]} accepts messages from ${positionals[0]}.\n`
      : `Revoked the grant: ${positionals[1]} no longer accepts messages from ${positionals[0]} outside a shared Team.\n`;
  }
  if (command === "messages" || command === "grants") {
    if (positionals.length !== 1 || (command === "grants" && values.limit !== undefined))
      throw new Error(tagMessagingHelp());
    const query = new URLSearchParams({ tagId: await tagId(positionals[0]) });
    if (values.limit !== undefined) query.set("limit", values.limit);
    return `${JSON.stringify(await client.request(`${endpoint}/${command}?${query}`), null, 2)}\n`;
  }
  throw new Error(tagMessagingHelp());
}
