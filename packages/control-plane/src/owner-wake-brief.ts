import {
  type ActivationDigest,
  type Objective,
  ownerActivation,
  readableDuration,
  type Store,
  storedOpenTaskFindings,
  TASK_FINDING_SEVERITIES,
  type TagMessage,
  type TaskAssignment,
} from "@supertag/core";

import { teamDigestBriefLines } from "./activation-digest.js";
import { operatorDirectionBrief } from "./operator-direction-brief.js";
import {
  quoted,
  renderUnhandledOperatorBrief,
  unhandledOperatorBrief,
} from "./unhandled-operator-brief.js";

/**
 * The Objective owner's activations start in a fresh harness session instead of resuming the
 * previous transcript, so a wake costs about the same early and late in an Objective. Each one
 * receives this compact brief of durable state; the coordination tools read the rest.
 */

/** Hard ceiling on the whole brief, in characters. */
export const OWNER_WAKE_BRIEF_MAX_CHARACTERS = 12_000;
/** List lengths and per-entry text lengths that keep a typical brief well under the ceiling. */
const LIMITS = {
  statement: 1_000,
  changes: 8,
  changeText: 140,
  messages: 4,
  messageText: 240,
  open: 10,
  openText: 100,
  reviews: 6,
  reviewText: 200,
  findings: 10,
  findingText: 160,
  notes: 500,
} as const;
const SETTLED = ["submitted", "accepted", "rejected", "failed", "cancelled"];
const OPEN = ["queued", "running", "waiting"];

export interface OwnerWakeBriefInput {
  readonly objective: Objective;
  /** The owner activation this brief is for. */
  readonly task: TaskAssignment;
  /** Every Task in the Objective. */
  readonly tasks: readonly TaskAssignment[];
  /** Messages the owner received in this Objective, in any order. */
  readonly messages: readonly TagMessage[];
  /** Selected independently of delivery status and the previous wake by durable handling records. */
  readonly unhandledOperatorMessages?: readonly TagMessage[];
  readonly hasMoreUnhandledOperatorMessages?: boolean;
  /** When the owner's previous wake started; null when none is recorded. */
  readonly since: string | null;
  /** Separate scoped direction read; null marks a failed read, not an empty mailbox. */
  readonly operatorMessages?: Awaited<ReturnType<Store["listObjectiveOperatorMessages"]>> | null;
  readonly now?: string;
  /** The owner's activation digest, read from every Team channel in the Objective. */
  readonly digest?: ActivationDigest;
}

/** Whether a Task Attempt for this Task starts fresh with an Objective brief. */
export function startsOwnerWake(task: TaskAssignment, objective: Objective): boolean {
  return ownerActivation(task, objective.ownerTagId);
}

/** One line of text, cut to `max` characters with a pointer to the tool that reads it in full. */
function clip(value: unknown, max: number, pointer: string): string {
  const text = (typeof value === "string" ? value : value == null ? "" : JSON.stringify(value))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove ANSI escapes from untrusted output.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return quoted(text.length <= max ? text : `${text.slice(0, max)}… [truncated; ${pointer}]`);
}

function more(total: number, shown: number, pointer: string): string[] {
  return total > shown ? [`- …and ${total - shown} more; ${pointer}.`] : [];
}

function amount(minor: number, currency: string | null | undefined): string {
  return currency ? `${(minor / 100).toFixed(2)} ${currency}` : `${minor} units`;
}

