import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startControlPlaneRuntime } from "../../apps/cli/src/control-plane-runtime.js";
import type { Tag, TaskAssignment } from "../../packages/core/src/index.js";
import {
  type CodexRunner,
  createCodexWorker,
} from "../../packages/runtime/harnesses/codex/src/index.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
} from "../../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../../packages/store/src/index.js";
import { harnessRequest } from "./harness-request.js";
import { enrollWorkerHost } from "./worker-host-enrollment.js";

export interface ObjectiveSimulationOptions {
  /** Total logical Tags, including one lead. */
  readonly agents?: number;
  readonly seed?: number;
  /** Leaf Worker Hosts, in addition to the dedicated lead host. */
  readonly hosts?: number;
  readonly concurrency?: number;
  readonly outputDirectory: string;
  readonly processMode?: "simulated" | "local";
  readonly timeoutMs?: number;
  readonly onProgress?: (message: string) => void;
}
export interface SimulationInvariant {
  readonly passed: boolean;
  readonly detail: string;
}
export interface ObjectiveSimulationReport {
  readonly version: 1;
  readonly passed: boolean;
  readonly seed: number;
  readonly workloadDigest: string;
  readonly agentsRegistered: number;
  readonly agentsExecuted: number;
  readonly configuredExecutionSlots: number;
  readonly peakConcurrency: number;
  readonly peakByWorker: Readonly<Record<string, number>>;
  readonly peakByTeam: Readonly<Record<string, number>>;
  readonly tasksByStatus: Readonly<Record<string, number>>;
  readonly taskCount: number;
  readonly approvals: number;
  readonly restarts: number;
  readonly injectedFailures: number;
  readonly staleCredentialRejected: boolean;
  readonly providerCalls: 0;
  readonly localProcesses: number;
  readonly duplicateAdmissions: number;
  readonly durationMs: number;
  readonly shutdownMs: number;
  readonly memoryBytes: { startRss: number; peakRss: number; endRss: number; peakHeapUsed: number };
  /** Leaf admission-to-runner observation includes approvals, dependencies, capacity and MCP setup. */
  readonly admissionToStartMs: { samples: number; p50: number; p95: number; max: number };
  readonly budget: { limit: number; charged: number; reserved: number };
  readonly invariants: Readonly<Record<string, SimulationInvariant>>;
  readonly error?: string;
}
interface TraceEvent {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly type: string;
  readonly task?: string;
  readonly worker?: string;
  readonly team?: string;
  readonly detail?: string;
}
interface Outcome {
  readonly status: string;
  readonly attempts: number;
}

