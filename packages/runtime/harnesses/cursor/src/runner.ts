import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Agent, JsonlLocalAgentStore, type ToolName } from "@cursor/sdk";
import {
  redactText,
  type SensitiveValue,
  sensitiveEnvironmentValues,
} from "@supertag/worker-sdk/redaction";
import {
  type CursorCustomToolBridge,
  type CursorRunnerMcpServer,
  type CursorSplitToolDefinition,
  type CursorSplitToolOutcome,
  type CursorWorkspaceForwarder,
  connectMcpServer,
  cursorCustomTools,
  type McpConnector,
} from "./mcp-custom-tools.js";
import {
  MAX_CURSOR_ERROR_CHARS,
  redactCursorExactSecrets,
  stripCursorControls,
} from "./protocol.js";
import { parseWorkspaceResult } from "./workspace-frames.js";

interface StartFrame {
  readonly type: "start";
  readonly apiKey: string;
  readonly request: {
    readonly prompt: string;
    readonly workspace: string;
    readonly storeDirectory: string;
    readonly agentId: string;
    readonly resumeAgentId?: string;
    readonly model?: string;
    readonly mcpServers: Readonly<Record<string, CursorRunnerMcpServer>>;
    readonly tools: readonly string[];
    readonly disallowedTools: readonly string[];
    /**
     * Present only in split execution. These are the Worker executor's workspace tools; the
     * runner registers them as custom tools and forwards every call to the Worker.
     */
    readonly splitTools?: readonly CursorSplitToolDefinition[];
  };
}

let activeApiKey: string | undefined;
let activeRequest: StartFrame["request"] | undefined;

/** The SDK looks for native packages by walking upward from process.argv[1]. */
export function resolveCursorSandboxEntry(
  sdkEntry: string = createRequire(import.meta.url).resolve("@cursor/sdk"),
  platform = process.platform,
  arch = process.arch,
  exists: (path: string) => boolean = existsSync,
): string {
  const packageName = `@cursor/sdk-${platform}-${arch}`;
  const entry = realpathSync(sdkEntry);
  let directory = dirname(entry);
  const checked: string[] = [];
  while (true) {
    const helper = join(directory, "node_modules", packageName, "bin", "cursorsandbox");
    checked.push(helper);
    if (exists(helper)) return entry;
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) break;
    directory = parent;
  }
  const error = new Error(
    `Cursor sandbox helper from ${packageName} is unavailable; checked ${checked.join(", ")}`,
  );
  error.name = "ConfigurationError";
  throw error;
}

export function serializeCursorRunnerFrame(
  frame: Record<string, unknown>,
  apiKey = activeApiKey,
  request = activeRequest,
): string {
  const encoded = JSON.stringify(frame);
  const secrets = runnerSecrets(apiKey, request);
  const safe =
    frame["type"] === "event" || frame["type"] === "error"
      ? redactText(encoded, secrets)
      : redactCursorExactSecrets(encoded, secrets);
  return `${safe}\n`;
}

function emit(frame: Record<string, unknown>): void {
  process.stdout.write(serializeCursorRunnerFrame(frame));
}

function safeEvent(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  switch (event["type"]) {
    case "system":
    case "user":
    case "thinking":
      return { type: event["type"] };
    case "status":
      return { type: event["type"], status: event["status"] };
    case "task":
      return { type: event["type"], status: event["status"], text: event["text"] };
    case "request":
      return { type: event["type"], request_id: event["request_id"] };
    case "usage":
      return { type: event["type"], usage: event["usage"] };
    case "assistant":
      return { type: event["type"], message: event["message"] };
    case "tool_call":
      // Tool args/results may contain MCP credentials or private data. The stable envelope
      // is enough for HarnessEvents. https://cursor.com/docs/sdk/typescript.md#stream-events
      return {
        type: event["type"],
        call_id: event["call_id"],
        name: event["name"],
        status: event["status"],
      };
    default:
      return undefined;
  }
}

