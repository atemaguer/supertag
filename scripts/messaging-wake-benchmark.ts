import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { enrollWorkerHost } from "../tests/support/worker-host-enrollment.js";

interface PoolClient {
  query(sql: string): Promise<unknown>;
  release(): void;
}
interface Pool {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}
const PostgresPool = createRequire(new URL("../packages/store/package.json", import.meta.url))("pg")
  .Pool as new (options: {
  connectionString: string;
  max: number;
}) => Pool;
interface Assignment {
  taskId: string;
  tagId: string;
  streamId: string;
  attempts: string[];
  startedAt?: number;
  controlPlaneIds: Set<string>;
}
interface Publication {
  requestStart: number;
  responseAt: number;
}
function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function distribution(values: number[]) {
  requireCondition(values.length, "Missing latency samples");
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    n: values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    min: sorted[0],
    max: sorted.at(-1),
  };
}
async function waitUntil(check: () => Promise<boolean>, errors: unknown[], label: string) {
  const deadline = performance.now() + 90000;
  while (!(await check())) {
    if (errors.length) throw new Error(`${label}: ${errors.map(String).join("; ")}`);
    if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function runScenario(baseUrl: string, controlPlaneCount: number, count: number) {
  const databaseName = `supertag_wake_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new PostgresPool({ connectionString: baseUrl, max: 1 });
  const admin = await adminPool.connect();
  let databaseCreated = false;
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const directory = await mkdtemp(join(tmpdir(), "supertag-wake-benchmark-"));
  const runtimes: Array<Awaited<ReturnType<typeof startControlPlaneRuntime>>> = [];
  const connections: Array<Awaited<ReturnType<typeof connectWorklet>>> = [];
  const durableWorklets: DurableLocalWorklet[] = [];
  const errors: unknown[] = [];
  const assignments = new Map<string, Assignment>();
  const store = new DrizzleStore({ url: databaseUrl.toString() });
  const profile = { id: "wake-benchmark", revision: "1" };
  const scenarioStart = performance.now();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    await migrateDatabase({ url: databaseUrl.toString() });
    await store.connect();
    const owner = await store.createTag({ name: "Benchmark owner" });
    await store.createObjective({
      id: "benchmark",
      ownerTagId: owner.id,
      outcome: "Measure post-to-resumption latency",
    });
    const worker = (index: number): Worker => ({
      async describe() {
        return {
          profileCapabilities: [
            {
              profile: profile,
              capabilities: [
                { id: "supertag.task-attempt.events", version: 1 },
                { id: "supertag.coordination", version: 1 },
              ],
              contextTypes: [],
            },
          ],
          id: `worker-${index}`,
          type: "deterministic",
          profiles: [profile],
          contextTypes: [],
          maxConcurrency: 8,
          capabilities: [
            { id: "supertag.task-attempt.events", version: 1 },
            { id: "supertag.coordination", version: 1 },
          ],
        };
      },
      async *execute(spec) {
        const executionAt = performance.now();
        const assignment = assignments.get(spec.taskId);
        requireCondition(assignment, `Unexpected assignment ${spec.taskId}`);
        assignment.attempts.push(spec.attemptId);
        if (assignment.attempts.length === 2) assignment.startedAt = executionAt;
        const identity = {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
        };
        try {
          requireCondition(assignment.attempts.length <= 2, `Repeated resumption ${spec.taskId}`);
          const task = await store.getTaskAssignment(spec.taskId);
          requireCondition(task?.leaseOwner, "Missing active Control Plane lease owner");
          assignment.controlPlaneIds.add(task.leaseOwner);
          yield { ...identity, type: "execution.started", workerId: `worker-${index}` };
          if (assignment.attempts.length === 1) {
            const response = await fetch(
              `${spec.coordination?.controlPlaneUrl}/internal/v1/coordination/mcp`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${spec.coordination?.token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: {
                    name: "wait_for",
                    arguments: {
                      workstreamPosts: { workstreamId: assignment.streamId, afterSequence: 0 },
                    },
                  },
                }),
              },
            );
            const body = (await response.json()) as {
              error?: unknown;
              result?: { isError?: boolean };
            };
            requireCondition(
              response.ok && !body.error && !body.result?.isError,
              `wait_for failed: ${JSON.stringify(body)}`,
            );
          }
          yield {
            ...identity,
            type: "output.message",
            message: {
              role: "teammate",
              text:
                assignment.attempts.length === 1
                  ? "Waiting for shared context"
                  : "Shared context observed",
            },
          };
          yield { ...identity, type: "execution.completed" };
        } catch (error) {
          errors.push(error);
          throw error;
        }
      },
    });
    const credentialVault = new FileGatewayCredentialVault(join(directory, "vault.json"));
    for (let index = 0; index < controlPlaneCount; index++) {
      const runtime = await startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl: databaseUrl.toString(),
        workletTransport: "remote",
        adminToken: "benchmark-admin",
        credentialVault,
      });
      runtimes.push(runtime);
      const workerHostId = `host-${index}`;
      const credential = await enrollWorkerHost(runtime.url, "benchmark-admin", workerHostId);
      const worklet = new LocalWorklet(`worklet-${index}`, workerHostId, [worker(index)]);
      const durableWorklet = new DurableLocalWorklet(
        worklet,
        new FileAttemptJournal(join(directory, `journal-${index}`)),
      );
      durableWorklets.push(durableWorklet);
      connections.push(
        await connectWorklet({
          url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
          credential,
          worklet,
          durableWorklet,
          onError: (error) => errors.push(error),
        }),
      );
    }
    const runtime = runtimes[0];
    requireCondition(runtime, "Missing Control Plane");
    const command = async (name: string, input: Record<string, unknown>) => {
      const response = await fetch(`${runtime.url}/api/v1/coordination/${name}`, {
        method: "POST",
        headers: { Authorization: "Bearer benchmark-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ objectiveId: "benchmark", ...input }),
      });
      const body = await response.json();
      requireCondition(response.ok, `${name}: ${JSON.stringify(body)}`);
      return body;
    };
    const setup = async (mode: string) => {
      const entries: Assignment[] = [];
      for (let index = 0; index < count; index++) {
        const tag = await store.createTag({ name: `${mode}-${index}` });
        const entry: Assignment = {
          taskId: `${mode}-${index}`,
          tagId: tag.id,
          streamId: mode === "burst" ? "burst-shared" : `steady-${index}`,
          attempts: [],
          controlPlaneIds: new Set(),
        };
        entries.push(entry);
        assignments.set(entry.taskId, entry);
      }
      await store.createTeam({
        id: mode,
        objectiveId: "benchmark",
        name: mode,
        leadTagId: owner.id,
        memberTagIds: entries.map((entry) => entry.tagId),
        maxConcurrency: 64,
      });
      // Posts go to Team channels (channel ID = Team ID). The owner publishes, so it leads each
      // channel Team; the waiting Tags are members.
      if (mode === "burst")
        await store.createTeam({
          id: "burst-shared",
          objectiveId: "benchmark",
          name: "Burst shared posts",
          leadTagId: owner.id,
          memberTagIds: entries.map((entry) => entry.tagId),
        });
      for (const entry of entries) {
        if (mode === "steady")
          await store.createTeam({
            id: entry.streamId,
            objectiveId: "benchmark",
            name: entry.streamId,
            leadTagId: owner.id,
            memberTagIds: [entry.tagId],
          });
        await command("assign_task", {
          execution: { profile },
          taskId: entry.taskId,
          teamId: mode,
          assignedTagId: entry.tagId,
          instruction: "Wait for Workstream posts",
          acceptanceCriteria: ["Shared post observed"],
        });
      }
      await waitUntil(
        async () =>
          (await store.listTaskAssignments("benchmark")).filter(
            (task) => task.teamId === mode && task.status === "waiting",
          ).length === count,
        errors,
        `${mode} waits registered`,
      );
      return entries;
    };
    const publish = async (streamId: string, index: number): Promise<Publication> => {
      const requestStart = performance.now();
      await command("post_workstream", {
        workstreamId: streamId,
        body: `Benchmark post ${index}`,
        idempotencyKey: `${streamId}-${index}`,
      });
      return { requestStart, responseAt: performance.now() };
    };
    const steady = await setup("steady");
    const steadyRequest: number[] = [],
      steadyResponse: number[] = [];
    for (const [index, entry] of steady.entries()) {
      const publication = await publish(entry.streamId, index);
      await waitUntil(async () => entry.startedAt !== undefined, errors, `steady resume ${index}`);
      requireCondition(entry.startedAt !== undefined, "Missing resumption timestamp");
      steadyRequest.push(entry.startedAt - publication.requestStart);
      steadyResponse.push(entry.startedAt - publication.responseAt);
    }
    const burst = await setup("burst");
    const burstStart = performance.now();
    const publications = await Promise.all(
      Array.from({ length: 50 }, (_, index) => publish("burst-shared", index)),
    );
    const firstResponse = Math.min(...publications.map((entry) => entry.responseAt));
    await waitUntil(
      async () => burst.every((entry) => entry.startedAt !== undefined),
      errors,
      "burst resumes",
    );
    await waitUntil(
      async () =>
        (await store.listTaskAssignments("benchmark")).every((task) => task.status === "submitted"),
      errors,
      "all attempts settled",
    );
    const tasks = await store.listTaskAssignments("benchmark");
    requireCondition(tasks.length === count * 2, "Unexpected extra assignment");
    for (const entry of assignments.values()) {
      const attempts = await store.listTaskAttempts(entry.taskId);
      requireCondition(
        entry.attempts.length === 2 && new Set(entry.attempts).size === 2 && attempts.length === 2,
        `Duplicate/missing Attempt ${entry.taskId}`,
      );
      requireCondition(
        attempts.every((attempt) => attempt.status === "completed"),
        `Failed Attempt ${entry.taskId}`,
      );
    }
    const history = await store.listWorkstreamPosts("burst-shared", owner.id, { limit: 100 });
    requireCondition(
      history.length === 50 && history.at(-1)?.sequence === 50,
      "Incomplete burst history",
    );
    requireCondition(errors.length === 0, errors.map(String).join("; "));
    const observedControlPlaneInstanceIds = [
      ...new Set([...assignments.values()].flatMap((entry) => [...entry.controlPlaneIds])),
    ];
    requireCondition(
      observedControlPlaneInstanceIds.length === controlPlaneCount,
      "Not every Control Plane claimed work; multi-instance measurement invalid",
    );
    return {
      controlPlaneCount,
      runtimePorts: runtimes.map((entry) => new URL(entry.url).port),
      observedControlPlaneInstanceIds,
      transportProtocol: 11,
      workerSlotsPerControlPlane: 8,
      objectivePollDelayMs: 200,
      pollingNote:
        "200ms delay after each completed Objective scheduling tick; tick duration adds to cadence",
      providerCalls: 0,
      assignments: tasks.length,
      attempts: tasks.length * 2,
      steady: {
        requestStartToExecutionMs: distribution(steadyRequest),
        responseAcknowledgementToExecutionMs: distribution(steadyResponse),
      },
      burst: {
        posts: 50,
        waitingAssignments: count,
        historyCount: history.length,
        firstRequestToExecutionMs: distribution(
          burst.map((entry) => (entry.startedAt ?? 0) - burstStart),
        ),
        firstResponseAcknowledgementToExecutionMs: distribution(
          burst.map((entry) => (entry.startedAt ?? 0) - firstResponse),
        ),
      },
      timingNote:
        "Worker.execute timestamp is recorded before its first await. HTTP response acknowledges persistence but is not the exact database commit timestamp; acknowledgement-relative samples may be negative. Wait registration and admission are outside latency samples. Both Control Planes run in one OS process with separate controllers, HTTP ports and remote Worklets sharing one private database.",
      durationMs: performance.now() - scenarioStart,
    };
  } finally {
    await Promise.allSettled(connections.map((connection) => connection.stop()));
    await Promise.allSettled(
      durableWorklets.map((worklet) => worklet.shutdown("Benchmark cleanup")),
    );
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    await store.disconnect();
    try {
      if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}"`);
    } finally {
      admin.release();
      await adminPool.end();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
async function main() {
  const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
  const { values } = parseArgs({
    args,
    options: { output: { type: "string" }, assignments: { type: "string", default: "32" } },
    strict: true,
  });
  const count = Number(values.assignments);
  requireCondition(
    Number.isInteger(count) && count >= 30 && count <= 50,
    "--assignments must be 30–50",
  );
  const databaseUrl = process.env["SUPERTAG_POSTGRES_URL"];
  requireCondition(databaseUrl, "SUPERTAG_POSTGRES_URL is required");
  requireCondition(values.output, "--output is required");
  const output = resolve(values.output);
  const report = {
    version: 1,
    createdAt: new Date().toISOString(),
    measurements: [] as Array<Awaited<ReturnType<typeof runScenario>>>,
    error: undefined as string | undefined,
  };
  try {
    for (const countControlPlanes of [1, 2])
      report.measurements.push(await runScenario(databaseUrl, countControlPlanes, count));
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${output}\n`);
  }
}
await main();
