import { createHash } from "node:crypto";
import type {
  AuthKey,
  AuthKeyPhase,
  ExecutionSettings,
  JsonRecord,
  OperatorToken,
  OperatorTokenPhase,
  Role,
  RoleAssignment,
  SurfaceAccount,
  Tag,
  TagContextActivation,
  TagContextItem,
  TagContextSet,
  TagMessagingGrant,
  TagPermission,
  TagPermissionActivation,
  TagPermissionSet,
  TagRoute,
  Volume,
  WorkerHost,
  Workspace,
} from "@supertag/core";
import {
  advertisedWorkspaces,
  advertisesWorkspaceClone,
  authKeyPhase,
  executionRange,
  operatorTokenOperatorId,
  operatorTokenPhase,
  workspaceEnvironmentRefusals,
} from "@supertag/core";
import type {
  CapabilityIdentifier,
  ContextTypeSupport,
  WorkerDescriptor,
  WorkerHostDescriptor,
  WorkerProfileCapabilities,
  WorkerProfileRef,
} from "@supertag/worker-sdk";
import type { OperatorReadStore } from "./operator-seams.js";
import type { HostStorageEvidence } from "./storage-durability.js";
import { type PreparedWorkspaceStatus, preparedWorkspaceOf } from "./work-views.js";
import { workerHostStorage } from "./worker-host-storage.js";

export const CONTROL_PLANE_API_VERSION = "supertag/v1" as const;

