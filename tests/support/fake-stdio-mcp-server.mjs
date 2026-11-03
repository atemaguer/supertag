// A dependency-free fake stdio MCP server for tests. It never calls a real provider.
// FAKE_MCP_LOG, when set, names a file that receives one JSON line per tools/call, and the
// process ID at startup, so tests can count forwarded calls and check that the process stopped.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_MCP_LOG;
const record = (entry) => {
  if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`);
};
record({ started: process.pid, cwd: process.cwd() });

const TOOLS = [
  "get_issue",
  "update_issue",
  "create_pull_request",
  "read_env",
  "im_v1_message_list",
  "im_v1_message_create",
];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-stdio", version: "1" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: TOOLS.map((name) => ({
          name,
          inputSchema: { type: "object", additionalProperties: true },
        })),
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    record({ call: name, arguments: args });
    const text =
      name === "read_env" ? JSON.stringify({ environment: process.env, cwd: process.cwd() }) : "ok";
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
});
