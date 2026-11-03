import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectExecutionEnvironmentMcpClient,
  type ExecutionEnvironment,
  LocalExecutionEnvironmentProvider,
  type ToolInput,
} from "../../packages/runtime/sdk/src/index.ts";
import { repositoryAttempt } from "../support/repository-execution.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
});

async function environment(): Promise<ExecutionEnvironment> {
  const attempt = repositoryAttempt("mcp-lifecycle");
  const plan = {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "unrestricted" as const },
  };
  const instance = await new LocalExecutionEnvironmentProvider().provision({
    task: attempt,
    profile: {
      ref: attempt.workerProfile,
      workerType: "supertag",
      harness: { provider: "codex" },
      execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
    },
    plan,
  });
  await instance.prepare(plan);
  cleanups.push(() => instance.dispose());
  return instance;
}

function input(binding: ToolInput["binding"]): ToolInput {
  return {
    id: "environment",
    kind: "tool",
    required: true,
    capability: {
      id: "environment",
      provider: "test",
      operations: [
        {
          name: "lookup",
          effect: "read",
          actions: ["documents:read"],
          resourceArgumentPolicies: [
            { match: "scope", prefix: "collection:", components: [{ arguments: ["collection"] }] },
          ],
        },
      ],
      authorization: {
        provider: "test",
        resources: [{ surfaceAccountId: "test", scope: "collection:docs" }],
      },
    },
    binding,
  };
}
const schemas = [
  {
    name: "lookup",
    inputSchema: {
      type: "object",
      properties: { collection: { type: "string" } },
      required: ["collection"],
    },
  },
  { name: "hidden", inputSchema: { type: "object" } },
];
const stdioPrefix = String.raw`
const lines = require("node:readline").createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
lines.on("line", line => {
 const request = JSON.parse(line);
 if (request.method === "initialize") send(request.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } });
 if (request.method === "tools/list") send(request.id, { tools: [{ name: "lookup", inputSchema: { type: "object" } }] });
`;

