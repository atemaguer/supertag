import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskResourceFromStore } from "../apps/cli/src/control-plane-resources.js";
import { createWorkspacePullRequestHandler } from "../apps/cli/src/gateway-surfaces.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  WORKSPACE_PULL_REQUEST_RETRY,
  type WorkspacePullRequestHandler,
  WorkspacePullRequestLifecycle,
  type WorkspacePullRequestTarget,
} from "../packages/control-plane/src/workspace-pull-requests.js";
import {
  type SurfaceAccount,
  type TaskAssignment,
  WORKSPACE_PULL_REQUEST_EVENTS,
  workspacePullRequestReference,
} from "../packages/core/src/index.js";
import { LocalWorklet } from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import {
  closeGitHubPullRequest,
  GitHubPullRequestError,
  markGitHubPullRequestReady,
} from "../packages/surfaces/github/src/index.js";

// Under a busy full-suite run these tests can exceed vitest's 5-second default timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PULL_REQUEST = {
  surfaceAccountId: "github-account",
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
};

describe("Workspace pull request lifecycle", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "supertag-pr-lifecycle-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    await store.applyWorkspace({
      name: "app",
      source: "https://github.com/acme/app.git",
      delivery: "pull-request",
    });
    const owner = await store.createTag({ name: `owner-${randomUUID()}` });
    const member = await store.createTag({ name: `member-${randomUUID()}` });
    for (const tag of [owner, member]) await store.bindTagWorkerHost(tag.id, "host");
    const objective = await store.createObjective({
      id: `objective-${randomUUID().slice(0, 8)}`,
      ownerTagId: owner.id,
      outcome: "Ship the change.",
      workspaces: ["app"],
    });
    const team = await store.createTeam({
      id: randomUUID(),
      objectiveId: objective.id,
      name: "Delivery",
      leadTagId: owner.id,
      memberTagIds: [member.id],
      maxConcurrency: 1,
    });
    const calls: {
      kind: "ready" | "close";
      target: WorkspacePullRequestTarget;
      comment?: string;
    }[] = [];
    let failure: Error | undefined;
    const handler: WorkspacePullRequestHandler = {
      async markReadyForReview(target) {
        if (failure) throw failure;
        calls.push({ kind: "ready", target });
      },
      async close(target) {
        if (failure) throw failure;
        calls.push({ kind: "close", target, comment: target.comment });
      },
    };
    const controller = new ObjectiveController(store, new LocalWorklet("w", "host", []));
    controller.setWorkspacePullRequestHandler(handler);
    cleanups.push(() => controller.stop());
    const assign = async () => {
      const task = (await controller.command("assign_task", {
        objectiveId: objective.id,
        taskId: randomUUID(),
        teamId: team.id,
        assignedTagId: member.id,
        instruction: "Change the code",
        acceptanceCriteria: ["Changed"],
      })) as TaskAssignment;
      // What a Worker records on its Task Attempt result after opening the draft.
      await store.appendTaskEvent({
        taskId: task.taskId,
        type: "result",
        payload: {
          type: "result",
          result: {
            summary: "Changed the code",
            decisions: [],
            changes: [],
            unresolved: [],
            findings: [],
            artifacts: [],
            references: [workspacePullRequestReference(PULL_REQUEST)],
          },
        },
      });
      return task;
    };
    /** Settles the stored assignment without the controller, so a test lifecycle acts on it. */
    const cancel = (task: TaskAssignment) => store.cancelTaskAssignment(task.taskId, owner.id);
    const accept = async (task: TaskAssignment) => {
      await store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "test" });
      await store.createTaskAttempt({
        taskId: task.taskId,
        attemptNumber: 1,
        workerProfile: { id: "test", revision: "1" },
        workerSnapshot: {},
        startedAt: new Date().toISOString(),
      });
      await store.settleTaskAssignment({
        taskId: task.taskId,
        leaseOwner: "test",
        attemptCount: 1,
        result: { taskResult: { artifacts: [] } },
      });
      return store.reviewTaskAssignment(task.taskId, owner.id, true, "Accepted");
    };
    return {
      store,
      controller,
      objective,
      calls,
      handler,
      assign,
      cancel,
      accept,
      fail: (error: Error | undefined) => {
        failure = error;
      },
    };
  }

  it("captures the Workspace source on the Task plan", async () => {
    const f = await fixture();
    const task = await f.assign();
    expect((await f.store.findTaskById(task.taskId))?.workspacePlan).toMatchObject({
      status: "workspace",
      source: "https://github.com/acme/app.git",
      delivery: "pull-request",
    });
  });

  it("closes the pull request with a comment when the Task is cancelled, once", async () => {
    const f = await fixture();
    const task = await f.assign();
    await f.controller.command("update_task", {
      objectiveId: f.objective.id,
      taskId: task.taskId,
      expectedStatus: "queued",
      status: "cancelled",
    });
    expect(f.calls).toEqual([
      {
        kind: "close",
        target: expect.objectContaining({
          surfaceAccountId: "github-account",
          repository: "acme/app",
          number: 7,
        }),
        comment: `SuperTag closed this pull request because Task ${task.taskId} was cancelled.`,
      },
    ]);
    const events = await f.store.listTaskEvents(task.taskId);
    expect(
      events.find((event) => event.type === WORKSPACE_PULL_REQUEST_EVENTS.closed)?.payload,
    ).toMatchObject({
      url: PULL_REQUEST.url,
      taskStatus: "cancelled",
    });
    // Settling again never repeats the provider call.
    await new WorkspacePullRequestLifecycle(f.store, f.handler).settle({
      taskId: task.taskId,
      status: "cancelled",
    });
    expect(f.calls).toHaveLength(1);
    const resource = await taskResourceFromStore(
      f.store,
      (await f.store.findTaskById(task.taskId)) as never,
    );
    expect(resource.status.pullRequest).toEqual({
      repository: "acme/app",
      number: 7,
      url: PULL_REQUEST.url,
      state: "closed",
    });
  });

  it("marks the draft ready for review when the Task is accepted, and records failures", async () => {
    const f = await fixture();
    const task = await f.assign();
    await f.accept(task);
    let clock = Date.parse("2026-09-30T12:00:00.000Z");
    const lifecycle = new WorkspacePullRequestLifecycle(f.store, f.handler, undefined, () => clock);
    f.fail(new Error("GitHub ready-for-review failed with HTTP 502"));
    await lifecycle.settle({ taskId: task.taskId, status: "accepted" });
    const failed = await taskResourceFromStore(
      f.store,
      (await f.store.findTaskById(task.taskId)) as never,
    );
    expect(failed.status.pullRequest).toMatchObject({
      state: "draft",
      lastError: "GitHub ready-for-review failed with HTTP 502",
      nextAttemptAt: "2026-09-30T12:01:00.000Z",
    });
    f.fail(undefined);
    // A scheduled retry owns the transition; settling again waits for it.
    await lifecycle.settle({ taskId: task.taskId, status: "accepted" });
    expect(f.calls).toHaveLength(0);
    clock += 60_000;
    await lifecycle.retryDue(true);
    await lifecycle.settle({ taskId: task.taskId, status: "accepted" });
    expect(f.calls.map((call) => call.kind)).toEqual(["ready"]);
    const ready = await taskResourceFromStore(
      f.store,
      (await f.store.findTaskById(task.taskId)) as never,
    );
    expect(ready.status.pullRequest).toEqual({
      repository: "acme/app",
      number: 7,
      url: PULL_REQUEST.url,
      state: "ready",
    });
    // Tasks that have not settled leave the pull request alone.
    await lifecycle.settle({ taskId: task.taskId, status: "submitted" });
    expect(f.calls).toHaveLength(1);
  });

  it("retries a failed close with doubling backoff and stops after bounded attempts", async () => {
    const f = await fixture();
    const task = await f.assign();
    await f.cancel(task);
    let clock = Date.parse("2026-09-30T12:00:00.000Z");
    const lifecycle = new WorkspacePullRequestLifecycle(f.store, f.handler, undefined, () => clock);
    f.fail(new Error("fetch failed"));
    await lifecycle.settle({ taskId: task.taskId, status: "cancelled" });
    const delays: number[] = [];
    for (;;) {
      const [pending] = await f.store.listDueWorkspacePullRequestTransitions(
        "9999-01-01T00:00:00.000Z",
      );
      if (!pending) break;
      expect(pending).toMatchObject({ taskId: task.taskId, action: "close" });
      const due = Date.parse(pending.nextAttemptAt);
      delays.push((due - clock) / 60_000);
      // Nothing happens before the backoff elapses.
      clock = due - 1;
      await lifecycle.retryDue(true);
      expect(
        (await f.store.listDueWorkspacePullRequestTransitions("9999-01-01T00:00:00.000Z"))[0]
          ?.attemptCount,
      ).toBe(pending.attemptCount);
      clock = due;
      await lifecycle.retryDue(true);
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
    expect(WORKSPACE_PULL_REQUEST_RETRY.maxAttempts).toBe(10);
    const failures = (await f.store.listTaskEvents(task.taskId)).filter(
      (event) => event.type === WORKSPACE_PULL_REQUEST_EVENTS.failed,
    );
    expect(failures).toHaveLength(10);
    expect(failures.at(-1)?.payload).toMatchObject({ attempt: 10, retryable: true });
    expect(failures.at(-1)?.payload).not.toHaveProperty("nextAttemptAt");
    const resource = await taskResourceFromStore(
      f.store,
      (await f.store.findTaskById(task.taskId)) as never,
    );
    expect(resource.status.pullRequest).toMatchObject({
      state: "draft",
      lastError: "fetch failed",
    });
    expect(resource.status.pullRequest).not.toHaveProperty("nextAttemptAt");
  });

  it("recovers on a later retry and records the transition once", async () => {
    const f = await fixture();
    const task = await f.assign();
    await f.cancel(task);
    let clock = Date.parse("2026-09-30T12:00:00.000Z");
    const lifecycle = new WorkspacePullRequestLifecycle(f.store, f.handler, undefined, () => clock);
    f.fail(new GitHubPullRequestError("GitHub pull request close failed with HTTP 503", true, 503));
    await lifecycle.settle({ taskId: task.taskId, status: "cancelled" });
    f.fail(undefined);
    clock += 60_000;
    await lifecycle.retryDue(true);
    await lifecycle.retryDue(true);
    expect(f.calls.map((call) => call.kind)).toEqual(["close"]);
    expect(
      await f.store.listDueWorkspacePullRequestTransitions("9999-01-01T00:00:00.000Z"),
    ).toEqual([]);
    const events = await f.store.listTaskEvents(task.taskId);
    expect(events.filter((e) => e.type === WORKSPACE_PULL_REQUEST_EVENTS.closed)).toHaveLength(1);
  });

  it("does not retry permanent failures such as a missing pull request", async () => {
    const f = await fixture();
    const task = await f.assign();
    await f.cancel(task);
    const lifecycle = new WorkspacePullRequestLifecycle(f.store, f.handler);
    f.fail(
      new GitHubPullRequestError("GitHub pull request lookup failed with HTTP 404", false, 404),
    );
    await lifecycle.settle({ taskId: task.taskId, status: "cancelled" });
    expect(
      await f.store.listDueWorkspacePullRequestTransitions("9999-01-01T00:00:00.000Z"),
    ).toEqual([]);
    const resource = await taskResourceFromStore(
      f.store,
      (await f.store.findTaskById(task.taskId)) as never,
    );
    expect(resource.status.pullRequest).toEqual({
      repository: "acme/app",
      number: 7,
      url: PULL_REQUEST.url,
      state: "draft",
      lastError: "GitHub pull request lookup failed with HTTP 404",
    });
    const [failure] = (await f.store.listTaskEvents(task.taskId)).filter(
      (event) => event.type === WORKSPACE_PULL_REQUEST_EVENTS.failed,
    );
    expect(failure?.payload).toMatchObject({ attempt: 1, retryable: false });
    // A missing handler is also permanent.
    const other = await f.assign();
    await f.cancel(other);
    await new WorkspacePullRequestLifecycle(f.store, undefined).settle({
      taskId: other.taskId,
      status: "cancelled",
    });
    expect(
      await f.store.listDueWorkspacePullRequestTransitions("9999-01-01T00:00:00.000Z"),
    ).toEqual([]);
  });

  it("drops a pending retry once the pull request already reached its state", async () => {
    const f = await fixture();
    const task = await f.assign();
    await f.cancel(task);
    let clock = Date.parse("2026-09-30T12:00:00.000Z");
    const lifecycle = new WorkspacePullRequestLifecycle(f.store, f.handler, undefined, () => clock);
    f.fail(new Error("socket hang up"));
    await lifecycle.settle({ taskId: task.taskId, status: "cancelled" });
    f.fail(undefined);
    // Another Control Plane instance, or a person, recorded the close meanwhile.
    await f.store.appendTaskEvent({
      taskId: task.taskId,
      type: WORKSPACE_PULL_REQUEST_EVENTS.closed,
      payload: { url: PULL_REQUEST.url },
    });
    clock += 60_000;
    await lifecycle.retryDue(true);
    expect(f.calls).toEqual([]);
    expect(
      await f.store.listDueWorkspacePullRequestTransitions("9999-01-01T00:00:00.000Z"),
    ).toEqual([]);
  });

  it("closes each open Task's pull request when its Objective is cancelled", async () => {
    const f = await fixture();
    const task = await f.assign();
    const result = await f.controller.cancelObjective({ objectiveId: f.objective.id });
    expect(result.cancelledTaskIds).toEqual([task.taskId]);
    expect(f.calls).toEqual([
      expect.objectContaining({
        kind: "close",
        comment: `SuperTag closed this pull request because Task ${task.taskId} was cancelled.`,
      }),
    ]);
  });

  it("closes the pull request when the Task result is rejected", async () => {
    const f = await fixture();
    const task = await f.assign();
    await new WorkspacePullRequestLifecycle(f.store, f.handler).settle({
      taskId: task.taskId,
      status: "rejected",
    });
    expect(f.calls[0]?.comment).toContain("was rejected");
  });

  it("uses the Control Plane's GitHub Surface Account credential", async () => {
    const requests: { method: string; url: string; authorization: string | null }[] = [];
    const request = (async (input: string | URL, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if ((init?.method ?? "GET") === "GET")
        return Response.json({ node_id: "PR_node", state: "open", draft: true, merged: false });
      return Response.json({ data: {} });
    }) as typeof fetch;
    const account = {
      id: "github-account",
      provider: "github",
      credentialId: "credential-1",
      displayName: "acme",
      configuration: {},
    } as unknown as SurfaceAccount;
    const handler = createWorkspacePullRequestHandler(
      { findSurfaceAccountById: async (id) => (id === account.id ? account : undefined) },
      { resolve: async () => ({ token: "gateway-token" }) } as never,
      request,
    );
    await handler.markReadyForReview(PULL_REQUEST);
    expect(requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/app/pulls/7",
      "POST https://api.github.com/graphql",
    ]);
    expect(requests.every((entry) => entry.authorization === "Bearer gateway-token")).toBe(true);
    await expect(
      handler.close({ ...PULL_REQUEST, surfaceAccountId: "missing", comment: "x" }),
    ).rejects.toMatchObject({
      message: "GitHub Surface Account missing was not found",
      retryable: false,
    });
  });
});