export interface ResourceMetadata {
  readonly id: string;
  readonly name?: string;
  readonly resourceVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ControlPlaneResource<
  Kind extends string,
  Spec extends JsonRecord,
  Status extends JsonRecord,
> {
  readonly apiVersion: typeof CONTROL_PLANE_API_VERSION;
  readonly kind: Kind;
  readonly metadata: ResourceMetadata;
  readonly spec: Spec;
  readonly status: Status;
}

export interface ControlPlaneResourceList<Item> {
  readonly apiVersion: typeof CONTROL_PLANE_API_VERSION;
  readonly kind: "ResourceList";
  readonly metadata: { readonly resourceVersion: string };
  readonly items: readonly Item[];
}

/**
 * One place where a Tag answers, in manifest form. Scope fields use the camelCase spelling of the
 * `supertag update tag --add-location` flags; `account` is the Surface Account's external ID.
 */
export type TagLocationSpec = {
  readonly provider: SurfaceAccount["provider"];
  readonly account?: string;
  readonly channelId?: string;
  readonly chatId?: string;
  readonly teamId?: string;
  readonly team?: string;
  readonly repoId?: string;
  readonly repo?: string;
  readonly permissionSets?: readonly string[];
  readonly contextSets?: readonly string[];
  /** Workspaces an Objective created from this location names, in order. */
  readonly workspaces?: readonly string[];
};

export type TagResource = ControlPlaneResource<
  "Tag",
  {
    readonly roles: readonly string[];
    readonly workerHosts: readonly string[];
    /** Labels a bound Worker Host must carry to run this Tag's Tasks; placement only. */
    readonly runsOn: readonly string[];
    /** Harness, models, and efforts this Tag allows; overrides its Roles' settings. */
    readonly execution?: ExecutionSettings;
    readonly locations: readonly TagLocationSpec[];
    /** Tags this Tag accepts Mailbox messages from beyond its Teams, by name. */
    readonly acceptsMessagesFrom: readonly string[];
  },
  {
    readonly phase: Tag["status"];
    /** Present once the Tag is retired. */
    readonly retiredAt?: string;
    /** The range its Tasks run in: the Tag's own settings, then its Roles' in name order. */
    readonly execution?: ExecutionSettings;
    readonly locations: readonly {
      readonly provider: SurfaceAccount["provider"];
      readonly account: string;
      readonly target: string;
      readonly enabled: boolean;
    }[];
  }
>;

export type SurfaceAccountResource = ControlPlaneResource<
  "SurfaceAccount",
  {
    readonly provider: SurfaceAccount["provider"];
    readonly externalAccountId: string;
    readonly displayName: string;
    readonly authMethod: string;
    readonly configuration: JsonRecord;
    /** Where each secret came from at the last manifest apply; references, never values. */
    readonly secrets?: SurfaceAccount["secretReferences"];
  },
  {
    readonly phase: SurfaceAccount["status"];
    readonly lastVerifiedAt: string;
  }
>;

export type PermissionSetResource = ControlPlaneResource<
  "PermissionSet",
  { readonly approvers?: readonly string[]; readonly permissions: readonly TagPermission[] },
  { readonly phase: "active"; readonly bindings: readonly string[] }
>;

export type ContextSetResource = ControlPlaneResource<
  "ContextSet",
  { readonly items: readonly TagContextItem[] },
  { readonly phase: "active"; readonly bindings: readonly string[] }
>;

export type RoleResource = ControlPlaneResource<
  "Role",
  {
    readonly purpose: string;
    readonly instructions: string;
    readonly contextSets: readonly string[];
    readonly permissionSets: readonly string[];
    /** Default harness, models, and efforts for the Role's Tags. */
    readonly execution?: ExecutionSettings;
  },
  {
    readonly phase: Role["status"];
    readonly assignedTags: readonly string[];
  }
>;

export type VolumeResource = ControlPlaneResource<
  "Volume",
  {
    readonly source: string;
    /** The credential's name; Worker Hosts map it to a secret. Never a value. */
    readonly credential?: string;
  },
  { readonly phase: "active" }
>;

export type WorkspaceResource = ControlPlaneResource<
  "Workspace",
  {
    readonly source?: string;
    readonly ref?: string;
    readonly setup?: string;
    readonly mcp?: readonly string[];
    readonly skills?: readonly string[];
    readonly skillCatalog?: Workspace["skillCatalog"];
    readonly mounts?: Workspace["mounts"];
    readonly delivery: Workspace["delivery"];
  },
  {
    readonly phase: "active";
    /** Enrolled Worker Hosts whose latest descriptor declares a checkout of this Workspace. */
    readonly workerHosts: readonly {
      readonly id: string;
      readonly connectionStatus: WorkerHost["connectionStatus"];
    }[];
    /**
     * Enrolled Worker Hosts that serve this Workspace, by environment provider, with the prepared
     * environment their latest Task Attempt reported. Only `describe workspace NAME` reads them.
     */
    readonly environments?: readonly WorkspaceEnvironmentStatus[];
  }
>;

/** How one Worker Host serves a Workspace: its environment provider and what it prepared. */
export interface WorkspaceEnvironmentStatus {
  readonly workerHostId: string;
  readonly connectionStatus: WorkerHost["connectionStatus"];
  /** `local`, or a remote sandbox provider such as `e2b` or `modal`. */
  readonly provider: string;
  /** The prepared environment the latest Task Attempt on this host reported, when any. */
  readonly prepared?: PreparedWorkspaceStatus & { readonly at: string };
  /** Why this host's provider refuses the Workspace's Tasks, when it does. */
  readonly refusal?: string;
}

export type WorkerHostResource = ControlPlaneResource<
  "WorkerHost",
  { readonly draining: boolean },
  {
    readonly phase: "connected" | "draining" | "ready" | "revoked" | "unreachable";
    readonly diskSpace?: { readonly freeBytes: number; readonly totalBytes: number };
    /** Joined with an ephemeral Auth Key; removed after it disconnects. */
    readonly ephemeral: boolean;
    /** Execution placement from Control Plane Attempt history, not current capabilities. */
    readonly storage?: HostStorageEvidence;
    /** The Auth Key this host redeemed to join, if any. */
    readonly authKey?: string;
    readonly credentialRevision: number;
    readonly connectionGeneration: number;
    readonly connectionStatus: WorkerHost["connectionStatus"];
    readonly workletId?: string;
    readonly protocolVersion?: number;
    readonly durableProtocolVersion?: number;
    readonly controlProtocolVersion?: number;
    readonly workers: WorkerHostDescriptor["workers"];
    /** Workspace names with a declared checkout on this host; paths stay on the host. */
    readonly workspaces: readonly string[];
    /** Placement labels: advertised by the host (self-reported) plus granted by its Auth Key. */
    readonly labels: readonly string[];
    /** Labels granted by the Auth Key the host redeemed. */
    readonly grantedLabels: readonly string[];
    readonly ready: boolean;
    readonly lastAuthenticatedAt?: string;
    readonly failedAuthenticationCount: number;
    readonly lastAuthenticationFailureAt?: string;
    readonly lastSeenAt?: string;
    readonly connectedAt?: string;
    readonly disconnectedAt?: string;
    readonly revokedAt?: string;
    readonly revocationReason?: string;
    readonly activeAttempts: number;
    readonly capacity: number;
    readonly availableSlots: number;
  }
>;

/** An Auth Key without its secret. The secret appears only once, in the create response. */
export type AuthKeyResource = ControlPlaneResource<
  "AuthKey",
  {
    readonly tags: readonly string[];
    /** Placement labels granted to every Worker Host that redeems the key. */
    readonly labels: readonly string[];
    readonly reusable: boolean;
    readonly ephemeral: boolean;
  },
  {
    readonly phase: AuthKeyPhase;
    readonly expiresAt: string;
    readonly usedAt?: string;
    readonly redemptionCount: number;
    readonly revokedAt?: string;
  }
>;

export function authKeyResource(
  key: AuthKey,
  tagNames: ReadonlyMap<string, string>,
): AuthKeyResource {
  const spec: AuthKeyResource["spec"] = {
    tags: key.tagIds.map((id) => tagNames.get(id) ?? id),
    labels: key.labels,
    reusable: key.reusable,
    ephemeral: key.ephemeral,
  };
  const status: AuthKeyResource["status"] = {
    phase: authKeyPhase(key),
    expiresAt: key.expiresAt,
    ...(key.usedAt === undefined ? {} : { usedAt: key.usedAt }),
    redemptionCount: key.redemptionCount,
    ...(key.revokedAt === undefined ? {} : { revokedAt: key.revokedAt }),
  };
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "AuthKey",
    metadata: {
      id: key.id,
      name: key.name,
      resourceVersion: resourceVersion({ id: key.id, updatedAt: key.updatedAt, spec, status }),
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
    },
    spec,
    status,
  };
}

