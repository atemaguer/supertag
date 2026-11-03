import type { Server as HttpServer } from "node:http";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function startManagerIsolationMcp(expectedAuthorization: string) {
  const authorizations: Array<string | undefined> = [];
  const calls: unknown[] = [];
  const app = createMcpExpressApp();
  app.post("/internal/v1/coordination/mcp", async (request, response) => {
    authorizations.push(request.headers.authorization);
    if (request.headers.authorization !== expectedAuthorization) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const protocol = new McpProtocolServer(
      { name: "manager-isolation-upstream", version: "1" },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "read_objective",
          description: "Harmless manager isolation fixture",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      calls.push(params);
      return { content: [{ type: "text", text: "manager-authorized" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
    await protocol.connect(transport as Parameters<McpProtocolServer["connect"]>[0]);
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
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing MCP fixture address");
  return {
    controlPlaneUrl: `http://127.0.0.1:${address.port}`,
    authorizations,
    calls,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

export async function callManagerProxy(
  url: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<void> {
  const client = new McpClient({ name: "manager-isolation-root", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { ...headers } } }),
    );
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "read_objective")) {
      throw new Error("Manager proxy omitted read_objective");
    }
    const result = await client.callTool({ name: "read_objective", arguments: {} });
    if (result.isError || JSON.stringify(result.content).includes("manager-authorized") === false) {
      throw new Error(`Manager proxy call failed: ${JSON.stringify(result)}`);
    }
  } finally {
    await client.close();
  }
}
