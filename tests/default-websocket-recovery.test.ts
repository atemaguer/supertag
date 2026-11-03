import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import {
  type AddressInfo,
  connect,
  createServer as createProxyServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worklet,
} from "../packages/runtime/sdk/src/index.js";
import { RemoteWorkletServer, WorkletConnection } from "../packages/runtime/transport/src/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  while (cleanup.length) {
    try {
      await cleanup.pop()?.();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "WebSocket recovery fixture cleanup failed");
});
function gate() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.push(async () => {
    release();
  });
  return { waiting, release };
}
function event(
  spec: TaskAttemptSpec,
  type: "execution.completed" | "output.delta",
  text = "",
): TaskAttemptEvent {
  return {
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    at: new Date().toISOString(),
    type,
    ...(type === "output.delta" ? { text } : {}),
  };
}
function task(host: string, name: string): TaskAttemptSpec {
  const capturedAt = new Date().toISOString();
  return {
    version: 2,
    taskId: name,
    attemptId: `${name}-attempt`,
    tag: { id: "tag", name: "Tag" },
    input: {
      origin: {
        surface: "cli",
        accountId: "local",
        scope: "terminal",
        sessionKey: name,
        occurredAt: capturedAt,
      },
      messages: [{ id: "request", role: "requester", text: "test" }],
    },
    execution: {},
    workerProfile: { id: host, revision: "1" },
    workspacePlan: { version: 1, status: "none" },
    contextPlan: emptyTagContextPlan(capturedAt),
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "tag", name: "Tag" },
      origin: {
        tagRouteId: "route",
        surfaceAccountId: "local",
        provider: "cli",
        scope: "terminal",
      },
      requester: { id: "user", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-websocket-recovery-"));
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  const credentials = new Set<string>();
  const generations = new Map<string, number>();
  const remote = new RemoteWorkletServer({
    server: http,
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 1000,
    durableAcknowledgementTimeoutMs: 2000,
    authenticateWorklet: ({ credential, worklet }) => {
      const id = worklet.host.id;
      if (!credentials.has(id) || credential !== `credential-${id}`) return undefined;
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      return { connectionGeneration: generation };
    },
  });
  remote.start();
  const hosts: Array<{ close(): Promise<void> }> = [];
  cleanup.push(async () => {
    await Promise.all(hosts.map((host) => host.close()));
    await remote.stop();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    remote,
    credentials,
    generations,
    async host(id: string, stream: Worklet["execute"], protocolVersions?: number[]) {
      credentials.add(id);
      let partitioned = false;
      const sockets = new Set<Socket>();
      const proxy = createProxyServer((downstream) => {
        if (partitioned) {
          downstream.destroy();
          return;
        }
        const upstream = connect(port, "127.0.0.1");
        for (const socket of [upstream, downstream]) {
          sockets.add(socket);
          socket.on("error", () => {});
          socket.once("close", () => {
            sockets.delete(socket);
            upstream.destroy();
            downstream.destroy();
          });
        }
        downstream.pipe(upstream).pipe(downstream);
      });
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const worklet: Worklet & { execute: ReturnType<typeof vi.fn<Worklet["execute"]>> } = {
        id,
        describe: async () => ({
          id,
          protocolVersion: 1,
          host: {
            id,
            workers: [
              {
                profileCapabilities: [
                  {
                    profile: { id, revision: "1" },
                    capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
                    contextTypes: [],
                  },
                ],
                id: `${id}-worker`,
                type: "fixture",
                profiles: [{ id, revision: "1" }],
                capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
                contextTypes: [],
                maxConcurrency: 2,
              },
            ],
          },
        }),
        execute: vi.fn(stream),
      };
      const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(join(directory, id)));
      const clients: WorkletConnection[] = [];
      function client(versions = protocolVersions) {
        // Deliberately omit transport: these regression checks exercise the default WebSocket path.
        const result = new WorkletConnection({
          url: `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}/worklets`,
          credential: `credential-${id}`,
          worklet,
          durableWorklet: durable,
          reconnectIntervalMs: 20,
          ...(versions ? { protocolVersions: versions } : {}),
        });
        clients.push(result);
        return result;
      }
      const first = client();
      hosts.push({
        async close() {
          await Promise.all(clients.map((client) => client.stop()));
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => proxy.close(() => resolve()));
          await durable.close();
        },
      });
      await first.start();
      return {
        first,
        durable,
        worklet,
        client,
        partition() {
          partitioned = true;
          for (const socket of sockets) socket.destroy();
        },
        restore() {
          partitioned = false;
        },
      };
    },
  };
}