/** The compact, bounded Objective brief for one owner wake. */
export function ownerWakeBrief(input: OwnerWakeBriefInput): string {
  const { objective, task, since } = input;
  const now = input.now ?? new Date().toISOString();
  const after = (at: string) => since === null || at > since;
  const readTask = (id: string) => `read_task ${id} reads it in full`;
  const delegated = input.tasks.filter(
    (candidate) =>
      candidate.taskId !== task.taskId && !ownerActivation(candidate, objective.ownerTagId),
  );
  const lines: string[] = [
    "Objective brief for this owner wake. This Task Attempt starts a fresh harness session: earlier conversation turns are not carried over. This brief and currentWork summarize the stored state; use the coordination tools to read more before acting on anything it omits.",
    "",
    `Objective ${objective.id} (${objective.status}): ${clip(objective.outcome, LIMITS.statement, "read_objective returns the full statement in definition pages")}`,
  ];

  const limits: string[] = [];
  if (objective.deadline) {
    const left = Date.parse(objective.deadline) - Date.parse(now);
    limits.push(
      `deadline ${objective.deadline} (${left > 0 ? `${readableDuration(left)} left` : "passed"})`,
    );
  }
  if (typeof objective.budgetLimitMinor === "number") {
    const spend = objective.limitState?.reportedSpend;
    limits.push(
      `budget ${amount(objective.budgetLimitMinor, objective.budgetCurrency)}${
        spend ? `, ${amount(spend.amountMinor, spend.currency)} reported spent` : ""
      }`,
    );
  }
  if (limits.length) lines.push(`Limits: ${limits.join("; ")}.`);

  // What changed since the owner last ran.
  lines.push(
    "",
    since === null
      ? "Recent changes (no earlier owner wake is recorded):"
      : `Changes since your last wake at ${since}:`,
  );
  const changed = delegated
    .filter((candidate) => SETTLED.includes(candidate.status) && after(candidate.updatedAt))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const candidate of changed.slice(0, LIMITS.changes)) {
    const result = candidate.result ?? {};
    const setupFailure =
      candidate.status === "failed" && result["failureKind"] === "workspace-setup";
    const detail =
      candidate.status === "submitted"
        ? "result awaits your review"
        : `${setupFailure ? "untrusted setup output: " : ""}${clip(
            candidate.status === "accepted" || candidate.status === "rejected"
              ? result["assessment"]
              : (result["error"] ?? result["text"]),
            LIMITS.changeText,
            readTask(candidate.taskId),
          )}`;
    lines.push(
      `- Task ${candidate.taskId} ${candidate.status} at ${candidate.updatedAt} (assigned to Tag ${candidate.assignedTagId})${detail ? `: ${detail}` : ""}`,
    );
  }
  lines.push(...more(changed.length, LIMITS.changes, "read_objective lists every Task"));

  const messages = input.messages
    .filter(
      (message) =>
        message.operatorId === undefined &&
        message.objectiveId === objective.id &&
        message.recipientTagId === objective.ownerTagId &&
        message.id !== task.sourceMessageId &&
        after(message.createdAt),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const message of messages.slice(0, LIMITS.messages)) {
    const body = message.body["message"] ?? message.body["text"] ?? message.body;
    const sender = message.operatorId
      ? `operator ${message.operatorId}`
      : `Tag ${message.senderTagId}`;
    lines.push(
      `- Message ${message.id} from ${sender} (${message.type}) at ${message.createdAt}: ${clip(body, LIMITS.messageText, `read_mailbox with messageId ${message.id} reads it in full`)}`,
    );
  }
  lines.push(...more(messages.length, LIMITS.messages, "read_mailbox reads every message"));

  const state = objective.limitState;
  const notices = [
    ...(state?.deadlineSetAt && after(state.deadlineSetAt.at)
      ? [`- Deadline set to ${state.deadlineSetAt.deadline} at ${state.deadlineSetAt.at}.`]
      : []),
    ...(state?.deadlineWarnings ?? [])
      .filter((warning) => after(warning.at))
      .map(
        (warning) =>
          `- Deadline warning at ${warning.at}: ${warning.minutesBefore} minutes before ${warning.deadline}.`,
      ),
    ...(state?.deadlinePassed && after(state.deadlinePassed.at)
      ? [`- Deadline ${state.deadlinePassed.deadline} passed at ${state.deadlinePassed.at}.`]
      : []),
    ...(state?.budgetWarnings ?? [])
      .filter((warning) => after(warning.at))
      .map(
        (warning) =>
          `- Budget warning at ${warning.at}: ${amount(warning.spentMinor, objective.budgetCurrency)} of ${amount(warning.limitMinor, objective.budgetCurrency)} spent.`,
      ),
    ...(state?.budgetExhausted && after(state.budgetExhausted.at)
      ? [
          `- Budget spent at ${state.budgetExhausted.at}: ${amount(state.budgetExhausted.spentMinor, objective.budgetCurrency)} of ${amount(state.budgetExhausted.limitMinor, objective.budgetCurrency)}.`,
        ]
      : []),
  ];
  lines.push(...notices.slice(-4));
  if (!changed.length && !messages.length && !notices.length)
    lines.push("- No recorded Task results, messages, or limit changes.");

  const open = delegated
    .filter((candidate) => OPEN.includes(candidate.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  lines.push("", `Open delegated Tasks (${open.length}):`);
  for (const candidate of open.slice(0, LIMITS.open)) {
    const waiting =
      candidate.status === "waiting" && candidate.waitState?.reason
        ? `; waiting: ${clip(candidate.waitState.reason, LIMITS.openText, readTask(candidate.taskId))}`
        : "";
    lines.push(
      `- ${candidate.taskId} ${candidate.status} (Tag ${candidate.assignedTagId}): ${clip(candidate.instruction, LIMITS.openText, readTask(candidate.taskId))}${waiting}`,
    );
  }
  if (!open.length) lines.push("- None.");
  lines.push(...more(open.length, LIMITS.open, "read_objective pages through every Task"));

  const reviews = delegated
    .filter((candidate) => candidate.status === "submitted")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  lines.push("", `Results awaiting your review (${reviews.length}):`);
  for (const candidate of reviews.slice(0, LIMITS.reviews))
    lines.push(
      `- ${candidate.taskId} submitted at ${candidate.updatedAt} (Tag ${candidate.assignedTagId}): ${clip(candidate.result?.["text"], LIMITS.reviewText, readTask(candidate.taskId))}`,
    );
  if (!reviews.length) lines.push("- None.");
  lines.push(...more(reviews.length, LIMITS.reviews, "read_objective lists every submitted Task"));

  const findingsStart = lines.length;
  // Open review findings on delegated Tasks, highest severity first. A cancelled Task's open
  // findings still describe the work, so they are listed with the Task marked cancelled.
  // A Task whose stored findings do not validate is listed as unreadable instead of failing the
  // whole brief; it never reads as having no open findings.
  const unreadable: { taskId: string; reason: string }[] = [];
  const findings = delegated
    .flatMap((candidate) => {
      const stored = storedOpenTaskFindings(candidate.result);
      if ("unreadable" in stored) {
        unreadable.push({ taskId: candidate.taskId, reason: stored.unreadable });
        return [];
      }
      return [...stored.high, ...stored.medium, ...stored.low].map((finding) => ({
        taskId: candidate.taskId,
        cancelled: candidate.status === "cancelled",
        finding,
      }));
    })
    .sort(
      (a, b) =>
        TASK_FINDING_SEVERITIES.indexOf(a.finding.severity) -
        TASK_FINDING_SEVERITIES.indexOf(b.finding.severity),
    );
  const count = (severity: string) =>
    findings.filter((entry) => entry.finding.severity === severity).length;
  lines.push(
    "",
    `Open findings (${findings.length}${findings.length ? `: ${TASK_FINDING_SEVERITIES.map((severity) => `${count(severity)} ${severity}`).join(", ")}` : ""}${unreadable.length ? `; unreadable on ${unreadable.length} Task${unreadable.length === 1 ? "" : "s"}` : ""}):`,
  );
  for (const { taskId, cancelled, finding } of findings.slice(0, LIMITS.findings))
    lines.push(
      `- ${finding.severity} ${finding.id} on Task ${taskId}${cancelled ? " (cancelled)" : ""}: ${clip(
        `${finding.summary}${finding.location === undefined ? "" : ` (${finding.location})`}`,
        LIMITS.findingText,
        readTask(taskId),
      )}`,
    );
  for (const { taskId, reason } of unreadable.slice(0, LIMITS.findings))
    lines.push(
      `- unreadable findings on Task ${taskId}: ${clip(reason, LIMITS.findingText, readTask(taskId))}`,
    );
  if (!findings.length && !unreadable.length) lines.push("- None.");
  lines.push(...more(findings.length, LIMITS.findings, "read_task shows each Task's findings"));
  lines.push(...more(unreadable.length, LIMITS.findings, "read_task shows each Task's findings"));

  // Reserve bounded space for findings and the owner's notes even when other lists fill up.
  const findingLines = lines.splice(findingsStart);
  const protectedLines: string[] = [];
  for (const [index, line] of findingLines.entries()) {
    if (protectedLines.join("\n").length + line.length > 1_800) {
      protectedLines.push(
        `- ${findingLines.length - index} more finding lines; read_task shows each Task's findings.`,
      );
      break;
    }
    protectedLines.push(line);
  }

  // The owner's own record of why it stopped last time.
  const previous = input.tasks
    .filter(
      (candidate) =>
        candidate.taskId !== task.taskId && ownerActivation(candidate, objective.ownerTagId),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const notes = task.waitState?.reason
    ? { label: "Your wait reason", text: task.waitState.reason, taskId: task.taskId }
    : previous?.waitState?.reason
      ? { label: "Your last wait reason", text: previous.waitState.reason, taskId: previous.taskId }
      : typeof previous?.result?.["text"] === "string" && previous.result["text"].trim()
        ? {
            label: `Your last activation's result (${previous.taskId})`,
            text: previous.result["text"],
            taskId: previous.taskId,
          }
        : undefined;
  if (notes)
    protectedLines.push(
      "",
      `${notes.label}: ${clip(notes.text, LIMITS.notes, readTask(notes.taskId))}`,
    );

  // The digest's blockers and decisions are recorded as delivered, so the cap never cuts one
  // mid-line: space is reserved for them, and only the sections above are truncated. Past half
  // the cap, whole lines give way to a count; every item is also in this activation's teamDigest.
  const operatorBrief = unhandledOperatorBrief(
    objective,
    input.unhandledOperatorMessages ?? [],
    input.hasMoreUnhandledOperatorMessages,
  );
  const operatorDirection = operatorDirectionBrief(
    objective,
    input.operatorMessages?.items ?? (input.operatorMessages === null ? [] : input.messages),
    {
      ...(input.operatorMessages?.olderMessage
        ? { olderMessage: input.operatorMessages.olderMessage }
        : {}),
      ...(input.operatorMessages === null ? { unavailable: true } : {}),
    },
  );
  const protectedText = protectedLines.join("\n");
  const digestLimit = Math.min(
    OWNER_WAKE_BRIEF_MAX_CHARACTERS / 2,
    OWNER_WAKE_BRIEF_MAX_CHARACTERS -
      operatorDirection.length -
      operatorBrief.length -
      protectedText.length -
      2_000,
  );
  const digestLines: string[] = [];
  const candidates = teamDigestBriefLines(input.digest);
  let used = 0;
  for (const [index, line] of candidates.entries()) {
    if (used + line.length + 1 > digestLimit) {
      digestLines.push(
        `- ${candidates.length - index} more blocker and decision lines; full text in teamDigest and read_workstream`,
      );
      break;
    }
    digestLines.push(line);
    used += line.length + 1;
  }
  const tail = [
    "",
    protectedText,
    operatorDirection,
    operatorBrief,
    ...digestLines,
    "",
    "Read more: read_objective (every Task, Team, and Workstream, paged), read_task TASK_ID (full instruction, result, review, and artifacts), read_mailbox (messages in full), read_workstream (shared posts).",
  ].join("\n");
  const head = lines.join("\n");
  if (head.length + 1 + tail.length <= OWNER_WAKE_BRIEF_MAX_CHARACTERS) return `${head}\n${tail}`;
  const marker = "\n… [brief truncated; read_objective and read_task return the full state]\n";
  const room = Math.max(0, OWNER_WAKE_BRIEF_MAX_CHARACTERS - tail.length - marker.length);
  // Never cut a quoted line in half: that would remove its closing delimiter.
  const kept: string[] = [];
  let headUsed = 0;
  for (const line of lines) {
    if (headUsed + line.length + 1 > room) break;
    kept.push(line);
    headUsed += line.length + 1;
  }
  return `${kept.join("\n")}${marker}${tail}`;
}

type BriefStore = Pick<
  Store,
  | "listTaskAssignments"
  | "listTaskAttempts"
  | "listTagMessageHistory"
  | "listUnhandledOperatorInputs"
  | "recordOperatorInputReceipt"
  | "listObjectiveOperatorMessages"
>;

/** Gathers the stored state for {@link ownerWakeBrief} and renders it. */
export async function loadOwnerWakeBrief(
  store: BriefStore,
  objective: Objective,
  task: TaskAssignment,
  attemptId: string,
  digest?: ActivationDigest,
): Promise<string> {
  const tasks = await store.listTaskAssignments(objective.id);
  // The previous wake is the latest other owner Attempt: this Task's earlier Attempt, or one of
  // the most recently updated other owner activations.
  const activations = [
    task,
    ...tasks
      .filter(
        (candidate) =>
          candidate.taskId !== task.taskId && ownerActivation(candidate, objective.ownerTagId),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 3),
  ];
  let since: string | null = null;
  for (const activation of activations)
    for (const attempt of await store.listTaskAttempts(activation.taskId))
      if (attempt.id !== attemptId && (since === null || attempt.startedAt > since))
        since = attempt.startedAt;
  // Recent changes and persistent direction are independent bounded reads. Filter direction
  // in the store so unrelated traffic cannot hide it behind a recent-history page.
  const [recent, operatorMessages] = await Promise.all([
    store.listTagMessageHistory(objective.ownerTagId, { limit: 50 }).catch(() => ({ items: [] })),
    store.listObjectiveOperatorMessages(objective.id, objective.ownerTagId).catch(() => null),
  ]);
  // This Objective-scoped query is independent of the recent history window. Query one
  // extra record so the bounded brief can tell the owner when more input needs fetching.
  const unhandled = await store.listUnhandledOperatorInputs(objective.id, 101);
  const selected = unhandled.slice(0, 100);
  const rendered = renderUnhandledOperatorBrief(objective, selected, unhandled.length > 100);
  await store.recordOperatorInputReceipt({
    taskId: task.taskId,
    attemptCount: task.attemptCount,
    messageIds: rendered.messageIds,
  });
  return ownerWakeBrief({
    objective,
    task,
    tasks,
    messages: recent.items,
    operatorMessages,
    unhandledOperatorMessages: selected,
    hasMoreUnhandledOperatorMessages: unhandled.length > 100,
    since,
    ...(digest ? { digest } : {}),
  });
}
