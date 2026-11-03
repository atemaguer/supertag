import {
  ALLOW_UNSANDBOXED_COMMANDS_SETTING,
  advertisedWorkerHostLabels,
  advertisesWorkspaceClone,
  advertisesWorkspaceEnvironment,
  artifactVolumeLabel,
  COMMANDS_EXECUTE_ACTION,
  COMMANDS_EXECUTE_CAPABILITY_ID,
  hostCommandSupport,
  mcpLoginLabel,
  mcpPlacementLabels,
  mcpServerLabel,
  mcpServerOfLabel,
  mcpServerOfLoginLabel,
  missingWorkerHostLabels,
  parseVolumeSource,
  type TagAuthorizationSnapshot,
  type TaskExecutionRequirements,
  type TaskWorkspacePlan,
  type TaskWorkspaceVolume,
  type UnsandboxedCommandHold,
  volumeCredentialLabel,
  volumeLocationsOverlap,
  type WorkerHost,
  workerHostLabelRequirement,
  workspaceEnvironmentRefusals,
  workspaceLabel,
} from "@supertag/core";
import {
  WORKSPACE_COPY_MOUNT_CAPABILITY,
  WORKSPACE_ENVIRONMENT_CAPABILITY,
  WORKSPACE_IN_PLACE_CAPABILITY,
  WORKSPACE_NATIVE_MOUNT_CAPABILITY,
} from "@supertag/worker-sdk";

export type LabelPlacement =
  | { readonly status: "eligible"; readonly allowedWorkerHostIds: readonly string[] }
  | {
      readonly status: "unmet";
      /** Labels no bound host carries, or every required label when each exists somewhere. */
      readonly missingLabels: readonly string[];
      /** Scheduling requirement such as `labels:macos,gpu`. */
      readonly requirement: string;
      /**
       * Missing MCP servers that a bound host provides but whose `oauth: true` login lapsed:
       * the Task is held until someone runs `supertag mcp login NAME` there.
       */
      readonly mcpLogins?: readonly string[];
    };

/**
 * Whether a host can serve the Workspace's MCP servers: a host that does not declare a server
 * uses the Workspace's, and one that declares it uses its own, which it must currently provide.
 */
function servesWorkspaceMcp(labels: readonly string[], workspaceMcp: readonly string[]): boolean {
  return workspaceMcp.every(
    (server) => labels.includes(mcpServerLabel(server)) || !labels.includes(mcpLoginLabel(server)),
  );
}

/**
 * Narrows a Tag's bound Worker Hosts to those that carry every required label. Bindings decide
 * which hosts may run the Tag's Tasks; labels only choose among them. `workspaceMcp` names
 * granted servers the Task's Workspace provides; each candidate host is checked on its own.
 */
export function placeByLabels(
  boundWorkerHostIds: readonly string[],
  hosts: readonly Pick<WorkerHost, "id" | "enrollmentStatus" | "labels">[],
  required: readonly string[],
  workspaceMcp: readonly string[] = [],
): LabelPlacement {
  if (required.length === 0 && workspaceMcp.length === 0)
    return { status: "eligible", allowedWorkerHostIds: boundWorkerHostIds };
  const labels = new Map(
    hosts
      .filter((host) => host.enrollmentStatus === "active")
      .map((host) => [host.id, host.labels]),
  );
  const allowedWorkerHostIds = boundWorkerHostIds.filter((id) => {
    const carried = labels.get(id);
    return (
      carried !== undefined &&
      missingWorkerHostLabels(required, carried).length === 0 &&
      servesWorkspaceMcp(carried, workspaceMcp)
    );
  });
  if (allowedWorkerHostIds.length > 0) return { status: "eligible", allowedWorkerHostIds };
  const carried = boundWorkerHostIds.flatMap((id) => labels.get(id) ?? []);
  const absent = missingWorkerHostLabels(required, carried);
  const lapsedWorkspace = workspaceMcp
    .filter((server) => carried.includes(mcpLoginLabel(server)))
    .map(mcpServerLabel);
  const missingLabels =
    absent.length > 0
      ? absent
      : required.length > 0 || lapsedWorkspace.length === 0
        ? [...new Set([...required, ...lapsedWorkspace])]
        : lapsedWorkspace;
  const loginNeeded = new Set(carried.flatMap((label) => mcpServerOfLoginLabel(label) ?? []));
  const mcpLogins = missingLabels.flatMap((label) => {
    const server = mcpServerOfLabel(label);
    return server !== undefined && loginNeeded.has(server) ? [server] : [];
  });
  return {
    status: "unmet",
    missingLabels,
    requirement: workerHostLabelRequirement(missingLabels),
    ...(mcpLogins.length === 0 ? {} : { mcpLogins }),
  };
}

