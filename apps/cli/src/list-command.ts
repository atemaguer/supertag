import { parseArgs } from "node:util";
import { fromJsonString } from "@bufbuild/protobuf";
import {
  ListApprovalsResponseSchema,
  ListArtifactsResponseSchema,
  ListMailboxGrantsResponseSchema,
  ListObjectivesResponseSchema,
  ListTagMessagesResponseSchema,
  ListTeamsResponseSchema,
  ListWorkstreamPostsResponseSchema,
  TagMessageStatus,
} from "@supertag/operator-api";
import { stringify as stringifyYaml } from "yaml";
import { runApprovalCommand, runInboxCommand } from "./approvals.js";
import { runArtifactCommand } from "./artifacts.js";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";
import { runTagMessagingCommand } from "./messaging.js";
import { money } from "./money.js";
import {
  approvalRecord,
  enumTable,
  isoOf,
  type ObjectiveView,
  objectiveView,
} from "./objective-protos.js";
import { runObjectiveCommand } from "./objectives.js";
import { refusedAsError, workClient } from "./operator-client.js";
import {
  isOperatorResourcePath,
  listOperatorResources,
  listResourceViews,
} from "./operator-resources.js";
import { isResourcePath } from "./resource-protos.js";
import { runTeamCommand } from "./teams.js";
import { terminalText } from "./terminal-text.js";
import { artifactRow, sessionView, taskView } from "./work-protos.js";
import { allSessions, recentTasks, workSessionsJson, workTasksJson } from "./work-reads.js";
import { workerHarnessNames } from "./worker-harness-names.js";
import { listWorkstreamPosts } from "./workstreams.js";

const paths: Record<string, string> = {
  tag: "tags",
  role: "roles",
  "permission-set": "permission-sets",
  "context-set": "context-sets",
  volume: "volumes",
  workspace: "workspaces",
  surface: "surface-accounts",
  "worker-host": "worker-hosts",
  "worker-profile": "worker-profiles",
  "auth-key": "auth-keys",
  "operator-token": "operator-tokens",
};
const kinds = new Set([
  ...Object.keys(paths),
  "task",
  "session",
  "objective",
  "team",
  "workstream-post",
  "message",
  "mailbox-grant",
  "inbox",
  "approval",
  "artifact",
]);

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const items = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  const object = record(value);
  for (const key of [
    "items",
    "objectives",
    "teams",
    "requests",
    "messages",
    "grants",
    "posts",
    "artifacts",
  ])
    if (Array.isArray(object[key])) return object[key] as unknown[];
  return [];
};
const field = (row: Row, key: string): unknown =>
  key.split(".").reduce<unknown>((value, segment) => record(value)[segment], row);
const display = (value: unknown): string =>
  value === undefined || value === null
    ? "-"
    : Array.isArray(value)
      ? value.map(display).join(", ") || "-"
      : typeof value === "object"
        ? JSON.stringify(value)
        : terminalText(String(value));

