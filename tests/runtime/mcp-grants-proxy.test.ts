import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { hostMcpToolServers, MCP_PRESETS } from "../../apps/cli/src/host-mcp.ts";
import {
  approvalArgumentsDigest,
  type TagApprovalRequirement,
  type TagMcpGrant,
  taskWorkspaceBranch,
} from "../../packages/core/src/index.ts";
import {
  connectWorkerMcpClient,
  HttpMcpToolProvider,
  type McpResourceMapping,
  openTaskApprovalChannel,
  type ResolutionContext,
  startMcpPolicyProxy,
  type ToolInput,
  ToolProviderRegistry,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
  withApprovalRequirements,
} from "../../packages/runtime/sdk/src/index.ts";
import { createRepository, git, isolateGitConfiguration } from "../support/git-repository.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Tools the fake server advertises, including look-alikes of granted names. */
const ADVERTISED = [
  "get_issue",
  "get_event",
  "Get_Issue",
  "get_іssue", // Cyrillic і
  "get issue",
  "update_issue",
  "create_pull_request",
  "merge_pull_request",
  "search_code",
];

const GITHUB_LIKE: McpResourceMapping = {
  tools: {
    create_pull_request: [
      {
        prefix: "repository:",
        separator: "/",
        components: [{ arguments: ["owner"] }, { arguments: ["repo", "repository"] }],
      },
    ],
    merge_pull_request: [
      {
        prefix: "repository:",
        separator: "/",
        components: [{ arguments: ["owner"] }, { arguments: ["repo", "repository"] }],
      },
    ],
  },
};

