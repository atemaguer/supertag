import { posix } from "node:path";
import type { TaskNamedWorkspacePlan, TaskReference } from "./index.js";
import { TagMessagingError } from "./mailbox.js";
import { MAX_MOUNT_MAX_BYTES } from "./mount-manifest.js";

/**
 * How a Worker returns a Task's committed workspace changes. `pull-request` needs a GitHub
 * `source`.
 */
export const WORKSPACE_DELIVERIES = ["patch", "branch", "pull-request"] as const;
export type WorkspaceDelivery = (typeof WORKSPACE_DELIVERIES)[number];
/** Delivery modes this release can perform. */
export const SUPPORTED_WORKSPACE_DELIVERIES: readonly WorkspaceDelivery[] = [
  "patch",
  "branch",
  "pull-request",
];
/** The surface action that pull-request delivery performs and approval rules can gate. */
export const WORKSPACE_PULL_REQUEST_ACTION = "pull-requests:create";
export const DEFAULT_WORKSPACE_DELIVERY: WorkspaceDelivery = "branch";
/** Base ref used when neither the Workspace nor the checkout names one. */
export const DEFAULT_WORKSPACE_REF = "main";
/** Most workspaces one Objective may name. */
export const MAX_OBJECTIVE_WORKSPACES = 16;

/** Operator-declared data copied beside a Task checkout. No credential value is stored here. */
export interface WorkspaceMount {
  readonly volume: string;
  readonly path: string;
  readonly access: "read-only" | "read-write";
  readonly strategy: "copy" | "mount";
  readonly maxBytes?: number;
}

/** GitHub repository Skills selected for every Task in a Workspace. */
export interface WorkspaceSkillCatalog {
  readonly repository: string;
  readonly path: string;
  readonly revision: string;
  readonly skills: readonly string[];
}

/** Desired Workspace fields. Every field is optional; absent fields take their defaults. */
export interface WorkspaceSpec {
  /**
   * Git remote. Hosts with a declared checkout use it; other hosts that can clone keep a
   * host-managed clone of this source.
   */
  readonly source?: string;
  /** Base for Task branches. Absent: the checkout's current branch, else `main`. */
  readonly ref?: string;
  /** One shell command run once in each new Task worktree. */
  readonly setup?: string;
  /** Server names explicitly allowed from the checkout's .mcp.json. */
  readonly mcp?: readonly string[];
  /** Skill names explicitly selected from the host checkout. */
  readonly skills?: readonly string[];
  readonly skillCatalog?: WorkspaceSkillCatalog;
  readonly mounts?: readonly WorkspaceMount[];
  readonly delivery: WorkspaceDelivery;
}

/** A named repository that Objectives may work in. Checkouts stay on Worker Hosts. */
export interface Workspace extends WorkspaceSpec {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApplyWorkspaceInput extends WorkspaceSpec {
  readonly name: string;
}

export interface WorkspaceStore {
  /** Creates or replaces the named Workspace; absent optional fields are cleared. */
  applyWorkspace(
    input: ApplyWorkspaceInput,
  ): Promise<{ readonly workspace: Workspace; readonly created: boolean }>;
  findWorkspaceByName(name: string): Promise<Workspace | undefined>;
  listWorkspaces(): Promise<readonly Workspace[]>;
  /**
   * Deletes the named Workspace's configuration. Objectives keep the names they recorded, and
   * Tasks keep their recorded workspace. Returns false when no such Workspace exists.
   */
  deleteWorkspace(name: string): Promise<boolean>;
  /** Records, or replaces, the one pending pull-request transition of a Task. */
  saveWorkspacePullRequestTransition(
    transition: Omit<WorkspacePullRequestTransition, "createdAt" | "updatedAt">,
  ): Promise<void>;
  /** Pending transitions due at `now`, earliest first. */
  listDueWorkspacePullRequestTransitions(
    now: string,
    limit?: number,
  ): Promise<readonly WorkspacePullRequestTransition[]>;
  deleteWorkspacePullRequestTransition(taskId: string): Promise<void>;
}

/**
 * A Workspace pull-request transition that failed for a reason that may clear with time, such
 * as a network error, a GitHub 5xx, or a rate limit. The Control Plane retries it with backoff.
 */
export interface WorkspacePullRequestTransition {
  readonly taskId: string;
  readonly url: string;
  /** `ready` marks the draft ready for review; `close` comments and closes it. */
  readonly action: "ready" | "close";
  /** Failed provider calls so far. */
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

/** Workspace names appear in flags, paths, and branch names, so they stay small and plain. */
export function parseWorkspaceName(value: unknown, field = "Workspace name"): string {
  if (typeof value !== "string" || !NAME.test(value))
    throw new TagMessagingError(
      400,
      `${field} must be 1-63 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit`,
    );
  return value;
}

/** Validates a distinct list of Workspace names, such as an Objective's workspaces. */
export function parseWorkspaceNames(value: unknown, field = "workspaces"): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_OBJECTIVE_WORKSPACES)
    throw new TagMessagingError(
      400,
      `${field} must be an array of at most ${MAX_OBJECTIVE_WORKSPACES} Workspace names`,
    );
  const names = value.map((item) => parseWorkspaceName(item, `${field} entry`));
  if (new Set(names).size !== names.length)
    throw new TagMessagingError(400, `${field} must not contain duplicates`);
  return names;
}

