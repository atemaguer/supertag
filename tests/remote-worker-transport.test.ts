import { mkdtempSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { HostServiceWorklet } from "../apps/cli/src/worker.ts";
import { placeByLabels } from "../packages/control-plane/src/label-placement.ts";
import { emptyTagContextPlan } from "../packages/core/src/index.ts";
import {
  collectTaskAttemptEvents,
  DurableLocalWorklet,
  FileAttemptJournal,
  StaticWorker,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  terminalOutputText,
  type Worklet,
  WorkletAdmissionRejectedError,
  type WorkletDescriptor,
} from "../packages/runtime/sdk/src/index.ts";
import {
  connectWorklet as connectTransport,
  RemoteWorkletServer,
  WorkletConnection,
  type WorkletConnectionOptions,
} from "../packages/runtime/transport/src/index.ts";
import { sharedTokenAuthentication } from "./support/worklet-authentication.js";

const CREDENTIAL = "remote-worker-test-token";
const servers: Server[] = [];
const remoteWorkletServers: RemoteWorkletServer[] = [];
const clients: WorkletConnection[] = [];
const journals: Array<{ directory: string; durable: DurableLocalWorklet }> = [];
let durableWorklets = new WeakMap<Worklet, DurableLocalWorklet>();
function durableFor(worklet: Worklet): DurableLocalWorklet {
  const existing = durableWorklets.get(worklet);
  if (existing) return existing;
  const directory = mkdtempSync(join(tmpdir(), "supertag-current-transport-"));
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  durableWorklets.set(worklet, durable);
  journals.push({ directory, durable });
  return durable;
}
function connectWorklet(options: WorkletConnectionOptions): Promise<WorkletConnection> {
  return connectTransport({
    ...options,
    durableWorklet: options.durableWorklet ?? durableFor(options.worklet),
  });
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
  await Promise.allSettled(remoteWorkletServers.splice(0).map((server) => server.stop()));
  await Promise.allSettled(servers.splice(0).map(closeServer));
  for (const { directory, durable } of journals.splice(0)) {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
  durableWorklets = new WeakMap();
});

describe("remote Worklet transport", () => {
  it.each([9, 10, 11, 12, 13, 14, 15, 16, 17, 999])(
    "rejects unsupported protocol %s before authentication",
    async (version) => {
      const server = await listen();
      const authenticateWorklet = vi.fn(sharedTokenAuthentication(CREDENTIAL));
      const remote = startRemoteWorkletServer(server, { authenticateWorklet });
      const socket = new WebSocket(workletUrl(server));
      try {
        await new Promise<void>((resolve) => socket.once("open", resolve));
        const response = new Promise<Record<string, unknown>>((resolve) =>
          socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
        );
        socket.send(
          JSON.stringify({
            type: "hello",
            protocolVersions: [version],
            credential: CREDENTIAL,
            worklet: {
              ...(await testWorklet(async function* () {}).describe()),
              durableProtocolVersion: 1,
            },
          }),
        );
        expect(await response).toMatchObject({
          type: "protocol_error",
          code: "unsupported_protocol",
          supportedProtocolVersions: [18],
        });
        expect(authenticateWorklet).not.toHaveBeenCalled();
        expect(remote.isWorkletConnected).toBe(false);
      } finally {
        socket.close();
      }
    },
  );

  it.each([{ protocolVersions: [17, 18] }, { protocolVersions: [18, 18] }])(
    "rejects a hello that advertises versions $protocolVersions instead of only 18",
    async ({ protocolVersions }) => {
      const server = await listen();
      const authenticateWorklet = vi.fn(sharedTokenAuthentication(CREDENTIAL));
      startRemoteWorkletServer(server, { authenticateWorklet });
      const socket = new WebSocket(workletUrl(server));
      try {
        await new Promise<void>((resolve) => socket.once("open", resolve));
        const response = new Promise<Record<string, unknown>>((resolve) =>
          socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
        );
        socket.send(
          JSON.stringify({
            type: "hello",
            protocolVersions,
            credential: CREDENTIAL,
            worklet: await testWorklet(async function* () {}).describe(),
          }),
        );
        await expect(response).resolves.toMatchObject({
          type: "protocol_error",
          code: "unsupported_protocol",
          supportedProtocolVersions: [18],
        });
        expect(authenticateWorklet).not.toHaveBeenCalled();
      } finally {
        socket.close();
      }
    },
  );

  it("rejects a non-durable protocol 18 hello before authentication or observation", async () => {
    const server = await listen();
    const authenticateWorklet = vi.fn(sharedTokenAuthentication(CREDENTIAL));
    const onWorkletConnected = vi.fn();
    const onWorkletObserved = vi.fn();
    const remote = startRemoteWorkletServer(server, {
      authenticateWorklet,
      onWorkletConnected,
      onWorkletObserved,
    });
    const socket = new WebSocket(workletUrl(server));
    try {
      await new Promise<void>((resolve) => socket.once("open", resolve));
      const response = new Promise<Record<string, unknown>>((resolve) =>
        socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
      );
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersions: [18],
          credential: CREDENTIAL,
          worklet: {
            ...(await testWorklet(async function* () {}).describe()),
            durableProtocolVersion: undefined,
          },
        }),
      );
      expect(await response).toMatchObject({
        type: "protocol_error",
        code: "unsupported_protocol",
        message: "Worklet protocol 18 requires durableProtocolVersion: 1",
      });
      expect(await closed).toBe(4002);
      expect(authenticateWorklet).not.toHaveBeenCalled();
      expect(onWorkletConnected).not.toHaveBeenCalled();
      expect(onWorkletObserved).not.toHaveBeenCalled();
      expect(remote.isWorkletConnected).toBe(false);
      expect(await remote.listWorkerHosts()).toEqual([]);
    } finally {
      socket.close();
    }
  });

  it("rejects clients without a durable backend", async () => {
    const server = await listen();
    const remote = startRemoteWorkletServer(server);
    const worklet = testWorklet(async function* (spec) {
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    await expect(
      connectTransport({
        url: workletUrl(server),
        credential: CREDENTIAL,
        worklet,
      }),
    ).rejects.toThrow("Durable execution required");
    expect(remote.isWorkletConnected).toBe(false);
    expect(await remote.listWorkerHosts()).toEqual([]);
    expect(worklet.execute).not.toHaveBeenCalled();
  });

  it.each(["task_attempt_event", "job_done", "job_error"])(
    "rejects removed %s frames on protocol 18",
    async (type) => {
      const server = await listen();
      startRemoteWorkletServer(server);
      const { socket, ready } = await rawWorkletConnection(
        server,
        await testWorklet(async function* () {}).describe(),
        CREDENTIAL,
      );
      try {
        expect(ready).toMatchObject({ type: "ready", protocolVersion: 18 });
        const response = new Promise<Record<string, unknown>>((resolve) =>
          socket.once("message", (raw) => resolve(JSON.parse(raw.toString()))),
        );
        socket.send(JSON.stringify({ type, jobId: "removed-job" }));
        expect(await response).toMatchObject({
          type: "protocol_error",
          code: "invalid_message",
          message: "Unsupported authenticated Worklet message",
        });
      } finally {
        socket.close();
      }
    },
  );

  it("rejects legacy job dispatch from a protocol 18 Control Plane", async () => {
    const http = await listen();
    const sockets = new WebSocketServer({ server: http, path: "/worklets" });
    const worklet = testWorklet(async function* (spec) {
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const onError = vi.fn();
    sockets.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            type: "ready",
            protocolVersion: 18,
            heartbeatIntervalMs: 15000,
            connectionGeneration: 1,
          }),
        );
        socket.send(JSON.stringify({ type: "job", jobId: "removed-job", spec: taskAttemptSpec() }));
      });
    });
    const client = await connectTransport({
      url: workletUrl(http),
      credential: CREDENTIAL,
      worklet,
      onError,
    });
    clients.push(client);
    try {
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Worklet protocol 18 requires durable execution requests",
          }),
        ),
      );
      expect(worklet.execute).not.toHaveBeenCalled();
    } finally {
      await client.stop();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    }
  });

  it("clears a rejected durable admission reservation after the host confirms no receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-durable-rejected-"));
    const worklet = testWorklet(async function* (spec) {
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    const accept = durable.accept.bind(durable);
    let reject = true;
    vi.spyOn(durable, "accept").mockImplementation(async (spec) => {
      if (reject) throw new Error("No eligible Worker capacity");
      return accept(spec);
    });
    const server = await listen();
    const remote = startRemoteWorkletServer(server);
    const client = await connectWorklet({
      url: workletUrl(server),
      credential: CREDENTIAL,
      worklet,
      durableWorklet: durable,
    });
    clients.push(client);
    try {
      const rejected = taskAttemptSpec();
      await expect(remote.accept(rejected)).rejects.toThrow("No eligible Worker capacity");
      expect(await remote.inspect(rejected.attemptId)).toBeUndefined();
      reject = false;
      await expect(
        remote.accept({ ...taskAttemptSpec(), attemptId: "accepted-after-rejection" }),
      ).resolves.toMatchObject({ status: "accepted" });
    } finally {
      await client.stop();
      await durable.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("selects requirements by profile and rejects a frozen Attempt on incompatible capacity", async () => {
    const server = await listen();
    const remote = startRemoteWorkletServer(server);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worklet = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.started", workerId: "local-static" });
        await waiting;
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      {
        profiles: [
          { id: "research", revision: "1" },
          { id: "coding", revision: "1" },
        ],
      },
    );
    const original = worklet.describe;
    worklet.describe = async () => {
      const value = await original();
      return {
        ...value,
        host: {
          ...value.host,
          workers: value.host.workers.map((worker) => ({
            ...worker,
            profileCapabilities: [
              {
                profile: { id: "research", revision: "1" },
                harness: "opencode",
                capabilities: [{ id: "search", version: 1 }],
                contextTypes: [],
              },
              {
                profile: { id: "coding", revision: "1" },
                harness: "codex",
                capabilities: [{ id: "write", version: 1 }],
                contextTypes: [],
              },
            ],
          })),
        },
      };
    };
    clients.push(
      await connectWorklet({ url: workletUrl(server), credential: CREDENTIAL, worklet }),
    );
    const plan = taskAttemptSpec().contextPlan;
    expect(
      await remote.selectExecution({ requires: [{ id: "search", version: 1 }] }, plan),
    ).toEqual({ id: "research", revision: "1" });
    expect(await remote.selectExecution({ prefers: [{ id: "write", version: 1 }] }, plan)).toEqual({
      id: "coding",
      revision: "1",
    });
    expect(await remote.selectExecution({ harness: "claude-code" }, plan)).toBeUndefined();
    await expect(
      collectTaskAttemptEvents(
        remote.execute({
          ...taskAttemptSpec({ id: "research", revision: "1" }),
          execution: { harness: "codex" },
        }),
      ),
    ).rejects.toThrow(/No durable/);
    const iterator = remote
      .execute({
        ...taskAttemptSpec({ id: "coding", revision: "1" }),
        execution: { harness: "codex" },
      })
      [Symbol.asyncIterator]();
    try {
      await iterator.next();
      expect(await remote.selectExecution({}, plan)).toBeUndefined();
    } finally {
      release();
      while (!(await iterator.next()).done) {
        /* Drain accepted execution. */
      }
    }
    expect(await remote.selectExecution({ harness: "codex" }, plan)).toEqual({
      id: "coding",
      revision: "1",
    });
  });

  it("registers a Worklet and streams ordered Task Attempt Events across WebSocket", async () => {
    const httpServer = await listen();
    const worklet = testWorklet(async function* (spec) {
      yield taskAttemptEvent(spec, { type: "execution.started", workerId: "local-static" });
      yield taskAttemptEvent(spec, { type: "output.delta", text: "local:" });
      yield taskAttemptEvent(spec, {
        type: "output.message",
        message: { role: "teammate", text: `local:${spec.input.messages[0]?.text}` },
      });
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const connected = vi.fn();
    const remote = startRemoteWorkletServer(httpServer, { onWorkletConnected: connected });
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
      reconnectIntervalMs: 5,
    });
    clients.push(client);

    expect(remote.isWorkletConnected).toBe(true);
    expect(client.negotiatedProtocolVersion).toBe(18);
    await expect(remote.describe()).resolves.toEqual(await worklet.describe());
    expect(remote.workletRegistration).toEqual(await worklet.describe());
    expect(connected).toHaveBeenCalledWith(await worklet.describe(), {
      connectionGeneration: 1,
      protocolVersion: 18,
      workerHostId: "local-worklet-host",
      workletId: "local-worklet",
    });
    expect(client.connectionGeneration).toBe(1);

    const spec = taskAttemptSpec();
    const events = await collectTaskAttemptEvents(remote.execute(spec));
    expect(events.map((event) => event.type)).toEqual([
      "execution.started",
      "output.delta",
      "output.message",
      "execution.completed",
    ]);
    expect(terminalOutputText(events)).toBe("local:execute this on the worklet");
    expect(worklet.execute).toHaveBeenCalledWith(spec, expect.any(AbortSignal));
  });

  it("preserves Session continuity on protocol 18", async () => {
    const httpServer = await listen();
    const worklet = testWorklet(async function* (spec) {
      if (spec.session) {
        yield taskAttemptEvent(spec, {
          type: "session.updated",
          sessionState: { id: "native-state", format: "test.v1", uri: "supertag://sessions/state" },
        });
      }
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const remote = startRemoteWorkletServer(httpServer);
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
      protocolVersions: [18],
      reconnectIntervalMs: 5,
    });
    clients.push(client);
    await expect(collectTaskAttemptEvents(remote.execute(taskAttemptSpec()))).resolves.toHaveLength(
      1,
    );
    const spec = { ...taskAttemptSpec(), session: { id: "session" } };
    const events = await collectTaskAttemptEvents(
      remote.execute({ ...spec, attemptId: "session-attempt" }),
    );
    expect(events.map((event) => event.type)).toEqual(["session.updated", "execution.completed"]);
  });

  it("does not admit a Worklet presenting the wrong credential", async () => {
    const httpServer = await listen();
    const worklet = testWorklet(async function* (spec) {
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const remote = startRemoteWorkletServer(httpServer);
    const client = new WorkletConnection({
      url: workletUrl(httpServer),
      credential: "wrong-token",
      worklet,
      durableWorklet: durableFor(worklet),
      reconnectIntervalMs: 5,
    });
    clients.push(client);
    const startOutcome = client.start().then(
      () => "connected" as const,
      (error: unknown) => error,
    );

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(client.isConnected).toBe(false);
    expect(remote.isWorkletConnected).toBe(false);
    await expect(remote.describe()).rejects.toThrow("No remote Worklet is connected");
    const rejected = collectTaskAttemptEvents(remote.execute(taskAttemptSpec()));
    await expect(rejected).rejects.toBeInstanceOf(WorkletAdmissionRejectedError);
    await expect(collectTaskAttemptEvents(remote.execute(taskAttemptSpec()))).rejects.toThrow(
      "No durable Worklet",
    );
    await client.stop();
    await expect(startOutcome).resolves.toBeInstanceOf(Error);
    expect(worklet.execute).not.toHaveBeenCalled();
  });

  it("sends changed host labels on a heartbeat, so a lapsed or restored MCP login reaches placement without a reconnect", async () => {
    const httpServer = await listen();
    let latest: WorkletDescriptor | undefined;
    const authenticate = sharedTokenAuthentication(CREDENTIAL);
    const authenticateWorklet = vi.fn(authenticate);
    startRemoteWorkletServer(httpServer, {
      authenticateWorklet,
      onWorkletObserved: (observation) => {
        latest = observation.descriptor;
      },
    });
    let lapsed = new Set<string>();
    const worklet = new HostServiceWorklet(
      "w",
      "h",
      [new StaticWorker()],
      { labels: [] },
      ["notion"],
      async () => lapsed,
    );
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
      reconnectIntervalMs: 5,
    });
    clients.push(client);
    const placement = () =>
      placeByLabels(
        ["h"],
        [{ id: "h", enrollmentStatus: "active", labels: latest?.host.labels ?? [] }],
        ["mcp:notion"],
      );
    await vi.waitFor(() => expect(placement()).toMatchObject({ status: "eligible" }));
    lapsed = new Set(["notion"]);
    await vi.waitFor(() =>
      expect(placement()).toMatchObject({ status: "unmet", mcpLogins: ["notion"] }),
    );
    lapsed = new Set();
    await vi.waitFor(() => expect(placement()).toMatchObject({ status: "eligible" }));
    expect(authenticateWorklet).toHaveBeenCalledTimes(1);
  });

  it("sends changed Worker concurrency on an immediate heartbeat, so the Control Plane schedules against a new limit without a reconnect", async () => {
    const httpServer = await listen();
    let latest: { capacity: number; maxConcurrency: number | undefined } | undefined;
    const authenticateWorklet = vi.fn(sharedTokenAuthentication(CREDENTIAL));
    const remote = startRemoteWorkletServer(httpServer, {
      authenticateWorklet,
      // Only heartbeat() sends one in this test, as the host does after a change.
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 120_000,
      onWorkletObserved: (observation) => {
        latest = {
          capacity: observation.capacity,
          maxConcurrency: observation.descriptor.host.workers[0]?.maxConcurrency,
        };
      },
    });
    let limit = 2;
    const base = testWorklet(async function* () {}, { maxConcurrency: 2 });
    const worklet: Worklet = {
      ...base,
      describe: async () => {
        const descriptor = await base.describe();
        return {
          ...descriptor,
          host: {
            ...descriptor.host,
            workers: descriptor.host.workers.map((worker) => ({
              ...worker,
              maxConcurrency: limit,
            })),
          },
        };
      },
      workerConcurrency: async () => ({ "local-static": limit }),
    };
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
      reconnectIntervalMs: 5,
    });
    clients.push(client);
    await vi.waitFor(() => expect(latest).toEqual({ capacity: 2, maxConcurrency: 2 }));
    limit = 6;
    client.heartbeat();
    await vi.waitFor(() => expect(latest).toEqual({ capacity: 6, maxConcurrency: 6 }));
    expect((await remote.describe()).host.workers[0]?.maxConcurrency).toBe(6);
    limit = 1;
    client.heartbeat();
    await vi.waitFor(() => expect(latest).toEqual({ capacity: 1, maxConcurrency: 1 }));
    expect(authenticateWorklet).toHaveBeenCalledTimes(1);
  });

  it("rejects a heartbeat resize past 1,000 per Worker or 10,000 per host, as a connection does", async () => {
    const httpServer = await listen();
    const capacities: number[] = [];
    const errors: string[] = [];
    startRemoteWorkletServer(httpServer, {
      authenticateWorklet: vi.fn(sharedTokenAuthentication(CREDENTIAL)),
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 120_000,
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      onWorkletObserved: (observation) => {
        capacities.push(observation.capacity);
      },
    });
    let limit = 1;
    const ids = Array.from({ length: 11 }, (_, index) => `local-${index}`);
    const base = testWorklet(async function* () {}, { maxConcurrency: 1 });
    const worklet: Worklet = {
      ...base,
      describe: async () => {
        const descriptor = await base.describe();
        const worker = descriptor.host.workers[0];
        if (worker === undefined) throw new Error("test Worklet has no Worker");
        return {
          ...descriptor,
          host: {
            ...descriptor.host,
            workers: ids.map((id) => ({ ...worker, id, maxConcurrency: 1 })),
          },
        };
      },
      workerConcurrency: async () => Object.fromEntries(ids.map((id) => [id, limit])),
    };
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
      reconnectIntervalMs: 5,
    });
    clients.push(client);
    await vi.waitFor(() => expect(capacities).toContain(11));
    limit = 1_001;
    client.heartbeat();
    await vi.waitFor(() =>
      expect(errors).toContain(
        "Worker concurrency must be a whole number from 1 through 1000 per Worker",
      ),
    );
    // 11 Workers at 1,000 each would be 11,000 on one host.
    limit = 1_000;
    client.heartbeat();
    await vi.waitFor(() => expect(errors).toContain("Worker Host capacity must not exceed 10000"));
    limit = 900;
    client.heartbeat();
    await vi.waitFor(() => expect(capacities).toContain(9_900));
    expect(Math.max(...capacities)).toBe(9_900);
  });

  it("keeps stalled host probes bounded and ignores their results after disconnect", async () => {
    const httpServer = await listen();
    const sockets = new WebSocketServer({ server: httpServer, path: "/worklets" });
    const heartbeats: { hostLabels?: string[] }[] = [];
    sockets.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "hello")
          socket.send(
            JSON.stringify({ type: "ready", protocolVersion: 18, heartbeatIntervalMs: 5 }),
          );
        if (message.type === "heartbeat") heartbeats.push(message);
      });
    });
    const slow = deferred<readonly string[]>();
    const slowConcurrency = deferred<Record<string, number>>();
    let calls = 0;
    let concurrencyCalls = 0;
    const worklet = {
      ...testWorklet(async function* () {}),
      hostLabels: () => (++calls === 1 ? slow.promise : Promise.resolve(["mcp-login:notion"])),
      workerConcurrency: () => {
        concurrencyCalls++;
        return slowConcurrency.promise;
      },
    };
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
    });
    clients.push(client);
    try {
      await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThan(10));
      expect(calls).toBe(1);
      expect(concurrencyCalls).toBe(1);
      await client.stop();
      slow.resolve(["mcp:notion"]);
      slowConcurrency.resolve({ worker: 3 });
      await Promise.resolve();
      expect(
        heartbeats.every(
          (beat) => beat.hostLabels === undefined && beat.workerConcurrency === undefined,
        ),
      ).toBe(true);
    } finally {
      await client.stop();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    }
  });

  it("keeps heartbeats flowing while a host labels probe is stalled", async () => {
    const httpServer = await listen();
    // Count the heartbeats the server takes while the probe stays stalled, rather than racing a
    // short timeout against the runner's scheduling.
    const heartbeats = new Set<string>();
    const remote = startRemoteWorkletServer(httpServer, {
      heartbeatIntervalMs: 20,
      onWorkletObserved: (observation) => {
        if (observation.connected) heartbeats.add(observation.lastHeartbeatAt);
      },
    });
    const slow = deferred<readonly string[]>();
    let probes = 0;
    const worklet = {
      ...testWorklet(async function* () {}),
      hostLabels: () => {
        probes++;
        return slow.promise;
      },
    };
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
    });
    clients.push(client);
    try {
      await vi.waitFor(() => expect(probes).toBe(1));
      const before = heartbeats.size;
      await vi.waitFor(() => expect(heartbeats.size).toBeGreaterThan(before + 10), {
        timeout: 5_000,
      });
      // The one probe is still outstanding: heartbeats never waited for it.
      expect(probes).toBe(1);
      expect(remote.isWorkletConnected).toBe(true);
      expect(client.isConnected).toBe(true);
    } finally {
      slow.resolve([]);
    }
  });

  it("authenticates the credential against the declared Worker Host and restores drain state", async () => {
    const httpServer = await listen();
    const observations = vi.fn();
    const authenticateWorklet = vi.fn(
      async ({ credential, worklet }: { credential: string; worklet: { host: { id: string } } }) =>
        credential === "host-a-secret" && worklet.host.id === "host-a"
          ? { connectionGeneration: 41, draining: true }
          : undefined,
    );
    const remote = startRemoteWorkletServer(httpServer, {
      authenticateWorklet,
      onWorkletObserved: observations,
    });
    const worklet = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workerHostId: "host-a" },
    );
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: "host-a-secret",
      worklet,
      reconnectIntervalMs: 5,
    });
    clients.push(client);

    expect(client.connectionGeneration).toBe(41);
    expect(authenticateWorklet).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: "host-a-secret",
        protocolVersion: 18,
        worklet: expect.objectContaining({ host: expect.objectContaining({ id: "host-a" }) }),
      }),
    );
    await expect(remote.listWorkerHosts()).resolves.toEqual([
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: "host-a" }),
        conditions: expect.arrayContaining([
          expect.objectContaining({ type: "Draining", status: true }),
        ]),
        availableSlots: 0,
      }),
    ]);
    await vi.waitFor(() =>
      expect(observations).toHaveBeenCalledWith(
        expect.objectContaining({
          workerHostId: "host-a",
          connectionGeneration: 41,
          connected: true,
          draining: true,
          capacity: 1,
          activeAttempts: 0,
          availableSlots: 0,
        }),
      ),
    );
  });

  it("rejects a host credential used to claim another Worker Host identity", async () => {
    const httpServer = await listen();
    startRemoteWorkletServer(httpServer, {
      authenticateWorklet: async ({ credential, worklet }) =>
        credential === "host-a-secret" && worklet.host.id === "host-a"
          ? { connectionGeneration: 1 }
          : undefined,
    });
    const worklet = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workerHostId: "host-b" },
    );
    const client = new WorkletConnection({
      url: workletUrl(httpServer),
      credential: "host-a-secret",
      worklet,
      durableWorklet: durableFor(worklet),
      reconnectIntervalMs: 5,
    });
    clients.push(client);

    await expect(client.start()).rejects.toThrow("Authentication failed");
    expect(client.isConnected).toBe(false);
  });

  it.each([false, true])(
    "rejects pairingToken on protocol 18 even alongside credential (%s)",
    async (includeCredential) => {
      const httpServer = await listen();
      const authenticateWorklet = vi.fn(async () => ({ connectionGeneration: 1 }));
      startRemoteWorkletServer(httpServer, {
        authenticateWorklet,
      });
      const descriptor = await testWorklet(
        async function* (spec) {
          yield taskAttemptEvent(spec, { type: "execution.completed" });
        },
        { workerHostId: "protocol-field-host" },
      ).describe();
      const socket = new WebSocket(workletUrl(httpServer));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const invalid = new Promise<Record<string, unknown>>((resolve) => {
        socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersions: [18],
          pairingToken: "legacy-name",
          ...(includeCredential ? { credential: CREDENTIAL } : {}),
          worklet: descriptor,
        }),
      );

      await expect(invalid).resolves.toMatchObject({
        type: "protocol_error",
        code: "invalid_message",
      });
      expect(authenticateWorklet).not.toHaveBeenCalled();
      socket.close();
    },
  );

  it("fails closed when the durable Worker Host claim fails", async () => {
    const httpServer = await listen();
    const reported = vi.fn();
    startRemoteWorkletServer(httpServer, {
      authenticateWorklet: async () => {
        throw new Error("claim store unavailable");
      },
      onError: reported,
    });
    const worklet = testWorklet(async function* (spec) {
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const client = new WorkletConnection({
      url: workletUrl(httpServer),
      credential: "otherwise-valid",
      worklet,
      durableWorklet: durableFor(worklet),
      reconnectIntervalMs: 5,
    });
    clients.push(client);

    await expect(client.start()).rejects.toThrow("Authentication failed");
    expect(client.isConnected).toBe(false);
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ message: "claim store unavailable" }),
    );
  });

  it("does not admit a Worker Host when the authoritative observation rejects its generation", async () => {
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer, {
      authenticateWorklet: async () => ({ connectionGeneration: 7 }),
      onWorkletObserved: (observation) => !observation.connected,
    });
    const descriptor = await testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workerHostId: "revoked-before-ready" },
    ).describe();
    const socket = new WebSocket(workletUrl(httpServer));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(data.toString()));
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersions: [18],
        credential: "credential",
        worklet: descriptor,
      }),
    );

    await expect(closed).resolves.toBe(4007);
    expect(messages).toEqual([]);
    expect(remote.isWorkletConnected).toBe(false);
    await expect(remote.describe()).rejects.toThrow("No remote Worklet is connected");
  });

  it("keeps all frames fenced while authoritative admission is pending", async () => {
    const httpServer = await listen();
    const releaseObservation = deferred<void>();
    startRemoteWorkletServer(httpServer, {
      authenticateWorklet: async () => ({ connectionGeneration: 8 }),
      onWorkletObserved: async (observation) => {
        if (observation.connected) await releaseObservation.promise;
        return true;
      },
    });
    const descriptor = await testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workerHostId: "pending-authority" },
    ).describe();
    const socket = new WebSocket(workletUrl(httpServer));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersions: [18],
        credential: "credential",
        worklet: descriptor,
      }),
    );
    socket.send(JSON.stringify({ type: "heartbeat", at: new Date().toISOString() }));

    await expect(closed).resolves.toBe(4001);
    releaseObservation.resolve();
  });

  it("revalidates a drain change made while authoritative admission is pending", async () => {
    const httpServer = await listen();
    const observationStarted = deferred<void>();
    const releaseObservation = deferred<void>();
    const observations: Array<{ connected: boolean; draining: boolean }> = [];
    const remote = startRemoteWorkletServer(httpServer, {
      authenticateWorklet: async () => ({ connectionGeneration: 9 }),
      onWorkletObserved: async (observation) => {
        observations.push(observation);
        if (observations.length === 1) {
          observationStarted.resolve();
          await releaseObservation.promise;
        }
        return true;
      },
    });
    const descriptor = await testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workerHostId: "drained-before-ready" },
    ).describe();
    const socket = new WebSocket(workletUrl(httpServer));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const ready = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersions: [18],
        credential: "credential",
        worklet: descriptor,
      }),
    );
    await observationStarted.promise;
    await expect(remote.setHostDraining("drained-before-ready", true)).resolves.toBe(true);
    releaseObservation.resolve();

    await expect(ready).resolves.toMatchObject({ type: "ready", connectionGeneration: 9 });
    expect(observations.slice(0, 2)).toEqual([
      expect.objectContaining({ connected: true, draining: false }),
      expect.objectContaining({ connected: true, draining: true }),
    ]);
    await expect(remote.listWorkerHosts()).resolves.toEqual([
      expect.objectContaining({ availableSlots: 0 }),
    ]);
    socket.close();
  });

  it("adopts authoritative drain state returned after a connection claim", async () => {
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer, {
      authenticateWorklet: async () => ({ connectionGeneration: 10, draining: false }),
      onWorkletObserved: async () => ({ draining: true }),
    });
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: "credential",
      worklet: testWorklet(
        async function* (spec) {
          yield taskAttemptEvent(spec, { type: "execution.completed" });
        },
        { workerHostId: "authoritatively-drained" },
      ),
      reconnectIntervalMs: 5,
    });
    clients.push(client);

    await expect(remote.listWorkerHosts()).resolves.toEqual([
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: "authoritatively-drained" }),
        availableSlots: 0,
        conditions: expect.arrayContaining([
          expect.objectContaining({ type: "Draining", status: true }),
        ]),
      }),
    ]);
    await expect(remote.describe()).rejects.toThrow("No remote Worklet is connected");
  });

  it("bounds sockets waiting for Worker Host authentication", async () => {
    const httpServer = await listen();
    startRemoteWorkletServer(httpServer, {
      maxPendingAuthentications: 1,
      authTimeoutMs: 1_000,
    });
    const pending = new WebSocket(workletUrl(httpServer));
    await new Promise<void>((resolve, reject) => {
      pending.once("open", resolve);
      pending.once("error", reject);
    });
    const rejected = new WebSocket(workletUrl(httpServer));
    const responseStatus = new Promise<number>((resolve, reject) => {
      rejected.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      rejected.once("error", reject);
    });

    await expect(responseStatus).resolves.toBe(503);
    pending.close();
    rejected.terminate();
  });

  it("releases a durable claim that completes after its socket authentication timeout", async () => {
    const httpServer = await listen();
    const releaseClaim = deferred<void>();
    const released = deferred<number>();
    startRemoteWorkletServer(httpServer, {
      authTimeoutMs: 15,
      authenticateWorklet: async () => {
        await releaseClaim.promise;
        return { connectionGeneration: 9 };
      },
      onWorkletObserved: (observation) => {
        if (!observation.connected) released.resolve(observation.connectionGeneration);
      },
    });
    const descriptor = await testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workerHostId: "timed-out-host" },
    ).describe();
    const socket = new WebSocket(workletUrl(httpServer));
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersions: [18],
        credential: "credential",
        worklet: descriptor,
      }),
    );

    await expect(closed).resolves.toBe(4001);
    releaseClaim.resolve();
    await expect(released.promise).resolves.toBe(9);
  });

  it("replaces a Worker Host socket with a newer generation and fences the old connection", async () => {
    const httpServer = await listen();
    let generation = 0;
    const disconnected = vi.fn();
    const remote = startRemoteWorkletServer(httpServer, {
      authenticateWorklet: async () => ({ connectionGeneration: ++generation }),
      onWorkletDisconnected: disconnected,
    });
    const firstWorklet = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workletId: "first-worklet", workerHostId: "shared-host" },
    );
    const first = await rawWorkletConnection(httpServer, await firstWorklet.describe(), "first");
    expect(first.ready).toMatchObject({ type: "ready", connectionGeneration: 1 });
    const firstClosed = new Promise<number>((resolve) =>
      first.socket.once("close", (code) => resolve(code)),
    );
    const replacementWorklet = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workletId: "replacement-worklet", workerHostId: "shared-host" },
    );
    const replacement = await connectWorklet({
      url: workletUrl(httpServer),
      credential: "replacement",
      worklet: replacementWorklet,
      reconnectIntervalMs: 5,
    });
    clients.push(replacement);

    await expect(firstClosed).resolves.toBe(4007);
    expect(replacement.connectionGeneration).toBe(2);
    await expect(collectTaskAttemptEvents(remote.execute(taskAttemptSpec()))).resolves.toEqual([
      expect.objectContaining({ type: "execution.completed" }),
    ]);
    expect(firstWorklet.execute).not.toHaveBeenCalled();
    expect(replacementWorklet.execute).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledWith(
      expect.objectContaining({ id: "first-worklet" }),
      expect.objectContaining({ workerHostId: "shared-host", connectionGeneration: 1 }),
    );
    await expect(remote.listWorkerHosts()).resolves.toEqual([
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: "shared-host" }),
        workletId: "replacement-worklet",
        conditions: expect.arrayContaining([
          expect.objectContaining({ type: "Connected", status: true }),
        ]),
      }),
    ]);
  });

  it("does not let a superseded Worklet reconnect and repeatedly reclaim the Host", async () => {
    const httpServer = await listen();
    let generation = 0;
    const remote = startRemoteWorkletServer(httpServer, {
      authenticateWorklet: async () => ({ connectionGeneration: ++generation }),
    });
    const firstWorklet = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workletId: "old-process", workerHostId: "single-host" },
    );
    const first = await connectWorklet({
      url: workletUrl(httpServer),
      credential: "shared-host-credential",
      worklet: firstWorklet,
      reconnectIntervalMs: 5,
    });
    clients.push(first);
    const replacementDescriptor = await testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workletId: "new-process", workerHostId: "single-host" },
    ).describe();
    const replacement = await rawWorkletConnection(
      httpServer,
      replacementDescriptor,
      "shared-host-credential",
    );

    await vi.waitFor(() => expect(first.isConnected).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(generation).toBe(2);
    expect(remote.workletRegistrations).toEqual([replacementDescriptor]);
    replacement.socket.close();
  });

  it("rejects a delayed stale generation after a newer claim becomes active", async () => {
    const httpServer = await listen();
    const releaseOld = deferred<void>();
    const remote = startRemoteWorkletServer(httpServer, {
      authenticateWorklet: async ({ credential }) => {
        if (credential === "old") {
          await releaseOld.promise;
          return { connectionGeneration: 1 };
        }
        return { connectionGeneration: 2 };
      },
    });
    const descriptor = await testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workerHostId: "ordered-host" },
    ).describe();
    const oldSocket = new WebSocket(workletUrl(httpServer));
    await new Promise<void>((resolve) => oldSocket.once("open", resolve));
    oldSocket.send(
      JSON.stringify({
        type: "hello",
        protocolVersions: [18],
        credential: "old",
        worklet: descriptor,
      }),
    );
    const newer = await rawWorkletConnection(httpServer, descriptor, "new");
    expect(newer.ready).toMatchObject({ connectionGeneration: 2 });
    const oldClosed = new Promise<number>((resolve) =>
      oldSocket.once("close", (code) => resolve(code)),
    );
    releaseOld.resolve();

    await expect(oldClosed).resolves.toBe(4007);
    expect(remote.workletRegistrations).toEqual([descriptor]);
    newer.socket.close();
  });

  it("disconnects a revoked Worker Host generation immediately", async () => {
    const httpServer = await listen();
    const observations: Array<{ connected: boolean; connectionGeneration: number }> = [];
    const remote = startRemoteWorkletServer(httpServer, {
      authenticateWorklet: async () => ({ connectionGeneration: 1 }),
      onWorkletObserved: async (observation) => {
        observations.push(observation);
      },
    });
    const descriptor = await testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workerHostId: "revoked-host" },
    ).describe();
    const connection = await rawWorkletConnection(httpServer, descriptor, "revoked");
    const closed = new Promise<number>((resolve) =>
      connection.socket.once("close", (code) => resolve(code)),
    );

    expect(remote.disconnectHost("revoked-host")).toBe(true);
    await expect(closed).resolves.toBe(4008);
    await vi.waitFor(() => expect(remote.isWorkletConnected).toBe(false));
    await remote.flushObservations();
    // The peer's close event can precede the server's observation callback.
    await vi.waitFor(() =>
      expect(observations.at(-1)).toMatchObject({ connected: false, connectionGeneration: 1 }),
    );
    expect(remote.disconnectHost("missing-host")).toBe(false);
  });

  it("routes durable native controls once to the accepted host and replays after reconnect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-controls-"));
    const release = deferred<void>();
    const started = deferred<void>();
    const base = testWorklet(async function* (spec) {
      yield taskAttemptEvent(spec, { type: "execution.started", workerId: "local-static" });
      started.resolve();
      await release.promise;
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const control = vi.fn(async (command) => ({
      id: command.id,
      taskId: command.taskId,
      attemptId: command.attemptId,
      status: "accepted" as const,
    }));
    const worklet: Worklet = {
      ...base,
      control,
      controlCapabilities: async () => ({ version: 1, operations: ["input"], inputMode: "steer" }),
    };
    const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer);
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
      durableWorklet: durable,
      reconnectIntervalMs: 5,
    });
    clients.push(client);
    const spec = taskAttemptSpec();
    try {
      await remote.accept(spec);
      await started.promise;
      expect(await remote.controlCapabilities(spec.taskId, spec.attemptId)).toEqual({
        version: 1,
        operations: ["input"],
        inputMode: "steer",
      });
      const command = {
        id: "remote-input",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        type: "input" as const,
        text: "change direction",
      };
      expect((await remote.control(command)).status).toBe("accepted");
      await client.stop();
      expect((await remote.control(command)).status).toBe("unknown");
      await client.start();
      expect((await remote.control(command)).status).toBe("accepted");
      expect((await remote.control({ ...command, text: "conflict" })).status).toBe("rejected");
      expect(control).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      for await (const _ of durable.events(spec.attemptId)) {
        /* Complete accepted execution. */
      }
      await client.stop();
      await durable.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("durably accepts protocol 18 attempts once and resumes journal events after reconnect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-durable-transport-"));
    const release = deferred<void>();
    const started = deferred<void>();
    const worklet = testWorklet(async function* (spec) {
      yield taskAttemptEvent(spec, { type: "execution.started", workerId: "local-static" });
      started.resolve();
      await release.promise;
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    const httpServer = await listen();
    let remote = startRemoteWorkletServer(httpServer);
    const spec = taskAttemptSpec();
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
      durableWorklet: durable,
      protocolVersions: [18],
    });
    clients.push(client);
    try {
      expect(client.negotiatedProtocolVersion).toBe(18);
      const receipt = await remote.accept(spec);
      expect(receipt).toMatchObject({
        attemptId: spec.attemptId,
        taskId: spec.taskId,
        workerId: "local-static",
      });
      await started.promise;
      expect((await remote.accept(spec)).specDigest).toBe(receipt.specDigest);
      expect(worklet.execute).toHaveBeenCalledOnce();
      const events = remote.events(spec.attemptId)[Symbol.asyncIterator]();
      const first = await events.next();
      expect(first.value?.sequence).toBe(1);
      await events.return?.();
      await client.stop();
      const unavailableReplay = await remote.accept(spec).catch((error: unknown) => error);
      expect(unavailableReplay).toBeInstanceOf(Error);
      expect(unavailableReplay).not.toBeInstanceOf(WorkletAdmissionRejectedError);
      expect(unavailableReplay).toMatchObject({
        message: "Durable Attempt host unavailable; inspect before retrying",
      });
      expect((await durable.inspect(spec.attemptId))?.cancellationRequested).not.toBe(true);
      await remote.stop();
      remote = startRemoteWorkletServer(httpServer);
      await client.start();
      expect((await remote.inspect(spec.attemptId))?.status).toBe("running");
      expect(await remote.canExecute(spec.workerProfile, spec.contextPlan)).toBe(false);
      release.resolve();
      const resumed = [];
      for await (const item of remote.events(spec.attemptId, 1)) resumed.push(item);
      expect(resumed.map((item) => item.sequence)).toEqual([2]);
      await expect
        .poll(async () => (await remote.inspect(spec.attemptId))?.status)
        .toBe("completed");
      await expect(remote.accept({ ...spec, taskId: "conflict" })).rejects.toThrow("conflict");
      const journal = (
        await Promise.all(
          (
            await readdir(directory)
          )
            .filter((name) => name.endsWith(".json"))
            .map((name) => readFile(join(directory, name), "utf8")),
        )
      ).join("");
      expect(journal).not.toContain('"authorization"');
      expect(worklet.execute).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await client.stop();
      await expect
        .poll(async () => (await durable.inspect(spec.attemptId))?.status)
        .toBe("completed");
      await expect
        .poll(async () => {
          try {
            await expect
              .poll(async () => {
                try {
                  await durable.close();
                  return true;
                } catch {
                  return false;
                }
              })
              .toBe(true);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not reroute an uncertain durable acceptance and recovers its receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-durable-ack-"));
    const ack = deferred<void>();
    const worklet = testWorklet(async function* (spec) {
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    const accept = durable.accept.bind(durable);
    vi.spyOn(durable, "accept").mockImplementation(async (spec) => {
      const receipt = await accept(spec);
      await ack.promise;
      return receipt;
    });
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer, { durableAcknowledgementTimeoutMs: 30 });
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
      durableWorklet: durable,
    });
    clients.push(client);
    try {
      const spec = taskAttemptSpec();
      await expect(remote.accept(spec)).rejects.toThrow("outcome may be unknown");
      await expect
        .poll(async () => (await remote.inspect(spec.attemptId))?.status)
        .toBe("completed");
      ack.resolve();
      await remote.accept(spec);
      expect(worklet.execute).toHaveBeenCalledOnce();
      await client.stop();
      await expect(remote.accept(spec)).rejects.toThrow("inspect before retrying");
      expect(worklet.execute).toHaveBeenCalledOnce();
    } finally {
      ack.resolve();
      await client.stop();
      await expect
        .poll(async () => {
          try {
            await durable.close();
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["completed", true],
    ["failed", true],
    ["cancelled", true],
    ["completed", false],
    ["failed", false],
    ["cancelled", false],
  ] as const)(
    "reserves unknown cleanup across reconnect until %s (Worker identified: %s)",
    async (terminalStatus, identifiesWorker) => {
      const directory = await mkdtemp(join(tmpdir(), "supertag-durable-unknown-capacity-"));
      const release = deferred<void>();
      const worklet = testWorklet(async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.started", workerId: "local-static" });
        await release.promise;
        throw new Error("Execution cleanup could not be confirmed");
      });
      const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
      const inspect = durable.inspect.bind(durable);
      let confirmedTerminal: "completed" | "failed" | "cancelled" | undefined;
      vi.spyOn(durable, "inspect").mockImplementation(async (id) => {
        const receipt = await inspect(id);
        if (!receipt) return undefined;
        const { workerId: _workerId, ...unidentified } = receipt;
        return {
          ...(identifiesWorker ? receipt : unidentified),
          status: confirmedTerminal ?? receipt.status,
        };
      });
      const accept = vi.spyOn(durable, "accept");
      const httpServer = await listen();
      let remote = startRemoteWorkletServer(httpServer);
      const client = await connectWorklet({
        url: workletUrl(httpServer),
        credential: CREDENTIAL,
        worklet,
        durableWorklet: durable,
        protocolVersions: [18],
      });
      clients.push(client);
      const spec = taskAttemptSpec();
      const expectReserved = async () => {
        expect(await remote.canExecute(spec.workerProfile, spec.contextPlan)).toBe(false);
        expect(
          await remote.selectExecution({ profile: spec.workerProfile }, spec.contextPlan),
        ).toBeUndefined();
        await expect(
          remote.accept({ ...spec, attemptId: "must-remain-queued" }),
        ).rejects.toBeInstanceOf(WorkletAdmissionRejectedError);
        expect(accept).toHaveBeenCalledTimes(1);
      };
      try {
        await remote.accept(spec);
        release.resolve();
        await vi.waitFor(async () =>
          expect((await inspect(spec.attemptId))?.status).toBe("unknown"),
        );
        expect((await remote.inspect(spec.attemptId))?.status).toBe("unknown");
        await expectReserved();
        // Socket replacement cannot free the already known reservation before inspection.
        await client.stop();
        await client.start();
        await expectReserved();
        // A replacement Control Plane has no prior reservation: its receipt must reconstruct it.
        await client.stop();
        if (!identifiesWorker) {
          const describe = worklet.describe;
          worklet.describe = async () => {
            const descriptor = await describe();
            const worker = descriptor.host.workers[0];
            if (!worker) throw new Error("Fixture Worker missing");
            return {
              ...descriptor,
              host: {
                ...descriptor.host,
                workers: [
                  ...descriptor.host.workers,
                  {
                    ...worker,
                    id: "other-worker",
                    profiles: [{ id: "other", revision: "1" }],
                    profileCapabilities: [{ id: "other", revision: "1" }].map((profile) => ({
                      profile,
                      capabilities: worker.capabilities,
                      contextTypes: worker.contextTypes,
                    })),
                  },
                ],
              },
            };
          };
        }
        await remote.stop();
        remote = startRemoteWorkletServer(httpServer);
        await client.start();
        expect((await remote.inspect(spec.attemptId))?.status).toBe("unknown");
        await expectReserved();
        expect(await remote.listWorkerHosts()).toEqual([
          expect.objectContaining({
            activeAttempts: 1,
            capacity: identifiesWorker ? 1 : 2,
            availableSlots: 0,
          }),
        ]);
        if (!identifiesWorker)
          expect(
            await remote.selectExecution(
              { profile: { id: "other", revision: "1" } },
              spec.contextPlan,
            ),
          ).toBeUndefined();
        confirmedTerminal = terminalStatus;
        expect((await remote.inspect(spec.attemptId))?.status).toBe(terminalStatus);
        expect(await remote.canExecute(spec.workerProfile, spec.contextPlan)).toBe(true);
        expect(
          await remote.selectExecution({ profile: spec.workerProfile }, spec.contextPlan),
        ).toEqual(spec.workerProfile);
        expect(await remote.listWorkerHosts()).toEqual([
          expect.objectContaining({
            activeAttempts: 0,
            capacity: identifiesWorker ? 1 : 2,
            availableSlots: identifiesWorker ? 1 : 2,
          }),
        ]);
        expect(worklet.execute).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await client.stop();
        await durable.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps durable cancellation capacity reserved until journaled cleanup completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-durable-cancel-"));
    const cleanup = deferred<void>();
    const started = deferred<void>();
    const worklet = testWorklet(async function* (spec) {
      started.resolve();
      await cleanup.promise;
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer);
    const client = await connectWorklet({
      url: workletUrl(httpServer),
      credential: CREDENTIAL,
      worklet,
      durableWorklet: durable,
    });
    clients.push(client);
    const spec = taskAttemptSpec();
    try {
      await remote.accept(spec);
      await started.promise;
      expect((await remote.cancel(spec.attemptId, "Obsolete work")).cancellationRequested).toBe(
        true,
      );
      expect(await remote.supportsDurableExecution(spec.workerProfile, spec.contextPlan)).toBe(
        true,
      );
      expect(await remote.canExecute(spec.workerProfile, spec.contextPlan)).toBe(false);
      await expect(
        collectTaskAttemptEvents(remote.execute({ ...spec, attemptId: "busy-attempt" })),
      ).rejects.toThrow("No durable Worklet");
      cleanup.resolve();
      await expect
        .poll(async () => (await remote.inspect(spec.attemptId))?.status)
        .toBe("cancelled");
      expect(await remote.canExecute(spec.workerProfile, spec.contextPlan)).toBe(true);
    } finally {
      cleanup.resolve();
      await client.stop();
      await expect
        .poll(async () => {
          try {
            await durable.close();
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(
    [[9], [10], [11], [12], [13], [14], [15], [16], [17], [999], [17, 18], [18, 18]].map(
      (protocolVersions) => ({ protocolVersions }),
    ),
  )("refuses client configuration for protocols $protocolVersions", ({ protocolVersions }) => {
    expect(
      () =>
        new WorkletConnection({
          url: "ws://127.0.0.1/worklets",
          credential: CREDENTIAL,
          worklet: testWorklet(async function* () {}),
          protocolVersions,
        }),
    ).toThrow("Only Worklet protocol 18 is supported");
  });

  it("does not borrow unrelated Worker profile capacity on a mixed host", async () => {
    const httpServer = await listen();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const worklet = testWorklet(async function* (spec) {
      started.push(spec.workerProfile.id);
      await blocked;
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const descriptor = await worklet.describe();
    const base = descriptor.host.workers[0];
    if (!base) throw new Error("Missing test Worker");
    worklet.describe = async () => ({
      ...descriptor,
      host: {
        ...descriptor.host,
        workers: [
          base,
          {
            ...base,
            id: "other-worker",
            profiles: [{ id: "other", revision: "1" }],
            profileCapabilities: [{ id: "other", revision: "1" }].map((profile) => ({
              profile,
              capabilities: base.capabilities,
              contextTypes: base.contextTypes,
            })),
          },
        ],
      },
    });
    const remote = startRemoteWorkletServer(httpServer);
    clients.push(
      await connectWorklet({ url: workletUrl(httpServer), credential: CREDENTIAL, worklet }),
    );
    const first = collectTaskAttemptEvents(remote.execute(taskAttemptSpec()));
    await expect.poll(() => started.length).toBe(1);
    expect(await remote.canExecute({ id: "default", revision: "1" }, emptyTagContextPlan())).toBe(
      false,
    );
    expect(await remote.canExecute({ id: "other", revision: "1" }, emptyTagContextPlan())).toBe(
      true,
    );
    await expect(
      collectTaskAttemptEvents(remote.execute({ ...taskAttemptSpec(), attemptId: "at-capacity" })),
    ).rejects.toThrow("No durable Worklet");
    const other = collectTaskAttemptEvents(
      remote.execute(taskAttemptSpec({ id: "other", revision: "1" }, "other-task")),
    );
    await expect.poll(() => started.length).toBe(2);
    release?.();
    await Promise.all([first, other]);
    expect(await remote.canExecute({ id: "default", revision: "1" }, emptyTagContextPlan())).toBe(
      true,
    );
  });

  it("drains 100 queued logical Tags across two bounded remote hosts without starvation", async () => {
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer);
    const active = [0, 0],
      peak = [0, 0],
      completed = [0, 0];
    for (let host = 0; host < 2; host++) {
      const worklet = testWorklet(
        async function* (spec) {
          active[host] = (active[host] ?? 0) + 1;
          peak[host] = Math.max(peak[host] ?? 0, active[host] ?? 0);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active[host] = (active[host] ?? 1) - 1;
          completed[host] = (completed[host] ?? 0) + 1;
          yield taskAttemptEvent(spec, { type: "execution.completed" });
        },
        { workletId: `host-${host}`, maxConcurrency: 4 },
      );
      clients.push(
        await connectWorklet({ url: workletUrl(httpServer), credential: CREDENTIAL, worklet }),
      );
    }
    const queue = Array.from({ length: 100 }, (_, index) => ({
      ...taskAttemptSpec(undefined, `task-${index}`),
      tag: { id: `tag-${index}`, name: `Tag ${index}` },
    }));
    const finished = new Set<string>();
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (true) {
          const spec = queue.shift();
          if (!spec) return;
          const events = await collectTaskAttemptEvents(remote.execute(spec));
          expect(events.at(-1)?.type).toBe("execution.completed");
          finished.add(spec.tag.id);
        }
      }),
    );
    expect(finished.size).toBe(100);
    expect(peak).toEqual([4, 4]);
    expect(completed.every((count) => count > 0)).toBe(true);
    expect(active).toEqual([0, 0]);
  });

  it("rejects malformed nested profile capabilities before registration and remains usable", async () => {
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer);
    const worklet = testWorklet(async function* (spec) {
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const descriptor = await worklet.describe();
    const socket = new WebSocket(workletUrl(httpServer));
    await new Promise<void>((resolve) => socket.once("open", resolve));
    try {
      for (const invalid of [
        { capabilities: [null], contextTypes: [] },
        { capabilities: [{ id: "", version: 1 }], contextTypes: [] },
        { capabilities: [{ id: "example", version: 0 }], contextTypes: [] },
        { capabilities: [{ id: "example", version: 1.5 }], contextTypes: [] },
        { capabilities: [], contextTypes: [null] },
        { capabilities: [], contextTypes: [{ type: "", versions: [1] }] },
        { capabilities: [], contextTypes: [{ type: "example", versions: [] }] },
        { capabilities: [], contextTypes: [{ type: "example", versions: ["1"] }] },
      ]) {
        const response = new Promise<Record<string, unknown>>((resolve) =>
          socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
        );
        socket.send(
          JSON.stringify({
            type: "hello",
            protocolVersions: [18],
            credential: CREDENTIAL,
            worklet: {
              ...descriptor,
              host: {
                ...descriptor.host,
                workers: descriptor.host.workers.map((worker) => ({
                  ...worker,
                  profileCapabilities: [{ profile: { id: "default", revision: "1" }, ...invalid }],
                })),
              },
            },
          }),
        );
        expect(await response).toMatchObject({ type: "protocol_error", code: "invalid_message" });
        expect(remote.workletRegistrations).toEqual([]);
      }
    } finally {
      socket.close();
    }
    clients.push(
      await connectWorklet({ url: workletUrl(httpServer), credential: CREDENTIAL, worklet }),
    );
    await collectTaskAttemptEvents(remote.execute(taskAttemptSpec()));
    expect(worklet.execute).toHaveBeenCalledOnce();
  });

  it("rejects unbounded Worker Host capacity before authentication", async () => {
    const httpServer = await listen();
    const authenticateWorklet = vi.fn(async () => ({ connectionGeneration: 1 }));
    startRemoteWorkletServer(httpServer, {
      authenticateWorklet,
    });
    const descriptor = await testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workerHostId: "unbounded-host" },
    ).describe();
    const socket = new WebSocket(workletUrl(httpServer));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersions: [18],
        credential: "credential",
        worklet: {
          ...descriptor,
          host: {
            ...descriptor.host,
            workers: descriptor.host.workers.map((worker) => ({
              ...worker,
              maxConcurrency: 1_001,
            })),
          },
        },
      }),
    );

    await expect(response).resolves.toMatchObject({
      type: "protocol_error",
      code: "invalid_message",
    });
    expect(authenticateWorklet).not.toHaveBeenCalled();
    socket.close();
  });

  it("retains a cancelled remote reservation until host cleanup completes", async () => {
    const httpServer = await listen();
    const started = deferred<void>();
    const cleanup = deferred<void>();
    const worklet = testWorklet(async function* (spec) {
      if (spec.taskId === "cancelled") {
        started.resolve();
        await cleanup.promise;
      }
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    });
    const remote = startRemoteWorkletServer(httpServer);
    clients.push(
      await connectWorklet({ url: workletUrl(httpServer), credential: CREDENTIAL, worklet }),
    );
    const abort = new AbortController();
    const cancelled = collectTaskAttemptEvents(
      remote.execute(taskAttemptSpec(undefined, "cancelled"), abort.signal),
    ).catch((error: unknown) => error);
    await started.promise;
    abort.abort(new Error("cancelled"));
    await cancelled;
    try {
      expect(
        await remote.canExecute(
          { id: "default", revision: "1" },
          emptyTagContextPlan(new Date().toISOString()),
        ),
      ).toBe(false);
    } finally {
      cleanup.resolve();
    }
    await expect
      .poll(() =>
        remote.canExecute(
          { id: "default", revision: "1" },
          emptyTagContextPlan(new Date().toISOString()),
        ),
      )
      .toBe(true);
    await collectTaskAttemptEvents(remote.execute(taskAttemptSpec(undefined, "replacement")));
    expect(worklet.execute).toHaveBeenCalledTimes(2);
  });

  it("schedules across Worker Hosts by profile and drains hosts through their Worklets", async () => {
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer);
    const defaultWorklet = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, {
          type: "output.message",
          message: { role: "teammate", text: "default worklet" },
        });
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workletId: "worklet-default", workerId: "worker-default" },
    );
    const researchWorklet = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, {
          type: "output.message",
          message: { role: "teammate", text: "research worklet" },
        });
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      {
        workletId: "worklet-research",
        workerHostId: "research-host",
        workerId: "worker-research",
        profiles: [{ id: "research", revision: "2" }],
      },
    );
    await startWorkletClient(httpServer, defaultWorklet).start();
    await startWorkletClient(httpServer, researchWorklet).start();

    await expect(remote.listWorkerHosts()).resolves.toHaveLength(2);
    await expect(
      remote.canExecute(
        { id: "research", revision: "2" },
        emptyTagContextPlan("2026-08-01T00:00:00.000Z"),
      ),
    ).resolves.toBe(true);
    const research = await collectTaskAttemptEvents(
      remote.execute(taskAttemptSpec({ id: "research", revision: "2" }, "task-research")),
    );
    expect(terminalOutputText(research)).toBe("research worklet");
    expect(defaultWorklet.execute).not.toHaveBeenCalled();
    expect(researchWorklet.execute).toHaveBeenCalledOnce();

    await expect(remote.setHostDraining("research-host", true)).resolves.toBe(true);
    await expect(
      remote.canExecute(
        { id: "research", revision: "2" },
        emptyTagContextPlan("2026-08-01T00:00:00.000Z"),
      ),
    ).resolves.toBe(false);
    await expect(remote.listWorkerHosts()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptor: expect.objectContaining({ id: "research-host" }),
          workletId: "worklet-research",
          conditions: expect.arrayContaining([
            expect.objectContaining({ type: "Draining", status: true }),
            expect.objectContaining({ type: "Ready", status: false }),
          ]),
          availableSlots: 0,
        }),
      ]),
    );
  });

  it("marks a Worker Host unreachable after its Worklet disconnects", async () => {
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer);
    const client = startWorkletClient(
      httpServer,
      testWorklet(
        async function* (spec) {
          yield taskAttemptEvent(spec, { type: "execution.completed" });
        },
        { workletId: "ephemeral-worklet" },
      ),
    );
    await client.start();
    await client.stop();

    await vi.waitFor(async () => {
      const workerHosts = await remote.listWorkerHosts();
      expect(workerHosts).toEqual([
        expect.objectContaining({
          descriptor: expect.objectContaining({ id: "ephemeral-worklet-host" }),
          workletId: "ephemeral-worklet",
          conditions: expect.arrayContaining([
            expect.objectContaining({ type: "Connected", status: false }),
            expect.objectContaining({ type: "Unreachable", status: true }),
          ]),
        }),
      ]);
    });
  });

  it("routes required custom Context types only to a compatible Worker", async () => {
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer);
    const incompatible = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workletId: "plain-worklet" },
    );
    const compatible = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, {
          type: "output.message",
          message: { role: "teammate", text: "custom context worklet" },
        });
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      {
        workletId: "context-worklet",
        contextTypes: [{ type: "acme.io/runbook", versions: [1] }],
      },
    );
    await startWorkletClient(httpServer, incompatible).start();
    await startWorkletClient(httpServer, compatible).start();
    const base = taskAttemptSpec();
    const spec: TaskAttemptSpec = {
      ...base,
      contextPlan: {
        version: 7,
        capturedAt: "2026-08-02T00:00:00.000Z",
        sets: [
          {
            id: "set-1",
            name: "operations",
            items: [
              {
                id: "runbook-1",
                itemKey: "runbook:payments",
                type: "acme.io/runbook",
                version: 1,
                required: true,
                config: { name: "payments" },
              },
            ],
          },
        ],
      },
    };

    await expect(remote.canExecute(spec.workerProfile, spec.contextPlan)).resolves.toBe(true);
    await expect(collectTaskAttemptEvents(remote.execute(spec))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "output.message",
          message: { role: "teammate", text: "custom context worklet" },
        }),
      ]),
    );
    expect(incompatible.execute).not.toHaveBeenCalled();
    expect(compatible.execute).toHaveBeenCalledOnce();
  });

  it("accounts for advertised concurrency before assigning more work", async () => {
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer);
    const release = deferred<void>();
    const worklet = testWorklet(
      async function* (spec) {
        yield taskAttemptEvent(spec, { type: "execution.started", workerId: "parallel-worker" });
        await release.promise;
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      },
      { workletId: "parallel-worklet", workerId: "parallel-worker", maxConcurrency: 2 },
    );
    await startWorkletClient(httpServer, worklet).start();

    const first = collectTaskAttemptEvents(remote.execute(taskAttemptSpec(undefined, "task-a")));
    const second = collectTaskAttemptEvents(remote.execute(taskAttemptSpec(undefined, "task-b")));
    await vi.waitFor(() => expect(worklet.execute).toHaveBeenCalledTimes(2));
    await expect(
      remote.canExecute(
        { id: "default", revision: "1" },
        emptyTagContextPlan("2026-08-01T00:00:00.000Z"),
      ),
    ).resolves.toBe(false);
    await expect(remote.listWorkerHosts()).resolves.toEqual([
      expect.objectContaining({ activeAttempts: 2, capacity: 2, availableSlots: 0 }),
    ]);

    release.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await expect(
      remote.canExecute(
        { id: "default", revision: "1" },
        emptyTagContextPlan("2026-08-01T00:00:00.000Z"),
      ),
    ).resolves.toBe(true);
  });

  it("marks a Worker Host unreachable when its Worklet heartbeat lease expires", async () => {
    const httpServer = await listen();
    const remote = startRemoteWorkletServer(httpServer, { heartbeatTimeoutMs: 100 });
    const socket = new WebSocket(workletUrl(httpServer));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersions: [18],
        credential: CREDENTIAL,
        worklet: {
          id: "silent-worklet",
          protocolVersion: 1,
          durableProtocolVersion: 1,
          host: {
            id: "silent-host",
            workers: [
              {
                profileCapabilities: [
                  { profile: { id: "default", revision: "1" }, capabilities: [], contextTypes: [] },
                ],
                id: "silent-worker",
                type: "test",
                capabilities: [],
                profiles: [{ id: "default", revision: "1" }],
                contextTypes: [],
              },
            ],
          },
        },
      }),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("message", () => resolve());
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });

    await expect(closed).resolves.toBe(4005);
    await vi.waitFor(async () => {
      await expect(remote.listWorkerHosts()).resolves.toEqual([
        expect.objectContaining({
          descriptor: expect.objectContaining({ id: "silent-host" }),
          workletId: "silent-worklet",
          conditions: expect.arrayContaining([
            expect.objectContaining({ type: "Unreachable", status: true }),
          ]),
        }),
      ]);
    });
  });
});

