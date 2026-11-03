export interface GitHubPullRequestOptions {
  readonly token: string;
  readonly apiBaseUrl?: string;
  /** `owner/name`. */
  readonly repository: string;
  readonly number: number;
  readonly request?: typeof fetch;
  readonly signal?: AbortSignal;
}

/**
 * A failed pull-request call. `retryable` is true for failures that may clear with time: GitHub
 * 5xx responses, 429, and rate-limited 403s. A missing pull request, a permission denial, or an
 * invalid request is permanent. Network errors are thrown as-is and count as retryable.
 */
export class GitHubPullRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubPullRequestError";
  }
}

function httpFailure(step: string, response: Response): GitHubPullRequestError {
  const status = response.status;
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")));
  return new GitHubPullRequestError(
    `GitHub ${step} failed with HTTP ${status}${rateLimited ? " (rate limited)" : ""}`,
    rateLimited || status === 408 || status >= 500,
    status,
  );
}

interface PullRequestView {
  readonly nodeId: string;
  readonly state: string;
  readonly draft: boolean;
  readonly merged: boolean;
}

/**
 * Marks a draft pull request ready for review. GitHub exposes this transition only through
 * GraphQL. A pull request that is already ready, closed, or merged is left unchanged.
 */
export async function markGitHubPullRequestReady(options: GitHubPullRequestOptions): Promise<void> {
  const view = await readPullRequest(options);
  if (!view.draft || view.state !== "open") return;
  const response = await send(options, graphqlUrl(options.apiBaseUrl), "POST", {
    query:
      "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
    variables: { id: view.nodeId },
  });
  if (!response.ok) throw httpFailure("ready-for-review", response);
  const payload: unknown = await response.json().catch(() => undefined);
  if (isRecord(payload) && Array.isArray(payload["errors"]) && payload["errors"].length > 0) {
    const types = payload["errors"].map((error) => (isRecord(error) ? error["type"] : undefined));
    // GraphQL reports failures with HTTP 200; only denial and absence are known to be lasting.
    const permanent = types.some((type) => type === "NOT_FOUND" || type === "FORBIDDEN");
    throw new GitHubPullRequestError(
      `GitHub ready-for-review returned an error${typeof types[0] === "string" ? ` (${types[0]})` : ""}`,
      !permanent,
    );
  }
}

/**
 * Comments on an open pull request, then closes it. A closed or merged pull request is left
 * unchanged. This never merges.
 */
export async function closeGitHubPullRequest(
  options: GitHubPullRequestOptions & { readonly comment: string },
): Promise<void> {
  const view = await readPullRequest(options);
  if (view.state !== "open" || view.merged) return;
  const base = restBase(options.apiBaseUrl);
  const path = repositoryPath(options.repository);
  const comment = await send(
    options,
    `${base}/repos/${path}/issues/${options.number}/comments`,
    "POST",
    {
      body: options.comment.slice(0, 2000),
    },
  );
  if (!comment.ok) throw httpFailure("pull request comment", comment);
  const closed = await send(options, `${base}/repos/${path}/pulls/${options.number}`, "PATCH", {
    state: "closed",
  });
  if (!closed.ok) throw httpFailure("pull request close", closed);
}

async function readPullRequest(options: GitHubPullRequestOptions): Promise<PullRequestView> {
  if (!Number.isSafeInteger(options.number) || options.number <= 0)
    throw new GitHubPullRequestError(
      "GitHub pull request number must be a positive integer",
      false,
    );
  const response = await send(
    options,
    `${restBase(options.apiBaseUrl)}/repos/${repositoryPath(options.repository)}/pulls/${options.number}`,
    "GET",
    undefined,
  );
  if (!response.ok) throw httpFailure("pull request lookup", response);
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value["node_id"] !== "string")
    throw new Error("GitHub returned an invalid pull request");
  return {
    nodeId: value["node_id"],
    state: typeof value["state"] === "string" ? value["state"] : "open",
    draft: value["draft"] === true,
    merged: value["merged"] === true,
  };
}

function send(
  options: GitHubPullRequestOptions,
  url: string,
  method: string,
  body: unknown,
): Promise<Response> {
  if (!options.token.trim()) throw new GitHubPullRequestError("A GitHub token is required", false);
  return (options.request ?? fetch)(url, {
    method,
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${options.token}`,
      "user-agent": "supertag-gateway",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/u.test(part)))
    throw new GitHubPullRequestError("GitHub repository must use owner/name format", false);
  return parts.map(encodeURIComponent).join("/");
}

function restBase(value: string | undefined): string {
  const url = new URL(value ?? "https://api.github.com");
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
    throw new GitHubPullRequestError(
      "GitHub API URL must use HTTPS except for loopback development",
      false,
    );
  return url.href.replace(/\/$/u, "");
}

/** github.com serves GraphQL at /graphql; GitHub Enterprise Server at /api/graphql. */
function graphqlUrl(value: string | undefined): string {
  const base = restBase(value);
  return base.endsWith("/api/v3") ? `${base.slice(0, -"/v3".length)}/graphql` : `${base}/graphql`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
