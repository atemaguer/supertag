import type {
  GatewayCredentialVault,
  ManagedResourceKind,
  Objective,
  Store,
  SurfaceAccount,
  Tag,
  TagRoute,
  WorkerHost,
} from "@supertag/core";
import { advertisedWorkspaces, authKeyPhase, volumeArtifactCopyRefusal } from "@supertag/core";
import { tagLocationScopeFields } from "./control-plane-resources.js";
import { locationKey } from "./field-management.js";

/**
 * What deleting one resource would do. Deletion never erases history: Tags and Roles retire and
 * keep their rows, and sets and Workspaces lose only configuration, since each Task keeps the
 * policy and workspace recorded when SuperTag accepted it.
 */
export interface DeletionPlan {
  readonly kind: ManagedResourceKind;
  readonly name: string;
  /** Tags, Roles, and Surface Accounts retire; sets and Workspaces are deleted. */
  readonly action: "retire" | "delete";
  /** Everything that still uses the resource. Any entry refuses the deletion. */
  readonly references: readonly string[];
  /** A direct refusal, such as a built-in Role or retained artifact copies. */
  readonly refusal?: string;
  /** Configuration removed along with the resource. */
  readonly removed: readonly string[];
  /** Effects outside the Control Plane's configuration, such as Worker Host declarations. */
  readonly notes: readonly string[];
}

/** The CLI resource name of each kind, as `supertag delete KIND NAME` spells it. */
export const DELETE_KIND_NAMES: Readonly<Record<ManagedResourceKind, string>> = {
  SurfaceAccount: "surface",
  Tag: "tag",
  Role: "role",
  PermissionSet: "permission-set",
  ContextSet: "context-set",
  Volume: "volume",
  Workspace: "workspace",
  Objective: "objective",
};

const OPEN_TASK_LIMIT = 10;

/**
 * Plans deleting one resource from the current state without changing anything. Returns
 * undefined when no such resource exists; retired Tags and Roles count as already gone.
 */
export async function planDeletion(
  store: Store,
  kind: ManagedResourceKind,
  name: string,
  workerHosts?: () => Promise<readonly WorkerHost[]>,
  /** Open Objectives to treat as closed, such as those a prune cancels first. */
  closing: ReadonlySet<string> = new Set(),
): Promise<DeletionPlan | undefined> {
  if (kind === "Objective")
    throw new Error("Objectives are cancelled, not deleted: supertag cancel objective ID");
  const open = async () =>
    (await store.listOpenObjectives()).filter((objective) => !closing.has(objective.id));
  if (kind === "SurfaceAccount") {
    const account = await findSurfaceAccountForDeletion(store, name);
    return account === undefined ? undefined : planSurfaceAccount(store, account);
  }
  const managed = await store.findResourceManagement(kind, name);
  const membership =
    managed?.applySet === undefined ? [] : [`membership in apply set ${managed.applySet}`];
  if (kind === "Tag") {
    const tag = await store.findTagByName(name);
    return tag === undefined ? undefined : planTag(store, tag, membership, await open(), closing);
  }
  if (kind === "Role") {
    const role = await store.findRoleByName(name);
    if (role?.status !== "active") return undefined;
    const sets = await setNames(store);
    const assigned = await tagNames(
      store,
      (await store.listRoleAssignments({ roleId: role.id, status: "active" })).map(
        (assignment) => assignment.tagId,
      ),
    );
    return {
      kind,
      name,
      action: "retire",
      references: assigned.map((tag) => `Tag ${tag}`),
      ...(role.origin === "system" ? { refusal: "is a built-in Role" } : {}),
      removed: [
        ...role.contextSetIds.map((id) => `reference to Context Set ${sets.context.get(id) ?? id}`),
        ...role.permissionSetIds.map(
          (id) => `reference to Permission Set ${sets.permission.get(id) ?? id}`,
        ),
        ...membership,
      ],
      notes: [],
    };
  }
  if (kind === "PermissionSet" || kind === "ContextSet") {
    const permission = kind === "PermissionSet";
    const set = permission
      ? await store.findTagPermissionSetByName(name)
      : await store.findTagContextSetByName(name);
    if (!set) return undefined;
    const roles = (await store.listRoles())
      .filter(
        (role) =>
          role.status === "active" &&
          (permission ? role.permissionSetIds : role.contextSetIds).includes(set.id),
      )
      .map((role) => `Role ${role.name}`)
      .toSorted((left, right) => left.localeCompare(right));
    const routeIds = permission
      ? (await store.listTagPermissionActivations({ permissionSetId: set.id })).map(
          (activation) => activation.tagRouteId,
        )
      : (await store.listTagContextActivations({ contextSetId: set.id })).map(
          (activation) => activation.tagRouteId,
        );
    const routes: TagRoute[] = [];
    for (const routeId of routeIds) {
      const route = await store.findTagRouteById(routeId);
      if (route) routes.push(route);
    }
    const contents = permission
      ? (await store.listTagPermissions({ permissionSetId: set.id })).length
      : (await store.listTagContextItems({ contextSetId: set.id })).length;
    return {
      kind,
      name,
      action: "delete",
      references: [...roles, ...(await tagLocationReferences(store, routes))],
      removed: [
        ...(contents === 0
          ? []
          : [plural(contents, permission ? "permission" : "context item", "its ")]),
        ...membership,
      ],
      notes: [],
    };
  }
  if (kind === "Volume") {
    const volume = await store.findVolumeByName(name);
    if (!volume) return undefined;
    const refusal = volumeArtifactCopyRefusal(await store.countVolumeArtifactCopies(volume.id));
    return {
      kind,
      name,
      action: "delete",
      references: [],
      removed: membership,
      notes: [],
      ...(refusal === undefined ? {} : { refusal }),
    };
  }
  const workspace = await store.findWorkspaceByName(name);
  if (!workspace) return undefined;
  const objectives = (await open())
    .filter((objective) => (objective.workspaces ?? []).includes(name))
    .map((objective) => `Objective ${objective.id} (${objective.status.replaceAll("_", "-")})`);
  const declaring = (workerHosts === undefined ? [] : await workerHosts())
    .filter(
      (host) =>
        host.enrollmentStatus === "active" &&
        advertisedWorkspaces(host.workerSnapshot).includes(name),
    )
    .map((host) => host.id)
    .toSorted((left, right) => left.localeCompare(right));
  return {
    kind,
    name,
    action: "delete",
    references: [
      ...objectives,
      ...(await tagLocationReferences(store, await store.listLocationsReferencingWorkspace(name))),
    ],
    removed: membership,
    notes:
      declaring.length === 0
        ? []
        : [
            `Worker Host ${listText(declaring)} ${declaring.length === 1 ? "declares" : "declare"} workspace ${name}. The checkout stays on the host, and SuperTag stops offering it until a Workspace named ${name} exists again.`,
          ],
  };
}

