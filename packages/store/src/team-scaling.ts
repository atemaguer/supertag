import { resolveTeamScaling, TagMessagingError, type Team } from "@supertag/core";

type ScalingTeam = Pick<Team, "id" | "parentTeamId" | "status" | "scaling">;

/** Validate the proposed physical tree, independent of its linked Objectives. */
export function validateTeamScaling(teams: readonly ScalingTeam[], proposed: ScalingTeam): void {
  const rows = new Map(teams.map((team) => [team.id, team]));
  rows.set(proposed.id, proposed);
  let root = proposed;
  const ancestors = new Set<string>();
  while (root.parentTeamId) {
    if (ancestors.has(root.id)) throw new TagMessagingError(409, "Team hierarchy cycle");
    ancestors.add(root.id);
    const parent = rows.get(root.parentTeamId);
    if (!parent) throw new TagMessagingError(409, "Parent Team is missing");
    root = parent;
  }
  const children = new Map<string, ScalingTeam[]>();
  for (const team of rows.values()) {
    if (team.status !== "active" || !team.parentTeamId) continue;
    const siblings = children.get(team.parentTeamId) ?? [];
    siblings.push(team);
    children.set(team.parentTeamId, siblings);
  }
  const pending = [{ team: root, lineage: [root] }];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop();
    if (current?.team.status !== "active") continue;
    if (visited.has(current.team.id)) throw new TagMessagingError(409, "Team hierarchy cycle");
    visited.add(current.team.id);
    const limits = resolveTeamScaling(current.lineage);
    const direct = children.get(current.team.id) ?? [];
    if (limits.maxBreadth !== undefined && direct.length > limits.maxBreadth)
      throw new TagMessagingError(
        409,
        `Team ${current.team.id} exceeds maxBreadth ${limits.maxBreadth} declared by Team ${limits.maxBreadthTeamId}`,
      );
    if (direct.length && limits.maxDepth !== undefined && limits.maxDepth < 1)
      throw new TagMessagingError(
        409,
        `Team ${current.team.id} exceeds maxDepth declared by Team ${limits.maxDepthTeamId}; remaining depth is ${limits.maxDepth}`,
      );
    for (const child of direct) pending.push({ team: child, lineage: [...current.lineage, child] });
  }
}
