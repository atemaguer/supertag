import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  gitRefComponent,
  type LiveMount,
  type MountManifest,
  type MountOutputManifest,
  parseLiveMounts,
  parseModalVolumeCredential,
  type TaskNamedWorkspacePlan,
  type TaskWorkspacePlan,
  type WorkspaceDelivery,
  type WorkspacePullRequest,
} from "@supertag/core";
import { readTrustedDevcontainer } from "./devcontainer-subset.js";
import { pinGitHubSkillCatalog } from "./github-skill-catalog.js";
import type {
  EnvironmentPlan,
  ExecutionEnvironment,
  ResolutionContext,
  SkillInput,
  TaskAttemptSpec,
  WorkspaceInput,
  WorkspaceResolver,
} from "./index.js";
import { assertLocalMountDestination, type LocalMountRoot } from "./local-mount-root.js";
import {
  type LocalTaskCommits,
  type LocalWorkspaceCheckout,
  LocalWorkspaceEnvironment,
} from "./local-workspace-environment.js";
import { pinWorkspaceVolumes, type ResolvedVolume, type VolumeResolver } from "./volume-copy.js";
import { WorkspaceBranches } from "./workspace-branches.js";
import { bundleTaskObjects, bundleTrustedCommit } from "./workspace-bundles.js";
import {
  assertWorkspaceMountSupport,
  deliverWorkspace,
  exists,
  type GitAuthor,
  type GitSourceCredential,
  isDirectory,
  WORKSPACE_NAME,
  type WorkspaceDefinition,
  type WorkspaceEnvironment,
  WorkspaceHost,
  WorkspaceMergeConflictError,
  type WorkspaceRepository,
  workspaceDefinition,
  workspaceHarnessRequirement,
} from "./workspace-environment.js";
import {
  type ResolvedWorkspaceMcpServer,
  resolveWorkspaceMcpServers,
  sandboxWorkspaceMcpServers,
  type WorkspaceMcpResolution,
} from "./workspace-mcp.js";
import { pinWorkspaceSkills } from "./workspace-skills.js";

/** One Workspace checkout declared on this Worker Host. The path never leaves the host. */
export interface GitWorkspaceCheckout {
  readonly name: string;
  readonly path: string;
}

/** The Task fields Workspace resolution and delivery read. */
export type WorkspaceTask = Pick<TaskAttemptSpec, "taskId" | "attemptId" | "workspacePlan"> &
  Partial<Pick<TaskAttemptSpec, "authorization" | "coordination" | "tag" | "input">>;

/** Supplies credentials for a Workspace source; undefined means the host's own git setup. */
export interface WorkspaceSourceCredentials {
  resolve(input: {
    readonly task: WorkspaceTask;
    readonly source: string;
    readonly purpose: "fetch" | "push";
  }): Promise<GitSourceCredential | undefined>;
}

/** What pull-request delivery produced for one completed Task Attempt. */
export type WorkspacePullRequestOutcome =
  | {
      /** `opened` created the pull request; `updated` pushed to the Task's existing one. */
      readonly status: "opened" | "updated";
      readonly pullRequest: WorkspacePullRequest;
      readonly draft: boolean;
    }
  | {
      /** The Task's pull request was closed on the provider; SuperTag does not reopen it. */
      readonly status: "closed";
      readonly pullRequest: WorkspacePullRequest;
      readonly message: string;
    }
  | {
      readonly status: "approval-pending" | "approval-denied" | "not-authorized" | "failed";
      readonly message: string;
      readonly requestId?: string;
    };

export interface WorkspacePullRequestPublishInput {
  readonly task: WorkspaceTask;
  readonly plan: TaskNamedWorkspacePlan & { readonly source: string };
  /** Commit the Task branch started from. */
  readonly base: string;
  /** Task branch head to publish. */
  readonly head: string;
  /** The Attempt's result summary, for the pull request title and body. */
  readonly summary?: string;
  /** Short evidence lines from the Attempt's result. */
  readonly evidence?: readonly string[];
  readonly signal?: AbortSignal;
  /** Pushes the Task branch to the source; the credential serves this one command. */
  push(credential: GitSourceCredential | undefined): Promise<void>;
}

/**
 * Opens or updates the pull request for a Task branch. Implementations own provider policy:
 * which surface credential applies, whether the Task may open pull requests, and approval.
 */
export interface WorkspacePullRequestPublisher {
  publish(input: WorkspacePullRequestPublishInput): Promise<WorkspacePullRequestOutcome>;
}

export interface WorkspaceEnvironmentResolverOptions {
  /** Host-only root for local mount destinations; absent refuses local mounts. */
  readonly localMountRoot?: LocalMountRoot;
  readonly checkouts: readonly GitWorkspaceCheckout[];
  /** Task worktrees live under `<root>/<workspace>/worktrees/<task>`. Default: ~/.supertag/workspaces. */
  readonly worktreeRoot?: string;
  /**
   * Serve Workspaces this host declares no checkout for by keeping a clone of their `source`
   * under `<root>/<workspace>/clone`. Default: false.
   */
  readonly cloneSources?: boolean;
  /** Credentials for fetching and pushing sources. Default: the host's own git setup. */
  readonly sourceCredentials?: WorkspaceSourceCredentials;
  /** Performs `pull-request` delivery. Without one, such Tasks keep their branch on the host. */
  readonly pullRequests?: WorkspacePullRequestPublisher;
  /** Git executable. Default: `git` on PATH. */
  readonly git?: string;
  /** Host-supplied URL for local catalog fixtures. */
  readonly catalogSourceUrl?: string;
  /** Commit identity for Worker commits. Default: SuperTag <supertag@localhost>. */
  readonly author?: GitAuthor;
  /** Bound for the Workspace setup command. Default: 10 minutes. */
  readonly setupTimeoutMs?: number;
  /**
   * Environment for the setup command. Default: the Worker's process-launch plumbing only.
   * TMPDIR, TMP, and TEMP always name a fresh private directory, removed after setup.
   */
  readonly setupEnvironment?: Readonly<Record<string, string>>;
  /** How long to wait for another process's lock on a Workspace repository. Default: 10 minutes. */
  readonly lockTimeoutMs?: number;
  /**
   * Values for `${SUPERTAG_MCP_*}` references in a Workspace `.mcp.json`, such as the host's
   * environment merged with `~/.supertag/.env`. Other names are refused before they are read.
   * Default: the Worker's environment.
   */
  readonly mcpVariables?: Readonly<Record<string, string | undefined>>;
  /** Provider-native Workspace implementations, keyed by execution provider id. */
  readonly environments?: Readonly<Record<string, WorkspaceEnvironment>>;
  /**
   * Resolves the Volumes that Workspace `copy` mounts name, with their credentials, on this
   * Worker Host. Without one, a Task whose Workspace has mounts fails before its harness starts,
   * naming the Volume. Credentials it returns stay in the Worker process.
   */
  readonly volumes?: VolumeResolver;
}

