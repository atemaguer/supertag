import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { sharedTokenAuthentication } from "../../../tests/support/worklet-authentication.js";
import { emptyTagContextPlan } from "../../core/src/index.js";
import type { Worklet, WorkletExecutionPlacement } from "../sdk/src/index.js";
import { DurableHostProtocol } from "./src/durable-protocol.js";
import { RemoteWorkletServer } from "./src/index.js";
import {
  listenSocketMessages,
  type MessageSocket,
  sendSocketMessage,
  type TypedTransportMessage,
} from "./src/message-socket.js";

class TypedSocket extends EventEmitter implements MessageSocket {
  readyState = 1;
  readonly sent: TypedTransportMessage[] = [];
  readonly #listeners = new Set<(message: TypedTransportMessage) => void>();
  send = vi.fn(() => {
    throw new Error("typed dispatch must not serialize through send");
  });
  sendMessage(message: TypedTransportMessage) {
    this.sent.push(message);
  }
  onMessage(listener: (message: TypedTransportMessage) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  receive(message: TypedTransportMessage) {
    for (const listener of this.#listeners) listener(message);
  }
  close() {
    this.readyState = 3;
  }
}

it("dispatches typed messages without passing through JSON", () => {
  const socket = new TypedSocket();
  const received: object[] = [];
  const stop = listenSocketMessages(
    socket,
    () => {
      throw new Error("typed messages must not use the byte decoder");
    },
    (message) => received.push(message),
  );
  const message = {
    type: "heartbeat",
    at: "2026-09-17T00:00:00.000Z",
    hostLabels: ["mcp-login:notion"],
  };
  sendSocketMessage(socket, message);
  socket.receive(message);
  stop();
  socket.receive({ type: "ignored" });
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.sent).toEqual([message]);
  expect(received).toEqual([message]);
});

it("closes malformed byte messages without dispatch or an uncaught decoder error", () => {
  const socket = new EventEmitter() as EventEmitter & MessageSocket;
  socket.close = vi.fn();
  const listener = vi.fn();
  listenSocketMessages(socket, (bytes) => JSON.parse(bytes.toString()), listener);
  expect(() => socket.emit("message", Buffer.from("{broken"))).not.toThrow();
  expect(socket.close).toHaveBeenCalledWith(1007, "Invalid transport message");
  expect(listener).not.toHaveBeenCalled();
});

it("does not retain or dispatch oversized placement request identities", async () => {
  const selectPlacement = vi.fn();
  const protocol = new DurableHostProtocol({ selectPlacement } as unknown as Worklet);
  const socket = new TypedSocket();
  await protocol.receive(socket, {
    type: "durable_request",
    operation: "select_placement",
    requestId: "x".repeat(1_025),
    requirements: {},
    contextPlan: emptyTagContextPlan("2026-09-17T00:00:00.000Z"),
    options: {},
  });
  expect(selectPlacement).not.toHaveBeenCalled();
  expect(socket.sent.at(-1)).toMatchObject({ error: "Placement requestId exceeds limit" });
});

it("rejects cyclic placement arrays before allocating capacity", async () => {
  const selectPlacement = vi.fn();
  const protocol = new DurableHostProtocol({ selectPlacement } as unknown as Worklet);
  const socket = new TypedSocket();
  const cycle: unknown[] = [];
  cycle.push(cycle);
  await protocol.receive(socket, {
    type: "durable_request",
    operation: "select_placement",
    requestId: "cycle",
    requirements: { cycle },
    contextPlan: emptyTagContextPlan("2026-09-17T00:00:00.000Z"),
    options: {},
  });
  expect(selectPlacement).not.toHaveBeenCalled();
  expect(socket.sent.at(-1)).toMatchObject({ error: "Placement request contains a cycle" });
});

it("discards a placement when its connection closes before the awaiting caller resumes", async () => {
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: sharedTokenAuthentication("credential"),
  });
  remote.start();
  const socket = new TypedSocket();
  remote.attachConnection(socket);
  socket.receive({
    type: "hello",
    protocolVersions: [18],
    credential: "credential",
    worklet: {
      id: "worklet",
      protocolVersion: 1,
      durableProtocolVersion: 1,
      host: {
        id: "host",
        workers: [
          {
            profileCapabilities: [
              {
                profile: { id: "profile", revision: "1" },
                capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
                contextTypes: [],
              },
            ],
            id: "worker",
            type: "test",
            capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
            profiles: [{ id: "profile", revision: "1" }],
            contextTypes: [],
          },
        ],
      },
    },
  });
  await vi.waitFor(() => expect(remote.isConnected).toBe(true));
  const selection = remote.selectPlacement({}, emptyTagContextPlan());
  await vi.waitFor(() =>
    expect(socket.sent.some((message) => message.operation === "select_placement")).toBe(true),
  );
  const request = socket.sent.find((message) => message.operation === "select_placement");
  socket.receive({
    type: "durable_reply",
    requestId: request?.requestId,
    resultKind: "placement",
    result: {
      workerHostId: "host",
      workletId: "worklet",
      workerId: "worker",
      workerProfile: { id: "profile", revision: "1" },
      reservation: { id: "reservation", expiresAt: "2099-01-01T00:00:00Z" },
    },
  });
  socket.close();
  socket.emit("close", 1000, Buffer.alloc(0));
  await expect(selection).resolves.toBeUndefined();
  await remote.stop();
});

