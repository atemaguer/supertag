// biome-ignore-all lint/suspicious/noExplicitAny: This read model spans dialect-specific Drizzle tables.

import type {
  CoordinationInboxApproval,
  CoordinationInboxFilter,
  CoordinationInboxItem,
  CoordinationInboxKind,
  CoordinationInboxPage,
  CoordinationInboxStore,
  ReadCoordinationInboxInput,
} from "@supertag/core";
import {
  COORDINATION_INBOX_KINDS,
  COORDINATION_INBOX_VERSION,
  coordinationInboxCommands,
  currentUncertainAttempt,
  mailboxText,
  OBJECTIVE_CLOSED_STATUSES,
  objectiveClosed,
  objectiveLimitEvents,
  readableDuration,
  storedTaskFindings,
  TagMessagingError,
} from "@supertag/core";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { ownerStallWork } from "./owner-stall.js";

export const COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT = 1_000;
/** Render deadline warnings against the inbox read time, not their recorded warning time. */
export function inboxLimitReason(
  event: { kind: string; message: string },
  deadline: string | null,
  asOf: string,
): string {
  if (event.kind !== "objective_deadline_approaching" || !deadline) return event.message;
  const remaining = Date.parse(deadline) - Date.parse(asOf);
  return remaining > 0
    ? `The Objective deadline ${deadline} is near: ${readableDuration(remaining)} left.`
    : `The Objective deadline ${deadline} has passed.`;
}
const TERMINAL_ASSIGNMENT_STATUSES = ["accepted", "rejected", "cancelled", "failed"];
const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled"];
/** Task assignment statuses still in progress or awaiting review. */
const OPEN_ASSIGNMENT_STATUSES = ["queued", "waiting", "running", "submitted"];

interface InboxCursor {
  readonly v: 5;
  readonly asOf: string;
  readonly actionableSince: string;
  readonly key: string;
  readonly filter: CoordinationInboxFilter;
}

