/**
 * Workspace environments: the interface every execution environment provider implements to run
 * a named Workspace, and the host-side pieces they share. A provider turns one trusted
 * {@link WorkspaceDefinition} into a {@link PreparedWorkspace} (`prepare`), starts each Task from
 * it (`start`), commits the Task's work (`finalize`), and discards artifacts (`evict`). The Worker
 * Host keeps the repository, its credentials, the prepared-artifact cache, and delivery.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_WORKSPACE_REF,
  type TaskNamedWorkspacePlan,
  type WorkspaceMount,
} from "@supertag/core";
import type {
  WorkspaceAttemptOutcome,
  WorkspaceDeliveryRecord,
  WorkspacePullRequestOutcome,
} from "./git-workspace.js";
import type { EnvironmentPlan, ExecutionEnvironment, WorkerProfile } from "./index.js";
import type { VolumeResolver } from "./volume-copy.js";
import type { WorkspaceMcpResolution, WorkspaceMcpServerDefinition } from "./workspace-mcp.js";

// ---------------------------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------------------------

/** Git objects built on the Worker Host: a bundle file and the SHA-256 digest of its bytes. */
export interface GitObjects {
  /** Host path of a `git bundle` file. */
  readonly bundle: string;
  readonly digest: string;
}

/** The commit identity a provider commits Task work with. */
export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

/**
 * The validated subset of a trusted commit's `devcontainer.json` that providers translate.
 * Read and validated by the Worker before `prepare`; local ignores it.
 */
export interface DevcontainerSubset {
  readonly image?: string;
  readonly build?: {
    readonly dockerfile: string;
    /** Resolved path and bytes read with git from the trusted commit. */
    readonly dockerfilePath?: string;
    readonly dockerfileContent?: string;
    /** SHA-256 of the Dockerfile at the trusted commit; part of every prepared digest. */
    readonly dockerfileDigest: string;
    readonly context?: string;
    readonly args?: Readonly<Record<string, string>>;
  };
  readonly onCreateCommand?: DevcontainerCommand;
  readonly updateContentCommand?: DevcontainerCommand;
  readonly postCreateCommand?: DevcontainerCommand;
  readonly containerEnv?: Readonly<Record<string, string>>;
  readonly remoteEnv?: Readonly<Record<string, string>>;
  readonly remoteUser?: string;
  readonly containerUser?: string;
  readonly workspaceFolder?: string;
}

/** A devcontainer lifecycle command in any of its three forms. */
export type DevcontainerCommand =
  | string
  | readonly string[]
  | Readonly<Record<string, string | readonly string[]>>;

/** What a Task's Harness needs installed in a prepared environment, from its Worker Profile. */
export interface WorkspaceHarnessRequirement {
  readonly commands: readonly string[];
  readonly install?: string;
}

/**
 * The harness requirement of a Worker Profile: the Harness provider it selects, such as `codex`.
 * Providers install it in a prepared environment, and it is part of every prepared digest, so a
 * profile with another Harness never reuses an artifact prepared for this one.
 */
export function workspaceHarnessRequirement(
  profile: Pick<WorkerProfile, "harness"> & Partial<Pick<WorkerProfile, "runtime">>,
): WorkspaceHarnessRequirement {
  if (profile.runtime !== undefined && ["claude-code", "cursor"].includes(profile.harness.provider))
    return { commands: [] };
  return { commands: [profile.harness.provider] };
}

/**
 * One Workspace as every provider sees it, built by the Worker from the Task's plan and its host
 * repository. Everything here comes from the trusted commit or the operator; nothing an AI actor
 * wrote.
 */
export interface WorkspaceDefinition {
  readonly workspace: string;
  /** Normalized source URL; `file:` only for local. */
  readonly source: string;
  /**
   * The newest commit both the Task's base and the Workspace's operator-chosen ref contain. Setup,
   * MCP servers, Skills, and devcontainer settings are read only from it.
   */
  readonly trustedCommit: string;
  /**
   * A bundle of the trusted commit, built on the host, for providers that prepare away from it.
   * Absent for a provider whose `capabilities.setupOnHost` is true: local prepares from the host
   * repository itself.
   */
  readonly content?: GitObjects;
  /** Host repository for data-only reads while staging a trusted Docker build context. */
  readonly trustedRepository?: string;
  readonly setup?: string;
  /** From the trusted commit, already validated. */
  readonly devcontainer?: DevcontainerSubset;
  /**
   * The selected MCP servers as the trusted commit declares them, and their digest, as a Task's
   * `mcpPin` records it. Resolved servers can hold host credentials, so they stay with the Worker
   * and never reach a provider; see {@link WorkspaceMcpServerDefinition}.
   */
  readonly mcp?: {
    readonly digest: string;
    readonly servers: readonly WorkspaceMcpServerDefinition[];
  };
  readonly harness: WorkspaceHarnessRequirement;
  /**
   * The Task the prepared environment belongs to, set exactly when the provider's
   * `capabilities.sharedPrepare` is false. It is then part of the prepared digest.
   */
  readonly taskId?: string;
  /**
   * Warm prepare: an artifact this host prepared for the same definition at an ancestor of the
   * trusted commit. The provider starts from it and runs `setup` again on the new trusted commit.
   * Set only by {@link PreparedWorkspaceCache}; never part of the prepared digest.
   */
  readonly warmFrom?: PreparedWorkspace;
}

/** What the Worker knows about a Workspace when it builds a {@link WorkspaceDefinition}. */
export interface WorkspaceDefinitionInput extends Omit<WorkspaceDefinition, "mcp"> {
  /**
   * The selected MCP servers as the Worker resolved them. Only their declared definitions and
   * digest are kept.
   */
  readonly mcp?: WorkspaceMcpResolution;
}

/**
 * The definition every provider sees. Resolved MCP servers, which can hold host credentials, are
 * reduced to their declared definitions and digest; nothing else the Worker resolved is added.
 */
export function workspaceDefinition(input: WorkspaceDefinitionInput): WorkspaceDefinition {
  return {
    workspace: input.workspace,
    source: input.source,
    trustedCommit: input.trustedCommit,
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.trustedRepository === undefined
      ? {}
      : { trustedRepository: input.trustedRepository }),
    ...(input.setup === undefined ? {} : { setup: input.setup }),
    ...(input.devcontainer === undefined ? {} : { devcontainer: input.devcontainer }),
    ...(input.mcp === undefined
      ? {}
      : { mcp: { digest: input.mcp.digest, servers: input.mcp.definitions.map(copyDefinition) } }),
    harness: input.harness,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  };
}

/** Copies exactly the declared fields, so nothing else a caller attached reaches a provider. */
function copyDefinition(definition: WorkspaceMcpServerDefinition): WorkspaceMcpServerDefinition {
  return definition.transport === "http"
    ? { name: definition.name, transport: "http" }
    : {
        name: definition.name,
        transport: "stdio",
        command: definition.command,
        args: [...definition.args],
        env: { ...definition.env },
      };
}

/** A provider-native artifact prepared from one definition, reused by digest. */
export interface PreparedWorkspace {
  /** `sha256:` digest of the definition's cache key; see {@link preparedWorkspaceDigest}. */
  readonly digest: string;
  /** The provider that owns the artifact, such as `local`, `e2b`, or `modal`. */
  readonly provider: string;
  /** Provider-native artifact: a worktree path, template name, or image ID. */
  readonly artifact: string;
  readonly trustedCommit: string;
  /** Checkout directory inside a remote prepared artifact. */
  readonly workspaceDirectory?: string;
}

/** One Task Attempt's checkout of its branch, started from a prepared artifact. */
export interface TaskCheckout {
  readonly taskId: string;
  readonly attemptId: string;
  /** Operator-defined mounts, resolved from the Task's admission plan. */
  readonly mounts?: readonly WorkspaceMount[];
  /**
   * Resolves the Volumes `mounts` name, with their credentials, on the Worker Host. `start`
   * downloads each `copy` mount through it and delivers files only; nothing it returns is passed
   * to a provider or the Task. Required when `mounts` is not empty.
   */
  readonly volumes?: VolumeResolver;
  /** The Task branch, `supertag/<objective>/<task>`. */
  readonly branch: string;
  /** The commit Task changes are measured from. */
  readonly base: string;
  /** The commit to check out: the branch head, a reviewed commit, or the base. */
  readonly head: string;
  /** Objects from the trusted commit to `head`, for remote providers only. */
  readonly objects?: GitObjects;
  /** The Task's network policy, mounts, and files. */
  readonly plan: EnvironmentPlan;
}

/** The Task branch after `finalize` committed whatever the Attempt left. */
export interface FinalizedWork {
  readonly head: string;
  /** True when the Attempt left changes that `finalize` committed. */
  readonly committed: boolean;
  /** Objects from the base to `head`, read out of a remote sandbox. Absent for local. */
  readonly objects?: GitObjects;
  /** Direct writes uploaded from read-write copy mounts, including partial failures. */
  readonly mountOutputManifests?: readonly import("@supertag/core").MountOutputManifest[];
}

/** What a provider can do, so the Worker can choose and refuse without calling it. */
export interface WorkspaceEnvironmentCapabilities {
  /** Supported Workspace mount strategies; absent means no mounts. */
  readonly mounts?: {
    readonly strategies: readonly ("copy" | "mount")[];
    readonly access: readonly ("read-only" | "read-write")[];
  };
  /** True when one prepared artifact serves many Tasks; false means one artifact per Task. */
  readonly sharedPrepare: boolean;
  /** True only for local: `setup` runs on the Worker Host. */
  readonly setupOnHost: boolean;
  /** True when the provider serves checkouts an operator declared, not only sources. */
  readonly declaredCheckouts: boolean;
  /** True when the provider translates `devcontainer.json`. */
  readonly devcontainer: boolean;
  /** Where Workspace stdio MCP servers run. */
  readonly mcpStdio: "host" | "sandbox";
}

