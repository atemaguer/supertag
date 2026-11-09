import { explainHarnessSignIn } from "@supertag/control-plane";
import { type CoordinationInboxItem, coordinationInboxHeadline } from "@supertag/core";
import { formatDelivery, hasDelivery, type LocalCheckouts, shellWord } from "./delivery-view.js";
import { money } from "./money.js";
import type { ObjectiveOverviewView, ObjectiveSessionView } from "./objective-protos.js";
import { operatorNotice } from "./operator-notice.js";
import { terminalText } from "./terminal-text.js";

/** The Objective's own conversation, or a work Session started under it. */
export type ObjectiveOverviewSession = ObjectiveSessionView;

/** Facts the describe view adds beside the Control Plane's overview. */
export interface ObjectiveOverviewContext {
  /** Pending inbox items for this Objective; omitted when the inbox could not be read. */
  readonly inbox?: readonly CoordinationInboxItem[];
  /** Checkout paths on this machine, when the Control Plane runs locally. */
  readonly checkouts?: LocalCheckouts;
  readonly cwd?: string;
}

const OPEN_TASK = new Set(["pending", "running"]);

/**
 * Human-readable rendering only; state and explanations belong to the Control Plane. Leads with
 * what a person decides on (status, outcome, owner, results, and what needs them) and keeps the
 * full record for `--output json`.
 */
export function formatObjectiveOverview(
  view: ObjectiveOverviewView,
  context: ObjectiveOverviewContext = {},
): string {
  // Treat agent-authored text as text, never terminal escape sequences.
  const safe = terminalText;
  const { objective } = view;
  const tag = (id: string) => view.tagNames[id] ?? "unknown Tag";
  const id = shellWord(objective.id);
  const closed = objective.status === "completed" || objective.status === "cancelled";
  const lines = [
    `Objective ${objective.id}: ${objective.status.replaceAll("_", " ")}`,
    `Outcome: ${objective.outcome}`,
  ];
  if (objective.completionSummary)
    lines.push(
      `${objective.status === "ready_for_review" ? "Owner's assessment" : "Result"}: ${objective.completionSummary}`,
    );
  if (objective.limitSummary) lines.push(`Limit summary: ${objective.limitSummary}`);
  if (view.highFindings.length)
    lines.push(
      `High findings (${view.highFindings.length}):`,
      ...view.highFindings.map(
        (finding) =>
          `  ${finding.taskId} ${finding.id}: ${safe(finding.summary)}${finding.location ? ` (${safe(finding.location)})` : ""}`,
      ),
    );
  lines.push(`Owner: ${tag(objective.ownerTagId)}`);
  if (view.team)
    lines.push(
      `Team: ${view.team.name} (${view.team.memberTagIds.map(tag).join(", ") || "no members"})`,
    );
  // A closed Objective runs nothing more, so whether it could run is no longer news.
  for (const condition of closed ? [] : view.conditions)
    lines.push(
      `${condition.type}: ${condition.status ? "yes" : "no"}${condition.reasons.length ? `. ${condition.reasons.join(" ")}` : ""}`,
    );
  lines.push(budgetLine(view));

  // Delivered: what finished work produced, and how to fetch it.
  const delivered = view.sessions.filter((session) => hasDelivery(session.task?.delivery));
  lines.push("", "Delivered:");
  if (delivered.length === 0) lines.push(closed ? "  Nothing was delivered." : "  Nothing yet.");
  for (const session of delivered) {
    const task = session.task;
    if (task === undefined) continue;
    lines.push(`  ${sessionLabel(session)} (${tag(session.tagId)}, Task ${task.id})`);
    if (task.delivery)
      lines.push(
        ...formatDelivery(task.delivery, {
          indent: "    ",
          ...(context.checkouts === undefined ? {} : { checkouts: context.checkouts }),
          ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
        }),
      );
  }

  // Needs you: decisions only the operator makes, each with its command.
  const needs: string[] = [];
  if (objective.status === "limited")
    needs.push(
      "  The Objective reached its budget or deadline limit. Review the limit summary, then raise the budget or move the deadline to resume it.",
      `    supertag update objective ${id} --budget-minor AMOUNT`,
      `    supertag update objective ${id} --deadline ISO_TIME`,
    );
  const owner = view.sessions.find((session) => session.owner);
  // The owner's question appears in full: the operator has no other way to read it.
  const asks = (text: string) => {
    const body = operatorNotice(text)
      .split(/\r?\n|\r/u)
      .map((line) => safe(line.replace(/\t/gu, "  ")).trimEnd());
    while (body.length > 1 && body[0] === "") body.shift();
    while (body.length > 1 && body.at(-1) === "") body.pop();
    const shown = body.map((line, index) => (index === 0 || line === "" ? line : `    ${line}`));
    shown[0] = `  ${tag(objective.ownerTagId)} asks: "${shown[0]}`;
    shown[shown.length - 1] += '"';
    return shown;
  };
  for (const item of context.inbox ?? []) {
    if (item.objectiveId !== objective.id || !item.operatorEligible) continue;
    if (item.kind === "question" && owner?.task?.question !== undefined)
      needs.push(...asks(owner.task.question));
    else needs.push(`  ${coordinationInboxHeadline(item)}`);
    const command = item.commands?.[0];
    if (command) needs.push(`    ${command}`);
  }
  if (
    context.inbox === undefined &&
    owner?.task?.status === "waiting" &&
    owner.task.question !== undefined
  )
    needs.push(...asks(owner.task.question), `    supertag message objective ${id} TEXT`);
  for (const item of view.attention) {
    if (item.kind === "objective_review")
      needs.push(
        "  The owner submitted the Objective for review.",
        `    Approve: supertag approve objective ${id}`,
        `    Ask for changes: supertag message objective ${id} TEXT`,
      );
    else if (item.kind === "not_started" || item.kind === "objective_paused")
      needs.push(`  ${item.message}`, `    ${item.nextAction}`);
    else if (item.kind === "approvals_pending" && context.inbox === undefined)
      needs.push(`  ${item.message}`, `    supertag list approval --objective ${id}`);
  }
  lines.push("", "Needs you:", ...(needs.length ? needs : ["  Nothing right now."]));

  if (view.writes.length) {
    lines.push("", "Writes:");
    for (const write of view.writes)
      lines.push(
        `  ${write.volume}: ${write.files} files / ${write.bytes} bytes written${write.partial ? `; ${write.partial} partial` : ""}${write.refused ? `; ${write.refused} refused` : ""}`,
      );
  }

  // Work: the Objective's conversation and each work Session, with its latest turn.
  lines.push("", `Work: ${plural(view.sessions.length, "Session")}`);
  const width = (values: readonly string[]) => Math.max(0, ...values.map((value) => value.length));
  const statusWidth = width(view.sessions.map((session) => session.task?.status ?? "not started"));
  const tagWidth = width(view.sessions.map((session) => tag(session.tagId)));
  for (const session of view.sessions) {
    const task = session.task;
    lines.push(
      `  ${(task?.status ?? "not started").padEnd(statusWidth)}  ${tag(session.tagId).padEnd(tagWidth)}  ${firstLine(sessionLabel(session))}${task ? `  (Task ${task.id})` : ""}`,
    );
    if (task === undefined) continue;
    // Why open work is held, in the Control Plane's words.
    if (!closed && OPEN_TASK.has(task.status))
      for (const reason of task.explanations) lines.push(`    ${reason.message}`);
    for (const reason of task.explanations)
      if (reason.kind === "execution_failed")
        lines.push(
          `    ${explainHarnessSignIn(reason.message, reason.harness, reason.failureKind)}`,
        );
  }

  // Details: everything else a person may want, without internal accounting.
  lines.push("", "Details:");
  lines.push(`  Revision: ${objective.revision}`);
  if (objective.deadline) lines.push(`  Deadline: ${objective.deadline}`);
  if (objective.workspaces?.length) lines.push(`  Workspaces: ${objective.workspaces.join(", ")}`);
  if (objective.status === "cancelled")
    lines.push(`  Cancelled: ${objective.cancelledAt ?? "time not recorded"}`);
  for (const item of view.attention) {
    if (["objective_review", "not_started", "approvals_pending"].includes(item.kind)) continue;
    lines.push(`  ${item.message}`, `    Next: ${item.nextAction}`);
  }
  if (view.approvals)
    lines.push(
      `  Approvals: ${view.approvals.pending} pending; ${view.approvals.decidedLastDay.approved} approved and ${view.approvals.decidedLastDay.denied} denied in the last day`,
    );
  if (view.team)
    lines.push(
      `  Team ${view.team.name}: ${
        view.team.maxConcurrency === null
          ? "turns limited only by Worker Host capacity"
          : `at most ${view.team.maxConcurrency} turns at once across its Objectives`
      }`,
    );
  lines.push(
    `  Follow it: supertag watch objective ${id}`,
    `  Full record: supertag describe objective ${id} --output json`,
  );
  return `${lines.map(safe).join("\n")}\n`;
}

