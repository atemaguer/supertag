import { createSecureServer, createServer, type Http2Session } from "node:http2";
import { setTimeout as delay } from "node:timers/promises";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { RpcTelemetry } from "@supertag/worker-sdk";
import {
  ExecutionEnvironmentService,
  OperationStatus,
} from "./gen/supertag/environment/v1/environment_pb.js";
import {
  operationFromProto,
  receiptToProto,
  safeNumber,
  snapshotToProto,
  WIRE_LIMIT,
} from "./grpc-codec.js";
import type { SharedExecutionRequest, SharedExecutionResponse } from "./server.js";

export interface SharedExecutionGrpcServerOptions {
  readonly telemetry?: RpcTelemetry;
  readonly service: { dispatch(request: SharedExecutionRequest): Promise<SharedExecutionResponse> };
  readonly host?: string;
  readonly port?: number;
  readonly tls?: { readonly key: string | Buffer; readonly cert: string | Buffer };
}
/** A second frontend for the same service owner and journal; never a second executor. */
export async function startSharedExecutionGrpcServer(options: SharedExecutionGrpcServerOptions) {
  const host = options.host ?? "127.0.0.1";
  if (!options.tls && !["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error("Non-loopback gRPC listeners require TLS");
  async function dispatch(
    method: string,
    url: string,
    authorization: string | null,
    body?: Record<string, unknown>,
  ) {
    const response = await options.service.dispatch({
      method,
      url,
      headers: authorization ? { authorization } : {},
      ...(body === undefined ? {} : { body }),
    });
    if (response.status >= 400) {
      const code =
        (
          {
            400: Code.InvalidArgument,
            401: Code.Unauthenticated,
            403: Code.PermissionDenied,
            404: Code.NotFound,
            409: Code.FailedPrecondition,
            413: Code.ResourceExhausted,
            429: Code.ResourceExhausted,
          } as Record<number, Code>
        )[response.status] ?? Code.Internal;
      throw new ConnectError(String(response.body["error"] ?? "Execution request failed"), code);
    }
    return response.body;
  }
  const telemetry = options.telemetry ?? new RpcTelemetry();
  const handler = connectNodeAdapter({
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
    readMaxBytes: WIRE_LIMIT,
    writeMaxBytes: WIRE_LIMIT,
    routes: (router) =>
      router.service(ExecutionEnvironmentService, {
        async issueAccess(request, context) {
          if (request.protocolVersion !== 1)
            throw new ConnectError(
              "Unsupported execution protocol version",
              Code.FailedPrecondition,
            );
          const body = await dispatch(
            "PUT",
            `/v1/accesses/${encodeURIComponent(request.accessId)}`,
            context.requestHeader.get("authorization"),
            {
              taskId: request.taskId,
              attemptId: request.attemptId,
              tagId: request.tagId,
              ttlMs: safeNumber(request.ttlMs),
              accessToken: context.requestHeader.get("x-supertag-grant-token") ?? "",
            },
          );
          return {
            protocolVersion: 1,
            accessId: String(body["accessId"]),
            environmentId: String(body["environmentId"]),
            incarnationId: String(body["incarnationId"]),
            expiresAt: String(body["expiresAt"]),
            rootDirectory: String(body["rootDirectory"]),
          };
        },
        async releaseAccess(request, context) {
          await dispatch(
            "POST",
            `/v1/accesses/${encodeURIComponent(request.accessId)}`,
            context.requestHeader.get("authorization"),
          );
          return { accessId: request.accessId };
        },
        async revokeAccess(request, context) {
          await dispatch(
            "DELETE",
            `/v1/accesses/${encodeURIComponent(request.accessId)}`,
            context.requestHeader.get("authorization"),
          );
          return { accessId: request.accessId };
        },
        async execute(request, context) {
          // A caller's deadline ends its wait, not an already accepted operation.
          return receiptToProto(
            await dispatch(
              "POST",
              `/v1/operations/${encodeURIComponent(request.operationId)}`,
              context.requestHeader.get("authorization"),
              operationFromProto(request),
            ),
          );
        },
        async inspectOperation(request, context) {
          return receiptToProto(
            await dispatch(
              "GET",
              `/v1/operations/${encodeURIComponent(request.operationId)}`,
              context.requestHeader.get("authorization"),
            ),
          );
        },
        async *watchProcess(request, context) {
          let cursor = safeNumber(request.afterSequence);
          let previous: string | undefined;
          while (!context.signal.aborted) {
            const snapshot = snapshotToProto(
              await dispatch(
                "GET",
                `/v1/processes/${encodeURIComponent(request.processId)}?cursor=${cursor}`,
                context.requestHeader.get("authorization"),
              ),
            );
            const state = `${snapshot.status}:${snapshot.nextCursor}`;
            if (state !== previous) {
              yield snapshot;
              previous = state;
            }
            cursor = safeNumber(snapshot.nextCursor);
            if (![OperationStatus.ACCEPTED, OperationStatus.RUNNING].includes(snapshot.status))
              return;
            await delay(25, undefined, { signal: context.signal });
          }
        },
      }),
  });
  const server = options.tls ? createSecureServer(options.tls, handler) : createServer(handler);
  const sessions = new Set<Http2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    const close = telemetry.openChannel();
    session.once("close", () => {
      sessions.delete(session);
      close();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gRPC listener has no address");
  return {
    telemetry,
    url: `${options.tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    // Closing a transport leaves the underlying service and accepted processes alive.
    async close() {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