/** An Operator Token without its secret. The secret appears only once, in the create response. */
export type OperatorTokenResource = ControlPlaneResource<
  "OperatorToken",
  Record<string, never>,
  {
    readonly phase: OperatorTokenPhase;
    /** The operator ID requests made with the token act as, such as `token:laptop-2`. */
    readonly operatorId: string;
    readonly expiresAt: string;
    readonly lastUsedAt?: string;
    readonly revokedAt?: string;
  }
>;

export function operatorTokenResource(token: OperatorToken): OperatorTokenResource {
  const status: OperatorTokenResource["status"] = {
    phase: operatorTokenPhase(token),
    operatorId: operatorTokenOperatorId(token.name),
    expiresAt: token.expiresAt,
    ...(token.lastUsedAt === undefined ? {} : { lastUsedAt: token.lastUsedAt }),
    ...(token.revokedAt === undefined ? {} : { revokedAt: token.revokedAt }),
  };
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "OperatorToken",
    metadata: {
      id: token.id,
      name: token.name,
      resourceVersion: resourceVersion({ id: token.id, updatedAt: token.updatedAt, status }),
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
    },
    spec: {},
    status,
  };
}

/** One-time response from enrollment or rotation; it never appears in ordinary resource reads. */
export interface WorkerHostCredentialIssuance {
  readonly apiVersion: typeof CONTROL_PLANE_API_VERSION;
  readonly kind: "WorkerHostCredential";
  readonly metadata: {
    readonly workerHostId: string;
    readonly issuedAt: string;
  };
  readonly credential: { readonly token: string };
}

export type WorkerProfileResource = ControlPlaneResource<
  "WorkerProfile",
  { readonly ref: WorkerProfileRef },
  {
    readonly phase: "available" | "unavailable";
    readonly workerHostId: string;
    readonly workletId: string;
    readonly workerId: string;
  }
>;

/** Everything outside the Tag row that its manifest form names. */
export interface TagOrganization {
  readonly permissionActivations: readonly TagPermissionActivation[];
  readonly contextActivations: readonly TagContextActivation[];
  readonly permissionSetNames: ReadonlyMap<string, string>;
  readonly contextSetNames: ReadonlyMap<string, string>;
  /** Grants involving the Tag; only those where it is the recipient are rendered. */
  readonly grants: readonly TagMessagingGrant[];
  readonly tagNames: ReadonlyMap<string, string>;
}