/** Budget in plain words: unlimited, or how much of the Objective's budget has been spent. */
function budgetLine(view: ObjectiveOverviewView): string {
  const { limitMinor, currency, spentMinor } = view.pool;
  const unpricedAttempts = Object.values(view.unpricedModels).reduce(
    (sum, count) => sum + count,
    0,
  );
  const amount = (minor: number) => (currency === null ? `${minor} units` : money(minor, currency));
  const unpriced = unpricedAttempts
    ? `; ${plural(unpricedAttempts, "Task Attempt")} unpriced, so the budget cannot count them`
    : "";
  const spent = spentMinor ?? 0;
  if (limitMinor === null)
    return `Budget: unlimited${spent > 0 ? `; ${amount(spent)} from recorded usage` : "; no cost recorded"}${unpriced}`;
  if (spentMinor === null)
    return `Budget: ${amount(limitMinor)}; spend is not counted in allocation units${unpriced}`;
  return `Budget: ${amount(spent)} of ${amount(limitMinor)} spent${spent > limitMinor ? `; overrun ${amount(spent - limitMinor)}` : ""}${unpriced}`;
}

/** The Objective's conversation, or a work Session by its title. */
export function sessionLabel(session: ObjectiveOverviewSession): string {
  return session.owner ? "Objective conversation" : (session.title ?? `Session ${session.id}`);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}