/** The commit `finalize` makes. */
export interface WorkspaceCommit {
  readonly message: string;
  readonly author: GitAuthor;
}

/**
 * An execution environment provider's translation of a Workspace. `refuse` runs before any
 * provider call; `prepare` reads only trusted content; `start` is per Task Attempt; `finalize`
 * runs for every outcome; `evict` discards a prepared artifact.
 */
export interface WorkspaceEnvironment {
  /** Provider name recorded in {@link PreparedWorkspace.provider}. */
  readonly provider: string;
  /** The provider's base, such as a template or image; part of every prepared digest. */
  readonly base?: string;
  readonly capabilities: WorkspaceEnvironmentCapabilities;
  /**
   * Where `prepare` places the copy of the trusted commit that Workspace stdio MCP servers run
   * from: an absolute path inside every Task sandbox, outside the checkout. Set exactly when
   * `capabilities.mcpStdio` is `sandbox`.
   */
  readonly mcpDirectory?: string;
  /**
   * Remote providers: the Harness's view of a started Task checkout, rooted at the checkout's
   * parent so that files the Harness stages or writes at its root, such as credentials, session
   * state, inputs, and outputs, never enter the checkout `finalize` commits. The view refuses a
   * plan that stages into the checkout. Set together with `checkoutPath`.
   */
  harnessEnvironment?(started: ExecutionEnvironment): ExecutionEnvironment;
  /** Where the checkout sits within `harnessEnvironment`'s view, as a relative path. */
  readonly checkoutPath?: string;
  /** A reason naming what this provider cannot run, or undefined. Makes no provider call. */
  refuse(definition: WorkspaceDefinition): string | undefined;
  /** Source-specific native refusal, without provider calls. */
  refuseMount?(
    mount: WorkspaceMount,
    volume: import("./volume-copy.js").ResolvedVolume,
  ): string | undefined;
  prepare(definition: WorkspaceDefinition, signal?: AbortSignal): Promise<PreparedWorkspace>;
  start(
    prepared: PreparedWorkspace,
    task: TaskCheckout,
    signal?: AbortSignal,
  ): Promise<ExecutionEnvironment>;
  /** Commits the Attempt's work, for every outcome. No changes means `committed: false`. */
  finalize(
    environment: ExecutionEnvironment,
    commit: WorkspaceCommit,
    signal?: AbortSignal,
  ): Promise<FinalizedWork>;
  evict(prepared: PreparedWorkspace): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------------------------

/** The inputs a prepared digest covers. Any change makes a new digest. */
export interface PreparedWorkspaceKey {
  readonly provider: string;
  readonly base?: string;
  readonly source: string;
  readonly trustedCommit: string;
  readonly setup?: string;
  readonly devcontainer?: DevcontainerSubset;
  readonly mcpDigest?: string;
  readonly harness: WorkspaceHarnessRequirement;
  readonly taskId?: string;
}

/** The cache key of a definition for a provider. */
export function preparedWorkspaceKey(
  environment: Pick<WorkspaceEnvironment, "provider" | "base" | "capabilities">,
  definition: WorkspaceDefinition,
): PreparedWorkspaceKey {
  if (!environment.capabilities.sharedPrepare && definition.taskId === undefined)
    throw new Error(
      `Workspace environment ${environment.provider} prepares one artifact per Task, so its definition needs a Task id`,
    );
  return {
    provider: environment.provider,
    ...(environment.base === undefined ? {} : { base: environment.base }),
    source: definition.source,
    trustedCommit: definition.trustedCommit,
    ...(definition.setup === undefined ? {} : { setup: definition.setup }),
    ...(definition.devcontainer === undefined
      ? {}
      : {
          devcontainer:
            definition.devcontainer.build === undefined
              ? definition.devcontainer
              : {
                  ...definition.devcontainer,
                  build: {
                    dockerfile: definition.devcontainer.build.dockerfile,
                    dockerfileDigest: definition.devcontainer.build.dockerfileDigest,
                    ...(definition.devcontainer.build.context === undefined
                      ? {}
                      : { context: definition.devcontainer.build.context }),
                    ...(definition.devcontainer.build.args === undefined
                      ? {}
                      : { args: definition.devcontainer.build.args }),
                  },
                },
        }),
    ...(definition.mcp === undefined ? {} : { mcpDigest: definition.mcp.digest }),
    harness: definition.harness,
    ...(environment.capabilities.sharedPrepare ? {} : { taskId: definition.taskId as string }),
  };
}

/** SHA-256 of the key's canonical JSON, as `sha256:<hex>`. */
export function preparedWorkspaceDigest(
  environment: Pick<WorkspaceEnvironment, "provider" | "base" | "capabilities">,
  definition: WorkspaceDefinition,
): string {
  return `sha256:${sha256(canonicalJson(preparedWorkspaceKey(environment, definition)))}`;
}

/**
 * The key with the trusted commit left out. Warm prepare starts from the newest artifact with the
 * same warm key whose trusted commit is an ancestor of the new one.
 */
export function preparedWorkspaceWarmKey(
  environment: Pick<WorkspaceEnvironment, "provider" | "base" | "capabilities">,
  definition: WorkspaceDefinition,
): string {
  const { trustedCommit: _trusted, ...rest } = preparedWorkspaceKey(environment, definition);
  return `sha256:${sha256(canonicalJson(rest))}`;
}

/** JSON with object keys sorted and undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// The prepared-artifact cache
// ---------------------------------------------------------------------------------------------

/**
 * Fixed limits, with no settings: keep at most three prepared artifacts per Workspace per host,
 * and evict any unused for 7 days. Reuse is keyed to the exact trusted commit, so there is no
 * time-based reuse window.
 */
export const PREPARED_WORKSPACE_LIMITS = {
  perWorkspace: 3,
  unusedMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** What the host records for one shared prepared artifact, at `prepared/<digest>.json`. */
export interface PreparedWorkspaceRecord extends PreparedWorkspace {
  readonly workspace: string;
  readonly warmKey: string;
  readonly preparedAt: string;
  readonly lastUsedAt: string;
}

export interface PreparedWorkspaceCacheOptions {
  /** Records live under `<root>/<workspace>/prepared`. */
  readonly root: string;
  /** How long to wait for another process's lock on one digest. Default: 10 minutes. */
  readonly lockTimeoutMs?: number;
  /** Clock for records and eviction. Default: `Date.now`. */
  readonly now?: () => number;
  /**
   * True when `ancestor` is an ancestor of `descendant` in the Workspace's host repository.
   * Enables warm prepare for shared providers; without it every miss prepares from the base.
   */
  readonly isAncestor?: (
    workspace: string,
    ancestor: string,
    descendant: string,
  ) => Promise<boolean>;
}

/**
 * The host's authority on prepared artifacts: digest lookup, one lock per digest so concurrent
 * Tasks prepare once, and eviction. Only `prepare` output enters it, never anything a Task wrote.
 * A provider whose `sharedPrepare` is false is serialized per digest but keeps no record: its
 * artifact belongs to one Task.
 */
export class PreparedWorkspaceCache {
  readonly #root: string;
  readonly #lockTimeoutMs: number;
  readonly #now: () => number;
  readonly #isAncestor: PreparedWorkspaceCacheOptions["isAncestor"];
  readonly #locks = new KeyedSerializer();
  /** Shared providers this cache has prepared with, so eviction can reach their artifacts. */
  readonly #environments = new Map<string, WorkspaceEnvironment>();
  /** Records this process is evicting. A prepare during a provider's evict skips, never waits. */
  readonly #evicting = new Set<string>();

  constructor(options: PreparedWorkspaceCacheOptions) {
    this.#root = resolve(options.root);
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 600_000;
    this.#now = options.now ?? Date.now;
    this.#isAncestor = options.isAncestor;
  }

  /** The record path for a digest. */
  recordPath(workspace: string, digest: string): string {
    return join(
      this.#root,
      workspaceDirectoryName(workspace),
      "prepared",
      `${digestHex(digest)}.json`,
    );
  }

  /** The recorded artifact for a digest, or undefined. */
  async read(workspace: string, digest: string): Promise<PreparedWorkspaceRecord | undefined> {
    const text = await readFile(this.recordPath(workspace, digest), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (text === undefined) return undefined;
    const record = parseRecord(text);
    if (record === undefined || record.digest !== digest || record.workspace !== workspace)
      throw new Error(
        `Prepared Workspace record ${this.recordPath(workspace, digest)} is invalid; remove it`,
      );
    return record;
  }

  /** Every record for a Workspace, newest use first. */
  async list(workspace: string): Promise<readonly PreparedWorkspaceRecord[]> {
    const directory = join(this.#root, workspaceDirectoryName(workspace), "prepared");
    const records: PreparedWorkspaceRecord[] = [];
    for (const entry of await readdir(directory).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{64}\.json$/u.test(entry)) continue;
      const record = parseRecord(await readFile(join(directory, entry), "utf8").catch(() => ""));
      if (record?.workspace === workspace) records.push(record);
    }
    return records.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
  }

  /**
   * The prepared artifact for a definition: the recorded one for the same digest, else a new one
   * from `environment.prepare`. Concurrent callers with one digest, in this process or another
   * sharing the root, wait for a single prepare. On a miss for a shared provider, the newest
   * recorded artifact at an ancestor trusted commit becomes the definition's `warmFrom`. A new
   * Every shared prepare, hit or miss, then evicts beyond {@link PREPARED_WORKSPACE_LIMITS}.
   */
  async prepare(
    environment: WorkspaceEnvironment,
    definition: WorkspaceDefinition,
    signal?: AbortSignal,
  ): Promise<{
    readonly prepared: PreparedWorkspace;
    readonly reused: boolean;
    /** The artifact a warm prepare started from. */
    readonly warmFrom?: PreparedWorkspace;
  }> {
    // Only this cache chooses a warm start, from its own records.
    const { warmFrom: _ignored, ...cold } = definition;
    const digest = preparedWorkspaceDigest(environment, cold);
    const shared = environment.capabilities.sharedPrepare;
    if (shared) this.#environments.set(environment.provider, environment);
    const result = await this.#locked(cold.workspace, digest, async () => {
      if (shared) {
        const recorded = await this.read(cold.workspace, digest);
        if (recorded !== undefined && recorded.provider === environment.provider) {
          await this.#write({ ...recorded, lastUsedAt: new Date(this.#now()).toISOString() });
          return { prepared: preparedOf(recorded), reused: true };
        }
      }
      const warmKey = preparedWorkspaceWarmKey(environment, cold);
      const isAncestor = this.#isAncestor;
      const warm =
        shared && isAncestor !== undefined
          ? await this.warmStart(cold.workspace, warmKey, (commit) =>
              commit === cold.trustedCommit
                ? Promise.resolve(false)
                : isAncestor(cold.workspace, commit, cold.trustedCommit).catch(() => false),
            )
          : undefined;
      const warmFrom =
        warm !== undefined && warm.provider === environment.provider ? preparedOf(warm) : undefined;
      const prepared = await environment.prepare(
        warmFrom === undefined ? cold : { ...cold, warmFrom },
        signal,
      );
      if (prepared.digest !== digest || prepared.provider !== environment.provider)
        throw new Error(
          `Workspace environment ${environment.provider} prepared ${prepared.digest} for digest ${digest}`,
        );
      if (shared) {
        const now = new Date(this.#now()).toISOString();
        await this.#write({
          ...preparedOf(prepared),
          workspace: cold.workspace,
          warmKey,
          preparedAt: now,
          lastUsedAt: now,
        });
      }
      return { prepared, reused: false, ...(warmFrom === undefined ? {} : { warmFrom }) };
    });
    // Outside the digest lock: eviction takes other digests' locks.
    if (shared)
      await this.evict(cold.workspace, environment, new Set([digest])).catch(() => undefined);
    return result;
  }

