import { mailboxObject, mailboxText, TagMessagingError } from "./mailbox.js";

/**
 * A configured set of Tags. Members may message one another and share the Team's Workstream; an
 * Objective that names the Team may start work Sessions of its members. A Team stands alone: any
 * number of Objectives may name it.
 */
export interface Team {
  readonly id: string;
  readonly name: string;
  readonly memberTagIds: readonly string[];
  /**
   * Turns that may run at once across the Sessions of every open Objective naming this Team;
   * later ones wait. Null when only Worker Host capacity limits them.
   */
  readonly maxConcurrency: number | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTeamInput {
  readonly id: string;
  readonly name: string;
  readonly memberTagIds: readonly string[];
  readonly maxConcurrency?: number;
}

export interface UpdateTeamInput {
  readonly expectedRevision: number;
  readonly name?: string;
  readonly memberTagIds?: readonly string[];
  /** Set a limit, or null to remove it. */
  readonly maxConcurrency?: number | null;
}

export interface TeamStore {
  /** Every member must be an active Tag; the name must be unused. */
  createTeam(input: CreateTeamInput): Promise<Team>;
  getTeam(id: string): Promise<Team | undefined>;
  /** Every Team, by name. */
  listTeams(): Promise<readonly Team[]>;
  /** The Teams the Tag is a member of, by name. */
  listTeamsOfTag(tagId: string): Promise<readonly Team[]>;
  /** Refused with 409 when `expectedRevision` is not the current revision. */
  updateTeam(id: string, input: UpdateTeamInput): Promise<Team>;
  /**
   * Deletes the Team and its Workstream posts. Refused with 409 while an Objective that is not
   * completed or cancelled names it. False when no such Team exists.
   */
  deleteTeam(id: string): Promise<boolean>;
}

/** Most members one Team may have. */
export const TEAM_MAX_MEMBERS = 100;

function name(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 200 ||
    /\p{Cc}/u.test(value)
  )
    throw new TagMessagingError(400, "Team name must contain 1–200 characters");
  return value.trim();
}
function members(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > TEAM_MAX_MEMBERS)
    throw new TagMessagingError(
      400,
      `memberTagIds must contain at most ${TEAM_MAX_MEMBERS} Tag IDs`,
    );
  return [...new Set(value.map((id) => mailboxText(id, "memberTagId")))].sort();
}
function concurrency(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000)
    throw new TagMessagingError(400, "maxConcurrency must be an integer from 1 to 1000");
  return value as number;
}

export function parseCreateTeam(value: unknown): CreateTeamInput {
  const r = mailboxObject(value, ["id", "name", "memberTagIds", "maxConcurrency"]);
  const id = mailboxText(r["id"], "id");
  if (id === "." || id === "..") throw new TagMessagingError(400, "Invalid Team ID");
  return {
    id,
    name: name(r["name"]),
    memberTagIds: members(r["memberTagIds"]),
    ...(r["maxConcurrency"] === undefined || r["maxConcurrency"] === null
      ? {}
      : { maxConcurrency: concurrency(r["maxConcurrency"]) }),
  };
}

export function parseUpdateTeam(value: unknown): UpdateTeamInput {
  const r = mailboxObject(value, ["expectedRevision", "name", "memberTagIds", "maxConcurrency"]);
  if (!Number.isSafeInteger(r["expectedRevision"]) || (r["expectedRevision"] as number) < 1)
    throw new TagMessagingError(400, "A positive expectedRevision is required");
  return {
    expectedRevision: r["expectedRevision"] as number,
    ...(r["name"] === undefined ? {} : { name: name(r["name"]) }),
    ...(r["memberTagIds"] === undefined ? {} : { memberTagIds: members(r["memberTagIds"]) }),
    ...(r["maxConcurrency"] === undefined
      ? {}
      : {
          maxConcurrency: r["maxConcurrency"] === null ? null : concurrency(r["maxConcurrency"]),
        }),
  };
}
