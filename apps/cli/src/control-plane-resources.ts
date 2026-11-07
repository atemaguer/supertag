import { createHash } from "node:crypto";
import {
  taskAttemptReportedCost,
  taskAttemptRunningCommand,
  taskAttemptWarnings,
  taskExecutionPlacementReport,
} from "@supertag/control-plane";
import type {
  AuthKey,
  AuthKeyPhase,
  ExecutionSettings,
  JsonRecord,
  MountManifest,
  MountOutputManifest,
  OperatorToken,
  OperatorTokenPhase,
  Role,
  RoleAssignment,
  Session,
  Store,
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
  Task,
  TaskStatus,
  Volume,
  WorkerHost,
  Workspace,
} from "@supertag/core";
import {
  advertisedWorkspaces,
  advertisesWorkspaceClone,
  authKeyPhase,
  currentUncertainAttempt,
  executionRange,
  operatorTokenOperatorId,
  operatorTokenPhase,
  placementHoldReason,
  SELF_ESCALATED_EVENT,
  type StoredOpenTaskFindings,
  storedOpenTaskFindings,
  type TaskDelivery,
  taskDelivery,
  uncertainAttemptRecoverCommand,
  unsandboxedCommandHoldsOf,
  WAIT_REGISTERED_EVENT,
  workspaceEnvironmentRefusals,
  workspacePullRequestFromEvents,
} from "@supertag/core";
import type {
  CapabilityIdentifier,
  ContextTypeSupport,
  WorkerDescriptor,
  WorkerHostDescriptor,
  WorkerProfileCapabilities,
  WorkerProfileRef,
} from "@supertag/worker-sdk";
import type { HostStorageEvidence } from "./storage-durability.js";
import { type TaskStorage, taskStorage } from "./task-storage.js";
import { workerHostStorage } from "./worker-host-storage.js";

export const CONTROL_PLANE_API_VERSION = "supertag/v1" as const;
/** Most objects of each `copy` mount a Task view lists per Attempt. */
export const TASK_VIEW_MOUNT_OBJECTS = 20;

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

/** A Mailbox grant where the Tag is the recipient. */
export type TagMailboxGrantSpec = { readonly tag: string; readonly types: readonly string[] };

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
    readonly acceptsMessagesFrom: readonly TagMailboxGrantSpec[];
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
    readonly builtIn: boolean;
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

/** A prepared Workspace environment as a Task Attempt's input provenance reports it. */
export interface PreparedWorkspaceStatus {
  readonly digest: string;
  readonly provider: string;
  readonly trustedCommit: string;
}

