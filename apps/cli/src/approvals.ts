import { parseArgs } from "node:util";
import { create, toJsonString } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  type ApprovalRequest,
  COORDINATION_INBOX_KINDS,
  COORDINATION_INBOX_QUESTION_LIMIT,
  COORDINATION_INBOX_VERSION,
  type CoordinationInboxItem,
  type CoordinationInboxPage,
  coordinationInboxHeadline,
  describeApprovalAction,
  shellWord,
} from "@supertag/core";
import {
  type InboxItem,
  type InboxItemKind,
  InboxItemSchema,
  ListApprovalsResponseSchema,
  type ListInboxItemsResponse,
  ListInboxItemsResponseSchema,
  WatchKind,
} from "@supertag/operator-api";
import { followChanges } from "./change-follow.js";
import type { ControlPlaneTarget } from "./control-plane-client.js";
import {
  APPROVAL_SCOPE,
  APPROVAL_STATUS,
  approvalRecord,
  INBOX_KIND,
  inboxItemRecord,
} from "./objective-protos.js";
import { eventClient, inboxClient } from "./operator-client.js";
import { operatorNotice } from "./operator-notice.js";
import { refusedAsError } from "./tag-conversation.js";
import { terminalText } from "./terminal-text.js";

type InboxClient = ReturnType<typeof inboxClient>;
type EventClient = ReturnType<typeof eventClient>;

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
  const client = inboxClient({ url: target.url, token: target.token, warnOnSkew: true });
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
    if (values.status !== "all" && !APPROVAL_STATUS.words.includes(values.status as never))
      throw new Error("status must be pending, approved, denied, expired, or all");
    if (values.limit !== undefined && !/^\d+$/u.test(values.limit))
      throw new Error("--limit must be an integer");
    const result = await refusedAsError(() =>
      client.listApprovals({
        objectiveId: values.objective ?? "",
        status: APPROVAL_STATUS.value(values.status),
        pageSize: values.limit === undefined ? 0 : Number(values.limit),
      }),
    );
    return values.output === "json"
      ? `${toJsonString(ListApprovalsResponseSchema, result, { prettySpaces: 2 })}\n`
      : formatApprovalRequests(result.approvals.map(approvalRecord), values.status);
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
    let decided: ApprovalRequest;
    if (command === "approve") {
      const scope = values["scope"];
      if (scope !== undefined && scope !== "once" && scope !== "objective")
        throw new Error("--scope must be once or objective");
      const until = values["until"];
      const validUntil = typeof until === "string" ? new Date(until) : undefined;
      if (validUntil !== undefined && Number.isNaN(validUntil.getTime()))
        throw new Error("--until must be an ISO-8601 time");
      decided = approvalRecord(
        await refusedAsError(() =>
          client.approve({
            id,
            scope: APPROVAL_SCOPE.value(scope),
            ...(validUntil === undefined ? {} : { validUntil: timestampFromDate(validUntil) }),
          }),
        ),
      );
    } else {
      if (typeof values["reason"] !== "string" || !values["reason"].trim())
        throw new Error("deny request requires --reason TEXT");
      const reason = values["reason"];
      decided = approvalRecord(await refusedAsError(() => client.deny({ id, reason })));
    }
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
  const filter: InboxFilter = {
    objectiveId: values.objective ?? "",
    kind: INBOX_KIND.value(kind),
    nextActorTagId: values["next-actor"] ?? "",
  };
  const options = { url: target.url, token: target.token, warnOnSkew: true };
  const inbox = inboxClient(options);
  if (command === "watch") {
    if (values.cursor !== undefined || values.limit !== undefined)
      throw new Error("watch inbox does not accept --cursor or --limit");
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    try {
      await refusedAsError(() =>
        watchCoordinationInbox({ inbox, events: eventClient(options) }, filter, {
          output,
          signal: controller.signal,
          write: (text) => process.stdout.write(text),
          warn: (text) => process.stderr.write(text),
        }),
      );
    } finally {
      process.removeListener("SIGINT", stop);
    }
    return "";
  }
  if (values.limit !== undefined && !/^\d+$/u.test(values.limit))
    throw new Error("--limit must be an integer");
  const first = await refusedAsError(() =>
    inbox.listInboxItems({
      ...filter,
      pageToken: values.cursor ?? "",
      pageSize: values.limit === undefined ? 0 : Number(values.limit),
    }),
  );
  let result = first;
  if (!values.all) {
    const items = [...first.items];
    const tagNames = { ...first.tagNames };
    const truncatedKinds = new Set(first.truncatedKinds);
    let pageToken = first.nextPageToken;
    while (pageToken) {
      const token = pageToken;
      const next = await refusedAsError(() =>
        inbox.listInboxItems({ ...filter, pageToken: token, pageSize: 100 }),
      );
      items.push(...next.items);
      Object.assign(tagNames, next.tagNames);
      for (const truncated of next.truncatedKinds) truncatedKinds.add(truncated);
      pageToken = next.nextPageToken;
    }
    result = create(ListInboxItemsResponseSchema, {
      ...(first.asOf === undefined ? {} : { asOf: first.asOf }),
      items: items.filter((item) => item.operatorEligible),
      tagNames,
      truncatedKinds: [...truncatedKinds],
    });
  }
  return output === "text"
    ? formatCoordinationInbox(inboxPage(result))
    : `${toJsonString(ListInboxItemsResponseSchema, result, { prettySpaces: 2 })}\n`;
}