async function httpFixture(mode: "json" | "sse" | "disconnect" | "redirect") {
  const calls: string[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const server = createServer(async (request, response) => {
    headers.push(request.headers);
    if (request.method === "DELETE") {
      calls.push("delete");
      response.writeHead(200).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    calls.push(message.method);
    if (mode === "redirect") {
      response.writeHead(307, { location: "/redirected" }).end();
      return;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    if (message.method === "tools/call" && mode === "disconnect") {
      request.socket.destroy();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "http", version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: schemas }
          : { content: [{ type: "text", text: "from environment" }] };
    response.writeHead(200, {
      "content-type": mode === "sse" ? "text/event-stream" : "application/json",
      ...(message.method === "initialize" ? { "mcp-session-id": "session-1" } : {}),
    });
    const json = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    if (mode === "sse") {
      response.write(
        ': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\r\n\r\n',
      );
      response.end(`event: message\r\ndata: ${json}\r\n\r\n`);
    } else response.end(json);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return {
    calls,
    headers,
    binding: {
      kind: "mcp-http" as const,
      name: "test",
      url: `http://127.0.0.1:${address.port}/mcp`,
      runtimeHeaders: { Authorization: "Bearer environment-test-secret" },
    },
  };
}

describe("execution environment MCP lifecycle", () => {
  it.each(["json", "sse"] as const)(
    "owns an HTTP %s session and checks resource arguments",
    async (mode) => {
      const server = await httpFixture(mode);
      const connection = await connectExecutionEnvironmentMcpClient(
        await environment(),
        input(server.binding),
      );
      try {
        expect(connection.tools.map((tool) => tool.name)).toEqual(["lookup"]);
        await expect(connection.callTool("lookup", { collection: "docs" })).resolves.toMatchObject({
          content: [{ text: "from environment" }],
        });
        await expect(
          connection.callTool("lookup", { collection: "private" }),
        ).resolves.toMatchObject({ isError: true });
        await expect(connection.callTool("hidden", {})).rejects.toThrow("not admitted");
        expect(server.calls.filter((call) => call === "tools/call")).toHaveLength(1);
        expect(
          server.headers.every(
            (headers) => headers.authorization === "Bearer environment-test-secret",
          ),
        ).toBe(true);
        expect(
          server.headers
            .slice(1)
            .every(
              (headers) =>
                headers["mcp-session-id"] === "session-1" &&
                headers["mcp-protocol-version"] === "2025-06-18",
            ),
        ).toBe(true);
      } finally {
        await connection.close();
      }
      expect(server.calls).toContain("delete");
    },
  );

  it("does not replay an HTTP call after a lost response", async () => {
    const server = await httpFixture("disconnect");
    const connection = await connectExecutionEnvironmentMcpClient(
      await environment(),
      input(server.binding),
    );
    try {
      await expect(connection.callTool("lookup", { collection: "docs" })).rejects.toThrow();
      await expect(connection.callTool("lookup", { collection: "docs" })).rejects.toThrow();
      expect(server.calls.filter((call) => call === "tools/call")).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });

  it("rejects redirects without forwarding the credential", async () => {
    const server = await httpFixture("redirect");
    await expect(
      connectExecutionEnvironmentMcpClient(await environment(), input(server.binding)),
    ).rejects.toThrow();
    expect(server.calls).toEqual(["initialize"]);
  });

  it("times out a hung call once and terminates a server that ignores SIGTERM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-hung-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const pidFile = join(dir, "pid");
    const countFile = join(dir, "calls");
    const code =
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n` +
      stdioPrefix +
      `if (request.method === "tools/call") require("node:fs").appendFileSync(${JSON.stringify(countFile)}, "call\\n"); });`;
    const connection = await connectExecutionEnvironmentMcpClient(
      await environment(),
      input({ kind: "mcp-stdio", name: "hung", command: process.execPath, args: ["-e", code] }),
      // The bound also covers the start handshake, which launches two Node.js processes; keep
      // it above process start-up time on a loaded runner so only the hung call times out.
      { timeoutMs: 2000 },
    );
    await expect(connection.callTool("lookup", { collection: "docs" })).rejects.toThrow(
      "timed out",
    );
    await expect(connection.callTool("lookup", { collection: "docs" })).rejects.toThrow(
      "timed out",
    );
    await connection.close();
    expect(await readFile(countFile, "utf8")).toBe("call\n");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("aborts an active call and rejects subsequent calls", async () => {
    const controller = new AbortController();
    const connection = await connectExecutionEnvironmentMcpClient(
      await environment(),
      input({
        kind: "mcp-stdio",
        name: "abort",
        command: process.execPath,
        args: ["-e", `${stdioPrefix}});`],
      }),
      { signal: controller.signal },
    );
    const call = connection.callTool("lookup", { collection: "docs" });
    controller.abort(new Error("test cancellation"));
    await expect(call).rejects.toThrow("test cancellation");
    await expect(connection.callTool("lookup", { collection: "docs" })).rejects.toThrow(
      "test cancellation",
    );
    await connection.close();
  });

  it.each([
    "process.stdout.write('invalid-json\\n');",
    "process.stdout.write('x'.repeat(2 * 1024 * 1024));",
  ])("fails a malformed server stream without waiting for request timeout", async (output) => {
    const start = Date.now();
    await expect(
      connectExecutionEnvironmentMcpClient(
        await environment(),
        input({
          kind: "mcp-stdio",
          name: "broken",
          command: process.execPath,
          args: ["-e", `${output}setInterval(() => {}, 1000);`],
        }),
      ),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(3_000);
  });
});

it("reports unconfirmed termination instead of silently completing cleanup", async () => {
  const actual = await environment();
  const unavailableWait = new Proxy(actual, {
    get(target, key) {
      if (key === "spawn")
        return async (...args: Parameters<ExecutionEnvironment["spawn"]>) => {
          const handle = await target.spawn(...args);
          return new Proxy(handle, {
            get(process, property) {
              if (property === "wait") return () => new Promise<never>(() => {});
              const value = Reflect.get(process, property, process);
              return typeof value === "function" ? value.bind(process) : value;
            },
          });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const connection = await connectExecutionEnvironmentMcpClient(
    unavailableWait,
    input({
      kind: "mcp-stdio",
      name: "missing-termination",
      command: process.execPath,
      args: ["-e", `${stdioPrefix}});`],
    }),
  );
  const closed = connection.close();
  await expect(closed).rejects.toThrow("could not confirm process termination");
  expect(connection.close()).toBe(closed);
});
