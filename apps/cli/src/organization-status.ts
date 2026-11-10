import type { ControlPlaneTarget } from "./control-plane-client.js";
import { money } from "./money.js";
import { inboxClient, organizationClient, refusedAsError } from "./operator-client.js";
import { organizationStatusView } from "./organization-protos.js";
import type { OrganizationStatus, OrganizationStatusView } from "./organization-views.js";
import { takeOutputFlag } from "./output-flag.js";
import { runningCommandText } from "./running-command.js";
import { terminalText } from "./terminal-text.js";

export function statusHelp(): string {
  return `Usage: supertag status [--output text|json]

Shows what the organization is doing right now, on one screen: each Worker Host with its
connection and running Task Attempts against capacity per harness, each Tag as idle or busy with
its running Tasks, each Objective that is not finished with its status, spend against budget,
time to deadline, and items waiting for the operator, and the operator inbox count.
Unpriced Task Attempts show token counts and a warning that their monetary budget cannot be enforced.
Worker Hosts with reported low free disk show a warning below their row. The threshold is the
smaller of 10 GiB and 5% of the host's temporary filesystem volume.

  --output text|json     Output format (default: text)
`;
}

export async function runStatusCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
  now: () => Date = () => new Date(),
): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) return statusHelp();
  const output = takeOutputFlag(args);
  if (output.args.length > 0)
    throw new Error(`supertag status takes no arguments: ${output.args.join(" ")}`);
  const organizations = organizationClient({
    url: target.url,
    token: target.token,
    warnOnSkew: true,
  });
  const [organization, inbox] = await Promise.all([
    refusedAsError(async () => organizationStatusView(await organizations.getOrganization({}))),
    operatorInbox(target),
  ]);
  const items = inbox.items;
  const byObjective = new Map<string, number>();
  for (const { objectiveId } of items)
    if (objectiveId !== null) byObjective.set(objectiveId, (byObjective.get(objectiveId) ?? 0) + 1);
  const view: OrganizationStatusView = {
    ...organization,
    objectives: organization.objectives.map((objective) => ({
      ...objective,
      needsOperator: byObjective.get(objective.id) ?? 0,
    })),
    inbox: { items: items.length, truncated: inbox.truncated },
  };
  return output.json ? `${JSON.stringify(view, null, 2)}\n` : formatOrganizationStatus(view, now());
}

/** Every item the operator decides, as `supertag list inbox` counts them. */
async function operatorInbox(target: ControlPlaneTarget): Promise<{
  items: { readonly objectiveId: string | null }[];
  truncated: boolean;
}> {
  const inbox = inboxClient({ url: target.url, token: target.token });
  const items: { readonly objectiveId: string | null }[] = [];
  let truncated = false;
  let pageToken = "";
  do {
    const token = pageToken;
    const page = await refusedAsError(() =>
      inbox.listInboxItems({ pageToken: token, pageSize: 100 }),
    );
    for (const item of page.items)
      if (item.operatorEligible) items.push({ objectiveId: item.objectiveId || null });
    if (page.truncatedKinds.length > 0) truncated = true;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { items, truncated };
}

export function formatOrganizationStatus(view: OrganizationStatusView, now: Date): string {
  const lines: string[] = ["Worker Hosts"];
  if (view.workerHosts.length === 0)
    lines.push("  none; add one with supertag up or supertag connect worklet");
  for (const host of view.workerHosts) {
    const loads = host.harnesses.length
      ? host.harnesses
          .map(
            (load) =>
              `${load.harness} ${load.running}/${load.capacity}${load.coordinationCapacity ? ` (${load.coordinationCapacity} owner-only slot${load.coordinationCapacity === 1 ? "" : "s"})` : ""}`,
          )
          .join(", ")
      : "no Workers";
    lines.push(
      `  ${host.id}  ${host.phase}  ${host.running}/${host.capacity} Task Attempts running (${loads})`,
    );
    if (host.diskWarning) lines.push(`    ${host.diskWarning}`);
  }
  lines.push("", "Tags");
  if (view.tags.length === 0) lines.push("  none");
  for (const tag of view.tags) {
    lines.push(
      `  ${tag.name}  ${tag.runningTaskIds.length ? `busy: ${tag.runningTaskIds.join(", ")}` : "idle"}`,
    );
    for (const running of tag.runningCommands) {
      const command = runningCommandText(running, now.getTime());
      if (command) lines.push(`    ${running.taskId}  ${command}`);
    }
  }
  lines.push("", "Objectives not finished");
  if (view.objectives.length === 0) lines.push("  none");
  for (const objective of view.objectives) {
    const details = [
      objective.status,
      `owner ${objective.ownerName}`,
      spendText(objective),
      deadlineText(objective.deadline, now),
      ...(objective.needsOperator > 0 ? [`${objective.needsOperator} need you`] : []),
    ];
    lines.push(`  ${objective.id}  ${details.join("; ")}`);
    if (objective.unpricedAttempts)
      lines.push(
        `    unpriced; ${objective.unpricedAttempts} Task Attempts; ${objective.unpricedTokens ?? 0} tokens${objective.budgetLimitMinor !== null && objective.currency !== null ? "; budget cannot be enforced for these Task Attempts" : ""}`,
      );
    for (const finding of objective.highFindings ?? [])
      lines.push(
        `    High finding: ${finding.taskId} ${finding.id}: ${finding.summary}${finding.location ? ` (${finding.location})` : ""}`,
      );
  }
  lines.push(
    "",
    view.inbox.items === 0 && !view.inbox.truncated
      ? "Operator inbox: empty; see supertag list inbox --all for Tag decisions"
      : `Operator inbox: ${view.inbox.truncated ? "at least " : ""}${view.inbox.items} ${view.inbox.items === 1 ? "item" : "items"}; see supertag list inbox`,
  );
  return `${lines.map(terminalText).join("\n")}\n`;
}

function spendText(objective: OrganizationStatus["objectives"][number]): string {
  const { spentMinor, budgetLimitMinor, currency, spendCurrency } = objective;
  const spent =
    objective.unpricedAttempts && spentMinor === 0
      ? "unpriced"
      : spendCurrency === null
        ? `${spentMinor} units`
        : money(spentMinor, spendCurrency);
  if (budgetLimitMinor === null)
    return spendCurrency === null ? "no budget" : `${spent} spent, no budget`;
  // Keep the measures distinct: an allocation budget is never shown as money.
  const budget =
    currency === null ? `${budgetLimitMinor} budget units` : money(budgetLimitMinor, currency);
  return `${spent} of ${budget}`;
}

function deadlineText(deadline: string | null, now: Date): string {
  if (deadline === null) return "no deadline";
  const minutes = Math.round((Date.parse(deadline) - now.getTime()) / 60_000);
  const span = (total: number) => {
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    if (hours >= 48) return `${Math.floor(hours / 24)}d`;
    return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
  };
  return minutes >= 0 ? `deadline in ${span(minutes)}` : `deadline passed ${span(-minutes)} ago`;
}
