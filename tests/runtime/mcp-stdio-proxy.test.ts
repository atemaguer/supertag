import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_STDIO_PRESETS } from "../../apps/cli/src/host-mcp.ts";
import {
  approvalArgumentsDigest,
  type TagApprovalRequirement,
  type TagMcpGrant,
} from "../../packages/core/src/index.ts";
import {
  connectWorkerMcpClient,
  HttpMcpToolProvider,
  type McpResourceMapping,
  type McpServerDefinition,
  minimalProcessEnvironment,
  openTaskApprovalChannel,
  type ResolutionContext,
  readMcpServerConfiguration,
  resolveWorkspaceMcpServers,
  startMcpPolicyProxy,
  stdioMcpBaseEnvironment,
  type ToolInput,
  ToolProviderRegistry,
  withApprovalRequirements,
} from "../../packages/runtime/sdk/src/index.ts";

const SERVER = fileURLToPath(new URL("../support/fake-stdio-mcp-server.mjs", import.meta.url));
const SECRET = "stdio-secret-value-7f3a";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const GITHUB_LIKE: McpResourceMapping = {
  tools: {
    create_pull_request: [
      {
        prefix: "repository:",
        separator: "/",
        components: [{ arguments: ["owner"] }, { arguments: ["repo"] }],
      },
    ],
  },
};

