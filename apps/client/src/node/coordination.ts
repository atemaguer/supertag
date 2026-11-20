/**
 * Objectives, the operator inbox, Teams and their Workstreams, and Work Sessions, read and acted
 * on through one Gateway client and converted to the view types of `@supertag/client/model`.
 * `GatewayState` runs these on its current connection.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ApprovalScope,
  ApprovalState,
  AttemptCleanup,
  AttemptDecision,
  InboxItemKind,
  ObjectiveStatus,
  type Approval as ProtoApproval,
  type InboxItem as ProtoInboxItem,
  type Objective as ProtoObjective,
  type Team as ProtoTeam,
  type WorkSession as ProtoWorkSession,
  type WorkstreamPost as ProtoWorkstreamPost,
  TaskEventKind,
  TaskState,
  WorkSessionCloseReason,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import type {
  ApprovalDetails,
  InboxItem,
  InboxKind,
  NewObjective,
  Objective,
  Team,
  UncertainAttempt,
  WorkBranch,
  WorkSession,
  WorkstreamPost,
} from "../model/coordination";
import { resolutionEvidence } from "../model/coordination";
import type { AttemptDecisionName } from "../model/gateway";
import { compact, enumName, num, optionalNum } from "./convert";
import { rpc, rpcError, statusOf } from "./errors";
import { Code, type GatewayClient } from "./sdk";
import { CALL, MAX_PAGES } from "./session";

const STATUSES: Record<number, Objective["status"]> = {
  [ObjectiveStatus.WORKING]: "working",
  [ObjectiveStatus.BLOCKED]: "blocked",
  [ObjectiveStatus.LIMITED]: "limited",
  [ObjectiveStatus.READY_FOR_REVIEW]: "ready_for_review",
  [ObjectiveStatus.COMPLETED]: "completed",
  [ObjectiveStatus.CANCELLED]: "cancelled",
};

export function objective(value: ProtoObjective): Objective {
  const limit = optionalNum(value.budgetLimitMinor);
  return compact({
    objectiveId: value.objectiveId,
    ownerTagId: value.ownerTagId,
    sessionId: value.sessionId,
    outcome: value.outcome,
    status: STATUSES[value.status] ?? "unspecified",
    revision: num(value.revision),
    ongoing: value.ongoing,
    startingTaskId: value.startingTaskId,
    deadlineMs: optionalNum(value.deadlineMs),
    budget:
      limit === undefined ? undefined : { minor: limit, currency: value.budgetCurrency ?? "" },
    spentMinor: optionalNum(value.reportedSpendMinor),
    pausedAtMs: optionalNum(value.pausedAtMs),
    idleSinceMs: optionalNum(value.idleSinceMs),
    completionSummary: value.completionSummary || undefined,
    createdBy: value.createdBy,
  } as Objective);
}

const KINDS: Record<number, InboxKind> = {
  [InboxItemKind.QUESTION]: "question",
  [InboxItemKind.APPROVAL]: "approval",
  [InboxItemKind.OBJECTIVE_BUDGET]: "budget",
  [InboxItemKind.OBJECTIVE_LIMIT]: "limit",
  [InboxItemKind.TASK_ATTENTION]: "attention",
  [InboxItemKind.MCP_LOGIN]: "mcp_login",
};

/** What the execution report says of an Attempt's cleanup, as one word: `confirmed`. */
function cleanupWord(value: AttemptCleanup | undefined): string {
  return enumName(AttemptCleanup, value ?? AttemptCleanup.UNSPECIFIED);
}

function uncertainAttempt(
  value: NonNullable<ProtoInboxItem["uncertainAttempt"]>,
): UncertainAttempt {
  const autoResolveAtMs = num(value.autoResolveAtMs);
  return compact({
    tagId: value.tagId,
    sessionId: value.sessionId,
    blockedTasks: value.blockedTasks,
    cleanup: cleanupWord(value.executionReport?.cleanup),
    complete: value.executionReport?.complete ?? false,
    autoResolveAtMs: autoResolveAtMs > 0 ? autoResolveAtMs : undefined,
    heldReason: value.heldReason || undefined,
  } as UncertainAttempt);
}

export function inboxItem(item: ProtoInboxItem): InboxItem {
  const approval = item.approval;
  let summary = approval?.action ?? "";
  if (approval?.resource) summary += ` on ${approval.resource}`;
  if (approval?.summary && approval.summary !== summary) summary += ` · ${approval.summary}`;
  return compact({
    key: item.key,
    kind: KINDS[item.kind] ?? "attention",
    objectiveId: item.objectiveId,
    taskId: item.taskId,
    attemptId: item.attemptId,
    reason: item.reason,
    actionableSinceMs: num(item.actionableSinceMs),
    question: item.question
      ? {
          text: item.question.text,
          askedAtMs: num(item.question.askedAtMs),
          truncated: item.question.truncated,
        }
      : undefined,
    approval: approval
      ? { approvalId: approval.approvalId, tagId: approval.tagId, summary }
      : undefined,
    uncertain: item.uncertainAttempt ? uncertainAttempt(item.uncertainAttempt) : undefined,
  } as InboxItem);
}

