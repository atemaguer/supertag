// A stdio MCP server for Rust Worker Host tests. No dependencies: newline-delimited JSON-RPC.
// Usage: node rust-mcp-stdio-provider.mjs JOURNAL [normal|hung|garbage|oversized]
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [journal, mode = "normal"] = process.argv.slice(2);
const audit = (value) => appendFileSync(journal, `${JSON.stringify(value)}\n`);
// What the Worker Host gave this process: its ID and its whole environment.
writeFileSync(
  `${journal}.${process.pid}.launch`,
  JSON.stringify({ pid: process.pid, env: process.env }),
);

if (mode === "garbage") process.stdout.write("not json\n");
if (mode === "oversized") process.stdout.write("x".repeat(2 * 1024 * 1024));
if (mode === "hung") process.on("SIGTERM", () => {});
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const inputSchema = {
  type: "object",
  properties: {
    owner: { type: "string" },
    repo: { type: "string" },
    org: { type: "string" },
    mirror: { type: "boolean" },
  },
  required: ["owner", "repo"],
  additionalProperties: false,
};

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === "server-ping" && request.method === undefined)
    return writeFileSync(`${journal}.ping`, JSON.stringify(request));
  if (request.id === undefined || request.method === undefined) return;
  if (request.method === "initialize")
    return send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stdio-fixture", version: "1" },
      },
    });
  if (request.method === "tools/list")
    return send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: ["list_docs", "List_docs", "publish", "ungranted"].map((name) => ({
          name,
          inputSchema,
        })),
      },
    });
  if (request.method === "tools/call") {
    const { name, arguments: args } = request.params;
    audit({ tool: name, arguments: args });
    if (mode === "hung") return;
    // A ping from the server before the answer: the Worker Host must answer and keep waiting.
    send({ jsonrpc: "2.0", id: "server-ping", method: "ping" });
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } });
    const text = args?.mirror ? process.env.CATALOG_TOKEN : "fixture release record";
    return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } });
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
});
lines.on("close", () => {
  audit({ closed: true });
  if (mode !== "hung") process.exit(0);
});
if (mode === "hung") setInterval(() => {}, 1000);
