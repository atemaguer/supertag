import { parseArgs } from "node:util";
import type { ControlPlaneClient } from "./control-plane-client.js";
import { runTeamCommand } from "./teams.js";

export function workstreamHelp(): string {
  return `Usage:
  supertag list workstream-post --team TEAM [--after-sequence N] [--limit N]

Every Team has one Workstream: the shared record of its members' posts, which every member
reads. A post wakes nobody; a post addressed to Tags is delivered to each of them as a Mailbox
message. Without --after-sequence the newest posts are listed; with it, the posts after that
sequence number, oldest first.
`;
}

/** Lists a Team's Workstream posts; `args` are the `list workstream-post` options. */
export async function listWorkstreamPosts(
  client: ControlPlaneClient,
  args: readonly string[],
): Promise<unknown> {
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
  const team = JSON.parse(await runTeamCommand(client, ["get", values.team])) as {
    readonly id: string;
  };
  const query = new URLSearchParams();
  if (values.limit !== undefined) query.set("limit", values.limit);
  if (values["after-sequence"] !== undefined) query.set("afterSequence", values["after-sequence"]);
  return client.request(
    `/api/v1/tag-messaging/workstreams/${encodeURIComponent(team.id)}/posts?${query}`,
  );
}
