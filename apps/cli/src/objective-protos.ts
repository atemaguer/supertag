import type { MessageInitShape } from "@bufbuild/protobuf";
import { type Timestamp, timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ObjectiveOverview as ObjectiveOverviewRecord } from "@supertag/control-plane";
import {
  type ApprovalActionDescriptor,
  type ApprovalRequest,
  COORDINATION_INBOX_VERSION,
  type CoordinationInboxEvidence,
  type CoordinationInboxItem,
  type Objective as ObjectiveRecord,
  type TaskDelivery as TaskDeliveryRecord,
  type WorkstreamPost as WorkstreamPostRecord,
} from "@supertag/core";
import {
  type Approval,
  ApprovalDecider,
  ApprovalKind,
  type ApprovalSchema,
  ApprovalScope,
  ApprovalStatus,
  ApprovalTarget,
  BudgetMeasure,
  type InboxItem,
  InboxItemKind,
  type InboxItemSchema,
  InboxNotificationStatus,
  type Objective,
  ObjectiveAttentionKind,
  ObjectiveConversationAuthor,
  type ObjectiveOverview,
  type ObjectiveOverviewSchema,
  type ObjectiveSchema,
  ObjectiveSessionStatus,
  ObjectiveStatus,
  PullRequestState,
  TaskAttemptStatus,
  type TaskDelivery,
  type TaskDeliverySchema,
  TaskExplanationKind,
  TaskStatus,
  WorkspaceDeliveryMode,
  type WorkstreamPostSchema,
} from "@supertag/operator-api";

/** One enum's domain words and protobuf values, read in both directions. */
export function enumTable<W extends string, E extends number>(
  pairs: readonly (readonly [W, E])[],
  unspecified: E,
) {
  const values = new Map<string, E>(pairs);
  const words = new Map<E, W>(pairs.map(([word, value]) => [value, word]));
  return {
    value: (word: string | null | undefined): E =>
      (word === null || word === undefined ? undefined : values.get(word)) ?? unspecified,
    word: (value: E): W | undefined => words.get(value),
    words: pairs.map(([word]) => word),
  };
}

export const OBJECTIVE_STATUS = enumTable(
  [
    ["working", ObjectiveStatus.WORKING],
    ["blocked", ObjectiveStatus.BLOCKED],
    ["limited", ObjectiveStatus.LIMITED],
    ["ready_for_review", ObjectiveStatus.READY_FOR_REVIEW],
    ["completed", ObjectiveStatus.COMPLETED],
    ["cancelled", ObjectiveStatus.CANCELLED],
  ] as const,
  ObjectiveStatus.UNSPECIFIED,
);

export const INBOX_KIND = enumTable(
  [
    ["approval", InboxItemKind.APPROVAL],
    ["question", InboxItemKind.QUESTION],
    ["objective_budget", InboxItemKind.OBJECTIVE_BUDGET],
    ["objective_limit", InboxItemKind.OBJECTIVE_LIMIT],
    ["task_attention", InboxItemKind.TASK_ATTENTION],
    ["mcp_login", InboxItemKind.MCP_LOGIN],
  ] as const,
  InboxItemKind.UNSPECIFIED,
);

const NOTIFICATION_STATUS = enumTable(
  [
    ["unconfigured", InboxNotificationStatus.NOT_CONFIGURED],
    ["not configured", InboxNotificationStatus.NOT_CONFIGURED],
    ["pending", InboxNotificationStatus.PENDING],
    ["delivering", InboxNotificationStatus.DELIVERING],
    ["delivered", InboxNotificationStatus.DELIVERED],
    ["failed", InboxNotificationStatus.FAILED],
    ["unavailable", InboxNotificationStatus.UNAVAILABLE],
  ] as const,
  InboxNotificationStatus.UNSPECIFIED,
);

const APPROVAL_KIND = enumTable(
  [["surface-action", ApprovalKind.SURFACE_ACTION]] as const,
  ApprovalKind.UNSPECIFIED,
);

export const APPROVAL_STATUS = enumTable(
  [
    ["pending", ApprovalStatus.PENDING],
    ["approved", ApprovalStatus.APPROVED],
    ["denied", ApprovalStatus.DENIED],
    ["expired", ApprovalStatus.EXPIRED],
  ] as const,
  ApprovalStatus.UNSPECIFIED,
);

export const APPROVAL_SCOPE = enumTable(
  [
    ["once", ApprovalScope.ONCE],
    ["objective", ApprovalScope.OBJECTIVE],
  ] as const,
  ApprovalScope.UNSPECIFIED,
);

const APPROVAL_DECIDER = enumTable(
  [
    ["operator", ApprovalDecider.OPERATOR],
    ["tag", ApprovalDecider.TAG],
  ] as const,
  ApprovalDecider.UNSPECIFIED,
);

