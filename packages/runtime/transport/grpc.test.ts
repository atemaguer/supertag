import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { create, toBinary } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { describe, expect, it, vi } from "vitest";
import { sharedTokenAuthentication } from "../../../tests/support/worklet-authentication.js";
import { emptyTagContextPlan } from "../../core/src/index.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worker,
  type Worklet,
  type WorkletDescriptor,
} from "../sdk/src/index.js";
import { DurableControlPlaneProtocol } from "./src/durable-protocol.js";
import {
  ConnectRequestSchema,
  ConnectResponseSchema,
  WorkletService,
} from "./src/gen/supertag/worklet/v1/worklet_pb.js";
import { WorkletFrameQueue } from "./src/grpc.js";
import {
  decodeControlFrame,
  decodeHostFrame,
  encodeControlFrame,
  encodeHostFrame,
} from "./src/grpc-codec.js";
import { RemoteWorkletServer, startWorkletGrpcServer, WorkletConnection } from "./src/index.js";

describe("Worklet gRPC contract", () => {
  it("round-trips bounded changed paths for several Task Attempts", () => {
    const at = "2026-10-03T00:00:00.000Z";
    const changedPaths = [
      { attemptId: "attempt-a", paths: ["src/a.ts", "src/old.ts"], truncated: false },
      { attemptId: "attempt-b", paths: [], truncated: true },
    ];
    expect(decodeHostFrame(encodeHostFrame({ type: "heartbeat", at, changedPaths }), "c")).toEqual({
      type: "heartbeat",
      at,
      changedPaths,
    });
    expect(() =>
      encodeHostFrame({
        type: "heartbeat",
        at,
        changedPaths: [
          {
            attemptId: "attempt-a",
            paths: Array.from({ length: 501 }, (_, i) => `p${i}`),
            truncated: true,
          },
        ],
      }),
    ).toThrow();
  });
  it("round-trips heartbeat host labels and leaves them unset when unchanged", () => {
    const at = "2026-10-03T00:00:00.000Z";
    expect(
      decodeHostFrame(
        encodeHostFrame({ type: "heartbeat", at, hostLabels: ["mcp-login:notion", "os:macos"] }),
        "c",
      ),
    ).toEqual({ type: "heartbeat", at, hostLabels: ["mcp-login:notion", "os:macos"] });
    expect(decodeHostFrame(encodeHostFrame({ type: "heartbeat", at }), "c")).toEqual({
      type: "heartbeat",
      at,
    });
  });

  it("round-trips Worker Host disk space on a heartbeat", () => {
    const at = "2026-10-03T00:00:00.000Z";
    const diskSpace = { freeBytes: 4 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 };
    expect(decodeHostFrame(encodeHostFrame({ type: "heartbeat", at, diskSpace }), "c")).toEqual({
      type: "heartbeat",
      at,
      diskSpace,
    });
  });

  it("round-trips heartbeat Worker concurrency and rejects a limit outside 1 through 1000", () => {
    const at = "2026-10-03T00:00:00.000Z";
    const workerConcurrency = { "local-codex": 6, "local-claude-code": 6 };
    expect(
      decodeHostFrame(encodeHostFrame({ type: "heartbeat", at, workerConcurrency }), "c"),
    ).toEqual({ type: "heartbeat", at, workerConcurrency });
    expect(() =>
      encodeHostFrame({ type: "heartbeat", at, workerConcurrency: { "local-codex": 0 } }),
    ).toThrow("from 1 through 1000");
    expect(() =>
      encodeHostFrame({ type: "heartbeat", at, workerConcurrency: { "local-codex": 1_001 } }),
    ).toThrow("from 1 through 1000");
  });

  it("rejects missing profile capability maps at both protobuf boundaries", async () => {
    const descriptor = {
      ...(await testWorklet(async function* () {}).describe()),
      durableProtocolVersion: 1 as const,
    };
    const missing = {
      ...descriptor,
      host: {
        ...descriptor.host,
        workers: descriptor.host.workers.map(({ profileCapabilities: _, ...worker }) => worker),
      },
    } as WorkletDescriptor;
    expect(() =>
      encodeHostFrame({ type: "hello", protocolVersions: [18], worklet: missing }),
    ).toThrow("profileCapabilities");
    const frame = encodeHostFrame({ type: "hello", protocolVersions: [18], worklet: descriptor });
    if (frame.frame.case !== "hello" || !frame.frame.value.workers[0])
      throw new Error("Missing fixture Worker");
    frame.frame.value.workers[0].profileCapabilities = undefined;
    expect(() => decodeHostFrame(frame, "credential")).toThrow("profileCapabilities");
  });

  it("keeps host credentials out of protobuf and preserves typed descriptor identity", async () => {
    const descriptor = await testWorklet(async function* () {}).describe();
    const frame = encodeHostFrame({
      type: "hello",
      protocolVersions: [18],
      credential: "never-in-protobuf",
      worklet: { ...descriptor, durableProtocolVersion: 1 },
    });
    expect(Buffer.from(toBinary(ConnectRequestSchema, frame)).includes("never-in-protobuf")).toBe(
      false,
    );
    expect(decodeHostFrame(frame, "from-metadata")).toMatchObject({
      credential: "from-metadata",
      worklet: { host: descriptor.host },
    });
    const emptyProfileSet = {
      ...descriptor,
      durableProtocolVersion: 1 as const,
      host: {
        ...descriptor.host,
        workers: descriptor.host.workers.map((worker) => ({ ...worker, profileCapabilities: [] })),
      },
    };
    expect(
      decodeHostFrame(
        encodeHostFrame({ type: "hello", protocolVersions: [18], worklet: emptyProfileSet }),
        "credential",
      ),
    ).toMatchObject({ worklet: emptyProfileSet });
    expect(() =>
      decodeHostFrame(create(ConnectRequestSchema, { wireVersion: 2 }), "credential"),
    ).toThrow("wire version");
    expect(() => decodeControlFrame(create(ConnectResponseSchema, { wireVersion: 1 }))).toThrow(
      "unsupported",
    );
    expect(() =>
      encodeHostFrame({ type: "hello", protocolVersions: [13], worklet: descriptor }),
    ).toThrow("protocol 18");
  });
  it("round-trips protocol 18 handshakes", async () => {
    const descriptor = await testWorklet(async function* () {}).describe();
    for (const protocolVersion of [18]) {
      const hello = {
        type: "hello" as const,
        protocolVersions: [protocolVersion],
        worklet: { ...descriptor, durableProtocolVersion: 1 as const },
      };
      expect(decodeHostFrame(encodeHostFrame(hello), "credential")).toMatchObject({
        protocolVersions: [protocolVersion],
      });
      expect(
        decodeControlFrame(
          encodeControlFrame({
            type: "ready",
            protocolVersion,
            heartbeatIntervalMs: 1,
            connectionGeneration: 1,
          }),
        ),
      ).toMatchObject({ protocolVersion });
    }
  });
  it.each([15, 16, 17, 19])(
    "rejects protocol %s at every gRPC handshake boundary",
    async (protocolVersion) => {
      const descriptor = await testWorklet(async function* () {}).describe();
      const hello = {
        type: "hello" as const,
        protocolVersions: [18],
        worklet: { ...descriptor, durableProtocolVersion: 1 as const },
      };
      const ready = {
        type: "ready" as const,
        protocolVersion: 18,
        heartbeatIntervalMs: 1,
        connectionGeneration: 1,
      };
      expect(() => encodeHostFrame({ ...hello, protocolVersions: [protocolVersion] })).toThrow();
      const hostFrame = encodeHostFrame(hello);
      if (hostFrame.frame.case !== "hello") throw new Error("fixture");
      hostFrame.frame.value.protocolVersions = [protocolVersion];
      expect(() => decodeHostFrame(hostFrame, "credential")).toThrow();
      const controlFrame = encodeControlFrame(ready);
      if (controlFrame.frame.case !== "ready") throw new Error("fixture");
      controlFrame.frame.value.protocolVersion = protocolVersion;
      expect(() => decodeControlFrame(controlFrame)).toThrow();
      expect(() => encodeControlFrame({ ...ready, protocolVersion })).toThrow();
      expect(
        () =>
          new WorkletConnection({
            url: "https://fixture.invalid",
            credential: "credential",
            worklet: testWorklet(async function* () {}),
            durableWorklet: {} as never,
            protocolVersions: [protocolVersion],
          }),
      ).toThrow(/protocol 18/);
    },
  );
  it.each([9, 10, 11, 12, 13, 14, 15, 16, 17])(
    "rejects protocol %s gRPC hellos",
    async (version) => {
      const worklet = {
        ...(await testWorklet(async function* () {}).describe()),
        durableProtocolVersion: 1 as const,
      };
      expect(() =>
        encodeHostFrame({ type: "hello", protocolVersions: [version], worklet }),
      ).toThrow("protocol 18");
      const frame = encodeHostFrame({ type: "hello", protocolVersions: [18], worklet });
      if (frame.frame.case !== "hello") throw new Error("Expected hello");
      frame.frame.value.protocolVersions = [version];
      expect(() => decodeHostFrame(frame, "credential")).toThrow("protocol 18");
    },
  );
  it("round-trips protocol 17 placement commands with presence-bearing options", () => {
    const contextPlan = emptyTagContextPlan("2026-08-02T00:00:00.000Z");
    const request = {
      type: "durable_request" as const,
      operation: "select_placement" as const,
      requestId: "select-1",
      requirements: { profile: { id: "codex", revision: "profile-revision-2" } },
      contextPlan,
      options: {
        requiresCoordination: false,
        requiresSurfaceCoordination: false,
        coordinationSlot: true,
        compatibleProfile: { id: "codex", revision: "profile-revision-2" },
        allowedWorkerHostIds: [],
      },
    };
    const encoded = encodeControlFrame(request);
    if (encoded.frame.case !== "selectPlacement") throw new Error("fixture");
    expect(encoded.frame.value.options?.requiresCoordination).toBe(false);
    expect(encoded.frame.value.options?.requiresSurfaceCoordination).toBe(false);
    expect(encoded.frame.value.options?.coordinationSlot).toBe(true);
    expect(encoded.frame.value.options?.allowedWorkerHostIds?.ids).toEqual([]);
    expect(decodeControlFrame(encoded)).toEqual(request);

    const unrestricted = encodeControlFrame({
      ...request,
      requestId: "select-2",
      options: {},
    });
    if (unrestricted.frame.case !== "selectPlacement") throw new Error("fixture");
    expect(unrestricted.frame.value.options?.allowedWorkerHostIds).toBeUndefined();
    expect(decodeControlFrame(unrestricted)).toEqual({
      ...request,
      requestId: "select-2",
      options: {},
    });
  });
  it("round-trips typed placement, no-placement and release results", () => {
    const placement = {
      workerHostId: "host-1",
      workletId: "worklet-1",
      workerId: "worker-1",
      workerProfile: { id: "codex", revision: "profile-revision-2" },
      reservation: { id: "reservation-1", expiresAt: "2026-08-02T00:00:30.000Z" },
    };
    const selection = {
      type: "durable_reply" as const,
      requestId: "select-1",
      resultKind: "placement" as const,
      result: placement,
    };
    expect(decodeHostFrame(encodeHostFrame(selection), "credential")).toEqual(selection);

    const unavailable = {
      type: "durable_reply" as const,
      requestId: "select-2",
      resultKind: "no_placement" as const,
      result: undefined,
    };
    expect(decodeHostFrame(encodeHostFrame(unavailable), "credential")).toEqual(unavailable);

    const release = {
      type: "durable_request" as const,
      operation: "release_placement" as const,
      requestId: "release-1",
      placement,
    };
    expect(decodeControlFrame(encodeControlFrame(release))).toEqual(release);
    const released = {
      type: "durable_reply" as const,
      requestId: "release-1",
      resultKind: "placement_release" as const,
      result: { released: true },
    };
    expect(decodeHostFrame(encodeHostFrame(released), "credential")).toEqual(released);
  });
  it("validates named documents, digest and envelope identities before dispatch", () => {
    const spec = taskAttemptSpec();
    const encoded = encodeControlFrame({
      type: "durable_request",
      operation: "accept",
      requestId: "accept",
      spec,
    });
    expect(decodeControlFrame(encoded)).toEqual({
      type: "durable_request",
      operation: "accept",
      requestId: "accept",
      spec,
    });
    if (encoded.frame.case !== "accept" || !encoded.frame.value.spec?.taskAttemptSpec)
      throw new Error("fixture");
    encoded.frame.value.spec.taskId = "other";
    expect(() => decodeControlFrame(encoded)).toThrow("identity or digest");
    encoded.frame.value.spec.taskId = spec.taskId;
    encoded.frame.value.spec.taskAttemptSpec.version = 2;
    expect(() => decodeControlFrame(encoded)).toThrow("schema document");
    expect(() =>
      encodeControlFrame({
        type: "durable_request",
        operation: "events",
        requestId: "events",
        attemptId: "attempt",
        afterSequence: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow("Unsafe");
  });
  it("round-trips take requests and fail-closed authorization responses", () => {
    const take = { type: "control_take" as const, requestId: "control" };
    expect(decodeHostFrame(encodeHostFrame(take), "connection")).toEqual(take);
    for (const allowed of [true, false]) {
      const answer = { type: "control_take_result" as const, requestId: "control", allowed };
      expect(decodeControlFrame(encodeControlFrame(answer))).toEqual(answer);
    }
  });

  it("preserves explicit zero, false, control inputs, receipts and event identity", () => {
    const message = {
      type: "durable_reply" as const,
      requestId: "inspect",
      result: {
        taskId: "task",
        attemptId: "attempt",
        specDigest: "digest",
        status: "running",
        lastSequence: 0,
        cancellationRequested: false,
      },
    };
    expect(decodeHostFrame(encodeHostFrame(message), "")).toEqual(message);
    const control = {
      type: "durable_request" as const,
      operation: "control" as const,
      requestId: "control",
      attemptId: "attempt",
      command: {
        id: "input",
        taskId: "task",
        attemptId: "attempt",
        type: "input" as const,
        text: "continue",
      },
    };
    expect(decodeControlFrame(encodeControlFrame(control))).toEqual(control);
    // Advisory input, such as Team coordination, keeps its flag across the wire.
    const advisory = {
      ...control,
      command: {
        ...control.command,
        advisory: true,
        requiresInputAuthorization: true,
        origin: { kind: "peer" as const, from: "lead-tag" },
      },
    };
    expect(decodeControlFrame(encodeControlFrame(advisory))).toEqual(advisory);
    const event = encodeHostFrame({
      type: "durable_event",
      requestId: "events",
      item: {
        sequence: 1,
        event: taskAttemptEvent(taskAttemptSpec(), { type: "execution.completed" }),
      },
    });
    if (event.frame.case !== "event") throw new Error("fixture");
    event.frame.value.attemptId = "forged";
    expect(() => decodeHostFrame(event, "")).toThrow("identity mismatch");
  });
  it("reserves bounded queue capacity for control while preserving output order", async () => {
    const queue = new WorkletFrameQueue<string>(16, 1024);
    for (let i = 0; i < 12; i++) queue.push(`event-${i}`, 16, false);
    expect(() => queue.push("overflow", 16, false)).toThrow("queue exhausted");
    queue.push("cancellation-receipt", 16, true);
    queue.end();
    const start = performance.now();
    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("cancellation-receipt");
    expect(performance.now() - start).toBeLessThan(100);
    const rest = [];
    for await (const item of { [Symbol.asyncIterator]: () => iterator }) rest.push(item);
    expect(rest).toEqual(Array.from({ length: 12 }, (_, i) => `event-${i}`));
    expect(() => queue.push("closed", 1, true)).toThrow("closed");
  });
  it("rejects non-durable clients and plaintext non-loopback endpoints", async () => {
    const worklet = testWorklet(async function* () {});
    expect(
      () =>
        new WorkletConnection({
          transport: "grpc",
          url: "http://127.0.0.1",
          credential: "x",
          worklet,
        }),
    ).toThrow("durableWorklet");
    const remote = new RemoteWorkletServer({
      server: createServer(),
      authenticateWorklet: sharedTokenAuthentication("x"),
    });
    await expect(startWorkletGrpcServer({ remote, host: "0.0.0.0" })).rejects.toThrow("TLS");
  });
});

it("recovers a lost acceptance reply and reconnects observation without executing twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-journal-"));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worklet = testWorklet(async function* (spec) {
    yield taskAttemptEvent(spec, { type: "execution.started", workerId: "local-static" });
    await waiting;
    yield taskAttemptEvent(spec, { type: "execution.completed" });
  });
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  let generation = 0;
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: ({ credential }) =>
      credential === "credential" ? { connectionGeneration: ++generation } : undefined,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 1000,
    durableAcknowledgementTimeoutMs: 1000,
  });
  remote.start();
  let frontend = await startWorkletGrpcServer({ remote });
  const port = Number(new URL(frontend.url).port);
  const client = new WorkletConnection({
    url: frontend.url,
    transport: "grpc",
    credential: "credential",
    worklet,
    durableWorklet: durable,
    reconnectIntervalMs: 10,
  });
  const original = durable.accept.bind(durable);
  vi.spyOn(durable, "accept").mockImplementationOnce(async (spec) => {
    const receipt = await original(spec);
    await frontend.close();
    return receipt;
  });
  try {
    await client.start();
    expect(client.connectionGeneration).toBe(1);
    expect(remote.isHostConnectionLoopback("local-worklet-host", 1)).toBe(true);
    const spec = taskAttemptSpec();
    await expect(remote.accept(spec)).rejects.toThrow(/disconnected|unknown/i);
    frontend = await startWorkletGrpcServer({ remote, port });
    await vi.waitFor(() => expect(client.connectionGeneration).toBe(2));
    expect(remote.isHostConnectionLoopback("local-worklet-host", 1)).toBe(false);
    expect(remote.isHostConnectionLoopback("local-worklet-host", 2)).toBe(true);
    expect(await remote.inspect(spec.attemptId)).toMatchObject({
      attemptId: spec.attemptId,
      status: "running",
    });
    const observed = remote.events(spec.attemptId)[Symbol.asyncIterator]();
    const first = await observed.next();
    expect(first.value?.sequence).toBe(1);
    await observed.return?.();
    release();
    const rest = [];
    for await (const event of remote.events(spec.attemptId, 1)) rest.push(event);
    expect(rest.at(-1)?.event.type).toBe("execution.completed");
    expect(worklet.execute).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await client.stop();
    await frontend.close();
    await remote.stop();
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it("shares authentication and supersedes stale host connections through the original owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-auth-"));
  const worklet = testWorklet(async function* () {});
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  let generation = 0;
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: ({ credential }) =>
      credential === "credential" ? { connectionGeneration: ++generation } : undefined,
  });
  remote.start();
  const frontend = await startWorkletGrpcServer({ remote });
  const connect = (credential: string) =>
    new WorkletConnection({
      transport: "grpc",
      url: frontend.url,
      credential,
      worklet,
      durableWorklet: durable,
    });
  const first = connect("credential");
  const second = connect("credential");
  const invalid = connect("wrong");
  try {
    await expect(invalid.start()).rejects.toThrow("Authentication failed");
    await first.start();
    await second.start();
    await vi.waitFor(() => expect(first.isConnected).toBe(false));
    expect(second.connectionGeneration).toBe(2);
    expect(remote.workletRegistrations).toHaveLength(1);
  } finally {
    await Promise.all([first.stop(), second.stop(), invalid.stop()]);
    await frontend.close();
    await remote.stop();
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it("rejects and releases a protocol 17 placement outside the advertised Worker profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-placement-validation-"));
  const worklet = testWorklet(async function* () {});
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  const invalidPlacement = {
    workerHostId: "local-worklet-host",
    workletId: "local-worklet",
    workerId: "unadvertised-worker",
    workerProfile: { id: "default", revision: "1" },
    reservation: { id: "invalid-reservation", expiresAt: "2099-01-01T00:00:00.000Z" },
  };
  vi.spyOn(durable, "selectPlacement").mockResolvedValue(invalidPlacement);
  const release = vi.spyOn(durable, "releasePlacement").mockResolvedValue();
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: sharedTokenAuthentication("credential"),
  });
  remote.start();
  const frontend = await startWorkletGrpcServer({ remote });
  const client = new WorkletConnection({
    transport: "grpc",
    url: frontend.url,
    credential: "credential",
    worklet,
    durableWorklet: durable,
  });
  try {
    await client.start();
    await expect(
      remote.selectPlacement({}, emptyTagContextPlan("2026-08-02T00:00:00.000Z"), {
        allowedWorkerHostIds: ["local-worklet-host"],
      }),
    ).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledWith(invalidPlacement);
  } finally {
    await client.stop();
    await frontend.close();
    await remote.stop();
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps a gRPC Worklet connected during a stalled Worker concurrency probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-heartbeat-"));
  let release!: (concurrency: Readonly<Record<string, number>>) => void;
  const slowConcurrency = new Promise<Readonly<Record<string, number>>>((resolve) => {
    release = resolve;
  });
  const worklet = {
    ...testWorklet(async function* () {}),
    workerConcurrency: () => slowConcurrency,
  };
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: sharedTokenAuthentication("credential"),
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 150,
  });
  remote.start();
  const frontend = await startWorkletGrpcServer({ remote });
  const client = new WorkletConnection({
    url: frontend.url,
    transport: "grpc",
    credential: "credential",
    worklet,
    durableWorklet: durable,
  });
  try {
    await client.start();
    await delay(350);
    expect(remote.isWorkletConnected).toBe(true);
    expect(client.isConnected).toBe(true);
  } finally {
    release({});
    await client.stop();
    await frontend.close();
    await remote.stop();
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it.each([false, true])(
  "bounds host label probes across timeout and reconnect (%s)",
  async (reconnect) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-label-timeout-"));
    let release!: (labels: readonly string[]) => void;
    const stalledLabels = new Promise<readonly string[]>((resolve) => {
      release = resolve;
    });
    const hostLabels = vi
      .fn<NonNullable<Worklet["hostLabels"]>>()
      .mockImplementationOnce(() => stalledLabels)
      .mockResolvedValue(["os:linux"]);
    const worklet = { ...testWorklet(async function* () {}), hostLabels };
    const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
    const remote = new RemoteWorkletServer({
      server: createServer(),
      authenticateWorklet: sharedTokenAuthentication("credential"),
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 1000,
    });
    remote.start();
    const frontend = await startWorkletGrpcServer({ remote });
    const client = new WorkletConnection({
      url: frontend.url,
      transport: "grpc",
      credential: "credential",
      worklet,
      durableWorklet: durable,
    });
    try {
      await client.start();
      await delay(200);
      expect(hostLabels).toHaveBeenCalledTimes(1);
      // A timeout may discard an observation, but cannot cancel the extension promise.
      await delay(5200);
      expect(hostLabels).toHaveBeenCalledTimes(1);
      expect(client.isConnected).toBe(true);
      expect(remote.isWorkletConnected).toBe(true);
      if (reconnect) {
        await client.stop();
        await client.start();
        await delay(100);
        expect(hostLabels).toHaveBeenCalledTimes(1);
      }
      // A late result must not replace the last known labels, even across reconnection.
      hostLabels.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      release(["os:macos"]);
      await vi.waitFor(() => expect(hostLabels).toHaveBeenCalledTimes(2));
      expect(remote.workletRegistrations[0]?.host.labels ?? []).toEqual([]);
      release(["os:linux"]);
      await vi.waitFor(() => {
        expect(remote.workletRegistrations[0]?.host.labels).toEqual(["os:linux"]);
      });
    } finally {
      release([]);
      await client.stop();
      await frontend.close();
      await remote.stop();
      await durable.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

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
): Worklet & { execute: ReturnType<typeof vi.fn<Worklet["execute"]>> } {
  return {
    id: options.workletId ?? "local-worklet",
    describe: async () => ({
      id: options.workletId ?? "local-worklet",
      protocolVersion: 1,
      host: {
        id: options.workerHostId ?? `${options.workletId ?? "local-worklet"}-host`,
        workers: [
          {
            profileCapabilities: (options.profiles ?? [{ id: "default", revision: "1" }]).map(
              (profile) => ({
                profile,
                capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
                contextTypes: options.contextTypes ?? [],
              }),
            ),
            id: options.workerId ?? "local-static",
            type: "test",
            capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
            profiles: options.profiles ?? [{ id: "default", revision: "1" }],
            contextTypes: options.contextTypes ?? [],
            ...(options.maxConcurrency === undefined
              ? {}
              : { maxConcurrency: options.maxConcurrency }),
          },
        ],
      },
    }),
    execute: vi.fn(stream),
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

it("bounds slow inbound observers and requires explicit resume after overflow", async () => {
  const protocol = new DurableControlPlaneProtocol(1000);
  let requestId = "";
  class Socket extends EventEmitter {
    readyState = 1;
    send(data: string) {
      const message = JSON.parse(data);
      if (message.type === "durable_request") requestId = message.requestId;
    }
    close() {
      this.readyState = 3;
      protocol.disconnected(this);
    }
  }
  const socket = new Socket();
  const iterator = protocol.events(socket, "attempt")[Symbol.asyncIterator]();
  const initial = iterator.next();
  const receive = (sequence: number) =>
    protocol.receive(socket, {
      type: "durable_event",
      requestId,
      item: {
        sequence,
        event: {
          type: "output.delta",
          taskId: "task",
          attemptId: "attempt",
          at: new Date().toISOString(),
          text: "output",
        },
      },
    });
  receive(1);
  expect((await initial).value?.sequence).toBe(1);
  for (let i = 2; i <= 258; i++) receive(i);
  expect(socket.readyState).toBe(3);
  const sequences = [];
  await expect(
    (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        sequences.push(next.value.sequence);
      }
    })(),
  ).rejects.toThrow(/inspect and resume/);
  expect(sequences).toEqual(Array.from({ length: 256 }, (_, i) => i + 2));
});

it("rejects an incompatible live gRPC peer instead of retrying startup forever", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-version-"));
  const worklet = testWorklet(async function* () {});
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  const server = createHttp2Server(
    connectNodeAdapter({
      grpc: true,
      connect: false,
      grpcWeb: false,
      routes(router) {
        router.service(WorkletService, {
          async *connect(requests) {
            for await (const _request of requests) {
              yield create(ConnectResponseSchema, { wireVersion: 2 });
              break;
            }
          },
        });
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  const client = new WorkletConnection({
    transport: "grpc",
    url: `http://127.0.0.1:${address.port}`,
    credential: "credential",
    worklet,
    durableWorklet: durable,
    reconnectIntervalMs: 5,
  });
  try {
    await expect(client.start()).rejects.toThrow();
    expect(client.isConnected).toBe(false);
  } finally {
    await client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 5000);

it("rejects invalid local gRPC configuration and oversized hello without an uncaught exception", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-local-config-"));
  const worklet = testWorklet(async function* () {}, { workletId: "x".repeat(4 * 1024 * 1024) });
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  expect(
    () =>
      new WorkletConnection({
        transport: "grpc",
        url: "http://127.0.0.1/worklets",
        credential: "credential",
        worklet,
        durableWorklet: durable,
      }),
  ).toThrow();
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: sharedTokenAuthentication("credential"),
  });
  remote.start();
  const frontend = await startWorkletGrpcServer({ remote });
  const client = new WorkletConnection({
    transport: "grpc",
    url: frontend.url,
    credential: "credential",
    worklet,
    durableWorklet: durable,
  });
  try {
    await expect(client.start()).rejects.toThrow("Invalid Worklet frame");
  } finally {
    await client.stop();
    await frontend.close();
    await remote.stop();
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 5000);

it("fails an invalid Worker event without journaling it or closing the host connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-invalid-event-"));
  const worker: Worker = {
    async describe() {
      return {
        id: "local-static",
        type: "test",
        profiles: [{ id: "default", revision: "1" }],
        capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
        contextTypes: [],
        profileCapabilities: [
          {
            profile: { id: "default", revision: "1" },
            capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
            contextTypes: [],
          },
        ],
      };
    },
    async *execute(spec) {
      yield taskAttemptEvent(spec, { type: "execution.started", workerId: "local-static" });
      yield taskAttemptEvent(spec, { type: "fixture.made-up" } as never);
    },
  };
  const worklet = new LocalWorklet("local-worklet", "local-worklet-host", [worker]);
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: sharedTokenAuthentication("credential"),
  });
  remote.start();
  const frontend = await startWorkletGrpcServer({ remote });
  const client = new WorkletConnection({
    transport: "grpc",
    url: frontend.url,
    credential: "credential",
    worklet,
    durableWorklet: durable,
  });
  try {
    await client.start();
    const generation = client.connectionGeneration;
    const spec = taskAttemptSpec();
    await remote.accept(spec);
    const events: TaskAttemptEvent[] = [];
    for await (const item of remote.events(spec.attemptId)) events.push(item.event);
    expect(events.map((event) => event.type)).toEqual(["execution.started", "execution.failed"]);
    expect(events[1]).toMatchObject({
      error: { message: expect.stringContaining("fixture.made-up") },
    });
    expect(await remote.inspect(spec.attemptId)).toMatchObject({ status: "failed" });
    expect(client.connectionGeneration).toBe(generation);
    expect(remote.isHostConnectionLoopback("local-worklet-host", generation)).toBe(true);
  } finally {
    await client.stop();
    await frontend.close();
    await remote.stop();
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 5000);

it("journals and delivers a Worker event that carries extra fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-extra-field-event-"));
  const usage = {
    inputTokens: 3,
    outputTokens: 2,
    cachedInputTokens: 0,
    totalTokens: 5,
    complete: true,
    model: "harness-model",
  };
  const worker: Worker = {
    async describe() {
      return {
        id: "local-static",
        type: "test",
        profiles: [{ id: "default", revision: "1" }],
        capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
        contextTypes: [],
        profileCapabilities: [
          {
            profile: { id: "default", revision: "1" },
            capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
            contextTypes: [],
          },
        ],
      };
    },
    async *execute(spec) {
      yield taskAttemptEvent(spec, { type: "execution.started", workerId: "local-static" });
      yield taskAttemptEvent(spec, {
        type: "usage.updated",
        usage,
        harnessDetail: { turn: 1 },
      } as never);
      yield taskAttemptEvent(spec, { type: "execution.completed" });
    },
  };
  const worklet = new LocalWorklet("local-worklet", "local-worklet-host", [worker]);
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: sharedTokenAuthentication("credential"),
  });
  remote.start();
  const frontend = await startWorkletGrpcServer({ remote });
  const client = new WorkletConnection({
    transport: "grpc",
    url: frontend.url,
    credential: "credential",
    worklet,
    durableWorklet: durable,
  });
  try {
    await client.start();
    const spec = taskAttemptSpec();
    await remote.accept(spec);
    const events: TaskAttemptEvent[] = [];
    for await (const item of remote.events(spec.attemptId)) events.push(item.event);
    expect(events.map((event) => event.type)).toEqual([
      "execution.started",
      "usage.updated",
      "execution.completed",
    ]);
    expect(events[1]).toMatchObject({ usage, harnessDetail: { turn: 1 } });
    expect(await remote.inspect(spec.attemptId)).toMatchObject({ status: "completed" });
  } finally {
    await client.stop();
    await frontend.close();
    await remote.stop();
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 5000);

