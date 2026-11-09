import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { toJson } from "@bufbuild/protobuf";
import { probeInvalidExecutionCredential } from "../apps/cli/src/deploy.js";
import {
  conversationClient,
  hostClient,
  organizationClient,
  workClient,
} from "../apps/cli/src/operator-client.js";
import { taskView } from "../apps/cli/src/work-protos.js";
import {
  ListSessionStatesResponseSchema,
  ReplyStatus,
  SessionStateSchema,
  TaskEventSchema,
  type WorkerHost,
  WorkerHostConnection,
} from "../packages/operator-api/src/index.js";
import {
  assertNoSecrets,
  digest,
  hasExactLine,
  isToolCallStarted,
  type JsonRecord,
  nativeSessionEvidence,
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

  /** The work RPCs, and the options each call takes. */
  work() {
    return {
      client: workClient({ url: this.origin, token: this.token }),
      options: {
        signal: runAbort.signal,
        timeoutMs: Math.min(this.timeout, 30_000),
      },
    };
  }

  /** A Session's native archives, and each archive with its contents. */
  async sessionStates(sessionId: string): Promise<{ body: JsonRecord; details: JsonRecord[] }> {
    const { client, options } = this.work();
    const listed = await client.listSessionStates({ sessionId }, options);
    const details = await Promise.all(
      listed.states.map(
        async (state) =>
          toJson(
            SessionStateSchema,
            await client.getSessionState({ sessionId, id: state.id }, options),
          ) as JsonRecord,
      ),
    );
    return { body: toJson(ListSessionStatesResponseSchema, listed) as JsonRecord, details };
  }

  /** One Worker Host, read from HostService. */
  async workerHost(id: string): Promise<WorkerHost> {
    return await hostClient({ url: this.origin, token: this.token }).getWorkerHost(
      { id },
      { signal: runAbort.signal, timeoutMs: Math.min(this.timeout, 30_000) },
    );
  }

  /** Enrolls a Worker Host and returns its credential's token. */
  async enrollWorkerHost(id: string): Promise<string> {
    const credential = await hostClient({
      url: this.origin,
      token: this.token,
    }).enrollWorkerHost(
      { id },
      { signal: runAbort.signal, timeoutMs: Math.min(this.timeout, 30_000) },
    );
    return credential.token;
  }

  /** The conversation RPCs, and the options each call takes. */
  conversations() {
    return {
      client: conversationClient({ url: this.origin, token: this.token }),
      options: {
        signal: runAbort.signal,
        timeoutMs: Math.min(this.timeout, 30_000),
      },
    };
  }

  async waitUntilReachable(): Promise<void> {
    await poll(async () => {
      try {
        await organizationClient({ url: this.origin, token: this.token }).getStatus(
          {},
          { signal: runAbort.signal, timeoutMs: Math.min(this.timeout, 30_000) },
        );
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
const tagName = `${prefix}-tag`;
const permissionSetName = `${prefix}-runtime`;
const roleName = `${prefix}-worker`;
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
      instructions: "Do only what each message asks and do not start work Sessions.",
      permissionSets: [permissionSetName],
      contextSets: [],
    },
  });

  await api.request("POST", "/api/v1/tags", {
    apiVersion: "supertag/v1",
    kind: "Tag",
    metadata: { name: tagName },
    spec: { roles: [roleName], workerHosts: [hostA, hostB] },
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

  // Two turns of one conversation: the first reads the value on Host A, the second recalls it
  // on a fresh Host B process after Host A's state and the Workspace contents are deleted.
  const continuity = `${prefix}-continuity`;
  const firstTurn = await converse(
    api,
    continuity,
    [
      "This is a two-turn native Session continuity probe.",
      "Read challenge.txt once with a shell command and memorize its exact contents. Do not repeat it in your answer, messages, files, or tool arguments.",
      "Reply only with READY. Do not start work Sessions, create resources, or use external services.",
    ].join(" "),
  );
  const firstTask = firstTurn.task;
  const attemptA = taskAttempt(firstTask);
  assert.equal(attemptA.workerHostId, hostA);
  const continuitySpec = record(firstTask["spec"], "continuity Task spec");
  assertNoSecrets(continuitySpec, [nativeSecret], "first turn durable Task spec");
  const sessionId = firstTurn.sessionId;
  const firstSessionArchive = await poll(async () => {
    const { body, details } = await api.sessionStates(sessionId);
    const detail = details.find((item) => JSON.stringify(item).includes(nativeSecret));
    return detail === undefined ? undefined : { body, detail };
  }, "first turn native Session archive containing the protected tool result");
  const firstSession = nativeSessionEvidence(firstSessionArchive.body);
  assert.equal(firstSession.nativeIds.length, 1, "The first turn must persist one native identity");
  assert.ok(
    JSON.stringify(firstSessionArchive.detail).includes(nativeSecret),
    "The first turn's native archive does not contain the protected value read from challenge.txt",
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

  const secondTurn = await converse(
    api,
    continuity,
    "Do not call any tool or search the filesystem. Reply only with the exact contents of challenge.txt that you memorized earlier in this conversation.",
  );
  const continuityDone = secondTurn.task;
  assert.equal(secondTurn.sessionId, sessionId);
  const attemptB = taskAttempt(continuityDone);
  assert.equal(attemptB.workerHostId, hostB);
  assert.equal(attemptB.profile.id, profileId);
  const recalled = secondTurn.reply.trim();
  assert.equal(recalled, nativeSecret, "Fresh Worker did not recall the exact native value");
  const sessionEvidence = nativeSessionEvidence((await api.sessionStates(sessionId)).body);
  assert.deepEqual(sessionEvidence.nativeIds, firstSession.nativeIds);
  const continuityEvents = await taskEvents(api, secondTurn.taskId);
  const attemptBToolCalls = continuityEvents.filter(
    (event) => event["attemptId"] === attemptB.id && isToolCallStarted(event),
  ).length;
  assert.equal(attemptBToolCalls, 0, "Resumed recall used a tool");
  assertNoSecrets(continuityDone["spec"], [nativeSecret], "second turn projected durable inputs");
  checks.push({
    name: "fresh-process-native-session-recall",
    passed: true,
    valueDigest: digest(nativeSecret),
    sessionId,
    nativeId: firstSession.nativeIds[0],
    stateCount: sessionEvidence.count,
    firstTurnAttempt: attemptA,
    secondTurnAttempt: attemptB,
    resumedToolCallCount: attemptBToolCalls,
    projectedTaskInputsContainedProtectedValue: false,
    fullReceivedSessionHistoryInspected: false,
    initialArchiveContainedProtectedValue: true,
    stableWorkspaceIdentityWithDeletedContents: true,
  });

  await writeFile(join(continuityWorkspace, "artifact-source.txt"), artifactSecret, {
    mode: 0o600,
  });
  const artifacts = `${prefix}-artifacts`;
  const producerTurn = await converse(
    api,
    artifacts,
    'Read ./artifact-source.txt in the current working directory first. If it is absent, report MISSING and stop; never search / or any other directory. Copy it byte-for-byte to "$SUPERTAG_OUTPUT_DIR/evidence.txt". Do not append anything or modify the file contents. Your final reply may briefly describe completion. Do not start work Sessions or use external services.',
  );
  const producer = producerTurn.task;
  const captured = await capturedEvidence(api, producerTurn.taskId);
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
  const consumerTurn = await converse(
    api,
    artifacts,
    "Use find_artifacts to find the evidence.txt artifact this conversation captured earlier, then read it with read_artifact. Reply only with its exact contents. Do not read any other file, start work Sessions, or use external services.",
  );
  const consumer = consumerTurn.task;
  assert.equal(captured.digest, `sha256:${digest(artifactSecret)}`);
  assert.equal(captured.sizeBytes, Buffer.byteLength(artifactSecret));
  assert.ok(
    hasExactLine(consumerTurn.reply, artifactSecret),
    "Artifact consumer did not return the exact protected bytes on a standalone line",
  );
  const consumerSessionId = consumerTurn.sessionId;
  const consumerArchive = await poll(async () => {
    const { body, details } = await api.sessionStates(consumerSessionId);
    const detail = details.find((item) => JSON.stringify(item).includes(artifactSecret));
    return detail === undefined ? undefined : { body, detail };
  }, "consumer native archive containing the artifact bytes");
  const consumerNativeEvidence = nativeSessionEvidence(consumerArchive.body);
  checks.push({
    name: "independent-artifact-byte-handoff",
    passed: true,
    valueDigest: digest(artifactSecret),
    artifactId: captured.artifactId,
    path: captured.path,
    producerAttempt: taskAttempt(producer),
    consumerAttempt: taskAttempt(consumer),
    freshConsumerHostId: hostA,
    freshConsumerProcessGeneration: connectionGeneration(consumerHost),
    crossWorkerHostTransfer:
      taskAttempt(producer).workerHostId !== taskAttempt(consumer).workerHostId,
    producerWorkspaceDeletedBeforeConsumption: true,
    capturedDigestMatches: true,
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
      finalGeneration: connectionGeneration(await api.workerHost(hostB)),
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

/**
 * One turn of the Tag's CLI conversation `session`: sends `message`, waits for the reply and for
 * the turn's Task to complete.
 */
async function converse(
  apiClient: Api,
  session: string,
  message: string,
): Promise<{ taskId: string; sessionId: string; reply: string; task: JsonRecord }> {
  const { client, options } = apiClient.conversations();
  const sent = await client.sendMessage(
    { tag: tagName, conversation: session, text: message },
    options,
  );
  const taskId = text(sent.taskId, "turn Task id");
  const replied = await poll(async () => {
    const current = await client.getMessage({ tag: tagName, taskId }, options);
    return current.status === ReplyStatus.REPLIED ? current : undefined;
  }, `reply to Task ${taskId}`);
  return {
    taskId,
    sessionId: text(replied.sessionId, "turn Session id"),
    reply: text(replied.reply?.text, "turn reply text"),
    task: await pollTask(apiClient, taskId),
  };
}

/** The one evidence.txt file the turn's Task captured, from the operator artifact catalog. */
async function capturedEvidence(
  apiClient: Api,
  taskId: string,
): Promise<{ artifactId: string; path: string; digest: string; sizeBytes: number }> {
  const { client, options } = apiClient.work();
  const page = await client.listArtifacts({ taskId, pageSize: 100 }, options);
  for (const artifact of page.artifacts)
    for (const entry of artifact.entries) {
      if (!entry.path.endsWith("evidence.txt")) continue;
      return {
        artifactId: artifact.id,
        path: entry.path,
        digest: entry.digest,
        sizeBytes: Number(entry.sizeBytes),
      };
    }
  throw new Error(`Task ${taskId} captured no evidence.txt artifact`);
}

async function enrollHost(apiClient: Api, hostId: string): Promise<string> {
  return text(await apiClient.enrollWorkerHost(hostId), "Worker token");
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
    const host = await apiClient.workerHost(hostId);
    return host.connectionStatus === WorkerHostConnection.CONNECTED &&
      connectionGeneration(host) > afterGeneration
      ? host
      : undefined;
  }, `Worker Host ${hostId} connection after generation ${afterGeneration}`);
}

async function waitForDisconnected(apiClient: Api, hostId: string): Promise<void> {
  await poll(async () => {
    const host = await apiClient.workerHost(hostId);
    return host.connectionStatus === WorkerHostConnection.DISCONNECTED ? true : undefined;
  }, `Worker Host ${hostId} disconnection`);
}

function connectionGeneration(host: WorkerHost): number {
  return Number(host.connectionGeneration);
}

async function pollTask(apiClient: Api, taskId: string): Promise<JsonRecord> {
  return poll(async () => {
    const { client, options } = apiClient.work();
    const task = taskView(await client.getTask({ id: taskId }, options)) as unknown as JsonRecord;
    const phase = text(record(task["status"], "Task status")["phase"], "Task phase");
    if (["failed", "cancelled"].includes(phase))
      throw new Error(
        `Task ${taskId} reached ${phase}: ${JSON.stringify(record(task["status"])["outcome"] ?? {})}`,
      );
    return phase === "completed" ? task : undefined;
  }, `Task ${taskId}`);
}

async function taskEvents(apiClient: Api, taskId: string): Promise<JsonRecord[]> {
  const { client, options } = apiClient.work();
  const events: JsonRecord[] = [];
  let pageToken = "";
  do {
    const page = await client.listTaskEvents({ taskId, pageSize: 1000, pageToken }, options);
    for (const event of page.events) events.push(toJson(TaskEventSchema, event) as JsonRecord);
    pageToken = page.nextPageToken;
  } while (pageToken !== "");
  return events;
}

async function negativeAuthentication(
  apiClient: Api,
  url: string,
  selectedTransport: string,
  caFile?: string,
): Promise<void> {
  const response = await fetch(`${management}/supertag.operator.v1.WorkService/ListTasks`, {
    method: "POST",
    headers: {
      authorization: `Bearer invalid-${randomUUID()}`,
      "content-type": "application/json",
    },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(15_000), runAbort.signal]),
  });
  assert.equal(response.status, 401);
  if (selectedTransport !== "grpc") return;
  await probeInvalidExecutionCredential(
    grpcOrigin(url),
    caFile ? await readFile(caFile, "utf8") : undefined,
  );
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
      if (error instanceof Error && /reached (failed|cancelled)/u.test(error.message)) throw error;
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

/** The gRPC Worklet origin: HTTPS, or plain HTTP to a loopback address such as an SSH tunnel. */
function grpcOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new Error("--worklet-url for gRPC must be an HTTPS origin or a loopback HTTP origin");
  return url.origin;
}

function redactUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
