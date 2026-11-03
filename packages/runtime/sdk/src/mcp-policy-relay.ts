import type { EnvironmentAccess } from "./index.js";
import { ExecutionCleanupError } from "./process-supervision.js";

/**
 * The loopback address a harness reaches its MCP policy proxy at. On the Worker Host it is the
 * proxy itself; inside a remote harness runtime it is the relay below, the runtime's own
 * loopback, which is never egress from it.
 */
export const MCP_POLICY_PROXY_HOST = "127.0.0.1";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 8 * 1_048_576;
/** A request frame: a 1 MiB body in base64 plus bounded headers. */
const MAX_FRAME_BYTES = 2 * 1_048_576;
/** Requests the Worker forwards at once; more are answered 503. */
const MAX_IN_FLIGHT = 64;
/** Request headers a harness MCP client needs; nothing else reaches the proxy. */
const FORWARDED_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
] as const;

/**
 * Dependency-free Node.js program run inside a remote harness runtime. It listens on the
 * runtime's loopback only and passes each `POST /mcp` request, with only the MCP headers, to the
 * Worker over its supervised process streams. It holds no credential: the Worker's policy proxy
 * checks the per-Attempt bearer secret, grants, and approvals on every request.
 */
export const MCP_POLICY_RELAY_SOURCE = String.raw`
const http = require("node:http");
const { StringDecoder } = require("node:string_decoder");
const MAX_BODY = ${MAX_REQUEST_BYTES};
const MAX_LINE = ${MAX_RESPONSE_BYTES * 2};
const FORWARDED = ${JSON.stringify(FORWARDED_HEADERS)};
const pending = new Map();
let next = 1;
function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
function stop(code) {
  for (const response of pending.values()) response.destroy();
  pending.clear();
  process.exit(code);
}
const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/mcp") {
    request.resume();
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  let refused = false;
  request.on("error", () => {});
  request.on("data", chunk => {
    if (refused) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      refused = true;
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (refused) return;
    const id = next++;
    pending.set(id, response);
    response.on("close", () => { if (pending.delete(id)) send({ id, cancel: true }); });
    const headers = {};
    for (const name of FORWARDED) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    send({ id, headers, body: Buffer.concat(chunks).toString("base64") });
  });
});
function answer(message) {
  const response = pending.get(message.id);
  if (!response) return;
  pending.delete(message.id);
  const headers = {};
  if (typeof message.contentType === "string") headers["content-type"] = message.contentType;
  if (typeof message.sessionId === "string") headers["mcp-session-id"] = message.sessionId;
  const status = Number.isInteger(message.status) && message.status >= 200 && message.status <= 599
    ? message.status : 502;
  response.writeHead(status, headers);
  response.end(Buffer.from(typeof message.body === "string" ? message.body : "", "base64"));
}
const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += decoder.write(chunk);
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    try { answer(JSON.parse(line)); } catch { stop(1); }
  }
  if (buffer.length > MAX_LINE) stop(1);
});
process.stdin.on("end", () => { server.close(); stop(0); });
process.once("SIGTERM", () => stop(0));
server.once("error", () => stop(1));
server.listen(0, "127.0.0.1", () => send({ listening: server.address().port }));
`;

export interface McpPolicyRelay {
  /** The URL a harness inside the runtime uses: the runtime's own loopback. */
  readonly url: string;
  close(): Promise<void>;
}

export interface McpPolicyRelayOptions {
  /** Node.js command available inside the runtime. Default: `node`. */
  readonly nodeCommand?: string;
  /** Bound for the relay to start listening. Default: 10 seconds. */
  readonly startTimeoutMs?: number;
}

/**
 * Makes a Worker-local MCP policy proxy reachable from inside a remote harness runtime, without
 * exposing it on any Worker Host interface. A relay inside the runtime listens on the runtime's
 * loopback and forwards each request over the runtime's supervised process streams; the Worker
 * sends it on to the proxy on its own loopback. The proxy still checks the bearer secret, grants,
 * resource arguments, and approvals on every call, and upstream credentials stay with it.
 */