export function approvalDetails(value: ProtoApproval): ApprovalDetails {
  let args = value.canonicalArgumentsJson;
  try {
    args = JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    // Shown as the Gateway sent it.
  }
  return {
    approvalId: value.approvalId,
    action: value.action,
    resource: value.resource,
    summary: value.summary,
    arguments: args,
    pending: value.state === ApprovalState.PENDING,
    state: enumName(ApprovalState, value.state),
  };
}

export function team(value: ProtoTeam): Team {
  return compact({
    teamId: value.teamId,
    name: value.name || value.teamId,
    memberTagIds: [...value.memberTagIds],
    revision: num(value.revision),
  } as Team);
}

export function workstreamPost(value: ProtoWorkstreamPost): WorkstreamPost {
  return {
    postId: value.postId,
    teamId: value.teamId,
    authorTagId: value.authorTagId,
    toTagIds: [...value.toTagIds],
    body: value.body,
    sequence: num(value.sequence),
    createdAtMs: num(value.createdAtMs),
  };
}

function closeReason(reason: WorkSessionCloseReason): string | undefined {
  switch (reason) {
    case WorkSessionCloseReason.IDLE:
      return "idle";
    case WorkSessionCloseReason.TAG:
      return "by the Tag";
    case WorkSessionCloseReason.OPERATOR:
      return "by an operator";
    case WorkSessionCloseReason.DELIVERY_PULLED:
      return "delivery pulled";
    case WorkSessionCloseReason.OBJECTIVE_CLOSED:
      return "Objective closed";
    case WorkSessionCloseReason.UPGRADE:
      return "finished before the upgrade";
    case WorkSessionCloseReason.MERGED:
      return "pull request merged";
    default:
      return undefined;
  }
}

export function workSession(value: ProtoWorkSession): WorkSession {
  const delivery = value.workspaceDelivery;
  const question = value.question;
  return compact({
    workSessionId: value.workSessionId,
    title: value.title,
    tagId: value.tagId,
    parentTagId: value.parentTagId,
    parentSessionId: value.parentSessionId,
    starterTaskId: value.starterTaskId,
    latestTaskId: value.latestTaskId,
    latestTaskState: enumName(TaskState, value.latestTaskState),
    reportTaskId: value.reportTaskId,
    reportTaskState:
      value.reportTaskId === undefined ? undefined : enumName(TaskState, value.reportTaskState),
    objectiveId: value.objectiveId,
    delivery:
      delivery && (delivery.headCommit !== "" || delivery.workspaceId !== "")
        ? {
            workspaceId: delivery.workspaceId,
            baseCommit: delivery.baseCommit,
            headCommit: delivery.headCommit,
            committed: delivery.committed,
            changedFiles: num(delivery.changedFiles),
          }
        : undefined,
    question:
      question && question.text !== "" && question.answerTaskId === undefined
        ? question.text
        : undefined,
    closedAtMs: optionalNum(value.closedAtMs),
    closeReason: value.closedAtMs === undefined ? undefined : closeReason(value.closeReason),
  } as WorkSession);
}

/** An operation ID for a call the Gateway accepts at most once. */
export const operationId = () => randomUUID();

/** The open Objectives the caller can see, a page at a time. */
export async function listObjectives(client: GatewayClient): Promise<Objective[]> {
  const PAGE = 50;
  const found: Objective[] = [];
  let after = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = (
      await rpc(() => client.objectives.listObjectives({ limit: PAGE, afterId: after }, CALL))
    ).objectives;
    found.push(...listed.map(objective));
    const last = listed.at(-1)?.objectiveId;
    if (listed.length < PAGE || last === undefined || last === after) break;
    after = last;
  }
  return found;
}

export async function getObjective(client: GatewayClient, objectiveId: string) {
  const read = await rpc(() => client.objectives.getObjective({ objectiveId }, CALL));
  if (read.objectiveId !== objectiveId) throw "The Gateway returned a different Objective.";
  return objective(read);
}

/** A refusal the Gateway words for the person, such as an owner with no Worker Host, is shown. */
function said(error: unknown): string {
  const { code, message } = statusOf(error);
  if (code === Code.FailedPrecondition || code === Code.NotFound) {
    const reason = [...message.replace(/\p{Cc}/gu, "")].slice(0, 400).join("").trim();
    if (reason !== "") return reason;
  }
  if (code === Code.PermissionDenied) return "Only an operator can do that.";
  return rpcError(error);
}

