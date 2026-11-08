import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workSessionBranch } from "../packages/control-plane/src/work-sessions.js";
import {
  githubRepositoryFromSource,
  type TaskNamedWorkspacePlan,
  WORKSPACE_PULL_REQUEST_ACTION,
} from "../packages/core/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import {
  GitHubPullRequestPublisher,
  type GitHubPullRequestPublisherOptions,
  pullRequestBody,
  pullRequestTitle,
} from "../packages/runtime/resources/github/src/index.js";
import {
  collectTaskAttemptEvents,
  type ResolutionContext,
  requestSurfaceActionApproval,
  type SurfaceActionApprovalRequest,
  type SurfaceActionApprovalResult,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
} from "../packages/runtime/sdk/src/index.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

// Under a busy full-suite run these tests can exceed vitest's 5-second default timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SOURCE = "https://github.com/acme/app.git";
const SCOPE = "repository:4242";
const ACCOUNT = "github-account";

interface FakePullRequest {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  head: string;
  base: string;
  title: string;
  body: string;
}

/** A fake GitHub REST API for one repository's pull requests. */
function fakeGitHub() {
  const pulls: FakePullRequest[] = [];
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const request = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer worker-token");
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && url.pathname === "/repos/acme/app")
      return json({ default_branch: "main" });
    if (method === "GET" && url.pathname === "/repos/acme/app/pulls") {
      const head = url.searchParams.get("head")?.replace(/^acme:/u, "");
      return json(pulls.filter((pull) => pull.head === head));
    }
    if (method === "POST" && url.pathname === "/repos/acme/app/pulls") {
      if (pulls.some((pull) => pull.head === body?.["head"] && pull.state === "open"))
        return json({ message: "A pull request already exists" }, 422);
      const pull: FakePullRequest = {
        number: pulls.length + 1,
        html_url: `https://github.com/acme/app/pull/${pulls.length + 1}`,
        state: "open",
        draft: body?.["draft"] === true,
        head: String(body?.["head"]),
        base: String(body?.["base"]),
        title: String(body?.["title"]),
        body: String(body?.["body"]),
      };
      pulls.push(pull);
      return json(pull, 201);
    }
    const match = /^\/repos\/acme\/app\/pulls\/(\d+)$/u.exec(url.pathname);
    if (method === "PATCH" && match) {
      const pull = pulls.find((candidate) => candidate.number === Number(match[1]));
      if (!pull) return json({}, 404);
      Object.assign(pull, body);
      return json(pull);
    }
    return json({ message: "not found" }, 404);
  }) as typeof fetch;
  return { pulls, calls, request };
}