const APPROVAL_TARGET = enumTable(
  [
    ["surface", ApprovalTarget.SURFACE],
    ["runtime", ApprovalTarget.RUNTIME],
    ["mcp", ApprovalTarget.MCP],
  ] as const,
  ApprovalTarget.UNSPECIFIED,
);

export const TASK_STATUS = enumTable(
  [
    ["pending", TaskStatus.PENDING],
    ["running", TaskStatus.RUNNING],
    ["completed", TaskStatus.COMPLETED],
    ["failed", TaskStatus.FAILED],
    ["cancelled", TaskStatus.CANCELLED],
  ] as const,
  TaskStatus.UNSPECIFIED,
);

export const ATTEMPT_STATUS = enumTable(
  [
    ["running", TaskAttemptStatus.RUNNING],
    ["completed", TaskAttemptStatus.COMPLETED],
    ["failed", TaskAttemptStatus.FAILED],
    ["cancelled", TaskAttemptStatus.CANCELLED],
  ] as const,
  TaskAttemptStatus.UNSPECIFIED,
);

const SESSION_STATUS = enumTable(
  [
    ["queued", ObjectiveSessionStatus.QUEUED],
    ["pending", ObjectiveSessionStatus.PENDING],
    ["running", ObjectiveSessionStatus.RUNNING],
    ["waiting", ObjectiveSessionStatus.WAITING],
    ["completed", ObjectiveSessionStatus.COMPLETED],
    ["failed", ObjectiveSessionStatus.FAILED],
    ["cancelled", ObjectiveSessionStatus.CANCELLED],
  ] as const,
  ObjectiveSessionStatus.UNSPECIFIED,
);

const ATTENTION_KIND = enumTable(
  [
    ["not_started", ObjectiveAttentionKind.NOT_STARTED],
    ["objective_paused", ObjectiveAttentionKind.PAUSED],
    ["objective_cancelled", ObjectiveAttentionKind.CANCELLED],
    ["objective_blocked", ObjectiveAttentionKind.BLOCKED],
    ["objective_review", ObjectiveAttentionKind.REVIEW],
    ["owner_question", ObjectiveAttentionKind.OWNER_QUESTION],
    ["objective_budget_threshold", ObjectiveAttentionKind.BUDGET_THRESHOLD],
    ["objective_budget_exhausted", ObjectiveAttentionKind.BUDGET_EXHAUSTED],
    ["budget_coverage_incomplete", ObjectiveAttentionKind.BUDGET_COVERAGE_INCOMPLETE],
    ["objective_deadline_approaching", ObjectiveAttentionKind.DEADLINE_APPROACHING],
    ["deadline_passed", ObjectiveAttentionKind.DEADLINE_PASSED],
    ["approvals_pending", ObjectiveAttentionKind.APPROVALS_PENDING],
  ] as const,
  ObjectiveAttentionKind.UNSPECIFIED,
);

const EXPLANATION_KIND = enumTable(
  [
    ["objective_paused", TaskExplanationKind.OBJECTIVE_PAUSED],
    ["controller", TaskExplanationKind.CONTROLLER],
    ["worker_requirements", TaskExplanationKind.WORKER_REQUIREMENTS],
    ["attempt_uncertain", TaskExplanationKind.ATTEMPT_UNCERTAIN],
    ["execution_failed", TaskExplanationKind.EXECUTION_FAILED],
  ] as const,
  TaskExplanationKind.UNSPECIFIED,
);

const CONVERSATION_AUTHOR = enumTable(
  [
    ["operator", ObjectiveConversationAuthor.OPERATOR],
    ["supertag", ObjectiveConversationAuthor.SUPERTAG],
    ["owner", ObjectiveConversationAuthor.OWNER],
  ] as const,
  ObjectiveConversationAuthor.UNSPECIFIED,
);

export const DELIVERY_MODE = enumTable(
  [
    ["patch", WorkspaceDeliveryMode.PATCH],
    ["branch", WorkspaceDeliveryMode.BRANCH],
    ["pull-request", WorkspaceDeliveryMode.PULL_REQUEST],
  ] as const,
  WorkspaceDeliveryMode.UNSPECIFIED,
);

const PULL_REQUEST_STATE = enumTable(
  [
    ["draft", PullRequestState.DRAFT],
    ["ready", PullRequestState.READY],
    ["closed", PullRequestState.CLOSED],
  ] as const,
  PullRequestState.UNSPECIFIED,
);

/** A stored ISO time as a Timestamp; undefined when unset or unreadable. */
export function timestampOf(iso: string | null | undefined): Timestamp | undefined {
  if (iso === null || iso === undefined) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : timestampFromDate(date);
}