export type TaskResource = ControlPlaneResource<
  "Task",
  {
    readonly tagId: string;
    readonly sessionId: string;
    readonly execution: Task["execution"];
    readonly trigger: JsonRecord;
    /** The named Workspace and Task branch recorded when the Task was accepted. */
    readonly workspace?: {
      readonly name: string;
      readonly branch: string;
      readonly ref?: string;
      readonly delivery: string;
    };
  },
  {
    readonly phase: Task["status"];
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly outcome?: JsonRecord;
    readonly assignment?: JsonRecord;
    /** Open findings of the Task's result by severity, or why its stored findings are unreadable. */
    readonly openFindings?: StoredOpenTaskFindings;
    /** Findings on other Tasks this re-review result confirms fixed; acceptance closes them. */
    readonly fixedFindings?: readonly JsonRecord[];
    /** Team posts and direct messages delivered into this Task's running Attempts, latest 20. */
    readonly teamInput?: readonly {
      readonly at: string;
      readonly attemptId: string | null;
      readonly status: string;
      readonly itemKind: string;
      readonly itemId: string;
      readonly itemType: string;
      readonly senderTagId: string;
      readonly truncated: boolean;
    }[];
    /** What accepting this re-review did with each confirmed finding, with refusal reasons. */
    readonly findingClosures?: readonly JsonRecord[];
    readonly attempt?: JsonRecord;
    /** Every Task Attempt, oldest first, with its provider-reported cost when known. */
    readonly attempts?: readonly {
      readonly id: string;
      readonly number: number;
      readonly phase: string;
      readonly startedAt: string;
      readonly endedAt: string | null;
      /** Set when the Attempt ended to wait durably (or escalate), not by a real cancellation. */
      readonly endedToWait: { readonly reason: string | null } | null;
      readonly reportedCost: {
        readonly amountMinor: number;
        readonly currency: string;
        readonly estimated?: boolean;
      } | null;
      /**
       * What the Workspace's `copy` mounts placed in this Attempt's environment, when recorded.
       * This view lists at most the first {@link TASK_VIEW_MOUNT_OBJECTS} objects of each mount;
       * `objectCount` and `totalBytes` cover all of them.
       */
      readonly mountManifests?: readonly MountManifest[];
      readonly mountOutputManifests?: readonly MountOutputManifest[];
    }[];
    readonly scheduling?: JsonRecord;
    /** Skills actually delivered to the latest Task Attempt. */
    readonly skills?: readonly {
      readonly name: string;
      readonly source: string;
      readonly digest: string;
    }[];
    /** The prepared Workspace artifact used by the latest Task Attempt, when reported. */
    readonly preparedWorkspace?: {
      readonly digest: string;
      readonly provider: string;
      readonly trustedCommit: string;
    };
    /** The pull request a Worker opened for this Task, for `pull-request` delivery. */
    readonly pullRequest?: {
      readonly repository: string;
      readonly number: number;
      readonly url: string;
      readonly state: "draft" | "ready" | "closed";
      readonly lastError?: string;
      /** When a failed ready or close transition is retried; absent once retries stop. */
      readonly nextAttemptAt?: string;
    };
    /** What the Task delivered: its Workspace branch, patches, pull request, and outputs. */
    readonly delivery?: TaskDelivery;
    /**
     * Where the latest Attempt's Task files and each captured artifact live, flagging copies
     * held only on ephemeral storage. Present when one Task is read.
     */
    readonly storage?: TaskStorage;
  }
>;

export type SessionResource = ControlPlaneResource<
  "Session",
  {
    readonly tagId: string;
    readonly sessionKey: string;
    readonly origin: JsonRecord;
    /** The conversation Session that started this work Session; read-only. */
    readonly parentSessionId?: string;
  },
  {
    readonly phase: Session["state"];
    readonly audience: Session["audience"];
    /** The Tag's name. */
    readonly tag?: string;
    /** A work Session's title, or how a conversation began: its first request, shortened. */
    readonly title?: string;
    /** The status of the Session's latest Task. */
    readonly latestTaskStatus?: TaskStatus;
    readonly lastInteractionAt: string;
  }
>;

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

export type ControlPlaneStatusResource = ControlPlaneResource<
  "ControlPlane",
  Record<string, never>,
  {
    readonly phase: "accepting" | "draining";
    readonly apiVersion: 1;
    readonly controllers: readonly {
      readonly name: string;
      readonly phase: string;
    }[];
  }
>;

