/**
 * What a front end shows of the work around conversations: Objectives (outcomes a Tag owns,
 * with a budget and a status), the operator inbox (questions and approval requests waiting on a
 * person), Teams and their Workstream posts, and the Work Sessions a conversation's turns
 * started. View types and the rules for showing them; no DOM and no Node.js.
 */

export type ObjectiveStatus =
  | "working"
  | "blocked"
  | "limited"
  | "ready_for_review"
  | "completed"
  | "cancelled"
  | "unspecified";

/** An amount in a currency's minor units, such as cents: `{ minor: 1250, currency: "USD" }`. */
export interface Money {
  minor: number;
  currency: string;
}

export interface Objective {
  objectiveId: string;
  ownerTagId: string;
  /** The owner's Session the Objective works in; follow-ups go there. */
  sessionId: string;
  outcome: string;
  status: ObjectiveStatus;
  revision: number;
  ongoing: boolean;
  /** The owner's first turn; empty while it could not start. */
  startingTaskId: string;
  teamId?: string;
  deadlineMs?: number;
  budget?: Money;
  /** What its work reported spending, in the budget's currency. */
  spentMinor?: number;
  pausedAtMs?: number;
  /** Working, but its owner's last turn left nothing running and asked nothing. */
  idleSinceMs?: number;
  completionSummary?: string;
  /** Who created it, such as `operator:local`; empty for one a surface thread started. */
  createdBy: string;
}

/** A new Objective, as the form submits it. Its ID is chosen once, so a retry starts the same one. */
export interface NewObjective {
  objectiveId: string;
  ownerTagId: string;
  outcome: string;
  teamId?: string;
  budget?: Money;
}

export function objectiveOpen(objective: Pick<Objective, "status">): boolean {
  return objective.status !== "completed" && objective.status !== "cancelled";
}

/** Why an open Objective is held, as the rail shows it, or nothing while it works. */
export function objectiveHold(objective: Objective): string | undefined {
  if (objective.pausedAtMs !== undefined) return "paused";
  switch (objective.status) {
    case "blocked":
      return "blocked";
    case "limited":
      return "limited";
    case "ready_for_review":
      return "review";
    default:
      return undefined;
  }
}

/** An Objective's status in words: `working`, `ready for review`… */
export function statusLabel(status: ObjectiveStatus): string {
  return status === "ready_for_review" ? "ready for review" : status;
}

const SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CAD: "CA$",
  AUD: "A$",
  INR: "₹",
  CNY: "CN¥",
  KRW: "₩",
  BRL: "R$",
  MXN: "MX$",
  NZD: "NZ$",
  HKD: "HK$",
  ILS: "₪",
  VND: "₫",
  TWD: "NT$",
};

/** ISO 4217 minor digits that are not 2. */
const MINOR_DIGITS: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

const digitsOf = (currency: string) => MINOR_DIGITS[currency] ?? 2;
const currencyCode = (code: string) => /^[A-Z]{3}$/u.test(code);

/** An amount as a person reads it: `$1,250.00`, `EUR 3.10`, `¥300`. */
export function formatMoney(minor: number, currency: string): string {
  if (!currencyCode(currency)) return `${minor} ${currency} minor units`;
  const digits = digitsOf(currency);
  const sign = minor < 0 ? "-" : "";
  const value = Math.abs(minor);
  const scale = 10 ** digits;
  const whole = Math.floor(value / scale)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const amount =
    digits > 0 ? `${whole}.${String(value % scale).padStart(digits, "0")}` : `${whole}`;
  const symbol = SYMBOLS[currency];
  return symbol ? `${sign}${symbol}${amount}` : `${sign}${currency} ${amount}`;
}

/** `formatMoney` without zero cents: `$300`, `$12.50`. */
export function shortMoney(minor: number, currency: string): string {
  const text = formatMoney(minor, currency);
  return text.replace(/\.0+$/u, "");
}

const BUDGET =
  /^(?:\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)|([0-9][0-9,]*(?:\.[0-9]+)?)\s*([A-Za-z]{3}))$/u;

