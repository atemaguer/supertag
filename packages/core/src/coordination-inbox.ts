/** Version of the durable operator inbox projection contract. */
export const COORDINATION_INBOX_VERSION = 7 as const;

export const COORDINATION_INBOX_KINDS = [
  "task_approval",
  "task_review",
  "task_budget",
  "objective_budget",
  "operator_message",
  "task_attention",
  "objective_limit",
  "objective_ready_for_review",
  "objective_completed",
  "approval",
  "mcp_login",
] as const;
export type CoordinationInboxKind = (typeof COORDINATION_INBOX_KINDS)[number];
export type CoordinationInboxStatus = "pending";

export type CoordinationInboxEvidence =
  | { readonly kind: "message"; readonly id: string }
  | {
      readonly kind: "task";
      readonly id: string;
      readonly status: string;
      readonly attemptCount: number;
      readonly updatedAt: string;
    }
  | { readonly kind: "objective"; readonly id: string; readonly revision: number }
  | { readonly kind: "team"; readonly id: string; readonly revision: number }
  | { readonly kind: "approval_request"; readonly id: string };

/** A partial invocation of a public primitive plus fields the operator must still supply. */
export interface CoordinationInboxAction {
  readonly tool: "update_task" | "update_objective" | "send_message" | "decide_approval";
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
  readonly objectiveId: string;
  readonly teamId: string;
  readonly nextActorTagIds: readonly string[];
  readonly excludedActorTagIds: readonly string[];
  readonly operatorEligible: boolean;
  readonly actionableSince: string;
  readonly ageSeconds: number;
  readonly deadline: string | null;
  readonly evidence: readonly CoordinationInboxEvidence[];
  readonly permittedActions: readonly CoordinationInboxAction[];
  /**
   * The pending approval request an `approval` item stands for, or the request that holds a
   * `task_approval` Task.
   */
  readonly approval?: CoordinationInboxApproval;
  /**
   * For an `operator_message` item read by an operator who may read the whole Objective: the
   * owner's message text, cut to {@link COORDINATION_INBOX_MESSAGE_LIMIT} characters, and when
   * the owner sent it.
   */
  readonly message?: CoordinationInboxMessage;
  /**
   * For a `task_attention` item about a running Task whose Attempt is uncertain: the Attempt and
   * where its journal is, which name the `supertag recover worklet` command in `commands`.
   */
  readonly uncertainAttempt?: CoordinationInboxUncertainAttempt;
  /** `supertag` commands that act on the item, most direct first. */
  readonly commands?: readonly string[];
  /** Delivery state for the existing operator or manager escalation route. */
  readonly notification?: {
    readonly status:
      | "unconfigured"
      | "pending"
      | "delivering"
      | "delivered"
      | "failed"
      | "manager"
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

/** Longest owner message text an inbox item carries; longer text ends with `…`. */
export const COORDINATION_INBOX_MESSAGE_LIMIT = 500;

export interface CoordinationInboxMessage {
  readonly text: string;
  readonly createdAt: string;
  /** The stored message is longer than `text`; read it with `read_mailbox`. */
  readonly truncated: boolean;
}

/** The bounded inbox form of an owner message body. */
export function coordinationInboxMessage(
  text: string,
  createdAt: string,
): CoordinationInboxMessage {
  const truncated = text.length > COORDINATION_INBOX_MESSAGE_LIMIT;
  return {
    text: truncated ? `${text.slice(0, COORDINATION_INBOX_MESSAGE_LIMIT - 1)}…` : text,
    createdAt,
    truncated,
  };
}

export interface CoordinationInboxApproval {
  readonly requestId: string;
  readonly requestKind: "surface-action" | "task" | "plan";
  readonly summary: string;
  readonly requestingTagId: string;
  readonly requestingTagName?: string;
  readonly taskId: string;
  /** A running Task Attempt waits on this decision. */
  readonly blocking: boolean;
}

export interface CoordinationInboxFilter {
  readonly objectiveId?: string;
  readonly teamId?: string;
  readonly kind?: CoordinationInboxKind;
  readonly status?: CoordinationInboxStatus;
  readonly nextActorId?: string;
}

export interface ReadCoordinationInboxInput extends CoordinationInboxFilter {
  /** Include approval requests; false for principals that may not list them. Defaults to true. */
  readonly includeApprovals?: boolean;
  /**
   * Include notify-only items (Objective completion) that need no operator action. Only the
   * notification outbox reads them; listing the inbox leaves them out unless filtered by kind.
   */
  readonly includeNotices?: boolean;
  /** Only derive completion notices recorded at or after this time for notification scans. */
  readonly includeNoticesSince?: string;
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
    case "task_approval":
      return `Task ${task ?? "?"} is held for approval${approval ? ` (request ${approval.requestId})` : ""}`;
    case "task_review":
      return `Task ${task ?? "?"} was submitted for review`;
    case "task_budget":
      return `Task ${task ?? "?"} stopped at its budget`;
    case "objective_budget":
      return "The Objective allocation is used up";
    case "operator_message":
      return "The Objective owner sent you a message";
    case "task_attention":
      if (item.key === `task_attention:objective:${item.objectiveId}:stalled`)
        return `Objective ${item.objectiveId} needs owner attention`;
      return item.uncertainAttempt
        ? `Task ${task ?? "?"} is uncertain: Attempt ${item.uncertainAttempt.attemptId} may have executed, and only an operator on Worker Host ${item.uncertainAttempt.workerHostId ?? "unknown"} can recover it`
        : `Task ${task ?? "?"} needs attention`;
    case "objective_limit":
      return summary(item.reason ?? "A budget or deadline limit was reached");
    case "objective_ready_for_review":
      return `Objective ${item.objectiveId} is ready for review`;
    case "objective_completed":
      return `Objective ${item.objectiveId} completed`;
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
  const objective = shellWord(item.objectiveId);
  const task = item.evidence.find((entry) => entry.kind === "task")?.id;
  const request = item.approval?.requestId;
  switch (item.kind) {
    case "approval":
    case "task_approval":
      return request
        ? [
            `supertag approve request ${shellWord(request)}`,
            `supertag deny request ${shellWord(request)} --reason TEXT`,
          ]
        : [`supertag list approval --objective ${objective}`];
    case "operator_message":
      return [`supertag message objective ${objective} TEXT`];
    case "objective_budget":
      return [`supertag update objective ${objective} --budget-minor N`];
    case "objective_limit":
      return item.key.includes(":deadline-")
        ? [`supertag update objective ${objective} --deadline ISO-8601`]
        : [`supertag update objective ${objective} --budget-minor N`];
    case "objective_ready_for_review":
    case "objective_completed":
      return [`supertag describe objective ${objective}`];
    case "task_review":
      return task
        ? [
            `supertag coordinate update_task --input ${shellWord(`${task}-accept-review.json`)}`,
            `supertag coordinate update_task --input ${shellWord(`${task}-reject-review.json`)}`,
            `supertag describe task ${shellWord(task)}`,
          ]
        : [`supertag describe objective ${objective}`];
    case "task_budget":
      return task
        ? [
            `supertag coordinate update_task --input ${shellWord(`${task}-renew-budget.json`)}`,
            `supertag describe task ${shellWord(task)}`,
          ]
        : [`supertag describe objective ${objective}`];
    case "task_attention":
      if (item.key === `task_attention:objective:${item.objectiveId}:stalled`)
        return [`supertag message objective ${objective} TEXT`];
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