/** Validates Workspace fields and fills the delivery and mount defaults. */
export function parseWorkspaceSpec(value: unknown): WorkspaceSpec {
  if (value === undefined || value === null) return { delivery: DEFAULT_WORKSPACE_DELIVERY };
  if (typeof value !== "object" || Array.isArray(value))
    throw new TagMessagingError(400, "Workspace spec must be an object");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) =>
      !["source", "ref", "setup", "delivery", "mcp", "skills", "skillCatalog", "mounts"].includes(
        key,
      ),
  );
  if (unknown.length > 0)
    throw new TagMessagingError(
      400,
      `Workspace spec contains unknown fields: ${unknown.join(", ")}`,
    );
  const delivery = record["delivery"] ?? DEFAULT_WORKSPACE_DELIVERY;
  if (!WORKSPACE_DELIVERIES.includes(delivery as WorkspaceDelivery))
    throw new TagMessagingError(
      400,
      "Workspace spec.delivery must be patch, branch, or pull-request",
    );
  if (!SUPPORTED_WORKSPACE_DELIVERIES.includes(delivery as WorkspaceDelivery))
    throw new TagMessagingError(
      400,
      `Workspace spec.delivery ${String(delivery)} is not yet supported; use patch or branch`,
    );
  const source = optional(record["source"], "source", 2048);
  if (source !== undefined) assertGitSource(source);
  const mounts = parseWorkspaceMounts(record["mounts"]);
  if (mounts.length > 0 && source === undefined)
    throw new TagMessagingError(
      400,
      "Workspace spec.mounts require spec.source naming a git repository",
    );
  if (delivery === "pull-request") {
    if (source === undefined)
      throw new TagMessagingError(
        400,
        "Workspace spec.delivery pull-request needs spec.source naming a GitHub repository",
      );
    if (githubRepositoryFromSource(source) === undefined)
      throw new TagMessagingError(
        400,
        `Workspace spec.delivery pull-request supports only GitHub sources such as https://github.com/OWNER/REPO or git@github.com:OWNER/REPO; ${source} is not one. Use branch or patch delivery for other remotes.`,
      );
  }
  const ref = optional(record["ref"], "ref", 200);
  if (ref !== undefined && !isValidGitRef(ref))
    throw new TagMessagingError(
      400,
      "Workspace spec.ref must be a valid git branch, tag, or commit",
    );
  const setup = optional(record["setup"], "setup", 4000);
  if (setup !== undefined && /[\r\n]/u.test(setup))
    throw new TagMessagingError(400, "Workspace spec.setup must be one shell command on one line");
  const mcp = record["mcp"];
  if (
    mcp !== undefined &&
    (!Array.isArray(mcp) ||
      mcp.length > 64 ||
      !mcp.every(
        (name) => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u.test(name),
      ) ||
      new Set(mcp).size !== mcp.length)
  )
    throw new TagMessagingError(
      400,
      "Workspace spec.mcp must be an array of distinct server names",
    );
  const skills = record["skills"];
  if (
    skills !== undefined &&
    (!Array.isArray(skills) ||
      skills.length > 64 ||
      !skills.every(
        (name) => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u.test(name),
      ) ||
      new Set(skills).size !== skills.length)
  )
    throw new TagMessagingError(
      400,
      "Workspace spec.skills must be an array of distinct Skill names",
    );
  const skillCatalog = parseWorkspaceSkillCatalog(record["skillCatalog"]);
  if (skillCatalog && skills?.some((name: string) => skillCatalog.skills.includes(name)))
    throw new TagMessagingError(
      400,
      "Workspace Skill names must be distinct across spec.skills and spec.skillCatalog.skills",
    );
  return {
    ...(source === undefined ? {} : { source }),
    ...(ref === undefined ? {} : { ref }),
    ...(setup === undefined ? {} : { setup }),
    ...(mcp === undefined ? {} : { mcp: mcp as string[] }),
    ...(skills === undefined ? {} : { skills: skills as string[] }),
    ...(skillCatalog === undefined ? {} : { skillCatalog }),
    ...(record["mounts"] === undefined ? {} : { mounts }),
    delivery: delivery as WorkspaceDelivery,
  };
}