/** What `list inbox` and `watch inbox` filter on. */
export interface InboxFilter {
  readonly objectiveId: string;
  readonly kind: InboxItemKind;
  readonly nextActorTagId: string;
}

/** A page of the inbox as the CLI shows it. */
function inboxPage(response: ListInboxItemsResponse): CoordinationInboxPage {
  const asOf = response.asOf === undefined ? new Date() : timestampDate(response.asOf);
  return {
    projectionVersion: COORDINATION_INBOX_VERSION,
    asOf: asOf.toISOString(),
    items: response.items.map((item) => inboxItemRecord(item, asOf)),
    tagNames: response.tagNames,
    truncatedKinds: response.truncatedKinds.flatMap((kind) => INBOX_KIND.word(kind) ?? []),
    ...(response.nextPageToken === "" ? {} : { nextCursor: response.nextPageToken }),
  };
}

const WATCH_PAGE_LIMIT = 20;

export interface CoordinationInboxWatchOptions {
  readonly output: "json" | "text";
  readonly signal: AbortSignal;
  readonly write: (text: string) => void;
  readonly warn?: (text: string) => void;
  /** How long to wait before reconnecting a broken change stream. */
  readonly retryMs?: number;
}

/**
 * Prints each pending inbox item once, as it appears, until the signal aborts. It prints
 * everything already pending first, then rereads the inbox each time the change stream says an
 * inbox item changed. An item that leaves the inbox and returns prints again.
 */
export async function watchCoordinationInbox(
  clients: {
    readonly inbox: Pick<InboxClient, "listInboxItems">;
    readonly events: Pick<EventClient, "watch">;
  },
  filter: InboxFilter,
  options: CoordinationInboxWatchOptions,
): Promise<void> {
  let seen = new Set<string>();
  let read = false;
  await followChanges(clients.events, {
    kinds: [WatchKind.INBOX_ITEM],
    signal: options.signal,
    ...(options.warn === undefined ? {} : { warn: options.warn }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    matches: (change) => filter.objectiveId === "" || change.objectiveId === filter.objectiveId,
    refresh: async () => {
      const items: InboxItem[] = [];
      try {
        let pageToken = "";
        for (let page = 0; page < WATCH_PAGE_LIMIT; page += 1) {
          const result = await clients.inbox.listInboxItems({
            ...filter,
            pageToken,
            pageSize: 100,
          });
          items.push(...result.items);
          pageToken = result.nextPageToken;
          if (!pageToken) break;
        }
      } catch (error) {
        // Nothing has printed yet, so a first failure, such as a refused credential, ends it.
        if (!read) throw error;
        options.warn?.(
          `Inbox read failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return "poll";
      }
      read = true;
      if (options.signal.aborted) return "stop";
      const asOf = new Date();
      const current = new Set<string>();
      for (const item of items) {
        current.add(item.occurrence);
        if (seen.has(item.occurrence)) continue;
        options.write(
          options.output === "json"
            ? `${toJsonString(InboxItemSchema, item)}\n`
            : `${formatCoordinationInboxLine(inboxItemRecord(item, asOf))}\n`,
        );
      }
      seen = current;
      return undefined;
    },
  });
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
