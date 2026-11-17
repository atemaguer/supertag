import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createRemoteWorkspaceExecutor,
  type harnessClient,
} from "@supertag/worker-sdk/internal/rust-harness";

/** Claude's tools in a remote Workspace: Claude Code itself has no built-in tool there. */
export const REMOTE_WORKSPACE_SERVER = "workspace";
export const REMOTE_WORKSPACE_PREFIX = `mcp__${REMOTE_WORKSPACE_SERVER}__`;
/** A command may run for 120 s in the sandbox; the call carries its result back. */
const CALL_TIMEOUT_MS = 140_000;

/**
 * The Task's Workspace tools as an in-process MCP server. Each call goes to the Worker Host's
 * Harness.Workspace, which forwards it to the sandbox. A call never runs on this host: an
 * unreachable sandbox is a tool error, and Claude Code has no built-in tool to fall back to.
 */
export function remoteWorkspaceTools(
  bridge: ReturnType<typeof harnessClient>,
  actions: readonly string[],
  signal: AbortSignal,
) {
  const executor = createRemoteWorkspaceExecutor(actions, bridge);
  const configured = createSdkMcpServer({
    name: REMOTE_WORKSPACE_SERVER,
    version: "1",
    timeout: CALL_TIMEOUT_MS,
    tools: [],
  });
  const server = configured.instance.server;
  server.registerCapabilities({ tools: {} });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: executor.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: inputSchema as { type: "object" },
      _meta: { "anthropic/alwaysLoad": true },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, request) => {
    try {
      const { text, isError } = await executor.call(
        params.name,
        params.arguments ?? {},
        AbortSignal.any([signal, request.signal]),
      );
      return { content: [{ type: "text" as const, text }], isError };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Workspace tool failed: ${error instanceof Error ? error.message : "unavailable"}`,
          },
        ],
        isError: true,
      };
    }
  });
  return {
    tools: executor.tools.map(({ name }) => `${REMOTE_WORKSPACE_PREFIX}${name}`),
    servers: { [REMOTE_WORKSPACE_SERVER]: configured },
  };
}