  /**
   * The newest record with the same warm key whose trusted commit `isAncestor` accepts, for warm
   * prepare. The provider runs setup again on top of it; the record itself never changes.
   */
  async warmStart(
    workspace: string,
    warmKey: string,
    isAncestor: (trustedCommit: string) => Promise<boolean>,
  ): Promise<PreparedWorkspaceRecord | undefined> {
    for (const record of await this.list(workspace))
      if (record.warmKey === warmKey && (await isAncestor(record.trustedCommit))) return record;
    return undefined;
  }

  /**
   * Evicts a Workspace's records on this host beyond {@link PREPARED_WORKSPACE_LIMITS}: any unused
   * for 7 days, then all but the three most recently used, counted across providers. `environments`
   * adds to the providers this cache has prepared with; a record whose provider is in neither
   * stays until its provider is available to evict it, and does not count toward the limit. `keep`
   * names digests in use, which stay.
   */
  async evict(
    workspace: string,
    environments: WorkspaceEnvironment | readonly WorkspaceEnvironment[] = [],
    keep: ReadonlySet<string> = new Set(),
  ): Promise<readonly PreparedWorkspaceRecord[]> {
    const now = this.#now();
    const providers = new Map(this.#environments);
    for (const environment of Array.isArray(environments) ? environments : [environments])
      providers.set(environment.provider, environment);
    const evicted: PreparedWorkspaceRecord[] = [];
    let kept = 0;
    for (const record of await this.list(workspace)) {
      const unused = now - Date.parse(record.lastUsedAt) > PREPARED_WORKSPACE_LIMITS.unusedMs;
      const environment = providers.get(record.provider);
      // A record whose provider is unavailable stays, but takes no slot from the available ones.
      if (environment === undefined) continue;
      if (keep.has(record.digest) || (!unused && kept < PREPARED_WORKSPACE_LIMITS.perWorkspace)) {
        kept += 1;
        continue;
      }
      const key = `${workspace}\0${record.digest}`;
      if (this.#evicting.has(key)) continue;
      this.#evicting.add(key);
      const removed = await this.#locked(workspace, record.digest, async () => {
        // Another process may have reused or evicted the artifact since the listing.
        const current = await this.read(workspace, record.digest).catch(() => undefined);
        if (current === undefined || current.lastUsedAt !== record.lastUsedAt) return false;
        await environment.evict(preparedOf(current));
        await rm(this.recordPath(workspace, record.digest), { force: true });
        return true;
      }).finally(() => this.#evicting.delete(key));
      if (removed) evicted.push(record);
    }
    return evicted;
  }

  async #write(record: PreparedWorkspaceRecord): Promise<void> {
    const path = this.recordPath(record.workspace, record.digest);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  #locked<T>(workspace: string, digest: string, work: () => Promise<T>): Promise<T> {
    return this.#locks.run(`${workspace}\0${digest}`, async () => {
      const directory = join(this.#root, workspaceDirectoryName(workspace), "prepared");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await acquireLockFile(
        join(directory, `${digestHex(digest)}.lock`),
        this.#lockTimeoutMs,
      );
      try {
        return await work();
      } finally {
        await release();
      }
    });
  }
}

function preparedOf(record: PreparedWorkspace): PreparedWorkspace {
  return {
    digest: record.digest,
    provider: record.provider,
    artifact: record.artifact,
    trustedCommit: record.trustedCommit,
    ...(record.workspaceDirectory === undefined
      ? {}
      : { workspaceDirectory: record.workspaceDirectory }),
  };
}

function parseRecord(text: string): PreparedWorkspaceRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = value as Partial<Record<keyof PreparedWorkspaceRecord, unknown>>;
  const fields = [
    "digest",
    "provider",
    "artifact",
    "trustedCommit",
    "workspace",
    "warmKey",
    "preparedAt",
    "lastUsedAt",
  ] as const;
  if (typeof value !== "object" || value === null) return undefined;
  if (!fields.every((field) => typeof record[field] === "string")) return undefined;
  if (record.workspaceDirectory !== undefined && typeof record.workspaceDirectory !== "string")
    return undefined;
  return value as PreparedWorkspaceRecord;
}

function digestHex(digest: string): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(digest);
  if (!match) throw new Error(`Invalid prepared Workspace digest ${JSON.stringify(digest)}`);
  return match[1] as string;
}

function workspaceDirectoryName(workspace: string): string {
  if (!WORKSPACE_NAME.test(workspace))
    throw new Error(`Invalid Workspace name ${JSON.stringify(workspace)}`);
  return workspace;
}

/** Workspace names, as `supertag.yaml` and Workspace manifests accept them. */
export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

// ---------------------------------------------------------------------------------------------
// The host repository and Worker git commands
// ---------------------------------------------------------------------------------------------

/**
 * A username and password git uses for one https command. SuperTag passes it to that command
 * through its environment and a command-line credential helper; it never reaches git config,
 * remote URLs, or a credential store.
 */
export interface GitSourceCredential {
  readonly username: string;
  readonly password: string;
}

/** A Workspace's repository on the Worker Host. */
export interface WorkspaceRepository {
  readonly path: string;
  /** True for a host-managed bare clone of the Workspace source; false for a declared checkout. */
  readonly managed: boolean;
}

/** A Task worktree, addressed through the private git directory its repository recorded. */
export interface WorkspaceWorktree {
  readonly path: string;
  /**
   * Found from the repository, never from the worktree's `.git` file, which the harness can
   * rewrite to point git at a configuration it wrote.
   */
  readonly gitDir: string;
}

/** The repository's git config changed during a Task Attempt; the Worker ran no further git. */
export class WorkspaceIntegrityError extends Error {
  override name = "WorkspaceIntegrityError";
}

/**
 * Merging a dependency's delivered branch conflicted, so the Task Attempt fails before its harness
 * starts. It is a Workspace setup failure; `paths` are the conflicting files.
 */
export class WorkspaceMergeConflictError extends Error {
  override name = "WorkspaceSetupError";
  readonly paths: readonly string[];
  constructor(paths: readonly string[], message = `Merge conflict in ${paths.join(", ")}`) {
    super(message);
    this.paths = paths;
  }
}

/** The fields of a Workspace the host repository needs. */
export interface WorkspaceSourceRef {
  readonly workspace: string;
  readonly source?: string;
  readonly ref?: string;
}

export interface WorkspaceHostOptions {
  /** Workspace state lives under `<root>/<workspace>`. */
  readonly root: string;
  /** Declared checkouts by Workspace name. Paths never leave the host. */
  readonly checkouts: ReadonlyMap<string, string>;
  /** Serve Workspaces without a declared checkout from a bare clone of their source. */
  readonly cloneSources: boolean;
  /** Git executable. Default: `git` on PATH. */
  readonly git?: string;
  /** How long to wait for another process's repository lock. Default: 10 minutes. */
  readonly lockTimeoutMs?: number;
}