describe("target: mcp grants through the per-Task policy proxy", () => {
  it("lists only granted tools, matching globs exactly and case-sensitively", async () => {
    const upstream = await startFakeMcpServer();
    const [input] = await resolveTools(upstream.url, [{ action: "fake/get_*" }]);
    expect(input?.capability.operations.map((operation) => operation.name)).toEqual([
      "get_event",
      "get_issue",
    ]);
    const client = await connectThroughProxy(input as ToolInput);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["get_event", "get_issue"]);
  });

  it.each([
    ["an ungranted tool", "update_issue"],
    ["a different case", "Get_Issue"],
    ["a homoglyph", "get_іssue"],
    ["an encoded name", "get%5Fissue"],
    ["padding", " get_issue"],
    ["a path suffix", "get_issue/../update_issue"],
    ["a null byte", "get_issue\u0000"],
  ])("refuses %s without contacting the server", async (_label, name) => {
    const upstream = await startFakeMcpServer();
    const [input] = await resolveTools(upstream.url, [{ action: "fake/get_*" }]);
    const client = await connectThroughProxy(input as ToolInput);
    const result = (await client.callTool({ name, arguments: {} })) as DeniedResult;
    expect(result.isError).toBe(true);
    expect(upstream.calls).not.toHaveBeenCalled();
    const granted = (await client.callTool({ name: "get_issue", arguments: {} })) as DeniedResult;
    expect(granted.isError).toBeFalsy();
    expect(upstream.calls).toHaveBeenCalledWith("get_issue", {});
  });

  it.each([
    ["get_*", ["get_event", "get_issue"]],
    ["*_issue", ["get_issue", "update_issue"]],
    ["*", ADVERTISED.filter((name) => /^[A-Za-z0-9_.-]+$/u.test(name)).sort()],
    ["get_issue", ["get_issue"]],
    ["get_issu", []],
    ["*pull*", ["create_pull_request", "merge_pull_request"]],
    ["get_*_x", []],
  ])("glob %s grants exactly %j", async (pattern, expected) => {
    const upstream = await startFakeMcpServer();
    const resolving = resolveTools(upstream.url, [{ action: `fake/${pattern}` }]);
    if (expected.length === 0) {
      await expect(resolving).rejects.toThrow(/offers none of the tools/u);
      return;
    }
    const [input] = await resolving;
    expect(input?.capability.operations.map((operation) => operation.name)).toEqual(expected);
  });

  it("requires a mapped resource argument for a resource-scoped grant", async () => {
    const upstream = await startFakeMcpServer();
    const [input] = await resolveTools(
      upstream.url,
      [{ action: "fake/create_pull_request", resource: "repository:acme/api" }],
      GITHUB_LIKE,
    );
    const client = await connectThroughProxy(input as ToolInput);
    const call = (arguments_: Record<string, unknown>) =>
      client.callTool({ name: "create_pull_request", arguments: arguments_ }) as Promise<
        DeniedResult & { content: { text: string }[] }
      >;
    const bypasses: Record<string, unknown>[] = [
      {},
      { owner: "acme" },
      { repo: "api" },
      { owner: "acme", repo: "web" },
      { owner: "ACME", repo: "api" },
      { owner: "acme", repo: "API" },
      { owner: "acme", repo: " api" },
      { owner: "acme", repo: "api " },
      { owner: "acme", repo: "api/../web" },
      { owner: "acme/api", repo: "x" },
      { owner: "acme", repo: "api\u0000" },
      { owner: "acme", repo: "ap​i" },
      { owner: "acme", repo: "api%2F..%2Fweb" },
      { owner: "acme", repo: ["api"] },
      { owner: "acme", repo: { value: "api" } },
      { owner: "acme", repo: 7 },
      { owner: "acme", repo: "api", repository: "web" },
      { owner: "acme", repo: "", repository: "api" },
    ];
    for (const arguments_ of bypasses) {
      const result = await call(arguments_);
      expect(result.isError, JSON.stringify(arguments_)).toBe(true);
    }
    expect(upstream.calls).not.toHaveBeenCalled();
    expect((await call({ owner: "acme", repo: "api" })).isError).toBeFalsy();
    expect((await call({ owner: "acme", repository: "api" })).isError).toBeFalsy();
    // The same value under both alternative names is one resource, not an ambiguity.
    expect((await call({ owner: "acme", repo: "api", repository: "api" })).isError).toBeFalsy();
    expect(upstream.calls).toHaveBeenCalledTimes(3);
  });

  it("admits a tool on any resource only when a grant without a resource covers it", async () => {
    const upstream = await startFakeMcpServer();
    const [input] = await resolveTools(
      upstream.url,
      [
        { action: "fake/create_pull_request", resource: "repository:acme/api" },
        { action: "fake/merge_*" },
      ],
      GITHUB_LIKE,
    );
    const client = await connectThroughProxy(input as ToolInput);
    const merge = (await client.callTool({
      name: "merge_pull_request",
      arguments: { owner: "other", repo: "repo" },
    })) as DeniedResult;
    expect(merge.isError).toBeFalsy();
    const create = (await client.callTool({
      name: "create_pull_request",
      arguments: { owner: "other", repo: "repo" },
    })) as DeniedResult;
    expect(create.isError).toBe(true);
    expect(upstream.calls).toHaveBeenCalledTimes(1);
  });

  it("refuses a resource-scoped grant on a server without a resource mapping", async () => {
    const upstream = await startFakeMcpServer();
    await expect(
      resolveTools(upstream.url, [
        { action: "fake/create_pull_request", resource: "repository:acme/api" },
      ]),
    ).rejects.toThrow(/has no resource mapping/u);
    expect(upstream.calls).not.toHaveBeenCalled();
  });

  it("fails before the harness starts when the host does not provide a granted server", async () => {
    const provider = new HttpMcpToolProvider({ servers: {} });
    await expect(provider.resolve(context([{ action: "sentry/get_issue" }]))).rejects.toThrow(
      /does not provide/u,
    );
  });

  it("rejects an insecure Workspace server before listing its tools", async () => {
    const provider = new HttpMcpToolProvider({
      servers: {},
      workspaceServers: () => [{ name: "fake", url: "http://example.test/mcp", headers: {} }],
    });
    await expect(provider.resolve(context([{ action: "fake/get_issue" }]))).rejects.toThrow(
      /must use HTTPS/u,
    );
  });

  it("holds an approval: required call until the exact canonical arguments are approved", async () => {
    const upstream = await startFakeMcpServer();
    const approved = new Set<string>();
    const asked: { action: unknown; argumentsDigest: string }[] = [];
    const [input] = await resolveTools(
      upstream.url,
      [{ action: "fake/update_issue" }, { action: "fake/get_issue" }],
      undefined,
      [mcpApproval("fake/update_*")],
      approvalTransport(approved, asked),
    );
    const client = await connectThroughProxy(input as ToolInput);
    const update = (arguments_: Record<string, unknown>) =>
      client.callTool({ name: "update_issue", arguments: arguments_ }) as Promise<
        DeniedResult & { content: { text: string }[] }
      >;

    expect((await client.callTool({ name: "get_issue", arguments: {} })).isError).toBeFalsy();
    const pending = await update({ id: "1", status: "resolved" });
    expect(pending.isError).toBe(true);
    expect(pending.content[0]?.text).toContain("Approval pending");
    expect(asked[0]?.action).toEqual({
      target: "mcp",
      action: "fake/update_issue",
      toolName: "update_issue",
    });
    expect(upstream.calls).toHaveBeenCalledTimes(1);

    approved.add(approvalArgumentsDigest({ id: "1", status: "resolved" }));
    // Changed arguments are a different call and need their own approval.
    expect((await update({ id: "1", status: "ignored" })).isError).toBe(true);
    expect((await update({ id: "2", status: "resolved" })).isError).toBe(true);
    expect((await update({ id: "1", status: "resolved", extra: true })).isError).toBe(true);
    expect(upstream.calls).toHaveBeenCalledTimes(1);
    // Key order does not change the canonical arguments.
    expect((await update({ status: "resolved", id: "1" })).isError).toBeFalsy();
    expect(upstream.calls).toHaveBeenLastCalledWith("update_issue", {
      status: "resolved",
      id: "1",
    });
  });

  it("applies a resource-scoped approval requirement, and to calls with no resource", async () => {
    const upstream = await startFakeMcpServer();
    const asked: { action: unknown; argumentsDigest: string }[] = [];
    const [input] = await resolveTools(
      upstream.url,
      [{ action: "fake/merge_pull_request" }],
      GITHUB_LIKE,
      [mcpApproval("fake/merge_pull_request", "repository:acme/api")],
      approvalTransport(new Set(), asked),
    );
    const client = await connectThroughProxy(input as ToolInput);
    const merge = (arguments_: Record<string, unknown>) =>
      client.callTool({
        name: "merge_pull_request",
        arguments: arguments_,
      }) as Promise<DeniedResult>;
    // Another repository is outside the requirement.
    expect((await merge({ owner: "acme", repo: "web" })).isError).toBeFalsy();
    expect((await merge({ owner: "acme", repo: "api" })).isError).toBe(true);
    expect(asked.at(-1)?.action).toMatchObject({ resource: "repository:acme/api" });
    // Without a resource argument, the requirement still applies.
    expect((await merge({ pull: 1 })).isError).toBe(true);
    expect(asked.at(-1)?.action).not.toHaveProperty("resource");
    expect((await merge({ owner: "acme", repo: "api", repository: "web" })).isError).toBe(true);
    expect(upstream.calls).toHaveBeenCalledTimes(1);
  });

  it("fails closed without an approval channel or when the check fails", async () => {
    const upstream = await startFakeMcpServer();
    const [unchanneled] = await resolveTools(
      upstream.url,
      [{ action: "fake/update_issue" }],
      undefined,
      [mcpApproval("fake/update_issue")],
    );
    const first = await connectThroughProxy(unchanneled as ToolInput);
    const denied = (await first.callTool({
      name: "update_issue",
      arguments: {},
    })) as DeniedResult & {
      content: { text: string }[];
    };
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("no approval channel");

    const [failing] = await resolveTools(
      upstream.url,
      [{ action: "fake/update_issue" }],
      undefined,
      [mcpApproval("fake/update_issue")],
      async () => new Response("unavailable", { status: 503 }),
    );
    const second = await connectThroughProxy(failing as ToolInput);
    expect((await second.callTool({ name: "update_issue", arguments: {} })).isError).toBe(true);
    expect(upstream.calls).not.toHaveBeenCalled();
  });

  it("injects host headers upstream through the auth hook, never through the proxy URL", async () => {
    const upstream = await startFakeMcpServer();
    const provider = new HttpMcpToolProvider({
      servers: { fake: { url: upstream.url } },
      headers: ({ server }) => ({ "x-test-credential": `secret-for-${server}` }),
    });
    const bundle = await new ToolProviderRegistry([provider]).resolve(
      context([{ action: "fake/get_issue" }]),
    );
    const [input] = bundle;
    expect(input?.binding).toMatchObject({
      runtimeHeaders: { "x-test-credential": "secret-for-fake" },
    });
    const proxy = await startMcpPolicyProxy(input as ToolInput);
    cleanups.push(() => proxy.close());
    expect(proxy.url).not.toContain("secret");
    const client = new Client({ name: "harness", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: proxy.headers },
      }),
    );
    cleanups.push(() => client.close());
    await client.callTool({ name: "get_issue", arguments: {} });
    expect(upstream.headers.at(-1)?.["x-test-credential"]).toBe("secret-for-fake");
    expect(JSON.stringify(proxy.headers)).not.toContain("secret-for-fake");
  });

  it("checks resource grants on a host preset server through the preset's mapping", async () => {
    const upstream = await startFakeMcpServer();
    const servers = hostMcpToolServers({
      github: { url: upstream.url, preset: "github" },
      plain: { url: upstream.url },
    });
    expect(servers).toEqual({
      github: { url: upstream.url, resources: MCP_PRESETS.github.resources },
      plain: { url: upstream.url },
    });
    const provider = new HttpMcpToolProvider({ servers });
    const [input] = await new ToolProviderRegistry([provider]).resolve(
      context([{ action: "github/create_pull_request", resource: "repository:acme/api" }]),
    );
    const client = await connectThroughProxy(input as ToolInput);
    const denied = (await client.callTool({
      name: "create_pull_request",
      arguments: { owner: "acme", repo: "web" },
    })) as DeniedResult;
    expect(denied.isError).toBe(true);
    expect(upstream.calls).not.toHaveBeenCalled();
    const admitted = (await client.callTool({
      name: "create_pull_request",
      arguments: { owner: "acme", repo: "api" },
    })) as DeniedResult;
    expect(admitted.isError).toBeFalsy();
    expect(upstream.calls).toHaveBeenCalledOnce();
    // A server without a preset mapping cannot take resource-scoped grants.
    await expect(
      new ToolProviderRegistry([provider]).resolve(
        context([{ action: "plain/create_pull_request", resource: "repository:acme/api" }]),
      ),
    ).rejects.toThrow();
  });

  it("rejects a Workspace server that shares a host server name, even without grants", async () => {
    const url = "http://127.0.0.1:9/mcp";
    const provider = new HttpMcpToolProvider({
      servers: { fake: { url } },
      workspaceServers: () => [{ name: "fake", url, headers: {} }],
    });
    await expect(provider.resolve(context([]))).rejects.toThrow(
      /Workspace MCP server fake conflicts with a host MCP server/u,
    );
  });

  it("strips Workspace credentials on cross-origin redirects during discovery and proxy calls", async () => {
    const upstream = await startFakeMcpServer();
    const originHeaders: Array<string | string[] | undefined> = [];
    const redirect = createServer((request, response) => {
      originHeaders.push(request.headers["x-workspace-secret"]);
      response.writeHead(307, { Location: upstream.url });
      response.end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => redirect.close(() => resolve())));
    const address = redirect.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing redirect address");
    const provider = new HttpMcpToolProvider({
      servers: {},
      workspaceServers: () => [
        {
          name: "fake",
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { "x-workspace-secret": "checkout-secret" },
        },
      ],
    });
    const [input] = await new ToolProviderRegistry([provider]).resolve(
      context([{ action: "fake/get_issue" }]),
    );
    const client = await connectThroughProxy(input as ToolInput);
    await client.callTool({ name: "get_issue", arguments: {} });
    expect(originHeaders.length).toBeGreaterThan(1);
    expect(originHeaders.every((value) => value === "checkout-secret")).toBe(true);
    expect(upstream.headers.length).toBeGreaterThan(1);
    for (const headers of upstream.headers) expect(headers["x-workspace-secret"]).toBeUndefined();
    expect(upstream.calls).toHaveBeenCalledOnce();
  });

  it("refuses a local caller without this Task Attempt's proxy secret", async () => {
    const upstream = await startFakeMcpServer();
    const [input] = await resolveTools(upstream.url, [{ action: "fake/get_issue" }]);
    const proxy = await startMcpPolicyProxy(input as ToolInput);
    cleanups.push(() => proxy.close());
    const other = await startMcpPolicyProxy(input as ToolInput);
    cleanups.push(() => other.close());
    expect(proxy.headers["Authorization"]).toMatch(/^Bearer [\w-]{43}$/u);
    expect(other.headers["Authorization"]).not.toBe(proxy.headers["Authorization"]);
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_issue", arguments: {} },
    });
    const post = (headers: Record<string, string>) =>
      fetch(proxy.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: call,
      });
    const refused = [
      {},
      { Authorization: other.headers["Authorization"] as string },
      { Authorization: "Bearer " },
      { Authorization: `${proxy.headers["Authorization"]}x` },
      { Authorization: (proxy.headers["Authorization"] as string).toLowerCase() },
    ];
    for (const headers of refused) {
      const response = await post(headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    const anonymous = new Client({ name: "other-task", version: "1" });
    await expect(
      anonymous.connect(new StreamableHTTPClientTransport(new URL(proxy.url))),
    ).rejects.toThrow();
    expect(upstream.calls).not.toHaveBeenCalled();
    const client = await connectThroughExistingProxy(proxy);
    await client.callTool({ name: "get_issue", arguments: {} });
    expect(upstream.calls).toHaveBeenCalledOnce();
  });

  it("uses checkout MCP servers through the policy proxy without exposing resolved headers", async () => {
    const upstream = await startFakeMcpServer();
    const restoreGit = await isolateGitConfiguration();
    cleanups.push(restoreGit);
    const checkout = await createRepository();
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    await writeFile(
      join(checkout, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fake: {
            type: "http",
            url: upstream.url,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Test fixture uses a literal environment reference.
            headers: { "x-test-credential": "${SUPERTAG_MCP_TEST_SECRET}" },
          },
        },
      }),
    );
    git(checkout, "add", ".mcp.json");
    git(checkout, "commit", "--quiet", "-m", "Declare fake MCP server");
    vi.stubEnv("SUPERTAG_MCP_TEST_SECRET", "checkout-secret");
    cleanups.push(() => vi.unstubAllEnvs());
    const worktreeRoot = await mkdtemp(join(tmpdir(), "supertag-mcp-proxy-worktree-"));
    cleanups.push(() => rm(worktreeRoot, { recursive: true, force: true }));
    const workspaces = new WorkspaceResolverRegistry([
      new WorkspaceEnvironmentResolver({
        checkouts: [{ name: "app", path: checkout }],
        worktreeRoot,
      }),
    ]);
    const resolution = context([{ action: "fake/get_issue" }]);
    const task = {
      ...resolution.task,
      workspacePlan: {
        version: 1,
        status: "workspace",
        workspace: "app",
        branch: taskWorkspaceBranch("objective-1", "task-1"),
        delivery: "branch",
        mcp: ["fake"],
      },
    } as unknown as typeof resolution.task;
    const prepared = await workspaces.resolve({ ...resolution, task });
    expect(JSON.stringify(prepared)).not.toContain("checkout-secret");
    const provider = new HttpMcpToolProvider({
      servers: {},
      workspaceServers: (attemptId) => workspaces.mcpServersForAttempt(attemptId),
    });
    const [input] = await new ToolProviderRegistry([provider]).resolve({ ...resolution, task });
    expect(input?.capability.operations.map((operation) => operation.name)).toEqual(["get_issue"]);
    const client = await connectThroughProxy(input as ToolInput);
    expect((await client.callTool({ name: "update_issue", arguments: {} })).isError).toBe(true);
    await client.callTool({ name: "get_issue", arguments: {} });
    expect(upstream.headers.at(-1)?.["x-test-credential"]).toBe("checkout-secret");
    expect(upstream.calls).toHaveBeenCalledTimes(1);
    await workspaces.finalize(task, "failed");
    expect(workspaces.mcpServersForAttempt(task.attemptId)).toEqual([]);
  });

  it("enforces the same grants in the Worker-owned MCP client", async () => {
    const upstream = await startFakeMcpServer();
    const [input] = await resolveTools(
      upstream.url,
      [{ action: "fake/create_pull_request", resource: "repository:acme/api" }],
      GITHUB_LIKE,
    );
    const connection = await connectWorkerMcpClient(input as ToolInput);
    cleanups.push(() => connection.close());
    expect(connection.tools.map((tool) => tool.name)).toEqual(["create_pull_request"]);
    await expect(connection.callTool("update_issue", {})).rejects.toThrow(/not admitted/u);
    await expect(
      connection.callTool("create_pull_request", { owner: "acme", repo: "web" }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      connection.callTool("create_pull_request", { owner: "acme", repo: "api" }),
    ).resolves.toMatchObject({ isError: false });
    expect(upstream.calls).toHaveBeenCalledTimes(1);
  });
});

