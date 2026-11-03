import type { ToolInput } from "../../packages/runtime/sdk/src/index.ts";

/** Synthetic sandbox-only server; records calls independently of Harness output. */
export const SHARED_MCP_FIXTURE_SOURCE = String.raw`
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const root = process.env.MCP_WORKSPACE || process.cwd();
const mode = process.env.MCP_TRANSPORT || "stdio";
const sessions = new Set();
const tools = [{ name: "exchange", description: "Read or publish a shared note in the admitted collection. Use action read or publish. Publishing requires text.", inputSchema: {
  type: "object", properties: { collection: { type: "string" }, action: { type: "string", enum: ["read", "publish"] }, text: { type: "string" } }, required: ["collection", "action"], additionalProperties: false,
} }, { name: "forbidden_tool", inputSchema: { type: "object" } }];
function handle(message) {
  if (message.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "shared-fixture", version: "1" } };
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const args = message.params.arguments;
    fs.appendFileSync(root + "/mcp-calls.jsonl", JSON.stringify({ transport: mode, name: message.params.name, ...args }) + "\n");
    if (message.params.name !== "exchange" || args.collection !== "docs") throw new Error("Unexpected unadmitted call reached fixture");
    if (args.action === "publish") fs.writeFileSync(root + "/mcp-note.txt", args.text);
    return { content: [{ type: "text", text: fs.readFileSync(root + "/mcp-note.txt", "utf8") }] };
  }
}
if (mode === "http") {
  http.createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer " + process.env.MCP_FIXTURE_TOKEN) { response.writeHead(401).end(); return; }
    if (request.method === "DELETE") {
      sessions.delete(request.headers["mcp-session-id"]);
      fs.appendFileSync(root + "/mcp-closed.txt", "closed\n");
      response.writeHead(200).end(); return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    let session;
    if (message.method === "initialize") { session = crypto.randomUUID(); sessions.add(session); }
    else if (!sessions.has(request.headers["mcp-session-id"])) { response.writeHead(404).end(); return; }
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    try {
      const result = handle(message);
      response.writeHead(200, { "content-type": "text/event-stream", ...(session ? { "mcp-session-id": session } : {}) });
      response.end("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n\n");
    } catch { response.writeHead(500).end(); }
  }).listen(8799, "127.0.0.1");
} else {
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    try { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handle(message) }) + "\n"); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Fixture rejected call" } }) + "\n"); }
  });
}
`;

export function sharedMcpInputs(workspace: string, token: string): readonly ToolInput[] {
  return ["stdio", "http"].map((transport) => ({
    id: `shared-${transport}`,
    kind: "tool",
    required: true,
    audience: "manager",
    capability: {
      id: `shared-${transport}`,
      provider: "shared-fixture",
      operations: [
        {
          name: "exchange",
          effect: "write",
          actions: ["notes:write"],
          resourceArgumentPolicies: [
            { match: "scope", prefix: "collection:", components: [{ arguments: ["collection"] }] },
          ],
        },
      ],
      authorization: {
        provider: "shared-fixture",
        resources: [{ surfaceAccountId: "fixture", scope: "collection:docs" }],
      },
    },
    binding:
      transport === "stdio"
        ? {
            kind: "mcp-stdio",
            name: "shared_stdio",
            command: "node",
            args: ["-e", SHARED_MCP_FIXTURE_SOURCE],
            runtimeEnvironment: { MCP_WORKSPACE: workspace },
          }
        : {
            kind: "mcp-http",
            name: "shared_http",
            url: "http://127.0.0.1:8799/mcp",
            runtimeHeaders: { Authorization: `Bearer ${token}` },
          },
  }));
}
