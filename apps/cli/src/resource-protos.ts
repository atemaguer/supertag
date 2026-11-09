import type { JsonObject, MessageInitShape } from "@bufbuild/protobuf";
import type {
  ExecutionEffort as ExecutionEffortWord,
  ExecutionSettings as ExecutionSettingsRecord,
  JsonRecord,
  TagContextItem,
  TagPermission,
  Workspace as WorkspaceRecord,
} from "@supertag/core";
import {
  type ContextSet,
  type ContextSetSchema,
  type DeclaredObjective,
  type DeclaredObjectiveSchema,
  ExecutionEffort,
  type ExecutionSettings,
  type ExecutionSettingsSchema,
  MountAccess,
  type Permission,
  PermissionApproval,
  type PermissionSchema,
  type PermissionSet,
  type PermissionSetSchema,
  type Resource,
  ResourceKind,
  type ResourceSchema,
  type Role,
  RolePhase,
  type RoleSchema,
  SurfaceProvider,
  type Tag,
  type TagLocation,
  type TagLocationSchema,
  TagPhase,
  type TagSchema,
  type Volume,
  type VolumeSchema,
  WorkerHostConnection,
  type WorkerProfile,
  WorkerProfilePhase,
  type WorkerProfileSchema,
  type Workspace,
  type WorkspaceMount,
  WorkspaceMountStrategy,
  type WorkspaceSchema,
} from "@supertag/operator-api";
import {
  CONTROL_PLANE_API_VERSION,
  type ContextSetResource,
  type PermissionSetResource,
  type ResourceMetadata,
  type RoleResource,
  type SurfaceAccountResource,
  type TagLocationSpec,
  type TagResource,
  type VolumeResource,
  type WorkerProfileResource,
  type WorkspaceEnvironmentStatus,
  type WorkspaceResource,
} from "./control-plane-resources.js";
import {
  metadataMessage,
  metadataView,
  nameOf,
  optionalIso,
  optionalTimestamp,
  SURFACE_PROVIDERS,
  surfaceAccountMessage,
  surfaceAccountView,
} from "./host-protos.js";
import { DELIVERY_MODE, enumTable, isoOf, timestampOf } from "./objective-protos.js";

/**
 * Tags, Roles, Permission Sets, Context Sets, Volumes, Workspaces, Worker Profiles and declared
 * Objectives in both directions: from the resource views the Control Plane builds to
 * `ResourceService`'s messages, and back to the same views, so the CLI prints what it always
 * printed.
 */

/** A resource kind: its CLI path, manifest kind and operator API value. */
export const RESOURCE_KINDS = [
  { path: "tags", kind: "Tag", value: ResourceKind.TAG },
  { path: "roles", kind: "Role", value: ResourceKind.ROLE },
  { path: "permission-sets", kind: "PermissionSet", value: ResourceKind.PERMISSION_SET },
  { path: "context-sets", kind: "ContextSet", value: ResourceKind.CONTEXT_SET },
  { path: "volumes", kind: "Volume", value: ResourceKind.VOLUME },
  { path: "workspaces", kind: "Workspace", value: ResourceKind.WORKSPACE },
  { path: "surface-accounts", kind: "SurfaceAccount", value: ResourceKind.SURFACE_ACCOUNT },
  { path: "objectives", kind: "Objective", value: ResourceKind.OBJECTIVE },
  { path: "worker-profiles", kind: "WorkerProfile", value: ResourceKind.WORKER_PROFILE },
] as const;

export type ResourcePath = (typeof RESOURCE_KINDS)[number]["path"];

export function isResourcePath(path: string): path is ResourcePath {
  return RESOURCE_KINDS.some((entry) => entry.path === path);
}

export function resourceKindOfPath(path: ResourcePath): ResourceKind {
  return RESOURCE_KINDS.find((entry) => entry.path === path)?.value ?? ResourceKind.UNSPECIFIED;
}

export function resourceKindOfName(kind: string): ResourceKind {
  return RESOURCE_KINDS.find((entry) => entry.kind === kind)?.value ?? ResourceKind.UNSPECIFIED;
}

/** A kind's CLI path and manifest kind; undefined for `UNSPECIFIED` or an unknown value. */
export function resourceKindEntry(
  value: ResourceKind,
): (typeof RESOURCE_KINDS)[number] | undefined {
  return RESOURCE_KINDS.find((entry) => entry.value === value);
}