const columns: Record<string, readonly [string, string][]> = {
  tag: [
    ["NAME", "metadata.name"],
    ["ROLES", "spec.roles"],
    ["HARNESS / MODEL", "status.execution"],
    ["WORKER HOSTS", "spec.workerHosts"],
    ["TASK", "status.busyTask"],
  ],
  "worker-host": [
    ["NAME", "metadata.name"],
    ["CONNECTION", "status.connectionStatus"],
    ["HARNESSES", "status.workers"],
    ["RUNNING / CAPACITY", "status.runningTaskAttempts"],
  ],
  task: [
    ["ID", "metadata.id"],
    ["STATUS", "status.phase"],
    ["TAG", "spec.tagId"],
    ["OBJECTIVE", "spec.objectiveId"],
  ],
  session: [
    ["ID", "metadata.id"],
    ["TAG", "status.tag"],
    ["TITLE", "status.title"],
    ["PARENT", "spec.parentSessionId"],
    ["STATUS", "status.latestTaskStatus"],
    ["LAST INTERACTION", "status.lastInteractionAt"],
  ],
  objective: [
    ["ID", "id"],
    ["STATUS", "status"],
    ["OWNER", "ownerTagId"],
    ["SPEND / BUDGET", "limitState.reportedSpend.amountMinor"],
    ["DEADLINE", "deadline"],
  ],
  team: [
    ["NAME", "name"],
    ["MEMBERS", "memberTagIds"],
    ["MAX CONCURRENCY", "maxConcurrency"],
  ],
  role: [
    ["NAME", "metadata.name"],
    ["PURPOSE", "spec.purpose"],
    ["TAGS", "status.assignedTags"],
  ],
  "permission-set": [
    ["NAME", "metadata.name"],
    ["BINDINGS", "status.bindings"],
    ["STATE", "status.phase"],
  ],
  "context-set": [
    ["NAME", "metadata.name"],
    ["ITEMS", "spec.items"],
    ["BINDINGS", "status.bindings"],
  ],
  volume: [
    ["NAME", "metadata.name"],
    ["SOURCE", "spec.source"],
    ["CREDENTIAL", "spec.credential"],
  ],
  workspace: [
    ["NAME", "metadata.name"],
    ["SOURCE", "spec.source"],
    ["DELIVERY", "spec.delivery"],
    ["WORKER HOSTS", "status.workerHosts"],
  ],
  surface: [
    ["NAME", "metadata.name"],
    ["PROVIDER", "spec.provider"],
    ["STATE", "status.phase"],
  ],
  "worker-profile": [
    ["NAME", "metadata.name"],
    ["HARNESS", "spec.harness"],
    ["MODEL", "spec.model"],
  ],
  "auth-key": [
    ["NAME", "metadata.name"],
    ["STATE", "status.phase"],
    ["EXPIRES", "spec.expiresAt"],
  ],
  "operator-token": [
    ["NAME", "metadata.name"],
    ["STATE", "status.phase"],
    ["CREATED", "metadata.createdAt"],
  ],
  approval: [
    ["ID", "id"],
    ["STATUS", "status"],
    ["KIND", "kind"],
    ["TASK", "taskId"],
    ["SUMMARY", "summary"],
  ],
  artifact: [
    ["ID", "metadata.id"],
    ["TASK", "spec.taskId"],
    ["CREATED", "metadata.createdAt"],
    ["FILES", "spec.entries"],
    ["LOCATIONS", "status.locations"],
  ],
  message: [
    ["ID", "id"],
    ["FROM", "senderTagId"],
    ["TO", "recipientTagId"],
    ["STATUS", "status"],
    ["TIME", "createdAt"],
    ["MESSAGE", "text"],
  ],
  "mailbox-grant": [
    ["SENDER", "senderTagId"],
    ["RECIPIENT", "recipientTagId"],
  ],
  "workstream-post": [
    ["SEQUENCE", "sequence"],
    ["AUTHOR", "authorTagId"],
    ["TO", "to"],
    ["TIME", "createdAt"],
    ["MESSAGE", "body"],
  ],
};

/** Fields of each kind that hold Tag IDs, shown as names in text tables. */
const TAG_FIELDS: Readonly<Record<string, readonly string[]>> = {
  objective: ["ownerTagId"],
};

const MESSAGE_STATUS = enumTable(
  [
    ["pending", TagMessageStatus.PENDING],
    ["handled", TagMessageStatus.HANDLED],
    ["failed", TagMessageStatus.FAILED],
  ] as const,
  TagMessageStatus.UNSPECIFIED,
);

/**
 * The rows a text table shows for the kinds whose JSON is an operator RPC's response, with Tag
 * IDs shown as the names the response carries.
 */
function rpcRows(kind: string, response: string): Row[] | undefined {
  const named = (names: Readonly<Record<string, string>>) => (id: string) => names[id] ?? id;
  if (kind === "team")
    return fromJsonString(ListTeamsResponseSchema, response).teams.map((team) => ({
      name: team.name,
      memberTagIds: team.members.map((member) => member.tag || member.tagId),
      maxConcurrency: team.maxConcurrency,
    }));
  if (kind === "message") {
    const page = fromJsonString(ListTagMessagesResponseSchema, response);
    const name = named(page.tagNames);
    return page.messages.map((message) => ({
      id: message.id,
      senderTagId: name(message.senderTagId),
      recipientTagId: name(message.recipientTagId),
      status: MESSAGE_STATUS.word(message.status),
      createdAt: isoOf(message.createdAt),
      text: message.text,
    }));
  }
  if (kind === "mailbox-grant") {
    const page = fromJsonString(ListMailboxGrantsResponseSchema, response);
    const name = named(page.tagNames);
    return page.grants.map((grant) => ({
      senderTagId: name(grant.senderTagId),
      recipientTagId: name(grant.recipientTagId),
    }));
  }
  if (kind === "workstream-post") {
    const page = fromJsonString(ListWorkstreamPostsResponseSchema, response);
    const name = named(page.tagNames);
    return page.posts.map((post) => ({
      sequence: Number(post.sequence),
      authorTagId: name(post.authorTagId),
      to: post.toTagIds.map(name),
      createdAt: isoOf(post.createdAt),
      body: post.body,
    }));
  }
  if (kind === "artifact")
    return fromJsonString(ListArtifactsResponseSchema, response).artifacts.map(artifactRow);
  return undefined;
}