describe("stdio MCP servers behind the per-Task policy proxy", () => {
  it("lists and forwards only granted tools, refusing others before the server", async () => {
    const log = await logFile();
    const [input] = await resolveTools(log, [{ action: "fake/get_*" }]);
    const client = await connectThroughProxy(input as ToolInput);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["get_issue"]);
    const refused = (await client.callTool({ name: "update_issue", arguments: {} })) as Denied;
    expect(refused.isError).toBe(true);
    expect((await client.callTool({ name: "get_issue", arguments: {} })).isError).toBeFalsy();
    expect(await calls(log)).toEqual(["get_issue"]);
  });

  it("checks resource arguments when the server has a mapping", async () => {
    const log = await logFile();
    const [input] = await resolveTools(
      log,
      [{ action: "fake/create_pull_request", resource: "repository:acme/api" }],
      GITHUB_LIKE,
    );
    const client = await connectThroughProxy(input as ToolInput);
    const call = (arguments_: Record<string, unknown>) =>
      client.callTool({ name: "create_pull_request", arguments: arguments_ }) as Promise<Denied>;
    expect((await call({ owner: "acme", repo: "web" })).isError).toBe(true);
    expect((await call({ owner: "acme" })).isError).toBe(true);
    expect(await calls(log)).toEqual([]);
    expect((await call({ owner: "acme", repo: "api" })).isError).toBeFalsy();
    expect(await calls(log)).toEqual(["create_pull_request"]);
  });

  it("maps the Lark preset's nested chat arguments to chat-scoped grants", async () => {
    const log = await logFile();
    const [input] = await resolveTools(
      log,
      [
        { action: "fake/im_v1_message_list", resource: "chat:oc_1" },
        { action: "fake/im_v1_message_create", resource: "chat:oc_1" },
      ],
      MCP_STDIO_PRESETS.lark.resources,
    );
    const client = await connectThroughProxy(input as ToolInput);
    const call = (name: string, arguments_: Record<string, unknown>) =>
      client.callTool({ name, arguments: arguments_ }) as Promise<Denied>;
    const listIn = (id: string, type = "chat") => ({
      params: { container_id_type: type, container_id: id },
    });
    const createIn = (id: string, type = "chat_id") => ({
      params: { receive_id_type: type },
      data: { receive_id: id, msg_type: "text", content: "{}" },
    });
    expect((await call("im_v1_message_list", listIn("oc_2"))).isError).toBe(true);
    expect((await call("im_v1_message_list", listIn("oc_1", "thread"))).isError).toBe(true);
    expect((await call("im_v1_message_list", { chat_id: "oc_1" })).isError).toBe(true);
    expect((await call("im_v1_message_create", createIn("oc_2"))).isError).toBe(true);
    expect((await call("im_v1_message_create", createIn("oc_1", "open_id"))).isError).toBe(true);
    expect(await calls(log)).toEqual([]);
    expect((await call("im_v1_message_list", listIn("oc_1"))).isError).toBeFalsy();
    expect((await call("im_v1_message_create", createIn("oc_1"))).isError).toBeFalsy();
    expect(await calls(log)).toEqual(["im_v1_message_list", "im_v1_message_create"]);
  });

  it("holds approval: required calls until the exact arguments are approved", async () => {
    const log = await logFile();
    const approved = new Set<string>();
    const [input] = await resolveTools(
      log,
      [{ action: "fake/update_issue" }],
      undefined,
      [
        {
          target: "mcp",
          action: "fake/update_issue",
          permissionSets: ["triage"],
          approvers: [],
        },
      ],
      approvalTransport(approved),
    );
    const client = await connectThroughProxy(input as ToolInput);
    const update = () =>
      client.callTool({ name: "update_issue", arguments: { id: "1" } }) as Promise<Denied>;
    expect((await update()).isError).toBe(true);
    expect(await calls(log)).toEqual([]);
    approved.add(approvalArgumentsDigest({ id: "1" }));
    expect((await update()).isError).toBeFalsy();
    expect(await calls(log)).toEqual(["update_issue"]);
  });

  it("gives env credentials only to the server process, never to the harness", async () => {
    const log = await logFile();
    process.env["SUPERTAG_TEST_WORKER_ONLY"] = "worker-only-value";
    cleanups.push(() => delete process.env["SUPERTAG_TEST_WORKER_ONLY"]);
    const [input] = await resolveTools(log, [{ action: "fake/read_env" }]);
    const tool = input as ToolInput;

    // The Tool input the harness adapters see names neither the command nor the environment.
    const serialized = JSON.stringify(tool);
    for (const hidden of [SECRET, "FAKE_TOKEN", SERVER, "fake-stdio-mcp-server", "command"])
      expect(serialized).not.toContain(hidden);
    const harnessConfiguration = readMcpServerConfiguration(tool, "harness-runtime");
    expect(harnessConfiguration.transport).toBe("mcp-http");
    expect(JSON.stringify(harnessConfiguration)).not.toContain(SECRET);

    const proxy = await startMcpPolicyProxy(tool);
    cleanups.push(() => proxy.close());
    // What the harness's MCP configuration receives: a loopback URL and a per-Attempt bearer.
    const harnessView = JSON.stringify({ url: proxy.url, headers: proxy.headers });
    for (const hidden of [SECRET, "FAKE_TOKEN", SERVER]) expect(harnessView).not.toContain(hidden);
    // The harness's process environment is an allowlist that drops server credentials.
    expect(minimalProcessEnvironment({ ...process.env, FAKE_TOKEN: SECRET })).not.toHaveProperty(
      "FAKE_TOKEN",
    );

    const client = await connect(proxy);
    const result = (await client.callTool({ name: "read_env", arguments: {} })) as {
      content: { text: string }[];
    };
    const seen = JSON.parse(result.content[0]?.text ?? "{}") as {
      environment: Record<string, string>;
    };
    expect(seen.environment["FAKE_TOKEN"]).toBe(SECRET);
    // The server gets its own env and a minimal default, not the Worker's environment.
    expect(seen.environment).not.toHaveProperty("SUPERTAG_TEST_WORKER_ONLY");
  });

  it("fails closed for a copied Tool input that carries no Worker launch", async () => {
    const log = await logFile();
    const [input] = await resolveTools(log, [{ action: "fake/get_issue" }]);
    const started = (await readFile(log, "utf8")).split("\n").filter(Boolean).length;
    const copy = structuredClone(input) as ToolInput;
    // Nothing may dial the placeholder URL: spy on every HTTP request the Worker makes.
    const dial = vi.spyOn(globalThis, "fetch");
    cleanups.push(() => dial.mockRestore());
    await expect(startMcpPolicyProxy(copy)).rejects.toThrow(/stdio server with no Worker launch/u);
    await expect(connectWorkerMcpClient(copy)).rejects.toThrow(
      /stdio server with no Worker launch/u,
    );
    expect(
      dial.mock.calls.filter(([target]) =>
        String(target instanceof Request ? target.url : target).includes("supertag-stdio"),
      ),
    ).toEqual([]);
    // Neither path launched the server again.
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean).length).toBe(started);
  });

  it("stops the server process when the proxy closes", async () => {
    const log = await logFile();
    const [input] = await resolveTools(log, [{ action: "fake/get_issue" }]);
    const proxy = await startMcpPolicyProxy(input as ToolInput);
    const client = await connect(proxy);
    await client.callTool({ name: "get_issue", arguments: {} });
    const pids = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { started?: number }).started)
      .filter((pid): pid is number => pid !== undefined);
    const serving = pids.at(-1) as number;
    await proxy.close();
    await expect.poll(() => alive(serving), { timeout: 5_000 }).toBe(false);
  });

  it("runs a listed Workspace stdio server in the checkout with its referenced env", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "supertag-stdio-workspace-"));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    await writeFile(join(checkout, "server.mjs"), await readFile(SERVER, "utf8"));
    await writeFile(
      join(checkout, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: {
            command: process.execPath,
            args: ["server.mjs"],
            // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
            env: { FAKE_TOKEN: "${SUPERTAG_MCP_TOKEN}" },
          },
        },
      }),
    );
    // The Worker's own credentials are in its environment, as on a real host.
    const workerCredentials = {
      GITHUB_TOKEN: "worker-github-token",
      SUPERTAG_AUTH_KEY: "stak_worker-auth-key",
      OPENAI_API_KEY: "worker-openai-key",
      CODEX_API_KEY: "worker-codex-key",
      ANTHROPIC_API_KEY: "worker-anthropic-key",
    };
    for (const [name, value] of Object.entries(workerCredentials)) vi.stubEnv(name, value);
    cleanups.push(() => vi.unstubAllEnvs());
    const resolved = await resolveWorkspaceMcpServers(checkout, ["local"], {
      SUPERTAG_MCP_TOKEN: SECRET,
    });
    expect(resolved.digest).not.toContain(SECRET);
    const provider = new HttpMcpToolProvider({
      servers: {},
      workspaceServers: () => resolved.servers,
    });
    const [input] = await new ToolProviderRegistry([provider]).resolve(
      context([{ action: "local/read_env" }]),
    );
    expect(JSON.stringify(input)).not.toContain(SECRET);
    const client = await connectThroughProxy(input as ToolInput);
    const result = (await client.callTool({ name: "read_env", arguments: {} })) as {
      content: { text: string }[];
    };
    const seen = JSON.parse(result.content[0]?.text ?? "{}") as {
      environment: Record<string, string>;
      cwd: string;
    };
    expect(seen.environment["FAKE_TOKEN"]).toBe(SECRET);
    expect(await realpath(seen.cwd)).toBe(await realpath(checkout));
    // The server starts with a minimal environment plus its own env, never the Worker's
    // credentials.
    for (const name of Object.keys(workerCredentials))
      expect(seen.environment).not.toHaveProperty(name);
    expect(JSON.stringify(seen.environment)).not.toMatch(/worker-|stak_/u);
    const allowed = new Set([
      ...Object.keys(stdioMcpBaseEnvironment()),
      "FAKE_TOKEN",
      // macOS adds this to every new process; it is not inherited from the Worker.
      "__CF_USER_TEXT_ENCODING",
    ]);
    expect(Object.keys(seen.environment).filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("rejects literal env values in a Workspace .mcp.json", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "supertag-stdio-literal-"));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    await writeFile(
      join(checkout, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: process.execPath, env: { FAKE_TOKEN: "literal-secret" } },
        },
      }),
    );
    await expect(resolveWorkspaceMcpServers(checkout, ["local"], {})).rejects.toThrow(
      /literal values are not allowed/u,
    );
    await writeFile(
      join(checkout, ".mcp.json"),
      JSON.stringify({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: A mixed literal and reference.
        mcpServers: { local: { command: process.execPath, env: { FAKE_TOKEN: "x-${TOKEN}" } } },
      }),
    );
    await expect(
      resolveWorkspaceMcpServers(checkout, ["local"], { TOKEN: SECRET }),
    ).rejects.toThrow(/literal values are not allowed/u);
  });

  it("refreshes HTTP credentials on 401 for an approval-required tool", async () => {
    let valid = "token-1";
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${valid}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) {
        response.writeHead(202).end();
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
            ? { tools: [{ name: "get_issue", inputSchema: { type: "object" } }] }
            : {};
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address() as { port: number };
    let version = 1;
    const provider = new HttpMcpToolProvider({
      servers: { remote: { url: `http://127.0.0.1:${address.port}/mcp` } },
      headers: ({ refresh }) => {
        if (refresh === true) version += 1;
        return { Authorization: `Bearer token-${version}` };
      },
    });
    const approvals: TagApprovalRequirement[] = [
      { target: "mcp", action: "remote/get_issue" } as TagApprovalRequirement,
    ];
    const inputs = await new ToolProviderRegistry([provider]).resolve(
      context([{ action: "remote/get_issue" }], approvals),
    );
    const [input] = withApprovalRequirements(inputs, approvals, () => undefined) as ToolInput[];
    expect(input?.capability.authorization.mcp?.approvalRequired).toHaveLength(1);
    valid = "token-2";
    const connection = await connectWorkerMcpClient(input as ToolInput);
    cleanups.push(() => connection.close());
    expect(version).toBe(2);
  });

  it("reports a server that cannot start by name only", async () => {
    const provider = new HttpMcpToolProvider({
      servers: { broken: { command: join(tmpdir(), "supertag-missing-mcp-server") } },
      environment: () => ({ FAKE_TOKEN: SECRET }),
      listTimeoutMs: 5_000,
    });
    const resolving = new ToolProviderRegistry([provider]).resolve(
      context([{ action: "broken/*" }]),
    );
    await expect(resolving).rejects.toThrow(/^Could not list the tools of MCP server broken$/u);
  });
});

