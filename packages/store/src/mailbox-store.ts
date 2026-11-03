// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across the SQLite and PostgreSQL dialects.

import { createHash, randomUUID } from "node:crypto";
import {
  ACTIVATION_DIGEST_ITEM_MAX_CHARACTERS,
  ACTIVATION_DIGEST_MAX_CHARACTERS,
  type ActivationDigest,
  type ActivationDigestItem,
  type DatabaseProvider,
  type ListWorkstreamsOptions,
  mailboxObject,
  mailboxText,
  narrowObjectiveWorkspaces,
  type Objective,
  type ObjectiveLimitState,
  type ObjectiveStore,
  objectiveCancellationNotice,
  objectiveClosed,
  objectiveDeadlineNotices,
  objectiveDeadlineSetMessage,
  objectiveDeadlineStopsRunning,
  ownerActivation,
  ownerActivationAwaitsNoReview,
  ownerDeliveries,
  parseCancelObjective,
  parseCreateObjective,
  parseObjectiveStatus,
  parsePostWorkstream,
  parseSurfaceObjectiveCommand,
  parseTagMessageInput,
  parseWorkspaceNames,
  storedTaskFindings,
  TAG_MAILBOX_MAX_OUTSTANDING,
  TAG_MESSAGE_TYPES,
  type TagMailboxCredential,
  type TagMailboxStore,
  type TagMessage,
  type TagMessageDelivery,
  TagMessagingError,
  type TagMessagingGrant,
  TEAM_LIVE_DELIVERY_PENDING_MS,
  teamSupportsObjective,
  WORKSTREAM_POST_MAX_BODY,
  type Workstream,
  type WorkstreamPost,
  type WorkstreamStore,
  workspacesForGitHubRepository,
} from "@supertag/core";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";
import { lockObjective } from "./objective-lock.js";
import {
  expireClosedObjectiveApprovals,
  refuseCompletionWithPendingQuestions,
  resolveCancelledObjectiveQuestions,
} from "./operator-question-resolution.js";
import { appendResourceChange } from "./resource-change-store.js";
import { nextTaskEventSequence } from "./task-event-sequence.js";
import {
  loadTeamChannel,
  mayPostTeamChannel,
  mayReadTeamChannel,
  readableChannelObjectives,
  type TeamChannel,
  teamChannelView,
} from "./team-channel.js";
import { TEAM_REPLY_DUPLICATE_WINDOW_MS } from "./team-reply-loop-brakes.js";
import { queueTeamReplyTrigger } from "./team-reply-triggers.js";
import { handleOperatorInputs, unhandledOperatorInputs } from "./unhandled-operator-input.js";

const MAX_DELIVERIES = 5;
const TEAM_CONVERSATION_TYPES = new Set([
  "note",
  "question",
  "blocker",
  "evidence",
  "decision",
  "message",
  "clarification.requested",
  "progress.updated",
  "priority.proposed",
  "priority.accepted",
  "priority.declined",
]);
const TEAM_DIRECT_MAX_OUTSTANDING = 100;

function sharesActiveTeam(
  teams: readonly any[],
  objectiveId: string,
  senderTagId: string,
  recipientTagId: string,
): boolean {
  return teams.some(
    (team) =>
      team.status === "active" &&
      teamSupportsObjective(team, objectiveId) &&
      (team.leadTagId === senderTagId || team.memberTagIds.includes(senderTagId)) &&
      (team.leadTagId === recipientTagId || team.memberTagIds.includes(recipientTagId)),
  );
}

function currentDirectTeamParticipants(message: any, team: any, provider: DatabaseProvider) {
  const member = (tagId: any) =>
    provider === "sqlite"
      ? sql`exists (select 1 from json_each(${team.memberTagIds}) where value = ${tagId})`
      : sql`${team.memberTagIds} @> jsonb_build_array(${tagId}::text)`;
  const linked =
    provider === "sqlite"
      ? sql`exists (select 1 from json_each(${team.objectiveIds}) where value = ${message.objectiveId})`
      : sql`${team.objectiveIds} @> jsonb_build_array(${message.objectiveId}::text)`;
  return sql`exists (select 1 from ${team} where ${team.id} = ${message.directTeamId} and ${team.status} = 'active' and (${team.objectiveId} = ${message.objectiveId} or ${linked}) and (${team.leadTagId} = ${message.senderTagId} or ${member(message.senderTagId)}) and (${team.leadTagId} = ${message.recipientTagId} or ${member(message.recipientTagId)}))`;
}

function visibleDirectMessage(message: any, team: any, provider: DatabaseProvider) {
  return or(
    sql`${message.directTeamId} is null`,
    and(
      sql`${message.status} <> 'failed'`,
      or(
        sql`${message.status} <> 'pending'`,
        currentDirectTeamParticipants(message, team, provider),
      ),
    ),
  );
}

/** One logical inbox per Tag; no separately provisioned mailbox row. */
/** The author recorded on deadline notices the Control Plane raises by itself. */
const OBJECTIVE_LIMITS_AUTHOR = "supertag:objective-limits";

