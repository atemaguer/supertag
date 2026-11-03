import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type {
  ExecutionEnvironment,
  ProcessHandle,
  ProcessOutputChunk,
  ProcessResult,
  ProcessSpec,
} from "../../sdk/src/index.js";
import { startCodexExecServerBridge } from "./src/exec-server.js";

it("bridges text JSON-RPC frames to the environment-owned exec-server and records provenance", async () => {
  const fixture = environmentFixture();
  const bridge = await startCodexExecServerBridge({
    environment: fixture.environment,
    command: "codex",
    expectedVersion: "0.146.0",
    timeoutMs: 5_000,
    scratchDirectory: "/remote/workspace/scratch",
  });
  const socket = await connect(bridge.url);
  try {
    const received = nextMessage(socket);
    socket.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await vi.waitFor(() =>
      expect(fixture.writes.map((bytes) => new TextDecoder().decode(bytes))).toContain(
        '{"id":1,"method":"initialize","params":{}}\n',
      ),
    );
    fixture.output.push({
      stream: "stdout",
      text: '{"id":1,"result":{"sessionId":"exec-session"}}\n',
    });
    await expect(received).resolves.toBe('{"id":1,"result":{"sessionId":"exec-session"}}');
    expect(fixture.spawns).toEqual([
      expect.objectContaining({ command: "codex", args: ["--version"] }),
      expect.objectContaining({
        command: "codex",
        args: ["exec-server", "--listen", "stdio://"],
        cwd: "/remote/workspace",
        environment: { SUPERTAG_SCRATCH_DIR: "/remote/workspace/scratch" },
        streamInput: true,
        streamOutput: true,
      }),
    ]);
    expect(bridge.provenance).toEqual({
      protocol: "codex-exec-server",
      protocolVersion: 1,
      environmentId: bridge.environmentId,
      executionEnvironmentId: "remote:incarnation:access",
      execServerVersion: "0.146.0",
      execServerSessionId: "exec-session",
      transport: "stdio-websocket-bridge",
    });
  } finally {
    socket.close();
    await bridge.close();
  }
});

it("starts remote exec-server without provider keys or Codex auth home", async () => {
  const fixture = environmentFixture();
  const bridge = await startCodexExecServerBridge({
    environment: fixture.environment,
    command: "codex",
    expectedVersion: "0.146.0",
    timeoutMs: 5_000,
    scratchDirectory: "/remote/workspace/scratch",
  });
  try {
    const sandboxProcesses = JSON.stringify(fixture.spawns);
    expect(sandboxProcesses).not.toMatch(/OPENAI_|CODEX_|auth\.json/);
    expect(fixture.spawns[1]?.environment).toEqual({
      SUPERTAG_SCRATCH_DIR: "/remote/workspace/scratch",
    });
    expect(fixture.spawns.map((spec) => spec.replaceEnvironment)).toEqual([true, true]);
  } finally {
    await bridge.close();
  }
});

it("fails before starting exec-server when its version differs from app-server", async () => {
  const fixture = environmentFixture("0.145.0");
  await expect(
    startCodexExecServerBridge({
      environment: fixture.environment,
      command: "codex",
      expectedVersion: "0.146.0",
      timeoutMs: 5_000,
    }),
  ).rejects.toThrow("does not match app-server 0.146.0");
  expect(fixture.spawns).toEqual([
    expect.objectContaining({ command: "codex", args: ["--version"] }),
  ]);
});

it("fails closed when the environment does not provide duplex process streams", async () => {
  const fixture = environmentFixture("0.146.0", false);
  await expect(
    startCodexExecServerBridge({
      environment: fixture.environment,
      command: "codex",
      expectedVersion: "0.146.0",
      timeoutMs: 5_000,
    }),
  ).rejects.toThrow("requires environment-owned streaming input and output");
  expect(fixture.execKilled).toHaveBeenCalledOnce();
});