/** Where an Attempt's Task worktree stands after the Worker committed it. */
export interface WorkspaceDeliveryRecord {
  readonly workspace: string;
  readonly branch: string;
  readonly delivery: WorkspaceDelivery;
  /** Commit the Task branch started from. */
  readonly base: string;
  /** Task branch head after the Worker's commit. */
  readonly head: string;
  /** True when this Attempt left changes that the Worker committed. */
  readonly committed: boolean;
  /** Files that differ between base and head. */
  readonly changedFiles: number;
  /** `git format-patch` of base..head, for `patch` delivery of a completed Attempt with changes. */
  readonly patch?: Uint8Array;
  /** True when the Worker removed the Task worktree. */
  readonly worktreeRemoved: boolean;
  /**
   * True when the Attempt, whatever its outcome, left the Task branch without commits since its
   * base, so the Worker deleted the branch with the worktree; there is nothing to deliver.
   */
  readonly branchRemoved: boolean;
  /** `pull-request` delivery of a completed Attempt with commits. */
  readonly pullRequest?: WorkspacePullRequestOutcome;
}

export type WorkspaceAttemptOutcome = "completed" | "failed" | "cancelled";

/** Result details a Worker passes to delivery after its Harness finishes. */
export interface WorkspaceFinalizeDetails {
  readonly summary?: string;
  readonly evidence?: readonly string[];
  readonly signal?: AbortSignal;
}

/** Asks a harness for the one-line change summary that {@link commitSubject} prefers. */
export const CHANGE_SUMMARY_INSTRUCTION =
  'If you changed files, end your answer with one line "Change: <imperative summary of the change, at most 72 characters>".';

/** The `Change:` line of a harness result, when it is a usable imperative subject. */
export function changeSummary(summary: string | undefined): string | undefined {
  const lines = summary?.split(/\r?\n/u) ?? [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*(?:[*_]{1,2})?change(?:[*_]{1,2})?\s*:\s*(?:[*_]{1,2}\s*)?(.+)$/iu.exec(
      lines[index] ?? "",
    );
    const text = match?.[1]
      ?.replace(/`([^`]*)`/gu, "$1")
      .replace(/[.\s]+$/u, "")
      .trim();
    if (text && text.length <= 72 && !/^(?:i|i'm|i've|i'll|we|implemented|done)\b/iu.test(text))
      return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return undefined;
}

/**
 * The harness's `Change:` line when present; otherwise a bounded imperative subject from the
 * Task's title, its first requester instruction line. The rest of the harness summary is excluded
 * because it often describes the branch rather than the change.
 */
export function commitSubject(task: WorkspaceTask, summary?: string): string {
  const change = changeSummary(summary);
  if (change !== undefined) return change;
  const instruction = task.input?.messages.find((message) => message.role === "requester")?.text;
  const firstLine = instruction
    ?.split(/\r?\n/u)
    .map((line) => line.replace(/^(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)+/u, "").trim())
    .find(Boolean);
  const action = firstLine
    // Labels such as "Title:", "Task:" or "Item 2:" are not part of the change.
    ?.replace(/^(?:title|task|item\s*\d+|objective|goal|todo)\s*[:.-]\s*/iu, "")
    .replace(
      /^(?:please\s+|i\s+(?:want|need|would like)\s+(?:you\s+)?to\s+|can you\s+|could you\s+)/iu,
      "",
    )
    .replace(/^you\s+(?:should|must)\s+/iu, "")
    // Branch names never belong in the subject.
    .replace(/\s+(?:on|in|to|from|onto)\s+(?:the\s+)?branch\s+\S+/giu, "")
    .replace(/\s*\bbranch\s+(?:`[^`]*`|\S+)/giu, "")
    // "I will fix X" and similar keep the verb that follows.
    .replace(/^(?:i\s+will|i'll|i\s+need\s+to|i\s+want\s+to|i\s+am\s+going\s+to)\s+/iu, "")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/gu, "$1")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .split(/[.!?](?:\s|$)/u)[0]
    ?.replace(/\s+/gu, " ")
    .trim();
  // A first-person or progress report is not an imperative description of the change.
  const usable =
    action !== undefined && !/^(?:i|i'm|i've|i'll|we|implemented|done)\b/iu.test(action)
      ? action
      : undefined;
  const subject = usable || `Update task ${task.taskId}`;
  const bounded = subject.length > 72 ? `${subject.slice(0, 69).trimEnd()}...` : subject;
  return bounded.charAt(0).toUpperCase() + bounded.slice(1);
}

/** A Workspace setup failure: the Attempt fails before its harness starts. */
function setupError(error: unknown): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.name = "WorkspaceSetupError";
  return failure;
}

/**
 * A path as one line of plain text: control characters, line and paragraph separators, and
 * bidirectional controls become `\n`-style or `\uXXXX` escapes, so a file name can neither start
 * a new line in a failure message nor reorder or hide its text.
 */
function printablePath(path: string): string {
  return path.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters escaped.
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\\]/gu,
    (character) =>
      ({ "\n": "\\n", "\r": "\\r", "\t": "\\t", "\\": "\\\\" })[character] ??
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** At most 20 paths, each as printable text, then how many more. */
function listedPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 20).map(printablePath).join(", ");
  return paths.length > 20 ? `${shown}, and ${paths.length - 20} more` : shown;
}

/** A review may use only the immutable commit pinned by an admitted artifact input. */
function reviewGitHead(task: WorkspaceTask): string | undefined {
  const heads = new Set<string>();
  for (const attachment of task.input?.attachments ?? []) {
    const reference = attachment.provenance?.["workspaceGitReference"];
    if (reference === undefined) continue;
    if (!attachment.artifactId || typeof attachment.provenance?.["taskId"] !== "string")
      throw new Error("Submitted Workspace git reference needs an admitted artifact");
    if (typeof reference !== "string") throw new Error("Invalid submitted Workspace git reference");
    const match = /^git:supertag\/[A-Za-z0-9._/-]+@([0-9a-f]{40,64})$/u.exec(reference);
    if (!match) throw new Error("Invalid submitted Workspace git reference");
    heads.add(match[1] as string);
  }
  if (heads.size > 1) throw new Error("Review inputs name different submitted Workspace commits");
  return heads.values().next().value;
}

/**
 * Local applies no plan to a Task checkout: the Worker's local execution environment applies
 * the Task's plan when it starts the Harness.
 */
const IN_PLACE_PLAN: EnvironmentPlan = {
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "none" },
};

/**
 * One remote Attempt between `resolve` and `finalize`. `resolve` prepares the environment; the
 * Worker then plans the sandbox's network policy and calls `startWorkspaceSandbox` before tool
 * resolution, so the Workspace's stdio MCP servers are listed and run inside the sandbox.
 */
interface RemoteAttempt {
  readonly environment: WorkspaceEnvironment;
  readonly prepared: Awaited<ReturnType<WorkspaceEnvironment["prepare"]>>;
  readonly checkout: Omit<Parameters<WorkspaceEnvironment["start"]>[1], "plan">;
  readonly repository: WorkspaceRepository;
  readonly mcp: WorkspaceMcpResolution | undefined;
  /** Private host directory holding this Attempt's bundles. */
  readonly bundles: string;
  /** The started checkout, which `finalize` commits and disposes. */
  sandbox?: ExecutionEnvironment;
  /** The Harness's view of the sandbox, rooted beside the checkout. */
  harness?: ExecutionEnvironment;
}

