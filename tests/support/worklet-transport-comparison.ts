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
import { emptyTagContextPlan } from "../../packages/core/src/index.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worklet,
} from "../../packages/runtime/sdk/src/index.js";
import {
  RemoteWorkletServer,
  startWorkletGrpcServer,
  WorkletConnection,
} from "../../packages/runtime/transport/src/index.js";

export type ComparedTransport = "websocket" | "grpc";

export interface TransportComparisonOptions {
  readonly iterations?: number;
  readonly warmup?: number;
  readonly reconnects?: number;
  readonly deadlineMs?: number;
}

export interface Distribution {
  readonly samples: number;
  readonly minimumMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
}

export interface TransportMeasurement {
  readonly transport: ComparedTransport;
  readonly protocolVersion: number;
  readonly completed: number;
  readonly duplicateExecutions: number;
  readonly connectionMs: number;
  readonly completion: Distribution;
  readonly reconnect: Distribution;
  readonly rss: {
    readonly startBytes: number;
    readonly peakBytes: number;
    readonly endBytes: number;
    readonly peakDeltaBytes: number;
  };
}

export interface TransportComparisonReport {
  readonly version: 1;
  readonly measuredAt: string;
  readonly runtime: {
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly workload: {
    readonly iterations: number;
    readonly warmup: number;
    readonly reconnects: number;
    readonly deadlineMs: number;
  };
  readonly measurements: readonly TransportMeasurement[];
  readonly adoptionBudget: {
    readonly requiredCompletionRate: 1;
    readonly maximumDuplicateExecutions: 0;
    readonly maximumReconnectMs: number;
    readonly maximumGrpcP95Ratio: 3;
    readonly grpcP95AllowanceMs: 5;
    readonly maximumGrpcRssOverheadBytes: number;
  };
  readonly adoptionGate: {
    readonly passed: boolean;
    readonly checks: readonly {
      readonly name: string;
      readonly category: "correctness" | "comparative";
      readonly passed: boolean;
      readonly observed: number;
      readonly limit: number;
    }[];
  };
  readonly limitations: readonly string[];
}

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

function distribution(samples: readonly number[]): Distribution {
  const ordered = [...samples].sort((left, right) => left - right);
  const quantile = (fraction: number) =>
    ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
  return {
    samples: ordered.length,
    minimumMs: ordered[0] ?? 0,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    maximumMs: ordered.at(-1) ?? 0,
  };
}

function task(transport: ComparedTransport, name: string): TaskAttemptSpec {
  const capturedAt = new Date().toISOString();
  return {
    version: 2,
    taskId: `${transport}-${name}`,
    attemptId: `${transport}-${name}-attempt`,
    tag: { id: "transport-comparison", name: "Transport comparison" },
    workerProfile: { id: "comparison", revision: "1" },
    execution: {},
    contextPlan: emptyTagContextPlan(capturedAt),
    workspacePlan: { version: 1, status: "none" },
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "transport-comparison", name: "Transport comparison" },
      origin: {
        tagRouteId: "local-comparison",
        surfaceAccountId: "local",
        provider: "github",
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
        sessionKey: `${transport}:${name}`,
        occurredAt: capturedAt,
      },
      messages: [{ id: "request", role: "requester", text: "Complete the comparison task" }],
    },
  };
}

function event(
  spec: TaskAttemptSpec,
  value:
    | { readonly type: "execution.started"; readonly workerId: string }
    | { readonly type: "output.delta"; readonly text: string }
    | { readonly type: "execution.completed" },
): TaskAttemptEvent {
  return { ...value, taskId: spec.taskId, attemptId: spec.attemptId, at: new Date().toISOString() };
}

