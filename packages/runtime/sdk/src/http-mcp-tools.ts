import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  isReservedMcpServerName,
  type JsonRecord,
  MCP_SERVER_NAME,
  MCP_TOOL_NAME,
  mcpGrantsFor,
  mcpServersOfGrants,
  type TagMcpGrant,
} from "@supertag/core";
import { openEnvironmentMcpBridge } from "./environment-mcp-bridge.js";
import type {
  ExecutionEnvironment,
  ResolutionContext,
  TaskAttemptSpec,
  ToolBundle,
  ToolInput,
  ToolOperation,
  ToolProvider,
  ToolResourceArgumentPolicy,
} from "./index.js";
import type { ResolvedWorkspaceMcpServer } from "./workspace-mcp.js";

/**
 * How a server's tool arguments name a resource, so Permission Set grants can carry a
 * `resource` such as `repository:acme/api`. Each tool lists rules; a call names a resource
 * when every component of one rule is present. A rule produces
 * `prefix + components.join(separator)`. Presets supply mappings for the servers SuperTag knows.
 */
export interface McpResourceMapping {
  readonly tools: Readonly<Record<string, readonly McpResourceRule[]>>;
}

export type McpResourceRule = Omit<ToolResourceArgumentPolicy, "match">;

/** One HTTP MCP server a Worker Host provides. */
export interface HttpMcpServer {
  readonly url: string;
  /** Present only for servers whose grants may name a `resource`. */
  readonly resources?: McpResourceMapping;
}

/**
 * One stdio MCP server a Worker Host provides. The Worker launches it for each Task Attempt and
 * speaks MCP to it; the harness reaches it only through the Worker's per-Task policy proxy and
 * never receives its command or environment.
 */
export interface StdioMcpServer {
  readonly command: string;
  readonly args?: readonly string[];
  /** Working directory for the server process; the Worker's own by default. */
  readonly cwd?: string;
  /** Present only for servers whose grants may name a `resource`. */
  readonly resources?: McpResourceMapping;
}

/** An HTTP or stdio MCP server a Worker Host provides. */
export type McpServerDefinition = HttpMcpServer | StdioMcpServer;

/**
 * Supplies the environment the Worker starts one stdio server with for one Task Attempt, such
 * as `DATABASE_URL`. The values reach only the server process, never the harness or its shell.
 */
export type McpServerEnvironment = (request: {
  readonly server: string;
  readonly task: TaskAttemptSpec;
}) => Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>;

/** How the Worker starts one stdio server. Runtime-only: never serialized or shown. */
export interface McpStdioLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

// Runtime-only: how the policy proxy starts a stdio server, keyed by the Tool input's binding
// object so policy layers that spread the input (such as approval requirements) keep it. Never
// serialized: a cloned input, or a harness copy with a rebuilt binding, has no launch and fails
// closed instead of reaching the server.
const stdioLaunches = new WeakMap<object, McpStdioLaunch>();

/** The launch the policy proxy uses for one resolved stdio server, if the input is one. */
export function mcpStdioLaunch(input: ToolInput): McpStdioLaunch | undefined {
  return stdioLaunches.get(input.binding);
}

/**
 * How the Worker reaches one Workspace stdio server that runs inside a Task's sandbox: the
 * environment MCP bridge starts it there, from the trusted copy at `cwd`, with no host variables.
 * Runtime-only, like {@link McpStdioLaunch}: the harness still reaches the server only through
 * the Worker's policy proxy, which checks every call.
 */
export interface McpSandboxLaunch {
  readonly environment: ExecutionEnvironment;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

const sandboxLaunches = new WeakMap<object, McpSandboxLaunch>();

/** The sandbox launch for one Workspace stdio server, if the input is one. */
export function mcpSandboxLaunch(input: ToolInput): McpSandboxLaunch | undefined {
  return sandboxLaunches.get(input.binding);
}

/**
 * The binding URL of a stdio-backed Tool input. It is never dialed: the policy proxy starts the
 * server from the runtime-only launch instead, and the discard port fails closed otherwise.
 */
export function stdioMcpBindingUrl(name: string): string {
  return `http://127.0.0.1:9/supertag-stdio/${name}`;
}

/** True for the placeholder binding URL of a stdio server, which must never be dialed. */
export function isStdioMcpBindingUrl(url: string): boolean {
  return url.startsWith("http://127.0.0.1:9/supertag-stdio/");
}

/**
 * Variables of the Worker's environment a stdio server inherits. The MCP SDK always adds its
 * own default (HOME, LOGNAME, PATH, SHELL, TERM, USER); this adds locale and temporary-directory
 * settings. Nothing credential-like, such as GITHUB_TOKEN, SUPERTAG_AUTH_KEY, or a model API key,
 * is ever inherited: a server receives credentials only through its own `env`.
 */
const STDIO_INHERITED_VARIABLES = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
] as const;

