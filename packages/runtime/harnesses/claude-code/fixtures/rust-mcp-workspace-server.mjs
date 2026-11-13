// A repository's stdio MCP server for Rust Workspace MCP process tests. No dependencies.
// It logs each start, with its working directory, to FAKE_MCP_LOG, and offers `read_env`, which
// answers with that directory.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_MCP_LOG;
const audit = (value) => log && appendFileSync(log, `${JSON.stringify(value)}\n`);
audit({ started: process.pid, cwd: process.cwd(), args: process.argv.slice(2) });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined || request.method === undefined) return;
  if (request.method === "initialize")
    return send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "workspace-fixture", version: "1" },
      },
    });
  if (request.method === "tools/list")
    return send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: ["read_env", "ungranted"].map((name) => ({
          name,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        })),
      },
    });
  if (request.method === "tools/call") {
    audit({ tool: request.params.name });
    const text = JSON.stringify({ cwd: process.cwd() });
    return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } });
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
});
lines.on("close", () => {
  audit({ closed: process.pid });
  process.exit(0);
});