it("keeps protocol 18 operational through a host partition and credential revocation", async () => {
  const f = await fixture();
  const finish = gate();
  const a = await f.host("host-a", async function* (spec) {
    yield event(spec, "output.delta", "before");
    await finish.waiting;
    yield event(spec, "output.delta", "after");
    yield event(spec, "execution.completed");
  });
  const b = await f.host(
    "host-b",
    async function* (spec) {
      yield event(spec, "execution.completed");
    },
    [18],
  );
  expect(a.first.negotiatedProtocolVersion).toBe(18);
  expect(b.first.negotiatedProtocolVersion).toBe(18);
  const spec = task("host-a", "partitioned");
  await f.remote.accept(spec);
  const observation = f.remote.events(spec.attemptId)[Symbol.asyncIterator]();
  expect((await observation.next()).value?.sequence).toBe(1);
  const disconnected = observation.next();
  const disconnectedAssertion = expect(disconnected).rejects.toThrow(/disconnected|resume/);
  a.partition();
  await disconnectedAssertion;
  await vi.waitFor(() => expect(a.first.isConnected).toBe(false));
  expect(await a.durable.inspect(spec.attemptId)).toMatchObject({ status: "running" });
  const other = task("host-b", "independent");
  await f.remote.accept(other);
  const independent = [];
  for await (const item of f.remote.events(other.attemptId)) independent.push(item);
  expect(independent.at(-1)?.event.type).toBe("execution.completed");
  a.restore();
  await vi.waitFor(() => expect(a.first.connectionGeneration).toBe(2));
  await f.remote.accept(spec);
  finish.release();
  const recovered = [];
  for await (const item of f.remote.events(spec.attemptId, 1)) recovered.push(item);
  expect(recovered.map((item) => item.sequence)).toEqual([2, 3]);
  expect(a.worklet.execute).toHaveBeenCalledTimes(1);
  expect(() => b.client([999])).toThrow(/protocol/i);
  expect(b.first.isConnected).toBe(true);
  f.credentials.delete("host-a");
  expect(f.remote.disconnectHost("host-a")).toBe(true);
  await vi.waitFor(() => expect(a.first.isConnected).toBe(false));
  await expect(a.client().start()).rejects.toThrow("Authentication failed");
  expect(b.first.isConnected).toBe(true);
}, 15_000);

it("fences simultaneous reconnects without restarting accepted work", async () => {
  const f = await fixture();
  const finish = gate();
  const host = await f.host("same-host", async function* (spec) {
    yield event(spec, "output.delta", "started");
    await finish.waiting;
    yield event(spec, "execution.completed");
  });
  const spec = task("same-host", "same-attempt");
  await f.remote.accept(spec);
  const replacements = [host.client(), host.client()];
  await Promise.allSettled(replacements.map((client) => client.start()));
  await vi.waitFor(() => {
    expect(host.first.isConnected).toBe(false);
    expect(replacements.filter((client) => client.isConnected)).toHaveLength(1);
  });
  expect(replacements.find((client) => client.isConnected)?.connectionGeneration).toBe(3);
  await f.remote.accept(spec);
  finish.release();
  const observed = [];
  for await (const item of f.remote.events(spec.attemptId)) observed.push(item);
  expect(observed.map((item) => item.sequence)).toEqual([1, 2]);
  expect(host.worklet.execute).toHaveBeenCalledTimes(1);
}, 15_000);