/**
 * The labels a Task needs: its Tag's `runsOn`, plus `mcp:NAME` for each MCP server its
 * granted tools use that its Workspace does not provide, so it runs only on a host that
 * provides those servers. Pass the Workspace's granted servers to `placeTask` as
 * `workspaceMcp`; whether a host must provide one is decided for that host alone.
 */
export function taskPlacementLabels(
  runsOn: readonly string[],
  authorization: Pick<TagAuthorizationSnapshot, "mcp"> | undefined,
  workspaceMcp: readonly string[] = [],
): readonly string[] {
  const servers = mcpPlacementLabels(authorization?.mcp).filter(
    (label) => !workspaceMcp.includes(label.slice("mcp:".length)),
  );
  return servers.length === 0 ? runsOn : [...new Set([...runsOn, ...servers])];
}

/** The granted MCP servers a Task's Workspace provides. */
export function workspaceMcpServers(
  authorization: Pick<TagAuthorizationSnapshot, "mcp"> | undefined,
  workspaceMcp: readonly string[] = [],
): readonly string[] {
  return mcpPlacementLabels(authorization?.mcp)
    .map((label) => label.slice("mcp:".length))
    .filter((server) => workspaceMcp.includes(server));
}

type Capability = { readonly id: string; readonly version: number };
type PlacementHost = Pick<WorkerHost, "id" | "enrollmentStatus" | "labels" | "workerSnapshot">;

/** Hosts to try in order, each with the capabilities its profile must add for selection. */
export interface PlacementTier {
  readonly allowedWorkerHostIds: readonly string[];
  readonly requires: readonly Capability[];
}

export type TaskPlacement =
  | { readonly status: "eligible"; readonly tiers: readonly PlacementTier[] }
  | {
      readonly status: "unmet";
      /** Scheduling requirement such as `labels:macos,gpu`. */
      readonly requirement: string;
      /** Labels no bound host carries, when labels are what is missing. */
      readonly missingLabels?: readonly string[];
      /** MCP servers held for `supertag mcp login NAME` on a bound host. */
      readonly mcpLogins?: readonly string[];
      /** Hosts whose harnesses would run the Task's commands unsandboxed without an opt-in. */
      readonly unsandboxedCommands?: readonly UnsandboxedCommandHold[];
      /** Provider reasons advertised by bound hosts when no profile can serve this Workspace. */
      readonly workspaceRefusals?: readonly string[];
    };

/** What placement needs to know about a Task besides its labels and Workspace. */
export interface TaskPlacementOptions {
  /** Resolved Volume requirements; only names cross the Worker Host boundary. */
  readonly mounts?: readonly {
    readonly volume: string;
    readonly strategy?: "copy" | "mount";
    readonly access?: "read-only" | "read-write";
    readonly credential?: string;
    readonly missing?: boolean;
    /** Why no host may mount this Volume, such as holding artifacts. */
    readonly refused?: string;
  }[];
  /**
   * Set when the Task may run commands (`commands:execute`). Hosts that report command sandboxing
   * then run it only on a profile that may run commands. `harness` is the Task's harness, if any.
   */
  readonly commands?: { readonly harness?: string };
}

interface VolumeLookup {
  findVolumeByName(
    name: string,
  ): Promise<{ readonly source: string; readonly credential?: string } | undefined>;
}

