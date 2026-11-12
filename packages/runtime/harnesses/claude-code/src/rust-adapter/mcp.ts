import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  HarnessMcpApprovalState,
  type harnessClient,
  PolicyPermissionTarget,
  redact,
  type Task,
} from "@supertag/worker-sdk/internal/rust-harness";

const MAX_TOOLS = 128;
const CALL_TIMEOUT_MS = 13_000;

function denied(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export async function taskMcpTools(
  bridge: ReturnType<typeof harnessClient>,
  task: Task,
  signal: AbortSignal,
  active: () => boolean,
  secrets: readonly string[],
) {
  const toolServers = new Map<string, string>();
  const servers: Record<string, McpSdkServerConfigWithInstance> = Object.create(null);
  const pending = new Set<string>();
  const calls = new Set<Promise<unknown>>();
  const hasPendingApprovals = () => pending.size > 0;
  const waitingApprovalIds = async () => {
    await Promise.allSettled(calls);
    return [...pending].sort();
  };
  if (
    !task.policySnapshot?.permissionSets.some(({ permissions }) =>
      permissions.some(({ target }) => target === PolicyPermissionTarget.MCP),
    )
  )
    return { toolServers, servers, hasPendingApprovals, waitingApprovalIds };

  const { tools } = await bridge.mcp.list({}, { ...bridge.options(), signal });
  if (tools.length > MAX_TOOLS) throw new Error("Invalid Worker Host MCP tool inventory");
  const byServer = new Map<string, Map<string, Tool>>();
  for (const tool of tools) {
    const name = `mcp__${tool.server}__${tool.name}`;
    if (
      !/^[a-z0-9][a-z0-9_-]{0,58}$/.test(tool.server) ||
      tool.server.startsWith("supertag") ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ||
      toolServers.has(name)
    )
      throw new Error("Invalid Worker Host MCP tool identity");
    const inputSchema: Tool["inputSchema"] = JSON.parse(tool.inputSchemaJson);
    if (inputSchema?.type !== "object") throw new Error("Invalid Worker Host MCP tool schema");
    const inventory = byServer.get(tool.server) ?? new Map<string, Tool>();
    inventory.set(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema,
    });
    byServer.set(tool.server, inventory);
    toolServers.set(name, tool.server);
  }
  for (const [name, inventory] of byServer) {
    const configured = createSdkMcpServer({
      name,
      version: "1",
      timeout: CALL_TIMEOUT_MS + 1000,
      tools: [],
    });
    // Register exact upstream JSON schemas instead of converting them to a permissive Zod shape.
    const server = configured.instance.server;
    server.registerCapabilities({ tools: {} });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...inventory.values()],
    }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }, request) => {
      const call = (async () => {
        if (!active() || signal.aborted || !inventory.has(params.name))
          return denied("MCP tool is unavailable for this execution.");
        if (pending.size >= 32)
          return denied(
            "Finish this turn with a brief reply and wait for the MCP approval decisions.",
          );
        const argumentsJson = JSON.stringify(params.arguments ?? {});
        if (redact(argumentsJson, secrets) !== argumentsJson)
          return denied("MCP arguments contain a private execution credential.");
        try {
          // A lost response can follow an external effect. Never retry this RPC.
          const response = await bridge.mcp.call(
            { server: name, tool: params.name, argumentsJson, operationId: randomUUID() },
            {
              ...bridge.options(),
              signal: AbortSignal.any([signal, request.signal]),
              timeoutMs: CALL_TIMEOUT_MS,
            },
          );
          if (response.approvalState !== HarnessMcpApprovalState.UNSPECIFIED) {
            const approvalId = response.approvalId;
            if (!approvalId || !/^[0-9a-f-]{36}$/u.test(approvalId))
              return denied("MCP approval receipt could not be verified.");
            if (response.approvalState === HarnessMcpApprovalState.PENDING) {
              pending.add(approvalId);
              return denied(
                "MCP call requires approval, request " +
                  approvalId +
                  ". The call was not made. Finish this turn with a brief reply and wait for the decision.",
              );
            }
            pending.delete(approvalId);
            if (response.approvalState === HarnessMcpApprovalState.DENIED)
              return denied("The MCP approval was denied or expired. The call was not made.");
            if (response.approvalState !== HarnessMcpApprovalState.GRANTED || !response.resultJson)
              return denied("MCP call could not be confirmed. Do not repeat it automatically.");
          }
          const result = CallToolResultSchema.safeParse(JSON.parse(response.resultJson));
          return result.success
            ? result.data
            : denied("MCP provider response could not be verified.");
        } catch (error) {
          const message =
            error && typeof error === "object" && "rawMessage" in error
              ? error.rawMessage
              : undefined;
          // Only exact fixed refusals originating at the private Worker Host cross this boundary.
          if (message === "MCP tool or resource is outside accepted Task permissions")
            return denied("MCP tool or resource is outside accepted Task permissions.");
          return denied("MCP call could not be confirmed. Do not repeat it automatically.");
        }
      })();
      calls.add(call);
      return call.finally(() => calls.delete(call));
    });
    servers[name] = configured;
  }
  return { toolServers, servers, hasPendingApprovals, waitingApprovalIds };
}
