import { createServer, type Http2Session } from "node:http2";
import { setTimeout as delay } from "node:timers/promises";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecutionEnvironmentService,
  OperationStatus,
  type ProcessSnapshotSchema,
} from "./src/gen/supertag/environment/v1/environment_pb.js";
import { SharedExecutionGrpcClient } from "./src/grpc-client.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture(
  watch: (context: HandlerContext) => AsyncIterable<MessageInitShape<typeof ProcessSnapshotSchema>>,
  timeoutMs = 1000,
) {
  const server = createServer(
    connectNodeAdapter({
      grpc: true,
      connect: false,
      grpcWeb: false,
      routes(router) {
        router.service(ExecutionEnvironmentService, {
          watchProcess(_request, context) {
            return watch(context);
          },
        });
      },
    }),
  );
  const sessions = new Set<Http2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return new SharedExecutionGrpcClient(`http://127.0.0.1:${address.port}`, timeoutMs);
}

async function collect(client: SharedExecutionGrpcClient) {
  const snapshots = [];
  for await (const snapshot of client.watch("process", 0, "access-token")) snapshots.push(snapshot);
  return snapshots;
}

describe("execution gRPC stream recovery", () => {
  it.each([Code.Unavailable, Code.Canceled])(
    "bounds failures with code %s even when each reconnect returns an empty initial snapshot",
    async (code) => {
      let calls = 0;
      const client = await fixture(async function* () {
        calls++;
        yield { processId: "process", status: OperationStatus.RUNNING };
        throw new ConnectError("Disconnected", code);
      });
      await expect(collect(client)).rejects.toMatchObject({ code });
      expect(calls).toBe(4);
    },
  );

  it("bounds deadlines when the server never responds", async () => {
    let calls = 0;
    const client = await fixture(async function* (context) {
      calls++;
      await delay(1000, undefined, { signal: context.signal });
      yield { processId: "process", status: OperationStatus.COMPLETED };
    }, 100);
    await expect(collect(client)).rejects.toMatchObject({ code: Code.DeadlineExceeded });
    expect(calls).toBe(4);
  });

  it("renews healthy quiet streams across deadlines until the process finishes", async () => {
    let calls = 0;
    const client = await fixture(async function* (context) {
      calls++;
      if (calls === 5) {
        yield { processId: "process", status: OperationStatus.COMPLETED };
        return;
      }
      yield { processId: "process", status: OperationStatus.RUNNING };
      await delay(1000, undefined, { signal: context.signal });
    }, 100);
    await expect(collect(client)).resolves.toHaveLength(5);
    expect(calls).toBe(5);
  });

  it.each([
    { processId: "another-process", status: OperationStatus.COMPLETED },
    {
      processId: "process",
      status: OperationStatus.RUNNING,
      nextCursor: 2n,
      chunks: [{ sequence: 2n, stream: 1, text: "gap" }],
    },
    { processId: "process", status: OperationStatus.RUNNING, nextCursor: 1n },
  ])("does not retry corrupted stream responses: %#", async (snapshot) => {
    let calls = 0;
    const client = await fixture(async function* () {
      calls++;
      yield snapshot;
    });
    await expect(collect(client)).rejects.toMatchObject({ code: Code.DataLoss });
    expect(calls).toBe(1);
  });

  it("does not reconnect after the caller cancels its watch", async () => {
    let calls = 0;
    const client = await fixture(async function* (context) {
      calls++;
      yield { processId: "process", status: OperationStatus.RUNNING };
      await delay(1000, undefined, { signal: context.signal });
    });
    const controller = new AbortController();
    const iterator = client
      .watch("process", 0, "access-token", controller.signal)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: Code.Canceled });
    expect(calls).toBe(1);
  });

  it("requires TLS outside loopback and rejects credentials in endpoint URLs", () => {
    expect(() => new SharedExecutionGrpcClient("http://worker-host:9000", 100)).toThrow("TLS");
    expect(() => new SharedExecutionGrpcClient("https://secret@worker-host:9000", 100)).toThrow(
      "credentials",
    );
    expect(() => new SharedExecutionGrpcClient("http://127.0.0.1:9000", 0)).toThrow("timeout");
  });
});