type DeniedResult = { readonly isError?: boolean };

function mcpApproval(
  action: string,
  resource?: string,
): Extract<TagApprovalRequirement, { target: "mcp" }> {
  return {
    target: "mcp",
    action,
    ...(resource === undefined ? {} : { resource }),
    permissionSets: ["triage"],
    approvers: [],
  };
}

function context(
  grants: readonly TagMcpGrant[],
  approvals: readonly TagApprovalRequirement[] = [],
): ResolutionContext {
  return {
    task: {
      taskId: "task-1",
      attemptId: "attempt-1",
      authorization: {
        version: 4,
        runtimeActions: [],
        resources: [],
        mcp: grants,
        ...(approvals.length ? { approvals } : {}),
      },
    },
    profile: { harness: { provider: "codex" } },
  } as unknown as ResolutionContext;
}

async function resolveTools(
  url: string,
  grants: readonly TagMcpGrant[],
  resources?: McpResourceMapping,
  approvals: readonly TagApprovalRequirement[] = [],
  transport?: typeof fetch,
): Promise<readonly ToolInput[]> {
  const provider = new HttpMcpToolProvider({
    servers: { fake: { url, ...(resources === undefined ? {} : { resources }) } },
  });
  const resolution = context(grants, approvals);
  const inputs = await new ToolProviderRegistry([provider]).resolve(resolution);
  return withApprovalRequirements(inputs, approvals, () => {
    if (transport === undefined) return undefined;
    const channel = openTaskApprovalChannel(
      {
        coordination: {
          controlPlaneUrl: "http://127.0.0.1:9",
          token: "unused",
          objectiveId: "objective-1",
        },
      },
      transport,
    );
    if (channel === undefined) return undefined;
    cleanups.push(() => channel.close());
    return channel.handle;
  }) as ToolInput[];
}