export function tagResource(
  tag: Tag,
  routes: readonly TagRoute[],
  assignments: readonly RoleAssignment[],
  workerHosts: readonly string[],
  roleNames: ReadonlyMap<string, string>,
  accounts: ReadonlyMap<string, SurfaceAccount>,
  organization: TagOrganization,
  roleRecords: ReadonlyMap<string, Role> = new Map(),
): TagResource {
  const activeAssignments = assignments.filter((assignment) => assignment.status === "active");
  const execution = executionRange(
    tag.execution,
    activeAssignments
      .map((assignment) => roleRecords.get(assignment.roleId))
      .filter((role): role is Role => role?.status === "active")
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((role) => role.execution),
  );
  const roles = activeAssignments
    .map((assignment) => roleNames.get(assignment.roleId) ?? assignment.roleId)
    .toSorted((left, right) => left.localeCompare(right));
  const routeAccount = (route: TagRoute) => {
    const account = accounts.get(route.surfaceAccountId);
    if (!account) throw new Error(`Surface account ${route.surfaceAccountId} is unavailable`);
    return account;
  };
  const locations = routes
    .map((route) => {
      const account = routeAccount(route);
      return {
        provider: account.provider,
        account: account.displayName,
        target: route.scope,
        enabled: route.enabled,
      };
    })
    .toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.account.localeCompare(right.account) ||
        left.target.localeCompare(right.target),
    );
  const specLocations = canonicalTagLocations(
    routes.map((route) => {
      const account = routeAccount(route);
      return {
        provider: account.provider,
        account: account.externalAccountId,
        ...tagLocationScopeFields(account.provider, route.scope),
        permissionSets: organization.permissionActivations
          .filter((activation) => activation.tagRouteId === route.id)
          .map(
            (activation) =>
              organization.permissionSetNames.get(activation.permissionSetId) ??
              activation.permissionSetId,
          ),
        contextSets: organization.contextActivations
          .filter((activation) => activation.tagRouteId === route.id)
          .map(
            (activation) =>
              organization.contextSetNames.get(activation.contextSetId) ?? activation.contextSetId,
          ),
        workspaces: route.workspaces,
      };
    }),
  );
  const acceptsMessagesFrom = canonicalMailboxGrants(
    organization.grants
      .filter((grant) => grant.recipientTagId === tag.id)
      .map((grant) => organization.tagNames.get(grant.senderTagId) ?? grant.senderTagId),
  );
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Tag",
    metadata: {
      id: tag.id,
      name: tag.name,
      resourceVersion: resourceVersion({
        tag,
        roles,
        assignments: activeAssignments.map((assignment) => ({
          id: assignment.id,
          revision: assignment.revision,
          roleId: assignment.roleId,
        })),
        workerHosts,
        routes: routes.map((route) => ({
          id: route.id,
          updatedAt: route.updatedAt,
          enabled: route.enabled,
        })),
        specLocations,
        acceptsMessagesFrom,
      }),
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt,
    },
    spec: {
      roles,
      workerHosts: [...workerHosts].toSorted(),
      runsOn: tag.runsOn,
      ...(tag.execution === undefined ? {} : { execution: tag.execution }),
      locations: specLocations,
      acceptsMessagesFrom,
    },
    status: {
      phase: tag.status,
      ...(tag.retiredAt === undefined ? {} : { retiredAt: tag.retiredAt }),
      ...(Object.keys(execution).length === 0 ? {} : { execution }),
      locations,
    },
  };
}

/** Reverses a stored route scope into the location fields a manifest uses. */
export function tagLocationScopeFields(
  provider: SurfaceAccount["provider"],
  scope: string,
): Pick<TagLocationSpec, "channelId" | "chatId" | "teamId" | "repoId"> {
  const match = (pattern: RegExp) => pattern.exec(scope)?.slice(1);
  if (provider === "slack") {
    const [channelId] = match(/^channel:(.+)$/u) ?? [];
    if (channelId) return { channelId };
  } else if (provider === "lark") {
    const [chatId] = match(/^chat:(.+)$/u) ?? [];
    if (chatId) return { chatId };
  } else if (provider === "teams") {
    const [teamId, channelId] = match(/^team:(.+?)\/channel:(.+)$/u) ?? [];
    if (teamId && channelId) return { teamId, channelId };
  } else if (provider === "github") {
    const [repoId] = match(/^repository:(.+)$/u) ?? [];
    if (repoId) return { repoId };
  } else {
    const [teamId] = match(/^team:(.+)$/u) ?? [];
    if (teamId) return { teamId };
  }
  throw new Error(`Unrecognized ${provider} location scope ${JSON.stringify(scope)}`);
}

/** One ordering and shape for stored and desired locations, so diff compares like with like. */
export function canonicalTagLocations(
  locations: readonly TagLocationSpec[],
): readonly TagLocationSpec[] {
  return locations
    .map(({ permissionSets, contextSets, workspaces, ...location }) => {
      const sorted = (names: readonly string[] | undefined) =>
        [...new Set(names ?? [])].toSorted((left, right) => left.localeCompare(right));
      const permission = sorted(permissionSets);
      const context = sorted(contextSets);
      return {
        ...location,
        ...(permission.length > 0 ? { permissionSets: permission } : {}),
        ...(context.length > 0 ? { contextSets: context } : {}),
        // Order is kept: an Objective's first Workspace serves its owner's first Task.
        ...(workspaces !== undefined && workspaces.length > 0
          ? { workspaces: [...new Set(workspaces)] }
          : {}),
      };
    })
    .toSorted((left, right) => locationSortKey(left).localeCompare(locationSortKey(right)));
}

function locationSortKey(location: TagLocationSpec): string {
  return JSON.stringify([
    location.provider,
    location.account ?? "",
    location.teamId ?? location.team ?? "",
    location.channelId ?? location.chatId ?? location.repoId ?? location.repo ?? "",
  ]);
}

