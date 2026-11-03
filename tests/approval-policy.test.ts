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
import type { ApprovalRequest, TaskAssignment } from "../packages/core/src/index.js";
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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-approvals-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  cleanups.push(() => store.disconnect());
  const [owner, lead, worker, approver, bystander] = await Promise.all(
    ["owner", "lead", "worker", "release-manager", "bystander"].map((name) =>
      store.createTag({ name: `${name}-${randomUUID()}` }),
    ),
  );
  if (!owner || !lead || !worker || !approver || !bystander) throw new Error("Missing Tags");
  for (const tag of [owner, lead, worker, approver, bystander])
    await store.bindTagWorkerHost(tag.id, "fixture");
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
    approvers: [`tag:${approver.name}`, `tag:${lead.name}`],
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
  const objective = await store.createObjective({
    id: randomUUID(),
    ownerTagId: owner.id,
    outcome: "Release the change",
    runtimeActions: ["commands:execute", "files:write"],
  });
  const team = await store.createTeam({
    id: randomUUID(),
    objectiveId: objective.id,
    name: "Release",
    leadTagId: lead.id,
    memberTagIds: [worker.id, approver.id, bystander.id],
    maxConcurrency: 5,
  });
  const onError = vi.fn();
  const controller = new ObjectiveController(store, undefined, onError);
  controller.activateCoordination({ url: "http://fixture.invalid" });
  // Attempt callers hold real leases under this controller identity, without a scheduling loop.
  const leaseOwner = controller["instanceId"];
  const activate = async (task: TaskAssignment) => {
    const claimed = await store.claimTaskAssignment({ taskId: task.taskId, leaseOwner });
    if (!claimed) throw new Error("Fixture assignment could not be claimed");
    await store.createTaskAttempt({
      workerProfile: { id: "default", revision: "1" },
      taskId: task.taskId,
      attemptNumber: claimed.attemptCount,
      workerSnapshot: {},
      startedAt: new Date().toISOString(),
    });
    await store.startTask({ taskId: task.taskId, startedAt: new Date().toISOString() });
    return claimed;
  };
  const caller = await activate(
    (await controller.command("assign_task", {
      objectiveId: objective.id,
      taskId: `lead-${randomUUID()}`,
      teamId: team.id,
      assignedTagId: lead.id,
      instruction: "Coordinate the release",
      acceptanceCriteria: ["Released"],
    })) as TaskAssignment,
  );
  const assign = (assignedTagId: string, extra: Record<string, unknown> = {}) =>
    controller.command(
      "assign_task",
      {
        taskId: `task-${randomUUID()}`,
        teamId: team.id,
        assignedTagId,
        instruction: "Merge the reviewed release pull request",
        acceptanceCriteria: ["Merged"],
        ...extra,
      },
      caller,
    ) as Promise<TaskAssignment>;
  const approveTask = async (task: TaskAssignment) => {
    const [request] = await store.listApprovalRequests({ taskId: task.taskId, kind: "task" });
    if (!request) throw new Error("Missing Task approval request");
    await controller.decideApprovalRequest({ requestId: request.id, decision: "approve" });
    return request;
  };
  return {
    store,
    controller,
    owner,
    lead,
    worker,
    approver,
    bystander,
    account,
    set,
    objective,
    team,
    caller,
    activate,
    assign,
    approveTask,
    onError,
  };
}

