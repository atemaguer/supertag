import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageObjectiveResult, ObjectiveOverview } from "@supertag/control-plane";
import type { CoordinationInboxPage, Objective, Team } from "@supertag/core";
import type { Message } from "@supertag/operator-api";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";
import { localCheckouts } from "./delivery-view.js";
import { money } from "./money.js";
import { runObjectiveCancel } from "./objective-cancel.js";
import { formatObjectiveOverview } from "./objective-overview.js";
import { runObjectivePause } from "./objective-pause.js";
import { watchObjective } from "./objective-watch.js";
import { withCurrentRevision } from "./revision.js";
import { followTagMessage, refusedAsError, tagConversationClient } from "./tag-conversation.js";
import { runTeamCommand } from "./teams.js";
import { terminalText } from "./terminal-text.js";

export function objectiveHelp(): string {
  return `Usage:
  supertag create objective [ID] --outcome TEXT --owner TAG [--team TEAM] [--budget-minor N --budget-currency CODE] [--deadline ISO] [--runtime-action ACTION ...] [--workspace NAME ...] [--ongoing] [--dry-run]
  supertag list objective [--owner TAG] [--limit N]
  supertag get objective ID [--output yaml]
  supertag describe objective ID [--output text|json]
  supertag watch objective ID [--output text|json]
  supertag message objective ID TEXT|- [--output text|json]
  supertag approve objective ID
  supertag update objective ID --status STATUS [--revision N]
  supertag update objective ID [--revision N] [--deadline ISO] [--budget-minor N] [--runtime-action ACTION ...]
  supertag complete objective ID --summary-file FILE|- [--revision N]
  supertag cancel objective ID [--reason TEXT]
  supertag pause objective ID
  supertag resume objective ID

An Objective is an outcome its owner Tag works toward in a conversation of its own, with a budget,
a deadline, and a status. The outcome is one statement: the result, how success is verified, what
must not change, and when to ask a person.
Without an ID, create generates one from the outcome's first words, such as ship-sso-7f3k.
Create also starts the Objective: the owner takes its first turn. Running the same create again
never starts it twice. Create prints a warning for each condition that would hold its turns, such
as an owner Tag with no connected Worker Host. --dry-run checks and warns without creating anything.
--team names the Team whose members the owner may hand work to; create it first with
supertag create team. Without it, the owner works alone.
Runtime actions, such as files:write, default to those the owner Tag's Permission Sets allow,
recorded at creation. Repeat --runtime-action to narrow them; actions the owner lacks are dropped
with a warning. Update --runtime-action replaces the list for turns that start afterwards.
A budget with --budget-currency caps provider-reported cost for the owner and all the work it
starts. Repeat --workspace to name Workspaces the Objective's work may use; each must already exist.
Use --ongoing for a responsibility that only an operator can end.
message sends TEXT (or standard input for -) to the Objective's conversation as its next turn and
shows the owner's reply when the Objective was created from this CLI; otherwise the reply posts
to the thread the Objective was created in. A message answers a question the owner asked, and
moves a blocked, limited, or ready_for_review Objective back to working.
approve completes a ready_for_review Objective with the owner's assessment.
Update --deadline moves the deadline, including after it passed. Update --budget-minor only increases a budget.
Updates read the current revision when --revision is omitted and retry once after an unrelated change.
Update statuses: working, blocked, ready_for_review, completed. Only cancel sets cancelled.
Cancel stops the Objective for good: its open Tasks are cancelled and nothing new starts. Only
operators cancel; no revision is needed, and repeating it is harmless.
Pause holds the Objective without losing anything: no new turn starts, running Task Attempts
finish, and messages and reports wait. A paused Objective shows under Needs you. Resume lets work
start again and gives the owner a summary of what changed while it was paused. Only operators
pause and resume; repeating either is harmless.
complete is for scripts; it requires --summary-file with an assessment of the outcome and supporting results.
get --output yaml prints the Objective as a manifest. Declare Objectives, with a Team of their own
or a Team name, in a manifest or supertag.yaml and apply it: supertag apply -f FILE creates and
starts each one.
describe shows the status, owner, what the Objective delivered, what needs you, and its work.
watch prints one line per event until the Objective is completed or cancelled.
Commands that change an Objective print a one-line summary; add --output json for the full record.
`;
}
export async function runObjectiveCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
): Promise<string> {
  const [command, ...rest] = args;
  if (command === "cancel") return runObjectiveCancel(new ControlPlaneClient(target), rest);
  if (command === "pause" || command === "resume")
    return runObjectivePause(new ControlPlaneClient(target), command, rest);
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    strict: true,
    options: {
      outcome: { type: "string" },
      owner: { type: "string" },
      ongoing: { type: "boolean" },
      team: { type: "string" },
      workspace: { type: "string", multiple: true },
      revision: { type: "string" },
      summary: { type: "string" },
      "summary-file": { type: "string" },
      limit: { type: "string" },
      deadline: { type: "string" },
      "budget-minor": { type: "string" },
      "budget-currency": { type: "string" },
      "runtime-action": { type: "string", multiple: true },
      overview: { type: "boolean" },
      output: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const allowed =
    command === "create"
      ? [
          "outcome",
          "owner",
          "deadline",
          "budget-minor",
          "budget-currency",
          "runtime-action",
          "team",
          "ongoing",
          "workspace",
          "dry-run",
          "output",
        ]
      : command === "status"
        ? [
            "revision",
            "summary",
            "summary-file",
            "deadline",
            "budget-minor",
            "runtime-action",
            "output",
          ]
        : command === "list"
          ? ["owner", "limit"]
          : command === "message" || command === "approve" || command === "watch"
            ? ["output"]
            : command === "get" && values.overview
              ? ["overview", "output"]
              : [];
  if (
    Object.keys(values).some((key) => !allowed.includes(key)) ||
    (command === "status"
      ? // A deadline, budget, or runtime action update may omit the status positional.
        positionals.length !== 2 &&
        !(
          positionals.length === 1 &&
          (values.deadline !== undefined ||
            values["budget-minor"] !== undefined ||
            values["runtime-action"] !== undefined)
        )
      : command === "create"
        ? positionals.length > 1
        : command === "message"
          ? positionals.length !== 2
          : positionals.length !== (command === "list" ? 0 : 1))
  )
    throw new Error(objectiveHelp());
  if (values.output !== undefined && values.output !== "json" && values.output !== "text")
    throw new Error("--output must be text or json");
  const json = values.output === "json";
  const client = new ControlPlaneClient(target);
  const base = "/api/v1/tag-messaging/objectives";
  const id = positionals[0] ?? "";
  if (command === "watch") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    try {
      const checkouts = json ? undefined : await localCheckouts(target.url);
      await watchObjective(client, id, {
        output: json ? "json" : "text",
        signal: controller.signal,
        write: (text) => process.stdout.write(text),
        warn: (text) => process.stderr.write(text),
        ...(checkouts === undefined ? {} : { checkouts }),
      });
    } finally {
      process.removeListener("SIGINT", stop);
    }
    return "";
  }
  if (command === "get" && values.overview) {
    const overview = await client.request<ObjectiveOverview>(
      `/api/v1/coordination/objectives/${encodeURIComponent(id)}/overview`,
    );
    if (json) return `${JSON.stringify(overview, null, 2)}\n`;
    const [inbox, checkouts] = await Promise.all([
      client
        .request<CoordinationInboxPage>(
          `/api/v1/coordination/inbox?${new URLSearchParams({ objectiveId: id, limit: "100" })}`,
        )
        .then((page) => page.items)
        .catch(() => undefined),
      localCheckouts(target.url),
    ]);
    return formatObjectiveOverview(overview, {
      ...(inbox === undefined ? {} : { inbox }),
      ...(checkouts === undefined ? {} : { checkouts }),
    });
  }
  if (command === "message") {
    const text = positionals[1] === "-" ? await readStdin() : (positionals[1] ?? "");
    if (!text.trim()) throw new Error("The message is empty");
    const result = await client.request<MessageObjectiveResult>(
      `/api/v1/coordination/objectives/${encodeURIComponent(id)}/messages`,
      { method: "POST", body: JSON.stringify({ text: text.trim() }) },
    );
    if (json) return `${JSON.stringify(result, null, 2)}\n`;
    process.stdout.write(formatMessageResult(id, result));
    return followObjectiveReply(client, target, id, result.taskId);
  }
  if (command === "approve") {
    const objective = await client.request<Objective>(
      `/api/v1/coordination/objectives/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: "{}" },
    );
    return json
      ? `${JSON.stringify(objective, null, 2)}\n`
      : `objective/${terminalText(objective.id)} approved; it is completed (revision ${objective.revision}).\n`;
  }
  let result: unknown;
  if (command === "create") {
    if (!values.outcome || !values.owner) throw new Error(objectiveHelp());
    const owner = await client.getTag(values.owner);
    const dryRun = values["dry-run"] === true;
    const created = await client.request<
      Objective & {
        warnings?: string[];
        dryRun?: boolean;
        started?: { taskId: string };
        notStarted?: string;
      }
    >(`${base}${dryRun ? "?dryRun=true" : ""}`, {
      method: "POST",
      body: JSON.stringify({
        // Omitted IDs are generated by the Control Plane from the outcome.
        ...(positionals[0] === undefined ? {} : { id: positionals[0] }),
        ongoing: values.ongoing ?? false,
        outcome: values.outcome,
        ownerTagId: owner.metadata.id,
        ...(values.team === undefined ? {} : { teamId: await teamId(client, values.team) }),
        ...(values.deadline === undefined ? {} : { deadline: values.deadline }),
        ...(values["budget-minor"] === undefined
          ? {}
          : { budgetLimitMinor: Number(values["budget-minor"]) }),
        ...(values["budget-currency"] === undefined
          ? {}
          : { budgetCurrency: values["budget-currency"] }),
        ...(values["runtime-action"] === undefined
          ? {}
          : { runtimeActions: values["runtime-action"] }),
        ...(values.workspace === undefined ? {} : { workspaces: values.workspace }),
      }),
    });
    const { warnings = [], dryRun: _dryRun, started, notStarted, ...objective } = created;
    for (const warning of warnings) process.stderr.write(`Warning: ${terminalText(warning)}\n`);
    if (notStarted !== undefined)
      process.stderr.write(
        `Warning: The Objective was not started: ${terminalText(notStarted).replace(/\.?$/u, ".")} Once that is fixed, run this command again with ID ${terminalText(objective.id)} to start it.\n`,
      );
    if (json) {
      if (dryRun)
        process.stderr.write(
          `Dry run: Objective ${terminalText(objective.id)} was checked but not created.\n`,
        );
      else if (positionals[0] === undefined)
        process.stderr.write(`Created Objective ${terminalText(objective.id)}.\n`);
      if (started !== undefined)
        process.stderr.write(
          `Started owner ${terminalText(values.owner ?? "")} with Task ${terminalText(started.taskId)}.\n`,
        );
      return `${JSON.stringify(objective, null, 2)}\n`;
    }
    const lines = [
      dryRun
        ? `objective/${terminalText(objective.id)} checked; nothing was created (dry run)`
        : `objective/${terminalText(objective.id)} created`,
    ];
    if (started !== undefined)
      lines.push(
        `Started ${terminalText(values.owner ?? "")} with Task ${terminalText(started.taskId)}.`,
      );
    if (!dryRun)
      lines.push(
        `Follow it: supertag watch objective ${terminalText(objective.id)}`,
        `See results: supertag describe objective ${terminalText(objective.id)}`,
      );
    return `${lines.join("\n")}\n`;
  } else if (command === "list") {
    const query = new URLSearchParams();
    if (values.owner !== undefined) {
      const tag = await client.getTag(values.owner);
      if (!tag.metadata.id) throw new Error("Tag has no ID");
      query.set("tagId", tag.metadata.id);
    }
    if (values.limit !== undefined) query.set("limit", values.limit);
    result = await client.request(`${base}?${query}`);
  } else if (command === "get") result = await client.request(`${base}/${encodeURIComponent(id)}`);
  else if (command === "status") {
    if (values.summary !== undefined && values["summary-file"] !== undefined)
      throw new Error("--summary and --summary-file cannot be combined");
    const summary =
      values["summary-file"] === undefined
        ? values.summary
        : values["summary-file"] === "-"
          ? await readStdin()
          : await readFile(values["summary-file"], "utf8");
    const change = {
      ...(positionals[1] === undefined ? {} : { status: positionals[1] }),
      ...(summary === undefined ? {} : { completionSummary: summary.trim() }),
      ...(values.deadline === undefined ? {} : { deadline: values.deadline }),
      ...(values["budget-minor"] === undefined
        ? {}
        : { budgetLimitMinor: Number(values["budget-minor"]) }),
      ...(values["runtime-action"] === undefined
        ? {}
        : { runtimeActions: values["runtime-action"] }),
    };
    const path = `${base}/${encodeURIComponent(id)}`;
    const updated = await withCurrentRevision({
      explicit: values.revision,
      resource: `Objective ${id}`,
      read: () => client.request<Record<string, unknown>>(path),
      fields: Object.keys(change),
      write: (expectedRevision) =>
        client.request<Record<string, unknown> & { warnings?: string[] }>(path, {
          method: "PATCH",
          body: JSON.stringify({ ...change, expectedRevision }),
        }),
    });
    const { warnings = [], ...objective } = updated;
    for (const warning of warnings) process.stderr.write(`Warning: ${terminalText(warning)}\n`);
    if (json) return `${JSON.stringify(objective, null, 2)}\n`;
    return formatObjectiveUpdate(id, objective, change);
  } else throw new Error(objectiveHelp());
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** `objective/ID updated: status blocked (revision 3)`, naming each field the command set. */
function formatObjectiveUpdate(
  id: string,
  objective: Record<string, unknown>,
  change: Record<string, unknown>,
): string {
  const revision = typeof objective["revision"] === "number" ? objective["revision"] : "?";
  if (change["status"] === "completed")
    return `objective/${id} completed (revision ${revision}).\n`;
  const parts: string[] = [];
  if (change["status"] !== undefined) parts.push(`status ${String(objective["status"])}`);
  if (change["deadline"] !== undefined) parts.push(`deadline ${String(objective["deadline"])}`);
  if (change["budgetLimitMinor"] !== undefined)
    parts.push(`budget limit ${budgetLimit(objective)}`);
  if (Array.isArray(objective["runtimeActions"]) && change["runtimeActions"] !== undefined)
    parts.push(`runtime actions ${objective["runtimeActions"].join(", ") || "none"}`);
  return `objective/${id} updated${parts.length ? `: ${parts.join(", ")}` : ""} (revision ${revision}).\n`;
}

function budgetLimit(objective: Record<string, unknown>): string {
  const limit = objective["budgetLimitMinor"];
  const currency = objective["budgetCurrency"];
  if (typeof limit !== "number") return "none";
  return typeof currency === "string" ? money(limit, currency) : `${limit} allocation units`;
}

function formatMessageResult(id: string, result: MessageObjectiveResult): string {
  const lines = [
    `${result.duplicate ? "Already sent" : "Sent"} to the conversation of Objective ${terminalText(id)}.`,
  ];
  if (result.statusChange)
    lines.push(
      `The Objective moved from ${result.statusChange.replaceAll("_", " ")} back to working.`,
    );
  return `${lines.join("\n")}\n`;
}

/**
 * Shows the owner's reply to a message, as `message tag` does, when the Objective's conversation
 * is this operator's CLI conversation. Otherwise the reply posts to the Objective's home thread.
 */
async function followObjectiveReply(
  client: ControlPlaneClient,
  target: ControlPlaneTarget,
  id: string,
  taskId: string,
): Promise<string> {
  const objective = await client.request<Objective>(
    `/api/v1/tag-messaging/objectives/${encodeURIComponent(id)}`,
  );
  const tags = await client.request<{
    readonly items: readonly {
      readonly metadata: { readonly id: string; readonly name?: string };
    }[];
  }>("/api/v1/tags");
  const name =
    tags.items.find((tag) => tag.metadata.id === objective.ownerTagId)?.metadata.name ??
    objective.ownerTagId;
  const conversations = tagConversationClient(target);
  let message: Message;
  try {
    message = await conversations.getMessage({ tag: name, taskId });
  } catch (error) {
    if (
      error instanceof ConnectError &&
      (error.code === Code.NotFound || error.code === Code.PermissionDenied)
    )
      return "The reply posts to the thread the Objective was created in.\n";
    return refusedAsError(() => Promise.reject(error));
  }
  const detach = new AbortController();
  const stop = () => detach.abort();
  process.once("SIGINT", stop);
  try {
    return await followTagMessage(conversations, message, {
      signal: detach.signal,
      write: (text) => process.stdout.write(text),
      warn: (text) => process.stderr.write(text),
      interactive: process.stdout.isTTY === true,
    });
  } finally {
    process.removeListener("SIGINT", stop);
  }
}

/** A Team's ID from its name or ID. */
async function teamId(client: ControlPlaneClient, name: string): Promise<string> {
  const team = JSON.parse(await runTeamCommand(client, ["get", name])) as Team;
  return team.id;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