/** Sender Tag names, distinct and sorted, so diff compares like with like. */
export function canonicalMailboxGrants(senders: readonly string[]): readonly string[] {
  return [...new Set(senders)].toSorted((left, right) => left.localeCompare(right));
}

export function surfaceAccountResource(account: SurfaceAccount): SurfaceAccountResource {
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "SurfaceAccount",
    metadata: {
      id: account.id,
      // Accounts set up interactively have no manifest name; their provider identity names them.
      name: account.name ?? `${account.provider}:${account.externalAccountId}`,
      resourceVersion: account.updatedAt,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
    spec: {
      provider: account.provider,
      externalAccountId: account.externalAccountId,
      displayName: account.displayName,
      authMethod: account.authMethod,
      configuration: account.configuration,
      ...(account.secretReferences === undefined ? {} : { secrets: account.secretReferences }),
    },
    status: { phase: account.status, lastVerifiedAt: account.verifiedAt },
  };
}

export function permissionSetResource(
  set: TagPermissionSet,
  permissions: readonly TagPermission[],
  activations: readonly TagPermissionActivation[],
): PermissionSetResource {
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "PermissionSet",
    metadata: {
      id: set.id,
      name: set.name,
      resourceVersion: resourceVersion({ set, permissions, activations }),
      createdAt: set.createdAt,
      updatedAt: set.updatedAt,
    },
    spec: {
      ...(set.approvers?.length ? { approvers: [...set.approvers] } : {}),
      permissions,
    },
    status: {
      phase: "active",
      bindings: activations.map((activation) => activation.tagRouteId),
    },
  };
}

export function contextSetResource(
  set: TagContextSet,
  items: readonly TagContextItem[],
  activations: readonly TagContextActivation[],
): ContextSetResource {
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "ContextSet",
    metadata: {
      id: set.id,
      name: set.name,
      resourceVersion: resourceVersion({ set, items, activations }),
      createdAt: set.createdAt,
      updatedAt: set.updatedAt,
    },
    spec: {
      items,
    },
    status: {
      phase: "active",
      bindings: activations.map((activation) => activation.tagRouteId),
    },
  };
}

export function roleResource(
  role: Role,
  assignments: readonly RoleAssignment[],
  names: {
    readonly contextSets: ReadonlyMap<string, string>;
    readonly permissionSets: ReadonlyMap<string, string>;
    readonly tags: ReadonlyMap<string, string>;
  },
): RoleResource {
  const assignedTags = assignments
    .filter((assignment) => assignment.status === "active")
    .map((assignment) => names.tags.get(assignment.tagId) ?? assignment.tagId)
    .toSorted((left, right) => left.localeCompare(right));
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Role",
    metadata: {
      id: role.id,
      name: role.name,
      resourceVersion: resourceVersion({ role, assignedTags }),
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    },
    spec: {
      purpose: role.purpose,
      instructions: role.instructions,
      contextSets: role.contextSetIds.map((id) => names.contextSets.get(id) ?? id),
      permissionSets: role.permissionSetIds.map((id) => names.permissionSets.get(id) ?? id),
      ...(role.execution === undefined ? {} : { execution: role.execution }),
    },
    status: {
      phase: role.status,
      assignedTags,
    },
  };
}

export function volumeResource(volume: Volume): VolumeResource {
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Volume",
    metadata: {
      id: volume.id,
      name: volume.name,
      resourceVersion: resourceVersion({ volume }),
      createdAt: volume.createdAt,
      updatedAt: volume.updatedAt,
    },
    spec: {
      source: volume.source,
      ...(volume.credential === undefined ? {} : { credential: volume.credential }),
    },
    status: { phase: "active" },
  };
}

