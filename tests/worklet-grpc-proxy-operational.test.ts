import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import {
  type AddressInfo,
  connect,
  createServer as createProxyServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
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

const execute = promisify(execFile);

function task(): TaskAttemptSpec {
  const capturedAt = new Date().toISOString();
  return {
    version: 2,
    taskId: "tls-proxy-task",
    attemptId: "tls-proxy-attempt",
    tag: { id: "proxy-tag", name: "Proxy test" },
    workerProfile: { id: "proxy", revision: "1" },
    execution: {},
    contextPlan: emptyTagContextPlan(capturedAt),
    workspacePlan: { version: 1, status: "none" },
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "proxy-tag", name: "Proxy test" },
      origin: {
        tagRouteId: "proxy-route",
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
        sessionKey: "proxy-test",
        occurredAt: capturedAt,
      },
      messages: [{ id: "request", role: "requester", text: "Verify proxy recovery" }],
    },
  };
}

it("keeps a TLS gRPC Worklet stream alive through idle time and reconnects through a TCP proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-proxy-"));
  const keyPath = join(directory, "server.key");
  const certPath = join(directory, "server.crt");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
  let executions = 0;
  const worklet: Worklet = {
    id: "proxy-worklet",
    async describe() {
      return {
        id: this.id,
        protocolVersion: 1,
        host: {
          id: "proxy-host",
          workers: [
            {
              profileCapabilities: [
                {
                  profile: { id: "proxy", revision: "1" },
                  capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
                  contextTypes: [],
                },
              ],
              id: "proxy-worker",
              type: "proxy-test",
              profiles: [{ id: "proxy", revision: "1" }],
              capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
              contextTypes: [],
            },
          ],
        },
      };
    },
    async *execute(spec) {
      executions++;
      const at = new Date().toISOString();
      yield {
        type: "execution.started",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at,
        workerId: "proxy-worker",
      } satisfies TaskAttemptEvent;
      yield {
        type: "execution.completed",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at,
      } satisfies TaskAttemptEvent;
    },
  };
  const durable = new DurableLocalWorklet(
    worklet,
    new FileAttemptJournal(join(directory, "journal")),
  );
  let generation = 0;
  const remote = new RemoteWorkletServer({
    server: createServer(),
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 1000,
    authenticateWorklet: ({ credential }) =>
      credential === "proxy-credential" ? { connectionGeneration: ++generation } : undefined,
  });
  remote.start();
  const frontend = await startWorkletGrpcServer({ remote, tls: { key, cert } });
  const upstreamPort = Number(new URL(frontend.url).port);
  let partitioned = false;
  let idleClosures = 0;
  const sockets = new Set<Socket>();
  const proxy = createProxyServer((downstream) => {
    if (partitioned) {
      downstream.destroy();
      return;
    }
    const upstream = connect(upstreamPort, "127.0.0.1");
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      socket.setTimeout(400, () => {
        if (!partitioned) idleClosures++;
        downstream.destroy();
        upstream.destroy();
      });
    }
    downstream.pipe(upstream).pipe(downstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const connection = new WorkletConnection({
    url: `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    tlsCa: cert,
    credential: "proxy-credential",
    worklet,
    durableWorklet: durable,
    protocolVersions: [18],
    reconnectIntervalMs: 20,
  });
  try {
    await connection.start();
    expect(connection.connectionGeneration).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(connection.isConnected).toBe(true);
    expect(idleClosures).toBe(0);

    partitioned = true;
    for (const socket of sockets) socket.destroy();
    await vi.waitFor(() => expect(connection.isConnected).toBe(false), { timeout: 5000 });
    partitioned = false;
    await vi.waitFor(() => expect(connection.connectionGeneration).toBeGreaterThan(1), {
      timeout: 5000,
    });

    const spec = task();
    await remote.accept(spec);
    const events = [];
    for await (const item of remote.events(spec.attemptId)) events.push(item);
    expect(events.at(-1)?.event.type).toBe("execution.completed");
    expect(executions).toBe(1);
  } finally {
    await connection.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await frontend.close();
    await remote.stop();
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
