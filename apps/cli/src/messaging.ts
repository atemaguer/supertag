import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { TagMailboxCredential } from "@supertag/core";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";

export function tagMessagingHelp(): string {
  return `Usage:
  supertag grant mailbox RECIPIENT --sender SENDER --type TYPE [--type TYPE]
  supertag revoke mailbox RECIPIENT --sender SENDER
  supertag list mailbox-grant --mailbox TAG
  supertag list message --mailbox TAG [--limit N]
  supertag prune mailbox --before TIMESTAMP [--limit N]
  supertag issue mailbox-credential TAG --out PATH
  supertag revoke mailbox-credential ID

Use Tag names. Grants are directional and do not grant execution authority.
Credential files are written with mode 0600; existing files are never overwritten.
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
    options: {
      types: { type: "string" },
      out: { type: "string" },
      limit: { type: "string" },
      "before-created-at": { type: "string" },
      "before-id": { type: "string" },
      before: { type: "string" },
    },
  });
  if (
    (command !== "history" &&
      (values["before-created-at"] !== undefined || values["before-id"] !== undefined)) ||
    (command !== "prune-bodies" && values.before !== undefined)
  )
    throw new Error(tagMessagingHelp());
  const tagId = async (name: string | undefined): Promise<string> => {
    if (!name) throw new Error("A Tag name is required");
    const tag = await client.getTag(name);
    if (!tag.metadata.id) throw new Error("Tag has no ID");
    return tag.metadata.id;
  };
  const endpoint = "/api/v1/tag-messaging";
  if (command === "history") {
    if (
      positionals.length !== 1 ||
      values.out ||
      values.types ||
      (values["before-created-at"] === undefined) !== (values["before-id"] === undefined)
    )
      throw new Error(tagMessagingHelp());
    const query = new URLSearchParams({ tagId: await tagId(positionals[0]) });
    if (values.limit !== undefined) query.set("limit", values.limit);
    if (values["before-created-at"] !== undefined)
      query.set("beforeCreatedAt", values["before-created-at"]);
    if (values["before-id"] !== undefined) query.set("beforeId", values["before-id"]);
    return `${JSON.stringify(await client.request(`${endpoint}/history?${query}`), null, 2)}\n`;
  }
  if (command === "prune-bodies") {
    if (positionals.length !== 0 || values.before === undefined || values.out || values.types)
      throw new Error(tagMessagingHelp());
    return `${JSON.stringify(
      await client.request(`${endpoint}/retention`, {
        method: "POST",
        body: JSON.stringify({
          before: values.before,
          ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
        }),
      }),
      null,
      2,
    )}\n`;
  }
  if (command === "grant" || command === "revoke") {
    if (
      positionals.length !== 2 ||
      values.out ||
      values.limit ||
      (command === "revoke" && values.types)
    )
      throw new Error(tagMessagingHelp());
    if (command === "grant" && !values.types) throw new Error("--types is required");
    const senderTagId = await tagId(positionals[0]);
    const recipientTagId = await tagId(positionals[1]);
    await client.request(`${endpoint}/grants`, {
      method: "PUT",
      body: JSON.stringify({
        senderTagId,
        recipientTagId,
        messageTypes:
          command === "revoke" ? [] : values.types?.split(",").map((type) => type.trim()),
      }),
    });
    return `${command === "revoke" ? "Revoked" : "Updated"} messaging grant from ${positionals[0]} to ${positionals[1]}.\n`;
  }
  if (command === "messages" || command === "grants") {
    if (
      positionals.length !== 1 ||
      values.out ||
      values.types ||
      (command === "grants" && values.limit)
    )
      throw new Error(tagMessagingHelp());
    const id = await tagId(positionals[0]);
    const suffix =
      command === "messages" && values.limit ? `&limit=${encodeURIComponent(values.limit)}` : "";
    return `${JSON.stringify(await client.request(`${endpoint}/${command}?tagId=${encodeURIComponent(id)}${suffix}`, { method: "GET" }), null, 2)}\n`;
  }
  if (command === "credential") {
    if (positionals.length !== 1 || !values.out || values.types || values.limit)
      throw new Error(tagMessagingHelp());
    const id = await tagId(positionals[0]);
    const path = resolve(values.out);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "wx", 0o600);
    let credential: (TagMailboxCredential & { token: string }) | undefined;
    try {
      credential = await client.request<TagMailboxCredential & { token: string }>(
        `${endpoint}/credentials`,
        { method: "POST", body: JSON.stringify({ tagId: id }) },
      );
      await file.writeFile(
        `${JSON.stringify({ ...credential, controlPlaneUrl: target.url }, null, 2)}\n`,
      );
    } catch (error) {
      if (credential)
        await client
          .request(`${endpoint}/credentials/${credential.id}`, { method: "DELETE" })
          .catch(() => undefined);
      throw error;
    } finally {
      await file.close();
    }
    return `Mailbox credential saved to ${path}\nCredential ID: ${credential.id}\nTag ID: ${id}\n`;
  }
  if (command === "revoke-credential") {
    if (positionals.length !== 1 || values.out || values.types || values.limit)
      throw new Error(tagMessagingHelp());
    await client.request(`${endpoint}/credentials/${encodeURIComponent(positionals[0] ?? "")}`, {
      method: "DELETE",
    });
    return "Mailbox credential revoked.\n";
  }
  throw new Error(tagMessagingHelp());
}
