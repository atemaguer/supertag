import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  generateCoordinationTls,
  startCoordinationTls,
} from "../examples/shared-organization/coordination-tls.mjs";

const execute = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "TLS fixture cleanup failed");
});

async function fixture(holdStream = false) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-coordination-tls-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const certificates = await generateCoordinationTls(join(directory, "trusted"));
  const requests: Array<{ path: string; method: string; authorized: boolean; session: string }> =
    [];
  const connections = new Set<Socket>();
  let nativeState: unknown;
  const server = createServer(async (request, response) => {
    const authorized = request.headers.authorization === "Bearer fixture-manager";
    requests.push({
      path: request.url ?? "",
      method: request.method ?? "",
      authorized,
      session: String(request.headers["mcp-session-id"] ?? ""),
    });
    if (!authorized) {
      response.writeHead(401).end();
      return;
    }
    if (holdStream && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (request.url === "/internal/v1/sessions/save") {
      nativeState = message;
      response.writeHead(200, { "content-type": "application/json" }).end("null");
      return;
    }
    if (request.url === "/internal/v1/sessions/load") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(nativeState));
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                { name: "inspect", inputSchema: { type: "object" } },
                { name: "not_admitted", inputSchema: { type: "object" } },
              ],
            }
          : { content: [{ type: "text", text: "manager-state" }] };
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "owned-manager-session",
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  const proxy = await startCoordinationTls({
    targetUrl: `http://127.0.0.1:${address.port}`,
    ...certificates,
    port: 0,
  });
  cleanups.push(() => proxy.close());
  return { directory, certificates, requests, proxy, connections };
}

async function probe(baseUrl: string, caFile?: string, path?: string) {
  const input = {
    id: "supertag-coordination",
    kind: "tool",
    audience: "manager",
    required: true,
    capability: {
      id: "supertag-coordination",
      provider: "supertag",
      operations: [{ name: "inspect", effect: "read", actions: [] }],
    },
    binding: {
      kind: "mcp-http",
      name: "supertag-coordination",
      url: `${baseUrl}/internal/v1/coordination/mcp`,
      runtimeHeaders: { authorization: "Bearer fixture-manager" },
    },
  };
  const source =
    path === undefined
      ? `
    import { connectWorkerMcpClient } from ${JSON.stringify(new URL("../packages/runtime/sdk/src/index.ts", import.meta.url).href)};
    let connection;
    try {
      connection = await connectWorkerMcpClient(${JSON.stringify(input)});
      const result = await connection.callTool("inspect", {});
      console.log(JSON.stringify({ connected: true, tools: connection.tools.map(tool => tool.name), result }));
    } catch (error) {
      const codes = []; let current = error;
      for (let depth = 0; current && depth < 8; depth++, current = current.cause) if (typeof current.code === "string") codes.push(current.code);
      console.log(JSON.stringify({ connected: false, codes }));
    } finally { await connection?.close(); }
  `
      : `
    const response = await fetch(${JSON.stringify(`${baseUrl}${path}`)}, { headers: { authorization: "Bearer fixture-manager" }, redirect: "manual" });
    console.log(JSON.stringify({ status: response.status }));
  `;
  const { stdout } = await execute(
    process.execPath,
    ["--import", "tsx", "--conditions=development", "--input-type=module", "-e", source],
    {
      cwd: new URL("..", import.meta.url),
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: process.env.PATH,
        NODE_TLS_REJECT_UNAUTHORIZED: "1",
        ...(caFile ? { NODE_EXTRA_CA_CERTS: caFile } : {}),
      },
    },
  );
  return JSON.parse(stdout.trim());
}

it("uses explicit per-run CA trust for the real Worker MCP client and closes only its authenticated session", async () => {
  const { directory, certificates, requests, proxy } = await fixture();
  const wrong = await generateCoordinationTls(join(directory, "unrelated"));
  for (const caFile of [undefined, wrong.caFile]) {
    const result = await probe(proxy.url, caFile);
    expect(result.connected).toBe(false);
    expect(result.codes.some((code: string) => /CERT|ISSUER|VERIFY/.test(code))).toBe(true);
    expect(requests).toEqual([]);
  }
  expect(await probe(proxy.url, certificates.caFile)).toMatchObject({
    connected: true,
    tools: ["inspect"],
    result: { content: [{ type: "text", text: "manager-state" }] },
  });
  expect(
    requests.every(
      (request) => request.authorized && request.path === "/internal/v1/coordination/mcp",
    ),
  ).toBe(true);
  expect(requests.filter((request) => request.method === "DELETE")).toEqual([
    {
      path: "/internal/v1/coordination/mcp",
      method: "DELETE",
      authorized: true,
      session: "owned-manager-session",
    },
  ]);
  expect((await stat(certificates.keyFile)).mode & 0o777).toBe(0o600);
}, 30_000);