/**
 * Serves named Workspaces through a {@link LocalWorkspaceEnvironment}, from checkouts declared
 * on this Worker Host or from a host-managed bare clone of the Workspace source. `resolve`
 * builds the Task's {@link WorkspaceDefinition} from the host repository, refuses or prepares
 * it, and starts the Task's checkout; `finalize` commits through the environment and delivers
 * from the host. Each Task gets its own git worktree on its deterministic branch; the Harness uses
 * it in place, without a copy. A declared checkout's own working tree and current branch are
 * never changed.
 */
export class WorkspaceEnvironmentResolver implements WorkspaceResolver {
  readonly #host: WorkspaceHost;
  readonly #branches: WorkspaceBranches;
  readonly #localMountRoot: LocalMountRoot | undefined;
  readonly #environment: LocalWorkspaceEnvironment;
  readonly #environments: ReadonlyMap<string, WorkspaceEnvironment>;
  readonly #credentials: WorkspaceSourceCredentials | undefined;
  readonly #catalogSourceUrl: string | undefined;
  readonly #pullRequests: WorkspacePullRequestPublisher | undefined;
  readonly #author: GitAuthor;
  readonly #mcpVariables: Readonly<Record<string, string | undefined>> | undefined;
  readonly #mcpByAttempt = new Map<string, WorkspaceMcpResolution>();
  readonly #remoteByAttempt = new Map<string, RemoteAttempt>();
  readonly #skillsByAttempt = new Map<string, readonly SkillInput[]>();
  readonly #volumes: VolumeResolver | undefined;
  /** Native attachment evidence, reported before the harness starts. */
  readonly #liveMountsByAttempt = new Map<string, readonly LiveMount[]>();
  /** What each Attempt's `copy` mounts placed, reported before its harness starts. */
  readonly #mountsByAttempt = new Map<string, readonly MountManifest[]>();
  readonly #mountOutputsByAttempt = new Map<string, readonly MountOutputManifest[]>();

