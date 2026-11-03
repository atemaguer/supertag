// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import type { Team, Workstream } from "@supertag/core";
import { eq, inArray } from "drizzle-orm";

/**
 * A Team's channel with the Team it belongs to and the owners of the Objectives the Team
 * serves: its governing Objective and every linked Objective.
 */
export interface TeamChannel {
  readonly workstream: Workstream;
  readonly team: Team;
  readonly objectiveOwnerTagIds: readonly string[];
  /** The owner of each Objective the Team serves, by Objective ID. */
  readonly objectiveOwners: Readonly<Record<string, string>>;
}

/** The channel's public shape, read from its Team at the time of the read. */
export function teamChannelView(team: Team, createdAt: string): Workstream {
  return {
    id: team.id,
    objectiveId: team.objectiveId,
    title: team.name,
    ownerTagId: team.leadTagId,
    participantTagIds: [...team.memberTagIds].sort(),
    createdAt,
    updatedAt: team.updatedAt,
  };
}

/** Yields queries for the caller's transaction; a missing channel returns undefined. */
export function* loadTeamChannel(
  tx: any,
  tables: any,
  id: string,
): Generator<any, TeamChannel | undefined, any> {
  const w = tables.workstreams,
    t = tables.teams,
    o = tables.objectives;
  const [row] = yield tx
    .select({ createdAt: w.createdAt, team: t })
    .from(w)
    .innerJoin(t, eq(t.id, w.id))
    .where(eq(w.id, id))
    .limit(1);
  if (!row) return undefined;
  const team = row.team as Team;
  const served = [...new Set([team.objectiveId, ...(team.objectiveIds ?? [])])];
  const owners: { id: string; ownerTagId: string }[] = yield tx
    .select({ id: o.id, ownerTagId: o.ownerTagId })
    .from(o)
    .where(inArray(o.id, served));
  return {
    team,
    objectiveOwnerTagIds: [...new Set(owners.map((owner) => owner.ownerTagId))],
    objectiveOwners: Object.fromEntries(owners.map((owner) => [owner.id, owner.ownerTagId])),
    workstream: teamChannelView(row.team as Team, row.createdAt),
  };
}

/**
 * Team members read their channel, and so does the owner of any Objective the Team serves
 * (its governing Objective or a linked one). Within one Objective, only members and that
 * Objective's owner read it, and only if the Team serves that Objective.
 */
export function mayReadTeamChannel(
  channel: TeamChannel,
  tagId: string,
  objectiveId?: string,
): boolean {
  if (objectiveId !== undefined)
    return (
      channel.objectiveOwners[objectiveId] !== undefined &&
      (channel.team.memberTagIds.includes(tagId) || channel.objectiveOwners[objectiveId] === tagId)
    );
  return channel.team.memberTagIds.includes(tagId) || channel.objectiveOwnerTagIds.includes(tagId);
}

/**
 * The Objectives whose posts the Tag reads in the channel: every Objective the Team serves for a
 * member, or the served Objectives it owns for anyone else. A post written under an Objective
 * the Team no longer serves is read by no Tag.
 */
export function readableChannelObjectives(channel: TeamChannel, tagId: string): string[] {
  const member = channel.team.memberTagIds.includes(tagId);
  return Object.entries(channel.objectiveOwners)
    .filter(([, ownerTagId]) => member || ownerTagId === tagId)
    .map(([objectiveId]) => objectiveId)
    .sort();
}

/** Only members of an active Team post to its channel. */
export function mayPostTeamChannel(channel: TeamChannel, tagId: string): boolean {
  return channel.team.status === "active" && channel.team.memberTagIds.includes(tagId);
}