function parseWorkspaceSkillCatalog(value: unknown): WorkspaceSkillCatalog | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TagMessagingError(400, "Workspace spec.skillCatalog must be an object");
  const catalog = value as Record<string, unknown>;
  if (
    Object.keys(catalog).some((key) => !["repository", "path", "revision", "skills"].includes(key))
  )
    throw new TagMessagingError(400, "Workspace spec.skillCatalog has unknown fields");
  const { repository, path, revision, skills } = catalog;
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    repository.includes("..")
  )
    throw new TagMessagingError(
      400,
      "Workspace spec.skillCatalog.repository must be GitHub OWNER/REPO",
    );
  if (
    typeof path !== "string" ||
    path.length > 512 ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(path) ||
    path.split("/").includes("..")
  )
    throw new TagMessagingError(
      400,
      "Workspace spec.skillCatalog.path must be a relative directory path",
    );
  if (typeof revision !== "string" || !isValidGitRef(revision))
    throw new TagMessagingError(
      400,
      "Workspace spec.skillCatalog.revision must be a valid branch, tag, or commit",
    );
  if (
    !Array.isArray(skills) ||
    skills.length === 0 ||
    skills.length > 64 ||
    !skills.every(
      (name) => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u.test(name),
    ) ||
    new Set(skills).size !== skills.length
  )
    throw new TagMessagingError(
      400,
      "Workspace spec.skillCatalog.skills must be an array of distinct Skill names",
    );
  return { repository, path, revision, skills: skills as string[] };
}

/** Keeps every mount separate from the checkout, staged paths, and other mounts. */
export function assertWorkspaceMountPaths(
  mounts: readonly WorkspaceMount[],
  checkout: string,
  stagedFiles: readonly string[],
): void {
  for (const [index, mount] of mounts.entries()) {
    if (pathsOverlap(mount.path, checkout))
      throw new TagMessagingError(
        400,
        `Workspace mount ${mount.volume} path ${mount.path} overlaps the checkout ${checkout}`,
      );
    const staged = stagedFiles.find((file) => pathsOverlap(mount.path, file));
    if (staged !== undefined)
      throw new TagMessagingError(
        400,
        `Workspace mount ${mount.volume} path ${mount.path} overlaps a staged file ${staged}`,
      );
    const other = mounts.slice(index + 1).find((entry) => pathsOverlap(mount.path, entry.path));
    if (other !== undefined)
      throw new TagMessagingError(
        400,
        `Workspace mount ${mount.volume} path ${mount.path} overlaps another mount ${other.volume} path ${other.path}`,
      );
  }
}

export function parseWorkspaceMounts(value: unknown): readonly WorkspaceMount[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64)
    throw new TagMessagingError(400, "Workspace spec.mounts must be an array of at most 64 mounts");
  const mounts: WorkspaceMount[] = [];
  for (const [index, item] of value.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new TagMessagingError(400, `Workspace spec.mounts[${index}] must be an object`);
    const mount = item as Record<string, unknown>;
    const unknown = Object.keys(mount).filter(
      (key) => !["volume", "path", "access", "strategy", "maxBytes"].includes(key),
    );
    if (unknown.length)
      throw new TagMessagingError(
        400,
        `Workspace spec.mounts[${index}] contains unknown fields: ${unknown.join(", ")}`,
      );
    const volume = parseWorkspaceName(mount["volume"], `Workspace spec.mounts[${index}].volume`);
    const path = mount["path"];
    if (
      typeof path !== "string" ||
      !posix.isAbsolute(path) ||
      path.includes("\\") ||
      /[\p{Cc}\p{Cf}]/u.test(path) ||
      path.length > 4096
    )
      throw new TagMessagingError(
        400,
        `Workspace spec.mounts[${index}].path must be an absolute POSIX path`,
      );
    if (path === "/")
      throw new TagMessagingError(
        400,
        `Workspace spec.mounts[${index}].path cannot be the filesystem root`,
      );
    if (path.endsWith("/"))
      throw new TagMessagingError(400, `Workspace spec.mounts[${index}].path cannot end in /`);
    if (posix.normalize(path) !== path || path.split("/").includes(".."))
      throw new TagMessagingError(
        400,
        `Workspace spec.mounts[${index}].path must be normalized without .. segments`,
      );
    if (isSensitiveWorkspaceMountPath(path))
      throw new TagMessagingError(
        400,
        `Workspace spec.mounts[${index}].path overlaps a sensitive system location`,
      );
    const access = mount["access"] ?? "read-only";
    if (access !== "read-only" && access !== "read-write")
      throw new TagMessagingError(
        400,
        `Workspace spec.mounts[${index}].access must be read-only or read-write`,
      );
    const strategy = mount["strategy"] ?? "copy";
    if (strategy !== "copy" && strategy !== "mount")
      throw new TagMessagingError(400, `Workspace mount ${volume}: strategy must be copy or mount`);
    const maxBytes = mount["maxBytes"];
    if (
      maxBytes !== undefined &&
      (!Number.isSafeInteger(maxBytes) ||
        (maxBytes as number) <= 0 ||
        (maxBytes as number) > MAX_MOUNT_MAX_BYTES)
    )
      throw new TagMessagingError(
        400,
        `Workspace spec.mounts[${index}].maxBytes must be a positive integer at most 20 GiB`,
      );
    const other = mounts.find((existing) => pathsOverlap(existing.path, path));
    if (other !== undefined)
      throw new TagMessagingError(
        400,
        `Workspace mount ${volume} path ${path} overlaps another mount ${other.volume} path ${other.path}`,
      );
    mounts.push({
      volume,
      path,
      access,
      strategy,
      ...(maxBytes === undefined ? {} : { maxBytes: maxBytes as number }),
    });
  }
  return mounts;
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = posix.normalize(left).replace(/\/+$/u, "") || "/";
  const b = posix.normalize(right).replace(/\/+$/u, "") || "/";
  return a === "/" || b === "/" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Fixed host and sandbox locations that a copied Volume must never replace. */