type Denied = { readonly isError?: boolean };

async function realpath(path: string): Promise<string> {
  const { realpath: resolve } = await import("node:fs/promises");
  return resolve(path);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function logFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supertag-stdio-mcp-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "calls.jsonl");
  await writeFile(path, "");
  return path;
}

async function calls(log: string): Promise<string[]> {
  return (await readFile(log, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { call?: string }).call)
    .filter((call): call is string => call !== undefined);
}

function context(
  grants: readonly TagMcpGrant[],
  approvals: readonly TagApprovalRequirement[] = [],
): ResolutionContext {
  return {
    task: {
      taskId: "task-1",
      attemptId: "attempt-1",
      authorization: {
        version: 4,
        runtimeActions: [],
        resources: [],
        mcp: grants,
        ...(approvals.length ? { approvals } : {}),
      },
    },
    profile: {},
  } as unknown as ResolutionContext;
}

async function resolveTools(
  log: string,
  grants: readonly TagMcpGrant[],
  resources?: McpResourceMapping,
  approvals: readonly TagApprovalRequirement[] = [],
  transport?: typeof fetch,
): Promise<readonly ToolInput[]> {
  const server: McpServerDefinition = {
    command: process.execPath,
    args: [SERVER],
    ...(resources === undefined ? {} : { resources }),
  };
  const provider = new HttpMcpToolProvider({
    servers: { fake: server },
    environment: ({ server: name }) =>
      name === "fake" ? { FAKE_TOKEN: SECRET, FAKE_MCP_LOG: log } : {},
  });
  const inputs = await new ToolProviderRegistry([provider]).resolve(context(grants, approvals));
  return withApprovalRequirements(inputs, approvals, () => {
    if (transport === undefined) return undefined;
    const channel = openTaskApprovalChannel(
      {
        coordination: {
          controlPlaneUrl: "http://127.0.0.1:9",
          token: "unused",
          objectiveId: "objective-1",
        },
      },
      transport,
    );
    if (channel === undefined) return undefined;
    cleanups.push(() => channel.close());
    return channel.handle;
  }) as ToolInput[];
}

/** A Control Plane stand-in that grants only calls whose argument digest was approved. */
function approvalTransport(approved: ReadonlySet<string>): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const rpc = JSON.parse(String(init?.body)) as {
      id: number;
      params: { arguments: { argumentsDigest: string } };
    };
    const status = approved.has(rpc.params.arguments.argumentsDigest) ? "granted" : "pending";
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: JSON.stringify({ status, requestId: "r1" }) }] },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

async function connectThroughProxy(input: ToolInput): Promise<Client> {
  const proxy = await startMcpPolicyProxy(input);
  cleanups.push(() => proxy.close());
  return await connect(proxy);
}

async function connect(proxy: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}): Promise<Client> {
  const client = new Client({ name: "harness", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(proxy.url), {
      requestInit: { headers: proxy.headers },
    }),
  );
  cleanups.push(() => client.close());
  return client;
}