/** What the artifact-Volume guard reads: every Volume, every Worker Host, and recorded copies. */
interface ArtifactHolderLookup {
  listVolumes(): Promise<
    readonly { readonly id: string; readonly name: string; readonly source: string }[]
  >;
  listWorkerHosts(): Promise<readonly Pick<WorkerHost, "labels" | "workerSnapshot">[]>;
  listVolumeIdsHoldingArtifacts(): Promise<readonly string[]>;
}

/**
 * The Workspace plan a Task Attempt is dispatched with: its mounts' Volumes as the catalog holds
 * them now, with sources and credential names only. A Volume no longer in the catalog, or one
 * that holds artifacts, gets no mount credential. Every file artifact Volume is also carried
 * without a credential as a protected path, so the host can reject aliases the Control Plane
 * cannot resolve on its own filesystem.
 */
export async function dispatchedWorkspacePlan(
  store: object,
  plan: TaskWorkspacePlan,
): Promise<TaskWorkspacePlan> {
  if (plan.status !== "workspace" || plan.mounts === undefined || plan.mounts.length === 0)
    return plan;
  const { volumes: _stale, ...rest } = plan;
  if (!hasVolumeLookup(store)) return rest;
  const names = [...new Set(plan.mounts.map((mount) => mount.volume))];
  const artifacts = await artifactVolumes(store);
  const holdsArtifacts = guardArtifactVolumes(artifacts);
  const volumes = [];
  for (const name of names) {
    const volume = await store.findVolumeByName(name);
    // Never give an artifact Volume mount consent, even when placement predates its first copy.
    if (volume === undefined || holdsArtifacts(name, volume.source) !== undefined) continue;
    volumes.push({
      name,
      source: volume.source,
      ...(volume.credential ? { credential: volume.credential } : {}),
    });
  }
  for (const volume of artifacts ?? [])
    if (volumeLocation(volume.source)?.scheme === "file")
      volumes.push({ name: volume.name, source: volume.source });
  return { ...rest, volumes };
}

function hasVolumeLookup(store: object): store is VolumeLookup {
  return "findVolumeByName" in store && typeof store.findVolumeByName === "function";
}

function hasArtifactHolderLookup(store: object): store is ArtifactHolderLookup {
  return (
    "listVolumes" in store &&
    typeof store.listVolumes === "function" &&
    "listWorkerHosts" in store &&
    typeof store.listWorkerHosts === "function" &&
    "listVolumeIdsHoldingArtifacts" in store &&
    typeof store.listVolumeIdsHoldingArtifacts === "function"
  );
}

/**
 * Why a Volume may not be mounted because it holds artifacts, or undefined when it may. A Volume
 * holds artifacts when a Worker Host advertises it as its artifact Volume or the catalog records
 * an artifact copy on it. A mount of that Volume, or of any Volume whose location is, contains,
 * or sits inside its location, is refused: it would hand a Task every artifact there, bypassing
 * artifact grants. Locations are compared normalized (see `volumeLocationsOverlap`), never as
 * strings. A store that cannot list artifact holders refuses every mount rather than guess.
 */
export async function artifactVolumeGuard(
  store: object,
): Promise<(name: string, source: unknown) => string | undefined> {
  return guardArtifactVolumes(await artifactVolumes(store));
}

async function artifactVolumes(store: object): Promise<readonly TaskWorkspaceVolume[] | undefined> {
  if (!hasArtifactHolderLookup(store)) return undefined;
  const [volumes, hosts, recorded] = await Promise.all([
    store.listVolumes(),
    store.listWorkerHosts(),
    store.listVolumeIdsHoldingArtifacts(),
  ]);
  const advertised = new Set(
    hosts.flatMap((host) => [...host.labels, ...advertisedWorkerHostLabels(host.workerSnapshot)]),
  );
  const holding = new Set(recorded);
  return volumes.filter(
    (volume) => holding.has(volume.id) || advertised.has(artifactVolumeLabel(volume.name)),
  );
}