export function workspaceResource(
  workspace: Workspace,
  hosts: readonly WorkerHost[],
  environments?: readonly WorkspaceEnvironmentStatus[],
): WorkspaceResource {
  const workerHosts = hosts
    .filter(
      (host) =>
        host.enrollmentStatus === "active" &&
        advertisedWorkspaces(host.workerSnapshot).includes(workspace.name),
    )
    .map((host) => ({ id: host.id, connectionStatus: host.connectionStatus }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const spec: WorkspaceResource["spec"] = {
    ...(workspace.source === undefined ? {} : { source: workspace.source }),
    ...(workspace.ref === undefined ? {} : { ref: workspace.ref }),
    ...(workspace.setup === undefined ? {} : { setup: workspace.setup }),
    ...(workspace.mcp === undefined ? {} : { mcp: workspace.mcp }),
    ...(workspace.skills === undefined ? {} : { skills: workspace.skills }),
    ...(workspace.skillCatalog === undefined ? {} : { skillCatalog: workspace.skillCatalog }),
    ...(workspace.mounts === undefined ? {} : { mounts: workspace.mounts }),
    delivery: workspace.delivery,
  };
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Workspace",
    metadata: {
      id: workspace.id,
      name: workspace.name,
      resourceVersion: resourceVersion({ workspace, workerHosts }),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    },
    spec,
    status: {
      phase: "active",
      workerHosts,
      ...(environments === undefined ? {} : { environments }),
    },
  };
}

/** How many recent Tasks `describe workspace` reads for prepared environments. */
const PREPARED_ENVIRONMENT_TASK_SCAN = 200;

/**
 * Each enrolled Worker Host that serves a Workspace, by environment provider, with the prepared
 * environment its latest Task Attempt reported. Hosts are the authority for what they prepared;
 * the Control Plane learns digest, provider, and trusted commit only from Attempt provenance.
 */
export async function workspaceEnvironments(
  store: Pick<OperatorReadStore, "listTasks" | "listTaskAttempts" | "listTaskEvents">,
  workspace: Workspace,
  hosts: readonly WorkerHost[],
): Promise<readonly WorkspaceEnvironmentStatus[]> {
  const prepared = new Map<string, PreparedWorkspaceStatus & { readonly at: string }>();
  const tasks = (await store.listTasks({ limit: PREPARED_ENVIRONMENT_TASK_SCAN })).filter(
    (task) =>
      task.workspacePlan?.status === "workspace" && task.workspacePlan.workspace === workspace.name,
  );
  for (const task of tasks) {
    const [attempts, events] = await Promise.all([
      store.listTaskAttempts(task.id),
      store.listTaskEvents(task.id),
    ]);
    for (const attempt of attempts.toSorted((a, b) => b.attemptNumber - a.attemptNumber)) {
      const host = text(attempt.workerSnapshot["workerHostId"]);
      if (host === undefined) continue;
      const attemptEvents = events.filter((event) => event.attemptId === attempt.id);
      const reported = preparedWorkspaceOf(attemptEvents);
      const at = attemptEvents.findLast(
        (event) => event.type === "runtime-inputs.resolved",
      )?.createdAt;
      if (reported === undefined || at === undefined) continue;
      const known = prepared.get(host);
      if (known === undefined || known.at < at) prepared.set(host, { ...reported, at });
    }
  }
  return hosts
    .filter((host) => host.enrollmentStatus === "active")
    .flatMap((host): WorkspaceEnvironmentStatus[] => {
      const provider = environmentProviderOf(host.workerSnapshot);
      const reported = prepared.get(host.id);
      const serves =
        reported !== undefined ||
        advertisedWorkspaces(host.workerSnapshot).includes(workspace.name) ||
        (workspace.source !== undefined &&
          (provider !== "local" || advertisesWorkspaceClone(host.workerSnapshot)));
      if (provider === undefined || !serves) return [];
      const refusal =
        provider === "local" ? undefined : workspaceEnvironmentRefusals(host.workerSnapshot)[0];
      return [
        {
          workerHostId: host.id,
          connectionStatus: host.connectionStatus,
          provider: reported?.provider ?? provider,
          ...(reported === undefined ? {} : { prepared: reported }),
          ...(refusal === undefined ? {} : { refusal }),
        },
      ];
    })
    .toSorted((left, right) => left.workerHostId.localeCompare(right.workerHostId));
}

const REMOTE_SANDBOX_CAPABILITY =
  /^supertag\.execution\.remote-sandbox\.([a-z0-9][a-z0-9_-]{0,62})$/u;

/** The environment provider a host's profiles advertise: a remote sandbox, else local. */
function environmentProviderOf(snapshot: Readonly<Record<string, unknown>>): string | undefined {
  const workers = Array.isArray(snapshot["workers"]) ? snapshot["workers"] : [];
  const ids = workers.flatMap((worker) =>
    isRecord(worker) && Array.isArray(worker["profileCapabilities"])
      ? worker["profileCapabilities"].flatMap((profile) =>
          isRecord(profile) && Array.isArray(profile["capabilities"])
            ? profile["capabilities"].flatMap((capability) =>
                isRecord(capability) && typeof capability["id"] === "string"
                  ? [capability["id"]]
                  : [],
              )
            : [],
        )
      : [],
  );
  for (const id of ids) {
    const remote = REMOTE_SANDBOX_CAPABILITY.exec(id)?.[1];
    if (remote !== undefined) return remote;
  }
  return ids.includes("supertag.execution.local-process") ? "local" : undefined;
}

/** Read storage evidence once for a host list, including disconnected hosts. */
export async function workerHostResourcesFromStore(
  store: Parameters<typeof workerHostStorage>[0],
  hosts: readonly WorkerHost[],
): Promise<WorkerHostResource[]> {
  const storage = await workerHostStorage(store, hosts);
  return hosts.map((host) => workerHostResource(host, storage.get(host.id)));
}

export function workerHostResource(
  host: WorkerHost,
  storage?: HostStorageEvidence,
): WorkerHostResource {
  const descriptor = workerHostDescriptor(host);
  const phase =
    host.enrollmentStatus === "revoked"
      ? "revoked"
      : host.connectionStatus === "disconnected"
        ? "unreachable"
        : host.draining
          ? "draining"
          : host.ready
            ? "ready"
            : "connected";
  const spec: WorkerHostResource["spec"] = { draining: host.draining };
  const diskSpace = diskSpaceFromSnapshot(host.workerSnapshot);
  const status: WorkerHostResource["status"] = {
    phase,
    ...(diskSpace === undefined ? {} : { diskSpace }),
    ephemeral: host.ephemeral,
    ...(storage === undefined ? {} : { storage }),
    ...(host.authKey === undefined ? {} : { authKey: host.authKey }),
    credentialRevision: host.credentialRevision,
    connectionGeneration: host.connectionGeneration,
    connectionStatus: host.connectionStatus,
    ...(host.workletId === undefined ? {} : { workletId: host.workletId }),
    ...(host.protocolVersion === undefined ? {} : { protocolVersion: host.protocolVersion }),
    ...(host.durableProtocolVersion === undefined
      ? {}
      : { durableProtocolVersion: host.durableProtocolVersion }),
    ...(host.controlProtocolVersion === undefined
      ? {}
      : { controlProtocolVersion: host.controlProtocolVersion }),
    workers: descriptor?.workers ?? [],
    workspaces: advertisedWorkspaces(host.workerSnapshot),
    labels: host.labels,
    grantedLabels: host.grantedLabels,
    ready: host.ready,
    ...(host.lastAuthenticatedAt === undefined
      ? {}
      : { lastAuthenticatedAt: host.lastAuthenticatedAt }),
    failedAuthenticationCount: host.failedAuthenticationCount,
    ...(host.lastAuthenticationFailureAt === undefined
      ? {}
      : { lastAuthenticationFailureAt: host.lastAuthenticationFailureAt }),
    ...(host.lastSeenAt === undefined ? {} : { lastSeenAt: host.lastSeenAt }),
    ...(host.connectedAt === undefined ? {} : { connectedAt: host.connectedAt }),
    ...(host.disconnectedAt === undefined ? {} : { disconnectedAt: host.disconnectedAt }),
    ...(host.revokedAt === undefined ? {} : { revokedAt: host.revokedAt }),
    ...(host.revocationReason === undefined ? {} : { revocationReason: host.revocationReason }),
    activeAttempts: host.activeAttempts,
    capacity: host.capacity,
    availableSlots: host.availableSlots,
  };
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "WorkerHost",
    metadata: {
      id: host.id,
      name: host.id,
      resourceVersion: resourceVersion({ id: host.id, updatedAt: host.updatedAt, spec, status }),
      createdAt: host.createdAt,
      updatedAt: host.updatedAt,
    },
    spec,
    status,
  };
}

