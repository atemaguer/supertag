import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectExecutionEnvironmentMcpClient,
  connectWorkerMcpClient,
  type ExecutionEnvironment,
  LocalExecutionEnvironmentProvider,
  type McpClientConnection,
  startMcpPolicyProxy,
  type ToolInput,
} from "../../packages/runtime/sdk/src/index.ts";
import { repositoryAttempt } from "../support/repository-execution.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "MCP fixture cleanup failed");
});

async function environment(): Promise<ExecutionEnvironment> {
  const attempt = repositoryAttempt(`mcp-reliability-${randomUUID()}`);
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

function toolInput(collection: string, binding: ToolInput["binding"]): ToolInput {
  return {
    id: `task-${collection}`,
    kind: "tool",
    required: true,
    capability: {
      id: "notes",
      provider: "fixture",
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
        provider: "fixture",
        resources: [{ surfaceAccountId: "fixture", scope: `collection:${collection}` }],
      },
    },
    binding,
  };
}

const tools = [
  { name: "exchange", inputSchema: { type: "object" as const } },
  { name: "unadmitted", inputSchema: { type: "object" as const } },
];

/** Records side effects before responding, independently of client observations. */
async function httpFixture(options: { deleteStatus?: number | "hang" } = {}) {
  const sessions = new Set<string>();
  const created: string[] = [];
  const revoked = new Set<string>();
  const closed: string[] = [];
  const paths: string[] = [];
  const writes: { session: string; collection: string; text: string }[] = [];
  const calls: { session: string; collection: string }[] = [];
  const notes = new Map<string, string>();
  let dropNextWrite: "disconnect" | "expired" | undefined;
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? "");
    const session = String(request.headers["mcp-session-id"] ?? "");
    if (request.method === "DELETE") {
      closed.push(session);
      if (options.deleteStatus === "hang") return;
      const status = options.deleteStatus ?? 200;
      if (status === 200) sessions.delete(session);
      response.writeHead(status).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.method !== "initialize" && (!sessions.has(session) || revoked.has(session))) {
      response.writeHead(403).end();
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    let newSession: string | undefined;
    if (message.method === "initialize") {
      newSession = randomUUID();
      sessions.add(newSession);
      created.push(newSession);
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "reliability", version: "1" },
      };
    } else if (message.method === "tools/list") {
      result = { tools };
    } else if (message.method === "tools/call") {
      const { collection, text } = message.params.arguments;
      calls.push({ session, collection });
      if (typeof text === "string") {
        writes.push({ session, collection, text });
        notes.set(collection, text);
        if (dropNextWrite) {
          if (dropNextWrite === "expired") {
            sessions.delete(session);
            response.writeHead(404).end();
          } else request.socket.destroy();
          dropNextWrite = undefined;
          return;
        }
      }
      result = { content: [{ type: "text", text: notes.get(collection) ?? "empty" }] };
    }
    response.writeHead(200, {
      "content-type": "application/json",
      ...(newSession ? { "mcp-session-id": newSession } : {}),
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    binding: {
      kind: "mcp-http" as const,
      name: "fixture",
      url: `http://127.0.0.1:${address.port}/mcp`,
    },
    sessions,
    created,
    revoked,
    closed,
    paths,
    calls,
    writes,
    dropNextWrite: (mode: "disconnect" | "expired") => {
      dropNextWrite = mode;
    },
  };
}

type Placement = "worker-host" | "execution-environment" | "harness-policy-proxy";
type Connection = Pick<McpClientConnection, "tools" | "callTool" | "close">;
async function connect(placement: Placement, input: ToolInput): Promise<Connection> {
  let connection: Connection;
  if (placement === "execution-environment") {
    connection = await connectExecutionEnvironmentMcpClient(await environment(), input);
  } else if (placement === "worker-host") {
    connection = await connectWorkerMcpClient(input);
  } else {
    const proxy = await startMcpPolicyProxy(input);
    const client = new Client({ name: "harness-fixture", version: "1" });
    cleanups.push(() => proxy.close());
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: proxy.headers },
      }),
    );
    const advertised = await client.listTools();
    connection = {
      tools: advertised.tools,
      callTool: (name, arguments_) => client.callTool({ name, arguments: arguments_ }),
      close: async () => {
        await client.close();
        await proxy.close();
      },
    };
  }
  cleanups.push(() => connection.close());
  return connection;
}

