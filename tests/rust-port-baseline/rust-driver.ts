/**
 * Test-only driver for the Rust services. It launches the built `supertag` binary as separate
 * Control Plane, Gateway, and Worker Host processes with private temporary state, ephemeral
 * loopback ports, and generated credentials. It observes them only through public operations:
 * the `supertag-ai/gateway` gRPC client, the `supertag` CLI, and the `supertag-ai/harness`
 * adapter entry point used by `rust-baseline-adapter.mjs`. It imports no TypeScript Control
 * Plane, store, or runtime implementation.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Code, ConnectError, createGatewayClient } from "../../packages/supertag-ai/src/gateway.ts";

type Gateway = ReturnType<typeof createGatewayClient>;
type Task = Awaited<ReturnType<Gateway["operator"]["getTask"]>>;

const root = resolve(import.meta.dirname, "../..");
const binary =
  process.env["SUPERTAG_BASELINE_RUST_BINARY"] ?? join(root, "rust/target/debug/supertag");
const adapterSource = join(import.meta.dirname, "rust-baseline-adapter.mjs");
const execute = promisify(execFile);
const WAIT_MS = 30_000;

// Public enum numbers from rust/proto/supertag/runtime/v2/{runtime,policy}.proto.
const TaskState = { queued: 1, running: 2, succeeded: 3, failed: 4, cancelled: 5 } as const;
const ObjectiveStatus = { working: 1, limited: 3 } as const;
const RUNTIME_TARGET = 1;
const ROLE_ACTIVE = 1;

/**
 * Rust names terminal success `succeeded`; the baseline's semantic vocabulary predates the
 * rewrite and calls the same state `completed`. This is a naming change, not a behavior change.
 */
function taskStatus(state: number): string {
  switch (state) {
    case TaskState.queued:
      return "queued";
    case TaskState.running:
      return "running";
    case TaskState.succeeded:
      return "completed";
    case TaskState.failed:
      return "failed";
    case TaskState.cancelled:
      return "cancelled";
    default:
      return `state-${state}`;
  }
}

function objectiveStatus(status: number): string {
  if (status === ObjectiveStatus.working) return "working";
  if (status === ObjectiveStatus.limited) return "limited";
  return `status-${status}`;
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  const deadline = performance.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(25);
  }
}

const credentials = {
  gateway: randomUUID(),
  operator: randomUUID(),
  host: randomUUID(),
};

/** Only generated credentials and a minimal PATH enter Rust processes. */
function environment(directory: string, extra: Record<string, string> = {}) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: join(directory, "home"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    SUPERTAG_GATEWAY_TOKEN: credentials.gateway,
    SUPERTAG_OPERATOR_TOKEN: credentials.operator,
    SUPERTAG_HOST_TOKEN: credentials.host,
    SUPERTAG_BOOTSTRAP_HOST_TOKEN: credentials.host,
    ...extra,
  };
}

const children = new Set<ChildProcess>();

async function launch(
  directory: string,
  name: string,
  args: string[],
  extra: Record<string, string> = {},
) {
  await mkdir(join(directory, "logs"), { recursive: true });
  const log = await open(join(directory, "logs", `${name}-${randomUUID()}.log`), "w");
  const child = spawn(binary, args, {
    cwd: directory,
    env: environment(directory, extra),
    stdio: ["ignore", "pipe", log.fd],
  });
  children.add(child);
  const exited = once(child, "exit").then(async ([code, signal]) => {
    children.delete(child);
    await log.close();
    return { code: code as number | null, signal: signal as string | null };
  });
  return { child, exited };
}

/** A service prints its bound loopback endpoint as its first stdout line. */
async function service(directory: string, name: string, args: string[], extra = {}) {
  const launched = await launch(directory, name, args, extra);
  let buffered = "";
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not start`)), WAIT_MS);
    launched.child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const line = buffered.split("\n")[0];
      if (buffered.includes("\n") && line) {
        clearTimeout(timer);
        resolve(line.trim());
      }
    });
    void launched.exited.then(({ code, signal }) =>
      reject(new Error(`${name} exited before reporting its endpoint (${code ?? signal})`)),
    );
  });
  const url = endpoint.startsWith("http://") ? endpoint : `http://${endpoint}`;
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u.test(url))
    throw new Error(`${name} reported an unexpected endpoint`);
  return { ...launched, url };
}