function guardArtifactVolumes(
  volumes: readonly TaskWorkspaceVolume[] | undefined,
): (name: string, source: unknown) => string | undefined {
  if (volumes === undefined)
    return (name) => `Volume ${name} cannot be checked for artifacts and cannot be mounted`;
  const holders = volumes.map((volume) => ({
    name: volume.name,
    location: artifactVolumeLocation(volume.source),
  }));
  return (name, source) => {
    if (holders.some((holder) => holder.name === name))
      return `Volume ${name} holds artifacts and cannot be mounted`;
    const location = volumeLocation(source);
    // Invalid mounts never gain consent, even when an artifact holder is invalid too.
    if (location === undefined) return `Volume ${name} has an invalid source and cannot be mounted`;
    const invalid = holders.find((holder) => holder.location === undefined);
    if (invalid !== undefined)
      return `Volume ${name} cannot be checked against artifact Volume ${invalid.name} and cannot be mounted`;
    const overlapping = holders.find(
      (holder) =>
        holder.location !== undefined && volumeLocationsOverlap(holder.location, location),
    );
    return overlapping === undefined
      ? undefined
      : `Volume ${name} overlaps artifact Volume ${overlapping.name} and cannot be mounted`;
  };
}

/**
 * Legacy HTTP artifact sources remain useful deny rules, though they cannot be mounted. Relax
 * only the HTTPS requirement for comparison; keep every other source validation and the original
 * port. Unknown locations still fail closed. Never use this result to open a Volume.
 */
function artifactVolumeLocation(source: unknown): ReturnType<typeof parseVolumeSource> | undefined {
  const location = volumeLocation(source);
  if (location !== undefined || typeof source !== "string") return location;
  const question = source.indexOf("?");
  if (question === -1) return undefined;
  const settings = new URLSearchParams(source.slice(question + 1));
  const endpoints = settings.getAll("endpoint");
  const endpoint = endpoints[0];
  if (endpoints.length !== 1 || !endpoint?.startsWith("http://")) return undefined;
  settings.set("endpoint", endpoint.replace(/^http:/u, "https:"));
  const validated = volumeLocation(`${source.slice(0, question)}?${settings}`);
  return validated === undefined || (validated.scheme !== "s3" && validated.scheme !== "r2")
    ? undefined
    : { ...validated, endpoint };
}

function volumeLocation(source: unknown): ReturnType<typeof parseVolumeSource> | undefined {
  try {
    return parseVolumeSource(source);
  } catch {
    return undefined;
  }
}

/** Resolves the immutable Workspace's Volume names for both surface and Objective placement. */
export async function volumeMountRequirements(
  store: object,
  plan: TaskWorkspacePlan,
): Promise<NonNullable<TaskPlacementOptions["mounts"]>> {
  const mounts = plan.status === "workspace" && "mounts" in plan ? plan.mounts : undefined;
  if (mounts === undefined) return [];
  if (!Array.isArray(mounts)) return [{ volume: "invalid mount", missing: true }];
  const holdsArtifacts = hasVolumeLookup(store)
    ? await artifactVolumeGuard(store)
    : () => undefined;
  return Promise.all(
    mounts.map(async (mount: unknown) => {
      if (
        mount === null ||
        typeof mount !== "object" ||
        !("volume" in mount) ||
        typeof mount.volume !== "string"
      )
        return { volume: "invalid mount", missing: true };
      const name = mount.volume;
      const strategy = "strategy" in mount ? mount.strategy : "copy";
      const access = "access" in mount ? mount.access : "read-only";
      if (strategy !== "copy" && strategy !== "mount")
        return {
          volume: name,
          refused: `Workspace mount ${name}: unsupported strategy ${String(strategy)}`,
        };
      if (access !== "read-only")
        return {
          volume: name,
          refused: `Workspace mount ${name}: ${strategy} does not support ${String(access)}`,
        };
      const native = strategy === "mount" ? ({ strategy, access } as const) : {};
      const volume = hasVolumeLookup(store) ? await store.findVolumeByName(name) : undefined;
      const refused = volume === undefined ? undefined : holdsArtifacts(name, volume.source);
      if (refused !== undefined) return { volume: name, refused };
      return volume === undefined
        ? { volume: name, missing: true }
        : volume.credential
          ? { volume: name, credential: volume.credential, ...native }
          : { volume: name, ...native };
    }),
  );
}

