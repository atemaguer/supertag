// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across the SQLite and PostgreSQL dialects.

import { createHash, randomUUID } from "node:crypto";
import {
  type DatabaseProvider,
  type DeliverTagMessageInput,
  inboxSessionKey,
  type ListTeamPostsOptions,
  mailboxObject,
  mailboxText,
  narrowObjectiveWorkspaces,
  type Objective,
  type ObjectiveLimitState,
  type ObjectiveStore,
  objectiveDeadlineStopsRunning,
  type PostInput,
  parseCancelObjective,
  parseCreateObjective,
  parseObjectiveStatus,
  parseSurfaceObjectiveCommand,
  parseWorkspaceNames,
  TAG_MESSAGE_TEXT_MAX,
  type TagMailboxStore,
  type TagMessage,
  type TagMessageHistoryOptions,
  type TagMessageHistoryPage,
  type TagMessageStatus,
  TagMessagingError,
  type TagMessagingGrant,
  WORKSTREAM_POST_MAX_BODY,
  WORKSTREAM_POST_MAX_TO,
  type WorkstreamPost,
  type WorkstreamStore,
  workspacesForGitHubRepository,
} from "@supertag/core";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { expireClosedObjectiveApprovals } from "./approval-store.js";
import { runDialectTransaction } from "./dialect-transaction.js";
import { lockObjective } from "./objective-lock.js";
import { appendResourceChange } from "./resource-change-store.js";
import { nextTaskEventSequence } from "./task-event-sequence.js";
import { teamFromRow, teamHasMember } from "./team-store.js";

