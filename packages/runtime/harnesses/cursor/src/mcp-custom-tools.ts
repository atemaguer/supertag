import type {
  SDKCustomTool,
  SDKCustomToolContent,
  SDKCustomToolResult,
  SDKJsonValue,
  SDKToolAnnotations,
} from "@cursor/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SplitExecutionToolDefinition, SplitExecutionToolResult } from "@supertag/worker-sdk";

/**
 * An admitted SuperTag MCP server as the runner receives it. `toolNames` is the admitted
 * operation list; the runner exposes only those tools.
 */
export type CursorRunnerMcpServer =
  | {
      readonly type: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly toolNames: readonly string[];
    }
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly toolNames: readonly string[];
    };

export interface McpListedTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
  readonly annotations?: unknown;
}

export interface McpCallResult {
  readonly content?: unknown;
  readonly isError?: unknown;
  readonly structuredContent?: unknown;
}

export interface McpToolSession {
  listTools(): Promise<readonly McpListedTool[]>;
  callTool(
    name: string,
    args: Record<string, SDKJsonValue>,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

export type McpConnector = (server: CursorRunnerMcpServer, cwd: string) => Promise<McpToolSession>;

const MAX_LISTED_TOOLS = 1_000;
const MAX_LIST_PAGES = 50;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_DESCRIPTION_BYTES = 16 * 1024;
const MAX_SCHEMA_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const SETUP_TIMEOUT_MS = 30_000;
// Bounded by the Attempt timeout too: the harness stops the runner and its MCP children.
const CALL_TIMEOUT_MS = 10 * 60_000;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

/** Bound even empty pages whose cursor never advances. */
export async function listMcpTools(
  listPage: (cursor?: string) => Promise<{ tools: McpListedTool[]; nextCursor?: string }>,
): Promise<readonly McpListedTool[]> {
  const tools: McpListedTool[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let bytes = 0;
  do {
    if (++pages > MAX_LIST_PAGES) throw new Error("SuperTag MCP tools/list page limit exceeded");
    const page = await listPage(cursor);
    bytes += Buffer.byteLength(JSON.stringify(page));
    if (bytes > MAX_LIST_BYTES || tools.length + page.tools.length > MAX_LISTED_TOOLS)
      throw new Error("SuperTag MCP tools/list size limit exceeded");
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

/** Connects to one admitted server: the HTTP policy proxy or the admitted stdio command. */
export const connectMcpServer: McpConnector = async (server, cwd) => {
  const client = new Client({ name: "supertag-cursor", version: "1" });
  const transport =
    server.type === "http"
      ? new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { ...server.headers } },
        })
      : new StdioClientTransport({
          command: server.command,
          args: [...server.args],
          env: { ...server.env },
          cwd,
          stderr: "ignore",
        });
  await client.connect(transport as Parameters<Client["connect"]>[0], {
    timeout: SETUP_TIMEOUT_MS,
  });
  return {
    async listTools() {
      return listMcpTools(async (cursor) => {
        const page = await client.listTools(cursor === undefined ? {} : { cursor }, {
          timeout: SETUP_TIMEOUT_MS,
        });
        return { tools: page.tools, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      });
    },
    async callTool(name, args, signal) {
      return (await client.callTool({ name, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      })) as McpCallResult;
    },
    close: () => client.close(),
  };
};

function annotations(value: unknown): SDKToolAnnotations | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, string | boolean> = {};
  if (typeof source["title"] === "string") result["title"] = source["title"];
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
    if (typeof source[key] === "boolean") result[key] = source[key] as boolean;
  return Object.keys(result).length ? (result as SDKToolAnnotations) : undefined;
}

function jsonObject(value: unknown): Record<string, SDKJsonValue> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, SDKJsonValue>;
  } catch {
    return undefined;
  }
}

function customResult(result: McpCallResult): SDKCustomToolResult {
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES)
    throw new Error("SuperTag MCP tool result exceeds size limit");
  const content: SDKCustomToolContent[] = Array.isArray(result.content)
    ? result.content.map((item: unknown): SDKCustomToolContent => {
        const block = item as Record<string, unknown> | null;
        if (block?.["type"] === "text" && typeof block["text"] === "string")
          return { type: "text", text: block["text"] };
        if (block?.["type"] === "image" && typeof block["data"] === "string")
          return {
            type: "image",
            data: block["data"],
            ...(typeof block["mimeType"] === "string" ? { mimeType: block["mimeType"] } : {}),
          };
        return { type: "text", text: JSON.stringify(item) ?? "" };
      })
    : [];
  const structuredContent = jsonObject(result.structuredContent);
  return {
    content,
    isError: result.isError === true,
    ...(structuredContent ? { structuredContent } : {}),
  };
}

/** A workspace tool the Worker's executor offers; the runner never runs it itself. */
export type CursorSplitToolDefinition = SplitExecutionToolDefinition;
export type CursorSplitToolOutcome = SplitExecutionToolResult;

/** Runner-side handle that sends one workspace call to the Worker and waits for its answer. */
export interface CursorWorkspaceForwarder {
  readonly tools: readonly CursorSplitToolDefinition[];
  forward(name: string, input: unknown, signal: AbortSignal): Promise<CursorSplitToolOutcome>;
}

/** Cursor sees an executor tool `read` as `workspace_read`, so it cannot collide with a built-in. */
export const WORKSPACE_TOOL_PREFIX = "workspace_";

export interface CursorCustomToolBridge {
  readonly tools: Record<string, SDKCustomTool>;
  readonly calls: ReadonlyMap<string, { name: string; status: "completed" | "error" | "running" }>;
  abort(): void;
  close(): Promise<void>;
}