async function planTag(
  store: Store,
  tag: Tag,
  membership: readonly string[],
  open: readonly Objective[],
  closing: ReadonlySet<string>,
): Promise<DeletionPlan> {
  const references: string[] = [];
  for (const objective of open)
    if (objective.ownerTagId === tag.id) references.push(`Objective ${objective.id} (owner)`);
  const teams = new Set<string>();
  for (const objective of open)
    for (const team of await store.listTeams(objective.id)) {
      if (team.status !== "active" || teams.has(team.id)) continue;
      const role =
        team.leadTagId === tag.id
          ? "lead"
          : team.memberTagIds.includes(tag.id)
            ? "member"
            : undefined;
      if (role === undefined) continue;
      teams.add(team.id);
      references.push(`Team ${team.id} of Objective ${objective.id} (${role})`);
    }
  const listed = [
    ...(await store.listTasks({ tagId: tag.id, status: "running", limit: OPEN_TASK_LIMIT + 1 })),
    ...(await store.listTasks({ tagId: tag.id, status: "pending", limit: OPEN_TASK_LIMIT + 1 })),
  ];
  // Cancelling an Objective cancels its open Tasks, so they no longer hold the Tag.
  const tasks: typeof listed = [];
  for (const task of listed) {
    const objectiveId =
      closing.size === 0 ? undefined : (await store.getTaskAssignment(task.id))?.objectiveId;
    if (objectiveId === undefined || !closing.has(objectiveId)) tasks.push(task);
  }
  for (const task of tasks.slice(0, OPEN_TASK_LIMIT))
    references.push(`Task ${task.id} (${task.status})`);
  // An approver entry by name would pass to a new Tag that reuses the name.
  for (const set of await store.listTagPermissionSets())
    if (
      (set.approvers ?? []).some(
        (entry) => entry === `tag:${tag.name}` || entry === `tag:${tag.id}`,
      )
    )
      references.push(`Permission Set ${set.name} (approver)`);
  if (tasks.length > OPEN_TASK_LIMIT) references.push("more open Tasks");

  const removed: string[] = [];
  const routes = await store.listTagRoutes({ tagId: tag.id });
  const accounts = new Map((await store.listSurfaceAccounts()).map((item) => [item.id, item]));
  const sets = await setNames(store);
  for (const route of routes) {
    const attached = [
      ...(await store.listTagPermissionActivations({ tagRouteId: route.id })).map(
        (activation) =>
          `Permission Set ${sets.permission.get(activation.permissionSetId) ?? activation.permissionSetId}`,
      ),
      ...(await store.listTagContextActivations({ tagRouteId: route.id })).map(
        (activation) =>
          `Context Set ${sets.context.get(activation.contextSetId) ?? activation.contextSetId}`,
      ),
    ];
    removed.push(
      `location ${routeLabel(route, accounts)}${attached.length === 0 ? "" : ` with ${listText(attached)}`}`,
    );
  }
  for (const binding of await store.listTagWorkerHostBindings(tag.id))
    removed.push(`Worker Host ${binding.workerHostId} binding`);
  const roles = new Map((await store.listRoles()).map((role) => [role.id, role.name]));
  for (const assignment of await store.listRoleAssignments({ tagId: tag.id, status: "active" }))
    removed.push(`Role ${roles.get(assignment.roleId) ?? assignment.roleId} assignment`);
  for (const grant of await store.listTagMessagingGrants(tag.id)) {
    if (grant.messageTypes.length === 0) continue;
    removed.push(
      grant.recipientTagId === tag.id
        ? `Mailbox grant from Tag ${await tagName(store, grant.senderTagId)}`
        : `Mailbox grant to Tag ${await tagName(store, grant.recipientTagId)}`,
    );
  }
  removed.push(...membership);
  const authKeys = (await store.listAuthKeys())
    .filter((key) => authKeyPhase(key) === "active" && key.tagIds.includes(tag.id))
    .map((key) => key.name);
  return {
    kind: "Tag",
    name: tag.name,
    action: "retire",
    references,
    removed,
    notes:
      authKeys.length === 0
        ? []
        : [
            `Auth Key ${listText(authKeys)} ${authKeys.length === 1 ? "names" : "name"} this Tag and can no longer join a Worker Host.`,
          ],
  };
}