/** The minimal environment a stdio server starts with, before its own `env`. */
export function stdioMcpBaseEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    STDIO_INHERITED_VARIABLES.flatMap((key) => {
      const value = environment[key];
      // Exported shell functions are never inherited.
      return value === undefined || value.startsWith("()") ? [] : [[key, value]];
    }),
  );
}

/**
 * The client transport for one stdio server. The process gets a minimal environment (see
 * {@link stdioMcpBaseEnvironment}) plus the server's own `env`, nothing else of the Worker's;
 * its stderr is discarded so server output cannot carry its environment into Worker logs.
 */
export function stdioMcpTransport(launch: McpStdioLaunch): StdioClientTransport {
  return new StdioClientTransport({
    command: launch.command,
    args: [...launch.args],
    env: { ...stdioMcpBaseEnvironment(), ...launch.env },
    stderr: "ignore",
    ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
  });
}

function isStdioServer(server: McpServerDefinition): server is StdioMcpServer {
  return "command" in server;
}

/**
 * Supplies the HTTP headers the Worker's policy proxy sends to one server for one Task
 * Attempt, such as `Authorization`. Headers never reach the harness: the proxy holds them.
 */
export type McpServerHeaders = (request: {
  readonly server: string;
  readonly url: string;
  readonly task: TaskAttemptSpec;
  /** True after the server answered 401 or 403: fetch fresh credentials instead of cached ones. */
  readonly refresh?: boolean;
}) => Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>;

type HeaderRefresher = () => Promise<Readonly<Record<string, string>>>;

// Runtime-only: how the policy proxy refetches a server's headers, keyed by the binding object
// so policy layers that spread the input (such as approval requirements) keep it. Never serialized.
const headerRefreshers = new WeakMap<object, HeaderRefresher>();

/** The refetch hook the policy proxy uses for one resolved server, if it has credentials. */
export function mcpHeaderRefresher(input: ToolInput): HeaderRefresher | undefined {
  return headerRefreshers.get(input.binding);
}

/**
 * The fetch every Worker-side client of an HTTP MCP server uses when it sends credentials:
 * credential headers never follow a redirect to another origin, and a refresh hook, when
 * present, refetches them once on 401 or 403. Undefined when there is nothing to protect.
 */