/**
 * Every Worker git command runs without hooks, a filesystem monitor, or submodule recursion. A
 * relative `core.hooksPath`, such as husky's `.husky`, would otherwise run scripts from the Task
 * worktree, which the harness writes, on the Worker Host.
 */
const WORKER_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "submodule.recurse=false",
] as const;

/**
 * Git commands that talk to a remote. They run in the repository, never in a working tree, and
 * keep the host's global and system config so credential helpers and proxies work. Every other
 * Worker git command reads only the repository's own config.
 */
const NETWORK_GIT_COMMANDS: ReadonlySet<string> = new Set(["fetch", "push", "ls-remote"]);

/**
 * Configuration for commands that read or write a working tree: no global attributes file, on
 * top of the environment that drops global and system config. A committed `.gitattributes`
 * can then select only drivers the repository itself defines, plus `lfs` when the host has it.
 */
const WORKING_TREE_GIT_CONFIG = ["-c", "core.attributesFile=/dev/null"] as const;

/** The one filter driver working-tree commands take from host config, by name. */
const LFS_FILTER_KEYS = ["clean", "smudge", "process", "required"] as const;

/** Diffs never run an external diff program or a textconv driver. */
export const SAFE_DIFF = ["--no-ext-diff", "--no-textconv"] as const;

/**
 * Well-known generated paths that are never source, as git glob pathspecs. A Task Attempt's
 * commit leaves them out when they are untracked, even in a repository whose `.gitignore` does
 * not list them; a tracked file under one is still committed when it changes. The exclusion
 * wins over a `.gitignore` negation such as `!keep.pyc`, so commit such a file once to keep it
 * tracked. `dist/` and `build/` are absent because some repositories commit their builds.
 */
const GENERATED_PATHS = [
  "**/__pycache__/**",
  "**/*.pyc",
  "**/*.pyo",
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  "**/.ruff_cache/**",
  "**/.tox/**",
  "**/.venv/**",
  "**/*.egg-info/**",
  "**/.coverage",
  "**/.coverage.*",
  "**/htmlcov/**",
  "**/node_modules/**",
  "**/.next/**",
  "**/.DS_Store",
] as const;

/**
 * The two `git add` argument lists that stage an Attempt's work: every change to a tracked file,
 * then every untracked file that neither the repository ignores nor {@link GENERATED_PATHS} lists.
 */
export const COMMIT_STAGING: readonly (readonly string[])[] = [
  ["add", "--update"],
  ["add", "--all", "--", ".", ...GENERATED_PATHS.map((path) => `:(exclude,glob)${path}`)],
];

const HOST_LFS_FILTERS = new Map<string, Promise<readonly string[]>>();

const REMOTE = "origin";
const DEFAULT_BRANCH_MARKER = "supertag-default-branch";
const WORKTREE_REMOVED = "removed";

/**
 * Digests of repository git settings that a harness could change, including resolved config
 * values and shared attributes, excludes, and hooks. File snapshots retain exact bytes and modes.
 */
interface GitIntegrityDigest {
  readonly "repository config": string;
  readonly "worktree config": string;
  readonly "info/attributes": string;
  readonly "info/exclude": string;
  readonly hooks: string;
}

interface GitFileSnapshot {
  readonly bytes?: Buffer;
  readonly link?: string;
  readonly directory?: true;
  readonly mode?: number;
}

/** What an Attempt recorded at its start, so later git commands can check it. */
interface AttemptIntegrity {
  readonly commonDir: string;
  readonly tree: WorkspaceWorktree;
  readonly digest: GitIntegrityDigest;
  readonly files: ReadonlyMap<string, GitFileSnapshot>;
  /** Set once a check failed; every later git command for the Attempt is refused with it. */
  failure?: WorkspaceIntegrityError;
}

/**
 * The host side of every Workspace: its repository, a declared checkout or a bare clone fetched
 * with host credentials, the trusted commit computed from it, repository locks, and every Worker
 * git command. Git runs without a shell, hooks, or host config in working-tree commands. Inside
 * {@link checked}, each command first compares the repository's git config with the digest the
 * Attempt recorded at its start.
 */
export class WorkspaceHost {
  readonly root: string;
  readonly git: string;
  readonly #checkouts: ReadonlyMap<string, string>;
  readonly #cloneSources: boolean;
  readonly #lockTimeoutMs: number;
  readonly #locks = new KeyedSerializer();
  readonly #integrity = new Map<string, AttemptIntegrity>();
  /** The Attempt whose recorded git digest each git command run in this async context checks. */
  readonly #checkedAttempt = new AsyncLocalStorage<string>();

  constructor(options: WorkspaceHostOptions) {
    this.root = resolve(options.root);
    this.git = options.git ?? "git";
    this.#checkouts = options.checkouts;
    this.#cloneSources = options.cloneSources;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 600_000;
  }

