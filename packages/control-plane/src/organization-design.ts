import { createHash } from "node:crypto";
import {
  type Objective,
  ORG_ARCHITECT_ROLE_KEY,
  type Role,
  type RoleAssignment,
  type Store,
  TagMessagingError,
  type TaskAssignment,
  type Team,
} from "@supertag/core";

export type OrganizationDesignOperation = "create_tag" | "create_team";

interface OrgArchitectRoute {
  readonly role: Role;
  readonly assignment: RoleAssignment;
  readonly recipientTagId: string;
}

type OrganizationDesignPersistence = Pick<
  Store,
  | "enqueueTagMessage"
  | "findRoleBySystemKey"
  | "findTagById"
  | "listRoleAssignments"
  | "listTagMessagingGrants"
  | "listTaskAssignments"
  | "listTeams"
>;

/** Routes organization changes to the Role holder positioned to review them. */
export class OrganizationDesignRouter {
  constructor(private readonly store: OrganizationDesignPersistence) {}

  async requestIfConfigured(input: {
    readonly objective: Objective;
    readonly caller: TaskAssignment;
    readonly operation: OrganizationDesignOperation;
    readonly request: Readonly<Record<string, unknown>>;
    readonly parentTeamId?: string;
  }) {
    const route = await this.resolveRoute(input.objective, input.parentTeamId);
    if (!route) return undefined;
    const [grants, teams] = await Promise.all([
      this.store.listTagMessagingGrants(input.caller.assignedTagId),
      this.store.listTeams(input.caller.objectiveId),
    ]);
    const sameTeam = teams.some(
      (team) =>
        team.status === "active" &&
        (team.leadTagId === input.caller.assignedTagId ||
          team.memberTagIds.includes(input.caller.assignedTagId)) &&
        (team.leadTagId === route.recipientTagId ||
          team.memberTagIds.includes(route.recipientTagId)),
    );
    const allows = (senderTagId: string, recipientTagId: string) =>
      grants.some(
        (grant) =>
          grant.senderTagId === senderTagId &&
          grant.recipientTagId === recipientTagId &&
          grant.messageTypes.includes("message"),
      );
    if (
      !sameTeam &&
      (!allows(input.caller.assignedTagId, route.recipientTagId) ||
        !allows(route.recipientTagId, input.caller.assignedTagId))
    )
      throw new TagMessagingError(
        409,
        "Org Architect review requires message grants from the manager to the architect and back",
      );

    const idempotencyKey = `organization-design:${createHash("sha256")
      .update(
        JSON.stringify({
          taskId: input.caller.taskId,
          action: input.operation,
          input: input.request,
          recipientTagId: route.recipientTagId,
          roleId: route.role.id,
          roleRevision: route.role.revision,
          assignmentId: route.assignment.id,
          assignmentRevision: route.assignment.revision,
        }),
      )
      .digest("hex")}`;
    const queued = await this.store.enqueueTagMessage(
      {
        senderTagId: input.caller.assignedTagId,
        recipientTagId: route.recipientTagId,
        objectiveId: input.caller.objectiveId,
        type: "message",
        body: { action: input.operation, input: input.request },
        idempotencyKey,
      },
      { forceTaskDelivery: true },
    );
    return {
      status: "pending" as const,
      message: queued.message,
      duplicate: queued.duplicate,
    };
  }

  private async resolveRoute(
    objective: Objective,
    parentTeamId?: string,
  ): Promise<OrgArchitectRoute | undefined> {
    const role = await this.store.findRoleBySystemKey(ORG_ARCHITECT_ROLE_KEY);
    if (role?.status !== "active") return undefined;
    const assignments = await this.store.listRoleAssignments({
      roleId: role.id,
      status: "active",
    });
    if (assignments.length === 0) return undefined;

    const teams = (await this.store.listTeams(objective.id)).filter(
      (team) => team.status === "active",
    );
    const teamById = new Map(teams.map((team) => [team.id, team]));
    const nearby = parentTeamId
      ? firstArchitectsInTeamLineage(assignments, teamById, parentTeamId)
      : [];
    const objectiveArchitects = assignments.filter(
      (assignment) =>
        assignment.tagId === objective.ownerTagId ||
        teams.some((team) => team.memberTagIds.includes(assignment.tagId)),
    );
    const candidates = nearby.length > 0 ? nearby : objectiveArchitects;
    if (candidates.length === 0) return undefined;

    const tasks = await this.store.listTaskAssignments(objective.id);
    const available = (
      await Promise.all(
        candidates.map(async (assignment): Promise<OrgArchitectRoute | undefined> => {
          const tag = await this.store.findTagById(assignment.tagId);
          const teamsForTag = teams.filter((team) => team.memberTagIds.includes(assignment.tagId));
          const hasPriorTask = tasks.some(
            (task) =>
              task.assignedTagId === assignment.tagId &&
              teamsForTag.some((team) => team.id === task.teamId),
          );
          const hasMailboxPath =
            teamsForTag.length === 1 || hasPriorTask || assignment.tagId === objective.ownerTagId;
          return tag?.status === "active" && hasMailboxPath
            ? { role, assignment, recipientTagId: assignment.tagId }
            : undefined;
        }),
      )
    ).filter((route): route is OrgArchitectRoute => route !== undefined);

    if (available.length === 0)
      throw new TagMessagingError(
        409,
        "The Org Architect must have an active mailbox execution path in this Objective",
      );
    if (available.length > 1)
      throw new TagMessagingError(
        409,
        "More than one Org Architect is positioned to review this request",
      );
    return available[0];
  }
}

function firstArchitectsInTeamLineage(
  assignments: readonly RoleAssignment[],
  teamById: ReadonlyMap<string, Team>,
  teamId: string,
): readonly RoleAssignment[] {
  const visited = new Set<string>();
  let current = teamById.get(teamId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const members = new Set(current.memberTagIds);
    const architects = assignments.filter((assignment) => members.has(assignment.tagId));
    if (architects.length > 0) return architects;
    current = current.parentTeamId ? teamById.get(current.parentTeamId) : undefined;
  }
  return [];
}
