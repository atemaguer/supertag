import type { ControlPlane, CoordinationOperatorPrincipal } from "@supertag/control-plane";
import { resolveOwnerObjectiveRuntimeActions } from "@supertag/control-plane";
import type {
  AddTagContextItemInput,
  AddTagPermissionInput,
  ConnectedSurfaceProvider,
  ExecutionSettings,
  GatewayCredentialVault,
  ManagedResourceKind,
  Objective,
  Role,
  Store,
  SurfaceAccount,
  SurfaceProvider,
  Tag,
  TagContextItem,
  TagMessagingGrant,
  TagPermission,
  TagPermissionSet,
  VolumeSpec,
  WorkspaceSpec,
} from "@supertag/core";
import {
  type ApplyVolumeInput,
  type ApplyWorkspaceInput,
  DEFAULT_WORKSPACE_DELIVERY,
  normalizeApprovers,
  parseCreateObjective,
  parseExecutionSettings,
  parseMcpGrantAction,
  parseMcpGrantResource,
  parseVolumeName,
  parseVolumeSpec,
  parseWorkerHostLabels,
  parseWorkspaceName,
  parseWorkspaceNames,
  parseWorkspaceSpec,
  TagMessagingError,
} from "@supertag/core";
import type { VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import { type PruneItem, pruneApplySet } from "./apply-set-prune.js";
import {
  CONTROL_PLANE_API_VERSION,
  canonicalMailboxGrants,
  canonicalTagLocations,
  contextSetResource,
  permissionSetResource,
  roleResource,
  surfaceAccountResource,
  type TagLocationSpec,
  type TagOrganization,
  tagLocationScopeFields,
  tagResource,
  volumeResource,
  workerProfileResourcesFromHost,
  workspaceEnvironments,
  workspaceResource,
} from "./control-plane-resources.js";
import { canonicalJson, locationKey, sameValue } from "./field-management.js";
import {
  conflictMessage,
  type ManagedPlan,
  type ManagedWriteOptions,
  planImperativeWrite,
  planManagedWrite,
  planReport,
  recordManagedWrite,
} from "./managed-apply.js";
import {
  applyObjectiveManifest,
  objectivePlanReport,
  objectiveRefusalMessage,
  objectiveResource,
  parseObjectiveManifest,
  planObjectiveManifest,
} from "./objective-manifest.js";
import {
  applyDeletion,
  DELETE_KIND_NAMES,
  deletionRefusal,
  planDeletion,
} from "./resource-deletion.js";
import type { ResourcePath, ResourceView } from "./resource-protos.js";
import {
  declaredConfiguration,
  parseSurfaceAccountManifest,
  type SurfaceAccountManifestSpec,
  sameCredential,
  manifestSpec as surfaceManifestSpec,
} from "./surface-account-manifest.js";
import {
  AccountSelectionError,
  type SurfaceTarget,
  SurfaceTargetResolver,
  TargetValueError,
} from "./tag-surface-target.js";

/**
 * The Control Plane's resources one at a time: reading them as the resource views the operator
 * API serves, planning and writing one manifest under field management, deleting one, and pruning
 * an apply set. `manifest-apply.ts` applies whole inputs through these.
 */

/** What reading and writing resources uses: the store, the vault and the Control Plane. */
export interface ResourceApplyContext {
  readonly store: Store;
  /** Holds Surface Account credentials, which resolve locations and compare secrets. */
  readonly credentialVault: GatewayCredentialVault;
  readonly controlPlane: Pick<
    ControlPlane,
    "isAccepting" | "listWorkerHosts" | "objectives" | "setupSurfaceAccount" | "startObjective"
  >;
  /** When the Control Plane started; Worker Profiles report it as their timestamps. */
  readonly startedAt: string;
}

/** The kinds a manifest declares, by their CLI path. */
export type ManifestPath = Exclude<ResourcePath, "worker-profiles">;

/** A field one write changes, as the field manager rules key it. */
export interface PlannedChange {
  readonly path: string;
  readonly action: "add" | "remove" | "change";
  readonly before?: unknown;
  readonly after?: unknown;
}

/** A dry run: the merged spec and what applying the manifest would change. */
export interface PlannedResource {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: { readonly name: string };
  readonly spec: unknown;
  readonly plan: {
    readonly action: "create" | "update" | "unchanged";
    readonly changes: readonly PlannedChange[];
    readonly conflicts: readonly { readonly path: string; readonly manager: string }[];
    /** Changes apply cannot make, such as a new Objective outcome or account provider. */
    readonly refusals?: readonly { readonly path: string; readonly reason: string }[];
    /** Objectives only: applying starts the Objective. */
    readonly start?: boolean;
    /** Objectives only: why applying leaves the Objective unchanged. */
    readonly held?: string;
    /** Surface Accounts with resolved secrets: whether they match the stored credentials. */
    readonly secrets?: "changed" | "unchanged";
  };
  /** Surface Accounts only: the provider account the name already holds. */
  readonly current?: { readonly provider: string; readonly externalAccountId: string };
}

/** What writing one manifest did. */
export interface WrittenResource {
  /** Objectives only: conditions that hold its turns, or why apply left it unchanged. */
  readonly warnings?: readonly string[];
  /** Objectives only: the first turn applying started. */
  readonly started?: { readonly taskId: string };
  /** Objectives only: why it could not start. */
  readonly notStarted?: string;
}

/** The resolved secrets of a Surface Account manifest, and what its provider verified them as. */
export interface SurfaceAccountWrite {
  /** Compared with the stored credentials by a plan; never stored, returned or logged. */
  readonly credentials?: Readonly<Record<string, string>>;
  /** Present when the write stores credentials the provider verified. */
  readonly verified?: VerifiedSurfaceAccount;
}

/** A deletion refused while something still uses the resource; `references` names each user. */
export class ResourceInUseError extends TagMessagingError {
  constructor(
    message: string,
    readonly references: readonly string[],
  ) {
    super(409, message);
    this.name = "ResourceInUseError";
  }
}

/** What a deletion removes, or would remove. */
export interface ResourceDeletion {
  readonly kind: ManagedResourceKind;
  readonly name: string;
  readonly dryRun: boolean;
  readonly action: "retire" | "delete";
  readonly removed: readonly string[];
  readonly notes: readonly string[];
}

const DELETABLE_LABELS: Readonly<Record<ManagedResourceKind, string>> = {
  SurfaceAccount: "Surface Account",
  Tag: "Tag",
  Role: "Role",
  PermissionSet: "Permission Set",
  ContextSet: "Context Set",
  Volume: "Volume",
  Workspace: "Workspace",
  Objective: "Objective",
};

/** Every resource of one kind, as `ListResources` returns them. */
export async function listResourceViews(
  context: ResourceApplyContext,
  path: ResourcePath,
): Promise<readonly ResourceView[]> {
  const store = context.store;
  switch (path) {
    case "tags": {
      const [tags, routes, assignments, roles, accounts, organization] = await Promise.all([
        store.listTags(),
        store.listTagRoutes(),
        store.listRoleAssignments(),
        store.listRoles(),
        store.listSurfaceAccounts(),
        tagOrganizationFromStore(store),
      ]);
      const roleNames = new Map(roles.map((role) => [role.id, role.name]));
      const accountsById = new Map(accounts.map((account) => [account.id, account]));
      const bindings = new Map(
        await Promise.all(
          tags.map(async (tag) => [tag.id, await store.listTagWorkerHostBindings(tag.id)] as const),
        ),
      );
      const grantsByTag = new Map(
        await Promise.all(
          tags.map(async (tag) => [tag.id, await recipientGrants(store, tag)] as const),
        ),
      );
      return tags.map((tag) =>
        tagResource(
          tag,
          routes.filter((route) => route.tagId === tag.id),
          assignments.filter((assignment) => assignment.tagId === tag.id),
          (bindings.get(tag.id) ?? []).map((binding) => binding.workerHostId),
          roleNames,
          accountsById,
          { ...organization, grants: grantsByTag.get(tag.id) ?? [] },
          new Map(roles.map((role) => [role.id, role])),
        ),
      );
    }
    case "roles":
      return Promise.all(
        (await store.listRoles()).map((role) => roleResourceFromStore(store, role)),
      );
    case "permission-sets": {
      const [sets, permissions, activations] = await Promise.all([
        store.listTagPermissionSets(),
        store.listTagPermissions(),
        store.listTagPermissionActivations(),
      ]);
      return sets.map((set) =>
        permissionSetResource(
          set,
          permissions.filter((permission) => permission.permissionSetId === set.id),
          activations.filter((activation) => activation.permissionSetId === set.id),
        ),
      );
    }
    case "context-sets": {
      const [sets, items, activations] = await Promise.all([
        store.listTagContextSets(),
        store.listTagContextItems(),
        store.listTagContextActivations(),
      ]);
      return sets.map((set) =>
        contextSetResource(
          set,
          items.filter((item) => item.contextSetId === set.id),
          activations.filter((activation) => activation.contextSetId === set.id),
        ),
      );
    }
    case "volumes":
      return (await store.listVolumes()).map(volumeResource);
    case "workspaces": {
      const [workspaces, hosts] = await Promise.all([
        store.listWorkspaces(),
        context.controlPlane.listWorkerHosts(),
      ]);
      return workspaces.map((workspace) => workspaceResource(workspace, hosts));
    }
    case "surface-accounts":
      return (await store.listSurfaceAccounts()).map(surfaceAccountResource);
    case "worker-profiles":
      return (await context.controlPlane.listWorkerHosts()).flatMap((host) =>
        workerProfileResourcesFromHost(host, context.startedAt),
      );
    case "objectives":
      throw new TagMessagingError(
        400,
        "Objectives are listed with supertag list objective; get objective ID reads one",
      );
  }
}

/**
 * One resource by name, as `GetResource` returns it, or a `TagMessagingError` 404 naming it.
 * A Workspace also reports its environments.
 */
export async function readResourceView(
  context: ResourceApplyContext,
  path: ResourcePath,
  name: string,
): Promise<ResourceView> {
  const store = context.store;
  const missing = (message: string) => new TagMessagingError(404, message);
  switch (path) {
    case "tags": {
      // A retired Tag stays readable by name until a new Tag takes the name.
      const tag = await store.findTagByName(name, { includeRetired: true });
      if (tag === undefined) throw missing(`Tag ${JSON.stringify(name)} does not exist`);
      return tagResourceFromStore(store, tag);
    }
    case "roles": {
      const role = await store.findRoleByName(name);
      if (role === undefined) throw missing(`Role ${name} does not exist`);
      return roleResourceFromStore(store, role);
    }
    case "permission-sets": {
      const set = await store.findTagPermissionSetByName(name);
      if (set === undefined) throw missing(`Permission Set ${name} does not exist`);
      return permissionSetResource(
        set,
        await store.listTagPermissions({ permissionSetId: set.id }),
        await store.listTagPermissionActivations({ permissionSetId: set.id }),
      );
    }
    case "context-sets": {
      const set = await store.findTagContextSetByName(name);
      if (set === undefined) throw missing(`Context Set ${name} does not exist`);
      return contextSetResource(
        set,
        await store.listTagContextItems({ contextSetId: set.id }),
        await store.listTagContextActivations({ contextSetId: set.id }),
      );
    }
    case "volumes": {
      const volume = await store.findVolumeByName(name);
      if (volume === undefined) throw missing(`Volume ${name} does not exist`);
      return volumeResource(volume);
    }
    case "workspaces": {
      const workspace = await store.findWorkspaceByName(name);
      if (workspace === undefined) throw missing(`Workspace ${name} does not exist`);
      const hosts = await context.controlPlane.listWorkerHosts();
      return workspaceResource(
        workspace,
        hosts,
        await workspaceEnvironments(store, workspace, hosts),
      );
    }
    case "surface-accounts": {
      const account = await findSurfaceAccountByName(store, name);
      if (account === undefined) throw missing(`Surface Account ${name} does not exist`);
      return surfaceAccountResource(account);
    }
    case "worker-profiles": {
      const profile = (await context.controlPlane.listWorkerHosts())
        .flatMap((host) => workerProfileResourcesFromHost(host, context.startedAt))
        .find((candidate) => candidate.metadata.name === name || candidate.metadata.id === name);
      if (profile === undefined) throw missing("Worker Profile does not exist");
      return profile;
    }
    case "objectives": {
      const objective = await store.getObjective(name).catch((error: unknown) => {
        if (error instanceof TagMessagingError && error.statusCode === 404)
          throw missing(`Objective ${name} does not exist`);
        throw error;
      });
      const resource = await objectiveResource(store, objective);
      return { ...resource, spec: resource.spec as Readonly<Record<string, unknown>> };
    }
  }
}

/** A Surface Account by manifest name, or by `PROVIDER:EXTERNAL_ACCOUNT_ID`. */
async function findSurfaceAccountByName(
  store: Store,
  name: string,
): Promise<SurfaceAccount | undefined> {
  const named = await store.findSurfaceAccountByName(name);
  if (named !== undefined) return named;
  const separator = name.indexOf(":");
  const provider = name.slice(0, separator);
  if (separator <= 0 || !Object.hasOwn(LOCATION_SCOPES, provider)) return undefined;
  return store.findSurfaceAccount(provider as ConnectedSurfaceProvider, name.slice(separator + 1));
}

/** Plans one manifest without writing: its merged spec and what applying it would change. */
export async function planResource(
  context: ResourceApplyContext,
  path: ManifestPath,
  body: unknown,
  options: ManagedWriteOptions,
  surface: SurfaceAccountWrite = {},
): Promise<PlannedResource> {
  return (await postResource(
    context,
    path,
    body,
    { ...options, dryRun: true },
    undefined,
    surface,
  )) as PlannedResource;
}

/**
 * Writes one manifest under field management: refused as a `TagMessagingError` 409 for a field
 * another manager owns or one that cannot change, and 400 for an invalid manifest.
 */
export async function writeResource(
  context: ResourceApplyContext,
  path: ManifestPath,
  body: unknown,
  options: ManagedWriteOptions,
  principal: CoordinationOperatorPrincipal,
  surface: SurfaceAccountWrite = {},
): Promise<WrittenResource> {
  return (await postResource(
    context,
    path,
    body,
    { ...options, dryRun: false },
    principal,
    surface,
  )) as WrittenResource;
}

async function postResource(
  context: ResourceApplyContext,
  path: ManifestPath,
  body: unknown,
  options: ManagedWriteOptions,
  principal: CoordinationOperatorPrincipal | undefined,
  surface: SurfaceAccountWrite,
): Promise<PlannedResource | WrittenResource> {
  const store = context.store;
  switch (path) {
    case "surface-accounts":
      return applySurfaceAccountManifest(context, body, options, surface);
    case "objectives":
      return applyObjectiveDocument(context, body, options, principal);
    case "permission-sets": {
      const desired = parseDesiredPermissionSet(body);
      const existing = await store.findTagPermissionSetByName(desired.name);
      const plan = await planWrite(store, options, {
        kind: "PermissionSet",
        name: desired.name,
        currentSpec: existing
          ? permissionSetManifestSpec(
              existing,
              await store.listTagPermissions({ permissionSetId: existing.id }),
            )
          : undefined,
        desiredSpec: {
          ...(manifestSpec(body)["approvers"] === undefined
            ? {}
            : { approvers: desired.approvers }),
          permissions: desired.permissions,
        },
      });
      const unwritten = withoutWriting(body, plan, options);
      if (unwritten !== undefined) return unwritten;
      const merged = plan.spec as {
        readonly approvers: readonly string[];
        readonly permissions: readonly DesiredPermission[];
      };
      const created = await store.createTagPermissionSet({
        name: desired.name,
        approvers: merged.approvers,
      });
      const set =
        JSON.stringify(created.approvers ?? []) === JSON.stringify(merged.approvers)
          ? created
          : await store.setTagPermissionSetApprovers(created.id, merged.approvers);
      const current = await store.listTagPermissions({ permissionSetId: set.id });
      const desiredKeys = new Set(merged.permissions.map(permissionKey));
      await Promise.all(
        current
          .filter((permission) => !desiredKeys.has(permissionKey(permission)))
          .map((permission) => store.removeTagPermission(permission.id)),
      );
      for (const permission of merged.permissions) {
        const stored = await store.addTagPermission({ permissionSetId: set.id, ...permission });
        if (stored.approval !== permission.approval)
          await store.setTagPermissionApproval(stored.id, permission.approval);
      }
      const stored = (await store.findTagPermissionSetById(set.id)) ?? set;
      const permissions = await store.listTagPermissions({ permissionSetId: set.id });
      await recordWrite(store, plan, permissionSetManifestSpec(stored, permissions), options);
      return {};
    }
    case "context-sets": {
      const desired = parseDesiredContextSet(body);
      const existing = await store.findTagContextSetByName(desired.name);
      const plan = await planWrite(store, options, {
        kind: "ContextSet",
        name: desired.name,
        currentSpec: existing
          ? contextSetManifestSpec(await store.listTagContextItems({ contextSetId: existing.id }))
          : undefined,
        desiredSpec: { items: desired.items },
      });
      const unwritten = withoutWriting(body, plan, options);
      if (unwritten !== undefined) return unwritten;
      const merged = plan.spec as { readonly items: readonly DesiredContextItem[] };
      const set = await store.createTagContextSet({ name: desired.name });
      const current = await store.listTagContextItems({ contextSetId: set.id });
      const desiredKeys = new Set(merged.items.map((item) => item.itemKey));
      await Promise.all(
        current
          .filter((item) => !desiredKeys.has(item.itemKey))
          .map((item) => store.removeTagContextItem(item.id)),
      );
      for (const item of merged.items) {
        const prior = current.find((candidate) => candidate.itemKey === item.itemKey);
        if (prior !== undefined && sameValue(contextItemValue(prior), item)) continue;
        if (prior !== undefined) await store.removeTagContextItem(prior.id);
        await store.addTagContextItem({ contextSetId: set.id, ...item });
      }
      const items = await store.listTagContextItems({ contextSetId: set.id });
      await recordWrite(store, plan, contextSetManifestSpec(items), options);
      return {};
    }
    case "roles": {
      const desired = parseDesiredRole(body);
      const existing = await store.findRoleByName(desired.name);
      // A retired Role is gone from the organization; applying it again starts it fresh.
      const active = existing?.status === "active" ? existing : undefined;
      const plan = await planWrite(store, options, {
        kind: "Role",
        name: desired.name,
        currentSpec: active ? (await roleResourceFromStore(store, active)).spec : undefined,
        desiredSpec: {
          purpose: desired.purpose,
          instructions: desired.instructions,
          contextSets: desired.contextSets,
          permissionSets: desired.permissionSets,
          ...(desired.execution === undefined ? {} : { execution: desired.execution }),
        },
      });
      const unwritten = withoutWriting(body, plan, options);
      if (unwritten !== undefined) return unwritten;
      const merged = plan.spec as {
        readonly purpose?: string;
        readonly instructions?: string;
        readonly contextSets: readonly string[];
        readonly permissionSets: readonly string[];
        readonly execution?: ExecutionSettings;
      };
      const [contextSets, permissionSets] = await Promise.all([
        Promise.all(
          merged.contextSets.map(async (name) => {
            const set = await store.findTagContextSetByName(name);
            if (!set) throw new Error(`Context Set ${name} does not exist`);
            return set;
          }),
        ),
        Promise.all(
          merged.permissionSets.map(async (name) => {
            const set = await store.findTagPermissionSetByName(name);
            if (!set) throw new Error(`Permission Set ${name} does not exist`);
            return set;
          }),
        ),
      ]);
      const fields = {
        purpose: merged.purpose ?? desired.purpose,
        instructions: merged.instructions ?? "",
        contextSetIds: contextSets.map((set) => set.id),
        permissionSetIds: permissionSets.map((set) => set.id),
      };
      let role = existing
        ? await store.updateRole(existing.id, {
            expectedRevision: existing.revision,
            ...fields,
            execution: merged.execution ?? null,
            status: "active",
          })
        : await store.createRole({
            name: desired.name,
            ...fields,
            ...(merged.execution === undefined ? {} : { execution: merged.execution }),
          });
      role = (await store.findRoleById(role.id)) ?? role;
      const resource = await roleResourceFromStore(store, role);
      await recordWrite(store, plan, resource.spec, options);
      return {};
    }
    case "volumes": {
      const desired = parseDesiredVolume(body);
      const existing = await store.findVolumeByName(desired.name);
      const { name: _name, ...desiredSpec } = desired;
      const plan = await planWrite(store, options, {
        kind: "Volume",
        name: desired.name,
        currentSpec: existing ? volumeResource(existing).spec : undefined,
        desiredSpec,
      });
      const unwritten = withoutWriting(body, plan, options);
      if (unwritten !== undefined) return unwritten;
      // The merged spec keeps fields other managers own; the store validates it again.
      const { volume } = await store.applyVolume({
        ...(plan.spec as Partial<VolumeSpec>),
        name: desired.name,
      } as ApplyVolumeInput);
      await recordWrite(store, plan, volumeResource(volume).spec, options);
      return {};
    }
    case "workspaces": {
      const desired = parseDesiredWorkspace(body);
      const existing = await store.findWorkspaceByName(desired.name);
      const listed = manifestSpec(body);
      const plan = await planWrite(store, options, {
        kind: "Workspace",
        name: desired.name,
        currentSpec: existing ? workspaceResource(existing, []).spec : undefined,
        // Only the fields the manifest sets; the store fills defaults for the rest.
        desiredSpec: Object.fromEntries(
          Object.entries(withoutName(desired)).filter(([field]) => listed[field] !== undefined),
        ),
      });
      const unwritten = withoutWriting(body, plan, options);
      if (unwritten !== undefined) return unwritten;
      const merged = plan.spec as Partial<WorkspaceSpec>;
      const { workspace } = await store.applyWorkspace({
        name: desired.name,
        ...merged,
        delivery: merged.delivery ?? DEFAULT_WORKSPACE_DELIVERY,
      });
      await recordWrite(store, plan, workspaceResource(workspace, []).spec, options);
      return {};
    }
    case "tags":
      return applyTagManifest(context, body, options);
  }
}

async function applyTagManifest(
  context: ResourceApplyContext,
  body: unknown,
  options: ManagedWriteOptions,
): Promise<PlannedResource | WrittenResource> {
  const store = context.store;
  const desired = parseDesiredTag(body);
  const [accounts, workerHosts] = await Promise.all([
    store.listSurfaceAccounts(),
    context.controlPlane.listWorkerHosts(),
  ]);
  const knownWorkerHostIds = new Set(workerHosts.map((host) => host.id));
  for (const workerHostId of desired.workerHosts ?? [])
    if (!knownWorkerHostIds.has(workerHostId))
      throw new Error(`Worker Host ${workerHostId} does not exist`);
  const locations =
    desired.locations === undefined
      ? undefined
      : await resolveTagLocations(context, desired.locations, accounts);
  const existing = await store.findTagByName(desired.name);
  const plan = await planWrite(store, options, {
    kind: "Tag",
    name: desired.name,
    currentSpec: existing ? (await tagResourceFromStore(store, existing)).spec : undefined,
    desiredSpec: desiredTagSpec(desired, locations),
  });
  // References are checked by the caller, against the whole input.
  const unwritten = withoutWriting(body, plan, options);
  if (unwritten !== undefined) return unwritten;
  const merged = plan.spec as {
    readonly roles: readonly string[];
    readonly workerHosts: readonly string[];
    readonly runsOn: readonly string[];
    readonly execution?: ExecutionSettings;
    readonly locations: readonly TagLocationSpec[];
    readonly acceptsMessagesFrom: readonly string[];
  };
  // Kept locations come from stored routes; the manifest's own are already resolved.
  const resolved = new Map<string, ResolvedTagLocation>();
  for (const route of existing ? await store.listTagRoutes({ tagId: existing.id }) : []) {
    const account = accounts.find((candidate) => candidate.id === route.surfaceAccountId);
    if (!account) continue;
    const key = locationKey({
      provider: account.provider,
      ...tagLocationScopeFields(account.provider, route.scope),
    });
    resolved.set(key, {
      field: `spec.locations[${key}]`,
      provider: account.provider,
      account,
      scope: route.scope,
      displayName: route.scope,
      permissionSets: [],
      contextSets: [],
      workspaces: [],
    });
  }
  for (const location of locations ?? [])
    resolved.set(
      locationKey({
        provider: location.account.provider,
        ...tagLocationScopeFields(location.account.provider, location.scope),
      }),
      location,
    );
  const mergedLocations = merged.locations.map((location) => {
    const route = resolved.get(locationKey(location));
    if (!route) throw new Error(`Tag location ${locationKey(location)} cannot be resolved`);
    return {
      ...route,
      permissionSets: location.permissionSets ?? [],
      contextSets: location.contextSets ?? [],
      workspaces: location.workspaces ?? [],
    };
  });
  const { tag } = await applyDesiredTag(
    context,
    {
      name: desired.name,
      roles: merged.roles,
      workerHosts: merged.workerHosts,
      runsOn: merged.runsOn,
      execution: merged.execution ?? null,
      acceptsMessagesFrom: merged.acceptsMessagesFrom,
    },
    mergedLocations,
  );
  const resource = await tagResourceFromStore(store, tag);
  await recordWrite(store, plan, resource.spec, options);
  return {};
}

/**
 * Deletes or retires one resource with what goes with it, or with `dryRun` says what that would
 * do. Refused as a `TagMessagingError` 409 while something still uses it, and 404 when it does
 * not exist.
 */
export async function deleteResourceByName(
  context: ResourceApplyContext,
  kind: Exclude<ManagedResourceKind, "Objective">,
  name: string,
  dryRun: boolean,
): Promise<ResourceDeletion> {
  const plan = await planDeletion(context.store, kind, name, () =>
    context.controlPlane.listWorkerHosts(),
  );
  if (plan === undefined)
    throw new TagMessagingError(404, `${DELETABLE_LABELS[kind]} ${name} does not exist`);
  const refusal = deletionRefusal(plan);
  if (refusal !== undefined)
    throw new ResourceInUseError(`${DELETE_KIND_NAMES[kind]} ${name} ${refusal}.`, plan.references);
  if (!dryRun) await applyDeletion(context.store, plan, context.credentialVault);
  return {
    kind,
    name,
    dryRun,
    action: plan.action,
    removed: plan.removed,
    notes: plan.notes,
  };
}

/** Prunes an apply set's members the input no longer lists, or with `dryRun` plans it. */
export function pruneResources(
  context: ResourceApplyContext,
  input: {
    readonly applySet: string;
    readonly keep: readonly { readonly kind: string; readonly name: string }[];
    readonly dryRun: boolean;
  },
  principal: CoordinationOperatorPrincipal | undefined,
): Promise<readonly PruneItem[]> {
  return pruneApplySet(context.store, {
    ...input,
    credentialVault: context.credentialVault,
    workerHosts: () => context.controlPlane.listWorkerHosts(),
    ...(principal === undefined
      ? {}
      : {
          cancelObjective: async (objectiveId: string, reason: string) => {
            await context.controlPlane.objectives.cancelObjective(
              { objectiveId, reason },
              principal,
            );
          },
        }),
  });
}

interface DesiredTagLocation {
  readonly field: string;
  readonly target: SurfaceTarget;
  readonly permissionSets: readonly string[];
  readonly contextSets: readonly string[];
  readonly workspaces: readonly string[];
}

interface DesiredTag {
  readonly name: string;
  readonly roles?: readonly string[];
  readonly workerHosts?: readonly string[];
  /** Absent leaves placement labels unmanaged; present replaces them. */
  readonly runsOn?: readonly string[];
  /** Absent leaves execution settings unmanaged; null clears them. */
  readonly execution?: ExecutionSettings | null;
  /** Absent leaves routes and their activations unmanaged; present is authoritative. */
  readonly locations?: readonly DesiredTagLocation[];
  /** Tags this Tag accepts Mailbox messages from beyond its Teams; absent leaves them unmanaged. */
  readonly acceptsMessagesFrom?: readonly string[];
}

interface ResolvedTagLocation {
  readonly field: string;
  readonly provider: SurfaceProvider;
  readonly account: SurfaceAccount;
  readonly scope: string;
  readonly displayName: string;
  readonly permissionSets: readonly string[];
  readonly contextSets: readonly string[];
  /** Workspaces an Objective created from this location names. */
  readonly workspaces: readonly string[];
}

/** Scope fields per provider, spelled as the camelCase `--add-location` flags. */
const LOCATION_SCOPES: Readonly<Record<ConnectedSurfaceProvider, readonly (readonly string[])[]>> =
  {
    slack: [["channelId"]],
    lark: [["chatId"]],
    teams: [["teamId", "channelId"]],
    github: [["repo"], ["repoId"]],
    linear: [["team"], ["teamId"]],
  };

function parseDesiredTag(value: unknown): DesiredTag {
  if (
    !isRecord(value) ||
    value["apiVersion"] !== CONTROL_PLANE_API_VERSION ||
    value["kind"] !== "Tag" ||
    !isRecord(value["metadata"]) ||
    !isRecord(value["spec"])
  )
    throw new Error("Tag resource is invalid");
  const spec = value["spec"];
  const allowed = new Set([
    "roles",
    "workerHosts",
    "runsOn",
    "execution",
    "locations",
    "acceptsMessagesFrom",
  ]);
  const unknown = Object.keys(spec).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(`Tag spec contains unknown fields: ${unknown.join(", ")}`);
  const roles = optionalNameList(spec["roles"], "Tag spec.roles");
  const workerHosts = optionalNameList(spec["workerHosts"], "Tag spec.workerHosts");
  const runsOn =
    spec["runsOn"] === undefined
      ? undefined
      : parseWorkerHostLabels(spec["runsOn"], "Tag spec.runsOn");
  const execution = parseExecutionSettings(spec["execution"], "Tag spec.execution");
  const locations = spec["locations"];
  if (locations !== undefined && !Array.isArray(locations))
    throw new Error("Tag spec.locations must be an array");
  const acceptsMessagesFrom = optionalNameList(
    spec["acceptsMessagesFrom"],
    "Tag spec.acceptsMessagesFrom",
  );
  return {
    name: requiredString(value["metadata"]["name"], "Tag metadata.name"),
    ...(roles === undefined ? {} : { roles }),
    ...(workerHosts === undefined ? {} : { workerHosts }),
    ...(runsOn === undefined ? {} : { runsOn }),
    ...(execution === undefined ? {} : { execution }),
    ...(locations === undefined
      ? {}
      : {
          locations: locations.map((location: unknown, index: number) =>
            parseTagLocation(location, index),
          ),
        }),
    ...(acceptsMessagesFrom === undefined ? {} : { acceptsMessagesFrom }),
  };
}

function parseTagLocation(value: unknown, index: number): DesiredTagLocation {
  const field = `Tag spec.locations[${index}]`;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const provider = value["provider"];
  if (typeof provider !== "string" || !Object.hasOwn(LOCATION_SCOPES, provider))
    throw new Error(`${field}.provider must be slack, github, lark, linear, or teams`);
  const alternatives = LOCATION_SCOPES[provider as ConnectedSurfaceProvider];
  const scopeFields = new Set(alternatives.flat());
  const allowed = new Set([
    "provider",
    "account",
    "permissionSets",
    "contextSets",
    "workspaces",
    ...scopeFields,
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(`${field} contains fields not used by ${provider}: ${unknown.join(", ")}`);
  const present = Object.keys(value).filter((key) => scopeFields.has(key));
  const chosen = alternatives.find(
    (fields) => fields.length === present.length && fields.every((name) => present.includes(name)),
  );
  if (chosen === undefined)
    throw new Error(
      `${field} for ${provider} requires ${alternatives.map((fields) => fields.join(" and ")).join(" or ")}`,
    );
  const scope: Record<string, string> = Object.fromEntries(
    chosen.map((name) => [name, requiredField(value[name], `${field}.${name}`)]),
  );
  const account =
    value["account"] === undefined
      ? undefined
      : requiredField(value["account"], `${field}.account`);
  const common = account === undefined ? {} : { accountSelector: account };
  const text = (name: string) => scope[name] ?? "";
  let target: SurfaceTarget;
  if (provider === "slack") target = { ...common, provider, channelId: text("channelId") };
  else if (provider === "lark") target = { ...common, provider, chatId: text("chatId") };
  else if (provider === "teams")
    target = { ...common, provider, teamId: text("teamId"), channelId: text("channelId") };
  else if (provider === "github")
    target =
      scope["repoId"] === undefined
        ? { ...common, provider, repositoryName: text("repo") }
        : { ...common, provider, repositoryId: text("repoId") };
  else
    target =
      scope["teamId"] === undefined
        ? { ...common, provider: "linear", teamName: text("team") }
        : { ...common, provider: "linear", teamId: text("teamId") };
  return {
    field,
    target,
    permissionSets: optionalNameList(value["permissionSets"], `${field}.permissionSets`) ?? [],
    contextSets: optionalNameList(value["contextSets"], `${field}.contextSets`) ?? [],
    workspaces: parseWorkspaceNames(value["workspaces"], `${field}.workspaces`),
  };
}

/** Resolves locations with the surface resolver that `--add-location` uses. */
async function resolveTagLocations(
  context: Pick<ResourceApplyContext, "store" | "credentialVault">,
  locations: readonly DesiredTagLocation[],
  accounts: readonly SurfaceAccount[],
): Promise<readonly ResolvedTagLocation[]> {
  const resolver = new SurfaceTargetResolver(context.store, context.credentialVault);
  const resolved: ResolvedTagLocation[] = [];
  for (const location of locations) {
    try {
      const target = await resolver.resolve(location.target, accounts);
      resolved.push({
        field: location.field,
        provider: location.target.provider,
        permissionSets: location.permissionSets,
        contextSets: location.contextSets,
        workspaces: location.workspaces,
        account: target.account,
        scope: target.scope,
        displayName: target.displayName,
      });
    } catch (error) {
      throw new Error(`${location.field}: ${locationErrorMessage(error)}`, { cause: error });
    }
  }
  const keys = new Set<string>();
  for (const location of resolved) {
    const key = JSON.stringify([location.account.id, location.scope]);
    if (keys.has(key))
      throw new Error(
        `${location.field} repeats ${location.provider} ${location.displayName}; list each location once`,
      );
    keys.add(key);
  }
  return resolved;
}

function locationErrorMessage(error: unknown): string {
  if (error instanceof AccountSelectionError) {
    const { provider, selector, matches } = error.selection;
    if (matches.length === 0)
      return selector === undefined
        ? `No connected ${provider} account exists. Run supertag setup surface ${provider}.`
        : `No connected ${provider} account matches account ${JSON.stringify(selector)}`;
    return `Multiple connected ${provider} accounts exist; set account to one of: ${matches.map((account) => account.externalAccountId).join(", ")}`;
  }
  if (error instanceof TargetValueError) return `${error.field} is required`;
  return error instanceof Error ? error.message : String(error);
}

/** The resolved form of the fields a manifest manages; absent fields stay absent. */
function desiredTagSpec(
  desired: DesiredTag,
  locations: readonly ResolvedTagLocation[] | undefined,
): Record<string, unknown> {
  return {
    ...(desired.roles === undefined
      ? {}
      : { roles: desired.roles.toSorted((left, right) => left.localeCompare(right)) }),
    ...(desired.workerHosts === undefined ? {} : { workerHosts: desired.workerHosts.toSorted() }),
    ...(desired.runsOn === undefined ? {} : { runsOn: desired.runsOn }),
    ...(desired.execution === undefined || desired.execution === null
      ? {}
      : { execution: desired.execution }),
    ...(locations === undefined
      ? {}
      : {
          locations: canonicalTagLocations(
            locations.map(
              (location): TagLocationSpec => ({
                provider: location.account.provider,
                account: location.account.externalAccountId,
                ...tagLocationScopeFields(location.account.provider, location.scope),
                permissionSets: location.permissionSets,
                contextSets: location.contextSets,
                workspaces: location.workspaces,
              }),
            ),
          ),
        }),
    ...(desired.acceptsMessagesFrom === undefined
      ? {}
      : { acceptsMessagesFrom: canonicalMailboxGrants(desired.acceptsMessagesFrom) }),
  };
}

/**
 * Reconciles one Tag. Every reference is checked before the first write, so a manifest that
 * names a missing Role, set, sender, or occupied location leaves the Tag untouched.
 */
async function applyDesiredTag(
  context: ResourceApplyContext,
  desired: DesiredTag,
  locations: readonly ResolvedTagLocation[] | undefined,
): Promise<{ readonly tag: Tag; readonly created: boolean }> {
  const store = context.store;
  const existing = await store.findTagByName(desired.name);
  const roles = await Promise.all(
    (desired.roles ?? []).map(async (name) => {
      const role = await store.findRoleByName(name);
      if (role?.status !== "active") throw new Error(`Role ${name} does not exist`);
      return role;
    }),
  );
  const permissionSetIds = new Map<string, string>();
  const contextSetIds = new Map<string, string>();
  for (const location of locations ?? []) {
    for (const name of location.permissionSets) {
      const set = await store.findTagPermissionSetByName(name);
      if (!set) throw new Error(`Permission Set ${name} does not exist`);
      permissionSetIds.set(name, set.id);
    }
    for (const name of location.contextSets) {
      const set = await store.findTagContextSetByName(name);
      if (!set) throw new Error(`Context Set ${name} does not exist`);
      contextSetIds.set(name, set.id);
    }
    for (const name of location.workspaces)
      if (!(await store.findWorkspaceByName(name)))
        throw new Error(
          `${location.field}.workspaces: Workspace ${name} does not exist; apply a Workspace manifest before naming it`,
        );
    const holder = (await store.listTagRoutes({ surfaceAccountId: location.account.id })).find(
      (route) => route.scope === location.scope && route.tagId !== existing?.id,
    );
    if (holder) {
      const other = await store.findTagById(holder.tagId);
      throw new Error(
        `${location.field}: ${location.provider} ${location.displayName} already routes to Tag ${other?.name ?? holder.tagId}`,
      );
    }
  }
  const senders = new Map<string, Tag>();
  for (const name of desired.acceptsMessagesFrom ?? []) {
    if (name === desired.name) continue;
    const sender = await store.findTagByName(name);
    if (sender?.status !== "active") throw new Error(`Tag ${name} does not exist`);
    senders.set(name, sender);
  }

  let tag = existing ?? (await store.createTag({ name: desired.name }));
  if (desired.roles !== undefined) {
    const currentAssignments = await store.listRoleAssignments({ tagId: tag.id, status: "active" });
    const desiredRoleIds = new Set(roles.map((role) => role.id));
    for (const assignment of currentAssignments)
      if (!desiredRoleIds.has(assignment.roleId))
        await store.deactivateRoleAssignment(assignment.id, assignment.revision);
    for (const role of roles) await store.assignRole({ roleId: role.id, tagId: tag.id });
  }
  // Placement labels only; they never widen which bound hosts may run the Tag's Tasks.
  if (
    desired.runsOn !== undefined &&
    JSON.stringify(parseWorkerHostLabels(desired.runsOn, "Tag spec.runsOn")) !==
      JSON.stringify(tag.runsOn)
  )
    tag = await store.setTagRunsOn(tag.id, desired.runsOn);
  if (
    desired.execution !== undefined &&
    canonicalJson(desired.execution ?? undefined) !== canonicalJson(tag.execution)
  )
    tag = await store.setTagExecution(tag.id, desired.execution ?? undefined);
  if (desired.workerHosts !== undefined) {
    const current = await store.listTagWorkerHostBindings(tag.id);
    const desiredIds = new Set(desired.workerHosts);
    for (const binding of current)
      if (!desiredIds.has(binding.workerHostId))
        await store.unbindTagWorkerHost(tag.id, binding.workerHostId);
    for (const workerHostId of desired.workerHosts)
      await store.bindTagWorkerHost(tag.id, workerHostId);
  }
  if (locations !== undefined) {
    const routeKey = (surfaceAccountId: string, scope: string) =>
      JSON.stringify([surfaceAccountId, scope]);
    const current = await store.listTagRoutes({ tagId: tag.id });
    const wanted = new Set(
      locations.map((location) => routeKey(location.account.id, location.scope)),
    );
    // Same store call as `--remove-location`: the route and its activations are deleted.
    for (const route of current)
      if (!wanted.has(routeKey(route.surfaceAccountId, route.scope)))
        await store.removeTagRoute(route.id);
    for (const location of locations) {
      const route =
        current.find(
          (candidate) =>
            routeKey(candidate.surfaceAccountId, candidate.scope) ===
            routeKey(location.account.id, location.scope),
        ) ??
        (await store.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: location.account.id,
          scope: location.scope,
        }));
      if (JSON.stringify(route.workspaces) !== JSON.stringify(location.workspaces))
        await store.setTagRouteWorkspaces(route.id, location.workspaces);
      const wantedPermissionSets = new Set(
        location.permissionSets.map((name) => permissionSetIds.get(name) ?? name),
      );
      const permissionActivations = await store.listTagPermissionActivations({
        tagRouteId: route.id,
      });
      for (const activation of permissionActivations)
        if (!wantedPermissionSets.has(activation.permissionSetId))
          await store.deactivateTagPermissionSet(activation.permissionSetId, route.id);
      for (const permissionSetId of wantedPermissionSets)
        if (!permissionActivations.some((item) => item.permissionSetId === permissionSetId))
          await store.activateTagPermissionSet({ permissionSetId, tagRouteId: route.id });
      const wantedContextSets = new Set(
        location.contextSets.map((name) => contextSetIds.get(name) ?? name),
      );
      const contextActivations = await store.listTagContextActivations({ tagRouteId: route.id });
      for (const activation of contextActivations)
        if (!wantedContextSets.has(activation.contextSetId))
          await store.deactivateTagContextSet(activation.contextSetId, route.id);
      for (const contextSetId of wantedContextSets)
        if (!contextActivations.some((item) => item.contextSetId === contextSetId))
          await store.activateTagContextSet({ contextSetId, tagRouteId: route.id });
    }
  }
  if (desired.acceptsMessagesFrom !== undefined) {
    // Same store call as `supertag grant mailbox`: the list replaces the Tag's grants.
    const wanted = desired.acceptsMessagesFrom
      .map((name) => senders.get(name)?.id ?? tag.id)
      .toSorted();
    const current = (await recipientGrants(store, tag))
      .map((grant) => grant.senderTagId)
      .toSorted();
    if (JSON.stringify(current) !== JSON.stringify(wanted))
      await store.setTagMessagingGrants(tag.id, wanted);
  }
  return { tag, created: existing === undefined };
}

/** Mailbox grants where the Tag is the recipient. */
async function recipientGrants(
  store: Pick<Store, "listTagMessagingGrants">,
  tag: Tag,
): Promise<readonly TagMessagingGrant[]> {
  if (tag.status !== "active") return [];
  return (await store.listTagMessagingGrants(tag.id)).filter(
    (grant) => grant.recipientTagId === tag.id,
  );
}

async function tagOrganizationFromStore(store: Store): Promise<Omit<TagOrganization, "grants">> {
  const [permissionActivations, contextActivations, permissionSets, contextSets, tags] =
    await Promise.all([
      store.listTagPermissionActivations(),
      store.listTagContextActivations(),
      store.listTagPermissionSets(),
      store.listTagContextSets(),
      store.listTags(),
    ]);
  return {
    permissionActivations,
    contextActivations,
    permissionSetNames: new Map(permissionSets.map((set) => [set.id, set.name])),
    contextSetNames: new Map(contextSets.map((set) => [set.id, set.name])),
    tagNames: new Map(tags.map((tag) => [tag.id, tag.name])),
  };
}

function optionalNameList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    throw new Error(`${field} must be a string array`);
  const names = value.map((item: string) => item.trim());
  if (new Set(names).size !== names.length) throw new Error(`${field} must not contain duplicates`);
  return names;
}

