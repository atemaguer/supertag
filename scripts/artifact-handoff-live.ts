/** Opt-in, subscription-authenticated artifact handoff across fresh native Harness processes. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { handleArtifactRequest } from "../apps/cli/src/artifact-http.js";
import { handleCoordinationRequest } from "../apps/cli/src/coordination-http.js";
import { ArtifactCatalog, ObjectiveController } from "../packages/control-plane/src/index.js";
import {
  type ResolvedArtifactTransfer,
  TagMessagingError,
  type TaskAssignment,
} from "../packages/core/src/index.js";
import { ClaudeCodeHarness } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { CodexHarness } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  createWorker,
  LocalExecutionEnvironmentProvider,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  terminalOutputText,
  terminalTaskResult,
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
  const callers = new Map<string, TaskAssignment>();
  const requests: Array<{ phase: string; method: string; path: string; status: number }> = [];
  let phase = "setup";
  const authority = new ObjectiveController(store, undefined);
  const catalog = new ArtifactCatalog(store, {
    async authenticateExecution(token) {
      const caller = callers.get(token ?? "");
      if (!caller) throw new TagMessagingError(401, "Unknown live probe Attempt");
      return caller;
    },
    authorizeArtifactSource: authority.authorizeArtifactSource.bind(authority),
    artifactDiscoveryTaskIds: authority.artifactDiscoveryTaskIds.bind(authority),
  });
  const coordination = {
    authenticate: async (token: string | undefined) => {
      const caller = callers.get(token ?? "");
      if (!caller) throw new TagMessagingError(401, "Unknown live probe Attempt");
      return caller;
    },
    // Standalone fixture grants one scope-bound read, not organizational mutation authority.
    coordinationActions: async () => ["read_objective"] as readonly string[],
    commandAsAttempt: async (...args: Parameters<typeof authority.commandAsAttempt>) => {
      const [name, _input, caller] = args;
      if (name !== "read_objective" || "kind" in caller)
        throw new TagMessagingError(403, "Live probe permits only its Objective read");
      return { objective: await store.getObjective(caller.objectiveId, caller.assignedTagId) };
    },
    commandAsAdministrator: authority.commandAsAdministrator.bind(authority),
    readCoordinationInbox: authority.readCoordinationInbox.bind(authority),
    readTeamHistory: authority.readTeamHistory.bind(authority),
    readObjectiveOverview: authority.readObjectiveOverview.bind(authority),
    rebindExecutionCredential: authority.rebindExecutionCredential.bind(authority),
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const requestPhase = phase;
    response.once("finish", () =>
      requests.push({
        phase: requestPhase,
        method: request.method ?? "",
        path,
        status: response.statusCode,
      }),
    );
    if (path.startsWith("/internal/v1/coordination/")) {
      void handleCoordinationRequest(
        request,
        response,
        new URL(path, "http://localhost"),
        coordination,
      );
      return;
    }
    void handleArtifactRequest(request, response, new URL(path, "http://localhost"), catalog);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const controlPlaneUrl = `http://127.0.0.1:${address.port}`;
    const owner = await store.createTag({ name: "Handoff supervisor" });
    const producer = await store.createTag({ name: "Report producer" });
    const consumer = await store.createTag({ name: "Report consumer" });
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "Exchange verified research through durable artifacts",
    });
    const team = await store.createTeam(
      {
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Handoff team",
        leadTagId: owner.id,
        memberTagIds: [producer.id, consumer.id],
        maxConcurrency: 2,
      },
      owner.id,
    );
    const nonce = randomUUID();
    const value = 1000 + Math.floor(Math.random() * 8000);
    const subject = `Calibration ${randomUUID().slice(0, 8)}`;
    const instructions = {
      producer: `Produce a durable report named calibration-report.md for ${subject}. Its exact source facts are reference code ${nonce} and baseline ${value}. Write those facts plus the calculation rule "adjusted = baseline * 7 + 3" into the report using the managed output directory provided in your execution instructions (SUPERTAG_OUTPUT_DIR). Write the file; do not merely describe it. Do not call capture_artifact: automatic output collection is under test. Do not create memories or other deliverables. Finish with a brief confirmation.`,
      consumer: `Another teammate produced the ${subject} report. Find their report through the available artifact tools, inspect its metadata, and read its contents. You have no local copy. Use find_artifacts, inspect_artifact, and read_artifact; if a search returns no matches, try listing available artifacts. Derive the adjusted value using its calculation rule. Also return a line PRODUCER_SESSION <harnessId> <native id> using the producing native conversation reference in inspected artifact metadata. Return a final line exactly of the form HANDOFF_RESULT <reference code from report> <adjusted integer>. Do not invent missing facts, read arbitrary host files, or create another report.`,
    };
    const leases = new Map<string, string>();
    async function assignment(tag: typeof producer, instruction: string): Promise<TaskAttemptSpec> {
      const at = new Date().toISOString();
      const record = await store.admitTaskAssignment({
        taskId: randomUUID(),
        objectiveId: objective.id,
        teamId: team.id,
        assignedTagId: tag.id,
        requestedByTagId: owner.id,
        instruction,
        acceptanceCriteria: ["Use durable artifact handoff"],
        execution: {},
        workspacePlan: { version: 1, status: "none" },
        contextPlan: { version: 7, capturedAt: at, sets: [] },
        authorizationSnapshot: {
          version: 4,
          capturedAt: at,
          tag,
          origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
          requester: { id: owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: tag.id === producer.id ? ["files:write", "commands:execute"] : [],
        },
      });
      const leaseOwner = `live-${record.taskId}`;
      const claimed = await store.claimTaskAssignment({ taskId: record.taskId, leaseOwner });
      assert(claimed);
      leases.set(record.taskId, leaseOwner);
      const attempt = await store.createTaskAttempt({
        taskId: record.taskId,
        attemptNumber: claimed.attemptCount,
        workerProfile: profile,
        workerSnapshot: {},
        startedAt: at,
      });
      const token = randomUUID();
      callers.set(token, claimed);
      const task = await store.findTaskById(record.taskId);
      assert(task);
      return {
        version: 2,
        taskId: task.id,
        attemptId: attempt.id,
        tag,
        authorization: task.authorizationSnapshot,
        contextPlan: task.contextPlan,
        workspacePlan: task.workspacePlan,
        execution: task.execution,
        workerProfile: profile,
        coordination: { controlPlaneUrl, token, objectiveId: objective.id },
        input: {
          origin: {
            surface: "internal",
            accountId: "organization",
            scope: objective.id,
            sessionKey: task.id,
            occurredAt: at,
          },
          messages: [{ id: randomUUID(), role: "requester", text: instruction }],
        },
      };
    }
    async function execute(
      which: "producer" | "consumer",
      harness: Provider,
      spec: TaskAttemptSpec,
    ) {
      phase = which;
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
        const safeEvents = result.events.filter(
          (event) => event.type !== "runtime-inputs.resolved",
        );
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
          assert.deepEqual(
            await readdir(join(runtime, entry)),
            [],
            "Runtime ownership records remain",
          );
        }
        const taskResult = terminalTaskResult(result.events);
        assert(taskResult, "No terminal Task result");
        await store.settleTaskAssignment({
          taskId: spec.taskId,
          leaseOwner: leases.get(spec.taskId) as string,
          attemptCount: 1,
          result: { taskResult },
          terminalAttempt: { id: spec.attemptId, status: "completed" },
        });
        return result;
      } finally {
        await rm(specPath, { force: true });
        await rm(source, { recursive: true, force: true });
        await rm(runtime, { recursive: true, force: true });
      }
    }
    const producerSpec = await assignment(producer, instructions.producer);
    assert.equal(producerSpec.execution?.outputs, undefined, "Must exercise default output policy");
    const produced = await execute("producer", producerProvider, producerSpec);
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
    const consumerSpec = await assignment(consumer, instructions.consumer);
    for (const hidden of [nonce, String(value), report.id, report.harnessSession.id])
      assert(
        !JSON.stringify(consumerSpec).includes(hidden),
        "Producer answer/identity leaked into consumer input",
      );
    const consumed = await execute("consumer", consumerProvider, consumerSpec);
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
    for (const operation of ["find", "inspect", "acquire", "settle"]) {
      assert(
        requests.some(
          (request) =>
            request.phase === "consumer" &&
            request.path === `/internal/v1/artifacts/catalog/${operation}` &&
            request.status === 200,
        ),
        `Consumer never successfully called ${operation}`,
      );
    }
    assert(
      requests.some(
        (request) =>
          request.phase === "producer" &&
          request.path === "/internal/v1/artifacts/catalog/upload" &&
          request.status === 204,
      ),
      "Producer never recorded its host copy with the catalog",
    );
    assert(
      !requests.some((request) => /^\/internal\/v1\/artifacts\/[a-f0-9]{64}$/.test(request.path)),
      "Artifact bytes must stay on the Worker Host, never the Control Plane",
    );
    // Claude does not emit portable tool completion events. Its authenticated HTTP
    // requests above and exact recovered facts prove retrieval without inventing events.
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
        consumerProvider === "codex" ? "http-and-native-tool-events" : "http-and-exact-answer",
      requests,
    };
    await writeFile(join(directory, "report.json"), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    return result;
  } catch (error) {
    await writeFile(
      join(directory, "failure.json"),
      JSON.stringify(
        {
          passed: false,
          phase,
          error: error instanceof Error ? error.message : String(error),
          requests,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.disconnect();
  }
}
