import { once } from "node:events";
import { PassThrough } from "node:stream";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, createClient } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import {
  HarnessWorkspace,
  RemoteWorkspaceProvider,
  RemoteWorkspaceProviderBootstrapSchema,
  type RemoteWorkspaceStageChunk,
  RemoteWorkspaceStageChunkSchema,
} from "@supertag/worker-sdk/internal/rust-harness";
import {
  type RemoteWorkspaceHandlers,
  readRemoteWorkspaceBootstrap,
  runRemoteWorkspaceTransport,
  startRemoteWorkspaceTransport,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { expect, it, vi } from "vitest";

const token = "private-fixture-bearer-32-characters";
const auth = { headers: { authorization: `Bearer ${token}` }, timeoutMs: 2000 };
const owner = {
  hostId: "host",
  hostGeneration: 2n,
  taskId: "task",
  attemptId: "attempt",
  allocationId: "allocation",
};

async function* messages(...parts: Uint8Array[]) {
  yield create(RemoteWorkspaceStageChunkSchema, {
    part: { case: "header", value: { startCommit: "base" } },
  });
  for (const value of parts)
    yield create(RemoteWorkspaceStageChunkSchema, { part: { case: "payload", value } });
}

async function collect<T>(stream: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function handlers(): RemoteWorkspaceHandlers {
  return {
    provider: {
      allocate: async () => ({ sandboxId: "sandbox" }),
      stage: async (stream) => {
        await collect(stream);
        return {};
      },
      capture: async function* () {
        yield { part: { case: "tree", value: { sha256: "a".repeat(64), byteLength: 4n } } };
        yield { part: { case: "payload", value: new Uint8Array([1, 2, 3, 4]) } };
      },
      stop: async () => ({ stoppedSandboxId: "sandbox" }),
    },
    workspace: { execute: async () => ({ text: "fixture file", isError: false }) },
  };
}

function client(endpoint: string) {
  const sessionManager = new Http2SessionManager(endpoint);
  const transport = createGrpcTransport({ baseUrl: endpoint, sessionManager });
  return {
    provider: createClient(RemoteWorkspaceProvider, transport),
    workspace: createClient(HarnessWorkspace, transport),
    close: () => sessionManager.abort(),
  };
}

it("reads only a bounded valid raw bootstrap and never accepts a malformed token", async () => {
  const bytes = toBinary(
    RemoteWorkspaceProviderBootstrapSchema,
    create(RemoteWorkspaceProviderBootstrapSchema, { token }),
  );
  async function* split() {
    yield bytes.subarray(0, 3);
    yield bytes.subarray(3);
  }
  expect((await readRemoteWorkspaceBootstrap(split())).token).toBe(token);
  await expect(
    readRemoteWorkspaceBootstrap(
      (async function* () {
        yield new Uint8Array(4097);
      })(),
    ),
  ).rejects.toThrow("limit");
  for (const invalid of ["", "short", "bad\nheader".repeat(3)]) {
    const input = toBinary(
      RemoteWorkspaceProviderBootstrapSchema,
      create(RemoteWorkspaceProviderBootstrapSchema, { token: invalid }),
    );
    await expect(
      readRemoteWorkspaceBootstrap(
        (async function* () {
          yield input;
        })(),
      ),
    ).rejects.toThrow("bootstrap");
  }
  await expect(
    readRemoteWorkspaceBootstrap(
      (async function* () {
        yield new Uint8Array([255]);
      })(),
    ),
  ).rejects.toThrow("bootstrap");
});

it("authenticates both generated services before invoking any handler and runs the lifecycle", async () => {
  const implementation = handlers();
  const allocate = vi.spyOn(implementation.provider, "allocate");
  const execute = vi.spyOn(implementation.workspace, "execute");
  const parts: RemoteWorkspaceStageChunk[] = [];
  implementation.provider.stage = async (stream) => {
    parts.push(...(await collect(stream)));
    return {};
  };
  const server = await startRemoteWorkspaceTransport({ ...implementation, token });
  const calls = client(server.endpoint);
  try {
    expect(server.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(calls.provider.allocate({ owner }, { timeoutMs: 2000 })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    await expect(
      calls.workspace.execute(
        {},
        { headers: { authorization: `Bearer ${token}x` }, timeoutMs: 2000 },
      ),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(allocate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await expect(
      calls.provider.stage(messages(new Uint8Array(1024 * 1024 + 1)), { timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(
      (await calls.provider.allocate({ owner, allowedActions: ["files:read"] }, auth)).sandboxId,
    ).toBe("sandbox");
    await calls.provider.stage(messages(new Uint8Array([1, 2, 3, 4])), auth);
    expect(parts.map((part) => part.part.case)).toEqual(["header", "payload"]);
    expect(
      (
        await calls.workspace.execute(
          { operation: { case: "read", value: { path: "README.md" } } },
          auth,
        )
      ).text,
    ).toBe("fixture file");
    expect((await collect(calls.provider.capture({}, auth))).map((part) => part.part.case)).toEqual(
      ["tree", "payload"],
    );
    expect(
      (await calls.provider.stop({ owner, sandboxId: "sandbox" }, auth)).stoppedSandboxId,
    ).toBe("sandbox");
  } finally {
    calls.close();
    await server.close();
  }
});

it("keeps the Host channel alive after one cancelled call and redacts untyped provider failures", async () => {
  const implementation = handlers();
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  implementation.workspace.execute = async (_request, context) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      context.signal.addEventListener(
        "abort",
        () => {
          cancelled.resolve();
          resolve();
        },
        { once: true },
      ),
    );
    return {};
  };
  const server = await startRemoteWorkspaceTransport({ ...implementation, token });
  const calls = client(server.endpoint);
  const cancellation = new AbortController();
  try {
    const request = calls.workspace
      .execute({}, { ...auth, signal: cancellation.signal })
      .catch(() => undefined);
    await entered.promise;
    cancellation.abort();
    await Promise.all([request, cancelled.promise]);
    expect(server.signal.aborted).toBe(false);
    expect((await calls.provider.allocate({}, auth)).sandboxId).toBe("sandbox");
    implementation.provider.allocate = async () => {
      throw new Error(`provider credential ${token}`);
    };
    await expect(calls.provider.allocate({}, auth)).rejects.toMatchObject({
      code: Code.Internal,
      rawMessage: "Remote workspace operation failed",
    });
  } finally {
    calls.close();
    await server.close();
  }
});

it("bounds response messages and stops an unfinished bootstrap without stdout", async () => {
  const implementation = handlers();
  implementation.workspace.execute = async () => ({ text: "x".repeat(2048) });
  const server = await startRemoteWorkspaceTransport({
    ...implementation,
    token,
    limits: { messageBytes: 1024 },
  });
  const calls = client(server.endpoint);
  try {
    await expect(calls.workspace.execute({}, auth)).rejects.toMatchObject({
      code: Code.ResourceExhausted,
    });
  } finally {
    calls.close();
    await server.close();
  }
  const input = new PassThrough();
  const output = new PassThrough();
  const lifetime = new AbortController();
  const running = runRemoteWorkspaceTransport(handlers(), {
    input,
    output,
    signal: lifetime.signal,
  });
  lifetime.abort();
  await expect(running).rejects.toMatchObject({ code: Code.Canceled });
  expect(input.destroyed).toBe(true);
  expect(output.readableLength).toBe(0);
});

it("bounds client and server stream chunks and aggregate bytes over real gRPC", async () => {
  const implementation = handlers();
  let accepted = 0;
  let captured = [new Uint8Array(4), new Uint8Array(4)];
  implementation.provider.stage = async (stream) => {
    await collect(stream);
    accepted++;
    return {};
  };
  implementation.provider.capture = async function* () {
    for (const value of captured) yield { part: { case: "payload", value } };
  };
  const server = await startRemoteWorkspaceTransport({
    ...implementation,
    token,
    limits: { chunkBytes: 4, streamBytes: 8, messageBytes: 1024 },
  });
  const calls = client(server.endpoint);
  try {
    await calls.provider.stage(messages(new Uint8Array(4), new Uint8Array(4)), auth);
    expect(accepted).toBe(1);
    await expect(calls.provider.stage(messages(new Uint8Array(5)), auth)).rejects.toMatchObject({
      code: Code.ResourceExhausted,
    });
    await expect(
      calls.provider.stage(messages(new Uint8Array(4), new Uint8Array(4), new Uint8Array(1)), auth),
    ).rejects.toMatchObject({ code: Code.ResourceExhausted });
    expect(accepted).toBe(1);
    expect(await collect(calls.provider.capture({}, auth))).toHaveLength(2);
    captured = [new Uint8Array(5)];
    await expect(collect(calls.provider.capture({}, auth))).rejects.toMatchObject({
      code: Code.ResourceExhausted,
    });
    captured = [new Uint8Array(4), new Uint8Array(4), new Uint8Array(1)];
    await expect(collect(calls.provider.capture({}, auth))).rejects.toMatchObject({
      code: Code.ResourceExhausted,
    });
    await expect(
      calls.workspace.execute(
        { operation: { case: "write", value: { path: "file", content: "x".repeat(2048) } } },
        auth,
      ),
    ).rejects.toMatchObject({ code: Code.ResourceExhausted });
  } finally {
    calls.close();
    await server.close();
  }
});

it("ignores unauthenticated disconnects and aborts active handlers when its Host disconnects", async () => {
  const implementation = handlers();
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  implementation.workspace.execute = async (_request, context) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      context.signal.addEventListener(
        "abort",
        () => {
          cancelled.resolve();
          resolve();
        },
        { once: true },
      ),
    );
    return {};
  };
  const server = await startRemoteWorkspaceTransport({ ...implementation, token });
  const stranger = client(server.endpoint);
  await expect(stranger.provider.allocate({}, { timeoutMs: 2000 })).rejects.toMatchObject({
    code: Code.Unauthenticated,
  });
  stranger.close();
  const host = client(server.endpoint);
  try {
    const request = host.workspace.execute({}, auth).catch(() => undefined);
    await entered.promise;
    host.close();
    await Promise.all([cancelled.promise, server.closed, request]);
    expect(server.signal.aborted).toBe(true);
    await server.close();
  } finally {
    host.close();
    await server.close();
  }
});

it("announces only one endpoint line after bootstrap EOF and closes on cancellation", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lifetime = new AbortController();
  const running = runRemoteWorkspaceTransport(handlers(), {
    input,
    output,
    signal: lifetime.signal,
  });
  const next = once(output, "data");
  input.end(
    toBinary(
      RemoteWorkspaceProviderBootstrapSchema,
      create(RemoteWorkspaceProviderBootstrapSchema, { token }),
    ),
  );
  const [line] = await next;
  const text = Buffer.from(line).toString();
  expect(text).toMatch(/^http:\/\/127\.0\.0\.1:\d+\n$/);
  expect(text).not.toContain(token);
  const calls = client(text.trim());
  try {
    expect((await calls.provider.allocate({}, auth)).sandboxId).toBe("sandbox");
  } finally {
    lifetime.abort();
    calls.close();
    await running;
  }
});
