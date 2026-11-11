import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostMcpToolServers } from "../../apps/cli/src/host-mcp.ts";
import { HostServiceWorklet } from "../../apps/cli/src/worker.ts";
import { ControlPlane } from "../../packages/control-plane/src/index.ts";
import {
  type CodexRunRequest,
  createCodexWorker,
} from "../../packages/runtime/harnesses/codex/src/index.ts";
import {
  describeToolCall,
  type ExecutionEnvironment,
  HttpMcpToolProvider,
  startMcpPolicyProxy,
  type ToolInput,
  ToolProviderRegistry,
} from "../../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../../packages/store/src/index.ts";
import {
  postSlackThreadReply,
  slackReplyCapabilities,
} from "../../packages/surfaces/slack/src/index.ts";
import { migrateSqlite } from "../support/database.ts";

const directories: string[] = [];
const servers: HttpServer[] = [];
// The final reply follows a Worker turn and HTTP round trips through the MCP policy proxy.
const replyWait = { timeout: 5_000 };

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Slack to GitHub action lifecycle", () => {
  it("performs one permission-scoped comment and returns its link to Slack", async () => {
    const hosted = await startGitHubMcp();
    const fixture = await createFixture({
      endpoint: hosted.endpoint,
      resource: "repository:atemaguer/supertag",
    });
    const event = slackCommentRequest();

    try {
      await fixture.controlPlane.start();
      await expect(fixture.controlPlane.ingestSurfaceEvent(event)).resolves.toMatchObject({
        status: "accepted",
      });
      await expect(
        fixture.controlPlane.ingestSurfaceEvent({ ...event, eventId: "slack-delivery-twin" }),
      ).resolves.toMatchObject({ status: "duplicate" });
      await vi.waitFor(() => expect(fixture.slackRequest).toHaveBeenCalledTimes(2), replyWait);

      expect(hosted.calls).toHaveBeenCalledOnce();
      expect(hosted.calls).toHaveBeenCalledWith({
        owner: "atemaguer",
        repo: "supertag",
        issue_number: 17,
        body: "The deployment guard is now documented.",
      });
      // The policy proxy adds the host credential upstream; the harness never holds it.
      expect(hosted.requestHeaders).toEqual(
        expect.arrayContaining([{ authorization: "Bearer worker-github-secret" }]),
      );
      expect(fixture.harnessHeaders.join("\n")).not.toContain("worker-github-secret");

      const finalPayload = slackPayload(fixture.slackRequest, 1);
      expect(finalPayload).toMatchObject({ channel: "C123", ts: "reply-ts" });
      expect(finalPayload.text).toContain("Comment added successfully");
      expect(finalPayload.text).toContain("https://github.com/atemaguer/supertag/issues/17");
      expect(taskEvent(fixture.databasePath, "execution.tool.call.completed")).toMatchObject({
        call: {
          capabilityId: "mcp:github",
          binding: { kind: "mcp-http", name: "github" },
          operation: "add_issue_comment",
          effect: "write",
          actions: ["github/add_issue_comment"],
        },
        outcome: { references: ["https://github.com/atemaguer/supertag/issues/17"] },
      });
      expect(taskResult(fixture.databasePath)).toMatchObject({
        changes: [
          {
            summary: "Completed mcp action add_issue_comment",
            reference: "https://github.com/atemaguer/supertag/issues/17",
          },
        ],
      });
      expect(
        JSON.stringify(taskEvent(fixture.databasePath, "execution.tool.call.completed")),
      ).not.toContain("worker-github-secret");
    } finally {
      await fixture.controlPlane.stop();
    }
  });

  it("does not expose a comment tool when the Slack route lacks permission", async () => {
    const hosted = await startGitHubMcp();
    const fixture = await createFixture({
      endpoint: hosted.endpoint,
      resource: undefined,
    });

    try {
      await fixture.controlPlane.start();
      await fixture.controlPlane.ingestSurfaceEvent(slackCommentRequest("slack-denied"));
      await vi.waitFor(() => expect(fixture.slackRequest).toHaveBeenCalledTimes(2), replyWait);

      expect(hosted.calls).not.toHaveBeenCalled();
      expect(fixture.credentials).not.toHaveBeenCalled();
      expect(slackPayload(fixture.slackRequest, 1).text).toContain(
        "I can’t comment because this Tag has no GitHub issue-comment permission here.",
      );
      expect(taskEventTypes(fixture.databasePath)).not.toContain("execution.tool.call.started");
    } finally {
      await fixture.controlPlane.stop();
    }
  });

  it("refuses a comment on a repository the grant does not name, before it reaches GitHub", async () => {
    const hosted = await startGitHubMcp();
    const fixture = await createFixture({
      endpoint: hosted.endpoint,
      resource: "repository:atemaguer/other",
    });

    try {
      await fixture.controlPlane.start();
      await fixture.controlPlane.ingestSurfaceEvent(slackCommentRequest("slack-resource-denied"));
      await vi.waitFor(() => expect(fixture.slackRequest).toHaveBeenCalledTimes(2), replyWait);

      expect(fixture.runner).toHaveBeenCalledOnce();
      expect(hosted.calls).not.toHaveBeenCalled();
      expect(slackPayload(fixture.slackRequest, 1).text).not.toContain(
        "https://github.com/atemaguer/supertag/issues/17",
      );
    } finally {
      await fixture.controlPlane.stop();
    }
  });
});

