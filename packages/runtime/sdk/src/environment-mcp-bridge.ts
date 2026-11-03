import type { JsonRecord } from "@supertag/core";
import type { ExecutionEnvironment } from "./index.js";
import { ExecutionCleanupError } from "./process-supervision.js";

/**
 * Dependency-free Node.js program run inside an execution environment. It owns
 * the MCP session while the Worker exchanges a private JSONL control protocol
 * over the environment's supervised process streams.
 */
export const ENVIRONMENT_MCP_BRIDGE_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const MAX_LINE_BYTES = 1024 * 1024;

let server;
let http;
let sessionId;
let protocolVersion;
const httpAbort = new AbortController();
let nextServerId = 1;
let started = false;
let ready = false;
let closing = false;
let listing = false;
let shutdownPromise;
let allowedTools = new Set();
const pending = new Map();

process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function failPending(error) {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

function serverRequest(method, params) {
  if (http) return httpMessage({ jsonrpc: "2.0", id: nextServerId++, method, params });
  if (!server?.stdin?.writable) return Promise.reject(new Error("MCP server input is unavailable"));
  const id = nextServerId++;
  return new Promise((resolve, reject) => {
    pending.set(String(id), { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => {
      if (error) {
        pending.delete(String(id));
        reject(error);
      }
    });
  });
}

async function serverNotification(method, params) {
  if (http) return await httpMessage({ jsonrpc: "2.0", method, params });
  if (!server?.stdin?.writable) throw new Error("MCP server input is unavailable");
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function onServerLine(line) {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("MCP server frame exceeds limit");
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const entry = message.method === undefined ? pending.get(String(message.id)) : undefined;
  if (entry) {
    pending.delete(String(message.id));
    if (message.error) entry.reject(new Error(String(message.error.message || "MCP request failed")));
    else entry.resolve(message.result);
    return;
  }
  if (message.method && server?.stdin?.writable) {
    server.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Client request unsupported" },
    }) + "\n");
  }
}

// Bound incomplete frames as they arrive, before allocating a full line.
function readLines(stream, onLine, onEnd) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", chunk => {
    try {
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("MCP frame exceeds limit");
        if (line) onLine(line);
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw new Error("MCP frame exceeds limit");
    } catch (error) { fatal(error); }
  });
  stream.once("error", fatal);
  stream.once("end", onEnd);
}

function fatal(error) {
  failPending(error);
  if (!closing) {
    send({ id: null, error: "MCP connection failed" });
    void shutdown().finally(() => process.exit(1));
  }
}

function killServer(signal) {
  if (!server?.pid) return;
  try {
    if (process.platform === "win32") server.kill(signal);
    else process.kill(-server.pid, signal);
  } catch {}
}

function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
  closing = true;
  ready = false;
  failPending(new Error("MCP connection closed"));
  httpAbort.abort();
  killServer("SIGTERM");
  // Kill descendants even if their parent exits first.
  if (server) {
    await new Promise(resolve => setTimeout(resolve, 100));
    killServer("SIGKILL");
  }
  if (http && sessionId) {
    try {
      await fetch(http.url, {
        method: "DELETE", headers: httpHeaders(), redirect: "error", signal: AbortSignal.timeout(500),
      }).then(async response => {
        await response.body?.cancel();
        if (!response.ok && ![404, 405, 410].includes(response.status))
          throw new Error("MCP session termination failed");
      });
    } catch {
      // The bridge can exit cleanly while the remote session remains uncertain.
      // Report that separately from the failure of an in-flight tool call.
      await new Promise((resolve, reject) => {
        const frame = JSON.stringify({ cleanupError: "Execution-environment MCP cleanup could not confirm session termination" }) + "\n";
        process.stdout.write(frame, error => error ? reject(error) : resolve());
      });
      throw new Error("MCP session termination could not be confirmed");
    }
  }
  })();
  return shutdownPromise;
}

