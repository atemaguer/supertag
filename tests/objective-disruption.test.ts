import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  type ExecutionEnvironment,
  LocalExecutionEnvironmentProvider,
  LocalWorklet,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { connectDurableTestWorklet } from "./support/durable-test-connection.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

async function fixture(maxConcurrency = 1) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-disruption-"));
  const sourceWorkspace = join(directory, "source-workspace");
  await mkdir(sourceWorkspace);
  await writeFile(join(sourceWorkspace, "input.txt"), "Disruption fixture input");
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  const tag = await store.createTag({
    name: "Disruption",
  });
  for (const host of [
    "killed-host",
    "replacement-host",
    "old-host",
    "fresh-host",
    "objective-host",
  ])
    await store.bindTagWorkerHost(tag.id, host);
  await store.createObjective({
    id: "disruption",
    ownerTagId: tag.id,
    outcome: "Recover disrupted execution",
    budgetLimitMinor: 100,
  });
  await store.createTeam({
    id: "team",
    objectiveId: "disruption",
    name: "Recovery",
    leadTagId: tag.id,
    memberTagIds: [tag.id],
    maxConcurrency,
  });
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  const connections: Array<Awaited<ReturnType<typeof connectDurableTestWorklet>>> = [];
  const credentials = new Map<string, string>();
  const boot = async () => {
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "disruption-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    return runtime;
  };
  const enroll = async (id: string) => {
    const existing = credentials.get(id);
    if (existing) return existing;
    if (!runtime) throw new Error("Control Plane is not running");
    const credential = await enrollWorkerHost(runtime.url, "disruption-admin", id);
    credentials.set(id, credential);
    return credential;
  };
  const admin = async (command: string, arguments_: Record<string, unknown>) => {
    const response = await fetch(`${runtime?.url}/api/v1/coordination/${command}`, {
      method: "POST",
      headers: { Authorization: "Bearer disruption-admin", "Content-Type": "application/json" },
      body: JSON.stringify({ objectiveId: "disruption", ...arguments_ }),
    });
    expect(response.status, await response.text()).toBe(200);
  };
  const assign = (taskId: string) =>
    admin("assign_task", {
      taskId,
      teamId: "team",
      assignedTagId: tag.id,
      instruction: taskId,
      acceptanceCriteria: ["Fresh result"],
      maxCostMinor: 0,
    });
  const connect = async (worker: ReturnType<typeof createCodexWorker>, id: string) => {
    const credential = await enroll(id);
    const local = new LocalWorklet(id, id, [worker]);
    const connection = await connectDurableTestWorklet({
      url: `${runtime?.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet: local,
      durableWorklet: durableTestWorklet(local),
    });
    connections.push(connection);
    return connection;
  };
  const worker = (runner: NonNullable<Parameters<typeof createCodexWorker>[0]["runner"]>) =>
    createCodexWorker({
      workspace: sourceWorkspace,
      profileId: "disruption",
      executionEnvironment: new LocalExecutionEnvironmentProvider({
        temporaryDirectory: directory,
      }),
      runner,
    });
  const denied = async (authorization: string) => {
    const response = await fetch(`${runtime?.url}/internal/v1/coordination/mcp`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return response.status;
  };
  const cleanup = async () => {
    for (const connection of connections) await connection.stop();
    await runtime?.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, store, boot, enroll, assign, connect, worker, denied, cleanup };
}

it("reaps a SIGKILLed Worklet's owned directory on replacement while preserving live and external data", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // The unresolved durable Task retains its slot while a separate Task proves recovery.
  const f = await fixture(2);
  let child: ChildProcess | undefined;
  let liveEnvironment: ExecutionEnvironment | undefined;
  const externalDirectory = await mkdtemp(join(tmpdir(), "supertag-external-sentinels-"));
  try {
    const runtime = await f.boot();
    const state = { ready: false, authorization: "", rootDirectory: "", error: "" };
    child = fork(fileURLToPath(new URL("./support/disruption-worklet.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx", "--conditions=development"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.on(
      "message",
      (message: {
        type: string;
        authorization?: string;
        rootDirectory?: string;
        message?: string;
      }) => {
        if (message.type === "ready") state.ready = true;
        if (message.type === "executing") {
          state.authorization = message.authorization ?? "";
          state.rootDirectory = message.rootDirectory ?? "";
        }
        if (message.type === "error") state.error = message.message ?? "Fixture error";
      },
    );
    child.send({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      directory: f.directory,
      credential: await f.enroll("killed-host"),
    });
    await expect.poll(() => state.error || state.ready, { timeout: 10000 }).toBe(true);
    await f.assign("killed-task");
    await expect.poll(() => state.authorization.length > 0, { timeout: 10000 }).toBe(true);
    expect((await f.store.getTaskAssignment("killed-task"))?.status).toBe("running");
    expect((await stat(state.rootDirectory)).isDirectory()).toBe(true);
    const workspace = join(externalDirectory, "workspace"),
      sessionState = join(externalDirectory, "sessionState.json");
    await mkdir(workspace);
    await writeFile(join(workspace, "important.txt"), "preserve external workspace", {
      mode: 0o400,
    });
    await writeFile(sessionState, "preserve external sessionState", { mode: 0o400 });
    await symlink(workspace, join(state.rootDirectory, "external-workspace"), "dir");
    await symlink(sessionState, join(state.rootDirectory, "external-sessionState"), "file");
    const admitted = await f.store.findTaskById("killed-task");
    if (!admitted) throw new Error("Missing admitted Task");
    const liveProvider = new LocalExecutionEnvironmentProvider({ temporaryDirectory: f.directory });
    liveEnvironment = await liveProvider.provision({
      task: {
        execution: {},
        version: 1,
        taskId: "live-other-task",
        attemptId: "live-other-attempt",
        tag: { id: admitted.tagId, name: "Live" },
        input: {
          origin: {
            surface: "test",
            accountId: "test",
            scope: "test",
            sessionKey: "test",
            occurredAt: new Date().toISOString(),
          },
          messages: [],
        },
        authorization: admitted.authorizationSnapshot,
        contextPlan: admitted.contextPlan,
        workspacePlan: admitted.workspacePlan,
        workerProfile: { id: "disruption", revision: "1" },
      },
      profile: {
        ref: { id: "disruption", revision: "1" },
        workerType: "supertag",
        harness: { provider: "codex" },
        execution: { provider: liveProvider.id, lifetime: { scope: "attempt" } },
      },
      plan: {
        files: [],
        mounts: [],
        environmentVariables: {},
        secretBindings: [],
        network: { mode: "none" },
      },
    });
    await writeFile(join(liveEnvironment.rootDirectory, "live.txt"), "preserve live execution");

    const exited = once(child, "exit");
    child.kill("SIGKILL");
    expect(await exited).toEqual([null, "SIGKILL"]);
    // Stop lease renewal, then restart after expiry without assuming execution ended.
    await runtime.close();
    vi.setSystemTime(Date.now() + 31_000);
    await f.boot();
    await expect.poll(() => f.denied(state.authorization)).toBe(401);
    expect((await f.store.getTaskAssignment("killed-task"))?.status).toBe("running");
    await f.connect(
      f.worker(async function* () {
        yield { type: "output.message", text: "fresh replacement" };
      }),
      "replacement-host",
    );
    // Advertising the fresh Worklet invokes provider recovery before any Task is assigned.
    await expect(stat(state.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(liveEnvironment.rootDirectory, "live.txt"), "utf8")).toBe(
      "preserve live execution",
    );
    await f.assign("replacement-task");
    await expect
      .poll(async () => (await f.store.getTaskAssignment("replacement-task"))?.status)
      .toBe("submitted");
    expect((await f.store.getTaskAssignment("replacement-task"))?.result).toMatchObject({
      text: "fresh replacement",
    });
    await expect(stat(state.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(liveEnvironment.rootDirectory, "live.txt"), "utf8")).toBe(
      "preserve live execution",
    );
    expect(await readFile(join(workspace, "important.txt"), "utf8")).toBe(
      "preserve external workspace",
    );
    expect(await readFile(sessionState, "utf8")).toBe("preserve external sessionState");
    expect((await stat(join(workspace, "important.txt"))).mode & 0o777).toBe(0o400);
    expect((await stat(sessionState)).mode & 0o777).toBe(0o400);

    expect((await f.store.getTaskAssignment("killed-task"))?.attemptCount).toBe(1);
    expect((await f.store.getTaskAssignment("killed-task"))?.status).toBe("running");
    expect((await f.store.listTaskAttempts("killed-task"))[0]?.status).toBe("running");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await liveEnvironment?.dispose("completed");
    await f.cleanup();
    await rm(externalDirectory, { recursive: true, force: true });
    vi.useRealTimers();
  }
}, 20000);

it("keeps a durable zero-reservation Task unresolved after its host disconnects instead of rerunning it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); // Only lease time moves; transport and scheduling timers stay real.
  const f = await fixture();
  let release: (() => void) | undefined;
  let staleAuthorization = "",
    oldRunnerEnded = false;
  try {
    const runtime = await f.boot();
    const old = await f.connect(
      f.worker(async function* (request) {
        const server = request.mcpServers.find((server) => server.name === "supertag-coordination");
        if (server?.transport !== "mcp-http") throw new Error("Missing coordination input");
        staleAuthorization = server.headers["Authorization"] ?? "";
        try {
          await new Promise<void>((resolve) => {
            release = resolve;
          }); // Deliberately ignore cancellation.
          yield { type: "output.message", text: "STALE RESULT" };
        } finally {
          oldRunnerEnded = true;
        }
      }),
      "old-host",
    );
    await f.assign("recoverable-task");
    await expect.poll(() => staleAuthorization.length > 0).toBe(true);
    await runtime.close();
    await old.stop();
    expect((await f.store.getTaskAssignment("recoverable-task"))?.status).toBe("running");
    expect((await f.store.getTaskAssignment("recoverable-task"))?.attemptCount).toBe(1);
    vi.setSystemTime(Date.now() + 31000);
    await f.boot();
    expect(await f.denied(staleAuthorization)).toBe(401);
    let replacementExecutions = 0;
    await f.connect(
      f.worker(async function* () {
        replacementExecutions += 1;
        yield { type: "output.message", text: "must not rerun accepted work" };
      }),
      "fresh-host",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(replacementExecutions).toBe(0);
    expect((await f.store.getTaskAssignment("recoverable-task"))?.status).toBe("running");
    expect((await f.store.getTaskAssignment("recoverable-task"))?.attemptCount).toBe(1);
    expect(await f.store.listTaskAttempts("recoverable-task")).toHaveLength(1);
    release?.();
    await expect.poll(() => oldRunnerEnded).toBe(true);
    expect((await f.store.getObjective("disruption")).reservedMinor).toBe(0);
  } finally {
    release?.();
    await f.cleanup();
    vi.useRealTimers();
  }
}, 20000);