export function isSensitiveWorkspaceMountPath(path: string): boolean {
  const normalized = posix.normalize(path).toLowerCase();
  const home = /^(?:\/home\/[^/]+|\/users\/[^/]+|\/root|\/var\/root)(?=\/|$)/u.exec(
    normalized,
  )?.[0];
  const homeTail = home === undefined ? "" : normalized.slice(home.length);
  return (
    normalized.startsWith("/lib") ||
    normalized === "/home" ||
    (home !== undefined &&
      (normalized === home ||
        /^\/\.[^/]+(?:\/|$)/u.test(homeTail) ||
        /^\/library(?:\/|$)/u.test(homeTail))) ||
    [
      "/proc",
      "/sys",
      "/dev",
      "/etc",
      "/usr",
      "/bin",
      "/sbin",
      "/boot",
      "/run",
      "/root/.ssh",
      "/root/.supertag",
      "/root/.codex",
      "/root/.claude",
      "/private/etc",
      "/private/var/run",
      "/private/var/db",
      "/private/var/log",
      "/system",
      "/library",
      "/applications",
    ].some((sensitive) => pathsOverlap(normalized, sensitive))
  );
}

function optional(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max || /\0/u.test(value))
    throw new TagMessagingError(
      400,
      `Workspace spec.${field} must be text of at most ${max} characters`,
    );
  return value.trim();
}

/** Accepts common git remote forms; rejects embedded credentials and shell-significant text. */
function assertGitSource(source: string): void {
  if (/[\s\p{Cc}]/u.test(source) || source.startsWith("-"))
    throw new TagMessagingError(400, "Workspace spec.source must be a git URL");
  const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/].*$/u;
  if (scp.test(source)) return;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new TagMessagingError(400, "Workspace spec.source must be a git URL");
  }
  if (!["https:", "http:", "ssh:", "git:", "file:"].includes(url.protocol))
    throw new TagMessagingError(
      400,
      "Workspace spec.source must use https, http, ssh, git, or file, or the user@host:path form",
    );
  if (url.password || ((url.protocol === "https:" || url.protocol === "http:") && url.username))
    throw new TagMessagingError(
      400,
      "Workspace spec.source must not embed credentials; Worker Hosts supply their own",
    );
}

interface WorkspaceBranchEvent {
  readonly type: string;
  readonly attemptId?: string;
  readonly payload?: unknown;
}

/** A resolved branch from the Worker's Workspace manifest. */
function resolvedWorkspaceBranch(
  event: WorkspaceBranchEvent,
  workspace: string,
): string | undefined {
  if (event.type !== "runtime-inputs.resolved" || !isRecord(event.payload)) return undefined;
  const manifest = event.payload["manifest"];
  if (!isRecord(manifest) || !Array.isArray(manifest["inputs"])) return undefined;
  for (const entry of manifest["inputs"]) {
    if (!isRecord(entry) || entry["kind"] !== "workspace" || !isRecord(entry["resource"])) continue;
    const provenance = entry["resource"]["provenance"];
    if (
      !isRecord(provenance) ||
      provenance["provider"] !== "supertag-workspace" ||
      provenance["workspace"] !== workspace
    )
      continue;
    const branch = provenance["branch"];
    if (typeof branch === "string" && branch.startsWith("supertag/") && isValidGitRef(branch))
      return branch;
  }
  return undefined;
}

/** The branch a Worker most recently resolved for this Task. */
export function workspaceBranchPin(
  events: readonly WorkspaceBranchEvent[],
  workspace: string,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const branch = event === undefined ? undefined : resolvedWorkspaceBranch(event, workspace);
    if (branch !== undefined) return branch;
  }
  return undefined;
}

/** The last Worker-recorded full commit for the Task's pinned Workspace branch. */
export function workspaceBranchHeadPin(
  events: readonly WorkspaceBranchEvent[],
  workspace: string,
): string | undefined {
  const pin = workspaceBranchPin(events, workspace);
  if (pin === undefined) return undefined;
  const branches = new Map<string | undefined, string>();
  let head: string | undefined;
  for (const event of events) {
    const branch = resolvedWorkspaceBranch(event, workspace);
    if (branch !== undefined) branches.set(event.attemptId, branch);
    if (event.type !== "progress.updated" || branches.get(event.attemptId) !== pin) continue;
    const evidence = workspaceDeliveryEvidence(event.payload);
    if (
      evidence?.branch === pin &&
      evidence.head !== evidence.base &&
      /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(evidence.head)
    )
      head = evidence.head;
  }
  return head;
}

/** A GitHub repository named by a Workspace source. */
export interface GitHubSourceRepository {
  readonly owner: string;
  readonly name: string;
  /** `owner/name`, as Permission Set references name repositories. */
  readonly fullName: string;
  /** True for https sources, which Workers authenticate with a surface credential. */
  readonly https: boolean;
}