/** An Objective as a table row names its fields. */
function objectiveRow(objective: ObjectiveView): Row {
  return {
    id: objective.id,
    status: objective.status,
    ownerTagId: objective.ownerTagId,
    deadline: objective.deadline,
    budgetLimitMinor: objective.budgetLimitMinor,
    budgetCurrency: objective.budgetCurrency,
    ...(objective.reportedSpendMinor === null
      ? {}
      : { limitState: { reportedSpend: { amountMinor: objective.reportedSpendMinor } } }),
  };
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function renderListTable(kind: string, value: unknown): string {
  const rows = items(value).map(record);
  const selected = columns[kind] ?? [
    ["NAME / ID", "metadata.name"],
    ["STATUS", "status.phase"],
    ["DETAIL", "spec"],
  ];
  const headings = selected.map(([heading]) => heading);
  const cells = rows.map((row) =>
    selected
      .map(([, key], index) => {
        const raw = field(row, key);
        if (index === 0 && raw === undefined)
          return display(row["id"] ?? record(row["metadata"])["id"] ?? row["name"]);
        if (kind === "objective" && key === "limitState.reportedSpend.amountMinor") {
          // Without a currency the budget counts allocation units, never money.
          const currency =
            typeof row["budgetCurrency"] === "string" ? row["budgetCurrency"] : undefined;
          const amount = (minor: number) =>
            currency === undefined ? `${minor} units` : money(minor, currency);
          const spent = typeof raw === "number" ? amount(raw) : "-";
          const limit = row["budgetLimitMinor"];
          return typeof limit === "number" ? `${spent} / ${amount(limit)}` : spent;
        }
        if (kind === "message" && key === "text") return firstLine(display(raw));
        if (kind === "workstream-post" && key === "body") return firstLine(display(raw));
        if (kind === "tag" && key === "status.execution") {
          const execution = record(raw);
          return display([execution["harness"], execution["model"]].filter(Boolean));
        }
        if (kind === "artifact" && key === "spec.entries")
          return Array.isArray(raw) ? String(raw.length) : "-";
        if (kind === "artifact" && key === "status.locations") {
          const places = (Array.isArray(raw) ? raw : []).map((entry) => {
            const location = record(entry);
            if (location["kind"] === "volume") return `Volume ${display(location["volume"])}`;
            const notes = [
              location["removed"] ? "removed" : "",
              location["ephemeral"] ? "ephemeral" : "",
            ];
            const note = notes.filter(Boolean).join(", ");
            return `${display(location["workerHostId"])}${note ? ` (${note})` : ""}`;
          });
          const text = places.length ? places.join(", ") : "no recorded copy";
          return field(row, "status.ephemeralOnly") === true ? `${text}; ephemeral only` : text;
        }
        if (kind === "worker-host" && key === "status.workers")
          return display(
            Array.isArray(raw) ? raw.flatMap((worker) => workerHarnessNames(record(worker))) : raw,
          );
        return display(raw);
      })
      .map(terminalText),
  );
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );
  const line = (row: readonly string[]) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ");
  return `${[line(headings), ...cells.map(line)].join("\n")}\n`;
}

