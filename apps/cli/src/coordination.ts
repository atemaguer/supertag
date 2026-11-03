import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  COORDINATION_INBOX_MESSAGE_LIMIT,
  type CoordinationInboxItem,
  type CoordinationInboxPage,
  coordinationInboxHeadline,
  coordinationInboxOccurrence,
  shellWord,
} from "@supertag/core";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";
import { operatorNotice } from "./operator-notice.js";
import { terminalText } from "./terminal-text.js";
export function coordinationHelp(): string {
  return `Usage:
  supertag coordinate inbox [--objective ID] [--team ID] [--kind KIND] [--next-actor ID] [--cursor CURSOR] [--limit N] [--output json|text]
  supertag coordinate COMMAND --input FILE

Commands: start_objective, read_objective, read_team, read_task, assign_task, update_task,
read_mailbox, send_message, read_workstream, post_workstream, wait_for, update_objective,
create_team, update_team, create_tag, request_approval, decide_approval.
FILE contains a JSON object with objectiveId and the command arguments.
Task and Team updates require the current status or revision. Credentials use saved Control Plane configuration.
`;
}
export async function runCoordinateCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
  options: { readonly operatorList?: boolean } = {},
): Promise<string> {
  const [command, ...rest] = args;
  if (command === "inbox") return runCoordinationInboxCommand(target, rest, options);
  const { values, positionals } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: true,
    options: { input: { type: "string" } },
  });
  if (!command || !/^[a-z_]+$/u.test(command) || !values.input || positionals.length)
    throw new Error(coordinationHelp());
  const input: unknown = JSON.parse(await readFile(values.input, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Input file must contain a JSON object");
  return `${JSON.stringify(await new ControlPlaneClient(target).request(`/api/v1/coordination/${command}`, { method: "POST", body: JSON.stringify(input) }), null, 2)}\n`;
}

async function runCoordinationInboxCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
  options: { readonly operatorList?: boolean },
): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      objective: { type: "string" },
      team: { type: "string" },
      kind: { type: "string" },
      status: { type: "string", default: "pending" },
      "next-actor": { type: "string" },
      "as-of": { type: "string" },
      cursor: { type: "string" },
      limit: { type: "string" },
      output: { type: "string" },
      watch: { type: "boolean" },
      ...(options.operatorList ? { all: { type: "boolean" as const } } : {}),
    },
  });
  if (positionals.length > 0) throw new Error(coordinationHelp());
  const output = values.output ?? (values.watch ? "text" : "json");
  if (output !== "json" && output !== "text") throw new Error("--output must be json or text");
  if (values.watch) {
    if (values.cursor !== undefined || values.limit !== undefined || values["as-of"] !== undefined)
      throw new Error("watch inbox does not accept --cursor, --limit, or --as-of");
    const query = new URLSearchParams();
    for (const [name, value] of [
      ["objectiveId", values.objective],
      ["teamId", values.team],
      ["kind", values.kind],
      ["status", values.status],
      ["nextActorId", values["next-actor"]],
    ] as const)
      if (value !== undefined) query.set(name, value);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    try {
      await watchCoordinationInbox(new ControlPlaneClient(target), query, {
        output,
        signal: controller.signal,
        write: (text) => process.stdout.write(text),
        warn: (text) => process.stderr.write(text),
      });
    } finally {
      process.removeListener("SIGINT", stop);
    }
    return "";
  }
  const query = new URLSearchParams();
  for (const [name, value] of [
    ["objectiveId", values.objective],
    ["teamId", values.team],
    ["kind", values.kind],
    ["status", values.status],
    ["nextActorId", values["next-actor"]],
    ["asOf", values["as-of"]],
    ["cursor", values.cursor],
  ] as const) {
    if (value !== undefined) query.set(name, value);
  }
  if (values.limit !== undefined) {
    if (!/^\d+$/u.test(values.limit)) throw new Error("Inbox limit must be an integer");
    query.set("limit", values.limit);
  }
  const suffix = query.size > 0 ? `?${query}` : "";
  const client = new ControlPlaneClient(target);
  let result = await client.request<CoordinationInboxPage>(`/api/v1/coordination/inbox${suffix}`, {
    method: "GET",
  });
  if (options.operatorList && !values.all) {
    const items = [...result.items];
    const tagNames = { ...result.tagNames };
    const truncatedKinds = new Set(result.truncatedKinds);
    let cursor = result.nextCursor;
    while (cursor) {
      const nextQuery = new URLSearchParams(query);
      nextQuery.set("cursor", cursor);
      const next = await client.request<CoordinationInboxPage>(
        `/api/v1/coordination/inbox?${nextQuery}`,
        { method: "GET" },
      );
      items.push(...next.items);
      Object.assign(tagNames, next.tagNames);
      for (const kind of next.truncatedKinds) truncatedKinds.add(kind);
      cursor = next.nextCursor;
    }
    result = {
      projectionVersion: result.projectionVersion,
      asOf: result.asOf,
      items: items.filter(operatorDecidesInboxItem),
      tagNames,
      truncatedKinds: [...truncatedKinds],
    };
  }
  return output === "text"
    ? formatCoordinationInbox(result)
    : `${JSON.stringify(result, null, 2)}\n`;
}

const WATCH_PAGE_LIMIT = 20;