let activeRun: { cancel(): Promise<void> } | undefined;
let activeAgent: { close(): void } | undefined;
let activeBridge: CursorCustomToolBridge | undefined;
let started = false;
/** Workspace calls sent to the Worker and not yet answered, keyed by frame id. */
const pendingWorkspaceCalls = new Map<string, (outcome: CursorSplitToolOutcome) => void>();
// The only tool name @cursor/sdk 1.0.37's stream emits for an MCP call is "mcp".
// Evidence in node_modules/@cursor/sdk/dist/esm: the mcpToolCall case of the tool
// converter in 464.js returns {type:"mcp", args}, and the stream adapter in
// index.js names a tool_call `toolCall.name ?? toolCall.type`. The converter sets no
// `name`. It returns null for getMcpToolsToolCall, listMcpResourcesToolCall,
// readMcpResourceToolCall and mcpAuthToolCall, which the adapter names "unknown".
// The raw proto names (mcp_tool_call, get_mcp_tools_tool_call, ...) appear in
// index.js only in its allowed/exclude-tools header map and never in a stream event.
const NATIVE_MCP_TOOLS = new Set(["mcp"]);
const SPLIT_NATIVE_DENYLIST = ["read", "edit", "shell", "grep", "glob", "ls", "task"] as const;

export async function cancelCursorSdk(): Promise<void> {
  activeBridge?.abort();
  await activeRun?.cancel();
  activeAgent?.close();
}

export async function executeCursorSdk(
  frame: StartFrame,
  agentApi: Pick<typeof Agent, "create" | "resume"> = Agent,
  storeFactory: (directory: string) => JsonlLocalAgentStore = (directory) =>
    new JsonlLocalAgentStore(directory),
  emitFrame: (frame: Record<string, unknown>) => void = emit,
  sandboxEntryResolver: () => string = resolveCursorSandboxEntry,
  connectMcp: McpConnector = connectMcpServer,
): Promise<void> {
  const request = frame.request;
  const key = frame.apiKey;
  if (!key) throw new Error("API_KEY_MISSING");
  // @cursor/sdk 1.0.37 searches native sandbox, tree-sitter and ripgrep assets
  // relative to argv[1], not its own package. Point that walk at the real SDK
  // entry and refuse before Agent.create if its platform helper is absent.
  // https://cursor.com/docs/sdk/typescript.md
  // https://cursor.com/docs/agent/security/run-modes.md
  process.argv[1] = sandboxEntryResolver();
  // Refuse an invalid workspace before connecting any admitted stdio MCP child.
  if (
    !request.workspace ||
    !existsSync(request.workspace) ||
    !statSync(request.workspace).isDirectory()
  ) {
    const error = new Error("Cursor workspace is unavailable");
    error.name = "ConfigurationError";
    throw error;
  }
  if (request.splitTools) {
    // local.cwd is also the default cwd of native Cursor tools. Keep it empty and
    // Attempt-private even if a future caller bypasses the harness's workspace setup.
    // https://cursor.com/docs/sdk/typescript.md
    // https://cursor.com/docs/agent/security/run-modes.md
    const workspace = realpathSync(request.workspace);
    const attemptRoot = realpathSync(dirname(request.storeDirectory));
    const refuse = (message: string): never => {
      const error = new Error(message);
      error.name = "ConfigurationError";
      throw error;
    };
    if (workspace !== join(attemptRoot, "workspace"))
      refuse("Cursor split working directory is not <attemptRoot>/workspace");
    if (workspace === process.cwd())
      refuse("Cursor split working directory must not be the runner process cwd");
    const entries = readdirSync(workspace);
    if (entries.length !== 0)
      refuse(
        `Cursor split working directory is not empty: ${entries
          .slice(0, 5)
          .map((name) => JSON.stringify(name))
          .join(", ")}`,
      );
  }
  if (
    !/^agent-[\w-]{1,100}$/u.test(request.agentId) ||
    (request.resumeAgentId && !/^agent-[\w-]{1,100}$/u.test(request.resumeAgentId))
  ) {
    const error = new Error("Cursor agent ID is invalid");
    error.name = "ConfigurationError";
    throw error;
  }
  // Explicit JSONL storage keeps session bytes under the Attempt state directory.
  // Resume options must repeat ephemeral policy. https://cursor.com/docs/sdk/typescript.md#local-agent-stores
  // https://cursor.com/docs/sdk/typescript.md#resuming-agents
  const store = storeFactory(request.storeDirectory);
  // The SDK scopes a resumed local agent to its stored cwd. Check that state
  // before a tools/list request can spawn an admitted stdio MCP server.
  // https://cursor.com/docs/sdk/typescript.md#local-agent-stores
  if (store.agents?.get) {
    const existing = await store.agents.get({ agentId: request.resumeAgentId ?? request.agentId });
    if (
      (request.resumeAgentId && (!existing || existing.cwd !== request.workspace)) ||
      (!request.resumeAgentId && existing)
    ) {
      const error = new Error("Cursor agent state is unavailable or belongs to another workspace");
      error.name = "ConfigurationError";
      throw error;
    }
  }
  if (
    request.splitTools &&
    (request.tools.length !== 1 ||
      request.tools[0] !== "mcp" ||
      request.disallowedTools.includes("mcp") ||
      SPLIT_NATIVE_DENYLIST.some((name) => !request.disallowedTools.includes(name)))
  ) {
    // Reject malformed allow and deny policy before the SDK sees it. The denylist also
    // blocks subagents, whose curated toolset would bypass the main-loop allowlist.
    // https://cursor.com/docs/sdk/typescript.md#restricting-the-toolset
    // https://cursor.com/docs/release-notes/sdk.md
    const error = new Error("Cursor split execution requires mcp only and native tools denied");
    error.name = "ConfigurationError";
    throw error;
  }
  const bridge = await cursorCustomTools(
    request.mcpServers,
    request.workspace,
    emitFrame,
    (error) => cursorSdkErrorMessage(error, key, request),
    connectMcp,
    request.splitTools ? workspaceForwarder(request.splitTools, emitFrame) : undefined,
  );
  activeBridge = bridge;
  try {
    await runCursorSdk(frame, agentApi, store, emitFrame, bridge);
  } finally {
    bridge.abort();
    await bridge.close().catch(() => undefined);
    if (activeBridge === bridge) activeBridge = undefined;
  }
}