/** Read-only, redacted projection over Tasks that currently need human or lead judgment. */
export class DrizzleCoordinationInboxStore implements CoordinationInboxStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
  ) {}

  async readCoordinationInbox(
    input: ReadCoordinationInboxInput = {},
  ): Promise<CoordinationInboxPage> {
    const limit = parseLimit(input.limit);
    const requestedFilter = parseFilter(input);
    const cursor = input.cursor === undefined ? undefined : parseCursor(input.cursor);
    const hasExplicitFilter =
      input.objectiveId !== undefined ||
      input.teamId !== undefined ||
      input.kind !== undefined ||
      input.status !== undefined ||
      input.nextActorId !== undefined;
    if (cursor && hasExplicitFilter && !sameFilter(cursor.filter, requestedFilter))
      throw new TagMessagingError(400, "Coordination inbox cursor does not match filters");
    const filter = cursor && !hasExplicitFilter ? cursor.filter : requestedFilter;
    const asOf = parseAsOf(cursor?.asOf ?? input.asOf ?? new Date().toISOString());
    const noticesSince = input.includeNoticesSince;
    if (noticesSince !== undefined && !Number.isFinite(Date.parse(noticesSince)))
      throw new TagMessagingError(400, "Completion notice cutoff must be a valid timestamp");
    if (cursor && input.asOf !== undefined && parseAsOf(input.asOf) !== cursor.asOf)
      throw new TagMessagingError(400, "Coordination inbox cursor does not match asOf");

    const t = this.tables;
    const taskCondition = and(
      filter.objectiveId === undefined
        ? undefined
        : eq(t.taskAssignments.objectiveId, filter.objectiveId),
      filter.teamId === undefined ? undefined : eq(t.taskAssignments.teamId, filter.teamId),
      filter.kind === "task_approval"
        ? and(eq(t.taskAssignments.status, "queued"), eq(t.taskAssignments.approval, "pending"))
        : filter.kind === "task_review"
          ? eq(t.taskAssignments.status, "submitted")
          : filter.kind === "task_budget"
            ? eq(t.taskAssignments.status, "failed")
            : filter.kind === "mcp_login"
              ? eq(t.taskAssignments.status, "queued")
              : or(
                  eq(t.taskAssignments.status, "queued"),
                  eq(t.taskAssignments.status, "waiting"),
                  eq(t.taskAssignments.status, "running"),
                  eq(t.taskAssignments.status, "submitted"),
                  eq(t.taskAssignments.status, "accepted"),
                  eq(t.taskAssignments.status, "failed"),
                  eq(t.taskAssignments.status, "cancelled"),
                  eq(t.taskAssignments.status, "rejected"),
                ),
    );
    // Budget notifications must scan every eligible row; unrelated failed Tasks and
    // unrelated Teams/Objectives must not consume the bounded candidate window.
    const budgetRows =
      filter.kind === "task_budget"
        ? await this.db
            .select({ task: t.taskAssignments, team: t.teams, objective: t.objectives })
            .from(t.taskAssignments)
            .innerJoin(t.teams, eq(t.teams.id, t.taskAssignments.teamId))
            .innerJoin(t.objectives, eq(t.objectives.id, t.taskAssignments.objectiveId))
            .where(
              and(
                taskCondition,
                sql`${t.taskAssignments.result} ->> 'failureKind' = 'budget-exhausted'`,
                inArray(t.objectives.status, ["working", "blocked"]),
                lte(t.taskAssignments.createdAt, asOf),
                lte(t.taskAssignments.updatedAt, asOf),
                lte(t.teams.createdAt, asOf),
                lte(t.teams.updatedAt, asOf),
                lte(t.objectives.createdAt, asOf),
                lte(t.objectives.updatedAt, asOf),
                filter.nextActorId === undefined
                  ? undefined
                  : and(
                      ne(t.taskAssignments.assignedTagId, filter.nextActorId),
                      or(
                        eq(t.objectives.ownerTagId, filter.nextActorId),
                        eq(t.teams.leadTagId, filter.nextActorId),
                      ),
                    ),
                cursor
                  ? or(
                      gt(t.taskAssignments.updatedAt, cursor.actionableSince),
                      and(
                        eq(t.taskAssignments.updatedAt, cursor.actionableSince),
                        gt(t.taskAssignments.taskId, cursor.key.slice("task_budget:".length)),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(t.taskAssignments.updatedAt), asc(t.taskAssignments.taskId))
            .limit(limit + 1)
        : undefined;
    // Only open work can produce an item: a Task still in progress or awaiting review, or any
    // Task of an Objective that is not closed (findings, failures, and finished owner activations
    // matter only while it is open). Finished Tasks of closed Objectives are history, and must
    // not consume the bounded candidate window, so the scan tracks open work, not history.
    const openObjectiveIds = this.db
      .select({ id: t.objectives.id })
      .from(t.objectives)
      .where(notInArray(t.objectives.status, [...OBJECTIVE_CLOSED_STATUSES]));
    const candidateTaskCondition = and(
      lte(t.taskAssignments.createdAt, asOf),
      lte(t.taskAssignments.updatedAt, asOf),
      taskCondition,
      or(
        inArray(t.taskAssignments.status, OPEN_ASSIGNMENT_STATUSES),
        inArray(t.taskAssignments.objectiveId, openObjectiveIds),
      ),
    );
    const candidateTasks = (column: any) =>
      this.db.selectDistinct({ id: column }).from(t.taskAssignments).where(candidateTaskCondition);
    // Completion notices are the only items closed Objectives produce; read the newest apart.
    const completionNotices =
      filter.kind === "objective_completed" ||
      (filter.kind === undefined && input.includeNotices === true);
    const [tasks, teams, objectives, completedObjectives] = budgetRows
      ? [
          budgetRows.map((row: any) => row.task),
          budgetRows.map((row: any) => row.team),
          budgetRows.map((row: any) => row.objective),
          [],
        ]
      : await Promise.all([
          this.db
            .select()
            .from(t.taskAssignments)
            .where(candidateTaskCondition)
            .orderBy(asc(t.taskAssignments.updatedAt), asc(t.taskAssignments.taskId))
            .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1),
          this.db
            .select()
            .from(t.teams)
            .where(
              and(
                lte(t.teams.createdAt, asOf),
                lte(t.teams.updatedAt, asOf),
                filter.teamId === undefined ? undefined : eq(t.teams.id, filter.teamId),
                inArray(t.teams.id, candidateTasks(t.taskAssignments.teamId)),
              ),
            )
            .orderBy(asc(t.teams.id))
            .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1),
          this.db
            .select()
            .from(t.objectives)
            .where(
              and(
                lte(t.objectives.createdAt, asOf),
                lte(t.objectives.updatedAt, asOf),
                filter.objectiveId === undefined
                  ? undefined
                  : eq(t.objectives.id, filter.objectiveId),
                or(
                  notInArray(t.objectives.status, [...OBJECTIVE_CLOSED_STATUSES]),
                  inArray(t.objectives.id, candidateTasks(t.taskAssignments.objectiveId)),
                ),
              ),
            )
            .orderBy(asc(t.objectives.id))
            .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1),
          completionNotices
            ? this.db
                .select()
                .from(t.objectives)
                .where(
                  and(
                    eq(t.objectives.status, "completed"),
                    noticesSince === undefined
                      ? undefined
                      : gte(t.objectives.updatedAt, noticesSince),
                    lte(t.objectives.createdAt, asOf),
                    lte(t.objectives.updatedAt, asOf),
                    filter.objectiveId === undefined
                      ? undefined
                      : eq(t.objectives.id, filter.objectiveId),
                  ),
                )
                .orderBy(desc(t.objectives.updatedAt), desc(t.objectives.id))
                .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1)
            : [],
        ]);

    const truncatedKinds = new Set<CoordinationInboxKind>();
    if (
      tasks.length > COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT ||
      teams.length > COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT ||
      objectives.length > COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT
    )
      for (const kind of COORDINATION_INBOX_KINDS)
        if (
          kind !== "approval" &&
          kind !== "objective_completed" &&
          (filter.kind === undefined || filter.kind === kind)
        )
          truncatedKinds.add(kind);
    if (completedObjectives.length > COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)
      truncatedKinds.add("objective_completed");

    // Pending approval requests: `approval` items, and the request holding a `task_approval` Task.
    const taskApprovals = new Map<string, CoordinationInboxApproval>();
    const approvalRows =
      input.includeApprovals !== false &&
      (filter.kind === undefined || filter.kind === "approval" || filter.kind === "task_approval")
        ? await this.db
            .select({
              request: t.approvalRequests,
              assignment: t.taskAssignments,
              task: t.tasks,
              requester: { name: t.tags.name },
              objective: t.objectives,
            })
            .from(t.approvalRequests)
            .innerJoin(t.objectives, eq(t.objectives.id, t.approvalRequests.objectiveId))
            .leftJoin(t.taskAssignments, eq(t.taskAssignments.taskId, t.approvalRequests.taskId))
            .leftJoin(t.tasks, eq(t.tasks.id, t.approvalRequests.taskId))
            .leftJoin(t.tags, eq(t.tags.id, t.approvalRequests.requestingTagId))
            .where(
              and(
                eq(t.approvalRequests.status, "pending"),
                lte(t.approvalRequests.createdAt, asOf),
                filter.objectiveId === undefined
                  ? undefined
                  : eq(t.approvalRequests.objectiveId, filter.objectiveId),
              ),
            )
            .orderBy(asc(t.approvalRequests.createdAt), asc(t.approvalRequests.id))
            .limit(COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 1)
        : [];
    if (approvalRows.length > COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)
      for (const kind of ["approval", "task_approval"] as const)
        if (filter.kind === undefined || filter.kind === kind) truncatedKinds.add(kind);
    const pendingApprovals: {
      readonly approval: CoordinationInboxApproval;
      readonly row: any;
    }[] = [];
    for (const row of approvalRows.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)) {
      const { request, assignment, task, objective } = row;
      if (objectiveClosed(objective.status)) continue;
      // Requests whose Task already finished can never be used; the coordinator expires them.
      const open =
        request.kind === "plan" ||
        (assignment
          ? !TERMINAL_ASSIGNMENT_STATUSES.includes(assignment.status)
          : task
            ? !TERMINAL_TASK_STATUSES.includes(task.status)
            : false);
      if (!open) continue;
      const approval: CoordinationInboxApproval = {
        requestId: request.id,
        requestKind: request.kind,
        // A Task request's stored summary quotes its instruction, which the inbox redacts.
        summary:
          request.kind === "task"
            ? `Start Task ${request.taskId}${runtimeActions(request.actions)}`
            : request.summary,
        requestingTagId: request.requestingTagId,
        ...(row.requester?.name ? { requestingTagName: row.requester.name } : {}),
        taskId: request.taskId,
        blocking:
          request.attemptId !== null &&
          (assignment
            ? ["running", "waiting"].includes(assignment.status)
            : task?.status === "running"),
      };
      if (request.kind === "task") taskApprovals.set(request.taskId, approval);
      else pendingApprovals.push({ approval, row });
    }

    const teamById = new Map<string, any>(
      teams.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT).map((row: any) => [row.id, row]),
    );
    const objectiveById = new Map<string, any>(
      objectives.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT).map((row: any) => [row.id, row]),
    );
    const items: CoordinationInboxItem[] = [];
    const push = (item: Omit<CoordinationInboxItem, "projectionVersion" | "ageSeconds">) => {
      const value: CoordinationInboxItem = {
        projectionVersion: COORDINATION_INBOX_VERSION,
        ...item,
        commands: coordinationInboxCommands(item),
        ageSeconds: Math.max(
          0,
          Math.floor((Date.parse(asOf) - Date.parse(item.actionableSince)) / 1_000),
        ),
      };
      if (matches(value, filter)) items.push(value);
    };

    if (filter.kind === undefined || filter.kind === "task_attention") {
      for (const objective of objectives.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)) {
        if (filter.objectiveId !== undefined && filter.objectiveId !== objective.id) continue;
        if (filter.teamId !== undefined && filter.teamId !== `${objective.id}:leadership`) continue;
        if (objective.status !== "working" || !objective.executionStartedAt) continue;
        const [assignments, messages] = await Promise.all([
          this.db
            .select()
            .from(t.taskAssignments)
            .where(eq(t.taskAssignments.objectiveId, objective.id)),
          this.db.select().from(t.tagMessages).where(eq(t.tagMessages.objectiveId, objective.id)),
        ]);
        const pending = ownerStallWork(objective, assignments, messages, true);
        if (!pending) continue;
        push({
          key: `task_attention:objective:${objective.id}:stalled`,
          kind: "task_attention",
          status: "pending",
          objectiveId: objective.id,
          teamId: `${objective.id}:leadership`,
          nextActorTagIds: [],
          excludedActorTagIds: [],
          operatorEligible: true,
          actionableSince: pending.since,
          deadline: objective.deadline ?? null,
          reason: `Objective ${objective.id} has no owner activation. Waiting: ${pending.waiting.join(", ")}. Send direction with supertag message objective ${objective.id} TEXT to wake the owner.`,
          evidence: [
            ...pending.evidence.map((task) => ({ kind: "task" as const, ...task })),
            { kind: "objective", id: objective.id, revision: objective.revision },
          ],
          permittedActions: [],
          redaction: metadataOnly(["instruction", "result", "message body"]),
        });
      }
    }

    if (filter.kind === undefined || filter.kind === "operator_message") {
      const m = t.objectiveMessages,
        q = t.taskAssignments,
        o = t.objectives;
      const messages = await this.db
        .select({ message: m, teamId: q.teamId, objective: o })
        .from(m)
        .innerJoin(q, eq(q.taskId, m.sourceTaskId))
        .innerJoin(o, eq(o.id, m.objectiveId))
        .where(
          and(
            sql`${m.replyMessageId} is null`,
            sql`${m.resolvedAt} is null`,
            eq(m.needsReply, true),
            lte(m.createdAt, asOf),
            filter.objectiveId === undefined ? undefined : eq(m.objectiveId, filter.objectiveId),
            filter.teamId === undefined ? undefined : eq(q.teamId, filter.teamId),
            cursor
              ? or(
                  gt(m.createdAt, cursor.actionableSince),
                  and(
                    eq(m.createdAt, cursor.actionableSince),
                    gt(sql`'operator_message:' || ${m.id}`, cursor.key),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(m.createdAt), asc(m.id))
        .limit(limit + 1);
      for (const { message, teamId, objective } of messages)
        push({
          key: `operator_message:${message.id}`,
          kind: "operator_message",
          status: "pending",
          objectiveId: message.objectiveId,
          teamId,
          nextActorTagIds: [],
          excludedActorTagIds: [],
          operatorEligible: true,
          actionableSince: message.createdAt,
          deadline: objective.deadline ?? null,
          reason:
            "The Objective owner sent a message for operator attention. Read its operator mailbox before deciding; replying does not approve a resource change.",
          evidence: [
            { kind: "message", id: message.id },
            { kind: "objective", id: objective.id, revision: objective.revision },
          ],
          permittedActions: [
            {
              tool: "send_message",
              arguments: {
                objectiveId: message.objectiveId,
                recipientTagId: objective.ownerTagId,
                type: "message",
                inReplyTo: message.id,
              },
              requiredInputFields: ["body", "idempotencyKey"],
            },
          ],
          redaction: metadataOnly(["body"]),
        });
    }

    if (filter.kind === undefined || filter.kind === "objective_limit") {
      for (const objective of objectives.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)) {
        if (
          objectiveClosed(objective.status) ||
          !objective.executionStartedAt ||
          (filter.objectiveId !== undefined && objective.id !== filter.objectiveId)
        )
          continue;
        for (const event of objectiveLimitEvents(objective)) {
          if (event.at > asOf) continue;
          const budget =
            event.kind === "objective_budget_threshold" ||
            event.kind === "objective_budget_exhausted";
          push({
            key: `objective_limit:${objective.id}:${event.key}`,
            kind: "objective_limit",
            status: "pending",
            reason: inboxLimitReason(event, objective.deadline ?? null, asOf),
            objectiveId: objective.id,
            teamId: `${objective.id}:leadership`,
            nextActorTagIds: [],
            excludedActorTagIds: [],
            operatorEligible: true,
            actionableSince: event.at,
            deadline: objective.deadline ?? null,
            evidence: [{ kind: "objective", id: objective.id, revision: objective.revision }],
            permittedActions: [
              {
                tool: "update_objective",
                arguments: { objectiveId: objective.id, expectedRevision: objective.revision },
                requiredInputFields: [budget ? "budgetLimitMinor" : "deadline"],
              },
            ],
            redaction: metadataOnly([]),
          });
        }
      }
    }

    if (
      filter.kind === undefined ||
      filter.kind === "objective_ready_for_review" ||
      filter.kind === "objective_completed"
    ) {
      for (const objective of [
        ...objectives
          .slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)
          .filter((row: any) => row.status === "ready_for_review"),
        ...completedObjectives.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT),
      ]) {
        const kind =
          objective.status === "ready_for_review"
            ? "objective_ready_for_review"
            : "objective_completed";
        if (filter.kind !== undefined && filter.kind !== kind) continue;
        // Completion needs no operator action: notify through the outbox, never list it as open.
        if (kind === "objective_completed" && filter.kind !== kind && !input.includeNotices)
          continue;
        const pendingQuestions =
          kind === "objective_ready_for_review"
            ? await this.db
                .select({
                  id: t.objectiveMessages.id,
                  createdAt: t.objectiveMessages.createdAt,
                  body: t.objectiveMessages.body,
                })
                .from(t.objectiveMessages)
                .where(
                  and(
                    eq(t.objectiveMessages.objectiveId, objective.id),
                    eq(t.objectiveMessages.senderTagId, objective.ownerTagId),
                    eq(t.objectiveMessages.needsReply, true),
                    isNull(t.objectiveMessages.replyMessageId),
                    isNull(t.objectiveMessages.resolvedAt),
                    lte(t.objectiveMessages.createdAt, asOf),
                  ),
                )
                .orderBy(asc(t.objectiveMessages.createdAt), asc(t.objectiveMessages.id))
            : [];
        push({
          key: `${kind}:${objective.id}`,
          kind,
          status: "pending",
          objectiveId: objective.id,
          teamId: `${objective.id}:leadership`,
          nextActorTagIds: [],
          excludedActorTagIds: [],
          operatorEligible: true,
          actionableSince: objective.updatedAt,
          deadline: objective.deadline ?? null,
          reason:
            kind === "objective_ready_for_review"
              ? pendingQuestions.length
                ? `The Objective owner requested operator review. Approval waits for answers to these owner questions:\n${pendingQuestions.map((question: { id: string; createdAt: string; body: Record<string, unknown> }) => `- ${question.id} (asked ${question.createdAt}): ${String(question.body?.["message"] ?? "").split(/\r?\n|\r/u, 1)[0]}\n  supertag message objective ${objective.id} --reply-to ${question.id} TEXT`).join("\n")}`
                : "The Objective owner requested operator review."
              : "The Objective was completed.",
          evidence: [{ kind: "objective", id: objective.id, revision: objective.revision }],
          permittedActions: [],
          redaction: metadataOnly(["outcome", "completionSummary"]),
        });
      }
    }

    if (filter.kind === undefined || filter.kind === "approval") {
      for (const { approval, row } of pendingApprovals) {
        const { request, assignment, objective } = row;
        push({
          key: `approval:${request.id}`,
          kind: "approval",
          status: "pending",
          reason: approval.blocking
            ? "A running Task Attempt waits for this decision."
            : "The request waits for a decision before the action can proceed.",
          objectiveId: objective.id,
          teamId: assignment?.teamId ?? `${objective.id}:leadership`,
          nextActorTagIds: [],
          excludedActorTagIds: [request.requestingTagId],
          operatorEligible: true,
          actionableSince: request.createdAt,
          deadline: objective.deadline ?? null,
          evidence: [
            { kind: "approval_request", id: request.id },
            { kind: "objective", id: objective.id, revision: objective.revision },
          ],
          permittedActions: [
            {
              tool: "decide_approval",
              arguments: { objectiveId: objective.id, requestId: request.id, decision: "approve" },
              requiredInputFields: [],
            },
            {
              tool: "decide_approval",
              arguments: { objectiveId: objective.id, requestId: request.id, decision: "deny" },
              requiredInputFields: ["reason"],
            },
          ],
          approval,
          redaction: metadataOnly(["actions", "argumentsDigest"]),
        });
      }
    }

    // Queued Tasks the scheduler last held for a lapsed MCP login, by Task ID.
    const heldForLogin = new Map<string, { readonly servers: string[]; readonly at: string }>();
    const queuedIds = tasks
      .slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)
      .filter((task: any) => task.status === "queued")
      .map((task: any) => task.taskId as string);
    if ((filter.kind === undefined || filter.kind === "mcp_login") && queuedIds.length > 0) {
      const events = await this.db
        .select({
          taskId: t.taskEvents.taskId,
          type: t.taskEvents.type,
          payload: t.taskEvents.payload,
          createdAt: t.taskEvents.createdAt,
        })
        .from(t.taskEvents)
        .where(
          and(
            inArray(t.taskEvents.taskId, queuedIds),
            inArray(t.taskEvents.type, [
              "task.scheduling-incompatible",
              "task.scheduling-compatible",
              "task.scheduling-waiting",
            ]),
            lte(t.taskEvents.createdAt, asOf),
          ),
        )
        .orderBy(asc(t.taskEvents.taskId), asc(t.taskEvents.sequence));
      const latest = new Map<string, any>();
      for (const event of events) latest.set(event.taskId, event);
      for (const [taskId, event] of latest) {
        if (event.type !== "task.scheduling-incompatible") continue;
        const servers = mcpLoginServers(event.payload);
        if (servers.length > 0) heldForLogin.set(taskId, { servers, at: event.createdAt });
      }
    }

    const budgetObjectives = new Set<string>();
    for (const task of tasks.slice(0, COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT)) {
      const team = teamById.get(task.teamId);
      const objective = objectiveById.get(task.objectiveId);
      if (!team || !objective) continue;
      const reviewers = uniqueActors([objective.ownerTagId, team.leadTagId]);
      const base = {
        objectiveId: task.objectiveId,
        teamId: task.teamId,
        operatorEligible: true,
        excludedActorTagIds: [] as string[],
        actionableSince: task.updatedAt,
        deadline: objective.deadline ?? null,
        evidence: [
          {
            kind: "task" as const,
            id: task.taskId,
            status: task.status,
            attemptCount: task.attemptCount,
            updatedAt: task.updatedAt,
          },
          { kind: "team" as const, id: team.id, revision: team.revision },
        ],
        redaction: metadataOnly(["instruction", "acceptanceCriteria", "result"]),
      };
      if (
        (filter.kind === undefined || filter.kind === "task_attention") &&
        !objectiveClosed(objective.status)
      )
        for (const finding of storedTaskFindings(task.result)) {
          if (finding.status !== "open" || finding.severity !== "high") continue;
          push({
            ...base,
            key: `task_attention:${task.taskId}:${finding.id}`,
            kind: "task_attention",
            status: "pending",
            nextActorTagIds: reviewers,
            reason: `Open high finding ${task.taskId} ${finding.id}: ${finding.summary}${finding.location ? ` (${finding.location})` : ""}`,
            permittedActions: [],
          });
        }
      if (
        (filter.kind === undefined || filter.kind === "objective_budget") &&
        !budgetObjectives.has(objective.id) &&
        task.assignedTagId === objective.ownerTagId &&
        !task.parentTaskId &&
        !task.sourceMessageId &&
        !objectiveClosed(objective.status) &&
        objective.observationState?.blocked ===
          "Observation delivery awaits available Objective budget"
      ) {
        budgetObjectives.add(objective.id);
        push({
          ...base,
          key: `objective_budget:${objective.id}`,
          kind: "objective_budget",
          status: "pending",
          nextActorTagIds: [],
          reason:
            "Observation assessment cannot be admitted within the Objective allocation. An operator may increase its finite limit; no Task execution has been marked failed by this condition.",
          evidence: [
            ...base.evidence,
            { kind: "objective", id: objective.id, revision: objective.revision },
          ],
          permittedActions: [
            {
              tool: "update_objective",
              arguments: { objectiveId: objective.id, expectedRevision: objective.revision },
              requiredInputFields: ["budgetLimitMinor"],
            },
          ],
        });
      }
      // An uncertain Attempt holds Worker capacity until an operator on its host recovers it,
      // whatever the Objective's status.
      const uncertain = currentUncertainAttempt(task);
      if ((filter.kind === undefined || filter.kind === "task_attention") && uncertain)
        push({
          ...base,
          key: `task_attention:${task.taskId}:uncertain:${uncertain.attemptId}`,
          kind: "task_attention",
          status: "pending",
          // Only a person with access to the Worker Host can confirm execution stopped.
          nextActorTagIds: [],
          actionableSince: uncertain.detectedAt,
          reason: `Task Attempt ${uncertain.attemptId} may have executed, so SuperTag will not replay it; it keeps a Worker capacity slot until recovered. Why: ${uncertain.reason.replace(/[.\s]*$/u, ".")} On Worker Host ${uncertain.workerHostId ?? "that ran it"}, stop the host service first (supertag down SERVICE), confirm all of the Attempt's processes and remote executions stopped, then run the recover command and start the host again. The Task then fails, and whoever waits on it wakes.`,
          uncertainAttempt: {
            attemptId: uncertain.attemptId,
            ...(uncertain.workerHostId === undefined
              ? {}
              : { workerHostId: uncertain.workerHostId }),
            ...(uncertain.workerId === undefined ? {} : { workerId: uncertain.workerId }),
          },
          permittedActions: [],
        });
      const integrityFailure =
        task.status === "failed" && task.result?.failureKind === "workspace-integrity";
      if (
        (filter.kind === undefined || filter.kind === "task_attention") &&
        integrityFailure &&
        !objectiveClosed(objective.status)
      )
        push({
          ...base,
          key: `task_attention:${task.taskId}`,
          kind: "task_attention",
          status: "pending",
          // Only a person with access to the Worker Host can inspect its repository.
          nextActorTagIds: [],
          reason: `The Worker stopped running git for this Task because the repository's git config changed during its Task Attempt. ${String(task.result?.error ?? "")} Inspect the restored repository config on the Worker Host before retrying the Task.`,
          permittedActions: [],
        });
      else if (
        (filter.kind === undefined || filter.kind === "task_attention") &&
        objective.executionStartedAt &&
        !objectiveClosed(objective.status)
      ) {
        const failedAssessment =
          ["failed", "cancelled", "rejected"].includes(task.status) &&
          (objective.observationState?.pending?.taskId === task.taskId ||
            (task.sourceMessageId?.startsWith("observation:") &&
              objective.observationState?.pending?.messageId === task.sourceMessageId));
        const finishedOwner =
          task.assignedTagId === objective.ownerTagId &&
          !task.parentTaskId &&
          ["submitted", "accepted", "failed", "cancelled", "rejected"].includes(task.status);
        // Inspect all current assignments, not the bounded inbox candidate page or Team view.
        const active = finishedOwner
          ? await this.db
              .select({ id: t.taskAssignments.taskId })
              .from(t.taskAssignments)
              .where(
                and(
                  eq(t.taskAssignments.objectiveId, objective.id),
                  inArray(t.taskAssignments.status, ["queued", "running", "waiting"]),
                ),
              )
              .limit(1)
          : [];
        const unattended =
          finishedOwner &&
          !active.length &&
          (!objective.observations?.length || objective.observationState?.blocked);
        if (failedAssessment || unattended)
          push({
            ...base,
            key: `task_attention:${task.taskId}`,
            kind: "task_attention",
            status: "pending",
            nextActorTagIds: reviewers,
            reason: failedAssessment
              ? "Observation assessment stopped without acknowledging its evidence. Inspect the Task and any external effects before recovery."
              : "The owner finished its Task, but the active Objective has no scheduled work or usable observation subscription. Review the outcome and arrange a durable follow-up or close it.",
            // Inspection must precede choosing an existing coordination action.
            permittedActions: [],
          });
      }
      const login = task.status === "queued" ? heldForLogin.get(task.taskId) : undefined;
      for (const server of login?.servers ?? [])
        push({
          ...base,
          key: `mcp_login:${task.taskId}:${server}`,
          kind: "mcp_login",
          status: "pending",
          nextActorTagIds: [],
          actionableSince: login?.at ?? task.updatedAt,
          reason: `The Task needs MCP server ${server}, whose login lapsed on its Worker Host. Run the login command on that host; the Task stays queued until then.`,
          // Logging in happens on the host, outside the coordination primitives.
          permittedActions: [],
        });
      if (task.status === "queued" && task.approval === "pending") {
        const approval = taskApprovals.get(task.taskId);
        push({
          ...base,
          ...(approval ? { approval } : {}),
          key: `task_approval:${task.taskId}`,
          kind: "task_approval",
          status: "pending",
          nextActorTagIds: reviewers,
          permittedActions: [
            {
              tool: "update_task",
              arguments: {
                objectiveId: task.objectiveId,
                taskId: task.taskId,
                expectedStatus: "queued",
                approval: "approved",
              },
              requiredInputFields: [],
            },
          ],
        });
      }
      if (
        task.status === "failed" &&
        task.result?.failureKind === "budget-exhausted" &&
        ["working", "blocked"].includes(objective.status)
      ) {
        const canResume = ["working", "blocked"].includes(objective.status);
        push({
          ...base,
          key: `task_budget:${task.taskId}`,
          kind: "task_budget",
          status: "pending",
          nextActorTagIds: canResume ? reviewers.filter((id) => id !== task.assignedTagId) : [],
          excludedActorTagIds: [task.assignedTagId],
          operatorEligible: canResume,
          permittedActions: canResume
            ? [
                {
                  tool: "update_task",
                  arguments: {
                    objectiveId: task.objectiveId,
                    taskId: task.taskId,
                    expectedStatus: "failed",
                    status: "queued",
                  },
                  requiredInputFields: ["executionLimits"],
                },
              ]
            : [],
        });
      }
      if (task.status === "submitted") {
        const eligible = reviewers.filter(
          (id) => id !== task.assignedTagId || task.requestedByTagId === task.assignedTagId,
        );
        push({
          ...base,
          key: `task_review:${task.taskId}`,
          kind: "task_review",
          status: "pending",
          nextActorTagIds: eligible,
          excludedActorTagIds:
            task.requestedByTagId === task.assignedTagId ? [] : [task.assignedTagId],
          operatorEligible: eligible.includes(objective.ownerTagId),
          permittedActions: [
            {
              tool: "update_task",
              arguments: {
                objectiveId: task.objectiveId,
                taskId: task.taskId,
                expectedStatus: "submitted",
                status: "accepted",
              },
              requiredInputFields: ["assessment"],
            },
            {
              tool: "update_task",
              arguments: {
                objectiveId: task.objectiveId,
                taskId: task.taskId,
                expectedStatus: "submitted",
                status: "rejected",
              },
              requiredInputFields: ["assessment"],
            },
          ],
        });
      }
    }

    if (!budgetRows)
      items.sort(
        (left, right) =>
          left.actionableSince.localeCompare(right.actionableSince) ||
          left.key.localeCompare(right.key),
      );
    const after =
      cursor && !budgetRows
        ? items.filter(
            (item) =>
              item.actionableSince > cursor.actionableSince ||
              (item.actionableSince === cursor.actionableSince && item.key > cursor.key),
          )
        : items;
    const pageItems = after.slice(0, limit);
    const actorIds = [...new Set(pageItems.flatMap((item) => item.nextActorTagIds))];
    const actorRows = actorIds.length
      ? await this.db
          .select({ id: t.tags.id, name: t.tags.name })
          .from(t.tags)
          .where(inArray(t.tags.id, actorIds))
      : [];
    const tagNames = Object.fromEntries(
      actorRows.map((row: { id: string; name: string }) => [row.id, row.name]),
    );
    const last = pageItems.at(-1);
    return {
      projectionVersion: COORDINATION_INBOX_VERSION,
      asOf,
      items: pageItems,
      tagNames,
      truncatedKinds: [...truncatedKinds].sort(),
      ...(after.length > limit && last
        ? {
            nextCursor: encodeCursor({
              v: 5,
              asOf,
              actionableSince: last.actionableSince,
              key: last.key,
              filter,
            }),
          }
        : {}),
    };
  }
}