export interface CoordinationInboxWatchOptions {
  readonly output: "json" | "text";
  readonly signal: AbortSignal;
  readonly write: (text: string) => void;
  readonly warn?: (text: string) => void;
  readonly intervalMs?: number;
}

/**
 * Prints each pending inbox item once, as it appears, until the signal aborts. The first poll
 * prints everything already pending. An item that leaves the inbox and returns prints again.
 */
export async function watchCoordinationInbox(
  client: Pick<ControlPlaneClient, "request">,
  query: URLSearchParams,
  options: CoordinationInboxWatchOptions,
): Promise<void> {
  let seen = new Set<string>();
  while (!options.signal.aborted) {
    try {
      const items: CoordinationInboxItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < WATCH_PAGE_LIMIT; page += 1) {
        const pageQuery = new URLSearchParams(query);
        pageQuery.set("limit", "100");
        if (cursor) pageQuery.set("cursor", cursor);
        const result = await client.request<CoordinationInboxPage>(
          `/api/v1/coordination/inbox?${pageQuery}`,
          { method: "GET" },
        );
        items.push(...result.items);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      if (options.signal.aborted) break;
      const current = new Set<string>();
      for (const item of items) {
        const occurrence = coordinationInboxOccurrence(item);
        current.add(occurrence);
        if (seen.has(occurrence)) continue;
        options.write(
          options.output === "json"
            ? `${JSON.stringify(item)}\n`
            : `${formatCoordinationInboxLine(item)}\n`,
        );
      }
      seen = current;
    } catch (error) {
      options.warn?.(
        `Inbox poll failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) return resolve();
      const timer = setTimeout(done, options.intervalMs ?? 1_000);
      function done() {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", done);
        resolve();
      }
      options.signal.addEventListener("abort", done, { once: true });
    });
  }
}

/** One line per inbox item: when, what, where, and the command to act. */
export function formatCoordinationInboxLine(item: CoordinationInboxItem): string {
  const command = item.commands?.[0];
  const message = item.message
    ? `: ${quoteLine(operatorNotice(item.message.text), COORDINATION_INBOX_MESSAGE_LIMIT)}`
    : "";
  return safeText(
    `${item.actionableSince}  ${item.kind}  Objective ${item.objectiveId}  ${coordinationInboxHeadline(item)}${message}${command ? `  -> ${command}` : ""}`,
  );
}

/** Message text on one line, in quotes, cut to `limit` characters. */
function quoteLine(text: string, limit: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return `"${line.length > limit ? `${line.slice(0, limit - 1)}…` : line}"`;
}

function safeText(text: string): string {
  return terminalText(text);
}

/** Whether the operator, rather than a Tag, decides this inbox item. */
export function operatorDecidesInboxItem(item: CoordinationInboxItem): boolean {
  return (
    item.operatorEligible && (item.kind !== "task_review" || item.nextActorTagIds.length === 0)
  );
}

function formatCoordinationInbox(page: CoordinationInboxPage): string {
  const lines = [`Operator inbox (${page.items.length} items; as of ${page.asOf})`];
  for (const item of page.items) {
    lines.push(
      "",
      `${item.kind.replaceAll("_", " ")}: ${item.key}`,
      `  Objective: ${item.objectiveId}`,
      `  Team: ${item.teamId}`,
      `  Decision maker: ${
        [
          ...(operatorDecidesInboxItem(item) ? ["operator"] : []),
          ...item.nextActorTagIds.map((id) => page.tagNames?.[id] ?? "unknown Tag"),
        ].join(", ") || "none currently eligible"
      }`,
    );
    if (item.notification) {
      const { status, reason } = item.notification;
      lines.push(
        `  Notification: ${status === "unconfigured" ? "not configured" : status}${reason ? `${status === "delivered" ? " " : status === "pending" ? " (" : ": "}${reason}${status === "pending" ? ")" : ""}` : ""}`,
      );
    }
    if (item.approval) {
      lines.push(
        `  Approval request: ${item.approval.requestId} (${item.approval.requestKind})${item.approval.blocking ? "; a running Task Attempt is waiting" : ""}`,
        `  ${safeText(item.approval.summary)}`,
        `  Requested by Tag ${item.approval.requestingTagName ?? "unknown Tag"} for Task ${item.approval.taskId}`,
      );
    }
    if (item.message)
      lines.push(
        `  Message (sent ${item.message.createdAt}): ${quoteLine(operatorNotice(item.message.text), COORDINATION_INBOX_MESSAGE_LIMIT)}`,
        ...(item.message.truncated
          ? [
              `  The message continues; read it in full with supertag describe objective ${shellWord(item.objectiveId)}.`,
            ]
          : []),
      );
    // Reasons and commands can carry Worker Host or Tag text: one line each, so none forges a line.
    if (item.reason) lines.push(`  ${safeText(item.reason)}`);
    for (const command of item.commands ?? []) lines.push(`  Run: ${safeText(command)}`);
  }
  if (page.truncatedKinds.length)
    lines.push("", `Incomplete scan: ${page.truncatedKinds.join(", ")}`);
  if (page.nextCursor) lines.push("", `Next cursor: ${page.nextCursor}`);
  return `${lines.map(terminalText).join("\n")}\n`;
}
