import { parseArgs } from "node:util";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  type AuditEntry,
  parseAuditQuery,
} from "@supertag/core";
import type { ControlPlaneClient } from "./control-plane-client.js";
import { CONTROL_PLANE_API_VERSION } from "./control-plane-resources.js";
import { organizationClient } from "./operator-client.js";
import { auditEntryView } from "./organization-protos.js";
import { refusedAsError } from "./tag-conversation.js";

export function auditHelp(): string {
  return `Usage:
  supertag audit [--since ISO] [--actor NAME] [--limit N] [--output text|json]

Lists recorded operator changes, newest first: applies, deletes, Operator Token and Auth Key
changes, approval decisions, Objective messages, approvals, and cancellations, and other management
writes. Each entry names the actor, action, target, time, and outcome, never a secret.

  --since ISO     Only changes at or after this time, such as 2026-10-01T09:00:00Z
  --actor NAME    Only changes by this operator, such as token:laptop-2
  --limit N       At most N entries, 1 through ${AUDIT_MAX_LIMIT} (default ${AUDIT_DEFAULT_LIMIT})
  --output FORMAT text (default) or json
`;
}

/** `supertag audit`: reads the durable audit trail through `OrganizationService.ListAuditEntries`. */
export async function runAuditCommand(
  client: Pick<ControlPlaneClient, "operator">,
  args: readonly string[],
): Promise<string> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      since: { type: "string" },
      actor: { type: "string" },
      limit: { type: "string" },
      output: { type: "string", default: "text" },
    },
  });
  if (positionals.length > 0) throw new Error(auditHelp());
  if (values.output !== "text" && values.output !== "json")
    throw new Error("--output must be text or json");
  let parsed: ReturnType<typeof parseAuditQuery>;
  try {
    parsed = parseAuditQuery({ since: values.since, actor: values.actor, limit: values.limit });
  } catch (error) {
    throw new Error(`--${error instanceof Error ? error.message : String(error)}`);
  }
  const { since, actor, limit } = parsed;
  const page = await refusedAsError(() =>
    organizationClient(client.operator).listAuditEntries({
      ...(since === undefined ? {} : { since: timestampFromDate(new Date(since)) }),
      actor: actor ?? "",
      pageSize: limit,
    }),
  );
  const items: readonly AuditEntry[] = page.entries.map(auditEntryView);
  const result = {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "AuditEntryList",
    metadata: { limit },
    items,
  };
  return values.output === "json"
    ? `${JSON.stringify(result, null, 2)}\n`
    : formatAuditEntries(result.items);
}

function formatAuditEntries(entries: readonly AuditEntry[]): string {
  if (entries.length === 0) return "No audit entries match.\n";
  const safe = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
  const rows = [
    ["TIME", "ACTOR", "ACTION", "TARGET", "OUTCOME"],
    ...entries.map((entry) => [
      entry.at,
      entry.actor,
      entry.action,
      entry.target,
      entry.status === undefined ? entry.outcome : `${entry.outcome} (${entry.status})`,
    ]),
  ].map((row) => row.map(safe));
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return `${rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
        )
        .join("  "),
    )
    .join("\n")}\n`;
}
