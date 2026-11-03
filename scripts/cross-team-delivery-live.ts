/** Opt-in local operator journey. Runs real subscription-backed Harnesses; never contacts a cloud Control Plane. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { DrizzleStore } from "../packages/store/src/index.js";
import {
  assessCrossTeamDelivery,
  type CrossTeamDeliveryEvidence,
} from "./cross-team-delivery-evidence.js";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    provider: { type: "string", default: "codex" },
    "max-reported-tokens": { type: "string" },
  },
});
if (!values.live) throw new Error("Pass --live to use local subscription credentials");
const provider = values.provider;
if (provider !== "codex" && provider !== "claude-code")
  throw new Error("--provider must be codex or claude-code");
const requestedTokens = values["max-reported-tokens"];
if (provider !== "codex" && requestedTokens !== undefined)
  throw new Error("--max-reported-tokens is only supported for codex");
const maxReportedTokens = requestedTokens === undefined ? 200000 : Number(requestedTokens);
if (
  requestedTokens !== undefined &&
  (!/^\d+$/.test(requestedTokens) ||
    !Number.isSafeInteger(maxReportedTokens) ||
    maxReportedTokens < 1 ||
    maxReportedTokens > 1000000)
)
  throw new Error("--max-reported-tokens must be an integer from1 through1000000");
const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "supertag-cross-team-live-"));
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
const deadline = Date.now() + 900000;
let evidenceDeadline: number | undefined;
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
      Math.max(1, Math.min(30000, (evidenceDeadline ?? deadline) - Date.now())),
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
  throw new Error("Operator journey exceeded 900 seconds");
}
const executionLimits =
  provider === "codex"
    ? { maxNativeAgents: 0, maxReportedTokens }
    : { maxReportedCost: { amountMinor: 200, currency: "USD" } };
const taskAllocation = provider === "codex" ? 20 : 200;
const report: Record<string, unknown> = {
  provider,
  directory,
  startedAt: new Date().toISOString(),
  result: "failed",
  mode: "autonomous-manager",
  transport: "websocket",
  limits: {
    deadlineMs: 900000,
    maxAttempts: 30,
    maxConcurrentWorkers: 3,
    perAttempt: executionLimits,
    attemptCapSemantics:
      "Observed durable Attempt threshold; concurrent admission can overshoot before process shutdown",
  },
};
const store = new DrizzleStore({ url: env.SUPERTAG_DATABASE_URL });
const workers = new Map<
  string,
  {
    child: ChildProcess;
    args: string[];
    env: NodeJS.ProcessEnv;
    state: string;
    workspace: string;
    credential: string;
  }
>();
const actors: Record<string, string> = {};
let recovery: CrossTeamDeliveryEvidence["recovery"] | undefined;
let recoverySessionId: string | undefined;
async function collect() {
  // Evidence collection has a separate shared bound, including failure-path collection.
  evidenceDeadline ??= Date.now() + 60000;
  if (recovery && recoverySessionId) {
    const states = await store.listSessionStates({ sessionId: recoverySessionId });
    recovery = {
      ...recovery,
      nativeIdsAfter: states.flatMap((s) => (s.nativeId ? [s.nativeId] : [])),
      attemptIds: states.map((s) => s.attemptId),
    };
  }
  const tasks = await store.listTaskAssignments("delivery");
  const usageReports: unknown[] = [];
  for (const task of tasks) {
    const path = join(directory, `inspect-${randomUUID()}.json`);
    await writeFile(path, JSON.stringify({ objectiveId: "delivery", taskId: task.taskId }), {
      mode: 0o600,
    });
    try {
      const inspected = JSON.parse(await cli(["coordinate", "read_task", "--input", path]));
      usageReports.push({ taskId: task.taskId, budget: inspected.budget });
    } catch {
      usageReports.push({ taskId: task.taskId, budget: null });
    }
  }
  const artifacts = (await store.listCapturedArtifacts({ objectiveId: "delivery", limit: 100 }))
    .artifacts;
  const parsed = [];
  for (const artifact of artifacts) {
    const artifactValues: Record<string, unknown> = {};
    for (const entry of artifact.entries) {
      let value: unknown;
      try {
        const path = join(
          directory,
          `artifact-${artifact.id}-${Object.keys(artifactValues).length}-${randomUUID()}.json`,
        );
        await cli(["download", "artifact", artifact.id, "--path", entry.path, "--out", path]);
        value = JSON.parse(await readFile(path, "utf8"));
      } catch {
        value = null;
      }
      artifactValues[entry.path] = value;
    }
    parsed.push({ manifest: artifact, values: artifactValues });
  }
  const messages = [
    ...new Map(
      (await Promise.all(Object.values(actors).map((id) => store.listTagMessages(id, 100))))
        .flat()
        .map((m) => [m.id, m]),
    ).values(),
  ];
  return {
    usageReports,
    objective: await store.getObjective("delivery"),
    teams: await store.listTeams("delivery"),
    tasks,
    messages,
    artifacts: parsed,
    events: await Promise.all(
      tasks.map(async (t) => ({ taskId: t.taskId, events: await store.listTaskEvents(t.taskId) })),
    ),
    recovery,
    actors: {
      managerTagId: actors["manager"] as string,
      producerTagId: actors["producer"] as string,
      reviewerTagId: actors["reviewer"] as string,
    },
  };
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
  const permission = {
    apiVersion: "supertag/v1",
    kind: "PermissionSet",
    metadata: { name: "runtime" },
    spec: {
      permissions: ["files:read", "files:write", "commands:execute"].map((action) => ({
        target: "runtime",
        action,
      })),
    },
  };
  const apply = async (resource: unknown, name: string) => {
    const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify(resource), { mode: 0o600 });
    await cli(["apply", "-f", path]);
  };
  await apply(permission, "permission");
  for (const role of ["manager", "producer", "reviewer"]) {
    const credential = join(directory, `${role}-credential.json`);
    await cli(["enroll", "worker-host", role, "--out", credential]);
    await apply(
      {
        apiVersion: "supertag/v1",
        kind: "Role",
        metadata: { name: role },
        spec: {
          purpose: `Bounded ${role} validation`,
          instructions:
            "Follow only the assigned Task. Never create Tags or use native subagents. Use SuperTag Mailboxes only for cross-Team coordination.",
          permissionSets: ["runtime"],
          contextSets: [],
        },
      },
      `${role}-role`,
    );
    await apply(
      {
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: role },
        spec: { roles: [role], workerHosts: [role] },
      },
      `${role}-tag`,
    );
    actors[role] = JSON.parse(await cli(["get", "tag", role])).metadata.id;
    const state = join(directory, `${role}-state`),
      workspace = join(directory, `${role}-workspace`);
    await mkdir(workspace, { recursive: true });
    const workerEnv = { ...environment, SUPERTAG_STATE_DIR: state };
    await installCredential(credential, role, String(workerEnv["SUPERTAG_STATE_DIR"]));
    const args = [
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
      role,
      "--worker-id",
      role,
      "--worklet-id",
      role,
      "--worker-profile",
      role,
      "--worker-profile-revision",
      "1",
      ...(provider === "codex"
        ? [
            "--codex-execution-mode",
            "app-server",
            "--model",
            role === "manager" ? "gpt-5.6-sol" : "gpt-5.6-luna",
          ]
        : ["--model", role === "manager" ? "sonnet" : "haiku"]),
    ];
    const child = await background(args, workerEnv, role);
    workers.set(role, { child, args, env: workerEnv, state, workspace, credential });
  }
  await poll(async () => {
    for (const role of workers.keys()) {
      const h = JSON.parse(await cli(["get", "worker-host", role]));
      if (h.status.connectionStatus !== "connected") return undefined;
    }
    return true;
  });
  for (const [sender, recipient] of [
    ["reviewer", "producer"],
    ["reviewer", "manager"],
    ["manager", "reviewer"],
    ["manager", "producer"],
    ["producer", "reviewer"],
  ] as const) {
    await store.setTagMessagingGrant({
      senderTagId: actors[sender] as string,
      recipientTagId: actors[recipient] as string,
      messageTypes: ["message"],
    });
  }
  const wakeAt = new Date(Date.now() + 180000).toISOString();
  const constraints = [
    `Every Task MUST include execution.limits ${JSON.stringify(executionLimits)} and maxCostMinor ${taskAllocation}; do not relax these ceilings.`,
    `You are manager Tag ${actors["manager"]}. Producer Tag ${actors["producer"]} uses profile producer revision 1; reviewer Tag ${actors["reviewer"]} uses profile reviewer revision 1. Every assigned Task must select its exact profile. Manager profile manager revision1.`,
    "Create exactly two delivery Teams under your leadership Team: production led by producer and review led by reviewer. Each Team maxConcurrency1. Assign only producer implementation Tasks and reviewer checking Tasks; do not implement or review yourself.",
    `First producer Task MUST be id draft, Team production, create outputs/report.json containing exactly {"value":7}. Its instruction must FIRST call wait_for exactly once with only notBefore '${wakeAt}', then end turn READY; after this native conversation resumes, do not wait again, write the file. This pause is required for an independently observed Worker restart.`,
    "Declare execution.outputs {directory:'outputs',required:['outputs/report.json'],include:['outputs/report.json']} for producer Tasks. Use the specified maxCostMinor allocation for every Task. Do not require human approval.",
    "After draft submission, assign reviewer Task review-draft in review Team with inputArtifacts selecting its exact artifactId and outputs/report.json. Tell reviewer: inspect this input and send_message to recipientTeamId production requesting a second version adding double:14. Use type message, body {kind:'revision.requested',taskId:'draft',artifactId:<exact initial ID>,requirement:'double'}, stable idempotencyKey. Also send the same revision request to manager so it can orchestrate the followup. Do not declare the initial version final. Reviewer output outputs/review.json must record passed:false and artifactId.",
    "On the copy of the revision request addressed to manager, send a correlated reply to the reviewer with inReplyTo that copy ID and body kind revision.accepted, then assign revision in production Team with exact draft artifact input and instruction produce outputs/report.json exactly {value:7,double:14}. Do not reuse draft ID or mutate its immutable artifact. Producer handling a mailbox delivery must only acknowledge; only explicit revision produces the revision.",
    "Assign review-final in review Team selecting exact revision artifact; reviewer validates value7 and double14, writes outputs/review.json {passed:true,artifactId:<revision ID>,value:7,double:14}. Declare outputs/review.json capture for both review Tasks.",
    "After reviewing durable review-final evidence, accept revision and review-final through update_task status accepted with expectedStatus from reread. Reject draft and accept review-draft through update_task using current expectedStatus so no unfinished Tasks remain, then complete Objective through update_objective with evidence. Do not claim success from prose. Use durable waits rather than duplicate assignments. Never exceed6 delivery Tasks or30total Attempts.",
  ];
  await cli([
    "create",
    "objective",
    "delivery",
    "--outcome",
    [
      "Deliver independently reviewed numeric JSON through two Teams and a Mailbox revision round trip",
      "Done when: Revised report has value7 and double14 and independent review accepted",
      "Constraints:",
      ...constraints.map((c) => `- ${c}`),
    ].join("\n"),
    "--owner",
    "manager",
    "--budget-minor",
    "6000",
    ...(provider === "claude-code" ? ["--budget-currency", "USD"] : []),
    ...["files:read", "files:write", "commands:execute"].flatMap((a) => ["--runtime-action", a]),
  ]);
  const start = join(directory, "start.json");
  await writeFile(
    start,
    JSON.stringify({
      objectiveId: "delivery",
      taskId: "manager-mission",
      maxCostMinor: taskAllocation,
      execution: { profile: { id: "manager", revision: "1" }, limits: executionLimits },
    }),
  );
  await cli(["coordinate", "start_objective", "--input", start]);
  let restarted = false;
  await poll(async () => {
    const tasks = await store.listTaskAssignments("delivery");
    for (const task of tasks.filter((t) => t.status === "queued" && t.attemptCount === 0)) {
      const events = await store.listTaskEvents(task.taskId);
      const incompatible = events.findLast((e) => e.type === "task.scheduling-incompatible");
      if (incompatible && Date.now() - Date.parse(incompatible.createdAt) > 5000)
        throw new Error(
          `Task ${task.taskId} has incompatible Worker requirements; inspect its scheduling event`,
        );
    }
    const firstReview = tasks.find((t) => t.taskId === "review-draft");
    if (
      firstReview &&
      ["submitted", "accepted"].includes(firstReview.status) &&
      Date.now() - Date.parse(firstReview.updatedAt) > 30000
    ) {
      const messages = await store.listTagMessages(actors["producer"] as string, 100);
      if (
        !messages.some(
          (m) => m.senderTagId === actors["reviewer"] && m.body["kind"] === "revision.requested",
        )
      )
        throw new Error("Reviewer completed without a durable revision request to producer");
    }
    const attempts = tasks.reduce((n, t) => n + t.attemptCount, 0);
    if (attempts > 30) throw new Error("Durable Attempt budget exceeded");
    const task = tasks.find((t) => t.taskId === "draft");
    if (task?.status === "waiting" && !restarted) {
      const resource = JSON.parse(await cli(["get", "task", "draft"]));
      recoverySessionId = resource.spec.sessionId as string;
      const states = await store.listSessionStates({ sessionId: recoverySessionId });
      if (!states.some((s) => s.status === "resumable")) return undefined;
      const worker = workers.get("producer");
      assert.ok(worker);
      worker.child.kill("SIGTERM");
      await new Promise<void>((done) => worker.child.once("exit", () => done()));
      await rm(worker.state, { recursive: true, force: true });
      await rm(worker.workspace, { recursive: true, force: true });
      await mkdir(worker.workspace, { recursive: true });
      await installCredential(
        worker.credential,
        "producer",
        String(worker.env["SUPERTAG_STATE_DIR"]),
      );
      worker.child = await background(worker.args, worker.env, "producer-restarted");
      recovery = {
        taskId: task.taskId,
        nativeIdsBefore: states.flatMap((s) => (s.nativeId ? [s.nativeId] : [])),
        nativeIdsAfter: [],
        attemptIds: [],
        workspaceDeleted: true,
        stateDeleted: true,
      };
      restarted = true;
    }
    const objective = await store.getObjective("delivery");
    return objective.status === "completed" ? true : undefined;
  });
  const settlementDeadline = Date.now() + 30000;
  while (Date.now() < settlementDeadline) {
    const tasks = await store.listTaskAssignments("delivery");
    const messages = (
      await Promise.all(Object.values(actors).map((id) => store.listTagMessages(id, 100)))
    ).flat();
    if (
      !tasks.some((t) => ["queued", "running", "waiting"].includes(t.status)) &&
      messages.every((m) => m.status === "processed")
    )
      break;
    await delay(500);
  }
  const evidence = await collect();
  report["evidence"] = evidence;
  report["actors"] = actors;
  assert.ok(evidence.recovery, "Worker interruption was not observed");
  const assessment = assessCrossTeamDelivery({ ...evidence, recovery: evidence.recovery });
  report["assessment"] = assessment;
  assert.ok(assessment.passed, "Durable evidence checks failed");
  report["result"] = "passed";
} catch (error) {
  report["error"] = error instanceof Error ? error.message : "Unknown failure";
  try {
    const evidence = await collect();
    report["evidence"] = evidence;
    report["actors"] = actors;
    if (evidence.recovery)
      report["assessment"] = assessCrossTeamDelivery({ ...evidence, recovery: evidence.recovery });
  } catch {}
  process.exitCode = 1;
} finally {
  for (const child of children.toReversed()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((done) => child.once("exit", () => done())),
      delay(10000).then(() => {
        child.kill("SIGKILL");
      }),
    ]);
  }
  await store.disconnect();
  report["finishedAt"] = new Date().toISOString();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({ result: report["result"], provider, directory, error: report["error"] }),
  );
}

/** Installs an enrolled Worker Host credential where connect worklet finds it. */
async function installCredential(file: string, id: string, state: string): Promise<void> {
  const target = join(state, "worker-hosts", `${encodeURIComponent(id)}.credential.json`);
  await mkdir(join(state, "worker-hosts"), { recursive: true, mode: 0o700 });
  await copyFile(file, target);
}