function runtimeActions(actions: unknown): string {
  const names = Array.isArray(actions)
    ? actions
        .map((action) => (action && typeof action === "object" ? action.action : undefined))
        .filter((name): name is string => typeof name === "string")
    : [];
  return names.length ? ` with ${names.join(", ")}` : "";
}

function uniqueActors(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function metadataOnly(omitted: readonly string[]): CoordinationInboxItem["redaction"] {
  return { level: "metadata_only", omitted };
}

function matches(item: CoordinationInboxItem, filter: CoordinationInboxFilter): boolean {
  return (
    (filter.objectiveId === undefined || item.objectiveId === filter.objectiveId) &&
    (filter.teamId === undefined || item.teamId === filter.teamId) &&
    (filter.kind === undefined || item.kind === filter.kind) &&
    (filter.status === undefined || item.status === filter.status) &&
    (filter.nextActorId === undefined || item.nextActorTagIds.includes(filter.nextActorId))
  );
}

function parseFilter(input: ReadCoordinationInboxInput): CoordinationInboxFilter {
  if (input.kind !== undefined && !COORDINATION_INBOX_KINDS.includes(input.kind))
    throw new TagMessagingError(400, "Invalid coordination inbox kind");
  if (input.status !== undefined && input.status !== "pending")
    throw new TagMessagingError(400, "Invalid coordination inbox status");
  return {
    ...(input.objectiveId === undefined
      ? {}
      : { objectiveId: mailboxText(input.objectiveId, "objectiveId") }),
    ...(input.teamId === undefined ? {} : { teamId: mailboxText(input.teamId, "teamId") }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.nextActorId === undefined
      ? {}
      : { nextActorId: mailboxText(input.nextActorId, "nextActorId") }),
  };
}

function parseLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TagMessagingError(400, "Coordination inbox limit must be an integer from 1 to 100");
  return limit;
}

