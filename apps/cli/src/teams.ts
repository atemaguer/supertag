import { parseArgs } from "node:util";
import { create, type DescMessage, type MessageShape, toJsonString } from "@bufbuild/protobuf";
import {
  DeleteTeamResponseSchema,
  ListTeamsResponseSchema,
  type Team,
  TeamSchema,
} from "@supertag/operator-api";
import { type OperatorClientOptions, teamClient } from "./operator-client.js";
import { takeOutputFlag } from "./output-flag.js";
import { withCurrentRevision } from "./revision.js";
import { refusedAsError } from "./tag-conversation.js";
import { terminalText } from "./terminal-text.js";

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
  client: { readonly operator: OperatorClientOptions },
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
  const teams = teamClient(client.operator);
  if (command === "list") return json(ListTeamsResponseSchema, await allTeams(teams));
  const name = positionals[0] as string;
  const members = (list: string): string[] =>
    list
      .split(",")
      .map((member) => member.trim())
      .filter(Boolean);
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
    const team = await refusedAsError(() =>
      teams.createTeam({
        id: name,
        name,
        members: members(values.members as string),
        ...(limit === null ? {} : { maxConcurrency: limit }),
      }),
    );
    return output.json ? json(TeamSchema, team) : `team/${terminalText(team.name)} created.\n`;
  }
  if (command === "get")
    return json(TeamSchema, await refusedAsError(() => teams.getTeam({ team: name })));
  if (command === "delete") {
    const result = await refusedAsError(() => teams.deleteTeam({ team: name }));
    return output.json
      ? json(DeleteTeamResponseSchema, result)
      : `team/${terminalText(result.name)} deleted.\n`;
  }
  const change = {
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.members === undefined ? {} : { members: { tags: members(values.members) } }),
    ...(values.concurrency === undefined
      ? {}
      : { concurrency: { maxConcurrency: concurrency(values.concurrency) ?? 0 } }),
  };
  const fields = [
    ...(values.name === undefined ? [] : ["name"]),
    ...(values.members === undefined ? [] : ["memberTagIds"]),
    ...(values.concurrency === undefined ? [] : ["maxConcurrency"]),
  ];
  if (fields.length === 0) throw new Error(teamHelp());
  const updated = await refusedAsError(() =>
    withCurrentRevision({
      explicit: values.revision,
      resource: `Team ${name}`,
      read: async () => teamRecord(await teams.getTeam({ team: name })),
      fields,
      write: (expectedRevision) =>
        teams.updateTeam({ team: name, expectedRevision: BigInt(expectedRevision), ...change }),
    }),
  );
  return output.json
    ? json(TeamSchema, updated)
    : `team/${terminalText(updated.name)} updated (revision ${updated.revision}).\n`;
}

/** Every Team, by name, one page after another. */
async function allTeams(teams: ReturnType<typeof teamClient>) {
  const all: Team[] = [];
  let pageToken = "";
  do {
    const page = await refusedAsError(() => teams.listTeams({ pageSize: 500, pageToken }));
    all.push(...page.teams);
    pageToken = page.nextPageToken;
  } while (pageToken !== "");
  return create(ListTeamsResponseSchema, { teams: all });
}

/** A Team as `withCurrentRevision` compares it: the fields `update team` changes. */
function teamRecord(team: Team): Record<string, unknown> {
  return {
    name: team.name,
    memberTagIds: team.members.map((member) => member.tagId),
    maxConcurrency: team.maxConcurrency ?? null,
    revision: Number(team.revision),
  };
}

function json<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): string {
  return `${toJsonString(schema, message, { prettySpaces: 2 })}\n`;
}
