import {
  approvalArgumentsDigest,
  type GitHubSourceRepository,
  githubRepositoryFromSource,
  WORKSPACE_PULL_REQUEST_ACTION,
  type WorkspacePullRequest,
} from "@supertag/core";
import {
  type GitSourceCredential,
  requestSurfaceActionApproval,
  type SurfaceActionApprovalRequest,
  type SurfaceActionApprovalResult,
  type WorkspacePullRequestOutcome,
  type WorkspacePullRequestPublisher,
  type WorkspacePullRequestPublishInput,
  type WorkspaceSourceCredentials,
  type WorkspaceTask,
} from "@supertag/worker-sdk";
import type { GitHubWorkerCredential, GitHubWorkerCredentialProvider } from "./index.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const TITLE_MAX = 120;
const BODY_MAX = 16_000;

export interface GitHubPullRequestPublisherOptions {
  readonly credentials: GitHubWorkerCredentialProvider;
  readonly request?: typeof fetch;
  /** Applies `approval: required`. Default: ask the Control Plane through the Task's channel. */
  readonly approvals?: (
    task: WorkspaceTask,
    request: SurfaceActionApprovalRequest,
  ) => Promise<SurfaceActionApprovalResult>;
  /** How long a pending approval holds the Attempt before delivery gives up. Default: 10 minutes. */
  readonly approvalWaitMs?: number;
  /** Interval between approval checks while pending. Default: 5 seconds. */
  readonly approvalPollMs?: number;
}

interface PullRequestState {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly draft: boolean;
  readonly merged: boolean;
}

/**
 * Pull-request delivery on GitHub, modeled on dependency update bots: one pull request per
 * Session on its `supertag/session/<id>` branch, opened as a draft after the first completed
 * Task Attempt with commits and updated by later Attempts and later Tasks of the Session. Once a
 * person merges it, the Session's next delivery opens a new one; one a person closed unmerged is
 * neither reopened nor pushed to. The Tag must hold `pull-requests:create` on the repository,
 * pushes and API calls use the host's separate Git credential, and an `approval: required` rule
 * on the action holds each opening push until a person decides. SuperTag never merges.
 */
export class GitHubPullRequestPublisher implements WorkspacePullRequestPublisher {
  readonly #credentials: GitHubWorkerCredentialProvider;
  readonly #request: typeof fetch;
  readonly #approvals: NonNullable<GitHubPullRequestPublisherOptions["approvals"]>;
  readonly #approvalWaitMs: number;
  readonly #approvalPollMs: number;

  constructor(options: GitHubPullRequestPublisherOptions) {
    this.#credentials = options.credentials;
    this.#request = options.request ?? fetch;
    this.#approvals =
      options.approvals ??
      ((task, request) =>
        requestSurfaceActionApproval(
          {
            authorization: task.authorization ?? emptyAuthorization(),
            ...(task.coordination === undefined ? {} : { coordination: task.coordination }),
          },
          request,
        ));
    this.#approvalWaitMs = options.approvalWaitMs ?? 600_000;
    this.#approvalPollMs = options.approvalPollMs ?? 5_000;
  }

  async publish(input: WorkspacePullRequestPublishInput): Promise<WorkspacePullRequestOutcome> {
    const { plan, task } = input;
    const repository = githubRepositoryFromSource(plan.source);
    if (repository === undefined)
      return {
        status: "failed",
        message: `Workspace ${plan.workspace} source is not a GitHub repository; branch ${plan.branch} stays on this Worker Host`,
      };
    const resource = pullRequestResource(task, repository);
    if (resource === undefined)
      return {
        status: "not-authorized",
        message: `Tag ${task.tag?.name ?? "for this Task"} may not open pull requests on ${repository.fullName}. Grant ${WORKSPACE_PULL_REQUEST_ACTION} on it through a Permission Set; branch ${plan.branch} stays on this Worker Host.`,
      };
    const credential = await this.#credentials.resolve(resource.surfaceAccountId);
    const api = new GitHubPullRequestApi(credential, this.#request, input.signal);
    // A merged pull request is done: the Session's later work opens a new one from its branch.
    const found = await api.find(repository, plan.branch);
    const existing = found?.merged === true ? undefined : found;
    const pullRequestOf = (state: PullRequestState): WorkspacePullRequest => ({
      surfaceAccountId: resource.surfaceAccountId,
      repository: repository.fullName,
      number: state.number,
      url: state.url,
    });
    if (existing?.state === "closed")
      return {
        status: "closed",
        pullRequest: pullRequestOf(existing),
        message: `Pull request ${repository.fullName}#${existing.number} was closed on GitHub; SuperTag did not reopen it or push branch ${plan.branch}. Reopen it for this Session's later Tasks to update it`,
      };
    const baseBranch = plan.ref ?? (await api.defaultBranch(repository));
    if (existing === undefined) {
      // Opening the pull request is the gated action; later pushes update the same one.
      const decision = await this.#approve(
        task,
        resource,
        repository,
        plan.branch,
        baseBranch,
        input,
      );
      if (decision !== undefined) return decision;
    }
    await input.push(
      repository.https ? { username: "x-access-token", password: credential.token } : undefined,
    );
    const title = pullRequestTitle(input);
    const body = pullRequestBody(input, baseBranch);
    if (existing !== undefined) {
      await api.update(repository, existing.number, { title, body });
      return { status: "updated", pullRequest: pullRequestOf(existing), draft: existing.draft };
    }
    const created = await api.create(repository, {
      title,
      body,
      head: plan.branch,
      base: baseBranch,
      draft: true,
    });
    if (created !== undefined)
      return { status: "opened", pullRequest: pullRequestOf(created), draft: created.draft };
    // Another Attempt opened it first; update that one instead of opening a second.
    const raced = await api.find(repository, plan.branch);
    if (raced === undefined) throw new Error("GitHub rejected the pull request");
    await api.update(repository, raced.number, { title, body });
    return { status: "updated", pullRequest: pullRequestOf(raced), draft: raced.draft };
  }

