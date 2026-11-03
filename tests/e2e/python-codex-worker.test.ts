import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyTagContextPlan } from "../../packages/core/src/index.ts";
import {
  collectTaskAttemptEvents,
  type SessionStateRef,
  type TaskAttemptSpec,
  terminalOutputText,
} from "../../packages/runtime/sdk/src/index.ts";
import { RemoteWorkletServer } from "../../packages/runtime/transport/src/index.ts";
import { sharedTokenAuthentication } from "../support/worklet-authentication.js";

const python = process.env["SUPERTAG_PYTHON_BIN"];
const credential = "python-codex-live-e2e-token";
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

describe.skipIf(python === undefined || process.env["SUPERTAG_LIVE_MODEL_TESTS"] !== "1")(
  "live Python Codex Worker",
  () => {
    it("answers a codebase question through Worklet protocol 18 and the official Codex SDK", async () => {
      const server = await listen();
      const remote = new RemoteWorkletServer({
        server,
        authenticateWorklet: sharedTokenAuthentication(credential),
        path: "/worklets",
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 5_000,
        durableAcknowledgementTimeoutMs: 180_000,
      });
      remote.start();
      remoteServers.push(remote);

      let stderr = "";
      const child = spawn(python as string, [resolve("sdks/python/examples/codex_worker.py")], {
        cwd: resolve("."),
        env: {
          ...process.env,
          SUPERTAG_CONTROL_PLANE_URL: workerUrl(server),
          SUPERTAG_WORKER_TIMEOUT_SECONDS: "150",
          SUPERTAG_WORKER_WORKSPACE: resolve("."),
          SUPERTAG_WORKLET_TOKEN: credential,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      children.push(child);

      await vi.waitFor(
        async () => {
          expect(
            await remote.canExecute(
              { id: "codex", revision: "1" },
              emptyTagContextPlan("2026-08-01T00:00:00.000Z"),
            ),
          ).toBe(true);
        },
        { timeout: 20_000, interval: 100 },
      );

      const events = await collectTaskAttemptEvents(remote.execute(attempt()));
      const output = terminalOutputText(events);
      expect(events.at(0)?.type).toBe("execution.started");
      expect(events.at(-1)?.type, stderr).toBe("execution.completed");
      expect(output).toContain("sdks/python/src/supertag/models.py");
      expect(output).toMatch(/\b9\b/);

      const sessionStateEvent = events.findLast((event) => event.type === "session.updated");
      expect(sessionStateEvent?.type).toBe("session.updated");
      const sessionState =
        sessionStateEvent?.type === "session.updated" ? sessionStateEvent.sessionState : undefined;
      const followUp = await collectTaskAttemptEvents(
        remote.execute(
          attempt(
            "python-codex-live-follow-up",
            "What integer did you identify in the previous turn? Answer with just that integer.",
            sessionState,
          ),
        ),
      );
      expect(terminalOutputText(followUp).trim()).toBe("13");
    }, 200_000);
  },
);

function attempt(
  taskId = "python-codex-live-task",
  question = "In sdks/python/src/supertag/models.py, what integer is assigned to WORKLET_PROTOCOL_VERSION? Answer in one sentence and include the file path.",
  sessionState?: SessionStateRef,
): TaskAttemptSpec {
  const capturedAt = new Date().toISOString();
  const workerProfile = { id: "codex", revision: "1" };
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
        sessionKey: "slack:engineering:python-codex-live",
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
      id: "python-codex-live-session",
      history: [],
      ...(sessionState === undefined ? {} : { sessionState }),
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
