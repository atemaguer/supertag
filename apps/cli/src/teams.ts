import { parseArgs } from "node:util";
import type { Team } from "@supertag/core";
import { type ControlPlaneClient, ControlPlaneRequestError } from "./control-plane-client.js";
import { takeOutputFlag } from "./output-flag.js";
import { withCurrentRevision } from "./revision.js";
import { terminalText } from "./terminal-text.js";

const TEAMS = "/api/v1/tag-messaging/teams";

export function teamHelp(): string {
  return `Usage:
  supertag create team NAME --member TAG [--member TAG ...] [--max-concurrency N]
  supertag list team
  supertag get team NAME
  supertag update team NAME [--member TAG ...] [--max-concurrency N] [--name TEXT] [--revision N]
  supertag delete team NAME

A Team is a set of Tags. Members may message one another and share the Team's Workstream, and
an Objective that names the Team may hand work to its members.
Members use Tag names. On update, --member replaces the whole member list.
--max-concurrency limits how many turns run at once across every open Objective that names the
Team; later turns wait. Leave it out so Worker Host capacity is the only limit, and pass an empty
value to update to remove it.
Without --revision, update reads the current revision and retries once after an unrelated change.
delete refuses a Team that an open Objective names.
create, update, and delete print a one-line summary; add --output json for the full record.
`;
}

export async function runTeamCommand(
  client: ControlPlaneClient,
  args: readonly string[],
): Promise<string> {
  const [command, ...given] = args;
  const output = takeOutputFlag(given);
  const { values, positionals } = parseArgs({
    args: [...output.args],
    allowPositionals: true,
    strict: true,
    options: {
      name: { type: "string" },
      members: { type: "string" },
      concurrency: { type: "string" },
      revision: { type: "string" },
    },
  });
  const allowed =
    command === "create"
      ? ["members", "concurrency"]
      : command === "update"
        ? ["name", "members", "concurrency", "revision"]
        : command === "list" || command === "get" || command === "delete"
          ? []
          : undefined;
  if (
    allowed === undefined ||
    Object.keys(values).some((key) => !allowed.includes(key)) ||
    positionals.length !== (command === "list" ? 0 : 1)
  )
    throw new Error(teamHelp());
  if (command === "list") return json(await client.request(TEAMS));
  const name = positionals[0] as string;
  const memberTagIds = async (list: string): Promise<string[]> =>
    Promise.all(
      list
        .split(",")
        .map((member) => member.trim())
        .filter(Boolean)
        .map(async (member) => {
          const tag = await client.getTag(member);
          if (!tag.metadata.id) throw new Error(`Tag ${member} has no ID`);
          return tag.metadata.id;
        }),
    );
  const concurrency = (value: string): number | null => {
    if (value === "") return null;
    const limit = Number(value);
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(limit) || limit < 1)
      throw new Error("--max-concurrency must be a positive integer");
    return limit;
  };
  if (command === "create") {
    if (!values.members) throw new Error(teamHelp());
    const limit = values.concurrency === undefined ? null : concurrency(values.concurrency);
    const team = await client.request<Team>(TEAMS, {
      method: "POST",
      body: JSON.stringify({
        id: name,
        name,
        memberTagIds: await memberTagIds(values.members),
        ...(limit === null ? {} : { maxConcurrency: limit }),
      }),
    });
    return output.json ? json(team) : `team/${terminalText(team.name)} created.\n`;
  }
  const team = await findTeam(client, name);
  const path = `${TEAMS}/${encodeURIComponent(team.id)}`;
  if (command === "get") return json(team);
  if (command === "delete") {
    const result = await client.request(path, { method: "DELETE" });
    return output.json ? json(result) : `team/${terminalText(team.name)} deleted.\n`;
  }
  const change: Record<string, unknown> = {
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.members === undefined ? {} : { memberTagIds: await memberTagIds(values.members) }),
    ...(values.concurrency === undefined
      ? {}
      : { maxConcurrency: concurrency(values.concurrency) }),
  };
  if (Object.keys(change).length === 0) throw new Error(teamHelp());
  const updated = await withCurrentRevision({
    explicit: values.revision,
    resource: `Team ${name}`,
    read: () => client.request<Record<string, unknown>>(path),
    fields: Object.keys(change),
    write: (expectedRevision) =>
      client.request<Team>(path, {
        method: "PATCH",
        body: JSON.stringify({ ...change, expectedRevision }),
      }),
  });
  return output.json
    ? json(updated)
    : `team/${terminalText(updated.name)} updated (revision ${updated.revision}).\n`;
}

/** A Team by name, or by ID. */
async function findTeam(client: ControlPlaneClient, name: string): Promise<Team> {
  try {
    return await client.request<Team>(`${TEAMS}/${encodeURIComponent(name)}`);
  } catch (error) {
    if (!(error instanceof ControlPlaneRequestError) || error.status !== 404) throw error;
  }
  const { items } = await client.request<{ readonly items: readonly Team[] }>(TEAMS);
  const team = items.find((candidate) => candidate.name === name);
  if (team === undefined) throw new Error(`Team ${terminalText(name)} does not exist`);
  return team;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