  async #approve(
    task: WorkspaceTask,
    resource: { readonly surfaceAccountId: string; readonly scope: string },
    repository: GitHubSourceRepository,
    head: string,
    base: string,
    input: WorkspacePullRequestPublishInput,
  ): Promise<WorkspacePullRequestOutcome | undefined> {
    const request: SurfaceActionApprovalRequest = {
      action: {
        target: "surface",
        surfaceAccountId: resource.surfaceAccountId,
        scope: resource.scope,
        action: WORKSPACE_PULL_REQUEST_ACTION,
        provider: "github",
        toolName: "workspace_pull_request",
      },
      argumentsDigest: approvalArgumentsDigest({ repository: repository.fullName, head, base }),
      summary: `Push ${head} and open a draft pull request into ${base} on ${repository.fullName}`,
    };
    const deadline = Date.now() + this.#approvalWaitMs;
    for (;;) {
      const result = await this.#approvals(task, request);
      if (result.status === "granted") return undefined;
      if (result.status === "denied")
        return {
          status: "approval-denied",
          ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
          message: `Approval request ${result.requestId ?? ""} to open a pull request on ${repository.fullName} was denied${result.reason ? `: ${result.reason}` : ""}. Branch ${head} was not pushed.`,
        };
      if (Date.now() + this.#approvalPollMs > deadline || input.signal?.aborted)
        return {
          status: "approval-pending",
          ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
          message: `Opening a pull request on ${repository.fullName} needs approval${result.requestId ? ` (request ${result.requestId})` : ""}${result.reason ? `; ${result.reason}` : ""}. Branch ${head} was not pushed; a later Task Attempt opens the pull request once the request is approved.`,
        };
      await sleep(this.#approvalPollMs, input.signal);
    }
  }
}

/**
 * Surface credentials for fetching GitHub https sources. A Task whose Permission Sets name the
 * repository fetches with that Surface Account's Worker credential; otherwise the host's own
 * git setup applies. The credential reaches git only through a per-command helper.
 */
export class GitHubWorkspaceSourceCredentials implements WorkspaceSourceCredentials {
  readonly #credentials: GitHubWorkerCredentialProvider;

  constructor(options: { readonly credentials: GitHubWorkerCredentialProvider }) {
    this.#credentials = options.credentials;
  }

  async resolve(input: {
    readonly task: WorkspaceTask;
    readonly source: string;
    readonly purpose: "fetch" | "push";
  }): Promise<GitSourceCredential | undefined> {
    const repository = githubRepositoryFromSource(input.source);
    if (!repository?.https) return undefined;
    const resource =
      input.purpose === "push"
        ? pullRequestResource(input.task, repository)
        : repositoryResources(input.task, repository)[0];
    if (resource === undefined) return undefined;
    const credential = await this.#credentials
      .resolve(resource.surfaceAccountId)
      .catch(() => undefined);
    return credential === undefined
      ? undefined
      : { username: "x-access-token", password: credential.token };
  }
}

function repositoryResources(task: WorkspaceTask, repository: GitHubSourceRepository) {
  const name = repository.fullName.toLowerCase();
  return (task.authorization?.resources ?? []).filter(
    (resource) =>
      resource.provider === "github" &&
      /^repository:[1-9][0-9]*$/u.test(resource.scope) &&
      resource.reference?.toLowerCase() === name,
  );
}

function pullRequestResource(task: WorkspaceTask, repository: GitHubSourceRepository) {
  return repositoryResources(task, repository).find((resource) =>
    resource.actions.includes(WORKSPACE_PULL_REQUEST_ACTION),
  );
}

/** Minimal GitHub REST client for the pull requests one Task branch owns. */
class GitHubPullRequestApi {
  readonly #base: string;

  constructor(
    private readonly credential: GitHubWorkerCredential,
    private readonly request: typeof fetch,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.#base = apiBaseUrl(credential.apiBaseUrl);
  }

  async find(
    repository: GitHubSourceRepository,
    branch: string,
  ): Promise<PullRequestState | undefined> {
    const query = new URLSearchParams({
      head: `${repository.owner}:${branch}`,
      state: "all",
      per_page: "10",
    });
    const list = await this.#json("GET", `${repoPath(repository)}/pulls?${query}`, undefined);
    const entries = Array.isArray(list) ? list.map(pullRequestState) : [];
    // Prefer an open pull request; otherwise the most recent one.
    return entries.find((entry) => entry.state === "open") ?? entries[0];
  }

  async defaultBranch(repository: GitHubSourceRepository): Promise<string> {
    const value = await this.#json("GET", repoPath(repository), undefined);
    const branch = isRecord(value) ? value["default_branch"] : undefined;
    if (typeof branch !== "string" || !branch) throw new Error("GitHub returned no default branch");
    return branch;
  }

  async create(
    repository: GitHubSourceRepository,
    body: Record<string, unknown>,
  ): Promise<PullRequestState | undefined> {
    const response = await this.#send("POST", `${repoPath(repository)}/pulls`, body);
    // 422 when a pull request for this head already exists.
    if (response.status === 422) return undefined;
    if (!response.ok)
      throw new Error(`GitHub pull request creation failed with HTTP ${response.status}`);
    return pullRequestState(await response.json());
  }

  async update(
    repository: GitHubSourceRepository,
    number: number,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.#send("PATCH", `${repoPath(repository)}/pulls/${number}`, body);
    if (!response.ok)
      throw new Error(`GitHub pull request update failed with HTTP ${response.status}`);
  }

  async #json(method: string, path: string, body: unknown): Promise<unknown> {
    const response = await this.#send(method, path, body);
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path.split("?")[0]} failed with HTTP ${response.status}`);
    return response.json();
  }

  #send(method: string, path: string, body: unknown): Promise<Response> {
    return this.request(`${this.#base}${path}`, {
      method,
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.credential.token}`,
        "user-agent": "supertag-worker",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  }
}

function pullRequestState(value: unknown): PullRequestState {
  if (!isRecord(value)) throw new Error("GitHub returned an invalid pull request");
  const number = value["number"];
  const url = value["html_url"];
  const state = value["state"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
    throw new Error("GitHub returned an invalid pull request number");
  if (typeof url !== "string" || !url.startsWith("https://"))
    throw new Error("GitHub returned an invalid pull request URL");
  return {
    number,
    url,
    state: typeof state === "string" ? state : "open",
    draft: value["draft"] === true,
    merged: typeof value["merged_at"] === "string",
  };
}

function repoPath(repository: GitHubSourceRepository): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function apiBaseUrl(value: string | undefined): string {
  const url = new URL((value ?? DEFAULT_API_BASE_URL).trim().replace(/\/+$/u, ""));
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("GitHub API base URL must use HTTPS (or loopback HTTP for tests)");
  return url.toString().replace(/\/+$/u, "");
}

/** Title from the Attempt's summary, else the Task instruction; one bounded line. */
export function pullRequestTitle(
  input: Pick<WorkspacePullRequestPublishInput, "summary" | "task">,
) {
  const candidates = [
    input.summary,
    input.task.input?.messages.find((message) => message.role === "requester")?.text,
    input.task.input?.messages[0]?.text,
  ];
  for (const candidate of candidates) {
    const line = cleanText(candidate ?? "")
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean);
    if (line) return bounded(line, TITLE_MAX);
  }
  return `SuperTag Task ${input.task.taskId}`;
}

/** Body from the Attempt's summary and evidence, with a reference to its Objective and Task. */
export function pullRequestBody(
  input: Pick<WorkspacePullRequestPublishInput, "summary" | "evidence" | "task" | "plan">,
  base: string,
): string {
  const evidence = (input.evidence ?? [])
    .map((line) => bounded(cleanText(line).replace(/\s+/gu, " ").trim(), 500))
    .filter(Boolean)
    .slice(0, 20);
  const objective = input.task.coordination?.objectiveId;
  const footer = [
    "---",
    [
      ...(objective === undefined ? [] : [`Objective: \`${code(objective)}\``]),
      `Task: \`${code(input.task.taskId)}\``,
      `Branch: \`${code(input.plan.branch)}\` into \`${code(base)}\``,
    ].join(" · "),
    "",
    "Opened by SuperTag as a draft; it becomes ready for review when a Task completes its work. SuperTag never merges pull requests.",
  ].join("\n");
  const summary = bounded(cleanText(input.summary ?? "").trim(), 8_000);
  const sections = [
    summary || "SuperTag recorded changes for this Task.",
    ...(evidence.length === 0
      ? []
      : [`### Evidence\n${evidence.map((line) => `- ${line}`).join("\n")}`]),
  ];
  return `${bounded(sections.join("\n\n"), BODY_MAX - footer.length - 2)}\n\n${footer}`;
}

/**
 * Removes control characters, keeps line breaks, and breaks @mentions so model-written text
 * cannot notify people or teams.
 */
function cleanText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/@(?=[A-Za-z0-9])/gu, "@\u200b");
}

function code(value: string): string {
  return cleanText(value).replaceAll("`", "'");
}

function bounded(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyAuthorization(): NonNullable<WorkspaceTask["authorization"]> {
  return {
    version: 1,
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  } as unknown as NonNullable<WorkspaceTask["authorization"]>;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
}