async function createFixture(options: {
  readonly endpoint: string;
  /** The repository the github/add_issue_comment grant names; undefined grants nothing. */
  readonly resource: string | undefined;
}) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-github-action-"));
  directories.push(directory);
  const workspace = join(directory, "source-workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "input.txt"), "GitHub action fixture input");
  const databasePath = join(directory, "supertag.db");
  await migrateSqlite(databasePath);
  const store = new DrizzleStore({ url: `file:${databasePath}` });
  await store.connect();
  const slack = await store.saveSurfaceAccount({
    provider: "slack",
    externalAccountId: "T123",
    displayName: "Acme",
    authMethod: "slack-socket-mode",
    credentialId: "test/slack",
    status: "connected",
    configuration: { transport: "socket" },
    verifiedAt: "2026-08-13T00:00:00.000Z",
  });
  const tag = await store.createTag({
    name: "engineering",
  });
  await store.bindTagWorkerHost(tag.id, "github-action-host");
  const route = await store.addTagRoute({
    tagId: tag.id,
    surfaceAccountId: slack.id,
    scope: "channel:C123",
  });
  if (options.resource !== undefined) {
    const set = await store.createTagPermissionSet({ tagId: tag.id, name: "github-actions" });
    await store.addTagPermission({
      target: "mcp",
      permissionSetId: set.id,
      action: "github/add_issue_comment",
      resource: options.resource,
    });
    await store.activateTagPermissionSet({ permissionSetId: set.id, tagRouteId: route.id });
  }
  await store.disconnect();

  // The host's auth for its github preset server, as the Worker's mcpHeaders hook gives it.
  const credentials = vi.fn(async () => ({ authorization: "Bearer worker-github-secret" }));
  const harnessHeaders: string[] = [];
  const runner = vi.fn(actionRunner(harnessHeaders));
  const worker = createCodexWorker({
    workerId: "github-action-worker",
    profileId: "github-action-codex",
    profileRevision: "1",
    workspace,
    runner,
    toolProviders: new ToolProviderRegistry([
      new HttpMcpToolProvider({
        servers: hostMcpToolServers({ github: { preset: "github", url: options.endpoint } }),
        headers: credentials,
      }),
    ]),
  });
  const slackRequest = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ ok: true, channel: "C123", ts: "reply-ts" }));
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
    worklet: new HostServiceWorklet("github-action-worklet", "github-action-host", [worker], {}, [
      "github",
    ]),
    reply: Object.assign(
      async (event, presentation, _account, delivery) => {
        return await postSlackThreadReply(event, presentation, {
          botToken: "xoxb-test",
          ...(delivery.replaceExternalMessageId === undefined
            ? {}
            : { replaceMessageTs: delivery.replaceExternalMessageId }),
          request: slackRequest,
        });
      },
      { capabilities: () => slackReplyCapabilities },
    ),
    dispatch: {
      pollIntervalMs: 5,
      retryBaseMs: 5,
      maxAttempts: 1,
      onDispatchError: () => undefined,
    },
  });
  return {
    controlPlane,
    databasePath,
    credentials,
    harnessHeaders,
    runner,
    slackRequest,
  };
}

/**
 * Stands in for Codex. An injected runner gets the resolved tool inputs instead of policy
 * proxies, so it starts the same per-Task policy proxy the Codex harness starts and talks to
 * GitHub only through it, as the harness process does.
 */
