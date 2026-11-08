import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { objectiveAuthorization } from "../packages/control-plane/src/objective-sessions.js";
import type { SurfaceTagAuthorizationSnapshot } from "../packages/core/src/index.js";
import {
  HttpMcpToolProvider,
  openTaskApprovalChannel,
  type ResolutionContext,
  startMcpPolicyProxy,
  type ToolInput,
  withApprovalRequirements,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A Tag that works under an Objective, with a Permission Set whose `approval: required` entries
 * reach its Task's authorization snapshot. Its turn is an Objective Session Task, so the gated
 * calls run with `request_action_approval` and an operator decides them.
 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-approvals-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  cleanups.push(() => store.disconnect());
  const [owner, worker, approver] = await Promise.all(
    ["owner", "worker", "release-manager"].map((name) =>
      store.createTag({ name: `${name}-${randomUUID()}` }),
    ),
  );
  if (!owner || !worker || !approver) throw new Error("Missing Tags");
  for (const tag of [owner, worker, approver]) await store.bindTagWorkerHost(tag.id, "fixture");
  const account = await store.saveSurfaceAccount({
    provider: "github",
    externalAccountId: `github-${randomUUID()}`,
    displayName: "GitHub",
    authMethod: "simulation",
    credentialId: "unused",
    status: "connected",
    configuration: {},
    verifiedAt: new Date().toISOString(),
  });
  const set = await store.createTagPermissionSet({
    name: `release-${randomUUID()}`,
    approvers: [`tag:${approver.name}`],
  });
  const surface = {
    permissionSetId: set.id,
    target: "surface" as const,
    surfaceAccountId: account.id,
    scope: "repository:1",
    reference: "acme/repo",
  };
  await store.addTagPermission({ ...surface, action: "pull-requests:create" });
  await store.addTagPermission({
    ...surface,
    action: "pull-requests:merge",
    approval: "required",
  });
  await store.addTagPermission({
    permissionSetId: set.id,
    target: "runtime",
    action: "commands:execute",
    approval: "required",
  });
  await store.addTagPermission({
    permissionSetId: set.id,
    target: "runtime",
    action: "files:write",
  });
  const role = await store.createRole({
    name: `Release engineer ${randomUUID()}`,
    purpose: "Ship reviewed changes.",
    instructions: "Merge only reviewed pull requests.",
    contextSetIds: [],
    permissionSetIds: [set.id],
  });
  await store.assignRole({ roleId: role.id, tagId: worker.id });
  const team = await store.createTeam({
    id: randomUUID(),
    name: `release-${randomUUID()}`,
    memberTagIds: [owner.id, worker.id, approver.id],
  });
  const objective = await store.createObjective({
    id: randomUUID(),
    ownerTagId: owner.id,
    teamId: team.id,
    outcome: "Release the change",
    runtimeActions: ["commands:execute", "files:write"],
  });
  const route = await store.addTagRoute({
    tagId: worker.id,
    surfaceAccountId: account.id,
    scope: "repository:1",
  });
  const onError = vi.fn();
  const controller = new ObjectiveController(store, undefined, onError);
  controller.activateCoordination({ url: "http://fixture.invalid" });
  // A waiting turn's approval notice and Session resume belong to the Control Plane; this
  // fixture drives the controller alone, so they are recorded and not delivered.
  const notices: string[] = [];
  controller.setSessionHandlers({
    approvalNotice: async (_task, _inbound, requestId) => {
      notices.push(requestId);
    },
    approvalDecided: async () => {},
  } as never);

  const location = { account, route, event: { actor: { id: "supertag", kind: "bot" } } };
  const authorization = () =>
    objectiveAuthorization(
      store,
      objective,
      worker,
      location as never,
    ) as Promise<SurfaceTagAuthorizationSnapshot>;

  /**
   * One running Task of the worker Tag under the Objective, with a claimed turn and a running
   * Attempt, as a dispatched work Session Task has.
   */
  async function runningTask() {
    const snapshot = await authorization();
    const at = new Date().toISOString();
    const sessionKey = `work:${randomUUID()}`;
    const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
    const admitted = await store.admitInboundEvent({
      surfaceAccountId: account.id,
      tagRouteId: route.id,
      tagId: worker.id,
      authorization: snapshot,
      contextPlan,
      event: {
        eventId: randomUUID(),
        logicalEventId: randomUUID(),
        provider: "github",
        externalAccountId: account.externalAccountId,
        kind: "message",
        scope: "repository:1",
        sessionKey,
        actor: { id: "supertag", displayName: "SuperTag", kind: "bot" },
        text: "Merge the reviewed release pull request",
        occurredAt: at,
        callback: {
          provider: "github",
          mode: "github_issue_comment",
          threadKey: sessionKey,
          target: { repository: "acme/repo", issueNumber: 1 },
        },
        source: {},
        metadata: {},
        internal: {
          kind: "work_session",
          startedByTaskId: randomUUID(),
          parentSessionId: randomUUID(),
          title: "Merge the release",
        },
      },
    });
    const session = await store.openSession({
      tagId: worker.id,
      sessionKey,
      origin: {},
      objectiveId: objective.id,
      at,
    });
    const task = await store.openTask({
      inboundEventId: admitted.work.id,
      tagId: worker.id,
      sessionId: session.id,
      execution: {},
      actor: { id: "supertag", kind: "bot" },
      trigger: {},
      workspacePlan: { version: 1, status: "none" },
      sessionHistory: [],
      authorizationSnapshot: snapshot,
      contextPlan,
      createdAt: at,
    });
    const claimed = await store.claimDueInboundEvent({
      inboundEventId: admitted.work.id,
      leaseOwner: "approval-fixture",
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    if (!claimed) throw new Error("Fixture turn could not be claimed");
    const attempt = await store.createTaskAttempt({
      workerProfile: { id: "default", revision: "1" },
      taskId: task.id,
      attemptNumber: claimed.attemptCount,
      workerSnapshot: {},
      startedAt: new Date().toISOString(),
    });
    await store.startTask({ taskId: task.id, startedAt: new Date().toISOString() });
    return {
      task,
      snapshot,
      caller: { kind: "surface" as const, taskId: task.id, attemptId: attempt.id },
    };
  }

  return {
    store,
    controller,
    owner,
    worker,
    approver,
    account,
    set,
    objective,
    team,
    notices,
    authorization,
    runningTask,
    onError,
  };
}

describe("approval: required on permissions", () => {
  it("freezes approval requirements and approvers into the Task authorization snapshot", async () => {
    const f = await fixture();
    const { snapshot } = await f.runningTask();
    expect(snapshot.permissionSets).toEqual([
      { id: f.set.id, name: f.set.name, approvers: [`tag:${f.approver.name}`] },
    ]);
    // Requirements are ordered by their canonical key, so `runtime` sorts before `surface`.
    expect(snapshot.approvals).toEqual([
      {
        target: "runtime",
        action: "commands:execute",
        permissionSets: [f.set.name],
        approvers: [`tag:${f.approver.name}`],
      },
      {
        target: "surface",
        surfaceAccountId: f.account.id,
        scope: "repository:1",
        action: "pull-requests:merge",
        permissionSets: [f.set.name],
        approvers: [`tag:${f.approver.name}`],
      },
    ]);
    // Actions granted without approval are not listed.
    expect(JSON.stringify(snapshot.approvals)).not.toContain("pull-requests:create");
    expect(JSON.stringify(snapshot.approvals)).not.toContain("files:write");
    // The Objective's runtime actions are the ceiling; a surface grant is not a runtime action.
    expect(snapshot.runtimeActions).toEqual(["commands:execute", "files:write"]);
  });

  it("restricts operator decisions when a Permission Set names operator approvers", async () => {
    const f = await fixture();
    await f.store.setTagPermissionSetApprovers(f.set.id, ["operator:release-oncall"]);
    const { task, caller } = await f.runningTask();
    const requested = (await f.controller.commandAsAttempt(
      "request_action_approval",
      {
        action: {
          target: "surface",
          surfaceAccountId: f.account.id,
          scope: "repository:1",
          action: "pull-requests:merge",
        },
        argumentsDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        summary: "Merge the release pull request",
      },
      caller,
    )) as { status: string; requestId: string };
    expect(requested.status).toBe("pending");
    const [request] = await f.store.listApprovalRequests({ taskId: task.id });
    expect(request).toMatchObject({
      kind: "surface-action",
      approvers: ["operator:release-oncall"],
    });
    const principal = (operatorId: string) => ({ operatorId, scopes: { actions: ["*"] } });
    await expect(
      f.controller.decideApprovalRequest(
        { requestId: request?.id, decision: "approve" },
        principal("someone-else"),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      f.controller.decideApprovalRequest(
        { requestId: request?.id, decision: "approve" },
        principal("release-oncall"),
      ),
    ).resolves.toMatchObject({ status: "approved", decidedBy: "release-oncall" });
  });

  it("gates surface calls in the MCP policy proxy until an approval matches", async () => {
    const f = await fixture();
    const { task, caller } = await f.runningTask();
    const coordination = await startCoordination(async (name, args) =>
      f.controller.commandAsAttempt(name, args, caller),
    );
    const channel = openTaskApprovalChannel({
      coordination: {
        controlPlaneUrl: coordination.url,
        token: "unused",
        objectiveId: f.objective.id,
      },
    });
    if (!channel) throw new Error("Missing approval channel");
    cleanups.push(() => channel.close());
    const upstream = await startUpstream(["merge_pull_request", "create_pull_request"]);
    const proxy = await startMcpPolicyProxy(githubTool(f.account.id, upstream.url, channel.handle));
    cleanups.push(() => proxy.close());
    const client = new Client({ name: "approval-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: proxy.headers },
      }),
    );
    cleanups.push(() => client.close());
    const call = async (name: string, pullNumber: number) =>
      (await client.callTool({
        name,
        arguments: { owner: "acme", repo: "repo", pullNumber },
      })) as { isError?: boolean; content: { text: string }[] };

    // An action granted without approval is forwarded directly.
    expect((await call("create_pull_request", 1)).isError).toBeFalsy();
    expect(upstream.calls).toHaveBeenCalledTimes(1);

    const first = await call("merge_pull_request", 1);
    expect(first.isError).toBe(true);
    expect(first.content[0]?.text).toContain("Approval pending");
    expect(upstream.calls).toHaveBeenCalledTimes(1);
    const [pending] = await f.store.listApprovalRequests({
      taskId: task.id,
      kind: "surface-action",
    });
    if (!pending) throw new Error("Missing surface approval request");
    expect(first.content[0]?.text).toContain(pending.id);
    expect(pending).toMatchObject({
      status: "pending",
      requestingTagId: f.worker.id,
      objectiveId: f.objective.id,
      actions: [
        {
          target: "surface",
          surfaceAccountId: f.account.id,
          scope: "repository:1",
          action: "pull-requests:merge",
          toolName: "merge_pull_request",
        },
      ],
      ruleSources: [f.set.name],
      argumentsDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(pending.summary).toContain("merge_pull_request");
    // Repeating the identical call reuses the pending request.
    expect((await call("merge_pull_request", 1)).content[0]?.text).toContain(pending.id);

    await f.controller.decideApprovalRequest({ requestId: pending.id, decision: "approve" });
    expect((await call("merge_pull_request", 1)).isError).toBeFalsy();
    expect(upstream.calls).toHaveBeenCalledTimes(2);
    expect((await f.store.getApprovalRequest(pending.id))?.consumedAt).not.toBeNull();
    // A once-scope approval is consumed by one use.
    const again = await call("merge_pull_request", 1);
    expect(again.isError).toBe(true);
    expect(again.content[0]?.text).not.toContain(pending.id);

    // Different arguments need their own approval.
    const other = await call("merge_pull_request", 2);
    expect(other.isError).toBe(true);
    const requests = await f.store.listApprovalRequests({
      taskId: task.id,
      kind: "surface-action",
      status: "pending",
    });
    expect(requests).toHaveLength(2);
    const second = requests.find((request) => other.content[0]?.text.includes(request.id));
    if (!second) throw new Error("Missing second request");
    await f.controller.decideApprovalRequest({
      requestId: second.id,
      decision: "deny",
      reason: "Pull request 2 is not reviewed",
    });
    const denied = await call("merge_pull_request", 2);
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("denied: Pull request 2 is not reviewed");
    expect(upstream.calls).toHaveBeenCalledTimes(2);

    // An Objective-scope approval covers later matching calls with any arguments.
    const third = requests.find((request) => request.id !== second.id);
    if (!third) throw new Error("Missing remaining request");
    await f.controller.decideApprovalRequest({
      requestId: third.id,
      decision: "approve",
      scope: "objective",
    });
    expect((await call("merge_pull_request", 7)).isError).toBeFalsy();
    expect((await call("merge_pull_request", 8)).isError).toBeFalsy();
    expect(upstream.calls).toHaveBeenCalledTimes(4);

    const types = (await f.store.listTaskEvents(task.id)).map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "approval.approved",
        "approval.consumed",
        "approval.denied",
        "approval.granted-by-scope",
      ]),
    );
    const overview = await f.controller.readObjectiveOverview({ objectiveId: f.objective.id });
    expect(overview.approvals).toMatchObject({ decidedLastDay: { approved: 2, denied: 1 } });
  });

  it("gates target: mcp calls by canonical arguments through the Control Plane", async () => {
    const f = await fixture();
    await f.store.addTagPermission({
      permissionSetId: f.set.id,
      target: "mcp",
      action: "fake/update_*",
      approval: "required",
    });
    await f.store.addTagPermission({
      permissionSetId: f.set.id,
      target: "mcp",
      action: "fake/get_issue",
    });
    const { task, snapshot, caller } = await f.runningTask();
    expect(snapshot.mcp).toEqual([{ action: "fake/get_issue" }, { action: "fake/update_*" }]);
    expect(snapshot.approvals).toEqual(
      expect.arrayContaining([
        {
          target: "mcp",
          action: "fake/update_*",
          permissionSets: [f.set.name],
          approvers: expect.any(Array),
        },
      ]),
    );
    const coordination = await startCoordination(async (name, args) =>
      f.controller.commandAsAttempt(name, args, caller),
    );
    const upstream = await startUpstream(["get_issue", "update_issue", "delete_issue"]);
    const channel = openTaskApprovalChannel({
      coordination: {
        controlPlaneUrl: coordination.url,
        token: "unused",
        objectiveId: f.objective.id,
      },
    });
    if (!channel) throw new Error("Missing approval channel");
    cleanups.push(() => channel.close());
    const bundle = await new HttpMcpToolProvider({
      servers: { fake: { url: upstream.url } },
    }).resolve({ task: { authorization: snapshot } } as unknown as ResolutionContext);
    const [input] = withApprovalRequirements(
      bundle?.inputs ?? [],
      snapshot.approvals,
      () => channel.handle,
    ) as ToolInput[];
    const proxy = await startMcpPolicyProxy(input as ToolInput);
    cleanups.push(() => proxy.close());
    const client = new Client({ name: "approval-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: proxy.headers },
      }),
    );
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "get_issue",
      "update_issue",
    ]);
    const call = async (name: string, arguments_: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: arguments_ })) as {
        isError?: boolean;
        content: { text: string }[];
      };

    expect((await call("delete_issue", { id: "1" })).isError).toBe(true);
    expect((await call("get_issue", { id: "1" })).isError).toBeFalsy();
    const pending = await call("update_issue", { id: "1", status: "resolved" });
    expect(pending.content[0]?.text).toContain("Approval pending");
    const [request] = await f.store.listApprovalRequests({
      taskId: task.id,
      kind: "surface-action",
    });
    expect(request).toMatchObject({
      status: "pending",
      actions: [{ target: "mcp", action: "fake/update_issue", toolName: "update_issue" }],
      ruleSources: [f.set.name],
    });
    if (!request) throw new Error("Missing MCP approval request");
    await f.controller.decideApprovalRequest({ requestId: request.id, decision: "approve" });
    // Changed arguments are not covered by the once-scope approval.
    expect((await call("update_issue", { id: "1", status: "ignored" })).isError).toBe(true);
    expect(upstream.calls).toHaveBeenCalledTimes(1);
    expect((await call("update_issue", { status: "resolved", id: "1" })).isError).toBeFalsy();
    expect(upstream.calls).toHaveBeenLastCalledWith("update_issue", {
      status: "resolved",
      id: "1",
    });
    // The approval was consumed by that one use.
    expect((await call("update_issue", { id: "1", status: "resolved" })).isError).toBe(true);
    expect(upstream.calls).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a gated tool has no approval channel", async () => {
    const upstream = await startUpstream(["merge_pull_request"]);
    const proxy = await startMcpPolicyProxy(githubTool("account", upstream.url, undefined));
    cleanups.push(() => proxy.close());
    const client = new Client({ name: "approval-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: proxy.headers },
      }),
    );
    cleanups.push(() => client.close());
    const result = (await client.callTool({
      name: "merge_pull_request",
      arguments: { owner: "acme", repo: "repo", pullNumber: 1 },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no approval channel");
    expect(upstream.calls).not.toHaveBeenCalled();
  });

  it("reports pending approvals as an Objective attention item and in the digest", async () => {
    const f = await fixture();
    const { caller } = await f.runningTask();
    const requested = (await f.controller.commandAsAttempt(
      "request_action_approval",
      {
        action: {
          target: "surface",
          surfaceAccountId: f.account.id,
          scope: "repository:1",
          action: "pull-requests:merge",
        },
        argumentsDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        summary: "Merge the release pull request",
      },
      caller,
    )) as { status: string; requestId: string };
    expect(requested.status).toBe("pending");
    const overview = await f.controller.readObjectiveOverview({ objectiveId: f.objective.id });
    expect(overview.approvals).toMatchObject({ pending: 1 });
    expect(overview.attention).toContainEqual(
      expect.objectContaining({
        kind: "approvals_pending",
        nextAction: expect.stringContaining(`supertag list approval --objective ${f.objective.id}`),
      }),
    );
    const [digest] = await f.controller["approvals"].digests();
    expect(digest).toMatchObject({ objectiveId: f.objective.id });
    expect(digest?.text).toContain(requested.requestId);
    // The waiting turn's notice names the same request.
    expect(f.notices).toEqual([requested.requestId]);
  });
});