  /** Names with a declared checkout on this host. */
  get declared(): readonly string[] {
    return [...this.#checkouts.keys()].sort();
  }

  /** Declared repositories may live outside the host's managed worktree root. */
  get declaredCheckoutPaths(): readonly string[] {
    return [...this.#checkouts.values()];
  }

  get clonesSources(): boolean {
    return this.#cloneSources;
  }

  /** The host-managed bare clone of a Workspace source. */
  clonePath(workspace: string): string {
    return join(this.root, workspace, "clone");
  }

  /** One operation at a time per key within this process. */
  serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    return this.#locks.run(key, work);
  }

  /**
   * Exclusive access to a Workspace's repository: serialized in this process, and guarded by a
   * lock file against other Worklet processes that share the same Workspace root. Not reentrant.
   */
  async exclusive<T>(workspace: string, work: () => Promise<T>): Promise<T> {
    // Workspace aliases and linked checkouts share the actual Git repository lock.
    const directory = this.#checkouts.has(workspace)
      ? await realpath(
          (
            await this.run(await this.#checkout(workspace), [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ])
          ).trim(),
        )
      : join(this.root, workspace);
    return this.serialized(`repository\0${directory}`, async () => {
      await mkdir(directory, { recursive: true });
      const release = await acquireLockFile(
        join(
          directory,
          this.#checkouts.has(workspace) ? "supertag-repository.lock" : "repository.lock",
        ),
        this.#lockTimeoutMs,
      );
      try {
        return await work();
      } finally {
        await release();
      }
    });
  }

  /** The declared checkout, else the host-managed clone of the source. */
  async repository(plan: WorkspaceSourceRef, create: boolean): Promise<WorkspaceRepository> {
    if (this.#checkouts.has(plan.workspace))
      return { path: await this.#checkout(plan.workspace), managed: false };
    if (!this.#cloneSources || plan.source === undefined)
      throw new Error(
        plan.source === undefined
          ? `Workspace ${plan.workspace} has no checkout declared on this Worker Host and records no source to clone`
          : `Workspace ${plan.workspace} has no checkout declared on this Worker Host, and this Worker does not clone sources`,
      );
    const path = this.clonePath(plan.workspace);
    const cloned = await isDirectory(path);
    if (!create) {
      if (!cloned) throw new Error(`Workspace ${plan.workspace} has no clone on this Worker Host`);
      return { path, managed: true };
    }
    if (!cloned) {
      await mkdir(path, { recursive: true });
      await this.run(path, ["init", "--bare", "--quiet"]);
    }
    // Fetch and push keep the host's global config for credentials. A bare clone guarantees they
    // never touch a working tree, where that config could select a filter driver.
    if ((await this.run(path, ["rev-parse", "--is-bare-repository"])).trim() !== "true")
      throw new Error(
        `Workspace ${plan.workspace} clone ${path} is not a bare repository; remove it so SuperTag can clone the source again`,
      );
    // The URL carries no credentials; Workspace sources reject them at apply.
    await this.run(path, ["config", `remote.${REMOTE}.url`, plan.source]);
    await this.run(path, [
      "config",
      `remote.${REMOTE}.fetch`,
      `+refs/heads/*:refs/remotes/${REMOTE}/*`,
    ]);
    return { path, managed: true };
  }

  /** The repository of a Workspace this host already serves, without creating or configuring it. */
  async opened(workspace: string): Promise<WorkspaceRepository> {
    if (this.#checkouts.has(workspace))
      return { path: await this.#checkout(workspace), managed: false };
    const path = this.clonePath(workspace);
    if (!(await isDirectory(path)))
      throw new Error(`Workspace ${workspace} has no checkout or clone on this Worker Host`);
    return { path, managed: true };
  }

  /** The source URL a definition names: the recorded source, else the declared checkout. */
  sourceOf(plan: WorkspaceSourceRef, repository: WorkspaceRepository): string {
    return plan.source ?? pathToFileURL(repository.path).href;
  }

  async #checkout(workspace: string): Promise<string> {
    const path = this.#checkouts.get(workspace);
    if (path === undefined)
      throw new Error(`Workspace ${workspace} has no checkout declared on this Worker Host`);
    if (!(await isDirectory(path)))
      throw new Error(`Workspace ${workspace} checkout ${path} is not a directory`);
    const inside = await this.run(path, ["rev-parse", "--is-inside-work-tree"]).catch(
      () => "false",
    );
    if (inside.trim() !== "true")
      throw new Error(
        `Workspace ${workspace} checkout ${path} is not a git repository. SuperTag serves only git checkouts as Workspaces; run git init there or declare a git checkout.`,
      );
    return (await this.run(path, ["rev-parse", "--show-toplevel"])).trim();
  }

  /** Brings a host-managed clone up to date with its source, and records the default branch. */
  async fetch(
    repository: WorkspaceRepository,
    plan: WorkspaceSourceRef,
    credential: GitSourceCredential | undefined,
  ): Promise<void> {
    const source = plan.source as string;
    await this.run(
      repository.path,
      ["fetch", "--quiet", "--prune", "--tags", REMOTE],
      credential,
    ).catch((error: unknown) => {
      throw new Error(
        `Workspace ${plan.workspace} could not fetch ${source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (plan.ref !== undefined) return;
    const head = await this.run(
      repository.path,
      ["ls-remote", "--symref", REMOTE, "HEAD"],
      credential,
    ).catch(() => "");
    const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/mu.exec(head)?.[1];
    if (branch !== undefined)
      await writeFile(join(repository.path, DEFAULT_BRANCH_MARKER), `${branch}\n`);
  }

  /**
   * The Workspace `ref`, else the checkout's current branch or the source's default branch.
   * In a clone, branch names resolve to their fetched remote-tracking refs.
   */
  async baseRef(repository: WorkspaceRepository, plan: WorkspaceSourceRef): Promise<string> {
    if (repository.managed) {
      const branch =
        plan.ref ??
        ((
          await readFile(join(repository.path, DEFAULT_BRANCH_MARKER), "utf8").catch(() => "")
        ).trim() ||
          DEFAULT_WORKSPACE_REF);
      const tracking = `refs/remotes/${REMOTE}/${branch}`;
      return (await this.hasRef(repository.path, tracking)) ? tracking : branch;
    }
    if (plan.ref !== undefined) return plan.ref;
    const current = await this.run(repository.path, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]).catch(() => "");
    return current.trim() || DEFAULT_WORKSPACE_REF;
  }

  /** The remote-tracking ref a branch pushed by another host would have in a managed clone. */
  remoteBranch(branch: string): string {
    return `refs/remotes/${REMOTE}/${branch}`;
  }

  /**
   * Fetches one commit by id from a host-managed clone's source, into the object store only: no
   * ref changes, not even FETCH_HEAD. True when the commit is then present. A source that refuses
   * to serve the id, or does not hold it, gives false.
   */
  async fetchCommit(
    repository: WorkspaceRepository,
    commit: string,
    credential: GitSourceCredential | undefined,
  ): Promise<boolean> {
    if (!repository.managed || !/^[0-9a-f]{40,64}$/u.test(commit)) return false;
    await this.run(
      repository.path,
      ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", REMOTE, commit],
      credential,
    ).catch(() => undefined);
    return this.hasRef(repository.path, `${commit}^{commit}`);
  }

  /**
   * The commit setup, MCP servers, and Skills are read from: the newest commit both the Task's
   * base and the Workspace ref contain. It is always reachable from the operator-chosen ref, so a
   * base an AI actor produced never becomes the trusted commit.
   */
  async trusted(
    repository: WorkspaceRepository,
    plan: WorkspaceSourceRef,
    anchor: string,
  ): Promise<string> {
    const baseRef = await this.baseRef(repository, plan);
    return this.mergeBase(repository.path, anchor, baseRef).catch(() => {
      throw new Error(
        `Workspace ${plan.workspace} base ref ${baseRef} shares no commit with this Task's base ${anchor.slice(0, 12)}, so setup has no trusted commit to run on`,
      );
    });
  }

  async mergeBase(cwd: string | WorkspaceWorktree, left: string, right: string): Promise<string> {
    return (await this.run(cwd, ["merge-base", left, right])).trim();
  }

  async hasRef(repository: string, ref: string): Promise<boolean> {
    return this.run(repository, ["rev-parse", "--verify", "--quiet", ref]).then(
      () => true,
      () => false,
    );
  }

  /** The commit a ref names, or an error with `message`. */
  async commit(repository: string, ref: string, message: string): Promise<string> {
    return this.run(repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
      (output) => output.trim(),
      () => {
        throw new Error(message);
      },
    );
  }

  /** Refuses a commit that does not contain the submitted commit under review. */
  async assertContains(
    cwd: string | WorkspaceWorktree,
    submitted: string,
    commit: string,
  ): Promise<void> {
    await this.run(cwd, ["merge-base", "--is-ancestor", submitted, commit]).catch(() => {
      throw new Error(
        `Review branch at ${commit === "HEAD" ? "its worktree" : commit.slice(0, 12)} does not contain submitted commit ${submitted}; SuperTag refused to reuse it. Remove the branch to start the review afresh.`,
      );
    });
  }

  /**
   * Merges `theirs` into `ours` in the repository's object store with `git merge-tree`, without a
   * worktree, index, or ref change, and returns the merge commit. The same inputs give the same
   * commit, because its identity and date are fixed: the later parent's committer date. A conflict
   * throws {@link WorkspaceMergeConflictError} naming the conflicting paths.
   */
  async mergeCommit(
    repository: string,
    ours: string,
    theirs: string,
    message: string,
    author: GitAuthor,
  ): Promise<string> {
    const merged = await this.#runStatus(repository, [
      "merge-tree",
      "--write-tree",
      "--no-messages",
      "--name-only",
      "-z",
      ours,
      theirs,
    ]);
    const [tree, ...paths] = merged.stdout.split("\0").filter(Boolean);
    if (merged.status === 1 && tree !== undefined)
      throw new WorkspaceMergeConflictError([...new Set(paths)].sort());
    if (merged.status !== 0 || tree === undefined || !/^[0-9a-f]{40,64}$/u.test(tree))
      throw new Error(
        `git merge-tree failed: ${merged.stderr.trim().slice(0, 500) || `exit ${merged.status}`}; merging dependencies needs git 2.38 or later`,
      );
    const dates = (await this.run(repository, ["show", "-s", "--format=%ct", ours, theirs]))
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isInteger(value));
    const date = `${Math.max(0, ...dates)} +0000`;
    const commit = await this.#runStatus(
      repository,
      [
        "-c",
        `user.name=${author.name}`,
        "-c",
        `user.email=${author.email}`,
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        "-p",
        ours,
        "-p",
        theirs,
        "-m",
        message,
      ],
      { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    );
    const id = commit.stdout.trim();
    if (commit.status !== 0 || !/^[0-9a-f]{40,64}$/u.test(id))
      throw new Error(`git commit-tree failed: ${commit.stderr.trim().slice(0, 500)}`);
    return id;
  }

  /** Runs git like {@link run} and returns its exit status instead of rejecting on one. */
  async #runStatus(
    cwd: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>> = {},
  ): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
    const invocation = await this.#invocation(cwd, args);
    return new Promise((resolvePromise) => {
      execFile(
        this.git,
        invocation.args,
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: { ...invocation.env, ...environment },
        },
        (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          resolvePromise({
            status: error === null ? 0 : typeof code === "number" ? code : -1,
            stdout,
            stderr: stderr || (error?.message ?? ""),
          });
        },
      );
    });
  }