function parseAsOf(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new TagMessagingError(400, "Coordination inbox asOf must be an ISO timestamp");
  const normalized = new Date(value).toISOString();
  if (Date.parse(normalized) > Date.now())
    throw new TagMessagingError(400, "Coordination inbox asOf cannot be in the future");
  return normalized;
}

function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseCursor(value: string): InboxCursor {
  try {
    if (typeof value !== "string" || value.length < 1 || value.length > 4_096)
      throw new Error("size");
    const cursor = object(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (
      cursor?.["v"] !== 5 ||
      typeof cursor["asOf"] !== "string" ||
      typeof cursor["actionableSince"] !== "string" ||
      typeof cursor["key"] !== "string" ||
      !object(cursor["filter"])
    )
      throw new Error("shape");
    parseAsOf(cursor["asOf"]);
    if (
      !Number.isFinite(Date.parse(cursor["actionableSince"])) ||
      cursor["key"].length < 1 ||
      cursor["key"].length > 1_000
    )
      throw new Error("position");
    return {
      v: 5,
      asOf: cursor["asOf"],
      actionableSince: cursor["actionableSince"],
      key: cursor["key"],
      filter: parseFilter(cursor["filter"] as ReadCoordinationInboxInput),
    };
  } catch (error) {
    if (error instanceof TagMessagingError) throw error;
    throw new TagMessagingError(400, "Invalid coordination inbox cursor");
  }
}

function sameFilter(left: CoordinationInboxFilter, right: CoordinationInboxFilter): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** MCP server names a scheduling diagnosis holds for a login. */
function mcpLoginServers(payload: unknown): string[] {
  const value =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)["mcpLogins"]
      : undefined;
  return Array.isArray(value)
    ? value.filter(
        (server): server is string =>
          typeof server === "string" && /^[a-z0-9][a-z0-9_-]{0,58}$/u.test(server),
      )
    : [];
}