/** A declared Objective as `GET objective` once returned it, with its manifest spec. */
export interface DeclaredObjectiveResource {
  readonly apiVersion: typeof CONTROL_PLANE_API_VERSION;
  readonly kind: "Objective";
  readonly metadata: ResourceMetadata;
  readonly spec: Readonly<Record<string, unknown>>;
}

/** Any resource `ResourceService` serves, as a view. */
export type ResourceView =
  | TagResource
  | RoleResource
  | PermissionSetResource
  | ContextSetResource
  | VolumeResource
  | WorkspaceResource
  | SurfaceAccountResource
  | WorkerProfileResource
  | DeclaredObjectiveResource;

const EFFORT = enumTable(
  [
    ["low", ExecutionEffort.LOW],
    ["medium", ExecutionEffort.MEDIUM],
    ["high", ExecutionEffort.HIGH],
  ] as const,
  ExecutionEffort.UNSPECIFIED,
);

const MOUNT_ACCESS = enumTable(
  [
    ["read-only", MountAccess.READ_ONLY],
    ["read-write", MountAccess.READ_WRITE],
  ] as const,
  MountAccess.UNSPECIFIED,
);

const MOUNT_STRATEGY = enumTable(
  [
    ["copy", WorkspaceMountStrategy.COPY],
    ["mount", WorkspaceMountStrategy.MOUNT],
  ] as const,
  WorkspaceMountStrategy.UNSPECIFIED,
);

const TAG_PHASE = enumTable(
  [
    ["active", TagPhase.ACTIVE],
    ["retired", TagPhase.RETIRED],
  ] as const,
  TagPhase.UNSPECIFIED,
);

const ROLE_PHASE = enumTable(
  [
    ["active", RolePhase.ACTIVE],
    ["retired", RolePhase.RETIRED],
  ] as const,
  RolePhase.UNSPECIFIED,
);

const CONNECTION = enumTable(
  [
    ["connected", WorkerHostConnection.CONNECTED],
    ["disconnected", WorkerHostConnection.DISCONNECTED],
  ] as const,
  WorkerHostConnection.UNSPECIFIED,
);

function word<W extends string>(
  table: { word: (value: never) => W | undefined },
  value: number,
  what: string,
): W {
  const found = table.word(value as never);
  if (found === undefined) throw new Error(`Control Plane returned an unknown ${what}`);
  return found;
}

function json(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonObject;
}

// Execution settings.

function executionMessage(
  settings: ExecutionSettingsRecord,
): MessageInitShape<typeof ExecutionSettingsSchema> {
  return {
    harness: settings.harness ?? "",
    model: [...(settings.model ?? [])],
    effort: (settings.effort ?? []).map((effort) => EFFORT.value(effort)),
  };
}

function executionView(settings: ExecutionSettings): ExecutionSettingsRecord {
  return {
    ...(settings.harness === "" ? {} : { harness: settings.harness }),
    ...(settings.model.length === 0 ? {} : { model: [...settings.model] }),
    ...(settings.effort.length === 0
      ? {}
      : {
          effort: settings.effort.map(
            (effort): ExecutionEffortWord => word(EFFORT, effort, "execution effort"),
          ),
        }),
  };
}

// Tags.

function tagLocationMessage(location: TagLocationSpec): MessageInitShape<typeof TagLocationSchema> {
  const place = (): Exclude<MessageInitShape<typeof TagLocationSchema>["place"], undefined> => {
    switch (location.provider) {
      case "slack":
        return { case: "slack", value: { channelId: location.channelId ?? "" } };
      case "lark":
        return { case: "lark", value: { chatId: location.chatId ?? "" } };
      case "teams":
        return {
          case: "teams",
          value: { teamId: location.teamId ?? "", channelId: location.channelId ?? "" },
        };
      case "github":
        return {
          case: "github",
          value: {
            repository:
              location.repoId === undefined
                ? { case: "repo", value: location.repo ?? "" }
                : { case: "repoId", value: location.repoId },
          },
        };
      case "linear":
        return {
          case: "linear",
          value: {
            linearTeam:
              location.teamId === undefined
                ? { case: "team", value: location.team ?? "" }
                : { case: "teamId", value: location.teamId },
          },
        };
      default:
        throw new Error("A CLI conversation is not a Tag location");
    }
  };
  return {
    place: place(),
    account: location.account ?? "",
    permissionSets: [...(location.permissionSets ?? [])],
    contextSets: [...(location.contextSets ?? [])],
    workspaces: [...(location.workspaces ?? [])],
  };
}