  /**
   * Finds the private git directory the repository recorded for a worktree. A directory the
   * repository does not list as its worktree is refused.
   */
  async openWorktree(
    repository: WorkspaceRepository,
    worktree: string,
    branch?: string,
  ): Promise<WorkspaceWorktree> {
    const common = (
      await this.run(repository.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).trim();
    const target = await realpath(worktree).catch(() => resolve(worktree));
    const directory = join(common, "worktrees");
    for (const entry of await readdir(directory).catch(() => [] as string[])) {
      const recorded = (await readFile(join(directory, entry, "gitdir"), "utf8").catch(() => ""))
        .trim()
        .replace(/[\\/]\.git$/u, "");
      if (!recorded || (await realpath(recorded).catch(() => recorded)) !== target) continue;
      const tree = { path: worktree, gitDir: join(directory, entry) };
      if (branch !== undefined && (await this.currentBranch(tree)) !== branch)
        throw new Error(
          `Task worktree ${worktree} is not on branch ${branch} of this repository; remove it to recreate it`,
        );
      return tree;
    }
    throw new Error(
      `Task worktree ${worktree} exists but is not a git worktree of this repository; remove it`,
    );
  }

  /** The worktree's branch, or the empty string when its HEAD is detached. */
  async currentBranch(tree: WorkspaceWorktree): Promise<string> {
    return (
      await this.run(tree, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")
    ).trim();
  }

  /** Removes a worktree and its registration; its branch and commits stay. */
  async discardWorktree(repository: WorkspaceRepository, worktree: string): Promise<void> {
    await this.run(repository.path, ["worktree", "remove", "--force", worktree]).catch(
      async (error: unknown) => {
        // A refused command must leave the worktree, and its uncommitted changes, in place.
        if (error instanceof WorkspaceIntegrityError) throw error;
        await rm(worktree, { recursive: true, force: true });
        await this.run(repository.path, ["worktree", "prune"]);
      },
    );
  }

  /** Runs `work` with every git command checking the digest `attemptId` recorded at its start. */
  checked<T>(attemptId: string, work: () => Promise<T>): Promise<T> {
    return this.#checkedAttempt.run(attemptId, work);
  }

  /**
   * Records the git digest a Task Attempt starts with. The repository's common git directory is
   * found from the repository, never from the worktree.
   */
  async recordIntegrity(
    attemptId: string,
    repository: WorkspaceRepository,
    tree: WorkspaceWorktree,
  ): Promise<void> {
    const commonDir = (
      await this.run(repository.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).trim();
    this.#integrity.set(attemptId, {
      commonDir,
      tree,
      digest: await this.#integrityDigest(commonDir, tree),
      files: await this.#integrityFiles(commonDir, tree),
    });
  }

  /** Inside {@link checked}, refuses when the Attempt's git config changed. */
  checkIntegrity(): Promise<void> {
    return this.#checkIntegrity();
  }

  /** The integrity failure an Attempt hit, if any. */
  integrityFailure(attemptId: string): WorkspaceIntegrityError | undefined {
    return this.#integrity.get(attemptId)?.failure;
  }

  forgetIntegrity(attemptId: string): void {
    this.#integrity.delete(attemptId);
  }

  async #integrityPaths(commonDir: string, tree: WorkspaceWorktree): Promise<string[]> {
    const paths = [
      join(commonDir, "config"),
      join(tree.gitDir, "config.worktree"),
      join(commonDir, "info", "attributes"),
      join(commonDir, "info", "exclude"),
    ];
    // The local digest follows includes, so retain their bytes for restoration too.
    const included = await new Promise<string[]>((done) => {
      execFile(
        this.git,
        [
          `--git-dir=${commonDir}`,
          "config",
          "--local",
          "--includes",
          "--show-origin",
          "--list",
          "-z",
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: gitEnvironment(undefined, true) },
        (error, stdout) =>
          done(
            error
              ? []
              : [...stdout.matchAll(/file:([^\0]+)\0/gu)].map((match) => match[1] as string),
          ),
      );
    });
    for (const path of included) if (!paths.includes(path)) paths.push(path);
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      )) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else paths.push(path);
      }
    };
    await walk(join(commonDir, "hooks"));
    return paths;
  }

  async #integrityFiles(
    commonDir: string,
    tree: WorkspaceWorktree,
  ): Promise<ReadonlyMap<string, GitFileSnapshot>> {
    const files = new Map<string, GitFileSnapshot>();
    for (const path of await this.#integrityPaths(commonDir, tree)) {
      const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      files.set(
        path,
        metadata === undefined
          ? {}
          : metadata.isSymbolicLink()
            ? { link: await readlink(path) }
            : metadata.isDirectory()
              ? { directory: true, mode: metadata.mode }
              : { bytes: await readFile(path), mode: metadata.mode },
      );
    }
    return files;
  }

  async #restoreIntegrity(recorded: AttemptIntegrity): Promise<void> {
    const current = await this.#integrityFiles(recorded.commonDir, recorded.tree);
    for (const path of new Set([...recorded.files.keys(), ...current.keys()])) {
      const expected = recorded.files.get(path) ?? {};
      const actual = current.get(path) ?? {};
      if (
        expected.link === actual.link &&
        expected.directory === actual.directory &&
        expected.mode === actual.mode &&
        (expected.bytes === undefined
          ? actual.bytes === undefined
          : expected.bytes.equals(actual.bytes ?? Buffer.alloc(0)))
      )
        continue;
      await rm(path, { recursive: true, force: true });
      if (expected.link !== undefined) {
        await mkdir(dirname(path), { recursive: true });
        await symlink(expected.link, path);
      } else if (expected.bytes !== undefined) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, expected.bytes, { mode: expected.mode });
        if (expected.mode !== undefined) await chmod(path, expected.mode);
      } else if (expected.directory) {
        await mkdir(path, { recursive: true });
        if (expected.mode !== undefined) await chmod(path, expected.mode);
      }
    }
  }

  async #integrityDigest(commonDir: string, tree: WorkspaceWorktree): Promise<GitIntegrityDigest> {
    const file = (path: string) =>
      readFile(path).then(sha256, (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? "absent" : `unreadable: ${error.code}`,
      );
    // Listing config parses it and follows includes; it runs no driver or helper.
    const local = await new Promise<string>((done) => {
      execFile(
        this.git,
        [`--git-dir=${commonDir}`, "config", "--local", "--includes", "--list", "-z"],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: gitEnvironment(undefined, true) },
        (error, stdout) => done(error ? `unreadable: ${error.message}` : sha256(stdout)),
      );
    });
    return {
      "repository config": local,
      // A removed worktree, such as one the Worker discarded, has no config left to run.
      "worktree config": (await isDirectory(tree.gitDir))
        ? await file(join(tree.gitDir, "config.worktree"))
        : WORKTREE_REMOVED,
      "info/attributes": await file(join(commonDir, "info", "attributes")),
      "info/exclude": await file(join(commonDir, "info", "exclude")),
      hooks: sha256(
        [...(await this.#integrityFiles(commonDir, tree))]
          .filter(([path]) => path.startsWith(`${join(commonDir, "hooks")}/`))
          .map(
            ([path, value]) => `${path}:${value.link ?? sha256(value.bytes ?? "")}:${value.mode}`,
          )
          .join("\0"),
      ),
    };
  }

  /**
   * Inside {@link checked}, refuses to run git once the repository's config differs from the
   * digest its Attempt recorded at the start. The harness may have written it to make this
   * command run its code on the Worker Host.
   */
  async #checkIntegrity(): Promise<void> {
    const attemptId = this.#checkedAttempt.getStore();
    const recorded = attemptId === undefined ? undefined : this.#integrity.get(attemptId);
    if (recorded === undefined) return;
    if (recorded.failure) throw recorded.failure;
    const current = await this.#integrityDigest(recorded.commonDir, recorded.tree);
    const changed = (Object.keys(current) as (keyof GitIntegrityDigest)[]).filter(
      (key) => current[key] !== recorded.digest[key] && current[key] !== WORKTREE_REMOVED,
    );
    const files = await this.#integrityFiles(recorded.commonDir, recorded.tree);
    const changedFiles = [...new Set([...recorded.files.keys(), ...files.keys()])].filter(
      (path) => {
        if (
          path === join(recorded.tree.gitDir, "config.worktree") &&
          current["worktree config"] === WORKTREE_REMOVED
        )
          return false;
        const expected = recorded.files.get(path) ?? {};
        const actual = files.get(path) ?? {};
        return (
          expected.link !== actual.link ||
          expected.directory !== actual.directory ||
          expected.mode !== actual.mode ||
          (expected.bytes === undefined
            ? actual.bytes !== undefined
            : !expected.bytes.equals(actual.bytes ?? Buffer.alloc(0)))
        );
      },
    );
    if (changed.length === 0 && changedFiles.length === 0) return;
    const label = (path: string) =>
      path === join(recorded.commonDir, "config")
        ? "repository config"
        : path === join(recorded.tree.gitDir, "config.worktree")
          ? "worktree config"
          : path.startsWith(`${recorded.commonDir}/`)
            ? path.slice(recorded.commonDir.length + 1)
            : path;
    const present = (file: GitFileSnapshot | undefined) =>
      file?.bytes !== undefined || file?.link !== undefined || file?.directory === true;
    const details = changedFiles.map((path) => {
      const change = !present(recorded.files.get(path))
        ? "added"
        : !present(files.get(path))
          ? "removed"
          : "modified";
      return `${label(path)}: ${change}`;
    });
    let restoration: string;
    try {
      await this.#restoreIntegrity(recorded);
      restoration = "SuperTag restored the recorded git configuration";
    } catch (error) {
      restoration = `SuperTag could not restore the recorded git configuration: ${String(error)}`;
    }
    recorded.failure = new WorkspaceIntegrityError(
      `Repository config changed during the Task Attempt (${details.join(", ") || changed.join(", ")} in ${recorded.commonDir}). ${restoration} and ran no further git command for Task worktree ${recorded.tree.path}; its changes are uncommitted.`,
    );
    throw recorded.failure;
  }

  /**
   * `-c filter.lfs.*` from the host's own config, when git-lfs is installed; otherwise nothing.
   * Working-tree commands drop global config, and this keeps the one driver allowed by name.
   */
  #lfsFilter(): Promise<readonly string[]> {
    // Host config is read once per process for each git executable and global config location.
    const key = [
      this.git,
      process.env["HOME"],
      gitEnvironment(undefined, false, true)["GIT_CONFIG_GLOBAL"],
    ].join("\0");
    let filter = HOST_LFS_FILTERS.get(key);
    if (filter === undefined) {
      filter = readHostLfsFilter(this.git);
      HOST_LFS_FILTERS.set(key, filter);
    }
    return filter;
  }

  /**
   * Leading arguments and environment for one Worker git command. Inside {@link checked} the
   * Attempt's git digest is checked first. Only network commands see global and system config.
   */
  async #invocation(
    cwd: string | WorkspaceWorktree,
    args: readonly string[],
    credential?: GitSourceCredential,
  ): Promise<{ readonly args: string[]; readonly env: NodeJS.ProcessEnv }> {
    await this.#checkIntegrity();
    const network = NETWORK_GIT_COMMANDS.has(gitSubcommand(args) ?? "");
    return {
      args: [
        ...gitLocation(cwd),
        ...(network ? [] : [...WORKING_TREE_GIT_CONFIG, ...(await this.#lfsFilter())]),
        ...credentialArguments(credential),
        ...args,
      ],
      env: gitEnvironment(credential, !network, network, network),
    };
  }

  /** Runs git in a directory, or in a Task worktree through the git directory its repository recorded. */
  async run(
    cwd: string | WorkspaceWorktree,
    args: readonly string[],
    credential?: GitSourceCredential,
  ): Promise<string> {
    const invocation = await this.#invocation(cwd, args, credential);
    return new Promise((resolvePromise, reject) => {
      execFile(
        this.git,
        invocation.args,
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: invocation.env },
        (error, stdout, stderr) => {
          if (error)
            reject(
              new Error(
                `git ${args[0]} failed: ${redact((stderr || error.message).trim(), credential).slice(0, 500)}`,
              ),
            );
          else resolvePromise(stdout);
        },
      );
    });
  }

  /** Runs a Git command with bounded binary input, using the same safe invocation as `run`. */
  async runInput(cwd: string, args: readonly string[], input: Uint8Array): Promise<string> {
    const invocation = await this.#invocation(cwd, args);
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        this.git,
        invocation.args,
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: invocation.env },
        (error, stdout, stderr) => {
          if (error)
            reject(
              new Error(`git ${args[0]} failed: ${(stderr || error.message).trim().slice(0, 500)}`),
            );
          else resolvePromise(stdout);
        },
      );
      // An invalid pack can make git exit before it consumes stdin.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    });
  }

  /** Runs git and returns at most 32 MiB of its output as bytes. */
  async runBytes(cwd: string | WorkspaceWorktree, args: readonly string[]): Promise<Uint8Array> {
    const invocation = await this.#invocation(cwd, args);
    return new Promise((resolvePromise, reject) => {
      execFile(
        this.git,
        invocation.args,
        { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, env: invocation.env },
        (error, stdout, stderr) => {
          if (error)
            reject(
              new Error(`git ${args[0]} failed: ${String(stderr || error.message).slice(0, 500)}`),
            );
          else resolvePromise(new Uint8Array(stdout));
        },
      );
    });
  }
}