function actionRunner(harnessHeaders: string[]) {
  return async function* (request: CodexRunRequest, _environment: ExecutionEnvironment) {
    const input = request.toolInputs.find((tool) => tool.id === "mcp:github");
    if (input === undefined) {
      yield {
        type: "output.message" as const,
        text: "I can’t comment because this Tag has no GitHub issue-comment permission here.",
      };
      return;
    }
    const proxy = await startMcpPolicyProxy(input as ToolInput);
    harnessHeaders.push(proxy.url, JSON.stringify(proxy.headers));
    const arguments_ = {
      owner: "atemaguer",
      repo: "supertag",
      issue_number: 17,
      body: "The deployment guard is now documented.",
    };
    const call = describeToolCall(request.toolInputs, {
      id: "github-comment-call-1",
      binding: { kind: "mcp-http", name: "github" },
      operation: "add_issue_comment",
      arguments: arguments_,
    });
    yield { type: "tool.call.started" as const, call };

    const client = new Client({ name: "supertag-action-e2e", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(proxy.url), {
          requestInit: { headers: proxy.headers },
        }),
      );
      const tools = await client.listTools();
      if (!tools.tools.some((tool) => tool.name === "add_issue_comment")) {
        throw new Error("GitHub MCP did not expose add_issue_comment");
      }
      const result = await client.callTool({ name: "add_issue_comment", arguments: arguments_ });
      if (result.isError === true) {
        yield { type: "output.message" as const, text: firstText(result.content) };
        return;
      }
      const reference = JSON.parse(firstText(result.content))["url"];
      if (typeof reference !== "string") throw new Error("GitHub MCP omitted the issue URL");
      yield {
        type: "tool.call.completed" as const,
        call,
        outcome: { references: [reference] },
      };
      yield {
        type: "output.message" as const,
        text: `Comment added successfully: ${reference}`,
      };
    } finally {
      await client.close();
      await proxy.close();
    }
  };
}

async function startGitHubMcp() {
  const calls = vi.fn();
  const requestHeaders: Record<string, string | undefined>[] = [];
  const app = createMcpExpressApp();
  app.post("/mcp", async (request, response) => {
    requestHeaders.push({ authorization: request.header("authorization") });
    if (request.header("authorization") !== "Bearer worker-github-secret") {
      response.status(401).json({ error: "credential rejected" });
      return;
    }
    const protocol = new McpProtocolServer(
      { name: "github-action-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "add_issue_comment",
          description: "Add a comment to an issue",
          inputSchema: { type: "object", additionalProperties: true },
        },
      ],
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async (toolRequest) => {
      const input = toolRequest.params.arguments ?? {};
      if (
        input["owner"] !== "atemaguer" ||
        input["repo"] !== "supertag" ||
        input["issue_number"] !== 17
      ) {
        return { isError: true, content: [{ type: "text", text: "repository is not allowed" }] };
      }
      calls(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: 9001,
              url: "https://github.com/atemaguer/supertag/issues/17",
            }),
          },
        ],
      };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await protocol.connect(transport);
    await transport.handleRequest(request, response, request.body);
    response.on("close", () => {
      void transport.close();
      void protocol.close();
    });
  });
  const listener = await new Promise<HttpServer>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(listener);
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("MCP server has no port");
  return {
    calls,
    requestHeaders,
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
  };
}

function slackCommentRequest(eventId = "slack-comment-1") {
  return {
    eventId,
    logicalEventId: "slack-comment-logical-1",
    provider: "slack" as const,
    externalAccountId: "T123",
    kind: "mention" as const,
    scope: "channel:C123",
    sessionKey: "slack:T123:C123:thread-1",
    actor: { id: "U123", displayName: "Atem", kind: "user" as const },
    text: "@SuperTag comment on atemaguer/supertag issue 17 that the deployment guard is documented",
    occurredAt: "2026-08-13T00:00:00.000Z",
    callback: {
      provider: "slack" as const,
      mode: "slack_thread" as const,
      threadKey: "thread-1",
      target: { channelId: "C123", threadTs: "thread-1" },
    },
    source: { channelId: "C123" },
    metadata: {},
  };
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) throw new Error("MCP response content is invalid");
  const block = content.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as { type?: unknown }).type === "text" &&
      typeof (candidate as { text?: unknown }).text === "string",
  ) as { readonly text: string } | undefined;
  if (block === undefined) throw new Error("MCP response did not contain text");
  return block.text;
}

function slackPayload(request: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  return JSON.parse(String(request.mock.calls[index]?.[1]?.body)) as {
    readonly channel: string;
    readonly thread_ts: string;
    readonly text: string;
  };
}

function taskEvent(databasePath: string, type: string): Record<string, unknown> {
  const database = new Database(databasePath, { readonly: true });
  try {
    const payload = database
      .prepare("SELECT payload FROM TaskEvent WHERE type = ? LIMIT 1")
      .pluck()
      .get(type);
    if (typeof payload !== "string") throw new Error(`Task event ${type} was not recorded`);
    return JSON.parse(payload) as Record<string, unknown>;
  } finally {
    database.close();
  }
}

function taskEventTypes(databasePath: string): readonly string[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .prepare("SELECT type FROM TaskEvent ORDER BY sequence")
      .pluck()
      .all() as string[];
  } finally {
    database.close();
  }
}

function taskResult(databasePath: string): Record<string, unknown> {
  const database = new Database(databasePath, { readonly: true });
  try {
    const result = database
      .prepare("SELECT result FROM Task WHERE result IS NOT NULL LIMIT 1")
      .pluck()
      .get();
    if (typeof result !== "string") throw new Error("Task result was not stored");
    return JSON.parse(result) as Record<string, unknown>;
  } finally {
    database.close();
  }
}
