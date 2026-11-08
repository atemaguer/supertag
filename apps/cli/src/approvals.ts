import { parseArgs } from "node:util";
import {
  type ApprovalRequest,
  COORDINATION_INBOX_KINDS,
  COORDINATION_INBOX_QUESTION_LIMIT,
  type CoordinationInboxItem,
  type CoordinationInboxPage,
  coordinationInboxHeadline,
  coordinationInboxOccurrence,
  describeApprovalAction,
  shellWord,
} from "@supertag/core";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";
import { operatorNotice } from "./operator-notice.js";
import { terminalText } from "./terminal-text.js";

export function approvalHelp(): string {
  return `Usage:
  supertag list approval [--objective ID] [--status pending|approved|denied|expired|all] [--limit N] [--output text|json]
  supertag approve request ID [--scope once|objective] [--until ISO-8601]
  supertag deny request ID --reason TEXT

Approval requests come from permissions marked approval: required. The Task that asked ends
waiting on the decision; deciding continues its Session with the decision. --scope once (the
default) approves this request; --scope objective approves every matching action in the
request's Objective, optionally until --until. Denials require a reason.
`;
}

export async function runApprovalCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
): Promise<string> {
  const [command, ...rest] = args;
  const client = new ControlPlaneClient(target);
  if (command === "list") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        objective: { type: "string" },
        status: { type: "string", default: "pending" },
        limit: { type: "string" },
        output: { type: "string", default: "text" },
      },
    });
    if (positionals.length > 0) throw new Error(approvalHelp());
    if (values.output !== "text" && values.output !== "json")
      throw new Error("--output must be text or json");
    const query = new URLSearchParams();
    if (values.objective !== undefined) query.set("objectiveId", values.objective);
    query.set("status", values.status);
    if (values.limit !== undefined) {
      if (!/^\d+$/u.test(values.limit)) throw new Error("--limit must be an integer");
      query.set("limit", values.limit);
    }
    const result = await client.request<{ readonly requests: readonly ApprovalRequest[] }>(
      `/api/v1/coordination/approvals?${query}`,
      { method: "GET" },
    );
    return values.output === "json"
      ? `${JSON.stringify(result, null, 2)}\n`
      : formatApprovalRequests(result.requests, values.status);
  }
  if (command === "approve" || command === "deny") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options:
        command === "approve"
          ? { scope: { type: "string" }, until: { type: "string" } }
          : { reason: { type: "string" } },
    });
    const [id, ...extra] = positionals;
    if (id === undefined || extra.length > 0) throw new Error(approvalHelp());
    const body: Record<string, unknown> = {};
    if (command === "approve") {
      const scope = values["scope"];
      if (scope !== undefined && scope !== "once" && scope !== "objective")
        throw new Error("--scope must be once or objective");
      if (scope !== undefined) body["scope"] = scope;
      if (values["until"] !== undefined) body["validUntil"] = values["until"];
    } else {
      if (typeof values["reason"] !== "string" || !values["reason"].trim())
        throw new Error("deny request requires --reason TEXT");
      body["reason"] = values["reason"];
    }
    const decided = await client.request<ApprovalRequest>(
      `/api/v1/coordination/approvals/${encodeURIComponent(id)}/${command}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return `Approval request ${decided.id} ${decided.status}${decided.scope ? ` (scope: ${decided.scope}${decided.validUntil ? ` until ${decided.validUntil}` : ""})` : ""}.\n`;
  }
  throw new Error(approvalHelp());
}

function formatApprovalRequests(requests: readonly ApprovalRequest[], status: string): string {
  const safe = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
  if (requests.length === 0)
    return `No ${status === "all" ? "" : `${status} `}approval requests.\n`;
  const lines: string[] = [];
  for (const request of requests) {
    lines.push(
      `${request.id} | ${request.status} | ${request.kind} | Task ${request.taskId}${request.objectiveId ? ` | Objective ${request.objectiveId}` : ""}`,
      `  ${request.summary}`,
      `  Requested by Tag ${request.requestingTagId} at ${request.createdAt}`,
    );
    for (const action of request.actions) lines.push(`  Action: ${describeApprovalAction(action)}`);
    if (request.ruleSources.length)
      lines.push(`  Required by Permission Set: ${request.ruleSources.join(", ")}`);
    lines.push(
      `  Approvers: ${request.approvers.length ? request.approvers.join(", ") : "operators"}`,
    );
    if (request.status === "pending")
      lines.push(
        `  Decide: supertag approve request ${request.id} [--scope once|objective]; supertag deny request ${request.id} --reason TEXT`,
      );
    else if (request.decidedAt)
      lines.push(
        `  Decided by ${request.decidedByKind ?? "unknown"} ${request.decidedBy ?? ""} at ${request.decidedAt}${request.scope ? `; scope ${request.scope}` : ""}${request.reason ? `; reason: ${request.reason}` : ""}`,
      );
  }
  return `${lines.map(safe).join("\n")}\n`;
}

export function inboxHelp(): string {
  return `Usage:
  supertag list inbox [--objective ID] [--kind ${COORDINATION_INBOX_KINDS.map((kind) => kind.replaceAll("_", "-")).join("|")}] [--all] [--output text|json]
  supertag watch inbox [--objective ID] [--kind KIND] [--output text|json]

The inbox lists what waits on a person: approval requests, questions an Objective asked, budget
and deadline limits, Tasks that need an operator, and MCP servers to log in to. Each item names
the command that acts on it. Without --all, list inbox shows only items the operator decides.
watch inbox prints each item once, as it appears, until Ctrl-C.
`;
}

/** `list inbox` and `watch inbox`. */
export async function runInboxCommand(
  target: ControlPlaneTarget,
  command: "list" | "watch",
  args: readonly string[],
): Promise<string> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      objective: { type: "string" },
      kind: { type: "string" },
      "next-actor": { type: "string" },
      cursor: { type: "string" },
      limit: { type: "string" },
      output: { type: "string" },
      ...(command === "list" ? { all: { type: "boolean" as const } } : {}),
    },
  });
  if (positionals.length > 0) throw new Error(inboxHelp());
  const output = values.output ?? (command === "watch" ? "text" : "json");
  if (output !== "json" && output !== "text") throw new Error("--output must be json or text");
  const kind = values.kind?.replaceAll("-", "_");
  if (kind !== undefined && !(COORDINATION_INBOX_KINDS as readonly string[]).includes(kind))
    throw new Error(
      `--kind must be one of ${COORDINATION_INBOX_KINDS.map((item) => item.replaceAll("_", "-")).join(", ")}`,
    );
  const query = new URLSearchParams();
  for (const [name, value] of [
    ["objectiveId", values.objective],
    ["kind", kind],
    ["nextActorId", values["next-actor"]],
  ] as const)
    if (value !== undefined) query.set(name, value);
  const client = new ControlPlaneClient(target);
  if (command === "watch") {
    if (values.cursor !== undefined || values.limit !== undefined)
      throw new Error("watch inbox does not accept --cursor or --limit");
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    try {
      await watchCoordinationInbox(client, query, {
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
  if (values.cursor !== undefined) query.set("cursor", values.cursor);
  if (values.limit !== undefined) {
    if (!/^\d+$/u.test(values.limit)) throw new Error("--limit must be an integer");
    query.set("limit", values.limit);
  }
  let result = await client.request<CoordinationInboxPage>(`/api/v1/coordination/inbox?${query}`, {
    method: "GET",
  });
  if (!values.all) {
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
      for (const truncated of next.truncatedKinds) truncatedKinds.add(truncated);
      cursor = next.nextCursor;
    }
    result = {
      projectionVersion: result.projectionVersion,
      asOf: result.asOf,
      items: items.filter((item) => item.operatorEligible),
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
  const question = item.question
    ? `: ${quoteLine(operatorNotice(item.question.text), COORDINATION_INBOX_QUESTION_LIMIT)}`
    : "";
  return terminalText(
    `${item.actionableSince}  ${item.kind}${item.objectiveId === null ? "" : `  Objective ${item.objectiveId}`}  ${coordinationInboxHeadline(item)}${question}${command ? `  -> ${command}` : ""}`,
  );
}

/** Text on one line, in quotes, cut to `limit` characters. */
function quoteLine(text: string, limit: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return `"${line.length > limit ? `${line.slice(0, limit - 1)}…` : line}"`;
}

function formatCoordinationInbox(page: CoordinationInboxPage): string {
  const lines = [`Operator inbox (${page.items.length} items; as of ${page.asOf})`];
  for (const item of page.items) {
    lines.push(
      "",
      `${item.kind.replaceAll("_", " ")}: ${item.key}`,
      `  Objective: ${item.objectiveId ?? "none (a Tag's inbox)"}`,
      `  Decision maker: ${
        [
          ...(item.operatorEligible ? ["operator"] : []),
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
        `  Approval request: ${item.approval.requestId} (${item.approval.requestKind})${item.approval.blocking ? "; a Task waits on the decision" : ""}`,
        `  ${terminalText(item.approval.summary)}`,
        `  Requested by Tag ${item.approval.requestingTagName ?? "unknown Tag"} for Task ${item.approval.taskId}`,
      );
    }
    if (item.question)
      lines.push(
        `  Question (asked ${item.question.createdAt}): ${quoteLine(operatorNotice(item.question.text), COORDINATION_INBOX_QUESTION_LIMIT)}`,
        ...(item.question.truncated && item.objectiveId !== null
          ? [
              `  The question continues; read it in full with supertag describe objective ${shellWord(item.objectiveId)}.`,
            ]
          : []),
      );
    // Reasons and commands can carry Worker Host or Tag text: one line each, so none forges a line.
    if (item.reason) lines.push(`  ${terminalText(item.reason)}`);
    for (const command of item.commands ?? []) lines.push(`  Run: ${terminalText(command)}`);
  }
  if (page.truncatedKinds.length)
    lines.push("", `Incomplete scan: ${page.truncatedKinds.join(", ")}`);
  if (page.nextCursor) lines.push("", `Next cursor: ${page.nextCursor}`);
  return `${lines.map(terminalText).join("\n")}\n`;
}