const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/u;

/**
 * Recognizes github.com sources: `https://github.com/OWNER/REPO[.git]`,
 * `git@github.com:OWNER/REPO[.git]`, and `ssh://git@github.com/OWNER/REPO[.git]`.
 */
export function githubRepositoryFromSource(source: string): GitHubSourceRepository | undefined {
  let path: string;
  let https = false;
  const scp = /^git@github\.com:([^/]+\/[^/]+)$/iu.exec(source);
  if (scp?.[1] !== undefined) path = scp[1];
  else {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return undefined;
    }
    if (url.hostname.toLowerCase() !== "github.com" || url.search || url.hash) return undefined;
    if (url.protocol === "https:") https = true;
    else if (url.protocol !== "ssh:") return undefined;
    if (url.port) return undefined;
    path = url.pathname.replace(/^\/+/u, "").replace(/\/+$/u, "");
  }
  const [owner, rawName, ...rest] = path.split("/");
  const name = rawName?.replace(/\.git$/iu, "");
  if (rest.length > 0 || owner === undefined || name === undefined) return undefined;
  if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(name) || name === "." || name === "..")
    return undefined;
  return { owner, name, fullName: `${owner}/${name}`, https };
}

/**
 * Workspaces whose `source` names the GitHub repository `owner/name`. Https, ssh, and scp-style
 * sources match with or without `.git`; owner and name compare case-insensitively, as on GitHub.
 */
export function workspacesForGitHubRepository(
  workspaces: readonly { readonly name: string; readonly source?: string | null }[],
  repository: string,
): readonly string[] {
  const wanted = repository
    .trim()
    .replace(/\.git$/iu, "")
    .toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(wanted)) return [];
  return workspaces
    .filter((workspace) => {
      if (!workspace.source) return false;
      const found = githubRepositoryFromSource(workspace.source);
      return found !== undefined && found.fullName.toLowerCase() === wanted;
    })
    .map((workspace) => workspace.name)
    .slice(0, MAX_OBJECTIVE_WORKSPACES);
}

/**
 * The Workspaces a new Objective gets when its creator may use only `allowed`, such as its
 * location's Workspaces. Omitted `requested` takes all of them; a request may name only a subset.
 */
export function narrowObjectiveWorkspaces(
  allowed: readonly string[],
  requested: readonly string[] | undefined,
  from: string,
): readonly string[] {
  if (requested === undefined) return allowed;
  const outside = requested.filter((name) => !allowed.includes(name));
  if (outside.length > 0)
    throw new TagMessagingError(
      400,
      allowed.length === 0
        ? `${from} attaches no Workspaces, so this Objective cannot name ${outside.join(", ")}`
        : `${from} attaches only Workspaces ${allowed.join(", ")}; ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not among them`,
    );
  return requested;
}

/** Conservative subset of `git check-ref-format` rules, applied without invoking git. */
export function isValidGitRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 200 &&
    !/[\s\p{Cc}~^:?*[\\]/u.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.includes("//") &&
    ref !== "@" &&
    !ref.startsWith("-") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".") &&
    !ref.endsWith(".lock") &&
    !ref.split("/").some((part) => part.startsWith("."))
  );
}

/**
 * One git ref component derived from an identifier. Unsafe characters become hyphens; when that
 * changes the value, a short hash of the original keeps distinct identifiers distinct.
 */
export function gitRefComponent(value: string): string {
  let safe = value
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .replace(/\.{2,}/gu, ".")
    .replace(/^[.-]+/u, "")
    .replace(/[.]+$/u, "");
  if (safe.endsWith(".lock")) safe = safe.slice(0, -".lock".length);
  if (safe === value && safe.length > 0) return safe;
  return `${safe.slice(0, 80) || "id"}-${fnv1a(value)}`;
}

/** A Task's plan for `workspace` with branch candidate `branch`, captured at admission. */
export function namedWorkspacePlan(workspace: Workspace, branch: string): TaskNamedWorkspacePlan {
  return {
    version: 1,
    status: "workspace",
    workspace: workspace.name,
    ...(workspace.source === undefined ? {} : { source: workspace.source }),
    ...(workspace.ref === undefined ? {} : { ref: workspace.ref }),
    branch,
    delivery: workspace.delivery,
    ...(workspace.setup === undefined ? {} : { setup: workspace.setup }),
    ...(workspace.mcp === undefined ? {} : { mcp: workspace.mcp }),
    ...(workspace.skills === undefined ? {} : { skills: workspace.skills }),
    ...(workspace.skillCatalog === undefined ? {} : { skillCatalog: workspace.skillCatalog }),
    ...(workspace.mounts === undefined ? {} : { mounts: workspace.mounts }),
  };
}

/**
 * Workspace names a Worker Host advertised with its descriptor. Checkout paths never leave the
 * host; only names reach the Control Plane.
 */
