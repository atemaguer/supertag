import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startControlPlaneRuntime } from "../../apps/cli/src/control-plane-runtime.js";
import type { ArtifactSelection } from "../../packages/core/src/index.js";
import {
  CodexHarness,
  type CodexRunner,
  runCodex,
} from "../../packages/runtime/harnesses/codex/src/index.js";
import {
  createWorker,
  DurableLocalWorklet,
  FileArtifactStore,
  FileAttemptJournal,
  LocalExecutionEnvironmentProvider,
  LocalWorklet,
  type Worker,
} from "../../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../../packages/store/src/index.js";
import { harnessRequest } from "./harness-request.js";
import { hostArtifactStore } from "./host-artifact-store.js";
import { evaluateSchedulingArtifact } from "./software-artifact-evaluator.js";
import { enrollWorkerHost } from "./worker-host-enrollment.js";

export interface SoftwareObjectiveDemoOptions {
  outputDirectory: string;
  recovery?: boolean;
  finalResponseDelayMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  mode?: "deterministic" | "real" | "live-handoff";
}
/** Real Control Plane APIs/Worklet transport/Workers/artifacts; scripted model runner by default, explicit paid mode optional. */
export async function runSoftwareObjectiveDemo(options: SoftwareObjectiveDemoOptions) {
  const timeoutMs =
    options.timeoutMs ?? (options.mode && options.mode !== "deterministic" ? 600000 : 30000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
    throw new Error("timeoutMs must be 1000–600000");
  if (
    !Number.isSafeInteger(options.maxAttempts ?? 12) ||
    (options.maxAttempts ?? 12) < 1 ||
    (options.maxAttempts ?? 12) > 12
  )
    throw new Error("maxAttempts must be 1–12");
  const directory = resolve(options.outputDirectory);
  await mkdir(directory, { recursive: true });
  const sourceDirectory = join(directory, "source");
  await mkdir(sourceDirectory, { recursive: true });
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  const connections: Awaited<ReturnType<typeof connectWorklet>>[] = [];
  const failures: unknown[] = [];
  const disruptions: string[] = [];
  const offlineDeliveryEvidence: Array<{
    attemptId: string;
    status: string;
    eventTypes: string[];
  }> = [];
  const durableWorklets: DurableLocalWorklet[] = [];
  const reconnectors = new Map<string, (attemptId: string) => Promise<void>>();
  const reconnecting: Promise<void>[] = [];
  let closing = false;
  let restartControlPlane: (() => Promise<void>) | undefined;
  let implementationDisrupted = false;
  let artifactDisrupted = false;
  const awaitCondition = async (condition: () => Promise<boolean>) => {
    const until = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (closing || Date.now() > until)
        throw new Error("Recovery condition interrupted or timed out");
      await delay(20);
    }
  };
  const runs: Array<{ role: string; workspace: string }> = [];
  const maxAttempts = options.maxAttempts ?? 12;
  const startedAt = Date.now();
  let passed = false;
  let firstFailureAt: number | undefined;
  const checkFailure = async () => {
    const tasks = await store.listTaskAssignments("software-demo");
    const failed = tasks.find((task) => task.status === "failed");
    if (failed) throw new Error(`Task ${failed.taskId} persisted failed status`);
    if (failures.length) {
      firstFailureAt ??= Date.now();
      // Give the executing Worker/Control Plane a short window to persist its failure.
      if (!tasks.some((task) => task.status === "running") || Date.now() - firstFailureAt > 5000)
        throw failures[0];
    }
  };
  try {
    const lead = await store.createTag({
      name: "Coordinator",
    });
    const engineer = await store.createTag({
      name: "Engineer",
    });
    const reviewer = await store.createTag({
      name: "Independent reviewer",
    });
    await store.bindTagWorkerHost(lead.id, "host-lead");
    await store.bindTagWorkerHost(engineer.id, "host-engineer");
    await store.bindTagWorkerHost(reviewer.id, "host-reviewer");
    await store.createObjective({
      id: "software-demo",
      ownerTagId: lead.id,
      outcome: "Implement and independently validate a scheduling overlap function",
      runtimeActions: ["files:write", "commands:execute"],
      budgetLimitMinor: 100,
    });
    const runner = (role: string): CodexRunner =>
      async function* (request, environment, signal) {
        runs.push({ role, workspace: environment.resolvePath(".") });
        if (runs.length > maxAttempts) throw new Error("Demo attempt bound exceeded");
        const inputFile = async (name: string) => {
          const root = join(request.workspace, "inputs");
          const candidates = (await readdir(root, { recursive: true })).filter((path) =>
            path.endsWith(`/${name}`),
          );
          if (candidates.length !== 1)
            throw new Error(`Expected one admitted ${name}, found ${candidates.length}`);
          return join(root, candidates[0] as string);
        };
        let waitingRequested = false;
        try {
          if (options.recovery && role === "engineer" && !implementationDisrupted) {
            implementationDisrupted = true;
            await awaitCondition(
              async () =>
                (await store.getTaskAssignment("software-demo:start"))?.status === "waiting",
            );
            if (!restartControlPlane) throw new Error("Missing restart hook");
            await restartControlPlane();
            disruptions.push("control_plane_restart_coordinator_waiting");
            await restartControlPlane();
            disruptions.push("control_plane_restart_implementation_running");
          }
          if (options.mode === "real" || (options.mode === "live-handoff" && role !== "lead")) {
            const instructions =
              role === "lead"
                ? `You coordinate this bounded demo. Engineer Tag ID ${engineer.id}; independent reviewer Tag ID ${reviewer.id}; your Tag ID ${lead.id}. Use EXACT Team ID delivery; its channel's Workstream ID is also delivery. Create Team delivery with all three members. Perform at most ONE next workflow step per Attempt, then immediately give a short final answer and END YOUR TURN. Do not poll for downstream completion in this Attempt. Control Plane followup Tasks will resume coordination when children submit. If you call wait_for successfully, your NEXT action must be a final text response ending the turn: no more tools, no polling, no repeated wait_for. Use these EXACT unprefixed Task IDs: implementation, review-initial, revision, review-final. Never prepend software-demo: or any other prefix. Delegate at most four assignments: implementation to Engineer, review-initial to reviewer consuming implementation artifact, revision to Engineer consuming implementation and review-initial artifacts, review-final to reviewer consuming revision artifact. Use inputArtifacts [{artifactId,paths}] from read_task result.taskResult.artifacts. OMIT the dependencies field entirely on EVERY review and revision assignment: their source artifacts are already submitted, whereas dependencies wait for acceptance and would deadlock independent review. Do not add acceptance prerequisites, cancel an assigned review, or reuse a cancelled Task ID. Assigned instructions must explain output files and checks. Engineer output is schedule.cjs; reviewer output is review.json. Initial implementation intentionally uses inclusive <= overlap to create an adjacent-boundary defect for independent review. Revision must correct it to strict <. Leave implementation submitted until independent review; reject the defective initial implementation, then assign revision with its immutable inputArtifacts; rejected Task artifacts remain available for repair. Accept revision only after final independent review. Complete Objective with update_objective (including completionSummary and expectedRevision) only after review-final's structured evidence says passed. On initial Attempt create Team delivery and assign implementation, then END TURN. On implementation submission assign review-initial, then END TURN. On review-initial submission record the failed review, reject the original implementation, and assign revision using its retained artifacts, then END TURN. On revision submission assign review-final, then END TURN. On review-final submission accept verified revision and review and complete Objective, then END TURN. On followup inspect Tasks rather than recreating completed assignments. Do not create additional Tags or Teams, run shell, or call external services.`
                : role === "engineer"
                  ? "Produce schedule.cjs exporting a CommonJS function (a,b)=>boolean for appointment overlap. On implementation use inclusive <= comparisons intentionally so the reviewer can demonstrate the adjacency defect. On revision read supplied artifact feedback and fix to strict < comparisons. Imported artifacts retain their filenames under the artifact-specific directories listed in the runtime inputs. Always write schedule.cjs in the attempt workspace; do not merely describe it. You are the assigned engineer, and the running Task entry with your taskId is your own execution. Do not call coordination tools, assign_task, send_message, or delegate to anyone. After writing schedule.cjs, provide a brief final answer and stop. No external services."
                  : "Independently test the supplied CommonJS scheduling function at the admitted schedule.cjs path listed in runtime inputs: adjacent [0,10] and [10,20] must not overlap; [0,10] and [5,15] must overlap. Run the tests locally, then write review.json containing passed:boolean and concrete test evidence. Initial review should find the adjacency bug; final review must verify the correction. Never modify the imported implementation. You are the assigned reviewer; the running Task entry with your taskId is your own execution. Do not call coordination tools, assign_task, send_message, or delegate. After writing review.json, finish with a concise final answer explicitly stating passed:true or passed:false and the concrete test results so the coordinator can read that evidence through read_task. Then stop. No external services.";
            const roleInstructions =
              options.recovery && role === "lead"
                ? instructions
                    .replace(
                      "Perform at most ONE next workflow step per Attempt, then immediately give a short final answer and END YOUR TURN.",
                      "Perform at most ONE next workflow step per Attempt. Every assign_task must include maxCostMinor:10. Set execution.profile.id to demo-engineer for implementation or demo-reviewer for review, with revision 1. After each child assignment immediately call wait_for with submittedTaskIds:[that child taskId].",
                    )
                    .replace(
                      "Control Plane followup Tasks will resume coordination when children submit.",
                      "The SAME coordinator Task resumes when the child submits. Its waitState.wake.taskIds identifies the child to inspect; initial waitState is absent.",
                    )
                    .replace(
                      "If you call wait_for successfully, your NEXT action must be a final text response ending the turn: no more tools, no polling, no repeated wait_for.",
                      "wait_for ends this Attempt automatically; do not call further tools or poll afterward.",
                    )
                    .replace(
                      "On review-final submission accept verified revision and review and complete Objective, then END TURN.",
                      "On review-final submission accept verified revision and review, complete Objective, and finish normally.",
                    )
                    .replaceAll(
                      "then END TURN.",
                      "then call wait_for with submittedTaskIds:[the just-assigned child ID].",
                    )
                    .replace("On followup inspect Tasks", "On each resumed Attempt inspect Tasks")
                : instructions;
            yield* runCodex(
              {
                ...request,
                prompt: `${request.prompt}\n\nDEMO ROLE INSTRUCTIONS:\n${roleInstructions}`,
                timeoutMs: 90000,
              },
              environment,
              signal,
            );
            return;
          }
          const instruction = harnessRequest(request.prompt);
          if (role === "lead") {
            const server = request.mcpServers.find(
              (server) => server.name === "supertag-coordination",
            );
            if (server?.transport !== "mcp-http") throw new Error("Missing coordination MCP");
            const client = new Client({ name: "software-demo", version: "1" });
            await client.connect(
              new StreamableHTTPClientTransport(new URL(server.url), {
                requestInit: { headers: server.headers },
              }) as Parameters<Client["connect"]>[0],
            );
            const call = async (name: string, args: Record<string, unknown>) => {
              const response = await client.callTool({ name, arguments: args });
              if (response.isError) throw new Error(JSON.stringify(response.content));
              return JSON.parse(
                (response.content as Array<{ text?: string }>).find((item) => item.text)?.text ??
                  "null",
              );
            };
            let assignedChild: string | undefined;
            const assign = (
              taskId: string,
              assignedTagId: string,
              inputArtifacts: ArtifactSelection[] = [],
            ) => {
              assignedChild = taskId;
              return call("assign_task", {
                taskId,
                assignedTagId,
                execution: {
                  profile: {
                    id: assignedTagId === engineer.id ? "demo-engineer" : "demo-reviewer",
                    revision: "1",
                  },
                },
                teamId: "delivery",
                workstreamId: "delivery",
                instruction: `DEMO_STEP:${taskId}\nImplement or test appointment overlap; adjacent boundaries must be non-overlapping.`,
                acceptanceCriteria: ["Publish the declared output with evidence"],
                inputArtifacts,
                ...(options.recovery ? { maxCostMinor: 10 } : {}),
              });
            };
            try {
              const update = [...instruction.matchAll(/Task (\S+) is (\w+)/g)].at(-1);
              if (update && update[2] !== "submitted")
                throw new Error(`Child ${update[1]} ended ${update[2]}`);
              const wake = options.recovery
                ? (await store.getTaskAssignment("software-demo:start"))?.waitState?.wake
                : undefined;
              // The lead's own review decisions are never delivered back to it, so every wake
              // reports the one child it waited for.
              if (wake && wake.reason !== "submitted_tasks")
                throw new Error(`Unexpected ${wake.reason} wake for ${wake.taskIds.join(", ")}`);
              const finished = options.recovery ? wake?.taskIds[0] : update?.[1];
              if (!finished) {
                await call("create_team", {
                  id: "delivery",
                  name: "Delivery",
                  leadTagId: lead.id,
                  memberTagIds: [lead.id, engineer.id, reviewer.id],
                  maxConcurrency: 2,
                });
                await assign("implementation", engineer.id);
              } else {
                const task = await call("read_task", { taskId: finished });
                const artifact = task.result?.taskResult?.artifacts?.[0] as
                  | ArtifactSelection
                  | undefined;
                if (!artifact)
                  throw new Error(`Task ${finished} omitted durable artifact evidence`);
                if (finished === "implementation")
                  await assign("review-initial", reviewer.id, [artifact]);
                else if (finished === "review-initial") {
                  await call("update_task", {
                    taskId: finished,
                    expectedStatus: "submitted",
                    status: "accepted",
                    assessment: "Independent defect evidence verified",
                  });
                  const original = await call("read_task", { taskId: "implementation" });
                  await call("update_task", {
                    taskId: "implementation",
                    expectedStatus: "submitted",
                    status: "rejected",
                    assessment: "Independent review reproduced adjacency defect",
                  });
                  await assign("revision", engineer.id, [
                    original.result.taskResult.artifacts[0],
                    artifact,
                  ]);
                } else if (finished === "revision")
                  await assign("review-final", reviewer.id, [artifact]);
                else if (finished === "review-final") {
                  await call("update_task", {
                    taskId: "revision",
                    expectedStatus: "submitted",
                    status: "accepted",
                    assessment: "Independent final review verifies corrected boundaries",
                  });
                  await call("update_task", {
                    taskId: finished,
                    expectedStatus: "submitted",
                    status: "accepted",
                    assessment: "Independent final validation passed",
                  });
                  const objective = await call("read_objective", {});
                  await call("update_objective", {
                    status: "completed",
                    completionSummary:
                      "Independent review verified strict appointment boundaries after revision",
                    expectedRevision: objective.revision,
                  });
                  if (options.finalResponseDelayMs) {
                    for (const name of ["read_objective", "assign_task"]) {
                      let denied = false;
                      try {
                        if (name === "assign_task") await assign("after-completion", engineer.id);
                        else await call(name, {});
                      } catch {
                        denied = true;
                      }
                      if (!denied) throw new Error(`Completed Objective allowed ${name}`);
                    }
                    await delay(options.finalResponseDelayMs, undefined, { signal });
                  }
                }
              }
              if (options.recovery && assignedChild) {
                waitingRequested = true;
                await call("wait_for", { submittedTaskIds: [assignedChild] });
              }
            } finally {
              await client.close();
            }
          } else if (role === "engineer") {
            const revision = instruction.includes("DEMO_STEP:revision");
            if (revision) {
              const feedback = JSON.parse(await environment.read(await inputFile("review.json")));
              if (feedback.passed !== false)
                throw new Error("Revision did not receive independent failure evidence");
            }
            await writeFile(
              join(request.workspace, "schedule.cjs"),
              `module.exports = (a,b) => a.start ${revision ? "<" : "<="} b.end && b.start ${revision ? "<" : "<="} a.end;\n`,
            );
          } else {
            const child = await environment.spawn({
              command: process.execPath,
              args: [
                "-e",
                `const overlap=require(${JSON.stringify(await inputFile("schedule.cjs"))}); const passed=overlap({start:0,end:10},{start:10,end:20})===false && overlap({start:0,end:10},{start:5,end:15})===true; process.stdout.write(JSON.stringify({passed,case:'adjacent appointment boundaries'}));`,
              ],
              cwd: request.workspace,
              timeoutMs: 2000,
            });
            const result = await child.wait();
            if (result.exitCode !== 0) throw new Error(result.stderr);
            const feedback = JSON.parse(result.stdout);
            if (instruction.includes("DEMO_STEP:review-final") && feedback.passed !== true)
              throw new Error("Revision failed independent validation");
            if (instruction.includes("DEMO_STEP:review-initial") && feedback.passed !== false)
              throw new Error("Initial bug was not reproduced");
            await writeFile(join(request.workspace, "review.json"), JSON.stringify(feedback));
          }
          yield {
            type: "output.message",
            text: "Declared output and independent evidence prepared",
          };
        } catch (error) {
          const current =
            role === "lead" ? await store.getTaskAssignment("software-demo:start") : undefined;
          if (
            signal?.aborted &&
            current?.waitState &&
            current.waitState.attemptCount === current.attemptCount &&
            (waitingRequested || options.mode === "real")
          )
            return;
          failures.push(error);
          throw error;
        }
      };
    const start = (port: number) =>
      startControlPlaneRuntime({
        host: "127.0.0.1",
        port,
        databaseUrl,
        workletTransport: "remote",
        adminToken: "demo-admin",
        credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      });
    runtime = await start(0);
    const port = Number(new URL(runtime.url).port);
    restartControlPlane = async () => {
      const prior = await store.getTaskAssignment("implementation");
      await runtime?.close();
      runtime = await start(port);
      await awaitCondition(async () => connections.every((connection) => connection.isConnected));
      if (prior?.status === "running")
        await awaitCondition(async () => {
          const current = await store.getTaskAssignment("implementation");
          return current?.status === "running" && current.leaseOwner !== prior.leaseOwner;
        });
    };
    for (const role of ["lead", "engineer", "reviewer"]) {
      const base = new CodexHarness({
        workspace: sourceDirectory,
        model: "gpt-5.6-luna",
        runner: runner(role),
        outputs:
          role === "lead" ? [] : [{ path: role === "engineer" ? "schedule.cjs" : "review.json" }],
      });
      const baseWorker = createWorker({
        id: `worker-${role}`,
        profiles: [
          {
            ref: { id: `demo-${role}`, revision: "1" },
            workerType: "codex",
            harness: { provider: "codex" },
            execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
          },
        ],
        harnesses: [base],
        environments: [new LocalExecutionEnvironmentProvider()],
        // The three roles share one Worker Host's copies; the Control Plane holds no bytes.
        artifactStore: hostArtifactStore(join(directory, "artifacts")),
        maxConcurrency: 1,
      });
      const worker: Worker = {
        describe: () => baseWorker.describe(),
        ...(baseWorker.control ? { control: baseWorker.control.bind(baseWorker) } : {}),
        ...(baseWorker.controlCapabilities
          ? { controlCapabilities: baseWorker.controlCapabilities.bind(baseWorker) }
          : {}),
        async *execute(spec, signal) {
          for await (const event of baseWorker.execute(spec, signal)) {
            if (
              options.recovery &&
              role === "engineer" &&
              !artifactDisrupted &&
              event.type === "artifact.created"
            ) {
              // Capture now includes an authenticated upload receipt and catalog commit.
              // Disconnect after both are durable but before output events reach the Control Plane.
              const captured = await store.findCapturedArtifact(event.artifact.id);
              if (!captured || captured.attemptId !== spec.attemptId)
                throw new Error("Artifact delivery began without durable catalog provenance");
              artifactDisrupted = true;
              await reconnectors.get(role)?.(spec.attemptId);
              disruptions.push("worklet_disconnect_during_artifact_delivery");
            }
            yield event;
          }
        },
      };
      const local = new LocalWorklet(`worklet-${role}`, `host-${role}`, [worker]);
      const credential = await enrollWorkerHost(runtime.url, "demo-admin", `host-${role}`);
      const durable = new DurableLocalWorklet(
        local,
        new FileAttemptJournal(join(directory, `journal-${role}`)),
      );
      durableWorklets.push(durable);
      const connect = async () => {
        if (!runtime) throw new Error("Missing Control Plane");
        return connectWorklet({
          url: `${runtime.url.replace(/^http/, "ws")}/worklets`,
          credential,
          worklet: local,
          durableWorklet: durable,
          reconnectIntervalMs: 30,
        });
      };
      let connection = await connect();
      connections.push(connection);
      reconnectors.set(role, async (attemptId) => {
        await connection.stop();
        connections.splice(connections.indexOf(connection), 1);
        // Return the saved bytes reference while disconnected. Only reconnect once
        // the durable journal contains terminal output, exercising event replay.
        const replay = (async () => {
          await awaitCondition(
            async () => (await durable?.inspect(attemptId))?.status === "completed",
          );
          const receipt = await durable?.inspect(attemptId);
          const eventTypes: string[] = [];
          if (durable)
            for await (const item of durable.events(attemptId)) eventTypes.push(item.event.type);
          if (
            receipt?.status !== "completed" ||
            !eventTypes.includes("artifact.created") ||
            !eventTypes.includes("result")
          )
            throw new Error("Missing durable output before reconnect");
          offlineDeliveryEvidence.push({ attemptId, status: receipt.status, eventTypes });
          connection = await connect();
          connections.push(connection);
        })();
        reconnecting.push(replay);
        void replay.catch((error) => failures.push(error));
      });
    }
    const response = await fetch(`${runtime.url}/api/v1/coordination/start_objective`, {
      method: "POST",
      headers: { Authorization: "Bearer demo-admin", "Content-Type": "application/json" },
      body: JSON.stringify({
        objectiveId: "software-demo",
        execution: { profile: { id: "demo-lead", revision: "1" } },
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    while ((await store.getObjective("software-demo")).status !== "completed") {
      await checkFailure();
      if (Date.now() - startedAt > timeoutMs) throw new Error("Demo time bound exceeded");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    // Objective completion is a tool call inside the lead's final execution.
    // Wait for that execution to settle and dispose before closing transport.
    while (
      (await store.listTaskAssignments("software-demo")).some(
        (task) => task.status === "running" || task.status === "queued",
      )
    ) {
      await checkFailure();
      if (Date.now() - startedAt > timeoutMs)
        throw new Error("Demo execution drain time bound exceeded");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    // The final running Task may have become failed as the drain condition cleared.
    // Objective completion and valid artifacts do not imply every execution succeeded.
    await checkFailure();
    const tasks = await store.listTaskAssignments("software-demo");
    const consumed = (
      await Promise.all(
        tasks.map(async (task) => {
          const executionTask = await store.findTaskById(task.taskId);
          const refs = executionTask?.trigger["inputArtifacts"];
          return Array.isArray(refs)
            ? refs.map((ref) => ({
                taskId: task.taskId,
                assignedTagId: task.assignedTagId,
                attemptCount: task.attemptCount,
                artifact: ref,
              }))
            : [];
        }),
      )
    ).flat();
    const final = tasks.find((task) => task.taskId === "review-final");
    if (final?.status !== "accepted")
      throw new Error("Incomplete independent review or artifact handoff");
    const artifacts = (
      final.result?.["taskResult"] as { artifacts?: ArtifactSelection[] } | undefined
    )?.artifacts;
    const finalArtifact = artifacts?.[0];
    if (!finalArtifact) throw new Error("Missing final review artifact");
    const finalManifest = await store.findCapturedArtifact(finalArtifact.artifactId);
    const finalEntry = finalManifest?.entries.find(
      (entry) => entry.path === finalArtifact.paths[0],
    );
    if (!finalEntry) throw new Error("Missing final review manifest entry");
    const finalReview = JSON.parse(
      Buffer.from(
        await new FileArtifactStore(join(directory, "artifacts")).get(finalEntry),
      ).toString("utf8"),
    );
    if (finalReview.passed !== true) throw new Error("Persisted independent review did not pass");
    const revision = tasks.find((task) => task.taskId === "revision");
    const revisionArtifact = (
      revision?.result?.["taskResult"] as { artifacts?: ArtifactSelection[] } | undefined
    )?.artifacts?.[0];
    if (!revisionArtifact) throw new Error("Missing revision artifact for machine verification");
    const revisionManifest = await store.findCapturedArtifact(revisionArtifact.artifactId);
    const revisionEntry = revisionManifest?.entries.find(
      (entry) => entry.path === revisionArtifact.paths[0],
    );
    if (!revisionEntry) throw new Error("Missing revision manifest entry");
    const machineVerification = await evaluateSchedulingArtifact(
      new FileArtifactStore(join(directory, "artifacts")),
      { ...revisionEntry, id: revisionArtifact.artifactId },
    );
    await writeFile(
      join(directory, "machine-verification.json"),
      JSON.stringify(machineVerification, null, 2),
    );
    if (!machineVerification.passed)
      throw new Error("Deterministic artifact acceptance failed despite reviewer claim");
    const executionReceipts = [];
    for (const task of tasks)
      for (const attempt of await store.listTaskAttempts(task.taskId)) {
        for (const durable of durableWorklets) {
          const receipt = await durable.inspect(attempt.id);
          if (receipt)
            executionReceipts.push({
              taskId: task.taskId,
              attemptId: attempt.id,
              status: receipt.status,
            });
        }
      }
    const unknownOutcomes = executionReceipts.filter((receipt) => receipt.status === "unknown");
    if (unknownOutcomes.length)
      throw new Error(
        `Execution outcome requires reconciliation: ${JSON.stringify(unknownOutcomes)}`,
      );
    if (options.recovery) {
      const accounting = await store.getObjective("software-demo");
      if (accounting.spentMinor !== 40 || accounting.reservedMinor !== 0)
        throw new Error("Recovery budget accounting must charge four reservations exactly once");
      if (disruptions.length !== 3 || offlineDeliveryEvidence.length !== 1)
        throw new Error("Recovery disruption coverage incomplete");
    }
    passed = true;
    return {
      passed,
      mode: options.mode ?? "deterministic",
      providerCalls: options.mode === "live-handoff" ? 4 : options.mode === "real" ? undefined : 0,
      configuredRealModel: "gpt-5.6-luna",
      attempts: runs.length,
      maxAttempts,
      durationMs: Date.now() - startedAt,
      consumed,
      catalogArtifacts: (await store.listCapturedArtifacts({ objectiveId: "software-demo" }))
        .artifacts,
      reviews: tasks
        .filter((task) => task.status === "accepted" || task.status === "rejected")
        .map((task) => ({
          taskId: task.taskId,
          attemptId: task.result?.["reviewedAttemptId"],
          artifacts: task.result?.["reviewedArtifacts"],
        })),
      disruptions,
      offlineDeliveryEvidence,
      executionReceipts,
      unknownOutcomes,
      accounting: {
        spentMinor: (await store.getObjective("software-demo")).spentMinor,
        reservedMinor: (await store.getObjective("software-demo")).reservedMinor,
      },
      finalArtifact,
      finalReview,
      machineVerification,
      tasks: tasks.map((task) => ({
        id: task.taskId,
        status: task.status,
        assignedTagId: task.assignedTagId,
        attemptCount: task.attemptCount,
      })),
      artifactStore: "worker-host",
    };
  } catch (error) {
    const tasks = await store.listTaskAssignments("software-demo").catch(() => []);
    await writeFile(
      join(directory, "report.json"),
      JSON.stringify(
        {
          passed: false,
          mode: options.mode ?? "deterministic",
          model: "gpt-5.6-luna",
          attempts: runs.length,
          maxAttempts,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          tasks: tasks.map((task) => ({
            id: task.taskId,
            status: task.status,
            assignedTagId: task.assignedTagId,
          })),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    closing = true;
    await Promise.allSettled(reconnecting);
    for (const connection of connections) await connection.stop();
    await runtime?.close();
    for (const durable of durableWorklets) await durable.shutdown("Demo cleanup");
    await store.disconnect();
    const disposed = await Promise.all(
      runs.map(async (run) => {
        try {
          await stat(run.workspace);
          return false;
        } catch {
          return true;
        }
      }),
    );
    await writeFile(
      join(directory, "environment-lifecycle.json"),
      JSON.stringify({ passed, runs, environmentOutputsRemoved: disposed }, null, 2),
    );
  }
}