describe.each(["worker-host", "execution-environment", "harness-policy-proxy"] as const)(
  "%s MCP reliability",
  (placement) => {
    it("keeps concurrent Task policies and cleanup independent", async () => {
      const fixture = await httpFixture();
      const first = await connect(placement, toolInput("alpha", fixture.binding));
      const second = await connect(placement, toolInput("beta", fixture.binding));
      expect(first.tools.map((tool) => tool.name)).toEqual(["exchange"]);
      expect(second.tools.map((tool) => tool.name)).toEqual(["exchange"]);
      for (const [connection, collection] of [
        [first, "beta"],
        [second, "alpha"],
      ] as const) {
        await expect(
          connection.callTool("exchange", { collection, text: "denied" }),
        ).resolves.toMatchObject({ isError: true });
        const hidden = await connection.callTool("unadmitted", {}).catch(() => ({ isError: true }));
        expect(hidden).toMatchObject({ isError: true });
      }
      expect(fixture.calls).toHaveLength(0);
      await first.callTool("exchange", { collection: "alpha", text: "first" });
      await second.callTool("exchange", { collection: "beta", text: "second" });
      expect(new Set(fixture.calls.map((call) => call.session)).size).toBe(2);
      await first.close();
      await expect(
        first.callTool("exchange", { collection: "alpha", text: "after close" }),
      ).rejects.toThrow();
      await expect(second.callTool("exchange", { collection: "beta" })).resolves.toMatchObject({
        content: [{ text: "second" }],
      });
      expect(fixture.writes.map(({ collection, text }) => ({ collection, text }))).toEqual([
        { collection: "alpha", text: "first" },
        { collection: "beta", text: "second" },
      ]);
      expect(fixture.closed).toEqual([fixture.writes[0]?.session]);
      expect(fixture.sessions.has(fixture.writes[1]?.session ?? "")).toBe(true);
    });

    it.each(["disconnect", "expired"] as const)(
      "does not replay a committed write after %s",
      async (failure) => {
        const fixture = await httpFixture();
        const connection = await connect(placement, toolInput("alpha", fixture.binding));
        fixture.dropNextWrite(failure);
        // Rejection is an unknown result: the server has already committed the write.
        await expect(
          connection.callTool("exchange", { collection: "alpha", text: "committed" }),
        ).rejects.toThrow();
        await connection.close();
        expect(fixture.writes).toHaveLength(1);
        expect(fixture.created).toHaveLength(1);
        const recovered = await connect(placement, toolInput("alpha", fixture.binding));
        await expect(
          recovered.callTool("exchange", { collection: "alpha" }),
        ).resolves.toMatchObject({
          content: [{ text: "committed" }],
        });
        expect(fixture.writes).toHaveLength(1);
        expect(fixture.calls).toHaveLength(2);
        expect(fixture.created).toHaveLength(2);
      },
    );

    it("does not recreate a revoked session or affect another Task", async () => {
      const fixture = await httpFixture();
      const first = await connect(placement, toolInput("alpha", fixture.binding));
      const second = await connect(placement, toolInput("beta", fixture.binding));
      await first.callTool("exchange", { collection: "alpha", text: "first" });
      await second.callTool("exchange", { collection: "beta", text: "second" });
      const firstSession = fixture.writes[0]?.session;
      if (!firstSession) throw new Error("Missing admitted session");
      fixture.revoked.add(firstSession);
      await expect(
        first.callTool("exchange", { collection: "alpha", text: "revoked" }),
      ).rejects.toThrow();
      await first.close();
      await expect(
        second.callTool("exchange", { collection: "beta", text: "still allowed" }),
      ).resolves.toMatchObject({ content: [{ text: "still allowed" }] });
      expect(fixture.writes.map((write) => write.text)).toEqual([
        "first",
        "second",
        "still allowed",
      ]);
      expect(new Set(fixture.calls.map((call) => call.session)).size).toBe(2);
    });
  },
);