  constructor(options: WorkspaceEnvironmentResolverOptions) {
    const checkouts = new Map<string, string>();
    for (const checkout of options.checkouts) {
      if (!WORKSPACE_NAME.test(checkout.name))
        throw new Error(`Invalid Workspace name ${JSON.stringify(checkout.name)}`);
      if (checkouts.has(checkout.name))
        throw new Error(`Workspace ${checkout.name} is declared more than once`);
      if (!isAbsolute(checkout.path))
        throw new Error(`Workspace ${checkout.name} checkout path must be absolute`);
      checkouts.set(checkout.name, checkout.path);
    }
    this.#host = new WorkspaceHost({
      root: resolve(
        options.worktreeRoot ??
          join(
            process.env["SUPERTAG_STATE_DIR"]?.trim() || join(homedir(), ".supertag"),
            "workspaces",
          ),
      ),
      checkouts,
      cloneSources: options.cloneSources ?? false,
      ...(options.git === undefined ? {} : { git: options.git }),
      ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    });
    this.#branches = new WorkspaceBranches(this.#host);
    this.#localMountRoot = options.localMountRoot;
    this.#environment = new LocalWorkspaceEnvironment({
      host: this.#host,
      ...(options.localMountRoot === undefined ? {} : { localMountRoot: options.localMountRoot }),
      ...(options.setupTimeoutMs === undefined ? {} : { setupTimeoutMs: options.setupTimeoutMs }),
      ...(options.setupEnvironment === undefined
        ? {}
        : { setupEnvironment: options.setupEnvironment }),
    });
    if (options.environments?.["local-execution"] !== undefined)
      throw new Error("The local Workspace environment cannot be replaced");
    this.#environments = new Map<string, WorkspaceEnvironment>([
      ["local-execution", this.#environment],
      ...Object.entries(options.environments ?? {}),
    ]);
    this.#credentials = options.sourceCredentials;
    this.#catalogSourceUrl = options.catalogSourceUrl;
    this.#pullRequests = options.pullRequests;
    this.#author = options.author ?? { name: "SuperTag", email: "supertag@localhost" };
    this.#mcpVariables = options.mcpVariables;
    this.#volumes = options.volumes;
  }

  /** The Workspace environment Tasks run in. */
  get environment(): LocalWorkspaceEnvironment {
    return this.#environment;
  }

  supportsCopyMounts(providerId: string): boolean {
    const mounts = this.#environments.get(providerId)?.capabilities.mounts;
    return mounts?.strategies.includes("copy") === true && mounts.access.includes("read-only");
  }

  supportsNativeMounts(providerId: string): boolean {
    const mounts = this.#environments.get(providerId)?.capabilities.mounts;
    return mounts?.strategies.includes("mount") === true && mounts.access.includes("read-only");
  }

  /** Why placement refuses a Workspace Task on this profile and provider. */
  refuseProfile(
    profile: { readonly runtime?: unknown; readonly execution: { readonly provider: string } },
    execution: { readonly id: string },
  ): string | undefined {
    return this.#profileRefusal(profile, execution.id);
  }

  #profileRefusal(
    profile: { readonly runtime?: unknown } | undefined,
    providerId: string,
  ): string | undefined {
    const environment = this.#environments.get(providerId);
    if (environment === undefined)
      return `provider ${providerId} has no registered Workspace environment`;
    if (environment === this.#environment && profile?.runtime !== undefined)
      return `provider ${providerId} cannot use a local Workspace checkout with this Worker Profile`;
    return undefined;
  }

  /**
   * Host-private server definitions for the policy proxy. Never pass them to a Harness. On a
   * remote provider, stdio servers are bound to the started sandbox and its trusted copy, with no
   * host variables or host working directory; before the sandbox starts there are none to list.
   */
  mcpServersForAttempt(attemptId: string): readonly ResolvedWorkspaceMcpServer[] {
    const remote = this.#remoteByAttempt.get(attemptId);
    if (remote === undefined) return this.#mcpByAttempt.get(attemptId)?.servers ?? [];
    if (remote.mcp === undefined) return [];
    if (remote.harness === undefined || remote.environment.mcpDirectory === undefined)
      throw new Error(
        `Workspace MCP servers of Task Attempt ${attemptId} run in its ${remote.environment.provider} sandbox, which has not started`,
      );
    return sandboxWorkspaceMcpServers(remote.mcp.servers, {
      provider: remote.environment.provider,
      sandbox: remote.harness,
      directory: remote.environment.mcpDirectory,
    });
  }

  /** True when this Attempt's Workspace runs in a remote sandbox not yet started. */
  startsWorkspaceSandbox(attemptId: string): boolean {
    const remote = this.#remoteByAttempt.get(attemptId);
    return remote !== undefined && remote.sandbox === undefined;
  }

  /**
   * Starts a remote Attempt's sandbox from its prepared environment with the network policy the
   * Worker planned before tool resolution, and returns the Harness's view of it, rooted beside the
   * checkout so nothing the Harness stages is committed. The resolver keeps it until `finalize`.
   */
  async startWorkspaceSandbox(
    attemptId: string,
    network: EnvironmentPlan["network"],
    signal?: AbortSignal,
  ): Promise<ExecutionEnvironment> {
    const remote = this.#remoteByAttempt.get(attemptId);
    if (remote === undefined || remote.sandbox !== undefined)
      throw new Error(`Task Attempt ${attemptId} has no Workspace sandbox to start`);
    const harnessEnvironment = remote.environment.harnessEnvironment?.bind(remote.environment);
    if (harnessEnvironment === undefined)
      throw new Error(`Task Attempt ${attemptId} has no Harness view of its Workspace sandbox`);
    remote.sandbox = await remote.environment.start(
      remote.prepared,
      { ...remote.checkout, plan: { ...IN_PLACE_PLAN, network } },
      signal,
    );
    this.#mountsByAttempt.set(attemptId, startedMountManifests(remote.sandbox));
    this.#liveMountsByAttempt.set(attemptId, parseLiveMounts(remote.sandbox.liveMounts ?? []));
    remote.harness = harnessEnvironment(remote.sandbox);
    return remote.harness;
  }

  /** Live sources attached by the provider when this Task Attempt's checkout started. */
  liveMountsForAttempt(attemptId: string): readonly LiveMount[] {
    return this.#liveMountsByAttempt.get(attemptId) ?? [];
  }

  /**
   * What this Attempt's Workspace `copy` mounts placed, once its checkout started: before the
   * harness, after `setup`. Manifests name keys, sizes, and versions, never a credential.
   */
  mountManifestsForAttempt(attemptId: string): readonly MountManifest[] {
    return this.#mountsByAttempt.get(attemptId) ?? [];
  }

  mountOutputManifestsForAttempt(attemptId: string): readonly MountOutputManifest[] {
    const outputs = this.#mountOutputsByAttempt.get(attemptId) ?? [];
    this.#mountOutputsByAttempt.delete(attemptId);
    return outputs;
  }

  /** Digest of the Workspace MCP configuration this Attempt uses, known before any launch. */
  mcpServersDigestForAttempt(attemptId: string): string | undefined {
    return this.#mcpByAttempt.get(attemptId)?.digest;
  }

  skillInputsForAttempt(attemptId: string): readonly SkillInput[] {
    return this.#skillsByAttempt.get(attemptId) ?? [];
  }

  /** Names this host advertises; paths are never advertised. */
  get workspaces(): readonly string[] {
    return this.#host.declared;
  }

  /** True when this resolver serves Workspaces without a declared checkout from their source. */
  get clonesSources(): boolean {
    return this.#host.clonesSources;
  }

  /** The Task worktree directory for a Workspace and Task. */
  worktreePath(workspace: string, taskId: string): string {
    return this.#environment.worktreePath(workspace, taskId);
  }

  /** The host-managed clone of a Workspace source. */
  clonePath(workspace: string): string {
    return this.#host.clonePath(workspace);
  }

  /**
   * The Worker-owned snapshot of a Task's base commit that Workspace MCP servers are read from
   * and run in. It is a sibling of the Task worktree, never inside it.
   */
  mcpSnapshotPath(workspace: string, taskId: string): string {
    return join(this.#host.root, workspace, "mcp", gitRefComponent(taskId));
  }

  /**
   * Checks mount support before any provider call. Copy mounts pin host credentials; native
   * mounts resolve only catalog sources and never open host copy credentials.
   */
  async #pinVolumes(
    plan: TaskNamedWorkspacePlan,
    environment: WorkspaceEnvironment,
    task: ResolutionContext["task"],
  ): Promise<VolumeResolver | undefined> {
    const mounts = plan.mounts ?? [];
    if (mounts.length === 0) return undefined;
    assertWorkspaceMountSupport(environment, mounts);
    const copies = mounts.filter((mount) => mount.strategy === "copy");
    const native = new Map<string, ResolvedVolume>();
    for (const mount of mounts) {
      if (mount.strategy !== "mount" || native.has(mount.volume)) continue;
      if (this.#volumes?.resolveMount === undefined)
        throw new Error(
          `Workspace mount ${mount.volume}: this Worker Host has no native mount source guard`,
        );
      const resolved = await this.#volumes.resolveMount(mount.volume, {
        taskId: task.taskId,
        attemptId: task.attemptId,
        ...(plan.volumes === undefined ? {} : { volumes: plan.volumes }),
      });
      if (resolved.volume !== mount.volume)
        throw new Error(`Workspace mount ${mount.volume}: host resolved a different Volume`);
      // Pin metadata only. Even a custom resolver cannot leak copy credentials to a provider.
      const metadata: ResolvedVolume = {
        volume: mount.volume,
        source: resolved.source,
        ...(resolved.nativeCredential === undefined
          ? {}
          : { nativeCredential: parseModalVolumeCredential(resolved.nativeCredential) }),
      };
      const refusal = environment.refuseMount?.(mount, metadata);
      if (refusal !== undefined) throw new Error(refusal);
      native.set(mount.volume, metadata);
    }
    const pinned = await pinWorkspaceVolumes({
      mounts: copies,
      volumes: this.#volumes,
      task: {
        taskId: task.taskId,
        attemptId: task.attemptId,
        ...(plan.volumes === undefined ? {} : { volumes: plan.volumes }),
      },
      protectedDirectories: [this.#host.root, ...this.#host.declaredCheckoutPaths],
    });
    return {
      ...(pinned?.protectedDirectories === undefined
        ? {}
        : { protectedDirectories: pinned.protectedDirectories }),
      resolve: async (name, request, signal) => {
        if (
          request.taskId !== task.taskId ||
          request.attemptId !== task.attemptId ||
          !mounts.some((mount) => mount.volume === name)
        )
          throw new Error(`Workspace mount ${name}: not resolved for this Task Attempt`);
        if (pinned && copies.some((mount) => mount.volume === name))
          return pinned.resolve(name, request, signal);
        const volume = native.get(name);
        if (!volume) throw new Error(`Workspace mount ${name}: Volume source is unavailable`);
        return volume;
      },
      resolveMount: async (name, request) => {
        const volume = native.get(name);
        if (
          request.taskId !== task.taskId ||
          request.attemptId !== task.attemptId ||
          volume === undefined
        )
          throw new Error(
            `Workspace mount ${name}: not resolved as a native mount for this Task Attempt`,
          );
        return volume;
      },
    };
  }

  async resolve(context: ResolutionContext): Promise<WorkspaceInput | undefined> {
    const requested = namedPlan(context.task.workspacePlan);
    if (requested === undefined) return undefined;
    const plan = requested;
    const providerId = context.profile?.execution?.provider ?? "local-execution";
    const environment = this.#environments.get(providerId);
    const refusal = this.#profileRefusal(context.profile, providerId);
    if (refusal !== undefined || environment === undefined)
      throw new Error(
        `Workspace ${plan.workspace}: ${refusal ?? `provider ${providerId} is unavailable`}`,
      );
    assertWorkspaceMountSupport(environment, plan.mounts ?? []);
    const local = environment === this.#environment;
    if (local)
      for (const mount of plan.mounts ?? [])
        await assertLocalMountDestination(mount.path, this.#localMountRoot);
    const host = this.#host;
    // Remote sandboxes import their returned commits into a host-managed clone; a declared
    // checkout's own repository is never written that way.
    if (!local && host.declared.includes(plan.workspace)) {
      const error = new Error(
        `Workspace ${plan.workspace}: provider ${providerId} serves Workspaces from their source, not a checkout declared on this Worker Host`,
      );
      error.name = "WorkspaceSetupError";
      throw error;
    }
    const task = context.task;
    // Before any clone, prepare, or provider call: every source passes host artifact protection.
    // Copy mounts also pin host credentials; native mounts pin credential-free metadata only.
    const volumes = await this.#pinVolumes(plan, environment, task);
    return host.serialized(`${plan.workspace}\0${task.taskId}`, async () => {
      let plan = requested;
      let resolved = false;
      try {
        const reviewHead = reviewGitHead(task);
        // Clone, fetch, and worktree changes share one repository, so they take its lock.
        const located = await host.exclusive(plan.workspace, async () => {
          const repository = await host.repository(plan, true);
          const credential = repository.managed
            ? await this.#credentials?.resolve({
                task,
                source: plan.source as string,
                purpose: "fetch",
              })
            : undefined;
          if (repository.managed) await host.fetch(repository, plan, credential);
          plan = await this.#branches.allocate(repository, plan, task.taskId);
          const commits =
            (local
              ? await this.#environment.resume(repository, plan, task.taskId, reviewHead)
              : undefined) ?? (await this.#locate(repository, plan, task, reviewHead, credential));
          await this.#branches.record(repository, plan, task.taskId, commits.head);
          const trusted =
            commits.trusted ?? (await host.trusted(repository, plan, reviewHead ?? commits.base));
          const mcp = plan.mcp?.length
            ? await this.#workspaceMcp(repository, plan, task.taskId, trusted)
            : undefined;
          const localSkills =
            local && plan.skills?.length
              ? await pinWorkspaceSkills({
                  checkout: await this.#skillCheckout(repository, plan, trusted),
                  cache: join(host.root, plan.workspace, "skills", gitRefComponent(task.taskId)),
                  names: plan.skills,
                  ...(plan.skillPins === undefined
                    ? {}
                    : {
                        expected: plan.skillPins.filter((pin) => !pin.source.startsWith("github:")),
                      }),
                })
              : [];
          const catalogSkills = plan.skillCatalog
            ? await pinGitHubSkillCatalog({
                catalog: plan.skillCatalog,
                useEnvironmentToken: this.#credentials === undefined,
                ...(this.#catalogSourceUrl === undefined
                  ? {}
                  : { sourceUrl: this.#catalogSourceUrl }),
                cache: join(
                  host.root,
                  plan.workspace,
                  "skills",
                  gitRefComponent(task.taskId),
                  "github",
                ),
                ...(plan.skillPins === undefined
                  ? {}
                  : { expected: plan.skillPins.filter((pin) => pin.source.startsWith("github:")) }),
                ...(this.#credentials === undefined
                  ? {}
                  : {
                      credential: await this.#credentials.resolve({
                        task,
                        source: `https://github.com/${plan.skillCatalog.repository}.git`,
                        purpose: "fetch",
                      }),
                    }),
              })
            : [];
          const skills = [...localSkills, ...catalogSkills];
          return { repository, commits, trusted, mcp, skills };
        });
        const devcontainer = local
          ? undefined
          : await readTrustedDevcontainer(located.repository.path, located.trusted);
        // Resolved MCP servers stay with the Worker; the definition carries only their declared
        // shapes and digest, so a provider can refuse what it cannot run without a credential.
        const definition = workspaceDefinition({
          workspace: plan.workspace,
          source: host.sourceOf(plan, located.repository),
          trustedCommit: located.trusted,
          // Local setup keeps its existing contract and never reads devcontainer.json.
          ...(local ? {} : { trustedRepository: located.repository.path }),
          ...(devcontainer === undefined ? {} : { devcontainer }),
          ...(plan.setup === undefined ? {} : { setup: plan.setup }),
          ...(located.mcp === undefined ? {} : { mcp: located.mcp }),
          harness: workspaceHarnessRequirement(context.profile),
          taskId: task.taskId,
        });
        if (!local) {
          // The Harness's execution root is the checkout's parent; it works at mountPath.
          const mountPath = environment.checkoutPath;
          if (mountPath === undefined || environment.harnessEnvironment === undefined)
            throw new Error(
              `${environment.provider} Workspace environments give a Harness no view beside the checkout`,
            );
          const bundles = await mkdtemp(join(host.root, plan.workspace, "bundles-"));
          try {
            const remoteDefinition: WorkspaceDefinition = {
              ...definition,
              content: await bundleTrustedCommit({
                repository: located.repository.path,
                trustedCommit: located.trusted,
                directory: bundles,
              }),
            };
            const providerRefusal = environment.refuse(remoteDefinition);
            if (providerRefusal !== undefined) {
              const error = new Error(providerRefusal);
              error.name = "WorkspaceSetupError";
              throw error;
            }
            const prepared = await environment.prepare(remoteDefinition);
            const objects = await bundleTaskObjects({
              repository: located.repository.path,
              trustedCommit: located.trusted,
              head: located.commits.head,
              directory: bundles,
            });
            this.#remoteByAttempt.set(task.attemptId, {
              environment,
              prepared,
              checkout: {
                taskId: task.taskId,
                attemptId: task.attemptId,
                ...(plan.mounts === undefined ? {} : { mounts: plan.mounts }),
                ...(volumes === undefined ? {} : { volumes }),
                branch: plan.branch,
                base: located.commits.base,
                head: located.commits.head,
                ...(objects === undefined ? {} : { objects }),
              },
              repository: located.repository,
              mcp: located.mcp,
              bundles,
            });
            if (located.mcp) this.#mcpByAttempt.set(task.attemptId, located.mcp);
            if (located.skills.length) this.#skillsByAttempt.set(task.attemptId, located.skills);
          } catch (error) {
            await rm(bundles, { recursive: true, force: true }).catch(() => undefined);
            throw error;
          }
          resolved = true;
          // The Worker starts the sandbox before tool resolution. The Harness works in the checkout
          // at mountPath and stages beside it, never into it.
          return {
            id: `workspace:${plan.workspace}:${plan.branch}`,
            kind: "workspace" as const,
            required: true,
            source: {
              uri: `supertag-workspace:${plan.workspace}`,
              digest: `git:${located.commits.base}`,
              provenance: {
                provider: "supertag-workspace",
                workspace: plan.workspace,
                branch: plan.branch,
                base: located.commits.base,
                preparedProvider: environment.provider,
                trustedCommit: located.trusted,
                ...(located.mcp === undefined ? {} : { mcpServersDigest: located.mcp.digest }),
                delivery: plan.delivery,
              },
            },
            mountPath,
            placement: "execution-root" as const,
            readOnly: !(task.authorization.runtimeActions ?? []).includes("files:write"),
          };
        }
        const providerRefusal = environment.refuse(definition);
        if (providerRefusal !== undefined) {
          const error = new Error(providerRefusal);
          error.name = "WorkspaceSetupError";
          throw error;
        }
        const prepared = await environment.prepare(definition);
        // The Attempt starts here: every later Worker git command checks the digest start records.
        const started = await environment.start(prepared, {
          taskId: task.taskId,
          attemptId: task.attemptId,
          ...(plan.mounts === undefined ? {} : { mounts: plan.mounts }),
          ...(volumes === undefined ? {} : { volumes }),
          branch: plan.branch,
          base: located.commits.base,
          head: located.commits.head,
          plan: IN_PLACE_PLAN,
        });
        this.#mountsByAttempt.set(task.attemptId, startedMountManifests(started));
        this.#liveMountsByAttempt.set(task.attemptId, parseLiveMounts(started.liveMounts ?? []));
        if (located.mcp) this.#mcpByAttempt.set(task.attemptId, located.mcp);
        if (located.skills.length) this.#skillsByAttempt.set(task.attemptId, located.skills);
        resolved = true;
        return {
          id: `workspace:${plan.workspace}:${plan.branch}`,
          kind: "workspace" as const,
          prepared,
          required: true,
          source: {
            uri: pathToFileURL(prepared.artifact).href,
            digest: `git:${located.commits.base}`,
            provenance: {
              provider: "supertag-workspace",
              workspace: plan.workspace,
              branch: plan.branch,
              base: located.commits.base,
              preparedDigest: prepared.digest,
              preparedProvider: prepared.provider,
              trustedCommit: prepared.trustedCommit,
              ...(located.mcp === undefined ? {} : { mcpServersDigest: located.mcp.digest }),
              delivery: plan.delivery,
            },
          },
          placement: "in-place" as const,
          readOnly: !(task.authorization.runtimeActions ?? []).includes("files:write"),
        };
      } finally {
        if (!resolved) await this.#removeMcpSnapshot(plan, task.taskId);
      }
    });
  }

  /**
   * The commits a new Task checkout starts from. A clone is fetched first, so a new checkout
   * starts from current work. A recorded Task branch, on this host or pushed by another, is
   * continued; a review starts at the submitted commit it reviews and measures its own changes
   * from it; otherwise the branch starts at the Workspace ref.
   */
  async #locate(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    task: WorkspaceTask,
    reviewHead: string | undefined,
    credential: GitSourceCredential | undefined,
  ): Promise<LocalTaskCommits> {
    const host = this.#host;
    const baseRef = await host.baseRef(repository, plan);
    const local = `refs/heads/${plan.branch}`;
    // Another host may already have pushed this Task's branch; continue from it.
    const remote = host.remoteBranch(plan.branch);
    const existing = (await host.hasRef(repository.path, local))
      ? local
      : repository.managed && (await host.hasRef(repository.path, remote))
        ? remote
        : undefined;
    const where = repository.managed ? "clone of its source" : "checkout";
    if (existing !== undefined) {
      if (plan.branchPin !== plan.branch)
        throw setupError(
          `Task branch ${plan.branch} already exists without an ownership record; retry to allocate a new branch`,
        );
      const head = await host.commit(
        repository.path,
        existing,
        `Task branch ${existing} is unreadable`,
      );
      // A review continues an existing branch only when it holds the submitted commit; otherwise
      // the reviewer would see, and could deliver, content other than the change under review.
      if (reviewHead) await host.assertContains(repository.path, reviewHead, head);
      if (reviewHead) return { base: reviewHead, head };
      const forked = await host.mergeBase(repository.path, head, baseRef).catch(() => head);
      return { base: await this.#continuedBase(repository, plan, task, forked, head), head };
    }
    if (reviewHead) {
      const base = await host.commit(
        repository.path,
        reviewHead,
        `Submitted commit ${reviewHead} is not in the ${where}`,
      );
      return { base, head: base };
    }
    const ref = await host.commit(
      repository.path,
      baseRef,
      `Workspace ${plan.workspace} base ref ${baseRef} does not name a commit in the ${where}`,
    );
    // A new Task branch starts from the Workspace ref merged with its dependencies' work, and
    // measures its own changes from there.
    const base = await this.#mergeDependencies(repository, plan, task, ref, where, credential);
    return { base, head: base };
  }

  /**
   * The base of a Task branch this Attempt continues without a kept worktree, which would have
   * recorded it. The branch started from the Workspace ref merged with its dependencies, and that
   * merge is deterministic, so redoing it from where the branch forked from the ref gives the same
   * commit. When the result is not in the branch, as when the branch was made otherwise, the fork
   * point is the base. The redone merge fetches nothing and fails nothing.
   */
  async #continuedBase(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    task: WorkspaceTask,
    forked: string,
    head: string,
  ): Promise<string> {
    if (!plan.dependencyBranches?.length) return forked;
    const merged = await this.#mergeDependencies(repository, plan, task, forked).catch(
      () => forked,
    );
    if (merged === forked) return forked;
    return this.#host.run(repository.path, ["merge-base", "--is-ancestor", merged, head]).then(
      () => merged,
      () => forked,
    );
  }

  /**
   * Merges each accepted dependency's delivered commit into `base`, in order, in the repository's
   * object store: before any worktree exists, so no harness ever has to merge. A commit already
   * contained is skipped and one that contains the result is fast-forwarded to. A conflict fails
   * the Attempt before its harness starts, naming the conflicting paths.
   *
   * A dependency commit missing from a host-managed clone, as when another Worker Host delivered
   * it, is fetched from the source by id when `where` is given. Still missing, it fails the
   * Attempt with what would make it available.
   */
  async #mergeDependencies(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    task: WorkspaceTask,
    base: string,
    where?: string,
    credential?: GitSourceCredential,
  ): Promise<string> {
    const host = this.#host;
    const contains = (ancestor: string, commit: string) =>
      host.run(repository.path, ["merge-base", "--is-ancestor", ancestor, commit]).then(
        () => true,
        () => false,
      );
    let merged = base;
    for (const dependency of plan.dependencyBranches ?? []) {
      const present = (await host.hasRef(repository.path, `${dependency.head}^{commit}`))
        ? true
        : where !== undefined && (await host.fetchCommit(repository, dependency.head, credential));
      if (!present) {
        const delivered = `Dependency ${dependency.taskId} delivered commit ${dependency.head.slice(0, 12)} on branch ${dependency.branch}`;
        const stays = `with branch delivery it stays in the repository of the Worker Host that ran ${dependency.taskId}`;
        throw setupError(
          repository.managed
            ? `${delivered}, which is not in the ${where} and could not be fetched from the source: ${stays}. Push branch ${dependency.branch} from that host to the Workspace source, or run this Task on that Worker Host, then retry; SuperTag started no harness`
            : `${delivered}, which is not in the ${where}: ${stays}. Fetch branch ${dependency.branch} into this checkout, or run this Task on that Worker Host, then retry; SuperTag started no harness`,
        );
      }
      const head = await host.commit(
        repository.path,
        dependency.head,
        `Dependency commit ${dependency.head.slice(0, 12)} is unreadable`,
      );
      if (await contains(head, merged)) continue;
      if (await contains(merged, head)) {
        merged = head;
        continue;
      }
      merged = await host
        .mergeCommit(
          repository.path,
          merged,
          head,
          `Merge dependency branch ${dependency.branch}\n\nSuperTag-Dependency: ${dependency.taskId}\nSuperTag-Task: ${task.taskId}`,
          this.#author,
        )
        .catch((error: unknown) => {
          if (error instanceof WorkspaceMergeConflictError)
            throw new WorkspaceMergeConflictError(
              error.paths,
              `Merging dependency ${dependency.taskId} (branch ${dependency.branch} at ${head.slice(0, 12)}) into this Task's base conflicts in ${listedPaths(error.paths)}; SuperTag started no harness`,
            );
          throw setupError(error);
        });
    }
    return merged;
  }

  /**
   * Commits whatever the Attempt left in its Task worktree, then prepares delivery. A completed
   * Attempt removes the worktree and keeps the branch; a failed or cancelled one keeps both for a
   * retry. An Attempt of any outcome without commits since the base deletes the worktree and the
   * branch. A later Attempt of the same Task recreates the worktree from the branch, or starts it
   * afresh from the base. Pull-request delivery pushes the branch and opens
   * or updates the Task's pull request after a completed Attempt with commits.
   */
  async finalize(
    task: WorkspaceTask,
    outcome: WorkspaceAttemptOutcome,
    details: WorkspaceFinalizeDetails = {},
  ): Promise<WorkspaceDeliveryRecord | undefined> {
    const host = this.#host;
    try {
      // Each git command below, including a pull-request push, first checks the digest the
      // Attempt recorded at its start.
      return await host.checked(task.attemptId, async () => {
        await host.checkIntegrity();
        const record = await this.#finalize(task, outcome, details).catch((error: unknown) => {
          throw host.integrityFailure(task.attemptId) ?? error;
        });
        // A refusal that a best-effort step absorbed still fails the Attempt.
        const failure = host.integrityFailure(task.attemptId);
        if (failure) throw failure;
        return record;
      });
    } finally {
      host.forgetIntegrity(task.attemptId);
      await this.#environment.releaseMounts(task.attemptId);
    }
  }

  async #finalize(
    task: WorkspaceTask,
    outcome: WorkspaceAttemptOutcome,
    details: WorkspaceFinalizeDetails,
  ): Promise<WorkspaceDeliveryRecord | undefined> {
    this.#mcpByAttempt.delete(task.attemptId);
    this.#skillsByAttempt.delete(task.attemptId);
    this.#mountsByAttempt.delete(task.attemptId);
    this.#liveMountsByAttempt.delete(task.attemptId);
    const requested = namedPlan(task.workspacePlan);
    if (requested === undefined) return undefined;
    const repository = await this.#host.repository(requested, false).catch(() => undefined);
    if (repository === undefined) return undefined;
    const branch = await this.#branches.recorded(repository, task.taskId);
    if (branch === undefined) return undefined;
    const plan = { ...requested, branch };
    const remote = this.#remoteByAttempt.get(task.attemptId);
    if (remote !== undefined) {
      this.#remoteByAttempt.delete(task.attemptId);
      try {
        return await this.#finalizeRemote(task, plan, remote, outcome, details);
      } finally {
        if (plan.mcp?.length) await this.#removeMcpSnapshot(plan, task.taskId);
        await rm(remote.bundles, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    // The next Attempt recreates the snapshot from the base commit.
    if (plan.mcp?.length) await this.#removeMcpSnapshot(plan, task.taskId);
    const worktree = this.worktreePath(plan.workspace, task.taskId);
    if (!(await isDirectory(worktree))) return undefined;
    return this.#host.serialized(`${plan.workspace}\0${task.taskId}`, async () => {
      const checkout = await this.#environment.reopen(repository, plan, task);
      if (checkout === undefined) return undefined;
      const finalized = await this.#environment.finalize(checkout, {
        message: `${commitSubject(task, details.summary)}\n\n${details.summary?.trim() ? `${details.summary.trim()}\n\n` : ""}Attempt: ${task.attemptId}\nOutcome: ${outcome}\nWorkspace: ${plan.workspace}\n\nSuperTag-Task: ${task.taskId}`,
        author: this.#author,
      });
      this.#mountOutputsByAttempt.set(task.attemptId, finalized.mountOutputManifests ?? []);
      return this.#deliver(task, plan, repository, checkout, finalized, outcome, details);
    });
  }

  /**
   * Commits a remote Attempt's work inside its sandbox, imports the returned commits into the
   * host-managed clone through {@link deliverWorkspace}, then disposes the sandbox. An Attempt
   * whose sandbox never started has nothing to deliver.
   */
  async #finalizeRemote(
    task: WorkspaceTask,
    plan: TaskNamedWorkspacePlan,
    remote: RemoteAttempt,
    outcome: WorkspaceAttemptOutcome,
    details: WorkspaceFinalizeDetails,
  ): Promise<WorkspaceDeliveryRecord | undefined> {
    const sandbox = remote.sandbox;
    if (sandbox === undefined) return undefined;
    try {
      const finalized = await remote.environment.finalize(
        sandbox,
        {
          message: `${commitSubject(task, details.summary)}\n\n${details.summary?.trim() ? `${details.summary.trim()}\n\n` : ""}Attempt: ${task.attemptId}\nOutcome: ${outcome}\nWorkspace: ${plan.workspace}\n\nSuperTag-Task: ${task.taskId}`,
          author: this.#author,
        },
        details.signal,
      );
      this.#mountOutputsByAttempt.set(task.attemptId, finalized.mountOutputManifests ?? []);
      const delivery = await deliverWorkspace(
        {
          host: this.#host,
          repository: remote.repository,
          base: remote.checkout.base,
          outcome,
          publish: (from, head) =>
            this.#publish(task, plan, remote.repository, from, head, details),
        },
        plan,
        finalized,
      );
      await this.#host.exclusive(plan.workspace, () =>
        this.#branches.advance(
          remote.repository,
          task.taskId,
          plan.branch,
          finalized.head,
          finalized.head === remote.checkout.base,
        ),
      );
      // A remote Attempt has no host worktree; its branch lives in the host-managed clone.
      return { ...delivery, worktreeRemoved: false, branchRemoved: false };
    } finally {
      await sandbox.dispose(outcome).catch(() => undefined);
    }
  }

  /**
   * Today's delivery from the Task worktree: the change count, a patch for `patch` delivery, a
   * push and pull request for `pull-request` delivery, then worktree and empty-branch removal.
   */
  async #deliver(
    task: WorkspaceTask,
    plan: TaskNamedWorkspacePlan,
    repository: WorkspaceRepository,
    checkout: LocalWorkspaceCheckout,
    finalized: { readonly head: string; readonly committed: boolean },
    outcome: WorkspaceAttemptOutcome,
    details: WorkspaceFinalizeDetails,
  ): Promise<WorkspaceDeliveryRecord> {
    const host = this.#host;
    const tree = checkout.tree;
    const base = await this.#environment.recordedBase(tree, plan, repository);
    const delivery = await deliverWorkspace(
      {
        host,
        repository,
        base,
        outcome,
        publish: (from, head) => this.#publish(task, plan, repository, from, head, details),
      },
      plan,
      finalized,
    );
    let worktreeRemoved = false;
    let branchRemoved = false;
    // A branch without commits holds no work to deliver or retry from, whatever the outcome; a
    // later Attempt starts afresh from the base. Otherwise only a completed Attempt drops the
    // worktree, and a failed or cancelled one keeps it for a retry.
    const empty = finalized.head === base;
    if (outcome === "completed" || empty) {
      await host.exclusive(plan.workspace, async () => {
        await host.discardWorktree(repository, tree.path);
        // Delete the branch only while it still points at the base, so a concurrent update is
        // never lost.
        if (empty)
          branchRemoved = await host
            .run(repository.path, ["update-ref", "-d", `refs/heads/${plan.branch}`, base])
            .then(
              () => true,
              () => false,
            );
      });
      worktreeRemoved = true;
    }
    await host.exclusive(plan.workspace, () =>
      this.#branches.advance(repository, task.taskId, plan.branch, finalized.head, empty),
    );
    return { ...delivery, worktreeRemoved, branchRemoved };
  }

  async #publish(
    task: WorkspaceTask,
    plan: TaskNamedWorkspacePlan,
    repository: WorkspaceRepository,
    base: string,
    head: string,
    details: WorkspaceFinalizeDetails,
  ): Promise<WorkspacePullRequestOutcome> {
    const source = plan.source;
    if (source === undefined)
      return {
        status: "failed",
        message: `Workspace ${plan.workspace} records no source, so its branch cannot be pushed; the branch stays on this Worker Host`,
      };
    if (this.#pullRequests === undefined)
      return {
        status: "failed",
        message: `This Worker has no pull request publisher configured; branch ${plan.branch} stays on this Worker Host`,
      };
    try {
      return await this.#pullRequests.publish({
        task,
        plan: { ...plan, source },
        base,
        head,
        ...(details.summary === undefined ? {} : { summary: details.summary }),
        ...(details.evidence === undefined ? {} : { evidence: details.evidence }),
        ...(details.signal === undefined ? {} : { signal: details.signal }),
        push: (credential) =>
          this.#host.exclusive(plan.workspace, async () => {
            await this.#host.run(
              repository.path,
              ["push", "--quiet", "--porcelain", source, `${head}:refs/heads/${plan.branch}`],
              credential,
            );
          }),
      });
    } catch (error) {
      return {
        status: "failed",
        message: `Pull request delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Reads the selected `.mcp.json` servers from a Worker-owned snapshot of the Task's base commit,
   * never from the Task worktree: the harness may write the worktree, and a failed Attempt keeps it
   * for the retry. stdio servers also run in the snapshot, so editing `.mcp.json` or a server's
   * script in the worktree cannot change what the Worker launches. Each Attempt recreates the
   * snapshot from git objects, outside every directory the harness sandbox may write. A
   * configuration that differs from the digest the Task's first Attempt recorded is refused here,
   * before any server starts.
   */
  async #workspaceMcp(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    taskId: string,
    base: string,
  ): Promise<WorkspaceMcpResolution> {
    const snapshot = this.mcpSnapshotPath(plan.workspace, taskId);
    await rm(snapshot, { recursive: true, force: true });
    // Drops the removed snapshot's registration, like a worktree removed by hand.
    await this.#host.run(repository.path, ["worktree", "prune"]);
    await mkdir(dirname(snapshot), { recursive: true });
    await this.#host.run(repository.path, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      snapshot,
      base,
    ]);
    const resolved = await resolveWorkspaceMcpServers(
      snapshot,
      plan.mcp ?? [],
      this.#mcpVariables ?? process.env,
    );
    if (plan.mcpPin !== undefined && resolved.digest !== plan.mcpPin)
      throw new Error(
        `Workspace ${plan.workspace} MCP servers changed since this Task's first Task Attempt: the selected .mcp.json entries at base commit ${base.slice(0, 12)} no longer match the digest that Attempt recorded (${plan.mcpPin}). SuperTag started none of them. Start a new Task to use the changed configuration.`,
      );
    return resolved;
  }

  /** Removes an Attempt's MCP snapshot and its worktree registration; best effort. */
  async #removeMcpSnapshot(plan: TaskNamedWorkspacePlan, taskId: string): Promise<void> {
    const snapshot = this.mcpSnapshotPath(plan.workspace, taskId);
    if (!(await exists(snapshot))) return;
    await rm(snapshot, { recursive: true, force: true }).catch(() => undefined);
    const repository = await this.#host.repository(plan, false).catch(() => undefined);
    if (repository !== undefined)
      await this.#host
        .exclusive(plan.workspace, () => this.#host.run(repository.path, ["worktree", "prune"]))
        .catch(() => undefined);
  }

  /** Skills come from a host checkout, including files Git ignores in a local source. */
  async #skillCheckout(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    base: string,
  ): Promise<string> {
    if (!repository.managed) return repository.path;
    if (plan.source?.startsWith("file:")) {
      const source = fileURLToPath(plan.source);
      const inside = await this.#host
        .run(source, ["rev-parse", "--is-inside-work-tree"])
        .catch(() => "false");
      if (inside.trim() === "true")
        return (await this.#host.run(source, ["rev-parse", "--show-toplevel"])).trim();
    }
    // The managed clone is bare. Keep a separate primary checkout for Skills; switching its
    // tracked files leaves host-provided ignored Skills in place for later Tasks.
    const checkout = join(this.#host.root, plan.workspace, "checkout");
    if (await isDirectory(checkout)) await this.#host.run(checkout, ["checkout", "--detach", base]);
    else
      await this.#host.run(repository.path, [
        "worktree",
        "add",
        "--quiet",
        "--detach",
        checkout,
        base,
      ]);
    return checkout;
  }
}

/** The manifests a Workspace environment's `start` recorded on the checkout it returned. */
function startedMountManifests(started: ExecutionEnvironment): readonly MountManifest[] {
  const manifests = (started as { readonly mountManifests?: unknown }).mountManifests;
  return Array.isArray(manifests) ? (manifests as readonly MountManifest[]) : [];
}

function namedPlan(plan: TaskWorkspacePlan): TaskNamedWorkspacePlan | undefined {
  return plan?.status === "workspace" ? plan : undefined;
}