function githubTool(accountId: string, url: string, channel: string | undefined): ToolInput {
  const policy = [
    {
      match: "reference" as const,
      separator: "/",
      components: [{ arguments: ["owner"] }, { arguments: ["repo", "repository"] }],
    },
  ];
  return {
    id: "github-mcp",
    kind: "tool",
    required: true,
    capability: {
      id: `github:${accountId}`,
      provider: "github",
      operations: [
        {
          name: "merge_pull_request",
          effect: "write",
          actions: ["pull-requests:merge"],
          resourceArgumentPolicies: policy,
        },
        {
          name: "create_pull_request",
          effect: "write",
          actions: ["pull-requests:create"],
          resourceArgumentPolicies: policy,
        },
      ],
      authorization: {
        provider: "github",
        resources: [{ surfaceAccountId: accountId, scope: "repository:1", reference: "acme/repo" }],
        approvalRequired: [
          { surfaceAccountId: accountId, scope: "repository:1", action: "pull-requests:merge" },
        ],
        ...(channel === undefined ? {} : { approvalChannel: channel }),
      },
    },
    binding: { kind: "mcp-http", name: "github", url },
  };
}

/** Minimal coordination endpoint that forwards JSON-RPC tool calls to the controller. */
async function startCoordination(
  invoke: (name: string, args: unknown) => Promise<unknown>,
): Promise<{ url: string }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let result: unknown;
    try {
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify(await invoke(rpc.params.name, rpc.params.arguments)),
          },
        ],
      };
    } catch (error) {
      result = {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => closeServer(server));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing address");
  return { url: `http://127.0.0.1:${address.port}` };
}

async function startUpstream(tools: readonly string[]) {
  const calls = vi.fn();
  const app = createMcpExpressApp();
  app.post("/mcp", async (request, response) => {
    const protocol = new McpProtocolServer(
      { name: "approval-upstream", version: "1" },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((name) => ({
        name,
        inputSchema: { type: "object", additionalProperties: true },
      })),
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      calls(params.name, params.arguments);
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await protocol.connect(transport);
    await transport.handleRequest(request, response, request.body);
    response.on("close", () => {
      void transport.close();
      void protocol.close();
    });
  });
  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  cleanups.push(() => closeServer(server));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address");
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls };
}

function closeServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
