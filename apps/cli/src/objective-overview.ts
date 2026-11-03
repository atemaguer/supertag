import { explainHarnessSignIn, type ObjectiveOverview } from "@supertag/control-plane";
import { type CoordinationInboxItem, coordinationInboxHeadline } from "@supertag/core";
import { formatDelivery, hasDelivery, type LocalCheckouts, shellWord } from "./delivery-view.js";
import { money } from "./money.js";
import { operatorNotice } from "./operator-notice.js";
import { formatPostTriggeredSpend } from "./spend.js";
import { terminalText } from "./terminal-text.js";

/** Facts the describe view adds beside the Control Plane's overview. */
export interface ObjectiveOverviewContext {
  /** Pending inbox items for this Objective; omitted when the inbox could not be read. */
  readonly inbox?: readonly CoordinationInboxItem[];
  /** Checkout paths on this machine, when the Control Plane runs locally. */
  readonly checkouts?: LocalCheckouts;
  readonly cwd?: string;
}

const OPEN_TASK = new Set(["queued", "running", "waiting", "submitted"]);

/**
 * Human-readable rendering only; state and explanations belong to the Control Plane. Leads with
 * what a person decides on (status, outcome, owner, results, and what needs them) and keeps the
 * full record for `--output json`.
 */
export function formatObjectiveOverview(
  view: ObjectiveOverview,
  context: ObjectiveOverviewContext = {},
): string {
  // Treat agent-authored text as text, never terminal escape sequences.
  const safe = terminalText;
  const { objective, performance } = view;
  const tagNames: Readonly<Record<string, string>> = view.tagNames ?? {};
  const tag = (id: string) => tagNames[id] ?? "unknown Tag";
  const id = shellWord(objective.id);
  const lines = [
    `Objective ${objective.id}: ${objective.status.replaceAll("_", " ")}`,
    `Outcome: ${objective.outcome}`,
  ];
  if (objective.completionSummary)
    lines.push(
      `${objective.status === "ready_for_review" ? "Owner's assessment" : "Result"}: ${objective.completionSummary}`,
    );
  if (objective.limitState?.summary)
    lines.push(`Limit summary: ${objective.limitState.summary.text}`);
  // A Control Plane that predates findings omits the field: say so instead of implying none.
  const openHighFindings = view.openHighFindings as typeof view.openHighFindings | undefined;
  if (openHighFindings === undefined)
    lines.push("Open high findings: not reported by this Control Plane");
  else if (openHighFindings.length)
    lines.push(
      `Open high findings (${openHighFindings.length}):`,
      ...openHighFindings.map(
        (finding) =>
          `  ${finding.taskId} ${finding.id}: ${safe(finding.summary)}${finding.location ? ` (${safe(finding.location)})` : ""}`,
      ),
    );
  lines.push(`Owner: ${tag(objective.ownerTagId)}`);
  const closed = objective.status === "completed" || objective.status === "cancelled";
  // A closed Objective runs nothing more, so whether it could run is no longer news.
  for (const condition of closed ? [] : view.conditions)
    lines.push(
      `${condition.type}: ${condition.status ? "yes" : "no"}${condition.reasons.length ? `. ${condition.reasons.join(" ")}` : ""}`,
    );
  if (view.scope.teamId) lines.push("Spend scope: entire Objective (all Teams and Task pages)");
  lines.push(budgetLine(view));
  if (view.postTriggeredSpend?.attempts)
    lines.push(formatPostTriggeredSpend(view.postTriggeredSpend));
  const latestReport = view.conversation
    ?.filter((message) => message.from === "owner" && message.needsReply === false)
    .at(-1);
  if (latestReport)
    lines.push(
      `Latest from the owner (${latestReport.createdAt}): ${safe(latestReport.text).replace(/\s+/gu, " ").trim()}`,
    );

  // Delivered: what finished work produced, and how to fetch it.
  const delivered = view.tasks.filter((task) => hasDelivery(task.delivery));
  lines.push("", "Delivered:");
  if (delivered.length === 0)
    lines.push(
      objective.status === "completed" || objective.status === "cancelled"
        ? "  Nothing was delivered."
        : "  Nothing yet.",
    );
  for (const task of delivered) {
    lines.push(`  Task ${task.taskId} (${tag(task.assignedTagId)}, ${task.status})`);
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
  if (objective.status === "limited") {
    if (objective.limitState?.summary)
      needs.push(
        "  The Objective reached its budget or deadline limit. Review the limit summary, then raise the budget or move the deadline to resume it.",
        `    supertag update objective ${id} --budget-minor AMOUNT`,
        `    supertag update objective ${id} --deadline ISO_TIME`,
      );
    else needs.push("  The owner is recording the final limit summary.");
  }
  const pendingOwnerMessage = view.conversation
    ?.filter(
      (message) =>
        message.from === "owner" && message.needsReply !== false && message.status === "pending",
    )
    .at(-1);
  const pendingReviewQuestions =
    objective.status === "ready_for_review"
      ? (view.conversation ?? []).filter(
          (message) =>
            message.from === "owner" && message.needsReply === true && message.status === "pending",
        )
      : [];
  if (pendingReviewQuestions.length) {
    lines.push("Approval waits for answers to these owner questions:");
    for (const question of pendingReviewQuestions) {
      lines.push(
        `  ${safe(question.id)} (asked ${safe(question.createdAt)}): ${safe(question.text.split(/\r?\n|\r/u, 1)[0] ?? "")}`,
      );
      lines.push(`    supertag message objective ${id} --reply-to ${shellWord(question.id)} TEXT`);
    }
  }
  // The owner's message appears in full: the operator has no other way to read it.
  // Line breaks and every line's leading indentation survive, including the first line's;
  // only leading and trailing blank lines and trailing spaces are dropped. Continuation
  // lines sit under the entry.
  const asks = (text: string, at: string) => {
    const lines = operatorNotice(text)
      .split(/\r?\n|\r/u)
      .map((line) => safe(line.replace(/\t/gu, "  ")).trimEnd());
    while (lines.length > 1 && lines[0] === "") lines.shift();
    while (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const body = lines.map((line, index) => (index === 0 || line === "" ? line : `    ${line}`));
    body[0] = `  ${tag(objective.ownerTagId)} asks (${at}): "${body[0]}`;
    body[body.length - 1] += '"';
    return body;
  };
  for (const item of context.inbox ?? []) {
    if (item.objectiveId !== objective.id || item.nextActorTagIds.length > 0) continue;
    if (item.operatorEligible === false) continue;
    // Each message item shows its full text: from the conversation, else from the inbox,
    // whose copy may be truncated.
    const messageId = item.evidence.find((entry) => entry.kind === "message")?.id;
    const stored = view.conversation?.find(
      (message) => message.from === "owner" && message.id === messageId,
    );
    const message = stored ?? item.message;
    if (item.kind === "operator_message" && message)
      needs.push(...asks(message.text, message.createdAt));
    else needs.push(`  ${coordinationInboxHeadline(item)}`);
    const command = item.commands?.[0];
    if (command) needs.push(`    ${command}`);
  }
  if (
    context.inbox === undefined &&
    pendingOwnerMessage &&
    !needs.some((line) => line.includes(" asks ("))
  )
    needs.push(
      ...asks(pendingOwnerMessage.text, pendingOwnerMessage.createdAt),
      `    supertag message objective ${id} TEXT`,
    );
  for (const item of view.attention) {
    if (item.kind === "objective_review")
      needs.push(
        "  The owner submitted the Objective for review.",
        `    Approve: supertag approve objective ${id}`,
        `    Ask for changes: supertag message objective ${id} TEXT`,
      );
    else if (item.kind === "no_scheduled_follow_up")
      needs.push(
        "  No work is scheduled to continue this Objective.",
        "    Review the results, then send the owner your next instruction.",
        `    supertag message objective ${id} TEXT`,
        "    If you are viewing one Team, check the full Objective before acting.",
      );
    else if (item.kind === "not_started" || item.kind === "objective_paused")
      needs.push(`  ${item.message}`, `    ${item.nextAction}`);
    else if (item.kind === "approvals_pending" && context.inbox === undefined)
      needs.push(`  ${item.message}`, `    supertag list approval --objective ${id}`);
  }
  lines.push("", "Needs you:", ...(needs.length ? needs : ["  Nothing right now."]));

  // Team questions and blockers are visible without opening each channel.
  const coordinationTag = (id: string) => tagNames[id] ?? id;
  lines.push("", "Team coordination:");
  for (const team of view.teams) {
    const { posts, directMessages } = team.openCoordination;
    const warnings = (view.coordination?.posts ?? [])
      .filter(
        (post) =>
          post.workstreamId === team.id && post.authorTagId === null && post.type === "evidence",
      )
      .slice(-20);
    lines.push(`  ${team.name}:`);
    if (posts.length === 0 && directMessages.length === 0 && warnings.length === 0)
      lines.push("    No open questions or blockers.");
    for (const post of warnings)
      lines.push(
        `    evidence post ${post.id} from system to ${post.to.map(coordinationTag).join(", ")}: ${coordinationPreview(post.body)}`,
      );
    for (const post of posts.slice(0, 20))
      lines.push(
        `    ${post.type} post ${post.id} from ${post.authorTagId === null ? "system" : coordinationTag(post.authorTagId)} to ${post.to.length ? post.to.map(coordinationTag).join(", ") : "Team (unaddressed)"}: ${coordinationPreview(post.body)}`,
      );
    for (const message of directMessages.slice(0, 20))
      lines.push(
        `    ${message.type} message ${message.id} from ${coordinationTag(message.senderTagId)} to ${coordinationTag(message.recipientTagId)}: ${coordinationPreview(typeof message.body["message"] === "string" ? message.body["message"] : JSON.stringify(message.body))}`,
      );
    if (posts.length > 20 || directMessages.length > 20)
      lines.push("    More open questions or blockers; read the Team channel and Mailbox history.");
  }

  if (view.writes.length) {
    lines.push("", "Writes:");
    for (const write of view.writes)
      lines.push(
        `  ${write.volume}: ${write.files} files / ${write.bytes} bytes written${write.partial ? `; ${write.partial} partial` : ""}${write.refused ? `; ${write.refused} refused` : ""}`,
      );
  }

  // Items: each numbered statement item with the Tasks that serve it.
  const uncertainIds = new Set(
    view.tasks.filter((task) => task.uncertainAttempt).map((task) => task.taskId),
  );
  lines.push(...formatItems(view.items ?? [], uncertainIds));

  // Tasks: counts, then one line each. Uncertain Tasks are running in the store, but no one runs
  // them until an operator recovers their Attempt, so they are counted and shown apart.
  const uncertainCount = performance.uncertain ?? 0;
  const counts = Object.entries({
    ...performance.states,
    running: performance.states.running - uncertainCount,
    uncertain: uncertainCount,
  })
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`);
  lines.push(
    "",
    `Tasks: ${performance.total}${counts.length ? ` (${counts.join(", ")})` : ""}${view.scope.teamId ? `, Team ${view.scope.teamId} only` : ""}`,
  );
  const width = (values: readonly string[]) => Math.max(0, ...values.map((value) => value.length));
  const idWidth = width(view.tasks.map((task) => task.taskId));
  const statusWidth = width(view.tasks.map(shownStatus));
  const tagWidth = width(view.tasks.map((task) => tag(task.assignedTagId)));
  for (const task of view.tasks) {
    lines.push(
      `  ${task.taskId.padEnd(idWidth)}  ${shownStatus(task).padEnd(statusWidth)}  ${tag(task.assignedTagId).padEnd(tagWidth)}  ${firstLine(task.instruction)}`,
    );
    // Why open work is held, in the Control Plane's words.
    if (!closed && OPEN_TASK.has(task.status))
      for (const reason of task.explanations)
        if (reason.kind !== "attempt_uncertain") lines.push(`    ${reason.message}`);
    for (const reason of task.explanations)
      if (
        (task.status === "failed" && reason.kind === "failed_after_delivering_commits") ||
        reason.kind === "attempt_uncertain"
      )
        lines.push(`    ${reason.message}`, `    ${reason.nextAction}`);
    for (const reason of task.explanations)
      if (reason.kind === "execution_failed")
        lines.push(
          `    ${explainHarnessSignIn(reason.message, reason.harness, reason.failureKind)}`,
        );
    // A Task that closed itself, such as an owner activation, has no reviewer worth showing.
    if (
      task.review.assessment &&
      task.review.reviewedByTagId &&
      (task.status === "accepted" || task.status === "rejected")
    )
      lines.push(
        `    ${task.status === "accepted" ? "Accepted" : "Rejected"}${task.review.reviewedByTagId ? ` by ${tag(task.review.reviewedByTagId)}` : ""}: ${firstLine(task.review.assessment)}`,
      );
  }
  if (view.nextOffset !== null)
    lines.push(`  More Tasks: supertag describe objective ${id} --offset ${view.nextOffset}`);

  // Details: everything else a person may want, without internal accounting.
  lines.push("", "Details:");
  lines.push(`  Revision: ${objective.revision}`);
  if (objective.deadline) lines.push(`  Deadline: ${objective.deadline}`);
  if (objective.workspaces?.length) lines.push(`  Workspaces: ${objective.workspaces.join(", ")}`);
  if (objective.status === "cancelled")
    lines.push(`  Cancelled: ${objective.cancelledAt ?? "time not recorded"}`);
  for (const item of view.attention) {
    if (
      ["objective_review", "not_started", "approvals_pending", "no_scheduled_follow_up"].includes(
        item.kind,
      )
    )
      continue;
    lines.push(`  ${item.message}`, `    Next: ${item.nextAction}`);
  }
  if (view.approvals)
    lines.push(
      `  Approvals: ${view.approvals.pending} pending; ${view.approvals.decidedLastDay.approved} approved and ${view.approvals.decidedLastDay.denied} denied in the last day`,
    );
  for (const team of view.teams)
    lines.push(
      `  Team ${team.name}: led by ${tag(team.leadTagId)}, ${
        team.maxConcurrency === null
          ? `${team.running} running, limited only by Worker Host capacity`
          : `${team.running} of ${team.maxConcurrency} running`
      }`,
    );
  if (performance.review.awaiting > 0) lines.push(`  Needs review: ${performance.review.awaiting}`);
  if (view.pageUsage.reportedTokens !== null)
    lines.push(`  Reported tokens: ${view.pageUsage.reportedTokens}`);
  lines.push(
    `  Follow it: supertag watch objective ${id}`,
    `  Full record: supertag describe objective ${id} --output json`,
  );
  return `${lines.map(safe).join("\n")}\n`;
}

/** Budget in plain words: unlimited, or how much of it has been spent. */
function budgetLine(view: ObjectiveOverview): string {
  const { allocation } = view;
  const usage = view.objectiveSpend;
  if (!usage) {
    const reported = view.objective.limitState?.reportedSpend;
    const spent = reported?.amountMinor ?? 0;
    if (allocation.limitMinor === null)
      return `Budget: unlimited${reported ? `; ${money(spent, reported.currency)} from recorded usage` : "; no cost recorded"}`;
    if (allocation.currency !== null)
      return `Budget: ${money(spent, allocation.currency)} of ${money(allocation.limitMinor, allocation.currency)} spent${spent > allocation.limitMinor ? `; overrun ${money(spent - allocation.limitMinor, allocation.currency)}` : ""}`;
    return `Budget: ${allocation.chargedMinor ?? 0} of ${allocation.limitMinor} units used`;
  }
  const estimateLabel = (usage.estimatedCostAttempts ?? 0) > 0 ? " (includes estimated cost)" : "";
  const unpriced = Object.keys(usage.unpricedModels ?? {}).length
    ? `; unpriced (${Object.entries(usage.unpricedModels ?? {})
        .map(([model, attempts]) => `${model}: ${attempts}`)
        .join(
          ", ",
        )}; ${usage.reportedTokens ?? "unknown"} reported tokens; budget cannot be enforced for these Task Attempts)`
    : "";
  const costs = Object.entries(usage.reportedCostByCurrency ?? {});
  const cost = costs.length
    ? costs.map(([currency, amount]) => money(amount, currency)).join(" + ")
    : undefined;
  const budgetCost =
    allocation.currency === null ? 0 : (usage.reportedCostByCurrency?.[allocation.currency] ?? 0);
  if (allocation.limitMinor === null)
    return `Budget: unlimited${cost === undefined ? "; no cost recorded" : `; ${cost} from recorded usage${estimateLabel}`}${unpriced}`;
  if (allocation.currency !== null)
    return `Budget: ${cost ?? (unpriced ? "unpriced" : money(0, allocation.currency))} of ${money(allocation.limitMinor, allocation.currency)} spent${estimateLabel}${budgetCost > allocation.limitMinor ? `; overrun ${money(budgetCost - allocation.limitMinor, allocation.currency)}` : ""}${unpriced}${usage.unknownCostAttempts && !unpriced ? ` (${usage.unknownCostAttempts} Task Attempts reported no cost)` : ""}`;
  return `Budget: ${allocation.chargedMinor} of ${allocation.limitMinor} units used${cost === undefined ? "" : `; ${cost} from recorded usage${estimateLabel}`}`;
}

export { money };

/**
 * One line per statement item with its state, then its Tasks; nothing when there are no items,
 * and one line when no Task records items, since every item would otherwise read as not started.
 */
function formatItems(
  items: ObjectiveOverview["items"],
  uncertainIds: ReadonlySet<string>,
): string[] {
  if (items.length === 0) return [];
  if (items.every((entry) => entry.tasks.length === 0))
    return ["", "Items: Tasks in this Objective don't record statement items."];
  const itemWidth = Math.max(...items.map((entry) => entry.item.length));
  const stateWidth = Math.max(...items.map((entry) => entry.state.length));
  const lines = ["", "Items:"];
  const itemsByTask = new Map<string, string[]>();
  for (const entry of items)
    for (const task of entry.tasks) {
      const list = itemsByTask.get(task.taskId) ?? [];
      if (!list.includes(entry.item)) list.push(entry.item);
      itemsByTask.set(task.taskId, list);
    }
  for (const entry of items) {
    lines.push(
      `  ${entry.item.padStart(itemWidth)}  ${entry.state.padEnd(stateWidth)}  ${entry.title ?? "(not in the statement)"}`,
    );
    const indent = `  ${" ".repeat(itemWidth)}  `;
    if (entry.tasks.length === 0) lines.push(`${indent}No Task.`);
    for (const task of entry.tasks) {
      const others = (itemsByTask.get(task.taskId) ?? []).filter((item) => item !== entry.item);
      lines.push(
        `${indent}${task.taskId} ${uncertainIds.has(task.taskId) && task.status === "running" ? "uncertain" : task.status}${others.length ? `, also item${others.length > 1 ? "s" : ""} ${others.join(", ")}` : ""}`,
      );
    }
  }
  return lines;
}

/** A Task's status for people: a running Task whose Attempt is uncertain reads "uncertain". */
function shownStatus(task: ObjectiveOverview["tasks"][number]): string {
  return task.uncertainAttempt ? "uncertain" : task.status;
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

/** Sanitize before bounding so control characters cannot create display lines. */
function coordinationPreview(text: string): string {
  const line = terminalText(text).replace(/\s+/gu, " ").trim();
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}
