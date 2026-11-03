import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { emptyTagContextPlan } from "../../packages/core/src/index.ts";
import type { TaskAttemptSpec } from "../../packages/runtime/sdk/src/index.ts";
import { RemoteWorkletServer } from "../../packages/runtime/transport/src/index.ts";
import { sharedTokenAuthentication } from "../support/worklet-authentication.js";

const python = process.env["SUPERTAG_PYTHON_BIN"];
it.skipIf(!python)(
  "Python protocol 18 persists receipt/cursor through host restart without replay",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "python-durable-"));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let protocolVersion: number | undefined;
    let remote = new RemoteWorkletServer({
      server,
      onWorkletConnected: (_descriptor, session) => {
        protocolVersion = session.protocolVersion;
      },
      authenticateWorklet: sharedTokenAuthentication("test-token"),
      durableAcknowledgementTimeoutMs: 5000,
    });
    remote.start();
    const gate = join(directory, "release");
    const starts = join(directory, "starts");
    await writeFile(gate, "ready");
    let child: ChildProcess | undefined;
    let errors = "";
    const start = async () => {
      child = spawn(python as string, [resolve("sdks/python/tests/fixtures/custom_worklet.py")], {
        env: {
          ...process.env,
          SUPERTAG_CONTROL_PLANE_URL: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/worklets`,
          SUPERTAG_WORKLET_TOKEN: "test-token",
          SUPERTAG_TEST_JOURNAL: join(directory, "journal"),
          SUPERTAG_TEST_GATE: gate,
          SUPERTAG_TEST_STARTS: starts,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr?.on("data", (chunk) => {
        errors += String(chunk);
      });
      await expect
        .poll(
          () =>
            remote.supportsDurableExecution(
              { id: "example-python", revision: "1" },
              emptyTagContextPlan(new Date().toISOString()),
            ),
          { timeout: 10000 },
        )
        .toBe(true);
    };
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await closed;
      }
      child = undefined;
    };
    try {
      await start();
      expect(await remote.inspect("missing")).toBeUndefined();
      const spec = attempt();
      expect(protocolVersion).toBe(18);
      const options = {
        allowedWorkerHostIds: ["python-custom-host"],
        compatibleProfile: spec.workerProfile,
      };
      const released = await remote.selectPlacement(spec.execution, spec.contextPlan, options);
      expect(released?.reservation).toBeDefined();
      expect(
        await remote.selectPlacement(spec.execution, spec.contextPlan, options),
      ).toBeUndefined();
      if (!released) throw new Error("Python Worklet did not reserve placement");
      await remote.releasePlacement(released);
      const placement = await remote.selectPlacement(spec.execution, spec.contextPlan, options);
      expect(placement?.reservation).toBeDefined();
      if (!placement) throw new Error("Python Worklet did not reserve placement");
      const reservedSpec: TaskAttemptSpec = {
        ...spec,
        placement: { ...placement, allowedWorkerHostIds: ["python-custom-host"] },
      };
      const receipt = await remote.accept(reservedSpec);
      expect(receipt.workerId).toBe("external-python");
      const events = [];
      for await (const item of remote.events(spec.attemptId)) events.push(item);
      expect(events.at(-1)?.event.type, errors).toBe("execution.completed");
      expect((await remote.inspect(spec.attemptId))?.status).toBe("completed");
      await stop();
      await expect
        .poll(() => remote.supportsDurableExecution(spec.workerProfile, spec.contextPlan))
        .toBe(false);
      await start();
      expect(await remote.accept(reservedSpec)).toMatchObject({
        specDigest: receipt.specDigest,
        status: "completed",
      });
      const replay = [];
      for await (const item of remote.events(spec.attemptId, 1)) replay.push(item);
      expect(replay).toEqual(events.slice(1));
      expect((await remote.inspect(spec.attemptId))?.lastSequence).toBe(events.length);
      // Disconnect the Control Plane while execution is active; output is journaled offline.
      await rm(gate);
      const offline = attempt("offline-task");
      await remote.accept(offline);
      await expect
        .poll(async () => (await readFile(starts, "utf8")).includes(offline.attemptId))
        .toBe(true);
      await remote.stop();
      await writeFile(gate, "ready");
      remote = new RemoteWorkletServer({
        server,
        authenticateWorklet: sharedTokenAuthentication("test-token"),
        durableAcknowledgementTimeoutMs: 5000,
      });
      remote.start();
      // A reconnect can start while the upgrade listener is absent. Allow the Python
      // WebSocket handshake timeout (10s) and the subsequent reconnect backoff.
      await expect
        .poll(() => remote.supportsDurableExecution(spec.workerProfile, spec.contextPlan), {
          timeout: 15000,
        })
        .toBe(true);
      await expect
        .poll(async () => (await remote.inspect(offline.attemptId))?.status)
        .toBe("completed");
      const offlineEvents = [];
      for await (const item of remote.events(offline.attemptId)) offlineEvents.push(item);
      expect(offlineEvents.at(-1)?.event.type).toBe("execution.completed");
      // Crash the Python host with an accepted execution; never replay it on restart.
      await rm(gate);
      const crashed = attempt("crashed-task");
      await remote.accept(crashed);
      await expect
        .poll(async () => (await readFile(starts, "utf8")).includes(crashed.attemptId))
        .toBe(true);
      const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
      child?.kill("SIGKILL");
      await exited;
      child = undefined;
      await expect
        .poll(() => remote.supportsDurableExecution(spec.workerProfile, spec.contextPlan))
        .toBe(false);
      await start();
      expect((await remote.inspect(crashed.attemptId))?.status).toBe("unknown");
      expect((await remote.accept(crashed)).status).toBe("unknown");
      await expect(remote.accept(attempt("blocked-task"))).rejects.toThrow(
        /No durable Worklet available/,
      );
      expect((await readFile(starts, "utf8")).trim().split("\n")).toEqual([
        spec.attemptId,
        offline.attemptId,
        crashed.attemptId,
      ]);
    } finally {
      await stop();
      await remote.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

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