describe("GitHub pull request transitions", () => {
  const recorder = (pullRequest: Record<string, unknown>) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const request = (async (input: string | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Response.json(
        (init?.method ?? "GET") === "GET" ? { node_id: "PR_node", ...pullRequest } : { data: {} },
      );
    }) as typeof fetch;
    return { calls, request };
  };
  const options = { token: "t", repository: "acme/app", number: 7 };

  it("marks a draft ready through GraphQL and leaves other pull requests alone", async () => {
    const draft = recorder({ state: "open", draft: true });
    await markGitHubPullRequestReady({ ...options, request: draft.request });
    expect(draft.calls[1]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/graphql",
      body: { variables: { id: "PR_node" } },
    });
    const ready = recorder({ state: "open", draft: false });
    await markGitHubPullRequestReady({ ...options, request: ready.request });
    expect(ready.calls).toHaveLength(1);
    const enterprise = recorder({ state: "open", draft: true });
    await markGitHubPullRequestReady({
      ...options,
      apiBaseUrl: "https://git.example.com/api/v3",
      request: enterprise.request,
    });
    expect(enterprise.calls[1]?.url).toBe("https://git.example.com/api/graphql");
  });

  it("comments, then closes an open pull request, and never touches a merged one", async () => {
    const open = recorder({ state: "open", draft: true, merged: false });
    await closeGitHubPullRequest({ ...options, comment: "Cancelled.", request: open.request });
    expect(open.calls.slice(1)).toEqual([
      {
        method: "POST",
        url: "https://api.github.com/repos/acme/app/issues/7/comments",
        body: { body: "Cancelled." },
      },
      {
        method: "PATCH",
        url: "https://api.github.com/repos/acme/app/pulls/7",
        body: { state: "closed" },
      },
    ]);
    const merged = recorder({ state: "closed", merged: true });
    await closeGitHubPullRequest({ ...options, comment: "x", request: merged.request });
    expect(merged.calls).toHaveLength(1);
    expect(open.calls.some((call) => call.url.endsWith("/merge"))).toBe(false);
  });

  it.each([
    [503, {}, true],
    [502, {}, true],
    [429, {}, true],
    [403, { "x-ratelimit-remaining": "0" }, true],
    [403, { "retry-after": "60" }, true],
    [403, {}, false],
    [404, {}, false],
    [410, {}, false],
    [422, {}, false],
  ] as const)("classifies HTTP %i %j as retryable=%s", async (status, headers, retryable) => {
    const request = (async () =>
      new Response("{}", { status, headers: { ...headers } })) as unknown as typeof fetch;
    const failure = await closeGitHubPullRequest({ ...options, comment: "x", request }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GitHubPullRequestError);
    expect(failure).toMatchObject({ status, retryable });
  });
});