/**
 * Creates an Objective, which starts its owner's first turn. The same ID again is the same
 * request, so a retry after it could not start starts it rather than making another.
 */
export async function createObjective(client: GatewayClient, created: NewObjective) {
  const read = await rpc(
    () =>
      client.objectives.createObjective(
        {
          operationId: created.objectiveId,
          objectiveId: created.objectiveId,
          ownerTagId: created.ownerTagId,
          outcome: created.outcome,
          ...(created.budget
            ? {
                budgetLimitMinor: BigInt(created.budget.minor),
                budgetCurrency: created.budget.currency,
              }
            : {}),
        },
        CALL,
      ),
    said,
  );
  return objective(read);
}

/** Sends a follow-up to an Objective's owner in the Objective's Session; returns its Task. */
export async function messageObjective(client: GatewayClient, objectiveId: string, text: string) {
  const read = await getObjective(client, objectiveId);
  const task = await rpc(
    () =>
      client.operator.submitTask(
        {
          tagId: read.ownerTagId,
          sessionId: read.sessionId,
          operationId: operationId(),
          prompt: text,
        },
        CALL,
      ),
    said,
  );
  return { taskId: task.taskId, tagId: task.tagId };
}

/** Approves an Objective ready for review, or asks for changes with feedback. */
export async function reviewObjective(
  client: GatewayClient,
  objectiveId: string,
  approved: boolean,
  feedback: string,
) {
  return objective(
    await rpc(
      () =>
        client.objectives.reviewObjective(
          { objectiveId, operationId: operationId(), approved, feedback },
          CALL,
        ),
      said,
    ),
  );
}

/** What a Task says now: its state and, once it finished, its result. */
export async function taskResult(client: GatewayClient, taskId: string) {
  const task = await rpc(() => client.operator.getTask({ taskId }, CALL));
  return { state: enumName(TaskState, task.state), result: task.result ?? "" };
}

/** The inbox items an operator decides, oldest first, as the Gateway orders them. */
export async function listInbox(client: GatewayClient): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await rpc(() => client.inbox.listItems({ pageSize: 100, cursor }, CALL));
    items.push(...listed.items.filter((item) => item.operatorEligible).map(inboxItem));
    if (listed.nextCursor === "" || listed.nextCursor === cursor) break;
    cursor = listed.nextCursor;
  }
  return items;
}

export async function getApproval(client: GatewayClient, approvalId: string) {
  const read = await rpc(() => client.inbox.getApproval({ approvalId }, CALL));
  if (read.approvalId !== approvalId) throw "The Gateway returned a different approval.";
  return approvalDetails(read);
}

/** Answers a question; the owner's next turn in the same Session reads it. */
export async function answerQuestion(client: GatewayClient, taskId: string, text: string) {
  const task = await rpc(
    () => client.inbox.answerQuestion({ taskId, operationId: operationId(), text }, CALL),
    said,
  );
  return { taskId: task.taskId };
}

/**
 * Decides about an uncertain Task Attempt from `app`, as `principal`, once its Worker Host
 * confirmed it stopped: the Gateway refuses a decision without that confirmation from anyone but
 * an operator who checked the host, so the app never claims it. The evidence names the app, the
 * caller, and the execution report's cleanup and completeness.
 */
export async function resolveAttempt(
  client: GatewayClient,
  taskId: string,
  attemptId: string,
  decision: AttemptDecisionName,
  app: string,
  principal: string,
): Promise<{ state: string }> {
  const task = await rpc(() => client.operator.getTask({ taskId }, CALL));
  if (enumName(TaskState, task.state) !== "uncertain" || task.attemptId !== attemptId)
    throw "This turn no longer waits for a decision.";
  const report = task.executionReport;
  if (report?.cleanup !== AttemptCleanup.CONFIRMED)
    throw `Its Worker Host has not confirmed this turn stopped. An operator who checked the host can resolve it: supertag task resolve-attempt ${taskId} ${attemptId} --decision ${decision} --confirmed-stopped --evidence TEXT`;
  const evidence = resolutionEvidence(app, principal, {
    cleanup: cleanupWord(report.cleanup),
    complete: report.complete,
  });
  await rpc(
    () =>
      client.operator.resolveAttempt(
        {
          taskId,
          attemptId,
          operationId: operationId(),
          decision: decision === "retry" ? AttemptDecision.RETRY : AttemptDecision.FAILED,
          evidence,
          confirmedStopped: false,
        },
        CALL,
      ),
    said,
  );
  return { state: decision === "retry" ? "queued" : "failed" };
}