export class DrizzleMailboxStore
  implements
    TagMailboxStore,
    WorkstreamStore,
    Omit<ObjectiveStore, "getObjectiveSurfaceTask" | "findObjectiveByNotificationSession">
{
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  private surfaceTransaction<T>(work: (tx: any) => Generator<any, T, any>): Promise<T> {
    return runDialectTransaction(this.db, this.provider, work);
  }
  private *surfaceSource(tx: any, taskId: string): Generator<any, any, any> {
    const t = this.tables.tasks,
      e = this.tables.durableInboundEvents,
      s = this.tables.sessions,
      c = this.tables.surfaceAccounts,
      tags = this.tables.tags;
    const [task] = yield tx.select().from(t).where(eq(t.id, taskId)).limit(1);
    if (!task?.inboundEventId || task.authorizationSnapshot?.version !== 5) return undefined;
    const [inbound] = yield tx.select().from(e).where(eq(e.id, task.inboundEventId)).limit(1);
    const [session] = yield tx.select().from(s).where(eq(s.id, task.sessionId)).limit(1);
    const [tag] = yield tx.select().from(tags).where(eq(tags.id, task.tagId)).limit(1);
    if (!inbound || !session || tag?.status !== "active") return undefined;
    const [account] = yield tx.select().from(c).where(eq(c.id, inbound.surfaceAccountId)).limit(1);
    const event = inbound.event,
      auth = task.authorizationSnapshot;
    const callback = event?.callback;
    const mode = {
      github: "github_issue_comment",
      linear: "linear_issue_comment",
      slack: "slack_thread",
      lark: "lark_thread",
      teams: "teams_thread",
    }[event?.provider as "github" | "linear" | "slack" | "lark" | "teams"];
    if (
      !callback ||
      callback.mode !== mode ||
      typeof callback.threadKey !== "string" ||
      !callback.threadKey ||
      !callback.target ||
      typeof callback.target !== "object" ||
      Array.isArray(callback.target) ||
      Object.keys(callback.target).length === 0 ||
      Object.values(callback.target).some((value) => typeof value !== "string")
    )
      return undefined;
    if (
      !account ||
      !event ||
      event.actor?.kind !== "user" ||
      task.actor?.kind !== "user" ||
      task.tagId !== inbound.tagId ||
      session.tagId !== task.tagId ||
      session.sessionKey !== event.sessionKey ||
      event.provider !== account.provider ||
      event.externalAccountId !== account.externalAccountId ||
      event.callback?.provider !== event.provider ||
      inbound.authorization?.version !== 5 ||
      inbound.authorization?.tag?.id !== task.tagId ||
      inbound.authorization?.origin?.surfaceAccountId !== inbound.surfaceAccountId ||
      inbound.authorization?.origin?.tagRouteId !== inbound.tagRouteId ||
      inbound.authorization?.origin?.provider !== event.provider ||
      inbound.authorization?.origin?.scope !== event.scope ||
      inbound.authorization?.requester?.id !== event.actor.id ||
      inbound.authorization?.requester?.kind !== "user" ||
      auth.tag?.id !== task.tagId ||
      auth.origin?.surfaceAccountId !== inbound.surfaceAccountId ||
      auth.origin?.tagRouteId !== inbound.tagRouteId ||
      auth.origin?.provider !== event.provider ||
      auth.origin?.scope !== event.scope ||
      task.actor.id !== event.actor.id ||
      auth.requester?.id !== event.actor.id ||
      auth.requester?.kind !== "user" ||
      !Array.isArray(auth.runtimeActions) ||
      !Array.isArray(inbound.authorization?.runtimeActions) ||
      auth.runtimeActions.some(
        (action: string) => !inbound.authorization.runtimeActions.includes(action),
      )
    )
      return undefined;
    const audience = canonicalJson({
      surfaceAccountId: inbound.surfaceAccountId,
      provider: event.provider,
      externalAccountId: event.externalAccountId,
      scope: event.scope,
      sessionKey: event.sessionKey,
      callback: event.callback,
    });
    return { task, inbound, session, audience };
  }
  private *notificationSource(tx: any, taskId: string): Generator<any, any, any> {
    const source = yield* this.surfaceSource(tx, taskId);
    if (!source) return undefined;
    const accounts = this.tables.surfaceAccounts;
    const [account] = yield tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, source.inbound.surfaceAccountId));
    return account?.status === "connected" ? source : undefined;
  }
  async getVerifiedSurfaceTask(
    taskId: string,
  ): ReturnType<ObjectiveStore["getVerifiedSurfaceTask"]> {
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      return (yield* self.notificationSource(tx, mailboxText(taskId, "taskId")))?.task;
    });
  }
  async createSurfaceObjective(
    input: Parameters<ObjectiveStore["createSurfaceObjective"]>[0],
  ): Promise<Objective> {
    const record = mailboxObject(input, [
      "taskId",
      "outcome",
      "deadline",
      "budgetLimitMinor",
      "budgetCurrency",
      "workspaces",
    ]);
    const taskId = mailboxText(record["taskId"], "taskId");
    const requestedWorkspaces =
      record["workspaces"] === undefined ? undefined : parseWorkspaceNames(record["workspaces"]);
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const source = yield* self.surfaceSource(tx, taskId);
      if (!source || parseSurfaceObjectiveCommand(source.inbound.event)?.kind !== "create")
        throw new TagMessagingError(
          403,
          "An explicit human Objective creation command is required",
        );
      const s = self.tables.sessions,
        o = self.tables.objectives;
      yield tx
        .update(s)
        .set({ updatedAt: sql`${s.updatedAt}` })
        .where(eq(s.id, source.task.sessionId))
        .returning();
      const id = `surface:${createHash("sha256").update(source.task.sessionId).digest("hex")}`;
      const { taskId: _task, workspaces: _workspaces, ...request } = record;
      const workspaces = yield* self.surfaceWorkspaces(tx, source, requestedWorkspaces);
      const definition = parseCreateObjective({
        ...request,
        id,
        runtimeActions: source.task.authorizationSnapshot.runtimeActions,
        workspaces,
      });
      const associations = self.tables.objectiveSessions;
      const [association] = yield tx
        .select()
        .from(associations)
        .where(eq(associations.sessionId, source.task.sessionId))
        .limit(1);
      const [existing] = association
        ? yield tx.select().from(o).where(eq(o.id, association.objectiveId)).limit(1)
        : [];

      if (existing) {
        const anchor = association.surfaceTaskId
          ? yield* self.surfaceSource(tx, association.surfaceTaskId)
          : undefined;
        if (
          !anchor ||
          existing.ownerTagId !== source.task.tagId ||
          anchor.audience !== source.audience
        )
          throw new TagMessagingError(
            409,
            "Conversation binding conflicts with the verified surface",
          );
        if (
          existing.outcome !== definition.outcome ||
          (existing.deadline ?? null) !== definition.deadline ||
          (existing.budgetLimitMinor ?? null) !== definition.budgetLimitMinor ||
          (existing.budgetCurrency ?? null) !== definition.budgetCurrency ||
          (requestedWorkspaces !== undefined &&
            canonicalJson(existing.workspaces ?? []) !== canonicalJson(definition.workspaces ?? []))
        )
          throw new TagMessagingError(
            409,
            "This conversation already has a different Objective definition",
          );
        yield tx
          .update(self.tables.tasks)
          .set({ surfaceObjectiveId: existing.id })
          .where(eq(self.tables.tasks.id, source.task.id))
          .returning();
        return existing as Objective;
      }
      const at = new Date().toISOString();
      const [created] = yield tx
        .insert(o)
        .values({
          ...definition,
          ownerTagId: source.task.tagId,
          surfaceTaskId: source.task.id,
          surfaceSessionId: source.task.sessionId,
          status: "working",
          revision: 1,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) throw new TagMessagingError(409, "Objective identity is already in use");
      yield tx
        .insert(associations)
        .values({
          sessionId: source.task.sessionId,
          objectiveId: created.id,
          surfaceTaskId: source.task.id,
          createdAt: at,
        })
        .returning();
      yield tx
        .update(self.tables.tasks)
        .set({ surfaceObjectiveId: created.id })
        .where(eq(self.tables.tasks.id, source.task.id))
        .returning();
      return created as Objective;
    });
  }
  /**
   * The Workspaces an Objective created from a verified surface Task gets: those its location
   * attaches, or for a GitHub location without any, those whose `source` is the repository.
   */
  private *surfaceWorkspaces(
    tx: any,
    source: any,
    requested: readonly string[] | undefined,
  ): Generator<any, readonly string[], any> {
    const routes = this.tables.tagRoutes,
      table = this.tables.workspaces;
    const [route] = yield tx
      .select()
      .from(routes)
      .where(eq(routes.id, source.inbound.tagRouteId))
      .limit(1);
    const event = source.inbound.event;
    const explicit: readonly string[] = Array.isArray(route?.workspaces) ? route.workspaces : [];
    const repository = event?.callback?.target?.repository;
    let allowed = explicit;
    if (explicit.length === 0 && event?.provider === "github" && typeof repository === "string")
      allowed = workspacesForGitHubRepository(
        yield tx.select().from(table).orderBy(asc(table.name)),
        repository,
      );
    const names = narrowObjectiveWorkspaces(
      allowed,
      requested,
      `This ${String(event?.provider ?? "surface")} location`,
    );
    if (names.length === 0) return names;
    const rows = yield tx
      .select({ name: table.name })
      .from(table)
      .where(inArray(table.name, [...names]));
    const known = new Set(rows.map((row: { name: string }) => row.name));
    const missing = names.filter((name) => !known.has(name));
    if (missing.length > 0)
      throw new TagMessagingError(
        400,
        `Workspace ${missing.join(", ")} named by this location does not exist; apply a Workspace manifest or change the Tag's location`,
      );
    return names;
  }
  async attachSurfaceObjective(taskId: string, objectiveId: string): Promise<Objective> {
    mailboxText(taskId, "taskId");
    mailboxText(objectiveId, "objectiveId");
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const source = yield* self.surfaceSource(tx, taskId);
      const command = source ? parseSurfaceObjectiveCommand(source.inbound.event) : undefined;
      if (!source || command?.kind !== "attach" || command.objectiveId !== objectiveId)
        throw new TagMessagingError(
          403,
          "An explicit human Objective attachment command is required",
        );
      const sessions = self.tables.sessions,
        objectives = self.tables.objectives,
        associations = self.tables.objectiveSessions;
      yield tx
        .update(sessions)
        .set({ updatedAt: sql`${sessions.updatedAt}` })
        .where(eq(sessions.id, source.task.sessionId))
        .returning();
      const [objective] = yield tx
        .select()
        .from(objectives)
        .where(eq(objectives.id, objectiveId))
        .limit(1);
      const anchor = objective?.surfaceTaskId
        ? yield* self.surfaceSource(tx, objective.surfaceTaskId)
        : undefined;
      if (
        !anchor ||
        objective.ownerTagId !== source.task.tagId ||
        !sameSurfaceAudience(anchor, source)
      )
        throw new TagMessagingError(403, "Objective cannot be attached to this verified audience");
      const [existing] = yield tx
        .select()
        .from(associations)
        .where(eq(associations.sessionId, source.task.sessionId))
        .limit(1);
      if (existing) {
        const verified = yield* self.surfaceSource(tx, existing.surfaceTaskId);
        if (existing.objectiveId !== objective.id || verified?.audience !== source.audience)
          throw new TagMessagingError(
            409,
            "Conversation is already associated with another Objective or audience",
          );
        yield tx
          .update(self.tables.tasks)
          .set({ surfaceObjectiveId: objective.id })
          .where(eq(self.tables.tasks.id, source.task.id))
          .returning();
        return objective as Objective;
      }
      yield tx
        .insert(associations)
        .values({
          sessionId: source.task.sessionId,
          objectiveId: objective.id,
          surfaceTaskId: source.task.id,
          createdAt: new Date().toISOString(),
        })
        .returning();
      yield tx
        .update(self.tables.tasks)
        .set({ surfaceObjectiveId: objective.id })
        .where(eq(self.tables.tasks.id, source.task.id))
        .returning();
      return objective as Objective;
    });
  }
  async getSurfaceObjective(taskId: string): Promise<Objective | undefined> {
    mailboxText(taskId, "taskId");
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const source = yield* self.surfaceSource(tx, taskId);
      if (!source) return undefined;
      const o = self.tables.objectives,
        associations = self.tables.objectiveSessions;
      const [association] = yield tx
        .select()
        .from(associations)
        .where(eq(associations.sessionId, source.task.sessionId))
        .limit(1);
      if (!association || source.task.surfaceObjectiveId !== association.objectiveId)
        return undefined;
      const [objective] = yield tx
        .select()
        .from(o)
        .where(and(eq(o.id, association.objectiveId), eq(o.ownerTagId, source.task.tagId)))
        .limit(1);
      if (!objective) return undefined;
      const boundSource = yield* self.surfaceSource(tx, association.surfaceTaskId);
      return boundSource?.audience === source.audience ? (objective as Objective) : undefined;
    });
  }
  async createObjective(
    input: Parameters<ObjectiveStore["createObjective"]>[0],
    options: Parameters<ObjectiveStore["createObjective"]>[1] = {},
  ): Promise<Objective> {
    const { ownerTagId, ...request } = input;
    const definition = parseCreateObjective(request);
    await this.activeTag(ownerTagId);
    if (
      definition.notificationTaskId &&
      !(await this.getVerifiedSurfaceTask(definition.notificationTaskId))
    )
      throw new TagMessagingError(
        400,
        "notificationTaskId must reference a verified human surface Task with a connected account",
      );
    for (const name of definition.workspaces ?? []) {
      const [workspace] = await this.db
        .select({ id: this.tables.workspaces.id })
        .from(this.tables.workspaces)
        .where(eq(this.tables.workspaces.name, name))
        .limit(1);
      if (!workspace)
        throw new TagMessagingError(
          400,
          `Workspace ${name} does not exist; apply a Workspace manifest before naming it`,
        );
    }
    const t = this.tables.objectives;
    const at = new Date().toISOString();
    const values = {
      ...definition,
      ownerTagId,
      status: "working",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    if (options.dryRun) {
      const [existing] = await this.db
        .select({ id: t.id })
        .from(t)
        .where(eq(t.id, definition.id))
        .limit(1);
      // The would-be record; an existing ID falls through to the same conflict check as creation.
      if (!existing)
        return {
          ...values,
          completionSummary: null,
          executionStartedAt: null,
          spentMinor: 0,
          reservedMinor: 0,
        } as Objective;
    } else {
      const rows = await this.db
        .insert(t)
        .values(values)
        .onConflictDoNothing({ target: t.id })
        .returning();
      if (rows[0]) return rows[0] as Objective;
    }
    const prior = await this.getObjective(definition.id);
    if (
      (prior.notificationTaskId ?? null) !== (definition.notificationTaskId ?? null) ||
      canonicalJson(prior.observations ?? []) !== canonicalJson(definition.observations ?? []) ||
      Boolean(prior.ongoing) !== Boolean(definition.ongoing) ||
      prior.ownerTagId !== ownerTagId ||
      prior.outcome !== definition.outcome ||
      (prior.deadline ?? null) !== definition.deadline ||
      (prior.budgetLimitMinor ?? null) !== definition.budgetLimitMinor ||
      (prior.budgetCurrency ?? null) !== definition.budgetCurrency ||
      canonicalJson(prior.runtimeActions ?? []) !== canonicalJson(definition.runtimeActions) ||
      canonicalJson(prior.workspaces ?? []) !== canonicalJson(definition.workspaces ?? [])
    )
      throw new TagMessagingError(409, "Objective ID already exists with a different definition");
    return prior;
  }

  private objectiveVisibility(tagId: string) {
    const o = this.tables.objectives;
    const team = this.tables.teams;
    const teamMember =
      this.provider === "sqlite"
        ? sql`exists (select 1 from json_each(${team.memberTagIds}) where value = ${tagId})`
        : sql`${team.memberTagIds} @> ${JSON.stringify([tagId])}::jsonb`;
    const linked =
      this.provider === "sqlite"
        ? sql`exists (select 1 from json_each(${team.objectiveIds}) where value = ${o.id})`
        : sql`${team.objectiveIds} @> jsonb_build_array(${o.id})`;
    return or(
      sql`exists (select 1 from ${team} where (${team.objectiveId} = ${o.id} or ${linked}) and ${team.status} = ${"active"} and ${teamMember})`,
      eq(o.ownerTagId, tagId),
    );
  }

  async getObjective(id: string, viewerTagId?: string): Promise<Objective> {
    const t = this.tables.objectives;
    const rows = await this.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.id, mailboxText(id, "objectiveId")),
          viewerTagId === undefined ? undefined : this.objectiveVisibility(viewerTagId),
        ),
      )
      .limit(1);
    if (!rows[0])
      throw new TagMessagingError(404, "Objective not found or not visible to this Tag");
    return rows[0] as Objective;
  }

  async listObjectives(tagId?: string, limit = 100, offset = 0): Promise<readonly Objective[]> {
    if (tagId !== undefined) await this.activeTag(tagId);
    checkLimit(limit);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new TagMessagingError(400, "offset must be a nonnegative safe integer");
    const t = this.tables.objectives;
    return this.db
      .select()
      .from(t)
      .where(tagId === undefined ? undefined : eq(t.ownerTagId, tagId))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit)
      .offset(offset);
  }

  async listVisibleObjectives(tagId: string, limit = 100): Promise<readonly Objective[]> {
    await this.activeTag(tagId);
    checkLimit(limit);
    const t = this.tables.objectives;
    return this.db
      .select()
      .from(t)
      .where(this.objectiveVisibility(tagId))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit);
  }

  async listExecutingObjectives(
    limit = 1000,
  ): ReturnType<ObjectiveStore["listExecutingObjectives"]> {
    const o = this.tables.objectives;
    return this.db
      .select({
        id: o.id,
        ownerTagId: o.ownerTagId,
        status: o.status,
        revision: o.revision,
        createdAt: o.createdAt,
        deadline: o.deadline,
        budgetLimitMinor: o.budgetLimitMinor,
        budgetCurrency: o.budgetCurrency,
        limitState: o.limitState,
        spentMinor: o.spentMinor,
        reservedMinor: o.reservedMinor,
      })
      .from(o)
      .where(
        and(
          sql`${o.executionStartedAt} is not null`,
          sql`${o.status} not in ('completed', 'cancelled')`,
        ),
      )
      .orderBy(asc(o.createdAt), asc(o.id))
      .limit(limit);
  }

  async listOpenObjectives(limit = 10_000): Promise<readonly Objective[]> {
    const o = this.tables.objectives;
    return this.db
      .select()
      .from(o)
      .where(sql`${o.status} not in ('completed', 'cancelled')`)
      .orderBy(asc(o.createdAt), asc(o.id))
      .limit(limit);
  }

  async recordObjectiveLimitState(
    id: string,
    state: ObjectiveLimitState,
    expectedRevision: number,
    limited = false,
  ): Promise<Objective | undefined> {
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const o = self.tables.objectives;
      // Claims lock this row before checking admission. Recheck the drain under that
      // lock, then persist exhaustion even when a claim won the race.
      const [locked] = yield lockObjective(tx, o, mailboxText(id, "objectiveId"));
      if (!locked || locked.revision !== expectedRevision) return undefined;
      const [previous] = yield tx
        .select()
        .from(o)
        .where(and(eq(o.id, mailboxText(id, "objectiveId")), eq(o.revision, expectedRevision)));
      if (!previous) return undefined;
      const running = limited
        ? yield tx
            .select({ taskId: self.tables.taskAssignments.taskId })
            .from(self.tables.taskAssignments)
            .where(
              and(
                eq(self.tables.taskAssignments.objectiveId, id),
                eq(self.tables.taskAssignments.status, "running"),
              ),
            )
        : [];
      const drained = limited && running.length === 0;
      const [updated] = yield tx
        .update(o)
        .set({
          limitState:
            drained && previous.status !== "limited"
              ? {
                  ...state,
                  summary: undefined,
                  summaryTaskId: `${id}:limit-summary:${expectedRevision + 1}`,
                }
              : state,
          ...(drained && previous.status !== "limited"
            ? {
                status: "limited",
                revision: sql`${o.revision} + 1`,
                updatedAt: new Date().toISOString(),
              }
            : {}),
        })
        .where(and(eq(o.id, id), eq(o.revision, expectedRevision)))
        .returning();
      if (!updated) return undefined;
      // Each newly raised deadline warning, and the deadline passing, reaches the owner once.
      const known = new Set(objectiveDeadlineNotices(previous).map((notice) => notice.key));
      for (const notice of objectiveDeadlineNotices(updated))
        if (notice.kind !== "objective_deadline_set" && !known.has(notice.key))
          yield* self.ownerDeadlineNotice(tx, updated, notice, OBJECTIVE_LIMITS_AUTHOR);
      return updated as Objective;
    });
  }

  /**
   * A trusted system notice in the owner's Mailbox, like the cancellation notice. It is already
   * processed, so it never blocks completion; the controller wakes a waiting owner and attaches
   * it to a running owner's tool results.
   */
  private *ownerDeadlineNotice(
    tx: any,
    objective: { readonly id: string; readonly ownerTagId: string },
    notice: {
      readonly key: string;
      readonly kind: string;
      readonly deadline: string;
      readonly at: string;
      readonly message: string;
    },
    operatorId: string,
  ): Generator<any, void, any> {
    const m = this.tables.tagMessages;
    const message = {
      recipientTagId: objective.ownerTagId,
      objectiveId: objective.id,
      type: "message",
      body: { message: notice.message, kind: notice.kind, deadline: notice.deadline },
      idempotencyKey: `objective-${notice.key}:${objective.id}`.slice(0, 200),
    };
    yield tx
      .insert(m)
      .values({
        ...message,
        id: randomUUID(),
        senderTagId: objective.ownerTagId,
        operatorId,
        fingerprint: createHash("sha256")
          .update(canonicalJson({ ...message, operatorId }))
          .digest("hex"),
        status: "processed",
        attemptCount: 0,
        processedAt: notice.at,
        createdAt: notice.at,
        updatedAt: notice.at,
      })
      .onConflictDoNothing({ target: [m.senderTagId, m.idempotencyKey] })
      .returning();
  }

  async updateObjectiveStatus(
    id: string,
    input: Parameters<ObjectiveStore["updateObjectiveStatus"]>[1],
    actorTagId?: string,
    execution?: Parameters<ObjectiveStore["updateObjectiveStatus"]>[3],
    source?: Parameters<ObjectiveStore["updateObjectiveStatus"]>[4],
  ): Promise<Objective> {
    const update = parseObjectiveStatus(input);
    if (update.budgetLimitMinor !== undefined && actorTagId !== undefined)
      throw new TagMessagingError(403, "Only operators may increase Objective allocation");
    if (update.deadline !== undefined && actorTagId !== undefined)
      throw new TagMessagingError(403, "Only operators may change an Objective deadline");
    if (update.notificationTaskId !== undefined && actorTagId !== undefined)
      throw new TagMessagingError(
        403,
        "Only operators may change Objective notification destinations",
      );
    if (update.runtimeActions !== undefined && actorTagId !== undefined)
      throw new TagMessagingError(403, "Only operators may change Objective runtime actions");
    await this.getObjective(id, actorTagId);
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const o = self.tables.objectives;
      yield lockObjective(tx, o, id);
      const [objective] = yield tx.select().from(o).where(eq(o.id, id));
      if (actorTagId !== undefined && actorTagId !== objective.ownerTagId)
        throw new TagMessagingError(403, "Only the Objective owner can change its status");
      if (objective.status === "cancelled")
        throw new TagMessagingError(409, "A cancelled Objective cannot change");
      if (objective.status === "limited" && actorTagId !== undefined && update.status !== "limited")
        throw new TagMessagingError(403, "Only an operator can resume a limited Objective");
      if (objective.revision !== update.expectedRevision)
        throw new TagMessagingError(409, "Objective revision changed; reload before updating");
      if (update.status === "completed")
        yield* refuseCompletionWithPendingQuestions(tx, self.tables, id, objective.ownerTagId);
      if (actorTagId !== undefined && update.status === "completed" && objective.ongoing)
        throw new TagMessagingError(
          403,
          "Only operators may end an ongoing Objective; completing an assessment does not end the responsibility",
        );
      if (
        update.budgetLimitMinor !== undefined &&
        (objective.status === "completed" ||
          objective.budgetLimitMinor == null ||
          update.budgetLimitMinor <= objective.budgetLimitMinor ||
          update.budgetLimitMinor < objective.spentMinor + objective.reservedMinor)
      )
        throw new TagMessagingError(
          409,
          "Increase an active Objective's finite allocation above its current limit and committed amount",
        );
      if (update.deadline !== undefined && objective.status === "completed")
        throw new TagMessagingError(409, "A completed Objective's deadline cannot change");
      const at = new Date().toISOString();
      if (update.status === "limited") {
        if (objective.status !== "limited" || actorTagId !== objective.ownerTagId || !execution)
          throw new TagMessagingError(
            403,
            "Only the final owner activation can record a limit summary",
          );
        if (execution.taskId !== objective.limitState?.summaryTaskId)
          throw new TagMessagingError(403, "Limit summary activation required");
        if (objective.limitState?.summary)
          throw new TagMessagingError(409, "Limit summary already recorded");
      }
      const deadlineChanged =
        update.deadline !== undefined && update.deadline !== (objective.deadline ?? null);
      const nextBudget = update.budgetLimitMinor ?? objective.budgetLimitMinor;
      const nextDeadline = update.deadline ?? objective.deadline;
      const budgetClear =
        !objective.budgetCurrency ||
        nextBudget == null ||
        (nextBudget > (objective.limitState?.reportedSpend?.amountMinor ?? 0) &&
          nextBudget !== objective.limitState?.budgetExhausted?.limitMinor);
      const deadlineClear = !nextDeadline || nextDeadline > at;
      const resuming =
        objective.status === "limited" &&
        (update.budgetLimitMinor !== undefined || deadlineChanged) &&
        budgetClear &&
        deadlineClear;
      if (resuming && !objective.limitState?.summary)
        throw new TagMessagingError(
          409,
          "Wait for the Objective's final limit summary before resuming",
        );
      if (
        objective.status === "limited" &&
        update.status &&
        update.status !== "limited" &&
        !resuming
      )
        throw new TagMessagingError(
          409,
          "Raise the budget or move the deadline to resume a limited Objective",
        );
      const runtimeActionsChanged =
        update.runtimeActions !== undefined &&
        canonicalJson(update.runtimeActions) !== canonicalJson(objective.runtimeActions ?? []);
      if (
        update.notificationTaskId &&
        !(yield* self.notificationSource(tx, update.notificationTaskId))
      )
        throw new TagMessagingError(
          400,
          "notificationTaskId must reference a verified human surface Task with a connected account",
        );
      let completing: { task: any; attempt: any; sourceMessageId: string | null } | undefined;
      if (execution !== undefined) {
        if (
          (update.status !== "completed" && update.status !== "limited") ||
          actorTagId === undefined
        )
          throw new TagMessagingError(
            400,
            "Completion execution requires an authenticated owner completion",
          );
        const q = self.tables.taskAssignments,
          t = self.tables.tasks,
          a = self.tables.taskAttempts;
        const [assignment] = yield tx.select().from(q).where(eq(q.taskId, execution.taskId));
        const [task] = yield tx.select().from(t).where(eq(t.id, execution.taskId));
        const [attempt] = yield tx
          .select()
          .from(a)
          .where(eq(a.taskId, execution.taskId))
          .orderBy(desc(a.attemptNumber))
          .limit(1);
        if (
          !assignment ||
          (update.status === "limited" && !assignment.limitSummaryActivation) ||
          assignment.objectiveId !== id ||
          assignment.assignedTagId !== actorTagId ||
          assignment.status !== "running" ||
          assignment.leaseOwner !== execution.leaseOwner ||
          assignment.attemptCount !== execution.attemptCount ||
          !assignment.leaseExpiresAt ||
          assignment.leaseExpiresAt <= at ||
          !task ||
          task.status !== "running" ||
          !attempt ||
          attempt.status !== "running" ||
          attempt.attemptNumber !== execution.attemptCount
        )
          throw new TagMessagingError(409, "Completion execution authority expired");
        const [tag] = yield tx
          .select()
          .from(self.tables.tags)
          .where(eq(self.tables.tags.id, actorTagId));
        const [team] = yield tx
          .select()
          .from(self.tables.teams)
          .where(eq(self.tables.teams.id, assignment.teamId));
        if (
          objective.status === "completed" ||
          // A running owner may still complete during the deadline grace period.
          (update.status === "completed" && objectiveDeadlineStopsRunning(objective, at)) ||
          tag?.status !== "active" ||
          team?.status !== "active" ||
          !team.memberTagIds.includes(actorTagId)
        )
          throw new TagMessagingError(403, "Completion execution authority revoked");
        completing = { task, attempt, sourceMessageId: assignment.sourceMessageId };
      }
      let completionSummary = update.completionSummary;
      if (update.status === "completed" || update.status === "ready_for_review") {
        const assignments = self.tables.taskAssignments;
        const rows = (yield tx
          .select({ taskId: assignments.taskId, result: assignments.result })
          .from(assignments)
          .where(eq(assignments.objectiveId, id))) as Array<{ taskId: string; result: unknown }>;
        const open = rows.flatMap((row) =>
          storedTaskFindings(row.result)
            .filter((finding) => finding.status === "open")
            .map((finding) => ({ taskId: row.taskId, finding })),
        );
        const line = ({ taskId, finding }: (typeof open)[number]) =>
          `${taskId} ${finding.id}: ${finding.summary}${finding.location ? ` (${finding.location})` : ""}`;
        const high = open.filter(({ finding }) => finding.severity === "high");
        if (high.length && actorTagId !== undefined)
          throw new TagMessagingError(
            409,
            `Objective cannot be ${update.status} while high findings are open: ${high.map(line).join("; ")}`,
          );
        if (update.status === "completed") {
          if (high.length && actorTagId === undefined)
            completionSummary =
              `${completionSummary ?? ""}\nOperator ${source?.operatorId ?? "administrative-api"} completed this Objective with open high findings:\n${high.map(({ taskId, finding }) => `- high: ${line({ taskId, finding })}`).join("\n")}`.trim();
          const lower = open.filter(({ finding }) => finding.severity !== "high");
          if (lower.length)
            completionSummary =
              `${completionSummary ?? ""}\nOpen medium and low findings:\n${lower.map(({ taskId, finding }) => `- ${finding.severity}: ${line({ taskId, finding })}`).join("\n")}`.trim();
        }
      }
      if (update.status === "completed") {
        const assignments = self.tables.taskAssignments;
        const unsettled = (yield tx
          .select({
            taskId: assignments.taskId,
            objectiveId: assignments.objectiveId,
            teamId: assignments.teamId,
            assignedTagId: assignments.assignedTagId,
            requestedByTagId: assignments.requestedByTagId,
            sourceMessageId: assignments.sourceMessageId,
            status: assignments.status,
            parentTaskId: assignments.parentTaskId,
          })
          .from(assignments)
          .where(eq(assignments.objectiveId, id))) as Array<{
          taskId: string;
          objectiveId: string;
          teamId: string;
          assignedTagId: string;
          requestedByTagId: string;
          sourceMessageId: string | null;
          status: string;
          parentTaskId: string | null;
        }>;
        const outstanding = unsettled.filter(
          (task) =>
            task.taskId !== execution?.taskId &&
            (actorTagId === undefined || task.assignedTagId !== actorTagId) &&
            // The owner's own finished activations have no reviewer; they never await review.
            // Other submitted work assigned to the completing owner is settled by terminal
            // cleanup, which records that no review took place.
            !ownerActivationAwaitsNoReview(task, objective.ownerTagId) &&
            ["queued", "running", "waiting", "submitted"].includes(task.status),
        );
        if (outstanding.length > 0) {
          const listed = outstanding
            .slice(0, 5)
            .map((task) => `${task.taskId} (${task.status})`)
            .join(", ");
          const remaining = outstanding.length > 5 ? ` and ${outstanding.length - 5} more` : "";
          throw new TagMessagingError(
            409,
            `Objective cannot be completed while Tasks remain unsettled: ${listed}${remaining}. Use read_task, then accept, reject, or cancel each Task before retrying update_objective.`,
          );
        }
        const messages = self.tables.tagMessages;
        const unsettledMessages = (
          (yield tx
            .select({ id: messages.id, type: messages.type, status: messages.status })
            .from(messages)
            .where(
              and(
                eq(messages.objectiveId, id),
                or(eq(messages.status, "pending"), eq(messages.status, "processing")),
                // Team messages settle on reading; pending ones fail on completion.
                sql`${messages.directTeamId} is null`,
              ),
            )) as Array<{ id: string; type: string; status: string }>
        ).filter(
          (message) =>
            message.id !== completing?.sourceMessageId &&
            // Messages delivered to the completing Attempt are its to handle.
            !ownerDeliveries(completing?.task.trigger).pending.some(
              (item) =>
                item.kind === "message" &&
                item.id === message.id &&
                item.attempt === completing?.attempt.attemptNumber,
            ),
        );
        if (unsettledMessages.length > 0) {
          const listed = unsettledMessages
            .slice(0, 5)
            .map((message) => `${message.id} (${message.type}, ${message.status})`)
            .join(", ");
          const remaining =
            unsettledMessages.length > 5 ? ` and ${unsettledMessages.length - 5} more` : "";
          throw new TagMessagingError(
            409,
            `Objective cannot be completed while Mailbox messages remain unsettled: ${listed}${remaining}. Release the manager with a bounded wait so recipients can process them, then reread state and retry update_objective.`,
          );
        }
      }
      const [updated] = yield tx
        .update(o)
        .set({
          ...(resuming ? { status: "working" } : {}),
          ...(update.status === undefined
            ? {}
            : {
                status: update.status,
                ...(update.status === "limited"
                  ? {
                      limitState: {
                        ...(objective.limitState ?? {}),
                        summary: { text: update.completionSummary ?? "", at },
                      },
                    }
                  : { completionSummary: completionSummary ?? null }),
              }),
          ...(update.budgetLimitMinor === undefined
            ? {}
            : {
                budgetLimitMinor: update.budgetLimitMinor,
                ...(objective.observationState?.blocked ===
                "Observation delivery awaits available Objective budget"
                  ? { observationState: { ...objective.observationState, blocked: undefined } }
                  : {}),
              }),
          ...(update.notificationTaskId === undefined
            ? {}
            : { notificationTaskId: update.notificationTaskId }),
          ...(runtimeActionsChanged ? { runtimeActions: update.runtimeActions } : {}),
          ...(deadlineChanged
            ? {
                deadline: update.deadline,
                // Warnings already due when the deadline was set are skipped.
                limitState: {
                  ...(objective.limitState ?? {}),
                  deadlineSetAt: { deadline: update.deadline, at },
                },
                ...(objective.observationState?.blocked ===
                "Observation delivery is pending beyond the Objective deadline; operator action required"
                  ? { observationState: { ...objective.observationState, blocked: undefined } }
                  : {}),
              }
            : {}),
          revision: sql`${o.revision} + 1`,
          updatedAt: at,
        })
        .where(and(eq(o.id, id), eq(o.revision, update.expectedRevision)))
        .returning();
      if (!updated)
        throw new TagMessagingError(409, "Objective revision changed; reload before updating");
      if (
        actorTagId === objective.ownerTagId &&
        !source?.operatorId &&
        (updated.status !== objective.status ||
          updated.completionSummary !== objective.completionSummary)
      )
        yield* handleOperatorInputs(
          tx,
          self.tables,
          objective,
          completing?.task.id ?? source?.taskId,
          execution?.attemptCount ?? source?.attemptCount,
          at,
          "objective",
          id,
        );
      let failedDirectMessageIds: string[] = [];
      if (update.status === "completed") {
        yield* expireClosedObjectiveApprovals(tx, self.tables, id, "completed", at);
        // No activation follows completion, so undelivered within-Team messages
        // would stay pending forever. They fail, which hides them from digests and read_mailbox.
        const m = self.tables.tagMessages;
        const failed = yield tx
          .update(m)
          .set({ status: "failed", updatedAt: at })
          .where(
            and(eq(m.objectiveId, id), eq(m.status, "pending"), sql`${m.directTeamId} is not null`),
          )
          .returning({ id: m.id });
        failedDirectMessageIds = failed.map((row: { id: string }) => row.id).sort();
      }
      if (
        (actorTagId === objective.ownerTagId &&
          (updated.status !== objective.status ||
            updated.completionSummary !== objective.completionSummary)) ||
        failedDirectMessageIds.length ||
        update.budgetLimitMinor !== undefined ||
        deadlineChanged ||
        runtimeActionsChanged
      )
        yield* appendResourceChange(tx, self.tables, {
          resourceType: "objective",
          resourceId: id,
          fromRevision: objective.revision,
          toRevision: updated.revision,
          actorTagId: actorTagId ?? null,
          operatorId: source?.operatorId ?? (actorTagId ? null : "administrative-api"),
          sourceTaskId: completing?.task.id ?? source?.taskId ?? null,
          sourceMessageId: null,
          changes: {
            ...(actorTagId === objective.ownerTagId
              ? { status: { previous: objective.status, next: updated.status } }
              : {}),
            ...(failedDirectMessageIds.length
              ? {
                  failedDirectMessages: {
                    previous: null,
                    next: { reason: "Objective completed", messageIds: failedDirectMessageIds },
                  },
                }
              : {}),
            ...(update.budgetLimitMinor === undefined
              ? {}
              : {
                  budgetLimitMinor: {
                    previous: objective.budgetLimitMinor,
                    next: update.budgetLimitMinor,
                  },
                }),
            ...(deadlineChanged
              ? { deadline: { previous: objective.deadline ?? null, next: update.deadline } }
              : {}),
            ...(runtimeActionsChanged
              ? {
                  runtimeActions: {
                    previous: objective.runtimeActions ?? [],
                    next: update.runtimeActions,
                  },
                }
              : {}),
          },
          createdAt: at,
        });
      if (deadlineChanged)
        yield* self.ownerDeadlineNotice(
          tx,
          updated,
          {
            key: `deadline-set-${update.deadline}-${at}`,
            kind: "objective_deadline_set",
            deadline: update.deadline as string,
            at,
            message: objectiveDeadlineSetMessage(update.deadline as string, at, objective.deadline),
          },
          source?.operatorId ?? "administrative-api",
        );
      if (completing) {
        const e = self.tables.taskEvents;
        const nextSequence = yield* nextTaskEventSequence(tx, e, completing.task.id);
        yield tx
          .insert(e)
          .values({
            id: randomUUID(),
            taskId: completing.task.id,
            attemptId: completing.attempt.id,
            sequence: nextSequence,
            type:
              update.status === "limited"
                ? "objective.limit-summary-recorded"
                : "objective.completed",
            payload: {
              objectiveId: id,
              objectiveRevision: updated.revision,
              attemptCount: completing.attempt.attemptNumber,
            },
            createdAt: at,
          })
          .returning();
      }
      return updated as Objective;
    });
  }

  async cancelObjective(
    id: string,
    input: Parameters<ObjectiveStore["cancelObjective"]>[1],
    source: Parameters<ObjectiveStore["cancelObjective"]>[2],
  ): Promise<{ readonly objective: Objective; readonly changed: boolean }> {
    mailboxText(id, "objectiveId");
    const reason = parseCancelObjective(input).reason ?? null;
    const operatorId = source?.operatorId;
    if (typeof operatorId !== "string" || !operatorId.trim() || operatorId.length > 200)
      throw new TagMessagingError(401, "Invalid operator principal");
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const o = self.tables.objectives,
        m = self.tables.tagMessages;
      yield lockObjective(tx, o, id);
      const [objective] = yield tx.select().from(o).where(eq(o.id, id));
      if (!objective) throw new TagMessagingError(404, "Objective not found");
      if (objective.status === "cancelled")
        return { objective: objective as Objective, changed: false };
      if (objective.status === "completed")
        throw new TagMessagingError(409, "A completed Objective cannot be cancelled");
      const at = new Date().toISOString();
      const [updated] = yield tx
        .update(o)
        .set({
          status: "cancelled",
          cancelledAt: at,
          cancellationReason: reason,
          revision: sql`${o.revision} + 1`,
          updatedAt: at,
        })
        .where(eq(o.id, id))
        .returning();
      yield* appendResourceChange(tx, self.tables, {
        resourceType: "objective",
        resourceId: id,
        fromRevision: objective.revision,
        toRevision: updated.revision,
        actorTagId: null,
        operatorId,
        sourceTaskId: null,
        sourceMessageId: null,
        changes: {
          status: { previous: objective.status, next: "cancelled" },
          ...(reason === null ? {} : { cancellationReason: { previous: null, next: reason } }),
        },
        createdAt: at,
      });
      yield* expireClosedObjectiveApprovals(tx, self.tables, id, "cancelled", at);
      yield* resolveCancelledObjectiveQuestions(tx, self.tables, id, objective.ownerTagId, at);
      // Nothing admits work for a cancelled Objective, so unclaimed messages would wait forever.
      yield tx
        .update(m)
        .set({ status: "failed", updatedAt: at })
        .where(and(eq(m.objectiveId, id), eq(m.status, "pending")))
        .returning();
      // A trusted system notice, like an operator reply: the owner address routes it and
      // operatorId records its author. It is already processed, so it starts no activation.
      const notice = {
        recipientTagId: objective.ownerTagId,
        objectiveId: id,
        type: "message",
        body: { message: objectiveCancellationNotice(updated), cancelledAt: at },
        idempotencyKey: `objective-cancelled:${id}`,
      };
      yield tx
        .insert(m)
        .values({
          ...notice,
          id: randomUUID(),
          senderTagId: objective.ownerTagId,
          operatorId,
          fingerprint: createHash("sha256")
            .update(canonicalJson({ ...notice, operatorId }))
            .digest("hex"),
          status: "processed",
          attemptCount: 0,
          processedAt: at,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing({ target: [m.senderTagId, m.idempotencyKey] })
        .returning();
      return { objective: updated as Objective, changed: true };
    });
  }

  pauseObjective(
    id: string,
    source: Parameters<ObjectiveStore["pauseObjective"]>[1],
  ): Promise<{ readonly objective: Objective; readonly changed: boolean }> {
    return this.setObjectivePause(id, source, true).then(({ objective, changed }) => ({
      objective,
      changed,
    }));
  }

  resumeObjective(
    id: string,
    source: Parameters<ObjectiveStore["resumeObjective"]>[1],
  ): ReturnType<ObjectiveStore["resumeObjective"]> {
    return this.setObjectivePause(id, source, false);
  }

  /** Records or clears an operator pause; repeating either is harmless. */
  private setObjectivePause(
    id: string,
    source: { readonly operatorId: string },
    pause: boolean,
  ): Promise<{
    readonly objective: Objective;
    readonly changed: boolean;
    readonly pausedAt: string | null;
  }> {
    mailboxText(id, "objectiveId");
    const operatorId = source?.operatorId;
    if (typeof operatorId !== "string" || !operatorId.trim() || operatorId.length > 200)
      throw new TagMessagingError(401, "Invalid operator principal");
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const o = self.tables.objectives;
      yield lockObjective(tx, o, id);
      const [objective] = yield tx.select().from(o).where(eq(o.id, id));
      if (!objective) throw new TagMessagingError(404, "Objective not found");
      const pausedAt: string | null = objective.pausedAt ?? null;
      if (pause ? pausedAt !== null : pausedAt === null)
        return { objective: objective as Objective, changed: false, pausedAt };
      if (pause && (objective.status === "completed" || objective.status === "cancelled"))
        throw new TagMessagingError(409, `A ${objective.status} Objective cannot be paused`);
      const at = new Date().toISOString();
      const next = pause ? at : null;
      const [updated] = yield tx
        .update(o)
        .set({ pausedAt: next, revision: sql`${o.revision} + 1`, updatedAt: at })
        .where(eq(o.id, id))
        .returning();
      yield* appendResourceChange(tx, self.tables, {
        resourceType: "objective",
        resourceId: id,
        fromRevision: objective.revision,
        toRevision: updated.revision,
        actorTagId: null,
        operatorId,
        sourceTaskId: null,
        sourceMessageId: null,
        changes: { pausedAt: { previous: pausedAt, next } },
        createdAt: at,
      });
      return { objective: updated as Objective, changed: true, pausedAt };
    });
  }

  async recordOverlapWarning(
    input: Parameters<WorkstreamStore["recordOverlapWarning"]>[0],
  ): ReturnType<WorkstreamStore["recordOverlapWarning"]> {
    const teamId = mailboxText(input.teamId, "teamId");
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    const firstAttemptId = mailboxText(input.firstAttemptId, "firstAttemptId");
    const secondAttemptId = mailboxText(input.secondAttemptId, "secondAttemptId");
    if (firstAttemptId === secondAttemptId)
      throw new TagMessagingError(400, "Distinct Task Attempts required");
    const [lowerAttemptId, higherAttemptId] = [firstAttemptId, secondAttemptId].sort();
    const paths = [...new Set(input.paths)].sort();
    if (!paths.length) return undefined;
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      yield lockObjective(tx, self.tables.objectives, objectiveId);
      const teams = self.tables.teams;
      const [team] = yield tx
        .update(teams)
        .set({ updatedAt: sql`${teams.updatedAt}` })
        .where(eq(teams.id, teamId))
        .returning();
      if (team?.status !== "active" || !teamSupportsObjective(team, objectiveId)) return undefined;
      const to = [...new Set([...input.to, team.leadTagId])]
        .filter((tagId) => tagId === team.leadTagId || team.memberTagIds.includes(tagId))
        .sort();
      const overlap = self.tables.overlapWarnings;
      const newPaths: string[] = [];
      for (const path of paths) {
        const [row] = yield tx
          .insert(overlap)
          .values({ teamId, lowerAttemptId, higherAttemptId, path })
          .onConflictDoNothing()
          .returning();
        if (row) newPaths.push(path);
      }
      if (!newPaths.length) return undefined;
      const p = self.tables.workstreamPosts;
      const [last] = yield tx
        .select({ sequence: p.sequence })
        .from(p)
        .where(and(eq(p.workstreamId, teamId), eq(p.objectiveId, objectiveId)))
        .orderBy(desc(p.sequence))
        .limit(1);
      const heading = `Overlap warning: Tasks ${input.firstTaskId} and ${input.secondTaskId} changed the same file(s). Coordinate before producing conflicting branches.\n`;
      let body = heading;
      for (const path of newPaths) {
        if (body.length + path.length + 1 > WORKSTREAM_POST_MAX_BODY - 80) {
          body += `… and ${newPaths.length - body.slice(heading.length).split("\n").filter(Boolean).length} more paths. Read the Task worktrees for the full list.`;
          break;
        }
        body += `${path}\n`;
      }
      const [post] = yield tx
        .insert(p)
        .values({
          id: randomUUID(),
          workstreamId: teamId,
          objectiveId,
          authorTagId: null,
          sourceTaskId: null,
          type: "evidence",
          to,
          body,
          references: [input.firstTaskId, input.secondTaskId],
          replyTo: null,
          sequence: (last?.sequence ?? 0) + 1,
          createdAt: new Date().toISOString(),
          idempotencyKey: randomUUID(),
        })
        .returning();
      return post as WorkstreamPost;
    });
  }

  async postWorkstream(
    input: Parameters<WorkstreamStore["postWorkstream"]>[0],
    sourceTaskId?: string,
  ): Promise<WorkstreamPost> {
    const parsed = parsePostWorkstream(input);
    const initial = await this.getWorkstream(parsed.workstreamId, parsed.authorTagId);
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const p = self.tables.workstreamPosts,
        teams = self.tables.teams;
      // Team changes take the Objective lock and then the Team's; taking both in the same order
      // makes the membership decision and the insert one operation.
      yield lockObjective(tx, self.tables.objectives, initial.objectiveId);
      yield tx
        .update(teams)
        .set({ updatedAt: sql`${teams.updatedAt}` })
        .where(eq(teams.id, parsed.workstreamId))
        .returning();
      const channel: TeamChannel | undefined = yield* loadTeamChannel(
        tx,
        self.tables,
        parsed.workstreamId,
      );
      if (!channel || channel.team.objectiveId !== initial.objectiveId)
        throw new TagMessagingError(409, "Team changed while posting; retry the post");
      const [author] = yield tx
        .select()
        .from(self.tables.tags)
        .where(eq(self.tables.tags.id, parsed.authorTagId));
      if (author?.status !== "active" || !mayPostTeamChannel(channel, parsed.authorTagId))
        throw new TagMessagingError(403, "Only members of an active Team may post to its channel");
      // The post belongs to one Objective the Team serves: the posting Task's, or else the Team's
      // governing Objective. Only readers of that Objective see it.
      let objectiveId = parsed.objectiveId;
      if (sourceTaskId !== undefined) {
        const [source] = yield tx
          .select({ objectiveId: self.tables.taskAssignments.objectiveId })
          .from(self.tables.taskAssignments)
          .where(eq(self.tables.taskAssignments.taskId, sourceTaskId));
        if (source && objectiveId !== undefined && source.objectiveId !== objectiveId)
          throw new TagMessagingError(403, "A post belongs to its source Task's Objective");
        objectiveId ??= source?.objectiveId;
      }
      objectiveId ??= channel.team.objectiveId;
      if (channel.objectiveOwners[objectiveId] === undefined)
        throw new TagMessagingError(403, "The Team does not serve this Objective");
      const outside = (parsed.to ?? []).filter((id) => !channel.team.memberTagIds.includes(id));
      if (outside.length)
        throw new TagMessagingError(
          400,
          `to must name Tags in Team ${channel.team.id}; not members: ${outside.slice(0, 5).join(", ")}`,
        );
      const type = parsed.type ?? "note";
      // A blocker is for the lead unless the post names its addressees.
      const to =
        parsed.to ??
        (type === "blocker" && channel.team.leadTagId !== parsed.authorTagId
          ? [channel.team.leadTagId]
          : []);
      const [existing] = yield tx
        .select()
        .from(p)
        .where(
          and(
            eq(p.workstreamId, parsed.workstreamId),
            eq(p.authorTagId, parsed.authorTagId),
            eq(p.idempotencyKey, parsed.idempotencyKey),
          ),
        );
      if (existing) {
        if (
          existing.objectiveId !== objectiveId ||
          existing.body !== parsed.body ||
          existing.type !== type ||
          // A defaulted blocker keeps the lead it was addressed to when first stored.
          (parsed.to !== undefined || type !== "blocker"
            ? JSON.stringify(existing.to) !== JSON.stringify(to)
            : false) ||
          existing.replyTo !== (parsed.replyTo ?? null) ||
          JSON.stringify(existing.references) !== JSON.stringify(parsed.references ?? [])
        )
          throw new TagMessagingError(409, "Post idempotency key already has a different payload");
        return existing as WorkstreamPost;
      }
      if (parsed.replyTo) {
        const [parent] = yield tx
          .select()
          .from(p)
          .where(
            and(
              eq(p.id, parsed.replyTo),
              eq(p.workstreamId, parsed.workstreamId),
              eq(p.objectiveId, objectiveId),
            ),
          );
        if (!parent)
          throw new TagMessagingError(
            400,
            "Reply must reference a post in the same Workstream and Objective",
          );
      }
      // Content retries within five minutes are dropped even with a new key, Task,
      // reply parent or references. The Team lock serializes this lookup with all post writes.
      const identical = yield tx
        .select()
        .from(p)
        .where(
          and(
            eq(p.workstreamId, parsed.workstreamId),
            eq(p.objectiveId, objectiveId),
            eq(p.authorTagId, parsed.authorTagId),
            eq(p.type, type),
            eq(p.body, parsed.body),
            gt(p.createdAt, new Date(Date.now() - TEAM_REPLY_DUPLICATE_WINDOW_MS).toISOString()),
          ),
        );
      const duplicate = identical.find(
        (post: any) => JSON.stringify([...post.to].sort()) === JSON.stringify([...to].sort()),
      );
      if (duplicate) {
        // A watched channel carries separate events even when their text repeats. Preserve
        // sequence numbers for Objective assessments and Tasks waiting on posts.
        const [objective] = yield tx
          .select({ observations: self.tables.objectives.observations })
          .from(self.tables.objectives)
          .where(eq(self.tables.objectives.id, objectiveId));
        const q = self.tables.taskAssignments;
        const watching = yield tx
          .select({ waitState: q.waitState })
          .from(q)
          .where(
            and(
              eq(q.objectiveId, objectiveId),
              inArray(q.status, ["queued", "running", "waiting"]),
            ),
          );
        const observed =
          objective.observations.some(
            (source: any) => source.workstreamId === parsed.workstreamId,
          ) ||
          watching.some(
            (task: any) => task.waitState?.workstreamPosts?.workstreamId === parsed.workstreamId,
          );
        if (!observed) return duplicate as WorkstreamPost;
      }
      // Each Objective numbers its own posts, so a sequence says nothing about other Objectives.
      const [last] = yield tx
        .select()
        .from(p)
        .where(and(eq(p.workstreamId, parsed.workstreamId), eq(p.objectiveId, objectiveId)))
        .orderBy(desc(p.sequence))
        .limit(1);
      const [post] = yield tx
        .insert(p)
        .values({
          id: randomUUID(),
          workstreamId: parsed.workstreamId,
          authorTagId: parsed.authorTagId,
          objectiveId,
          sourceTaskId: sourceTaskId ?? null,
          type,
          to,
          body: parsed.body,
          references: parsed.references ?? [],
          replyTo: parsed.replyTo ?? null,
          sequence: (last?.sequence ?? 0) + 1,
          createdAt: new Date().toISOString(),
          idempotencyKey: parsed.idempotencyKey,
        })
        .returning();
      for (const recipientTagId of [...new Set<string>(to)].sort())
        yield* queueTeamReplyTrigger(tx, self.tables, {
          objectiveId,
          teamId: channel.team.id,
          senderTagId: parsed.authorTagId,
          recipientTagId,
          itemKind: "post",
          itemId: post.id,
          itemType: type,
          sourceTaskId: sourceTaskId ?? null,
        });
      return post as WorkstreamPost;
    });
  }
  async listWorkstreamPosts(
    id: string,
    viewerTagId?: string,
    options: Parameters<WorkstreamStore["listWorkstreamPosts"]>[2] = {},
  ): Promise<readonly WorkstreamPost[]> {
    const parsedOptions = mailboxObject(options, ["afterSequence", "limit", "objectiveId"]);
    const after = (
        parsedOptions["afterSequence"] === undefined ? 0 : parsedOptions["afterSequence"]
      ) as number,
      limit = (parsedOptions["limit"] === undefined ? 50 : parsedOptions["limit"]) as number;
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new TagMessagingError(400, "afterSequence must be nonnegative and limit must be 1–100");
    const objectiveId = await this.readablePostObjective(
      id,
      viewerTagId,
      parsedOptions["objectiveId"] === undefined
        ? undefined
        : mailboxText(parsedOptions["objectiveId"], "objectiveId"),
    );
    const p = this.tables.workstreamPosts;
    return this.db
      .select()
      .from(p)
      .where(
        and(eq(p.workstreamId, id), eq(p.objectiveId, objectiveId), sql`${p.sequence} > ${after}`),
      )
      .orderBy(asc(p.sequence))
      .limit(limit);
  }

  /**
   * The one Objective whose posts a read returns, after checking that the viewer may read the
   * channel there. Each Objective numbers its own posts, so one Objective keeps a cursor exact.
   * A read without an Objective takes the Team's governing Objective, or, for a viewer outside
   * the Team who owns exactly one linked Objective, that one.
   */
  private async readablePostObjective(
    id: string,
    viewerTagId: string | undefined,
    objectiveId: string | undefined,
  ): Promise<string> {
    const streamId = mailboxText(id, "workstreamId");
    const self = this;
    const readable = await this.surfaceTransaction(function* (tx) {
      const channel: TeamChannel | undefined = yield* loadTeamChannel(tx, self.tables, streamId);
      if (!channel) return undefined;
      let chosen = objectiveId;
      if (viewerTagId !== undefined) {
        const [viewer] = yield tx
          .select({ status: self.tables.tags.status })
          .from(self.tables.tags)
          .where(eq(self.tables.tags.id, viewerTagId))
          .limit(1);
        if (viewer?.status !== "active") return undefined;
        if (chosen === undefined) {
          const objectives = readableChannelObjectives(channel, viewerTagId);
          chosen = objectives.includes(channel.team.objectiveId)
            ? channel.team.objectiveId
            : objectives.length === 1
              ? objectives[0]
              : undefined;
          if (chosen === undefined && objectives.length > 1)
            throw new TagMessagingError(
              409,
              "This Tag reads the channel under several Objectives; read it from a Task in one of them",
            );
        }
        if (chosen === undefined || !mayReadTeamChannel(channel, viewerTagId, chosen))
          return undefined;
      }
      chosen ??= channel.team.objectiveId;
      return channel.objectiveOwners[chosen] === undefined ? undefined : chosen;
    });
    if (readable === undefined)
      throw new TagMessagingError(404, "Workstream not found or not visible to this Tag");
    return readable;
  }

  async listRecentWorkstreamPosts(
    id: string,
    objectiveId: string,
    limit = 100,
  ): Promise<readonly WorkstreamPost[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TagMessagingError(400, "limit must be 1–100");
    await this.readablePostObjective(id, undefined, mailboxText(objectiveId, "objectiveId"));
    const p = this.tables.workstreamPosts;
    return this.db
      .select()
      .from(p)
      .where(and(eq(p.workstreamId, id), eq(p.objectiveId, objectiveId)))
      .orderBy(desc(p.sequence))
      .limit(limit);
  }

  async listOpenWorkstreamPosts(
    id: string,
    objectiveId: string,
    limit = 21,
  ): Promise<readonly WorkstreamPost[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TagMessagingError(400, "limit must be 1–100");
    await this.readablePostObjective(id, undefined, mailboxText(objectiveId, "objectiveId"));
    const p = this.tables.workstreamPosts;
    // Replies stay in their parent's Objective, so an answer always comes from the same one.
    return this.db
      .select()
      .from(p)
      .where(
        and(
          eq(p.workstreamId, id),
          eq(p.objectiveId, objectiveId),
          inArray(p.type, ["question", "blocker"]),
          sql`NOT EXISTS (SELECT 1 FROM "WorkstreamPost" reply WHERE reply."replyTo" = ${p.id} AND reply."objectiveId" = ${p.objectiveId})`,
        ),
      )
      .orderBy(desc(p.sequence))
      .limit(limit);
  }

  async getWorkstream(id: string, viewerTagId?: string): Promise<Workstream> {
    const streamId = mailboxText(id, "workstreamId");
    const self = this;
    const channel = await this.surfaceTransaction(function* (tx) {
      const found: TeamChannel | undefined = yield* loadTeamChannel(tx, self.tables, streamId);
      if (viewerTagId === undefined || !found) return found;
      const [viewer] = yield tx
        .select({ status: self.tables.tags.status })
        .from(self.tables.tags)
        .where(eq(self.tables.tags.id, viewerTagId))
        .limit(1);
      return viewer?.status === "active" && mayReadTeamChannel(found, viewerTagId)
        ? found
        : undefined;
    });
    if (!channel)
      throw new TagMessagingError(404, "Workstream not found or not visible to this Tag");
    return channel.workstream;
  }

  async listWorkstreams(
    tagId: string | undefined,
    limit = 100,
    options: ListWorkstreamsOptions = {},
  ): Promise<readonly Workstream[]> {
    if (tagId !== undefined) await this.activeTag(tagId);
    checkLimit(limit);
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new TagMessagingError(400, "offset must be a nonnegative safe integer");
    const w = this.tables.workstreams,
      t = this.tables.teams,
      o = this.tables.objectives;
    const sqlite = this.provider === "sqlite";
    const member = sqlite
      ? sql`exists (select 1 from json_each(${t.memberTagIds}) where value = ${tagId})`
      : sql`${t.memberTagIds} @> ${JSON.stringify([tagId])}::jsonb`;
    // The owner of the governing Objective or of any linked Objective the Team serves. Within
    // one Objective, only that Objective's owner: owning another Objective the Team serves
    // reveals nothing written under this one.
    const linkedToOwned = sqlite
      ? sql`exists (select 1 from json_each(${t.objectiveIds}) where value = ${o.id})`
      : sql`${t.objectiveIds} @> jsonb_build_array(${o.id})`;
    let owned = sql`exists (select 1 from ${o} where ${o.ownerTagId} = ${tagId} and (${o.id} = ${t.objectiveId} or ${linkedToOwned}))`;
    let served: ReturnType<typeof or>;
    if (options.objectiveId !== undefined) {
      const objectiveId = mailboxText(options.objectiveId, "objectiveId");
      owned = sql`exists (select 1 from ${o} where ${o.id} = ${objectiveId} and ${o.ownerTagId} = ${tagId})`;
      served = or(
        eq(t.objectiveId, objectiveId),
        sqlite
          ? sql`exists (select 1 from json_each(${t.objectiveIds}) where value = ${objectiveId})`
          : sql`${t.objectiveIds} @> ${JSON.stringify([objectiveId])}::jsonb`,
      );
    }
    const rows = await this.db
      .select({ createdAt: w.createdAt, team: t })
      .from(w)
      .innerJoin(t, eq(t.id, w.id))
      .where(and(tagId === undefined ? undefined : or(member, owned), served))
      .orderBy(desc(w.createdAt), desc(w.id))
      .limit(limit)
      .offset(offset);
    return rows.map((row: any) => teamChannelView(row.team, row.createdAt));
  }

  async deliverActivationDigest(
    input: Parameters<WorkstreamStore["deliverActivationDigest"]>[0],
  ): Promise<ActivationDigest> {
    const digest = await this.readActivationDigest(input);
    await this.recordActivationDigest({ ...input, items: digest.items });
    return digest;
  }

  async recordActivationDigest(
    input: Parameters<WorkstreamStore["recordActivationDigest"]>[0],
  ): Promise<void> {
    const tagId = mailboxText(input.tagId, "tagId");
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    if (input.items.length === 0) return;
    const deliveredAt = new Date().toISOString();
    const self = this;
    await this.surfaceTransaction(function* (tx) {
      // A preview is delivery too: record it once and release the pair's pending capacity.
      yield tx
        .insert(self.tables.tagDigestDeliveries)
        .values(
          input.items.map((item) => ({
            tagId,
            objectiveId,
            itemKind: item.kind,
            itemId: item.id,
            deliveredAt,
          })),
        )
        .onConflictDoNothing()
        .returning();
      const messageIds = input.items
        .filter((item) => item.kind === "direct_message")
        .map((item) => item.id);
      // Settle delivered previews as well as full messages. The body remains readable until
      // explicit pruning; recipients need not read every long message to keep a pair unblocked.
      yield* self.settleTeamDirectMessagesIn(tx, {
        tagId,
        objectiveId,
        messageIds,
        at: deliveredAt,
      });
    });
  }

  async takeTeamDirectMessages(
    input: Parameters<TagMailboxStore["takeTeamDirectMessages"]>[0],
  ): ReturnType<TagMailboxStore["takeTeamDirectMessages"]> {
    const tagId = mailboxText(input.tagId, "tagId");
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)
      throw new TagMessagingError(400, "limit must be between 1 and 200");
    const at = new Date().toISOString();
    const self = this;
    const m = this.tables.tagMessages;
    return this.surfaceTransaction(function* (tx) {
      // Oldest first, so repeated reads drain the backlog and every undelivered message is
      // reachable however many are pending.
      const rows: any[] = yield tx
        .select()
        .from(m)
        .where(
          and(
            eq(m.recipientTagId, tagId),
            eq(m.objectiveId, objectiveId),
            eq(m.status, "pending"),
            sql`${m.directTeamId} is not null`,
          ),
        )
        .orderBy(asc(m.createdAt), asc(m.id))
        .limit(input.limit);
      const settled = new Set(
        yield* self.settleTeamDirectMessagesIn(tx, {
          tagId,
          objectiveId,
          messageIds: rows.map((row) => row.id as string),
          at,
        }),
      );
      // Only messages this call settled are returned, so a concurrent read never returns one twice.
      return rows
        .filter((row) => settled.has(row.id))
        .map((row) =>
          publicMessage({ ...row, status: "processed", processedAt: at, updatedAt: at }),
        );
    });
  }

  /**
   * Settles pending within-Team direct messages delivered to their recipient.
   */
  private *settleTeamDirectMessagesIn(
    tx: any,
    input: {
      readonly tagId: string;
      readonly objectiveId: string;
      readonly messageIds: readonly string[];
      readonly at: string;
    },
  ): Generator<any, readonly string[], any> {
    if (input.messageIds.length === 0) return [];
    const m = this.tables.tagMessages;
    const rows = yield tx
      .update(m)
      .set({ status: "processed", processedAt: input.at, updatedAt: input.at })
      .where(
        and(
          inArray(m.id, [...new Set(input.messageIds)]),
          eq(m.recipientTagId, input.tagId),
          eq(m.objectiveId, input.objectiveId),
          eq(m.status, "pending"),
          sql`${m.directTeamId} is not null`,
        ),
      )
      .returning({ id: m.id });
    return rows.map((row: { id: string }) => row.id);
  }

  async readActivationDigest(
    input: Parameters<WorkstreamStore["readActivationDigest"]>[0],
  ): Promise<ActivationDigest> {
    const tagId = mailboxText(input.tagId, "tagId");
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    const o = this.tables.objectives,
      p = this.tables.workstreamPosts,
      m = this.tables.tagMessages,
      d = this.tables.tagDigestDeliveries;
    const [objective] = await this.db
      .select({ ownerTagId: o.ownerTagId })
      .from(o)
      .where(eq(o.id, objectiveId))
      .limit(1);
    if (!objective) throw new TagMessagingError(404, "Objective not found");
    // Only channels this Tag may read: its Teams', or every Team's serving an Objective it owns.
    // Every such channel, paged, so none is left out however many Teams the Objective has.
    const channelIds: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await this.listWorkstreams(tagId, 200, { objectiveId, offset });
      channelIds.push(...page.map((channel) => channel.id));
      if (page.length < 200) break;
    }
    const before = input.before === undefined ? undefined : mailboxText(input.before, "before");
    const live = this.tables.teamLiveDeliveries,
      attempts = this.tables.taskAttempts;
    // An item being injected into a running Task Attempt waits until the harness answers: if it
    // accepts, the item is delivered; if acceptance is uncertain, a later digest carries it. A
    // pending delivery older than the bound, left by an interrupted Control Plane, or one whose
    // Task Attempt has stopped running, so its answer can no longer matter, waits no more.
    const injecting = new Date(Date.now() - TEAM_LIVE_DELIVERY_PENDING_MS).toISOString();
    const unread = (kind: string, id: unknown) =>
      sql`not exists (select 1 from ${d} where ${d.tagId} = ${tagId} and ${d.objectiveId} = ${objectiveId} and ${d.itemKind} = ${kind} and ${d.itemId} = ${id}) and not exists (select 1 from ${live} inner join ${attempts} on ${attempts.id} = ${live.attemptId} where ${live.recipientTagId} = ${tagId} and ${live.objectiveId} = ${objectiveId} and ${live.itemKind} = ${kind} and ${live.itemId} = ${id} and ${live.status} = 'pending' and ${live.createdAt} > ${injecting} and ${attempts.status} = 'running')`;
    // A Task Attempt's digest holds only items created before it started. Later items are live
    // delivery's to inject into that Task Attempt, or a later digest's, so no item reaches the
    // same Task Attempt both ways.
    const createdBefore = (column: unknown) =>
      before === undefined ? undefined : sql`${column} < ${before}`;
    // Addressed means the post's `to` names this Tag. Each group is scanned on its own, so posts
    // addressed to other Tags cannot hide a newer blocker or decision behind the scan bound.
    const addressed =
      this.provider === "sqlite"
        ? sql`exists (select 1 from json_each(${p.to}) where value = ${tagId})`
        : sql`cast(${p.to} as jsonb) @> jsonb_build_array(${tagId}::text)`;
    const blockerOrDecision = sql`${p.type} in ('blocker', 'decision')`;
    const posts = async (filter: any, limit: number) =>
      channelIds.length === 0
        ? []
        : this.db
            .select()
            .from(p)
            .where(
              and(
                inArray(p.workstreamId, channelIds),
                // Only posts written under this Objective, whatever else the Team serves.
                eq(p.objectiveId, objectiveId),
                // System notices have no Tag author and reach every reader, including the lead.
                sql`(${p.authorTagId} <> ${tagId} or ${p.authorTagId} is null)`,
                unread("post", p.id),
                createdBefore(p.createdAt),
                filter,
              ),
            )
            .orderBy(asc(p.createdAt), asc(p.id))
            .limit(limit);
    const postRows: any[] = [
      ...(await posts(addressed, DIGEST_SCAN_LIMIT)),
      ...(await posts(and(sql`not ${addressed}`, blockerOrDecision), DIGEST_SCAN_LIMIT)),
      ...(await posts(
        and(sql`not ${addressed}`, sql`not ${blockerOrDecision}`),
        DIGEST_SCAN_LIMIT,
      )),
    ];
    // Same-Team direct messages, including the owner's, share the digest delivery path.
    const messageRows: any[] = await this.db
      .select()
      .from(m)
      .where(
        and(
          eq(m.recipientTagId, tagId),
          eq(m.objectiveId, objectiveId),
          // Only undelivered messages: one already read through read_mailbox is settled.
          eq(m.status, "pending"),
          sql`${m.directTeamId} is not null`,
          sql`${m.bodyPrunedAt} is null`,
          currentDirectTeamParticipants(m, this.tables.teams, this.provider),
          unread("direct_message", m.id),
          createdBefore(m.createdAt),
        ),
      )
      .orderBy(asc(m.createdAt), asc(m.id))
      .limit(DIGEST_SCAN_LIMIT);
    const candidates: ActivationDigestItem[] = [
      ...messageRows.map((row) => {
        const body = row.body as Record<string, unknown>;
        const message = typeof body?.["message"] === "string" ? body["message"] : undefined;
        const text = digestText(message ?? body);
        // Other body fields are left out of the preview, so it is cut too.
        const partial = message !== undefined && Object.keys(body).some((key) => key !== "message");
        return {
          kind: "direct_message" as const,
          id: row.id,
          from: row.senderTagId,
          type: row.type,
          addressed: true,
          to: [tagId],
          ...(row.inReplyTo ? { inReplyTo: row.inReplyTo } : {}),
          references: [],
          ...text,
          truncated: text.truncated || partial,
          createdAt: row.createdAt,
        };
      }),
      ...postRows.map((row) => {
        const to = (Array.isArray(row.to) ? row.to : []).map(String);
        return {
          kind: "post" as const,
          id: row.id,
          from: row.authorTagId ?? "system",
          type: row.type,
          addressed: to.includes(tagId),
          to: to.slice(0, 20),
          workstreamId: row.workstreamId,
          sequence: row.sequence,
          ...(row.replyTo ? { inReplyTo: row.replyTo } : {}),
          references: (Array.isArray(row.references) ? row.references : [])
            .slice(0, DIGEST_MAX_REFERENCES)
            .map((reference: unknown) => digestText(reference, DIGEST_REFERENCE_CHARACTERS).text),
          ...digestText(row.body),
          createdAt: row.createdAt,
        };
      }),
    ];
    const rank = (item: ActivationDigestItem) =>
      item.addressed ? 0 : item.type === "blocker" || item.type === "decision" ? 1 : 2;
    candidates.sort(
      (a, b) =>
        rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const selected: ActivationDigestItem[] = [];
    let used = 0;
    for (const item of candidates) {
      const cost = JSON.stringify(item).length;
      if (used + cost > ACTIVATION_DIGEST_MAX_CHARACTERS) continue;
      used += cost;
      selected.push(item);
    }
    // Reading records nothing: the activation records delivery with recordActivationDigest once
    // its context reaches the worker, so a failed start leaves every item unread.
    const items = selected;
    const left = candidates.filter((item) => !selected.includes(item));
    return {
      items,
      remaining: {
        posts: left.filter((item) => item.kind === "post").length,
        directMessages: left.filter((item) => item.kind === "direct_message").length,
        workstreamIds: [
          ...new Set(left.flatMap((item) => (item.workstreamId ? [item.workstreamId] : []))),
        ]
          .sort()
          .slice(0, DIGEST_REMAINING_CHANNELS),
      },
    };
  }

  async setTagMessagingGrant(grant: TagMessagingGrant): Promise<void> {
    const senderTagId = mailboxText(grant.senderTagId, "senderTagId");
    const recipientTagId = mailboxText(grant.recipientTagId, "recipientTagId");
    if (
      !Array.isArray(grant.messageTypes) ||
      grant.messageTypes.some((type) => !TAG_MESSAGE_TYPES.includes(type))
    ) {
      throw new TagMessagingError(400, "Unknown message type in grant");
    }
    const messageTypes = [...new Set(grant.messageTypes)].sort();
    const self = this;
    await this.surfaceTransaction(function* (tx) {
      yield* self.lockActiveTags(tx, [senderTagId, recipientTagId]);
      const t = self.tables.tagMessagingGrants;
      yield tx
        .insert(t)
        .values({ senderTagId, recipientTagId, messageTypes })
        .onConflictDoUpdate({
          target: [t.senderTagId, t.recipientTagId],
          set: { messageTypes },
        })
        .returning();
    });
  }

  async listTagMessagingGrants(tagId: string): Promise<readonly TagMessagingGrant[]> {
    await this.activeTag(tagId);
    const t = this.tables.tagMessagingGrants;
    return this.db
      .select()
      .from(t)
      .where(or(eq(t.senderTagId, tagId), eq(t.recipientTagId, tagId)))
      .orderBy(asc(t.senderTagId), asc(t.recipientTagId));
  }

  async createTagMailboxCredential(
    input: TagMailboxCredential & { readonly tokenHash: string },
  ): Promise<void> {
    await this.activeTag(input.tagId);
    await this.db.insert(this.tables.tagMailboxCredentials).values(input);
  }

  async findTagMailboxCredential(tokenHash: string): Promise<TagMailboxCredential | undefined> {
    const t = this.tables.tagMailboxCredentials;
    const tag = this.tables.tags;
    const rows = await this.db
      .select({ id: t.id, tagId: t.tagId, createdAt: t.createdAt })
      .from(t)
      .innerJoin(tag, eq(t.tagId, tag.id))
      .where(and(eq(t.tokenHash, tokenHash), eq(tag.status, "active")))
      .limit(1);
    return rows[0];
  }

  async revokeTagMailboxCredential(id: string): Promise<boolean> {
    const t = this.tables.tagMailboxCredentials;
    return (await this.db.delete(t).where(eq(t.id, id)).returning()).length > 0;
  }

  async enqueueTagMessage(
    input: Parameters<TagMailboxStore["enqueueTagMessage"]>[0],
    options?: Parameters<TagMailboxStore["enqueueTagMessage"]>[1],
  ) {
    const { senderTagId, ...request } = input;
    const message = parseTagMessageInput(request);
    await this.activeTag(senderTagId);
    // A retry of a durable Team-addressed send keeps its identity after leadership changes.
    if (message.recipientTeamId) {
      const t = this.tables.tagMessages;
      const [existing] = await this.db
        .select()
        .from(t)
        .where(and(eq(t.senderTagId, senderTagId), eq(t.idempotencyKey, message.idempotencyKey)))
        .limit(1);
      if (existing) {
        const fingerprint = createHash("sha256")
          .update(canonicalJson({ ...message, recipientTagId: message.recipientTeamId }))
          .digest("hex");
        if (existing.fingerprint !== fingerprint)
          throw new TagMessagingError(
            409,
            "Idempotency key was already used for a different message",
          );
        return { message: publicMessage(existing), duplicate: true };
      }
    }
    await this.activeTag(message.recipientTagId);
    const g = this.tables.tagMessagingGrants;
    const grants = await this.db
      .select()
      .from(g)
      .where(and(eq(g.senderTagId, senderTagId), eq(g.recipientTagId, message.recipientTagId)))
      .limit(1);
    const initialTeam = (
      await this.db.select().from(this.tables.teams).where(eq(this.tables.teams.status, "active"))
    ).find(
      (team: any) =>
        (!message.recipientTeamId || team.id === message.recipientTeamId) &&
        sharesActiveTeam([team], message.objectiveId, senderTagId, message.recipientTagId),
    );
    if (
      !(initialTeam && TEAM_CONVERSATION_TYPES.has(message.type)) &&
      !grants[0]?.messageTypes.includes(message.type)
    )
      throw new TagMessagingError(
        403,
        "This Tag is not permitted to send this message type to the recipient",
      );
    const t = this.tables.tagMessages;
    let replyParent: any;
    if (message.inReplyTo !== undefined) {
      const parent = (
        await this.db.select().from(t).where(eq(t.id, message.inReplyTo)).limit(1)
      )[0];
      if (
        !parent ||
        parent.objectiveId !== message.objectiveId ||
        parent.senderTagId !== message.recipientTagId ||
        parent.recipientTagId !== senderTagId
      ) {
        throw new TagMessagingError(
          400,
          "Reply must reference a message from this recipient in the same objective",
        );
      }
      replyParent = parent;
      const expectedParentType: Partial<Record<TagMessage["type"], TagMessage["type"]>> = {
        "delegation.accepted": "delegation.requested",
        "delegation.declined": "delegation.requested",
        "priority.accepted": "priority.proposed",
        "priority.declined": "priority.proposed",
      };
      if (expectedParentType[message.type] && parent.type !== expectedParentType[message.type])
        throw new TagMessagingError(
          400,
          `${message.type} must reply to ${expectedParentType[message.type]}`,
        );
      if (message.type === "priority.accepted" || message.type === "priority.declined") {
        if (
          parent.body?.taskId !== message.body["taskId"] ||
          parent.body?.priority !== message.body["priority"]
        )
          throw new TagMessagingError(
            400,
            "Priority response must preserve the proposed Task and priority",
          );
      }
    }
    if (
      [
        "delegation.accepted",
        "delegation.declined",
        "priority.accepted",
        "priority.declined",
      ].includes(message.type) &&
      !replyParent
    )
      throw new TagMessagingError(400, `${message.type} requires a valid proposal`);
    if (message.type === "priority.proposed") {
      if (!message.recipientTeamId)
        throw new TagMessagingError(400, "Priority proposals must address a Team");
      const q = this.tables.taskAssignments;
      const [task] = await this.db
        .select({ objectiveId: q.objectiveId, teamId: q.teamId })
        .from(q)
        .where(eq(q.taskId, message.body["taskId"] as string))
        .limit(1);
      if (task?.objectiveId !== message.objectiveId || task.teamId !== message.recipientTeamId)
        throw new TagMessagingError(
          403,
          "Priority proposal Task must belong to the addressed Team and Objective",
        );
    }
    const fingerprint = createHash("sha256")
      .update(
        canonicalJson(
          message.recipientTeamId
            ? { ...message, recipientTagId: message.recipientTeamId }
            : message,
        ),
      )
      .digest("hex");
    const at = new Date().toISOString();
    const self = this;
    const provider = this.provider;
    const teams = this.tables.teams;
    return this.surfaceTransaction(function* (tx): Generator<
      any,
      { message: TagMessage; duplicate: boolean },
      any
    > {
      // Completion/cancellation takes this lock before sweeping messages. Acquire it before
      // Team/Tag locks so a racing send is either refused or included in terminal cleanup.
      // A message may name an Objective SuperTag doesn't store, such as an external one between
      // Tags with a grant; nothing completes it, so there is nothing to lock or refuse.
      const [objective] = yield lockObjective(tx, self.tables.objectives, message.objectiveId);
      // Team updates lock this same row before changing membership or Objective links.
      // The send uses only the Team selected before admission; a new membership can retry.
      const [lockedTeam] = initialTeam
        ? yield tx
            .update(teams)
            .set({ updatedAt: sql`${teams.updatedAt}` })
            .where(eq(teams.id, initialTeam.id))
            .returning()
        : [];
      if (message.recipientTeamId) {
        const [team] = yield tx
          .update(teams)
          .set({ updatedAt: sql`${teams.updatedAt}` })
          .where(eq(teams.id, message.recipientTeamId))
          .returning();
        if (team?.status !== "active" || !teamSupportsObjective(team, message.objectiveId))
          throw new TagMessagingError(403, "Recipient Team is not active in this Objective");
        if (team.leadTagId !== message.recipientTagId)
          throw new TagMessagingError(409, "Team leadership changed; resolve its address again");
      }
      // Lock both endpoints in stable order. Grant changes take the same locks,
      // while NO KEY UPDATE remains compatible with reciprocal foreign-key inserts.
      yield* self.lockActiveTags(tx, [senderTagId, message.recipientTagId]);
      const grantQuery = tx
        .select()
        .from(g)
        .where(and(eq(g.senderTagId, senderTagId), eq(g.recipientTagId, message.recipientTagId)))
        .limit(1);
      const [currentGrant] = yield provider === "postgresql"
        ? grantQuery.for("no key update")
        : grantQuery;
      const authorizedByTeam =
        TEAM_CONVERSATION_TYPES.has(message.type) &&
        sharesActiveTeam(
          lockedTeam ? [lockedTeam] : [],
          message.objectiveId,
          senderTagId,
          message.recipientTagId,
        );
      if (!authorizedByTeam && !currentGrant?.messageTypes.includes(message.type))
        throw new TagMessagingError(
          403,
          "This Tag is not permitted to send this message type to the recipient",
        );
      const existing = yield tx
        .select()
        .from(t)
        .where(and(eq(t.senderTagId, senderTagId), eq(t.idempotencyKey, message.idempotencyKey)))
        .limit(1);
      if (existing[0]) {
        if (existing[0].fingerprint !== fingerprint)
          throw new TagMessagingError(
            409,
            "Idempotency key was already used for a different message",
          );
        return { message: publicMessage(existing[0]), duplicate: true };
      }
      if (objective && objectiveClosed(objective.status))
        throw new TagMessagingError(409, "Objective is closed");
      const terminalReplyTypes =
        message.type === "delegation.accepted" || message.type === "delegation.declined"
          ? (["delegation.accepted", "delegation.declined"] as const)
          : message.type === "priority.accepted" || message.type === "priority.declined"
            ? (["priority.accepted", "priority.declined"] as const)
            : undefined;
      if (message.inReplyTo && terminalReplyTypes) {
        // Serialize terminal responses on the proposal. A message accepts or declines once;
        // acceptance is still only communication and never an authority grant.
        yield tx
          .update(t)
          .set({ updatedAt: sql`${t.updatedAt}` })
          .where(eq(t.id, message.inReplyTo))
          .returning({ id: t.id });
        const [priorResponse] = yield tx
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              eq(t.inReplyTo, message.inReplyTo),
              sql`${t.type} in (${sql.join(
                terminalReplyTypes.map((type) => sql`${type}`),
                sql`, `,
              )})`,
            ),
          )
          .limit(1);
        if (priorResponse)
          throw new TagMessagingError(409, "Proposal already has a terminal response");
      }
      const directTeamId = authorizedByTeam && !options?.forceTaskDelivery ? lockedTeam.id : null;
      if (directTeamId) {
        const candidates = yield tx
          .select()
          .from(t)
          .where(
            and(
              eq(t.directTeamId, directTeamId),
              eq(t.objectiveId, message.objectiveId),
              eq(t.senderTagId, senderTagId),
              eq(t.recipientTagId, message.recipientTagId),
              eq(t.type, message.type),
              gt(
                t.createdAt,
                new Date(Date.parse(at) - TEAM_REPLY_DUPLICATE_WINDOW_MS).toISOString(),
              ),
            ),
          );
        const duplicate = candidates.find((prior: any) => {
          if (!prior.bodyPrunedAt) return canonicalJson(prior.body) === canonicalJson(message.body);
          // The original fingerprint survives retention. Reconstruct its envelope with the new
          // body to compare content without retaining or restoring a pruned message's text.
          const original = {
            recipientTagId: prior.recipientTeamId ?? prior.recipientTagId,
            ...(prior.recipientTeamId == null ? {} : { recipientTeamId: prior.recipientTeamId }),
            objectiveId: prior.objectiveId,
            type: prior.type,
            body: message.body,
            idempotencyKey: prior.idempotencyKey,
            ...(prior.inReplyTo == null ? {} : { inReplyTo: prior.inReplyTo }),
          };
          return (
            createHash("sha256").update(canonicalJson(original)).digest("hex") === prior.fingerprint
          );
        });
        if (duplicate) return { message: publicMessage(duplicate), duplicate: true };
      }
      const [count] = yield tx
        .select({ total: sql`count(*)` })
        .from(t)
        .where(
          and(
            eq(t.recipientTagId, message.recipientTagId),
            directTeamId
              ? eq(t.status, "pending")
              : or(eq(t.status, "pending"), eq(t.status, "processing")),
            // Within a Team the limit is per sender, recipient, Team, and Objective: delivery
            // drains one Objective at a time, so another Objective's backlog cannot block this one.
            directTeamId
              ? and(
                  eq(t.senderTagId, senderTagId),
                  eq(t.directTeamId, directTeamId),
                  eq(t.objectiveId, message.objectiveId),
                )
              : sql`${t.directTeamId} is null`,
          ),
        );
      if (
        Number(count.total) >=
        (directTeamId ? TEAM_DIRECT_MAX_OUTSTANDING : TAG_MAILBOX_MAX_OUTSTANDING)
      )
        throw new TagMessagingError(429, "Recipient mailbox is at its outstanding message limit");
      const inserted = yield tx
        .insert(t)
        .values({
          ...message,
          directTeamId,
          senderTagId,
          id: randomUUID(),
          fingerprint,
          status: "pending",
          attemptCount: 0,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing({ target: [t.senderTagId, t.idempotencyKey] })
        .returning();
      if (inserted[0]) {
        if (directTeamId)
          yield* queueTeamReplyTrigger(tx, self.tables, {
            objectiveId: message.objectiveId,
            teamId: directTeamId,
            senderTagId,
            recipientTagId: message.recipientTagId,
            itemKind: "direct_message",
            itemId: inserted[0].id,
            itemType: message.type,
          });
        if (message.inReplyTo && options?.sourceTaskId) {
          const [ownerObjective] = yield tx
            .select()
            .from(self.tables.objectives)
            .where(eq(self.tables.objectives.id, message.objectiveId));
          if (ownerObjective?.ownerTagId === senderTagId)
            yield* handleOperatorInputs(
              tx,
              self.tables,
              ownerObjective,
              options.sourceTaskId,
              options.sourceAttemptCount,
              at,
              "tag-message",
              inserted[0].id,
              message.inReplyTo,
            );
        }
        return { message: publicMessage(inserted[0]), duplicate: false };
      }
      const [prior] = yield tx
        .select()
        .from(t)
        .where(and(eq(t.senderTagId, senderTagId), eq(t.idempotencyKey, message.idempotencyKey)))
        .limit(1);
      if (!prior || prior.fingerprint !== fingerprint)
        throw new TagMessagingError(
          409,
          "Idempotency key was already used for a different message",
        );
      return { message: publicMessage(prior), duplicate: true };
    });
  }

  async listOpenTeamMessages(
    teamId: string,
    objectiveId: string,
    limit = 21,
  ): Promise<readonly TagMessage[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TagMessagingError(400, "limit must be 1–100");
    await this.readablePostObjective(teamId, undefined, mailboxText(objectiveId, "objectiveId"));
    const [team] = await this.db
      .select()
      .from(this.tables.teams)
      .where(eq(this.tables.teams.id, teamId))
      .limit(1);
    if (!team) throw new TagMessagingError(404, "Team not found");
    const members = [...new Set([team.leadTagId, ...team.memberTagIds])];
    const t = this.tables.tagMessages;
    const rows = await this.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.objectiveId, objectiveId),
          inArray(t.senderTagId, members),
          inArray(t.recipientTagId, members),
          sql`${t.operatorId} IS NULL`,
          inArray(t.type, ["question", "blocker"]),
          visibleDirectMessage(t, this.tables.teams, this.provider),
          sql`NOT EXISTS (SELECT 1 FROM "TagMessage" reply WHERE reply."inReplyTo" = ${t.id} AND reply."objectiveId" = ${t.objectiveId})`,
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit);
    return rows.map(publicMessage);
  }

  async recordOperatorInputReceipt(
    input: Parameters<TagMailboxStore["recordOperatorInputReceipt"]>[0],
  ): Promise<void> {
    if (!input.messageIds.length) return;
    const self = this;
    await this.surfaceTransaction(function* (tx) {
      const q = self.tables.taskAssignments;
      const [candidate] = yield tx.select().from(q).where(eq(q.taskId, input.taskId));
      if (!candidate) return;
      yield lockObjective(tx, self.tables.objectives, candidate.objectiveId);
      const [task] = yield tx.select().from(q).where(eq(q.taskId, input.taskId));
      const [objective] = yield tx
        .select()
        .from(self.tables.objectives)
        .where(eq(self.tables.objectives.id, task.objectiveId));
      const at = new Date().toISOString();
      if (
        !objective ||
        !ownerActivation(task, objective.ownerTagId) ||
        task.status !== "running" ||
        task.attemptCount !== input.attemptCount ||
        !task.leaseExpiresAt ||
        task.leaseExpiresAt <= at
      )
        return;
      const m = self.tables.tagMessages;
      const messages = yield tx
        .select({ id: m.id })
        .from(m)
        .where(
          and(
            inArray(m.id, [...input.messageIds]),
            eq(m.objectiveId, objective.id),
            eq(m.recipientTagId, objective.ownerTagId),
            sql`${m.operatorId} is not null`,
          ),
        );
      if (messages.length)
        yield tx
          .insert(self.tables.operatorInputReceipts)
          .values(
            messages.map((message: { id: string }) => ({
              taskId: task.taskId,
              attemptCount: input.attemptCount,
              messageId: message.id,
              seenAt: at,
            })),
          )
          .onConflictDoNothing()
          .returning();
    });
  }

  async listObjectiveTagMessageHistory(
    tagId: string,
    objectiveId: string,
    options: Parameters<TagMailboxStore["listObjectiveTagMessageHistory"]>[2] = {},
  ): ReturnType<TagMailboxStore["listObjectiveTagMessageHistory"]> {
    return this.messageHistory(tagId, options, objectiveId);
  }

  async listUnhandledOperatorInputs(
    objectiveId: string,
    limit = 100,
    offset = 0,
  ): Promise<readonly TagMessage[]> {
    checkLimit(limit);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new TagMessagingError(400, "offset must be a nonnegative safe integer");
    const objective = await this.getObjective(objectiveId);
    const tables = this.tables;
    return this.surfaceTransaction(function* (tx) {
      return yield* unhandledOperatorInputs(tx, tables, objective, limit, offset);
    });
  }

  async listTagMessageHistory(
    tagId: string,
    options: Parameters<TagMailboxStore["listTagMessageHistory"]>[1] = {},
  ): ReturnType<TagMailboxStore["listTagMessageHistory"]> {
    return this.messageHistory(tagId, options);
  }
  private async messageHistory(
    tagId: string,
    options: Parameters<TagMailboxStore["listTagMessageHistory"]>[1] = {},
    objectiveId?: string,
  ): ReturnType<TagMailboxStore["listTagMessageHistory"]> {
    await this.activeTag(mailboxText(tagId, "tagId"));
    const parsed = mailboxObject(options, ["before", "limit"]);
    const limit = parsed["limit"] === undefined ? 50 : (parsed["limit"] as number);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new TagMessagingError(400, "limit must be 1–200");
    const t = this.tables.tagMessages;
    let cursor: ReturnType<typeof or>;
    if (parsed["before"] !== undefined) {
      const before = mailboxObject(parsed["before"], ["createdAt", "id"]);
      if (
        typeof before["createdAt"] !== "string" ||
        !Number.isFinite(Date.parse(before["createdAt"]))
      )
        throw new TagMessagingError(400, "Invalid history cursor timestamp");
      const at = new Date(before["createdAt"]).toISOString(),
        id = mailboxText(before["id"], "id");
      cursor = or(lt(t.createdAt, at), and(eq(t.createdAt, at), lt(t.id, id)));
    }
    const rows = await this.db
      .select()
      .from(t)
      .where(
        and(
          or(eq(t.senderTagId, tagId), eq(t.recipientTagId, tagId)),
          objectiveId === undefined ? undefined : eq(t.objectiveId, objectiveId),
          visibleDirectMessage(t, this.tables.teams, this.provider),
          cursor,
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(publicMessage),
      last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last
        ? { nextCursor: { createdAt: last.createdAt, id: last.id } }
        : {}),
    };
  }
  async listObjectiveOperatorMessages(
    objectiveId: string,
    recipientTagId: string,
  ): ReturnType<TagMailboxStore["listObjectiveOperatorMessages"]> {
    await this.activeTag(mailboxText(recipientTagId, "recipientTagId"));
    mailboxText(objectiveId, "objectiveId");
    const t = this.tables.tagMessages;
    const rows = await this.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.objectiveId, objectiveId),
          eq(t.recipientTagId, recipientTagId),
          sql`${t.operatorId} is not null`,
          sql`${t.operatorId} <> ${OBJECTIVE_LIMITS_AUTHOR}`,
          visibleDirectMessage(t, this.tables.teams, this.provider),
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(51);
    const older = rows[50];
    return {
      items: rows.slice(0, 50).map(publicMessage),
      ...(older ? { olderMessage: { id: older.id, createdAt: older.createdAt } } : {}),
    };
  }
  async pruneTagMessageBodies(
    input: Parameters<TagMailboxStore["pruneTagMessageBodies"]>[0],
  ): ReturnType<TagMailboxStore["pruneTagMessageBodies"]> {
    const parsed = mailboxObject(input, ["before", "limit"]);
    if (typeof parsed["before"] !== "string" || !Number.isFinite(Date.parse(parsed["before"])))
      throw new TagMessagingError(400, "before must be a valid timestamp");
    const before = new Date(parsed["before"]).toISOString(),
      limit = parsed["limit"] === undefined ? 100 : (parsed["limit"] as number);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new TagMessagingError(400, "limit must be 1–1000");
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const t = self.tables.tagMessages;
      const eligible = and(
        or(eq(t.status, "processed"), eq(t.status, "failed")),
        lt(t.updatedAt, before),
        sql`${t.bodyPrunedAt} is null`,
        sql`${t.leaseExpiresAt} is null`,
        // Operator direction belongs to every later owner wake until the Objective closes.
        // This predicate is rechecked below while holding the Objective lock, including reopen.
        sql`(${t.operatorId} is null or not exists (select 1 from "Objective" o where o."id" = ${t.objectiveId} and o."status" not in ('completed', 'cancelled')))`,
        sql`not exists (select 1 from "TaskAssignment" q where q."sourceMessageId" = ${t.id} and q."status" in ('queued','running','waiting','submitted'))`,
      );
      const candidates = yield tx
        .select({ id: t.id, objectiveId: t.objectiveId })
        .from(t)
        .where(eligible)
        .orderBy(asc(t.updatedAt), asc(t.id))
        .limit(limit);
      // Task transitions acquire this same lock. Order all locks consistently,
      // then recheck eligibility after any concurrent transition has committed.
      const objectives = self.tables.objectives;
      const objectiveIds = [
        ...new Set<string>(candidates.map((row: any) => row.objectiveId)),
      ].sort();
      for (const objectiveId of objectiveIds) yield lockObjective(tx, objectives, objectiveId);
      let pruned = 0;
      for (const candidate of candidates) {
        const changed = yield tx
          .update(t)
          .set({ body: {}, bodyPrunedAt: new Date().toISOString() })
          .where(and(eq(t.id, candidate.id), eligible))
          .returning({ id: t.id });
        pruned += changed.length;
      }
      return { pruned };
    });
  }

  async listTagMessages(tagId: string, limit = 100): Promise<readonly TagMessage[]> {
    await this.activeTag(tagId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new TagMessagingError(400, "limit must be between 1 and 200");
    const t = this.tables.tagMessages;
    return (
      await this.db
        .select()
        .from(t)
        .where(
          and(
            or(eq(t.senderTagId, tagId), eq(t.recipientTagId, tagId)),
            visibleDirectMessage(t, this.tables.teams, this.provider),
          ),
        )
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit)
    ).map(publicMessage);
  }

  async getTagMessage(
    messageId: string,
    recipient?: { readonly tagId: string; readonly objectiveId: string },
  ): Promise<TagMessage | undefined> {
    mailboxText(messageId, "messageId");
    if (recipient) await this.activeTag(mailboxText(recipient.tagId, "tagId"));
    const t = this.tables.tagMessages;
    const [row] = await this.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.id, messageId),
          recipient
            ? and(
                eq(t.recipientTagId, recipient.tagId),
                eq(t.objectiveId, mailboxText(recipient.objectiveId, "objectiveId")),
                visibleDirectMessage(t, this.tables.teams, this.provider),
                or(
                  sql`${t.directTeamId} is null`,
                  currentDirectTeamParticipants(t, this.tables.teams, this.provider),
                ),
              )
            : undefined,
        ),
      )
      .limit(1);
    return row ? publicMessage(row) : undefined;
  }

  async listTagMessageReplies(messageId: string, limit = 100): Promise<readonly TagMessage[]> {
    mailboxText(messageId, "messageId");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new TagMessagingError(400, "limit must be between 1 and 200");
    const t = this.tables.tagMessages;
    return (
      await this.db
        .select()
        .from(t)
        .where(eq(t.inReplyTo, messageId))
        .orderBy(asc(t.createdAt), asc(t.id))
        .limit(limit)
    ).map(publicMessage);
  }

  async listTaskPriorityMessages(
    objectiveId: string,
    taskIds: readonly string[],
  ): Promise<readonly TagMessage[]> {
    mailboxText(objectiveId, "objectiveId");
    if (
      !Array.isArray(taskIds) ||
      taskIds.length > 100 ||
      taskIds.some((taskId) => mailboxText(taskId, "taskId") !== taskId)
    )
      throw new TagMessagingError(400, "At most 100 valid Task IDs are required");
    const t = this.tables.tagMessages;
    const messages: TagMessage[] = [];
    for (const taskId of [...new Set(taskIds)]) {
      const bodyTaskId =
        this.provider === "postgresql"
          ? sql`${t.body}->>'taskId' = ${taskId}`
          : sql`json_extract(${t.body}, '$.taskId') = ${taskId}`;
      const [proposal] = await this.db
        .select()
        .from(t)
        .where(and(eq(t.objectiveId, objectiveId), eq(t.type, "priority.proposed"), bodyTaskId))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(1);
      if (!proposal) continue;
      messages.push(publicMessage(proposal));
      messages.push(...(await this.listTagMessageReplies(proposal.id, 2)));
    }
    return messages;
  }

  async claimTagMessage(
    input: Parameters<TagMailboxStore["claimTagMessage"]>[0],
  ): Promise<TagMessageDelivery | undefined> {
    const t = this.tables.tagMessages;
    // Expired claims are redeliverable, but poison messages cannot block an inbox forever.
    await this.db
      .update(t)
      .set({
        status: "failed",
        updatedAt: input.now,
        leaseToken: null,
        leaseCredentialId: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(t.recipientTagId, input.tagId),
          gte(t.attemptCount, MAX_DELIVERIES),
          due(t, input.now),
          sql`${t.recipientTeamId} is null`,
          sql`not exists (select 1 from "TaskAssignment" q where q."sourceMessageId" = ${t.id})`,
        ),
      );
    for (let i = 0; i < 8; i += 1) {
      const candidate = (
        await this.db
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              eq(t.recipientTagId, input.tagId),
              lt(t.attemptCount, MAX_DELIVERIES),
              due(t, input.now),
              sql`${t.recipientTeamId} is null`,
              sql`not exists (select 1 from "TaskAssignment" q where q."sourceMessageId" = ${t.id})`,
            ),
          )
          .orderBy(asc(t.createdAt), asc(t.id))
          .limit(1)
      )[0];
      if (!candidate) return undefined;
      const leaseToken = randomUUID();
      const rows = await this.db
        .update(t)
        .set({
          status: "processing",
          attemptCount: sql`${t.attemptCount} + 1`,
          leaseToken,
          leaseCredentialId: input.credentialId,
          leaseExpiresAt: input.leaseExpiresAt,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(t.id, candidate.id),
            lt(t.attemptCount, MAX_DELIVERIES),
            due(t, input.now),
            sql`${t.recipientTeamId} is null`,
            sql`not exists (select 1 from "TaskAssignment" q where q."sourceMessageId" = ${t.id})`,
          ),
        )
        .returning();
      if (rows[0])
        return {
          message: publicMessage(rows[0]),
          leaseToken,
          leaseExpiresAt: input.leaseExpiresAt,
        };
    }
    return undefined;
  }

  async settleTagMessage(
    input: Parameters<TagMailboxStore["settleTagMessage"]>[0],
  ): Promise<boolean> {
    const t = this.tables.tagMessages;
    const rows = await this.db
      .update(t)
      .set({
        status: input.status,
        updatedAt: input.now,
        ...(input.status === "processed" ? { processedAt: input.now } : {}),
        // Retain the receipt for idempotent acknowledgement after an ambiguous response.
        ...(input.status === "processed" ? {} : { leaseToken: null, leaseCredentialId: null }),
        leaseExpiresAt: null,
      })
      .where(ownedLease(t, input))
      .returning();
    if (rows.length > 0) return true;
    if (input.status !== "processed") return false;
    return (
      (
        await this.db
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              eq(t.id, input.messageId),
              eq(t.recipientTagId, input.tagId),
              eq(t.leaseCredentialId, input.credentialId),
              eq(t.leaseToken, input.leaseToken),
              eq(t.status, "processed"),
            ),
          )
          .limit(1)
      ).length > 0
    );
  }

  async renewTagMessage(
    input: Parameters<TagMailboxStore["renewTagMessage"]>[0],
  ): Promise<boolean> {
    const t = this.tables.tagMessages;
    return (
      (
        await this.db
          .update(t)
          .set({ leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now })
          .where(ownedLease(t, input))
          .returning()
      ).length > 0
    );
  }

  private async activeTag(id: string): Promise<void> {
    mailboxText(id, "tagId");
    const t = this.tables.tags;
    if (
      !(
        await this.db
          .select({ id: t.id })
          .from(t)
          .where(and(eq(t.id, id), eq(t.status, "active")))
          .limit(1)
      )[0]
    ) {
      throw new TagMessagingError(404, "Active Tag not found");
    }
  }

  private *lockActiveTags(tx: any, ids: readonly string[]): Generator<any, void, any> {
    const t = this.tables.tags;
    for (const id of [...new Set(ids)].sort()) {
      const query = tx.select({ id: t.id, status: t.status }).from(t).where(eq(t.id, id)).limit(1);
      const [tag] = yield this.provider === "postgresql" ? query.for("no key update") : query;
      if (tag?.status !== "active") throw new TagMessagingError(404, "Active Tag not found");
    }
  }
}
function due(t: any, now: string) {
  return or(eq(t.status, "pending"), and(eq(t.status, "processing"), lte(t.leaseExpiresAt, now)));
}
function ownedLease(
  t: any,
  input: {
    messageId: string;
    tagId: string;
    credentialId: string;
    leaseToken: string;
    now: string;
  },
) {
  return and(
    eq(t.id, input.messageId),
    eq(t.recipientTagId, input.tagId),
    eq(t.leaseCredentialId, input.credentialId),
    eq(t.leaseToken, input.leaseToken),
    eq(t.status, "processing"),
    sql`${t.leaseExpiresAt} > ${input.now}`,
  );
}
/** Unread rows each digest source scans per activation. */
const DIGEST_SCAN_LIMIT = 200;
const DIGEST_MAX_REFERENCES = 5;
/** Channels named in a digest's remaining; each ID is a Team ID, bounded by Team validation. */
const DIGEST_REMAINING_CHANNELS = 20;
const DIGEST_REFERENCE_CHARACTERS = 200;

