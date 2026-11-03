import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  type DockerSoakConfiguration,
  type SoakFaultObservation,
  type SoakTaskObservation,
  summarizeDockerSoak,
} from "../tests/support/worklet-grpc-docker-soak.js";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    "duration-seconds": { type: "string", default: "120" },
    "max-tasks": { type: "string", default: "500" },
    concurrency: { type: "string", default: "2" },
    "fault-downtime-ms": { type: "string", default: "2500" },
    "task-timeout-ms": { type: "string", default: "45000" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  process.stdout.write(
    "Usage: pnpm exec tsx --conditions=development scripts/worklet-grpc-docker-soak.ts [--duration-seconds 120] [--max-tasks 500] [--concurrency 2] [--fault-downtime-ms 2500] [--task-timeout-ms 45000] [--output .supertag/benchmarks/worklet-grpc-docker-soak.json]\n",
  );
  process.exit(0);
}

const integer = (name: string, value: string | undefined, minimum = 1) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  return parsed;
};
const configuration: DockerSoakConfiguration = {
  durationSeconds: integer("duration-seconds", values["duration-seconds"], 30),
  maxTasks: integer("max-tasks", values["max-tasks"], 4),
  concurrency: integer("concurrency", values.concurrency, 1),
  faultDowntimeMs: integer("fault-downtime-ms", values["fault-downtime-ms"], 500),
  taskTimeoutMs: integer("task-timeout-ms", values["task-timeout-ms"], 5000),
};
if (configuration.concurrency > 2)
  throw new Error("concurrency cannot exceed the fixture Team's capacity of 2");

interface Host {
  readonly id: string;
  readonly connectionGeneration: number;
  readonly connectionStatus: string;
}
interface TaskState {
  readonly assignment: { readonly status: string; readonly attemptCount: number };
  readonly attempts: readonly { readonly status: string }[];
  readonly events: readonly { readonly payload?: { readonly journalSequence?: number } }[];
}
type MutableTask = {
  taskId: string;
  hostId: string;
  submittedAtMs: number;
  completedAtMs?: number;
  attemptCount: number;
  journalSequences: number[];
  error?: string;
};

const directory = await mkdtemp(join(tmpdir(), "supertag-worklet-grpc-soak-"));
const suffix = randomUUID().slice(0, 8);
const controlNetwork = `supertag-soak-control-${suffix}`;
const executionNetwork = `supertag-soak-execution-${suffix}`;
const image = `supertag-soak-${suffix}:test`;
const containers: string[] = [];
const workerCredentials = new Map<string, string>();
const adminToken = randomUUID();
const environment = {
  ...process.env,
  SUPERTAG_TEST_ADMIN_TOKEN: randomUUID(),
  SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken,
};
let apiUrl = "";
const name = (service: string) => `supertag-soak-${suffix}-${service}`;
const tasks: MutableTask[] = [];
const faults: SoakFaultObservation[] = [];

