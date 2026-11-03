import { Code, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { expect, it } from "vitest";
import { sharedTokenAuthentication } from "../../../tests/support/worklet-authentication.js";
import { type RpcLifecycleEvent, RpcTelemetry } from "../sdk/src/rpc-telemetry.js";
import { WorkletService } from "./src/gen/supertag/worklet/v1/worklet_pb.js";
import { startWorkletGrpcServer, WorkletFrameQueue } from "./src/grpc.js";
import { RemoteWorkletServer } from "./src/index.js";

it("counts unary errors and streaming cancellation once without retaining sensitive data", async () => {
  const events: RpcLifecycleEvent[] = [];
  let now = 0;
  const telemetry = new RpcTelemetry({
    now: () => now,
    onEvent: (event) => {
      events.push(event);
      throw new Error("sink unavailable");
    },
  });
  const controller = new AbortController();
  const descriptor = { service: "supertag.Test", method: "Watch", streaming: true };
  const response = await telemetry.observe(
    descriptor,
    controller.signal,
    async () => ({
      stream: true as const,
      message: (async function* () {
        yield "secret payload";
      })(),
    }),
    () => 13,
  );
  expect(telemetry.snapshot().methods[0]).toMatchObject({ active: 1, activeStreams: 1 });
  now = 10;
  controller.abort(new Error("secret token"));
  for await (const _item of response.message) {
    /* consume after cancellation */
  }
  expect(telemetry.snapshot().methods[0]).toMatchObject({
    completed: 1,
    active: 0,
    activeStreams: 0,
    errors: 1,
    durationMs: { total: 10 },
  });
  expect(telemetry.snapshot().methods[0]?.statusCodes[1]).toBe(1);
  await expect(
    telemetry.observe(
      { ...descriptor, streaming: false },
      new AbortController().signal,
      async () => {
        throw new Error("private failure");
      },
      () => 13,
    ),
  ).rejects.toThrow("private failure");
  expect(telemetry.snapshot().methods[0]?.statusCodes[13]).toBe(1);
  expect(telemetry.snapshot().traceErrors).toBe(4);
  expect(JSON.stringify({ events, snapshot: telemetry.snapshot() })).not.toMatch(
    /secret|private|payload|token/,
  );
});

it("bounds labels, isolates snapshots and accounts queue pressure and channel cleanup", async () => {
  const telemetry = new RpcTelemetry({ maxMethods: 2 });
  for (let i = 0; i < 20; i++)
    await telemetry.observe(
      { service: "Test", method: `Method${i}`, streaming: false },
      new AbortController().signal,
      async () => ({ stream: false as const, message: {} }),
      () => 2,
    );
  expect(telemetry.snapshot().methods).toHaveLength(3);
  const close = telemetry.openChannel();
  const queue = new WorkletFrameQueue(16, 64, telemetry.openQueue(16, 64));
  for (let i = 0; i < 12; i++) queue.push(i, 4, false);
  expect(() => queue.push(12, 4, false)).toThrow("exhausted");
  expect(telemetry.snapshot().queues).toMatchObject({
    active: 1,
    frames: 12,
    bytes: 48,
    rejections: 1,
    peakBytes: 48,
  });
  queue.end(true);
  close();
  close();
  for (let i = 0; i < 100; i++) telemetry.recordClose(i);
  const snapshot = telemetry.snapshot();
  expect(snapshot.queues).toMatchObject({ active: 0, frames: 0, bytes: 0, capacityBytes: 0 });
  expect(snapshot.channels).toEqual({ active: 0, opened: 1, closed: 1 });
  expect(snapshot.closeCodes).toEqual({ other: 100 });
  (snapshot.methods[0]?.statusCodes as number[])[0] = 999;
  expect(telemetry.snapshot().methods[0]?.statusCodes[0]).not.toBe(999);
});

it("observes real Worklet authentication rejection through the server interceptor", async () => {
  const telemetry = new RpcTelemetry();
  const remote = new RemoteWorkletServer({
    authenticateWorklet: sharedTokenAuthentication("test-only"),
  });
  const server = await startWorkletGrpcServer({ remote, telemetry });
  const client = createClient(WorkletService, createGrpcTransport({ baseUrl: server.url }));
  try {
    await expect(
      (async () => {
        for await (const _frame of client.connect((async function* () {})())) {
        }
      })(),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    const row = telemetry.snapshot().methods.find((row) => row.method === "Connect");
    expect(row).toMatchObject({ completed: 1, active: 0, errors: 1 });
    expect(row?.statusCodes[Code.Unauthenticated]).toBe(1);
    expect(telemetry.snapshot().channels.opened).toBe(1);
  } finally {
    await server.close();
  }
});

it("retains graceful-close queue pressure through slow draining and releases abandoned iterators", async () => {
  const telemetry = new RpcTelemetry();
  const queue = new WorkletFrameQueue(16, 64, telemetry.openQueue(16, 64));
  queue.push("first", 4, false);
  queue.push("second", 8, false);
  queue.end();
  expect(telemetry.snapshot().queues).toMatchObject({ active: 1, frames: 2, bytes: 12 });
  const iterator = queue[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ done: false, value: "first" });
  expect(telemetry.snapshot().queues).toMatchObject({ active: 1, frames: 1, bytes: 8 });
  expect(await iterator.next()).toEqual({ done: false, value: "second" });
  expect(telemetry.snapshot().queues).toMatchObject({ active: 0, frames: 0, bytes: 0 });
  await iterator.return?.();

  for (const begin of [false, true]) {
    const abandoned = new WorkletFrameQueue(16, 64, telemetry.openQueue(16, 64));
    abandoned.push("first", 4, false);
    abandoned.push("retained", 8, false);
    const consumer = abandoned[Symbol.asyncIterator]();
    if (begin) await consumer.next();
    await consumer.return?.();
    expect(telemetry.snapshot().queues).toMatchObject({ active: 0, frames: 0, bytes: 0 });
    expect(() => abandoned.push("late", 4, false)).toThrow("closed");
  }
  const waiting = new WorkletFrameQueue(16, 64, telemetry.openQueue(16, 64));
  const consumer = waiting[Symbol.asyncIterator]();
  const pending = consumer.next();
  await consumer.return?.();
  expect(await pending).toMatchObject({ done: true });
  expect(telemetry.snapshot().queues).toMatchObject({ active: 0, frames: 0, bytes: 0 });
});
