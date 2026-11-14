import type { ProcessHandle } from "./index.js";

export interface EnvironmentGuarantees {
  readonly filesystemIsolation: "none" | "sandbox";
  readonly networkPolicy: "none" | "enforced";
  readonly processTreeTermination: boolean;
  readonly scopedHttp: boolean;
}
export interface EnvironmentConnectionOptions {
  readonly port: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}
export interface EnvironmentHttpRequest {
  readonly method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  /** Origin-relative path, never an arbitrary URL. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}
export interface EnvironmentHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}
export interface EnvironmentConnection {
  request(request: EnvironmentHttpRequest, signal?: AbortSignal): Promise<EnvironmentHttpResponse>;
  close(): Promise<void>;
}
export interface EnvironmentHttpLimits {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}
export const MAX_ENVIRONMENT_HTTP_BYTES = 32 * 1024 * 1024;

/** Provider-side registry: connection authority is an actual live handle, not a PID supplied by a caller. */
export class EnvironmentConnections {
  readonly #processes = new WeakMap<ProcessHandle, AbortController>();
  readonly #closed = new AbortController();
  readonly #connections = new Set<EnvironmentConnection>();
  constructor(
    readonly transport: {
      verify(process: ProcessHandle, port: number, signal: AbortSignal): Promise<void>;
      request(
        process: ProcessHandle,
        port: number,
        request: EnvironmentHttpRequest,
        limits: EnvironmentHttpLimits,
        signal: AbortSignal,
      ): Promise<EnvironmentHttpResponse>;
    },
  ) {}
  register(process: ProcessHandle): void {
    const done = new AbortController();
    this.#processes.set(process, done);
    void process.wait().then(
      () => done.abort(new Error("Server process exited")),
      () => done.abort(new Error("Server process failed")),
    );
  }
  async connect(
    process: ProcessHandle,
    options: EnvironmentConnectionOptions,
    signal?: AbortSignal,
  ): Promise<EnvironmentConnection> {
    const lifetime = this.#processes.get(process);
    if (!lifetime) throw new Error("HTTP connection requires a process owned by this environment");
    const limits = connectionLimits(options);
    const port = options.port;
    const signals = [this.#closed.signal, lifetime.signal, ...(signal ? [signal] : [])];
    const verification = AbortSignal.any([...signals, AbortSignal.timeout(limits.timeoutMs)]);
    verification.throwIfAborted();
    await this.transport.verify(process, port, verification);
    verification.throwIfAborted();
    const closed = new AbortController();
    const pending = new Set<Promise<EnvironmentHttpResponse>>();
    const connection: EnvironmentConnection = {
      request: (request, signal) => {
        validateRequest(request);
        const frozen: EnvironmentHttpRequest = {
          path: request.path,
          ...(request.method ? { method: request.method } : {}),
          ...(request.headers ? { headers: { ...request.headers } } : {}),
          ...(request.body ? { body: new Uint8Array(request.body) } : {}),
        };
        const combined = AbortSignal.any([
          ...signals,
          closed.signal,
          ...(signal ? [signal] : []),
          AbortSignal.timeout(limits.timeoutMs),
        ]);
        combined.throwIfAborted();
        const run = this.transport
          .request(process, port, frozen, limits, combined)
          .then((response) => {
            combined.throwIfAborted();
            if (
              !Number.isInteger(response.status) ||
              response.status < 100 ||
              response.status > 599 ||
              response.body.byteLength > limits.maxResponseBytes
            )
              throw new Error("Invalid or oversized environment HTTP response");
            validateHeaders(response.headers, false);
            return response;
          });
        pending.add(run);
        void run.finally(() => pending.delete(run)).catch(() => {});
        return run;
      },
      close: async () => {
        closed.abort(new Error("Environment HTTP connection closed"));
        await Promise.allSettled([...pending]);
        this.#connections.delete(connection);
      },
    };
    this.#connections.add(connection);
    return connection;
  }
  async close(): Promise<void> {
    this.#closed.abort(new Error("Execution Environment closed"));
    await Promise.all([...this.#connections].map((connection) => connection.close()));
  }
}
function connectionLimits(options: EnvironmentConnectionOptions): EnvironmentHttpLimits {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new Error("Invalid environment HTTP port");
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new Error("Environment HTTP timeout must be between 1 and 120000 ms");
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_ENVIRONMENT_HTTP_BYTES
  )
    throw new Error("Invalid environment HTTP response bound");
  return { timeoutMs, maxResponseBytes };
}
function validateRequest(request: EnvironmentHttpRequest): void {
  if (
    !request.path.startsWith("/") ||
    request.path.startsWith("//") ||
    /[\r\n\\#]/.test(request.path) ||
    request.path.length > 8192
  )
    throw new Error("Environment HTTP requires an origin-relative path");
  if (
    request.method &&
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)
  )
    throw new Error("Unsupported environment HTTP method");
  if (
    request.body &&
    (!(request.body instanceof Uint8Array) || request.body.byteLength > MAX_ENVIRONMENT_HTTP_BYTES)
  )
    throw new Error("Environment HTTP request exceeded byte bound");
  validateHeaders(request.headers ?? {}, true);
}
function validateHeaders(headers: Readonly<Record<string, string>>, request: boolean): void {
  let bytes = 0;
  if (Object.keys(headers).length > 100) throw new Error("Too many environment HTTP headers");
  for (const [name, value] of Object.entries(headers)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) ||
      typeof value !== "string" ||
      /[\r\n]/.test(value)
    )
      throw new Error("Invalid environment HTTP header");
    if (
      request &&
      [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "upgrade",
        "proxy-authorization",
        "proxy-connection",
      ].includes(name.toLowerCase())
    )
      throw new Error("Environment HTTP routing headers are provider-owned");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (bytes > 16384) throw new Error("Environment HTTP headers exceeded byte bound");
}
