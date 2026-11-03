import type {
  ExecutionSettings,
  Role,
  RoleAssignment,
  Store,
  Tag,
  TagApprovalRequirement,
  TagAuthorizationResource,
  TagContextPlan,
  TagContextPlanSet,
  TagMcpGrant,
  TagPermissionSet,
  TagRoleSnapshot,
} from "@supertag/core";
import {
  ARTIFACT_CONTEXT_TYPE,
  approvalRequirementsFromPermissions,
  executionRange,
  mcpGrantsFromPermissions,
  ORG_ARCHITECT_ROLE_KEY,
} from "@supertag/core";
import {
  objectiveRuntimeActionWarnings,
  resolveObjectiveRuntimeActions,
} from "./objective-runnable.js";

export const ORG_ARCHITECT_ROLE_NAME = "Org Architect";

export async function ensureBuiltInRoles(store: Store): Promise<void> {
  await store.ensureSystemRole({
    systemKey: ORG_ARCHITECT_ROLE_KEY,
    name: ORG_ARCHITECT_ROLE_NAME,
    purpose:
      "Own the organization's structural design and decide when durable Tags and Teams should be created.",
    instructions:
      "Apply the configured organization-design rules to requests for new Teams and Tags. Approve durable structure only when work needs continuing ownership, authority, capacity, shared context, or a stable interface. Prefer a Task or harness-native subagent for temporary work. Workstreams are Team channels only. Record the evidence and policy revision behind each decision, then return a correlated mailbox decision to the requesting manager.",
  });
}

export interface ResolvedTagRoles {
  readonly snapshots: readonly TagRoleSnapshot[];
  readonly contextSetIds: readonly string[];
  readonly permissionSetIds: readonly string[];
  /** Each active Role's execution settings, in Role name order; the first that sets a field wins. */
  readonly execution: readonly (ExecutionSettings | undefined)[];
}

type RoleResolutionStore = Pick<
  Store,
  | "findSurfaceAccountById"
  | "findRoleById"
  | "findTagContextSetById"
  | "findTagPermissionSetById"
  | "listRoleAssignments"
  | "listTagContextItems"
  | "listTagPermissions"
>;

export async function resolveTagRoles(
  store: RoleResolutionStore,
  tagId: string,
): Promise<ResolvedTagRoles> {
  const assignments = await store.listRoleAssignments({ tagId, status: "active" });
  const roles = new Map<string, Role>();
  for (const role of await Promise.all(
    [...new Set(assignments.map((assignment) => assignment.roleId))].map((id) =>
      store.findRoleById(id),
    ),
  ))
    if (role?.status === "active") roles.set(role.id, role);
  const applicable = assignments
    .filter((assignment) => roles.has(assignment.roleId))
    .toSorted(compareAssignments);
  const snapshots = applicable.map((assignment) => {
    const role = roles.get(assignment.roleId);
    if (!role) throw new Error("Applicable Role disappeared during resolution");
    return snapshot(assignment, role);
  });
  return {
    snapshots,
    contextSetIds: uniqueSorted(snapshots.flatMap((entry) => entry.role.contextSetIds)),
    permissionSetIds: uniqueSorted(snapshots.flatMap((entry) => entry.role.permissionSetIds)),
    execution: [...roles.values()]
      .filter((role) => applicable.some((assignment) => assignment.roleId === role.id))
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((role) => role.execution),
  };
}

/**
 * The harness, models, and efforts a Tag's Tasks may use: the Tag's own settings field by field,
 * then its active Roles' in name order. Empty fields mean anything the Worker Host offers.
 */
export async function tagExecutionRange(
  store: RoleResolutionStore,
  tag: Pick<Tag, "id" | "execution">,
  roles?: ResolvedTagRoles,
): Promise<ExecutionSettings> {
  return executionRange(tag.execution, (roles ?? (await resolveTagRoles(store, tag.id))).execution);
}

export interface PermissionBundle {
  readonly permissionSets: readonly {
    readonly id: string;
    readonly name: string;
    readonly approvers?: readonly string[];
  }[];
  readonly resources: readonly TagAuthorizationResource[];
  readonly runtimeActions: readonly string[];
  /** `target: mcp` grants; omitted when none. */
  readonly mcp?: readonly TagMcpGrant[];
  /** `approval: required` grants; omitted when none so older snapshots stay byte-identical. */
  readonly approvals?: readonly TagApprovalRequirement[];
}