const COMMANDS_EXECUTE = { id: COMMANDS_EXECUTE_CAPABILITY_ID, version: 1 } as const;

/**
 * Placement options for a Task: `commands` when its authorization allows `commands:execute`.
 * `files:write` alone needs no sandbox check; harnesses write files through their own tools
 * inside the Task's worktree.
 */
export function commandPlacement(task: {
  readonly authorizationSnapshot: Pick<TagAuthorizationSnapshot, "runtimeActions">;
  readonly execution: Pick<TaskExecutionRequirements, "harness">;
}): TaskPlacementOptions {
  if (!task.authorizationSnapshot.runtimeActions.includes(COMMANDS_EXECUTE_ACTION)) return {};
  return {
    commands: task.execution.harness === undefined ? {} : { harness: task.execution.harness },
  };
}

/**
 * Places a Task among its Tag's bound Worker Hosts. Bindings decide which hosts may run it; the
 * Tag's `runsOn` labels choose among them. A named Workspace then prefers bound hosts with the
 * label `workspace:NAME`, on a profile that can use the checkout in place, and, when the
 * Workspace records a `source`, falls back to hosts whose Workers can clone it.
 */
export async function placeTask(
  boundWorkerHostIds: readonly string[],
  runsOn: readonly string[],
  plan: TaskWorkspacePlan,
  loadHosts: () => Promise<readonly PlacementHost[]>,
  workspaceMcp: readonly string[] = [],
  options: TaskPlacementOptions = {},
): Promise<TaskPlacement> {
  if (runsOn.length === 0 && plan.status !== "workspace" && options.commands === undefined)
    return {
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: boundWorkerHostIds, requires: [] }],
    };
  const hosts = await loadHosts();
  const placement = placeByLabelsAndWorkspace(
    boundWorkerHostIds,
    runsOn,
    plan,
    hosts,
    workspaceMcp,
  );
  if (placement.status === "unmet") return placement;
  const mounted = placeWorkspaceMounts(placement.tiers, hosts, options.mounts ?? []);
  if (mounted.status === "unmet" || options.commands === undefined) return mounted;
  return placeCommands(mounted.tiers, hosts, options.commands.harness);
}