it("does not forward management endpoints or similarly named routes", async () => {
  const { certificates, requests, proxy } = await fixture();
  for (const path of [
    "/api/v1/worker-hosts",
    "/internal/v1/coordination/mcp/extra",
    "/internal/v1/coordination/rebind/extra",
    "/internal/v1/sessions/save/extra",
    "/internal/v1/sessions/load?other=1",
    "/api/v1/sessions/session/states",
    "/internal/v1/sessions/load",
    "/internal/v1/sessions/save",
  ]) {
    expect(await probe(proxy.url, certificates.caFile, path)).toEqual({ status: 404 });
  }
  expect(requests).toEqual([]);
}, 30_000);

it("closes an active event stream and its upstream socket without waiting for stream expiry", async () => {
  const { certificates, proxy, connections } = await fixture(true);
  const ca = await readFile(certificates.caFile);
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(
      `${proxy.url}/internal/v1/coordination/mcp`,
      {
        ca,
        agent: false,
        headers: { authorization: "Bearer fixture-manager" },
      },
      resolve,
    );
    request.on("error", reject);
    request.end();
  });
  response.on("error", () => {});
  expect(connections.size).toBe(1);
  await proxy.close();
  await expect.poll(() => connections.size, { timeout: 1_000 }).toBe(0);
  await expect.poll(() => response.destroyed, { timeout: 1_000 }).toBe(true);
});

it("rejects non-loopback targets and listeners before opening an endpoint", async () => {
  await expect(
    startCoordinationTls({
      targetUrl: "http://example.com",
      certFile: "unused",
      keyFile: "unused",
    }),
  ).rejects.toThrow("fixed loopback HTTP upstream");
  await expect(
    startCoordinationTls({
      targetUrl: "http://127.0.0.1",
      certFile: "unused",
      keyFile: "unused",
      host: "0.0.0.0",
    }),
  ).rejects.toThrow("bind loopback");
});

it("forwards private Session storage with real CA trust and multi-megabyte bodies", async () => {
  const { certificates, requests, proxy } = await fixture();
  const source = `
    import { HttpSessionStateStore } from ${JSON.stringify(new URL("../packages/runtime/sdk/src/index.ts", import.meta.url).href)};
    const store = new HttpSessionStateStore({ controlPlaneUrl: ${JSON.stringify(proxy.url)}, token: "fixture-manager" });
    const state = { harnessId: "claude-code", ref: { id: "native", uri: "claude-code://session/native", format: "claude-code-session-v1" }, data: { transcript: "x".repeat(2 * 1024 * 1024) } };
    await store.save(state);
    const restored = await store.load(state.ref);
    console.log(JSON.stringify({ bytes: restored.data.transcript.length, id: restored.ref.id }));
  `;
  const { stdout } = await execute(
    process.execPath,
    ["--import", "tsx", "--conditions=development", "--input-type=module", "-e", source],
    {
      cwd: new URL("..", import.meta.url),
      timeout: 15000,
      maxBuffer: 1024,
      env: {
        PATH: process.env.PATH,
        NODE_TLS_REJECT_UNAUTHORIZED: "1",
        NODE_EXTRA_CA_CERTS: certificates.caFile,
      },
    },
  );
  expect(JSON.parse(stdout)).toEqual({ bytes: 2 * 1024 * 1024, id: "native" });
  expect(requests).toEqual([
    { path: "/internal/v1/sessions/save", method: "POST", authorized: true, session: "" },
    { path: "/internal/v1/sessions/load", method: "POST", authorized: true, session: "" },
  ]);
  const ca = await readFile(certificates.caFile);
  const rejected = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpsRequest(`${proxy.url}/internal/v1/sessions/load`, {
      method: "POST",
      ca,
    });
    request.on("error", reject);
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.end("{}");
  });
  expect(rejected).toBe(401);
}, 30_000);