describe("approval: required on permissions", () => {
  it("freezes approval flags and approvers into the Task authorization snapshot", async () => {
    const f = await fixture();
    const task = await f.assign(f.worker.id);
    const stored = await f.store.findTaskById(task.taskId);
    expect(stored?.authorizationSnapshot.permissionSets).toEqual([
      {
        id: f.set.id,
        name: f.set.name,
        approvers: [`tag:${f.approver.name}`, `tag:${f.lead.name}`],
      },
    ]);
    // Requirements are ordered by their canonical key, so `runtime` sorts before `surface`.
    expect(stored?.authorizationSnapshot.approvals).toEqual([
      {
        target: "runtime",
        action: "commands:execute",
        permissionSets: [f.set.name],
        approvers: [`tag:${f.approver.name}`, `tag:${f.lead.name}`].sort(),
      },
      {
        target: "surface",
        surfaceAccountId: f.account.id,
        scope: "repository:1",
        action: "pull-requests:merge",
        permissionSets: [f.set.name],
        approvers: [`tag:${f.approver.name}`, `tag:${f.lead.name}`].sort(),
      },
    ]);
    // Actions granted without approval are not listed.
    expect(JSON.stringify(stored?.authorizationSnapshot.approvals)).not.toContain(
      "pull-requests:create",
    );
    expect(JSON.stringify(stored?.authorizationSnapshot.approvals)).not.toContain("files:write");
  });

  it("holds Task admission for a runtime permission with approval required and bypasses it with an Objective grant", async () => {
    const f = await fixture();
    const held = await f.assign(f.worker.id, { requiresApproval: false });
    expect(held.approval).toBe("pending");
    const [request] = await f.store.listApprovalRequests({ taskId: held.taskId });
    expect(request).toMatchObject({
      kind: "task",
      status: "pending",
      requestingTagId: f.lead.id,
      actions: [{ target: "runtime", action: "commands:execute" }],
      ruleSources: [f.set.name],
    });
    expect((await f.store.listTaskEvents(held.taskId)).map((event) => event.type)).toContain(
      "approval.requested",
    );
    await expect(
      f.controller.listApprovalRequests({ objectiveId: f.objective.id }),
    ).resolves.toMatchObject({ requests: [{ id: request?.id }] });

    await f.controller.decideApprovalRequest({
      requestId: request?.id,
      decision: "approve",
      scope: "objective",
    });
    expect((await f.store.getTaskAssignment(held.taskId))?.approval).toBe("approved");

    const next = await f.assign(f.worker.id);
    expect(next.approval).toBe("approved");
    expect(await f.store.listApprovalRequests({ taskId: next.taskId })).toEqual([]);
    const events = await f.store.listTaskEvents(next.taskId);
    expect(
      events.find((event) => event.type === "approval.granted-by-scope")?.payload,
    ).toMatchObject({ requestId: request?.id, ruleSources: [f.set.name] });
    // A Tag without the runtime permission is not held.
    expect((await f.assign(f.bystander.id)).approval).toBe("approved");
  });

  it("records a manager-requested Task approval and settles it through the direct Task path", async () => {
    const f = await fixture();
    const task = await f.assign(f.bystander.id, { requiresApproval: true });
    const [request] = await f.store.listApprovalRequests({ taskId: task.taskId });
    expect(request).toMatchObject({ kind: "task", actions: [], ruleSources: [], approvers: [] });
    await f.controller.command("update_task", {
      objectiveId: f.objective.id,
      taskId: task.taskId,
      expectedStatus: "queued",
      approval: "approved",
    });
    expect((await f.store.getApprovalRequest(request?.id ?? ""))?.status).toBe("approved");
  });

  it("lets named Tag approvers decide, refuses others and self-approval, and delivers the decision by Mailbox", async () => {
    const f = await fixture();
    const held = await f.assign(f.worker.id);
    const [request] = await f.store.listApprovalRequests({ taskId: held.taskId });
    if (!request) throw new Error("Missing request");
    const approverCaller = await f.activate(await f.assign(f.approver.id));
    const bystanderCaller = await f.activate(await f.assign(f.bystander.id));

    expect(await f.controller.coordinationActions(approverCaller)).toContain("decide_approval");
    expect(await f.controller.coordinationActions(bystanderCaller)).not.toContain(
      "decide_approval",
    );
    expect(await f.controller.coordinationActions(f.caller)).toContain("request_approval");

    await expect(
      f.controller.command(
        "decide_approval",
        { requestId: request.id, decision: "approve" },
        bystanderCaller,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    // The lead is a named approver but requested this Task.
    await expect(
      f.controller.command(
        "decide_approval",
        { requestId: request.id, decision: "approve" },
        f.caller,
      ),
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("own") });
    await expect(
      f.controller.command(
        "decide_approval",
        { requestId: request.id, decision: "deny" },
        approverCaller,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    const decided = (await f.controller.command(
      "decide_approval",
      { requestId: request.id, decision: "deny", reason: "Release freeze until Monday" },
      approverCaller,
    )) as ApprovalRequest;
    expect(decided).toMatchObject({
      status: "denied",
      decidedBy: f.approver.id,
      decidedByKind: "tag",
      reason: "Release freeze until Monday",
    });
    expect((await f.store.getTaskAssignment(held.taskId))?.status).toBe("cancelled");
    const messages = await f.store.listTagMessages(f.lead.id);
    const decision = messages.find(
      (message) =>
        (message.body["approval"] as Record<string, unknown> | undefined)?.["requestId"] ===
        request.id,
    );
    expect(JSON.stringify(decision?.body)).not.toContain(request.summary);
    expect(decision).toMatchObject({
      senderTagId: f.approver.id,
      recipientTagId: f.lead.id,
      objectiveId: f.objective.id,
      body: {
        approval: { decision: "denied", reason: "Release freeze until Monday", kind: "task" },
      },
    });
    const events = await f.store.listTaskEvents(held.taskId);
    expect(events.find((event) => event.type === "approval.denied")?.payload).toMatchObject({
      decidedBy: f.approver.id,
      decidedByKind: "tag",
      reason: "Release freeze until Monday",
      ruleSources: [f.set.name],
    });
    await expect(
      f.controller.decideApprovalRequest({ requestId: request.id, decision: "approve" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("restricts operator decisions when a Permission Set names operator approvers", async () => {
    const f = await fixture();
    await f.store.setTagPermissionSetApprovers(f.set.id, ["operator:release-oncall"]);
    const task = await f.assign(f.worker.id);
    const [request] = await f.store.listApprovalRequests({ taskId: task.taskId });
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
    const task = await f.assign(f.worker.id);
    await f.approveTask(task);
    const workerCaller = await f.activate(task);
    const coordination = await startCoordination(async (name, args) =>
      f.controller.commandAsAttempt(name, args, workerCaller),
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
    expect(first.content[0]?.text).toContain("wait_for");
    expect(upstream.calls).toHaveBeenCalledTimes(1);
    const [pending] = await f.store.listApprovalRequests({
      taskId: task.taskId,
      kind: "surface-action",
    });
    if (!pending) throw new Error("Missing surface approval request");
    expect(first.content[0]?.text).toContain(pending.id);
    expect(pending).toMatchObject({
      status: "pending",
      requestingTagId: f.worker.id,
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
      taskId: task.taskId,
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

    const types = (await f.store.listTaskEvents(task.taskId)).map((event) => event.type);
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
    expect(overview.approvals).toMatchObject({ decidedLastDay: { approved: 3, denied: 1 } });
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
    const task = await f.assign(f.worker.id);
    await f.approveTask(task);
    const workerCaller = await f.activate(task);
    const snapshot = (await f.store.findTaskById(task.taskId))?.authorizationSnapshot;
    expect(snapshot?.mcp).toEqual([{ action: "fake/get_issue" }, { action: "fake/update_*" }]);
    expect(snapshot?.approvals).toEqual(
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
      f.controller.commandAsAttempt(name, args, workerCaller),
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
      snapshot?.approvals,
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
      taskId: task.taskId,
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

  it("creates one plan request whose Objective-scope approval covers every listed action", async () => {
    const f = await fixture();
    const plan = (await f.controller.command(
      "request_approval",
      {
        summary: "Run the schema migration and merge the release pull request.",
        actions: [
          { target: "runtime", action: "commands:execute" },
          {
            target: "surface",
            surfaceAccountId: f.account.id,
            scope: "repository:1",
            action: "pull-requests:merge",
          },
        ],
      },
      f.caller,
    )) as { status: string; requestId: string };
    expect(plan.status).toBe("pending");
    const request = await f.store.getApprovalRequest(plan.requestId);
    expect(request).toMatchObject({ kind: "plan", ruleSources: [f.set.name] });
    // Pending action and plan requests are batched into one digest per Objective.
    const [digest] = await f.controller["approvals"].digests();
    expect(digest).toMatchObject({ objectiveId: f.objective.id });
    expect(digest?.text).toContain(plan.requestId);
    expect(digest?.text).toContain("supertag approve request ID");
    await expect(
      f.controller.decideApprovalRequest({
        requestId: plan.requestId,
        decision: "approve",
        scope: "once",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      f.controller.decideApprovalRequest({ requestId: plan.requestId, decision: "approve" }),
    ).resolves.toMatchObject({ status: "approved", scope: "objective" });
    expect((await f.assign(f.worker.id)).approval).toBe("approved");
    await expect(
      f.controller.command(
        "request_approval",
        { summary: "Same plan", actions: [{ target: "runtime", action: "commands:execute" }] },
        f.caller,
      ),
    ).resolves.toMatchObject({ status: "granted" });
  });

  it("reports pending approvals as an Objective attention item", async () => {
    const f = await fixture();
    await f.assign(f.worker.id);
    const overview = await f.controller.readObjectiveOverview({ objectiveId: f.objective.id });
    expect(overview.approvals).toMatchObject({ pending: 1 });
    expect(overview.attention).toContainEqual(
      expect.objectContaining({
        kind: "approvals_pending",
        nextAction: expect.stringContaining(`supertag list approval --objective ${f.objective.id}`),
      }),
    );
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