export function advertisedWorkspaces(
  descriptor: Readonly<Record<string, unknown>>,
): readonly string[] {
  const value = descriptor["workspaces"];
  if (!Array.isArray(value)) return [];
  return value.filter((name): name is string => typeof name === "string" && NAME.test(name));
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Advertised by a Worker profile that can keep a host-managed clone of a Workspace `source`
 * when its host declares no checkout. Implies in-place workspace support.
 */
export const WORKSPACE_CLONE_CAPABILITY_ID = "supertag.workspace.clone";
/** A profile can start a Workspace from a provider-native prepared environment. */
export const WORKSPACE_ENVIRONMENT_CAPABILITY_ID = "supertag.workspace.environment";

/**
 * True when every Worker a host descriptor advertises can clone Workspace sources. A Task placed
 * on the host may land on any profile, so one profile without the capability disqualifies it.
 */
export function advertisesWorkspaceClone(descriptor: Readonly<Record<string, unknown>>): boolean {
  return advertisesWorkspaceCapability(descriptor, WORKSPACE_CLONE_CAPABILITY_ID);
}

/** True when any Worker profile on a host supports prepared Workspace environments. */
export function advertisesWorkspaceEnvironment(
  descriptor: Readonly<Record<string, unknown>>,
): boolean {
  const workers = descriptor["workers"];
  if (!Array.isArray(workers)) return false;
  return workers.some((worker) => {
    if (!isRecord(worker)) return false;
    const profiles = worker["profileCapabilities"];
    return Array.isArray(profiles)
      ? profiles.some(
          (profile) =>
            isRecord(profile) &&
            hasWorkspaceCapability(profile["capabilities"], WORKSPACE_ENVIRONMENT_CAPABILITY_ID),
        )
      : hasWorkspaceCapability(worker["capabilities"], WORKSPACE_ENVIRONMENT_CAPABILITY_ID);
  });
}

/** Provider refusal reasons reported by a host's Worker profiles. */
export function workspaceEnvironmentRefusals(
  descriptor: Readonly<Record<string, unknown>>,
): readonly string[] {
  const workers = descriptor["workers"];
  if (!Array.isArray(workers)) return [];
  const reasons = new Set<string>();
  for (const worker of workers) {
    if (!isRecord(worker) || !Array.isArray(worker["profileCapabilities"])) continue;
    for (const profile of worker["profileCapabilities"])
      if (isRecord(profile) && typeof profile["workspaceRefusal"] === "string")
        reasons.add(profile["workspaceRefusal"]);
  }
  return [...reasons];
}

function hasWorkspaceCapability(capabilities: unknown, capabilityId: string): boolean {
  return (
    Array.isArray(capabilities) &&
    capabilities.some(
      (capability) =>
        isRecord(capability) && capability["id"] === capabilityId && capability["version"] === 1,
    )
  );
}

function advertisesWorkspaceCapability(
  descriptor: Readonly<Record<string, unknown>>,
  capabilityId: string,
): boolean {
  const workers = descriptor["workers"];
  if (!Array.isArray(workers) || workers.length === 0) return false;
  const has = (capabilities: unknown) => hasWorkspaceCapability(capabilities, capabilityId);
  return workers.every((worker) => {
    if (!isRecord(worker)) return false;
    const entries = worker["profileCapabilities"];
    if (!Array.isArray(entries)) return has(worker["capabilities"]);
    const profiles = Array.isArray(worker["profiles"]) ? worker["profiles"] : [];
    return (
      profiles.length > 0 &&
      profiles.every(
        (profile) =>
          isRecord(profile) &&
          entries.some(
            (entry) =>
              isRecord(entry) &&
              isRecord(entry["profile"]) &&
              entry["profile"]["id"] === profile["id"] &&
              entry["profile"]["revision"] === profile["revision"] &&
              has(entry["capabilities"]),
          ),
      )
    );
  });
}

/** The pull request a Worker opened for a Task, as recorded on its Task Attempt result. */
export interface WorkspacePullRequest {
  readonly surfaceAccountId?: string;
  /** `owner/name`. */
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

/** Lifecycle Task events the Control Plane records after acting on a Task's pull request. */
export const WORKSPACE_PULL_REQUEST_EVENTS = {
  ready: "workspace.pull-request.ready",
  closed: "workspace.pull-request.closed",
  failed: "workspace.pull-request.failed",
} as const;

/** The Task result reference that records a Workspace pull request. */
export function workspacePullRequestReference(pullRequest: WorkspacePullRequest): TaskReference {
  return {
    provider: "github",
    ...(pullRequest.surfaceAccountId === undefined
      ? {}
      : { surfaceAccountId: pullRequest.surfaceAccountId }),
    resourceType: "pull-request",
    resourceId: `${pullRequest.repository}#${pullRequest.number}`,
    reference: pullRequest.url,
    relationship: "produced",
  };
}

/** Reads a Workspace pull request back from a Task result reference. */
export function workspacePullRequestFromReference(
  value: unknown,
): WorkspacePullRequest | undefined {
  if (
    !isRecord(value) ||
    value["provider"] !== "github" ||
    value["resourceType"] !== "pull-request" ||
    value["relationship"] !== "produced" ||
    typeof value["resourceId"] !== "string" ||
    typeof value["reference"] !== "string"
  )
    return undefined;
  const match = /^([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,9})$/u.exec(
    value["resourceId"],
  );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value["reference"]);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const surfaceAccountId = value["surfaceAccountId"];
  return {
    ...(typeof surfaceAccountId === "string" && surfaceAccountId ? { surfaceAccountId } : {}),
    repository: match[1],
    number: Number(match[2]),
    url: url.href,
  };
}

export type WorkspacePullRequestState = "draft" | "ready" | "closed";

/**
 * The latest Workspace pull request recorded in a Task's events, and its lifecycle state:
 * `draft` once a Worker opened it, then `ready` or `closed` after the Control Plane acted.
 */
export function workspacePullRequestFromEvents(
  events: readonly { readonly type: string; readonly payload?: unknown }[],
):
  | (WorkspacePullRequest & {
      readonly state: WorkspacePullRequestState;
      readonly lastError?: string;
      /** When the Control Plane next retries a failed transition; absent when it will not. */
      readonly nextAttemptAt?: string;
    })
  | undefined {
  let found: WorkspacePullRequest | undefined;
  let state: WorkspacePullRequestState = "draft";
  let lastError: string | undefined;
  let nextAttemptAt: string | undefined;
  for (const event of events) {
    const payload = isRecord(event.payload) ? event.payload : {};
    if (event.type === "result" && isRecord(payload["result"])) {
      const references = payload["result"]["references"];
      for (const reference of Array.isArray(references) ? references : []) {
        const pullRequest = workspacePullRequestFromReference(reference);
        if (pullRequest === undefined) continue;
        if (found?.url !== pullRequest.url) state = "draft";
        found = pullRequest;
      }
    } else if (found !== undefined && payload["url"] === found.url) {
      if (event.type === WORKSPACE_PULL_REQUEST_EVENTS.ready) {
        state = "ready";
        lastError = undefined;
        nextAttemptAt = undefined;
      } else if (event.type === WORKSPACE_PULL_REQUEST_EVENTS.closed) {
        state = "closed";
        lastError = undefined;
        nextAttemptAt = undefined;
      } else if (event.type === WORKSPACE_PULL_REQUEST_EVENTS.failed) {
        lastError = typeof payload["error"] === "string" ? payload["error"] : "failed";
        nextAttemptAt =
          typeof payload["nextAttemptAt"] === "string" ? payload["nextAttemptAt"] : undefined;
      }
    }
  }
  if (found === undefined) return undefined;
  return {
    ...found,
    state,
    ...(lastError === undefined ? {} : { lastError }),
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
  };
}

/** What one Task delivered, read back from its recorded result and lifecycle events. */
export interface TaskDelivery {
  /** The Task's Workspace delivery; absent for Tasks without a named Workspace. */
  readonly workspace?: {
    readonly name: string;
    readonly delivery: WorkspaceDelivery;
    readonly branch: string;
    /** Base the Task branch started from, when the Workspace records one. */
    readonly ref?: string;
    /** Branch head the Worker recorded with its result. */
    readonly head?: string;
    /** Files changed on the branch since its base, as the Worker reported them. */
    readonly changedFiles?: number;
    /** Commit the Task branch started from, as the Worker reported it. */
    readonly base?: string;
  };
  /** Patch artifacts from `patch` delivery. */
  readonly patches: readonly { readonly artifactId: string; readonly path: string }[];
  readonly pullRequest?: WorkspacePullRequest & {
    readonly state: WorkspacePullRequestState;
    readonly lastError?: string;
    readonly nextAttemptAt?: string;
  };
  /** Other files the Task captured as output artifacts. */
  readonly outputs: readonly { readonly artifactId: string; readonly paths: readonly string[] }[];
}

/**
 * `progress.updated` item ids a Worker reserves for its Workspace delivery record. A Worker drops
 * them from harness progress, so only the Worker's own commit and delivery step can report them.
 */
export const WORKSPACE_DELIVERY_PROGRESS_IDS: ReadonlySet<string> = new Set([
  "workspace-branch",
  "workspace-base",
  "workspace-head",
  "workspace-changed-files",
]);

/** A Worker's record of the commits on a Task branch after one Task Attempt. */
export interface WorkspaceDeliveryEvidence {
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly changedFiles: number;
}

/**
 * Reads the Worker's Workspace delivery record from one stored `progress.updated` event payload.
 * A record whose branch the Worker deleted names no branch and yields undefined.
 */
export function workspaceDeliveryEvidence(payload: unknown): WorkspaceDeliveryEvidence | undefined {
  const progress = isRecord(payload) ? payload["progress"] : undefined;
  const items = isRecord(progress) && Array.isArray(progress["items"]) ? progress["items"] : [];
  const text = (id: string) => {
    const item = items.find((entry) => isRecord(entry) && entry["id"] === id);
    return isRecord(item) && typeof item["text"] === "string" ? item["text"] : undefined;
  };
  const branch = /^Branch: (.+)$/u.exec(text("workspace-branch") ?? "")?.[1];
  const base = /^Base: ([0-9a-f]{7,64})$/u.exec(text("workspace-base") ?? "")?.[1];
  const head = /^Head: ([0-9a-f]{7,64})$/u.exec(text("workspace-head") ?? "")?.[1];
  const files = /^Changed files: (\d+)$/u.exec(text("workspace-changed-files") ?? "")?.[1];
  if (branch === undefined || base === undefined || head === undefined) return undefined;
  return { branch, base, head, changedFiles: files === undefined ? 0 : Number(files) };
}

/** The patch file name a Worker gives `patch` delivery of a Task branch. */
export function workspacePatchName(branch: string): string {
  return `${branch.replaceAll("/", "-")}.patch`;
}

/**
 * Reads a Task's delivery from stored records: its Workspace plan, the latest recorded result,
 * and pull-request lifecycle events. Returns undefined until a result records something to
 * deliver: a Workspace branch, a patch, a pull request, or output artifacts.
 */
export function taskDelivery(input: {
  readonly workspacePlan?: {
    readonly status: string;
    readonly workspace?: string;
    readonly branch?: string;
    readonly ref?: string;
    readonly delivery?: WorkspaceDelivery;
  };
  /** The recorded TaskResult, when the caller has one outside the events. */
  readonly result?: unknown;
  readonly events: readonly { readonly type: string; readonly payload?: unknown }[];
}): TaskDelivery | undefined {
  const recorded = input.events.findLast(
    (event) =>
      event.type === "result" && isRecord(event.payload) && isRecord(event.payload["result"]),
  );
  const result =
    recorded !== undefined && isRecord(recorded.payload) && isRecord(recorded.payload["result"])
      ? recorded.payload["result"]
      : isRecord(input.result)
        ? input.result
        : undefined;
  if (result === undefined) return undefined;
  const plan = input.workspacePlan;
  const named =
    plan?.status === "workspace" &&
    typeof plan.workspace === "string" &&
    typeof plan.branch === "string" &&
    plan.delivery !== undefined
      ? {
          name: plan.workspace,
          branch: workspaceBranchPin(input.events, plan.workspace) ?? plan.branch,
          delivery: plan.delivery,
          ref: plan.ref,
        }
      : undefined;
  let head: string | undefined;
  let changedFiles: number | undefined;
  for (const change of Array.isArray(result["changes"]) ? result["changes"] : []) {
    if (!isRecord(change) || typeof change["reference"] !== "string" || named === undefined)
      continue;
    const match = /^git:(.+)@([0-9a-f]{7,64})$/u.exec(change["reference"]);
    if (match?.[1] !== named.branch || match[2] === undefined) continue;
    head = match[2];
    const files =
      typeof change["summary"] === "string"
        ? /(\d+) changed files?/u.exec(change["summary"])?.[1]
        : undefined;
    changedFiles = files === undefined ? undefined : Number(files);
  }
  // Delivery progress records the base commit beside the branch.
  let base: string | undefined;
  for (const event of input.events) {
    const progress = isRecord(event.payload) ? event.payload["progress"] : undefined;
    const items = isRecord(progress) && Array.isArray(progress["items"]) ? progress["items"] : [];
    const text = (id: string) => {
      const item = items.find((entry) => isRecord(entry) && entry["id"] === id);
      return isRecord(item) && typeof item["text"] === "string" ? item["text"] : undefined;
    };
    if (named !== undefined && text("workspace-branch") === `Branch: ${named.branch}`) {
      const commit = /^Base: ([0-9a-f]{7,64})$/u.exec(text("workspace-base") ?? "")?.[1];
      if (commit !== undefined) base = commit;
    }
  }
  const patchName = named === undefined ? undefined : workspacePatchName(named.branch);
  const patches: { artifactId: string; path: string }[] = [];
  const outputs: { artifactId: string; paths: string[] }[] = [];
  for (const selection of Array.isArray(result["artifacts"]) ? result["artifacts"] : []) {
    if (!isRecord(selection) || typeof selection["artifactId"] !== "string") continue;
    const artifactId = selection["artifactId"];
    const other: string[] = [];
    for (const path of Array.isArray(selection["paths"]) ? selection["paths"] : []) {
      if (typeof path !== "string") continue;
      if (path === patchName) patches.push({ artifactId, path });
      else other.push(path);
    }
    if (other.length > 0) outputs.push({ artifactId, paths: other });
  }
  const pullRequest = workspacePullRequestFromEvents(input.events);
  if (named === undefined && patches.length === 0 && !pullRequest && outputs.length === 0)
    return undefined;
  return {
    ...(named === undefined
      ? {}
      : {
          workspace: {
            name: named.name,
            delivery: named.delivery,
            branch: named.branch,
            ...(named.ref === undefined ? {} : { ref: named.ref }),
            ...(head === undefined ? {} : { head }),
            ...(changedFiles === undefined ? {} : { changedFiles }),
            ...(base === undefined ? {} : { base }),
          },
        }),
    patches,
    ...(pullRequest === undefined ? {} : { pullRequest }),
    outputs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