function startRemoteWorkletServer(
  server: Server,
  overrides: Partial<ConstructorParameters<typeof RemoteWorkletServer>[0]> = {},
): RemoteWorkletServer {
  const remote = new RemoteWorkletServer({
    server,
    authenticateWorklet: sharedTokenAuthentication(CREDENTIAL),
    path: "/worklets",
    heartbeatIntervalMs: 20,
    // Ordinary transport tests must tolerate scheduling delays in the full suite.
    // Tests exercising expiry or acknowledgement failure set their own short deadlines.
    heartbeatTimeoutMs: 2_000,
    durableAcknowledgementTimeoutMs: 2_000,
    ...overrides,
  });
  remote.start();
  remoteWorkletServers.push(remote);
  return remote;
}

async function rawWorkletConnection(
  server: Server,
  descriptor: WorkletDescriptor,
  credential: string,
): Promise<{ socket: WebSocket; ready: Record<string, unknown> }> {
  const socket = new WebSocket(workletUrl(server));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersions: [18],
      credential,
      worklet: descriptor,
    }),
  );
  return { socket, ready: await ready };
}

function startWorkletClient(server: Server, worklet: Worklet): WorkletConnection {
  const client = new WorkletConnection({
    url: workletUrl(server),
    credential: CREDENTIAL,
    worklet,
    durableWorklet: durableFor(worklet),
    reconnectIntervalMs: 5,
  });
  clients.push(client);
  return client;
}