it("keeps disconnected cancellation unconfirmed, then cancels only its Attempt after reconnect and cleanup", async () => {
  const f = await fixture();
  const cleaned = gate();
  const survivorFinished = gate();
  let cancellationSeen = false;
  const host = await f.host("cancel-host", async function* (spec, signal) {
    yield event(spec, "output.delta", "started");
    if (spec.taskId === "cancelled") {
      if (!signal?.aborted)
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      cancellationSeen = true;
      await cleaned.waiting;
      return;
    }
    await survivorFinished.waiting;
    expect(signal?.aborted).toBe(false);
    yield event(spec, "execution.completed");
  });
  const cancelled = task("cancel-host", "cancelled");
  const survivor = task("cancel-host", "survivor");
  await f.remote.accept(cancelled);
  await f.remote.accept(survivor);
  host.partition();
  await vi.waitFor(() => expect(host.first.isConnected).toBe(false));
  await expect(f.remote.cancel(cancelled.attemptId, "stop")).rejects.toThrow(
    /unavailable|disconnect|unconfirmed/,
  );
  expect(cancellationSeen).toBe(false);
  expect(await host.durable.inspect(cancelled.attemptId)).toMatchObject({ status: "running" });
  host.restore();
  await vi.waitFor(() => expect(host.first.connectionGeneration).toBe(2));
  const acknowledgement = await f.remote.cancel(cancelled.attemptId, "stop");
  expect(acknowledgement).toMatchObject({ status: "running", cancellationRequested: true });
  await vi.waitFor(() => expect(cancellationSeen).toBe(true));
  // An acknowledged cancellation cannot release capacity while cleanup is still outstanding.
  expect(await f.remote.inspect(cancelled.attemptId)).toMatchObject({ status: "running" });
  await expect(f.remote.accept(task("cancel-host", "premature-reuse"))).rejects.toThrow(
    /capacity|available/,
  );
  survivorFinished.release();
  const observed = [];
  for await (const item of f.remote.events(survivor.attemptId)) observed.push(item);
  expect(observed.at(-1)?.event.type).toBe("execution.completed");
  cleaned.release();
  await vi.waitFor(async () =>
    expect(await f.remote.inspect(cancelled.attemptId)).toMatchObject({ status: "cancelled" }),
  );
  expect(host.worklet.execute).toHaveBeenCalledTimes(2);
}, 15_000);

it("bounds a paused WebSocket observer and resumes every durable event after overflow", async () => {
  const f = await fixture();
  const release = gate();
  const host = await f.host("output-host", async function* (spec) {
    yield event(spec, "output.delta", "start");
    await release.waiting;
    for (let n = 0; n < 180; n++) {
      yield event(spec, "output.delta", "x".repeat(32768));
      await delay(1);
    }
    yield event(spec, "execution.completed");
  });
  const spec = task("output-host", "bounded-output");
  await f.remote.accept(spec);
  const observation = f.remote.events(spec.attemptId)[Symbol.asyncIterator]();
  expect((await observation.next()).value?.sequence).toBe(1);
  release.release();
  await vi.waitFor(() => expect(host.first.connectionGeneration).toBe(2), { timeout: 5000 });
  const buffered = [];
  let error: unknown;
  try {
    for await (const item of { [Symbol.asyncIterator]: () => observation }) buffered.push(item);
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toContain("buffer exhausted");
  expect(buffered.length).toBeLessThanOrEqual(256);
  expect(
    buffered.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.event)), 0),
  ).toBeLessThanOrEqual(4 * 1024 * 1024);
  const cursor = buffered.at(-1)?.sequence ?? 1;
  const resumed = [];
  for await (const item of f.remote.events(spec.attemptId, cursor)) resumed.push(item);
  expect([...buffered, ...resumed].map((item) => item.sequence)).toEqual(
    Array.from({ length: 181 }, (_, index) => index + 2),
  );
  expect(resumed.at(-1)?.event.type).toBe("execution.completed");
  expect(host.worklet.execute).toHaveBeenCalledTimes(1);
}, 15_000);

it("reports the selected authenticated host rather than the aggregate or receipt-supplied host", async () => {
  const f = await fixture();
  const finish = gate();
  await f.host("host-unused", async function* (spec) {
    yield event(spec, "execution.completed");
  });
  const selected = await f.host("host-selected", async function* (spec) {
    await finish.waiting;
    yield event(spec, "execution.completed");
  });
  const localAccept = selected.durable.accept.bind(selected.durable);
  vi.spyOn(selected.durable, "accept").mockImplementation(async (spec) => ({
    ...(await localAccept(spec)),
    workerHostId: "untrusted-host",
    workletId: "untrusted-worklet",
  }));
  const spec = task("host-selected", "selected-provenance");
  expect((await f.remote.describe()).host.id).not.toBe("host-selected");
  expect(await f.remote.accept(spec)).toMatchObject({
    workerHostId: "host-selected",
    workletId: "host-selected",
    workerId: "host-selected-worker",
  });
  expect(await selected.durable.inspect(spec.attemptId)).toMatchObject({
    workerHostId: "host-selected",
    workletId: "host-selected",
    workerId: "host-selected-worker",
  });
  selected.partition();
  await vi.waitFor(() => expect(selected.first.isConnected).toBe(false));
  selected.restore();
  await vi.waitFor(() => expect(selected.first.isConnected).toBe(true));
  expect(await f.remote.inspect(spec.attemptId)).toMatchObject({
    workerHostId: "host-selected",
    workletId: "host-selected",
    workerId: "host-selected-worker",
  });
  finish.release();
});
