// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import {
  type DatabaseProvider,
  mailboxText,
  parseCreateTeam,
  parseUpdateTeam,
  TagMessagingError,
  type Team,
  type TeamStore,
  type UpdateTeamInput,
} from "@supertag/core";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";
import { resourceChangeDelta } from "./resource-change.js";
import { appendResourceChange, lastResourceRevision } from "./resource-change-store.js";

const TEAM_CHANGE_FIELDS = ["maxConcurrency", "memberTagIds", "name"] as const;

/** True when the Team row's `memberTagIds` JSON array contains the Tag. */
export function teamHasMember(provider: DatabaseProvider, memberTagIds: any, tagId: any): any {
  return provider === "sqlite"
    ? sql`exists (select 1 from json_each(${memberTagIds}) where value = ${tagId})`
    : sql`${memberTagIds} @> jsonb_build_array(${tagId}::text)`;
}

export class DrizzleTeamStore implements TeamStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}
  private transaction<T>(work: (tx: any) => Generator<any, T, any>): Promise<T> {
    return runDialectTransaction(this.db, this.provider, work);
  }
  /** Every member must be an active Tag; locks them so none retires meanwhile. */
  private *activeMembers(tx: any, members: readonly string[]): Generator<any, void, any> {
    if (members.length === 0) return;
    const t = this.tables.tags;
    const rows = (yield tx
      .update(t)
      .set({ updatedAt: sql`${t.updatedAt}` })
      .where(and(inArray(t.id, [...members]), eq(t.status, "active")))
      .returning({ id: t.id })) as { id: string }[];
    const active = new Set(rows.map((row) => row.id));
    const missing = members.filter((id) => !active.has(id));
    if (missing.length > 0)
      throw new TagMessagingError(
        404,
        `Active Tag${missing.length === 1 ? "" : "s"} not found: ${missing.join(", ")}`,
      );
  }
  private *nameFree(tx: any, name: string, id: string): Generator<any, void, any> {
    const t = this.tables.teams;
    const [taken] = yield tx
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.name, name), sql`${t.id} <> ${id}`))
      .limit(1);
    if (taken) throw new TagMessagingError(409, `Team name ${name} is already in use`);
  }
  private *create(
    tx: any,
    input: Parameters<TeamStore["createTeam"]>[0],
  ): Generator<any, Team, any> {
    const definition = parseCreateTeam(input);
    const t = this.tables.teams;
    const row = {
      id: definition.id,
      name: definition.name,
      memberTagIds: [...definition.memberTagIds],
      maxConcurrency: definition.maxConcurrency ?? null,
    };
    const [prior] = yield tx.select().from(t).where(eq(t.id, definition.id)).limit(1);
    if (prior) {
      if (
        prior.name !== row.name ||
        prior.maxConcurrency !== row.maxConcurrency ||
        JSON.stringify(prior.memberTagIds) !== JSON.stringify(row.memberTagIds)
      )
        throw new TagMessagingError(409, "Team ID already exists with a different definition");
      return teamFromRow(prior);
    }
    yield* this.activeMembers(tx, row.memberTagIds);
    yield* this.nameFree(tx, row.name, row.id);
    const at = new Date().toISOString();
    const [created] = yield tx
      .insert(t)
      .values({ ...row, revision: 1, createdAt: at, updatedAt: at })
      .onConflictDoNothing()
      .returning();
    if (!created) throw new TagMessagingError(409, "Team ID or name is already in use");
    // Claim the ID before reading its history so a concurrent deletion cannot advance it
    // between the history read and insertion. The initial revision stays inside this transaction.
    const revision = (yield* lastResourceRevision(tx, this.tables, "team", row.id)) + 1;
    if (revision !== 1) {
      yield tx.update(t).set({ revision }).where(eq(t.id, row.id)).returning();
    }
    const team = teamFromRow({ ...created, revision });
    yield* appendResourceChange(tx, this.tables, {
      resourceType: "team",
      resourceId: team.id,
      fromRevision: 0,
      toRevision: team.revision,
      actorTagId: null,
      operatorId: null,
      sourceTaskId: null,
      changes: resourceChangeDelta(
        null,
        team as unknown as Readonly<Record<string, unknown>>,
        TEAM_CHANGE_FIELDS,
      ),
      createdAt: at,
    });
    return team;
  }
  private *update(
    tx: any,
    id: string,
    input: Parameters<TeamStore["updateTeam"]>[1],
  ): Generator<any, Team, any> {
    const { expectedRevision, ...changes } = parseUpdateTeam(input);
    const t = this.tables.teams;
    const [prior] = yield tx
      .select()
      .from(t)
      .where(eq(t.id, mailboxText(id, "teamId")))
      .limit(1);
    if (!prior) throw new TagMessagingError(404, "Team not found");
    if (prior.revision !== expectedRevision) {
      // A retry of a change that holds already, such as one whose reply was lost, returns the Team.
      if (prior.revision > expectedRevision && teamHolds(teamFromRow(prior), changes))
        return teamFromRow(prior);
      throw new TagMessagingError(409, "Team revision changed; reload before updating");
    }
    if (changes.memberTagIds !== undefined) {
      const known = new Set<string>(prior.memberTagIds);
      yield* this.activeMembers(
        tx,
        changes.memberTagIds.filter((member) => !known.has(member)),
      );
    }
    if (changes.name !== undefined) yield* this.nameFree(tx, changes.name, id);
    const [updated] = yield tx
      .update(t)
      .set({
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.memberTagIds === undefined ? {} : { memberTagIds: [...changes.memberTagIds] }),
        ...(changes.maxConcurrency === undefined ? {} : { maxConcurrency: changes.maxConcurrency }),
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(t.id, id), eq(t.revision, expectedRevision)))
      .returning();
    if (!updated) throw new TagMessagingError(409, "Team revision changed; reload before updating");
    const team = teamFromRow(updated);
    yield* appendResourceChange(tx, this.tables, {
      resourceType: "team",
      resourceId: team.id,
      fromRevision: prior.revision,
      toRevision: team.revision,
      actorTagId: null,
      operatorId: null,
      sourceTaskId: null,
      changes: resourceChangeDelta(
        teamFromRow(prior) as unknown as Readonly<Record<string, unknown>>,
        team as unknown as Readonly<Record<string, unknown>>,
        TEAM_CHANGE_FIELDS,
      ),
    });
    return team;
  }
  private *delete(tx: any, id: string): Generator<any, boolean, any> {
    const t = this.tables.teams,
      o = this.tables.objectives,
      p = this.tables.workstreamPosts,
      m = this.tables.tagMessages;
    const [team] = yield tx
      .update(t)
      .set({ updatedAt: sql`${t.updatedAt}` })
      .where(eq(t.id, mailboxText(id, "teamId")))
      .returning();
    if (!team) return false;
    const [open] = yield tx
      .select({ id: o.id })
      .from(o)
      .where(and(eq(o.teamId, id), notInArray(o.status, ["completed", "cancelled"])))
      .orderBy(asc(o.createdAt), asc(o.id))
      .limit(1);
    if (open)
      throw new TagMessagingError(
        409,
        `Team ${team.name} cannot be deleted while Objective ${open.id} names it; complete or cancel the Objective first`,
      );
    // Closed Objectives keep their history without the Team.
    yield tx.update(o).set({ teamId: null }).where(eq(o.teamId, id)).returning();
    yield tx
      .update(m)
      .set({ workstreamPostId: null })
      .where(sql`${m.workstreamPostId} in (select ${p.id} from ${p} where ${p.teamId} = ${id})`)
      .returning();
    yield tx.delete(p).where(eq(p.teamId, id)).returning();
    yield tx.delete(t).where(eq(t.id, id)).returning();
    yield* appendResourceChange(tx, this.tables, {
      resourceType: "team",
      resourceId: id,
      fromRevision: team.revision,
      toRevision: team.revision + 1,
      actorTagId: null,
      operatorId: null,
      sourceTaskId: null,
      changes: resourceChangeDelta(
        teamFromRow(team) as unknown as Readonly<Record<string, unknown>>,
        {},
        TEAM_CHANGE_FIELDS,
      ),
    });
    return true;
  }
  createTeam(input: Parameters<TeamStore["createTeam"]>[0]): Promise<Team> {
    return this.transaction((tx) => this.create(tx, input));
  }
  async getTeam(id: string): Promise<Team | undefined> {
    const t = this.tables.teams;
    const [row] = await this.db
      .select()
      .from(t)
      .where(eq(t.id, mailboxText(id, "teamId")))
      .limit(1);
    return row === undefined ? undefined : teamFromRow(row);
  }
  async listTeams(): Promise<readonly Team[]> {
    const t = this.tables.teams;
    const rows = await this.db.select().from(t).orderBy(asc(t.name), asc(t.id));
    return rows.map(teamFromRow);
  }
  async listTeamsOfTag(tagId: string): Promise<readonly Team[]> {
    const t = this.tables.teams;
    const rows = await this.db
      .select()
      .from(t)
      .where(teamHasMember(this.provider, t.memberTagIds, mailboxText(tagId, "tagId")))
      .orderBy(asc(t.name), asc(t.id));
    return rows.map(teamFromRow);
  }
  updateTeam(id: string, input: Parameters<TeamStore["updateTeam"]>[1]): Promise<Team> {
    return this.transaction((tx) => this.update(tx, id, input));
  }
  deleteTeam(id: string): Promise<boolean> {
    return this.transaction((tx) => this.delete(tx, id));
  }
}

function teamHolds(team: Team, changes: Omit<UpdateTeamInput, "expectedRevision">): boolean {
  const members = (ids: readonly string[]) => [...new Set(ids)].sort().join("\n");
  return (
    (changes.name === undefined || changes.name === team.name) &&
    (changes.memberTagIds === undefined ||
      members(changes.memberTagIds) === members(team.memberTagIds)) &&
    (changes.maxConcurrency === undefined || changes.maxConcurrency === team.maxConcurrency)
  );
}

export function teamFromRow(row: any): Team {
  const members =
    typeof row.memberTagIds === "string" ? JSON.parse(row.memberTagIds) : row.memberTagIds;
  return {
    id: row.id,
    name: row.name,
    memberTagIds: Array.isArray(members) ? members : [],
    maxConcurrency: row.maxConcurrency ?? null,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