function testWorklet(
  stream: (spec: TaskAttemptSpec, signal?: AbortSignal) => AsyncIterable<TaskAttemptEvent>,
  options: {
    readonly workletId?: string;
    readonly workerHostId?: string;
    readonly workerId?: string;
    readonly profiles?: readonly { readonly id: string; readonly revision: string }[];
    readonly contextTypes?: readonly {
      readonly type: string;
      readonly versions: readonly number[];
    }[];
    readonly maxConcurrency?: number;
  } = {},
): Worklet & {
  execute: ReturnType<typeof vi.fn<Worklet["execute"]>>;
  executeOnWorker: (
    workerId: string,
    spec: TaskAttemptSpec,
    signal?: AbortSignal,
  ) => AsyncIterable<TaskAttemptEvent>;
} {
  const execute = vi.fn(stream);
  return {
    id: options.workletId ?? "local-worklet",
    describe: async () => ({
      id: options.workletId ?? "local-worklet",
      protocolVersion: 1,
      durableProtocolVersion: 1,
      controlProtocolVersion: 1,
      host: {
        id: options.workerHostId ?? `${options.workletId ?? "local-worklet"}-host`,
        workers: [
          {
            id: options.workerId ?? "local-static",
            type: "test",
            capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
            profiles: options.profiles ?? [{ id: "default", revision: "1" }],
            contextTypes: options.contextTypes ?? [],
            ...(options.maxConcurrency === undefined
              ? {}
              : { maxConcurrency: options.maxConcurrency }),
            profileCapabilities: (options.profiles ?? [{ id: "default", revision: "1" }]).map(
              (profile) => ({
                profile,
                capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
                contextTypes: options.contextTypes ?? [],
              }),
            ),
          },
        ],
      },
    }),
    execute,
    executeOnWorker: (_workerId: string, spec: TaskAttemptSpec, signal?: AbortSignal) =>
      execute(spec, signal),
  };
}