it("deduplicates concurrent placement selection and rejects replay after release", async () => {
  let completeSelection!: (placement: WorkletExecutionPlacement) => void;
  const selection = new Promise<WorkletExecutionPlacement>((resolve) => {
    completeSelection = resolve;
  });
  const placement: WorkletExecutionPlacement = {
    workerHostId: "host",
    workletId: "worklet",
    workerId: "worker",
    workerProfile: { id: "profile", revision: "1" },
    reservation: { id: "reservation", expiresAt: "2099-09-17T01:00:00.000Z" },
  };
  const selectPlacement = vi.fn(() => selection);
  const releasePlacement = vi.fn();
  const worklet = {
    id: "worklet",
    describe: vi.fn(),
    execute: vi.fn(),
    selectPlacement,
    releasePlacement,
  } as unknown as Worklet;
  const protocol = new DurableHostProtocol(worklet);
  const socket = new TypedSocket();
  const request = {
    type: "durable_request",
    operation: "select_placement",
    requestId: "selection-request",
    requirements: {},
    contextPlan: emptyTagContextPlan("2026-09-17T00:00:00.000Z"),
    // Runtime selection objects can contain optional keys with undefined values. Their replay
    // identity must match the JSON form sent by the WebSocket transport, which omits those keys.
    options: { requiresCoordination: undefined },
  };
  const first = protocol.receive(socket, request);
  const duplicate = protocol.receive(socket, {
    ...request,
    options: {},
    requirements: {},
  });
  await vi.waitFor(() => expect(selectPlacement).toHaveBeenCalledTimes(1));
  completeSelection(placement);
  await Promise.all([first, duplicate]);
  expect(selectPlacement).toHaveBeenCalledTimes(1);
  expect(socket.sent).toEqual([
    {
      type: "durable_reply",
      requestId: "selection-request",
      result: placement,
      resultKind: "placement",
    },
    {
      type: "durable_reply",
      requestId: "selection-request",
      result: placement,
      resultKind: "placement",
    },
  ]);

  await protocol.receive(socket, {
    type: "durable_request",
    operation: "release_placement",
    requestId: "release-request",
    placement,
  });
  await protocol.receive(socket, request);
  expect(releasePlacement).toHaveBeenCalledTimes(1);
  expect(selectPlacement).toHaveBeenCalledTimes(1);
  expect(socket.sent.at(-1)).toMatchObject({
    type: "durable_reply",
    requestId: "selection-request",
    error: "Placement request is no longer active",
  });
  expect(socket.send).not.toHaveBeenCalled();
});

it("rejects a reused placement request ID with different input", async () => {
  const placement: WorkletExecutionPlacement = {
    workerHostId: "host",
    workletId: "worklet",
    workerId: "worker",
    workerProfile: { id: "profile", revision: "1" },
    reservation: { id: "reservation", expiresAt: "2099-09-17T01:00:00.000Z" },
  };
  const selectPlacement = vi.fn(async () => placement);
  const protocol = new DurableHostProtocol({ selectPlacement } as unknown as Worklet);
  const socket = new TypedSocket();
  const base = {
    type: "durable_request",
    operation: "select_placement",
    requestId: "request",
    requirements: {},
    contextPlan: emptyTagContextPlan("2026-09-17T00:00:00.000Z"),
    options: {},
  };
  await protocol.receive(socket, base);
  await protocol.receive(socket, { ...base, options: { requiresCoordination: true } });
  expect(selectPlacement).toHaveBeenCalledTimes(1);
  expect(socket.sent.at(-1)).toMatchObject({
    type: "durable_reply",
    requestId: "request",
    error: "Placement requestId reused with different input",
  });
});