/** Filters hosts and profiles before any provider call or Task Attempt reservation. */
export function placeWorkspaceMounts(
  tiers: readonly PlacementTier[],
  hosts: readonly PlacementHost[],
  mounts: readonly {
    readonly volume: string;
    readonly strategy?: "copy" | "mount";
    readonly access?: "read-only" | "read-write";
    readonly credential?: string;
    readonly missing?: boolean;
    readonly refused?: string;
  }[],
): TaskPlacement {
  if (mounts.length === 0) return { status: "eligible", tiers };
  const mountCapabilities = [...new Set(mounts.map((mount) => mount.strategy ?? "copy"))].map(
    (strategy) =>
      strategy === "mount" ? WORKSPACE_NATIVE_MOUNT_CAPABILITY : WORKSPACE_COPY_MOUNT_CAPABILITY,
  );
  const active = new Map(hosts.map((host) => [host.id, host]));
  const refusals: string[] = [];
  const eligible = tiers.flatMap((tier) => {
    const allowedWorkerHostIds = tier.allowedWorkerHostIds.filter((id) => {
      const host = active.get(id);
      if (host === undefined) return false;
      const reason = mounts
        .map((mount) => {
          if (mount.refused !== undefined) return mount.refused;
          if (mount.missing) return `Volume ${mount.volume} is unavailable`;
          const strategy = mount.strategy ?? "copy";
          if (mount.access !== undefined && mount.access !== "read-only")
            return `Workspace mount ${mount.volume}: ${strategy} does not support ${mount.access}`;
          if (
            strategy === "mount" &&
            !hasMountCapabilities(host.workerSnapshot, [WORKSPACE_NATIVE_MOUNT_CAPABILITY])
          )
            return `Workspace mount ${mount.volume}: native mount is unsupported on Worker Host ${id}; no profile advertises native read-only mount support`;
          if (
            !mount.credential ||
            !advertisedWorkerHostLabels(host.workerSnapshot).includes(
              volumeCredentialLabel(mount.credential),
            )
          )
            return `Volume ${mount.volume} has no credential mapping on Worker Host ${id}`;
          if (
            strategy === "copy" &&
            !hasMountCapabilities(host.workerSnapshot, [WORKSPACE_COPY_MOUNT_CAPABILITY])
          )
            return `Volume ${mount.volume} needs a Workspace environment that supports copy on Worker Host ${id}`;
          return undefined;
        })
        .find((value) => value !== undefined);
      if (reason !== undefined) refusals.push(reason);
      if (reason !== undefined) return false;
      if (!hasMountCapabilities(host.workerSnapshot, [...tier.requires, ...mountCapabilities])) {
        refusals.push(
          `Workspace mount ${mounts[0]?.volume}: no single eligible profile supports all requested mount strategies and placement requirements on Worker Host ${id}`,
        );
        return false;
      }
      return true;
    });
    return allowedWorkerHostIds.length === 0
      ? []
      : [
          {
            allowedWorkerHostIds,
            requires: [...tier.requires, ...mountCapabilities],
          },
        ];
  });
  return eligible.length > 0
    ? { status: "eligible", tiers: eligible }
    : {
        status: "unmet",
        requirement: `workspace.mount.${mounts[0]?.strategy ?? "copy"}:${mounts[0]?.volume ?? "unknown"}`,
        workspaceRefusals: [...new Set(refusals)],
      };
}

function hasMountCapabilities(
  snapshot: Readonly<Record<string, unknown>>,
  required: readonly { readonly id: string; readonly version: number }[],
): boolean {
  const workers = snapshot["workers"];
  if (!Array.isArray(workers)) return false;
  return workers.some((worker) => {
    if (worker === null || typeof worker !== "object") return false;
    const profiles = (worker as Record<string, unknown>)["profileCapabilities"];
    return (
      Array.isArray(profiles) &&
      profiles.some((profile) => {
        if (profile === null || typeof profile !== "object") return false;
        const capabilities = (profile as Record<string, unknown>)["capabilities"];
        return (
          Array.isArray(capabilities) &&
          required.every((requirement) =>
            capabilities.some(
              (capability) =>
                capability !== null &&
                typeof capability === "object" &&
                (capability as Record<string, unknown>)["id"] === requirement.id &&
                (capability as Record<string, unknown>)["version"] === requirement.version,
            ),
          )
        );
      })
    );
  });
}

/**
 * Narrows placement tiers for a Task that may run commands. A host whose profiles report command
 * sandboxing runs it only on a profile with `supertag.commands.execute`; one whose matching
 * harnesses all run commands unsandboxed without the host's opt-in is left out. Hosts that report
 * neither capability, such as custom Workers, are not checked. When every host is left out, the
 * Task is unmet with a reason naming each host's `allow-unsandboxed-commands` setting.
 */
export function placeCommands(
  tiers: readonly PlacementTier[],
  hosts: readonly PlacementHost[],
  harness?: string,
): TaskPlacement {
  const active = new Map(
    hosts.filter((host) => host.enrollmentStatus === "active").map((host) => [host.id, host]),
  );
  const held: UnsandboxedCommandHold[] = [];
  const placed: PlacementTier[] = [];
  for (const tier of tiers) {
    const checked: string[] = [];
    const unchecked: string[] = [];
    for (const id of tier.allowedWorkerHostIds) {
      const host = active.get(id);
      const support =
        host === undefined ? undefined : hostCommandSupport(host.workerSnapshot, harness);
      if (support === undefined || !support.reported) unchecked.push(id);
      else if (support.permitted || support.refused.length === 0) checked.push(id);
      else if (!held.some((hold) => hold.workerHostId === id))
        held.push({ workerHostId: id, harnesses: support.refused });
    }
    if (checked.length > 0)
      placed.push({
        allowedWorkerHostIds: checked,
        requires: [...tier.requires, COMMANDS_EXECUTE],
      });
    if (unchecked.length > 0)
      placed.push({ allowedWorkerHostIds: unchecked, requires: tier.requires });
  }
  if (placed.length > 0) return { status: "eligible", tiers: placed };
  return {
    status: "unmet",
    requirement: `${ALLOW_UNSANDBOXED_COMMANDS_SETTING}:${held.map((hold) => hold.workerHostId).join(",")}`,
    unsandboxedCommands: held,
  };
}

