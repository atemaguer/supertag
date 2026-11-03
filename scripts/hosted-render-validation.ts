import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import {
  array,
  artifactSelection,
  assertExactArtifactAdmission,
  assertNoSecrets,
  digest,
  hasExactLine,
  isToolCallStarted,
  type JsonRecord,
  nativeSessionEvidence,
  outputText,
  readCredential,
  record,
  redactSecrets,
  taskAttempt,
  text,
  writePrivateJson,
} from "./hosted-render-validation-lib.js";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

class Api {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly timeout: number,
  ) {}

  async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<JsonRecord> {
    const response = await fetch(new URL(path, `${this.origin}/`), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(Math.min(this.timeout, 30_000)),
        runAbort.signal,
      ]),
    });
    const value = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok)
      throw new Error(`Control Plane ${method} ${path} failed with HTTP ${response.status}`);
    return record(value, `${method} ${path} response`);
  }

  async waitUntilReachable(): Promise<void> {
    await poll(async () => {
      try {
        await this.request("GET", "/api/v1/status");
        return true;
      } catch {
        return undefined;
      }
    }, "hosted Control Plane restart");
  }
}

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    management: { type: "string" },
    "worklet-url": { type: "string" },
    transport: { type: "string", default: "grpc" },
    provider: { type: "string", default: "codex" },
    "admin-token-file": { type: "string" },
    "tls-ca-file": { type: "string" },
    "restart-hook": { type: "string" },
    output: { type: "string" },
    "wake-seconds": { type: "string", default: "120" },
    "timeout-seconds": { type: "string", default: "900" },
    "codex-model": { type: "string", default: "gpt-5.6-luna" },
    "claude-model": { type: "string" },
  },
});

if (!values.live)
  throw new Error("Pass --live explicitly; this uses local Codex or Claude subscription auth");
const management = requiredHttpsOrigin(values.management, "--management");
const transport = values.transport;
if (transport !== "grpc" && transport !== "websocket")
  throw new Error("--transport must be grpc or websocket");
const provider = values.provider;
if (provider !== "codex" && provider !== "claude-code")
  throw new Error("--provider must be codex or claude-code");
const workletUrl = resolveWorkletUrl(management, transport, values["worklet-url"]);
const tlsCaFile = values["tls-ca-file"] ? resolve(values["tls-ca-file"]) : undefined;
if (transport === "grpc" && tlsCaFile === undefined)
  throw new Error("Hosted gRPC validation requires --tls-ca-file");
const wakeSeconds = positiveInteger(values["wake-seconds"], "--wake-seconds");
const timeoutMs = positiveInteger(values["timeout-seconds"], "--timeout-seconds") * 1000;
const outputDirectory = resolve(
  values.output ?? `.supertag/hosted-render/${provider}-${transport}-${Date.now()}`,
);
const adminToken = values["admin-token-file"]
  ? await readCredential(resolve(values["admin-token-file"]))
  : process.env["SUPERTAG_RENDER_ADMIN_TOKEN"];
if (!adminToken) throw new Error("Provide --admin-token-file or SUPERTAG_RENDER_ADMIN_TOKEN");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

