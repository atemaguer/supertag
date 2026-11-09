import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type DescMessage, type MessageShape, toJsonString } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ListObjectivesResponseSchema,
  type Message,
  MessageObjectiveResponseSchema,
  ObjectiveOverviewSchema,
  ObjectiveSchema,
} from "@supertag/operator-api";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";
import { localCheckouts } from "./delivery-view.js";
import { money } from "./money.js";
import { runObjectiveCancel } from "./objective-cancel.js";
import { formatObjectiveOverview } from "./objective-overview.js";
import { runObjectivePause } from "./objective-pause.js";
import {
  inboxItemRecord,
  OBJECTIVE_STATUS,
  type ObjectiveView,
  objectiveView,
  overviewView,
} from "./objective-protos.js";
import { watchObjective } from "./objective-watch.js";
import { eventClient, inboxClient, objectiveClient } from "./operator-client.js";
import { withCurrentRevision } from "./revision.js";
import { followTagMessage, refusedAsError, tagConversationClient } from "./tag-conversation.js";
import { terminalText } from "./terminal-text.js";
import { workstreamPosts } from "./workstreams.js";

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
  const connection = { url: target.url, token: target.token, warnOnSkew: true };
  const client = objectiveClient(connection);
  if (command === "cancel") return refusedAsError(() => runObjectiveCancel(client, rest));
  if (command === "pause" || command === "resume")
    return refusedAsError(() => runObjectivePause(client, command, rest));
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
  const id = positionals[0] ?? "";
  if (command === "watch") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    try {
      const checkouts = json ? undefined : await localCheckouts(target.url);
      await refusedAsError(() =>
        watchObjective(
          {
            objectives: client,
            inbox: inboxClient(connection),
            posts: workstreamPosts(new ControlPlaneClient(target)),
            events: eventClient(connection),
          },
          id,
          {
            output: json ? "json" : "text",
            signal: controller.signal,
            write: (text) => process.stdout.write(text),
            warn: (text) => process.stderr.write(text),
            ...(checkouts === undefined ? {} : { checkouts }),
          },
        ),
      );
    } finally {
      process.removeListener("SIGINT", stop);
    }
    return "";
  }
  if (command === "get" && values.overview) {
    const overview = await refusedAsError(() => client.describeObjective({ id }));
    if (json) return jsonOf(ObjectiveOverviewSchema, overview);
    const [inbox, checkouts] = await Promise.all([
      inboxClient(connection)
        .listInboxItems({ objectiveId: id, pageSize: 100 })
        .then((page) => {
          const asOf = page.asOf === undefined ? new Date() : timestampDate(page.asOf);
          return page.items.map((item) => inboxItemRecord(item, asOf));
        })
        .catch(() => undefined),
      localCheckouts(target.url),
    ]);
    return formatObjectiveOverview(overviewView(overview), {
      ...(inbox === undefined ? {} : { inbox }),
      ...(checkouts === undefined ? {} : { checkouts }),
    });
  }
  if (command === "message") {
    const text = positionals[1] === "-" ? await readStdin() : (positionals[1] ?? "");
    if (!text.trim()) throw new Error("The message is empty");
    const result = await refusedAsError(() =>
      client.messageObjective({ id, text: text.trim(), idempotencyKey: randomUUID() }),
    );
    if (json) return jsonOf(MessageObjectiveResponseSchema, result);
    process.stdout.write(
      formatMessageResult(id, result.duplicate, OBJECTIVE_STATUS.word(result.statusChange)),
    );
    return followObjectiveReply(target, result.tag, result.taskId);
  }
  if (command === "approve") {
    const objective = await refusedAsError(() => client.approveObjective({ id }));
    return json
      ? jsonOf(ObjectiveSchema, objective)
      : `objective/${terminalText(objective.id)} approved; it is completed (revision ${objective.revision}).\n`;
  }
  if (command === "create") {
    if (!values.outcome || !values.owner) throw new Error(objectiveHelp());
    const dryRun = values["dry-run"] === true;
    if (values["budget-currency"] !== undefined && values["budget-minor"] === undefined)
      throw new Error("budgetCurrency requires budgetLimitMinor");
    const request = {
      // Omitted IDs are generated by the Control Plane from the outcome.
      id: positionals[0] ?? "",
      ongoing: values.ongoing ?? false,
      outcome: values.outcome,
      owner: values.owner,
      team: values.team ?? "",
      ...(values.deadline === undefined ? {} : { deadline: deadlineOf(values.deadline) }),
      ...(values["budget-minor"] === undefined
        ? {}
        : {
            budget: {
              limitMinor: minorOf(values["budget-minor"]),
              currency: values["budget-currency"] ?? "",
            },
          }),
      runtimeActions: values["runtime-action"] ?? [],
      workspaces: values.workspace ?? [],
      dryRun,
    };
    const created = await refusedAsError(() => client.createObjective(request));
    const objective = created.objective;
    if (objective === undefined) throw new Error("The Control Plane returned no Objective");
    for (const warning of created.warnings)
      process.stderr.write(`Warning: ${terminalText(warning)}\n`);
    if (created.notStarted !== "")
      process.stderr.write(
        `Warning: The Objective was not started: ${terminalText(created.notStarted).replace(/\.?$/u, ".")} Once that is fixed, run this command again with ID ${terminalText(objective.id)} to start it.\n`,
      );
    if (json) {
      if (dryRun)
        process.stderr.write(
          `Dry run: Objective ${terminalText(objective.id)} was checked but not created.\n`,
        );
      else if (positionals[0] === undefined)
        process.stderr.write(`Created Objective ${terminalText(objective.id)}.\n`);
      if (created.startedTaskId !== "")
        process.stderr.write(
          `Started owner ${terminalText(values.owner ?? "")} with Task ${terminalText(created.startedTaskId)}.\n`,
        );
      return jsonOf(ObjectiveSchema, objective);
    }
    const lines = [
      dryRun
        ? `objective/${terminalText(objective.id)} checked; nothing was created (dry run)`
        : `objective/${terminalText(objective.id)} created`,
    ];
    if (created.startedTaskId !== "")
      lines.push(
        `Started ${terminalText(values.owner ?? "")} with Task ${terminalText(created.startedTaskId)}.`,
      );
    if (!dryRun)
      lines.push(
        `Follow it: supertag watch objective ${terminalText(objective.id)}`,
        `See results: supertag describe objective ${terminalText(objective.id)}`,
      );
    return `${lines.join("\n")}\n`;
  }
  if (command === "list") {
    if (values.limit !== undefined && !/^\d+$/u.test(values.limit))
      throw new Error("--limit must be an integer");
    const listed = await refusedAsError(() =>
      client.listObjectives({
        owner: values.owner ?? "",
        pageSize: values.limit === undefined ? 0 : Number(values.limit),
      }),
    );
    return jsonOf(ListObjectivesResponseSchema, listed);
  }
  if (command === "get")
    return jsonOf(ObjectiveSchema, await refusedAsError(() => client.getObjective({ id })));
  if (command === "status") {
    if (values.summary !== undefined && values["summary-file"] !== undefined)
      throw new Error("--summary and --summary-file cannot be combined");
    const summary =
      values["summary-file"] === undefined
        ? values.summary
        : values["summary-file"] === "-"
          ? await readStdin()
          : await readFile(values["summary-file"], "utf8");
    const status = positionals[1];
    if (status !== undefined && !OBJECTIVE_STATUS.words.includes(status as never))
      throw new Error(
        "A valid status, budgetLimitMinor, deadline, or runtimeActions and a positive expectedRevision are required",
      );
    const change = {
      ...(status === undefined ? {} : { status }),
      ...(summary === undefined ? {} : { completionSummary: summary.trim() }),
      ...(values.deadline === undefined ? {} : { deadline: values.deadline }),
      ...(values["budget-minor"] === undefined
        ? {}
        : { budgetLimitMinor: Number(values["budget-minor"]) }),
      ...(values["runtime-action"] === undefined
        ? {}
        : { runtimeActions: values["runtime-action"] }),
    };
    const updated = await refusedAsError(() =>
      withCurrentRevision({
        explicit: values.revision,
        resource: `Objective ${id}`,
        read: async () =>
          objectiveView(await client.getObjective({ id })) as unknown as Record<string, unknown>,
        fields: Object.keys(change),
        write: (expectedRevision) =>
          client.updateObjective({
            id,
            expectedRevision: BigInt(expectedRevision),
            ...(status === undefined ? {} : { status: OBJECTIVE_STATUS.value(status) }),
            ...(summary === undefined ? {} : { completionSummary: summary.trim() }),
            ...(values.deadline === undefined ? {} : { deadline: deadlineOf(values.deadline) }),
            ...(values["budget-minor"] === undefined
              ? {}
              : { budgetLimitMinor: minorOf(values["budget-minor"]) }),
            ...(values["runtime-action"] === undefined
              ? {}
              : { runtimeActions: { actions: values["runtime-action"] } }),
          }),
      }),
    );
    for (const warning of updated.warnings)
      process.stderr.write(`Warning: ${terminalText(warning)}\n`);
    if (updated.objective === undefined) throw new Error("The Control Plane returned no Objective");
    if (json) return jsonOf(ObjectiveSchema, updated.objective);
    return formatObjectiveUpdate(id, objectiveView(updated.objective), change);
  }
  throw new Error(objectiveHelp());
}