function requiredField(value: unknown, field: string): string {
  const result = stringValue(value)?.trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function planWrite(
  store: Store,
  options: ManagedWriteOptions,
  input: Omit<Parameters<typeof planManagedWrite>[1], "options">,
): Promise<ManagedPlan> {
  return options.imperative
    ? Promise.resolve(planImperativeWrite(input))
    : planManagedWrite(store, { ...input, options });
}

/** Imperative writes are attributed to `cli` when the next managed write compares values. */
async function recordWrite(
  store: Store,
  plan: ManagedPlan,
  storedSpec: unknown,
  options: ManagedWriteOptions,
): Promise<void> {
  if (!options.imperative) await recordManagedWrite(store, plan, storedSpec, options);
}

/**
 * Answers a dry run with the merged spec and its plan, or refuses a conflicting write. Returns
 * undefined when the write goes ahead.
 */
function withoutWriting(
  body: unknown,
  plan: ManagedPlan,
  options: ManagedWriteOptions,
): PlannedResource | undefined {
  if (options.dryRun) return { ...dryRunResource(body), spec: plan.spec, plan: planReport(plan) };
  if (plan.merge.conflicts.length === 0) return undefined;
  throw new TagMessagingError(409, conflictMessage(plan));
}

function manifestSpec(body: unknown): Record<string, unknown> {
  return isRecord(body) && isRecord(body["spec"]) ? body["spec"] : {};
}

function permissionSetManifestSpec(
  set: TagPermissionSet,
  permissions: readonly TagPermission[],
): Record<string, unknown> {
  return {
    ...(set.approvers?.length ? { approvers: [...set.approvers] } : {}),
    permissions: permissions.map(
      (permission): DesiredPermission =>
        permission.target === "runtime"
          ? {
              target: "runtime",
              action: permission.action,
              ...(permission.approval ? { approval: permission.approval } : {}),
            }
          : permission.target === "mcp"
            ? {
                target: "mcp",
                action: permission.action,
                ...(permission.resource ? { resource: permission.resource } : {}),
                ...(permission.approval ? { approval: permission.approval } : {}),
              }
            : {
                target: "surface",
                surfaceAccountId: permission.surfaceAccountId,
                scope: permission.scope,
                action: permission.action,
                ...(permission.reference ? { reference: permission.reference } : {}),
                ...(permission.approval ? { approval: permission.approval } : {}),
              },
    ),
  };
}

function contextSetManifestSpec(items: readonly TagContextItem[]): Record<string, unknown> {
  return { items: items.map(contextItemValue) };
}

/** A validated manifest echoed without writes, for `supertag diff` and pre-apply validation. */
function dryRunResource(value: unknown): {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: { readonly name: string };
  readonly spec: unknown;
} {
  const resource = isRecord(value) ? value : {};
  const metadata = isRecord(resource["metadata"]) ? resource["metadata"] : {};
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: String(resource["kind"]),
    metadata: { name: requiredField(metadata["name"], "metadata.name") },
    spec: resource["spec"],
  };
}

