import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import {
  type HarnessControlCommand,
  LocalHarnessExecutionControl,
  type Worklet,
} from "../sdk/src/index.js";
import { DurableControlPlaneProtocol, DurableHostProtocol } from "./src/durable-protocol.js";
import {
  decodeControlFrame,
  decodeHostFrame,
  encodeControlFrame,
  encodeHostFrame,
} from "./src/grpc-codec.js";
import type { WorkletClientMessage, WorkletServerMessage } from "./src/index.js";
import type { MessageSocket } from "./src/message-socket.js";

class Socket extends EventEmitter implements MessageSocket {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  deliver = (_message: Record<string, unknown>) => {};
  send(text: string) {
    this.sendMessage(JSON.parse(text));
  }
  sendMessage(message: Record<string, unknown>) {
    this.sent.push(message);
    this.deliver(message);
  }
  close() {
    this.readyState = 3;
  }
}

const command: HarnessControlCommand = {
  id: "input",
  taskId: "task",
  attemptId: "attempt",
  type: "input",
  text: "teammate text",
  advisory: true,
  requiresInputAuthorization: true,
};

it.each(["json", "protobuf"] as const)(
  "checks authority after the remote queue over %s and does not replay a take",
  async (wire) => {
    const serverSocket = new Socket();
    const hostSocket = new Socket();
    const authority = new DurableControlPlaneProtocol(1_000);
    let member = true;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received: string[] = [];
    const authorizeInput = vi.fn(async () => member);
    const native = new LocalHarnessExecutionControl({
      taskId: "task",
      attemptId: "attempt",
      capabilities: { version: 1, inputMode: "queue", operations: ["input"] },
      authorizeInputAtTake: true,
      dispatch: async (input, _signal, authorize) => {
        await ready;
        if (authorize && !(await authorize())) return { status: "rejected" };
        received.push(input.id);
        return { status: "accepted" };
      },
    });
    const host = new DurableHostProtocol({
      control: (input, options) => native.send(input, options),
    } as Worklet);
    const pending: Promise<unknown>[] = [];
    serverSocket.deliver = (message) => {
      pending.push(
        host.receive(
          hostSocket,
          wire === "protobuf"
            ? decodeControlFrame(encodeControlFrame(message as WorkletServerMessage))
            : JSON.parse(JSON.stringify(message)),
        ),
      );
    };
    hostSocket.deliver = (message) => {
      authority.receive(
        serverSocket,
        wire === "protobuf"
          ? decodeHostFrame(encodeHostFrame(message as WorkletClientMessage), "connection")
          : JSON.parse(JSON.stringify(message)),
      );
    };
    try {
      const result = authority.control(serverSocket, command, { authorizeInput });
      expect(authorizeInput).not.toHaveBeenCalled();
      member = false;
      release();
      expect((await result).status).toBe("rejected");
      expect(authorizeInput).toHaveBeenCalledTimes(1);
      expect(received).toEqual([]);
      const take = hostSocket.sent.find((message) => message["type"] === "control_take");
      expect(take).toBeDefined();
      if (!take) throw new Error("Missing take request");
      authority.receive(serverSocket, take);
      expect(authorizeInput).toHaveBeenCalledTimes(1);
      member = true;
      expect(
        (await authority.control(serverSocket, { ...command, id: "allowed" }, { authorizeInput }))
          .status,
      ).toBe("accepted");
      expect(received).toEqual(["allowed"]);
      expect(authorizeInput).toHaveBeenCalledTimes(2);
    } finally {
      release();
      authority.disconnected(serverSocket);
      host.disconnected(hostSocket);
      await native.close();
      await Promise.all(pending);
    }
  },
);

it("rejects late or disconnected authorization and ignores another connection's answer", async () => {
  vi.useFakeTimers();
  const socket = new Socket();
  const outsider = new Socket();
  const received: string[] = [];
  const native = new LocalHarnessExecutionControl({
    taskId: "task",
    attemptId: "attempt",
    capabilities: { version: 1, operations: ["input"] },
    authorizeInputAtTake: true,
    dispatch: async (input, _signal, authorize) => {
      if (!authorize || !(await authorize())) return { status: "rejected" };
      received.push(input.id);
      return { status: "accepted" };
    },
  });
  const host = new DurableHostProtocol({
    control: (input, options) => native.send(input, options),
  } as Worklet);
  try {
    const pending = host.receive(socket, {
      type: "durable_request",
      operation: "control",
      requestId: "first",
      attemptId: "attempt",
      command,
    });
    await vi.advanceTimersByTimeAsync(0);
    await host.receive(outsider, {
      type: "control_take_result",
      requestId: "first",
      allowed: true,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await pending;
    await host.receive(socket, { type: "control_take_result", requestId: "first", allowed: true });
    expect(received).toEqual([]);
    const disconnected = host.receive(socket, {
      type: "durable_request",
      operation: "control",
      requestId: "second",
      attemptId: "attempt",
      command: { ...command, id: "second" },
    });
    await vi.advanceTimersByTimeAsync(0);
    host.disconnected(socket);
    await disconnected;
    expect(received).toEqual([]);
    expect(
      socket.sent.filter((m) => m["type"] === "durable_reply").map((m) => m["result"]),
    ).toMatchObject([{ status: "rejected" }, { status: "rejected" }]);
  } finally {
    host.disconnected(socket);
    await native.close();
    vi.useRealTimers();
  }
});