export function isoOf(timestamp: Timestamp | undefined): string | null {
  return timestamp === undefined ? null : timestampDate(timestamp).toISOString();
}

const set = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

// From stored records to operator API messages, as the Control Plane serves them.

export function objectiveMessage(
  objective: ObjectiveRecord,
  ownerName: string | undefined,
): MessageInitShape<typeof ObjectiveSchema> {
  const spend = objective.limitState?.reportedSpend;
  const summary = objective.limitState?.summary;
  return {
    id: objective.id,
    outcome: objective.outcome,
    ownerTagId: objective.ownerTagId,
    ownerTag: ownerName ?? "",
    status: OBJECTIVE_STATUS.value(objective.status),
    revision: BigInt(objective.revision),
    ongoing: objective.ongoing === true,
    ...set("deadline", timestampOf(objective.deadline)),
    ...(objective.budgetLimitMinor === null || objective.budgetLimitMinor === undefined
      ? {}
      : {
          budget: {
            limitMinor: BigInt(objective.budgetLimitMinor),
            currency: objective.budgetCurrency ?? "",
          },
        }),
    ...(spend === undefined || !objective.budgetCurrency
      ? {}
      : {
          spend: {
            amountMinor: BigInt(spend.amountMinor),
            currency: spend.currency,
            unknownCostAttempts: spend.unknownAttemptIds.length,
            estimatedCostAttempts: spend.estimatedCostAttempts ?? 0,
            ...set("observedAt", timestampOf(spend.observedAt)),
          },
        }),
    runtimeActions: [...(objective.runtimeActions ?? [])],
    workspaces: [...(objective.workspaces ?? [])],
    teamId: objective.teamId ?? "",
    completionSummary: objective.completionSummary ?? "",
    ...(summary === undefined
      ? {}
      : { limitSummary: { text: summary.text, ...set("writtenAt", timestampOf(summary.at)) } }),
    ...set("executionStartedAt", timestampOf(objective.executionStartedAt)),
    ...set("pausedAt", timestampOf(objective.pausedAt)),
    ...set("cancelledAt", timestampOf(objective.cancelledAt)),
    cancellationReason: objective.cancellationReason ?? "",
    surfaceTaskId: objective.surfaceTaskId ?? "",
    notificationTaskId: objective.notificationTaskId ?? "",
    ...set("createdAt", timestampOf(objective.createdAt)),
    ...set("updatedAt", timestampOf(objective.updatedAt)),
  };
}

function approvalAction(action: ApprovalActionDescriptor) {
  return {
    target: APPROVAL_TARGET.value(action.target),
    action: action.action,
    surfaceAccountId: action.surfaceAccountId ?? "",
    scope: action.scope ?? "",
    resource: action.resource ?? "",
    provider: action.provider ?? "",
    toolName: action.toolName ?? "",
  };
}

export function approvalMessage(request: ApprovalRequest): MessageInitShape<typeof ApprovalSchema> {
  return {
    id: request.id,
    objectiveId: request.objectiveId ?? "",
    taskId: request.taskId,
    attemptId: request.attemptId ?? "",
    requestingTagId: request.requestingTagId,
    kind: APPROVAL_KIND.value(request.kind),
    actions: request.actions.map(approvalAction),
    argumentsDigest: request.argumentsDigest ?? "",
    summary: request.summary,
    ruleSources: [...request.ruleSources],
    approvers: [...request.approvers],
    status: APPROVAL_STATUS.value(request.status),
    scope: APPROVAL_SCOPE.value(request.scope),
    ...set("validUntil", timestampOf(request.validUntil)),
    decidedBy: request.decidedBy ?? "",
    decidedByKind: APPROVAL_DECIDER.value(request.decidedByKind),
    ...set("decidedAt", timestampOf(request.decidedAt)),
    reason: request.reason ?? "",
    ...set("consumedAt", timestampOf(request.consumedAt)),
    ...set("createdAt", timestampOf(request.createdAt)),
    ...set("updatedAt", timestampOf(request.updatedAt)),
  };
}

function inboxEvidence(entry: CoordinationInboxEvidence) {
  if (entry.kind === "task")
    return {
      record: {
        case: "task" as const,
        value: {
          id: entry.id,
          status: TASK_STATUS.value(entry.status),
          attemptCount: entry.attemptCount,
          ...set("updatedAt", timestampOf(entry.updatedAt)),
        },
      },
    };
  if (entry.kind === "objective")
    return {
      record: {
        case: "objective" as const,
        value: { id: entry.id, revision: BigInt(entry.revision) },
      },
    };
  return { record: { case: "approvalRequestId" as const, value: entry.id } };
}

/** Identifies one occurrence of an inbox item; see `InboxItem.occurrence`. */
function inboxOccurrence(item: CoordinationInboxItem): string {
  const task = item.evidence.find((entry) => entry.kind === "task");
  return task?.kind === "task" ? `${item.key}@${task.attemptCount}` : item.key;
}