/**
 * A budget as a person types it: an amount and its currency code (`300 USD`, `12.5 eur`) or a
 * dollar amount (`$12.50`). Empty is no budget. Throws why a text is not a budget.
 */
export function parseBudget(text: string): Money | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const match = BUDGET.exec(trimmed);
  if (!match) throw "A budget is an amount and its currency, such as 300 USD or $12.50.";
  let amount = match[1];
  let currency = "USD";
  if (amount === undefined) {
    amount = match[2] ?? "";
    currency = (match[3] ?? "").toUpperCase();
  }
  const [whole = "", fraction = ""] = amount.replace(/,/gu, "").split(".");
  const digits = digitsOf(currency);
  if (fraction.length > digits) {
    throw digits === 0
      ? `A ${currency} budget has no decimal places.`
      : `A ${currency} budget has at most ${digits} decimal places.`;
  }
  const minor = Number(`${whole}${fraction.padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(minor)) throw "That budget is too large.";
  if (minor <= 0) throw "A budget must be more than zero.";
  return { minor, currency };
}

/** What an Objective's rail row says after its outcome: its hold, or spend against its budget. */
export function objectiveDetail(objective: Objective): string {
  const hold = objectiveHold(objective);
  if (hold) return hold;
  const budget = objective.budget;
  if (budget) {
    return `${shortMoney(objective.spentMinor ?? 0, budget.currency)} of ${shortMoney(budget.minor, budget.currency)}`;
  }
  if (objective.spentMinor !== undefined && objective.spentMinor > 0) return "spending";
  return "";
}

/** A new Objective's ID: the outcome's first words and a random suffix, such as `ship-sso-3f9a01c2`. */
export function newObjectiveId(outcome: string, random: () => number = Math.random): string {
  const words =
    outcome
      .toLowerCase()
      .match(/[a-z0-9]+/gu)
      ?.slice(0, 3) ?? [];
  let slug = words.join("-");
  if (slug.length > 40) slug = slug.slice(0, 40).replace(/^-+|-+$/gu, "");
  const suffix = Array.from({ length: 8 }, () => Math.floor(random() * 16).toString(16)).join("");
  return `${slug || "objective"}-${suffix}`;
}

/**
 * Whether `text` is the `/goal` command, and its outcome: `/goal Ship it` is `"Ship it"`, and
 * `/goal` alone is `""` (it opens the form). Anything else is `undefined`.
 */
export function goalOutcome(text: string): string | undefined {
  const trimmed = text.trim();
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(trimmed);
  return match ? (match[1] ?? "").trim() : undefined;
}

/**
 * The Objective a reply says `/goal` created: the Gateway answers `Created Objective ID: …`.
 * The reply is the home of that Objective in the conversation.
 */
export function createdObjectiveId(reply: string): string | undefined {
  const rest = reply.startsWith("Created Objective ")
    ? reply.slice("Created Objective ".length)
    : "";
  const colon = rest.indexOf(":");
  if (colon <= 0) return undefined;
  const id = rest.slice(0, colon);
  return /[\s]/u.test(id) ? undefined : id;
}

/** The line under an Objective's home reply once it needs a person or ended; nothing while it works. */
export function objectiveHomeLine(objective: Objective): string | undefined {
  const id = objective.objectiveId;
  const summary = objective.completionSummary?.split("\n")[0]?.trim();
  const said = (text: string) => (summary ? `${text}: ${summary}` : text);
  switch (objective.status) {
    case "ready_for_review":
      return `${said(`Objective ${id} is ready for your review`)} · open it under Objectives to approve or request changes`;
    case "completed":
      return said(`Objective ${id} is complete`);
    case "cancelled":
      return `Objective ${id} was cancelled.`;
    default:
      return undefined;
  }
}

export type InboxKind = "question" | "approval" | "budget" | "limit" | "attention" | "mcp_login";

/** One item waiting on an operator: a question to answer, an approval to decide, or a held Objective. */
export interface InboxItem {
  key: string;
  kind: InboxKind;
  objectiveId: string;
  taskId: string;
  attemptId?: string;
  /** Why it waits, as the Gateway says. */
  reason: string;
  actionableSinceMs: number;
  question?: { text: string; askedAtMs: number; truncated: boolean };
  approval?: { approvalId: string; tagId: string; summary: string };
  /** For an uncertain Task Attempt: what it blocks and what its Worker Host confirmed. */
  uncertain?: UncertainAttempt;
}

/** An uncertain Task Attempt waiting for a decision; its Session runs no later turn until then. */
export interface UncertainAttempt {
  tagId: string;
  sessionId: string;
  /** The Session's queued turns that wait for the decision. */
  blockedTasks: number;
  /** What the execution report says of cleanup: `confirmed` once the host saw it stop. */
  cleanup: string;
  /** The execution report classifies every limited dimension of the Attempt. */
  complete: boolean;
  /** When SuperTag records it as failed on its own; absent when a person must decide. */
  autoResolveAtMs?: number;
  /** Why a person must decide, such as a message it already sent. */
  heldReason?: string;
}

/**
 * The audited evidence an app records with its decision about an uncertain turn: where and by
 * whom it was made, and what the execution report said.
 */
export function resolutionEvidence(
  app: string,
  principal: string,
  report: { cleanup: string; complete: boolean },
): string {
  return `Resolved from the ${app} by ${principal}: cleanup ${report.cleanup}, complete ${report.complete} per execution report.`;
}

/** The mark before an inbox item: `?` a question, `!` an approval request, `·` anything else. */
export function inboxMark(item: Pick<InboxItem, "kind">): string {
  return item.kind === "question" ? "?" : item.kind === "approval" ? "!" : "·";
}

/** An inbox item in one line. */
export function inboxLine(item: InboxItem): string {
  if (item.question) return item.question.text;
  if (item.approval) return item.approval.summary;
  return item.reason || item.kind.replace("_", " ");
}

/** An approval request in full, as `supertag get approval` shows it. */
export interface ApprovalDetails {
  approvalId: string;
  action: string;
  resource: string;
  summary: string;
  /** The arguments it would run with, as indented JSON. */
  arguments: string;
  pending: boolean;
  state: string;
}

export interface Team {
  teamId: string;
  name: string;
  memberTagIds: string[];
  /** How many of its members' turns may run at once. */
  maxConcurrency?: number;
  revision: number;
}

export interface WorkstreamPost {
  postId: string;
  teamId: string;
  authorTagId: string;
  toTagIds: string[];
  body: string;
  sequence: number;
  createdAtMs: number;
}

/** What a Work Session delivered: the commits and how many files changed. */
export interface WorkDelivery {
  workspaceId: string;
  baseCommit: string;
  headCommit: string;
  committed: boolean;
  changedFiles: number;
}

/** Longer work a turn started, as its own Session of a Tag. */
export interface WorkSession {
  workSessionId: string;
  title: string;
  tagId: string;
  parentTagId: string;
  parentSessionId: string;
  starterTaskId: string;
  latestTaskId: string;
  latestTaskState: string;
  reportTaskId?: string;
  reportTaskState?: string;
  objectiveId?: string;
  delivery?: WorkDelivery;
  /** The question it waits on. */
  question?: string;
  closedAtMs?: number;
  closeReason?: string;
}

/** A Work Session's state in a few words: `working`, `waiting on you`, `closed: idle`… */
export function workState(work: WorkSession): string {
  if (work.closedAtMs !== undefined)
    return work.closeReason ? `closed: ${work.closeReason}` : "closed";
  if (work.question) return "waiting on you";
  const report = work.reportTaskState;
  if (report === "succeeded") return "reported";
  const state = work.latestTaskState;
  if (state === "queued" || state === "running") return "working";
  return state;
}

/** Where a Work Session's changes are and how to review them: its branch and pull request. */
export interface WorkBranch {
  branch: string;
  /** The commit to diff against, and the branch that was its base. */
  baseCommit: string;
  baseRef?: string;
  headCommit: string;
  pullRequest?: string;
}

/** A Work Session's diff, or why there is none, with a note when it differs from what was recorded. */
export interface WorkDiff {
  text?: string;
  reason?: string;
  note?: string;
}