function httpHeaders() {
  const headers = new Headers(http.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json, text/event-stream");
  if (sessionId) headers.set("Mcp-Session-Id", sessionId);
  if (protocolVersion) headers.set("MCP-Protocol-Version", protocolVersion);
  return headers;
}

async function httpMessage(message) {
  const response = await fetch(http.url, {
    method: "POST", headers: httpHeaders(), body: JSON.stringify(message),
    redirect: "error", signal: httpAbort.signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("MCP HTTP request failed (" + response.status + "); request was not replayed");
  }
  if (message.method === "initialize") sessionId = response.headers.get("mcp-session-id") ?? undefined;
  if (message.id === undefined || message.method === undefined) { await response.body?.cancel(); return; }
  const type = response.headers.get("content-type")?.split(";")[0].trim();
  if (!response.body || !["application/json", "text/event-stream"].includes(type)) {
    await response.body?.cancel();
    throw new Error("Invalid MCP HTTP response type");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const accept = async value => {
    if (!value || value.jsonrpc !== "2.0") throw new Error("Invalid MCP response");
    if (value.method !== undefined) {
      if (value.id !== undefined) {
        await httpMessage({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "Client request unsupported" } });
      }
      return { matched: false };
    }
    if (value.id !== message.id) throw new Error("Mismatched MCP response ID");
    if (value.error) throw new Error(String(value.error.message || "MCP request failed"));
    if (!("result" in value)) throw new Error("Invalid MCP response result");
    return { matched: true, result: value.result };
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (type === "text/event-stream") {
        buffer = buffer.replace(/\r\n/g, "\n");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (Buffer.byteLength(event) > MAX_LINE_BYTES) throw new Error("MCP frame exceeds limit");
          const data = event.split("\n").filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (data) {
            const result = await accept(JSON.parse(data));
            if (result.matched) return result.result;
          }
        }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw new Error("MCP frame exceeds limit");
      if (done) {
        if (type === "application/json") {
          const result = await accept(JSON.parse(buffer));
          if (!result.matched) throw new Error("MCP HTTP request did not receive a response");
          return result.result;
        }
        throw new Error("MCP HTTP stream ended before a response; request was not replayed");
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

async function listTools() {
  const tools = [];
  const cursors = new Set();
  let cursor;
  do {
    const result = await serverRequest("tools/list", cursor ? { cursor } : {});
    for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
      if (listing || allowedTools.has(tool.name)) tools.push(tool);
    }
    cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("Invalid MCP tool pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}

async function start(message) {
  if (started) throw new Error("Environment MCP client is already initialized");
  started = true;
  // Listing returns every tool so the Worker can match them to grants; it never calls one.
  if (message.listOnly === true) listing = true;
  else if (!Array.isArray(message.toolNames) || !message.toolNames.every(value => typeof value === "string"))
    throw new Error("MCP tool allowlist is invalid");
  else allowedTools = new Set(message.toolNames);
  if (message.server?.transport === "mcp-http") {
    const url = new URL(message.server.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Invalid MCP HTTP endpoint");
    http = { url: url.href, headers: message.server.headers ?? {} };
  } else {
    if (typeof message.server?.command !== "string" || !message.server.command)
      throw new Error("MCP server command is required");
    if (!Array.isArray(message.server.args) || !message.server.args.every(value => typeof value === "string"))
      throw new Error("MCP server arguments are invalid");
    // The Worker passes a stdio server's working directory as the bridge's one argument.
    const cwd = process.argv[1];
    if (cwd !== undefined && !require("node:path").isAbsolute(cwd))
      throw new Error("MCP server working directory must be absolute");
    server = spawn(message.server.command, message.server.args, {
      cwd: cwd ?? process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    server.stdin.on("error", () => {});
    server.stderr.on("data", () => {});
    server.once("error", fatal);
    server.once("exit", () => { if (!closing) fatal(new Error("MCP server exited unexpectedly")); });
    readLines(server.stdout, onServerLine, () => {
      if (!closing) fatal(new Error("MCP server output closed"));
    });
  }
  const initialized = await serverRequest("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "supertag-execution-environment", version: "1" },
  });
  protocolVersion = initialized?.protocolVersion;
  if (!["2025-06-18", "2025-03-26", "2024-11-05"].includes(protocolVersion))
    throw new Error("Unsupported MCP protocol version");
  await serverNotification("notifications/initialized", {});
  const tools = await listTools();
  ready = true;
  return { protocolVersion, tools };
}

async function handle(message) {
  if (!message || (typeof message.id !== "string" && typeof message.id !== "number"))
    throw new Error("Environment MCP request has no ID");
  if (message.method === "start") return await start(message);
  if (message.method === "call") {
    if (!ready || closing) throw new Error("Environment MCP client is not initialized");
    if (listing) throw new Error("Environment MCP client is listing tools only");
    if (typeof message.name !== "string" || !allowedTools.has(message.name))
      throw new Error("MCP tool is outside the admitted allowlist");
    return await serverRequest("tools/call", {
      name: message.name,
      arguments: message.arguments && typeof message.arguments === "object" && !Array.isArray(message.arguments)
        ? message.arguments
        : {},
    });
  }
  if (message.method === "close") {
    await shutdown();
    return { closed: true };
  }
  throw new Error("Unknown environment MCP method");
}

readLines(process.stdin, line => {
  let message;
  try { message = JSON.parse(line); }
  catch { fatal(new Error("Environment MCP request is invalid JSON")); return; }
  Promise.resolve(handle(message)).then(
    result => {
      send({ id: message.id, result });
      if (message.method === "close") process.exit(0);
    },
    error => { send({ id: message.id, error: error instanceof Error ? error.message : String(error) }); },
  );
}, () => { void shutdown().finally(() => process.exit(0)); });
`;

/** The server one bridge connects to: a stdio process beside it, or an HTTP endpoint. */
export type EnvironmentMcpBridgeServer =
  | {
      readonly transport: "mcp-stdio";
      readonly command: string;
      readonly args: readonly string[];
      /** Absolute working directory inside the environment. Default: the bridge's own. */
      readonly cwd?: string;
    }
  | {
      readonly transport: "mcp-http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export interface EnvironmentMcpBridgeOptions {
  /** Node.js command available inside the execution environment. Default: `node`. */
  readonly nodeCommand?: string;
  /** Bound for each bridge request. Default: 10 seconds. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Variables the bridge, and so a stdio server, starts with beyond the environment's own. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Start with exactly `environment`, without the variables the environment's plan set. */
  readonly replaceEnvironment?: boolean;
}

/** One running bridge: the tools its server advertised, a raw call, and close. No policy. */
export interface EnvironmentMcpBridge {
  readonly tools: readonly JsonRecord[];
  call(name: string, arguments_: JsonRecord): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Starts the environment MCP bridge inside `environment` and connects it to `server`, speaking
 * only over the environment's supervised process streams. With `toolNames`, it advertises and
 * calls only those tools; with `listOnly`, it advertises every tool and refuses every call. The
 * caller applies grants and approvals before each call.
 */
export async function openEnvironmentMcpBridge(
  environment: ExecutionEnvironment,
  start:
    | { readonly server: EnvironmentMcpBridgeServer; readonly toolNames: readonly string[] }
    | { readonly server: EnvironmentMcpBridgeServer; readonly listOnly: true },
  options: EnvironmentMcpBridgeOptions = {},
): Promise<EnvironmentMcpBridge> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Execution-environment MCP timeout must be a positive integer");
  options.signal?.throwIfAborted();
  const { cwd, ...server } =
    start.server.transport === "mcp-stdio" ? start.server : { ...start.server, cwd: undefined };
  if (cwd !== undefined && !cwd.startsWith("/"))
    throw new Error("Execution-environment MCP server working directory must be absolute");
  // Own cancellation here so the provider does not reject wait() before the
  // bridge can shut down its server and report process termination.
  const process = await environment.spawn({
    command: options.nodeCommand ?? "node",
    args: ["-e", ENVIRONMENT_MCP_BRIDGE_SOURCE, ...(cwd === undefined ? [] : [cwd])],
    cwd: environment.rootDirectory,
    environment: { ...(options.environment ?? {}) },
    ...(options.replaceEnvironment ? { replaceEnvironment: true } : {}),
    streamInput: true,
    streamOutput: true,
  });
  if (!process.output || !process.write || !process.endInput) {
    try {
      process.kill();
    } catch {}
    await boundedWait([process.wait()]);
    throw new Error("Execution-environment MCP requires supervised streaming input and output");
  }

  type Pending = {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<string, Pending>();
  let requestId = 0;
  let stdout = "";
  let failure: Error | undefined;
  let cleanupFailure: ExecutionCleanupError | undefined;
  let closing = false;
  let closed = false;
  let processExited = false;
  let closingPromise: Promise<void> | undefined;
  const fail = (error: unknown) => {
    const cause = error instanceof Error ? error : new Error(String(error));
    failure ??= cause;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(cause);
    }
    pending.clear();
  };
  let stopping = false;
  const stopProcess = () => {
    if (stopping) return;
    stopping = true;
    void process.endInput?.().catch(() => {});
    const timer = setTimeout(() => {
      try {
        process.kill();
      } catch {}
    }, 3_000);
    timer.unref();
    void process.wait().then(
      () => clearTimeout(timer),
      () => {},
    );
  };
  const aborted = () => {
    fail(options.signal?.reason ?? new Error("Execution-environment MCP cancelled"));
    stopProcess();
  };
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  const outputDone = (async () => {
    for await (const chunk of process.output ?? []) {
      if (chunk.stream === "stderr") {
        continue;
      }
      stdout += chunk.text;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024)
        throw new Error("Execution-environment MCP emitted an oversized frame");
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const response = environmentMcpRecord(JSON.parse(line));
        if (typeof response["cleanupError"] === "string") {
          cleanupFailure = new ExecutionCleanupError(response["cleanupError"]);
          fail(cleanupFailure);
          stopProcess();
          continue;
        }
        const id = response["id"];
        if (typeof id !== "string" && typeof id !== "number")
          throw new Error("Execution-environment MCP connection failed");
        const entry = pending.get(String(id));
        if (!entry) continue;
        pending.delete(String(id));
        clearTimeout(entry.timer);
        if (typeof response["error"] === "string") {
          const error = new Error(response["error"]);
          entry.reject(error);
          fail(error);
          stopProcess();
        } else entry.resolve(response["result"]);
      }
    }
  })().catch((error) => {
    fail(error);
    stopProcess();
  });
  const processDone = process.wait().then((result) => {
    processExited = true;
    if (!closing)
      fail(
        new Error(
          `Execution-environment MCP client exited unexpectedly${result.exitCode === null ? "" : ` (${result.exitCode})`}`,
        ),
      );
  }, fail);
  const request = async (method: "start" | "call" | "close", payload: JsonRecord) => {
    if (method !== "close" && (closed || closing || failure))
      throw failure ?? new Error("Execution-environment MCP client is closed");
    const id = ++requestId;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(
          `Execution-environment MCP ${method} timed out; request was not replayed`,
        );
        fail(error);
        stopProcess();
      }, timeoutMs);
      pending.set(String(id), { resolve, reject, timer });
    });
    // Attach the response handler before writing: stalled writes must not hide a timeout.
    void process
      .write?.(Buffer.from(`${JSON.stringify({ id, method, ...payload })}\n`))
      .catch((error) => {
        fail(error);
        stopProcess();
      });
    return await response;
  };

  try {
    const started = environmentMcpRecord(
      await request("start", {
        server: server as unknown as JsonRecord,
        ...("listOnly" in start ? { listOnly: true } : { toolNames: [...start.toolNames] }),
      }),
    );
    const tools = Array.isArray(started["tools"]) ? started["tools"].map(environmentMcpRecord) : [];
    return {
      tools,
      call: (name, arguments_) => request("call", { name, arguments: arguments_ }),
      close() {
        if (closingPromise) return closingPromise;
        closingPromise = (async () => {
          closed = true;
          closing = true;
          try {
            if (!failure) await boundedWait([request("close", {})]);
          } finally {
            options.signal?.removeEventListener("abort", aborted);
            fail(new Error("Execution-environment MCP client closed"));
            stopProcess();
            await boundedWait([outputDone, processDone]);
          }
          if (!processExited)
            throw new ExecutionCleanupError(
              "Execution-environment MCP cleanup could not confirm process termination",
            );
          if (cleanupFailure) throw cleanupFailure;
        })();
        return closingPromise;
      },
    };
  } catch (error) {
    closing = true;
    closed = true;
    options.signal?.removeEventListener("abort", aborted);
    fail(error);
    stopProcess();
    await boundedWait([outputDone, processDone]);
    if (cleanupFailure)
      throw new ExecutionCleanupError(
        "Execution-environment MCP startup cleanup could not be confirmed",
        {
          cause: new AggregateError([error, cleanupFailure], "MCP startup and cleanup failed"),
        },
      );
    if (!processExited)
      throw new ExecutionCleanupError(
        "Execution-environment MCP startup cleanup could not confirm process termination",
        { cause: error },
      );
    throw error;
  }
}

async function boundedWait(work: readonly Promise<unknown>[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(work),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 4_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A bridge frame or tool as a plain object; anything else fails the connection. */
export function environmentMcpRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Execution-environment MCP returned an invalid object");
  return value as JsonRecord;
}
