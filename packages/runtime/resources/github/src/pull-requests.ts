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
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly merged: boolean;
  readonly headRef: string;
  readonly headSha: string;
  readonly headRepository: string | undefined;
  readonly baseRef: string;
  readonly baseRepository: string | undefined;
}

/** What GitHub says about the branch's pull requests before SuperTag pushes. */
type PullRequestLookup =
  | { readonly kind: "new" }
  | { readonly kind: "open"; readonly pullRequest: PullRequestState }
  | { readonly kind: "closed"; readonly pullRequest: PullRequestState }
  | { readonly kind: "hold"; readonly reason: string };

/** Page size of the branch discovery; a full page means the answer may be truncated. */
const LOOKUP_PAGE = 100;

/**
 * Pull-request delivery on GitHub, modeled on dependency update bots: one pull request per
 * Session on its `supertag/session/<id>` branch, opened as a draft after the first completed
 * Task Attempt with commits and updated by later Attempts and later Tasks of the Session.
 *
 * Before pushing, it reads the recorded pull request by number. With no record it discovers
 * the branch's pull requests, then reads the one it found by number. It checks repository, head, base,
 * and state there. It pushes only in two cases. A branch with no pull request and no branch on
 * GitHub is new work, opened after `approval: required`. A branch whose whole history is one
 * open, matching pull request is updated. Anything else holds: nothing is pushed and the branch
 * stays on the Worker Host. That covers a merged or closed pull request, more than one pull
 * request in the branch's history, a branch on GitHub with no pull request, and a malformed,
 * inconsistent, or truncated answer. After an approval wait it looks again, and after the push it
 * reads the pull request again before updating it. The Tag must hold `pull-requests:create` on
 * the repository; pushes and API calls use the host's separate Git credential. SuperTag never
 * merges.
 *
 * Limits: GitHub offers no compare-and-swap between its API and a push, so a person can still
 * merge, close, or open a pull request between the last read and the push or the update. The
 * first delivery without a recorded pull request relies on GitHub's branch and pull request lists.
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
    const pullRequestOf = (state: PullRequestState): WorkspacePullRequest => ({
      surfaceAccountId: resource.surfaceAccountId,
      repository: repository.fullName,
      number: state.number,
      url: state.url,
    });
    const held = (reason: string): WorkspacePullRequestOutcome => ({
      status: "failed",
      message: `SuperTag held pull request delivery on ${repository.fullName}: ${reason}. Branch ${plan.branch} was not pushed and stays on this Worker Host at ${input.head.slice(0, 12)}; resolve it on GitHub, or continue the work in a new Session.`,
    });
    const pin = plan.branchPinPullRequest;
    if (
      pin !== undefined &&
      (plan.branchPin !== plan.branch ||
        pin.repository.toLowerCase() !== repository.fullName.toLowerCase())
    )
      return held(
        `the recorded pull request ${pin.repository}#${pin.number} belongs to a different branch or repository`,
      );
    const baseBranch = plan.ref ?? (await api.defaultBranch(repository));
    const lookup = () =>
      pin === undefined
        ? lookupPullRequest(api, repository, plan.branch, baseBranch)
        : readPullRequest(api, repository, plan.branch, baseBranch, pin.number);
    const found = await lookup();
    if (found.kind === "hold") return held(found.reason);
    if (found.kind === "closed")
      return found.pullRequest.merged
        ? held(
            `pull request #${found.pullRequest.number} from this branch was already merged, so new commits would not reach it`,
          )
        : {
            status: "closed",
            pullRequest: pullRequestOf(found.pullRequest),
            message: `Pull request ${repository.fullName}#${found.pullRequest.number} was closed on GitHub; SuperTag did not reopen it or push branch ${plan.branch}. Reopen it for this Session's later Tasks to update it`,
          };
    const existing = found.kind === "open" ? found.pullRequest : undefined;
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
      // The approval may have waited; GitHub may have changed meanwhile.
      const again = await lookup();
      if (again.kind !== "new")
        return held(
          "the branch's pull requests on GitHub changed while the approval was pending; a later Task Attempt looks again",
        );
    }
    await input.push(
      repository.https ? { username: "x-access-token", password: credential.token } : undefined,
    );
    // From here the branch is on GitHub at input.head; every failure reports partial delivery.
    const pushed = `Pushed branch ${plan.branch} to ${repository.fullName} at ${input.head}`;
    const partial = (reason: string): WorkspacePullRequestOutcome => ({
      status: "failed",
      message: `${pushed}, but ${reason}. Check the branch on GitHub. If it has no pull request, open one from that branch before retrying.`,
    });
    // After a request that may have reached GitHub, its outcome is unknown, not failed.
    const uncertain = (request: string, error: unknown) =>
      partial(
        `the outcome of ${request} is uncertain (${error instanceof Error ? error.message : String(error)})`,
      );
    const exact = (pullRequest: PullRequestState) =>
      pullRequest.state === "open" &&
      !pullRequest.merged &&
      matches(pullRequest, repository, plan.branch, baseBranch) &&
      pullRequest.headSha === input.head;
    const title = pullRequestTitle(input);
    const body = pullRequestBody(input, baseBranch);
    if (existing !== undefined) {
      let current: PullRequestState;
      try {
        current = await api.get(repository, existing.number);
      } catch (error) {
        return partial(
          `SuperTag could not read pull request #${existing.number} again, so it did not update it (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      // GitHub may lag in moving the head to the pushed commit, so only identity is required here.
      const same =
        current.state === "open" &&
        !current.merged &&
        matches(current, repository, plan.branch, baseBranch);
      if (current.number !== existing.number || !same)
        return partial(
          `pull request #${existing.number} changed on GitHub after the push (it is ${current.merged ? "merged" : current.state}, or its head or base no longer match), so SuperTag did not update it`,
        );
      try {
        await api.update(repository, existing.number, { title, body });
      } catch (error) {
        return uncertain(`updating pull request #${existing.number}'s title and body`, error);
      }
      return { status: "updated", pullRequest: pullRequestOf(current), draft: current.draft };
    }
    let created: PullRequestState | undefined;
    try {
      created = await api.create(repository, {
        title,
        body,
        head: plan.branch,
        base: baseBranch,
        draft: true,
      });
    } catch (error) {
      return uncertain("opening the pull request", error);
    }
    if (created !== undefined)
      return exact(created)
        ? { status: "opened", pullRequest: pullRequestOf(created), draft: created.draft }
        : partial(
            `GitHub's answer to opening the pull request (#${created.number}) does not match the branch, base, repository, or pushed commit, so the outcome is uncertain`,
          );
    // 422: perhaps another Attempt opened it first. Adopt only that exact open pull request; the
    // push already delivered its head, so it is not edited.
    const raced = await lookup().catch(
      (error: unknown): PullRequestLookup => ({
        kind: "hold",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    if (raced.kind === "open" && exact(raced.pullRequest))
      return {
        status: "updated",
        pullRequest: pullRequestOf(raced.pullRequest),
        draft: raced.pullRequest.draft,
      };
    return partial(
      `GitHub rejected opening a pull request (HTTP 422) and lists no single open pull request from it into ${baseBranch} at that commit, so none was opened or adopted`,
    );
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

  /**
   * The branch's pull requests in every state, or a reason the answer cannot be trusted:
   * a malformed or truncated response.
   */
  async list(
    repository: GitHubSourceRepository,
    branch: string,
    pageSize: number,
  ): Promise<PullRequestState[] | string> {
    const query = new URLSearchParams({
      head: `${repository.owner}:${branch}`,
      state: "all",
      per_page: String(pageSize),
    });
    const list = await this.#json("GET", `${repoPath(repository)}/pulls?${query}`, undefined);
    if (!Array.isArray(list)) return "GitHub answered the pull request lookup with a non-list";
    if (list.length >= pageSize)
      return `GitHub lists ${list.length} or more pull requests for the branch, so the lookup is incomplete`;
    try {
      return list.map(pullRequestState);
    } catch (error) {
      return `the pull request lookup was malformed (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  /** One pull request by number: the authoritative read of its identity and state. */
  async get(repository: GitHubSourceRepository, number: number): Promise<PullRequestState> {
    return pullRequestState(
      await this.#json("GET", `${repoPath(repository)}/pulls/${number}`, undefined),
    );
  }

  /** An empty successful lookup proves absence. A 404 can also mean missing access. */
  async branchHead(
    repository: GitHubSourceRepository,
    branch: string,
  ): Promise<string | undefined> {
    const path = `${repoPath(repository)}/git/matching-refs/heads/${encodeURIComponent(branch)}`;
    const refs = await this.#json("GET", path, undefined);
    const prefix = `refs/heads/${branch}`;
    if (
      !Array.isArray(refs) ||
      refs.some(
        (ref) => !isRecord(ref) || typeof ref["ref"] !== "string" || !ref["ref"].startsWith(prefix),
      )
    )
      throw new Error("GitHub returned invalid branch references");
    const exact = refs.find((ref) => ref["ref"] === prefix);
    if (exact === undefined) return undefined;
    const object = exact["object"];
    if (!isRecord(object) || object["type"] !== "commit" || !isCommitId(object["sha"]))
      throw new Error("GitHub returned a branch without a commit");
    return object["sha"];
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
    if (response.status !== 201)
      throw new Error(`GitHub answered the creation with HTTP ${response.status}`);
    return pullRequestState(await response.json());
  }

  async update(
    repository: GitHubSourceRepository,
    number: number,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.#send("PATCH", `${repoPath(repository)}/pulls/${number}`, body);
    if (!response.ok) throw new Error(`GitHub answered the update with HTTP ${response.status}`);
    // An answer that does not name the same pull request leaves the update unconfirmed.
    const updated = pullRequestState(await response.json());
    if (updated.number !== number)
      throw new Error(`GitHub answered the update with pull request #${updated.number}`);
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
  const mergedAt = value["merged_at"];
  const head = value["head"];
  const base = value["base"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
    throw new Error("GitHub returned an invalid pull request number");
  if (typeof url !== "string" || !url.startsWith("https://"))
    throw new Error("GitHub returned an invalid pull request URL");
  if (state !== "open" && state !== "closed")
    throw new Error(`GitHub returned pull request #${number} with an unknown state`);
  // `merged_at: null` is GitHub's unmerged value; anything else but a timestamp is malformed.
  if (mergedAt !== null && (typeof mergedAt !== "string" || !mergedAt))
    throw new Error(`GitHub returned pull request #${number} without a valid merged_at`);
  if (!isRecord(head) || !isRecord(base))
    throw new Error(`GitHub returned pull request #${number} without its head and base`);
  const headRef = head["ref"];
  const headSha = head["sha"];
  const baseRef = base["ref"];
  if (
    typeof headRef !== "string" ||
    !headRef ||
    typeof baseRef !== "string" ||
    !baseRef ||
    !isCommitId(headSha)
  )
    throw new Error(`GitHub returned pull request #${number} with an invalid head or base`);
  const merged = typeof mergedAt === "string";
  if (value["merged"] !== undefined && value["merged"] !== merged)
    throw new Error(`GitHub returned conflicting merge status for pull request #${number}`);
  if (merged && state !== "closed")
    throw new Error(`GitHub returned pull request #${number} as both merged and open`);
  return {
    number,
    url,
    state,
    draft: value["draft"] === true,
    merged,
    headRef,
    headSha,
    headRepository: repositoryName(head["repo"]),
    baseRef,
    baseRepository: repositoryName(base["repo"]),
  };
}

function isCommitId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
}

function repositoryName(value: unknown): string | undefined {
  const name = isRecord(value) ? value["full_name"] : undefined;
  return typeof name === "string" ? name.toLowerCase() : undefined;
}

/** True when the pull request is from this repository's branch into its base. */
function matches(
  pullRequest: PullRequestState,
  repository: GitHubSourceRepository,
  branch: string,
  base: string,
): boolean {
  const name = repository.fullName.toLowerCase();
  return (
    pullRequest.headRef === branch &&
    pullRequest.headRepository === name &&
    pullRequest.baseRepository === name &&
    pullRequest.baseRef === base
  );
}

/**
 * Decides whether delivery may push. The list endpoint only discovers pull requests; the one it
 * finds is read again by number. Only a history of exactly one pull request is trusted: with
 * more than one, nothing shows which belongs to this Session. With none, a branch already on
 * GitHub means earlier delivery whose pull request GitHub does not list, so that holds too.
 */
async function lookupPullRequest(
  api: GitHubPullRequestApi,
  repository: GitHubSourceRepository,
  branch: string,
  base: string,
): Promise<PullRequestLookup> {
  const entries = await api.list(repository, branch, LOOKUP_PAGE);
  if (typeof entries === "string") return { kind: "hold", reason: entries };
  const name = repository.fullName.toLowerCase();
  for (const entry of entries)
    if (
      entry.headRef !== branch ||
      entry.baseRepository !== name ||
      // A head repository GitHub no longer reports cannot be checked.
      entry.headRepository !== name
    )
      return {
        kind: "hold",
        reason: `GitHub lists pull request #${entry.number} for the branch, but its head or repository does not match ${repository.fullName}:${branch}`,
      };
  if (entries.length > 1)
    return {
      kind: "hold",
      reason: `GitHub lists ${entries.length} pull requests for the branch (${entries.map((entry) => `#${entry.number} ${entry.merged ? "merged" : entry.state}`).join(", ")}), so SuperTag cannot tell which belongs to this Session`,
    };
  const discovered = entries[0];
  if (discovered === undefined) {
    let exists: boolean;
    try {
      exists = (await api.branchHead(repository, branch)) !== undefined;
    } catch (error) {
      return {
        kind: "hold",
        reason: `SuperTag could not tell whether the branch is already on GitHub (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    return exists
      ? {
          kind: "hold",
          reason:
            "the branch is already on GitHub but GitHub lists no pull request for it, so SuperTag cannot tell whether earlier work was delivered",
        }
      : { kind: "new" };
  }
  return readPullRequest(api, repository, branch, base, discovered.number, discovered.merged);
}

async function readPullRequest(
  api: GitHubPullRequestApi,
  repository: GitHubSourceRepository,
  branch: string,
  base: string,
  number: number,
  alreadyMerged = false,
): Promise<PullRequestLookup> {
  let current: PullRequestState;
  try {
    current = await api.get(repository, number);
  } catch (error) {
    return {
      kind: "hold",
      reason: `SuperTag could not read pull request #${number} by number (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const name = repository.fullName.toLowerCase();
  if (
    current.number !== number ||
    current.headRef !== branch ||
    current.headRepository !== name ||
    current.baseRepository !== name
  )
    return {
      kind: "hold",
      reason: `GitHub's exact read of pull request #${number} does not match ${repository.fullName}:${branch}`,
    };
  if (alreadyMerged && !current.merged)
    return {
      kind: "hold",
      reason: `GitHub disagrees about whether pull request #${number} was merged`,
    };
  if (current.state === "closed") return { kind: "closed", pullRequest: current };
  if (current.baseRef !== base)
    return {
      kind: "hold",
      reason: `open pull request #${current.number} targets ${current.baseRef}, not ${base}`,
    };
  let head: string | undefined;
  try {
    head = await api.branchHead(repository, branch);
  } catch (error) {
    return {
      kind: "hold",
      reason: `SuperTag could not verify the branch for pull request #${number} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (head !== current.headSha)
    return {
      kind: "hold",
      reason: `pull request #${number} names commit ${current.headSha}, but GitHub reports ${head === undefined ? "no branch" : `commit ${head} on the branch`}`,
    };
  return { kind: "open", pullRequest: current };
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