/**
 * A connected account by manifest name, or by the `provider:externalAccountId` name that
 * `supertag list surface` shows for accounts set up interactively.
 */
export async function findSurfaceAccountForDeletion(
  store: Pick<Store, "findSurfaceAccountByName" | "findSurfaceAccount">,
  name: string,
): Promise<SurfaceAccount | undefined> {
  const named = await store.findSurfaceAccountByName(name);
  if (named !== undefined) return named;
  const separator = name.indexOf(":");
  if (separator <= 0) return undefined;
  const provider = name.slice(0, separator);
  if (!SURFACE_PROVIDERS.includes(provider)) return undefined;
  return store.findSurfaceAccount(
    provider as SurfaceAccount["provider"],
    name.slice(separator + 1),
  );
}

const SURFACE_PROVIDERS: readonly string[] = ["slack", "github", "lark", "linear", "teams"];

/**
 * Retiring an account keeps its delivery history and removes its stored credential. Any Tag
 * location or Permission Set that still names the account refuses the retirement.
 */
async function planSurfaceAccount(store: Store, account: SurfaceAccount): Promise<DeletionPlan> {
  const name = account.name ?? `${account.provider}:${account.externalAccountId}`;
  const managed =
    account.name === undefined
      ? undefined
      : await store.findResourceManagement("SurfaceAccount", account.name);
  const routes = await store.listTagRoutes({ surfaceAccountId: account.id });
  const sets = await setNames(store);
  const permissionSets = [
    ...new Set(
      (await store.listTagPermissions({ surfaceAccountId: account.id })).map(
        (permission) =>
          `Permission Set ${sets.permission.get(permission.permissionSetId) ?? permission.permissionSetId}`,
      ),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  return {
    kind: "SurfaceAccount",
    name,
    action: "retire",
    references: [...(await tagLocationReferences(store, routes)), ...permissionSets],
    removed: [
      "its stored credential",
      ...(managed?.applySet === undefined ? [] : [`membership in apply set ${managed.applySet}`]),
    ],
    notes: [
      `${account.provider} account ${account.displayName} (${account.externalAccountId}) stops receiving events. Replies still pending through it fail.`,
    ],
  };
}

/** Why the plan cannot proceed, phrased to follow the resource's name; undefined when it can. */
export function deletionRefusal(plan: DeletionPlan): string | undefined {
  if (plan.refusal !== undefined) return plan.refusal;
  return plan.references.length === 0 ? undefined : `is in use by ${listText(plan.references)}`;
}

/**
 * Carries out a plan that has no refusal, then forgets the resource's field ownership and
 * apply-set membership. Callers plan first; this does not re-check references.
 */
export async function applyDeletion(
  store: Store,
  plan: DeletionPlan,
  credentialVault?: Pick<GatewayCredentialVault, "delete">,
): Promise<void> {
  if (plan.kind === "SurfaceAccount") {
    const account = await findSurfaceAccountForDeletion(store, plan.name);
    if (account !== undefined) {
      if (credentialVault === undefined)
        throw new Error("Retiring a Surface Account requires the credential vault");
      const name = account.name;
      await store.retireSurfaceAccount(account.id);
      await credentialVault.delete(account.credentialId);
      if (name !== undefined) await store.deleteResourceManagement("SurfaceAccount", name);
    }
    return;
  }
  if (plan.kind === "Tag") {
    const tag = await store.findTagByName(plan.name);
    if (tag) await store.retireTag(tag.id);
  } else if (plan.kind === "Role") {
    const role = await store.findRoleByName(plan.name);
    // Retiring keeps the Role's history; clearing its sets lets those sets be deleted too.
    if (role?.status === "active")
      await store.updateRole(role.id, {
        expectedRevision: role.revision,
        status: "retired",
        contextSetIds: [],
        permissionSetIds: [],
      });
  } else if (plan.kind === "PermissionSet") {
    const set = await store.findTagPermissionSetByName(plan.name);
    if (set) {
      await releaseRetiredRoles(store, set.id, "permissionSetIds");
      await store.removeTagPermissionSet(set.id);
    }
  } else if (plan.kind === "ContextSet") {
    const set = await store.findTagContextSetByName(plan.name);
    if (set) {
      await releaseRetiredRoles(store, set.id, "contextSetIds");
      await store.removeTagContextSet(set.id);
    }
  } else if (plan.kind === "Volume") {
    await store.deleteVolume(plan.name);
  } else {
    await store.deleteWorkspace(plan.name);
  }
  await store.deleteResourceManagement(plan.kind, plan.name);
}

/** Retired Roles keep references that would block deleting a set; drop them. */
async function releaseRetiredRoles(
  store: Store,
  setId: string,
  field: "contextSetIds" | "permissionSetIds",
): Promise<void> {
  for (const role of await store.listRoles())
    if (role.status === "retired" && role[field].includes(setId))
      await store.updateRole(role.id, {
        expectedRevision: role.revision,
        [field]: role[field].filter((id) => id !== setId),
      });
}

/** `Tag release (location slack:C01)`, one entry per Tag. */
async function tagLocationReferences(
  store: Store,
  routes: readonly TagRoute[],
): Promise<readonly string[]> {
  const accounts = new Map((await store.listSurfaceAccounts()).map((item) => [item.id, item]));
  const byTag = new Map<string, string[]>();
  for (const route of routes) {
    const labels = byTag.get(route.tagId) ?? [];
    labels.push(routeLabel(route, accounts));
    byTag.set(route.tagId, labels);
  }
  const entries: string[] = [];
  for (const [tagId, labels] of byTag) {
    const sorted = [...new Set(labels)].toSorted((left, right) => left.localeCompare(right));
    entries.push(
      `Tag ${await tagName(store, tagId)} (${sorted.length === 1 ? "location" : "locations"} ${sorted.join(", ")})`,
    );
  }
  return entries.toSorted((left, right) => left.localeCompare(right));
}

function routeLabel(
  route: TagRoute,
  accounts: ReadonlyMap<
    string,
    { readonly provider: Parameters<typeof tagLocationScopeFields>[0] }
  >,
): string {
  const account = accounts.get(route.surfaceAccountId);
  if (!account) return route.scope;
  return locationKey({
    provider: account.provider,
    ...tagLocationScopeFields(account.provider, route.scope),
  });
}

async function setNames(store: Store) {
  const [permission, context] = await Promise.all([
    store.listTagPermissionSets(),
    store.listTagContextSets(),
  ]);
  return {
    permission: new Map(permission.map((set) => [set.id, set.name])),
    context: new Map(context.map((set) => [set.id, set.name])),
  };
}

async function tagName(store: Store, id: string): Promise<string> {
  return (await store.findTagById(id))?.name ?? id;
}

async function tagNames(store: Store, ids: readonly string[]): Promise<readonly string[]> {
  const names = new Set<string>();
  for (const id of ids) names.add(await tagName(store, id));
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

function plural(count: number, noun: string, prefix = ""): string {
  return `${prefix}${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `a`, `a and b`, `a, b, and c`. */
export function listText(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
