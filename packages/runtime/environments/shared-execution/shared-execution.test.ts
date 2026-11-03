import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type ExecutionEnvironmentSpec,
  type HarnessPlan,
  PROCESS_INPUT_STREAMING_CAPABILITY,
} from "@supertag/worker-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { SharedExecutionEnvironmentProvider, startSharedExecutionGrpcServer } from "./src/index.ts";
import {
  type SharedExecutionRequest,
  type SharedExecutionResponse,
  startSharedExecutionServer,
} from "./src/server.ts";

const adminToken = "shared-execution-test-admin-token";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe.each(["http", "grpc"] as const)("SharedExecutionEnvironmentProvider (%s)", (transport) => {
  it("keeps deployment guarantees explicit and uses them for admission", async () => {
    const service = await fixture(transport);
    const restrictedPlan: HarnessPlan["execution"] = {
      ...plan(),
      network: { mode: "none" },
    };
    const unknown = await service.provider.provision(executionSpec("attempt-unknown-guarantees"));
    expect(unknown.guarantees).toEqual({
      filesystemIsolation: "none",
      networkPolicy: "none",
      processTreeTermination: true,
      scopedHttp: false,
    });
    expect(unknown.provenance).toMatchObject({
      environmentId: service.environmentId,
      incarnationId: expect.any(String),
      accessId: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(unknown.provenance)).not.toContain("token");
    await expect(unknown.prepare(restrictedPlan)).rejects.toThrow("network policy");
    await unknown.dispose("failed");

    const assertedProvider = new SharedExecutionEnvironmentProvider({
      baseUrl: service.url,
      adminToken,
      environmentId: service.environmentId,
      guarantees: {
        filesystemIsolation: "sandbox",
        networkPolicy: "enforced",
        processTreeTermination: true,
        scopedHttp: false,
      },
    });
    const asserted = await assertedProvider.provision(executionSpec("attempt-known-guarantees"));
    expect(asserted.guarantees).toEqual(assertedProvider.guarantees);
    await expect(asserted.prepare(restrictedPlan)).resolves.toBeUndefined();
    await asserted.dispose("completed");
  });

  it("captures fast process completion and all output while persisting state", async () => {
    const service = await fixture(transport);
    const environment = await service.provider.provision(executionSpec("fast-processes"));
    await environment.prepare(plan());
    try {
      for (let index = 0; index < 20; index++) {
        const child = await environment.spawn({
          command: "sh",
          args: ["-c", "printf complete"],
          timeoutMs: 2_000,
        });
        await expect(child.wait()).resolves.toMatchObject({ exitCode: 0, stdout: "complete" });
      }
    } finally {
      await environment.dispose("completed");
    }
  });

  it("signals only live processes when a long-lived Attempt signal aborts", async () => {
    const service = await fixture(transport);
    const environment = await service.provider.provision(executionSpec("attempt-abort-scope"));
    await environment.prepare(plan());
    const attempt = new AbortController();
    try {
      // Many finished commands share the Attempt's signal, as a long Harness session does.
      for (let index = 0; index < 25; index++) {
        const child = await environment.spawn(
          { command: "sh", args: ["-c", "printf done"], timeoutMs: 2_000 },
          attempt.signal,
        );
        await child.wait();
      }
      const live = await environment.spawn(
        { command: "sh", args: ["-c", "sleep 30"], timeoutMs: 60_000 },
        attempt.signal,
      );
      attempt.abort(new Error("Execution registered a durable wait"));
      await expect(live.wait()).resolves.toMatchObject({ exitCode: null });
      const state = JSON.parse(await readFile(service.statePath, "utf8")) as {
        operations: Record<string, { kind?: string; request?: { kind?: string } }>;
      };
      const signals = Object.values(state.operations).filter(
        (operation) => (operation.kind ?? operation.request?.kind) === "process.signal",
      );
      expect(signals).toHaveLength(1);
    } finally {
      await environment.dispose("cancelled");
    }
  });

  it("persists every operation acknowledged during a burst", async () => {
    const service = await fixture(transport);
    const environment = await service.provider.provision(executionSpec("attempt-burst"));
    await environment.prepare(plan());
    try {
      // Concurrent operations share coalesced writes; each acknowledgement must still be durable.
      // Stay within the server's default limit of eight concurrent processes.
      for (let round = 0; round < 5; round++)
        await Promise.all(
          Array.from({ length: 8 }, async (_, index) => {
            const child = await environment.spawn({
              command: "sh",
              args: ["-c", `printf ${round * 8 + index}`],
              timeoutMs: 5_000,
            });
            await child.wait();
          }),
        );
      const state = JSON.parse(await readFile(service.statePath, "utf8")) as {
        operations: Record<string, { status: string }>;
      };
      const completed = Object.values(state.operations).filter(
        (operation) => operation.status === "completed",
      );
      expect(completed.length).toBeGreaterThanOrEqual(40);
    } finally {
      await environment.dispose("completed");
    }
  });

  it("streams ordered process input and closes stdin once", async () => {
    const service = await fixture(transport);
    expect(service.provider.capabilities).toContainEqual(PROCESS_INPUT_STREAMING_CAPABILITY);
    const environment = await service.provider.provision(executionSpec("attempt-input"));
    await environment.prepare(plan());
    const child = await environment.spawn({
      command: process.execPath,
      args: [
        "-e",
        "let value = ''; process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(value + 'closed'))",
      ],
      streamInput: true,
      streamOutput: true,
    });
    expect(child.write).toBeTypeOf("function");
    expect(child.endInput).toBeTypeOf("function");
    const output = collectOutput(child.output);
    await child.write?.(Buffer.from("one-"));
    await child.write?.(Buffer.from("two-"));
    await child.endInput?.();
    await child.endInput?.();
    await expect(child.write?.(Buffer.from("late"))).rejects.toThrow(/input is closed/i);
    await expect(child.wait()).resolves.toMatchObject({ exitCode: 0, stdout: "one-two-closed" });
    await expect(output).resolves.toBe("one-two-closed");
    await environment.dispose("completed");
  });

  it("keeps process input operations idempotent and access-owned", async () => {
    const service = await fixture(transport);
    const owner = await issueAccess(service.url, "attempt-input-owner");
    const stranger = await issueAccess(service.url, "attempt-input-stranger");
    const start = await request<{ processId: string }>(
      service.url,
      `/v1/operations/${randomUUID()}`,
      owner.token,
      "POST",
      {
        kind: "process.start",
        command: process.execPath,
        args: [
          "-e",
          "let value = ''; process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(value))",
        ],
        cwd: ".",
        environment: {},
        streamInput: true,
      },
    );
    const writeId = randomUUID();
    const write = {
      kind: "process.input.write",
      processId: start.processId,
      contentBase64: Buffer.from("once").toString("base64"),
    };
    await request(service.url, `/v1/operations/${writeId}`, owner.token, "POST", write);
    await request(service.url, `/v1/operations/${writeId}`, owner.token, "POST", write);
    await expect(
      request(service.url, `/v1/operations/${randomUUID()}`, stranger.token, "POST", write),
    ).rejects.toThrow(/403.*another access/i);
    const closeId = randomUUID();
    const close = { kind: "process.input.close", processId: start.processId };
    await request(service.url, `/v1/operations/${closeId}`, owner.token, "POST", close);
    await request(service.url, `/v1/operations/${closeId}`, owner.token, "POST", close);

    const completed = await eventually(async () => {
      const snapshot = await request<ProcessSnapshot>(
        service.url,
        `/v1/processes/${start.processId}?cursor=0`,
        owner.token,
      );
      return snapshot.status === "completed" ? snapshot : undefined;
    });
    expect(completed.chunks.map((chunk) => chunk.text).join("")).toBe("once");
  });

  it("stages local workspace mounts once without overwriting shared changes", async () => {
    const service = await fixture(transport);
    const source = join(service.rootDirectory, "..", "source");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "nested", "input.txt"), "initial");
    const mountPlan: HarnessPlan["execution"] = {
      ...plan(),
      mounts: [
        {
          source: { uri: pathToFileURL(source).href },
          destination: "workspace",
          readOnly: false,
        },
      ],
    };
    const first = await service.provider.provision(executionSpec("attempt-stage-a"));
    await first.prepare(mountPlan);
    await expect(first.read("workspace/nested/input.txt")).resolves.toBe("initial");
    const edit = await first.spawn({
      command: "sh",
      args: ["-c", "printf changed > workspace/nested/input.txt"],
    });
    await expect(edit.wait()).resolves.toMatchObject({ exitCode: 0 });
    await first.dispose("completed");

    const second = await service.provider.provision(executionSpec("attempt-stage-b"));
    await second.prepare(mountPlan);
    await expect(second.read("workspace/nested/input.txt")).resolves.toBe("changed");
    await second.dispose("completed");

    const collision = join(service.rootDirectory, "..", "collision.txt");
    await writeFile(collision, "must not replace a directory");
    const third = await service.provider.provision(executionSpec("attempt-stage-c"));
    await expect(
      third.prepare({
        ...plan(),
        mounts: [
          {
            source: { uri: pathToFileURL(collision).href },
            destination: "workspace/nested",
            readOnly: false,
          },
        ],
      }),
    ).rejects.toThrow("regular file");
    await third.dispose("failed");

    const linked = join(source, "linked.txt");
    await symlink(join(source, "nested", "input.txt"), linked);
    const fourth = await service.provider.provision(executionSpec("attempt-stage-d"));
    await expect(fourth.prepare(mountPlan)).rejects.toThrow("symbolic links");
    await fourth.dispose("failed");
  });

  it("reuses exact staged inputs across Attempts but rejects changed bytes and symlinks", async () => {
    const service = await fixture(transport);
    const inputPlan: HarnessPlan["execution"] = {
      ...plan(),
      files: [{ path: "workspace/inputs/candidate.mjs", content: "export const version = 1;" }],
    };
    const first = await service.provider.provision(executionSpec("input-first"));
    await first.prepare(inputPlan);
    await first.dispose("completed");
    const second = await service.provider.provision(executionSpec("input-second"));
    await expect(second.prepare(inputPlan)).resolves.toBeUndefined();
    const path = join(service.rootDirectory, "workspace/inputs/candidate.mjs");
    await writeFile(path, "changed");
    await expect(second.prepare(inputPlan)).rejects.toThrow("differs from required input");
    expect(await readFile(path, "utf8")).toBe("changed");
    await rm(path);
    const target = join(service.rootDirectory, "outside-input.txt");
    await writeFile(target, "export const version = 1;");
    await symlink(target, path);
    await expect(second.prepare(inputPlan)).rejects.toThrow(/symbolic|symlink/i);
    await second.dispose("failed");
  });

  it("shares durable files while cancellation stops only processes owned by one access", async () => {
    const service = await fixture(transport);
    const first = await service.provider.provision(executionSpec("attempt-a"));
    const second = await service.provider.provision(executionSpec("attempt-b"));
    await first.prepare(plan());
    await second.prepare(plan());

    const writer = await first.spawn({
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('shared.txt', 'from-a')"],
    });
    await expect(writer.wait()).resolves.toMatchObject({ exitCode: 0 });
    await expect(second.read("shared.txt")).resolves.toBe("from-a");

    const cancelled = await first.spawn({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    const survivor = await second.spawn({
      command: process.execPath,
      args: [
        "-e",
        "setTimeout(() => { require('fs').writeFileSync('survived.txt', 'yes'); console.log('survived') }, 150)",
      ],
    });
    await first.dispose("cancelled");

    await expect(cancelled.wait()).rejects.toThrow(/revoked|released|failed/i);
    await expect(survivor.wait()).resolves.toMatchObject({
      exitCode: 0,
      stdout: "survived\n",
    });
    await expect(second.read("survived.txt")).resolves.toBe("yes");
    await second.dispose("completed");
  });

  it("keeps operation receipts idempotent, replays output by cursor, and revokes access", async () => {
    const service = await fixture(transport);
    const access = await issueAccess(service.url, "attempt-a");
    const operationId = randomUUID();
    const input = {
      kind: "process.start",
      command: process.execPath,
      args: ["-e", "process.stdout.write('one'); process.stderr.write('two')"],
      cwd: ".",
      environment: {},
    };
    const first = await request<{ processId: string; status: string }>(
      service.url,
      `/v1/operations/${operationId}`,
      access.token,
      "POST",
      input,
    );
    const duplicate = await request<{ processId: string; status: string }>(
      service.url,
      `/v1/operations/${operationId}`,
      access.token,
      "POST",
      input,
    );
    expect(duplicate.processId).toBe(first.processId);
    await expect(
      request(service.url, `/v1/operations/${operationId}`, access.token, "POST", {
        kind: "file.read",
        path: "different",
      }),
    ).rejects.toThrow(/409.*different input/i);

    const completed = await eventually(async () => {
      const snapshot = await request<ProcessSnapshot>(
        service.url,
        `/v1/processes/${first.processId}?cursor=0`,
        access.token,
      );
      return snapshot.status === "completed" ? snapshot : undefined;
    });
    expect(completed.chunks.map((chunk) => chunk.text).join("")).toContain("one");
    expect(completed.chunks.map((chunk) => chunk.text).join("")).toContain("two");
    const exhausted = await request<ProcessSnapshot>(
      service.url,
      `/v1/processes/${first.processId}?cursor=${completed.nextCursor}`,
      access.token,
    );
    expect(exhausted.chunks).toEqual([]);

    await request(service.url, `/v1/accesses/${access.id}`, adminToken, "DELETE");
    await expect(
      request(service.url, `/v1/processes/${first.processId}`, access.token),
    ).rejects.toThrow(/401.*revoked/i);
  });

  it.each(transport === "grpc" ? [Code.Unavailable, Code.Canceled] : [Code.Unavailable])(
    "retries ambiguous access and operation responses with the same identity (error %s)",
    async (code) => {
      const nativeFetch = globalThis.fetch;
      let loseAccessResponse = true;
      let loseOperationResponse = true;
      const service = await fixture(transport, {
        afterResponse(request, response) {
          if (response.status >= 400) return;
          if (
            loseAccessResponse &&
            request.method === "PUT" &&
            request.url.startsWith("/v1/accesses/")
          ) {
            loseAccessResponse = false;
            throw new ConnectError("simulated lost access acknowledgement", code);
          }
          if (
            loseOperationResponse &&
            request.method === "POST" &&
            request.body?.["kind"] === "process.start"
          ) {
            loseOperationResponse = false;
            throw new ConnectError("simulated lost operation acknowledgement", code);
          }
        },
      });
      if (transport === "http") {
        globalThis.fetch = async (input, init) => {
          const response = await nativeFetch(input, init);
          const url = String(input);
          if (loseAccessResponse && url.includes("/v1/accesses/")) {
            loseAccessResponse = false;
            await response.arrayBuffer();
            throw new Error("simulated lost access response");
          }
          if (loseOperationResponse && url.includes("/v1/operations/")) {
            loseOperationResponse = false;
            await response.arrayBuffer();
            throw new Error("simulated lost operation response");
          }
          return response;
        };
      }
      try {
        const environment = await service.provider.provision(executionSpec("attempt-retry"));
        await environment.prepare(plan());
        const child = await environment.spawn({
          command: process.execPath,
          args: ["-e", "require('fs').appendFileSync('once.txt', 'x')"],
        });
        await expect(child.wait()).resolves.toMatchObject({ exitCode: 0 });
        await expect(environment.read("once.txt")).resolves.toBe("x");
        await environment.dispose("completed");
        expect(loseAccessResponse).toBe(false);
        expect(loseOperationResponse).toBe(false);
        const state = JSON.parse(await readFile(service.statePath, "utf8"));
        expect(Object.keys(state.accesses)).toHaveLength(1);
        expect(
          Object.values(state.operations).filter(
            (operation) => (operation as { kind: string }).kind === "process.start",
          ),
        ).toHaveLength(1);
      } finally {
        globalThis.fetch = nativeFetch;
      }
    },
  );

  it("preserves access and completed operation receipts across service restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-shared-restart-"));
    const rootDirectory = join(directory, "workspace");
    const statePath = join(directory, "state", "state.json");
    let running = await startSharedExecutionServer({
      rootDirectory,
      statePath,
      environmentId: "restart-shared",
      adminToken,
    });
    try {
      const access = await issueAccess(running.url, "attempt-restart");
      const operationId = randomUUID();
      const input = {
        kind: "file.write",
        path: "durable.txt",
        contentBase64: Buffer.from("persisted").toString("base64"),
      };
      const original = await request<{ status: string }>(
        running.url,
        `/v1/operations/${operationId}`,
        access.token,
        "POST",
        input,
      );
      expect(original.status).toBe("completed");
      await running.close();
      running = await startSharedExecutionServer({
        rootDirectory,
        statePath,
        environmentId: "restart-shared",
        adminToken,
      });
      const replay = await request<{ status: string }>(
        running.url,
        `/v1/operations/${operationId}`,
        access.token,
        "POST",
        input,
      );
      expect(replay.status).toBe("completed");
      expect(await readFile(join(rootDirectory, "durable.txt"), "utf8")).toBe("persisted");
    } finally {
      await running.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fences old access when an operator replaces the environment incarnation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-shared-incarnation-"));
    const rootDirectory = join(directory, "workspace");
    const statePath = join(directory, "state", "state.json");
    let running = await startSharedExecutionServer({
      rootDirectory,
      statePath,
      environmentId: "replaced-shared",
      incarnationId: "incarnation-one",
      adminToken,
    });
    try {
      const access = await issueAccess(running.url, "attempt-before-replacement");
      await running.close();
      running = await startSharedExecutionServer({
        rootDirectory,
        statePath,
        environmentId: "replaced-shared",
        incarnationId: "incarnation-two",
        adminToken,
      });
      expect(running.incarnationId).toBe("incarnation-two");
      await expect(
        request(running.url, "/v1/operations/after-replacement", access.token, "POST", {
          kind: "file.read",
          path: "missing.txt",
          maximumBytes: 10,
        }),
      ).rejects.toThrow(/409.*incarnation was replaced/i);
    } finally {
      await running.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not expose service credentials to child processes", async () => {
    const previous = process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"];
    process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"] = "must-not-leak";
    try {
      const service = await fixture(transport);
      const environment = await service.provider.provision(executionSpec("attempt-secret"));
      await environment.prepare(plan());
      const child = await environment.spawn({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(process.env.SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN ?? 'absent')",
        ],
      });
      await expect(child.wait()).resolves.toMatchObject({ stdout: "absent" });
      await environment.dispose("completed");
      const state = await readFile(service.statePath, "utf8");
      expect(state).not.toContain("must-not-leak");
      expect(state).not.toContain(adminToken);
    } finally {
      if (previous === undefined) delete process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"];
      else process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"] = previous;
    }
  });

  it("enforces the environment-wide process concurrency limit across accesses", async () => {
    const service = await fixture(transport, { maximumConcurrentProcesses: 1 });
    const first = await service.provider.provision(executionSpec("attempt-a"));
    const second = await service.provider.provision(executionSpec("attempt-b"));
    await first.prepare(plan());
    await second.prepare(plan());
    const running = await first.spawn({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    await expect(
      second.spawn({ command: process.execPath, args: ["-e", "console.log('no')"] }),
    ).rejects.toThrow(/concurrency limit/i);
    running.kill("SIGKILL");
    await expect(running.wait()).resolves.toMatchObject({ signal: "SIGKILL" });
    await first.dispose("cancelled");
    await second.dispose("completed");
  });
});

interface ProcessSnapshot {
  status: string;
  chunks: Array<{ sequence: number; stream: string; text: string }>;
  nextCursor: number;
}

async function fixture(
  transport: "http" | "grpc",
  options: {
    maximumConcurrentProcesses?: number;
    afterResponse?: (
      request: SharedExecutionRequest,
      response: SharedExecutionResponse,
    ) => void | Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-shared-execution-"));
  const rootDirectory = join(directory, "workspace");
  const statePath = join(directory, "state", "state.json");
  const running = await startSharedExecutionServer({
    rootDirectory,
    statePath,
    environmentId: "test-shared",
    adminToken,
    maximumConcurrentProcesses: options.maximumConcurrentProcesses,
  });
  const grpc =
    transport === "grpc"
      ? await startSharedExecutionGrpcServer({
          service: {
            async dispatch(request) {
              const response = await running.dispatch(request);
              await options.afterResponse?.(request, response);
              return response;
            },
          },
        })
      : undefined;
  cleanups.push(async () => {
    await grpc?.close();
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ...running,
    rootDirectory,
    statePath,
    provider: new SharedExecutionEnvironmentProvider({
      baseUrl: grpc?.url ?? running.url,
      transport,
      adminToken,
      environmentId: running.environmentId,
    }),
  };
}

async function issueAccess(baseUrl: string, attemptId: string) {
  const id = randomUUID();
  const token = `stx_${randomBytes(32).toString("base64url")}`;
  const body = { taskId: "task-1", attemptId, tagId: "tag-1", accessToken: token, ttlMs: 60_000 };
  const first = await request<{ accessId: string }>(
    baseUrl,
    `/v1/accesses/${id}`,
    adminToken,
    "PUT",
    body,
  );
  const duplicate = await request<{ accessId: string }>(
    baseUrl,
    `/v1/accesses/${id}`,
    adminToken,
    "PUT",
    body,
  );
  expect(duplicate.accessId).toBe(first.accessId);
  await expect(
    request(baseUrl, `/v1/accesses/${id}`, adminToken, "PUT", {
      ...body,
      attemptId: "different",
    }),
  ).rejects.toThrow(/409.*different input/i);
  return { id, token };
}

async function request<T = unknown>(
  baseUrl: string,
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as { error?: string } & T;
  if (!response.ok) throw new Error(`${response.status}: ${value.error ?? "request failed"}`);
  return value;
}

async function eventually<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for shared execution state");
}

async function collectOutput(
  output: AsyncIterable<{ readonly text: string }> | undefined,
): Promise<string> {
  if (!output) throw new Error("Expected streamed process output");
  let text = "";
  for await (const chunk of output) text += chunk.text;
  return text;
}

function plan(): HarnessPlan["execution"] {
  return {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "unrestricted" },
  };
}

function executionSpec(attemptId: string): ExecutionEnvironmentSpec {
  return {
    task: {
      version: 1,
      taskId: "task-1",
      attemptId,
      tag: { id: "tag-1", name: "Engineering" },
      input: {
        origin: {
          surface: "test",
          accountId: "account-1",
          scope: "shared-execution",
          sessionKey: `test:${attemptId}`,
          occurredAt: "2026-09-14T00:00:00.000Z",
        },
        messages: [{ id: "message-1", role: "requester", text: "Execute" }],
      },
      authorization: {} as ExecutionEnvironmentSpec["task"]["authorization"],
      contextPlan: {} as ExecutionEnvironmentSpec["task"]["contextPlan"],
      execution: {},
      workerProfile: { id: "shared", revision: "1" },
    },
    profile: {
      ref: { id: "shared", revision: "1" },
      workerType: "supertag",
      harness: { provider: "fixture" },
      execution: { provider: "shared-execution:test-shared", lifetime: { scope: "attempt" } },
    },
    plan: plan(),
  };
}
