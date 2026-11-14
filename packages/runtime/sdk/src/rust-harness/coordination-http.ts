import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { harnessClient } from "./client.js";
import {
  COORDINATION_SERVER,
  type CoordinationScope,
  registerCoordinationTools,
} from "./coordination.js";
import type { HarnessRun } from "./gen/supertag/runtime/v2/runtime_pb.js";

const HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const MAX_REQUEST_BYTES = 256 * 1024;

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

/** A native harness reaches this Attempt's tools over authenticated loopback MCP. */
export async function startCoordinationHttp(
  bridge: ReturnType<typeof harnessClient>,
  run: HarnessRun,
  scope: CoordinationScope,
  questionOperationPrefix: string,
) {
  scope.signal.throwIfAborted();
  const ending = new AbortController();
  const signal = AbortSignal.any([scope.signal, ending.signal]);
  const protocol = new McpServer({ name: COORDINATION_SERVER, version: "1" });
  // This secret has no authority on the Worker Host's private gRPC service.
  const bearer = randomBytes(32).toString("base64url");
  const authorization = `Bearer ${bearer}`;
  const expected = Buffer.from(authorization);
  const { tools: operations, waitingApprovalIds } = registerCoordinationTools(
    protocol,
    bridge,
    run,
    {
      ...scope,
      signal,
      secrets: [...scope.secrets, authorization, bearer],
    },
    { questionOperationPrefix },
  );
  if (operations.length === 0)
    return { server: undefined, secrets: [], waitingApprovalIds, async close() {} };

  // A native process owns one client for this Attempt.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  await protocol.connect(transport as Parameters<typeof protocol.connect>[0]);
  const server = createServer(
    { maxHeaderSize: 8 * 1024, requestTimeout: 15_000 },
    async (req, res) => {
      if (req.url !== MCP_PATH || !["POST", "GET", "DELETE"].includes(req.method ?? "")) {
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
      scope.signal.removeEventListener("abort", onAbort);
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([stopped, protocol.close()]);
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
    return {
      server: {
        type: "http" as const,
        url: `http://${HOST}:${address.port}${MCP_PATH}`,
        headers: { Authorization: authorization },
        toolNames: operations,
      },
      secrets: [authorization, bearer],
      waitingApprovalIds,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
