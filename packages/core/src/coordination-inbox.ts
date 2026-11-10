/** Version of the durable operator inbox projection contract. */
export const COORDINATION_INBOX_VERSION = 8 as const;

/**
 * `approval`: a pending approval request. `question`: an Objective's latest turn asked with
 * `ask` and waits on the answer. `objective_budget` and `objective_limit`: a budget or deadline
 * limit was reached. `task_attention`: a Task needs an operator, such as an uncertain Attempt.
 * `mcp_login`: a Task is held until an MCP server is logged in.
 */
export const COORDINATION_INBOX_KINDS = [
  "approval",
  "question",
  "objective_budget",
  "objective_limit",
  "task_attention",
  "mcp_login",
] as const;
export type CoordinationInboxKind = (typeof COORDINATION_INBOX_KINDS)[number];
export type CoordinationInboxStatus = "pending";

export type CoordinationInboxEvidence =
  | {
      readonly kind: "task";
      readonly id: string;
      readonly status: string;
      readonly attemptCount: number;
      readonly updatedAt: string;
    }
  | { readonly kind: "objective"; readonly id: string; readonly revision: number }
  | { readonly kind: "approval_request"; readonly id: string };

/** A partial invocation of a public primitive plus fields the operator must still supply. */
export interface CoordinationInboxAction {
  readonly tool: "update_objective";
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly requiredInputFields: readonly string[];
}

/** One actionable row in a read model over existing resources. */
export interface CoordinationInboxItem {
  readonly projectionVersion: typeof COORDINATION_INBOX_VERSION;
  readonly key: string;
  readonly kind: CoordinationInboxKind;
  readonly status: CoordinationInboxStatus;
  /** Explains a responsibility needing inspection; does not authorize replay. */
  readonly reason?: string;
  /** Null only for an approval requested by a Tag's inbox turn, which has no Objective. */
  readonly objectiveId: string | null;
  readonly nextActorTagIds: readonly string[];
  readonly excludedActorTagIds: readonly string[];
  readonly operatorEligible: boolean;
  readonly actionableSince: string;
  readonly ageSeconds: number;
  readonly deadline: string | null;
  readonly evidence: readonly CoordinationInboxEvidence[];
  readonly permittedActions: readonly CoordinationInboxAction[];
  /** The pending approval request an `approval` item stands for. */
  readonly approval?: CoordinationInboxApproval;
  /**
   * For a `question` item read by an operator who may read the whole Objective: the question,
   * cut to {@link COORDINATION_INBOX_QUESTION_LIMIT} characters, and when it was asked.
   */
  readonly question?: CoordinationInboxQuestion;
  /**
   * For a `task_attention` item about a running Task whose Attempt is uncertain: the Attempt and
   * where its journal is, which name the `supertag recover worklet` command in `commands`.
   */
  readonly uncertainAttempt?: CoordinationInboxUncertainAttempt;
  /** `supertag` commands that act on the item, most direct first. */
  readonly commands?: readonly string[];
  /** Delivery state of the operator notification about this item. */
  readonly notification?: {
    readonly status:
      | "unconfigured"
      | "pending"
      | "delivering"
      | "delivered"
      | "failed"
      | "unavailable"
      | "not configured";
    readonly reason?: string;
  };
  readonly redaction: {
    readonly level: "metadata_only";
    readonly omitted: readonly string[];
  };
}

export interface CoordinationInboxUncertainAttempt {
  readonly attemptId: string;
  readonly workerHostId?: string;
  readonly workerId?: string;
}

/** Longest question text an inbox item carries; longer text ends with `…`. */
export const COORDINATION_INBOX_QUESTION_LIMIT = 500;

export interface CoordinationInboxQuestion {
  readonly text: string;
  readonly createdAt: string;
  /** The question is longer than `text`; `supertag describe objective` shows it in full. */
  readonly truncated: boolean;
}

/** The bounded inbox form of a question. */
export function coordinationInboxQuestion(
  text: string,
  createdAt: string,
): CoordinationInboxQuestion {
  const truncated = text.length > COORDINATION_INBOX_QUESTION_LIMIT;
  return {
    text: truncated ? `${text.slice(0, COORDINATION_INBOX_QUESTION_LIMIT - 1)}…` : text,
    createdAt,
    truncated,
  };
}

export interface CoordinationInboxApproval {
  readonly requestId: string;
  readonly requestKind: "surface-action";
  readonly summary: string;
  readonly requestingTagId: string;
  readonly requestingTagName?: string;
  readonly taskId: string;
  /** A running Task Attempt waits on this decision. */
  readonly blocking: boolean;
}

export interface CoordinationInboxFilter {
  readonly objectiveId?: string;
  readonly kind?: CoordinationInboxKind;
  readonly status?: CoordinationInboxStatus;
  readonly nextActorId?: string;
}

