import { EventEmitter } from "node:events";
import { createSecureServer, createServer, type ServerHttp2Session } from "node:http2";
import { create, type Message, toBinary } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  type ConnectRouter,
  createClient,
  createContextKey,
  createContextValues,
} from "@connectrpc/connect";
import { connectNodeAdapter, createGrpcTransport } from "@connectrpc/connect-node";
import { type RpcQueueTelemetry, RpcTelemetry } from "@supertag/worker-sdk";
import {
  CloseSchema,
  type ConnectRequest,
  ConnectRequestSchema,
  type ConnectResponse,
  ConnectResponseSchema,
  WorkletService,
} from "./gen/supertag/worklet/v1/worklet_pb.js";
import {
  decodeControlFrame,
  decodeHostFrame,
  encodeControlFrame,
  encodeHostFrame,
  WORKLET_GRPC_MAX_BYTES,
  wireUint32,
} from "./grpc-codec.js";
import type {
  RemoteWorkletServer,
  WorkletClientMessage,
  WorkletConnectionOptions,
  WorkletServerMessage,
} from "./index.js";
import type { MessageSocket, TypedTransportMessage } from "./message-socket.js";

export interface WorkletGrpcServerOptions {
  readonly remote: RemoteWorkletServer;
  readonly telemetry?: RpcTelemetry;
  readonly host?: string;
  readonly port?: number;
  readonly tls?: { readonly key: string | Buffer; readonly cert: string | Buffer };
  readonly maxPendingFrames?: number;
  readonly maxPendingBytes?: number;
  /** API Server-owned services share this authenticated HTTP/2 listener. */
  readonly registerRoutes?: (router: ConnectRouter) => void;
}
function loopback(host: string) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
}
function limit(value: number | undefined, fallback: number) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 16))
    throw new Error("gRPC queue limit must be a safe integer of at least 16");
  return value ?? fallback;
}
/** Control has reserved capacity; bulk output never evicts or reorders another output frame. */
export class WorkletFrameQueue<T> implements AsyncIterable<T> {
  readonly #control: Array<{ value: T; bytes: number }> = [];
  readonly #output: Array<{ value: T; bytes: number }> = [];
  #bytes = 0;
  #done = false;
  #wake: (() => void) | undefined;
  constructor(
    readonly maxFrames = 256,
    readonly maxBytes = 8 * 1024 * 1024,
    private readonly telemetry?: RpcQueueTelemetry,
  ) {}
  push(value: T, bytes: number, control: boolean): void {
    if (this.#done) throw new Error("Worklet stream closed");
    const frameLimit = control ? this.maxFrames : Math.floor(this.maxFrames * 0.75);
    const byteLimit = control ? this.maxBytes : Math.floor(this.maxBytes * 0.75);
    if (
      this.#control.length + this.#output.length >= frameLimit ||
      this.#bytes + bytes > byteLimit
    ) {
      this.telemetry?.reject();
      throw new Error(
        "Worklet outbound queue exhausted; inspect and resume from the last sequence",
      );
    }
    (control ? this.#control : this.#output).push({ value, bytes });
    this.#bytes += bytes;
    this.telemetry?.update(this.#control.length + this.#output.length, this.#bytes);
    this.#wake?.();
  }
  end(discard = false) {
    this.#done = true;
    if (discard || this.#control.length + this.#output.length === 0) this.telemetry?.close();
    if (discard) {
      this.#control.length = 0;
      this.#output.length = 0;
      this.#bytes = 0;
    }
    this.#wake?.();
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    const queue = this;
    const iterator = (async function* () {
      try {
        while (true) {
          const item = queue.#control.shift() ?? queue.#output.shift();
          if (item) {
            queue.#bytes -= item.bytes;
            queue.telemetry?.update(queue.#control.length + queue.#output.length, queue.#bytes);
            if (queue.#done && queue.#control.length + queue.#output.length === 0)
              queue.telemetry?.close();
            yield item.value;
            continue;
          }
          if (queue.#done) return;
          await new Promise<void>((resolve) => {
            queue.#wake = resolve;
          });
          queue.#wake = undefined;
        }
      } finally {
        queue.end(true);
      }
    })();
    return {
      next: () => iterator.next(),
      // Wake a pending next() and clean up even if iteration never began.
      return: async () => {
        queue.end(true);
        return iterator.return();
      },
      throw: async (error) => {
        queue.end(true);
        return iterator.throw(error);
      },
    };
  }
}
class GrpcSocket<
    Outbound extends TypedTransportMessage,
    Inbound extends TypedTransportMessage,
    T extends Message,
  >
  extends EventEmitter
  implements MessageSocket<Outbound, Inbound>
{
  readyState = 1;
  readonly queue: WorkletFrameQueue<T>;
  constructor(
    readonly encode: (message: Outbound) => T,
    readonly size: (frame: T) => number,
    readonly closeFrame: (code: number, reason: string) => T,
    private readonly limits: {
      maxPendingFrames?: number;
      maxPendingBytes?: number;
      telemetry?: RpcTelemetry;
    },
  ) {
    super();
    this.queue = new WorkletFrameQueue(
      limit(limits.maxPendingFrames, 256),
      limit(limits.maxPendingBytes, 8 * 1024 * 1024),
      limits.telemetry?.openQueue(
        limit(limits.maxPendingFrames, 256),
        limit(limits.maxPendingBytes, 8 * 1024 * 1024),
      ),
    );
  }
  send(_data: string) {
    this.close(4004, "Typed Worklet dispatch required");
    throw new Error("Worklet gRPC does not accept JSON messages");
  }
  sendMessage(message: Outbound) {
    if (this.readyState !== 1) throw new Error("Worklet gRPC stream closed");
    try {
      const frame = this.encode(message);
      const size = this.size(frame);
      if (size > WORKLET_GRPC_MAX_BYTES) throw new Error("Worklet frame exceeds wire limit");
      const record = message as Record<string, unknown>;
      const control = record["type"] !== "durable_event" && record["type"] !== "durable_end";
      try {
        this.queue.push(frame, size, control);
      } catch (error) {
        this.close(1013, "Worklet outbound queue exhausted");
        throw error;
      }
    } catch (error) {
      this.close(4004, "Invalid Worklet frame");
      throw error;
    }
  }
  readonly #messageListeners = new Set<(message: Inbound) => void>();
  onMessage(listener: (message: Inbound) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }
  receiveMessage(message: Inbound) {
    if (this.readyState !== 1) return;
    if (this.#messageListeners.size === 0) {
      this.close(4004, "Typed Worklet dispatcher unavailable");
      throw new Error("Worklet gRPC typed dispatcher unavailable");
    }
    for (const listener of this.#messageListeners) listener(message);
  }
  close(code = 1000, reason = "Worklet stream closed") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.limits.telemetry?.recordClose(code);
    try {
      const frame = this.closeFrame(code, reason);
      this.queue.push(frame, this.size(frame), true);
    } catch {
      /* Queue exhaustion still terminates the stream. */
    }
    this.queue.end();
    this.emit("close", code, Buffer.from(reason));
  }
  disconnect(code = 1006, reason = "Worklet gRPC connection closed") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.limits.telemetry?.recordClose(code);
    this.queue.end(true);
    this.emit("close", code, Buffer.from(reason));
  }
}
export function validateGrpcWorkletOptions(options: WorkletConnectionOptions): URL {
  const url = new URL(options.url);
  if (
    (url.pathname !== "/" && url.pathname !== "") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !loopback(url.hostname))
  )
    throw new Error("Worklet gRPC requires HTTPS outside loopback");
  limit(options.maxPendingFrames, 256);
  limit(options.maxPendingBytes, 8 * 1024 * 1024);
  return url;
}
export function createGrpcWorkletSocket(
  options: WorkletConnectionOptions & { credential: string },
): MessageSocket {
  const url = validateGrpcWorkletOptions(options);
  const socket = new GrpcSocket<WorkletClientMessage, WorkletServerMessage, ConnectRequest>(
    encodeHostFrame,
    (f) => toBinary(ConnectRequestSchema, f).length,
    (code, reason) =>
      create(ConnectRequestSchema, {
        wireVersion: 1,
        frame: { case: "close", value: create(CloseSchema, { code: wireUint32(code), reason }) },
      }),
    options,
  );
  const abort = new AbortController();
  const client = createClient(
    WorkletService,
    createGrpcTransport({
      baseUrl: url.origin,
      idleConnectionTimeoutMs: 1_000,
      readMaxBytes: WORKLET_GRPC_MAX_BYTES,
      writeMaxBytes: WORKLET_GRPC_MAX_BYTES,
      ...(options.tlsCa === undefined ? {} : { nodeOptions: { ca: options.tlsCa } }),
    }),
  );
  queueMicrotask(() => {
    if (socket.readyState !== 1) return;
    try {
      socket.emit("open");
    } catch (error) {
      socket.emit("error", error instanceof Error ? error : new Error("Invalid Worklet hello"));
      socket.close(4004, "Invalid Worklet hello");
      abort.abort();
      return;
    }
    void (async () => {
      try {
        for await (const frame of client.connect(socket.queue, {
          headers: { authorization: `Bearer ${options.credential}` },
          signal: abort.signal,
        })) {
          if (frame.wireVersion !== 1)
            throw new ConnectError("Unsupported Worklet wire version", Code.FailedPrecondition);
          if (frame.frame.case === "close") {
            socket.disconnect(frame.frame.value.code, frame.frame.value.reason);
            break;
          }
          try {
            socket.receiveMessage(decodeControlFrame(frame) as WorkletServerMessage);
          } catch (error) {
            throw new ConnectError(
              error instanceof Error ? error.message : "Invalid Worklet frame",
              Code.FailedPrecondition,
            );
          }
        }
      } catch (error) {
        if (socket.readyState === 1) {
          socket.emit("error", error instanceof Error ? error : new Error("Worklet gRPC failed"));
          socket.disconnect(
            error instanceof ConnectError &&
              [
                Code.Unauthenticated,
                Code.PermissionDenied,
                Code.InvalidArgument,
                Code.Unimplemented,
                Code.FailedPrecondition,
              ].includes(error.code)
              ? 4003
              : 1006,
          );
        }
      } finally {
        socket.disconnect();
        abort.abort();
      }
    })();
  });
  // Closing ends the request stream. Bound shutdown if a peer stops reading entirely.
  socket.once("close", () => {
    const timer = setTimeout(() => abort.abort(), 250);
    timer.unref();
  });
  return socket;
}
export async function startWorkletGrpcServer(options: WorkletGrpcServerOptions) {
  limit(options.maxPendingFrames, 256);
  limit(options.maxPendingBytes, 8 * 1024 * 1024);
  const host = options.host ?? "127.0.0.1";
  if (!options.tls && !loopback(host))
    throw new Error("Worklet gRPC requires TLS outside loopback");
  const sockets = new Set<
    GrpcSocket<WorkletServerMessage, WorkletClientMessage, ConnectResponse>
  >();
  const telemetry = options.telemetry ?? new RpcTelemetry();
  const peerAddress = createContextKey<string | undefined>(undefined);
  const handler = connectNodeAdapter({
    contextValues: (request) =>
      createContextValues().set(peerAddress, request.socket.remoteAddress),
    interceptors: [
      (next) => (request) =>
        telemetry.observe(
          {
            service: request.service.typeName,
            method: request.method.name,
            streaming: request.stream,
          },
          request.signal,
          () => next(request),
          (error) => ConnectError.from(error).code,
        ),
    ],
    grpc: true,
    connect: false,
    grpcWeb: false,
    readMaxBytes: WORKLET_GRPC_MAX_BYTES,
    writeMaxBytes: WORKLET_GRPC_MAX_BYTES,
    routes(router) {
      options.registerRoutes?.(router);
      router.service(WorkletService, {
        async *connect(requests, context) {
          const authorization = context.requestHeader.get("authorization") ?? "";
          if (!authorization.startsWith("Bearer ") || !authorization.slice(7).trim())
            throw new ConnectError("Worker Host credential required", Code.Unauthenticated);
          const socket = new GrpcSocket<
            WorkletServerMessage,
            WorkletClientMessage,
            ConnectResponse
          >(
            encodeControlFrame,
            (f) => toBinary(ConnectResponseSchema, f).length,
            (code, reason) =>
              create(ConnectResponseSchema, {
                wireVersion: 1,
                frame: {
                  case: "close",
                  value: create(CloseSchema, { code: wireUint32(code), reason }),
                },
              }),
            { ...options, telemetry },
          );
          sockets.add(socket);
          try {
            options.remote.attachConnection(socket, context.values.get(peerAddress));
          } catch (error) {
            sockets.delete(socket);
            socket.disconnect();
            throw error;
          }
          const onAbort = () => socket.disconnect();
          context.signal.addEventListener("abort", onAbort, { once: true });
          let hello = false;
          const reading = (async () => {
            try {
              for await (const frame of requests) {
                if (socket.readyState !== 1) break;
                if (frame.wireVersion !== 1)
                  throw new ConnectError(
                    "Unsupported Worklet wire version",
                    Code.FailedPrecondition,
                  );
                if (frame.frame.case === "close") {
                  socket.disconnect(frame.frame.value.code, frame.frame.value.reason);
                  break;
                }
                if (
                  (!hello && frame.frame.case !== "hello") ||
                  (hello && frame.frame.case === "hello")
                )
                  throw new Error("Exactly one hello must precede Worklet frames");
                hello = true;
                socket.receiveMessage(
                  decodeHostFrame(frame, authorization.slice(7)) as WorkletClientMessage,
                );
              }
            } catch (error) {
              socket.close(
                4004,
                error instanceof ConnectError && error.code === Code.FailedPrecondition
                  ? "Unsupported Worklet wire version"
                  : "Invalid Worklet gRPC frame",
              );
            } finally {
              socket.disconnect();
            }
          })();
          try {
            yield* socket.queue;
          } finally {
            socket.disconnect();
            sockets.delete(socket);
            context.signal.removeEventListener("abort", onAbort);
            void reading;
          }
        },
      });
    },
  });
  const server = options.tls ? createSecureServer(options.tls, handler) : createServer(handler);
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (s) => {
    sessions.add(s);
    const close = telemetry.openChannel();
    s.once("close", () => {
      sessions.delete(s);
      close();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No Worklet gRPC address");
  return {
    telemetry,
    url: `${options.tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    async close() {
      for (const socket of sockets) socket.disconnect(1001, "Worklet gRPC frontend stopped");
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