describe.each(["worker-host", "harness-policy-proxy", "execution-environment"] as const)(
  "%s session disposal",
  (placement) => {
    it.each([404, 405, 410])(
      "accepts DELETE %i and closes only the local client",
      async (deleteStatus) => {
        const fixture = await httpFixture({ deleteStatus });
        const connection = await connect(placement, toolInput("alpha", fixture.binding));
        await connection.close();
        await expect(connection.callTool("exchange", { collection: "alpha" })).rejects.toThrow();
        expect(fixture.closed).toEqual(fixture.created);
        expect(fixture.writes).toHaveLength(0);
      },
    );
  },
);

it.each([
  ["worker-host", 503],
  ["worker-host", "hang"],
  ["execution-environment", 503],
  ["execution-environment", "hang"],
] as const)(
  "reports unconfirmed %s session cleanup on DELETE %s",
  async (placement, deleteStatus) => {
    const fixture = await httpFixture({ deleteStatus });
    const input = toolInput("alpha", fixture.binding);
    const connection =
      placement === "worker-host"
        ? await connectWorkerMcpClient(input)
        : await connectExecutionEnvironmentMcpClient(await environment(), input);
    cleanups.push(() => connection.close().catch(() => {}));
    const start = performance.now();
    const closed = connection.close();
    await expect(closed).rejects.toMatchObject({ name: "ExecutionCleanupError" });
    expect(performance.now() - start).toBeLessThan(2_000);
    expect(connection.close()).toBe(closed);
    await expect(
      connection.callTool("exchange", { collection: "alpha", text: "after close" }),
    ).rejects.toThrow();
    expect(fixture.closed).toEqual(fixture.created);
    expect(fixture.writes).toHaveLength(0);
  },
);

it.each(["worker-host", "execution-environment"] as const)(
  "preserves %s startup and cleanup errors when a required tool is missing",
  async (placement) => {
    const fixture = await httpFixture({ deleteStatus: 503 });
    const input = toolInput("alpha", fixture.binding);
    const missingInput: ToolInput = {
      ...input,
      capability: {
        ...input.capability,
        operations: [{ name: "missing", effect: "read", actions: ["notes:read"] }],
      },
    };
    const error = await (placement === "worker-host"
      ? connectWorkerMcpClient(missingInput)
      : connectExecutionEnvironmentMcpClient(await environment(), missingInput)
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      name: "ExecutionCleanupError",
      cause: {
        errors: [
          { message: expect.stringContaining("MCP tools are unavailable: missing") },
          { name: "ExecutionCleanupError" },
        ],
      },
    });
    expect(fixture.closed).toEqual(fixture.created);
  },
);

it("does not rebind coordination authority during session cleanup", async () => {
  const fixture = await httpFixture({ deleteStatus: 401 });
  const input = toolInput("alpha", fixture.binding);
  const connection = await connectWorkerMcpClient({
    ...input,
    id: "supertag-coordination",
    capability: { ...input.capability, provider: "supertag" },
    binding: {
      ...fixture.binding,
      name: "supertag-coordination",
      runtimeHeaders: { Authorization: "Bearer fixture-only" },
    },
  });
  cleanups.push(() => connection.close().catch(() => {}));
  await expect(connection.close()).rejects.toMatchObject({ name: "ExecutionCleanupError" });
  expect(fixture.paths.every((path) => path === "/mcp")).toBe(true);
  expect(fixture.created).toHaveLength(1);
});