function tagLocationView(location: TagLocation): TagLocationSpec {
  const { place } = location;
  const account = location.account === "" ? {} : { account: location.account };
  let scope: Omit<TagLocationSpec, "account" | "permissionSets" | "contextSets" | "workspaces">;
  switch (place.case) {
    case "slack":
      scope = { provider: "slack", ...account, channelId: place.value.channelId };
      break;
    case "lark":
      scope = { provider: "lark", ...account, chatId: place.value.chatId };
      break;
    case "teams":
      scope = {
        provider: "teams",
        ...account,
        teamId: place.value.teamId,
        channelId: place.value.channelId,
      };
      break;
    case "github": {
      const repository = place.value.repository;
      scope = {
        provider: "github",
        ...account,
        ...(repository.case === "repoId"
          ? { repoId: repository.value }
          : { repo: repository.value ?? "" }),
      };
      break;
    }
    case "linear": {
      const team = place.value.linearTeam;
      scope = {
        provider: "linear",
        ...account,
        ...(team.case === "teamId" ? { teamId: team.value } : { team: team.value ?? "" }),
      };
      break;
    }
    default:
      throw new Error("Control Plane returned a Tag location without a provider");
  }
  return {
    ...scope,
    ...(location.permissionSets.length === 0
      ? {}
      : { permissionSets: [...location.permissionSets] }),
    ...(location.contextSets.length === 0 ? {} : { contextSets: [...location.contextSets] }),
    ...(location.workspaces.length === 0 ? {} : { workspaces: [...location.workspaces] }),
  };
}

export function tagMessage(resource: TagResource): MessageInitShape<typeof TagSchema> {
  const { spec, status } = resource;
  return {
    metadata: metadataMessage(resource.metadata),
    spec: {
      roles: [...spec.roles],
      workerHosts: [...spec.workerHosts],
      runsOn: [...spec.runsOn],
      ...(spec.execution === undefined ? {} : { execution: executionMessage(spec.execution) }),
      locations: spec.locations.map(tagLocationMessage),
      acceptsMessagesFrom: [...spec.acceptsMessagesFrom],
    },
    status: {
      phase: TAG_PHASE.value(status.phase),
      ...optionalTimestamp("retiredAt", status.retiredAt),
      ...(status.execution === undefined ? {} : { execution: executionMessage(status.execution) }),
      locations: status.locations.map((location) => ({
        provider:
          location.provider === "cli"
            ? SurfaceProvider.UNSPECIFIED
            : SURFACE_PROVIDERS[location.provider],
        account: location.account,
        target: location.target,
        enabled: location.enabled,
      })),
    },
  };
}

export function tagView(tag: Tag): TagResource {
  const spec = tag.spec;
  const status = tag.status;
  if (spec === undefined || status === undefined)
    throw new Error("Control Plane returned a Tag without its spec or status");
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Tag",
    metadata: metadataView(tag.metadata),
    spec: {
      roles: [...spec.roles],
      workerHosts: [...spec.workerHosts],
      runsOn: [...spec.runsOn],
      ...(spec.execution === undefined ? {} : { execution: executionView(spec.execution) }),
      locations: spec.locations.map(tagLocationView),
      acceptsMessagesFrom: [...spec.acceptsMessagesFrom],
    },
    status: {
      phase: word(TAG_PHASE, status.phase, "Tag phase"),
      ...optionalIso("retiredAt", status.retiredAt),
      ...(status.execution === undefined ? {} : { execution: executionView(status.execution) }),
      locations: status.locations.map((location) => ({
        provider:
          nameOf(SURFACE_PROVIDERS, location.provider) ??
          (() => {
            throw new Error("Control Plane returned an unknown collaboration surface");
          })(),
        account: location.account,
        target: location.target,
        enabled: location.enabled,
      })),
    },
  };
}

// Roles.

