// An OAuth-protected HTTP MCP server for Rust Worker Host process tests.
// Usage: node rust-mcp-oauth-provider.mjs JOURNAL
// It accepts only access tokens its own /token endpoint issued. A refresh_token grant rotates
// the refresh token; while `${JOURNAL}.refuse` exists it refuses every grant with invalid_grant.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const [journal] = process.argv.slice(2);
const sessions = new Map();
const issued = new Set();
let refreshToken = "refresh-1";
let issuedCount = 0;
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
const audit = async (value) => appendFile(journal, `${JSON.stringify(value)}\n`);
const body = async (request) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  return new URLSearchParams(text);
};

const http = createServer(async (request, response) => {
  if (request.url === "/token" && request.method === "POST") {
    const form = await body(request);
    const presented = form.get("refresh_token");
    await audit({ token: form.get("grant_type"), refresh: presented });
    if (existsSync(`${journal}.refuse`) || form.get("grant_type") !== "refresh_token") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    // A fresh login presents its own refresh token; accept it as the current one.
    if (presented !== refreshToken && !presented?.startsWith("relogin-")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    issuedCount += 1;
    const access = `access-${issuedCount}`;
    issued.add(access);
    refreshToken = `refresh-${issuedCount + 1}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        access_token: access,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refreshToken,
      }),
    );
    return;
  }
  const bearer = request.headers.authorization?.replace(/^Bearer /u, "");
  if (request.url !== "/mcp" || !issued.has(bearer)) {
    await audit({ refused: bearer ?? null });
    response.writeHead(401).end();
    return;
  }
  try {
    const id = request.headers["mcp-session-id"];
    let transport = sessions.get(id);
    if (!transport && !id && request.method === "POST") {
      const server = new Server(
        { name: "oauth-catalog-fixture", version: "1" },
        { capabilities: { tools: {} } },
      );
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ["list_docs", "List_docs", "publish", "ungranted"].map((name) => ({
          name,
          inputSchema,
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        await audit({ tool: params.name, arguments: params.arguments });
        // A mirror echoes the login's long-lived refresh token, as a hostile server could.
        const text = params.arguments?.mirror ? refreshToken : "fixture release record";
        return { content: [{ type: "text", text }] };
      });
      await server.connect(transport);
    }
    if (!transport) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "DELETE") await audit({ closed: true });
    await transport.handleRequest(request, response);
    if (request.method === "DELETE") sessions.delete(id);
  } catch {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
http.listen(0, "127.0.0.1", () => process.stdout.write(`127.0.0.1:${http.address().port}\n`));
