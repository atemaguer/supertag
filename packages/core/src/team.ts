import { mailboxObject, mailboxText, TagMessagingError } from "./mailbox.js";
import type { SystemRoleKey } from "./role.js";

/** Trusted provenance attached to a Team mutation when available. */
interface TeamMutationSource {
  readonly operatorId?: string;
  readonly sourceTaskId?: string;
  readonly sourceMessageId?: string;
  /** Gateway-verified Role authority captured on the calling Task. */
  readonly roleAuthority?: {
    readonly systemKey: SystemRoleKey;
    readonly assignmentId: string;
    readonly assignmentRevision: number;
    readonly roleRevision: number;
  };
}

/** Optional limits inherited by descendant Teams; omission adds no local limit. */
export interface TeamScaling {
  /** Maximum active direct children of this Team and each descendant, limited by ancestor minima. */
  readonly maxBreadth?: number;
  /** Maximum edges below this Team; zero permits no children. */
  readonly maxDepth?: number;
}

export interface CreateTeamInput {
  readonly id: string;
  readonly objectiveId: string;
  /** Additional Objectives approved by an administrator; originating Objective remains governance anchor. */
  readonly objectiveIds?: readonly string[];
  readonly name: string;
  readonly leadTagId: string;
  readonly memberTagIds: readonly string[];
  readonly parentTeamId?: string;
  /**
   * Optional throttle on Task Attempts running at once for this Team's own members. Omit it to
   * leave connected Worker Host capacity as the only limit.
   */
  readonly maxConcurrency?: number;
  readonly scaling?: TeamScaling;
}
export interface Team extends Omit<CreateTeamInput, "parentTeamId" | "maxConcurrency"> {
  readonly objectiveIds: readonly string[];
  /** Null when the Team sets no throttle and host capacity is the only limit. */
  readonly maxConcurrency: number | null;
  readonly scaling: TeamScaling;
  readonly parentTeamId: string | null;
  /** Durable shared context maintained by the Team through ordinary resource updates. */
  readonly context: Readonly<Record<string, unknown>>;
  readonly status: "active" | "dissolved";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface UpdateTeamInput {
  readonly expectedRevision: number;
  /** Transfer governance to an already linked Objective. */
  readonly objectiveId?: string;
  readonly objectiveIds?: readonly string[];
  readonly name?: string;
  readonly leadTagId?: string;
  readonly memberTagIds?: readonly string[];
  /** Set a throttle, or null to remove it. */
  readonly maxConcurrency?: number | null;
  /** Merge supplied limits into the current policy; omitted fields retain their limits. */
  readonly scaling?: TeamScaling;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly status?: "active" | "dissolved";
}
export interface TeamStore {
  /** Omitted actor/viewer is reserved for trusted administrative callers. */
  createTeam(
    input: CreateTeamInput,
    actorTagId?: string,
    source?: TeamMutationSource,
  ): Promise<Team>;
  getTeam(id: string, viewerTagId?: string): Promise<Team>;
  listTeams(objectiveId: string, viewerTagId?: string): Promise<readonly Team[]>;
  updateTeam(
    id: string,
    input: UpdateTeamInput,
    actorTagId?: string,
    source?: TeamMutationSource,
  ): Promise<Team>;
}
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
  if (!Array.isArray(value) || value.length > 100)
    throw new TagMessagingError(400, "memberTagIds must contain at most 100 Tag IDs");
  return [...new Set(value.map((id) => mailboxText(id, "memberTagId")))].sort();
}
function concurrency(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000)
    throw new TagMessagingError(400, "maxConcurrency must be an integer from 1 to 1000");
  return value as number;
}
function scaling(value: unknown): TeamScaling {
  const record = mailboxObject(value, ["maxBreadth", "maxDepth"]);
  const result: { maxBreadth?: number; maxDepth?: number } = {};
  for (const key of ["maxBreadth", "maxDepth"] as const) {
    const limit = record[key];
    if (limit === undefined) continue;
    if (!Number.isSafeInteger(limit) || (limit as number) < 0)
      throw new TagMessagingError(400, `scaling.${key} must be a nonnegative safe integer`);
    result[key] = limit as number;
  }
  return result;
}
export function parseCreateTeam(value: unknown): CreateTeamInput {
  const r = mailboxObject(value, [
    "id",
    "objectiveId",
    "objectiveIds",
    "name",
    "leadTagId",
    "memberTagIds",
    "parentTeamId",
    "maxConcurrency",
    "scaling",
  ]);
  const id = mailboxText(r["id"], "id");
  if (id === "." || id === "..") throw new TagMessagingError(400, "Invalid Team ID");
  return {
    id,
    objectiveId: mailboxText(r["objectiveId"], "objectiveId"),
    objectiveIds: r["objectiveIds"] === undefined ? [] : members(r["objectiveIds"]),
    name: name(r["name"]),
    leadTagId: mailboxText(r["leadTagId"], "leadTagId"),
    memberTagIds: members(r["memberTagIds"]),
    ...(r["parentTeamId"] === undefined
      ? {}
      : { parentTeamId: mailboxText(r["parentTeamId"], "parentTeamId") }),
    ...(r["maxConcurrency"] === undefined || r["maxConcurrency"] === null
      ? {}
      : { maxConcurrency: concurrency(r["maxConcurrency"]) }),
    scaling: r["scaling"] === undefined ? {} : scaling(r["scaling"]),
  };
}
export function parseUpdateTeam(value: unknown): UpdateTeamInput {
  const r = mailboxObject(value, [
    "expectedRevision",
    "objectiveId",
    "objectiveIds",
    "name",
    "leadTagId",
    "memberTagIds",
    "maxConcurrency",
    "scaling",
    "context",
    "status",
  ]);
  if (!Number.isSafeInteger(r["expectedRevision"]) || (r["expectedRevision"] as number) < 1)
    throw new TagMessagingError(400, "A positive expectedRevision is required");
  if (r["status"] !== undefined && r["status"] !== "active" && r["status"] !== "dissolved")
    throw new TagMessagingError(400, "Invalid Team status");
  const context = r["context"];
  if (context !== undefined) {
    if (context === null || typeof context !== "object" || Array.isArray(context))
      throw new TagMessagingError(400, "Team context must be a JSON object");
    let encoded: string;
    try {
      encoded = JSON.stringify(context);
    } catch {
      throw new TagMessagingError(400, "Team context must be JSON serializable");
    }
    if (new TextEncoder().encode(encoded).length > 65_536)
      throw new TagMessagingError(413, "Team context exceeds 64 KiB");
  }
  return {
    expectedRevision: r["expectedRevision"] as number,
    ...(r["objectiveId"] === undefined
      ? {}
      : { objectiveId: mailboxText(r["objectiveId"], "objectiveId") }),
    ...(r["objectiveIds"] === undefined ? {} : { objectiveIds: members(r["objectiveIds"]) }),
    ...(r["name"] === undefined ? {} : { name: name(r["name"]) }),
    ...(r["leadTagId"] === undefined
      ? {}
      : { leadTagId: mailboxText(r["leadTagId"], "leadTagId") }),
    ...(r["memberTagIds"] === undefined ? {} : { memberTagIds: members(r["memberTagIds"]) }),
    ...(r["maxConcurrency"] === undefined
      ? {}
      : {
          maxConcurrency: r["maxConcurrency"] === null ? null : concurrency(r["maxConcurrency"]),
        }),
    ...(r["scaling"] === undefined ? {} : { scaling: scaling(r["scaling"]) }),
    ...(context === undefined
      ? {}
      : { context: JSON.parse(JSON.stringify(context)) as Record<string, unknown> }),
    ...(r["status"] === undefined ? {} : { status: r["status"] as "active" | "dissolved" }),
  };
}