function taskAttemptEvent(
  spec: TaskAttemptSpec,
  event: Omit<TaskAttemptEvent, "taskId" | "attemptId" | "at">,
): TaskAttemptEvent {
  return {
    ...event,
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    at: "2026-08-02T00:00:00.000Z",
  } as TaskAttemptEvent;
}

function taskAttemptSpec(
  workerProfile = { id: "default", revision: "1" },
  taskId = "task-1",
): TaskAttemptSpec {
  const capturedAt = "2026-08-02T00:00:00.000Z";
  return {
    version: 2,
    taskId,
    attemptId: `${taskId}-attempt-1`,
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "github",
        accountId: "account-1",
        scope: "repository:supertag/remote-simulation",
        sessionKey: "github:supertag/remote-simulation:1",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text: "execute this on the worklet" }],
    },
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "tag-1", name: "Engineering" },
      origin: {
        tagRouteId: "surface-1",
        surfaceAccountId: "account-1",
        provider: "github",
        scope: "repository:supertag/remote-simulation",
      },
      requester: { id: "user-1", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    workspacePlan: { version: 1, status: "none" },
    contextPlan: emptyTagContextPlan(capturedAt),
    execution: {},
    workerProfile,
  };
}

async function listen(): Promise<Server> {
  const server = createServer((_request, response) => response.writeHead(404).end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return server;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function workletUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}/worklets`;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
