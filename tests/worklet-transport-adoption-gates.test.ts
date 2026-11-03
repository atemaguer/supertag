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
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worklet,
} from "../packages/runtime/sdk/src/index.js";
import {
  RemoteWorkletServer,
  startWorkletGrpcServer,
  WorkletConnection,
} from "../packages/runtime/transport/src/index.js";

interface Gate {
  readonly waiting: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let release!: () => void;
  return {
    waiting: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release,
  };
}

function spec(profile: string, name: string): TaskAttemptSpec {
  const capturedAt = new Date().toISOString();
  return {
    version: 2,
    taskId: name,
    attemptId: `${name}-attempt`,
    tag: { id: "adoption-gate", name: "Adoption gate" },
    workerProfile: { id: profile, revision: "1" },
    execution: { profile: { id: profile, revision: "1" } },
    contextPlan: emptyTagContextPlan(capturedAt),
    workspacePlan: { version: 1, status: "none" },
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "adoption-gate", name: "Adoption gate" },
      origin: {
        tagRouteId: "adoption-gate",
        surfaceAccountId: "local",
        provider: "cli",
        scope: "terminal",
      },
      requester: { id: "operator", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    input: {
      origin: {
        surface: "cli",
        accountId: "local",
        scope: "terminal",
        sessionKey: name,
        occurredAt: capturedAt,
      },
      messages: [{ id: "request", role: "requester", text: "Complete after reconnect" }],
    },
  };
}

function worklet(id: string, pause: Gate, executions: Map<string, number>): Worklet {
  return {
    id: `${id}-worklet`,
    async describe() {
      return {
        id: this.id,
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
              type: "adoption-gate",
              profiles: [{ id, revision: "1" }],
              capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
              contextTypes: [],
            },
          ],
        },
      };
    },
    async *execute(attempt) {
      executions.set(attempt.attemptId, (executions.get(attempt.attemptId) ?? 0) + 1);
      const at = new Date().toISOString();
      yield {
        type: "execution.started",
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        at,
        workerId: `${id}-worker`,
      } satisfies TaskAttemptEvent;
      await pause.waiting;
      yield {
        type: "execution.completed",
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        at: new Date().toISOString(),
      } satisfies TaskAttemptEvent;
    },
  };
}