/** Resolve exact Permission Set contents for admission; the returned bundle is immutable JSON. */
export async function capturePermissionBundle(
  store: RoleResolutionStore,
  permissionSetIds: readonly string[],
): Promise<PermissionBundle> {
  const sets = (
    await Promise.all(
      uniqueSorted(permissionSetIds).map((id) => store.findTagPermissionSetById(id)),
    )
  )
    .filter((set): set is TagPermissionSet => set !== undefined)
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
  if (sets.length !== new Set(permissionSetIds).size)
    throw new Error("A Role references an unavailable Permission Set");
  const permissions = (
    await Promise.all(sets.map((set) => store.listTagPermissions({ permissionSetId: set.id })))
  ).flat();
  const resources = new Map<string, MutableResource>();
  for (const permission of permissions) {
    if (permission.target !== "surface") continue;
    const account = await store.findSurfaceAccountById(permission.surfaceAccountId);
    if (!account) throw new Error(`Surface account ${permission.surfaceAccountId} is unavailable`);
    const key = `${permission.surfaceAccountId}\0${permission.scope}`;
    const existing = resources.get(key);
    if (existing) {
      existing.actions.add(permission.action);
      if (!existing.reference && permission.reference) existing.reference = permission.reference;
    } else {
      resources.set(key, {
        surfaceAccountId: account.id,
        provider: account.provider,
        scope: permission.scope,
        ...(permission.reference === undefined ? {} : { reference: permission.reference }),
        actions: new Set([permission.action]),
      });
    }
  }
  const approvals = approvalRequirementsFromPermissions(sets, permissions);
  const mcp = mcpGrantsFromPermissions(permissions);
  return {
    permissionSets: sets.map((set) => ({
      id: set.id,
      name: set.name,
      ...(set.approvers?.length ? { approvers: [...set.approvers] } : {}),
    })),
    ...(approvals.length ? { approvals } : {}),
    ...(mcp.length ? { mcp } : {}),
    resources: [...resources.values()]
      .map((resource) => ({
        surfaceAccountId: resource.surfaceAccountId,
        provider: resource.provider,
        scope: resource.scope,
        ...(resource.reference === undefined ? {} : { reference: resource.reference }),
        actions: [...resource.actions].sort(),
        sources: ["permission-set" as const],
      }))
      .toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.surfaceAccountId.localeCompare(right.surfaceAccountId) ||
          left.scope.localeCompare(right.scope),
      ),
    runtimeActions: uniqueSorted(
      permissions
        .filter((permission) => permission.target === "runtime")
        .map((permission) => permission.action),
    ),
  };
}

/**
 * The runtime actions a Tag's Permission Sets allow for internal work: the union across its
 * active Roles. Location activations apply only to work that came from that location, so an
 * Objective created from a thread inherits them through the thread's Task snapshot instead.
 */
export async function tagRuntimeActions(
  store: RoleResolutionStore,
  tagId: string,
): Promise<readonly string[]> {
  const roles = await resolveTagRoles(store, tagId);
  return (await capturePermissionBundle(store, roles.permissionSetIds)).runtimeActions;
}

/**
 * Resolve an operator's Objective runtime actions against the owner Tag's Permission Sets, once,
 * so the result can be frozen into the Objective record. Omitted means everything the owner is
 * allowed; an explicit list is narrowed to it, with a warning naming any dropped action.
 */
export async function resolveOwnerObjectiveRuntimeActions(
  store: RoleResolutionStore & Pick<Store, "findTagById">,
  input: {
    readonly objectiveId: string;
    readonly ownerTagId: string;
    readonly requested?: readonly string[];
  },
): Promise<{ readonly runtimeActions: readonly string[]; readonly warnings: readonly string[] }> {
  const [owner, allowed] = await Promise.all([
    store.findTagById(input.ownerTagId),
    tagRuntimeActions(store, input.ownerTagId),
  ]);
  return {
    runtimeActions: resolveObjectiveRuntimeActions(allowed, input.requested),
    warnings: objectiveRuntimeActionWarnings({
      objectiveId: input.objectiveId,
      owner: { name: owner?.name ?? input.ownerTagId },
      allowed,
      ...(input.requested === undefined ? {} : { requested: input.requested }),
    }),
  };
}

/** Internal Tasks can use static Role context; surface-dependent history must be selected at ingress. */
export async function captureInternalRoleContextPlan(
  store: RoleResolutionStore,
  contextSetIds: readonly string[],
  capturedAt: string,
): Promise<TagContextPlan> {
  const sets = await Promise.all(
    uniqueSorted(contextSetIds).map(async (id): Promise<TagContextPlanSet> => {
      const set = await store.findTagContextSetById(id);
      if (!set) throw new Error("A Role references an unavailable Context Set");
      const items = await store.listTagContextItems({ contextSetId: set.id });
      for (const item of items)
        if (item.type === ARTIFACT_CONTEXT_TYPE)
          throw new Error(
            `Role Context Set ${set.name} selects artifacts by surface and cannot equip an internal Task`,
          );
      return {
        id: set.id,
        name: set.name,
        items: items.map((item) => ({
          id: item.id,
          itemKey: item.itemKey,
          type: item.type,
          version: item.version,
          required: item.required,
          config: item.config,
        })),
      };
    }),
  );
  return {
    version: 7,
    capturedAt,
    sets: sets.toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    ),
  };
}

function snapshot(assignment: RoleAssignment, role: Role): TagRoleSnapshot {
  return {
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    role: {
      id: role.id,
      name: role.name,
      purpose: role.purpose,
      instructions: role.instructions,
      origin: role.origin,
      ...(role.systemKey === undefined ? {} : { systemKey: role.systemKey }),
      revision: role.revision,
      contextSetIds: [...role.contextSetIds],
      permissionSetIds: [...role.permissionSetIds],
    },
  };
}

function compareAssignments(left: RoleAssignment, right: RoleAssignment): number {
  return left.roleId.localeCompare(right.roleId) || left.id.localeCompare(right.id);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

interface MutableResource {
  readonly surfaceAccountId: string;
  readonly provider: TagAuthorizationResource["provider"];
  readonly scope: string;
  reference?: string;
  readonly actions: Set<string>;
}
