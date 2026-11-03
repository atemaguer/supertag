/** Opt-in real provider budget-exhaustion and authorized-renewal journey. Runs real subscription-backed Harnesses; never contacts a cloud Control Plane. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { DrizzleStore } from "../packages/store/src/index.js";

const { values } = parseArgs({
  options: { live: { type: "boolean" }, provider: { type: "string", default: "codex" } },
});
if (!values.live) throw new Error("Pass --live to use local subscription credentials");
const provider = values.provider;
if (provider !== "codex" && provider !== "claude-code")
  throw new Error("--provider must be codex or claude-code");
const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "supertag-budget-renewal-live-"));
const environment = { ...process.env };
for (const key of Object.keys(environment))
  if (
    key.startsWith("SUPERTAG_") ||
    [
      "DATABASE_URL",
      "PORT",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
    ].includes(key)
  )
    delete environment[key];
const cpState = join(directory, "control-plane");
const workerState = join(directory, "worker");
const workspace = join(directory, "workspace");
await mkdir(workspace, { recursive: true });
const port = await new Promise<number>((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    assert.ok(a && typeof a !== "string");
    server.close(() => done(a.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const admin = randomUUID();
const env = {
  ...environment,
  SUPERTAG_STATE_DIR: cpState,
  SUPERTAG_DATABASE_URL: `file:${join(cpState, "test.db")}`,
  SUPERTAG_ADMIN_TOKEN: admin,
  SUPERTAG_CONTROL_PLANE: origin,
  SUPERTAG_WORKLET_TRANSPORT: "remote",
};
const prefix = ["--import", "tsx", "--conditions=development", "apps/cli/src/index.ts"];
const children: ChildProcess[] = [];
const deadline = Date.now() + 600000;
let counter = 0;
async function cli(args: string[], override: NodeJS.ProcessEnv = env) {
  return new Promise<string>((done, reject) => {
    const child = spawn(process.execPath, [...prefix, ...args], {
      cwd: root,
      env: override,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (x) => (out += x));
    child.stderr.on("data", (x) => (err += x));
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      Math.max(1, Math.min(30000, deadline - Date.now())),
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      void writeFile(join(directory, `command-${++counter}.log`), out + err, { mode: 0o600 });
      code === 0
        ? done(out)
        : reject(
            new Error(`CLI ${args.slice(0, 2).join(" ")} exited ${code}; private log ${counter}`),
          );
    });
  });
}
async function background(args: string[], override: NodeJS.ProcessEnv, name: string) {
  const log = createWriteStream(join(directory, `${name}.log`), { mode: 0o600 });
  await new Promise<void>((done, reject) => {
    log.once("open", () => done());
    log.once("error", reject);
  });
  const child = spawn(process.execPath, [...prefix, ...args], {
    cwd: root,
    env: override,
    stdio: ["ignore", log, log],
  });
  children.push(child);
  return child;
}
async function poll<T>(fn: () => Promise<T | undefined>): Promise<T> {
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await delay(500);
  }
  throw new Error("Budget renewal journey exceeded 600 seconds");
}
const report: Record<string, unknown> = {
  provider,
  directory,
  startedAt: new Date().toISOString(),
  result: "failed",
  bounds: {
    durationMs: 600000,
    maxAttempts: 3,
    initialTokens: provider === "codex" ? 100 : null,
    renewedTokens: provider === "codex" ? 100000 : null,
    initialCostUsd: provider === "claude-code" ? 0.01 : null,
    renewedCostUsd: provider === "claude-code" ? 1 : null,
  },
  externalNotification: "No live collaboration surface; actual operator inbox is used",
};
const store = new DrizzleStore({ url: env.SUPERTAG_DATABASE_URL });
const initialLimits =
  provider === "codex"
    ? { maxNativeAgents: 0, maxReportedTokens: 100 }
    : { maxReportedCost: { amountMinor: 1, currency: "USD" } };
const renewedLimits =
  provider === "codex"
    ? { maxReportedTokens: 100000 }
    : { maxReportedCost: { amountMinor: 100, currency: "USD" } };
async function coordinate(command: string, input: Record<string, unknown>) {
  const path = join(directory, `input-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(input), { mode: 0o600 });
  return JSON.parse(await cli(["coordinate", command, "--input", path]));
}
async function boundedTask() {
  const task = await store.getTaskAssignment("producer");
  const attempts = await store.listTaskAttempts("producer");
  assert.ok(attempts.length <= 3, "Unexpected automatic Attempts exceeded hard test bound");
  return task;
}
try {
  await mkdir(cpState, { recursive: true });
  await cli(["migrate", "database"]);
  await store.connect();
  await background(
    ["start", "control-plane", "--host", "127.0.0.1", "--port", String(port)],
    env,
    "control-plane",
  );
  await poll(async () => {
    try {
      await cli(["status", "control-plane"]);
      return true;
    } catch {
      return undefined;
    }
  });
  const credential = join(directory, "host.json");
  await cli(["enroll", "worker-host", "host", "--out", credential]);
  const workerEnv = { ...environment, SUPERTAG_STATE_DIR: workerState };
  await installCredential(credential, "host", String(workerEnv["SUPERTAG_STATE_DIR"]));
  for (const resource of [
    {
      kind: "PermissionSet",
      metadata: { name: "runtime" },
      spec: {
        permissions: ["files:read", "files:write", "commands:execute"].map((action) => ({
          target: "runtime",
          action,
        })),
      },
    },
    {
      kind: "Role",
      metadata: { name: "worker" },
      spec: {
        purpose: "Bounded operator validation",
        instructions: "Complete only the assigned Task. Do not delegate.",
        permissionSets: ["runtime"],
        contextSets: [],
      },
    },
    {
      kind: "Tag",
      metadata: { name: "operator-worker" },
      spec: { roles: ["worker"], workerHosts: [] },
    },
  ]) {
    const path = join(directory, `${resource.kind}.json`);
    await writeFile(path, JSON.stringify({ apiVersion: "supertag/v1", ...resource }), {
      mode: 0o600,
    });
    await cli(["apply", "-f", path]);
  }
  await cli(["update", "tag", "operator-worker", "--add-worker-host", "host"]);
  const tag = JSON.parse(await cli(["get", "tag", "operator-worker"]));
  const workerArgs = [
    "connect",
    "worklet",
    "--worklet-url",
    `ws://127.0.0.1:${port}/worklets`,
    "--transport",
    "websocket",
    "--harness",
    provider,
    "--workspace",
    workspace,
    "--worker-host",
    "host",
    "--worker-id",
    "worker",
    "--worklet-id",
    "worklet",
    "--worker-profile",
    "test-profile",
    "--worker-profile-revision",
    "1",
    ...(provider === "codex"
      ? ["--codex-execution-mode", "app-server", "--model", "gpt-5.6-luna"]
      : ["--model", "haiku"]),
  ];
  const worker = await background(workerArgs, workerEnv, "worker");
  await poll(async () => {
    const host = JSON.parse(await cli(["get", "worker-host", "host"]));
    return host.status.connectionStatus === "connected" ? true : undefined;
  });
  await cli([
    "create",
    "objective",
    "objective",
    "--outcome",
    "Validate authorized native budget renewal",
    "--owner",
    "operator-worker",
    "--criterion",
    "Same Task and native Session submit exact artifact after explicit renewal",
    "--budget-minor",
    "300",
    ...(provider === "claude-code" ? ["--budget-currency", "USD"] : []),
    ...["files:read", "files:write", "commands:execute"].flatMap((a) => ["--runtime-action", a]),
  ]);
  await cli([
    "create",
    "team",
    "team",
    "--objective",
    "objective",
    "--name",
    "Validation",
    "--lead",
    "operator-worker",
    "--max-concurrency",
    "1",
  ]);
  const secret = `BUDGET_RENEWAL_${randomUUID()}`;
  await writeFile(join(workspace, "source.txt"), secret, { mode: 0o600 });
  await coordinate("assign_task", {
    taskId: "producer",
    objectiveId: "objective",
    teamId: "team",
    assignedTagId: tag.metadata.id,
    instruction:
      "Copy source.txt byte-for-byte into the required outputs/evidence.txt file using native tools. Do not append anything or modify its contents. Do not delegate or create any other Tasks. If this conversation resumes after an approved budget renewal, finish this same assignment using the current Attempt's output path. Do not update_task to accept or renew yourself. Final response: artifact ready.",
    acceptanceCriteria: ["Exact source bytes in required artifact"],
    maxCostMinor: provider === "claude-code" ? 1 : 0,
    execution: {
      profile: { id: "test-profile", revision: "1" },
      limits: initialLimits,
      outputs: {
        directory: "outputs",
        required: ["outputs/evidence.txt"],
        include: ["outputs/evidence.txt"],
      },
    },
  });
  const stopped = await poll(async () => {
    const task = await boundedTask();
    if (task?.status === "submitted")
      throw new Error("Initial allocation did not cause real provider exhaustion");
    if (task?.status === "failed") {
      assert.equal(
        task.result?.["failureKind"],
        "budget-exhausted",
        "Provider failure was not authoritative budget exhaustion",
      );
      return task;
    }
    return undefined;
  });
  assert.equal(stopped.attemptCount, 1);
  const taskResource = await store.findTaskById("producer");
  assert.ok(taskResource);
  const initialStates = await store.listSessionStates({
    sessionId: taskResource.sessionId,
    taskId: "producer",
  });
  const initialState = initialStates.find((state) => state.status === "resumable");
  assert.ok(
    initialState?.nativeId,
    "Interrupted provider did not archive a resumable native Session",
  );
  assert.ok(initialState.compatibility?.startsWith("budget:"));
  const inbox = JSON.parse(
    await cli([
      "list",
      "inbox",
      "--objective",
      "objective",
      "--kind",
      "task-budget",
      "--output",
      "json",
    ]),
  );
  const item = inbox.items.find((entry: { kind: string }) => entry.kind === "task_budget");
  assert.ok(item, "Operator inbox did not expose the exhausted Task");
  const action = item.permittedActions.find(
    (entry: { tool: string }) => entry.tool === "update_task",
  );
  assert.equal(action?.arguments?.taskId, "producer");
  assert.equal(action.arguments.expectedStatus, "failed");
  assert.equal(action.arguments.status, "queued");
  assert.ok(action.requiredInputFields.includes("executionLimits"));
  report["initialExhaustion"] = {
    taskId: "producer",
    attempt: 1,
    failureKind: stopped.result?.["failureKind"],
    nativeId: initialState.nativeId,
    archivedStateId: initialState.id,
    events: (await store.listTaskEvents("producer"))
      .filter((event) =>
        ["execution.failed", "task.budget-exhausted", "usage.updated"].includes(event.type),
      )
      .map((event) => ({ type: event.type, attemptId: event.attemptId, payload: event.payload })),
  };
  report["inbox"] = item;
  worker.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((done) => worker.once("exit", () => done())),
    delay(10000).then(() => {
      worker.kill("SIGKILL");
    }),
  ]);
  await rm(workerState, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "source.txt"), secret, { mode: 0o600 });
  await installCredential(credential, "host", String(workerEnv["SUPERTAG_STATE_DIR"]));
  await background(workerArgs, workerEnv, "worker-resumed");
  await poll(async () => {
    const host = JSON.parse(await cli(["get", "worker-host", "host"]));
    return host.status.connectionStatus === "connected" ? true : undefined;
  });
  assert.equal(
    (await boundedTask())?.attemptCount,
    1,
    "Exhausted Task retried before authorization",
  );
  await coordinate(action.tool, { ...action.arguments, executionLimits: renewedLimits });
  const completed = await poll(async () => {
    const task = await boundedTask();
    if (task?.status === "failed" && task.attemptCount > 1)
      throw new Error("Authorized renewed Attempt failed");
    return task?.status === "submitted" ? task : undefined;
  });
  assert.equal(completed.attemptCount, 2);
  const resumedTask = await store.findTaskById("producer");
  assert.equal(
    resumedTask?.sessionId,
    taskResource.sessionId,
    "Task Session changed during renewal",
  );
  const resumedAttempt = (await store.listTaskAttempts("producer")).find(
    (attempt) => attempt.attemptNumber === 2,
  );
  assert.equal(resumedAttempt?.status, "completed");
  assert.ok(resumedAttempt);
  const states = await store.listSessionStates({
    sessionId: taskResource.sessionId,
    taskId: "producer",
  });
  assert.ok(states.length >= 2, "Resumed Attempt did not archive native Session");
  assert.deepEqual([...new Set(states.map((state) => state.nativeId))], [initialState.nativeId]);
  const events = await store.listTaskEvents("producer");
  assert.equal(events.filter((event) => event.type === "task.budget-renewed").length, 1);
  const artifacts = (await store.listCapturedArtifacts({ taskId: "producer", limit: 10 }))
    .artifacts;
  const artifact = artifacts.find(
    (entry) =>
      entry.attemptId === resumedAttempt.id &&
      entry.entries.some((file) => file.path === "outputs/evidence.txt"),
  );
  assert.ok(artifact, "No captured output artifact");
  const destination = join(directory, "download.txt");
  await cli([
    "download",
    "artifact",
    artifact.id,
    "--path",
    "outputs/evidence.txt",
    "--out",
    destination,
  ]);
  assert.equal(await readFile(destination, "utf8"), secret);
  const finalInbox = JSON.parse(
    await cli([
      "list",
      "inbox",
      "--objective",
      "objective",
      "--kind",
      "task-budget",
      "--output",
      "json",
    ]),
  );
  assert.equal(finalInbox.items.length, 0, "Resolved budget decision remains actionable");
  report["budget"] = (
    await coordinate("read_task", { objectiveId: "objective", taskId: "producer" })
  ).budget;
  Object.assign(report, {
    result: "passed",
    taskId: "producer",
    attempts: 2,
    phase: completed.status,
    nativeId: initialState.nativeId,
    sessionId: taskResource.sessionId,
    freshWorker: true,
    artifactId: artifact.id,
    artifactAttemptId: artifact.attemptId,
    resumedAttemptId: resumedAttempt.id,
    renewedExecutionLimits: resumedTask?.execution.limits,
    resumedUsage: events
      .filter((event) => event.attemptId === resumedAttempt.id && event.type === "usage.updated")
      .map((event) => event.payload),
    artifactDigest: createHash("sha256").update(secret).digest("hex"),
    budgetRenewals: events
      .filter((event) => event.type === "task.budget-renewed")
      .map((event) => event.payload),
    archivedSessions: states.map((state) => ({
      id: state.id,
      attemptId: state.attemptId,
      nativeId: state.nativeId,
      status: state.status,
    })),
    finalInboxCount: finalInbox.items.length,
    commands: counter,
  });
} catch (error) {
  report["error"] = error instanceof Error ? error.message : "Unknown failure";
  process.exitCode = 1;
  try {
    report["tasks"] = await store.listTaskAssignments("objective");
    report["attempts"] = await store.listTaskAttempts("producer");
    report["events"] = (await store.listTaskEvents("producer")).filter((event) =>
      ["execution.failed", "task.scheduling-incompatible", "task.budget-exhausted"].includes(
        event.type,
      ),
    );
  } catch {
    /* Preserve original failure when setup was incomplete. */
  }
} finally {
  for (const child of children.toReversed()) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((done) => child.once("exit", () => done())),
      delay(10000).then(() => {
        child.kill("SIGKILL");
      }),
    ]);
  }
  await store.disconnect().catch(() => {});
  report["finishedAt"] = new Date().toISOString();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({ provider, directory, result: report["result"], error: report["error"] }),
  );
}

/** Installs an enrolled Worker Host credential where connect worklet finds it. */
async function installCredential(file: string, id: string, state: string): Promise<void> {
  const target = join(state, "worker-hosts", `${encodeURIComponent(id)}.credential.json`);
  await mkdir(join(state, "worker-hosts"), { recursive: true, mode: 0o700 });
  await copyFile(file, target);
}