/** A message as `--output json` prints it: its proto JSON, indented. */
function jsonOf<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): string {
  return `${toJsonString(schema, message, { prettySpaces: 2 })}\n`;
}

function deadlineOf(value: string) {
  const deadline = new Date(value);
  if (Number.isNaN(deadline.getTime())) throw new Error("deadline must be an ISO timestamp");
  return timestampFromDate(deadline);
}

function minorOf(value: string): bigint {
  if (!/^\d+$/u.test(value)) throw new Error("budgetLimitMinor must be a nonnegative integer");
  return BigInt(value);
}

/** `objective/ID updated: status blocked (revision 3)`, naming each field the command set. */
function formatObjectiveUpdate(
  id: string,
  objective: ObjectiveView,
  change: Record<string, unknown>,
): string {
  const revision = objective.revision;
  if (change["status"] === "completed")
    return `objective/${id} completed (revision ${revision}).\n`;
  const parts: string[] = [];
  if (change["status"] !== undefined) parts.push(`status ${objective.status}`);
  if (change["deadline"] !== undefined) parts.push(`deadline ${String(objective.deadline)}`);
  if (change["budgetLimitMinor"] !== undefined)
    parts.push(`budget limit ${budgetLimit(objective)}`);
  if (change["runtimeActions"] !== undefined)
    parts.push(`runtime actions ${objective.runtimeActions.join(", ") || "none"}`);
  return `objective/${id} updated${parts.length ? `: ${parts.join(", ")}` : ""} (revision ${revision}).\n`;
}

function budgetLimit(objective: ObjectiveView): string {
  const limit = objective.budgetLimitMinor;
  const currency = objective.budgetCurrency;
  if (limit === null) return "none";
  return currency !== null ? money(limit, currency) : `${limit} allocation units`;
}

function formatMessageResult(
  id: string,
  duplicate: boolean,
  statusChange: string | undefined,
): string {
  const lines = [
    `${duplicate ? "Already sent" : "Sent"} to the conversation of Objective ${terminalText(id)}.`,
  ];
  if (statusChange)
    lines.push(`The Objective moved from ${statusChange.replaceAll("_", " ")} back to working.`);
  return `${lines.join("\n")}\n`;
}

/**
 * Shows the owner's reply to a message, as `message tag` does, when the Objective's conversation
 * is this operator's CLI conversation. Otherwise the reply posts to the Objective's home thread.
 */
async function followObjectiveReply(
  target: ControlPlaneTarget,
  tag: string,
  taskId: string,
): Promise<string> {
  const conversations = tagConversationClient(target);
  let message: Message;
  try {
    message = await conversations.getMessage({ tag, taskId });
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