export function roleMessage(resource: RoleResource): MessageInitShape<typeof RoleSchema> {
  const { spec, status } = resource;
  return {
    metadata: metadataMessage(resource.metadata),
    spec: {
      purpose: spec.purpose,
      instructions: spec.instructions,
      contextSets: [...spec.contextSets],
      permissionSets: [...spec.permissionSets],
      ...(spec.execution === undefined ? {} : { execution: executionMessage(spec.execution) }),
    },
    status: { phase: ROLE_PHASE.value(status.phase), assignedTags: [...status.assignedTags] },
  };
}

export function roleView(role: Role): RoleResource {
  const { spec, status } = role;
  if (spec === undefined || status === undefined)
    throw new Error("Control Plane returned a Role without its spec or status");
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Role",
    metadata: metadataView(role.metadata),
    spec: {
      purpose: spec.purpose,
      instructions: spec.instructions,
      contextSets: [...spec.contextSets],
      permissionSets: [...spec.permissionSets],
      ...(spec.execution === undefined ? {} : { execution: executionView(spec.execution) }),
    },
    status: {
      phase: word(ROLE_PHASE, status.phase, "Role phase"),
      assignedTags: [...status.assignedTags],
    },
  };
}

// Permission Sets.

function permissionMessage(permission: TagPermission): MessageInitShape<typeof PermissionSchema> {
  const target = (): Exclude<MessageInitShape<typeof PermissionSchema>["target"], undefined> => {
    if (permission.target === "runtime") return { case: "runtime", value: {} };
    if (permission.target === "mcp")
      return { case: "mcp", value: { resource: permission.resource ?? "" } };
    return {
      case: "surface",
      value: {
        surfaceAccountId: permission.surfaceAccountId,
        scope: permission.scope,
        reference: permission.reference ?? "",
      },
    };
  };
  return {
    id: permission.id,
    target: target(),
    action: permission.action,
    approval:
      permission.approval === "required"
        ? PermissionApproval.REQUIRED
        : PermissionApproval.UNSPECIFIED,
    createdBy: permission.createdBy ?? "",
    ...optionalTimestamp("createdAt", permission.createdAt),
  };
}

function permissionView(permission: Permission, permissionSetId: string): TagPermission {
  const common = {
    id: permission.id,
    permissionSetId,
    action: permission.action,
    ...(permission.approval === PermissionApproval.REQUIRED
      ? { approval: "required" as const }
      : {}),
    ...(permission.createdBy === "" ? {} : { createdBy: permission.createdBy }),
    createdAt: isoOf(permission.createdAt) ?? "",
  };
  const { target } = permission;
  if (target.case === "runtime") return { ...common, target: "runtime" };
  if (target.case === "mcp")
    return {
      ...common,
      target: "mcp",
      ...(target.value.resource === "" ? {} : { resource: target.value.resource }),
    };
  if (target.case === "surface")
    return {
      ...common,
      target: "surface",
      surfaceAccountId: target.value.surfaceAccountId,
      scope: target.value.scope,
      ...(target.value.reference === "" ? {} : { reference: target.value.reference }),
    };
  throw new Error("Control Plane returned a permission without a target");
}

export function permissionSetMessage(
  resource: PermissionSetResource,
): MessageInitShape<typeof PermissionSetSchema> {
  return {
    metadata: metadataMessage(resource.metadata),
    spec: {
      approvers: [...(resource.spec.approvers ?? [])],
      permissions: resource.spec.permissions.map(permissionMessage),
    },
    status: { bindings: [...resource.status.bindings] },
  };
}

export function permissionSetView(set: PermissionSet): PermissionSetResource {
  const metadata = metadataView(set.metadata);
  const approvers = set.spec?.approvers ?? [];
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "PermissionSet",
    metadata,
    spec: {
      ...(approvers.length === 0 ? {} : { approvers: [...approvers] }),
      permissions: (set.spec?.permissions ?? []).map((permission) =>
        permissionView(permission, metadata.id),
      ),
    },
    status: { phase: "active", bindings: [...(set.status?.bindings ?? [])] },
  };
}

// Context Sets.

