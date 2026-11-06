import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { registerSessionGrpcRoutes } from "../apps/cli/src/session-grpc.js";
import { handleSessionRequest } from "../apps/cli/src/session-http.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { SessionContinuity } from "../packages/control-plane/src/session-continuity.js";
import { SessionPersistence } from "../packages/control-plane/src/session-persistence.js";
import {
  emptyTagContextPlan,
  type SurfaceTagAuthorizationSnapshot,
} from "../packages/core/src/index.js";
import { SharedExecutionEnvironmentProvider } from "../packages/runtime/environments/shared-execution/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  LocalExecutionEnvironmentProvider,
  LocalHarnessRuntimeProvider,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  terminalOutputText,
} from "../packages/runtime/sdk/src/index.js";
import {
  GrpcSessionStateStore,
  RemoteWorkletServer,
  startWorkletGrpcServer,
} from "../packages/runtime/transport/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "../tests/support/database.js";
import { sharedTokenAuthentication } from "../tests/support/worklet-authentication.js";
import { createDockerSessionWorkers } from "./session-persistence-docker.js";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    worker: { type: "boolean" },
    "docker-worker": { type: "boolean" },
    provider: { type: "string" },
    mode: { type: "string" },
    output: { type: "string" },
    database: { type: "string" },
    transport: { type: "string" },
  },
});
if (!values.live) throw new Error("Pass --live to run subscription-authenticated native sessions");
const provider = values.provider ?? "codex";
if (!["codex", "claude-code"].includes(provider)) throw new Error("Unsupported Harness");
const mode = values.mode ?? "app-server";
const transport = values.transport ?? "http";
if (!["http", "grpc"].includes(transport)) throw new Error("Unsupported Session transport");
if (transport === "grpc" && values["docker-worker"])
  throw new Error("Use local child Workers for the gRPC continuity probe");
if (!["exec", "app-server"].includes(mode)) throw new Error("Unsupported Codex mode");
const root = resolve(import.meta.dirname, "..");
const profile = { id: "session-live", revision: "1" };

if (values.worker) {
  const specification = process.env["SUPERTAG_SESSION_LIVE_SPEC"];
  const source = process.env["SUPERTAG_SESSION_LIVE_SOURCE"];
  const runtime = process.env["SUPERTAG_SESSION_LIVE_RUNTIME"];
  if (!specification || !source || !runtime)
    throw new Error("Missing isolated Worker configuration");
  const spec: TaskAttemptSpec = JSON.parse(await readFile(specification, "utf8"));
  const remoteUrl = process.env["SUPERTAG_SESSION_LIVE_EXECUTION_URL"];
  const executionEnvironment = remoteUrl
    ? new SharedExecutionEnvironmentProvider({
        baseUrl: remoteUrl,
        adminToken: process.env["SUPERTAG_SESSION_LIVE_EXECUTION_TOKEN"] ?? "",
        environmentId: process.env["SUPERTAG_SESSION_LIVE_EXECUTION_ID"] ?? "session-live",
        guarantees: {
          filesystemIsolation: "sandbox",
          networkPolicy: "none",
          processTreeTermination: true,
          scopedHttp: false,
        },
      })
    : new LocalExecutionEnvironmentProvider({ temporaryDirectory: runtime });
  const options = {
    workspace: source,
    profileId: profile.id,
    profileRevision: profile.revision,
    timeoutMs: 150_000,
    executionEnvironment,
    ...(process.env["SUPERTAG_SESSION_LIVE_GRPC_URL"]
      ? {
          sessionStateStore: (attempt: TaskAttemptSpec) => {
            const authority = attempt.session?.persistence ?? attempt.coordination;
            if (!authority) throw new Error("Session authority unavailable");
            return new GrpcSessionStateStore({
              baseUrl: process.env["SUPERTAG_SESSION_LIVE_GRPC_URL"] as string,
              token: authority.token,
            });
          },
        }
      : {}),
    ...(remoteUrl
      ? { harnessRuntime: new LocalHarnessRuntimeProvider({ temporaryDirectory: runtime }) }
      : {}),
  };
  const worker =
    provider === "codex"
      ? createCodexWorker({
          ...options,
          executionMode: mode as "exec" | "app-server",
          model: "gpt-5.6-luna",
          maxNativeAgents: 0,
          ...(remoteUrl ? { sandboxMode: "external" as const } : {}),
        })
      : createClaudeCodeWorker({ ...options, maxTurns: 8 });
  const events: TaskAttemptEvent[] = [];
  for await (const event of worker.execute(spec)) events.push(event);
  process.stdout.write(JSON.stringify({ pid: process.pid, events }));
} else {
  await main();
}