let workspaceCallCounter = 0;

/**
 * Sends each workspace call to the Worker as a `workspace_call` frame and waits for the
 * `workspace_result` frame with the same id. The call carries no abort signal from Cursor,
 * so the bridge's own signal answers a pending call with an error when the run ends.
 */
function workspaceForwarder(
  tools: readonly CursorSplitToolDefinition[],
  emitFrame: (frame: Record<string, unknown>) => void,
): CursorWorkspaceForwarder {
  return {
    tools,
    forward(name, input, signal) {
      if (signal.aborted)
        return Promise.resolve({ text: "Workspace tool call was cancelled", isError: true });
      const id = `workspace-${++workspaceCallCounter}`;
      return new Promise<CursorSplitToolOutcome>((resolve) => {
        const settle = (outcome: CursorSplitToolOutcome) => {
          if (!pendingWorkspaceCalls.delete(id)) return;
          signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        };
        const onAbort = () => settle({ text: "Workspace tool call was cancelled", isError: true });
        pendingWorkspaceCalls.set(id, settle);
        signal.addEventListener("abort", onAbort, { once: true });
        emitFrame({ type: "workspace_call", id, name, input });
      });
    },
  };
}

/** Answers a pending workspace call; an unknown or repeated id changes nothing. */
export function settleWorkspaceCall(frame: Record<string, unknown>): void {
  const result = parseWorkspaceResult(frame);
  pendingWorkspaceCalls.get(result.id)?.({ text: result.text, isError: result.isError });
}