export function contextSetMessage(
  resource: ContextSetResource,
): MessageInitShape<typeof ContextSetSchema> {
  return {
    metadata: metadataMessage(resource.metadata),
    spec: {
      items: resource.spec.items.map((item) => ({
        id: item.id,
        itemKey: item.itemKey,
        type: item.type,
        version: item.version,
        required: item.required,
        config: json(item.config),
        createdBy: item.createdBy ?? "",
        ...optionalTimestamp("createdAt", item.createdAt),
      })),
    },
    status: { bindings: [...resource.status.bindings] },
  };
}

export function contextSetView(set: ContextSet): ContextSetResource {
  const metadata = metadataView(set.metadata);
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "ContextSet",
    metadata,
    spec: {
      items: (set.spec?.items ?? []).map(
        (item) =>
          ({
            id: item.id,
            contextSetId: metadata.id,
            itemKey: item.itemKey,
            type: item.type,
            version: item.version,
            required: item.required,
            config: (item.config ?? {}) as JsonRecord,
            ...(item.createdBy === "" ? {} : { createdBy: item.createdBy }),
            createdAt: isoOf(item.createdAt) ?? "",
          }) as TagContextItem,
      ),
    },
    status: { phase: "active", bindings: [...(set.status?.bindings ?? [])] },
  };
}

// Volumes.

export function volumeMessage(resource: VolumeResource): MessageInitShape<typeof VolumeSchema> {
  return {
    metadata: metadataMessage(resource.metadata),
    spec: { source: resource.spec.source, credential: resource.spec.credential ?? "" },
  };
}

export function volumeView(volume: Volume): VolumeResource {
  const spec = volume.spec;
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Volume",
    metadata: metadataView(volume.metadata),
    spec: {
      source: spec?.source ?? "",
      ...(spec === undefined || spec.credential === "" ? {} : { credential: spec.credential }),
    },
    status: { phase: "active" },
  };
}

// Workspaces.

type MountRecord = NonNullable<WorkspaceRecord["mounts"]>[number];

function mountView(mount: WorkspaceMount): MountRecord {
  return {
    volume: mount.volume,
    path: mount.path,
    access: MOUNT_ACCESS.word(mount.access) ?? "read-only",
    strategy: MOUNT_STRATEGY.word(mount.strategy) ?? "copy",
    ...(mount.maxBytes === undefined ? {} : { maxBytes: Number(mount.maxBytes) }),
  };
}

export function workspaceMessage(
  resource: WorkspaceResource,
): MessageInitShape<typeof WorkspaceSchema> {
  const { spec, status } = resource;
  return {
    metadata: metadataMessage(resource.metadata),
    spec: {
      source: spec.source ?? "",
      ref: spec.ref ?? "",
      setup: spec.setup ?? "",
      mcp: [...(spec.mcp ?? [])],
      skills: [...(spec.skills ?? [])],
      ...(spec.skillCatalog === undefined
        ? {}
        : {
            skillCatalog: {
              repository: spec.skillCatalog.repository,
              path: spec.skillCatalog.path,
              revision: spec.skillCatalog.revision,
              skills: [...spec.skillCatalog.skills],
            },
          }),
      mounts: (spec.mounts ?? []).map((mount) => ({
        volume: mount.volume,
        path: mount.path,
        access: MOUNT_ACCESS.value(mount.access),
        strategy: MOUNT_STRATEGY.value(mount.strategy),
        ...(mount.maxBytes === undefined ? {} : { maxBytes: BigInt(mount.maxBytes) }),
      })),
      delivery: DELIVERY_MODE.value(spec.delivery),
    },
    status: {
      workerHosts: status.workerHosts.map((host) => ({
        id: host.id,
        connection: CONNECTION.value(host.connectionStatus),
      })),
      environments: (status.environments ?? []).map((environment) => ({
        workerHostId: environment.workerHostId,
        connection: CONNECTION.value(environment.connectionStatus),
        provider: environment.provider,
        ...(environment.prepared === undefined
          ? {}
          : {
              prepared: {
                digest: environment.prepared.digest,
                provider: environment.prepared.provider,
                trustedCommit: environment.prepared.trustedCommit,
              },
              ...optionalTimestamp("preparedAt", environment.prepared.at),
            }),
        refusal: environment.refusal ?? "",
      })),
    },
  };
}

/**
 * A Workspace as the CLI prints it. `environments` is present only when `GetResource` read it,
 * since `ListResources` leaves it out.
 */