describe("pull-request delivery on GitHub", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let upstream: string;
  let origin: string;
  let root: string;

  beforeEach(async () => {
    const restore = await isolateGitConfiguration();
    cleanups.push(restore);
    upstream = await createRepository();
    origin = join(await mkdtemp(join(tmpdir(), "supertag-origin-")), "app.git");
    git(upstream, "clone", "--quiet", "--bare", upstream, origin);
    // git talks to a local bare repository wherever the Workspace names github.com.
    await appendFile(
      process.env["GIT_CONFIG_GLOBAL"] as string,
      `[url "${pathToFileURL(origin).href}"]\n\tinsteadOf = ${SOURCE}\n`,
    );
    root = await mkdtemp(join(tmpdir(), "supertag-pr-root-"));
    for (const path of [upstream, join(origin, ".."), root])
      cleanups.push(() => rm(path, { recursive: true, force: true }));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const branch = workSessionBranch("task-1");
  const plan: TaskNamedWorkspacePlan = {
    version: 1,
    status: "workspace",
    workspace: "app",
    source: SOURCE,
    branch,
    delivery: "pull-request",
  };
  const spec = (
    attemptId: string,
    options: { actions?: string[]; approval?: boolean } = {},
  ): TaskAttemptSpec =>
    ({
      version: 2,
      taskId: "task-1",
      attemptId,
      tag: { id: "tag-1", name: "builder" },
      input: {
        origin: { surface: "cli", accountId: "a", scope: "s", sessionKey: "k", occurredAt: "now" },
        messages: [{ id: "m1", role: "requester", text: "Add a greeting to the README" }],
      },
      coordination: {
        controlPlaneUrl: "http://127.0.0.1:1",
        token: "coordination",
        scope: "surface",
        objectiveId: "objective-1",
      },
      workspacePlan: plan,
      authorization: {
        runtimeActions: ["files:write"],
        resources: [
          {
            provider: "github",
            surfaceAccountId: ACCOUNT,
            scope: SCOPE,
            reference: "acme/app",
            actions: options.actions ?? ["contents:read", WORKSPACE_PULL_REQUEST_ACTION],
            sources: ["permission-set"],
          },
        ],
        ...(options.approval
          ? {
              approvals: [
                {
                  target: "surface",
                  surfaceAccountId: ACCOUNT,
                  scope: SCOPE,
                  action: WORKSPACE_PULL_REQUEST_ACTION,
                  permissionSets: ["release"],
                  approvers: [],
                },
              ],
            }
          : {}),
      },
    }) as unknown as TaskAttemptSpec;
  const credentials = { resolve: async () => ({ token: "worker-token", allowedScopes: [SCOPE] }) };
  const setup = (options: Partial<GitHubPullRequestPublisherOptions> = {}) => {
    const github = fakeGitHub();
    const resolver = new WorkspaceEnvironmentResolver({
      checkouts: [],
      worktreeRoot: root,
      cloneSources: true,
      pullRequests: new GitHubPullRequestPublisher({
        credentials,
        request: github.request,
        approvalPollMs: 5,
        approvalWaitMs: 200,
        ...options,
      }),
    });
    const attempt = async (
      id: string,
      file: string,
      specOptions = {},
      summary = "Add greeting",
    ) => {
      const task = spec(id, specOptions);
      const input = await resolver.resolve({
        task,
        profile: { harness: { provider: "codex" } },
      } as unknown as ResolutionContext);
      await writeFile(join(fileURLToPath(input?.source.uri ?? ""), file), `${file}\n`);
      return resolver.finalize(task, "completed", { summary, evidence: ["Tests pass"] });
    };
    return { github, resolver, attempt };
  };
  const remoteHead = () =>
    git(origin, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);

  it("opens one draft pull request after the first committed Attempt and updates it on continuation", async () => {
    const { github, attempt } = setup();
    const first = await attempt("attempt-1", "greeting.txt");
    expect(first?.pullRequest).toEqual({
      status: "opened",
      draft: true,
      pullRequest: {
        surfaceAccountId: ACCOUNT,
        repository: "acme/app",
        number: 1,
        url: "https://github.com/acme/app/pull/1",
      },
    });
    expect(remoteHead()).toBe(first?.head);
    const created = github.calls.find((call) => call.method === "POST");
    expect(created?.body).toMatchObject({
      head: branch,
      base: "main",
      draft: true,
      title: "Add greeting",
    });
    expect(String(created?.body?.["body"])).toContain("Objective: `objective-1`");
    expect(String(created?.body?.["body"])).toContain("- Tests pass");

    const second = await attempt("attempt-2", "farewell.txt", {}, "Add greeting and farewell");
    expect(second?.pullRequest).toMatchObject({
      status: "updated",
      draft: true,
      pullRequest: { number: 1 },
    });
    expect(remoteHead()).toBe(second?.head);
    expect(github.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(github.pulls).toHaveLength(1);
    expect(github.pulls[0]?.title).toBe("Add greeting and farewell");
  });

  it("holds the first push until an approval: required rule is approved", async () => {
    const requests: SurfaceActionApprovalRequest[] = [];
    const answers: SurfaceActionApprovalResult["status"][] = ["pending", "pending", "granted"];
    const { github, attempt } = setup({
      async approvals(_task, request) {
        requests.push(request);
        // Nothing reaches the source while approval is pending.
        expect(remoteHead()).toBe("");
        return { status: answers.shift() ?? "granted", requestId: "approval-1" };
      },
    });
    const record = await attempt("attempt-1", "greeting.txt", { approval: true });
    expect(record?.pullRequest).toMatchObject({ status: "opened" });
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      action: {
        target: "surface",
        surfaceAccountId: ACCOUNT,
        scope: SCOPE,
        action: WORKSPACE_PULL_REQUEST_ACTION,
        provider: "github",
      },
      argumentsDigest: expect.stringMatching(/^sha256:/u),
    });
    expect(new Set(requests.map((request) => request.argumentsDigest)).size).toBe(1);
    expect(github.pulls).toHaveLength(1);
  });

  it("does not push when approval stays pending or is denied", async () => {
    const pending = setup({
      approvals: async () => ({ status: "pending", requestId: "approval-2" }),
    });
    const held = await pending.attempt("attempt-1", "greeting.txt", { approval: true });
    expect(held?.pullRequest).toMatchObject({
      status: "approval-pending",
      requestId: "approval-2",
      message: expect.stringContaining("needs approval (request approval-2)"),
    });
    expect(remoteHead()).toBe("");
    expect(pending.github.calls.some((call) => call.method === "POST")).toBe(false);

    const denied = setup({
      approvals: async () => ({ status: "denied", requestId: "approval-3", reason: "Not now" }),
    });
    const refused = await denied.attempt("attempt-2", "farewell.txt", { approval: true });
    expect(refused?.pullRequest).toMatchObject({
      status: "approval-denied",
      message: expect.stringContaining("was denied: Not now"),
    });
    expect(remoteHead()).toBe("");
  });

  it("applies the Task's frozen approval rules through the Control Plane, failing closed", async () => {
    const request: SurfaceActionApprovalRequest = {
      action: {
        target: "surface",
        surfaceAccountId: ACCOUNT,
        scope: SCOPE,
        action: WORKSPACE_PULL_REQUEST_ACTION,
        provider: "github",
        toolName: "workspace_pull_request",
      },
      argumentsDigest: "sha256:abc",
      summary: "Open a pull request",
    };
    // Without a rule, no call is made.
    expect(await requestSurfaceActionApproval(spec("a"), request, failingTransport)).toEqual({
      status: "granted",
    });
    const gated = spec("a", { approval: true });
    const forwarded: unknown[] = [];
    const transport = (async (_url: string | URL, init?: RequestInit) => {
      forwarded.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ status: "pending", requestId: "r1" }) },
            ],
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    expect(await requestSurfaceActionApproval(gated, request, transport)).toEqual({
      status: "pending",
      requestId: "r1",
    });
    expect(forwarded[0]).toMatchObject({
      method: "tools/call",
      params: { name: "request_action_approval", arguments: request },
    });
    expect(await requestSurfaceActionApproval(gated, request, failingTransport)).toMatchObject({
      status: "pending",
      reason: expect.stringContaining("approval check failed"),
    });
    const { coordination: _coordination, ...uncoordinated } = gated;
    expect(await requestSurfaceActionApproval(uncoordinated, request)).toMatchObject({
      status: "pending",
    });
  });

  it("does not push for a Tag without pull-requests:create", async () => {
    const { attempt, github } = setup();
    const record = await attempt("attempt-1", "greeting.txt", { actions: ["contents:read"] });
    expect(record?.pullRequest).toMatchObject({
      status: "not-authorized",
      message: expect.stringContaining("Grant pull-requests:create on it through a Permission Set"),
    });
    expect(remoteHead()).toBe("");
    expect(github.calls).toEqual([]);
  });

  it("never reopens a pull request that was closed on GitHub", async () => {
    const { attempt, github } = setup();
    const first = await attempt("attempt-1", "greeting.txt");
    const pushed = remoteHead();
    (github.pulls[0] as FakePullRequest).state = "closed";
    const second = await attempt("attempt-2", "farewell.txt");
    expect(second?.pullRequest).toMatchObject({
      status: "closed",
      pullRequest: { number: 1 },
      message: expect.stringContaining("SuperTag did not reopen it"),
    });
    expect(remoteHead()).toBe(pushed);
    expect(first?.head).toBe(pushed);
    expect(github.pulls).toHaveLength(1);
  });

  it("records the pull request on the Task Attempt result", async () => {
    const github = fakeGitHub();
    const state = await mkdtemp(join(tmpdir(), "supertag-pr-state-"));
    const fallback = await mkdtemp(join(tmpdir(), "supertag-pr-fallback-"));
    cleanups.push(() => rm(state, { recursive: true, force: true }));
    cleanups.push(() => rm(fallback, { recursive: true, force: true }));
    const prior = process.env["SUPERTAG_STATE_DIR"];
    process.env["SUPERTAG_STATE_DIR"] = state;
    cleanups.push(() => {
      if (prior === undefined) delete process.env["SUPERTAG_STATE_DIR"];
      else process.env["SUPERTAG_STATE_DIR"] = prior;
    });
    const worker = createClaudeCodeWorker({
      workspace: fallback,
      workspaceResolvers: new WorkspaceResolverRegistry([
        new WorkspaceEnvironmentResolver({
          checkouts: [],
          worktreeRoot: root,
          cloneSources: true,
          pullRequests: new GitHubPullRequestPublisher({ credentials, request: github.request }),
        }),
      ]),
      runner: async function* (request: { readonly workspace: string }) {
        await writeFile(join(request.workspace, "greeting.txt"), "hello\n");
        yield { type: "output.message", text: "Added a greeting." };
      } as never,
    });
    const task = {
      ...spec("attempt-1"),
      workerProfile: { id: "local-claude-code", revision: "1" },
    };
    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...task,
        contextPlan: { version: 7, capturedAt: "now", sets: [] },
        execution: {},
      } as never),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
    const result = events.find(
      (event): event is Extract<TaskAttemptEvent, { type: "result" }> => event.type === "result",
    )?.result;
    expect(result?.references).toContainEqual({
      provider: "github",
      surfaceAccountId: ACCOUNT,
      resourceType: "pull-request",
      resourceId: "acme/app#1",
      reference: "https://github.com/acme/app/pull/1",
      relationship: "produced",
    });
    expect(result?.changes).toContainEqual({
      summary: "Opened draft pull request acme/app#1",
      reference: "https://github.com/acme/app/pull/1",
    });
    expect(github.pulls[0]?.title).toBe("Added a greeting.");
  });

  it("bounds and sanitizes the pull request title and body", () => {
    const task = spec("attempt-1");
    const title = pullRequestTitle({
      task,
      summary: `\u0007  @maintainers ship ${"x".repeat(300)}\nrest`,
    });
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title).not.toContain("\u0007");
    expect(title.startsWith("@\u200bmaintainers ship")).toBe(true);
    expect(pullRequestTitle({ task })).toBe("Add a greeting to the README");
    const body = pullRequestBody(
      { task, plan, summary: "y".repeat(40_000), evidence: ["ping @team", "\u001b[31mred"] },
      "main",
    );
    expect(body.length).toBeLessThanOrEqual(16_000);
    expect(body).toContain("@\u200bteam");
    expect(body).not.toContain("\u001b");
    expect(body).toContain("SuperTag never merges pull requests.");
    expect(body).toContain("Task: `task-1`");
  });

  it("recognizes GitHub sources", () => {
    expect(githubRepositoryFromSource("https://github.com/acme/app.git")).toEqual({
      owner: "acme",
      name: "app",
      fullName: "acme/app",
      https: true,
    });
    expect(githubRepositoryFromSource("git@github.com:acme/app.git")).toMatchObject({
      fullName: "acme/app",
      https: false,
    });
    expect(githubRepositoryFromSource("ssh://git@github.com/acme/app")).toMatchObject({
      fullName: "acme/app",
    });
    for (const source of [
      "https://gitlab.com/acme/app.git",
      "https://github.com/acme",
      "https://github.com/acme/app/tree/main",
      "https://github.com:8443/acme/app",
      "file:///srv/app.git",
      "git@example.com:acme/app.git",
    ])
      expect(githubRepositoryFromSource(source)).toBeUndefined();
  });
});

const failingTransport = (async () => {
  throw new Error("unreachable");
}) as typeof fetch;
