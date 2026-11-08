/**
 * Opt-in, subscription-authenticated artifact handoff across fresh native Harness processes: an
 * Objective's conversation delegates a report to one Tag and its use to another with
 * start_session, and the second reads the first's artifact through the catalog.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  type ControlPlaneRuntimeHandle,
  startControlPlaneRuntime,
} from "../apps/cli/src/control-plane-runtime.js";
import type { ResolvedArtifactTransfer } from "../packages/core/src/index.js";
import { ClaudeCodeHarness } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { CodexHarness } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  createWorker,
  LocalExecutionEnvironmentProvider,
  SURFACE_COORDINATION_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  terminalOutputText,
  type Worklet,
  WorkletArtifactStore,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    worker: { type: "boolean" },
    producer: { type: "string" },
    consumer: { type: "string" },
    provider: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.live) throw new Error("Pass --live to permit model-backed subscription usage");
const root = resolve(import.meta.dirname, "..");
const profile = { id: "artifact-handoff-live", revision: "1" };
const HOST = "handoff-host";
const WORKLET = "handoff-worklet";
const WORKER = "handoff-worker";
type Provider = "codex" | "claude-code";
function provider(value: string): Provider {
  assert(value === "codex" || value === "claude-code", "Expected codex or claude-code");
  return value;
}
interface WorkerResult {
  pid: number;
  events: TaskAttemptEvent[];
  nativeSessions: Array<{ harnessId: string; id: string }>;
  runtimeAfter: string[];
}

if (values.worker) {
  const specPath = process.env["SUPERTAG_ARTIFACT_LIVE_SPEC"];
  const source = process.env["SUPERTAG_ARTIFACT_LIVE_SOURCE"];
  const runtime = process.env["SUPERTAG_ARTIFACT_LIVE_RUNTIME"];
  assert(specPath && source && runtime, "Missing child Worker configuration");
  const spec: TaskAttemptSpec = JSON.parse(await readFile(specPath, "utf8"));
  const nativeSessions: WorkerResult["nativeSessions"] = [];
  const options = { workspace: source, timeoutMs: 180_000 };
  const harness =
    provider(values.provider ?? "codex") === "codex"
      ? new CodexHarness({
          ...options,
          executionMode: "app-server",
          model: "gpt-5.6-luna",
          maxNativeAgents: 0,
        })
      : new ClaudeCodeHarness({ ...options, model: "haiku", maxTurns: 15 });
  const start = harness.start.bind(harness);
  // Observe the real execution's public native reference without changing its behavior.
  harness.start = async (...args) => {
    const execution = await start(...args);
    const run = execution.run.bind(execution);
    execution.run = async function* (...runArgs) {
      try {
        yield* run(...runArgs);
      } finally {
        if (execution.session) nativeSessions.push({ ...execution.session });
      }
    };
    return execution;
  };
  const environment = new LocalExecutionEnvironmentProvider({ temporaryDirectory: runtime });
  // Both child Workers run on this machine, one Worker Host, and share its artifact copies.
  // Only metadata reaches the Control Plane; it never receives or serves artifact bytes.
  const catalog = async (attempt: TaskAttemptSpec, operation: string, body: unknown) => {
    if (!attempt.coordination) throw new Error("Artifact metadata requires Attempt authority");
    const response = await fetch(
      new URL(`/internal/v1/artifacts/catalog/${operation}`, attempt.coordination.controlPlaneUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${attempt.coordination.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Artifact catalog ${operation} failed (${response.status})`);
    }
    return response;
  };
  const worker = createWorker({
    id: `live-${harness.id}`,
    outputJournalDirectory: join(runtime, "..", "output-transfers"),
    profiles: [
      {
        ref: profile,
        workerType: "supertag",
        harness: { provider: harness.id },
        execution: { provider: environment.id, lifetime: { scope: "attempt" } },
      },
    ],
    harnesses: [harness],
    environments: [environment],
    artifactStore: (attempt) =>
      new WorkletArtifactStore({
        directory: join(runtime, "..", "artifacts"),
        publish: async ({ ref, sizeBytes }) => {
          await (
            await catalog(attempt, "upload", { digest: ref.digest, sizeBytes })
          ).body?.cancel();
        },
        resolve: async (ref) =>
          (await (
            await catalog(attempt, "resolve-transfer", {
              artifactId: ref.artifactId,
              path: ref.path,
            })
          ).json()) as ResolvedArtifactTransfer,
      }),
  });
  const events: TaskAttemptEvent[] = [];
  for await (const event of worker.execute(spec)) events.push(event);
  process.stdout.write(
    JSON.stringify({
      pid: process.pid,
      events,
      nativeSessions,
      runtimeAfter: await readdir(runtime),
    }),
  );
} else {
  const directory = resolve(values.output ?? `.supertag/artifact-handoff-live/${Date.now()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pairs: Array<[Provider, Provider]> =
    values.producer || values.consumer
      ? [[provider(values.producer ?? "codex"), provider(values.consumer ?? "claude-code")]]
      : [
          ["codex", "claude-code"],
          ["claude-code", "codex"],
        ];
  const reports = [];
  for (const [producer, consumer] of pairs)
    reports.push(await runPair(join(directory, `${producer}-to-${consumer}`), producer, consumer));
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify({ passed: true, reports }, null, 2),
    { mode: 0o600 },
  );
  process.stdout.write(
    `${JSON.stringify({ passed: true, output: directory, reports }, null, 2)}\n`,
  );
}

async function runPair(directory: string, producerProvider: Provider, consumerProvider: Provider) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  const adminToken = randomUUID();
  const objectiveId = `handoff-${randomUUID().slice(0, 8)}`;
  let phase = "setup";
  let runtime: ControlPlaneRuntimeHandle | undefined;
  try {
    // The producer may write files and run commands, so its Worker preserves its outputs. The
    // owner carries the same Role so the Objective may grant those actions to its work Sessions.
    const runtimeSet = await store.createTagPermissionSet({ name: "handoff-runtime" });
    for (const action of ["files:write", "commands:execute"])
      await store.addTagPermission({ permissionSetId: runtimeSet.id, target: "runtime", action });
    const role = await store.createRole({
      name: "Report writer",
      purpose: "Write reports.",
      instructions: "Follow the work Session's instruction.",
      contextSetIds: [],
      permissionSetIds: [runtimeSet.id],
    });
    const owner = await store.createTag({ name: "Handoff supervisor" });
    const producer = await store.createTag({ name: "Report producer" });
    const consumer = await store.createTag({ name: "Report consumer" });
    for (const tag of [owner, producer, consumer]) await store.bindTagWorkerHost(tag.id, HOST);
    for (const tag of [owner, producer]) await store.assignRole({ roleId: role.id, tagId: tag.id });
    await store.createTeam({
      id: randomUUID(),
      name: "Handoff team",
      memberTagIds: [owner.id, producer.id, consumer.id],
    });
    const nonce = randomUUID();
    const value = 1000 + Math.floor(Math.random() * 8000);
    const subject = `Calibration ${randomUUID().slice(0, 8)}`;
    const instructions = {
      producer: `Produce a durable report named calibration-report.md for ${subject}. Its exact source facts are reference code ${nonce} and baseline ${value}. Write those facts plus the calculation rule "adjusted = baseline * 7 + 3" into the report using the managed output directory provided in your execution instructions (SUPERTAG_OUTPUT_DIR). Write the file; do not merely describe it. Do not call capture_artifact: automatic output collection is under test. Do not create memories or other deliverables. Finish with a brief confirmation.`,
      consumer: `Another teammate produced the ${subject} report. Find their report through the available artifact tools, inspect its metadata, and read its contents. You have no local copy. Use find_artifacts, inspect_artifact, and read_artifact; if a search returns no matches, try listing available artifacts. Derive the adjusted value using its calculation rule. Also return a line PRODUCER_SESSION <harnessId> <native id> using the producing native conversation reference in inspected artifact metadata. Return a final line exactly of the form HANDOFF_RESULT <reference code from report> <adjusted integer>. Do not invent missing facts, read arbitrary host files, or create another report.`,
    };
    const specs: Partial<Record<"producer" | "consumer", TaskAttemptSpec>> = {};
    const results: Partial<Record<"producer" | "consumer", WorkerResult>> = {};

    /**
     * The Objective's conversation is deterministic: it delegates the report to the producer, then
     * its review to the consumer once the producer's work Session reported, then completes.
     */
    async function* ownerTurn(spec: TaskAttemptSpec): AsyncIterable<TaskAttemptEvent> {
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId };
      const at = () => new Date().toISOString();
      yield { ...identity, at: at(), type: "execution.started", workerId: WORKER };
      const sessions = (await store.listObjectiveSessions(objectiveId)).filter(
        (session) => session.parentSessionId !== undefined,
      );
      const produced = sessions.find((session) => session.tagId === producer.id);
      const consumed = sessions.find((session) => session.tagId === consumer.id);
      let text = "Waiting for the next report.";
      if (produced === undefined) {
        await coordinate(spec, "start_session", {
          title: "Write the calibration report",
          instruction: instructions.producer,
          tag: producer.name,
        });
        text = "Delegated the report.";
      } else if (consumed === undefined && produced.task?.status === "completed") {
        await coordinate(spec, "start_session", {
          title: "Derive the adjusted value",
          instruction: instructions.consumer,
          tag: consumer.name,
        });
        text = "Delegated the review.";
      } else if (consumed?.task?.status === "completed") {
        await coordinate(spec, "update_objective", {
          status: "completed",
          expectedRevision: (await store.getObjective(objectiveId)).revision,
          completionSummary: "The consumer derived the result from the producer's artifact.",
        });
        text = "Completed the Objective.";
      }
      yield { ...identity, at: at(), type: "output.message", message: { role: "teammate", text } };
      yield {
        ...identity,
        at: at(),
        type: "result",
        result: {
          summary: text,
          decisions: [],
          changes: [],
          unresolved: [],
          findings: [],
          references: [],
          artifacts: [],
        },
      };
      yield { ...identity, at: at(), type: "execution.completed" };
    }

    const worklet: Worklet = {
      id: WORKLET,
      describe: async () => ({
        id: WORKLET,
        protocolVersion: 1,
        host: {
          id: HOST,
          workers: [
            {
              id: WORKER,
              type: "supertag",
              profiles: [profile],
              profileCapabilities: [
                { profile, capabilities: [SURFACE_COORDINATION_CAPABILITY], contextTypes: [] },
              ],
              capabilities: [SURFACE_COORDINATION_CAPABILITY],
              contextTypes: [],
              maxConcurrency: 2,
            },
          ],
        },
      }),
      selectPlacement: async () => ({
        workerHostId: HOST,
        workletId: WORKLET,
        workerId: WORKER,
        workerProfile: profile,
      }),
      async *execute(spec) {
        const task = await store.findTaskById(spec.taskId);
        const session = task && (await store.findSessionById(task.sessionId));
        if (session?.parentSessionId === undefined || session.parentSessionId === null) {
          yield* ownerTurn(spec);
          return;
        }
        const which = spec.tag.id === producer.id ? "producer" : "consumer";
        if (specs[which] !== undefined) throw new Error(`The ${which} ran twice`);
        specs[which] = spec;
        const result = await execute(
          directory,
          which,
          which === "producer" ? producerProvider : consumerProvider,
          spec,
          (next) => {
            phase = next;
          },
        );
        results[which] = result;
        yield* result.events;
      },
    };
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: url,
      adminToken,
      stateDirectory: join(directory, "server"),
      worklet,
    });
    const response = await fetch(new URL("/api/v1/objectives", runtime.url), {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Objective",
        metadata: { name: objectiveId },
        spec: {
          owner: owner.name,
          outcome: "Exchange verified research through durable artifacts",
          team: "Handoff team",
          runtimeActions: ["files:write", "commands:execute"],
        },
      }),
    });
    assert(response.ok, `Applying the Objective failed (${response.status})`);
    await response.body?.cancel();
    const deadline = Date.now() + 600_000;
    while ((await store.getObjective(objectiveId)).status !== "completed") {
      const status = (await store.getObjective(objectiveId)).status;
      assert(status === "working", `The Objective is ${status}`);
      assert(Date.now() < deadline, "The handoff did not complete in 10 minutes");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const producerSpec = specs.producer;
    const consumerSpec = specs.consumer;
    const produced = results.producer;
    const consumed = results.consumer;
    assert(producerSpec && consumerSpec && produced && consumed, "A work Session did not run");
    assert.equal(producerSpec.execution?.outputs, undefined, "Must exercise default output policy");
    const artifacts = (await store.listCapturedArtifacts({ taskId: producerSpec.taskId }))
      .artifacts;
    const report = artifacts.find((artifact) =>
      artifact.entries.some((entry) => entry.path.endsWith("calibration-report.md")),
    );
    assert(report, "Producer report was not automatically captured");
    assert(report.harnessSession, "Report lacks native Harness conversation reference");
    assert(
      produced.nativeSessions.some(
        (session) =>
          session.id === report.harnessSession?.id &&
          session.harnessId === report.harnessSession.harnessId,
      ),
      "Captured native ID does not match real Harness session persistence",
    );
    await assert.rejects(access(join(directory, "producer-source")));
    await assert.rejects(access(join(directory, "producer-runtime")));
    for (const hidden of [nonce, String(value), report.id, report.harnessSession.id])
      assert(
        !JSON.stringify(consumerSpec).includes(hidden),
        "Producer answer/identity leaked into consumer input",
      );
    assert.notEqual(consumed.pid, produced.pid, "Consumer must use a fresh process");
    const expected = `HANDOFF_RESULT ${nonce} ${value * 7 + 3}`;
    assert(
      terminalOutputText(consumed.events).includes(expected),
      "Consumer did not derive exact answer from report",
    );
    assert(
      terminalOutputText(consumed.events).includes(
        `PRODUCER_SESSION ${report.harnessSession.harnessId} ${report.harnessSession.id}`,
      ),
      "Consumer did not recover the producer native session metadata",
    );
    // Claude does not emit portable tool completion events; its exact recovered facts prove
    // retrieval without inventing events.
    if (consumerProvider === "codex")
      for (const operation of ["find_artifacts", "inspect_artifact", "read_artifact"])
        assert(
          consumed.events.some(
            (event) => event.type === "tool.call.completed" && event.call.operation === operation,
          ),
          `Consumer did not complete ${operation}`,
        );
    const result = {
      passed: true,
      producer: producerProvider,
      consumer: consumerProvider,
      producerPid: produced.pid,
      consumerPid: consumed.pid,
      artifactId: report.id,
      harnessSession: report.harnessSession,
      expected,
      defaultOutputPolicy: true,
      producerEnvironmentRemoved: true,
      consumerEvidence:
        consumerProvider === "codex" ? "native-tool-events-and-exact-answer" : "exact-answer",
    };
    await writeFile(join(directory, "report.json"), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    return result;
  } catch (error) {
    await writeFile(
      join(directory, "failure.json"),
      JSON.stringify(
        { passed: false, phase, error: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    await runtime?.close();
    await store.disconnect();
  }
}

/** Calls one coordination tool as the turn; a refusal fails the turn. */
async function coordinate(
  spec: TaskAttemptSpec,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const coordination = spec.coordination;
  assert(coordination, "The Objective's turn has no coordination");
  const response = await fetch(
    new URL("/internal/v1/coordination/mcp", coordination.controlPlaneUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${coordination.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    },
  );
  const body = (await response.json()) as {
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  if (!response.ok || body.result === undefined || body.result.isError)
    throw new Error(`${name} failed: ${body.result?.content?.[0]?.text ?? response.status}`);
}

/** Runs one work Session's Task in a fresh child Worker process and returns what it observed. */
async function execute(
  directory: string,
  which: "producer" | "consumer",
  harness: Provider,
  spec: TaskAttemptSpec,
  enter: (phase: string) => void,
): Promise<WorkerResult> {
  enter(which);
  const source = join(directory, `${which}-source`);
  const runtime = join(directory, `${which}-runtime`);
  await mkdir(source);
  await mkdir(runtime);
  const specPath = join(directory, `${which}-spec.json`);
  await writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUPERTAG_ARTIFACT_LIVE_SPEC: specPath,
    SUPERTAG_ARTIFACT_LIVE_SOURCE: source,
    SUPERTAG_ARTIFACT_LIVE_RUNTIME: runtime,
  };
  for (const key of [
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
  ])
    delete env[key];
  try {
    const child = await promisify(execFile)(
      "pnpm",
      [
        "exec",
        "tsx",
        "--conditions=development",
        import.meta.filename,
        "--live",
        "--worker",
        "--provider",
        harness,
      ],
      { cwd: root, env, timeout: 240_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const result: WorkerResult = JSON.parse(child.stdout);
    // Runtime manifests can contain bearer bindings; keep only observable tool/output evidence.
    const safeEvents = result.events.filter((event) => event.type !== "runtime-inputs.resolved");
    const safe = JSON.stringify({ ...result, events: safeEvents }, null, 2).replaceAll(
      spec.coordination?.token ?? "__no_token__",
      "[REDACTED]",
    );
    await writeFile(join(directory, `${which}-events.json`), safe, { mode: 0o600 });
    assert.equal(
      result.events.at(-1)?.type,
      "execution.completed",
      `${which} failed; inspect ${which}-events.json`,
    );
    for (const entry of result.runtimeAfter) {
      assert(
        entry.startsWith(".supertag-attempt-owners-"),
        `${which} runtime was not disposed: ${entry}`,
      );
      assert.deepEqual(await readdir(join(runtime, entry)), [], "Runtime ownership records remain");
    }
    return result;
  } finally {
    await rm(specPath, { force: true });
    await rm(source, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
}
