import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const fixturePath = resolve("examples/shared-organization/mcp-fixture.cjs");
const token = "synthetic-fixture-test-token";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures = [];
  while (cleanup.length) {
    try {
      await cleanup.pop()?.();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "MCP fixture test cleanup failed");
});
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
async function httpFixture() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-example-mcp-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const port = await freePort();
  const child = spawn(process.execPath, [fixturePath], {
    env: {
      PATH: process.env.PATH,
      MCP_TRANSPORT: "http",
      MCP_PORT: String(port),
      MCP_FIXTURE_TOKEN: token,
      MCP_EXAMPLE_ROOT: directory,
    },
    stdio: "ignore",
  });
  cleanup.push(() => stop(child));
  const url = `http://127.0.0.1:${port}/mcp`;
  await expect
    .poll(async () =>
      fetch(url, { signal: AbortSignal.timeout(250) }).then(
        (response) => response.status,
        () => 0,
      ),
    )
    .toBe(401);
  const headers = (session?: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "X-Example-Actor": "probe",
    "X-Example-Task": "probe-task",
    "X-Example-Attempt": "probe-attempt",
    ...(session ? { "mcp-session-id": session } : {}),
  });
  const call = (message: object, session?: string) =>
    fetch(url, {
      method: "POST",
      headers: headers(session),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(2000),
    });
  const initialize = async () => {
    const response = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await response.text();
    return response.headers.get("mcp-session-id") as string;
  };
  return {
    url,
    call,
    initialize,
    headers,
    ledger: async () =>
      (await readFile(join(directory, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}
const exchange = (action: "read" | "publish", text?: string) => ({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "exchange",
    arguments: { collection: "docs", action, ...(text ? { text } : {}) },
  },
});

it("records the real HTTP fixture's committed drop and makes an explicit replay visible as a second effect", async () => {
  const fixture = await httpFixture();
  const session = await fixture.initialize();
  const write = exchange("publish", "INTERRUPTED_HANDOFF");
  await expect(fixture.call(write, session)).rejects.toThrow();
  expect(await fixture.ledger()).toMatchObject([
    {
      actor: "probe",
      taskId: "probe-task",
      attemptId: "probe-attempt",
      transport: "http",
      action: "publish",
      committed: true,
      text: "INTERRUPTED_HANDOFF",
    },
  ]);
  const fresh = await fixture.initialize();
  const response = await fixture.call(exchange("read"), fresh);
  expect(await response.text()).toContain('"text":"INTERRUPTED_HANDOFF"');
  expect((await fixture.ledger()).filter((entry) => entry.committed)).toHaveLength(1);
  // Deliberately violate the client rule to demonstrate that the ledger detects duplicate writes.
  await expect(fixture.call(write, fresh)).rejects.toThrow();
  expect((await fixture.ledger()).filter((entry) => entry.committed)).toHaveLength(2);
});

it("forwards stdio identity through HTTP and deletes its owned session after EOF", async () => {
  const fixture = await httpFixture();
  let session: string | undefined;
  const deleted: string[] = [];
  let proxyError: unknown;
  const proxy = createServer(async (incoming, response) => {
    try {
      let body = "";
      for await (const chunk of incoming) body += chunk;
      if (incoming.method === "DELETE") deleted.push(String(incoming.headers["mcp-session-id"]));
      const headers = Object.fromEntries(
        Object.entries(incoming.headers)
          .filter(
            ([key]) => !["host", "connection", "content-length", "transfer-encoding"].includes(key),
          )
          .map(([key, value]) => [key, String(value)]),
      );
      const upstream = await fetch(fixture.url, {
        method: incoming.method,
        headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(2000),
      });
      session = upstream.headers.get("mcp-session-id") ?? session;
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(await upstream.text());
    } catch (error) {
      proxyError = error;
      response.destroy();
    }
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  cleanup.push(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((done) => proxy.close(() => done()));
  });
  const child = spawn(process.execPath, [fixturePath], {
    env: {
      PATH: process.env.PATH,
      MCP_PORT: String((proxy.address() as AddressInfo).port),
      MCP_FIXTURE_TOKEN: token,
      MCP_ACTOR: "reviewer",
      MCP_TASK: "review-task",
      MCP_ATTEMPT: "review-attempt",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanup.push(() => stop(child));
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-8192);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  const exited = once(child, "exit");
  child.stdin?.end(
    `${[
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      exchange("publish", "reviewer handoff"),
    ]
      .map((message) => JSON.stringify(message))
      .join("\n")}\n`,
  );
  await expect.poll(() => child.exitCode).toBe(0);
  expect(await exited).toEqual([0, null]);
  expect(proxyError).toBeUndefined();
  expect(stderr).toBe("");
  expect(stdout).toContain('"text":"reviewer handoff"');
  expect(await fixture.ledger()).toMatchObject([
    {
      actor: "reviewer",
      taskId: "review-task",
      attemptId: "review-attempt",
      transport: "stdio",
      action: "publish",
      committed: true,
      text: "reviewer handoff",
    },
  ]);
  expect(session).toBeTruthy();
  expect(deleted).toEqual([session]);
  const afterClose = await fixture.call(exchange("read"), session);
  expect(afterClose.status).toBe(404);
  await afterClose.body?.cancel();
});