/**
 * Exposes exactly the admitted SuperTag MCP tools as Cursor SDK custom tools.
 *
 * @cursor/sdk 1.0.37 sends sandboxed local runs through an MCP approval check whose
 * allowlist is empty and whose approver always declines ("Local SDK runs cannot request
 * interactive approval for this MCP tool call"), so inline `mcpServers` tools cannot run
 * there. Custom tools skip interactive approval while deny rules and sandbox limits still
 * apply. https://cursor.com/docs/sdk/typescript.md#custom-tools
 * https://cursor.com/docs/sdk/typescript.md#sandbox-options https://cursor.com/docs/mcp.md
 * The runner stays the MCP client, so the admitted server list and the HTTP policy proxy
 * remain the boundary; Cursor sees each tool as `<server>_<tool>`.
 */
export async function cursorCustomTools(
  servers: Readonly<Record<string, CursorRunnerMcpServer>>,
  cwd: string,
  emitFrame: (frame: Record<string, unknown>) => void,
  describeError: (error: unknown) => string | undefined,
  connect: McpConnector = connectMcpServer,
  workspace?: CursorWorkspaceForwarder,
): Promise<CursorCustomToolBridge> {
  const sessions: McpToolSession[] = [];
  const tools: Record<string, SDKCustomTool> = {};
  const calls = new Map<string, { name: string; status: "completed" | "error" | "running" }>();
  const controller = new AbortController();
  let terminal = false;
  const abort = () => {
    terminal = true;
    controller.abort();
  };
  const close = async () => {
    abort();
    const results = await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
    if (results.some((result) => result.status === "rejected"))
      throw new Error("SuperTag MCP client cleanup failed");
  };
  /** One custom tool whose calls are tracked so the runner can reconcile them with the stream. */
  const register = (
    key: string,
    definition: {
      readonly description?: unknown;
      readonly inputSchema?: unknown;
      readonly annotations?: unknown;
    },
    invoke: (args: Record<string, SDKJsonValue>, signal: AbortSignal) => Promise<McpCallResult>,
    failure: string,
  ) => {
    if (!TOOL_NAME.test(key)) throw new Error("Invalid SuperTag MCP tool name");
    if (tools[key]) throw new Error("Duplicate SuperTag MCP tool name");
    const inputSchema = jsonObject(definition.inputSchema);
    if (
      Buffer.byteLength(typeof definition.description === "string" ? definition.description : "") >
        MAX_DESCRIPTION_BYTES ||
      Buffer.byteLength(JSON.stringify(definition.inputSchema ?? {})) > MAX_SCHEMA_BYTES
    )
      throw new Error("SuperTag MCP tool definition exceeds size limit");
    const hints = annotations(definition.annotations);
    tools[key] = {
      ...(typeof definition.description === "string"
        ? { description: definition.description }
        : {}),
      ...(inputSchema ? { inputSchema } : {}),
      ...(hints ? { annotations: hints } : {}),
      async execute(args, context) {
        // Only the stable envelope crosses to the harness; args and results stay here.
        // SDK 1.0.37 correlates custom-tool execute with stream call_id via
        // toolCallId. An absent ID cannot be proven to match; refuse before
        // invoking the tool. https://cursor.com/docs/sdk/typescript.md#custom-tools
        const callId = context.toolCallId;
        if (!callId)
          return {
            content: [{ type: "text", text: `${failure} ID is missing` }],
            isError: true,
          };
        if (terminal) throw new Error("SuperTag MCP bridge is closed");
        calls.set(callId, { name: key, status: "running" });
        const frame = (status: string) =>
          !terminal &&
          emitFrame({
            type: "event",
            event: { type: "tool_call", call_id: callId, name: key, status },
          });
        frame("running");
        try {
          // SDK 1.0.37's SDKCustomToolContext has toolCallId but no signal.
          // The bridge owns cancellation and forwards it through the invoker's signal.
          const result = await invoke(args, controller.signal);
          if (terminal) return { content: [], isError: true };
          const converted = customResult(result);
          calls.set(callId, {
            name: key,
            status: result.isError === true ? "error" : "completed",
          });
          frame(result.isError === true ? "error" : "completed");
          return converted;
        } catch (error) {
          if (terminal) return { content: [], isError: true };
          calls.set(callId, { name: key, status: "error" });
          frame("error");
          const detail = describeError(error);
          return {
            content: [
              {
                type: "text",
                text: `${failure} failed${detail ? `: ${detail}` : ""}`,
              },
            ],
            isError: true,
          };
        }
      },
    };
  };
  try {
    for (const [serverName, server] of Object.entries(servers)) {
      const admitted = new Set(server.toolNames);
      if (!admitted.size) continue;
      const session = await connect(server, cwd);
      sessions.push(session);
      for (const listed of await session.listTools()) {
        if (!admitted.has(listed.name)) continue;
        register(
          `${serverName}_${listed.name}`,
          listed,
          (args, signal) => session.callTool(listed.name, args, signal),
          "SuperTag MCP tool call",
        );
      }
    }
    // Split execution: the executor's tools sit next to the SuperTag tools and run on the
    // Worker Host's execution environment, not here. https://cursor.com/docs/sdk/typescript.md#custom-tools
    for (const definition of workspace?.tools ?? []) {
      register(
        `${WORKSPACE_TOOL_PREFIX}${definition.name}`,
        definition,
        async (args, signal) => {
          const outcome = await workspace?.forward(definition.name, args, signal);
          if (!outcome) throw new Error("Workspace tool is unavailable");
          return { content: [{ type: "text", text: outcome.text }], isError: outcome.isError };
        },
        "Workspace tool call",
      );
    }
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  return { tools, calls, abort, close };
}