export function workspaceView(workspace: Workspace, withEnvironments: boolean): WorkspaceResource {
  const spec = workspace.spec;
  const status = workspace.status;
  const environments = (status?.environments ?? []).map(
    (environment): WorkspaceEnvironmentStatus => ({
      workerHostId: environment.workerHostId,
      connectionStatus: word(CONNECTION, environment.connection, "Worker Host connection"),
      provider: environment.provider,
      ...(environment.prepared === undefined
        ? {}
        : {
            prepared: {
              digest: environment.prepared.digest,
              provider: environment.prepared.provider,
              trustedCommit: environment.prepared.trustedCommit,
              at: isoOf(environment.preparedAt) ?? "",
            },
          }),
      ...(environment.refusal === "" ? {} : { refusal: environment.refusal }),
    }),
  );
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Workspace",
    metadata: metadataView(workspace.metadata),
    spec: {
      ...(spec === undefined || spec.source === "" ? {} : { source: spec.source }),
      ...(spec === undefined || spec.ref === "" ? {} : { ref: spec.ref }),
      ...(spec === undefined || spec.setup === "" ? {} : { setup: spec.setup }),
      ...(spec === undefined || spec.mcp.length === 0 ? {} : { mcp: [...spec.mcp] }),
      ...(spec === undefined || spec.skills.length === 0 ? {} : { skills: [...spec.skills] }),
      ...(spec?.skillCatalog === undefined
        ? {}
        : {
            skillCatalog: {
              repository: spec.skillCatalog.repository,
              path: spec.skillCatalog.path,
              revision: spec.skillCatalog.revision,
              skills: [...spec.skillCatalog.skills],
            },
          }),
      ...(spec === undefined || spec.mounts.length === 0
        ? {}
        : { mounts: spec.mounts.map(mountView) }),
      delivery: DELIVERY_MODE.word(spec?.delivery ?? 0) ?? "branch",
    },
    status: {
      phase: "active",
      workerHosts: (status?.workerHosts ?? []).map((host) => ({
        id: host.id,
        connectionStatus: word(CONNECTION, host.connection, "Worker Host connection"),
      })),
      ...(withEnvironments ? { environments } : {}),
    },
  };
}

// Worker Profiles.

export function workerProfileMessage(
  resource: WorkerProfileResource,
): MessageInitShape<typeof WorkerProfileSchema> {
  return {
    metadata: metadataMessage(resource.metadata),
    spec: { ref: { id: resource.spec.ref.id, revision: resource.spec.ref.revision } },
    status: {
      phase:
        resource.status.phase === "available"
          ? WorkerProfilePhase.AVAILABLE
          : WorkerProfilePhase.UNAVAILABLE,
      workerHostId: resource.status.workerHostId,
      workletId: resource.status.workletId,
      workerId: resource.status.workerId,
    },
  };
}

export function workerProfileView(profile: WorkerProfile): WorkerProfileResource {
  const ref = profile.spec?.ref;
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "WorkerProfile",
    metadata: metadataView(profile.metadata),
    spec: {
      ref: { id: ref?.id ?? "", revision: ref?.revision ?? "" },
    },
    status: {
      phase: profile.status?.phase === WorkerProfilePhase.AVAILABLE ? "available" : "unavailable",
      workerHostId: profile.status?.workerHostId ?? "",
      workletId: profile.status?.workletId ?? "",
      workerId: profile.status?.workerId ?? "",
    },
  };
}

// Declared Objectives.

export function declaredObjectiveMessage(resource: {
  readonly metadata: DeclaredObjectiveResource["metadata"];
  readonly spec: Readonly<Record<string, unknown>>;
}): MessageInitShape<typeof DeclaredObjectiveSchema> {
  const spec = resource.spec;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const names = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const budget = spec["budget"];
  const team = spec["team"];
  return {
    metadata: metadataMessage(resource.metadata),
    spec: {
      owner: text(spec["owner"]),
      outcome: text(spec["outcome"]),
      ongoing: spec["ongoing"] === true,
      workspaces: names(spec["workspaces"]),
      ...(isRecord(budget)
        ? {
            budget: {
              minor: BigInt(Number(budget["minor"] ?? 0)),
              currency: text(budget["currency"]),
            },
          }
        : {}),
      ...(typeof spec["deadline"] === "string" ? { deadline: timestampOf(spec["deadline"]) } : {}),
      runtimeActions: names(spec["runtimeActions"]),
      ...(typeof team === "string"
        ? { team: { case: "teamName" as const, value: team } }
        : isRecord(team)
          ? {
              team: {
                case: "ownTeam" as const,
                value: {
                  name: text(team["name"]),
                  members: names(team["members"]),
                  ...(typeof team["maxConcurrency"] === "number"
                    ? { maxConcurrency: team["maxConcurrency"] }
                    : {}),
                },
              },
            }
          : {}),
    },
  };
}