export async function relayMcpPolicyProxy(
  runtime: EnvironmentAccess,
  proxyUrl: string,
  options: McpPolicyRelayOptions = {},
): Promise<McpPolicyRelay> {
  const target = new URL(proxyUrl);
  if (target.protocol !== "http:" || target.hostname !== MCP_POLICY_PROXY_HOST)
    throw new Error("An MCP policy relay forwards only to a Worker-local policy proxy");
  const process = await runtime.spawn({
    command: options.nodeCommand ?? "node",
    args: ["-e", MCP_POLICY_RELAY_SOURCE],
    cwd: ".",
    environment: {},
    streamInput: true,
    streamOutput: true,
  });
  const { output, write, endInput } = process;
  if (output === undefined || write === undefined || endInput === undefined) {
    try {
      process.kill();
    } catch {}
    await boundedWait([process.wait()]);
    throw new Error("An MCP policy relay requires supervised streaming input and output");
  }
  const closed = new AbortController();
  const inFlight = new Map<number, AbortController>();
  let exited = false;
  let writes: Promise<void> = Promise.resolve();
  const send = (frame: Readonly<Record<string, unknown>>) => {
    writes = writes
      .then(() => write.call(process, Buffer.from(`${JSON.stringify(frame)}\n`)))
      .catch(() => closed.abort());
    return writes;
  };
  let listening!: (port: number) => void;
  let failed!: (error: Error) => void;
  const started = new Promise<number>((resolve, reject) => {
    listening = resolve;
    failed = reject;
  });
  const forward = async (id: number, frame: Readonly<Record<string, unknown>>) => {
    const request = new AbortController();
    inFlight.set(id, request);
    try {
      const body = relayBody(frame["body"]);
      const response = await fetch(target, {
        method: "POST",
        headers: relayHeaders(frame["headers"]),
        body,
        redirect: "error",
        signal: AbortSignal.any([closed.signal, request.signal]),
      });
      const bytes = await boundedBody(response, MAX_RESPONSE_BYTES);
      const contentType = response.headers.get("content-type");
      const sessionId = response.headers.get("mcp-session-id");
      await send({
        id,
        status: response.status,
        ...(contentType === null ? {} : { contentType }),
        ...(sessionId === null ? {} : { sessionId }),
        body: Buffer.from(bytes).toString("base64"),
      });
    } catch {
      if (!closed.signal.aborted) await send({ id, status: 502, body: "" });
    } finally {
      inFlight.delete(id);
    }
  };
  // The relay runs beside the Task's own processes, so every frame it sends is untrusted.
  const handle = (value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("The MCP policy relay sent an invalid frame");
    const frame = value as Readonly<Record<string, unknown>>;
    if ("listening" in frame) {
      const port = frame["listening"];
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error("The MCP policy relay reported an invalid port");
      listening(port);
      return;
    }
    const id = frame["id"];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
      throw new Error("The MCP policy relay sent a frame without a request ID");
    if (frame["cancel"] === true) {
      inFlight.get(id)?.abort();
      return;
    }
    if (inFlight.has(id)) throw new Error("The MCP policy relay reused a request ID");
    if (inFlight.size >= MAX_IN_FLIGHT) {
      void send({ id, status: 503, body: "" });
      return;
    }
    void forward(id, frame);
  };
  const reading = (async () => {
    let buffer = "";
    for await (const chunk of output) {
      if (chunk.stream === "stderr") continue;
      buffer += chunk.text;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line) handle(JSON.parse(line) as unknown);
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
        throw new Error("The MCP policy relay sent an oversized frame");
    }
  })();
  const stopped = (error: unknown) => {
    closed.abort();
    failed(error instanceof Error ? error : new Error(String(error)));
    try {
      process.kill();
    } catch {}
  };
  void reading.then(() => stopped(new Error("The MCP policy relay closed its output")), stopped);
  const waited = process.wait().then(
    () => {
      exited = true;
      stopped(new Error("The MCP policy relay exited"));
    },
    (error: unknown) => stopped(error),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let port: number;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      closed.abort();
      await endInput.call(process).catch(() => undefined);
      const kill = setTimeout(() => {
        try {
          process.kill();
        } catch {}
      }, 3_000);
      kill.unref();
      await boundedWait([waited, reading.catch(() => undefined)]);
      clearTimeout(kill);
      if (!exited)
        throw new ExecutionCleanupError(
          "MCP policy relay cleanup could not confirm process termination",
        );
    })();
    return closing;
  };
  try {
    port = await Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The MCP policy relay did not start listening")),
          options.startTimeoutMs ?? 10_000,
        );
      }),
    ]);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { url: `http://${MCP_POLICY_PROXY_HOST}:${port}/mcp`, close };
}

function relayHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return headers;
  for (const name of FORWARDED_HEADERS) {
    const header = (value as Record<string, unknown>)[name];
    if (typeof header === "string") headers[name] = header;
  }
  return headers;
}

function relayBody(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > MAX_FRAME_BYTES)
    throw new Error("The MCP policy relay sent an invalid request body");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > MAX_REQUEST_BYTES)
    throw new Error("The MCP policy relay sent an oversized request body");
  return new Uint8Array(bytes);
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("The MCP policy proxy response exceeds the relay bound");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new Uint8Array(Buffer.concat(chunks));
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
