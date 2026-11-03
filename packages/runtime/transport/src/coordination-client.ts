import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  COORDINATION_GRPC_MAX_INPUT_BYTES,
  COORDINATION_GRPC_MAX_OUTPUT_BYTES,
  CoordinationService,
  decodeCoordinationDocument,
  encodeCoordinationDocument,
} from "./coordination-codec.js";
import {
  GrpcExecutionAuthorityClient,
  waitForExecutionAuthorityRefresh,
} from "./execution-authority-client.js";

/** Worker-local MCP compatibility edge; only typed tool calls cross the gRPC connection. */
export class GrpcCoordinationClient {
  readonly #client;
  readonly #authority: GrpcExecutionAuthorityClient;
  #token: string;
  #refreshing: Promise<string> | undefined;
  constructor(options: {
    readonly baseUrl: string;
    readonly token: string;
    readonly tlsCa?: string;
  }) {
    this.#authority = new GrpcExecutionAuthorityClient(options);
    if (!options.token.trim()) throw new Error("Coordination Attempt credential required");
    this.#token = options.token;
    this.#client = createClient(
      CoordinationService,
      createGrpcTransport({
        baseUrl: options.baseUrl,
        readMaxBytes: COORDINATION_GRPC_MAX_OUTPUT_BYTES,
        writeMaxBytes: COORDINATION_GRPC_MAX_INPUT_BYTES,
        idleConnectionTimeoutMs: 1000,
        ...(options.tlsCa === undefined ? {} : { nodeOptions: { ca: options.tlsCa } }),
      }),
    );
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > COORDINATION_GRPC_MAX_INPUT_BYTES)
      return json({ error: "Request too large" }, 413);
    let rpc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      rpc = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "Invalid MCP request" }, 400);
    }
    if (rpc["jsonrpc"] !== "2.0") return json({ error: "Invalid MCP request" }, 400);
    const id = rpc["id"];
    const reply = (result: unknown) => json({ jsonrpc: "2.0", id, result });
    try {
      if (id === undefined) {
        return new Response(null, { status: 202 });
      }
      if (rpc["method"] === "tools/call") {
        const params = rpc["params"];
        if (!params || typeof params !== "object" || Array.isArray(params))
          return json({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid tool arguments" },
          });
        const value = params as Record<string, unknown>;
        if (typeof value["name"] !== "string")
          return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
        const call = {
          name: value["name"],
          arguments: encodeCoordinationDocument(value["arguments"] ?? {}),
        };
        const result = await this.#authorized(
          (options) => this.#client.callTool(call, options),
          request.signal,
        );
        return reply({
          ...(result.isError ? { isError: true } : {}),
          content: result.content.map(({ text }) => ({ type: "text", text })),
        });
      }
      const tools = await this.#authorized(
        (options) => this.#client.listTools({}, options),
        request.signal,
      );
      switch (rpc["method"]) {
        case "initialize":
          return reply({
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "supertag-coordination", version: "1.0.0" },
          });
        case "ping":
          return reply({});
        case "tools/list":
          return reply({
            tools: tools.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: decodeCoordinationDocument(tool.inputSchema),
            })),
          });
        default:
          return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.InvalidArgument)
        return json({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Invalid coordination tool request" },
        });
      // A transport failure cannot be represented as a successful MCP tool result.
      throw error;
    }
  };
  async #authorized<T>(
    call: (options: {
      headers: { authorization: string };
      signal: AbortSignal;
      timeoutMs: number;
    }) => Promise<T>,
    parent: AbortSignal,
  ): Promise<T> {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(30_000)]);
    const token = this.#token;
    const invoke = () =>
      call({ headers: { authorization: `Bearer ${this.#token}` }, signal, timeoutMs: 30_000 });
    try {
      return await invoke();
    } catch (error) {
      if (!(error instanceof ConnectError) || error.code !== Code.Unauthenticated) throw error;
      if (this.#token === token) {
        this.#refreshing ??= this.#recover(token, AbortSignal.timeout(30_000))
          .then((refreshed) => {
            if (this.#token === token) this.#token = refreshed;
            return refreshed;
          })
          .finally(() => {
            this.#refreshing = undefined;
          });
        await waitForExecutionAuthorityRefresh(this.#refreshing, signal);
      }
      return invoke();
    }
  }
  async #recover(token: string, signal: AbortSignal): Promise<string> {
    // Recovery may be in progress when a surviving manager first asks to rebind.
    // Only this credential exchange is retried; a tool mutation is never replayed on transport errors.
    for (;;) {
      signal.throwIfAborted();
      try {
        return await this.#authority.rebind(token, signal);
      } catch (error) {
        if (!(error instanceof ConnectError) || error.code !== Code.Unauthenticated) throw error;
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 250);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
    }
  }
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