/** A Control Plane stand-in that grants only calls whose argument digest was approved. */
function approvalTransport(
  approved: ReadonlySet<string>,
  asked: { action: unknown; argumentsDigest: string }[],
): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const rpc = JSON.parse(String(init?.body)) as {
      id: number;
      params: { arguments: { action: unknown; argumentsDigest: string } };
    };
    asked.push(rpc.params.arguments);
    const status = approved.has(rpc.params.arguments.argumentsDigest) ? "granted" : "pending";
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: JSON.stringify({ status, requestId: "r1" }) }] },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

async function connectThroughProxy(input: ToolInput): Promise<Client> {
  const proxy = await startMcpPolicyProxy(input);
  cleanups.push(() => proxy.close());
  return await connectThroughExistingProxy(proxy);
}

async function connectThroughExistingProxy(proxy: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}): Promise<Client> {
  const client = new Client({ name: "harness", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(proxy.url), {
      requestInit: { headers: proxy.headers },
    }),
  );
  cleanups.push(() => client.close());
  return client;
}

async function startFakeMcpServer() {
  const calls = vi.fn();
  const headers: Record<string, string | string[] | undefined>[] = [];
  const app = createMcpExpressApp();
  app.post("/mcp", async (request, response) => {
    headers.push({ ...request.headers });
    const protocol = new McpProtocolServer(
      { name: "fake-upstream", version: "1" },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ADVERTISED.map((name) => ({
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
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address");
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls, headers };
}