async function main() {
  const cleanups: Array<() => Promise<unknown>> = [];
  const failures: unknown[] = [];
  try {
    await runProbe(cleanups);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Session probe or cleanup failed");
}

async function runProbe(cleanups: Array<() => Promise<unknown>>) {
  const directory = resolve(
    values.output ?? `.supertag/session-live/${provider}-${mode}-${Date.now()}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (values["docker-worker"] && process.env["SUPERTAG_SESSION_LIVE_EXECUTION_URL"])
    throw new Error(
      "Docker Worker probe currently tests colocated execution; omit remote execution configuration",
    );
  let dockerWorkers: Awaited<ReturnType<typeof createDockerSessionWorkers>> | undefined;
  const source = join(directory, "source");
  await mkdir(source);
  const secret = `SESSION_FACT_${randomUUID().replaceAll("-", "")}`;
  await writeFile(join(source, "challenge.txt"), secret, { mode: 0o600 });
  const dialect = values.database ?? "sqlite";
  if (!["sqlite", "postgresql"].includes(dialect)) throw new Error("Unsupported database");
  const isolated =
    dialect === "postgresql"
      ? await createIsolatedPostgresDatabase(process.env["SUPERTAG_POSTGRES_URL"] ?? "")
      : undefined;
  if (isolated) cleanups.push(() => isolated.cleanup());
  const url = isolated?.url ?? `file:${join(directory, "session.db")}`;
  await migrateDatabase({ url });
  let store = new DrizzleStore({ url });
  cleanups.push(() => store.disconnect());
  await store.connect();
  let authority = new ObjectiveController(store, undefined);
  let service = new SessionPersistence(store, authority);
  let grpc: Awaited<ReturnType<typeof startWorkletGrpcServer>> | undefined;
  let grpcRemote: RemoteWorkletServer | undefined;
  let server = await startServer();
  cleanups.push(async () => {
    if (server.listening) await closeServer();
  });
  let base = serverUrl();
  authority.activateCoordination({ url: base });
  const at = new Date().toISOString();
  const tag = await store.createTag({ name: `SessionLive-${randomUUID()}` });
  const account = await store.saveSurfaceAccount({
    provider: "slack",
    externalAccountId: randomUUID(),
    displayName: "Isolated live test",
    authMethod: "simulation",
    credentialId: "none",
    status: "connected",
    configuration: {},
    verifiedAt: at,
  });
  const route = await store.addTagRoute({
    tagId: tag.id,
    surfaceAccountId: account.id,
    scope: "channel:session-live",
  });
  const sessionKey = randomUUID();
  const session = await store.openSession({ tagId: tag.id, sessionKey, origin: {}, at });
  const phases: Array<Record<string, unknown>> = [];
  {
    if (values["docker-worker"]) {
      dockerWorkers = await createDockerSessionWorkers(directory, root, provider, mode);
      cleanups.push(() => dockerWorkers?.close() ?? Promise.resolve());
      base = await dockerWorkers.setUpstream(serverUrl());
      authority.activateCoordination({ url: base });
    }
    for (const phase of ["initial", "resumed"] as const) {
      const now = new Date().toISOString();
      const prompt =
        phase === "initial"
          ? "Read challenge.txt using a workspace tool. Memorize its exact contents for our next turn. Do not write any files or repeat its contents now. Reply only READY. Do not spawn subagents."
          : "What was the exact content of challenge.txt that you read in the previous turn? The file and previous Worker are gone. Do not use tools or search the filesystem. Reply only with the exact remembered content.";
      const event = {
        eventId: randomUUID(),
        logicalEventId: randomUUID(),
        provider: "slack",
        externalAccountId: account.externalAccountId,
        kind: "message",
        scope: "channel:session-live",
        sessionKey,
        actor: { id: "live-test", kind: "user" },
        text: prompt,
        occurredAt: now,
        callback: {
          provider: "slack",
          mode: "slack_thread",
          threadKey: sessionKey,
          target: { channelId: "session-live", threadTs: sessionKey },
        },
        source: {},
        metadata: {},
      } as const;
      const authorization: SurfaceTagAuthorizationSnapshot = {
        version: 5,
        capturedAt: now,
        tag: { id: tag.id, name: tag.name },
        origin: {
          provider: "slack",
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          scope: event.scope,
        },
        requester: event.actor,
        permissionSets: [],
        resources: [],
        runtimeActions: [
          "files:write",
          "commands:execute",
          ...(process.env["SUPERTAG_SESSION_LIVE_EXECUTION_URL"]
            ? ["web:fetch", "web:search"]
            : []),
        ],
      };
      const contextPlan = emptyTagContextPlan(now);
      const admitted = await store.admitInboundEvent({
        surfaceAccountId: account.id,
        tagRouteId: route.id,
        tagId: tag.id,
        authorization,
        contextPlan,
        event,
      });
      const pending = await store.openTask({
        inboundEventId: admitted.work.id,
        tagId: tag.id,
        sessionId: session.id,
        execution: {},
        actor: event.actor,
        trigger: {},
        workspacePlan: { version: 1, status: "none" },
        sessionHistory: [],
        authorizationSnapshot: authorization,
        contextPlan,
        createdAt: now,
      });
      assert(
        await store.claimDueInboundEvent({
          inboundEventId: admitted.work.id,
          leaseOwner: "session-live",
          now: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      );
      const task = await store.startTask({ taskId: pending.id, startedAt: now });
      const attempt = await store.createTaskAttempt({
        taskId: task.id,
        attemptNumber: 1,
        workerProfile: profile,
        workerSnapshot: {},
        startedAt: now,
      });
      const prior = await new SessionContinuity(store).readTask(task, attempt.id);
      if (phase === "resumed") assert(prior, "No compatible native state selected");
      const persistence = await authority.sessionPersistence(task, attempt);
      assert(persistence);
      const spec: TaskAttemptSpec = {
        version: 2,
        taskId: task.id,
        attemptId: attempt.id,
        tag: { id: tag.id, name: tag.name },
        authorization,
        contextPlan,
        workspacePlan: task.workspacePlan,
        execution: {},
        workerProfile: profile,
        session: {
          id: session.id,
          persistence,
          history: [],
          ...(prior ? { sessionState: prior } : {}),
        },
        input: {
          origin: {
            surface: "slack",
            accountId: account.id,
            scope: event.scope,
            sessionKey,
            occurredAt: now,
          },
          messages: [{ id: event.eventId, role: "requester", text: prompt }],
        },
      };
      assert(!JSON.stringify(spec).includes(secret), "Secret leaked into replacement input");
      const specPath = join(directory, `${phase}-spec.json`);
      await writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
      const runtime = join(directory, `runtime-${phase}`);
      await mkdir(runtime);
      const env: NodeJS.ProcessEnv = {
        ...Object.fromEntries(
          [
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "TMPDIR",
            "TMP",
            "TEMP",
            "LANG",
            "LC_ALL",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_SECURESTORAGE_CONFIG_DIR",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "XDG_CONFIG_HOME",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
            "NODE_EXTRA_CA_CERTS",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "SUPERTAG_SESSION_LIVE_EXECUTION_URL",
            "SUPERTAG_SESSION_LIVE_EXECUTION_TOKEN",
            "SUPERTAG_SESSION_LIVE_EXECUTION_ID",
          ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
        ),
        SUPERTAG_SESSION_LIVE_SPEC: specPath,
        SUPERTAG_SESSION_LIVE_SOURCE: source,
        SUPERTAG_SESSION_LIVE_RUNTIME: runtime,
        ...(grpc ? { SUPERTAG_SESSION_LIVE_GRPC_URL: grpc.url } : {}),
      };
      let result: { pid: number; containerId?: string; events: TaskAttemptEvent[] };
      try {
        if (dockerWorkers) {
          result = await dockerWorkers.execute(specPath, source, runtime);
        } else {
          const child = await promisify(execFile)(
            "pnpm",
            [
              "exec",
              "tsx",
              "--conditions=development",
              import.meta.filename,
              "--live",
              "--worker",
              "--provider",
              provider,
              "--mode",
              mode,
            ],
            { cwd: root, env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
          );
          result = JSON.parse(child.stdout);
        }
      } finally {
        await rm(specPath, { force: true });
      }
      const terminal = result.events.at(-1);
      if (terminal?.type !== "execution.completed") {
        await writeFile(join(directory, `${phase}-failure.json`), JSON.stringify(result, null, 2), {
          mode: 0o600,
        });
        throw new Error(`${phase} failed: ${JSON.stringify(terminal)}`);
      }
      const candidate = result.events.findLast((entry) => entry.type === "session.updated");
      assert(candidate?.type === "session.updated", "Native Session state was not emitted");
      await new SessionContinuity(store).saveTask(task, profile, result.events);
      const state = await store.findSessionState(candidate.sessionState.id);
      assert.equal(state?.status, "resumable");
      assert(state?.nativeId);
      if (phase === "initial")
        assert(
          JSON.stringify(state.data).includes(secret),
          "The initial CLI never read the private fact; inspect native tool failures before testing resume",
        );
      if (phase === "resumed") {
        assert.equal(
          state.nativeId,
          phases[0]?.["nativeId"],
          "Resumption created a different native conversation",
        );
        assert(
          terminalOutputText(result.events).includes(secret),
          "Resumed CLI did not recover the private fact",
        );
        if (dockerWorkers) assert.notEqual(result.containerId, phases[0]?.["containerId"]);
        else assert.notEqual(result.pid, phases[0]?.["pid"]);
      }
      phases.push({
        phase,
        pid: result.pid,
        ...(result.containerId
          ? { containerId: result.containerId, originalContainerRemoved: true }
          : {}),
        nativeId: state.nativeId,
        stateId: state.id,
        bytes: Buffer.byteLength(JSON.stringify(state.data)),
        completed: true,
        nativeFactRecovered: phase === "resumed",
        replayHistoryEntries: 0,
        runtimeManifest: result.events.find((entry) => entry.type === "runtime-inputs.resolved"),
      });
      const endedAt = new Date().toISOString();
      await store.closeTaskAttempt({ attemptId: attempt.id, status: "completed", endedAt });
      await store.closeTask({ taskId: task.id, status: "completed", endedAt });
      await store.completeInboundEvent({
        inboundEventId: admitted.work.id,
        leaseOwner: "session-live",
        workerId: "live-worker",
        responseText: "Done",
        completedAt: endedAt,
      });
      await rm(runtime, { recursive: true, force: true });
      if (phase === "initial") {
        await removeSharedChallenge(spec);
        await rm(source, { recursive: true, force: true });
        await mkdir(source);
        await closeServer();
        await store.disconnect();
        store = new DrizzleStore({ url });
        await store.connect();
        authority = new ObjectiveController(store, undefined);
        service = new SessionPersistence(store, authority);
        server = await startServer();
        base = dockerWorkers ? await dockerWorkers.setUpstream(serverUrl()) : serverUrl();
        authority.activateCoordination({ url: base });
      }
    }
    const report = {
      verification: "VERIFIED",
      provider,
      mode,
      database: dialect,
      execution: process.env["SUPERTAG_SESSION_LIVE_EXECUTION_URL"] ? "shared" : "local",
      persistence: `real ${transport} and database with purpose-scoped credentials`,
      workerProcessesReplaced: true,
      workerPlacement: dockerWorkers ? "fresh Linux Docker containers" : "local child processes",
      ...(dockerWorkers
        ? {
            dockerSecurity: {
              nonroot: true,
              readOnlyRoot: true,
              droppedCapabilities: "ALL",
              seccomp:
                provider === "codex"
                  ? "unconfined to enable native bwrap namespaces"
                  : "Docker default",
              nativeHarnessSandbox: "unchanged",
            },
          }
        : {}),
      serviceRestarted: true,
      originalSourceRemoved: true,
      secretDigest: createHash("sha256").update(secret).digest("hex"),
      phases,
    };
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        verification: report.verification,
        provider,
        mode,
        database: dialect,
        report: join(directory, "report.json"),
      }),
    );
  }
  async function startServer() {
    const next = createServer((request, response) => {
      void handleSessionRequest(
        request,
        response,
        new URL(request.url ?? "/", "http://localhost"),
        service,
      );
    });
    await new Promise<void>((done) => next.listen(0, "127.0.0.1", done));
    if (transport === "grpc") {
      grpcRemote = new RemoteWorkletServer({
        server: next,
        authenticateWorklet: sharedTokenAuthentication(randomUUID()),
      });
      grpcRemote.start();
      grpc = await startWorkletGrpcServer({
        remote: grpcRemote,
        registerRoutes: (router) => registerSessionGrpcRoutes(router, service),
      });
    }
    return next;
  }
  function serverUrl() {
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function closeServer() {
    await grpc?.close();
    await grpcRemote?.stop();
    grpc = undefined;
    grpcRemote = undefined;
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
}

/** Remove only this probe's evidence from the persistent shared workspace before recall. */
async function removeSharedChallenge(spec: TaskAttemptSpec) {
  const base = process.env["SUPERTAG_SESSION_LIVE_EXECUTION_URL"];
  if (!base) return;
  const id = randomUUID();
  const accessToken = randomUUID();
  const request = async (path: string, token: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Shared challenge cleanup failed: ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const grant = await request(
    `/v1/accesses/${id}`,
    process.env["SUPERTAG_SESSION_LIVE_EXECUTION_TOKEN"] ?? "",
    "PUT",
    {
      taskId: spec.taskId,
      attemptId: `cleanup-${id}`,
      tagId: spec.tag.id,
      accessToken,
      ttlMs: 60_000,
    },
  );
  try {
    let receipt = await request(`/v1/operations/${id}`, accessToken, "POST", {
      kind: "process.start",
      command: "node",
      args: ["-e", "require('fs').unlinkSync('challenge.txt')"],
      cwd: `${grant["rootDirectory"]}/workspace`,
      environment: {},
      timeoutMs: 10_000,
    });
    const deadline = Date.now() + 20_000;
    while (!["completed", "failed"].includes(String(receipt["status"]))) {
      if (Date.now() > deadline) throw new Error("Shared challenge cleanup did not finish");
      await new Promise((done) => setTimeout(done, 100));
      receipt = await request(`/v1/operations/${id}`, accessToken);
    }
    assert.equal(receipt["status"], "completed", "Shared challenge was not removed");
    assert.equal(
      (receipt["result"] as { exitCode?: number } | undefined)?.exitCode,
      0,
      "Shared challenge removal command failed",
    );
  } finally {
    await request(`/v1/accesses/${id}`, accessToken, "POST");
  }
}
