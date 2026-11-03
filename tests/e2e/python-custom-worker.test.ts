import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyTagContextPlan } from "../../packages/core/src/index.ts";
import {
  collectTaskAttemptEvents,
  type TaskAttemptSpec,
  terminalOutputText,
} from "../../packages/runtime/sdk/src/index.ts";
import { RemoteWorkletServer } from "../../packages/runtime/transport/src/index.ts";
import { sharedTokenAuthentication } from "../support/worklet-authentication.js";

const python = process.env["SUPERTAG_PYTHON_BIN"];
const credential = "python-custom-e2e-token";
const servers: Server[] = [];
const remoteServers: RemoteWorkletServer[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }
  }
  await Promise.allSettled(remoteServers.splice(0).map((remote) => remote.stop()));
  await Promise.allSettled(servers.splice(0).map(closeServer));
});

describe.skipIf(python === undefined)("custom Python Harness and Environment", () => {
  it("executes through the real Worklet API with an external Python Harness and Environment", async () => {
    const server = await listen();
    let protocolVersion: number | undefined;
    const remote = new RemoteWorkletServer({
      server,
      onWorkletConnected: (_descriptor, session) => {
        protocolVersion = session.protocolVersion;
      },
      authenticateWorklet: sharedTokenAuthentication(credential),
      path: "/worklets",
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 5_000,
      durableAcknowledgementTimeoutMs: 180_000,
    });
    remote.start();
    remoteServers.push(remote);

    let stderr = "";
    const child = spawn(
      python as string,
      [resolve("sdks/python/tests/fixtures/custom_worklet.py")],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          SUPERTAG_CONTROL_PLANE_URL: workerUrl(server),
          SUPERTAG_WORKER_TIMEOUT_SECONDS: "150",
          SUPERTAG_WORKER_WORKSPACE: resolve("."),
          SUPERTAG_WORKLET_TOKEN: credential,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    children.push(child);

    await vi.waitFor(
      async () => {
        expect(
          await remote.canExecute(
            { id: "example-python", revision: "1" },
            emptyTagContextPlan("2026-08-01T00:00:00.000Z"),
          ),
        ).toBe(true);
      },
      { timeout: 20_000, interval: 100 },
    );

    expect(protocolVersion).toBe(18);
    const events = await collectTaskAttemptEvents(remote.execute(attempt()));
    const output = terminalOutputText(events);
    expect(events.at(0)?.type).toBe("execution.started");
    expect(events.at(-1)?.type, stderr).toBe("execution.completed");
    expect(output).toBe("Example Python Harness received: Hello from another language");
  }, 30_000);
});

function attempt(
  taskId = "python-custom-task",
  question = "Hello from another language",
): TaskAttemptSpec {
  const capturedAt = new Date().toISOString();
  const workerProfile = { id: "example-python", revision: "1" };
  return {
    execution: {},
    version: 2,
    taskId,
    attemptId: `${taskId}-attempt`,
    tag: { id: "engineering", name: "Engineering" },
    input: {
      origin: {
        surface: "slack",
        accountId: "slack-acme",
        scope: "channel:engineering",
        sessionKey: "slack:engineering:python-custom",
        occurredAt: capturedAt,
      },
      messages: [
        {
          id: "message-1",
          role: "requester",
          text: question,
        },
      ],
    },
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "engineering", name: "Engineering" },
      origin: {
        tagRouteId: "route-1",
        surfaceAccountId: "slack-acme",
        provider: "slack",
        scope: "channel:engineering",
      },
      requester: { id: "user-1", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    contextPlan: emptyTagContextPlan(capturedAt),
    workspacePlan: { version: 1, status: "none" },
    workerProfile,
    session: {
      id: "python-custom-session",
      history: [],
    },
  };
}

async function listen(): Promise<Server> {
  const server = createServer((_request, response) => response.writeHead(404).end());
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  servers.push(server);
  return server;
}

function workerUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}/worklets`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
}