export function mcpCredentialFetch(
  headers: Readonly<Record<string, string>>,
  refresh: HeaderRefresher | undefined,
): typeof fetch | undefined {
  if (refresh === undefined && Object.keys(headers).length === 0) return undefined;
  return credentialRetryingFetch(headers, refresh);
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Sends one request with the server's credential headers, following redirects itself. Fetch
 * strips only `Authorization` when a redirect leaves the origin; this also drops every
 * configured credential header, such as an API-key header, so none reaches another origin.
 */
async function sendWithCredentials(
  target: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  headers: Readonly<Record<string, string>>,
  configured: ReadonlySet<string>,
): Promise<Response> {
  if (target instanceof Request)
    throw new Error("MCP credential fetch expects a URL, not a Request");
  const origin = new URL(target).origin;
  let url = new URL(target);
  let request: RequestInit = { ...init };
  for (let hop = 0; ; hop += 1) {
    const merged = new Headers(request.headers);
    if (url.origin === origin) {
      for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    } else {
      for (const name of configured) merged.delete(name);
      for (const name of ["authorization", "cookie", "proxy-authorization"]) merged.delete(name);
    }
    const response = await fetch(url, { ...request, headers: merged, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
    await response.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error("MCP server redirected too many times");
    const next = new URL(location, url);
    if (next.protocol !== "https:" && next.protocol !== "http:")
      throw new Error("MCP server redirected to an unsupported URL");
    const method = (request.method ?? "GET").toUpperCase();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      const { body: _body, ...rest } = request;
      const withoutBody = new Headers(rest.headers);
      withoutBody.delete("content-type");
      withoutBody.delete("content-length");
      request = { ...rest, method: method === "HEAD" ? "HEAD" : "GET", headers: withoutBody };
    }
    url = next;
  }
}

/**
 * A fetch that sends the server's current credential headers and, when the server answers
 * 401 or 403, refetches them and retries the request exactly once. Concurrent failures share
 * one refetch. Session cleanup (DELETE) is never retried. Credential headers never follow a
 * redirect to another origin. Without `refresh`, a refusal is returned as is.
 */
export function credentialRetryingFetch(
  initial: Readonly<Record<string, string>>,
  refresh: HeaderRefresher | undefined,
): typeof fetch {
  let current = initial;
  let refreshing: Promise<Readonly<Record<string, string>>> | undefined;
  // Every credential header name ever configured, including ones the transport copies into
  // init.headers from its initial requestInit, is removed before a cross-origin hop.
  const configured = new Set(Object.keys(initial).map((name) => name.toLowerCase()));
  const send = (
    target: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    headers: Readonly<Record<string, string>>,
  ) => {
    for (const name of Object.keys(headers)) configured.add(name.toLowerCase());
    return sendWithCredentials(target, init, headers, configured);
  };
  return async (target, init) => {
    const used = current;
    const response = await send(target, init, used);
    if (response.status !== 401 && response.status !== 403) return response;
    if (refresh === undefined || init?.method?.toUpperCase() === "DELETE") return response;
    await response.body?.cancel().catch(() => undefined);
    if (current === used) {
      refreshing ??= refresh()
        .then((headers) => {
          current = headers;
          return headers;
        })
        .finally(() => {
          refreshing = undefined;
        });
      await refreshing;
    }
    return send(target, init, current);
  };
}

export interface HttpMcpToolProviderOptions {
  /** Servers by name, as the host service declares them. */
  readonly servers: Readonly<Record<string, McpServerDefinition>>;
  /** Authentication hook for HTTP servers. Omitted means no headers. */
  readonly headers?: McpServerHeaders;
  /** Environment hook for stdio servers. Omitted means no server-specific environment. */
  readonly environment?: McpServerEnvironment;
  /** Read from the snapshot of the Task's base commit, never exposed to the harness. */
  readonly workspaceServers?: (attemptId: string) => readonly ResolvedWorkspaceMcpServer[];
  /** Upper bound for listing one server's tools when a Task Attempt starts. */
  readonly listTimeoutMs?: number;
}

const MAX_TOOL_PAGES = 20;

/**
 * Resolves `target: mcp` grants into tools of the host's and Workspace's MCP servers, HTTP or
 * stdio. It lists each granted server's tools when the Task Attempt starts and keeps only granted
 * ones. The harness reaches each server only through the Worker's per-Task policy proxy, which
 * checks every call against the grants, resource mapping, and approval requirements. The Worker,
 * never the harness, launches stdio servers: their Tool inputs carry no command or environment.
 */
export class HttpMcpToolProvider implements ToolProvider {
  readonly provider = "mcp";
  readonly #servers: Readonly<Record<string, McpServerDefinition>>;
  readonly #headers: McpServerHeaders | undefined;
  readonly #environment: McpServerEnvironment | undefined;
  readonly #workspaceServers: HttpMcpToolProviderOptions["workspaceServers"];
  readonly #listTimeoutMs: number;

  constructor(options: HttpMcpToolProviderOptions) {
    for (const [name, server] of Object.entries(options.servers)) {
      if (isStdioServer(server)) validateStdioServer(name, server.command);
      else validateServer(name, server.url);
    }
    this.#servers = options.servers;
    this.#headers = options.headers;
    this.#environment = options.environment;
    this.#workspaceServers = options.workspaceServers;
    this.#listTimeoutMs = options.listTimeoutMs ?? 15_000;
  }

  async resolve({ task }: ResolutionContext): Promise<ToolBundle | undefined> {
    const workspaceServers = new Map(
      (this.#workspaceServers?.(task.attemptId) ?? []).map((server) => [server.name, server]),
    );
    for (const server of workspaceServers.values()) {
      if ("command" in server) validateStdioServer(server.name, server.command);
      else validateServer(server.name, server.url);
      if (Object.hasOwn(this.#servers, server.name))
        throw new Error(
          `Workspace MCP server ${server.name} conflicts with a host MCP server of the same name`,
        );
    }
    const grants = task.authorization.mcp ?? [];
    if (grants.length === 0) return undefined;
    const inputs: ToolInput[] = [];
    for (const name of mcpServersOfGrants(grants)) {
      const workspaceServer = workspaceServers.get(name);
      const server: McpServerDefinition | undefined =
        workspaceServer === undefined
          ? Object.hasOwn(this.#servers, name)
            ? this.#servers[name]
            : undefined
          : "command" in workspaceServer
            ? {
                command: workspaceServer.command,
                args: workspaceServer.args,
                cwd: workspaceServer.cwd,
              }
            : { url: workspaceServer.url };
      if (server === undefined)
        throw new Error(
          `This Task's Permission Sets grant tools of MCP server ${name}, which this Worker Host does not provide`,
        );
      const serverGrants = grants.filter((grant) => grant.action.startsWith(`${name}/`));
      const scoped = serverGrants.find((grant) => grant.resource !== undefined);
      if (scoped !== undefined && server.resources === undefined)
        throw new Error(
          `Permission grant ${scoped.action} names resource ${scoped.resource}, but MCP server ${name} has no resource mapping; grant its tools without a resource`,
        );
      let input: ToolInput;
      if (workspaceServer !== undefined && "sandbox" in workspaceServer) {
        const launch: McpSandboxLaunch = {
          environment: workspaceServer.sandbox,
          command: workspaceServer.command,
          args: [...workspaceServer.args],
          cwd: workspaceServer.cwd,
        };
        const tools = await listSandboxTools(name, launch, this.#listTimeoutMs);
        input = toolInput(this.provider, name, server, serverGrants, tools, {
          kind: "mcp-http",
          name,
          url: stdioMcpBindingUrl(name),
        });
        sandboxLaunches.set(input.binding, launch);
      } else if (isStdioServer(server)) {
        const launch: McpStdioLaunch = {
          command: server.command,
          args: [...(server.args ?? [])],
          env:
            workspaceServer !== undefined && "command" in workspaceServer
              ? { ...workspaceServer.env }
              : { ...((await this.#environment?.({ server: name, task })) ?? {}) },
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        };
        const tools = await listTools(name, () => stdioMcpTransport(launch), this.#listTimeoutMs);
        input = toolInput(this.provider, name, server, serverGrants, tools, {
          kind: "mcp-http",
          name,
          url: stdioMcpBindingUrl(name),
        });
        stdioLaunches.set(input.binding, launch);
      } else {
        const url = server.url;
        const hook = workspaceServer === undefined ? this.#headers : undefined;
        const headers =
          workspaceServer === undefined || "command" in workspaceServer
            ? { ...((await hook?.({ server: name, url, task })) ?? {}) }
            : { ...workspaceServer.headers };
        const refresh: HeaderRefresher | undefined =
          hook === undefined
            ? undefined
            : async () => ({
                ...(await hook({ server: name, url, task, refresh: true })),
              });
        const tools = await listServerTools(name, url, headers, refresh, this.#listTimeoutMs);
        input = toolInput(this.provider, name, server, serverGrants, tools, {
          kind: "mcp-http",
          name,
          url,
          ...(Object.keys(headers).length === 0 ? {} : { runtimeHeaders: headers }),
        });
        if (refresh !== undefined) headerRefreshers.set(input.binding, refresh);
      }
      inputs.push(input);
    }
    return { provider: this.provider, inputs };
  }
}

function toolInput(
  provider: string,
  name: string,
  server: McpServerDefinition,
  serverGrants: readonly TagMcpGrant[],
  tools: readonly ListedTool[],
  binding: Extract<ToolInput["binding"], { kind: "mcp-http" }>,
): ToolInput {
  const operations = grantedOperations(name, server, serverGrants, tools);
  if (operations.length === 0)
    throw new Error(
      `MCP server ${name} offers none of the tools this Task's Permission Sets grant (${serverGrants.map((grant) => grant.action).join(", ")})`,
    );
  return {
    id: `mcp:${name}`,
    kind: "tool",
    required: true,
    capability: {
      id: `mcp:${name}`,
      provider,
      operations,
      authorization: {
        provider,
        resources: [],
        mcp: { server: name, grants: serverGrants },
      },
    },
    binding,
  };
}

function validateStdioServer(name: string, command: string): void {
  if (!MCP_SERVER_NAME.test(name) || isReservedMcpServerName(name))
    throw new Error(`MCP server name ${JSON.stringify(name)} is invalid or reserved`);
  if (typeof command !== "string" || command.trim() === "")
    throw new Error(`MCP server ${name} needs a command`);
}

function validateServer(name: string, value: string): void {
  if (!MCP_SERVER_NAME.test(name) || isReservedMcpServerName(name))
    throw new Error(`MCP server name ${JSON.stringify(name)} is invalid or reserved`);
  const url = new URL(value);
  if (url.username || url.password)
    throw new Error(`MCP server ${name} URL must not hold credentials`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url)))
    throw new Error(`MCP server ${name} must use HTTPS unless it is on the loopback interface`);
}

interface ListedTool {
  readonly name: string;
  readonly inputSchema?: unknown;
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

function grantedOperations(
  server: string,
  config: McpServerDefinition,
  grants: readonly TagMcpGrant[],
  tools: readonly ListedTool[],
): ToolOperation[] {
  const operations = new Map<string, ToolOperation>();
  for (const tool of tools) {
    // Names outside the specification's characters are never exposed, so a server cannot
    // offer a look-alike of a granted tool.
    if (!MCP_TOOL_NAME.test(tool.name) || operations.has(tool.name)) continue;
    if (mcpGrantsFor(grants, server, tool.name).length === 0) continue;
    const rules = config.resources?.tools[tool.name];
    operations.set(tool.name, {
      name: tool.name,
      effect: tool.annotations?.readOnlyHint === true ? "read" : "write",
      actions: [`${server}/${tool.name}`],
      ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema as JsonRecord } : {}),
      ...(rules === undefined || !Object.hasOwn(config.resources?.tools ?? {}, tool.name)
        ? {}
        : {
            resourceArgumentPolicies: rules.map((rule) => ({ ...rule, match: "scope" as const })),
          }),
    });
  }
  return [...operations.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

async function listServerTools(
  name: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  refresh: HeaderRefresher | undefined,
  timeoutMs: number,
): Promise<readonly ListedTool[]> {
  const credentialFetch = mcpCredentialFetch(headers, refresh);
  return listTools(
    name,
    () =>
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { ...headers } },
        ...(credentialFetch === undefined ? {} : { fetch: credentialFetch }),
      }),
    timeoutMs,
  );
}

/** Lists a sandbox stdio server's tools through the environment MCP bridge, then stops it. */
async function listSandboxTools(
  name: string,
  launch: McpSandboxLaunch,
  timeoutMs: number,
): Promise<readonly ListedTool[]> {
  let bridge: Awaited<ReturnType<typeof openEnvironmentMcpBridge>> | undefined;
  try {
    bridge = await openEnvironmentMcpBridge(
      launch.environment,
      {
        server: {
          transport: "mcp-stdio",
          command: launch.command,
          args: launch.args,
          cwd: launch.cwd,
        },
        listOnly: true,
      },
      { timeoutMs },
    );
    return bridge.tools.flatMap((tool) =>
      typeof tool["name"] === "string" ? [tool as unknown as ListedTool] : [],
    );
  } catch {
    // Task-visible: report only the server name, as for host servers.
    throw new Error(`Could not list the tools of MCP server ${name}`);
  } finally {
    await bridge?.close().catch(() => undefined);
  }
}

async function listTools(
  name: string,
  createTransport: () => StreamableHTTPClientTransport | StdioClientTransport,
  timeoutMs: number,
): Promise<readonly ListedTool[]> {
  const client = new McpClient({ name: "supertag-worker-tools", version: "1" });
  const transport = createTransport();
  try {
    await client.connect(transport as Parameters<McpClient["connect"]>[0], { timeout: timeoutMs });
    const tools: ListedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await client.listTools(cursor === undefined ? {} : { cursor }, {
        timeout: timeoutMs,
      });
      tools.push(...(result.tools as ListedTool[]));
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    return tools;
  } catch (error) {
    // Task-visible: the server's error text and response body can echo the credential
    // headers or environment it was sent, so only the server name and the HTTP status are
    // reported.
    throw new Error(`Could not list the tools of MCP server ${name}${failureStatus(error)}`);
  } finally {
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId)
      await Promise.race([
        transport.terminateSession().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000).unref()),
      ]);
    await client.close().catch(() => undefined);
  }
}

function failureStatus(error: unknown): string {
  if (error instanceof StreamableHTTPError) {
    const status = error.code;
    return typeof status === "number" && status >= 100 && status <= 599 ? `: HTTP ${status}` : "";
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return ": timed out";
  return "";
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
