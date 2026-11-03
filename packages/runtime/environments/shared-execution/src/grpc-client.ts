import { setTimeout as delay } from "node:timers/promises";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ExecutionEnvironmentService } from "./gen/supertag/environment/v1/environment_pb.js";
import {
  integer,
  operationToProto,
  receiptFromProto,
  record,
  snapshotFromProto,
  text,
  WIRE_LIMIT,
} from "./grpc-codec.js";

export class SharedExecutionGrpcClient {
  readonly #client;
  constructor(
    baseUrl: string,
    readonly timeoutMs: number,
    ca?: string,
  ) {
    const url = new URL(baseUrl);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("gRPC request timeout must be a positive safe integer");
    if (url.username || url.password || url.search || url.hash)
      throw new Error("gRPC endpoint must not contain credentials, a query, or a fragment");
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error("gRPC requires TLS outside loopback");
    this.#client = createClient(
      ExecutionEnvironmentService,
      createGrpcTransport({
        baseUrl,
        idleConnectionTimeoutMs: 1000,
        readMaxBytes: WIRE_LIMIT,
        writeMaxBytes: WIRE_LIMIT,
        ...(ca ? { nodeOptions: { ca } } : {}),
      }),
    );
  }
  async request(
    path: string,
    options: { method?: string; token: string; body?: unknown },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers = new Headers({ authorization: `Bearer ${options.token}` });
    const call = { headers, timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) };
    const url = new URL(path, "http://execution.invalid");
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    const body = options.body === undefined ? {} : record(options.body);
    if (url.pathname.startsWith("/v1/accesses/")) {
      if (options.method === "PUT") {
        headers.set("x-supertag-grant-token", text(body["accessToken"]));
        const response = await this.#client.issueAccess(
          {
            protocolVersion: 1,
            accessId: id,
            taskId: text(body["taskId"]),
            attemptId: text(body["attemptId"]),
            tagId: text(body["tagId"]),
            ttlMs: integer(body["ttlMs"]),
          },
          call,
        );
        if (response.protocolVersion !== 1)
          throw new ConnectError("Unsupported execution protocol version", Code.FailedPrecondition);
        if (response.accessId !== id)
          throw new ConnectError("Access response identity mismatch", Code.DataLoss);
        return {
          accessId: response.accessId,
          environmentId: response.environmentId,
          incarnationId: response.incarnationId,
          expiresAt: response.expiresAt,
          rootDirectory: response.rootDirectory,
        };
      }
      if (options.method === "POST")
        return await this.#client.releaseAccess({ accessId: id }, call);
      if (options.method === "DELETE")
        return await this.#client.revokeAccess({ accessId: id }, call);
    }
    if (url.pathname.startsWith("/v1/operations/")) {
      const receipt = receiptFromProto(
        options.method === "POST"
          ? await this.#client.execute(operationToProto(id, body), call)
          : await this.#client.inspectOperation({ operationId: id }, call),
      );
      if (receipt["operationId"] !== id)
        throw new ConnectError("Operation response identity mismatch", Code.DataLoss);
      return receipt;
    }
    if (url.pathname.startsWith("/v1/processes/")) {
      for await (const snapshot of this.watch(
        id,
        Number(url.searchParams.get("cursor") ?? "0"),
        options.token,
        signal,
      ))
        return snapshot;
    }
    throw new ConnectError("Unsupported execution request", Code.InvalidArgument);
  }
  async *watch(
    processId: string,
    afterSequence: number,
    token: string,
    signal?: AbortSignal,
  ): AsyncIterable<Record<string, unknown>> {
    integer(afterSequence);
    let cursor = afterSequence;
    let failures = 0;
    while (true) {
      const startedAt = Date.now();
      let receivedSnapshot = false;
      try {
        for await (const value of this.#client.watchProcess(
          { processId, afterSequence: BigInt(cursor) },
          {
            headers: { authorization: `Bearer ${token}` },
            timeoutMs: this.timeoutMs,
            ...(signal ? { signal } : {}),
          },
        )) {
          const snapshot = snapshotFromProto(value);
          if (value.processId !== processId)
            throw new ConnectError("Process response identity mismatch", Code.DataLoss);
          receivedSnapshot = true;
          for (const chunk of snapshot["chunks"] as { sequence: number }[]) {
            if (chunk.sequence !== cursor + 1)
              throw new ConnectError("Process output sequence gap", Code.DataLoss);
            cursor = chunk.sequence;
          }
          if (snapshot["nextCursor"] !== cursor)
            throw new ConnectError("Process output cursor mismatch", Code.DataLoss);
          if ((snapshot["chunks"] as unknown[]).length > 0) failures = 0;
          yield snapshot;
          if (!["accepted", "running"].includes(String(snapshot["status"]))) return;
        }
        throw new ConnectError("Process stream ended before completion", Code.Unavailable);
      } catch (error) {
        // A healthy quiet stream may reach its deadline; short failed connections are bounded.
        if (
          error instanceof ConnectError &&
          error.code === Code.DeadlineExceeded &&
          receivedSnapshot &&
          Date.now() - startedAt >= this.timeoutMs * 0.9
        )
          failures = 0;
        if (
          signal?.aborted ||
          !(error instanceof ConnectError) ||
          !(
            [Code.Unavailable, Code.DeadlineExceeded, Code.Canceled].includes(error.code) ||
            // Connect reports an HTTP/2 disconnect before gRPC trailers this way.
            // Only the read-only watch is resumed; operation writes are never retried here.
            (error.code === Code.Internal && error.rawMessage === "protocol error: missing status")
          ) ||
          ++failures > 3
        )
          throw error;
        await delay(100 * failures, undefined, signal ? { signal } : undefined);
      }
    }
  }
}
