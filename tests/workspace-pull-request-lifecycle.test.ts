import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskResourceFromStore } from "../apps/cli/src/control-plane-resources.js";
import { createWorkspacePullRequestHandler } from "../apps/cli/src/gateway-surfaces.js";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import {
  WORKSPACE_PULL_REQUEST_RETRY,
  type WorkspacePullRequestHandler,
  WorkspacePullRequestLifecycle,
  type WorkspacePullRequestTarget,
} from "../packages/control-plane/src/workspace-pull-requests.js";
import {
  type SurfaceAccount,
  type Task,
  WORKSPACE_PULL_REQUEST_EVENTS,
  workspacePullRequestReference,
} from "../packages/core/src/index.js";
import { LocalWorklet } from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
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
    // The owner runs nowhere, so its own conversation's turn stays held and the test drives it.
    await store.bindTagWorkerHost(owner.id, "owner-host");
    await store.bindTagWorkerHost(member.id, "host");
    const team = await store.createTeam({
      id: randomUUID(),
      name: `delivery-${randomUUID()}`,
      memberTagIds: [owner.id, member.id],
      maxConcurrency: 1,
    });
    const objective = await store.createObjective({
      id: `objective-${randomUUID().slice(0, 8)}`,
      ownerTagId: owner.id,
      teamId: team.id,
      outcome: "Ship the change.",
      workspaces: ["app"],
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
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      worklet: new LocalWorklet("w", "host", []),
      reply: async () => undefined,
      dispatch: { pollIntervalMs: 1_000_000 },
    });
    const controller = controlPlane.objectives;
    controller.activateCoordination({ url: "http://127.0.0.1:1" });
    controller.setWorkspacePullRequestHandler(handler);
    await controlPlane.start();
    cleanups.push(() => controlPlane.stop());
    const { taskId: ownerTaskId } = await controlPlane.startObjective(objective.id);
    const ownerTask = await store.findTaskById(ownerTaskId);
    if (!ownerTask?.inboundEventId) throw new Error("The Objective opened no turn");
    const claimed = await store.claimDueInboundEvent({
      inboundEventId: ownerTask.inboundEventId,
      leaseOwner: "pr-lifecycle",
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    if (!claimed) throw new Error("The Objective's turn was not claimable");
    await store.startTask({ taskId: ownerTaskId, startedAt: new Date().toISOString() });
    const ownerAttempt = await store.createTaskAttempt({
      taskId: ownerTaskId,
      attemptNumber: claimed.attemptCount,
      workerProfile: { id: "default", revision: "1" },
      workerSnapshot: { workerHostId: "owner-host" },
      startedAt: new Date().toISOString(),
    });
    const running = await store.findTaskById(ownerTaskId);
    if (!running) throw new Error("Missing owner Task");
    const capability = await controller.surfaceCoordination(running, ownerAttempt);
    if (!capability) throw new Error("Missing owner coordination");
    const caller = await controller.authenticateExecution(capability.token);
    /** A work Session whose Worker opened a draft pull request. */
    const assign = async () => {
      const started = (await controller.commandAsAttempt(
        "start_session",
        { title: "Change the code", instruction: "Change the code" },
        caller,
      )) as { sessionId: string };
      const task = (await store.listTasks({ sessionId: started.sessionId }))[0] as Task;
      // What a Worker records on its Task Attempt result after opening the draft.
      await store.appendTaskEvent({
        taskId: task.id,
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
    /** Ends the work Session's Task the way the Control Plane does, without running it. */
    const settleTask = async (task: Task, status: "cancelled" | "completed") => {
      await store.closeTask({
        taskId: task.id,
        status,
        endedAt: new Date().toISOString(),
        ...(status === "completed"
          ? {
              result: {
                summary: "Changed the code",
                decisions: [],
                changes: [],
                unresolved: [],
                findings: [],
                references: [],
                artifacts: [],
              },
            }
          : {}),
      });
      return (await store.findTaskById(task.id)) as Task;
    };
    const cancel = (task: Task) => settleTask(task, "cancelled");
    const accept = (task: Task) => settleTask(task, "completed");
    return {
      store,
      controlPlane,
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
    expect((await f.store.findTaskById(task.id))?.workspacePlan).toMatchObject({
      status: "workspace",
      source: "https://github.com/acme/app.git",
      delivery: "pull-request",
    });
  });

  it("closes the pull request with a comment when the work Session is cancelled, once", async () => {
    const f = await fixture();
    const task = await f.assign();
    const cancelled = await f.cancel(task);
    await new WorkspacePullRequestLifecycle(f.store, f.handler).settle(cancelled);
    expect(f.calls).toEqual([
      {
        kind: "close",
        target: expect.objectContaining({
          surfaceAccountId: "github-account",
          repository: "acme/app",
          number: 7,
        }),
        comment: `SuperTag closed this pull request because Task ${task.id} was cancelled.`,
      },
    ]);
    const events = await f.store.listTaskEvents(task.id);
    expect(
      events.find((event) => event.type === WORKSPACE_PULL_REQUEST_EVENTS.closed)?.payload,
    ).toMatchObject({
      url: PULL_REQUEST.url,
      taskStatus: "cancelled",
    });
    // Settling again never repeats the provider call.
    await new WorkspacePullRequestLifecycle(f.store, f.handler).settle(cancelled);
    expect(f.calls).toHaveLength(1);
    const resource = await taskResourceFromStore(
      f.store,
      (await f.store.findTaskById(task.id)) as never,
    );
    expect(resource.status.pullRequest).toEqual({
      repository: "acme/app",
      number: 7,
      url: PULL_REQUEST.url,
      state: "closed",
    });
  });

  it("marks the draft ready for review when the work Session completes, and records failures", async () => {
    const f = await fixture();
    const task = await f.assign();
    const completed = await f.accept(task);
    let clock = Date.parse("2026-09-30T12:00:00.000Z");
    const lifecycle = new WorkspacePullRequestLifecycle(f.store, f.handler, undefined, () => clock);
    f.fail(new Error("GitHub ready-for-review failed with HTTP 502"));
    await lifecycle.settle(completed);
    const failed = await taskResourceFromStore(
      f.store,
      (await f.store.findTaskById(task.id)) as never,
    );
    expect(failed.status.pullRequest).toMatchObject({
      state: "draft",
      lastError: "GitHub ready-for-review failed with HTTP 502",
      nextAttemptAt: "2026-09-30T12:01:00.000Z",
    });
    f.fail(undefined);
    // A scheduled retry owns the transition; settling again waits for it.
    await lifecycle.settle(completed);
    expect(f.calls).toHaveLength(0);
    clock += 60_000;
    await lifecycle.retryDue(true);
    await lifecycle.settle(completed);
    expect(f.calls.map((call) => call.kind)).toEqual(["ready"]);
    const ready = await taskResourceFromStore(
      f.store,
      (await f.store.findTaskById(task.id)) as never,
    );
    expect(ready.status.pullRequest).toEqual({
      repository: "acme/app",
      number: 7,
      url: PULL_REQUEST.url,
      state: "ready",
    });
    // A Task that has not ended leaves the pull request alone.
    await lifecycle.settle({ ...completed, status: "running" });
    expect(f.calls).toHaveLength(1);
  });

  it("retries a failed close with doubling backoff and stops after bounded attempts", async () => {
    const f = await fixture();
    const task = await f.assign();
    const cancelled = await f.cancel(task);
    let clock = Date.parse("2026-09-30T12:00:00.000Z");
    const lifecycle = new WorkspacePullRequestLifecycle(f.store, f.handler, undefined, () => clock);
    f.fail(new Error("fetch failed"));
    await lifecycle.settle(cancelled);
    const delays: number[] = [];
    for (;;) {
      const [pending] = await f.store.listDueWorkspacePullRequestTransitions(
        "9999-01-01T00:00:00.000Z",
      );
      if (!pending) break;
      expect(pending).toMatchObject({ taskId: task.id, action: "close" });
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
    const failures = (await f.store.listTaskEvents(task.id)).filter(
      (event) => event.type === WORKSPACE_PULL_REQUEST_EVENTS.failed,
    );
    expect(failures).toHaveLength(10);
    expect(failures.at(-1)?.payload).toMatchObject({ attempt: 10, retryable: true });
    expect(failures.at(-1)?.payload).not.toHaveProperty("nextAttemptAt");
    const resource = await taskResourceFromStore(
      f.store,
      (await f.store.findTaskById(task.id)) as never,
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
    const cancelled = await f.cancel(task);
    let clock = Date.parse("2026-09-30T12:00:00.000Z");
    const lifecycle = new WorkspacePullRequestLifecycle(f.store, f.handler, undefined, () => clock);
    f.fail(new GitHubPullRequestError("GitHub pull request close failed with HTTP 503", true, 503));
    await lifecycle.settle(cancelled);
    f.fail(undefined);
    clock += 60_000;
    await lifecycle.retryDue(true);
    await lifecycle.retryDue(true);
    expect(f.calls.map((call) => call.kind)).toEqual(["close"]);
    expect(
      await f.store.listDueWorkspacePullRequestTransitions("9999-01-01T00:00:00.000Z"),
    ).toEqual([]);
    const events = await f.store.listTaskEvents(task.id);
    expect(events.filter((e) => e.type === WORKSPACE_PULL_REQUEST_EVENTS.closed)).toHaveLength(1);
  });

  it("does not retry permanent failures such as a missing pull request", async () => {
    const f = await fixture();
    const task = await f.assign();
    const cancelled = await f.cancel(task);
    const lifecycle = new WorkspacePullRequestLifecycle(f.store, f.handler);
    f.fail(
      new GitHubPullRequestError("GitHub pull request lookup failed with HTTP 404", false, 404),
    );
    await lifecycle.settle(cancelled);
    expect(
      await f.store.listDueWorkspacePullRequestTransitions("9999-01-01T00:00:00.000Z"),
    ).toEqual([]);
    const resource = await taskResourceFromStore(
      f.store,
      (await f.store.findTaskById(task.id)) as never,
    );
    expect(resource.status.pullRequest).toEqual({
      repository: "acme/app",
      number: 7,
      url: PULL_REQUEST.url,
      state: "draft",
      lastError: "GitHub pull request lookup failed with HTTP 404",
    });
    const [failure] = (await f.store.listTaskEvents(task.id)).filter(
      (event) => event.type === WORKSPACE_PULL_REQUEST_EVENTS.failed,
    );
    expect(failure?.payload).toMatchObject({ attempt: 1, retryable: false });
    // A missing handler is also permanent.
    const other = await f.assign();
    await new WorkspacePullRequestLifecycle(f.store, undefined).settle(await f.cancel(other));
    expect(
      await f.store.listDueWorkspacePullRequestTransitions("9999-01-01T00:00:00.000Z"),
    ).toEqual([]);
  });

  it("drops a pending retry once the pull request already reached its state", async () => {
    const f = await fixture();
    const task = await f.assign();
    const cancelled = await f.cancel(task);
    let clock = Date.parse("2026-09-30T12:00:00.000Z");
    const lifecycle = new WorkspacePullRequestLifecycle(f.store, f.handler, undefined, () => clock);
    f.fail(new Error("socket hang up"));
    await lifecycle.settle(cancelled);
    f.fail(undefined);
    // Another Control Plane instance, or a person, recorded the close meanwhile.
    await f.store.appendTaskEvent({
      taskId: task.id,
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

  it("cancels each open Task of a cancelled Objective and closes its pull request", async () => {
    const f = await fixture();
    const task = await f.assign();
    const result = await f.controller.cancelObjective({ objectiveId: f.objective.id });
    expect(result.cancelledTaskIds).toContain(task.id);
    expect((await f.store.findTaskById(task.id))?.status).toBe("cancelled");
    expect(f.calls).toEqual([
      {
        kind: "close",
        target: expect.objectContaining({ repository: "acme/app", number: 7 }),
        comment: `SuperTag closed this pull request because Task ${task.id} was cancelled.`,
      },
    ]);
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
