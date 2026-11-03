import { parseArgs } from "node:util";
import { type ApprovalRequest, describeApprovalAction } from "@supertag/core";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";

export function approvalHelp(): string {
  return `Usage:
  supertag list approval [--objective ID] [--status pending|approved|denied|expired|all] [--limit N] [--output text|json]
  supertag approve request ID [--scope once|objective] [--until ISO-8601]
  supertag deny request ID --reason TEXT

Approval requests come from permissions marked approval: required, from Tasks held for approval,
and from plan approvals requested by a lead AI actor. --scope once (the default) approves this
request; --scope objective approves every matching action in the request's Objective, optionally
until --until. Denials require a reason. The requesting Tag receives the decision by Mailbox.
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