async function crash(service: { child: ChildProcess; exited: Promise<unknown> }) {
  if (service.child.exitCode === null && service.child.signalCode === null)
    service.child.kill("SIGKILL");
  await service.exited;
}

async function database(directory: string, backend: string) {
  if (backend !== "postgresql")
    return { url: `sqlite://${join(directory, "baseline.db")}?mode=rwc`, cleanup: async () => {} };
  const base = process.env["SUPERTAG_POSTGRES_URL"];
  if (!base) throw new Error("Missing isolated PostgreSQL URL");
  const Pool = createRequire(join(root, "packages/store/package.json"))("pg")
    .Pool as new (options: {
    connectionString: string;
    max: number;
  }) => { query(text: string): Promise<unknown>; end(): Promise<void> };
  const name = `supertag_rust_baseline_${randomUUID().replaceAll("-", "")}`;
  const admin = async (statement: string) => {
    const pool = new Pool({ connectionString: base, max: 1 });
    try {
      await pool.query(statement);
    } finally {
      await pool.end();
    }
  };
  await admin(`CREATE DATABASE "${name}"`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    cleanup: () => admin(`DROP DATABASE "${name}" WITH (FORCE)`),
  };
}

interface AdapterRecord {
  readonly event: "started" | "finished";
  readonly taskId: string;
  readonly pid: number;
  readonly cwd: string;
  readonly allowedActions?: string[];
}