it("disconnects app-server and surfaces failure when exec-server exits prematurely", async () => {
  const fixture = environmentFixture();
  const bridge = await startCodexExecServerBridge({
    environment: fixture.environment,
    command: "codex",
    expectedVersion: "0.146.0",
    timeoutMs: 5_000,
  });
  const socket = await connect(bridge.url);
  const closed = new Promise<number>((resolve) => socket.once("close", resolve));
  fixture.exit.resolve({ exitCode: 17, stdout: "", stderr: "executor failed" });
  fixture.output.end();
  await expect(closed).resolves.toBe(1011);
  await expect(bridge.close()).rejects.toThrow("exited unexpectedly (17)");
});

it("disconnects app-server when the exec-server output stream closes before its process", async () => {
  const fixture = environmentFixture();
  const bridge = await startCodexExecServerBridge({
    environment: fixture.environment,
    command: "codex",
    expectedVersion: "0.146.0",
    timeoutMs: 5_000,
  });
  const socket = await connect(bridge.url);
  const closed = new Promise<number>((resolve) => socket.once("close", resolve));
  fixture.output.end();
  await expect(closed).resolves.toBe(1011);
  await expect(bridge.close()).rejects.toThrow("output closed unexpectedly");
});

it("rejects a second app-server connection instead of sharing one executor", async () => {
  const fixture = environmentFixture();
  const bridge = await startCodexExecServerBridge({
    environment: fixture.environment,
    command: "codex",
    expectedVersion: "0.146.0",
    timeoutMs: 5_000,
  });
  const first = await connect(bridge.url);
  try {
    await expect(connect(bridge.url)).rejects.toThrow();
  } finally {
    first.close();
    await bridge.close();
  }
});

it("accepts intentional app-server shutdown without hiding an earlier disconnect", async () => {
  for (const intentional of [true, false]) {
    const fixture = environmentFixture();
    const bridge = await startCodexExecServerBridge({
      environment: fixture.environment,
      command: "codex",
      expectedVersion: "0.146.0",
      timeoutMs: 5_000,
    });
    const socket = await connect(bridge.url);
    if (intentional) bridge.expectClose();
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close();
    await closed;
    // Server-side close delivery can follow the client's close event.
    await new Promise((resolve) => setTimeout(resolve, 10));
    bridge.expectClose();
    if (intentional) await expect(bridge.close()).resolves.toBeUndefined();
    else
      await expect(bridge.close()).rejects.toThrow(
        "Codex app-server disconnected from its exec-server",
      );
  }
});

function environmentFixture(version = "0.146.0", duplex = true) {
  const spawns: ProcessSpec[] = [];
  const writes: Uint8Array[] = [];
  const output = new AsyncQueue<ProcessOutputChunk>();
  const exit = deferred<ProcessResult>();
  const execKilled = vi.fn(() => {
    output.end();
    exit.resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" });
  });
  const versionHandle: ProcessHandle = {
    wait: async () => ({
      exitCode: 0,
      stdout: `codex-cli ${version}\n`,
      stderr: "",
    }),
    kill: vi.fn(),
  };
  const execHandle: ProcessHandle = {
    ...(duplex
      ? {
          output,
          write: async (bytes: Uint8Array) => {
            writes.push(bytes.slice());
          },
          endInput: async () => undefined,
        }
      : {}),
    wait: () => exit.promise,
    kill: execKilled,
  };
  const environment = {
    id: "remote:incarnation:access",
    placement: "remote",
    rootDirectory: "/remote/workspace",
    prepare: async () => undefined,
    resolvePath: (path: string) => `/remote/workspace/${path}`,
    read: async () => "",
    spawn: vi.fn(async (spec: ProcessSpec) => {
      spawns.push(spec);
      return spawns.length === 1 ? versionHandle : execHandle;
    }),
    dispose: async () => undefined,
  } satisfies ExecutionEnvironment;
  return { environment, spawns, writes, output, exit, execKilled };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`WebSocket upgrade rejected with ${response.statusCode}`));
    });
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiting: Array<(value: IteratorResult<T>) => void> = [];
  #ended = false;

  push(value: T): void {
    const waiting = this.#waiting.shift();
    if (waiting) waiting({ done: false, value });
    else this.#values.push(value);
  }

  end(): void {
    this.#ended = true;
    for (const waiting of this.#waiting.splice(0)) waiting({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<T>>((resolve) => this.#waiting.push(resolve));
      },
    };
  }
}