type DesiredPermission = AddTagPermissionInput extends infer Permission
  ? Permission extends AddTagPermissionInput
    ? Omit<Permission, "permissionSetId">
    : never
  : never;
type DesiredContextItem = Omit<AddTagContextItemInput, "contextSetId" | "createdBy">;

function parseDesiredPermissionSet(value: unknown): {
  readonly name: string;
  readonly approvers: readonly string[];
  readonly permissions: readonly DesiredPermission[];
} {
  const resource = parseNamedDesiredResource(value, "PermissionSet");
  const permissions = resource.spec["permissions"];
  if (!Array.isArray(permissions))
    throw new Error("PermissionSet spec.permissions must be an array");
  let approvers: string[];
  try {
    approvers = normalizeApprovers(resource.spec["approvers"]);
  } catch (error) {
    throw new Error(`PermissionSet spec.${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    name: resource.name,
    approvers,
    permissions: permissions.map((permission) => {
      if (!isRecord(permission)) throw new Error("PermissionSet permission must be an object");
      const target = requiredString(permission["target"], "target");
      const action = requiredString(permission["action"], "action");
      const approvalValue = permission["approval"];
      if (approvalValue !== undefined && approvalValue !== "required")
        throw new Error("PermissionSet permission approval must be required when present");
      const approval = approvalValue === "required" ? { approval: "required" as const } : {};
      if (target === "runtime") return { target, action, ...approval };
      if (target === "mcp") {
        const unknown = Object.keys(permission).filter(
          (key) => !["target", "action", "resource", "approval"].includes(key),
        );
        if (unknown.length > 0)
          throw new Error(
            `PermissionSet mcp permission ${action} does not take ${unknown.join(", ")}; use target, action, resource, and approval`,
          );
        parseMcpGrantAction(action);
        const rawResource = permission["resource"];
        if (rawResource !== undefined && typeof rawResource !== "string")
          throw new Error(`PermissionSet mcp permission ${action} resource must be a string`);
        const resource = rawResource?.trim();
        if (resource) parseMcpGrantResource(resource);
        return { target, action, ...(resource ? { resource } : {}), ...approval };
      }
      if (target !== "surface") {
        throw new Error("PermissionSet permission target must be surface, runtime, or mcp");
      }
      const reference = stringValue(permission["reference"])?.trim();
      return {
        target,
        surfaceAccountId: requiredString(permission["surfaceAccountId"], "surfaceAccountId"),
        scope: requiredString(permission["scope"], "scope"),
        action,
        ...(reference ? { reference } : {}),
        ...approval,
      };
    }),
  };
}

function parseDesiredContextSet(value: unknown): {
  readonly name: string;
  readonly items: readonly DesiredContextItem[];
} {
  const resource = parseNamedDesiredResource(value, "ContextSet");
  const items = resource.spec["items"];
  if (!Array.isArray(items)) throw new Error("ContextSet spec.items must be an array");
  return {
    name: resource.name,
    items: items.map((item) => {
      if (!isRecord(item)) throw new Error("ContextSet item must be an object");
      const version = item["version"];
      const required = item["required"];
      const config = item["config"];
      if (!Number.isInteger(version) || Number(version) < 1)
        throw new Error("ContextSet item version must be a positive integer");
      if (typeof required !== "boolean")
        throw new Error("ContextSet item required must be boolean");
      if (!isRecord(config)) throw new Error("ContextSet item config must be an object");
      return {
        itemKey: requiredString(item["itemKey"], "itemKey"),
        type: requiredString(item["type"], "type"),
        version: Number(version),
        required,
        config,
      };
    }),
  };
}

interface DesiredRole {
  readonly name: string;
  readonly purpose: string;
  readonly instructions: string;
  readonly contextSets: readonly string[];
  readonly permissionSets: readonly string[];
  /** Absent leaves execution settings to whichever manager set them. */
  readonly execution?: ExecutionSettings;
}

function parseDesiredRole(value: unknown): DesiredRole {
  const resource = parseNamedDesiredResource(value, "Role");
  const allowed = new Set([
    "purpose",
    "instructions",
    "contextSets",
    "permissionSets",
    "execution",
  ]);
  const unknown = Object.keys(resource.spec).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(`Role spec contains unknown fields: ${unknown.join(", ")}`);
  const execution = parseExecutionSettings(resource.spec["execution"], "Role spec.execution");
  const strings = (key: "contextSets" | "permissionSets"): readonly string[] => {
    const values = resource.spec[key] ?? [];
    if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !item.trim()))
      throw new Error(`Role spec.${key} must be a string array`);
    if (new Set(values).size !== values.length)
      throw new Error(`Role spec.${key} must not contain duplicates`);
    return values.map((item) => item.trim());
  };
  const purpose = requiredString(resource.spec["purpose"], "Role spec.purpose");
  const instructions = stringValue(resource.spec["instructions"] ?? "");
  if (instructions === undefined) throw new Error("Role spec.instructions must be text");
  const contextSets = strings("contextSets");
  const permissionSets = strings("permissionSets");
  return {
    name: resource.name,
    purpose,
    instructions,
    contextSets,
    permissionSets,
    ...(execution === undefined ? {} : { execution }),
  };
}

/** Validates a Volume manifest; its spec must name a source. */
function parseDesiredVolume(value: unknown): ApplyVolumeInput {
  const resource = parseNamedDesiredResource(value, "Volume");
  try {
    return {
      name: parseVolumeName(resource.name, "Volume metadata.name"),
      ...parseVolumeSpec(resource.spec),
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

/** Validates a Workspace manifest; an omitted spec takes every default. */
function parseDesiredWorkspace(value: unknown): ApplyWorkspaceInput {
  const resource = parseNamedDesiredResource(
    isRecord(value) && value["spec"] === undefined ? { ...value, spec: {} } : value,
    "Workspace",
  );
  try {
    return {
      name: parseWorkspaceName(resource.name, "Workspace metadata.name"),
      ...parseWorkspaceSpec(resource.spec),
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function withoutName({ name: _name, ...spec }: ApplyWorkspaceInput) {
  return spec;
}

function parseNamedDesiredResource(
  value: unknown,
  kind: "ContextSet" | "PermissionSet" | "Role" | "Volume" | "Workspace",
): { readonly name: string; readonly spec: Record<string, unknown> } {
  if (
    !isRecord(value) ||
    value["apiVersion"] !== CONTROL_PLANE_API_VERSION ||
    value["kind"] !== kind ||
    !isRecord(value["metadata"]) ||
    !isRecord(value["spec"])
  ) {
    throw new Error(`${kind} resource is invalid`);
  }
  return {
    name: requiredString(value["metadata"]["name"], `${kind} metadata.name`),
    spec: value["spec"],
  };
}

async function roleResourceFromStore(store: Store, role: Role) {
  const [assignments, contextSets, permissionSets, tags] = await Promise.all([
    store.listRoleAssignments({ roleId: role.id }),
    store.listTagContextSets(),
    store.listTagPermissionSets(),
    store.listTags(),
  ]);
  return roleResource(role, assignments, {
    contextSets: new Map(contextSets.map((set) => [set.id, set.name])),
    permissionSets: new Map(permissionSets.map((set) => [set.id, set.name])),
    tags: new Map(tags.map((tag) => [tag.id, tag.name])),
  });
}

async function tagResourceFromStore(store: Store, tag: Tag) {
  const [routes, assignments, bindings, roles, accounts, organization, grants] = await Promise.all([
    store.listTagRoutes({ tagId: tag.id }),
    store.listRoleAssignments({ tagId: tag.id }),
    store.listTagWorkerHostBindings(tag.id),
    store.listRoles(),
    store.listSurfaceAccounts(),
    tagOrganizationFromStore(store),
    recipientGrants(store, tag),
  ]);
  return tagResource(
    tag,
    routes,
    assignments,
    bindings.map((binding) => binding.workerHostId),
    new Map(roles.map((role) => [role.id, role.name])),
    new Map(accounts.map((account) => [account.id, account])),
    { ...organization, grants },
    new Map(roles.map((role) => [role.id, role])),
  );
}

function permissionKey(permission: DesiredPermission | TagPermission): string {
  if (permission.target === "runtime")
    return JSON.stringify([permission.target, permission.action]);
  if (permission.target === "mcp")
    return JSON.stringify([permission.target, permission.action, permission.resource ?? null]);
  return JSON.stringify([
    permission.target,
    permission.surfaceAccountId,
    permission.scope,
    permission.reference ?? null,
    permission.action,
  ]);
}

function contextItemValue(item: TagContextItem): DesiredContextItem {
  return {
    itemKey: item.itemKey,
    type: item.type,
    version: item.version,
    required: item.required,
    config: item.config,
  };
}

/**
 * Declarative Surface Accounts. The body is a SurfaceAccount manifest whose secrets are
 * references. A plan compares the non-secret fields; with `credentials`, the resolved values, it
 * also reports whether they match what the credential vault holds, without storing or returning
 * them. A write with `verified`, the account its provider verified, stores it exactly as
 * `supertag setup surface` does. A write without `verified` only records field ownership and set
 * membership, and is refused if anything would change.
 */
async function applySurfaceAccountManifest(
  context: ResourceApplyContext,
  body: unknown,
  options: ManagedWriteOptions,
  surface: SurfaceAccountWrite,
): Promise<PlannedResource | WrittenResource> {
  const manifest = parseSurfaceAccountManifest(body);
  const existing = await context.store.findSurfaceAccountByName(manifest.name);
  const plan = await planWrite(context.store, options, {
    kind: "SurfaceAccount",
    name: manifest.name,
    currentSpec: existing ? storedSurfaceAccountSpec(existing) : undefined,
    desiredSpec: surfaceManifestSpec(manifest),
  });
  const refusals =
    existing !== undefined && existing.provider !== manifest.provider
      ? [
          {
            path: "spec.provider",
            reason: `${manifest.name} is a ${existing.provider} account. Delete it, then apply the ${manifest.provider} account under a new name`,
          },
        ]
      : [];
  if (options.dryRun) {
    const credentials = surface.credentials;
    const secrets =
      credentials === undefined
        ? undefined
        : existing !== undefined &&
            sameCredential(
              await context.credentialVault.resolve(existing.credentialId),
              credentials,
            )
          ? ("unchanged" as const)
          : ("changed" as const);
    return {
      ...dryRunResource(body),
      spec: plan.spec,
      plan: {
        ...planReport(plan),
        refusals,
        ...(secrets === undefined ? {} : { secrets }),
      },
      ...(existing === undefined
        ? {}
        : {
            current: {
              provider: existing.provider,
              externalAccountId: existing.externalAccountId,
            },
          }),
    };
  }
  if (refusals.length > 0)
    throw new TagMessagingError(
      409,
      `SurfaceAccount ${manifest.name}: ${refusals.map((refusal) => refusal.reason).join("; ")}`,
    );
  const unwritten = withoutWriting(body, plan, options);
  if (unwritten !== undefined) return unwritten;
  const verified = surface.verified;
  if (verified === undefined) {
    if (existing === undefined || plan.merge.changes.length > 0)
      throw new Error(
        `SurfaceAccount ${manifest.name} changes require credentials verified with the provider; apply it with supertag apply`,
      );
    await recordWrite(context.store, plan, storedSurfaceAccountSpec(existing), options);
    return {};
  }
  if (verified.provider !== manifest.provider)
    throw new Error(
      `SurfaceAccount ${manifest.name} declares ${manifest.provider}, but its credentials are for ${verified.provider}`,
    );
  const expectedKeys = Object.keys(manifest.secrets).toSorted().join(",");
  if (Object.keys(verified.secrets).toSorted().join(",") !== expectedKeys)
    throw new Error(
      `SurfaceAccount ${manifest.name} credentials must hold exactly ${expectedKeys.replaceAll(",", ", ")}`,
    );
  if (existing !== undefined && existing.externalAccountId !== verified.externalAccountId)
    throw new TagMessagingError(
      409,
      `SurfaceAccount ${manifest.name} is ${existing.provider} account ${existing.externalAccountId}, but its credentials belong to ${verified.externalAccountId}. Delete it, then apply the other account under a new name`,
    );
  const holder = await context.store.findSurfaceAccount(
    verified.provider,
    verified.externalAccountId,
  );
  if (holder?.name !== undefined && holder.name !== manifest.name)
    throw new TagMessagingError(
      409,
      `${verified.provider} account ${verified.externalAccountId} is already declared as SurfaceAccount ${holder.name}`,
    );
  const merged = plan.spec as Partial<SurfaceAccountManifestSpec>;
  const account = await context.controlPlane.setupSurfaceAccount(
    {
      ...verified,
      displayName:
        typeof merged.displayName === "string" ? merged.displayName : verified.displayName,
    },
    { name: manifest.name, secretReferences: merged.secrets ?? manifest.secrets },
  );
  await recordWrite(context.store, plan, storedSurfaceAccountSpec(account), options);
  return {};
}

/** A stored account in manifest form, as field management compares it. */
function storedSurfaceAccountSpec(account: SurfaceAccount): SurfaceAccountManifestSpec {
  if (account.provider === "cli") throw new Error("The CLI conversation account is built in");
  return {
    provider: account.provider,
    displayName: account.displayName,
    configuration: declaredConfiguration({ ...account, provider: account.provider }),
    secrets: account.secretReferences ?? {},
  };
}

/** Starts a created Objective's conversation; refused while the Control Plane drains. */
function objectiveStarter(
  context: ResourceApplyContext,
  retry: string,
): {
  readonly runnable: (objective: Objective) => Promise<{ readonly reasons: readonly string[] }>;
  readonly start: (objective: Objective) => Promise<{ readonly taskId: string }>;
} {
  return {
    runnable: (objective) => context.controlPlane.objectives.objectiveRunnable(objective),
    start: async (objective) => {
      if (!context.controlPlane.isAccepting)
        throw new TagMessagingError(503, `The Control Plane is draining; ${retry}`);
      return await context.controlPlane.startObjective(objective.id);
    },
  };
}

/** Applies, or plans, one Objective manifest under field ownership. */
async function applyObjectiveDocument(
  context: ResourceApplyContext,
  body: unknown,
  options: ManagedWriteOptions,
  principal: CoordinationOperatorPrincipal | undefined,
): Promise<PlannedResource | WrittenResource> {
  if (options.imperative)
    throw new TagMessagingError(
      400,
      "Change an Objective imperatively with supertag update objective; apply takes manifests",
    );
  const store = context.store;
  const { name, spec } = parseObjectiveManifest(body);
  const plan = await planObjectiveManifest(store, { name, spec, options });
  if (options.dryRun)
    return { ...dryRunResource(body), spec: plan.managed.spec, plan: objectivePlanReport(plan) };
  if (plan.refusals.length > 0) throw new TagMessagingError(409, objectiveRefusalMessage(plan));
  if (plan.held !== undefined && plan.objective !== undefined) return { warnings: [plan.held] };
  if (plan.managed.merge.conflicts.length > 0)
    throw new TagMessagingError(409, conflictMessage(plan.managed));
  if (principal === undefined)
    throw new TagMessagingError(403, "Applying an Objective needs an operator");
  const starter = objectiveStarter(context, "apply again later to start the Objective");
  const result = await applyObjectiveManifest(
    {
      store,
      create: async (definition, ownerTagId) => {
        const parsed = parseCreateObjective(definition);
        const runtime = await resolveOwnerObjectiveRuntimeActions(store, {
          objectiveId: parsed.id,
          ownerTagId,
          ...(definition["runtimeActions"] === undefined
            ? {}
            : { requested: parsed.runtimeActions ?? [] }),
        });
        return {
          objective: await store.createObjective({
            ...parsed,
            runtimeActions: runtime.runtimeActions,
            ownerTagId,
          }),
          warnings: runtime.warnings,
        };
      },
      update: async (objective, change) => {
        const runtime =
          change.runtimeActions === undefined
            ? undefined
            : await resolveOwnerObjectiveRuntimeActions(store, {
                objectiveId: objective.id,
                ownerTagId: objective.ownerTagId,
                requested: change.runtimeActions,
              });
        return {
          objective: await store.updateObjectiveStatus(
            objective.id,
            {
              ...change,
              ...(runtime === undefined ? {} : { runtimeActions: runtime.runtimeActions }),
              expectedRevision: objective.revision,
            },
            undefined,
            undefined,
            { operatorId: principal.operatorId },
          ),
          warnings: runtime?.warnings ?? [],
        };
      },
      start: starter.start,
      runnable: starter.runnable,
    },
    plan,
  );
  await recordManagedWrite(
    store,
    plan.managed,
    (await objectiveResource(store, await store.getObjective(name))).spec,
    options,
  );
  return {
    warnings: result.warnings,
    ...(result.started === undefined ? {} : { started: result.started }),
    ...(result.notStarted === undefined ? {} : { notStarted: result.notStarted }),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value)?.trim();
  if (!result) throw new Error(`Surface ${name} is required`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