/** The part of a running Task assignment that Team concurrency inspects. */
export interface TeamOccupant {
  readonly teamId: string | null;
  readonly assignedTagId: string;
  readonly status: string;
}

/**
 * Task Attempts that occupy a Team's concurrency: running assignments of this Team held by its
 * current members. Waiting, queued, and finished Tasks hold no slot, and descendant Teams' work
 * counts only against their own Team. The scheduler and Objective overview share this rule.
 */
export function teamRunningCount(
  team: Pick<Team, "id" | "memberTagIds">,
  assignments: readonly TeamOccupant[],
): number {
  return assignments.filter(
    (task) =>
      task.status === "running" &&
      task.teamId === team.id &&
      team.memberTagIds.includes(task.assignedTagId),
  ).length;
}

/** Whether a Team's own throttle has no free slot; a Team without maxConcurrency never fills. */
export function teamConcurrencyFull(
  team: Pick<Team, "id" | "memberTagIds" | "maxConcurrency">,
  assignments: readonly TeamOccupant[],
): boolean {
  return team.maxConcurrency !== null && teamRunningCount(team, assignments) >= team.maxConcurrency;
}

/** The Team each Objective's owner starts in. */
export function leadershipTeamId(objectiveId: string): string {
  return `${objectiveId}:leadership`;
}

/** Linking is explicit; membership alone never grants another Objective. */
export function teamSupportsObjective(
  team: Pick<Team, "objectiveId" | "objectiveIds">,
  objectiveId: string,
): boolean {
  return team.objectiveId === objectiveId || team.objectiveIds.includes(objectiveId);
}

export interface ResolvedTeamScaling extends TeamScaling {
  readonly maxBreadthTeamId?: string;
  readonly maxDepthTeamId?: string;
}

/**
 * Resolve a root-to-target lineage, including the target. Breadth is the smallest
 * inherited limit. Depth is the remaining edge allowance below the target and
 * can be negative when the supplied lineage already exceeds an ancestor limit.
 * Equal limits name the nearest declaring Team. An empty lineage adds no limits.
 */
export function resolveTeamScaling(
  lineage: readonly Pick<Team, "id" | "scaling">[],
): ResolvedTeamScaling {
  let breadth: { limit: number; teamId: string } | undefined;
  let depth: { limit: number; teamId: string } | undefined;
  for (const [index, team] of lineage.entries()) {
    const maxBreadth = team.scaling.maxBreadth;
    if (maxBreadth !== undefined && (breadth === undefined || maxBreadth <= breadth.limit)) {
      breadth = { limit: maxBreadth, teamId: team.id };
    }
    const maxDepth = team.scaling.maxDepth;
    if (maxDepth !== undefined) {
      const remaining = maxDepth - (lineage.length - index - 1);
      if (depth === undefined || remaining <= depth.limit) {
        depth = { limit: remaining, teamId: team.id };
      }
    }
  }
  return {
    ...(breadth === undefined
      ? {}
      : { maxBreadth: breadth.limit, maxBreadthTeamId: breadth.teamId }),
    ...(depth === undefined ? {} : { maxDepth: depth.limit, maxDepthTeamId: depth.teamId }),
  };
}