async function waitUntil(probe: () => boolean, timeoutMs: number, description: string) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function partitionProxy(targetPort: number) {
  let partitioned = false;
  const sockets = new Set<Socket>();
  const server = createProxyServer((downstream) => {
    if (partitioned) {
      downstream.destroy();
      return;
    }
    const upstream = connect(targetPort, "127.0.0.1");
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
    }
    downstream.pipe(upstream).pipe(downstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    partition() {
      partitioned = true;
      for (const socket of sockets) socket.destroy();
    },
    restore() {
      partitioned = false;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("recovers sixteen independently authenticated gRPC hosts without repeating accepted work", async () => {
  const hostCount = 16;
  const deadlineMs = 5000;
  const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-storm-"));
  const generations = new Map<string, number>();
  const remote = new RemoteWorkletServer({
    server: createServer(),
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 1000,
    durableAcknowledgementTimeoutMs: deadlineMs,
    authenticateWorklet: ({ credential, worklet: descriptor }) => {
      const id = descriptor.host.id;
      if (credential !== `credential-${id}`) return undefined;
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      return { connectionGeneration: generation };
    },
  });
  remote.start();
  const frontend = await startWorkletGrpcServer({ remote });
  const transportProxy = await partitionProxy(Number(new URL(frontend.url).port));
  const pauses: Gate[] = [];
  const executions = new Map<string, number>();
  const durables: DurableLocalWorklet[] = [];
  const clients: WorkletConnection[] = [];
  const specs: TaskAttemptSpec[] = [];
  try {
    for (let index = 0; index < hostCount; index++) {
      const id = `storm-host-${index}`;
      const pause = gate();
      const owner = worklet(id, pause, executions);
      const durable = new DurableLocalWorklet(owner, new FileAttemptJournal(join(directory, id)));
      const client = new WorkletConnection({
        url: `http://127.0.0.1:${transportProxy.port}`,
        credential: `credential-${id}`,
        worklet: owner,
        durableWorklet: durable,
        protocolVersions: [18],
        reconnectIntervalMs: 20,
      });
      pauses.push(pause);
      durables.push(durable);
      clients.push(client);
      specs.push(spec(id, `storm-task-${index}`));
    }
    await Promise.all(clients.map((client) => client.start()));
    await Promise.all(specs.map((attempt) => remote.accept(attempt)));
    await Promise.all(
      specs.map(async (attempt) => {
        const observation = remote.events(attempt.attemptId)[Symbol.asyncIterator]();
        expect((await observation.next()).value?.event.type).toBe("execution.started");
        await observation.return?.();
      }),
    );
    const before = clients.map((client) => client.connectionGeneration ?? 0);
    transportProxy.partition();
    await waitUntil(
      () => clients.every((client) => !client.isConnected),
      deadlineMs,
      "all storm clients to disconnect",
    );
    const reconnectStarted = performance.now();
    transportProxy.restore();
    await waitUntil(
      () =>
        clients.every((client, index) => (client.connectionGeneration ?? 0) > (before[index] ?? 0)),
      deadlineMs,
      "all storm clients to reconnect",
    );
    const reconnectMs = performance.now() - reconnectStarted;
    expect(reconnectMs).toBeLessThanOrEqual(deadlineMs);
    await Promise.all(specs.map((attempt) => remote.accept(attempt)));
    for (const pause of pauses) pause.release();
    await Promise.all(
      specs.map(async (attempt) => {
        const observed = [];
        for await (const item of remote.events(attempt.attemptId, 1)) observed.push(item);
        expect(observed.at(-1)?.event.type).toBe("execution.completed");
      }),
    );
    expect([...executions.values()]).toEqual(Array.from({ length: hostCount }, () => 1));
  } finally {
    for (const pause of pauses) pause.release();
    await Promise.all(clients.map((client) => client.stop()));
    await transportProxy.close();
    await frontend.close();
    await remote.stop();
    await Promise.all(durables.map((durable) => durable.close()));
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it("rolls an accepted Attempt from gRPC to explicit WebSocket without re-executing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-transport-rollback-"));
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const pause = gate();
  const executions = new Map<string, number>();
  const owner = worklet("rollback", pause, executions);
  const durable = new DurableLocalWorklet(
    owner,
    new FileAttemptJournal(join(directory, "journal")),
  );
  let generation = 0;
  const remote = new RemoteWorkletServer({
    server: http,
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 1000,
    authenticateWorklet: ({ credential }) =>
      credential === "rollback-credential" ? { connectionGeneration: ++generation } : undefined,
  });
  remote.start();
  const frontend = await startWorkletGrpcServer({ remote });
  const grpc = new WorkletConnection({
    url: frontend.url,
    credential: "rollback-credential",
    worklet: owner,
    durableWorklet: durable,
    protocolVersions: [18],
    reconnectIntervalMs: 20,
  });
  let websocket: WorkletConnection | undefined;
  const attempt = spec("rollback", "rollback-task");
  try {
    await grpc.start();
    await remote.accept(attempt);
    const first = remote.events(attempt.attemptId)[Symbol.asyncIterator]();
    expect((await first.next()).value?.event.type).toBe("execution.started");
    await first.return?.();
    await grpc.stop();

    websocket = new WorkletConnection({
      url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/worklets`,
      transport: "websocket",
      credential: "rollback-credential",
      worklet: owner,
      durableWorklet: durable,
      protocolVersions: [18],
      reconnectIntervalMs: 20,
    });
    await websocket.start();
    expect(websocket.connectionGeneration).toBeGreaterThan(1);
    expect(await remote.inspect(attempt.attemptId)).toMatchObject({
      attemptId: attempt.attemptId,
      status: "running",
    });
    await remote.accept(attempt);
    pause.release();
    const resumed = [];
    for await (const item of remote.events(attempt.attemptId, 1)) resumed.push(item);
    expect(resumed.at(-1)?.event.type).toBe("execution.completed");
    expect(executions.get(attempt.attemptId)).toBe(1);
  } finally {
    pause.release();
    await Promise.all([grpc.stop(), websocket?.stop()]);
    await frontend.close();
    await remote.stop();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
