import { parseArgs } from "node:util";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";

export function workstreamHelp(): string {
  return `Usage:
  supertag list workstream [--tag TAG] [--limit N]
  supertag get workstream ID
  supertag list workstream-post --workstream ID [--after-sequence N] [--limit N]

Every Team has one channel, its Workstream, created with the Team; the Workstream ID is the
Team ID. Team members read and post in it, and the Team's Objective owner may read it.
Without --tag, list workstream shows every Team channel the operator may read.
Each post has a type (note, question, blocker, evidence, or decision) and the Tags it is
addressed to. A post carries no authority. It can wake a Task waiting on the channel or
trigger an Objective observation assessment when the channel is an observation source.
`;
}
export async function runWorkstreamCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
): Promise<string> {
  const [command, ...rest] = args;
  if (command !== "list" && command !== "get" && command !== "posts")
    throw new Error(workstreamHelp());
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    strict: true,
    options: {
      limit: { type: "string" },
      "after-sequence": { type: "string" },
    },
  });
  const allowed =
    command === "posts" ? ["limit", "after-sequence"] : command === "list" ? ["limit"] : [];
  if (
    Object.keys(values).some((key) => !allowed.includes(key)) ||
    positionals.length > 1 ||
    (positionals.length === 0 && command !== "list")
  )
    throw new Error(workstreamHelp());
  const id = positionals[0] ?? "";
  const client = new ControlPlaneClient(target);
  const base = "/api/v1/tag-messaging/workstreams";
  let result: unknown;
  if (command === "list") {
    const query = new URLSearchParams();
    if (positionals.length === 1) {
      const tag = await client.getTag(id);
      if (!tag.metadata.id) throw new Error("Tag has no ID");
      query.set("tagId", tag.metadata.id);
    }
    if (values.limit !== undefined) query.set("limit", values.limit);
    result = await client.request(`${base}?${query}`);
  } else if (command === "get") {
    result = await client.request(`${base}/${encodeURIComponent(id)}`);
  } else {
    const query = new URLSearchParams();
    if (values.limit !== undefined) query.set("limit", values.limit);
    if (values["after-sequence"] !== undefined)
      query.set("afterSequence", values["after-sequence"]);
    result = await client.request(`${base}/${encodeURIComponent(id)}/posts?${query}`);
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}