export interface ReadCoordinationInboxInput extends CoordinationInboxFilter {
  /** Include approval requests; false for principals that may not list them. Defaults to true. */
  readonly includeApprovals?: boolean;
  readonly asOf?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CoordinationInboxPage {
  readonly projectionVersion: typeof COORDINATION_INBOX_VERSION;
  readonly asOf: string;
  readonly items: readonly CoordinationInboxItem[];
  /** Display names for Tag decision makers on this page. */
  readonly tagNames?: Readonly<Record<string, string>>;
  readonly truncatedKinds: readonly CoordinationInboxKind[];
  readonly nextCursor?: string;
}

export interface CoordinationInboxStore {
  readCoordinationInbox(input?: ReadCoordinationInboxInput): Promise<CoordinationInboxPage>;
}

/**
 * Stable identity of one occurrence of an inbox item. A Task that needs the same decision again
 * after another Attempt is a new occurrence. Watchers and notifications key on this value.
 */
export function coordinationInboxOccurrence(item: CoordinationInboxItem): string {
  const task = item.evidence.find((entry) => entry.kind === "task");
  return task?.kind === "task" ? `${item.key}@${task.attemptCount}` : item.key;
}

/** One short, metadata-only sentence describing what an inbox item asks for. */
export function coordinationInboxHeadline(item: CoordinationInboxItem): string {
  const task = item.evidence.find((entry) => entry.kind === "task")?.id;
  const approval = item.approval;
  const summary = (text: string) => {
    const clean = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
    return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
  };
  switch (item.kind) {
    case "approval":
      return approval
        ? `Approval ${approval.requestId}${approval.blocking ? " (work is waiting)" : ""}: ${summary(approval.summary)} (requested by Tag ${approval.requestingTagName ?? "unknown Tag"})`
        : "An approval request waits for a decision";
    case "question":
      return `Objective ${item.objectiveId} waits on your answer`;
    case "objective_budget":
      return "The Objective budget is used up";
    case "task_attention":
      return item.uncertainAttempt
        ? `Task ${task ?? "?"} is uncertain: Attempt ${item.uncertainAttempt.attemptId} may have executed, and only an operator on Worker Host ${item.uncertainAttempt.workerHostId ?? "unknown"} can recover it`
        : `Task ${task ?? "?"} needs attention`;
    case "objective_limit":
      return summary(item.reason ?? "A budget or deadline limit was reached");
    case "mcp_login":
      return `Task ${task ?? "?"} is held until MCP server ${mcpLoginServerOfKey(item.key) ?? "?"} is logged in`;
  }
}

/** One shell word: plain values as-is, others single-quoted. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command that settles an uncertain Task Attempt. An operator runs it on the Worker Host, with
 * its host service stopped, after confirming the Attempt's execution stopped.
 */
export function uncertainAttemptRecoverCommand(
  taskId: string,
  attempt: Pick<CoordinationInboxUncertainAttempt, "attemptId" | "workerId">,
): string {
  return `supertag recover worklet --worker-id ${shellWord(attempt.workerId ?? "WORKER_ID")} --task ${shellWord(taskId)} --attempt ${shellWord(attempt.attemptId)} --confirm-stopped --reason TEXT`;
}

/** The `supertag` commands an operator runs to act on one inbox item, most direct first. */
export function coordinationInboxCommands(
  item: Pick<
    CoordinationInboxItem,
    "kind" | "key" | "objectiveId" | "evidence" | "approval" | "uncertainAttempt"
  >,
): string[] {
  const objective = shellWord(item.objectiveId ?? "OBJECTIVE");
  const task = item.evidence.find((entry) => entry.kind === "task")?.id;
  const request = item.approval?.requestId;
  switch (item.kind) {
    case "approval":
      return request
        ? [
            `supertag approve request ${shellWord(request)}`,
            `supertag deny request ${shellWord(request)} --reason TEXT`,
          ]
        : item.objectiveId === null
          ? ["supertag list approval"]
          : [`supertag list approval --objective ${objective}`];
    case "question":
      return [];
    case "objective_budget":
      return [`supertag update objective ${objective} --budget-minor N`];
    case "objective_limit":
      return item.key.includes(":deadline-")
        ? [`supertag update objective ${objective} --deadline ISO-8601`]
        : [`supertag update objective ${objective} --budget-minor N`];
    case "task_attention":
      // Run on the Worker Host with its host service stopped; see the item's reason.
      return task && item.uncertainAttempt
        ? [
            uncertainAttemptRecoverCommand(task, item.uncertainAttempt),
            `supertag describe task ${shellWord(task)}`,
          ]
        : [`supertag describe objective ${objective}`];
    case "mcp_login": {
      const server = mcpLoginServerOfKey(item.key);
      return server === undefined
        ? [`supertag describe objective ${objective}`]
        : [`supertag mcp login ${server}`, `supertag describe objective ${objective}`];
    }
  }
}

/** The server an `mcp_login` item key (`mcp_login:TASK:SERVER`) names. */
function mcpLoginServerOfKey(key: string): string | undefined {
  const server = key.slice(key.lastIndexOf(":") + 1);
  return key.startsWith("mcp_login:") && /^[a-z0-9][a-z0-9_-]{0,58}$/u.test(server)
    ? server
    : undefined;
}