async function fixture(directory: string, databaseUrl: string) {
  await mkdir(join(directory, "home"), { recursive: true });
  const record = join(directory, "adapter-records.jsonl");
  const adapter = join(directory, "baseline-adapter");
  await writeFile(adapter, `#!/bin/sh\nexec '${process.execPath}' '${adapterSource}' "$@"\n`);
  await chmod(adapter, 0o700);
  let plane: Awaited<ReturnType<typeof service>>;
  let gateway: Awaited<ReturnType<typeof service>>;
  let client: Gateway;
  const start = async () => {
    plane = await service(directory, "control-plane", ["control-plane"], {
      SUPERTAG_DATABASE_URL: databaseUrl,
    });
    gateway = await service(directory, "gateway", [
      "gateway",
      "--control-plane",
      plane.url,
      "--checkpoint-directory",
      join(directory, "gateway-artifacts"),
    ]);
    client = createGatewayClient({ url: gateway.url, token: credentials.operator });
  };
  await start();
  const records = async (): Promise<AdapterRecord[]> =>
    existsSync(record)
      ? (await readFile(record, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as AdapterRecord)
      : [];
  return {
    get client() {
      return client;
    },
    get gatewayUrl() {
      return gateway.url;
    },
    records,
    /** Hard-stop both services; their durable SQL state stays in place. */
    async stop() {
      client.close();
      await crash(gateway);
      await crash(plane);
    },
    start,
    /** Hard-stop both services, then reopen the same durable SQL state on new ports. */
    async restart() {
      await this.stop();
      await start();
    },
    /** A Worker Host's private state directory, which holds its Attempt journal. */
    hostState: (name: string) => join(directory, "hosts", name),
    host(name: string, mode: string, extra: string[] = []) {
      return launch(directory, `worker-host-${name}`, [
        "worker-host",
        "--gateway",
        gateway.url,
        "--state-directory",
        join(directory, "hosts", name),
        "--adapter",
        adapter,
        `--adapter-arg=--mode=${mode}`,
        `--adapter-arg=--record=${record}`,
        "--once",
        ...extra,
      ]);
    },
    async cli(args: string[]) {
      const { stdout } = await execute(binary, [...args, "--gateway", gateway.url], {
        cwd: directory,
        env: environment(directory),
        timeout: WAIT_MS,
      });
      return JSON.parse(stdout) as Record<string, unknown>;
    },
    task: (taskId: string) => client.operator.getTask({ taskId }),
    async state(taskId: string, state: number) {
      return until(
        () => client.operator.getTask({ taskId }),
        (task) => task.state === state,
        `Task ${taskId} to reach ${taskStatus(state)}`,
      );
    },
    close() {
      client?.close();
    },
  };
}

/** Kill every process this driver spawned, including services from a partial startup. */
async function killChildren() {
  const running = [...children];
  for (const child of running) child.kill("SIGKILL");
  await Promise.all(
    running.map((child) =>
      child.exitCode === null && child.signalCode === null
        ? once(child, "exit").catch(() => undefined)
        : undefined,
    ),
  );
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function succeeded(host: {
  exited: Promise<{ code: number | null; signal: string | null }>;
}) {
  const { code, signal } = await host.exited;
  if (code !== 0) throw new Error(`Worker Host exited with ${code ?? signal}`);
}

/** Every Task accepted for a Tag is one message in one of its conversations. */
async function taskCount(fixture: Fixture, tagId: string) {
  let count = 0;
  const { conversations } = await fixture.client.conversations.listConversations({
    tagId,
    limit: 100,
  });
  for (const conversation of conversations) {
    const { messages } = await fixture.client.conversations.listMessages({
      tagId,
      conversation: conversation.name,
      limit: 100,
    });
    count += messages.length;
  }
  return count;
}

const TAG = "baseline-engineer";
const CONVERSATION = "baseline-conversation";
const SESSION = "baseline-session";
const PROMPT = "Complete this deterministic baseline Task";

/** An operator message in a named conversation accepts one Task with a stable operation ID. */
async function message(fixture: Fixture, operationId: string) {
  const { task } = await fixture.client.conversations.sendMessage({
    tagId: TAG,
    conversation: CONVERSATION,
    text: PROMPT,
    operationId,
  });
  if (!task) throw new Error("The message accepted no Task");
  return task;
}

async function admission(fixture: Fixture) {
  await fixture.client.operator.putTag({
    tagId: TAG,
    instructions: "Complete deterministic baseline work",
    allowedActions: [],
  });
  const submit = () => message(fixture, "stable-operation");
  // Discard the first response's significance: repeat exactly the same operation identity.
  const first = await submit();
  const retry = await submit();
  const host = await fixture.host("admission", "complete");
  await fixture.state(first.taskId, TaskState.succeeded);
  await succeeded(host);
  await fixture.restart();
  const afterRestart = await submit();
  return {
    sameTaskOnRetry: first.taskId === retry.taskId,
    sameTaskAfterRestart: first.taskId === afterRestart.taskId,
    taskCount: await taskCount(fixture, TAG),
    executionCount: (await fixture.records()).filter(
      (entry) => entry.event === "started" && entry.taskId === first.taskId,
    ).length,
    status: taskStatus((await fixture.task(first.taskId)).state),
  };
}

/** The accepted authority of a Task, serialized for exact comparison. */
function acceptedPolicy(task: Task) {
  return JSON.stringify(
    {
      allowedActions: task.allowedActions,
      instructions: task.instructions,
      tagRevision: task.tagRevision,
      policySnapshot: task.policySnapshot,
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
}

async function permissions(fixture: Fixture) {
  const { policy, operator } = fixture.client;
  await operator.putTag({
    tagId: TAG,
    instructions: "Complete deterministic baseline work",
    allowedActions: [],
  });
  const set = await policy.putPermissionSet({
    operationId: "create-permissions",
    permissionSet: {
      name: "baseline-permissions",
      permissions: [{ target: RUNTIME_TARGET, action: "commands:execute" }],
    },
  });
  const role = await policy.putRole({
    operationId: "create-role",
    role: {
      name: "baseline-role",
      purpose: "Run baseline work",
      instructions: "Use allowed actions",
      permissionSetIds: [set.setId],
      status: ROLE_ACTIVE,
    },
  });
  await policy.assignRole({ operationId: "assign-role", role: role.name, tagId: TAG });
  const run = async (operationId: string, host: string) => {
    const task = await message(fixture, operationId);
    const worker = await fixture.host(host, "complete");
    await fixture.state(task.taskId, TaskState.succeeded);
    await succeeded(worker);
    return task.taskId;
  };
  const first = await run("before-policy-change", "before");
  const originalSnapshot = acceptedPolicy(await fixture.task(first));
  // Replace the grant: remove commands:execute and allow files:write instead.
  await policy.putPermissionSet({
    operationId: "change-permissions",
    expectedRevision: set.revision,
    permissionSet: {
      setId: set.setId,
      name: set.name,
      permissions: [{ target: RUNTIME_TARGET, action: "files:write" }],
    },
  });
  const later = await run("after-policy-change", "after");
  await fixture.restart();
  const started = (await fixture.records()).find(
    (entry) => entry.event === "started" && entry.taskId === first,
  );
  return {
    firstTaskActions: [...(await fixture.task(first)).allowedActions].sort(),
    firstExecutionActions: [...(started?.allowedActions ?? [])].sort(),
    laterTaskActions: [...(await fixture.task(later)).allowedActions].sort(),
    snapshotSurvivedRestart: acceptedPolicy(await fixture.task(first)) === originalSnapshot,
  };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** An abort is an adapter process for the Task that ended without completing its work. */
async function aborts(fixture: Fixture, taskId: string) {
  const entries = (await fixture.records()).filter((entry) => entry.taskId === taskId);
  return entries.filter(
    (entry) =>
      entry.event === "started" &&
      !alive(entry.pid) &&
      !entries.some((other) => other.event === "finished" && other.pid === entry.pid),
  ).length;
}

async function objective(fixture: Fixture) {
  const { objectives, operator } = fixture.client;
  const minutesFromNow = (minutes: number) => BigInt(Date.now() + minutes * 60_000);
  await operator.putTag({ tagId: TAG, instructions: "Maintain the baseline", allowedActions: [] });
  const created = await objectives.createObjective({
    operationId: "create-objective",
    objectiveId: "baseline-objective",
    ownerTagId: TAG,
    outcome: "Maintain the baseline",
    ongoing: true,
    deadlineMs: minutesFromNow(60),
  });
  const taskId = created.startingTaskId;
  const host = await fixture.host("objective", "hold");
  await fixture.state(taskId, TaskState.running);
  await until(
    async () => (await fixture.records()).some((entry) => entry.taskId === taskId),
    Boolean,
    "the Objective Task's adapter to start",
  );
  const reload = () => objectives.getObjective({ objectiveId: created.objectiveId });
  const changeDeadline = async (minutes: number, operationId: string) =>
    objectives.setLimits({
      objectiveId: created.objectiveId,
      operationId,
      deadlineMs: minutesFromNow(minutes),
      expectedRevision: (await reload()).revision,
    });
  // The Control Plane sweeps limits once per second. Allow several sweeps inside the grace.
  await changeDeadline(-5, "deadline-in-grace");
  await delay(3_500);
  const duringGraceTask = taskStatus((await fixture.task(taskId)).state);
  const duringGraceObjective = objectiveStatus((await reload()).status);
  const duringGraceAborts = await aborts(fixture, taskId);
  await changeDeadline(-20, "deadline-after-grace");
  await fixture.state(taskId, TaskState.cancelled);
  await until(reload, (value) => value.status === ObjectiveStatus.limited, "limited Objective");
  await until(
    () => aborts(fixture, taskId),
    (count) => count > 0,
    "the cancelled adapter to stop",
  );
  await host.exited;
  return {
    duringGraceTask,
    duringGraceObjective,
    duringGraceAborts,
    afterGraceTask: taskStatus((await fixture.task(taskId)).state),
    afterGraceObjective: objectiveStatus((await reload()).status),
    targetTaskAborts: await aborts(fixture, taskId),
  };
}

/**
 * Stops the Worker Host after its adapter has finished but before its outcome reaches the
 * Control Plane. Only the host's Attempt journal then knows the outcome. Restarting the host on
 * the same state directory must report that outcome without running the adapter again; a host
 * with an empty state directory has nothing to report and the Task never completes.
 */
async function replay(fixture: Fixture, directory: string) {
  // The client is replaced when the services restart.
  const operator = () => fixture.client.operator;
  await operator().putTag({ tagId: TAG, instructions: "Replay baseline work", allowedActions: [] });
  const request = {
    tagId: TAG,
    sessionId: SESSION,
    operationId: "baseline-replay",
    prompt: PROMPT,
  };
  const receipt = await operator().submitTask(request);
  const gate = join(directory, "replay-gate");
  const first = await fixture.host("replay", "complete", [`--adapter-arg=--gate=${gate}`]);
  const listEvents = async (afterSequence: bigint) =>
    (await operator().listEvents({ taskId: receipt.taskId, afterSequence, limit: 100 })).events;
  const events = await until(
    () => listEvents(0n),
    (value) => value.length === 3,
    "the adapter's three events",
  );
  // Take the services away, then let the adapter finish. The host records the outcome in its
  // journal and keeps retrying a report that cannot arrive.
  await fixture.stop();
  await writeFile(gate, "");
  const journal = join(fixture.hostState("replay"), "attempt.json");
  const recorded = await until(
    async () =>
      existsSync(journal)
        ? (JSON.parse(await readFile(journal, "utf8")) as { stage?: string; task_id?: string })
        : {},
    (entry) => entry.stage === "finish",
    "the Worker Host to journal the finished outcome",
  );
  if (recorded.task_id !== receipt.taskId) throw new Error("The journal names another Task");
  await crash(first);
  await fixture.start();
  if (taskStatus((await fixture.task(receipt.taskId)).state) !== "running")
    throw new Error("The outcome reached the Control Plane before the Worker Host stopped");
  // Reopen the same Worker Host journal; accepted work must not run again.
  await succeeded(await fixture.host("replay", "complete"));
  const completed = await fixture.state(receipt.taskId, TaskState.succeeded);
  const recovered = await operator().submitTask(request);
  const tail = await listEvents(1n);
  let conflictingRetryRejected = false;
  try {
    await operator().submitTask({ ...request, prompt: "A different intent" });
  } catch (error) {
    if (ConnectError.from(error).code !== Code.AlreadyExists) throw error;
    conflictingRetryRejected = true;
  }
  const serialize = (value: unknown) =>
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
  return {
    executionCount: (await fixture.records()).filter((entry) => entry.event === "started").length,
    receiptPreserved:
      recovered.taskId === receipt.taskId && serialize(recovered) === serialize(completed),
    statusAfterRestart: taskStatus((await fixture.task(receipt.taskId)).state),
    sequences: events.map((event) => Number(event.sequence)),
    tailSequences: tail.map((event) => Number(event.sequence)),
    tailMatches: serialize(tail) === serialize(events.slice(1)),
    conflictingRetryRejected,
  };
}

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execute("/usr/bin/git", args, {
    cwd,
    timeout: 10_000,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  });
  return stdout.trim();
}

/** The same pinned/newer/dirty source shape as tests/support/repository-execution.ts. */
async function repository(directory: string) {
  const source = join(directory, "source");
  await mkdir(source, { recursive: true });
  await git(source, "init", "--quiet");
  await writeFile(
    join(source, "overlap.cjs"),
    "module.exports=(a,b)=>a.start<=b.end&&b.start<=a.end;\n",
  );
  await git(source, "add", "overlap.cjs");
  await git(source, "commit", "--quiet", "-m", "Pinned baseline");
  const revision = await git(source, "rev-parse", "HEAD");
  await writeFile(
    join(source, "later.txt"),
    "A newer commit must not enter the requested revision\n",
  );
  await git(source, "add", "later.txt");
  await git(source, "commit", "--quiet", "-m", "Newer source");
  await writeFile(join(source, "overlap.cjs"), "uncommitted operator changes\n");
  return { source, revision };
}

async function workspace(fixture: Fixture, directory: string) {
  const { source, revision } = await repository(directory);
  const { operator } = fixture.client;
  const workspaceSpec = { workspaceId: "project", baseCommit: revision };
  const hostWorkspace = ["--workspace-id", "project", "--workspace-source", source];
  await operator.putTag({
    tagId: "producer",
    instructions: "Change the pinned source and export a patch",
    allowedActions: ["files:write", "commands:execute"],
    workspace: workspaceSpec,
  });
  await operator.putTag({
    tagId: "reviewer",
    instructions: "Independently check the exported patch",
    allowedActions: ["files:write", "commands:execute"],
    workspace: workspaceSpec,
  });
  const produced = await operator.submitTask({
    tagId: "producer",
    sessionId: "change",
    operationId: "produce",
    prompt: "Make adjacent ranges non-overlapping",
  });
  await succeeded(
    await fixture.host("producer", "produce", [
      `--adapter-arg=--revision=${revision}`,
      ...hostWorkspace,
    ]),
  );
  const producer = await fixture.state(produced.taskId, TaskState.succeeded);
  const producerCheckout = (await fixture.records()).find(
    (entry) => entry.taskId === produced.taskId,
  )?.cwd;
  const producerRemovedBeforeReview = !!producerCheckout && !existsSync(producerCheckout);
  const delivery = producer.workspaceDelivery;
  if (!delivery?.patch || !delivery.bundle) throw new Error("Producer delivered no patch");

  const verified: boolean[] = [];
  const download = async (taskId: string, kind: "patch" | "bundle", expected: string) => {
    const path = join(directory, `${taskId}.${kind}`);
    await fixture.cli(["task", "download", taskId, "--kind", kind, "--output", path]);
    const bytes = await readFile(path);
    verified.push(createHash("sha256").update(bytes).digest("hex") === expected);
    return bytes;
  };
  const patch = await download(produced.taskId, "patch", delivery.patch.sha256);
  await download(produced.taskId, "bundle", delivery.bundle.sha256);
  const evidence = JSON.parse(producer.result ?? "{}") as { revision?: string };

  // The reviewer is a different Tag on a fresh Worker Host with its own pinned checkout.
  const reviewed = await operator.submitTask({
    tagId: "reviewer",
    sessionId: "review",
    operationId: "review",
    prompt: JSON.stringify({ patch: patch.toString("utf8"), evidence }),
  });
  await succeeded(await fixture.host("reviewer", "review", hostWorkspace));
  const reviewer = await fixture.state(reviewed.taskId, TaskState.succeeded);
  const outcome = JSON.parse(reviewer.result ?? "{}") as {
    passed?: boolean;
    revision?: string;
    checks?: number;
  };
  const verification = reviewer.workspaceDelivery?.patch;
  if (!verification) throw new Error("Reviewer exported no verification");
  const verificationPatch = await download(reviewed.taskId, "patch", verification.sha256);
  if (!verificationPatch.toString("utf8").includes("verification.json"))
    throw new Error("Reviewer delivery omitted its verification record");
  return {
    independentChecks: outcome.checks,
    reviewPassed: outcome.passed,
    revisionMatches:
      outcome.revision === revision &&
      evidence.revision === revision &&
      delivery.baseCommit === revision,
    producerRemovedBeforeReview,
    operatorChangesPreserved:
      (await readFile(join(source, "overlap.cjs"), "utf8")) === "uncommitted operator changes\n",
    artifactDigestsVerified: verified.length === 3 && verified.every(Boolean),
  };
}

const [scenario, backend, directory] = process.argv.slice(2);
if (!directory || !backend || !scenario)
  throw new Error("Usage: DRIVER SCENARIO BACKEND DISPOSABLE_DIRECTORY");
if (!["sqlite", "postgresql", "filesystem"].includes(backend))
  throw new Error(`Unsupported baseline backend: ${backend}`);
const filesystemScenario =
  scenario === "durable-event-replay" || scenario === "workspace-verification";
if (filesystemScenario !== (backend === "filesystem"))
  throw new Error("The requested backend does not apply to this scenario");
if (!existsSync(binary)) throw new Error(`Build the Rust CLI first: ${binary} is missing`);

// Filesystem scenarios exercise Worker Host journals and Git workspaces; their Control Plane
// state lives in a private SQLite file inside the disposable directory.
const sql = await database(directory, backend === "postgresql" ? "postgresql" : "sqlite");
let facts: unknown;
let services: Fixture | undefined;
try {
  services = await fixture(directory, sql.url);
  switch (scenario) {
    case "admission-retry":
      facts = await admission(services);
      break;
    case "permission-snapshot":
      facts = await permissions(services);
      break;
    case "objective-deadline":
      facts = await objective(services);
      break;
    case "durable-event-replay":
      facts = await replay(services, directory);
      break;
    case "workspace-verification":
      facts = await workspace(services, directory);
      break;
    default:
      throw new Error(`Unknown baseline scenario: ${scenario}`);
  }
} catch (error) {
  // Service logs stay in the disposable directory; print their paths, never credentials.
  process.stderr.write(`Rust baseline driver failed; logs: ${join(directory, "logs")}\n`);
  throw error;
} finally {
  services?.close();
  await killChildren();
  await sql.cleanup();
}
process.stdout.write(
  `BASELINE_RESULT ${JSON.stringify({ version: 1, scenario, backend, facts })}\n`,
);