async function runCursorSdk(
  frame: StartFrame,
  agentApi: Pick<typeof Agent, "create" | "resume">,
  store: JsonlLocalAgentStore,
  emitFrame: (frame: Record<string, unknown>) => void,
  bridge: CursorCustomToolBridge,
): Promise<void> {
  const request = frame.request;
  const key = frame.apiKey;
  const customTools = bridge.tools;
  const split = request.splitTools !== undefined;
  const options = {
    apiKey: key,
    model: { id: request.model ?? "auto" },
    // No inline mcpServers: admitted SuperTag tools arrive as customTools, which sandboxed
    // local runs can call. https://cursor.com/docs/sdk/typescript.md#custom-tools
    tools: [...request.tools] as ToolName[],
    disallowedTools: [...request.disallowedTools] as ToolName[],
    // No systemPrompt: the 1.0.37 local runtime rejects it with
    // "[invalid_argument] unknown option '--system-prompt'". The harness prepends
    // its Worker policy to each Attempt's message instead.
    // https://cursor.com/docs/sdk/typescript.md
    local: {
      cwd: request.workspace,
      store,
      // Never pass settingSources: without it, no file-based MCP servers, rules or hooks
      // load, so the only MCP tools are the admitted customTools below.
      // https://cursor.com/docs/sdk/typescript.md#configuration-sources
      // https://cursor.com/docs/mcp.md
      // HOME is Attempt-private to avoid operator hooks, rules and Skills.
      // https://cursor.com/docs/hooks.md https://cursor.com/docs/rules.md
      // https://cursor.com/docs/skills.md
      // Defense in depth only: the SDK also reads writable repository sandbox policy
      // on each shell decision, so this is not an enforced command boundary.
      // https://cursor.com/docs/sdk/typescript.md
      // https://cursor.com/docs/agent/security/run-modes.md
      // https://cursor.com/docs/cli/reference/permissions.md
      sandboxOptions: { enabled: true },
      ...(Object.keys(customTools).length ? { customTools } : {}),
    },
  };
  const agent = request.resumeAgentId
    ? await agentApi.resume(request.resumeAgentId, options)
    : await agentApi.create({ ...options, agentId: request.agentId });
  activeAgent = agent;
  emitFrame({ type: "agent", agentId: agent.agentId });
  const run = await agent.send(request.prompt);
  activeRun = run;
  let rejected = false;
  let nativeMcp = false;
  let untrustedMcpProvider = false;
  // Split execution: the allowlist is enforced by Cursor's service while the local executors
  // stay registered, so any call that is not one of our custom tools is a policy breach.
  let nativeTool = false;
  let postExecutionError = false;
  // Custom call_ids streamed as running that have not yet reached a terminal event.
  const unfinished = new Set<string>();
  for await (const sdkEvent of run.stream()) {
    const event = safeEvent(sdkEvent);
    if (event) emitFrame({ type: "event", event });
    // @cursor/sdk 1.0.37's mcpToolCall converter in dist/esm/464.js emits
    // {type:"mcp", args:{providerIdentifier,toolName,args}}; the stream
    // adapter in dist/esm/index.js chooses tool.name ?? tool.type as name.
    // SDKToolUseMessage carries call_id/status, and SDKCustomToolContext
    // carries toolCallId. Compare only these structural fields, never args.args
    // or result. https://cursor.com/docs/sdk/typescript.md#custom-tools
    const tool = sdkEvent as {
      type?: unknown;
      name?: unknown;
      call_id?: unknown;
      status?: unknown;
      args?: unknown;
    };
    if (tool?.type !== "tool_call") continue;
    const mcpFamily = typeof tool.name === "string" && NATIVE_MCP_TOOLS.has(tool.name);
    const args =
      tool.args && typeof tool.args === "object"
        ? (tool.args as Record<string, unknown>)
        : undefined;
    // A provider marker identifies an MCP call even if the SDK supplies an
    // unfamiliar event name. Only the documented "mcp" event name is admitted.
    const mcpEvent = mcpFamily || (args !== undefined && Object.hasOwn(args, "providerIdentifier"));
    const toolName = args?.["toolName"];
    const isCustom =
      mcpFamily &&
      args?.["providerIdentifier"] === "custom-user-tools" &&
      typeof toolName === "string" &&
      Object.hasOwn(customTools, toolName);
    if (
      mcpFamily &&
      args?.["providerIdentifier"] !== undefined &&
      args["providerIdentifier"] !== "custom-user-tools"
    )
      untrustedMcpProvider = true;
    // Unknown names and malformed custom calls remain protocol failures.
    if (mcpEvent && !isCustom && !untrustedMcpProvider) nativeMcp = true;
    if (split && !isCustom) nativeTool = true;
    if (isCustom && tool.status === "running") {
      // Without a call_id the call cannot be reconciled against an execute record.
      if (typeof tool.call_id === "string") unfinished.add(tool.call_id);
      else rejected = true;
    }
    if (isCustom && tool.status !== "running") {
      if (typeof tool.call_id === "string") unfinished.delete(tool.call_id);
      const call = typeof tool.call_id === "string" ? bridge.calls.get(tool.call_id) : undefined;
      if (!call || call.name !== toolName || call.status === "running") rejected = true;
      else if (tool.status === "error" && call.status === "completed")
        // Execute succeeded; the SDK failed afterward. This is a run failure,
        // not a declined SuperTag tool call.
        postExecutionError = true;
      else if (tool.status === "error" && call.status !== "error") rejected = true;
    }
    if (rejected || nativeMcp || untrustedMcpProvider || nativeTool || postExecutionError) {
      bridge.abort();
      await run.cancel().catch(() => undefined);
    }
  }
  const result = await run.wait();
  // A custom call that never reached a terminal stream event, or whose execute
  // record is still running, was not proven to have run to completion.
  if (unfinished.size > 0 || [...bridge.calls.values()].some((call) => call.status === "running"))
    rejected = true;
  if (nativeTool) {
    const error = new Error("Cursor called a built-in tool in split execution");
    error.name = "SplitNativeToolError";
    throw error;
  }
  if (untrustedMcpProvider) {
    const error = new Error("Cursor called an untrusted MCP provider");
    error.name = "McpProviderUntrustedError";
    throw error;
  }
  if (nativeMcp) {
    const error = new Error("Cursor emitted an unexpected native MCP tool call");
    error.name = "McpProtocolError";
    throw error;
  }
  if (rejected) {
    const error = new Error("Cursor did not execute an admitted SuperTag MCP tool call");
    error.name = "McpToolRejectedError";
    throw error;
  }
  if (postExecutionError) {
    const error = new Error("Cursor failed after executing an admitted SuperTag MCP tool call");
    error.name = "CursorToolCallError";
    throw error;
  }
  let chargedCents: number | undefined;
  let usageTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const billed = await Promise.race([
      agent.getUsage(),
      new Promise<undefined>((resolve) => {
        usageTimer = setTimeout(() => resolve(undefined), 5_000);
      }),
    ]);
    if (!billed) throw new Error("Usage unavailable");
    const exact = billed.runs.find((entry) => entry.runId === run.id);
    // Local run entries use per-turn usage UUIDs, not run.id. A new agent has
    // only this Attempt's usage, so its agent total is attributable to this run.
    // A resumed agent's total includes earlier Attempts; use only an exact match.
    // https://cursor.com/docs/sdk/typescript.md#agentgetusage
    chargedCents =
      exact?.cost?.chargedCents ?? (request.resumeAgentId ? undefined : billed.cost?.chargedCents);
  } catch {
    // Local getUsage may return 403 feature_unavailable. Tokens remain reportable.
    // https://cursor.com/docs/sdk/typescript.md#agentgetusage
  } finally {
    if (usageTimer) clearTimeout(usageTimer);
  }
  emitFrame({
    type: "result",
    status: result.status,
    ...(result.result === undefined ? {} : { result: result.result }),
    ...(result.error === undefined
      ? {}
      : { error: cursorSdkErrorMessage(result.error, key, request) ?? "Cursor run failed" }),
    ...(result.model?.id === undefined ? {} : { model: result.model.id }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(chargedCents === undefined ? {} : { chargedCents }),
  });
  bridge.abort();
}