export type TagOperationResource = ControlPlaneResource<
  "TagOperation",
  {
    readonly command: string;
    readonly args: readonly string[];
  },
  {
    readonly phase: "completed";
    readonly output: string;
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
      .filter((grant) => grant.recipientTagId === tag.id && grant.messageTypes.length > 0)
      .map((grant) => ({
        tag: organization.tagNames.get(grant.senderTagId) ?? grant.senderTagId,
        types: grant.messageTypes,
      })),
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

export function canonicalMailboxGrants(
  grants: readonly TagMailboxGrantSpec[],
): readonly TagMailboxGrantSpec[] {
  return grants
    .map((grant) => ({ tag: grant.tag, types: [...new Set(grant.types)].toSorted() }))
    .toSorted((left, right) => left.tag.localeCompare(right.tag));
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
      builtIn: role.origin === "system",
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
  store: Pick<Store, "listTasks" | "listTaskAttempts" | "listTaskEvents">,
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

const PREPARED_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

/**
 * The prepared Workspace environment an Attempt's resolved inputs report. Only a well-formed
 * digest, provider name, and commit are kept; nothing else from provenance is projected.
 */
function preparedWorkspaceOf(
  events: readonly { readonly type: string; readonly payload?: JsonRecord | null }[],
): PreparedWorkspaceStatus | undefined {
  const manifest = events.findLast((event) => event.type === "runtime-inputs.resolved")?.payload?.[
    "manifest"
  ];
  const inputs = isRecord(manifest) && Array.isArray(manifest["inputs"]) ? manifest["inputs"] : [];
  for (const input of inputs) {
    if (!isRecord(input) || input["kind"] !== "workspace" || !isRecord(input["resource"])) continue;
    const provenance = input["resource"]["provenance"];
    if (!isRecord(provenance) || provenance["provider"] !== "supertag-workspace") continue;
    const digest = provenance["preparedDigest"];
    const provider = provenance["preparedProvider"];
    const trustedCommit = provenance["trustedCommit"];
    if (
      typeof digest === "string" &&
      PREPARED_DIGEST.test(digest) &&
      typeof provider === "string" &&
      PROVIDER.test(provider) &&
      typeof trustedCommit === "string" &&
      COMMIT.test(trustedCommit)
    )
      return { digest, provider, trustedCommit };
  }
  return undefined;
}

export function taskResource(task: Task): TaskResource {
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Task",
    metadata: {
      id: task.id,
      resourceVersion: task.updatedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    spec: {
      tagId: task.tagId,
      sessionId: task.sessionId,
      execution: task.execution,
      trigger: task.trigger,
      ...(task.workspacePlan?.status === "workspace"
        ? {
            workspace: {
              name: task.workspacePlan.workspace,
              branch: task.workspacePlan.branch,
              ...(task.workspacePlan.ref === undefined ? {} : { ref: task.workspacePlan.ref }),
              delivery: task.workspacePlan.delivery,
            },
          }
        : {}),
    },
    status: {
      phase: task.status,
      ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
      ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      ...(task.outcome === undefined ? {} : { outcome: task.outcome }),
    },
  };
}

/**
 * A cancelled Attempt whose own Task history records a durable wait or self-escalation ended to
 * wait, not by cancellation. Returns the recorded reason, or null when it was really cancelled.
 */
function attemptWaitEnding(
  attempt: { readonly attemptNumber: number; readonly status: string },
  events: readonly { readonly type: string; readonly payload?: JsonRecord | null }[],
): { reason: string | null } | null {
  if (attempt.status !== "cancelled") return null;
  const ending = events.findLast(
    (event) =>
      ((event.type === WAIT_REGISTERED_EVENT || event.type === SELF_ESCALATED_EVENT) &&
        event.payload?.["attemptNumber"] === attempt.attemptNumber) ||
      (event.type === "task.cancelled" &&
        event.payload?.["attemptCount"] === attempt.attemptNumber),
  );
  if (!ending || ending.type === "task.cancelled") return null;
  const reason = ending.payload?.["reason"];
  return {
    reason:
      typeof reason !== "string"
        ? null
        : ending.type === SELF_ESCALATED_EVENT
          ? `escalated: ${reason}`
          : reason,
  };
}

/** Stored observations only: resource reads never contact a Worklet or replay execution. */
/** A running Task's uncertain Attempt with the command that recovers it, or null. */
function uncertainAttemptView(
  taskId: string,
  assignment: Parameters<typeof currentUncertainAttempt>[0],
): JsonRecord | null {
  const uncertain = currentUncertainAttempt(assignment);
  return uncertain
    ? { ...uncertain, recoverCommand: uncertainAttemptRecoverCommand(taskId, uncertain) }
    : null;
}

export async function taskResourceFromStore(
  store: Store,
  task: Task,
  options: {
    /** Also read where the Task's files and artifacts live; `describe task` shows it. */
    readonly storage?: boolean;
  } = {},
): Promise<TaskResource> {
  const [assignment, attempts, history] = await Promise.all([
    store.getTaskAssignment(task.id),
    store.listTaskAttempts(task.id),
    store.listTaskEvents(task.id),
  ]);
  const events = history.toSorted((a, b) => a.sequence - b.sequence);
  const skillManifest = events.findLast((event) => event.type === "runtime-inputs.resolved")
    ?.payload?.["manifest"];
  const skills =
    isRecord(skillManifest) && Array.isArray(skillManifest["inputs"])
      ? skillManifest["inputs"].flatMap(
          (input): { name: string; source: string; digest: string }[] => {
            if (!isRecord(input) || input["kind"] !== "skill" || !isRecord(input["resource"]))
              return [];
            const resource = input["resource"];
            const provenance = isRecord(resource["provenance"]) ? resource["provenance"] : {};
            if (typeof input["id"] !== "string" || typeof resource["digest"] !== "string")
              return [];
            return [
              {
                name: input["id"].startsWith("skill:") ? input["id"].slice(6) : input["id"],
                source:
                  typeof provenance["source"] === "string" ? provenance["source"] : "host service",
                digest: resource["digest"],
              },
            ];
          },
        )
      : [];
  const latest = attempts.toSorted((a, b) => b.attemptNumber - a.attemptNumber)[0];
  const attemptEvents = latest ? events.filter((event) => event.attemptId === latest.id) : [];
  const preparedWorkspace = preparedWorkspaceOf(attemptEvents);
  const started = attemptEvents.findLast((event) => event.type === "execution.started");
  const lastEvent = attemptEvents.at(-1);
  const terminal = attemptEvents.findLast(
    (event) => event.type === "execution.failed" || event.type === "execution.completed",
  );
  const error = terminal?.type === "execution.failed" ? terminal.payload?.["error"] : undefined;
  // Worker events already apply their redaction policy. Never project extra error fields.
  const failureMessage = isRecord(error) ? text(error["message"]) : undefined;
  const placement = taskExecutionPlacementReport(latest, events);
  const warnings = taskAttemptWarnings(latest, events);
  const selectedPlacement =
    latest && isRecord(latest.workerSnapshot["placement"])
      ? latest.workerSnapshot["placement"]
      : undefined;
  // Keep the last recorded check; describe presents it only while work is queued.
  const scheduling = events.findLast(
    (event) =>
      event.type === "task.scheduling-incompatible" ||
      event.type === "task.scheduling-compatible" ||
      event.type === "task.scheduling-waiting",
  );
  const resource = taskResource(task);
  const resolved = events.findLast((event) => event.type === "task.execution-resolved")?.payload;
  const attemptExecution =
    latest && isRecord(latest.workerSnapshot["execution"])
      ? latest.workerSnapshot["execution"]
      : undefined;
  // Each self-escalation changes what the Task runs with from then on.
  const selfEscalations = events
    .filter((event) => event.type === SELF_ESCALATED_EVENT && isRecord(event.payload))
    .map((event) => ({
      at: event.createdAt,
      byTagId: text(event.payload?.["byTagId"]),
      change: text(event.payload?.["change"]),
      reason: text(event.payload?.["reason"]),
      to: isRecord(event.payload?.["to"]) ? event.payload["to"] : {},
    }));
  const execution =
    resolved === undefined && attemptExecution === undefined && selfEscalations.length === 0
      ? undefined
      : {
          ...(resolved === undefined
            ? {}
            : Object.fromEntries(Object.entries(resolved).filter(([key]) => key !== "version"))),
          ...(selfEscalations.at(-1)?.to ?? {}),
          ...(selfEscalations.length === 0
            ? {}
            : { selfEscalations: selfEscalations.map(({ to: _to, ...entry }) => entry) }),
          ...(attemptExecution === undefined ? {} : { latestAttempt: attemptExecution }),
        };
  const pullRequest =
    task.workspacePlan?.status === "workspace" && task.workspacePlan.delivery === "pull-request"
      ? workspacePullRequestFromEvents(events)
      : undefined;
  const delivery = taskDelivery({
    ...(task.workspacePlan === undefined ? {} : { workspacePlan: task.workspacePlan }),
    result: task.result ?? assignment?.result?.["taskResult"],
    events,
  });
  const environment = (value: typeof placement.executionEnvironment) =>
    value === null ? null : { id: value.id, provider: value.provider, placement: value.placement };
  // A coordination Task's settled record holds Control Plane-recorded findings under taskResult;
  // any other Task's result is the Task result itself.
  const openFindings = storedOpenTaskFindings(
    assignment?.result ?? (task.result ? { taskResult: task.result } : undefined),
  );
  const records = (value: unknown): JsonRecord[] =>
    Array.isArray(value) ? value.filter(isRecord) : [];
  const teamInput = events
    .filter((event) => event.type === "task.team-input" && isRecord(event.payload))
    .slice(-20)
    .map((event) => ({
      at: event.createdAt,
      attemptId: event.attemptId ?? null,
      status: text(event.payload?.["status"]) ?? "unknown",
      itemKind: text(event.payload?.["itemKind"]) ?? "",
      itemId: text(event.payload?.["itemId"]) ?? "",
      itemType: text(event.payload?.["itemType"]) ?? "",
      senderTagId: text(event.payload?.["senderTagId"]) ?? "",
      truncated: event.payload?.["truncated"] === true,
    }));
  const reviewed = task.result ?? assignment?.result?.["taskResult"];
  const fixedFindings = records(isRecord(reviewed) ? reviewed["fixedFindings"] : undefined);
  const findingClosures = records(assignment?.result?.["findingClosures"]);
  const status: TaskResource["status"] = {
    ...resource.status,
    ...("unreadable" in openFindings ||
    openFindings.high.length + openFindings.medium.length + openFindings.low.length
      ? { openFindings }
      : {}),
    ...(fixedFindings.length ? { fixedFindings } : {}),
    ...(findingClosures.length ? { findingClosures } : {}),
    ...(teamInput.length ? { teamInput } : {}),
    ...(skills.length ? { skills } : {}),
    ...(preparedWorkspace === undefined ? {} : { preparedWorkspace }),
    ...(execution === undefined ? {} : { execution }),
    ...(assignment === undefined
      ? {}
      : {
          assignment: {
            objectiveId: assignment.objectiveId,
            teamId: assignment.teamId,
            phase: assignment.status,
            approval: assignment.approval,
            priority: assignment.priority,
            attemptCount: assignment.attemptCount,
            dependencies: assignment.dependencies,
            availableAt: assignment.availableAt,
            leaseExpiresAt: assignment.leaseExpiresAt,
            uncertainAttempt: uncertainAttemptView(task.id, assignment),
            admissionRejection:
              isRecord(assignment.result) &&
              typeof assignment.result["admissionRejected"] === "string"
                ? assignment.result["admissionRejected"]
                : null,
            wait:
              assignment.waitState === null
                ? null
                : {
                    acceptedTaskIds: assignment.waitState.acceptedTaskIds,
                    submittedTaskIds: assignment.waitState.submittedTaskIds,
                    reason: assignment.waitState.reason,
                    mailbox: assignment.waitState.mailbox,
                    notBefore: assignment.waitState.notBefore,
                    workstreamPosts: assignment.waitState.workstreamPosts ?? null,
                    registeredAt: assignment.waitState.registeredAt,
                    attemptCount: assignment.waitState.attemptCount,
                    wake: assignment.waitState.wake ?? null,
                  },
          },
        }),
    ...(attempts.length === 0
      ? {}
      : {
          attempts: attempts
            .toSorted((a, b) => a.attemptNumber - b.attemptNumber)
            .map((candidate) => ({
              id: candidate.id,
              number: candidate.attemptNumber,
              phase: candidate.status,
              startedAt: candidate.startedAt,
              endedAt: candidate.endedAt ?? null,
              endedToWait: attemptWaitEnding(candidate, events),
              reportedCost: taskAttemptReportedCost(candidate, events),
              ...(candidate.liveMounts === undefined ? {} : { liveMounts: candidate.liveMounts }),
              ...(candidate.mountOutputManifests === undefined
                ? {}
                : { mountOutputManifests: candidate.mountOutputManifests }),
              ...(candidate.mountManifests === undefined
                ? {}
                : {
                    mountManifests: candidate.mountManifests.map((manifest) => ({
                      ...manifest,
                      objects: manifest.objects.slice(0, TASK_VIEW_MOUNT_OBJECTS),
                    })),
                  }),
            })),
        }),
    ...(latest === undefined
      ? {}
      : {
          attempt: {
            id: latest.id,
            number: latest.attemptNumber,
            phase: latest.status,
            endedToWait: attemptWaitEnding(latest, events),
            workerProfile: latest.workerProfile,
            durableExecution: latest.workerSnapshot["durableExecution"] === true,
            failure:
              failureMessage === undefined || terminal === undefined
                ? null
                : {
                    message: failureMessage,
                    at: terminal.createdAt,
                    sequence: terminal.sequence,
                  },
            warnings: warnings.map((warning) => ({
              message: warning.text,
              at: warning.at,
              sequence: warning.sequence,
            })),
            runningCommand: taskAttemptRunningCommand(latest, events),
            workerId:
              text(latest.workerSnapshot["workerId"]) ??
              text(started?.payload?.["workerId"]) ??
              text(selectedPlacement?.["workerId"]) ??
              null,
            workerHostId:
              text(latest.workerSnapshot["workerHostId"]) ??
              text(selectedPlacement?.["workerHostId"]) ??
              null,
            workletId:
              text(latest.workerSnapshot["workletId"]) ??
              text(selectedPlacement?.["workletId"]) ??
              null,
            selection:
              selectedPlacement === undefined
                ? null
                : {
                    allowedWorkerHostIds: Array.isArray(selectedPlacement["allowedWorkerHostIds"])
                      ? selectedPlacement["allowedWorkerHostIds"].filter(
                          (item): item is string => typeof item === "string",
                        )
                      : [],
                    reservation: placementReservationStatus(
                      selectedPlacement["reservation"],
                      typeof latest.workerSnapshot["workerHostId"] === "string",
                    ),
                  },
            lastEvent:
              lastEvent === undefined
                ? null
                : {
                    type: lastEvent.type,
                    sequence: lastEvent.sequence,
                    at: lastEvent.createdAt,
                  },
            placement: {
              status: placement.status,
              mode: placement.mode,
              cleanup: placement.cleanup,
              cleanupFailure: placement.cleanupFailure,
              harness:
                placement.harness === null
                  ? null
                  : {
                      id: placement.harness.id,
                      version: placement.harness.version,
                    },
              harnessRuntime: environment(placement.harnessRuntime),
              executionEnvironment: environment(placement.executionEnvironment),
            },
          },
        }),
    ...(scheduling === undefined
      ? {}
      : {
          scheduling: {
            status:
              scheduling.type === "task.scheduling-incompatible"
                ? "incompatible"
                : scheduling.type === "task.scheduling-waiting"
                  ? "waiting"
                  : "compatible",
            unmetRequirements: Array.isArray(scheduling.payload?.["unmetRequirements"])
              ? scheduling.payload["unmetRequirements"].filter(
                  (item): item is string => typeof item === "string",
                )
              : [],
            ...(scheduling.type === "task.scheduling-incompatible" &&
            placementHoldReason(scheduling.payload) !== undefined
              ? { reason: placementHoldReason(scheduling.payload) }
              : {}),
            ...(scheduling.type === "task.scheduling-incompatible" &&
            unsandboxedCommandHoldsOf(scheduling.payload).length > 0
              ? { unsandboxedCommands: unsandboxedCommandHoldsOf(scheduling.payload) }
              : {}),
            ...(scheduling.type === "task.scheduling-incompatible" &&
            Array.isArray(scheduling.payload?.["workspaceRefusals"])
              ? {
                  workspaceRefusals: scheduling.payload["workspaceRefusals"].filter(
                    (reason): reason is string => typeof reason === "string",
                  ),
                }
              : {}),
            ...(scheduling.type === "task.scheduling-waiting"
              ? { wait: schedulingWaitStatus(scheduling.payload) }
              : {}),
            observedAt: scheduling.createdAt,
            sequence: scheduling.sequence,
          },
        }),
    ...(pullRequest === undefined
      ? {}
      : {
          pullRequest: {
            repository: pullRequest.repository,
            number: pullRequest.number,
            url: pullRequest.url,
            state: pullRequest.state,
            ...(pullRequest.lastError === undefined ? {} : { lastError: pullRequest.lastError }),
            ...(pullRequest.nextAttemptAt === undefined
              ? {}
              : { nextAttemptAt: pullRequest.nextAttemptAt }),
          },
        }),
    ...(delivery === undefined ? {} : { delivery }),
  };
  // Storage is read only for one Task and kept out of its version, so a list and a read agree.
  const storage =
    options.storage === true
      ? await taskStorage(store, task.id, latest, environment(placement.executionEnvironment))
      : undefined;
  return {
    ...resource,
    metadata: { ...resource.metadata, resourceVersion: resourceVersion({ task, status }) },
    status: storage === undefined ? status : { ...status, storage },
  };
}

function placementReservationStatus(
  value: unknown,
  consumed: boolean,
): { readonly id: string; readonly expiresAt: string; readonly phase: string } | null {
  if (!isRecord(value)) return null;
  const id = text(value["id"]);
  const expiresAt = text(value["expiresAt"]);
  if (!id || !expiresAt) return null;
  return {
    id,
    expiresAt,
    phase: consumed ? "consumed" : Date.parse(expiresAt) <= Date.now() ? "expired" : "reserved",
  };
}

export function sessionResource(
  session: Session,
  summary: {
    readonly tag?: string;
    readonly latestTaskStatus?: TaskStatus;
    readonly firstRequest?: string;
  } = {},
): SessionResource {
  const title = sessionTitle(session, summary.firstRequest);
  const { latestTaskStatus } = summary;
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Session",
    metadata: {
      id: session.id,
      resourceVersion: session.updatedAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    spec: {
      tagId: session.tagId,
      sessionKey: session.sessionKey,
      origin: session.origin,
      ...(session.parentSessionId === undefined
        ? {}
        : { parentSessionId: session.parentSessionId }),
    },
    status: {
      phase: session.state,
      audience: session.audience,
      ...(summary.tag === undefined ? {} : { tag: summary.tag }),
      ...(title === undefined ? {} : { title }),
      ...(latestTaskStatus === undefined ? {} : { latestTaskStatus }),
      lastInteractionAt: session.lastInteractionAt,
    },
  };
}

/** Read storage evidence once for a host list, including disconnected hosts. */
export async function workerHostResourcesFromStore(
  store: Store,
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

function workerDescriptor(value: unknown): WorkerDescriptor | undefined {
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

/**
 * The stored reason a queued Task is waiting: dependencies not yet accepted, busy matching
 * Workers, none connected, or a declined claim with its cause.
 */
function schedulingWaitStatus(payload: JsonRecord | undefined): JsonRecord {
  if (payload?.["reason"] === "claim") {
    const claim = isRecord(payload["claim"]) ? payload["claim"] : {};
    return {
      reason: "claim",
      claim: {
        code: text(claim["code"]) ?? "unknown",
        message: text(claim["message"]) ?? "The Control Plane declined to start the Task.",
        ...(Array.isArray(claim["taskIds"])
          ? {
              taskIds: claim["taskIds"].filter((item): item is string => typeof item === "string"),
            }
          : {}),
        ...(text(claim["teamId"]) === undefined ? {} : { teamId: text(claim["teamId"]) }),
        ...(text(claim["tagId"]) === undefined ? {} : { tagId: text(claim["tagId"]) }),
        ...(text(claim["availableAt"]) === undefined
          ? {}
          : { availableAt: text(claim["availableAt"]) }),
      },
    };
  }
  if (payload?.["reason"] === "dependencies")
    return {
      reason: "dependencies",
      dependencies: (Array.isArray(payload["dependencies"])
        ? payload["dependencies"].filter(isRecord)
        : []
      ).map((dependency) => ({
        taskId: text(dependency["taskId"]) ?? "unknown",
        status: text(dependency["status"]) ?? null,
      })),
    };
  const hosts = Array.isArray(payload?.["hosts"]) ? payload["hosts"].filter(isRecord) : [];
  return {
    reason: payload?.["reason"] === "capacity" ? "capacity" : "unavailable",
    hosts: hosts.map((host) => ({
      workerHostId: text(host["workerHostId"]) ?? "unknown",
      harnesses: Array.isArray(host["harnesses"])
        ? host["harnesses"].filter((item): item is string => typeof item === "string")
        : [],
      capacity: typeof host["capacity"] === "number" ? host["capacity"] : 0,
      busyTaskIds: Array.isArray(host["busyTaskIds"])
        ? host["busyTaskIds"].filter((item): item is string => typeof item === "string")
        : [],
    })),
  };
}

/** A work Session's own title; otherwise the first request, on one line and at most 60 characters. */
function sessionTitle(session: Session, firstRequest: string | undefined): string | undefined {
  const own = session.origin["title"];
  if (typeof own === "string" && own.trim()) return own.trim();
  const request = firstRequest?.replace(/\s+/gu, " ").trim();
  if (request) return request.length > 60 ? `${request.slice(0, 59).trimEnd()}…` : request;
  // A CLI conversation is named by its session name.
  const key = session.sessionKey.match(/^cli:[^:]+:(.+)$/u)?.[1];
  return key;
}
