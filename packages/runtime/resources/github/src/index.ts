import { createWriteStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  assertTagActionAllowed,
  type ResolutionContext,
  type WorkspaceResolution,
  type WorkspaceResolver,
} from "@supertag/worker-sdk";
import { extract } from "tar";

export {
  GitHubPullRequestPublisher,
  type GitHubPullRequestPublisherOptions,
  GitHubWorkspaceSourceCredentials,
  pullRequestBody,
  pullRequestTitle,
} from "./pull-requests.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";

export interface GitHubWorkerCredential {
  readonly token: string;
  readonly apiBaseUrl?: string;
}

export interface GitHubWorkerCredentialProvider {
  resolve(surfaceAccountId: string): Promise<GitHubWorkerCredential>;
}

export interface EnvironmentGitHubCredentialProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Resolves a Worker-local GitHub credential without involving the Gateway secret store. */
export class EnvironmentGitHubCredentialProvider implements GitHubWorkerCredentialProvider {
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(options: EnvironmentGitHubCredentialProviderOptions = {}) {
    this.#environment = options.environment ?? process.env;
  }

  async resolve(surfaceAccountId: string): Promise<GitHubWorkerCredential> {
    const expectedAccount = this.#environment["GITHUB_ACCOUNT_ID"]?.trim();
    if (expectedAccount && expectedAccount !== surfaceAccountId) {
      throw new Error(
        `Worker GitHub credential is configured for ${expectedAccount}, not ${surfaceAccountId}`,
      );
    }
    const token = this.#environment["GITHUB_TOKEN"]?.trim();
    if (!token) {
      throw new Error(
        "GITHUB_TOKEN is required for GitHub repository source or pull-request delivery",
      );
    }
    const apiBaseUrl = this.#environment["GITHUB_API_BASE_URL"]?.trim();
    return {
      token,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    };
  }
}

export interface GitHubRepositorySourceInput {
  readonly surfaceAccountId: string;
  readonly repositoryId: string;
  readonly revision?: string;
  readonly credential: GitHubWorkerCredential;
}

export interface ResolvedGitHubWorkspace {
  readonly path: string;
  readonly repositoryId: string;
  readonly fullName: string;
  readonly commitSha: string;
  readonly requestedRevision: string;
}

export interface GitHubRepositorySource {
  resolve(input: GitHubRepositorySourceInput): Promise<ResolvedGitHubWorkspace>;
}

export interface GitHubApiRepositorySourceOptions {
  readonly cacheDirectory?: string;
  readonly request?: typeof fetch;
}

/** Resolves a repository and immutable commit through GitHub, then caches its source archive. */
export class GitHubApiRepositorySource implements GitHubRepositorySource {
  readonly #cacheDirectory: string;
  readonly #request: typeof fetch;

  constructor(options: GitHubApiRepositorySourceOptions = {}) {
    this.#cacheDirectory =
      options.cacheDirectory ?? join(homedir(), ".supertag", "cache", "github");
    this.#request = options.request ?? fetch;
  }