async function waitUntil(probe: () => boolean, deadlineMs: number, description: string) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function proxy(targetPort: number) {
  let partitioned = false;
  const sockets = new Set<Socket>();
  const server = createProxyServer((downstream) => {
    if (partitioned) {
      downstream.destroy();
      return;
    }
    const upstream = connect(targetPort, "127.0.0.1");
    for (const socket of [upstream, downstream]) {
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

async function measure(
  transport: ComparedTransport,
  options: Required<TransportComparisonOptions>,
): Promise<TransportMeasurement> {
  const directory = await mkdtemp(join(tmpdir(), `supertag-${transport}-comparison-`));
  const gates = new Map<string, Gate>();
  const executions = new Map<string, number>();
  const worklet: Worklet = {
    id: `${transport}-comparison-worklet`,
    async describe() {
      return {
        id: this.id,
        protocolVersion: 1,
        host: {
          id: `${transport}-comparison-host`,
          workers: [
            {
              profileCapabilities: [
                {
                  profile: { id: "comparison", revision: "1" },
                  capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
                  contextTypes: [],
                },
              ],
              id: `${transport}-comparison-worker`,
              type: "comparison",
              profiles: [{ id: "comparison", revision: "1" }],
              capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
              contextTypes: [],
              maxConcurrency: 2,
            },
          ],
        },
      };
    },
    async *execute(spec) {
      executions.set(spec.attemptId, (executions.get(spec.attemptId) ?? 0) + 1);
      yield event(spec, { type: "execution.started", workerId: `${transport}-comparison-worker` });
      const pause = gates.get(spec.attemptId);
      if (pause) await pause.waiting;
      yield event(spec, { type: "output.delta", text: "completed" });
      yield event(spec, { type: "execution.completed" });
    },
  };
  const durable = new DurableLocalWorklet(
    worklet,
    new FileAttemptJournal(join(directory, "journal")),
  );
  let generation = 0;
  const http = createServer();
  const remote = new RemoteWorkletServer({
    server: http,
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 1000,
    durableAcknowledgementTimeoutMs: options.deadlineMs,
    authenticateWorklet: ({ credential }) =>
      credential === "transport-comparison" ? { connectionGeneration: ++generation } : undefined,
  });
  remote.start();
  let grpcFrontend: Awaited<ReturnType<typeof startWorkletGrpcServer>> | undefined;
  let targetPort: number;
  if (transport === "websocket") {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    targetPort = (http.address() as AddressInfo).port;
  } else {
    grpcFrontend = await startWorkletGrpcServer({ remote });
    targetPort = Number(new URL(grpcFrontend.url).port);
  }
  const transportProxy = await proxy(targetPort);
  const connection = new WorkletConnection({
    url:
      transport === "grpc"
        ? `http://127.0.0.1:${transportProxy.port}`
        : `ws://127.0.0.1:${transportProxy.port}/worklets`,
    ...(transport === "grpc" ? { transport: "grpc" as const } : {}),
    credential: "transport-comparison",
    worklet,
    durableWorklet: durable,
    protocolVersions: [18],
    reconnectIntervalMs: 20,
  });
  try {
    const connectionStarted = performance.now();
    await connection.start();
    const connectionMs = performance.now() - connectionStarted;
    async function complete(spec: TaskAttemptSpec) {
      await remote.accept(spec);
      const observed = [];
      for await (const item of remote.events(spec.attemptId)) observed.push(item);
      if (observed.at(-1)?.event.type !== "execution.completed")
        throw new Error(`Missing completion for ${spec.attemptId}`);
    }
    for (let index = 0; index < options.warmup; index++)
      await complete(task(transport, `warmup-${index}`));

    const startRss = process.memoryUsage().rss;
    let peakRss = startRss;
    const completionSamples: number[] = [];
    for (let index = 0; index < options.iterations; index++) {
      const started = performance.now();
      await complete(task(transport, `measured-${index}`));
      completionSamples.push(performance.now() - started);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }

    const reconnectSamples: number[] = [];
    for (let index = 0; index < options.reconnects; index++) {
      const spec = task(transport, `reconnect-${index}`);
      const pause = gate();
      gates.set(spec.attemptId, pause);
      await remote.accept(spec);
      const first = remote.events(spec.attemptId)[Symbol.asyncIterator]();
      const started = await first.next();
      if (started.value?.event.type !== "execution.started")
        throw new Error(`Missing execution start for ${spec.attemptId}`);
      await first.return?.();
      const before = connection.connectionGeneration ?? 0;
      transportProxy.partition();
      await waitUntil(() => !connection.isConnected, options.deadlineMs, `${transport} disconnect`);
      const reconnectStarted = performance.now();
      transportProxy.restore();
      await waitUntil(
        () => (connection.connectionGeneration ?? 0) > before,
        options.deadlineMs,
        `${transport} reconnect`,
      );
      reconnectSamples.push(performance.now() - reconnectStarted);
      await remote.accept(spec);
      pause.release();
      const resumed = [];
      for await (const item of remote.events(spec.attemptId, 1)) resumed.push(item);
      if (resumed.at(-1)?.event.type !== "execution.completed")
        throw new Error(`Missing recovered completion for ${spec.attemptId}`);
      gates.delete(spec.attemptId);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const duplicateExecutions = [...executions.values()].filter((count) => count !== 1).length;
    if (duplicateExecutions !== 0) throw new Error(`${transport} repeated accepted work`);
    const endRss = process.memoryUsage().rss;
    return {
      transport,
      protocolVersion: connection.negotiatedProtocolVersion ?? 0,
      completed: options.iterations,
      duplicateExecutions,
      connectionMs,
      completion: distribution(completionSamples),
      reconnect: distribution(reconnectSamples),
      rss: {
        startBytes: startRss,
        peakBytes: peakRss,
        endBytes: endRss,
        peakDeltaBytes: Math.max(0, peakRss - startRss),
      },
    };
  } finally {
    for (const pause of gates.values()) pause.release();
    await connection.stop();
    await transportProxy.close();
    await grpcFrontend?.close();
    await remote.stop();
    if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runTransportComparison(
  input: TransportComparisonOptions = {},
): Promise<TransportComparisonReport> {
  const options = {
    iterations: input.iterations ?? 50,
    warmup: input.warmup ?? 5,
    reconnects: input.reconnects ?? 3,
    deadlineMs: input.deadlineMs ?? 5000,
  };
  for (const [name, value, maximum] of [
    ["iterations", options.iterations, 5000],
    ["warmup", options.warmup, 500],
    ["reconnects", options.reconnects, 50],
    ["deadlineMs", options.deadlineMs, 60_000],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  const measurements = [];
  for (const transport of ["websocket", "grpc"] as const)
    measurements.push(await measure(transport, options));
  const webSocket = measurements[0];
  const grpc = measurements[1];
  if (!webSocket || !grpc) throw new Error("Missing transport measurement");
  const adoptionBudget = {
    requiredCompletionRate: 1 as const,
    maximumDuplicateExecutions: 0 as const,
    maximumReconnectMs: options.deadlineMs,
    maximumGrpcP95Ratio: 3 as const,
    grpcP95AllowanceMs: 5 as const,
    maximumGrpcRssOverheadBytes: 32 * 1024 * 1024,
  };
  const checks = [
    ...measurements.flatMap((measurement) => [
      {
        name: `${measurement.transport}.completion-rate`,
        category: "correctness" as const,
        observed: measurement.completed / options.iterations,
        limit: adoptionBudget.requiredCompletionRate,
        passed:
          measurement.completed / options.iterations === adoptionBudget.requiredCompletionRate,
      },
      {
        name: `${measurement.transport}.duplicate-executions`,
        category: "correctness" as const,
        observed: measurement.duplicateExecutions,
        limit: adoptionBudget.maximumDuplicateExecutions,
        passed: measurement.duplicateExecutions === adoptionBudget.maximumDuplicateExecutions,
      },
      {
        name: `${measurement.transport}.bounded-reconnect`,
        category: "correctness" as const,
        observed: measurement.reconnect.maximumMs,
        limit: adoptionBudget.maximumReconnectMs,
        passed: measurement.reconnect.maximumMs <= adoptionBudget.maximumReconnectMs,
      },
    ]),
    {
      name: "grpc.completion-p95-regression",
      category: "comparative" as const,
      observed: grpc.completion.p95Ms,
      limit:
        webSocket.completion.p95Ms * adoptionBudget.maximumGrpcP95Ratio +
        adoptionBudget.grpcP95AllowanceMs,
      passed:
        grpc.completion.p95Ms <=
        webSocket.completion.p95Ms * adoptionBudget.maximumGrpcP95Ratio +
          adoptionBudget.grpcP95AllowanceMs,
    },
    {
      name: "grpc.rss-regression",
      category: "comparative" as const,
      observed: grpc.rss.peakDeltaBytes,
      limit: webSocket.rss.peakDeltaBytes + adoptionBudget.maximumGrpcRssOverheadBytes,
      passed:
        grpc.rss.peakDeltaBytes <=
        webSocket.rss.peakDeltaBytes + adoptionBudget.maximumGrpcRssOverheadBytes,
    },
  ];
  return {
    version: 1,
    measuredAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    workload: options,
    measurements,
    adoptionBudget,
    adoptionGate: { passed: checks.every((check) => check.passed), checks },
    limitations: [
      "Loopback plaintext endpoints and a raw TCP fault proxy do not represent production TLS termination or HTTP/2 proxy policy.",
      "Both peers run in one Node.js process, so RSS is process-wide and cannot attribute memory to one transport.",
      "The deterministic Worklet measures transport and durable-journal overhead without Harness, model, artifact, or database latency.",
      "Reported latency is a local comparison from this run, not a service-level objective or cross-host benchmark.",
    ],
  };
}
