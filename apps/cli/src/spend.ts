import { parseArgs } from "node:util";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { parseSpendSince, type SpendReport, type SpendUsage } from "@supertag/core";
import type { ControlPlaneTarget } from "./control-plane-client.js";
import { money } from "./money.js";
import { organizationClient } from "./operator-client.js";
import { SPEND_GROUPINGS, spendReportView } from "./organization-protos.js";
import { takeOutputFlag } from "./output-flag.js";
import { refusedAsError } from "./tag-conversation.js";
import { terminalText } from "./terminal-text.js";

export async function runSpendCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
): Promise<string> {
  if (args.includes("--help") || args.includes("-h"))
    return "Usage: supertag spend [--by tag|objective|day] [--since ISO] [--output text|json]\n";
  const output = takeOutputFlag(args);
  const { values } = parseArgs({
    args: output.args,
    options: { by: { type: "string" }, since: { type: "string" } },
    strict: true,
  });
  const by = values.by ?? "objective";
  if (by !== "tag" && by !== "objective" && by !== "day")
    throw new Error("--by must be tag, objective, or day");
  const since = values.since === undefined ? undefined : parseSpendSince(values.since);
  const report = spendReportView(
    await refusedAsError(() =>
      organizationClient({ url: target.url, token: target.token, warnOnSkew: true }).getSpend({
        by: SPEND_GROUPINGS[by],
        ...(since === undefined ? {} : { since: timestampFromDate(new Date(since)) }),
      }),
    ),
  );
  return output.json ? `${JSON.stringify(report, null, 2)}\n` : formatSpend(report);
}

export function formatSpend(report: SpendReport): string {
  if (report.groups.length === 0) return "No Task Attempts.\n";
  return report.groups
    .map((group) => {
      const budget =
        report.by === "objective"
          ? ` | budget ${group.budget ? (group.budget.currency ? money(group.budget.limitMinor, group.budget.currency) : `${group.budget.limitMinor} allocation units`) : "none"}`
          : "";
      return `${terminalText(group.name ?? group.key)} | ${formatUsage(group)}${budget}\n`;
    })
    .join("");
}

function formatUsage(group: SpendUsage): string {
  const cost =
    Object.entries(group.reportedCostByCurrency ?? {})
      .map(([currency, amount]) => money(amount, currency))
      .join(", ") || (Object.keys(group.unpricedModels ?? {}).length ? "unpriced" : "unknown");
  const estimate = group.estimatedCostAttempts
    ? `; ${group.estimatedCostAttempts} estimated-cost Attempt(s)`
    : "";
  const unknownCost = group.unknownCostAttempts
    ? `; ${group.unknownCostAttempts} unknown-cost Attempt(s): ${unknownCostReasons(group)}`
    : "";
  const tokens = group.reportedTokens === null ? "unknown" : String(group.reportedTokens);
  const unknownTokens = group.unknownTokenAttempts
    ? `; ${group.unknownTokenAttempts} unknown-token Attempt(s)`
    : "";
  return `${group.attempts} Attempt(s) | cost ${cost}${estimate}${unknownCost} | tokens ${tokens}${unknownTokens}`;
}

/** Where Harness model prices live, valid for npm installs as well as source checkouts. */
export const PRICE_TABLE =
  "Codex Harness price table, shipped with supertag-ai; upgrade supertag-ai for new prices";

function unknownCostReasons(group: SpendUsage): string {
  const unpriced = Object.entries(group.unpricedModels ?? {});
  const priced = unpriced.reduce((sum, [, attempts]) => sum + attempts, 0);
  const reasons = unpriced.map(
    ([model, attempts]) =>
      `unpriced: no published price for ${terminalText(model)} in ${attempts}; tokens recorded`,
  );
  const unreported = group.unknownCostAttempts - priced;
  if (unreported > 0) reasons.push(`no cost reported in ${unreported}`);
  return `${reasons.join("; ")}${unpriced.length > 0 ? ` (prices: ${PRICE_TABLE})` : ""}`;
}