/** Approves an approval request once, or denies it with a reason. */
export async function decideApproval(
  client: GatewayClient,
  approvalId: string,
  approve: boolean,
  reason: string,
) {
  return approvalDetails(
    await rpc(
      () =>
        client.inbox.decideApproval(
          {
            approvalId,
            operationId: operationId(),
            approve,
            scope: approve ? ApprovalScope.ONCE : ApprovalScope.UNSPECIFIED,
            reason,
          },
          CALL,
        ),
      said,
    ),
  );
}

export async function listTeams(client: GatewayClient): Promise<Team[]> {
  const teams: Team[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await rpc(() => client.teams.listTeams({ limit: 100, cursor }, CALL));
    teams.push(...listed.teams.map(team));
    if (listed.nextCursor === "" || listed.nextCursor === cursor) break;
    cursor = listed.nextCursor;
  }
  return teams;
}

/** A Team's newest Workstream posts, oldest first: at most `limit`. */
export async function workstreamPosts(
  client: GatewayClient,
  teamId: string,
  limit = 20,
): Promise<WorkstreamPost[]> {
  const posts: WorkstreamPost[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await rpc(() =>
      client.teams.listWorkstreamPosts({ team: teamId, limit: 100, cursor }, CALL),
    );
    posts.push(...listed.posts.map(workstreamPost));
    if (listed.nextCursor === "" || listed.nextCursor === cursor) break;
    cursor = listed.nextCursor;
  }
  return posts.sort((a, b) => a.sequence - b.sequence).slice(-limit);
}

/** The Work Sessions the turns of a Tag's Session started, the oldest first. */
export async function listWorkSessions(
  client: GatewayClient,
  parentTagId: string,
  parentSessionId: string,
): Promise<WorkSession[]> {
  const found: WorkSession[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await rpc(() =>
      client.workSessions.list({ parentTagId, parentSessionId, limit: 100, cursor }, CALL),
    );
    found.push(...listed.workSessions.map(workSession));
    if (listed.nextCursor === "" || listed.nextCursor === cursor) break;
    cursor = listed.nextCursor;
  }
  return found;
}

export async function getWorkSession(client: GatewayClient, workSessionId: string) {
  return workSession(await rpc(() => client.workSessions.get({ workSessionId }, CALL)));
}

/**
 * The branch a Session's changes land on, as the Control Plane and Worker Host name it:
 * `supertag/session/` and the SHA-256 of the JSON pair `[tag, session]`.
 */
export function sessionBranch(tagId: string, sessionId: string): string {
  const pair = JSON.stringify([tagId, sessionId]);
  return `supertag/session/${createHash("sha256").update(pair).digest("hex")}`;
}

/**
 * Where a Work Session's delivered changes are: its branch, the commits the Worker recorded, and
 * the pull request its latest review landing opened. Nothing before it delivered a commit.
 */
export async function workBranch(
  client: GatewayClient,
  work: WorkSession,
): Promise<WorkBranch | undefined> {
  const delivery = work.delivery;
  if (!delivery || delivery.headCommit === "" || delivery.headCommit === delivery.baseCommit) {
    return undefined;
  }
  const branch: WorkBranch = {
    branch: sessionBranch(work.tagId, work.workSessionId),
    baseCommit: delivery.baseCommit,
    headCommit: delivery.headCommit,
  };
  const landings = await client.workspaceLandings
    .list({ sessionId: work.workSessionId, limit: 20 }, CALL)
    .then((listed) => listed.landings)
    .catch(() => []);
  const latest = [...landings].sort((a, b) => Number(b.createdOrder - a.createdOrder));
  const reviewed = latest.find((landing) => landing.pullRequest?.url);
  if (reviewed?.pullRequest?.url) branch.pullRequest = reviewed.pullRequest.url;
  const target = latest.find((landing) => landing.target !== "")?.target;
  if (target) branch.baseRef = target;
  const landed = latest.find((landing) => landing.branch !== "")?.branch;
  if (landed) branch.branch = landed;
  return branch;
}

/** The commands and tools a Task ran, as its activity lines, oldest first. */
export async function taskActivity(client: GatewayClient, taskId: string): Promise<string[]> {
  const lines: string[] = [];
  let after = 0n;
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = (
      await rpc(() => client.operator.listEvents({ taskId, afterSequence: after, limit: 32 }, CALL))
    ).events;
    for (const event of listed) {
      if (event.sequence > after) after = event.sequence;
      if (event.kind === TaskEventKind.ACTIVITY && event.text.trim() !== "") lines.push(event.text);
    }
    if (listed.length < 32) break;
  }
  return lines;
}
