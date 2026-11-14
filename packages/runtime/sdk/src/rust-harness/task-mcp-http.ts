import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { harnessClient } from "./client.js";
import { HarnessMcpApprovalState } from "./gen/supertag/runtime/v2/mcp_pb.js";
import { PolicyPermissionTarget } from "./gen/supertag/runtime/v2/policy_pb.js";
import type { Task } from "./gen/supertag/runtime/v2/runtime_pb.js";
import { redact } from "./redact.js";

const HOST = "127.0.0.1";
const MAX_TOOLS = 128;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PENDING_APPROVALS = 32;
const CALL_TIMEOUT_MS = 13_000;
const REFUSED = "MCP tool or resource is outside accepted Task permissions";

export interface TaskMcpScope {
  readonly signal: AbortSignal;
  readonly active: () => boolean;
  readonly secrets: readonly string[];
}

export interface TaskMcpHttpServer {
  readonly type: "http";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly toolNames: readonly string[];
}

function denied(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function authorized(value: string | undefined, expected: Buffer): boolean {
  if (value === undefined || Buffer.byteLength(value) !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), expected);
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const length = request.headers["content-length"];
  if (length !== undefined && Number(length) > MAX_REQUEST_BYTES)
    throw new Error("MCP request exceeds its limit");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("MCP request exceeds its limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * A native harness that speaks HTTP MCP reaches the Task's granted MCP tools here, one
 * authenticated loopback endpoint per server. Every call crosses the Worker Host's HarnessMcp
 * service, which checks grants, resources, and approvals, and runs the server: a Workspace
 * stdio server of a remote Workspace runs inside the Task's sandbox.
 */
export async function startTaskMcpHttp(
  bridge: ReturnType<typeof harnessClient>,
  task: Task,
  scope: TaskMcpScope,
) {
  scope.signal.throwIfAborted();
  const pending = new Set<string>();
  const calls = new Set<Promise<unknown>>();
  const waitingApprovalIds = async () => {
    await Promise.allSettled(calls);
    return [...pending].sort();
  };
  const empty = {
    servers: {} as Record<string, TaskMcpHttpServer>,
    secrets: [] as string[],
    waitingApprovalIds,
    async close() {},
  };
  if (
    !task.policySnapshot?.permissionSets.some(({ permissions }) =>
      permissions.some(({ target }) => target === PolicyPermissionTarget.MCP),
    )
  )
    return empty;
  const { tools } = await bridge.mcp.list({}, { ...bridge.options(), signal: scope.signal });
  if (tools.length > MAX_TOOLS) throw new Error("Invalid Worker Host MCP tool inventory");
  const byServer = new Map<string, Map<string, Tool>>();
  for (const tool of tools) {
    const inventory = byServer.get(tool.server) ?? new Map<string, Tool>();
    if (
      !/^[a-z0-9][a-z0-9_-]{0,58}$/u.test(tool.server) ||
      tool.server.startsWith("supertag") ||
      !/^[A-Za-z0-9_.-]{1,128}$/u.test(tool.name) ||
      inventory.has(tool.name)
    )
      throw new Error("Invalid Worker Host MCP tool identity");
    const inputSchema: Tool["inputSchema"] = JSON.parse(tool.inputSchemaJson);
    if (inputSchema?.type !== "object") throw new Error("Invalid Worker Host MCP tool schema");
    inventory.set(tool.name, { name: tool.name, description: tool.description, inputSchema });
    byServer.set(tool.server, inventory);
  }
  if (byServer.size === 0) return empty;

  const ending = new AbortController();
  const signal = AbortSignal.any([scope.signal, ending.signal]);
  // This secret has no authority on the Worker Host's private gRPC service.
  const bearer = randomBytes(32).toString("base64url");
  const authorization = `Bearer ${bearer}`;
  const expected = Buffer.from(authorization);
  const secrets = [...scope.secrets, authorization, bearer];
  const endpoints = new Map<
    string,
    { protocol: Server; transport: StreamableHTTPServerTransport }
  >();
  for (const [name, inventory] of byServer) {
    const protocol = new Server({ name, version: "1" }, { capabilities: { tools: {} } });
    // Serve the exact upstream JSON schemas the Worker Host admitted.
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...inventory.values()],
    }));
    protocol.setRequestHandler(CallToolRequestSchema, ({ params }, request) => {
      const call = (async () => {
        if (!scope.active() || signal.aborted || !inventory.has(params.name))
          return denied("MCP tool is unavailable for this execution.");
        if (pending.size >= MAX_PENDING_APPROVALS)
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
                `MCP call requires approval, request ${approvalId}. The call was not made. Finish this turn with a brief reply and wait for the decision.`,
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
          // Only the exact fixed refusal from the private Worker Host crosses this boundary.
          if (message === REFUSED) return denied(`${REFUSED}.`);
          return denied("MCP call could not be confirmed. Do not repeat it automatically.");
        }
      })();
      calls.add(call);
      return call.finally(() => calls.delete(call));
    });
    // A native process owns one client per server for this Attempt.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    });
    await protocol.connect(transport as Parameters<typeof protocol.connect>[0]);
    endpoints.set(`/mcp/${name}`, { protocol, transport });
  }
  const server = createServer(
    { maxHeaderSize: 8 * 1024, requestTimeout: 15_000 },
    async (req, res) => {
      const endpoint = endpoints.get(req.url ?? "");
      if (!endpoint || !["POST", "GET", "DELETE"].includes(req.method ?? "")) {
        req.resume();
        res.writeHead(404).end();
        return;
      }
      if (req.headers.origin !== undefined || !authorized(req.headers.authorization, expected)) {
        req.resume();
        res.writeHead(403).end();
        return;
      }
      if (signal.aborted || !scope.active()) {
        req.resume();
        res.writeHead(410).end();
        return;
      }
      try {
        const body = req.method === "POST" ? await requestBody(req) : undefined;
        await endpoint.transport.handleRequest(req, res, body);
      } catch {
        req.resume();
        if (res.headersSent) res.destroy();
        else res.writeHead(400).end();
      }
    },
  );
  server.maxConnections = 16;
  server.headersTimeout = 5_000;
  let closing: Promise<void> | undefined;
  const onAbort = () => void close().catch(() => undefined);
  function close(): Promise<void> {
    closing ??= (async () => {
      ending.abort();
      scope.signal.removeEventListener("abort", onAbort);
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([
        stopped,
        ...[...endpoints.values()].map(({ protocol }) => protocol.close()),
      ]);
    })();
    return closing;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    scope.signal.addEventListener("abort", onAbort, { once: true });
    scope.signal.throwIfAborted();
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("MCP listener unavailable");
    const servers: Record<string, TaskMcpHttpServer> = Object.create(null);
    for (const [name, inventory] of byServer)
      servers[name] = {
        type: "http",
        url: `http://${HOST}:${address.port}/mcp/${name}`,
        headers: { Authorization: authorization },
        toolNames: [...inventory.keys()],
      };
    return { servers, secrets: [authorization, bearer], waitingApprovalIds, close };
  } catch (error) {
    await close();
    throw error;
  }
}
