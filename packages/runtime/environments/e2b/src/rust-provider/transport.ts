import { timingSafeEqual } from "node:crypto";
import { createServer, type ServerHttp2Session } from "node:http2";
import { Readable, type Writable } from "node:stream";
import { fromBinary } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  createContextKey,
  createContextValues,
  type HandlerContext,
  type ServiceImpl,
} from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  HarnessWorkspace,
  RemoteWorkspaceProvider,
  RemoteWorkspaceProviderBootstrapSchema,
} from "@supertag/worker-sdk/internal/rust-harness";

const HOST = "127.0.0.1";
const MAX_BOOTSTRAP_BYTES = 4096;
const MAX_STREAM_MESSAGES = 65_536;
const MAXIMUM = {
  messageBytes: 1024 * 1024,
  chunkBytes: 256 * 1024,
  streamBytes: 256 * 1024 * 1024,
};

export interface RemoteWorkspaceHandlers {
  readonly provider: ServiceImpl<typeof RemoteWorkspaceProvider>;
  readonly workspace: ServiceImpl<typeof HarnessWorkspace>;
}

export interface RemoteWorkspaceTransport {
  readonly endpoint: string;
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface TransportOptions extends RemoteWorkspaceHandlers {
  readonly token: string;
  readonly signal?: AbortSignal;
  /** Optional tighter limits; never allows the wire's hard bounds to grow. */
  readonly limits?: Partial<typeof MAXIMUM>;
}

function validToken(token: string): boolean {
  return /^[\x21-\x7e]{16,1024}$/.test(token);
}

function cancelled(): ConnectError {
  return new ConnectError("Remote workspace transport stopped", Code.Canceled);
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw cancelled();
  const aborted = Promise.withResolvers<T>();
  const onAbort = () => aborted.reject(cancelled());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The Host closes stdin after this raw protobuf, not after the provider's lifetime. */
export async function readRemoteWorkspaceBootstrap(
  input: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const iterator = input[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await abortable(iterator.next(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BOOTSTRAP_BYTES)
        throw new Error("Remote workspace bootstrap exceeds its limit");
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    // Do not wait for a producer that is blocked reading a disconnected pipe.
    void iterator.return?.().catch(() => undefined);
    throw error;
  }
  try {
    const bootstrap = fromBinary(RemoteWorkspaceProviderBootstrapSchema, Buffer.concat(chunks));
    if (!validToken(bootstrap.token)) throw new Error("invalid token");
    return bootstrap;
  } catch {
    throw new Error("Invalid remote workspace bootstrap");
  }
}

function limitsFor(input: TransportOptions["limits"]) {
  const result = { ...MAXIMUM, ...input };
  for (const key of ["messageBytes", "chunkBytes", "streamBytes"] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > MAXIMUM[key])
      throw new Error("Invalid remote workspace transport limit");
  }
  return result;
}

function safeError(error: unknown, context: HandlerContext): ConnectError {
  if (context.signal.aborted) return cancelled();
  return error instanceof ConnectError
    ? error
    : new ConnectError("Remote workspace operation failed", Code.Internal);
}

async function invoke<T>(context: HandlerContext, call: () => T | Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw safeError(error, context);
  }
}

async function* boundedParts<T extends { part?: { case?: string | undefined; value?: unknown } }>(
  source: AsyncIterable<T>,
  limits: typeof MAXIMUM,
  context: HandlerContext,
): AsyncGenerator<T> {
  let bytes = 0;
  let messages = 0;
  try {
    for await (const part of source) {
      if (context.signal.aborted) throw cancelled();
      if (++messages > MAX_STREAM_MESSAGES)
        throw new ConnectError(
          "Workspace stream exceeds its message limit",
          Code.ResourceExhausted,
        );
      if (part.part?.case === "payload") {
        const payload = part.part.value;
        if (!(payload instanceof Uint8Array))
          throw new ConnectError("Invalid workspace payload", Code.InvalidArgument);
        bytes += payload.byteLength;
        if (payload.byteLength > limits.chunkBytes || bytes > limits.streamBytes)
          throw new ConnectError("Workspace stream exceeds its byte limit", Code.ResourceExhausted);
      }
      yield part;
    }
  } catch (error) {
    throw safeError(error, context);
  }
}

/** One private Host channel carries both lifecycle and scoped Workspace operations. */
export async function startRemoteWorkspaceTransport(
  options: TransportOptions,
): Promise<RemoteWorkspaceTransport> {
  if (!validToken(options.token)) throw new Error("Invalid remote workspace bootstrap");
  if (options.signal?.aborted) throw cancelled();
  const limits = limitsFor(options.limits);
  const expected = Buffer.from(`Bearer ${options.token}`);
  const ending = new AbortController();
  const ended = Promise.withResolvers<void>();
  const sessions = new Set<ServerHttp2Session>();
  const authenticated = new Set<ServerHttp2Session>();
  const sessionKey = createContextKey<ServerHttp2Session | undefined>(undefined);
  let closing: Promise<void> | undefined;
  const server = createServer(
    { maxHeaderListPairs: 32, settings: { maxConcurrentStreams: 16, maxHeaderListSize: 8192 } },
    connectNodeAdapter({
      grpc: true,
      grpcWeb: false,
      connect: false,
      acceptCompression: [],
      readMaxBytes: limits.messageBytes,
      writeMaxBytes: limits.messageBytes,
      shutdownSignal: ending.signal,
      contextValues: (request) =>
        createContextValues().set(
          sessionKey,
          "stream" in request ? request.stream.session : undefined,
        ),
      requestGate(context) {
        const authorization = context.requestHeader.get("authorization");
        if (
          authorization === null ||
          Buffer.byteLength(authorization) !== expected.byteLength ||
          !timingSafeEqual(Buffer.from(authorization), expected)
        )
          throw new ConnectError("Private workspace authentication required", Code.Unauthenticated);
        if (context.requestHeader.has("origin"))
          throw new ConnectError("Browser requests are not allowed", Code.PermissionDenied);
        if (ending.signal.aborted) throw cancelled();
        const session = context.values.get(sessionKey);
        if (session) {
          authenticated.add(session);
          session.setTimeout(0);
        }
      },
      routes(router) {
        router.service(RemoteWorkspaceProvider, {
          allocate: (request, context) =>
            invoke(context, () => options.provider.allocate(request, context)),
          stage: (stream, context) =>
            invoke(context, () =>
              options.provider.stage(boundedParts(stream, limits, context), context),
            ),
          capture: async function* (request, context) {
            try {
              yield* boundedParts(options.provider.capture(request, context), limits, context);
            } catch (error) {
              throw safeError(error, context);
            }
          },
          stop: (request, context) =>
            invoke(context, () => options.provider.stop(request, context)),
        });
        router.service(HarnessWorkspace, {
          execute: (request, context) =>
            invoke(context, () => options.workspace.execute(request, context)),
        });
      },
    }),
  );
  server.maxConnections = 8;
  const onAbort = () => {
    void close();
  };
  function close(): Promise<void> {
    closing ??= (async () => {
      options.signal?.removeEventListener("abort", onAbort);
      ending.abort(cancelled());
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const session of sessions) session.destroy();
      await stopped;
      ended.resolve();
    })();
    return closing;
  }
  server.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {
      /* Socket failures are handled through close/cancellation. */
    });
    session.setTimeout(5000, () => session.destroy());
    session.once("close", () => {
      sessions.delete(session);
      const wasAuthenticated = authenticated.delete(session);
      if (wasAuthenticated && authenticated.size === 0) void close();
    });
  });
  server.on("error", onAbort);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted || ending.signal.aborted) throw cancelled();
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Private workspace listener unavailable");
    return {
      endpoint: `http://${HOST}:${address.port}`,
      signal: ending.signal,
      closed: ended.promise,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Only the endpoint is written to stdout; provider diagnostics belong on stderr. */
export async function runRemoteWorkspaceTransport(
  handlers: RemoteWorkspaceHandlers,
  options: { input?: AsyncIterable<Uint8Array>; output?: Writable; signal?: AbortSignal } = {},
): Promise<void> {
  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stop = () => lifetime.abort(cancelled());
  const closeInput = () => {
    if (input instanceof Readable) input.destroy();
  };
  signal.addEventListener("abort", closeInput, { once: true });
  if (!options.signal) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
  output.on("error", stop);
  let transport: Awaited<ReturnType<typeof startRemoteWorkspaceTransport>> | undefined;
  try {
    const bootstrap = await readRemoteWorkspaceBootstrap(
      input,
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    );
    transport = await startRemoteWorkspaceTransport({
      ...handlers,
      token: bootstrap.token,
      signal,
    });
    const endpoint = transport.endpoint;
    await abortable(
      new Promise<void>((resolve, reject) =>
        output.write(`${endpoint}\n`, (error) =>
          error ? reject(new Error("Workspace endpoint announcement failed")) : resolve(),
        ),
      ),
      signal,
    );
    await transport.closed;
  } finally {
    await transport?.close();
    output.removeListener("error", stop);
    signal.removeEventListener("abort", closeInput);
    if (!options.signal) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}
