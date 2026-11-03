import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import {
  describeToolCall,
  McpToolAdapter,
  type ToolInput,
} from "../../packages/runtime/sdk/src/index.ts";

const SERVER_SOURCE = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "supertag-stdio-e2e", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "echo_securely",
    description: "Echo text and report whether the Worker-only secret was supplied.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{
    type: "text",
    text: JSON.stringify({
      echoed: request.params.arguments?.text,
      authenticated: process.env.SUPERTAG_TEST_SECRET === "runtime-only-secret",
    }),
  }],
}));
await server.connect(new StdioServerTransport());
`;

describe("stdio MCP binding E2E", () => {
  it("spawns a real server, invokes its tool, and normalizes the call without leaking secrets", async () => {
    const runtimeInput = stdioInput();
    const adapted = new McpToolAdapter("harness-runtime").adapt(runtimeInput);
    expect(adapted.transport).toBe("mcp-stdio");
    if (adapted.transport !== "mcp-stdio") throw new Error("Expected stdio adaptation");

    const transport = new StdioClientTransport({
      command: adapted.command,
      args: [...adapted.args],
      env: { ...process.env, ...adapted.environment } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "supertag-stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["echo_securely"]);

      const result = await client.callTool({
        name: "echo_securely",
        arguments: { text: "hello from SuperTag" },
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({ echoed: "hello from SuperTag", authenticated: true }),
        },
      ]);

      const call = describeToolCall([runtimeInput], {
        id: "stdio-call-1",
        binding: { kind: "mcp-stdio", name: "local_echo" },
        operation: "echo_securely",
        arguments: { text: "hello from SuperTag" },
      });
      expect(call).toMatchObject({
        capabilityId: "test:echo",
        provider: "test",
        binding: { kind: "mcp-stdio", name: "local_echo" },
        operation: "echo_securely",
        effect: "read",
        actions: ["echo:read"],
      });
      expect(JSON.stringify({ capability: runtimeInput.capability, call })).not.toContain(
        "runtime-only-secret",
      );
    } finally {
      await client.close();
    }
  });
});

function stdioInput(): ToolInput {
  return {
    id: "test-stdio-echo",
    kind: "tool",
    required: true,
    capability: {
      id: "test:echo",
      provider: "test",
      operations: [{ name: "echo_securely", effect: "read", actions: ["echo:read"] }],
      authorization: {
        provider: "test",
        resources: [{ surfaceAccountId: "test-account", scope: "service:echo" }],
      },
    },
    binding: {
      kind: "mcp-stdio",
      name: "local_echo",
      command: process.execPath,
      args: ["--input-type=module", "--eval", SERVER_SOURCE],
      secretRefs: ["worker://test/test-account/token"],
      runtimeEnvironment: { SUPERTAG_TEST_SECRET: "runtime-only-secret" },
    },
  };
}