  async resolve(input: GitHubRepositorySourceInput): Promise<ResolvedGitHubWorkspace> {
    const repositoryId = positiveIntegerText(input.repositoryId, "GitHub repository ID");
    const apiBaseUrl = normalizeApiBaseUrl(input.credential.apiBaseUrl);
    const repository = await this.#json(
      `${apiBaseUrl}/repositories/${repositoryId}`,
      input.credential.token,
      "repository lookup",
    );
    const resolvedId = positiveIntegerText(repository["id"], "GitHub repository response ID");
    if (resolvedId !== repositoryId) {
      throw new Error(
        `GitHub returned repository ${resolvedId} for requested repository ${repositoryId}`,
      );
    }
    const fullName = repositoryName(repository["full_name"]);
    const defaultBranch = nonEmptyString(repository["default_branch"], "GitHub default branch");
    const requestedRevision = input.revision?.trim() || defaultBranch;
    const commit = await this.#json(
      `${apiBaseUrl}/repos/${repositoryPath(fullName)}/commits/${encodeURIComponent(requestedRevision)}`,
      input.credential.token,
      "commit resolution",
    );
    const commitSha = commitShaFrom(commit["sha"]);
    const repositoryCache = join(this.#cacheDirectory, repositoryId);
    const workspace = join(repositoryCache, commitSha);
    await mkdir(repositoryCache, { recursive: true });
    if (!(await pathExists(workspace))) {
      await this.#downloadWorkspace({
        apiBaseUrl,
        fullName,
        commitSha,
        repositoryCache,
        token: input.credential.token,
        workspace,
      });
    }
    return { path: workspace, repositoryId, fullName, commitSha, requestedRevision };
  }

  async #downloadWorkspace(input: {
    readonly apiBaseUrl: string;
    readonly fullName: string;
    readonly commitSha: string;
    readonly repositoryCache: string;
    readonly token: string;
    readonly workspace: string;
  }): Promise<void> {
    const temporary = await mkdtemp(join(input.repositoryCache, ".resolving-"));
    const archivePath = join(temporary, "repository.tar.gz");
    const extractedPath = join(temporary, "workspace");
    try {
      const archiveUrl = `${input.apiBaseUrl}/repos/${repositoryPath(input.fullName)}/tarball/${input.commitSha}`;
      let response = await this.#request(archiveUrl, {
        redirect: "manual",
        headers: githubHeaders(input.token, "application/vnd.github+json"),
      });
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (location === null) {
          throw new Error("GitHub repository archive redirect did not include a location");
        }
        const redirectUrl = safeGitHubArchiveRedirect(archiveUrl, location);
        response = await this.#request(redirectUrl, {
          redirect: "error",
          headers: githubHeaders(input.token, "application/vnd.github+json"),
        });
      }
      if (!response.ok || response.body === null) {
        throw new Error(`GitHub repository archive download failed with HTTP ${response.status}`);
      }
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        createWriteStream(archivePath, { mode: 0o600 }),
      );
      await mkdir(extractedPath);
      await extract({
        cwd: extractedPath,
        file: archivePath,
        preservePaths: false,
        strict: true,
        strip: 1,
      });
      await assertSafeWorkspaceTree(extractedPath);
      try {
        await rename(extractedPath, input.workspace);
      } catch (error) {
        if (!(await pathExists(input.workspace))) throw error;
      }
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }

  async #json(url: string, token: string, operation: string): Promise<Record<string, unknown>> {
    const response = await this.#request(url, {
      redirect: "error",
      headers: githubHeaders(token, "application/vnd.github+json"),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${operation} failed with HTTP ${response.status}`);
    }
    const value: unknown = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`GitHub ${operation} returned an invalid response`);
    }
    return value as Record<string, unknown>;
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function safeGitHubArchiveRedirect(requestUrl: string, location: string): string {
  const source = new URL(requestUrl);
  const destination = new URL(location, source);
  if (
    destination.protocol !== "https:" ||
    destination.username.length > 0 ||
    destination.password.length > 0
  ) {
    throw new Error("GitHub repository archive redirected to an unsafe URL");
  }
  const officialCodeload =
    source.hostname === "api.github.com" && destination.hostname === "codeload.github.com";
  if (destination.origin !== source.origin && !officialCodeload) {
    throw new Error(
      `GitHub repository archive redirected to untrusted host ${destination.hostname}`,
    );
  }
  return destination.href;
}

export interface GitHubRepositoryWorkspaceResolverOptions {
  readonly credentials: GitHubWorkerCredentialProvider;
  readonly source?: GitHubRepositorySource;
  readonly mountPath?: string;
}

/**
 * Resolves one GitHub repository workspace selected by the request or its
 * GitHub origin. Context Sets never participate in this selection: permissions bound
 * the eligible repositories, then this Worker-local extension performs retrieval.
 */
export class GitHubRepositoryWorkspaceResolver implements WorkspaceResolver {
  readonly #credentials: GitHubWorkerCredentialProvider;
  readonly #source: GitHubRepositorySource;
  readonly #mountPath: string;

  constructor(options: GitHubRepositoryWorkspaceResolverOptions) {
    this.#credentials = options.credentials;
    this.#source = options.source ?? new GitHubApiRepositorySource();
    this.#mountPath = options.mountPath ?? "workspace";
  }

  async resolve(context: ResolutionContext): Promise<WorkspaceResolution | undefined> {
    const target = selectRepositoryTarget(context);
    if (target === undefined) return undefined;
    if ("choices" in target) {
      return {
        id: "github-repository-selection-required",
        kind: "instruction",
        required: true,
        scope: "task",
        priority: -100,
        content: `The request does not identify a GitHub repository. Ask the requester to name exactly one of: ${target.choices.join(", ")}. Do not inspect or make claims about a repository until they do.`,
      };
    }
    assertTagActionAllowed(context.task, {
      surfaceAccountId: target.resource.surfaceAccountId,
      scope: target.resource.scope,
      action: "contents:read",
    });
    const credential = await this.#credentials.resolve(target.resource.surfaceAccountId);
    const workspace = await this.#source.resolve({
      surfaceAccountId: target.resource.surfaceAccountId,
      repositoryId: repositoryIdFromScope(target.resource.scope),
      credential,
    });
    return {
      id: `github-workspace:${workspace.repositoryId}:${workspace.commitSha}`,
      kind: "workspace",
      required: true,
      source: {
        uri: pathToFileURL(workspace.path).href,
        digest: `git:${workspace.commitSha}`,
        provenance: {
          provider: "github",
          surfaceAccountId: target.resource.surfaceAccountId,
          repositoryId: workspace.repositoryId,
          repository: workspace.fullName,
          requestedRevision: workspace.requestedRevision,
          commitSha: workspace.commitSha,
          targetSource: target.source,
        },
      },
      mountPath: this.#mountPath,
      readOnly: true,
    };
  }
}

type GitHubRepositoryTarget = {
  readonly resource: {
    readonly surfaceAccountId: string;
    readonly scope: string;
    readonly reference?: string;
    readonly actions: readonly string[];
  };
  readonly source: "origin" | "request" | "default";
};

type GitHubRepositorySelection = GitHubRepositoryTarget | { readonly choices: readonly string[] };

function selectRepositoryTarget(context: ResolutionContext): GitHubRepositorySelection | undefined {
  const plan = context.task.workspacePlan;
  // Named Workspaces resolve through the Worker Host's declared checkouts, not GitHub.
  if (plan.status === "none" || plan.status === "workspace") return undefined;
  if (plan.status === "unavailable") {
    throw new Error(
      `Tag ${context.task.tag.name} is not allowed to use GitHub repository ${plan.requested.join(", ")}`,
    );
  }
  if (plan.status === "selection-required") {
    return {
      choices: plan.choices
        .filter((choice) => choice.provider === "github")
        .map((choice) => choice.reference ?? choice.scope)
        .sort((left, right) => left.localeCompare(right)),
    };
  }
  if (plan.target.provider !== "github") return undefined;
  return { resource: plan.target, source: plan.selectedBy };
}

function repositoryIdFromScope(scope: string): string {
  const match = /^repository:(\d+)$/u.exec(scope);
  if (match?.[1] === undefined || match[1] === "0") {
    throw new Error(`Invalid GitHub repository scope ${scope}`);
  }
  return BigInt(match[1]).toString();
}

function normalizeApiBaseUrl(value: string | undefined): string {
  const normalized = (value ?? DEFAULT_API_BASE_URL).trim().replace(/\/+$/u, "");
  const url = new URL(normalized);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
    throw new Error("GitHub API base URL must use HTTPS (or loopback HTTP for tests)");
  }
  return url.toString().replace(/\/+$/u, "");
}

function githubHeaders(token: string, accept: string): Record<string, string> {
  if (!token.trim()) throw new Error("GitHub Worker token must not be empty");
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "supertag-worker",
    "x-github-api-version": "2022-11-28",
  };
}

function repositoryName(value: unknown): string {
  const name = nonEmptyString(value, "GitHub repository full name");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name)) {
    throw new Error("GitHub repository response has an invalid full name");
  }
  return name;
}

function repositoryPath(fullName: string): string {
  return fullName.split("/").map(encodeURIComponent).join("/");
}

function commitShaFrom(value: unknown): string {
  const sha = nonEmptyString(value, "GitHub commit SHA").toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("GitHub returned an invalid commit SHA");
  return sha;
}

function positiveIntegerText(value: unknown, label: string): string {
  const normalized = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+$/u.test(normalized) || normalized === "0")
    throw new Error(`${label} must be positive`);
  return BigInt(normalized).toString();
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} is required`);
  return value.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertSafeWorkspaceTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const status = await lstat(path);
    if (status.isSymbolicLink()) {
      throw new Error(`GitHub repository archive contains unsupported symbolic link ${entry.name}`);
    }
    if (status.isDirectory()) {
      await assertSafeWorkspaceTree(path);
    } else if (!status.isFile()) {
      throw new Error(`GitHub repository archive contains unsupported entry ${entry.name}`);
    }
  }
}
