import { parseArgs } from "node:util";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";
import { takeOutputFlag } from "./output-flag.js";
import { withCurrentRevision } from "./revision.js";

export function teamHelp(): string {
  return `Usage:
  supertag create team ID --objective ID --name TEXT --lead TAG [--member TAG] [--max-concurrency N] [--parent TEAM] [--max-breadth N] [--max-depth N]
  supertag list team [--objective ID]
  supertag events team ID --objective ID [--after-revision N] [--limit N]
  supertag update team ID --objective ID [--revision N] [--name TEXT] [--lead TAG] [--member TAG] [--max-concurrency N] [--max-breadth N] [--max-depth N]
  supertag dissolve team ID --objective ID [--revision N]

Lead and members use Tag names. Without --revision, updates read the current Team revision
and retry once after an unrelated change.
Scaling ceilings use nonnegative safe integers; 0 prevents children. Concurrency is separate.
--max-concurrency throttles the Team's own running Task Attempts; leave it out so Worker Host
capacity is the only limit, and pass an empty value to update to remove it.
Dissolution requires closing unfinished Tasks and active subteams first.
create, update, and dissolve print a one-line summary; add --output json for the full record.
`;
}
export async function runTeamCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
): Promise<string> {
  const [command, ...given] = args;
  const output =
    command === "create" || command === "update" || command === "dissolve"
      ? takeOutputFlag(given)
      : { json: true, args: given };
  const rest = output.args;
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    strict: true,
    options: {
      objective: { type: "string" },
      objectives: { type: "string" },
      name: { type: "string" },
      lead: { type: "string" },
      members: { type: "string" },
      parent: { type: "string" },
      concurrency: { type: "string" },
      "max-breadth": { type: "string" },
      "max-depth": { type: "string" },
      revision: { type: "string" },
      "after-revision": { type: "string" },
      limit: { type: "string" },
    },
  });
  const allowed =
    command === "create"
      ? [
          "objective",
          "name",
          "lead",
          "members",
          "parent",
          "concurrency",
          "max-breadth",
          "max-depth",
        ]
      : command === "update"
        ? [
            "objective",
            "objectives",
            "revision",
            "name",
            "lead",
            "members",
            "concurrency",
            "max-breadth",
            "max-depth",
          ]
        : command === "dissolve"
          ? ["objective", "revision"]
          : command === "list"
            ? ["objective"]
            : command === "history"
              ? ["objective", "after-revision", "limit"]
              : [];
  if (
    (command !== "list" && !values.objective) ||
    !allowed.length ||
    Object.keys(values).some((key) => !allowed.includes(key)) ||
    positionals.length !== (command === "list" ? 0 : 1)
  )
    throw new Error(teamHelp());
  const scaling: { maxBreadth?: number; maxDepth?: number } = {};
  for (const [flag, field] of [
    ["max-breadth", "maxBreadth"],
    ["max-depth", "maxDepth"],
  ] as const) {
    const value = values[flag];
    if (value === undefined) continue;
    const limit = Number(value);
    if (!value.trim() || !Number.isSafeInteger(limit) || limit < 0)
      throw new Error(`--${flag} must be a nonnegative safe integer`);
    scaling[field] = limit;
  }
  const client = new ControlPlaneClient(target);
  if (command === "history") {
    const query = new URLSearchParams({ objectiveId: values.objective as string });
    if (values["after-revision"] !== undefined)
      query.set("afterRevision", values["after-revision"]);
    if (values.limit !== undefined) query.set("limit", values.limit);
    const result = await client.request(
      `/api/v1/coordination/teams/${encodeURIComponent(positionals[0] as string)}/history?${query}`,
    );
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  const namedTagId = async (name: string): Promise<string> => {
    const tag = await client.getTag(name);
    if (!tag.metadata.id) throw new Error("Tag has no ID");
    return tag.metadata.id;
  };
  const input: Record<string, unknown> = { objectiveId: values.objective };
  if (Object.keys(scaling).length) input["scaling"] = scaling;
  if (values.objectives !== undefined)
    input["objectiveIds"] =
      values.objectives === "" ? [] : values.objectives.split(",").map((id) => id.trim());
  if (values.name !== undefined) input["name"] = values.name;
  if (values.lead !== undefined) input["leadTagId"] = await namedTagId(values.lead);
  if (values.members !== undefined)
    input["memberTagIds"] = await Promise.all(
      values.members === "" ? [] : values.members.split(",").map((name) => namedTagId(name.trim())),
    );
  if (values.concurrency !== undefined)
    input["maxConcurrency"] = values.concurrency === "" ? null : Number(values.concurrency);
  if (values.parent !== undefined) input["parentTeamId"] = values.parent;
  const post = (operation: string, body: Record<string, unknown>) =>
    client.request(`/api/v1/coordination/${operation}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  let result: unknown;
  if (command === "create") {
    if (!values.name || !values.lead) throw new Error(teamHelp());
    input["id"] = positionals[0];
    input["memberTagIds"] ??= [];
    result = await post("create_team", input);
  } else if (command === "list") {
    const objectiveIds: string[] = [];
    if (values.objective) objectiveIds.push(values.objective);
    else {
      const pageSize = 200;
      for (let offset = 0; ; offset += pageSize) {
        const { items } = await client.request<{ items: { id: string; status: string }[] }>(
          `/api/v1/tag-messaging/objectives?limit=${pageSize}&offset=${offset}`,
        );
        objectiveIds.push(
          ...items
            .filter(
              (objective) => objective.status !== "completed" && objective.status !== "cancelled",
            )
            .map((objective) => objective.id),
        );
        if (items.length < pageSize) break;
      }
    }
    const objectives = await Promise.all(
      objectiveIds.map((objectiveId) => post("read_objective", { objectiveId })),
    );
    result = objectives.flatMap(
      (objective) => ((objective as Record<string, unknown>)["teams"] ?? []) as unknown[],
    );
  } else {
    const teamId = positionals[0] as string;
    input["teamId"] = teamId;
    if (command === "dissolve") input["status"] = "dissolved";
    result = await withCurrentRevision({
      explicit: values.revision,
      resource: `Team ${teamId}`,
      read: () =>
        post("read_team", { objectiveId: values.objective, teamId }) as Promise<
          Record<string, unknown>
        >,
      fields: Object.keys(input).filter((key) => key !== "objectiveId" && key !== "teamId"),
      write: (expectedRevision) => post("update_team", { ...input, expectedRevision }),
    });
  }
  if (output.json) return `${JSON.stringify(result, null, 2)}\n`;
  const team = (result ?? {}) as { readonly id?: string; readonly revision?: number };
  const id = team.id ?? positionals[0];
  return command === "create"
    ? `team/${id} created.\n`
    : `team/${id} ${command === "dissolve" ? "dissolved" : "updated"} (revision ${team.revision ?? "?"}).\n`;
}