/**
 * Digest text on one line: ANSI escapes, control characters, and bidirectional overrides
 * become spaces, so teammate text cannot draw headings or pass as separate prompt sections.
 */
function digestText(
  value: unknown,
  max: number = ACTIVATION_DIGEST_ITEM_MAX_CHARACTERS,
): { text: string; truncated: boolean } {
  const raw = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  const text = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove ANSI escapes from teammate text.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Flatten control characters.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length <= max
    ? { text, truncated: false }
    : { text: `${text.slice(0, max - 1)}…`, truncated: true };
}

export function publicMessage(row: any): TagMessage {
  return {
    id: row.id,
    senderTagId: row.senderTagId,
    ...(row.operatorId == null ? {} : { operatorId: row.operatorId }),
    recipientTagId: row.recipientTagId,
    to: [row.recipientTagId],
    ...(row.recipientTeamId == null ? {} : { recipientTeamId: row.recipientTeamId }),
    objectiveId: row.objectiveId,
    type: row.type,
    body: row.body,
    ...(row.bodyPrunedAt == null ? {} : { bodyPrunedAt: row.bodyPrunedAt }),
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.inReplyTo === null || row.inReplyTo === undefined ? {} : { inReplyTo: row.inReplyTo }),
    ...(row.processedAt === null || row.processedAt === undefined
      ? {}
      : { processedAt: row.processedAt }),
  };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new TagMessagingError(400, "limit must be between 1 and 200");
}

function sameSurfaceAudience(left: any, right: any): boolean {
  if (left.audience === right.audience) return true;
  const a = left.inbound.event,
    b = right.inbound.event;
  if (a.provider !== "slack" || b.provider !== "slack") return false;
  const normalize = (source: any) => {
    const event = source.inbound.event;
    const { threadTs: _threadTs, ...target } = event.callback.target;
    return canonicalJson({
      surfaceAccountId: source.inbound.surfaceAccountId,
      provider: event.provider,
      externalAccountId: event.externalAccountId,
      scope: event.scope,
      mode: event.callback.mode,
      target,
    });
  };
  return normalize(left) === normalize(right);
}