export function inboxItemMessage(
  item: CoordinationInboxItem,
): MessageInitShape<typeof InboxItemSchema> {
  return {
    key: item.key,
    occurrence: inboxOccurrence(item),
    kind: INBOX_KIND.value(item.kind),
    reason: item.reason ?? "",
    objectiveId: item.objectiveId ?? "",
    nextActorTagIds: [...item.nextActorTagIds],
    excludedActorTagIds: [...item.excludedActorTagIds],
    operatorEligible: item.operatorEligible,
    ...set("actionableSince", timestampOf(item.actionableSince)),
    ...set("deadline", timestampOf(item.deadline)),
    evidence: item.evidence.map(inboxEvidence),
    ...(item.approval === undefined
      ? {}
      : {
          approval: {
            requestId: item.approval.requestId,
            kind: APPROVAL_KIND.value(item.approval.requestKind),
            summary: item.approval.summary,
            requestingTagId: item.approval.requestingTagId,
            requestingTag: item.approval.requestingTagName ?? "",
            taskId: item.approval.taskId,
            blocking: item.approval.blocking,
          },
        }),
    ...(item.question === undefined
      ? {}
      : {
          question: {
            text: item.question.text,
            ...set("askedAt", timestampOf(item.question.createdAt)),
            truncated: item.question.truncated,
          },
        }),
    ...(item.uncertainAttempt === undefined
      ? {}
      : {
          uncertainAttempt: {
            attemptId: item.uncertainAttempt.attemptId,
            workerHostId: item.uncertainAttempt.workerHostId ?? "",
            workerId: item.uncertainAttempt.workerId ?? "",
          },
        }),
    commands: [...(item.commands ?? [])],
    ...(item.notification === undefined
      ? {}
      : {
          notification: {
            status: NOTIFICATION_STATUS.value(item.notification.status),
            reason: item.notification.reason ?? "",
          },
        }),
  };
}

export function deliveryMessage(
  delivery: TaskDeliveryRecord,
): MessageInitShape<typeof TaskDeliverySchema> {
  const workspace = delivery.workspace;
  const pullRequest = delivery.pullRequest;
  return {
    ...(workspace === undefined
      ? {}
      : {
          workspace: {
            name: workspace.name,
            mode: DELIVERY_MODE.value(workspace.delivery),
            branch: workspace.branch,
            ref: workspace.ref ?? "",
            head: workspace.head ?? "",
            ...set("changedFiles", workspace.changedFiles),
            base: workspace.base ?? "",
          },
        }),
    patches: delivery.patches.map(({ artifactId, path }) => ({ artifactId, path })),
    ...(pullRequest === undefined
      ? {}
      : {
          pullRequest: {
            surfaceAccountId: pullRequest.surfaceAccountId ?? "",
            repository: pullRequest.repository,
            number: pullRequest.number,
            url: pullRequest.url,
            state: PULL_REQUEST_STATE.value(pullRequest.state),
            lastError: pullRequest.lastError ?? "",
            ...set("nextAttemptAt", timestampOf(pullRequest.nextAttemptAt)),
          },
        }),
    outputs: delivery.outputs.map(({ artifactId, paths }) => ({ artifactId, paths: [...paths] })),
  };
}

export function workstreamPostMessage(
  post: WorkstreamPostRecord,
): MessageInitShape<typeof WorkstreamPostSchema> {
  return {
    id: post.id,
    teamId: post.teamId,
    authorTagId: post.authorTagId,
    toTagIds: [...post.to],
    body: post.body,
    sourceTaskId: post.sourceTaskId ?? "",
    sequence: BigInt(post.sequence),
    ...set("createdAt", timestampOf(post.createdAt)),
  };
}

const bigintRecord = (record: Readonly<Record<string, number>> | null | undefined) =>
  Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, BigInt(value)]));

