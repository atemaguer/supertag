import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { harnessClient } from "./client.js";
import { createRemoteWorkspaceExecutor } from "./remote-workspace.js";

const HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 1024 * 1024;
/** The MCP server name a native harness sees the Workspace tools under. */
export const REMOTE_WORKSPACE_HTTP_SERVER = "workspace";

export interface RemoteWorkspaceHttpServer {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly toolNames: readonly string[];
  /** The bearer token and its header value, for redaction. */
  readonly secrets: readonly string[];
  close(): Promise<void>;
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
 * A remote Workspace's tools for a native harness that speaks HTTP MCP, such as OpenCode, on one
 * authenticated loopback endpoint. Each call goes to the Worker Host's Harness.Workspace, which
 * forwards it to the Task's sandbox; nothing runs on this host, and an unreachable sandbox is a
 * tool error.
 */
export async function startRemoteWorkspaceHttp(
  bridge: Pick<ReturnType<typeof harnessClient>, "workspace" | "options">,
  actions: readonly string[],
  signal: AbortSignal,
): Promise<RemoteWorkspaceHttpServer> {
  signal.throwIfAborted();
  const executor = createRemoteWorkspaceExecutor(actions, bridge);
  const ending = new AbortController();
  const active = AbortSignal.any([signal, ending.signal]);
  // This secret has no authority on the Worker Host's private gRPC service.
  const bearer = randomBytes(32).toString("base64url");
  const authorization = `Bearer ${bearer}`;
  const expected = Buffer.from(authorization);
  const protocol = new Server(
    { name: REMOTE_WORKSPACE_HTTP_SERVER, version: "1" },
    { capabilities: { tools: {} } },
  );
  protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: executor.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: inputSchema as { type: "object" },
    })),
  }));
  protocol.setRequestHandler(CallToolRequestSchema, async ({ params }, request) => {
    try {
      const { text, isError } = await executor.call(
        params.name,
        params.arguments ?? {},
        AbortSignal.any([active, request.signal]),
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
  // A native process owns one client for this Task Attempt.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  await protocol.connect(transport as Parameters<typeof protocol.connect>[0]);
  const path = `/mcp/${REMOTE_WORKSPACE_HTTP_SERVER}`;
  const server = createServer(
    { maxHeaderSize: 8 * 1024, requestTimeout: 15_000 },
    async (req, res) => {
      if (req.url !== path || !["POST", "GET", "DELETE"].includes(req.method ?? "")) {
        req.resume();
        res.writeHead(404).end();
        return;
      }
      if (req.headers.origin !== undefined || !authorized(req.headers.authorization, expected)) {
        req.resume();
        res.writeHead(403).end();
        return;
      }
      if (active.aborted) {
        req.resume();
        res.writeHead(410).end();
        return;
      }
      try {
        const body = req.method === "POST" ? await requestBody(req) : undefined;
        await transport.handleRequest(req, res, body);
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
      signal.removeEventListener("abort", onAbort);
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([stopped, protocol.close(), executor.dispose()]);
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
    signal.addEventListener("abort", onAbort, { once: true });
    signal.throwIfAborted();
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Workspace MCP listener unavailable");
    return {
      name: REMOTE_WORKSPACE_HTTP_SERVER,
      url: `http://${HOST}:${address.port}${path}`,
      headers: { Authorization: authorization },
      toolNames: executor.tools.map(({ name }) => name),
      secrets: [authorization, bearer],
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