it("flushes an asynchronous cleanup-failure frame before the bridge exits", async () => {
  const fixture = await httpFixture({ deleteStatus: 503 });
  const actual = await environment();
  const delayedOutput = new Proxy(actual, {
    get(target, key) {
      if (key === "spawn")
        return async (spec: Parameters<ExecutionEnvironment["spawn"]>[0]) => {
          const args = [...(spec.args ?? [])];
          const source = args[1];
          if (args[0] !== "-e" || typeof source !== "string")
            throw new Error("Expected bridge program");
          // Model a pipe write whose callback fires on a later event-loop turn.
          args[1] = `
const writeOutput = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  if (typeof chunk === "string" && chunk.includes('"cleanupError"')) {
    setTimeout(() => writeOutput(chunk, ...args), 50);
    return true;
  }
  return writeOutput(chunk, ...args);
};
${source}`;
          return target.spawn({ ...spec, args });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const connection = await connectExecutionEnvironmentMcpClient(
    delayedOutput,
    toolInput("alpha", fixture.binding),
  );
  cleanups.push(() => connection.close().catch(() => {}));
  await expect(connection.close()).rejects.toMatchObject({
    name: "ExecutionCleanupError",
    message: "Execution-environment MCP cleanup could not confirm session termination",
  });
  expect(fixture.closed).toEqual(fixture.created);
});

it.each(["exit", "abort"] as const)(
  "cleans only its stdio server and descendants after %s during a committed write",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-owned-processes-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const shared = await environment();
    let firstPids: number[] = [];
    let secondPids: number[] = [];
    // A failed ownership assertion must still remove the fixture descendants.
    cleanups.push(async () => {
      for (const pid of [...firstPids, ...secondPids]) {
        if (processExists(pid)) process.kill(pid, "SIGKILL");
      }
    });
    const controller = new AbortController();
    const binding = (name: string): ToolInput["binding"] => ({
      kind: "mcp-stdio",
      name,
      command: process.execPath,
      args: [
        "-e",
        String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.FIXTURE_ROOT;
const child = require("node:child_process").spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
const ready = new Promise(resolve => child.stdout.once("data", resolve));
fs.writeFileSync(path.join(root, process.env.FIXTURE_NAME + "-pids"), JSON.stringify([process.pid, child.pid]));
require("node:readline").createInterface({ input: process.stdin }).on("line", async line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  await ready;
  let result;
  if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "owned", version: "1" } };
  if (message.method === "tools/list") result = { tools: [{ name: "exchange", inputSchema: { type: "object" } }] };
  if (message.method === "tools/call") {
    const args = message.params.arguments;
    if (args.text) {
      fs.appendFileSync(path.join(root, "writes"), args.text + "\n");
      if (process.env.FIXTURE_FAILURE === "exit") process.exit(1);
      if (process.env.FIXTURE_FAILURE === "abort") return;
    }
    result = { content: [{ type: "text", text: "alive" }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
`,
      ],
      runtimeEnvironment: {
        FIXTURE_ROOT: directory,
        FIXTURE_NAME: name,
        FIXTURE_FAILURE: name === "first" ? failure : "none",
      },
    });
    const first = await connectExecutionEnvironmentMcpClient(
      shared,
      toolInput("alpha", binding("first")),
      { signal: controller.signal },
    );
    cleanups.push(() => first.close());
    const second = await connectExecutionEnvironmentMcpClient(
      shared,
      toolInput("beta", binding("second")),
    );
    cleanups.push(() => second.close());
    firstPids = JSON.parse(await readFile(join(directory, "first-pids"), "utf8")) as number[];
    secondPids = JSON.parse(await readFile(join(directory, "second-pids"), "utf8")) as number[];
    const failed = expect(
      first.callTool("exchange", { collection: "alpha", text: "committed" }),
    ).rejects.toThrow();
    await expect.poll(async () => readFile(join(directory, "writes"), "utf8")).toBe("committed\n");
    if (failure === "abort") controller.abort(new Error("Attempt cancelled"));
    await failed;
    await first.close();
    for (const pid of firstPids) await expect.poll(() => processExists(pid)).toBe(false);
    for (const pid of secondPids) expect(processExists(pid)).toBe(true);
    await expect(second.callTool("exchange", { collection: "beta" })).resolves.toMatchObject({
      content: [{ text: "alive" }],
    });
    await expect(
      first.callTool("exchange", { collection: "alpha", text: "duplicate" }),
    ).rejects.toThrow();
    expect(await readFile(join(directory, "writes"), "utf8")).toBe("committed\n");
    await second.close();
    for (const pid of secondPids) await expect.poll(() => processExists(pid)).toBe(false);
  },
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