export function workerProfileResources(
  descriptor: WorkerHostDescriptor,
  workletId: string,
  at: string,
): readonly WorkerProfileResource[] {
  return descriptor.workers.flatMap((worker) =>
    worker.profiles.map((ref) => ({
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "WorkerProfile" as const,
      metadata: {
        id: `${descriptor.id}:${worker.id}:${ref.id}@${ref.revision}`,
        name: `${ref.id}@${ref.revision}`,
        resourceVersion: resourceVersion({
          workerHostId: descriptor.id,
          workletId,
          workerId: worker.id,
          ref,
        }),
        createdAt: at,
        updatedAt: at,
      },
      spec: { ref },
      status: {
        phase: "available" as const,
        workerHostId: descriptor.id,
        workletId,
        workerId: worker.id,
      },
    })),
  );
}

export function workerProfileResourcesFromHost(
  host: WorkerHost,
  at: string,
): readonly WorkerProfileResource[] {
  const descriptor = workerHostDescriptor(host);
  if (descriptor === undefined || host.workletId === undefined) return [];
  return workerProfileResources(descriptor, host.workletId, at).map((profile) => ({
    ...profile,
    status: { ...profile.status, phase: host.ready ? "available" : "unavailable" },
  }));
}

export function workerHostCredentialIssuance(
  workerHostId: string,
  token: string,
  issuedAt: string,
): WorkerHostCredentialIssuance {
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "WorkerHostCredential",
    metadata: { workerHostId, issuedAt },
    credential: { token },
  };
}