try {
  await buildFixture();
  await execute("docker", ["network", "create", controlNetwork]);
  await execute("docker", ["network", "create", executionNetwork]);
  await createService("execution", "shared-execution-grpc-service.js", executionNetwork);
  await startService("execution", "shared gRPC execution ready");
  await createService("control-plane", "worklet-grpc-docker-control-plane.js", controlNetwork, [
    "-p",
    "127.0.0.1::8790",
  ]);
  await startService("control-plane", "Control Plane fixture ready");
  await refreshApiUrl();
  for (const host of ["worker-a", "worker-b"]) {
    workerCredentials.set(host, (await api<{ token: string }>("enroll", { id: host })).token);
    await createService(
      host,
      "worklet-grpc-docker-soak-worker.js",
      controlNetwork,
      ["-e", "WORKER_ID", "-e", "SUPERTAG_WORKLET_CREDENTIAL"],
      {
        ...environment,
        WORKER_ID: host,
        SUPERTAG_WORKLET_CREDENTIAL: workerCredentials.get(host),
      },
    );
    await execute("docker", ["network", "connect", executionNetwork, name(host)]);
    await startService(host, '"ready":true');
  }
  await eventually(async () => (await connectedHosts()).length === 2, configuration.taskTimeoutMs);

  const startedAt = new Date().toISOString();
  const workloadDeadline = Date.now() + configuration.durationSeconds * 1000;
  await partitionFault();
  await controlPlaneRestartFault();
  await workerRestartFault();
  let sequence = 0;
  while (Date.now() < workloadDeadline && tasks.length < configuration.maxTasks) {
    const batch: Promise<void>[] = [];
    for (
      let index = 0;
      index < configuration.concurrency && tasks.length < configuration.maxTasks;
      index++
    ) {
      const host = sequence % 2 === 0 ? "worker-a" : "worker-b";
      const task = await startTask(`soak-${sequence++}-${suffix}`, host);
      batch.push(finishTask(task));
    }
    await Promise.all(batch);
  }
  const effectCounts = await readEffectCounts();
  const endedAt = new Date().toISOString();
  const report = summarizeDockerSoak({
    startedAt,
    endedAt,
    configuration,
    tasks: tasks as SoakTaskObservation[],
    faults,
    effectCounts,
    credentialsDistinct:
      workerCredentials.size === 2 && new Set(workerCredentials.values()).size === 2,
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) {
    const path = resolve(values.output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output, { mode: 0o600 });
  }
  process.stdout.write(output);
  if (!report.gates.passed) process.exitCode = 1;
} finally {
  await Promise.all(
    containers.map((container) =>
      execute("docker", ["rm", "-f", container]).catch(() => undefined),
    ),
  );
  await execute("docker", ["network", "rm", controlNetwork]).catch(() => undefined);
  await execute("docker", ["network", "rm", executionNetwork]).catch(() => undefined);
  await execute("docker", ["image", "rm", image]).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

async function partitionFault() {
  const host = "worker-a";
  const before = await hostState(host);
  const task = await startTask(`partition-${suffix}`, host);
  await waitForJournal(task.taskId, 20);
  const disconnectedAt = Date.now();
  await execute("docker", ["network", "disconnect", controlNetwork, name(host)]);
  await new Promise((resolveWait) => setTimeout(resolveWait, configuration.faultDowntimeMs));
  const reconnectAt = Date.now();
  await execute("docker", ["network", "connect", controlNetwork, name(host)]);
  await eventually(async () => {
    const current = await hostState(host);
    return (
      current.connectionStatus === "connected" &&
      current.connectionGeneration > before.connectionGeneration
    );
  }, configuration.taskTimeoutMs);
  const connectedAt = Date.now();
  await finishTask(task);
  faults.push({
    kind: "control-network-partition",
    target: host,
    taskId: task.taskId,
    downtimeMs: reconnectAt - disconnectedAt,
    reconnectLatencyMs: connectedAt - reconnectAt,
    recoveryLatencyMs: (task.completedAtMs as number) - reconnectAt,
    recovered: task.error === undefined && task.attemptCount === 1,
  });
}

async function controlPlaneRestartFault() {
  const task = await startTask(`restart-${suffix}`, "worker-b");
  await waitForJournal(task.taskId, 20);
  const before = new Map(
    (await connectedHosts()).map((host) => [host.id, host.connectionGeneration]),
  );
  const restartedAt = Date.now();
  await execute("docker", ["restart", name("control-plane")]);
  await refreshApiUrl();
  await eventually(async () => {
    const hosts = await connectedHosts().catch(() => []);
    return (
      hosts.length === 2 &&
      hosts.every(
        (host) => host.connectionGeneration > (before.get(host.id) ?? host.connectionGeneration),
      )
    );
  }, configuration.taskTimeoutMs);
  const connectedAt = Date.now();
  await finishTask(task);
  faults.push({
    kind: "control-plane-restart",
    target: "control-plane",
    taskId: task.taskId,
    downtimeMs: connectedAt - restartedAt,
    reconnectLatencyMs: connectedAt - restartedAt,
    recoveryLatencyMs: (task.completedAtMs as number) - restartedAt,
    recovered: task.error === undefined && task.attemptCount === 1,
  });
}

async function workerRestartFault() {
  const host = "worker-a";
  const before = await hostState(host);
  const restartedAt = Date.now();
  await execute("docker", ["restart", name(host)]);
  await eventually(async () => {
    const current = await hostState(host);
    return (
      current.connectionStatus === "connected" &&
      current.connectionGeneration > before.connectionGeneration
    );
  }, configuration.taskTimeoutMs);
  const connectedAt = Date.now();
  const task = await startTask(`postrestart-${suffix}`, host);
  await finishTask(task);
  faults.push({
    kind: "worker-host-restart",
    target: host,
    taskId: task.taskId,
    downtimeMs: connectedAt - restartedAt,
    reconnectLatencyMs: connectedAt - restartedAt,
    recoveryLatencyMs: (task.completedAtMs as number) - restartedAt,
    recovered: task.error === undefined && task.attemptCount === 1,
  });
}

async function startTask(taskId: string, hostId: string): Promise<MutableTask> {
  const task: MutableTask = {
    taskId,
    hostId,
    submittedAtMs: Date.now(),
    attemptCount: 0,
    journalSequences: [],
  };
  tasks.push(task);
  try {
    await api("assign", { taskId, host: hostId, profile: hostId });
  } catch (error) {
    task.error = String(error);
    throw error;
  }
  return task;
}

async function finishTask(task: MutableTask): Promise<void> {
  try {
    let final: TaskState | undefined;
    await eventually(async () => {
      const current = await state(task.taskId);
      if (current.assignment.status === "failed") throw new Error(`Task ${task.taskId} failed`);
      if (!current.attempts.some((attempt) => attempt.status === "completed")) return false;
      final = current;
      return true;
    }, configuration.taskTimeoutMs);
    task.completedAtMs = Date.now();
    task.attemptCount = final?.assignment.attemptCount ?? final?.attempts.length ?? 0;
    task.journalSequences =
      final?.events.flatMap((event) =>
        event.payload?.journalSequence === undefined ? [] : [event.payload.journalSequence],
      ) ?? [];
  } catch (error) {
    task.error = String(error);
    throw error;
  }
}

async function waitForJournal(taskId: string, count: number) {
  await eventually(
    async () =>
      (await state(taskId)).events.filter((event) => event.payload?.journalSequence !== undefined)
        .length >= count,
    configuration.taskTimeoutMs,
  );
}

async function buildFixture() {
  await mkdir(join(directory, "certificates"));
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    join(directory, "certificates/server.key"),
    "-out",
    join(directory, "certificates/server.crt"),
    "-subj",
    "/CN=control-plane",
    "-addext",
    "subjectAltName=DNS:control-plane,DNS:execution",
  ]);
  await execute(
    "pnpm",
    [
      "exec",
      "esbuild",
      "tests/fixtures/worklet-grpc-docker-soak-worker.ts",
      "tests/fixtures/worklet-grpc-docker-control-plane.ts",
      "tests/fixtures/shared-execution-grpc-service.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--conditions=development",
      `--outdir=${join(directory, "app")}`,
      "--external:better-sqlite3",
      "--external:ws",
      '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    ],
    { cwd: repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  await cp(join(repositoryRoot, "packages/store/drizzle"), join(directory, "drizzle"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "Dockerfile"),
    [
      "FROM node:24-bookworm-slim",
      "WORKDIR /app",
      "RUN npm install --omit=dev better-sqlite3@12.11.1 ws@8.19.0 && groupadd -g 10001 workload && useradd -u 10001 -g workload workload",
      'RUN echo \'{"type":"module"}\' > package.json',
      "COPY app/ /app/",
      "COPY drizzle/ /drizzle/",
    ].join("\n"),
  );
  await execute("docker", ["build", "-t", image, directory], {
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function createService(
  service: string,
  entrypoint: string,
  network: string,
  options: string[] = [],
  env: NodeJS.ProcessEnv = environment,
) {
  containers.push(name(service));
  await execute(
    "docker",
    [
      "create",
      "--name",
      name(service),
      "--hostname",
      name(service),
      "--network",
      network,
      "--network-alias",
      service,
      "-v",
      service.startsWith("worker-")
        ? `${join(directory, "certificates/server.crt")}:/certificates/server.crt:ro`
        : `${join(directory, "certificates")}:/certificates:ro`,
      "-e",
      service === "control-plane"
        ? "SUPERTAG_TEST_ADMIN_TOKEN"
        : "SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN",
      ...options,
      image,
      "node",
      `/app/${entrypoint}`,
    ],
    { env },
  );
}

async function startService(service: string, marker: string) {
  await execute("docker", ["start", name(service)]);
  await eventually(async () => {
    const logs = await execute("docker", ["logs", name(service)]);
    const running = (
      await execute("docker", ["inspect", "-f", "{{.State.Running}}", name(service)])
    ).stdout.trim();
    if (running !== "true") throw new Error(`${service} exited: ${logs.stderr}${logs.stdout}`);
    return logs.stdout.includes(marker);
  }, 30_000);
}

async function refreshApiUrl() {
  const port = (await execute("docker", ["port", name("control-plane"), "8790/tcp"])).stdout.match(
    /:(\d+)\s*$/u,
  )?.[1];
  if (!port) throw new Error("Missing Control Plane published port");
  apiUrl = `http://127.0.0.1:${port}`;
}

async function api<T = unknown>(route: string, body: object = {}): Promise<T> {
  const response = await fetch(`${apiUrl}/${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${environment.SUPERTAG_TEST_ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Fixture ${route}: ${JSON.stringify(value)}`);
  return value as T;
}

async function connectedHosts() {
  return (await api<Host[]>("hosts")).filter((host) => host.connectionStatus === "connected");
}
async function hostState(id: string) {
  const host = (await api<Host[]>("hosts")).find((candidate) => candidate.id === id);
  if (!host) throw new Error(`Missing Worker Host ${id}`);
  return host;
}
function state(taskId: string) {
  return api<TaskState>("task", { taskId });
}

async function readEffectCounts(): Promise<Record<string, number>> {
  const output = await execute("docker", [
    "exec",
    name("execution"),
    "sh",
    "-c",
    "cat /data/soak-effects.ndjson 2>/dev/null || true",
  ]);
  const counts: Record<string, number> = {};
  for (const line of output.stdout.trim().split("\n")) {
    if (!line) continue;
    const value = JSON.parse(line) as { taskId?: unknown };
    if (typeof value.taskId === "string") counts[value.taskId] = (counts[value.taskId] ?? 0) + 1;
  }
  return counts;
}

async function eventually(probe: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Timed out waiting for Docker soak state${lastError ? `: ${String(lastError)}` : ""}`,
  );
}