/** The operator API form of the Control Plane's Objective overview. */
export function overviewMessage(
  view: ObjectiveOverviewRecord,
  ownerName: string | undefined,
  nextPageToken: string,
): MessageInitShape<typeof ObjectiveOverviewSchema> {
  const { limits, pool, objectiveSpend } = view;
  const bigint = (value: number | null | undefined) =>
    value === null || value === undefined ? undefined : BigInt(value);
  return {
    ...set("capturedAt", timestampOf(view.capturedAt)),
    objective: objectiveMessage(view.objective, ownerName),
    executionReadiness: view.executionReadiness,
    conditions: view.conditions.map(({ type, status, reasons }) => ({
      type,
      status,
      reasons: [...reasons],
    })),
    attention: view.attention.map((item) => ({
      kind: ATTENTION_KIND.value(item.kind),
      message: item.message,
      nextAction: item.nextAction,
      ...set("observedAt", timestampOf(item.observedAt)),
    })),
    ...(view.approvals === undefined
      ? {}
      : {
          approvals: {
            pending: view.approvals.pending,
            approvedLastDay: view.approvals.decidedLastDay.approved,
            deniedLastDay: view.approvals.decidedLastDay.denied,
          },
        }),
    tagNames: { ...view.tagNames },
    ...(view.team === null
      ? {}
      : {
          team: {
            id: view.team.id,
            name: view.team.name,
            memberTagIds: [...view.team.memberTagIds],
            ...set("maxConcurrency", view.team.maxConcurrency),
          },
        }),
    limits: {
      ...(limits.deadline === null
        ? {}
        : {
            deadline: {
              ...set("at", timestampOf(limits.deadline.at)),
              minutesRemaining: limits.deadline.minutesRemaining,
              remaining: limits.deadline.remaining,
              passed: limits.deadline.passed,
              graceMinutes: Math.round(limits.deadline.graceMinutes),
              notices: limits.deadline.notices.map((notice) => ({
                kind: notice.kind,
                ...set("at", timestampOf(notice.at)),
                message: notice.message,
              })),
              guidance: limits.deadline.guidance,
            },
          }),
      ...(limits.budget === null
        ? {}
        : {
            budget:
              limits.budget.measure === "provider_reported_cost"
                ? {
                    measure: BudgetMeasure.PROVIDER_REPORTED_COST,
                    limit: {
                      limitMinor: BigInt(limits.budget.limitMinor),
                      currency: limits.budget.currency ?? "",
                    },
                    ...set("reportedSpentMinor", bigint(limits.budget.reportedSpentMinor)),
                    overrunMinor: BigInt(limits.budget.overrunMinor),
                    ...set(
                      "reportedSpendObservedAt",
                      timestampOf(limits.budget.reportedSpendObservedAt),
                    ),
                    unknownCostAttempts: limits.budget.unknownCostAttempts,
                    exhausted: limits.budget.exhausted,
                    guidance: limits.budget.guidance,
                  }
                : {
                    measure: BudgetMeasure.UNMEASURED,
                    limit: { limitMinor: BigInt(limits.budget.limitMinor), currency: "" },
                    guidance: limits.budget.guidance,
                  },
          }),
    },
    budget: {
      currency: pool.currency ?? "",
      ...set("limitMinor", bigint(pool.limitMinor)),
      ...set("spentMinor", bigint(pool.spentMinor)),
      ...set("availableMinor", bigint(pool.availableMinor)),
      attempts: objectiveSpend.attempts,
      reportedCostByCurrency: bigintRecord(objectiveSpend.reportedCostByCurrency),
      unknownCostAttempts: objectiveSpend.unknownCostAttempts,
      estimatedCostAttempts: objectiveSpend.estimatedCostAttempts ?? 0,
      unpricedModels: { ...objectiveSpend.unpricedModels },
      unpricedTokens: BigInt(objectiveSpend.unpricedTokens ?? 0),
      ...set("reportedTokens", bigint(objectiveSpend.reportedTokens)),
      unknownTokenAttempts: objectiveSpend.unknownTokenAttempts,
    },
    conversation: view.conversation.map((entry) => ({
      taskId: entry.taskId,
      author: CONVERSATION_AUTHOR.value(entry.from),
      operatorId: entry.operatorId ?? "",
      text: entry.text,
      ...set("createdAt", timestampOf(entry.createdAt)),
    })),
    sessions: view.sessions.map((session) => ({
      id: session.id,
      tagId: session.tagId,
      tag: view.tagNames[session.tagId] ?? "",
      owner: session.owner,
      title: session.title ?? "",
      parentSessionId: session.parentSessionId ?? "",
      status: SESSION_STATUS.value(session.status),
      question: session.question ?? "",
      approvalRequestIds: [...(session.approvals ?? [])],
      taskCount: session.taskCount,
      ...set("createdAt", timestampOf(session.createdAt)),
      ...(session.task === undefined
        ? {}
        : {
            latestTask: {
              id: session.task.id,
              status: SESSION_STATUS.value(session.task.status),
              ...set("createdAt", timestampOf(session.task.createdAt)),
              ...set("updatedAt", timestampOf(session.task.updatedAt)),
              question: session.task.question ?? "",
              workspace: session.task.workspace ?? "",
              ...(session.task.delivery === null
                ? {}
                : { delivery: deliveryMessage(session.task.delivery) }),
              attemptStatus: ATTEMPT_STATUS.value(session.task.attemptStatus),
              report: session.task.report ?? "",
              explanations: session.task.explanations.map((explanation) => ({
                kind: EXPLANATION_KIND.value(explanation.kind),
                message: explanation.message,
                nextAction: explanation.nextAction,
                ...set("observedAt", timestampOf(explanation.observedAt)),
                harness: explanation.harness ?? "",
                failureKind: explanation.failureKind ?? "",
              })),
            },
          }),
    })),
    highFindings: view.highFindings.map((finding) => ({
      taskId: finding.taskId,
      id: finding.id,
      summary: finding.summary,
      location: finding.location ?? "",
    })),
    posts: view.posts.map(workstreamPostMessage),
    writes: view.writes.map((write) => ({
      volume: write.volume,
      files: BigInt(write.files),
      bytes: BigInt(write.bytes),
      partial: write.partial,
      refused: write.refused,
    })),
    tasks: view.tasks.map((task) => ({
      id: task.taskId,
      sessionId: task.sessionId,
      tagId: task.tagId,
      status: TASK_STATUS.value(task.status),
      request: task.request ?? "",
      response: task.response ?? "",
      ...set("createdAt", timestampOf(task.createdAt)),
      ...set("startedAt", timestampOf(task.startedAt)),
      ...set("endedAt", timestampOf(task.endedAt)),
      attempts: task.attempts.map((attempt) => ({
        id: attempt.id,
        number: attempt.number,
        status: ATTEMPT_STATUS.value(attempt.status),
        ...set("startedAt", timestampOf(attempt.startedAt)),
        ...set("endedAt", timestampOf(attempt.endedAt)),
        workerProfile: attempt.workerProfile.id,
      })),
    })),
    totalTasks: view.total,
    nextPageToken,
  };
}