export function declaredObjectiveView(objective: DeclaredObjective): DeclaredObjectiveResource {
  const spec = objective.spec;
  const team = spec?.team;
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Objective",
    metadata: metadataView(objective.metadata),
    spec: {
      owner: spec?.owner ?? "",
      outcome: spec?.outcome ?? "",
      ongoing: spec?.ongoing === true,
      workspaces: [...(spec?.workspaces ?? [])],
      ...(spec?.budget === undefined
        ? {}
        : {
            budget: {
              minor: Number(spec.budget.minor),
              ...(spec.budget.currency === "" ? {} : { currency: spec.budget.currency }),
            },
          }),
      ...(spec?.deadline === undefined ? {} : { deadline: isoOf(spec.deadline) }),
      runtimeActions: [...(spec?.runtimeActions ?? [])],
      ...(team?.case === "teamName"
        ? { team: team.value }
        : team?.case === "ownTeam"
          ? {
              team: {
                ...(team.value.name === "" ? {} : { name: team.value.name }),
                members: [...team.value.members],
                ...(team.value.maxConcurrency === undefined
                  ? {}
                  : { maxConcurrency: team.value.maxConcurrency }),
              },
            }
          : {}),
    },
  };
}

// Any resource.

/** A resource view as `ResourceService` returns it; `manifest` is set when one was asked for. */
export function resourceMessage(
  view: ResourceView,
  manifest?: Readonly<Record<string, unknown>>,
): MessageInitShape<typeof ResourceSchema> {
  const withManifest = manifest === undefined ? {} : { manifest: json(manifest) };
  switch (view.kind) {
    case "Tag":
      return { resource: { case: "tag", value: tagMessage(view) }, ...withManifest };
    case "Role":
      return { resource: { case: "role", value: roleMessage(view) }, ...withManifest };
    case "PermissionSet":
      return {
        resource: { case: "permissionSet", value: permissionSetMessage(view) },
        ...withManifest,
      };
    case "ContextSet":
      return { resource: { case: "contextSet", value: contextSetMessage(view) }, ...withManifest };
    case "Volume":
      return { resource: { case: "volume", value: volumeMessage(view) }, ...withManifest };
    case "Workspace":
      return { resource: { case: "workspace", value: workspaceMessage(view) }, ...withManifest };
    case "SurfaceAccount":
      return {
        resource: { case: "surfaceAccount", value: surfaceAccountMessage(view) },
        ...withManifest,
      };
    case "WorkerProfile":
      return {
        resource: { case: "workerProfile", value: workerProfileMessage(view) },
        ...withManifest,
      };
    case "Objective":
      return {
        resource: { case: "objective", value: declaredObjectiveMessage(view) },
        ...withManifest,
      };
  }
}

/**
 * A `ResourceService` resource as the view the CLI prints. A Workspace carries `environments`
 * only when `withEnvironments`, as `GetResource` reads them and `ListResources` does not.
 */
export function resourceView(resource: Resource, withEnvironments = false): ResourceView {
  const { value, case: kind } = resource.resource;
  switch (kind) {
    case "tag":
      return tagView(value);
    case "role":
      return roleView(value);
    case "permissionSet":
      return permissionSetView(value);
    case "contextSet":
      return contextSetView(value);
    case "volume":
      return volumeView(value);
    case "workspace":
      return workspaceView(value, withEnvironments);
    case "surfaceAccount":
      return surfaceAccountView(value);
    case "workerProfile":
      return workerProfileView(value);
    case "objective":
      return declaredObjectiveView(value);
    default:
      throw new Error("Control Plane returned a resource of no kind");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