export async function runListCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
): Promise<string> {
  const [kind, ...rest] = args;
  if (!kind) throw new Error("Usage: supertag list KIND [--output text|json|yaml]");
  if (!kinds.has(kind)) {
    const singular = kind.endsWith("s") ? kind.slice(0, -1) : "";
    if (kinds.has(singular))
      throw new Error(`Unknown list kind ${kind}; did you mean \`list ${singular}\`?`);
    throw new Error(`Unknown list kind: ${kind}`);
  }
  const outputIndex = rest.findIndex((arg) => arg === "--output" || arg.startsWith("--output="));
  const output =
    outputIndex < 0
      ? "text"
      : rest[outputIndex]?.includes("=")
        ? rest[outputIndex]?.split("=")[1]
        : rest[outputIndex + 1];
  if (output !== "text" && output !== "json" && output !== "yaml")
    throw new Error("--output must be text, json, or yaml");
  const options = rest.filter(
    (_, index) =>
      index !== outputIndex &&
      (outputIndex < 0 || rest[outputIndex]?.includes("=") || index !== outputIndex + 1),
  );
  const client = new ControlPlaneClient(target);
  let value: unknown;
  if (kind === "task" || kind === "session") {
    if (options.length) throw new Error(`Usage: supertag list ${kind} [--output text|json|yaml]`);
    const work = workClient(client.operator);
    if (kind === "task") {
      const tasks = await refusedAsError(() => recentTasks(work));
      value = output === "text" ? { items: tasks.map(taskView) } : workTasksJson(tasks);
    } else {
      const sessions = await refusedAsError(() => allSessions(work));
      value = output === "text" ? { items: sessions.map(sessionView) } : workSessionsJson(sessions);
    }
  } else if (kind in paths) {
    if (options.length) throw new Error(`Usage: supertag list ${kind} [--output text|json|yaml]`);
    const path = paths[kind] ?? "";
    value = isOperatorResourcePath(path)
      ? await listOperatorResources(client.operator, path)
      : isResourcePath(path)
        ? await listResourceViews(client.operator, path)
        : undefined;
  } else {
    let response: string;
    if (kind === "objective") {
      const parsed = parseArgs({
        args: options,
        options: { owner: { type: "string" }, limit: { type: "string" } },
        strict: true,
      });
      response = await runObjectiveCommand(target, [
        "list",
        ...(parsed.values.owner ? ["--owner", parsed.values.owner] : []),
        ...(parsed.values.limit ? ["--limit", parsed.values.limit] : []),
      ]);
    } else if (kind === "team") response = await runTeamCommand(client, ["list", ...options]);
    else if (kind === "approval")
      response = await runApprovalCommand(target, ["list", ...options, "--output", "json"]);
    else if (kind === "inbox") {
      // Inbox items carry a question, a decision maker, and an action; a table would drop them.
      if (output === "text")
        return runInboxCommand(target, "list", [...options, "--output", "text"]);
      response = await runInboxCommand(target, "list", [...options, "--output", "json"]);
    } else if (kind === "artifact") response = await runArtifactCommand(client, "list", options);
    else if (kind === "workstream-post")
      response = JSON.stringify(await listWorkstreamPosts(client, options));
    else {
      const { values } = parseArgs({
        args: options,
        options: { mailbox: { type: "string" }, limit: { type: "string" } },
        strict: true,
      });
      response = await runTagMessagingCommand(target, [
        kind === "message" ? "messages" : "grants",
        values.mailbox ?? "",
        ...(values.limit ? ["--limit", values.limit] : []),
      ]);
    }
    value = JSON.parse(response);
    // Text tables show the CLI's records; JSON and YAML keep the operator API's messages.
    if (output === "text" && kind === "objective")
      value = {
        items: fromJsonString(ListObjectivesResponseSchema, response).objectives.map((objective) =>
          objectiveRow(objectiveView(objective)),
        ),
      };
    if (output === "text" && kind === "approval")
      value = {
        items: fromJsonString(ListApprovalsResponseSchema, response).approvals.map(approvalRecord),
      };
    const rows = output === "text" ? rpcRows(kind, response) : undefined;
    if (rows !== undefined) value = { items: rows };
  }
  const tagFields = TAG_FIELDS[kind];
  if (output === "text" && tagFields !== undefined) {
    // Text tables name Tags; JSON and YAML keep the IDs the API returns.
    const names = new Map(
      items(await client.listTags())
        .map(record)
        .map((tag) => [field(tag, "metadata.id"), field(tag, "metadata.name")]),
    );
    const name = (id: unknown) => names.get(id) ?? id;
    value = {
      items: items(value).map((item) => {
        const row = record(item);
        return {
          ...row,
          ...Object.fromEntries(
            tagFields.map((key) => [
              key,
              Array.isArray(row[key]) ? row[key].map(name) : name(row[key]),
            ]),
          ),
        };
      }),
    };
  }
  if (output === "text" && (kind === "tag" || kind === "worker-host")) {
    const tasks = (await refusedAsError(() => recentTasks(workClient(client.operator)))).map(
      taskView,
    );
    const running = tasks
      .map(record)
      .filter((task) => field(task, "status.attempt.phase") === "running");
    value = {
      items: items(value).map((item) => {
        const row = record(item);
        const status = record(row["status"]);
        if (kind === "tag") {
          const task = running.find(
            (candidate) => field(candidate, "spec.tagId") === field(row, "metadata.id"),
          );
          return {
            ...row,
            status: {
              ...status,
              busyTask: task ? field(task, "metadata.id") : "idle",
            },
          };
        }
        const workers = Array.isArray(status["workers"]) ? status["workers"].map(record) : [];
        const hostId = field(row, "metadata.id");
        const capacity = new Map<string, number>();
        const usage = new Map<string, number>();
        for (const worker of workers) {
          const harness = workerHarnessNames(worker).join(", ");
          capacity.set(
            harness,
            (capacity.get(harness) ?? 0) +
              (typeof worker["maxConcurrency"] === "number" ? worker["maxConcurrency"] : 1),
          );
          const active = running.filter(
            (task) =>
              field(task, "status.attempt.workerHostId") === hostId &&
              field(task, "status.attempt.workerId") === worker["id"],
          );
          usage.set(harness, (usage.get(harness) ?? 0) + active.length);
        }
        const summary = [...capacity]
          .map(([harness, slots]) => `${harness} ${usage.get(harness) ?? 0}/${slots}`)
          .join(", ");
        return {
          ...row,
          status: { ...status, runningTaskAttempts: summary || "0/0" },
        };
      }),
    };
  }
  return output === "json"
    ? `${JSON.stringify(value, null, 2)}\n`
    : output === "yaml"
      ? stringifyYaml(value)
      : renderListTable(kind, value);
}
