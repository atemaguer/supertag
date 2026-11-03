// Synthetic note service used only by this runnable example. It records backend effects.
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const root = process.env.MCP_EXAMPLE_ROOT || "/state/example-mcp";
const mode = process.env.MCP_TRANSPORT || "stdio";
const sessions = new Map();
const tools = [
  {
    name: "exchange",
    description:
      "Read the committed shared handoff note or publish a note in collection docs. Read the handoff before doing your work.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        action: { type: "string", enum: ["read", "publish"] },
        text: { type: "string" },
      },
      required: ["collection", "action"],
      additionalProperties: false,
    },
  },
];
function handle(message, identity) {
  if (message.method === "initialize")
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "example-notes", version: "1" },
    };
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const args = message.params.arguments;
    const row = {
      ...identity,
      transport: identity.transport || mode,
      name: message.params.name,
      collection: args.collection,
      action: args.action,
      at: new Date().toISOString(),
    };
    if (message.params.name !== "exchange" || args.collection !== "docs") {
      fs.appendFileSync(`${root}/calls.jsonl`, `${JSON.stringify({ ...row, forbidden: true })}\n`);
      throw new Error("Unexpected unadmitted call reached fixture");
    }
    if (args.action === "publish") {
      fs.writeFileSync(`${root}/note.txt`, args.text);
      row.committed = true;
    }
    row.text = fs.readFileSync(`${root}/note.txt`, "utf8");
    fs.appendFileSync(`${root}/calls.jsonl`, `${JSON.stringify(row)}\n`);
    return { content: [{ type: "text", text: row.text }] };
  }
}
if (mode === "http") {
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  if (!fs.existsSync(`${root}/note.txt`)) fs.writeFileSync(`${root}/note.txt`, "No handoff yet");
  http
    .createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${process.env.MCP_FIXTURE_TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "DELETE") {
        sessions.delete(request.headers["mcp-session-id"]);
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 65536) {
          response.writeHead(413).end();
          return;
        }
      }
      try {
        const message = JSON.parse(body);
        let session = request.headers["mcp-session-id"];
        if (message.method === "initialize") {
          session = crypto.randomUUID();
          sessions.set(session, {
            transport: request.headers["x-example-transport"] || "http",
            actor: request.headers["x-example-actor"],
            taskId: request.headers["x-example-task"],
            attemptId: request.headers["x-example-attempt"],
          });
        } else if (!sessions.has(session)) {
          response.writeHead(404).end();
          return;
        }
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const identity = sessions.get(session);
        const result = handle(message, identity);
        if (
          identity.actor === "probe" &&
          message.method === "tools/call" &&
          message.params.arguments.action === "publish"
        ) {
          // Commit before dropping the response. Every replay remains visible as another write.
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": session });
        response.end(
          "event: message\ndata: " +
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) +
            "\n\n",
        );
      } catch {
        response.writeHead(500).end();
      }
    })
    .listen(Number(process.env.MCP_PORT || 8799), "127.0.0.1");
} else {
  // stdio is a protocol adapter; the root-owned HTTP service owns all evidence and writes.
  const endpoint = `http://127.0.0.1:${Number(process.env.MCP_PORT || 8799)}/mcp`;
  let session;
  const identityHeaders = {
    Authorization: `Bearer ${process.env.MCP_FIXTURE_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Example-Actor": process.env.MCP_ACTOR,
    "X-Example-Task": process.env.MCP_TASK,
    "X-Example-Attempt": process.env.MCP_ATTEMPT,
    "X-Example-Transport": "stdio",
  };
  let queue = Promise.resolve();
  let closing;
  const close = () =>
    (closing ??= (async () => {
      if (session)
        await fetch(endpoint, {
          method: "DELETE",
          headers: { ...identityHeaders, "Mcp-Session-Id": session },
          signal: AbortSignal.timeout(2000),
        }).catch(() => undefined);
    })());
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  const lines = require("node:readline").createInterface({ input: process.stdin });
  lines.on("close", () => {
    void queue.finally(close);
  });
  lines.on("line", (line) => {
    queue = queue
      .then(async () => {
        const message = JSON.parse(line);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { ...identityHeaders, ...(session ? { "Mcp-Session-Id": session } : {}) },
          body: JSON.stringify(message),
        });
        session = response.headers.get("mcp-session-id") || session;
        if (message.id === undefined) return;
        const text = await response.text();
        const data = text.split("\n").find((line) => line.startsWith("data: "));
        if (!data) throw new Error("Missing note response");
        process.stdout.write(`${data.slice(6)}\n`);
      })
      .catch(() => {
        process.stderr.write("Example note transport failed\n");
        process.exitCode = 1;
      });
  });
}