/** Objectives, Team Workstream posts, and Tag Mailbox messages. */
export class DrizzleMailboxStore
  implements TagMailboxStore, WorkstreamStore, Omit<ObjectiveStore, "getObjectiveSurfaceTask">
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
      const [existing] = yield tx
        .select()
        .from(o)
        .where(eq(o.surfaceSessionId, source.task.sessionId))
        .limit(1);
      if (existing) {
        const anchor = existing.surfaceTaskId
          ? yield* self.surfaceSource(tx, existing.surfaceTaskId)
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
        return existing as Objective;
      }
      const at = new Date().toISOString();
      const [created] = yield tx
        .insert(o)
        .values({
          ...definition,
          teamId: null,
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
      return created as Objective;
    });
  }
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
  async getSurfaceObjective(taskId: string): Promise<Objective | undefined> {
    mailboxText(taskId, "taskId");
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const source = yield* self.surfaceSource(tx, taskId);
      if (!source) return undefined;
      const o = self.tables.objectives;
      const [objective] = yield tx
        .select()
        .from(o)
        .where(
          and(eq(o.surfaceSessionId, source.task.sessionId), eq(o.ownerTagId, source.task.tagId)),
        )
        .limit(1);
      if (!objective?.surfaceTaskId) return undefined;
      const anchor = yield* self.surfaceSource(tx, objective.surfaceTaskId);
      return anchor?.audience === source.audience ? (objective as Objective) : undefined;
    });
  }
  async findObjectiveByHomeSession(sessionId: string): Promise<Objective | undefined> {
    const o = this.tables.objectives;
    const [objective] = await this.db
      .select()
      .from(o)
      .where(
        and(
          sql`${o.status} not in ('completed', 'cancelled')`,
          sql`exists (select 1 from "Task" t where t."id" = coalesce(${o.notificationTaskId}, ${o.surfaceTaskId}) and t."sessionId" = ${mailboxText(sessionId, "sessionId")})`,
        ),
      )
      .orderBy(desc(o.updatedAt), desc(o.id))
      .limit(1);
    return objective as Objective | undefined;
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
    if (definition.teamId) {
      const teams = this.tables.teams;
      const [team] = await this.db
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, definition.teamId))
        .limit(1);
      if (!team)
        throw new TagMessagingError(
          400,
          `Team ${definition.teamId} does not exist; create the Team before naming it`,
        );
    }
    const t = this.tables.objectives;
    const at = new Date().toISOString();
    const values = {
      ...definition,
      teamId: definition.teamId ?? null,
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
        return { ...values, completionSummary: null, executionStartedAt: null } as Objective;
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
      Boolean(prior.ongoing) !== Boolean(definition.ongoing) ||
      prior.ownerTagId !== ownerTagId ||
      prior.outcome !== definition.outcome ||
      (prior.teamId ?? null) !== (definition.teamId ?? null) ||
      (prior.deadline ?? null) !== definition.deadline ||
      (prior.budgetLimitMinor ?? null) !== definition.budgetLimitMinor ||
      (prior.budgetCurrency ?? null) !== definition.budgetCurrency ||
      canonicalJson(prior.runtimeActions ?? []) !== canonicalJson(definition.runtimeActions) ||
      canonicalJson(prior.workspaces ?? []) !== canonicalJson(definition.workspaces ?? [])
    )
      throw new TagMessagingError(409, "Objective ID already exists with a different definition");
    return prior;
  }

  /** A Tag sees the Objectives it owns and those naming a Team it is a member of. */
  private objectiveVisibility(tagId: string) {
    const o = this.tables.objectives;
    const team = this.tables.teams;
    return or(
      eq(o.ownerTagId, tagId),
      sql`exists (select 1 from ${team} where ${team.id} = ${o.teamId} and ${teamHasMember(this.provider, team.memberTagIds, tagId)})`,
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
      .orderBy(desc(t.updatedAt), desc(t.id))
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
      const o = self.tables.objectives,
        t = self.tables.tasks,
        s = self.tables.sessions;
      // Admissions lock this row before checking limits. Recheck the drain under that lock,
      // then persist exhaustion even when an admission won the race.
      const [locked] = yield lockObjective(tx, o, mailboxText(id, "objectiveId"));
      if (!locked || locked.revision !== expectedRevision) return undefined;
      const running = limited
        ? yield tx
            .select({ id: t.id })
            .from(t)
            .innerJoin(s, eq(s.id, t.sessionId))
            .where(and(eq(s.objectiveId, id), eq(t.status, "running")))
            .limit(1)
        : [];
      const drained = limited && running.length === 0 && locked.status !== "limited";
      const [updated] = yield tx
        .update(o)
        .set({
          limitState: drained ? { ...state, summary: undefined } : state,
          ...(drained
            ? {
                status: "limited",
                revision: sql`${o.revision} + 1`,
                updatedAt: new Date().toISOString(),
              }
            : {}),
        })
        .where(and(eq(o.id, id), eq(o.revision, expectedRevision)))
        .returning();
      return updated as Objective | undefined;
    });
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
      if (actorTagId !== undefined && update.status === "completed" && objective.ongoing)
        throw new TagMessagingError(
          403,
          "Only operators may end an ongoing Objective; completing an assessment does not end the responsibility",
        );
      if (
        update.budgetLimitMinor !== undefined &&
        (objective.status === "completed" ||
          objective.budgetLimitMinor == null ||
          update.budgetLimitMinor <= objective.budgetLimitMinor)
      )
        throw new TagMessagingError(
          409,
          "Increase an active Objective's finite allocation above its current limit",
        );
      if (update.deadline !== undefined && objective.status === "completed")
        throw new TagMessagingError(409, "A completed Objective's deadline cannot change");
      const at = new Date().toISOString();
      if (update.status === "limited") {
        if (objective.status !== "limited" || actorTagId !== objective.ownerTagId)
          throw new TagMessagingError(
            403,
            "Only the owner of a limited Objective can record its limit summary",
          );
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
      let completing: { task: any; attempt: any } | undefined;
      if (execution !== undefined) {
        if (
          (update.status !== "completed" && update.status !== "limited") ||
          actorTagId === undefined
        )
          throw new TagMessagingError(
            400,
            "Completion execution requires an authenticated owner completion",
          );
        const t = self.tables.tasks,
          a = self.tables.taskAttempts,
          i = self.tables.durableInboundEvents;
        const [task] = yield tx.select().from(t).where(eq(t.id, execution.taskId));
        const [attempt] = yield tx
          .select()
          .from(a)
          .where(eq(a.taskId, execution.taskId))
          .orderBy(desc(a.attemptNumber))
          .limit(1);
        const [inbound] = task?.inboundEventId
          ? yield tx.select().from(i).where(eq(i.id, task.inboundEventId))
          : [];
        if (
          !task ||
          task.objectiveId !== id ||
          task.tagId !== actorTagId ||
          task.status !== "running" ||
          !attempt ||
          attempt.status !== "running" ||
          attempt.attemptNumber !== execution.attemptCount ||
          inbound?.status !== "processing" ||
          inbound.leaseOwner !== execution.leaseOwner
        )
          throw new TagMessagingError(409, "Completion execution authority expired");
        const [tag] = yield tx
          .select()
          .from(self.tables.tags)
          .where(eq(self.tables.tags.id, actorTagId));
        if (
          objective.status === "completed" ||
          // A running owner may still complete during the deadline grace period.
          (update.status === "completed" && objectiveDeadlineStopsRunning(objective, at)) ||
          tag?.status !== "active"
        )
          throw new TagMessagingError(403, "Completion execution authority revoked");
        completing = { task, attempt };
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
                  : { completionSummary: update.completionSummary ?? null }),
              }),
          ...(update.budgetLimitMinor === undefined
            ? {}
            : { budgetLimitMinor: update.budgetLimitMinor }),
          ...(runtimeActionsChanged ? { runtimeActions: update.runtimeActions } : {}),
          ...(deadlineChanged
            ? {
                deadline: update.deadline,
                // Warnings already due when the deadline was set are skipped.
                limitState: {
                  ...(objective.limitState ?? {}),
                  deadlineSetAt: { deadline: update.deadline, at },
                },
              }
            : {}),
          revision: sql`${o.revision} + 1`,
          updatedAt: at,
        })
        .where(and(eq(o.id, id), eq(o.revision, update.expectedRevision)))
        .returning();
      if (!updated)
        throw new TagMessagingError(409, "Objective revision changed; reload before updating");
      if (update.status === "completed")
        yield* expireClosedObjectiveApprovals(tx, self.tables, id, "completed", at);
      const statusChanged =
        updated.status !== objective.status ||
        updated.completionSummary !== objective.completionSummary;
      if (
        (actorTagId === objective.ownerTagId && statusChanged) ||
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
          changes: {
            ...(statusChanged
              ? { status: { previous: objective.status, next: updated.status } }
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
    const operatorId = operatorPrincipal(source);
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const o = self.tables.objectives;
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
        changes: {
          status: { previous: objective.status, next: "cancelled" },
          ...(reason === null ? {} : { cancellationReason: { previous: null, next: reason } }),
        },
        createdAt: at,
      });
      yield* expireClosedObjectiveApprovals(tx, self.tables, id, "cancelled", at);
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
    const operatorId = operatorPrincipal(source);
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
        changes: { pausedAt: { previous: pausedAt, next } },
        createdAt: at,
      });
      return { objective: updated as Objective, changed: true, pausedAt };
    });
  }

  async post(input: PostInput): ReturnType<WorkstreamStore["post"]> {
    const teamId = mailboxText(input.teamId, "teamId");
    const authorTagId = mailboxText(input.authorTagId, "authorTagId");
    const sourceTaskId =
      input.sourceTaskId === undefined
        ? undefined
        : mailboxText(input.sourceTaskId, "sourceTaskId");
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body || body.length > WORKSTREAM_POST_MAX_BODY)
      throw new TagMessagingError(
        400,
        `text must contain 1–${WORKSTREAM_POST_MAX_BODY} characters`,
      );
    if (
      input.to !== undefined &&
      (!Array.isArray(input.to) || input.to.length > WORKSTREAM_POST_MAX_TO)
    )
      throw new TagMessagingError(400, `to must list at most ${WORKSTREAM_POST_MAX_TO} Tags`);
    const to = [...new Set((input.to ?? []).map((tag) => mailboxText(tag, "to")))].sort();
    // A retried Attempt that posts the same text to the same Tags stores nothing new.
    const idempotencyKey =
      sourceTaskId === undefined
        ? randomUUID()
        : `${sourceTaskId}:${createHash("sha256").update(canonicalJson({ to, body })).digest("hex")}`;
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const teams = self.tables.teams,
        p = self.tables.workstreamPosts;
      // The Team lock serializes membership changes, sequence numbers and duplicate checks.
      const [locked] = yield tx
        .update(teams)
        .set({ updatedAt: sql`${teams.updatedAt}` })
        .where(eq(teams.id, teamId))
        .returning();
      if (!locked) throw new TagMessagingError(404, "Team not found");
      const team = teamFromRow(locked);
      const [author] = yield tx
        .select({ status: self.tables.tags.status })
        .from(self.tables.tags)
        .where(eq(self.tables.tags.id, authorTagId));
      if (author?.status !== "active" || !team.memberTagIds.includes(authorTagId))
        throw new TagMessagingError(403, `Only members of Team ${team.name} may post to it`);
      const outside = to.filter((tagId) => !team.memberTagIds.includes(tagId));
      if (outside.length)
        throw new TagMessagingError(
          400,
          `to must name Tags in Team ${team.name}; not members: ${outside.slice(0, 5).join(", ")}`,
        );
      const [existing] = yield tx
        .select()
        .from(p)
        .where(
          and(
            eq(p.teamId, teamId),
            eq(p.authorTagId, authorTagId),
            eq(p.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) return { post: postFromRow(existing), duplicate: true };
      const [last] = yield tx
        .select({ sequence: p.sequence })
        .from(p)
        .where(eq(p.teamId, teamId))
        .orderBy(desc(p.sequence))
        .limit(1);
      const [created] = yield tx
        .insert(p)
        .values({
          id: randomUUID(),
          teamId,
          authorTagId,
          sourceTaskId: sourceTaskId ?? null,
          to,
          body,
          sequence: (last?.sequence ?? 0) + 1,
          createdAt: new Date().toISOString(),
          idempotencyKey,
        })
        .returning();
      return { post: postFromRow(created), duplicate: false };
    });
  }

  async listTeamPosts(
    teamId: string,
    options: ListTeamPostsOptions = {},
  ): Promise<readonly WorkstreamPost[]> {
    const id = mailboxText(teamId, "teamId");
    const parsed = mailboxObject(options, ["afterSequence", "limit"]);
    const limit = parsed["limit"] === undefined ? 50 : (parsed["limit"] as number);
    checkLimit(limit);
    const after = parsed["afterSequence"];
    if (after !== undefined && (!Number.isSafeInteger(after) || (after as number) < 0))
      throw new TagMessagingError(400, "afterSequence must be a nonnegative integer");
    const teams = this.tables.teams,
      p = this.tables.workstreamPosts;
    const [team] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, id))
      .limit(1);
    if (!team) throw new TagMessagingError(404, "Team not found");
    if (after !== undefined) {
      const rows = await this.db
        .select()
        .from(p)
        .where(and(eq(p.teamId, id), sql`${p.sequence} > ${after as number}`))
        .orderBy(asc(p.sequence))
        .limit(limit);
      return rows.map(postFromRow);
    }
    const rows = await this.db
      .select()
      .from(p)
      .where(eq(p.teamId, id))
      .orderBy(desc(p.sequence))
      .limit(limit);
    return rows.map(postFromRow).toReversed();
  }

  async setTagMessagingGrants(
    recipientTagId: string,
    senderTagIds: readonly string[],
  ): Promise<void> {
    const recipient = mailboxText(recipientTagId, "recipientTagId");
    if (!Array.isArray(senderTagIds) || senderTagIds.length > 1000)
      throw new TagMessagingError(400, "senderTagIds must list at most 1000 Tags");
    const senders = [...new Set(senderTagIds.map((id) => mailboxText(id, "senderTagId")))].sort();
    if (senders.includes(recipient))
      throw new TagMessagingError(400, "A Tag needs no grant to message itself");
    const self = this;
    await this.surfaceTransaction(function* (tx) {
      yield* self.lockActiveTags(tx, [recipient, ...senders]);
      const t = self.tables.tagMessagingGrants;
      yield tx.delete(t).where(eq(t.recipientTagId, recipient)).returning();
      if (senders.length > 0)
        yield tx
          .insert(t)
          .values(senders.map((senderTagId) => ({ senderTagId, recipientTagId: recipient })))
          .returning();
    });
  }

  async changeTagMessagingGrant(grant: TagMessagingGrant, granted: boolean): Promise<boolean> {
    const sender = mailboxText(grant.senderTagId, "senderTagId");
    const recipient = mailboxText(grant.recipientTagId, "recipientTagId");
    if (sender === recipient)
      throw new TagMessagingError(400, "A Tag needs no grant to message itself");
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      yield* self.lockActiveTags(tx, [recipient, sender]);
      const t = self.tables.tagMessagingGrants;
      const pair = and(eq(t.senderTagId, sender), eq(t.recipientTagId, recipient));
      const [existing] = yield tx
        .select({ senderTagId: t.senderTagId })
        .from(t)
        .where(pair)
        .limit(1);
      if ((existing !== undefined) === granted) return false;
      if (granted)
        yield tx.insert(t).values({ senderTagId: sender, recipientTagId: recipient }).returning();
      else yield tx.delete(t).where(pair).returning();
      return true;
    });
  }

  async listTagMessagingGrants(tagId: string): Promise<readonly TagMessagingGrant[]> {
    await this.activeTag(tagId);
    const t = this.tables.tagMessagingGrants;
    const rows = await this.db
      .select({ senderTagId: t.senderTagId, recipientTagId: t.recipientTagId })
      .from(t)
      .where(or(eq(t.senderTagId, tagId), eq(t.recipientTagId, tagId)))
      .orderBy(asc(t.senderTagId), asc(t.recipientTagId));
    return rows.map((row: any) => ({
      senderTagId: row.senderTagId,
      recipientTagId: row.recipientTagId,
    }));
  }

  async mayMessage(senderTagId: string, recipientTagId: string): Promise<boolean> {
    const sender = mailboxText(senderTagId, "senderTagId");
    const recipient = mailboxText(recipientTagId, "recipientTagId");
    const tags = this.tables.tags,
      teams = this.tables.teams,
      grants = this.tables.tagMessagingGrants;
    const active = await this.db
      .select({ id: tags.id })
      .from(tags)
      .where(and(inArray(tags.id, [sender, recipient]), eq(tags.status, "active")));
    if (active.length !== new Set([sender, recipient]).size) return false;
    const [team] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          teamHasMember(this.provider, teams.memberTagIds, sender),
          teamHasMember(this.provider, teams.memberTagIds, recipient),
        ),
      )
      .limit(1);
    if (team) return true;
    const [grant] = await this.db
      .select({ senderTagId: grants.senderTagId })
      .from(grants)
      .where(and(eq(grants.senderTagId, sender), eq(grants.recipientTagId, recipient)))
      .limit(1);
    return grant !== undefined;
  }

  async deliverTagMessage(
    input: DeliverTagMessageInput,
  ): Promise<{ readonly message: TagMessage; readonly admit: boolean }> {
    const senderTagId = mailboxText(input.senderTagId, "senderTagId");
    const recipientTagId = mailboxText(input.recipientTagId, "recipientTagId");
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > TAG_MESSAGE_TEXT_MAX)
      throw new TagMessagingError(400, `text must contain 1–${TAG_MESSAGE_TEXT_MAX} characters`);
    if (!Number.isSafeInteger(input.hops) || input.hops < 0)
      throw new TagMessagingError(400, "hops must be a nonnegative integer");
    const optional = (value: string | undefined, field: string) =>
      value === undefined ? null : mailboxText(value, field);
    const row = {
      id: randomUUID(),
      senderTagId,
      recipientTagId,
      objectiveId: optional(input.objectiveId, "objectiveId"),
      sourceTaskId: optional(input.sourceTaskId, "sourceTaskId"),
      workstreamPostId: optional(input.workstreamPostId, "workstreamPostId"),
      text,
      hops: input.hops,
      taskId: null,
      createdAt: new Date().toISOString(),
    };
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      // The recipient's lock orders this insert with the inbox turn that binds messages.
      yield* self.lockActiveTags(tx, [senderTagId, recipientTagId]);
      const m = self.tables.tagMessages,
        i = self.tables.durableInboundEvents;
      const [created] = yield tx.insert(m).values(row).returning();
      // A turn that has not started yet takes every unbound message when it does.
      const [waiting] = yield tx
        .select({ id: i.id })
        .from(i)
        .where(
          and(
            eq(i.tagId, recipientTagId),
            eq(i.sessionKey, inboxSessionKey(recipientTagId)),
            eq(i.status, "pending"),
          ),
        )
        .limit(1);
      return { message: messageFromRow(created), admit: waiting === undefined };
    });
  }

  async bindInboxMessages(taskId: string, tagId: string): Promise<readonly TagMessage[]> {
    const task = mailboxText(taskId, "taskId");
    const recipient = mailboxText(tagId, "tagId");
    const self = this;
    return this.surfaceTransaction(function* (tx) {
      const t = self.tables.tasks,
        m = self.tables.tagMessages;
      yield* self.lockActiveTags(tx, [recipient]);
      const [row] = yield tx.select({ tagId: t.tagId }).from(t).where(eq(t.id, task)).limit(1);
      if (row?.tagId !== recipient)
        throw new TagMessagingError(404, "Inbox Task not found for this Tag");
      yield tx
        .update(m)
        .set({ taskId: task })
        .where(and(eq(m.recipientTagId, recipient), isNull(m.taskId)))
        .returning({ id: m.id });
      const bound = yield self
        .messageQuery(tx)
        .where(eq(m.taskId, task))
        .orderBy(asc(m.createdAt), asc(m.id));
      return bound.map(messageFromRow);
    });
  }

  async listTagsWithUnboundMessages(limit: number): Promise<readonly string[]> {
    checkLimit(limit);
    const m = this.tables.tagMessages,
      tags = this.tables.tags;
    // Tags whose inbox already has a turn queued or running are left to that turn.
    const rows = await this.db
      .select({ tagId: m.recipientTagId, oldest: sql`min(${m.createdAt})` })
      .from(m)
      .innerJoin(tags, eq(tags.id, m.recipientTagId))
      .where(
        and(
          isNull(m.taskId),
          eq(tags.status, "active"),
          sql`not exists (select 1 from "DurableInboundEvent" e where e."tagId" = ${m.recipientTagId} and e."sessionKey" = 'inbox:' || ${m.recipientTagId} and e."status" in ('pending', 'processing'))`,
        ),
      )
      .groupBy(m.recipientTagId)
      .orderBy(sql`min(${m.createdAt})`, asc(m.recipientTagId))
      .limit(limit);
    return rows.map((row: any) => row.tagId as string);
  }

  async listTagMessageHistory(
    tagId: string,
    options: TagMessageHistoryOptions = {},
  ): Promise<TagMessageHistoryPage> {
    await this.activeTag(mailboxText(tagId, "tagId"));
    const parsed = mailboxObject(options, ["before", "limit"]);
    const limit = parsed["limit"] === undefined ? 50 : (parsed["limit"] as number);
    checkLimit(limit);
    const m = this.tables.tagMessages;
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
      cursor = or(lt(m.createdAt, at), and(eq(m.createdAt, at), lt(m.id, id)));
    }
    const rows = await this.messageQuery(this.db)
      .where(and(or(eq(m.senderTagId, tagId), eq(m.recipientTagId, tagId)), cursor))
      .orderBy(desc(m.createdAt), desc(m.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(messageFromRow),
      last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last
        ? { nextCursor: { createdAt: last.createdAt, id: last.id } }
        : {}),
    };
  }

  /** Messages with the status of the inbox Task that took each. */
  private messageQuery(db: any) {
    const m = this.tables.tagMessages,
      t = this.tables.tasks;
    return db.select({ message: m, taskStatus: t.status }).from(m).leftJoin(t, eq(t.id, m.taskId));
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
      if (tag?.status !== "active") throw new TagMessagingError(404, `Active Tag ${id} not found`);
    }
  }
}