function placeByLabelsAndWorkspace(
  boundWorkerHostIds: readonly string[],
  runsOn: readonly string[],
  plan: TaskWorkspacePlan,
  hosts: readonly PlacementHost[],
  workspaceMcp: readonly string[],
): TaskPlacement {
  const labelled = placeByLabels(boundWorkerHostIds, hosts, runsOn, workspaceMcp);
  if (labelled.status === "unmet") return labelled;
  if (plan.status !== "workspace")
    return {
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: labelled.allowedWorkerHostIds, requires: [] }],
    };
  const label = workspaceLabel(plan.workspace);
  const active = new Map(
    hosts.filter((host) => host.enrollmentStatus === "active").map((host) => [host.id, host]),
  );
  const checkout = labelled.allowedWorkerHostIds.filter((id) =>
    active.get(id)?.labels.includes(label),
  );
  const clone =
    plan.source === undefined
      ? []
      : labelled.allowedWorkerHostIds.filter((id) => {
          const host = active.get(id);
          return (
            host !== undefined &&
            !host.labels.includes(label) &&
            advertisesWorkspaceClone(host.workerSnapshot)
          );
        });
  const environment =
    plan.source === undefined
      ? []
      : labelled.allowedWorkerHostIds.filter((id) => {
          const host = active.get(id);
          return (
            host !== undefined &&
            !checkout.includes(id) &&
            !clone.includes(id) &&
            advertisesWorkspaceEnvironment(host.workerSnapshot)
          );
        });
  const tiers: PlacementTier[] = [
    ...(checkout.length === 0
      ? []
      : [{ allowedWorkerHostIds: checkout, requires: [WORKSPACE_IN_PLACE_CAPABILITY] }]),
    ...(clone.length === 0 ? [] : [{ allowedWorkerHostIds: clone, requires: [] }]),
    ...(environment.length === 0
      ? []
      : [{ allowedWorkerHostIds: environment, requires: [WORKSPACE_ENVIRONMENT_CAPABILITY] }]),
  ];
  if (tiers.length > 0) return { status: "eligible", tiers };
  const workspaceRefusals = labelled.allowedWorkerHostIds.flatMap((id) => {
    const host = active.get(id);
    return host === undefined
      ? []
      : workspaceEnvironmentRefusals(host.workerSnapshot).map(
          (reason) => `Worker Host ${id}: ${reason}`,
        );
  });
  return plan.source === undefined
    ? {
        status: "unmet",
        requirement: workerHostLabelRequirement([label]),
        missingLabels: [label],
      }
    : {
        status: "unmet",
        requirement: `workspace.checkout-or-clone:${plan.workspace}`,
        ...(workspaceRefusals.length === 0 ? {} : { workspaceRefusals }),
      };
}

/** Execution requirements with placement-only capabilities added for selection. */
export function withRequiredCapabilities(
  execution: TaskExecutionRequirements,
  requires: readonly { readonly id: string; readonly version: number }[],
): TaskExecutionRequirements {
  const missing = requires.filter(
    (capability) =>
      !execution.requires?.some(
        (existing) => existing.id === capability.id && existing.version === capability.version,
      ),
  );
  return missing.length === 0
    ? execution
    : { ...execution, requires: [...(execution.requires ?? []), ...missing] };
}
