import type { Server as HttpServer } from "node:http";
import { createConnection } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMcpPolicyProxy, type ToolInput } from "../../packages/runtime/sdk/src/index.ts";

const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

describe("Worker-local MCP policy proxy", () => {
  it("closes incomplete model requests promptly and supports repeated cleanup", async () => {
    const proxy = await startMcpPolicyProxy(
      toolInput("slack", "channel:C1", undefined, "http://127.0.0.1:1/mcp"),
    );
    const url = new URL(proxy.url);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{");
    try {
      await Promise.all([proxy.close(), proxy.close()]);
      await proxy.close();
    } finally {
      socket.destroy();
      await proxy.close();
    }
  }, 1500);

  it.each([
    [
      "github",
      "repository:123",
      "acme/repo",
      { owner: "acme", repo: "repo" },
      { owner: "acme", repo: "other" },
    ],
    ["slack", "channel:C1", undefined, { channel_id: "C1" }, { channel_id: "C2" }],
    ["linear", "team:T1", undefined, { teamId: "T1" }, { teamId: "T2" }],
    [
      "teams",
      "team:T1/channel:C1",
      undefined,
      { teamId: "T1", channelId: "C1" },
      { teamId: "T1", channelId: "C2" },
    ],
  ] as const)(
    "forwards only admitted %s resource arguments",
    async (provider, scope, reference, admitted, denied) => {
      const upstream = await startUpstream();
      const proxy = await startMcpPolicyProxy(toolInput(provider, scope, reference, upstream.url));
      const client = new Client({ name: "policy-test", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(proxy.url), {
            requestInit: { headers: proxy.headers },
          }),
        );
        await expect(client.callTool({ name: "act", arguments: denied })).resolves.toMatchObject({
          isError: true,
        });
        expect(upstream.calls).not.toHaveBeenCalled();
        await expect(client.callTool({ name: "act", arguments: admitted })).resolves.toMatchObject({
          isError: false,
        });
        expect(upstream.calls).toHaveBeenCalledOnce();
      } finally {
        await client.close();
        await proxy.close();
      }
    },
  );

  it("fails closed when a call has no checkable resource argument", async () => {
    const upstream = await startUpstream();
    const proxy = await startMcpPolicyProxy(
      toolInput("linear", "team:T1", undefined, upstream.url),
    );
    const client = new Client({ name: "policy-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(proxy.url), {
          requestInit: { headers: proxy.headers },
        }),
      );
      await expect(
        client.callTool({ name: "act", arguments: { issueId: "ENG-42" } }),
      ).resolves.toMatchObject({
        isError: true,
      });
      expect(upstream.calls).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await proxy.close();
    }
  });
});

function toolInput(
  provider: string,
  scope: string,
  reference: string | undefined,
  url: string,
): ToolInput {
  return {
    id: `${provider}-tool`,
    kind: "tool",
    required: true,
    capability: {
      id: `${provider}:account-1`,
      provider,
      operations: [
        {
          name: "act",
          effect: "write",
          actions: ["resource:write"],
          resourceArgumentPolicies: resourcePolicies(provider),
        },
      ],
      authorization: {
        provider,
        resources: [
          {
            surfaceAccountId: "account-1",
            scope,
            ...(reference === undefined ? {} : { reference }),
          },
        ],
      },
    },
    binding: { kind: "mcp-http", name: provider, url },
  };
}

function resourcePolicies(provider: string) {
  if (provider === "github") {
    return [
      {
        match: "reference" as const,
        separator: "/",
        components: [{ arguments: ["owner"] }, { arguments: ["repo", "repository"] }],
      },
    ];
  }
  if (provider === "teams") {
    return [
      {
        match: "scope" as const,
        prefix: "team:",
        separator: "/channel:",
        components: [
          { arguments: ["team_id", "teamId"] },
          { arguments: ["channel_id", "channelId"] },
        ],
      },
    ];
  }
  const prefix = provider === "slack" ? "channel:" : provider === "linear" ? "team:" : "chat:";
  const arguments_ =
    provider === "slack"
      ? ["channel_id", "channelId", "channel"]
      : provider === "linear"
        ? ["team_id", "teamId", "team"]
        : ["chat_id", "chatId", "receive_id", "receiveId"];
  return [
    {
      match: "scope" as const,
      prefix,
      components: [{ arguments: arguments_ }],
    },
  ];
}

async function startUpstream() {
  const calls = vi.fn();
  const app = createMcpExpressApp();
  app.post("/mcp", async (request, response) => {
    const protocol = new McpProtocolServer(
      { name: "policy-upstream", version: "1" },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "act", inputSchema: { type: "object", additionalProperties: true } }],
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      calls(params.arguments);
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
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address");
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls };
}