it("retains an expired selection tombstone instead of allocating a new hold", async () => {
  const selectPlacement = vi.fn(async () => ({
    workerHostId: "host",
    workletId: "worklet",
    workerId: "worker",
    workerProfile: { id: "profile", revision: "1" },
    reservation: { id: "expired", expiresAt: "2000-01-01T00:00:00.000Z" },
  }));
  const protocol = new DurableHostProtocol({ selectPlacement } as unknown as Worklet);
  const socket = new TypedSocket();
  const request = {
    type: "durable_request",
    operation: "select_placement",
    requestId: "expired-request",
    requirements: {},
    contextPlan: emptyTagContextPlan("2026-09-17T00:00:00.000Z"),
    options: {},
  };
  await protocol.receive(socket, request);
  await protocol.receive(socket, request);
  expect(selectPlacement).toHaveBeenCalledTimes(1);
  expect(socket.sent.at(-1)).toMatchObject({
    type: "durable_reply",
    requestId: "expired-request",
    error: "Placement request is no longer active",
  });
});

it("rejects pre-18 connections before authentication or control dispatch", async () => {
  const authenticateWorklet = vi.fn(sharedTokenAuthentication("credential"));
  const remote = new RemoteWorkletServer({ server: createServer(), authenticateWorklet });
  remote.start();
  const socket = new TypedSocket();
  remote.attachConnection(socket);
  socket.receive({
    type: "hello",
    protocolVersions: [17],
    credential: "credential",
    worklet: {
      id: "worklet",
      protocolVersion: 1,
      durableProtocolVersion: 1,
      controlProtocolVersion: 1,
      host: {
        id: "host",
        workers: [
          {
            profileCapabilities: [
              {
                profile: { id: "profile", revision: "1" },
                capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
                contextTypes: [],
              },
            ],
            id: "worker",
            type: "test",
            capabilities: [{ id: "supertag.task-attempt.events", version: 1 }],
            profiles: [{ id: "profile", revision: "1" }],
            contextTypes: [],
          },
        ],
      },
    },
  });
  try {
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    expect(socket.sent).toEqual([
      expect.objectContaining({
        type: "protocol_error",
        code: "unsupported_protocol",
        supportedProtocolVersions: [18],
      }),
    ]);
    expect(authenticateWorklet).not.toHaveBeenCalled();
    expect(remote.isConnected).toBe(false);
  } finally {
    socket.emit("close", 4002, Buffer.alloc(0));
    await remote.stop();
  }
});

it("ties loopback evidence to the admitted live generation, ignoring host-supplied claims", async () => {
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: sharedTokenAuthentication("credential"),
  });
  remote.start();
  const hello = {
    type: "hello",
    protocolVersions: [18],
    credential: "credential",
    remoteAddress: "127.0.0.1",
    worklet: {
      id: "worklet",
      protocolVersion: 1,
      durableProtocolVersion: 1,
      host: {
        id: "host",
        remoteAddress: "127.0.0.1",
        workers: [
          {
            profileCapabilities: [
              { profile: { id: "profile", revision: "1" }, capabilities: [], contextTypes: [] },
            ],
            id: "worker",
            type: "test",
            capabilities: [],
            profiles: [{ id: "profile", revision: "1" }],
            contextTypes: [],
          },
        ],
      },
    },
  };
  const attach = async (address?: string) => {
    const socket = new TypedSocket();
    remote.attachConnection(socket, address);
    socket.receive(hello);
    await vi.waitFor(() =>
      expect(socket.sent.some((message) => message.type === "ready")).toBe(true),
    );
    return socket;
  };
  try {
    expect(remote.isHostConnectionLoopback("host", 1)).toBe(false);
    await attach();
    expect(remote.isHostConnectionLoopback("host", 1)).toBe(false);
    const local = await attach("::ffff:127.0.0.1");
    expect(remote.isHostConnectionLoopback("host", 1)).toBe(false);
    expect(remote.isHostConnectionLoopback("host", 2)).toBe(true);
    const other = await attach("192.0.2.1");
    expect(remote.isHostConnectionLoopback("host", 2)).toBe(false);
    expect(remote.isHostConnectionLoopback("host", 3)).toBe(false);
    local.emit("close");
    other.close();
    expect(remote.isHostConnectionLoopback("host", 3)).toBe(false);
    const current = await attach("::1");
    expect(remote.isHostConnectionLoopback("host", 4)).toBe(true);
    current.close();
    expect(remote.isHostConnectionLoopback("host", 4)).toBe(false);
  } finally {
    await remote.stop();
  }
});
