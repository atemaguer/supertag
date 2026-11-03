// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import {
  type DatabaseProvider,
  leadershipTeamId,
  mailboxText,
  ORG_ARCHITECT_ROLE_KEY,
  objectiveClosed,
  parseCreateTeam,
  parseUpdateTeam,
  TAG_MAILBOX_MAX_OUTSTANDING,
  TagMessagingError,
  type Team,
  type TeamStore,
  teamSupportsObjective,
} from "@supertag/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";
import { lockObjective } from "./objective-lock.js";
import { resourceChangeDelta } from "./resource-change.js";
import { appendResourceChange } from "./resource-change-store.js";
import { lockTeamAncestors } from "./team-lock.js";
import { validateTeamScaling } from "./team-scaling.js";

/** Team change field naming the finished Objective whose closure dissolved the Team. */
export const TEAM_CLOSED_WITH_OBJECTIVE = "closedWithObjective";

/**
 * Restores the Teams that a completed Objective's closure dissolved, when an operator reopens it.
 * The caller holds the Objective lock.
 */
export function* restoreTeamsClosedWithObjective(
  tx: any,
  tables: any,
  objectiveId: string,
  at: string,
): Generator<any, readonly string[], any> {
  const t = tables.teams,
    c = tables.resourceChanges;
  const dissolved = (yield tx
    .select()
    .from(t)
    .where(and(eq(t.objectiveId, objectiveId), eq(t.status, "dissolved")))) as any[];
  const restored: string[] = [];
  for (const team of dissolved.toSorted((a, b) => a.id.localeCompare(b.id))) {
    const [latest] = yield tx
      .select()
      .from(c)
      .where(and(eq(c.resourceType, "team"), eq(c.resourceId, team.id)))
      .orderBy(desc(c.toRevision))
      .limit(1);
    if (latest?.changes?.[TEAM_CLOSED_WITH_OBJECTIVE]?.next !== objectiveId) continue;
    const [updated] = yield tx
      .update(t)
      .set({ status: "active", revision: team.revision + 1, updatedAt: at })
      .where(and(eq(t.id, team.id), eq(t.revision, team.revision)))
      .returning();
    if (!updated) continue;
    yield* appendResourceChange(tx, tables, {
      resourceType: "team",
      resourceId: team.id,
      fromRevision: team.revision,
      toRevision: updated.revision,
      actorTagId: null,
      operatorId: null,
      sourceTaskId: null,
      sourceMessageId: null,
      changes: {
        status: { previous: "dissolved", next: "active" },
        reason: { previous: null, next: `Objective ${objectiveId} was reopened` },
      },
      createdAt: at,
    });
    restored.push(team.id);
  }
  return restored;
}

const TEAM_CHANGE_FIELDS = [
  "context",
  "leadTagId",
  "maxConcurrency",
  "memberTagIds",
  "name",
  "objectiveId",
  "objectiveIds",
  "parentTeamId",
  "status",
  "scaling",
] as const;