// From operator API messages to the records the CLI shows, so its text output stays the same.

/** An Objective as the CLI shows it. */
export interface ObjectiveView {
  readonly id: string;
  readonly outcome: string;
  readonly ownerTagId: string;
  readonly status: string;
  readonly revision: number;
  readonly deadline: string | null;
  readonly budgetLimitMinor: number | null;
  readonly budgetCurrency: string | null;
  /** Provider-reported spend against a budget in a currency. */
  readonly reportedSpendMinor: number | null;
  readonly runtimeActions: readonly string[];
  readonly workspaces: readonly string[];
  readonly teamId: string | null;
  readonly completionSummary: string | null;
  readonly limitSummary: string | null;
  readonly cancelledAt: string | null;
  readonly cancellationReason: string | null;
  readonly surfaceTaskId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const text = (value: string) => (value === "" ? null : value);

export function objectiveView(objective: Objective): ObjectiveView {
  return {
    id: objective.id,
    outcome: objective.outcome,
    ownerTagId: objective.ownerTagId,
    status: OBJECTIVE_STATUS.word(objective.status) ?? "unknown",
    revision: Number(objective.revision),
    deadline: isoOf(objective.deadline),
    budgetLimitMinor: objective.budget === undefined ? null : Number(objective.budget.limitMinor),
    budgetCurrency: objective.budget === undefined ? null : text(objective.budget.currency),
    reportedSpendMinor: objective.spend === undefined ? null : Number(objective.spend.amountMinor),
    runtimeActions: objective.runtimeActions,
    workspaces: objective.workspaces,
    teamId: text(objective.teamId),
    completionSummary: text(objective.completionSummary),
    limitSummary: objective.limitSummary === undefined ? null : objective.limitSummary.text,
    cancelledAt: isoOf(objective.cancelledAt),
    cancellationReason: text(objective.cancellationReason),
    surfaceTaskId: text(objective.surfaceTaskId),
    createdAt: isoOf(objective.createdAt) ?? "",
    updatedAt: isoOf(objective.updatedAt) ?? "",
  };
}

export function approvalRecord(approval: Approval): ApprovalRequest {
  return {
    id: approval.id,
    objectiveId: text(approval.objectiveId),
    taskId: approval.taskId,
    attemptId: text(approval.attemptId),
    requestingTagId: approval.requestingTagId,
    kind: APPROVAL_KIND.word(approval.kind) ?? "surface-action",
    actions: approval.actions.map((action) => ({
      target: APPROVAL_TARGET.word(action.target) ?? "runtime",
      action: action.action,
      ...set("surfaceAccountId", text(action.surfaceAccountId)),
      ...set("scope", text(action.scope)),
      ...set("resource", text(action.resource)),
      ...set("provider", text(action.provider)),
      ...set("toolName", text(action.toolName)),
    })),
    argumentsDigest: text(approval.argumentsDigest),
    summary: approval.summary,
    ruleSources: approval.ruleSources,
    approvers: approval.approvers,
    status: APPROVAL_STATUS.word(approval.status) ?? "pending",
    scope: APPROVAL_SCOPE.word(approval.scope) ?? null,
    validUntil: isoOf(approval.validUntil),
    decidedBy: text(approval.decidedBy),
    decidedByKind: APPROVAL_DECIDER.word(approval.decidedByKind) ?? null,
    decidedAt: isoOf(approval.decidedAt),
    reason: text(approval.reason),
    consumedAt: isoOf(approval.consumedAt),
    createdAt: isoOf(approval.createdAt) ?? "",
    updatedAt: isoOf(approval.updatedAt) ?? "",
  };
}

export function inboxItemRecord(item: InboxItem, asOf: Date): CoordinationInboxItem {
  const actionableSince = isoOf(item.actionableSince) ?? "";
  return {
    projectionVersion: COORDINATION_INBOX_VERSION,
    key: item.key,
    kind: INBOX_KIND.word(item.kind) ?? "task_attention",
    status: "pending",
    ...set("reason", text(item.reason)),
    objectiveId: text(item.objectiveId),
    nextActorTagIds: item.nextActorTagIds,
    excludedActorTagIds: item.excludedActorTagIds,
    operatorEligible: item.operatorEligible,
    actionableSince,
    ageSeconds: Math.max(0, Math.floor((asOf.getTime() - Date.parse(actionableSince)) / 1000)),
    deadline: isoOf(item.deadline),
    evidence: item.evidence.flatMap((entry): CoordinationInboxEvidence[] => {
      const record = entry.record;
      if (record.case === "task")
        return [
          {
            kind: "task",
            id: record.value.id,
            status: TASK_STATUS.word(record.value.status) ?? "pending",
            attemptCount: record.value.attemptCount,
            updatedAt: isoOf(record.value.updatedAt) ?? "",
          },
        ];
      if (record.case === "objective")
        return [
          { kind: "objective", id: record.value.id, revision: Number(record.value.revision) },
        ];
      if (record.case === "approvalRequestId")
        return [{ kind: "approval_request", id: record.value }];
      return [];
    }),
    permittedActions: [],
    ...(item.approval === undefined
      ? {}
      : {
          approval: {
            requestId: item.approval.requestId,
            requestKind: "surface-action" as const,
            summary: item.approval.summary,
            requestingTagId: item.approval.requestingTagId,
            ...set("requestingTagName", text(item.approval.requestingTag)),
            taskId: item.approval.taskId,
            blocking: item.approval.blocking,
          },
        }),
    ...(item.question === undefined
      ? {}
      : {
          question: {
            text: item.question.text,
            createdAt: isoOf(item.question.askedAt) ?? "",
            truncated: item.question.truncated,
          },
        }),
    ...(item.uncertainAttempt === undefined
      ? {}
      : {
          uncertainAttempt: {
            attemptId: item.uncertainAttempt.attemptId,
            ...set("workerHostId", text(item.uncertainAttempt.workerHostId)),
            ...set("workerId", text(item.uncertainAttempt.workerId)),
          },
        }),
    commands: item.commands,
    ...(item.notification === undefined
      ? {}
      : {
          notification: {
            status: NOTIFICATION_STATUS.word(item.notification.status) ?? "unavailable",
            ...set("reason", text(item.notification.reason)),
          },
        }),
    redaction: { level: "metadata_only", omitted: [] },
  };
}

export function deliveryRecord(delivery: TaskDelivery): TaskDeliveryRecord {
  const workspace = delivery.workspace;
  const pullRequest = delivery.pullRequest;
  return {
    ...(workspace === undefined
      ? {}
      : {
          workspace: {
            name: workspace.name,
            delivery: DELIVERY_MODE.word(workspace.mode) ?? "branch",
            branch: workspace.branch,
            ...set("ref", text(workspace.ref)),
            ...set("head", text(workspace.head)),
            ...set("changedFiles", workspace.changedFiles),
            ...set("base", text(workspace.base)),
          },
        }),
    patches: delivery.patches.map(({ artifactId, path }) => ({ artifactId, path })),
    ...(pullRequest === undefined
      ? {}
      : {
          pullRequest: {
            ...set("surfaceAccountId", text(pullRequest.surfaceAccountId)),
            repository: pullRequest.repository,
            number: pullRequest.number,
            url: pullRequest.url,
            state: PULL_REQUEST_STATE.word(pullRequest.state) ?? "draft",
            ...set("lastError", text(pullRequest.lastError)),
            ...set("nextAttemptAt", isoOf(pullRequest.nextAttemptAt)),
          },
        }),
    outputs: delivery.outputs.map(({ artifactId, paths }) => ({ artifactId, paths })),
  };
}

/** A Session's latest Task as the CLI shows it. */
export interface ObjectiveSessionTaskView {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly question?: string;
  readonly workspace: string | null;
  readonly delivery: TaskDeliveryRecord | null;
  readonly attemptStatus?: string;
  readonly explanations: readonly {
    readonly kind: string;
    readonly message: string;
    readonly nextAction: string;
    readonly harness?: string;
    readonly failureKind?: string;
  }[];
}

export interface ObjectiveSessionView {
  readonly id: string;
  readonly tagId: string;
  readonly owner: boolean;
  readonly title?: string;
  readonly status: string;
  readonly question?: string;
  readonly createdAt: string;
  readonly task?: ObjectiveSessionTaskView;
}

/** An Objective overview as the CLI shows it. */
export interface ObjectiveOverviewView {
  readonly objective: ObjectiveView;
  readonly tagNames: Readonly<Record<string, string>>;
  readonly team: {
    readonly name: string;
    readonly memberTagIds: readonly string[];
    readonly maxConcurrency: number | null;
  } | null;
  readonly conditions: readonly {
    readonly type: string;
    readonly status: boolean;
    readonly reasons: readonly string[];
  }[];
  readonly attention: readonly {
    readonly kind: string;
    readonly message: string;
    readonly nextAction: string;
  }[];
  readonly approvals?: {
    readonly pending: number;
    readonly decidedLastDay: { readonly approved: number; readonly denied: number };
  };
  readonly pool: {
    readonly limitMinor: number | null;
    readonly currency: string | null;
    readonly spentMinor: number | null;
  };
  readonly unpricedModels: Readonly<Record<string, number>>;
  readonly sessions: readonly ObjectiveSessionView[];
  readonly highFindings: readonly {
    readonly taskId: string;
    readonly id: string;
    readonly summary: string;
    readonly location?: string;
  }[];
  readonly writes: readonly {
    readonly volume: string;
    readonly files: number;
    readonly bytes: number;
    readonly partial: number;
    readonly refused: number;
  }[];
}

export function overviewView(overview: ObjectiveOverview): ObjectiveOverviewView {
  if (overview.objective === undefined) throw new Error("The Objective overview has no Objective");
  const objective = objectiveView(overview.objective);
  const budget = overview.budget;
  const number = (value: bigint | undefined) => (value === undefined ? null : Number(value));
  return {
    objective,
    tagNames: overview.tagNames,
    team:
      overview.team === undefined
        ? null
        : {
            name: overview.team.name,
            memberTagIds: overview.team.memberTagIds,
            maxConcurrency: overview.team.maxConcurrency ?? null,
          },
    conditions: overview.conditions,
    attention: overview.attention.map((item) => ({
      kind: ATTENTION_KIND.word(item.kind) ?? "unknown",
      message: item.message,
      nextAction: item.nextAction,
    })),
    ...(overview.approvals === undefined
      ? {}
      : {
          approvals: {
            pending: overview.approvals.pending,
            decidedLastDay: {
              approved: overview.approvals.approvedLastDay,
              denied: overview.approvals.deniedLastDay,
            },
          },
        }),
    pool: {
      limitMinor: number(budget?.limitMinor),
      currency: budget === undefined ? null : text(budget.currency),
      spentMinor: number(budget?.spentMinor),
    },
    unpricedModels: budget?.unpricedModels ?? {},
    sessions: overview.sessions.map((session) => {
      const task = session.latestTask;
      return {
        id: session.id,
        tagId: session.tagId,
        owner: session.owner,
        ...set("title", text(session.title)),
        status: SESSION_STATUS.word(session.status) ?? "queued",
        ...set("question", text(session.question)),
        createdAt: isoOf(session.createdAt) ?? "",
        ...(task === undefined
          ? {}
          : {
              task: {
                id: task.id,
                status: SESSION_STATUS.word(task.status) ?? "pending",
                createdAt: isoOf(task.createdAt) ?? "",
                updatedAt: isoOf(task.updatedAt) ?? "",
                ...set("question", text(task.question)),
                workspace: text(task.workspace),
                delivery: task.delivery === undefined ? null : deliveryRecord(task.delivery),
                ...set("attemptStatus", ATTEMPT_STATUS.word(task.attemptStatus)),
                explanations: task.explanations.map((explanation) => ({
                  kind: EXPLANATION_KIND.word(explanation.kind) ?? "unknown",
                  message: explanation.message,
                  nextAction: explanation.nextAction,
                  ...set("harness", text(explanation.harness)),
                  ...set("failureKind", text(explanation.failureKind)),
                })),
              },
            }),
      };
    }),
    highFindings: overview.highFindings.map((finding) => ({
      taskId: finding.taskId,
      id: finding.id,
      summary: finding.summary,
      ...set("location", text(finding.location)),
    })),
    writes: overview.writes.map((write) => ({
      volume: write.volume,
      files: Number(write.files),
      bytes: Number(write.bytes),
      partial: write.partial,
      refused: write.refused,
    })),
  };
}