export function cursorSdkErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (message === "API_KEY_MISSING") return "API_KEY_MISSING";
  if (name === "ConfigurationError" && /sandbox|bubblewrap|helper/iu.test(message))
    return "SANDBOX_UNAVAILABLE";
  // Cursor SDK error classes are stable; messages are diagnostics, never classifiers.
  // https://cursor.com/docs/sdk/typescript.md#error-handling
  switch (name) {
    case "AuthenticationError":
      return "AUTHENTICATION_FAILED";
    case "RateLimitError":
      return "RATE_LIMITED";
    case "NetworkError":
      return "NETWORK_ERROR";
    case "AgentBusyError":
      return "AGENT_BUSY";
    case "AgentNotFoundError":
      return "AGENT_NOT_FOUND";
    case "IntegrationNotConnectedError":
      return "INTEGRATION_NOT_CONNECTED";
    case "ConfigurationError":
      return "CONFIGURATION_ERROR";
    case "UnknownAgentError":
      return "UNKNOWN_AGENT_ERROR";
    case "McpToolRejectedError":
      return "MCP_TOOL_REJECTED";
    case "McpProtocolError":
      return "PROTOCOL_ERROR";
    case "McpProviderUntrustedError":
      return "MCP_PROVIDER_UNTRUSTED";
    case "SplitNativeToolError":
      return "NATIVE_TOOL_BLOCKED";
    default:
      return "SDK_FAILURE";
  }
}

