import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { ControlPlaneApiServer } from "../apps/cli/src/control-plane-api.js";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import type { TaskAttemptSpec } from "../packages/runtime/sdk/src/index.js";
import { RemoteWorkletServer } from "../packages/runtime/transport/src/index.js";
import { DrizzleStore, FileGatewayCredentialVault } from "../packages/store/src/index.js";
import { migrateSqlite } from "./support/database.js";

const execute = promisify(execFile);
it.skipIf(process.env["SUPERTAG_RUN_GO_CONFORMANCE"] !== "1")(
  "verifies the experimental Worklet contract using an independent Go peer and the API owner",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-go-worklet-"));
    const processes: ChildProcess[] = [];
    let api: ControlPlaneApiServer | undefined;
    let controlPlane: ControlPlane | undefined;
    let store: DrizzleStore | undefined;
    const logs: string[] = [];
    async function stop(child: ChildProcess) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      const descriptor = join(directory, "worklet.pb");
      const binary = join(directory, "worklet");
      await execute("pnpm", [
        "exec",
        "buf",
        "build",
        "spec/proto",
        "--as-file-descriptor-set",
        "-o",
        descriptor,
      ]);
      await execute(
        process.env["SUPERTAG_CONFORMANCE_GO"] ?? "go",
        ["build", "-mod=readonly", "-o", binary, "."],
        { cwd: resolve("tests/fixtures/go-worklet"), timeout: 90_000 },
      );
      const key = join(directory, "server.key");
      const cert = join(directory, "server.crt");
      await execute("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ]);
      const database = join(directory, "state.db");
      await migrateSqlite(database);
      store = new DrizzleStore({ url: `file:${database}` });
      const credentialVault = new FileGatewayCredentialVault(join(directory, "vault.json"));
      const remote = new RemoteWorkletServer({
        server: createServer(),
        authenticateWorklet: (request) => {
          if (!controlPlane) throw new Error("No owner");
          return controlPlane.authenticateWorkerHost(request);
        },
        onWorkletObserved: (observation) => controlPlane?.observeWorkerHostConnection(observation),
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 2000,
        durableAcknowledgementTimeoutMs: 3000,
        onError: (error) => logs.push(String(error)),
      });
      controlPlane = new ControlPlane({
        store,
        credentialVault,
        worklet: remote,
        reply: async () => {},
      });
      await controlPlane.start();
      api = new ControlPlaneApiServer({
        controlPlane,
        store,
        credentialVault,
        surfaceController: { name: "surfaces", status: () => ({ active: 0, errors: [] }) },
        startedAt: new Date().toISOString(),
        coordinationOperatorCredentials: [],
        workletApi: remote,
      });
      api.start();
      const tls = { key: await readFile(key), cert: await readFile(cert) };
      let endpoint = await api.startWorkletGrpc({ tls });
      const port = Number(new URL(endpoint).port);
      const enrolled = await controlPlane.enrollWorkerHost({ id: "go-host" });
      const credential = enrolled.token;
      const statePath = join(directory, "go-state.json");
      function launch(token: string, host = "go-host", peerStatePath = statePath) {
        const child = spawn(binary, [], {
          env: {
            ...process.env,
            SUPERTAG_CONFORMANCE_DESCRIPTOR: descriptor,
            SUPERTAG_CONFORMANCE_ENDPOINT: new URL(endpoint).host,
            SUPERTAG_CONFORMANCE_CA: cert,
            SUPERTAG_CONFORMANCE_CREDENTIAL: token,
            SUPERTAG_CONFORMANCE_HOST: host,
            SUPERTAG_CONFORMANCE_PROTOCOL: "18",
            SUPERTAG_CONFORMANCE_STATE: peerStatePath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        processes.push(child);
        child.stdout?.on("data", (bytes) => logs.push(bytes.toString()));
        child.stderr?.on("data", (bytes) => logs.push(bytes.toString()));
        return child;
      }
      const invalid = launch("not-enrolled");
      await vi.waitFor(() => expect(invalid.exitCode, logs.join("\n")).toBe(3), { timeout: 5000 });
      expect(remote.isConnected).toBe(false);
      let child = launch(credential);
      await vi.waitFor(() => expect(remote.isConnected, logs.join("\n")).toBe(true), {
        timeout: 5000,
      });
      const firstGeneration = (await controlPlane.listWorkerHosts())[0]?.connectionGeneration;
      expect(firstGeneration).toBeGreaterThan(0);
      const at = new Date().toISOString();
      const baseSpec: TaskAttemptSpec = {
        version: 2,
        taskId: "go-task",
        attemptId: "go-attempt",
        tag: { id: "go-tag", name: "Conformance" },
        workerProfile: { id: "go-conformance", revision: "1" },
        execution: {},
        contextPlan: emptyTagContextPlan(at),
        workspacePlan: { version: 1, status: "none" },
        authorization: {
          version: 5,
          capturedAt: at,
          tag: { id: "go-tag", name: "Conformance" },
          origin: {
            tagRouteId: "route",
            surfaceAccountId: "account",
            provider: "github",
            scope: "repository:test",
          },
          requester: { id: "user", kind: "user" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        },
        input: {
          origin: {
            surface: "github",
            accountId: "account",
            scope: "repository:test",
            sessionKey: "session",
            occurredAt: at,
          },
          messages: [{ id: "message", role: "requester", text: "Validate the portable transport" }],
        },
      };
      const selectionOptions = { allowedWorkerHostIds: ["go-host"] };
      expect(
        await remote.selectPlacement(
          { profile: { id: "not-go-conformance", revision: "1" } },
          baseSpec.contextPlan,
          selectionOptions,
        ),
      ).toBeUndefined();
      const held = await remote.selectPlacement(
        baseSpec.execution,
        baseSpec.contextPlan,
        selectionOptions,
      );
      expect(held).toMatchObject({
        workerHostId: "go-host",
        workletId: "go-host",
        workerId: "go-worker",
        workerProfile: { id: "go-conformance", revision: "1" },
        reservation: { id: expect.any(String), expiresAt: expect.any(String) },
      });
      expect(
        await remote.selectPlacement(baseSpec.execution, baseSpec.contextPlan, selectionOptions),
      ).toBeUndefined();
      if (!held) throw new Error("Expected the Go peer to reserve placement");
      await remote.releasePlacement(held);
      const placement = await remote.selectPlacement(
        baseSpec.execution,
        baseSpec.contextPlan,
        selectionOptions,
      );
      if (!placement?.reservation) throw new Error("Expected a reservation");
      const spec: TaskAttemptSpec = {
        ...baseSpec,
        placement: {
          allowedWorkerHostIds: ["go-host"],
          workerHostId: placement.workerHostId,
          workletId: placement.workletId,
          workerId: placement.workerId,
          reservation: placement.reservation,
        },
      };
      const accepted = await remote.accept(spec);
      expect(accepted).toMatchObject({
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        status: "running",
      });
      expect(await remote.controlCapabilities(spec.taskId, spec.attemptId)).toMatchObject({
        operations: ["input", "interrupt"],
      });
      const first = remote.events(spec.attemptId)[Symbol.asyncIterator]();
      expect((await first.next()).value).toMatchObject({
        sequence: 1,
        event: { type: "execution.started" },
      });
      const input = {
        id: "input-1",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        type: "input" as const,
        text: "Go received this input",
      };
      expect(await remote.control(input)).toMatchObject({ id: input.id, status: "accepted" });
      expect((await first.next()).value).toMatchObject({
        sequence: 2,
        event: { type: "output.delta", text: input.text },
      });
      await first.return?.();
      // Drop the API listener; the independently running peer retains its accepted Attempt.
      await api.stop();
      api.start();
      endpoint = await api.startWorkletGrpc({ tls, port });
      await vi.waitFor(
        async () =>
          expect(
            (await controlPlane?.listWorkerHosts())?.[0]?.connectionGeneration,
          ).toBeGreaterThan(firstGeneration ?? 0),
        { timeout: 5000 },
      );
      expect(await remote.inspect(spec.attemptId)).toMatchObject({
        specDigest: accepted.specDigest,
        lastSequence: 2,
        status: "running",
      });
      // Restart the fixture process too: its test journal retains acceptance and control IDs.
      await stop(child);
      await vi.waitFor(() => expect(remote.isConnected).toBe(false));
      child = launch(credential);
      await vi.waitFor(() => expect(remote.isConnected, logs.join("\n")).toBe(true), {
        timeout: 5000,
      });
      expect(await remote.accept(spec)).toMatchObject({ specDigest: accepted.specDigest });
      expect(await remote.control(input)).toMatchObject({ status: "accepted" });
      expect(await remote.inspect(spec.attemptId)).toMatchObject({ lastSequence: 2 });
      const resumed = remote.events(spec.attemptId, 2)[Symbol.asyncIterator]();
      const completion = resumed.next();
      expect(
        await remote.control({
          id: "interrupt-1",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          type: "interrupt",
          reason: "Conformance complete",
        }),
      ).toMatchObject({ status: "accepted" });
      expect((await completion).value).toMatchObject({
        sequence: 3,
        event: { type: "execution.completed" },
      });
      expect((await resumed.next()).done).toBe(true);
      const otherBase = {
        ...baseSpec,
        taskId: "go-cancel-task",
        attemptId: "go-cancel-attempt",
      };
      const otherPlacement = await remote.selectPlacement(
        otherBase.execution,
        otherBase.contextPlan,
        selectionOptions,
      );
      if (!otherPlacement?.reservation) throw new Error("Expected a second reservation");
      const other: TaskAttemptSpec = {
        ...otherBase,
        placement: {
          allowedWorkerHostIds: ["go-host"],
          workerHostId: otherPlacement.workerHostId,
          workletId: otherPlacement.workletId,
          workerId: otherPlacement.workerId,
          reservation: otherPlacement.reservation,
        },
      };
      await remote.accept(other);
      expect(await remote.cancel(other.attemptId, "Conformance cancellation")).toMatchObject({
        status: "cancelled",
        cancellationRequested: true,
      });
      const stateText = await readFile(statePath, "utf8");
      expect(JSON.parse(stateText).acceptances).toBe(2);
      expect(stateText).not.toContain(credential);

      await stop(child);
      await vi.waitFor(() => expect(remote.isConnected).toBe(false));
    } finally {
      for (const child of processes) await stop(child);
      await api?.stop();
      await controlPlane?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