/** A returned bundle and patch have the same fixed 32 MiB limit. */
export const MAX_WORKSPACE_BUNDLE_BYTES = 32 * 1024 * 1024;

/** Host-owned inputs for delivery. The provider never receives the clone or its credentials. */
export interface WorkspaceDeliveryClone {
  readonly host: WorkspaceHost;
  readonly repository: WorkspaceRepository;
  readonly base: string;
  readonly outcome: WorkspaceAttemptOutcome;
  /** The caller applies its source credential and approval policy when publishing. */
  readonly publish?: (base: string, head: string) => Promise<WorkspacePullRequestOutcome>;
}

/**
 * Import a provider's returned commits into the host's bare clone, then deliver from refs.
 * The bundle first lands in a private bare repository. Thin deltas resolve only against a
 * separate pack of base-reachable objects. Failed validation never changes a host ref or imports
 * an object into the clone.
 */
export async function deliverWorkspace(
  clone: WorkspaceDeliveryClone,
  plan: TaskNamedWorkspacePlan,
  finalized: FinalizedWork,
): Promise<WorkspaceDeliveryRecord> {
  const { host, repository, base, outcome } = clone;
  const branch = `refs/heads/${plan.branch}`;
  await host.run(repository.path, ["check-ref-format", branch]);
  await host.commit(repository.path, base, `Workspace delivery base ${base} is not a commit`);
  if (finalized.objects !== undefined) {
    if (
      !repository.managed ||
      (await host.run(repository.path, ["rev-parse", "--is-bare-repository"])).trim() !== "true"
    )
      throw new Error("Workspace bundle delivery requires a host-managed bare clone");
    await host.exclusive(plan.workspace, () =>
      importWorkspaceBundle(host, repository, plan.workspace, branch, base, finalized),
    );
  } else {
    const present = await host.commit(
      repository.path,
      finalized.head,
      "Workspace delivery head is absent",
    );
    if (present !== finalized.head)
      throw new Error("Workspace delivery head differs from the finalized commit");
    await host.assertContains(repository.path, base, finalized.head);
    const current = await host.hasRef(repository.path, branch);
    if (!current && repository.managed && finalized.head === base)
      await host.exclusive(plan.workspace, () =>
        host.run(repository.path, ["update-ref", branch, base, "0".repeat(base.length)]),
      );
    else if (
      !current ||
      (await host.commit(repository.path, branch, "Task branch is unreadable")) !== finalized.head
    )
      throw new Error(
        "Workspace delivery without a bundle requires the Task branch at the finalized head",
      );
  }
  const head = finalized.head;
  const changedFiles = (
    await host.run(repository.path, ["diff", ...SAFE_DIFF, "--name-only", `${base}..${branch}`])
  )
    .split("\n")
    .filter(Boolean).length;
  const patch =
    outcome === "completed" && plan.delivery === "patch" && head !== base
      ? await host.runBytes(repository.path, [
          "-c",
          "diff.noprefix=false",
          "format-patch",
          ...SAFE_DIFF,
          "--stdout",
          "--binary",
          `${base}..${branch}`,
        ])
      : undefined;
  const pullRequest =
    outcome === "completed" && plan.delivery === "pull-request" && head !== base
      ? clone.publish
        ? await clone.publish(base, head)
        : {
            status: "failed" as const,
            message: `No pull request publisher is configured; branch ${plan.branch} stays on this Worker Host`,
          }
      : undefined;
  let branchRemoved = false;
  if (repository.managed && head === base) {
    await host.exclusive(plan.workspace, async () => {
      await host.run(repository.path, ["update-ref", "-d", branch, base]);
      branchRemoved = true;
    });
  }
  return {
    workspace: plan.workspace,
    branch: plan.branch,
    delivery: plan.delivery,
    base,
    head,
    committed: finalized.committed,
    changedFiles,
    ...(patch === undefined ? {} : { patch }),
    worktreeRemoved: false,
    branchRemoved,
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

async function importWorkspaceBundle(
  host: WorkspaceHost,
  repository: WorkspaceRepository,
  workspace: string,
  branch: string,
  base: string,
  finalized: FinalizedWork,
): Promise<void> {
  const objects = finalized.objects as GitObjects;
  const source = await open(
    objects.bundle,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  try {
    const status = await source.stat();
    if (!status.isFile() || status.size > MAX_WORKSPACE_BUNDLE_BYTES)
      throw new Error(
        `Workspace bundle must be a regular file of at most ${MAX_WORKSPACE_BUNDLE_BYTES} bytes`,
      );
    bytes = Buffer.allocUnsafe(MAX_WORKSPACE_BUNDLE_BYTES + 1);
    let read = 0;
    while (read < bytes.length) {
      const result = await source.read(bytes, read, bytes.length - read, null);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    bytes = bytes.subarray(0, read);
  } finally {
    await source.close();
  }
  if (bytes.length > MAX_WORKSPACE_BUNDLE_BYTES)
    throw new Error(`Workspace bundle exceeds ${MAX_WORKSPACE_BUNDLE_BYTES} bytes`);
  if (objects.digest !== `sha256:${sha256(bytes)}`)
    throw new Error("Workspace bundle digest does not match its bytes");
  const deliveryDirectory = join(host.root, workspace, "delivery");
  await mkdir(deliveryDirectory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(deliveryDirectory, "bundle-"));
  try {
    const stagedBundle = join(temporary, "work.bundle");
    const stage = join(temporary, "repo.git");
    const packRepository = join(temporary, "pack.git");
    const baseRepository = join(temporary, "base.git");
    await mkdir(stage);
    await mkdir(packRepository);
    await mkdir(baseRepository);
    await writeFile(stagedBundle, bytes, { mode: 0o600 });
    await host.run(stage, ["init", "--bare", "--quiet"]);
    await host.run(packRepository, ["init", "--bare", "--quiet"]);
    await host.run(baseRepository, ["init", "--bare", "--quiet"]);
    // Make a self-contained pack of only the base's reachable closure. The returned
    // pack may use thin deltas against this closure, but never against another ref in
    // the credentialed host clone.
    await host.runInput(
      repository.path,
      ["pack-objects", "--revs", join(baseRepository, "objects", "pack", "base")],
      Buffer.from(`${base}\n`),
    );
    await writeFile(
      join(packRepository, "objects", "info", "alternates"),
      `${join(baseRepository, "objects")}\n`,
    );
    const objectDirectory = (
      await host.run(repository.path, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ])
    ).trim();
    await writeFile(
      join(stage, "objects", "info", "alternates"),
      `${await realpath(objectDirectory)}\n${join(packRepository, "objects")}\n`,
    );
    await host.run(stage, ["update-ref", "refs/heads/base", base]);
    await host.run(stage, ["bundle", "verify", stagedBundle]);
    const separator = bytes.indexOf(Buffer.from("\n\n"));
    if (separator < 0 || bytes.toString("ascii", separator + 2, separator + 6) !== "PACK")
      throw new Error("Workspace bundle has no pack data");
    for (const line of bytes.toString("ascii", 0, separator).split("\n")) {
      if (!line.startsWith("-")) continue;
      const prerequisite = /^-([0-9a-f]{40,64})(?: |$)/u.exec(line)?.[1];
      if (!prerequisite) throw new Error("Workspace bundle has an invalid prerequisite");
      await host.assertContains(stage, prerequisite, base);
    }
    // Strictly check objects while indexing. Thin deltas can only use the base closure.
    const packResult = (
      await host.runInput(
        packRepository,
        ["index-pack", "--strict", "--fix-thin", "--stdin"],
        bytes.subarray(separator + 2),
      )
    ).trim();
    const packId = /^(?:pack\s+)?([0-9a-f]{40,64})$/u.exec(packResult)?.[1];
    if (!packId) throw new Error("Workspace bundle pack is invalid");
    const packIndex = join(packRepository, "objects", "pack", `pack-${packId}.idx`);
    // --fix-thin appends delta bases from the isolated base closure. Count only
    // objects carried by the provider's original pack in the history equality check.
    const originalPackEnd = bytes.length - (separator + 2) - base.length / 2;
    const packed = new Set(
      (await host.run(packRepository, ["verify-pack", "-v", packIndex]))
        .split("\n")
        .map((line) => {
          const object = /^([0-9a-f]{40,64})\s+\w+\s+\d+\s+\d+\s+(\d+)(?:\s|$)/u.exec(line);
          return object && Number(object[2]) < originalPackEnd ? object[1] : undefined;
        })
        .filter((oid): oid is string => oid !== undefined),
    );
    const heads = (await host.run(stage, ["bundle", "list-heads", stagedBundle]))
      .trim()
      .split("\n")
      .filter(Boolean);
    if (heads.length !== 1) throw new Error("Workspace bundle must advertise exactly one ref");
    const match = /^([0-9a-f]{40,64}) (HEAD|refs\/heads\/[A-Za-z0-9._/-]+)$/u.exec(
      heads[0] as string,
    );
    if (!match) throw new Error("Workspace bundle advertises an invalid ref");
    const advertised = match[2] as string;
    await host.run(stage, [
      "-c",
      "fetch.fsckObjects=true",
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      stagedBundle,
      `${advertised}:refs/heads/candidate`,
    ]);
    const stagedHead = await host.commit(
      stage,
      "refs/heads/candidate",
      "Workspace bundle head is not a commit",
    );
    if (stagedHead !== finalized.head || stagedHead !== match[1])
      throw new Error("Workspace bundle head differs from the finalized commit");
    await host.assertContains(stage, base, stagedHead);
    const required = new Set(
      (await host.run(stage, ["rev-list", "--objects", "refs/heads/candidate", "--not", base]))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ", 1)[0] as string),
    );
    if (
      [...required].some((oid) => !packed.has(oid)) ||
      [...packed].some((oid) => !required.has(oid))
    )
      throw new Error("Workspace bundle pack differs from the Task history after base");
    if (await host.hasRef(repository.path, branch)) {
      const current = await host.commit(repository.path, branch, "Task branch is unreadable");
      await host.assertContains(stage, current, stagedHead);
    }
    // Fetch exactly the verified ref, without its name or any tags, then move only the Task ref.
    await host.run(repository.path, [
      "-c",
      "fetch.fsckObjects=true",
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      stage,
      "refs/heads/candidate",
    ]);
    const old = (await host.hasRef(repository.path, branch))
      ? await host.commit(repository.path, branch, "Task branch is unreadable")
      : "0".repeat(stagedHead.length);
    await host.run(repository.path, ["update-ref", branch, stagedHead, old]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * `-c filter.lfs.*` pairs from the host's system and global config, the order git applies them,
 * when git-lfs is installed. A repository's own config is never read here.
 */
async function readHostLfsFilter(git: string): Promise<readonly string[]> {
  const read = (args: readonly string[]) =>
    new Promise<string | undefined>((done) => {
      execFile(
        git,
        [...args],
        { encoding: "utf8", env: gitEnvironment(undefined, false, true) },
        (error, stdout) => done(error ? undefined : stdout),
      );
    });
  const values = new Map<string, string>();
  for (const scope of ["--system", "--global"])
    for (const line of (
      (await read(["config", scope, "--includes", "-z", "--get-regexp", "^filter\\.lfs\\."])) ?? ""
    ).split("\0")) {
      const split = line.indexOf("\n");
      const key = line.slice(0, split).toLowerCase();
      if (split > 0 && (LFS_FILTER_KEYS as readonly string[]).includes(key.slice(11)))
        values.set(key, line.slice(split + 1));
    }
  if (values.size === 0 || (await read(["lfs", "version"])) === undefined) return [];
  return [...values].flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

/** The git subcommand in a Worker argument list, after any leading `-c` pairs. */
function gitSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-c") index += 1;
    else return args[index];
  }
  return undefined;
}

/** Leading git arguments: the directory, the worktree's recorded git directory, and safe config. */
function gitLocation(cwd: string | WorkspaceWorktree): string[] {
  return typeof cwd === "string"
    ? ["-C", cwd, ...WORKER_GIT_CONFIG]
    : ["-C", cwd.path, `--git-dir=${cwd.gitDir}`, `--work-tree=${cwd.path}`, ...WORKER_GIT_CONFIG];
}

/**
 * Configuration for one git command that authenticates with a credential. The empty helper
 * clears every configured helper, so no credential store ever sees the value; the inline
 * helper reads it from this command's environment and answers only `get`.
 */
const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; printf "username=%s\\npassword=%s\\n" "$SUPERTAG_GIT_USERNAME" "$SUPERTAG_GIT_PASSWORD"; }; f';

/** Arguments that make one git command answer credential requests from its environment. */
export function credentialArguments(credential: GitSourceCredential | undefined): string[] {
  if (credential === undefined) return [];
  return ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`];
}

/**
 * Git never prompts, and the user's global hooks path and pager stay out of Worker commands.
 * A `local` command reads only the repository's own config: no global or system config, no
 * system attributes file. Git LFS leaves pointers rather than downloading objects, because the
 * credentials it would need live in the global config.
 */
function gitEnvironment(
  credential?: GitSourceCredential,
  local = false,
  operatorConfig = false,
  transport = false,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    ...(operatorConfig && process.env["GIT_CONFIG_GLOBAL"]
      ? { GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"] }
      : {}),
    ...(transport && process.env["GIT_SSH_COMMAND"]
      ? { GIT_SSH_COMMAND: process.env["GIT_SSH_COMMAND"] }
      : {}),
    ...(transport && process.env["GIT_ASKPASS"] ? { GIT_ASKPASS: process.env["GIT_ASKPASS"] } : {}),
    ...(local
      ? {
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_LFS_SKIP_SMUDGE: "1",
        }
      : {}),
  };
  delete environment["SUPERTAG_GIT_USERNAME"];
  delete environment["SUPERTAG_GIT_PASSWORD"];
  if (credential !== undefined) {
    environment["SUPERTAG_GIT_USERNAME"] = credential.username;
    environment["SUPERTAG_GIT_PASSWORD"] = credential.password;
  }
  return environment;
}

/** Removes a credential from git output that echoes it back. */
function redact(text: string, credential: GitSourceCredential | undefined): string {
  if (credential === undefined || credential.password.length === 0) return text;
  return text.split(credential.password).join("[redacted]");
}

/** One operation at a time per key within this process. */
class KeyedSerializer {
  readonly #tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.#tails.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    this.#tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.#tails.get(key) === next) this.#tails.delete(key);
    }
  }
}

/**
 * Takes an exclusive lock file, waiting while another live process holds it. The file holds the
 * holder's pid and a token unique to this acquisition; the holder refreshes its timestamp while
 * it works, and release removes the file only while it still holds that token. A lock whose
 * holder has exited, or whose timestamp is older than the timeout, is stale and replaced.
 */
export async function acquireLockFile(
  path: string,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid} ${randomUUID()}\n`;
  for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      return heldLock(path, token, timeoutMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const content = await readFile(path, "utf8").catch(() => undefined);
    const holder = Number.parseInt(content ?? "", 10);
    const age = Date.now() - ((await stat(path).catch(() => undefined))?.mtimeMs ?? Date.now());
    if (content !== undefined && (!processAlive(holder) || age > timeoutMs)) {
      // Only the stale holder's file is removed, never one another waiter just took.
      if ((await readFile(path, "utf8").catch(() => undefined)) === content)
        await unlink(path).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for Workspace repository lock ${path}`);
    await new Promise((done) => setTimeout(done, delay));
  }
}

/** Keeps a held lock's timestamp fresh, and releases it only while it still holds `token`. */
function heldLock(path: string, token: string, timeoutMs: number): () => Promise<void> {
  const refresh = setInterval(
    () => {
      const now = new Date();
      void utimes(path, now, now).catch(() => undefined);
    },
    Math.max(10, Math.floor(timeoutMs / 4)),
  );
  refresh.unref();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(refresh);
    if ((await readFile(path, "utf8").catch(() => undefined)) === token)
      await unlink(path).catch(() => undefined);
  };
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

export async function isDirectory(path: string): Promise<boolean> {
  return lstat(path).then(
    (status) => status.isDirectory(),
    () => false,
  );
}

/**
 * The variables remote environment provider SDKs authenticate with. The Worker may hold them in
 * its own process; host child processes, such as git and harness model checks, never inherit them.
 */
export const ENVIRONMENT_PROVIDER_CREDENTIAL_VARIABLES: readonly string[] = [
  "E2B_API_KEY",
  "E2B_ACCESS_TOKEN",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
];

/** A copy of an environment without remote provider credentials, for host child processes. */
export function withoutProviderCredentials(
  environment: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...environment };
  for (const name of ENVIRONMENT_PROVIDER_CREDENTIAL_VARIABLES) delete copy[name];
  return copy;
}

/** Refuse unsupported mount requests without resolving credentials or calling a provider. */
export function assertWorkspaceMountSupport(
  environment: Pick<WorkspaceEnvironment, "provider" | "capabilities">,
  mounts: readonly WorkspaceMount[],
): void {
  for (const mount of mounts) {
    const supported = environment.capabilities.mounts;
    if (
      !supported?.strategies.includes(mount.strategy) ||
      !supported.access.includes(mount.access)
    ) {
      const reason =
        mount.strategy === "mount" && environment.provider === "e2b"
          ? "; native mounts would require keys inside the sandbox"
          : "";
      throw new Error(
        `Workspace mount ${mount.volume} at ${mount.path}: provider ${environment.provider} does not support ${mount.strategy} with ${mount.access}${reason}`,
      );
    }
  }
}