/** Scripted decisions and workload, real Control Plane API/WebSocket/Worker/Harness/environment lifecycle. */
export async function runObjectiveSimulation(
  options: ObjectiveSimulationOptions,
): Promise<ObjectiveSimulationReport> {
  const agents = integer(options.agents ?? 100, 20, 1000, "agents");
  const seed = integer(options.seed ?? 42, 0, 2147483647, "seed");
  const hosts = integer(options.hosts ?? 3, 1, 32, "hosts");
  const concurrency = integer(options.concurrency ?? 4, 1, 100, "concurrency");
  const processMode = options.processMode ?? "simulated";
  if (!["simulated", "local"].includes(processMode)) throw new Error("Unknown processMode");
  const started = performance.now();
  const timeoutMs = integer(
    options.timeoutMs ?? Math.max(90000, agents * 500),
    1,
    3600000,
    "timeoutMs",
  );
  const deadline = started + timeoutMs;
  await mkdir(options.outputDirectory, { recursive: true });
  const workspace = join(options.outputDirectory, "workspace");
  await mkdir(workspace, { recursive: true });
  const runId = randomUUID();
  const objectiveId = `simulation-${runId}`;
  const databaseUrl = `file:${join(options.outputDirectory, "state.db")}`;
  const leafCount = agents - 1;
  const failing = new Set([1 + (seed % (leafCount - 4)), 1 + ((seed + 17) % (leafCount - 4))]);
  const cancellationIndex = leafCount;
  const plan = Array.from({ length: leafCount }, (_, i) => ({
    index: i + 1,
    team: Math.floor(i / 10),
    fail: failing.has(i + 1),
    cancel: i + 1 === cancellationIndex,
    delayMs: 40 + ((seed * 31 + i * 17) % 80),
    dependency: i >= 10 && i + 1 !== cancellationIndex ? 1 : null,
  }));
  // Keep the shared dependency successful for every seed.
  failing.delete(1);
  for (const item of plan) if (item.index === 1) item.fail = false;
  const workloadDigest = createHash("sha256")
    .update(JSON.stringify({ agents, seed, hosts, concurrency, processMode, plan }))
    .digest("hex");
  await writeFile(
    join(options.outputDirectory, "manifest.json"),
    JSON.stringify(
      { version: 1, runId, agents, seed, hosts, concurrency, processMode, workloadDigest, plan },
      null,
      2,
    ),
    { flag: "wx" },
  );
  const trace: TraceEvent[] = [];
  const emit = (type: string, fields: Omit<TraceEvent, "sequence" | "elapsedMs" | "type"> = {}) =>
    trace.push({
      sequence: trace.length + 1,
      elapsedMs: Math.round(performance.now() - started),
      type,
      ...fields,
    });
  const progress = (message: string) => {
    emit("phase", { detail: message });
    options.onProgress?.(message);
  };
  const invariant: Record<string, SimulationInvariant> = {};
  const assert = (name: string, condition: boolean, detail: string) => {
    invariant[name] = { passed: condition, detail };
    if (!condition) throw new Error(`${name}: ${detail}`);
  };
  const activeWorkers = new Map<string, number>(),
    peakWorkers: Record<string, number> = {},
    activeTeams = new Map<string, number>(),
    peakTeams: Record<string, number> = {};
  const executed = new Set<string>();
  const teamCapacityViolations: string[] = [];
  let dependencyChecks = 0;
  let active = 0,
    peak = 0,
    approvals = 0,
    restarts = 0,
    injectedFailures = 0,
    localProcesses = 0,
    duplicates = 0;
  let cancellationStarted = false,
    cancellationReleased = false,
    cancelledToken = "",
    cancelledServer = "",
    staleCredentialRejected = false;
  const unexpected: string[] = [];
  const failedOriginals = new Set<number>();
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  let connections: Array<Awaited<ReturnType<typeof connectWorklet>>> = [];
  const durableWorklets = new Map<LocalWorklet, DurableLocalWorklet>();
  const store = new DrizzleStore({ url: databaseUrl });
  let connected = false;
  let registered = 0;
  let finalTasks: readonly TaskAssignment[] = [];
  let finalBudget = { limit: agents * 5, charged: 0, reserved: 0 };
  let failure: string | undefined;
  const taskId = (i: number) => `${objectiveId}:agent-${i}`;
  const retryId = (i: number) => `${taskId(i)}:replacement`;
  const teamId = (i: number) => `${objectiveId}:team-${Math.floor((i - 1) / 10)}`;
  const outcomes: Record<string, Outcome> = {};
  const managerialActivations: Record<string, Outcome> = {};
  const initialMemory = process.memoryUsage();
  let peakRss = initialMemory.rss,
    peakHeapUsed = initialMemory.heapUsed,
    shutdownMs = 0;
  const waits: number[] = [];
  const sampleMemory = () => {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
  };
  const sampler = setInterval(sampleMemory, 100).unref();
  try {
    await migrateDatabase({ url: databaseUrl });
    await store.connect();
    connected = true;
    const leader = await store.createTag({
      name: `${runId}-lead`,
    });
    await store.bindTagWorkerHost(leader.id, "simulation-lead-host");
    registered++;
    const leaves: Tag[] = [];
    for (let i = 1; i <= leafCount; i++) {
      const leaf = await store.createTag({ name: `${runId}-agent-${i}` });
      await store.bindTagWorkerHost(leaf.id, `simulation-host-${(i - 1) % hosts}`);
      leaves.push(leaf);
      registered++;
    }
    await store.createObjective({
      id: objectiveId,
      ownerTagId: leader.id,
      outcome: "Validate a product with a simulated Team with changing membership and capacity",
      budgetLimitMinor: agents * 5,
      runtimeActions: processMode === "local" ? ["commands:execute"] : [],
    });
    const makeRunner = (workerId: string, lead: boolean): CodexRunner =>
      async function* (request, environment, signal) {
        const server = request.mcpServers.find((s) => s.name === "supertag-coordination");
        if (server?.transport !== "mcp-http") throw new Error("Coordination input missing");
        if (!["127.0.0.1", "localhost"].includes(new URL(server.url).hostname))
          throw new Error("Simulation only permits loopback Control Plane connections");
        // Shared context contains other Tasks' instructions; script only this request.
        const instruction = harnessRequest(request.prompt);
        const marker = /SIM_LEAF:(\d+):(primary|replacement)/u.exec(instruction);
        const index = lead ? 0 : Number(marker?.[1]);
        if (!lead && !Number.isInteger(index)) throw new Error("Missing scripted agent marker");
        // An owner that ends without completing its Objective, with nothing else active, is
        // asked for a verdict. That can happen as soon as the last contribution is accepted.
        const assessment =
          lead && instruction.startsWith("Your last activation ended, but this Objective is still");
        const alias = lead
          ? assessment
            ? "lead-assessment"
            : instruction.includes("A delegated Task changed state")
              ? "lead-followup"
              : "lead-start"
          : `agent-${index}:${marker?.[2]}`;
        const team = lead ? "leadership" : `team-${Math.floor((index - 1) / 10)}`;
        executed.add(lead ? leader.id : (leaves[index - 1]?.id ?? "missing"));
        active++;
        peak = Math.max(peak, active);
        activeWorkers.set(workerId, (activeWorkers.get(workerId) ?? 0) + 1);
        peakWorkers[workerId] = Math.max(
          peakWorkers[workerId] ?? 0,
          activeWorkers.get(workerId) ?? 0,
        );
        activeTeams.set(team, (activeTeams.get(team) ?? 0) + 1);
        peakTeams[team] = Math.max(peakTeams[team] ?? 0, activeTeams.get(team) ?? 0);
        emit("execution.started", { task: alias, worker: workerId, team });
        const client = new Client({ name: "supertag-deterministic-simulation", version: "1" });
        const call = async (
          name: string,
          args: Record<string, unknown>,
          expectError = false,
        ): Promise<Record<string, unknown>> => {
          const callStarted = performance.now();
          const reply = await client.callTool({ name, arguments: args });
          const elapsed = Math.round(performance.now() - callStarted);
          if (elapsed >= 100)
            emit("coordination.slow-call", { task: alias, detail: `${name}: ${elapsed}ms` });
          const blocks = reply.content as Array<{ type: string; text?: string }>;
          const text = blocks.find((b) => b.type === "text")?.text ?? "{}";
          if (expectError) {
            if (!reply.isError || !text.includes("Objective budget exhausted"))
              throw new Error(`Expected ${name} to reject exhausted budget, received: ${text}`);
            return {};
          }
          if (reply.isError) throw new Error(`${name}: ${text}`);
          return JSON.parse(text) as Record<string, unknown>;
        };
        try {
          // MCP SDK's concrete transport declares sessionId as string | undefined,
          // while its Transport interface uses an exact optional string.
          await client.connect(
            new StreamableHTTPClientTransport(new URL(server.url), {
              requestInit: { headers: server.headers },
            }) as Parameters<Client["connect"]>[0],
          );
          if (lead) {
            // Results that arrive while a lead activation is open are delivered to it.
            const delivered = (
              JSON.parse(
                /"deliveries":(\[.*?\]),"deliveryGuidance"/su.exec(request.prompt)?.[1] ?? "[]",
              ) as Array<{ kind: string; taskId?: string }>
            ).flatMap((item) => (item.kind === "task" && item.taskId ? [item.taskId] : []));
            if (assessment && !delivered.length) {
              // Every contribution must already be accepted; anything else means work was
              // stranded. The Objective stays working so the run can check that Task completion
              // never completes it, so the scripted owner records no verdict.
              const tasks = await store.listTaskAssignments(objectiveId);
              const unfinished = plan
                .map((item) =>
                  item.fail || item.cancel ? retryId(item.index) : taskId(item.index),
                )
                .filter((id) => tasks.find((t) => t.taskId === id)?.status !== "accepted");
              if (unfinished.length)
                throw new Error(
                  `Assessment found unaccepted contributions: ${unfinished.join(", ")}`,
                );
            } else if (
              !instruction.includes("A delegated Task changed state") &&
              !delivered.length
            ) {
              for (let offset = 0; offset < leafCount; offset += 10) {
                const members = leaves.slice(offset, offset + 10).map((t) => t.id);
                await call("create_team", {
                  id: teamId(offset + 1),
                  name: `Team ${offset / 10}`,
                  leadTagId: leader.id,
                  memberTagIds: members,
                  maxConcurrency: Math.max(2, concurrency),
                });
              }
              for (const item of plan) {
                const input = {
                  taskId: taskId(item.index),
                  teamId: teamId(item.index),
                  workstreamId: teamId(item.index),
                  execution: { profile: { id: "simulation-leaf", revision: "1" } },
                  assignedTagId: leaves[item.index - 1]?.id,
                  instruction: `SIM_LEAF:${item.index}:primary`,
                  acceptanceCriteria: [`Evidence from agent ${item.index}`],
                  ...(item.dependency === null ? {} : { dependencies: [taskId(item.dependency)] }),
                  maxCostMinor: 1,
                };
                await call("assign_task", { ...input, requiresApproval: true });
                if (item.index % 10 === 0) {
                  await call("assign_task", { ...input, requiresApproval: true });
                  duplicates++;
                }
              }
              for (let i = 0; i < 3; i++)
                await call("assign_task", {
                  taskId: `${objectiveId}:obsolete-${i}`,
                  teamId: teamId(1),
                  execution: { profile: { id: "simulation-leaf", revision: "1" } },
                  assignedTagId: leaves[0]?.id,
                  instruction: `Obsolete campaign ${i}`,
                  acceptanceCriteria: ["Original strategy"],
                  maxCostMinor: 1,
                  requiresApproval: true,
                });
              await call(
                "assign_task",
                {
                  taskId: `${objectiveId}:over-budget`,
                  teamId: teamId(1),
                  execution: { profile: { id: "simulation-leaf", revision: "1" } },
                  assignedTagId: leaves[0]?.id,
                  instruction: "Must never execute",
                  acceptanceCriteria: ["Rejected"],
                  maxCostMinor: agents * 5 + 1,
                },
                true,
              );
              emit("team.formed", {
                detail: `${agents} Tags, ${Math.ceil(leafCount / 10)} Teams`,
              });
            } else {
              // Parent responsibility can contain older follow-up text. Only the final
              // contiguous result list belongs to this activation's admitted batch.
              const currentBatch =
                /((?:\nTask \S+ is \w+\.)+) Use read_task to inspect each full result\.$/u.exec(
                  instruction,
                )?.[1] ?? instruction;
              const ids = [
                ...new Set([
                  ...(instruction.includes("A delegated Task changed state")
                    ? [...currentBatch.matchAll(/\nTask (\S+) is /gu)].map((match) => match[1])
                    : []),
                  ...delivered,
                ]),
              ];
              if (!ids.length) throw new Error("Missing durable followup sources");
              await Promise.all(
                ids.map(async (id) => {
                  if (!id) throw new Error("Missing durable followup source");
                  const result = await call("read_task", { taskId: id });
                  const original = /agent-(\d+)(:replacement)?$/u.exec(id);
                  if (result["status"] === "submitted") {
                    const evidence = result["result"] as { text?: unknown } | undefined;
                    if (!original || evidence?.text !== `evidence-${Number(original[1])}`)
                      throw new Error(`Unexpected evidence for ${id}: ${JSON.stringify(evidence)}`);
                    await call("update_task", {
                      taskId: id,
                      expectedStatus: "submitted",
                      status: "accepted",
                      assessment:
                        "Deterministic evidence matches the scripted acceptance criterion",
                    });
                    if (id === taskId(1)) {
                      for (let i = 0; i < 3; i++)
                        await call("update_task", {
                          taskId: `${objectiveId}:obsolete-${i}`,
                          expectedStatus: "queued",
                          status: "cancelled",
                        });
                      const current = await call("read_team", { teamId: teamId(1) });
                      await call("update_team", {
                        teamId: current["id"],
                        expectedRevision: current["revision"],
                        maxConcurrency: Math.max(2, concurrency) + 1,
                      });
                      emit("team.updated");
                    }
                  } else if (
                    original &&
                    !original[2] &&
                    ["failed", "cancelled"].includes(String(result["status"]))
                  ) {
                    const number = Number(original[1]);
                    await call("assign_task", {
                      taskId: retryId(number),
                      teamId: teamId(number),
                      workstreamId: teamId(number),
                      execution: { profile: { id: "simulation-leaf", revision: "1" } },
                      assignedTagId: leaves[number - 1]?.id,
                      instruction: `SIM_LEAF:${number}:replacement`,
                      acceptanceCriteria: [`Replacement evidence from agent ${number}`],
                      maxCostMinor: 1,
                    });
                    emit("assignment.replaced", { task: `agent-${number}` });
                  }
                }),
              );
            }
            yield { type: "output.message", text: "Coordination changes recorded" };
          } else {
            const item = plan[index - 1];
            if (!item) throw new Error("Agent outside simulation plan");
            const isPrimary = marker?.[2] === "primary";
            const assignment = await store.getTaskAssignment(
              isPrimary ? taskId(index) : retryId(index),
            );
            if (!assignment) throw new Error(`Missing admitted assignment for ${alias}`);
            waits.push(Math.max(0, Date.now() - Date.parse(assignment.createdAt)));
            const liveTeam = await store.getTeam(teamId(index));
            const observedTeamActive = activeTeams.get(team) ?? 0;
            if (liveTeam.maxConcurrency !== null && observedTeamActive > liveTeam.maxConcurrency)
              teamCapacityViolations.push(
                `${team}: ${observedTeamActive}/${liveTeam.maxConcurrency}`,
              );
            if (isPrimary && item.dependency !== null) {
              if ((await store.getTaskAssignment(taskId(item.dependency)))?.status !== "accepted")
                throw new Error(`Dependency not accepted before ${alias}`);
              dependencyChecks++;
            }
            if (index === cancellationIndex && isPrimary) {
              cancelledToken = server.headers["Authorization"] ?? "";
              cancelledServer = server.url;
              cancellationStarted = true;
              emit("fault.late-result-barrier", { task: alias });
              // Deliberately ignore abort until released: exercise rejection of a late result.
              while (!cancellationReleased) {
                if (performance.now() > deadline) throw new Error("Cancellation barrier timed out");
                await delay(10);
              }
              yield { type: "output.message", text: "STALE RESULT MUST NOT BE ACCEPTED" };
              return;
            }
            await delay(item.delayMs, signal);
            if (item.fail && isPrimary) {
              injectedFailures++;
              failedOriginals.add(index);
              emit("fault.injected-failure", { task: alias });
              throw new Error(`SIMULATED_FAILURE agent-${index}`);
            }
            if (processMode === "local") {
              const probe = await environment.spawn(
                {
                  command: process.execPath,
                  args: ["-e", `process.stdout.write('evidence-${index}')`],
                  timeoutMs: 10000,
                },
                signal,
              );
              const output = await probe.wait();
              localProcesses++;
              if (output.exitCode !== 0) throw new Error("Local probe failed");
              yield { type: "output.message", text: output.stdout };
            } else yield { type: "output.message", text: `evidence-${index}` };
          }
        } catch (error) {
          emit("execution.error", { task: alias, detail: String(error) });
          throw error;
        } finally {
          await client.close();
          active--;
          activeWorkers.set(workerId, (activeWorkers.get(workerId) ?? 1) - 1);
          activeTeams.set(team, (activeTeams.get(team) ?? 1) - 1);
          emit("execution.ended", { task: alias, worker: workerId, team });
        }
      };
    const worklets = [
      new LocalWorklet("simulation-lead-host", "simulation-lead-host", [
        createCodexWorker({
          workspace,
          workerId: "lead-worker",
          profileId: "simulation-lead",
          maxConcurrency: 1,
          runner: makeRunner("lead-worker", true),
        }),
      ]),
    ];
    for (let h = 0; h < hosts; h++)
      worklets.push(
        new LocalWorklet(`simulation-host-${h}`, `simulation-host-${h}`, [
          createCodexWorker({
            workspace,
            workerId: `worker-${h}`,
            profileId: "simulation-leaf",
            maxConcurrency: concurrency,
            runner: makeRunner(`worker-${h}`, false),
          }),
        ]),
      );
    for (const worklet of worklets)
      durableWorklets.set(
        worklet,
        new DurableLocalWorklet(
          worklet,
          new FileAttemptJournal(join(options.outputDirectory, `journal-${worklet.id}`)),
        ),
      );
    const workerHostCredentials = new Map<string, string>();
    const boot = async () => {
      runtime = await startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl,
        workletTransport: "remote",
        adminToken: "simulation-admin-only",
        credentialVault: new FileGatewayCredentialVault(
          join(options.outputDirectory, "vault.json"),
        ),
      });
      connections = [];
      for (const worklet of worklets) {
        const descriptor = await worklet.describe();
        let credential = workerHostCredentials.get(descriptor.host.id);
        if (credential === undefined) {
          credential = await enrollWorkerHost(
            runtime.url,
            "simulation-admin-only",
            descriptor.host.id,
          );
          workerHostCredentials.set(descriptor.host.id, credential);
        }
        const durableWorklet = durableWorklets.get(worklet);
        if (!durableWorklet) throw new Error("Missing simulation journal");
        connections.push(
          await connectWorklet({
            url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
            credential,
            worklet,
            durableWorklet,
          }),
        );
      }
    };
    const admin = async (command: string, args: Record<string, unknown>) => {
      const response = await fetch(`${runtime?.url}/api/v1/coordination/${command}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer simulation-admin-only",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ objectiveId, ...args }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${command} HTTP ${response.status}: ${text}`);
      return JSON.parse(text) as Record<string, unknown>;
    };
    const waitFor = async (predicate: () => Promise<boolean>, label: string) => {
      while (!(await predicate())) {
        if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
        await delay(40);
      }
    };
    progress(
      `Starting ${agents} logical agents on ${hosts + 1} Worker Hosts (${1 + hosts * concurrency} execution slots)`,
    );
    await boot();
    await admin("start_objective", {
      execution: { profile: { id: "simulation-lead", revision: "1" } },
    });
    await waitFor(
      // The owner's start activation closes itself as accepted when its Attempt settles.
      async () => (await store.getTaskAssignment(`${objectiveId}:start`))?.status === "accepted",
      "Team setup",
    );
    const before = await store.listTaskAssignments(objectiveId);
    assert(
      "formation",
      before.length === leafCount + 4,
      `${before.length} Tasks; expected ${leafCount + 4} (including lead and obsolete work)`,
    );
    assert(
      "approvalGate",
      before
        .filter((t) => t.taskId !== `${objectiveId}:start`)
        .every((t) => t.approval === "pending" && t.attemptCount === 0),
      "No assignment ran before human approval",
    );
    progress("Restarting the Control Plane with all agent assignments awaiting approval");
    for (const connection of connections) await connection.stop();
    connections = [];
    await runtime?.close();
    runtime = undefined;
    await boot();
    restarts++;
    emit("control_plane.restarted");
    assert(
      "restartPreservesQueue",
      (await store.listTaskAssignments(objectiveId)).length === before.length,
      "Durable assignment count unchanged",
    );
    for (let start = 1; start <= leafCount; start += 16)
      await Promise.all(
        Array.from({ length: Math.min(16, leafCount - start + 1) }, (_, j) =>
          admin("update_task", {
            taskId: taskId(start + j),
            expectedStatus: "queued",
            approval: "approved",
          }).then(() => {
            approvals++;
          }),
        ),
      );
    progress("Running agent work, injected failures, cancellation and autonomous reassignment");
    await waitFor(async () => cancellationStarted, "cancel target starts");
    await admin("update_task", {
      taskId: taskId(cancellationIndex),
      expectedStatus: "running",
      status: "cancelled",
    });
    emit("fault.cancelled-running", { task: `agent-${cancellationIndex}` });
    const denied = await fetch(cancelledServer, {
      method: "POST",
      headers: { Authorization: cancelledToken, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    staleCredentialRejected = denied.status === 401;
    cancellationReleased = true;
    await waitFor(async () => {
      const tasks = await store.listTaskAssignments(objectiveId);
      for (const item of plan) {
        const target = item.fail || item.cancel ? retryId(item.index) : taskId(item.index);
        if (tasks.find((t) => t.taskId === target)?.status !== "accepted") return false;
      }
      return (
        tasks.every(
          (t) =>
            !["queued", "running", "submitted"].includes(t.status) || t.assignedTagId === leader.id,
        ) &&
        // Owner root activations close themselves as accepted; none may be left open.
        tasks.filter((t) => t.assignedTagId === leader.id).every((t) => t.status === "accepted") &&
        !(await store.listTaskAssignmentFollowups()).some((t) => t.objectiveId === objectiveId)
      );
    }, "all contributions accepted and all lead followups settled");
    finalTasks = await store.listTaskAssignments(objectiveId);
    const objective = await store.getObjective(objectiveId);
    finalBudget = {
      limit: objective.budgetLimitMinor ?? 0,
      charged: objective.spentMinor,
      reserved: objective.reservedMinor,
    };
    for (const task of finalTasks) {
      // Batch membership depends on completion timing, while each contribution's
      // outcome must remain deterministic. Preserve both, compare them separately.
      const destination =
        task.assignedTagId === leader.id && task.taskId !== `${objectiveId}:start`
          ? managerialActivations
          : outcomes;
      destination[task.taskId.replace(`${objectiveId}:`, "")] = {
        status: task.status,
        attempts: task.attemptCount,
      };
    }
    assert(
      "allAgentsExecuted",
      executed.size === agents,
      `${executed.size}/${agents} distinct Tags executed`,
    );
    assert(
      "allContributionsAccepted",
      finalTasks.filter((t) => t.assignedTagId !== leader.id && t.status === "accepted").length ===
        leafCount,
      `${leafCount} accepted agent contributions`,
    );
    assert(
      "workerCapacity",
      Object.entries(peakWorkers).every(([id, n]) => n <= (id === "lead-worker" ? 1 : concurrency)),
      JSON.stringify(peakWorkers),
    );
    assert(
      "globalCapacity",
      peak <= 1 + hosts * concurrency,
      `Observed ${peak}; configured ${1 + hosts * concurrency}`,
    );
    assert(
      "teamCapacity",
      teamCapacityViolations.length === 0,
      teamCapacityViolations.length
        ? teamCapacityViolations.join("; ")
        : "Every observed Team execution stayed within its current capacity",
    );
    assert(
      "dependenciesAcceptedBeforeExecution",
      dependencyChecks === plan.filter((item) => item.dependency !== null).length,
      `${dependencyChecks} dependent executions checked before work`,
    );
    assert(
      "faultsRecovered",
      injectedFailures === failing.size && failedOriginals.size === failing.size,
      `${injectedFailures} failures were explicitly replaced`,
    );
    assert(
      "staleCredentialRejected",
      staleCredentialRejected,
      "Canceled attempt credential returned 401",
    );
    assert(
      "lateResultFenced",
      (await store.getTaskAssignment(taskId(cancellationIndex)))?.status === "cancelled" &&
        !(await store.getTaskAssignment(taskId(cancellationIndex)))?.result,
      "Late result did not change canceled assignment",
    );
    assert(
      "obsoleteNeverRan",
      finalTasks.filter((t) => /:obsolete-[0-2]$/u.test(t.taskId)).length === 3 &&
        finalTasks
          .filter((t) => /:obsolete-[0-2]$/u.test(t.taskId))
          .every((t) => t.status === "cancelled" && t.attemptCount === 0),
      "Three obsolete assignments canceled before execution",
    );
    assert(
      "budgetReconciled",
      finalBudget.reserved === 0 &&
        finalBudget.charged === leafCount + failing.size + 1 &&
        finalBudget.charged <= finalBudget.limit,
      JSON.stringify(finalBudget),
    );
    const revisedTeam = await store.getTeam(teamId(1));
    assert(
      "capacityReallocated",
      revisedTeam.maxConcurrency === Math.max(2, concurrency) + 1 &&
        trace.some((event) => event.type === "team.updated"),
      "Lead applied the intended capacity change",
    );
    assert(
      "duplicateAdmissionIdempotent",
      duplicates === Math.floor(leafCount / 10) &&
        finalTasks.filter((task) => /:agent-\d+$/u.test(task.taskId)).length === leafCount,
      `${duplicates} duplicate requests produced no extra original assignments`,
    );
    assert(
      "budgetRejectionLeftNoTask",
      !(await store.getTaskAssignment(`${objectiveId}:over-budget`)),
      "Rejected budget reservation created no assignment",
    );
    assert(
      "localProcessEvidence",
      localProcesses === (processMode === "local" ? leafCount : 0),
      `${localProcesses} local evidence probes`,
    );
    // Attempt counters include claims rejected before a Worklet accepts execution (for
    // example, capacity still reserved for remote cleanup). Those safe admission retries
    // must not be mistaken for replaying work. Check actual starts and the independent
    // Harness trace instead; repeated manager followups have distinct assignment IDs. A lead
    // activation legitimately starts again for results delivered to it while it ran.
    const executionStarts = await Promise.all(
      finalTasks
        .filter((task) => task.assignedTagId !== leader.id)
        .map(async (task) => ({
          taskId: task.taskId,
          count: (await store.listTaskEvents(task.taskId)).filter(
            (event) => event.type === "execution.started",
          ).length,
        })),
    );
    const leafStarts = new Map<string, number>();
    for (const event of trace) {
      if (event.type !== "execution.started" || !event.task?.startsWith("agent-")) continue;
      leafStarts.set(event.task, (leafStarts.get(event.task) ?? 0) + 1);
    }
    const repeated = executionStarts.filter((entry) => entry.count > 1);
    const repeatedRunners = [...leafStarts].filter(([, count]) => count > 1);
    assert(
      "singleExecution",
      repeated.length === 0 && repeatedRunners.length === 0,
      repeated.length || repeatedRunners.length
        ? `Repeated execution starts: ${JSON.stringify({ assignments: repeated, runners: repeatedRunners })}`
        : "No assignment or leaf Harness executed twice; rejected admission claims are not executions",
    );
    assert(
      "noStrandedWork",
      finalTasks.every((t) => !["queued", "running"].includes(t.status)),
      "No queued/running Tasks remain",
    );
    assert(
      "objectiveNotImplicitlyComplete",
      objective.status === "working",
      "Task completion did not silently complete Objective",
    );
    progress(
      `Simulation passed: ${agents} agents, peak ${peak} executions, ${finalTasks.length} durable Tasks`,
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    emit("simulation.failed", { detail: failure });
  } finally {
    const shutdownStarted = performance.now();
    cancellationReleased = true;
    for (const connection of connections)
      await connection.stop().catch((error) => unexpected.push(String(error)));
    await runtime?.close().catch((error) => unexpected.push(String(error)));
    for (const durable of durableWorklets.values())
      await durable.shutdown("Simulation cleanup").catch((error) => unexpected.push(String(error)));
    if (connected) {
      finalTasks = await store.listTaskAssignments(objectiveId).catch(() => finalTasks);
      await store.disconnect().catch((error) => unexpected.push(String(error)));
    }
    shutdownMs = Math.round(performance.now() - shutdownStarted);
    sampleMemory();
    clearInterval(sampler);
  }
  if (unexpected.length && !failure) failure = `Cleanup errors: ${unexpected.join("; ")}`;
  const tasksByStatus: Record<string, number> = {};
  for (const task of finalTasks) tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
  waits.sort((a, b) => a - b);
  const report: ObjectiveSimulationReport = {
    version: 1,
    passed: failure === undefined && Object.values(invariant).every((i) => i.passed),
    seed,
    workloadDigest,
    agentsRegistered: registered,
    agentsExecuted: executed.size,
    configuredExecutionSlots: 1 + hosts * concurrency,
    peakConcurrency: peak,
    peakByWorker: peakWorkers,
    peakByTeam: peakTeams,
    tasksByStatus,
    taskCount: finalTasks.length,
    approvals,
    restarts,
    injectedFailures,
    staleCredentialRejected,
    providerCalls: 0,
    localProcesses,
    duplicateAdmissions: duplicates,
    durationMs: Math.round(performance.now() - started),
    shutdownMs,
    memoryBytes: {
      startRss: initialMemory.rss,
      peakRss,
      endRss: process.memoryUsage().rss,
      peakHeapUsed,
    },
    admissionToStartMs: {
      samples: waits.length,
      p50: waits[Math.floor(waits.length * 0.5)] ?? 0,
      p95: waits[Math.min(waits.length - 1, Math.floor(waits.length * 0.95))] ?? 0,
      max: waits.at(-1) ?? 0,
    },
    budget: finalBudget,
    invariants: invariant,
    ...(failure ? { error: failure } : {}),
  };
  await writeFile(join(options.outputDirectory, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(
    join(options.outputDirectory, "managerial-activations.json"),
    JSON.stringify(managerialActivations, null, 2),
  );
  await writeFile(
    join(options.outputDirectory, "outcomes.json"),
    JSON.stringify(outcomes, null, 2),
  );
  await writeFile(
    join(options.outputDirectory, "events.jsonl"),
    `${trace.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return report;
}
function integer(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be ${min}–${max}`);
  return value;
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