export function resourceList<Item extends { readonly metadata: ResourceMetadata }>(
  items: readonly Item[],
): ControlPlaneResourceList<Item> {
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "ResourceList",
    metadata: {
      resourceVersion: resourceVersion(
        items.map((item) => ({
          id: item.metadata.id,
          resourceVersion: item.metadata.resourceVersion,
        })),
      ),
    },
    items,
  };
}

function resourceVersion(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function diskSpaceFromSnapshot(
  snapshot: Readonly<Record<string, unknown>>,
): { readonly freeBytes: number; readonly totalBytes: number } | undefined {
  const space = snapshot["diskSpace"];
  if (!isRecord(space)) return undefined;
  const freeBytes = space["freeBytes"];
  const totalBytes = space["totalBytes"];
  return typeof freeBytes === "number" && typeof totalBytes === "number"
    ? { freeBytes, totalBytes }
    : undefined;
}

function workerHostDescriptor(host: WorkerHost): WorkerHostDescriptor | undefined {
  const snapshot = host.workerSnapshot;
  if (snapshot["id"] !== host.id || !Array.isArray(snapshot["workers"])) return undefined;
  const workers = snapshot["workers"].map(workerDescriptor);
  if (workers.some((worker) => worker === undefined)) return undefined;
  return { id: host.id, workers: workers as readonly WorkerDescriptor[] };
}

/** One Worker of a Worklet's host descriptor; undefined when it is malformed. */
export function workerDescriptor(value: unknown): WorkerDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value["id"]);
  const type = text(value["type"]);
  const capabilities = array(value["capabilities"], capabilityIdentifier);
  const profiles = array(value["profiles"], workerProfileRef);
  const contextTypes = array(value["contextTypes"], contextTypeSupport);
  const profileCapabilities = array(value["profileCapabilities"], workerProfileCapabilities);
  const maxConcurrency = value["maxConcurrency"];
  if (
    id === undefined ||
    type === undefined ||
    capabilities === undefined ||
    profiles === undefined ||
    contextTypes === undefined ||
    profileCapabilities === undefined ||
    (maxConcurrency !== undefined &&
      (!Number.isSafeInteger(maxConcurrency) || Number(maxConcurrency) <= 0))
  )
    return undefined;
  return {
    id,
    type,
    capabilities,
    profiles,
    contextTypes,
    profileCapabilities,
    ...(maxConcurrency === undefined ? {} : { maxConcurrency: Number(maxConcurrency) }),
  };
}

function workerProfileCapabilities(value: unknown): WorkerProfileCapabilities | undefined {
  if (!isRecord(value)) return undefined;
  const profile = workerProfileRef(value["profile"]);
  const capabilities = array(value["capabilities"], capabilityIdentifier);
  const contextTypes = array(value["contextTypes"], contextTypeSupport);
  const harness = value["harness"] === undefined ? undefined : text(value["harness"]);
  const models = Array.isArray(value["models"])
    ? value["models"].filter((model): model is string => typeof model === "string")
    : undefined;
  const efforts = Array.isArray(value["efforts"])
    ? value["efforts"].filter((effort): effort is "low" | "medium" | "high" =>
        ["low", "medium", "high"].includes(effort as string),
      )
    : undefined;
  if (
    profile === undefined ||
    capabilities === undefined ||
    contextTypes === undefined ||
    (value["harness"] !== undefined && harness === undefined)
  )
    return undefined;
  return {
    profile,
    capabilities,
    contextTypes,
    ...(harness === undefined ? {} : { harness }),
    ...(models === undefined || models.length === 0 ? {} : { models }),
    ...(efforts === undefined || efforts.length === 0 ? {} : { efforts }),
  };
}

function workerProfileRef(value: unknown): WorkerProfileRef | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value["id"]);
  const revision = text(value["revision"]);
  return id === undefined || revision === undefined ? undefined : { id, revision };
}

function capabilityIdentifier(value: unknown): CapabilityIdentifier | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value["id"]);
  const version = value["version"];
  return id === undefined || !Number.isSafeInteger(version) || Number(version) <= 0
    ? undefined
    : { id, version: Number(version) };
}

function contextTypeSupport(value: unknown): ContextTypeSupport | undefined {
  if (!isRecord(value)) return undefined;
  const type = text(value["type"]);
  const versions = Array.isArray(value["versions"])
    ? value["versions"].map((version) =>
        Number.isSafeInteger(version) && Number(version) > 0 ? Number(version) : undefined,
      )
    : undefined;
  return type === undefined || versions === undefined || versions.includes(undefined)
    ? undefined
    : { type, versions: versions as readonly number[] };
}

function array<Item>(
  value: unknown,
  parse: (item: unknown) => Item | undefined,
): readonly Item[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parse);
  return parsed.includes(undefined) ? undefined : (parsed as readonly Item[]);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