it("delivers acceptance and cancellation during noisy output to a slower observer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-traffic-"));
  const worklet = testWorklet(
    async function* (spec, signal) {
      yield taskAttemptEvent(spec, { type: "execution.started", workerId: "local-static" });
      if (spec.taskId === "noisy") {
        for (let index = 0; index < 200; index++) {
          await delay(2, undefined, { signal });
          yield taskAttemptEvent(spec, { type: "output.delta", text: String(index) });
        }
        yield taskAttemptEvent(spec, { type: "execution.completed" });
      } else await delay(10_000, undefined, { signal });
    },
    { maxConcurrency: 2 },
  );
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: sharedTokenAuthentication("credential"),
    durableAcknowledgementTimeoutMs: 2000,
  });
  remote.start();
  const frontend = await startWorkletGrpcServer({ remote });
  const client = new WorkletConnection({
    transport: "grpc",
    url: frontend.url,
    credential: "credential",
    worklet,
    durableWorklet: durable,
  });
  try {
    await client.start();
    const noisy = taskAttemptSpec(undefined, "noisy");
    await remote.accept(noisy);
    const sequences: number[] = [];
    const output: string[] = [];
    const observation = (async () => {
      for await (const item of remote.events(noisy.attemptId)) {
        sequences.push(item.sequence);
        if (item.event.type === "output.delta") output.push(item.event.text);
        await delay(8);
      }
    })();
    await delay(150);
    const other = taskAttemptSpec(undefined, "other");
    const acceptStart = performance.now();
    await remote.accept(other);
    const acceptanceMs = performance.now() - acceptStart;
    const cancelStart = performance.now();
    const cancelled = await remote.cancel(other.attemptId, "traffic test");
    const cancellationMs = performance.now() - cancelStart;
    expect(acceptanceMs).toBeLessThan(2000);
    expect(cancellationMs).toBeLessThan(2000);
    expect(cancelled).toMatchObject({ attemptId: other.attemptId, cancellationRequested: true });
    await observation;
    expect(output).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => i + 1));
    console.info(
      JSON.stringify({
        benchmark: "localhost-grpc-mixed-traffic",
        outputEvents: output.length,
        producerDelayMs: 2,
        observerDelayMs: 8,
        acceptanceMs: Math.round(acceptanceMs * 100) / 100,
        cancellationMs: Math.round(cancellationMs * 100) / 100,
      }),
    );
  } finally {
    await client.stop();
    await frontend.close();
    await remote.stop();
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

it("rejects uint32 overflow before capability and timer fields can wrap on the wire", async () => {
  const descriptor = await testWorklet(async function* () {}).describe();
  const worker = descriptor.host.workers[0];
  if (!worker) throw new Error("fixture");
  const overflow = 0x1_0000_0001;
  const encodeWorker = (changed: typeof worker) =>
    encodeHostFrame({
      type: "hello",
      protocolVersions: [18],
      worklet: {
        ...descriptor,
        durableProtocolVersion: 1,
        host: { ...descriptor.host, workers: [changed] },
      },
    });
  expect(() =>
    encodeWorker({ ...worker, capabilities: [{ id: "sensitive", version: overflow }] }),
  ).toThrow(/uint32/);
  expect(() => encodeWorker({ ...worker, maxConcurrency: overflow })).toThrow(/uint32/);
  expect(() =>
    encodeWorker({ ...worker, contextTypes: [{ type: "sensitive", versions: [overflow] }] }),
  ).toThrow(/uint32/);
  expect(() =>
    encodeWorker({
      ...worker,
      profileCapabilities: [
        {
          profile: { id: "default", revision: "1" },
          capabilities: [{ id: "sensitive", version: overflow }],
          contextTypes: [],
        },
      ],
    }),
  ).toThrow(/uint32/);
  expect(() =>
    encodeWorker({
      ...worker,
      profileCapabilities: [
        {
          profile: { id: "default", revision: "1" },
          capabilities: [],
          contextTypes: [{ type: "sensitive", versions: [overflow] }],
        },
      ],
    }),
  ).toThrow(/uint32/);
  expect(() =>
    encodeControlFrame({
      type: "ready",
      protocolVersion: 18,
      heartbeatIntervalMs: overflow,
      connectionGeneration: 1,
    }),
  ).toThrow(/uint32/);
  expect(() =>
    encodeControlFrame({
      type: "ready",
      protocolVersion: overflow,
      heartbeatIntervalMs: 100,
      connectionGeneration: 1,
    }),
  ).toThrow(/uint32/);
  expect(() =>
    encodeControlFrame({
      type: "protocol_error",
      code: "version",
      message: "unsupported",
      supportedProtocolVersions: [overflow],
    }),
  ).toThrow(/uint32/);
  // Highest representable value stays intact; protocol semantics are validated separately.
  const encoded = encodeWorker({
    ...worker,
    capabilities: [{ id: "future", version: 0xffff_ffff }],
  });
  expect(decodeHostFrame(encoded, "credential")).toMatchObject({
    worklet: { host: { workers: [{ capabilities: [{ id: "future", version: 0xffff_ffff }] }] } },
  });
  // Advertised models and efforts survive the wire; absent lists stay absent.
  const advertising = decodeHostFrame(
    encodeWorker({
      ...worker,
      profileCapabilities: [
        {
          profile: { id: "default", revision: "1" },
          harness: "codex",
          models: ["gpt-6-sol", "gpt-6-max"],
          efforts: ["medium", "high"],
          capabilities: [],
          contextTypes: [],
        },
        { profile: { id: "plain", revision: "1" }, capabilities: [], contextTypes: [] },
      ],
    }),
    "credential",
  ) as { worklet: { host: { workers: { profileCapabilities: Record<string, unknown>[] }[] } } };
  const [served, plain] = advertising.worklet.host.workers[0]?.profileCapabilities ?? [];
  expect(served).toMatchObject({ models: ["gpt-6-sol", "gpt-6-max"], efforts: ["medium", "high"] });
  expect(plain).not.toHaveProperty("models");
  expect(plain).not.toHaveProperty("efforts");
});

it("records the WebSocket peer from the upgrade socket", async () => {
  const server = createServer();
  const remote = new RemoteWorkletServer({
    server,
    authenticateWorklet: sharedTokenAuthentication("credential"),
  });
  remote.start();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port");
  const directory = await mkdtemp(join(tmpdir(), "supertag-websocket-peer-"));
  const worklet = testWorklet(async function* () {});
  const durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(directory));
  const client = new WorkletConnection({
    url: `ws://127.0.0.1:${address.port}/worklets`,
    transport: "websocket",
    credential: "credential",
    worklet,
    durableWorklet: durable,
  });
  try {
    await client.start();
    expect(remote.isHostConnectionLoopback("local-worklet-host", 1)).toBe(true);
    await client.stop();
    await vi.waitFor(() =>
      expect(remote.isHostConnectionLoopback("local-worklet-host", 1)).toBe(false),
    );
  } finally {
    await client.stop();
    await remote.stop();
    await durable.close();
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