function operatorPrincipal(source: { readonly operatorId: string } | undefined): string {
  const operatorId = source?.operatorId;
  if (typeof operatorId !== "string" || !operatorId.trim() || operatorId.length > 200)
    throw new TagMessagingError(401, "Invalid operator principal");
  return operatorId;
}

function messageStatus(taskStatus: unknown): TagMessageStatus {
  if (taskStatus === "completed") return "handled";
  if (taskStatus === "failed" || taskStatus === "cancelled") return "failed";
  return "pending";
}

function messageFromRow(row: any): TagMessage {
  const message = row.message ?? row;
  return {
    id: message.id,
    senderTagId: message.senderTagId,
    recipientTagId: message.recipientTagId,
    ...(message.objectiveId == null ? {} : { objectiveId: message.objectiveId }),
    ...(message.sourceTaskId == null ? {} : { sourceTaskId: message.sourceTaskId }),
    ...(message.workstreamPostId == null ? {} : { workstreamPostId: message.workstreamPostId }),
    text: message.text,
    hops: message.hops,
    ...(message.taskId == null ? {} : { taskId: message.taskId }),
    status: message.taskId == null ? "pending" : messageStatus(row.taskStatus),
    createdAt: message.createdAt,
  };
}

function postFromRow(row: any): WorkstreamPost {
  const to = typeof row.to === "string" ? JSON.parse(row.to) : row.to;
  return {
    id: row.id,
    teamId: row.teamId,
    authorTagId: row.authorTagId,
    to: Array.isArray(to) ? to : [],
    body: row.body,
    ...(row.sourceTaskId == null ? {} : { sourceTaskId: row.sourceTaskId }),
    sequence: row.sequence,
    createdAt: row.createdAt,
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