const runId = randomUUID().slice(0, 12);
const prefix = `render-${provider.replace("-code", "")}-${runId}`;
const hostA = `${prefix}-host-a`;
const hostB = `${prefix}-host-b`;
const profileId = `${prefix}-profile`;
const ownerName = `${prefix}-owner`;
const objectiveId = `${prefix}-objective`;
const teamId = `${prefix}-team`;
const permissionSetName = `${prefix}-runtime`;
const roleName = `${prefix}-worker`;
const continuityTaskId = `${prefix}-continuity`;
const producerTaskId = `${prefix}-producer`;
const consumerTaskId = `${prefix}-consumer`;
const nativeSecret = `NATIVE_${randomUUID().replaceAll("-", "")}`;
const artifactSecret = `ARTIFACT_${randomUUID().replaceAll("-", "")}`;
const protectedValues: string[] = [adminToken, nativeSecret, artifactSecret];
const runAbort = new AbortController();
const api = new Api(management, adminToken, timeoutMs);
const startedAt = new Date().toISOString();
const report: JsonRecord = {
  schemaVersion: 1,
  runId,
  startedAt,
  managementOrigin: management,
  workletOrigin: redactUrl(workletUrl),
  transport,
  provider,
  physicalTopology:
    "One local physical host ran two independently authenticated Worker Host identities across short-lived Worklet processes against one hosted Render Control Plane",
  restart: {
    phase: values["restart-hook"] ? "pending" : "skipped",
    reason: values["restart-hook"] ? undefined : "No --restart-hook supplied",
  },
  checks: [],
};
const checks = report["checks"] as unknown[];
const workers: RunningWorker[] = [];
const interrupt = () => runAbort.abort(new Error("Hosted validation interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let restartInvoked = false;

try {
  await negativeAuthentication(api, workletUrl, transport, tlsCaFile);
  checks.push({ name: "negative-authentication", passed: true });

  const [credentialA, credentialB] = await Promise.all([
    enrollHost(api, hostA),
    enrollHost(api, hostB),
  ]);
  protectedValues.push(credentialA, credentialB);

  await api.request("POST", "/api/v1/permission-sets", {
    apiVersion: "supertag/v1",
    kind: "PermissionSet",
    metadata: { name: permissionSetName },
    spec: {
      permissions: ["files:read", "files:write", "commands:execute"].map((action) => ({
        target: "runtime",
        action,
      })),
    },
  });
  await api.request("POST", "/api/v1/roles", {
    apiVersion: "supertag/v1",
    kind: "Role",
    metadata: { name: roleName },
    spec: {
      purpose: "Run the bounded hosted transport and persistence validation",
      instructions: "Follow only the assigned validation Task and do not delegate.",
      permissionSets: [permissionSetName],
      contextSets: [],
    },
  });

  const tagResource = await api.request("POST", "/api/v1/tags", {
    apiVersion: "supertag/v1",
    kind: "Tag",
    metadata: { name: ownerName },
    spec: { roles: [roleName], workerHosts: [hostA, hostB] },
  });
  const ownerTagId = text(record(tagResource["metadata"])["id"], "owner Tag id");
  await api.request("POST", "/api/v1/tag-messaging/objectives", {
    id: objectiveId,
    ownerTagId,
    outcome: [
      "Validate hosted gRPC or WebSocket Worklet recovery, native continuity, and artifact handoff",
      "Done when:",
      "A fresh Worker process resumes the exact native Session without replaying the protected value",
      "A separate Task reads exact bytes through an admitted artifact selector",
      "Authentication failures and reconnect generation are durably observable",
    ].join("\n"),
    runtimeActions: ["files:read", "files:write", "commands:execute"],
    budgetLimitMinor: 100,
  });
  await command(api, "create_team", {
    objectiveId,
    id: teamId,
    name: `${prefix} validation`,
    leadTagId: ownerTagId,
    memberTagIds: [ownerTagId],
    maxConcurrency: 1,
  });

  const phaseA = join(outputDirectory, "phase-a");
  const continuityWorkspace = join(outputDirectory, "continuity-workspace");
  await mkdir(continuityWorkspace, { recursive: true, mode: 0o700 });
  await mkdir(join(phaseA, "state"), { recursive: true, mode: 0o700 });
  await writeFile(join(continuityWorkspace, "challenge.txt"), nativeSecret, { mode: 0o600 });
  const workerA = await startWorker({
    hostId: hostA,
    credential: credentialA,
    phaseDirectory: phaseA,
    workspaceDirectory: continuityWorkspace,
  });
  workers.push(workerA);
  const hostAConnected = await waitForConnected(api, hostA, 0);

  const wakeAt = new Date(Date.now() + wakeSeconds * 1000).toISOString();
  await assign(api, {
    taskId: continuityTaskId,
    ownerTagId,
    instruction: [
      "This is a two-Attempt native Session continuity probe.",
      "If you have already memorized the protected value in this native conversation, do not call any tool or search the filesystem; reply only with that exact remembered value.",
      "Otherwise, read challenge.txt once with a shell command and memorize its exact contents. Do not repeat it in your answer, messages, files, or tool arguments.",
      `Then call wait_for exactly once with only notBefore set to ${wakeAt}, and immediately end the turn with READY.`,
      "Do not delegate, create resources, or use external services.",
    ].join(" "),
    acceptanceCriteria: ["Same native Session recalls the protected value on a fresh Worker"],
  });
  const waitingTask = await pollTask(
    api,
    continuityTaskId,
    (task) => assignmentPhase(task) === "waiting",
  );
  const attemptA = taskAttempt(waitingTask);
  assert.equal(attemptA.workerHostId, hostA);
  const continuitySpec = record(waitingTask["spec"], "continuity Task spec");
  assertNoSecrets(continuitySpec, [nativeSecret], "durable Task spec before resume");
  const sessionId = text(continuitySpec["sessionId"], "continuity Session id");
  const firstSessionArchive = await poll(async () => {
    const body = await api.request(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/states`,
    );
    for (const state of array(body["states"], "Session states").map((item) =>
      record(item, "Session state"),
    )) {
      const detail = await api.request(
        "GET",
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/states/${encodeURIComponent(text(state["id"], "Session state id"))}`,
      );
      if (JSON.stringify(detail).includes(nativeSecret)) return { body, detail };
    }
    return undefined;
  }, "Attempt 1 native Session archive containing the protected tool result");
  const firstSession = nativeSessionEvidence(firstSessionArchive.body);
  assert.equal(firstSession.nativeIds.length, 1, "Attempt 1 must persist one native identity");
  assert.ok(
    JSON.stringify(firstSessionArchive.detail).includes(nativeSecret),
    "Attempt 1 native archive does not contain the protected value read from challenge.txt",
  );

  await stopWorker(workerA);
  await waitForDisconnected(api, hostA);
  await rm(phaseA, { recursive: true, force: true });
  await rm(continuityWorkspace, { recursive: true, force: true });
  await mkdir(continuityWorkspace, { recursive: true, mode: 0o700 });
  const phaseB1 = join(outputDirectory, "phase-b-first-process");
  await mkdir(join(phaseB1, "state"), { recursive: true, mode: 0o700 });
  const workerB1 = await startWorker({
    hostId: hostB,
    credential: credentialB,
    phaseDirectory: phaseB1,
    workspaceDirectory: continuityWorkspace,
  });
  workers.push(workerB1);
  const hostBInitial = await waitForConnected(api, hostB, 0);
  assert.equal(
    assignmentPhase(await api.request("GET", `/api/v1/tasks/${continuityTaskId}`)),
    "waiting",
    "Continuity Task woke before the disposable Host B process was replaced",
  );
  assert.ok(
    Date.parse(wakeAt) - Date.now() >= 20_000,
    "Continuity wake deadline left less than 20 seconds for fresh-process replacement",
  );
  await stopWorker(workerB1);
  await waitForDisconnected(api, hostB);
  await rm(join(phaseB1, "state"), { recursive: true, force: true });
  await mkdir(join(phaseB1, "state"), { recursive: true, mode: 0o700 });
  const workerB2 = await startWorker({
    hostId: hostB,
    credential: credentialB,
    phaseDirectory: phaseB1,
    workspaceDirectory: continuityWorkspace,
  });
  workers.push(workerB2);
  const hostBAfterProcessRestart = await waitForConnected(
    api,
    hostB,
    connectionGeneration(hostBInitial),
  );
  checks.push({
    name: "fresh-worklet-process-reconnect",
    passed: true,
    beforeGeneration: connectionGeneration(hostBInitial),
    afterGeneration: connectionGeneration(hostBAfterProcessRestart),
  });

  if (values["restart-hook"]) {
    const before = connectionGeneration(hostBAfterProcessRestart);
    restartInvoked = true;
    await runRestartHook(resolve(values["restart-hook"]), outputDirectory);
    await api.waitUntilReachable();
    const after = await waitForConnected(api, hostB, before);
    report["restart"] = {
      phase: "passed",
      beforeGeneration: before,
      afterGeneration: connectionGeneration(after),
    };
  }

  const continuityDone = await pollTask(
    api,
    continuityTaskId,
    (task) => assignmentPhase(task) === "submitted",
  );
  const attemptB = taskAttempt(continuityDone);
  assert.equal(attemptB.number, 2);
  assert.equal(attemptB.workerHostId, hostB);
  assert.equal(attemptB.profile.id, profileId);
  const recalled = outputText(continuityDone).trim();
  assert.equal(recalled, nativeSecret, "Fresh Worker did not recall the exact native value");
  const sessionEvidence = nativeSessionEvidence(
    await api.request("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}/states`),
  );
  assert.deepEqual(sessionEvidence.nativeIds, firstSession.nativeIds);
  const continuityEvents = await taskEvents(api, continuityTaskId);
  const attemptBToolCalls = continuityEvents.filter(
    (event) => event["attemptId"] === attemptB.id && isToolCallStarted(event),
  ).length;
  assert.equal(attemptBToolCalls, 0, "Resumed recall used a tool");
  const retryInputs = {
    spec: continuityDone["spec"],
    assignment: record(continuityDone["status"])["assignment"],
  };
  assertNoSecrets(retryInputs, [nativeSecret], "Attempt 2 projected durable inputs");
  checks.push({
    name: "fresh-process-native-session-recall",
    passed: true,
    valueDigest: digest(nativeSecret),
    sessionId,
    nativeId: firstSession.nativeIds[0],
    stateCount: sessionEvidence.count,
    attempt1: attemptA,
    attempt2: attemptB,
    resumedToolCallCount: attemptBToolCalls,
    projectedTaskInputsContainedProtectedValue: false,
    fullReceivedSessionHistoryInspected: false,
    initialArchiveContainedProtectedValue: true,
    stableWorkspaceIdentityWithDeletedContents: true,
  });

  await writeFile(join(continuityWorkspace, "artifact-source.txt"), artifactSecret, {
    mode: 0o600,
  });
  await assign(api, {
    taskId: producerTaskId,
    ownerTagId,
    instruction:
      "Read ./artifact-source.txt in the current working directory first. If it is absent, report MISSING and stop; never search / or any other directory. Copy it byte-for-byte to outputs/evidence.txt. Do not append anything or modify the file contents. Your final chat response may briefly describe completion. Do not delegate or use external services.",
    acceptanceCriteria: ["outputs/evidence.txt preserves exact source bytes"],
    outputs: true,
  });
  const producer = await pollTask(
    api,
    producerTaskId,
    (task) => assignmentPhase(task) === "submitted",
  );
  const selection = artifactSelection(producer);
  await stopWorker(workerB2);
  await waitForDisconnected(api, hostB);
  await rm(phaseB1, { recursive: true, force: true });
  await rm(continuityWorkspace, { recursive: true, force: true });
  const consumerPhase = join(outputDirectory, "phase-a-artifact-consumer");
  await mkdir(join(consumerPhase, "workspace"), { recursive: true, mode: 0o700 });
  await mkdir(join(consumerPhase, "state"), { recursive: true, mode: 0o700 });
  const consumerWorker = await startWorker({
    hostId: hostA,
    credential: credentialA,
    phaseDirectory: consumerPhase,
  });
  workers.push(consumerWorker);
  const consumerHost = await waitForConnected(api, hostA, connectionGeneration(hostAConnected));
  await assign(api, {
    taskId: consumerTaskId,
    ownerTagId,
    instruction:
      "Read the admitted evidence.txt artifact at the exact runtime input path. Reply only with its exact contents. Do not read any other file, delegate, or use external services.",
    acceptanceCriteria: ["Reply matches the admitted immutable artifact bytes"],
    inputArtifacts: [selection],
  });
  const consumer = await pollTask(
    api,
    consumerTaskId,
    (task) => assignmentPhase(task) === "submitted",
  );
  const consumerSpec = record(consumer["spec"], "consumer Task spec");
  assert.deepEqual(selection.paths, ["outputs/evidence.txt"]);
  assertExactArtifactAdmission(
    record(consumerSpec["trigger"], "consumer Task trigger")["inputArtifacts"],
    {
      artifactId: selection.artifactId,
      path: selection.paths[0] as string,
      digest: `sha256:${digest(artifactSecret)}`,
      sizeBytes: Buffer.byteLength(artifactSecret),
    },
  );
  assert.ok(
    hasExactLine(outputText(consumer), artifactSecret),
    "Artifact consumer did not return the exact protected bytes on a standalone line",
  );
  const consumerSessionId = text(consumerSpec["sessionId"], "consumer Session id");
  const consumerArchive = await poll(async () => {
    const body = await api.request(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(consumerSessionId)}/states`,
    );
    for (const state of array(body["states"], "consumer Session states").map((item) =>
      record(item, "consumer Session state"),
    )) {
      const detail = await api.request(
        "GET",
        `/api/v1/sessions/${encodeURIComponent(consumerSessionId)}/states/${encodeURIComponent(text(state["id"], "consumer Session state id"))}`,
      );
      if (JSON.stringify(detail).includes(artifactSecret)) return { body, detail };
    }
    return undefined;
  }, "consumer native archive containing admitted artifact bytes");
  const consumerNativeEvidence = nativeSessionEvidence(consumerArchive.body);
  checks.push({
    name: "independent-artifact-byte-handoff",
    passed: true,
    valueDigest: digest(artifactSecret),
    artifactId: selection.artifactId,
    paths: selection.paths,
    producerAttempt: taskAttempt(producer),
    consumerAttempt: taskAttempt(consumer),
    freshConsumerHostId: hostA,
    freshConsumerProcessGeneration: connectionGeneration(consumerHost),
    crossWorkerHostTransfer:
      taskAttempt(producer).workerHostId !== taskAttempt(consumer).workerHostId,
    producerWorkspaceDeletedBeforeConsumption: true,
    admittedSelectorMatches: true,
    consumerArchiveContainedArtifactBytes: true,
    consumerNativeIds: consumerNativeEvidence.nativeIds,
  });

  report["workerHosts"] = {
    hostA: {
      id: hostA,
      initialGeneration: connectionGeneration(hostAConnected),
      credentialDigest: digest(credentialA),
    },
    hostB: {
      id: hostB,
      initialGeneration: connectionGeneration(hostBInitial),
      finalGeneration: connectionGeneration(
        await api.request("GET", `/api/v1/worker-hosts/${hostB}`),
      ),
      credentialDigest: digest(credentialB),
    },
    independentlyAuthenticated: credentialA !== credentialB,
  };
  report["finishedAt"] = new Date().toISOString();
  report["result"] = "passed";
} catch (error) {
  report["finishedAt"] = new Date().toISOString();
  report["result"] = "failed";
  const failure = redactSecrets(
    error instanceof Error ? error.message : String(error),
    protectedValues,
  );
  report["failure"] = failure;
  if (record(report["restart"], "restart evidence")["phase"] === "pending")
    report["restart"] = {
      phase: restartInvoked ? "failed" : "not-reached",
      reason: failure,
    };
  throw new Error(failure);
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  for (const worker of workers.toReversed()) await stopWorker(worker).catch(() => undefined);
  const serialized = JSON.stringify(report);
  assertNoSecrets(serialized, protectedValues, "Hosted validation report");
  const reportPath = join(outputDirectory, "report.json");
  await writePrivateJson(reportPath, report);
  process.stdout.write(
    `${JSON.stringify({ result: report["result"], report: reportPath, transport, provider })}\n`,
  );
}

interface AssignmentInput {
  taskId: string;
  ownerTagId: string;
  instruction: string;
  acceptanceCriteria: string[];
  outputs?: boolean;
  inputArtifacts?: { artifactId: string; paths: string[] }[];
}

async function assign(apiClient: Api, input: AssignmentInput): Promise<void> {
  await command(apiClient, "assign_task", {
    objectiveId,
    taskId: input.taskId,
    teamId,
    assignedTagId: input.ownerTagId,
    instruction: input.instruction,
    acceptanceCriteria: input.acceptanceCriteria,
    execution: {
      profile: { id: profileId, revision: "1" },
      ...(input.outputs
        ? {
            outputs: {
              directory: "outputs",
              required: ["outputs/evidence.txt"],
              include: ["outputs/**"],
            },
          }
        : {}),
    },
    ...(input.inputArtifacts ? { inputArtifacts: input.inputArtifacts } : {}),
    maxCostMinor: 20,
  });
}

async function command(apiClient: Api, name: string, input: JsonRecord): Promise<JsonRecord> {
  return apiClient.request("POST", `/api/v1/coordination/${name}`, input);
}

async function enrollHost(apiClient: Api, hostId: string): Promise<string> {
  const issuance = await apiClient.request("POST", "/api/v1/worker-hosts", {
    apiVersion: "supertag/v1",
    kind: "WorkerHostEnrollment",
    metadata: { id: hostId },
    spec: {},
  });
  return text(record(issuance["credential"], "Worker credential")["token"], "Worker token");
}

interface RunningWorker {
  child: ChildProcess;
  log: WriteStream;
  stopped: boolean;
}

async function startWorker(input: {
  hostId: string;
  credential: string;
  phaseDirectory: string;
  workspaceDirectory?: string;
}): Promise<RunningWorker> {
  const logPath = join(input.phaseDirectory, "worker.log");
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    log.once("open", () => resolveOpen());
    log.once("error", rejectOpen);
  });
  const workspace = input.workspaceDirectory ?? join(input.phaseDirectory, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const state = join(input.phaseDirectory, "state");
  const model = provider === "codex" ? values["codex-model"] : values["claude-model"];
  const args = [
    "--import",
    "tsx",
    "--conditions=development",
    "apps/cli/src/index.ts",
    "connect",
    "worklet",
    "--worklet-url",
    workletUrl,
    "--transport",
    transport,
    "--harness",
    provider,
    "--workspace",
    workspace,
    "--worker-profile",
    profileId,
    "--worker-profile-revision",
    "1",
    "--worker-host",
    input.hostId,
    "--worker-id",
    `${input.hostId}-worker`,
    "--worklet-id",
    `${input.hostId}-worklet`,
    "--timeout-ms",
    "300000",
    ...(model ? ["--model", model] : []),
  ];
  const environment = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
  ])
    delete environment[key];
  delete environment["SUPERTAG_RENDER_ADMIN_TOKEN"];
  environment["SUPERTAG_STATE_DIR"] = state;
  await mkdir(join(state, "worker-hosts"), { recursive: true, mode: 0o700 });
  await writePrivateJson(
    join(state, "worker-hosts", `${encodeURIComponent(input.hostId)}.credential.json`),
    { version: 1, workerHostId: input.hostId, token: input.credential },
  );
  if (tlsCaFile) environment["SUPERTAG_WORKLET_TLS_CA_FILE"] = tlsCaFile;
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: environment,
    stdio: ["ignore", log, log],
  });
  const running = { child, log, stopped: false };
  child.once("exit", () => {
    running.stopped = true;
    log.end();
  });
  return running;
}

async function stopWorker(worker: RunningWorker): Promise<void> {
  if (worker.stopped) return;
  worker.child.kill("SIGTERM");
  const ended = await Promise.race([
    new Promise<boolean>((resolveEnded) => worker.child.once("exit", () => resolveEnded(true))),
    delay(10_000).then(() => false),
  ]);
  if (!ended) {
    worker.child.kill("SIGKILL");
    await new Promise<void>((resolveEnded) => worker.child.once("exit", () => resolveEnded()));
  }
  worker.stopped = true;
  worker.log.end();
}

async function waitForConnected(apiClient: Api, hostId: string, afterGeneration: number) {
  return poll(async () => {
    const host = await apiClient.request("GET", `/api/v1/worker-hosts/${hostId}`);
    const status = record(host["status"], "Worker Host status");
    return status["connectionStatus"] === "connected" &&
      connectionGeneration(host) > afterGeneration
      ? host
      : undefined;
  }, `Worker Host ${hostId} connection after generation ${afterGeneration}`);
}

async function waitForDisconnected(apiClient: Api, hostId: string): Promise<void> {
  await poll(async () => {
    const host = await apiClient.request("GET", `/api/v1/worker-hosts/${hostId}`);
    return record(host["status"], "Worker Host status")["connectionStatus"] === "disconnected"
      ? true
      : undefined;
  }, `Worker Host ${hostId} disconnection`);
}

function connectionGeneration(host: JsonRecord): number {
  const value = record(host["status"], "Worker Host status")["connectionGeneration"];
  if (typeof value !== "number") throw new Error("Worker Host connection generation missing");
  return value;
}

async function pollTask(
  apiClient: Api,
  taskId: string,
  predicate: (task: JsonRecord) => boolean,
): Promise<JsonRecord> {
  return poll(async () => {
    const task = await apiClient.request("GET", `/api/v1/tasks/${encodeURIComponent(taskId)}`);
    const phase = assignmentPhase(task);
    if (["failed", "cancelled", "rejected"].includes(phase))
      throw new Error(
        `Task ${taskId} reached ${phase}: ${JSON.stringify(record(task["status"])["outcome"] ?? {})}`,
      );
    if (predicate(task)) return task;
    if (["submitted", "accepted"].includes(phase))
      throw new Error(`Task ${taskId} reached ${phase} before the expected state`);
    return undefined;
  }, `Task ${taskId}`);
}

function assignmentPhase(task: JsonRecord): string {
  return text(
    record(record(task["status"], "Task status")["assignment"], "assignment")["phase"],
    "assignment phase",
  );
}

async function taskEvents(apiClient: Api, taskId: string): Promise<JsonRecord[]> {
  const body = await apiClient.request("GET", `/api/v1/tasks/${encodeURIComponent(taskId)}/events`);
  return array(body["items"], "Task events").map((item) => record(item, "Task event"));
}

async function negativeAuthentication(
  apiClient: Api,
  url: string,
  selectedTransport: string,
  caFile?: string,
): Promise<void> {
  const response = await fetch(`${management}/api/v1/tasks`, {
    headers: { authorization: `Bearer invalid-${randomUUID()}` },
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(15_000), runAbort.signal]),
  });
  assert.equal(response.status, 401);
  if (selectedTransport !== "grpc") return;
  const { GrpcExecutionAuthorityClient } = await import(
    "../packages/runtime/transport/src/index.js"
  );
  const client = new GrpcExecutionAuthorityClient({
    baseUrl: url,
    ...(caFile ? { tlsCa: await readFile(caFile, "utf8") } : {}),
  });
  await assert.rejects(client.rebind(`invalid-${randomUUID()}`), /unauth|credential|token/i);
  void apiClient;
}

async function runRestartHook(path: string, directory: string): Promise<void> {
  await chmod(path, 0o700);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SUPERTAG_MANAGEMENT_URL: management,
  };
  delete environment["SUPERTAG_RENDER_ADMIN_TOKEN"];
  const logPath = join(directory, "restart-hook.log");
  const result = await execFileAsync(path, [], {
    cwd: root,
    env: environment,
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
    signal: runAbort.signal,
  });
  await writeFile(logPath, `${result.stdout}${result.stderr}`, { mode: 0o600 });
}

async function poll<T>(operation: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    runAbort.signal.throwIfAborted();
    try {
      const result = await operation();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /reached (failed|cancelled|rejected)/u.test(error.message))
        throw error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: lastError });
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function requiredHttpsOrigin(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`${name} must be a credential-free HTTPS origin`);
  url.pathname = "/";
  return url.origin;
}

function resolveWorkletUrl(
  managementOrigin: string,
  selectedTransport: string,
  explicit: string | undefined,
): string {
  if (explicit) return new URL(explicit).toString();
  if (selectedTransport === "grpc")
    throw new Error("gRPC requires --worklet-url for the SSH tunnel or public HTTP/2 listener");
  const url = new URL(managementOrigin);
  url.protocol = "wss:";
  url.pathname = "/worklets";
  return url.toString();
}

function redactUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