export class DrizzleTeamStore implements TeamStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}
  private transaction<T>(work: (tx: any) => Generator<any, T, any>): Promise<T> {
    return runDialectTransaction(this.db, this.provider, work);
  }
  private *lock(tx: any, objectiveId: string): Generator<any, void, any> {
    const o = this.tables.objectives;
    const rows = yield lockObjective(tx, o, objectiveId);
    if (!rows[0]) throw new TagMessagingError(404, "Objective not found");
  }
  private *activeTag(tx: any, id: string): Generator<any, void, any> {
    const t = this.tables.tags;
    if (
      !(yield tx
        .select()
        .from(t)
        .where(and(eq(t.id, mailboxText(id, "tagId")), eq(t.status, "active")))
        .limit(1))[0]
    )
      throw new TagMessagingError(404, "Active Tag not found");
  }
  private *owner(tx: any, objectiveId: string): Generator<any, string, any> {
    const t = this.tables.objectives;
    const row = (yield tx.select().from(t).where(eq(t.id, objectiveId)).limit(1))[0];
    if (!row) throw new TagMessagingError(404, "Objective not found");
    return row.ownerTagId;
  }
  private *validateMembers(
    tx: any,
    lead: string,
    members: readonly string[],
  ): Generator<any, string[], any> {
    const ids = [...new Set([lead, ...members])].sort();
    if (ids.length > 100)
      throw new TagMessagingError(400, "A Team may have at most 100 members including its lead");
    for (const id of ids) yield* this.activeTag(tx, id);
    return ids;
  }
  private *parent(
    tx: any,
    id: string | undefined | null,
    objectiveId: string,
  ): Generator<any, Team | undefined, any> {
    if (!id) return undefined;
    const parent = yield* this.get(tx, id);
    if (!teamSupportsObjective(parent, objectiveId) || parent.status !== "active")
      throw new TagMessagingError(
        409,
        "Parent Team must be active and belong to the same Objective",
      );
    return parent;
  }
  /** A child Team's members must come from its parent; Team concurrency does not nest. */
  private bounded(
    team: Pick<Team, "memberTagIds">,
    parent: Pick<Team, "id" | "memberTagIds">,
  ): void {
    if (team.memberTagIds.some((id) => !parent.memberTagIds.includes(id)))
      throw new TagMessagingError(
        403,
        `Team exceeds delegated membership: members must belong to Team ${parent.id}`,
      );
  }
  /** A Team lead editing its own Team may tighten its throttle but not raise or remove it. */
  private throttled(next: Pick<Team, "maxConcurrency">, prior: Pick<Team, "maxConcurrency">): void {
    if (
      prior.maxConcurrency !== null &&
      (next.maxConcurrency === null || next.maxConcurrency > prior.maxConcurrency)
    )
      throw new TagMessagingError(
        403,
        `Only the Objective owner or parent Team lead may raise or remove Team concurrency above ${prior.maxConcurrency}`,
      );
  }
  /**
   * The Leadership Team's delegation to Teams below it. Besides Tags already granted (the owner,
   * the Leadership Team's members, and the Team's current members), a Team may add any active Tag
   * bound to a Worker Host that is not revoked. Concurrency is the Team's own optional throttle.
   */
  private *staffed(
    tx: any,
    team: Pick<Team, "memberTagIds">,
    granted: readonly string[],
  ): Generator<any, void, any> {
    const candidates = team.memberTagIds.filter((id) => !granted.includes(id));
    const problems: string[] = [];
    if (candidates.length) {
      const b = this.tables.tagWorkerHostBindings;
      const h = this.tables.workerHosts;
      const bindings = (yield tx
        .select({ tagId: b.tagId, enrollmentStatus: h.enrollmentStatus })
        .from(b)
        .leftJoin(h, eq(h.id, b.workerHostId))
        .where(inArray(b.tagId, candidates))) as {
        tagId: string;
        enrollmentStatus: string | null;
      }[];
      const hosted = new Set(
        bindings.filter((row) => row.enrollmentStatus !== "revoked").map((row) => row.tagId),
      );
      const unhosted = candidates.filter((id) => !hosted.has(id));
      if (unhosted.length) {
        const t = this.tables.tags;
        const rows = (yield tx
          .select({ id: t.id, name: t.name })
          .from(t)
          .where(inArray(t.id, unhosted))) as { id: string; name: string }[];
        const names = new Map(rows.map((row) => [row.id, row.name]));
        const shown = unhosted.slice(0, 5).map((id) => `Tag ${names.get(id) ?? id} (${id})`);
        if (unhosted.length > shown.length) shown.push(`${unhosted.length - shown.length} more`);
        problems.push(
          `${shown.join(", ")} ${unhosted.length === 1 ? "has" : "have"} no bound Worker Host.`,
        );
      }
    }
    if (problems.length)
      throw new TagMessagingError(
        403,
        `Objective staffing allows the owner, existing members, and active Tags bound to a Worker Host. ${problems.join(" ")} Use list_tags to see each Tag's Worker Hosts.`,
      );
  }
  private isLeadership(team: Pick<Team, "id" | "objectiveId" | "parentTeamId">): boolean {
    return team.parentTeamId === null && team.id === leadershipTeamId(team.objectiveId);
  }
  private *create(
    tx: any,
    input: Parameters<TeamStore["createTeam"]>[0],
    actorTagId?: string,
    source?: Parameters<TeamStore["createTeam"]>[2],
  ): Generator<any, Team, any> {
    const definition = parseCreateTeam(input);
    yield* this.lock(tx, definition.objectiveId);
    if (actorTagId !== undefined) yield* this.activeTag(tx, actorTagId);
    const owner = yield* this.owner(tx, definition.objectiveId);
    if (actorTagId !== undefined && definition.objectiveIds?.length)
      throw new TagMessagingError(403, "Only administrators may link additional Objectives");
    for (const id of definition.objectiveIds ?? []) yield* this.owner(tx, id);
    if (definition.parentTeamId)
      yield* lockTeamAncestors(tx, this.tables.teams, definition.parentTeamId);
    const parent = yield* this.parent(tx, definition.parentTeamId, definition.objectiveId);
    const orgArchitect = source?.roleAuthority?.systemKey === ORG_ARCHITECT_ROLE_KEY;
    if (
      actorTagId !== undefined &&
      actorTagId !== owner &&
      actorTagId !== parent?.leadTagId &&
      !orgArchitect
    )
      throw new TagMessagingError(
        403,
        "Only the Objective owner or parent Team lead may create a Team",
      );
    const members = yield* this.validateMembers(tx, definition.leadTagId, definition.memberTagIds);
    const team = { ...definition, memberTagIds: members };
    if (parent && this.isLeadership(parent))
      yield* this.staffed(tx, team, [owner, ...parent.memberTagIds]);
    else if (parent) this.bounded(team, parent);
    if (parent) {
      if ((definition.objectiveIds ?? []).some((id) => !teamSupportsObjective(parent, id)))
        throw new TagMessagingError(403, "Child Objectives must remain within parent Team links");
    }
    const at = new Date().toISOString();
    const row = {
      ...definition,
      maxConcurrency: definition.maxConcurrency ?? null,
      objectiveIds: definition.objectiveIds ?? [],
      context: {},
      scaling: definition.scaling ?? {},
      parentTeamId: definition.parentTeamId ?? null,
      memberTagIds: members,
      status: "active",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    const t = this.tables.teams;
    const [prior] = yield tx.select().from(t).where(eq(t.id, definition.id)).limit(1);
    if (prior) {
      assertSameTeamDefinition(prior, row);
      return prior;
    }
    validateTeamScaling(yield tx.select(teamScalingColumns(t)).from(t), row as Team);
    const created = yield tx
      .insert(t)
      .values(row)
      .onConflictDoNothing({ target: t.id })
      .returning();
    if (created[0]) {
      const team = created[0] as Team;
      // The Team's channel shares its ID and reads everything else from the Team.
      yield tx
        .insert(this.tables.workstreams)
        .values({ id: team.id, createdAt: at })
        .onConflictDoNothing({ target: this.tables.workstreams.id })
        .returning();
      yield* appendResourceChange(tx, this.tables, {
        resourceType: "team",
        resourceId: team.id,
        fromRevision: 0,
        toRevision: team.revision,
        actorTagId: actorTagId ?? null,
        operatorId: source?.operatorId ?? null,
        sourceTaskId: source?.sourceTaskId ?? null,
        sourceMessageId: source?.sourceMessageId ?? null,
        changes: resourceChangeDelta(
          null,
          team as unknown as Readonly<Record<string, unknown>>,
          TEAM_CHANGE_FIELDS,
        ),
        createdAt: at,
      });
      return team;
    }
    const existing = yield* this.get(tx, definition.id);
    assertSameTeamDefinition(existing, row);
    return existing;
  }
  private *get(tx: any, id: string, viewerTagId?: string): Generator<any, Team, any> {
    const t = this.tables.teams;
    const row = (yield tx
      .select()
      .from(t)
      .where(eq(t.id, mailboxText(id, "teamId")))
      .limit(1))[0] as Team | undefined;
    if (!row) throw new TagMessagingError(404, "Team not found");
    if (viewerTagId !== undefined) {
      yield* this.activeTag(tx, viewerTagId);
      if (
        !row.memberTagIds.includes(viewerTagId) &&
        (yield* this.owner(tx, row.objectiveId)) !== viewerTagId
      ) {
        const parent = row.parentTeamId ? yield* this.get(tx, row.parentTeamId) : undefined;
        if (parent?.leadTagId !== viewerTagId) throw new TagMessagingError(404, "Team not found");
      }
    }
    return row;
  }
  private *list(
    tx: any,
    objectiveId: string,
    viewerTagId?: string,
  ): Generator<any, readonly Team[], any> {
    const owner = yield* this.owner(tx, mailboxText(objectiveId, "objectiveId"));
    if (viewerTagId !== undefined) yield* this.activeTag(tx, viewerTagId);
    const t = this.tables.teams;
    const rows = ((yield tx.select().from(t)) as Team[]).filter((team) =>
      teamSupportsObjective(team, objectiveId),
    );
    if (viewerTagId === undefined || viewerTagId === owner) return rows;
    const led = new Set(rows.filter((row) => row.leadTagId === viewerTagId).map((row) => row.id));
    return rows.filter(
      (row) =>
        row.memberTagIds.includes(viewerTagId) ||
        (row.parentTeamId !== null && led.has(row.parentTeamId)),
    );
  }
  private *update(
    tx: any,
    id: string,
    input: Parameters<TeamStore["updateTeam"]>[1],
    actorTagId?: string,
    source?: Parameters<TeamStore["updateTeam"]>[3],
  ): Generator<any, Team, any> {
    const { expectedRevision, ...changes } = parseUpdateTeam(input);
    const initial = yield* this.get(tx, id, actorTagId);
    for (const objectiveId of [...new Set([initial.objectiveId, changes.objectiveId])]
      .filter((value): value is string => value !== undefined)
      .sort())
      yield* this.lock(tx, objectiveId);
    yield* lockTeamAncestors(tx, this.tables.teams, id);
    const prior = yield* this.get(tx, id, actorTagId);
    if (changes.objectiveIds !== undefined) {
      if (actorTagId !== undefined)
        throw new TagMessagingError(403, "Only administrators may link additional Objectives");
      for (const objectiveId of changes.objectiveIds) yield* this.owner(tx, objectiveId);
    }
    const owner = yield* this.owner(tx, prior.objectiveId);
    if (changes.objectiveId !== undefined && changes.objectiveId !== prior.objectiveId) {
      if (actorTagId !== undefined && actorTagId !== owner)
        throw new TagMessagingError(403, "Only the governing Objective owner may transfer a Team");
      if (!prior.objectiveIds.includes(changes.objectiveId))
        throw new TagMessagingError(409, "Team governance can move only to a linked Objective");
      yield* this.owner(tx, changes.objectiveId);
    }
    const parent = yield* this.parent(tx, prior.parentTeamId, prior.objectiveId);
    if (
      actorTagId !== undefined &&
      actorTagId !== owner &&
      actorTagId !== prior.leadTagId &&
      actorTagId !== parent?.leadTagId
    )
      throw new TagMessagingError(
        403,
        "Only an authorized lead or Objective owner may update a Team",
      );
    if (prior.status === "dissolved")
      throw new TagMessagingError(409, "Dissolved Teams cannot be changed");
    const nextObjectiveIds =
      changes.objectiveId !== undefined && changes.objectiveId !== prior.objectiveId
        ? [
            ...new Set([
              prior.objectiveId,
              ...(changes.objectiveIds ?? prior.objectiveIds).filter(
                (objectiveId) => objectiveId !== changes.objectiveId,
              ),
            ]),
          ].sort()
        : (changes.objectiveIds ?? prior.objectiveIds);
    const next = {
      ...prior,
      ...changes,
      objectiveIds: nextObjectiveIds,
      scaling: { ...prior.scaling, ...changes.scaling },
      memberTagIds: yield* this.validateMembers(
        tx,
        changes.leadTagId ?? prior.leadTagId,
        changes.memberTagIds ?? prior.memberTagIds,
      ),
    };
    if (parent && this.isLeadership(parent))
      yield* this.staffed(tx, next, [owner, ...parent.memberTagIds, ...prior.memberTagIds]);
    else if (parent) this.bounded(next, parent);
    if (parent) {
      if ([next.objectiveId, ...next.objectiveIds].some((id) => !teamSupportsObjective(parent, id)))
        throw new TagMessagingError(403, "Child Objectives must remain within parent Team links");
    }
    if (actorTagId !== undefined && actorTagId !== owner && actorTagId !== parent?.leadTagId) {
      this.bounded(next, prior);
      this.throttled(next, prior);
    }
    const tree = (yield tx.select().from(this.tables.teams)) as Team[];
    validateTeamScaling(tree, next);
    const children = tree.filter((row) => row.parentTeamId === id && row.status === "active");
    if (next.status === "dissolved" && children.length)
      throw new TagMessagingError(409, "Dissolve or transfer active subteams first");
    if (next.status === "dissolved") {
      const waiting = (yield tx.select().from(this.tables.taskAssignments)) as any[];
      if (
        waiting.some(
          (task) =>
            task.status === "waiting" && task.waitState?.workstreamPosts?.workstreamId === id,
        )
      )
        throw new TagMessagingError(
          409,
          `Workstream ${id} has waiting Tasks; clear their waits before dissolving the Team`,
        );
      const objectives = yield tx.select().from(this.tables.objectives);
      const observing = objectives.find(
        (objective: any) =>
          !objectiveClosed(objective.status) &&
          objective.observations?.some((source: any) => source.workstreamId === id),
      );
      if (observing)
        throw new TagMessagingError(
          409,
          `Observation source ${id} cannot be dissolved while Objective ${observing.id} observes it`,
        );
    }
    for (const child of children) {
      // The Leadership Team delegates staffing, not its own membership; see staffed().
      if (!this.isLeadership(next)) this.bounded(child, next);
      if ([child.objectiveId, ...child.objectiveIds].some((id) => !teamSupportsObjective(next, id)))
        throw new TagMessagingError(403, "Parent must retain active child Objective links");
    }
    const q = this.tables.taskAssignments;
    const assignments = yield tx.select().from(q).where(eq(q.teamId, id));
    const unfinished = assignments.filter((task: any) =>
      ["queued", "running", "waiting", "submitted"].includes(task.status),
    );
    if (
      unfinished.some(
        (task: any) =>
          next.status === "dissolved" ||
          !next.memberTagIds.includes(task.assignedTagId) ||
          !teamSupportsObjective(next, task.objectiveId) ||
          (next.leadTagId !== prior.leadTagId && task.sourceMessageId),
      )
    )
      throw new TagMessagingError(
        409,
        "Close or transfer unfinished Tasks before removing their responsible Team or Tag",
      );
    const m = this.tables.tagMessages;
    // Revoke pending and claimed deliveries in the Team update, including Objective link and
    // governance changes. Re-adding membership or relinking an Objective cannot revive them.
    const belongs = (tagId: string, team: Team) =>
      team.leadTagId === tagId || team.memberTagIds.includes(tagId);
    const outstandingDirect = yield tx
      .select()
      .from(m)
      .where(and(eq(m.directTeamId, id), inArray(m.status, ["pending", "processing"])));
    const discarded = outstandingDirect.filter(
      (message: any) =>
        next.status !== "active" ||
        !teamSupportsObjective(next, message.objectiveId) ||
        !belongs(message.senderTagId, next) ||
        !belongs(message.recipientTagId, next),
    );
    if (discarded.length)
      yield tx
        .update(m)
        .set({
          status: "failed",
          updatedAt: new Date().toISOString(),
          leaseToken: null,
          leaseCredentialId: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            inArray(
              m.id,
              discarded.map((message: any) => message.id),
            ),
            inArray(m.status, ["pending", "processing"]),
          ),
        )
        .returning();
    const pendingMessages = yield tx
      .select()
      .from(m)
      .where(and(eq(m.recipientTeamId, id), eq(m.status, "pending")));
    if (
      pendingMessages.some(
        (message: any) =>
          next.status === "dissolved" || !teamSupportsObjective(next, message.objectiveId),
      )
    )
      throw new TagMessagingError(
        409,
        "Resolve pending Team messages before removing their Objective or dissolving the Team",
      );
    // Unadmitted Team messages follow the stable Team address on leadership changes.
    if (next.leadTagId !== prior.leadTagId) {
      const tags = this.tables.tags;
      const recipient = tx.select().from(tags).where(eq(tags.id, next.leadTagId));
      yield this.provider === "postgresql" ? recipient.for("no key update") : recipient;
      const outstanding = yield tx.select().from(m).where(eq(m.recipientTagId, next.leadTagId));
      const pending = outstanding.filter((message: any) =>
        ["pending", "processing"].includes(message.status),
      ).length;
      const transferring = pendingMessages.filter(
        (message: any) => message.recipientTagId !== next.leadTagId,
      ).length;
      if (pending + transferring > TAG_MAILBOX_MAX_OUTSTANDING)
        throw new TagMessagingError(429, "New lead mailbox cannot hold the pending Team messages");
      yield tx
        .update(m)
        .set({ recipientTagId: next.leadTagId })
        .where(
          and(
            eq(m.recipientTeamId, id),
            eq(m.status, "pending"),
            sql`not exists (select 1 from "TaskAssignment" q where q."sourceMessageId" = ${m.id})`,
          ),
        )
        .returning();
    }
    const t = this.tables.teams;
    const updated = yield tx
      .update(t)
      .set({
        ...changes,
        objectiveIds: next.objectiveIds,
        scaling: next.scaling,
        memberTagIds: next.memberTagIds,
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(t.id, id), eq(t.revision, expectedRevision)))
      .returning();
    if (!updated[0])
      throw new TagMessagingError(409, "Team revision changed; reload before updating");
    const team = updated[0] as Team;
    yield* appendResourceChange(tx, this.tables, {
      resourceType: "team",
      resourceId: team.id,
      fromRevision: prior.revision,
      toRevision: team.revision,
      actorTagId: actorTagId ?? null,
      operatorId: source?.operatorId ?? null,
      sourceTaskId: source?.sourceTaskId ?? null,
      sourceMessageId: source?.sourceMessageId ?? null,
      changes: resourceChangeDelta(
        prior as unknown as Readonly<Record<string, unknown>>,
        team as unknown as Readonly<Record<string, unknown>>,
        TEAM_CHANGE_FIELDS,
      ),
    });
    return team;
  }
  createTeam(...args: Parameters<TeamStore["createTeam"]>): Promise<Team> {
    return this.transaction((tx) => this.create(tx, ...args));
  }
  getTeam(id: string, viewerTagId?: string): Promise<Team> {
    return this.transaction((tx) => this.get(tx, id, viewerTagId));
  }
  listTeams(objectiveId: string, viewerTagId?: string): Promise<readonly Team[]> {
    return this.transaction((tx) => this.list(tx, objectiveId, viewerTagId));
  }
  updateTeam(...args: Parameters<TeamStore["updateTeam"]>): Promise<Team> {
    return this.transaction((tx) => this.update(tx, ...args));
  }
}

/** Only topology and scaling metadata are needed to validate the connected tree. */
function teamScalingColumns(table: any) {
  return {
    id: table.id,
    parentTeamId: table.parentTeamId,
    status: table.status,
    scaling: table.scaling,
  };
}

function assertSameTeamDefinition(existing: Team, row: any): void {
  if (
    JSON.stringify(existing.objectiveIds) !== JSON.stringify(row.objectiveIds) ||
    JSON.stringify(existing.context) !== JSON.stringify(row.context) ||
    existing.objectiveId !== row.objectiveId ||
    existing.name !== row.name ||
    existing.leadTagId !== row.leadTagId ||
    existing.parentTeamId !== row.parentTeamId ||
    existing.maxConcurrency !== row.maxConcurrency ||
    existing.scaling.maxBreadth !== row.scaling.maxBreadth ||
    existing.scaling.maxDepth !== row.scaling.maxDepth ||
    JSON.stringify(existing.memberTagIds) !== JSON.stringify(row.memberTagIds)
  )
    throw new TagMessagingError(409, "Team ID already exists with a different definition");
}