/** Reads a diagnostic from any throwable or SDK error object without trusting its shape. */
function errorDiagnostic(error: unknown): string {
  try {
    if (typeof error === "string") return error;
    if (error === null || typeof error !== "object")
      return error === undefined ? "" : String(error);
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

function runnerSecrets(
  apiKey: string | undefined,
  request?: StartFrame["request"],
): SensitiveValue[] {
  const mcp = Object.values(request?.mcpServers ?? {}).flatMap((server) => {
    if (server === null || typeof server !== "object") return [];
    const { headers, env } = server as { headers?: unknown; env?: unknown };
    return [headers, env].flatMap((values) =>
      values !== null && typeof values === "object"
        ? Object.values(values).filter((value): value is string => typeof value === "string")
        : [],
    );
  });
  return [...sensitiveEnvironmentValues(process.env), ...(apiKey ? [apiKey] : []), ...mcp];
}

/** Keep the full bounded diagnostic for Worker-only MCP secrets to be redacted later. */
export function cursorSdkErrorMessage(
  error: unknown,
  apiKey = activeApiKey,
  request = activeRequest,
): string | undefined {
  const diagnostic = stripCursorControls(errorDiagnostic(error));
  if (diagnostic.length > MAX_CURSOR_ERROR_CHARS)
    return "Cursor SDK diagnostic exceeded the error limit";
  const message = redactText(diagnostic, runnerSecrets(apiKey, request));
  return message || undefined;
}

export function cursorSdkErrorFrame(
  error: unknown,
  apiKey = activeApiKey,
): Record<string, unknown> {
  let code = "SDK_FAILURE";
  try {
    code = cursorSdkErrorCode(error);
  } catch {}
  const message = cursorSdkErrorMessage(error, apiKey);
  return { type: "error", code, ...(message ? { message } : {}) };
}

export async function runCursorStdio(
  input: NodeJS.ReadableStream = process.stdin,
  execute: (frame: StartFrame) => Promise<void> = executeCursorSdk,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let execution: Promise<void> | undefined;
  let terminal = false;
  for await (const line of lines) {
    try {
      const frame = JSON.parse(line) as { type?: unknown; request?: unknown; apiKey?: unknown };
      if (frame.type === "cancel") {
        await cancelCursorSdk();
        continue;
      }
      if (frame.type === "workspace_result") {
        settleWorkspaceCall(frame as Record<string, unknown>);
        continue;
      }
      if (frame.type === "close" && started) {
        await execution;
        terminal = true;
        break;
      }
      if (frame.type !== "start" || started || !frame.request) throw new Error("PROTOCOL_ERROR");
      if (typeof frame.apiKey !== "string" || !frame.apiKey) throw new Error("API_KEY_MISSING");
      started = true;
      activeApiKey = frame.apiKey;
      activeRequest = frame.request as StartFrame["request"];
      execution = execute(frame as StartFrame).catch((error: unknown) => {
        emit(cursorSdkErrorFrame(error));
        process.exitCode = 1;
      });
    } catch {
      emit({ type: "error", code: "PROTOCOL_ERROR" });
      process.exitCode = 1;
      break;
    }
  }
  // Keep the runner, and its parentage evidence, alive after a terminal frame.
  // The harness sends close only after scanning the stopped process tree. Cursor
  // documents run.cancel() and agent.close(), but not cleanup of tool children.
  // https://cursor.com/docs/sdk/typescript.md
  if (!terminal && execution) await cancelCursorSdk();
  await execution;
  activeAgent?.close();
  lines.close();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runCursorStdio();
