import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import type { ArtifactSelection, ResolvedArtifactTransfer } from "../packages/core/src/index.js";
import { ClaudeCodeHarness } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { CodexHarness } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  createWorker,
  DurableLocalWorklet,
  FileArtifactStore,
  FileAttemptJournal,
  LocalExecutionEnvironmentProvider,
  LocalWorklet,
  type TaskAttemptSpec,
  type Worker,
  WorkletArtifactStore,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { evaluateSchedulingArtifact } from "../tests/support/software-artifact-evaluator.js";
import { enrollWorkerHost } from "../tests/support/worker-host-enrollment.js";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    harness: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.live)
  throw new Error("Explicit --live required; uses the selected CLI subscription authentication");
const harness = values.harness ?? "codex";
if (harness !== "codex" && harness !== "claude-code")
  throw new Error("harness must be codex or claude-code");
const directory = resolve(values.output ?? `.supertag/combined-live/${Date.now()}`);
try {
  await stat(join(directory, "state.db"));
  throw new Error("Choose a fresh output directory; existing test state will not be overwritten");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await mkdir(directory, { recursive: true });
const source = join(directory, "source");
await mkdir(source, { recursive: true });
const databaseUrl = `file:${join(directory, "state.db")}`;
await migrateDatabase({ url: databaseUrl });
const store = new DrizzleStore({ url: databaseUrl });
await store.connect();
// Every role runs on this machine, one Worker Host, and shares its artifact copies. The Control
// Plane records only metadata, so results are read from these host copies.
const artifactStore = new FileArtifactStore(join(directory, "artifacts"));
const hostArtifacts = (spec: TaskAttemptSpec) => {
  if (!spec.coordination) throw new Error("Missing Control Plane artifact capability");
  const { controlPlaneUrl } = spec.coordination;
  let token = spec.coordination.token;
  const request = (path: string, credential: string, body: unknown) =>
    fetch(new URL(path, controlPlaneUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
    });
  // Metadata writes are idempotent, so retry transient failures. A Control Plane restart
  // re-leases the Attempt, so exchange the earlier credential once, as ArtifactClient does.
  const catalog = async (operation: string, body: unknown): Promise<Response> => {
    let rebound = false;
    for (let attempt = 0; ; attempt++) {
      const used = token;
      const response = await request(
        `/internal/v1/artifacts/catalog/${operation}`,
        used,
        body,
      ).catch((error: unknown) => {
        if (attempt >= 3) throw error;
        return undefined;
      });
      if (response?.ok) return response;
      await response?.body?.cancel();
      if (response?.status === 401 && !rebound) {
        rebound = true;
        if (token === used) {
          const rebind = await request("/internal/v1/coordination/rebind", used, {});
          if (!rebind.ok) throw new Error(`Artifact authority rebind failed (${rebind.status})`);
          token = ((await rebind.json()) as { token: string }).token;
        }
        continue;
      }
      if (response && (![502, 503, 504].includes(response.status) || attempt >= 3))
        throw new Error(`Artifact catalog ${operation} failed (${response.status})`);
      await delay(250 * 2 ** attempt);
    }
  };
  return new WorkletArtifactStore({
    copies: artifactStore,
    publish: async ({ ref, sizeBytes }) => {
      await (await catalog("upload", { digest: ref.digest, sizeBytes })).body?.cancel();
    },
    resolve: async (ref) =>
      (await (
        await catalog("resolve-transfer", { artifactId: ref.artifactId, path: ref.path })
      ).json()) as ResolvedArtifactTransfer,
  });
};
const started = Date.now();
const maxAttempts = 20;
const timeoutMs = 900000;
const adminToken = randomUUID();
const assertions: string[] = [];
const executions: Array<{
  taskId: string;
  attemptId: string;
  role: string;
  startedAt: string;
  endedAt?: string | undefined;
  eventTypes: string[];
  usage: unknown[];
  output: string[];
}> = [];
const disruptions: unknown[] = [];
const connections: Awaited<ReturnType<typeof connectWorklet>>[] = [];
const durables: DurableLocalWorklet[] = [];
let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
let active = 0;
let peakActive = 0;
let restart: Promise<void> | undefined;
let failure: string | undefined;
let machineVerification: unknown;
let initialVerification: unknown;
let finalReview: unknown;
let invoiceMachineVerification: unknown;
let invoiceReview: unknown;
let closing = false;
const poll = async (condition: () => Promise<boolean>, label: string) => {
  while (!(await condition())) {
    if (closing || Date.now() - started > timeoutMs) throw new Error(`Bound exceeded: ${label}`);
    await delay(50);
  }
};
const saveProgress = async () =>
  writeFile(
    join(directory, "progress.json"),
    JSON.stringify({ executions, assertions, disruptions, peakActive }, null, 2),
    { mode: 0o600 },
  );
const start = (port: number) =>
  startControlPlaneRuntime({
    host: "127.0.0.1",
    port,
    databaseUrl,
    workletTransport: "remote",
    adminToken,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
  });
const admin = async (action: string, input: Record<string, unknown>) => {
  const response = await fetch(`${runtime?.url}/api/v1/coordination/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
};
const tasks = async () => [
  ...(await store.listTaskAssignments("invoicing")),
  ...(await store.listTaskAssignments("refunds")),
];
try {
  const ownerA = await store.createTag({ name: "Invoice governing owner" });
  const ownerB = await store.createTag({ name: "Refund requesting owner" });
  const engineer = await store.createTag({ name: "Payments implementation manager" });
  const reviewer = await store.createTag({ name: "Independent review manager" });
  for (const [id, owner, outcome] of [
    ["invoicing", ownerA, "Invoice scheduling next week"],
    ["refunds", ownerB, "Repair active duplicate refund scheduling today"],
  ] as const)
    await store.createObjective({
      id,
      ownerTagId: owner.id,
      outcome,
      runtimeActions: ["files:read", "files:write", "commands:execute"],
    });
  await store.createTeam({
    id: "payments",
    objectiveId: "invoicing",
    objectiveIds: ["refunds"],
    name: "Shared Payments",
    leadTagId: ownerA.id,
    memberTagIds: [ownerB.id, engineer.id, reviewer.id],
    maxConcurrency: 1,
  });
  await store.setTagMessagingGrant({
    senderTagId: ownerB.id,
    recipientTagId: ownerA.id,
    messageTypes: ["message"],
  });
  runtime = await start(0);
  const port = Number(new URL(runtime.url).port);
  const connectRole = async (role: "manager" | "engineer" | "reviewer") => {
    const outputs =
      role === "manager" ? [] : [{ path: role === "engineer" ? "schedule.cjs" : "review.json" }];
    const harnessAdapter =
      harness === "claude-code"
        ? new ClaudeCodeHarness({
            workspace: source,
            model: "haiku",
            maxTurns: 12,
            timeoutMs: 120000,
            outputs,
          })
        : new CodexHarness({
            workspace: source,
            model: "gpt-5.6-luna",
            timeoutMs: 120000,
            outputs,
          });
    const base = createWorker({
      id: `combined-${role}`,
      profiles: [
        {
          ref: { id: `combined-${role}`, revision: "1" },
          workerType: harness,
          harness: { provider: harness },
          execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
        },
      ],
      harnesses: [harnessAdapter],
      environments: [new LocalExecutionEnvironmentProvider()],
      artifactStore: hostArtifacts,
      maxConcurrency: 1,
    });
    const worker: Worker = {
      ...base,
      describe: () => base.describe(),
      async *execute(spec: TaskAttemptSpec) {
        if (executions.length >= maxAttempts) throw new Error("Attempt budget exhausted");
        const entry = {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          role,
          startedAt: new Date().toISOString(),
          eventTypes: [] as string[],
          usage: [] as unknown[],
          output: [] as string[],
          endedAt: undefined as string | undefined,
        };
        executions.push(entry);
        active++;
        peakActive = Math.max(peakActive, active);
        await saveProgress();
        try {
          for await (const event of base.execute(spec)) {
            entry.eventTypes.push(event.type);
            if (spec.taskId === "refund-work" && !restart && event.type === "output.message")
              restart = (async () => {
                const before = await store.getTaskAssignment(spec.taskId);
                assert.equal(before?.status, "running");
                await runtime?.close();
                runtime = await start(port);
                await poll(
                  async () => connections.every((c) => c.isConnected),
                  "Worklet reconnection",
                );
                await poll(async () => {
                  const after = await store.getTaskAssignment(spec.taskId);
                  return after?.status === "running" && after.leaseOwner !== before?.leaseOwner;
                }, "recovered lease");
                const after = await store.getTaskAssignment(spec.taskId);
                disruptions.push({
                  kind: "control_plane_restart_live_refund",
                  taskId: spec.taskId,
                  attemptId: spec.attemptId,
                  beforeLease: before?.leaseOwner,
                  afterLease: after?.leaseOwner,
                  attemptCount: after?.attemptCount,
                  trigger: { type: event.type, at: event.at, text: event.message.text },
                  recoveredAt: new Date().toISOString(),
                });
                await saveProgress();
              })();

            if (spec.taskId === "refund-work" && restart && event.type === "output.message")
              await restart;
            if (event.type === "output.message") entry.output.push(event.message.text);
            if (event.type.includes("usage")) entry.usage.push(event);
            yield event;
          }
        } finally {
          active--;
          entry.endedAt = new Date().toISOString();
          await saveProgress();
        }
      },
    };
    const local = new LocalWorklet(`combined-${role}`, `host-${role}`, [worker]);
    const credential = await enrollWorkerHost(runtime?.url ?? "", adminToken, `host-${role}`);
    const durable = new DurableLocalWorklet(
      local,
      new FileAttemptJournal(join(directory, `journal-${role}`)),
    );
    durables.push(durable);
    connections.push(
      await connectWorklet({
        url: `${runtime?.url.replace(/^http/u, "ws")}/worklets`,
        credential,
        worklet: local,
        durableWorklet: durable,
        reconnectIntervalMs: 50,
      }),
    );
  };
  const assign = async (
    taskId: string,
    objectiveId: string,
    tagId: string,
    role: string,
    instruction: string,
    inputArtifacts?: ArtifactSelection[],
  ) =>
    admin("assign_task", {
      taskId,
      objectiveId,
      teamId: "payments",
      assignedTagId: tagId,
      instruction: `${instruction}\n\nBOUNDED LIVE TEST: Follow only this Task's admitted instruction. No autonomous additional assignments, no polling, no subagents, no external services. Use production coordination MCP tools when required. Read relevant current state before mutations, use actual current revisions. Finish immediately after the requested operation(s). Do not act on other Tasks unless named by your instruction.`,
      acceptanceCriteria: ["Follow bounded instruction and persist evidence"],
      execution: { profile: { id: `combined-${role}`, revision: "1" } },
      ...(inputArtifacts
        ? { inputArtifacts: inputArtifacts.map(({ artifactId, paths }) => ({ artifactId, paths })) }
        : {}),
    });
  const submitted = async (taskId: string) => {
    await poll(async () => {
      const task = await store.getTaskAssignment(taskId);
      if (task?.status === "failed") throw new Error(`Task failed: ${taskId}`);
      return task?.status === "submitted";
    }, `${taskId} submission`);
    await saveProgress();
    const task = await store.getTaskAssignment(taskId);
    assert.ok(task);
    return task;
  };
  const manager = async (id: string, objectiveId: string, tagId: string, prompt: string) => {
    await assign(id, objectiveId, tagId, "manager", prompt);
    return submitted(id);
  };
  const artifact = async (taskId: string) => {
    const task = await store.getTaskAssignment(taskId);
    const ref = (task?.result?.["taskResult"] as { artifacts?: ArtifactSelection[] } | undefined)
      ?.artifacts?.[0];
    assert.ok(ref, `${taskId} artifact missing`);
    const manifest = await store.findCapturedArtifact(ref.artifactId);
    const entry = manifest?.entries.find((candidate) => candidate.path === ref.paths[0]);
    assert.ok(entry, `${taskId} artifact manifest missing`);
    return { ...entry, ...ref, id: ref.artifactId };
  };
  await connectRole("manager");
  // Both work items are admitted and eligible together. Their implementation profile is
  // intentionally offline until independent priority negotiation finishes.
  await assign(
    "invoice-work",
    "invoicing",
    engineer.id,
    "engineer",
    "Write schedule.cjs exporting (a,b)=>a.start < b.end && b.start < a.end as CommonJS. This is routine invoice work due next week. Do not call coordination tools. Finish.",
  );
  await assign(
    "refund-work",
    "refunds",
    engineer.id,
    "engineer",
    "First send a brief progress message that you are starting the assigned implementation, before using tools. Then write schedule.cjs exporting CommonJS (a,b)=>a.start <= b.end && b.start <= a.end. Intentionally retain this inclusive-boundary defect as the controlled faulty initial submission for independent review. Do not call coordination tools. Finish.",
  );
  await manager(
    "priority-request",
    "refunds",
    ownerB.id,
    "Read_task refund-work. Send_message to recipientTeamId payments with type message, idempotencyKey priority-refund-work, and a body that requests urgent priority for refund-work because active duplicate refunds affect customers today while invoice work is due next week. Do not update the Task yourself.",
  );
  assert.equal((await store.getTaskAssignment("refund-work"))?.priority, "normal");
  assert.ok(
    (await store.listTagMessages(ownerA.id)).some(
      (message) => message.idempotencyKey === "priority-refund-work",
    ),
  );
  assertions.push("Live priority request reaches the Team lead without mutating the Task");
  await manager(
    "priority-decision",
    "refunds",
    ownerA.id,
    "Read_mailbox and read_task refund-work. Independently assess the priority request. If the message confirms active duplicate refunds affect customers today while invoice work is due next week, update_task refund-work from expectedStatus queued to priority urgent. Do not alter any other work.",
  );
  assert.equal((await store.getTaskAssignment("refund-work"))?.priority, "urgent");
  assert.equal((await store.getTaskAssignment("invoice-work"))?.status, "queued");
  assertions.push(
    "Independent live governing owner accepts priority while both competing jobs remain queued",
  );
  await connectRole("engineer");
  await submitted("refund-work");
  await restart;
  await submitted("invoice-work");
  assert.deepEqual(
    executions.filter((e) => e.role === "engineer").map((e) => e.taskId),
    ["refund-work", "invoice-work"],
  );
  assert.equal(peakActive, 1);
  assert.equal(disruptions.length, 1);
  assert.equal((await store.listTaskAttempts("refund-work")).length, 1);
  assertions.push(
    "Production scheduling starts urgent refund before earlier invoice admission with one shared execution at a time",
    "Control Plane restarts during live implementation and recovers the same Attempt with a new lease before artifact submission",
  );
  await connectRole("reviewer");
  const initial = await artifact("refund-work");
  initialVerification = await evaluateSchedulingArtifact(artifactStore, initial);
  assert.equal((initialVerification as { passed: boolean }).passed, false);
  assert.equal(
    (initialVerification as { checks: Array<{ name: string; passed: boolean }> }).checks.find(
      (c) => c.name === "adjacent",
    )?.passed,
    false,
  );
  await assign(
    "review-initial",
    "refunds",
    reviewer.id,
    "reviewer",
    "Independently execute imported CommonJS the admitted schedule.cjs path in runtime inputs for adjacent [0,10]/[10,20] (must false) and partial [0,10]/[5,15] (must true). Do not modify input. Write review.json with passed boolean and concrete actual results. Final text state passed:false or passed:true and evidence. Do not call coordination tools.",
    [{ artifactId: initial.artifactId, paths: initial.paths }],
  );
  await submitted("review-initial");
  const initialReview = JSON.parse(
    Buffer.from(await artifactStore.get(await artifact("review-initial"))).toString(),
  );
  assert.equal(initialReview.passed, false);
  await manager(
    "reject-initial",
    "refunds",
    ownerB.id,
    "Read_task refund-work and review-initial. Use the independent review evidence to update_task refund-work from expectedStatus submitted to status rejected with a concrete assessment. Do not accept defective output or assign new work.",
  );
  assert.equal((await store.getTaskAssignment("refund-work"))?.status, "rejected");
  assertions.push(
    "Independent live reviewer rejects seeded defect and live owner persists rejection",
  );
  await assign(
    "revision",
    "refunds",
    engineer.id,
    "engineer",
    "Read rejected implementation the admitted schedule.cjs path in runtime inputs and independent review the admitted review.json path in runtime inputs. Repair adjacent-boundary bug to strict < comparisons. Write corrected schedule.cjs CommonJS function. Do not call coordination tools.",
    [{ artifactId: initial.artifactId, paths: initial.paths }, await artifact("review-initial")],
  );
  await submitted("revision");
  const revision = await artifact("revision");
  assert.ok(revision.digest);
  await assign(
    "review-final",
    "refunds",
    reviewer.id,
    "reviewer",
    "Independently execute imported corrected CommonJS the admitted schedule.cjs path in runtime inputs for adjacent [0,10]/[10,20] (must false) and partial [0,10]/[5,15] (must true). Do not modify input. Write review.json with passed boolean and concrete actual results. Final text state passed:false or passed:true and evidence. Do not call coordination tools.",
    [{ artifactId: revision.artifactId, paths: revision.paths }],
  );
  await submitted("review-final");
  finalReview = JSON.parse(
    Buffer.from(await artifactStore.get(await artifact("review-final"))).toString(),
  );
  assert.equal((finalReview as { passed: boolean }).passed, true);
  machineVerification = await evaluateSchedulingArtifact(artifactStore, revision);
  assert.equal((machineVerification as { passed: boolean }).passed, true);
  await manager(
    "accept-revision",
    "refunds",
    ownerB.id,
    "Read_task revision and review-final. If the independent review passes, update_task revision from expectedStatus submitted to status accepted with an evidence-based assessment, then update_task review-final from expectedStatus submitted to status accepted with an evidence-based assessment. Otherwise reject them. Do not assign work.",
  );
  assert.equal((await store.getTaskAssignment("revision"))?.status, "accepted");
  assertions.push(
    "Live repair consumes immutable rejected artifact and review; independent live review and ten machine checks pass before live owner accepts",
  );
  await manager(
    "knowledge-share",
    "refunds",
    ownerB.id,
    `Read_task revision and review-final. Send_message to recipientTeamId payments with type message, idempotencyKey knowledge-policy-r17, and a body asking the Team lead to adopt this reviewed rule into Team context: POLICY-R17: Adjacent scheduling intervals do not overlap; use strict less-than comparisons. Include sourceTaskId revision, reviewTaskId review-final, artifact URI ${revision.uri}, and digest ${revision.digest}. Do not update Team context yourself.`,
  );
  await manager(
    "knowledge-adoption",
    "refunds",
    ownerA.id,
    "Read_mailbox, read_task revision, read_task review-final, and read_team payments. Verify the exact source Task and independent review are accepted. Then update_team payments with its current expectedRevision and a complete context object containing policyId POLICY-R17, the strict less-than boundary rule, sourceTaskId revision, reviewTaskId review-final, the exact artifact URI and digest from the message. Do not substitute another Task as the source.",
  );
  const adoptedTeam = await store.getTeam("payments");
  assert.equal(adoptedTeam.context["policyId"], "POLICY-R17");
  assert.equal(adoptedTeam.context["digest"], revision.digest);
  await manager(
    "knowledge-reuse",
    "invoicing",
    ownerA.id,
    "Read_team payments. Explain how its durable context applies to invoice-work, citing the exact policy identifier and source digest in your final response. Do not mutate anything.",
  );
  assert.ok(
    executions
      .find((e) => e.taskId === "knowledge-reuse")
      ?.output.join(" ")
      .includes("POLICY-R17"),
  );
  assert.ok(
    executions
      .find((e) => e.taskId === "knowledge-reuse")
      ?.output.join(" ")
      .includes(revision.digest),
  );
  assertions.push(
    "A reviewed artifact reference is adopted into durable Team context and cited by another Objective",
  );
  await manager(
    "transfer-request",
    "refunds",
    ownerB.id,
    "Read_team payments. Send_message to recipientTeamId payments with type message, idempotencyKey governance-payments-refunds, and a body requesting that refunds become the governing Objective while invoicing remains linked. Do not update the Team yourself.",
  );
  assert.equal((await store.getTeam("payments")).objectiveId, "invoicing");
  await manager(
    "transfer-decision",
    "refunds",
    ownerA.id,
    "Read_mailbox and read_team payments. If the governance request says invoicing must remain linked, update_team payments with its current expectedRevision and governingObjectiveId refunds. Preserve all existing fields and context.",
  );
  const team = await store.getTeam("payments");
  assert.equal(team.objectiveId, "refunds");
  assert.ok(team.objectiveIds.includes("invoicing"));
  assertions.push("Bilateral live governance transfer preserves other Objective linkage");
  await assign(
    "invoice-review",
    "invoicing",
    reviewer.id,
    "reviewer",
    "Independently execute the admitted schedule.cjs path in runtime inputs appointment overlap function: adjacent [0,10]/[10,20] false, partial [0,10]/[5,15] true. Write review.json passed boolean and concrete results. Do not modify imported artifact or call coordination tools.",
    [await artifact("invoice-work")],
  );
  await submitted("invoice-review");
  invoiceReview = JSON.parse(
    Buffer.from(await artifactStore.get(await artifact("invoice-review"))).toString(),
  );
  assert.equal((invoiceReview as { passed: boolean }).passed, true);
  invoiceMachineVerification = await evaluateSchedulingArtifact(
    artifactStore,
    await artifact("invoice-work"),
  );
  assert.equal((invoiceMachineVerification as { passed: boolean }).passed, true);
  await manager(
    "complete-invoicing",
    "invoicing",
    ownerA.id,
    "Read_task invoice-work and invoice-review. If independent review passes, update_task each from expectedStatus submitted to status accepted with concrete assessments. Read_objective and update_objective status completed using current expectedRevision and completionSummary explaining accepted invoice evidence. After successful update_objective immediately finish with a final answer; no more tools. Do not touch refund Objective or create work.",
  );
  await manager(
    "complete-refunds",
    "refunds",
    ownerB.id,
    "Read_task revision and review-final and read_objective. Verify both are accepted with passing independent evidence, then update_objective status completed using current expectedRevision and completionSummary explaining defect rejection, accepted repair and completed shared Team handover. After successful update_objective immediately finish with a final answer; no more tools. Do not create work.",
  );
  assert.equal((await store.getTaskAssignment("invoice-work"))?.status, "accepted");
  assert.equal((await store.getObjective("invoicing")).status, "completed");
  assert.equal((await store.getObjective("refunds")).status, "completed");
  assertions.push(
    "Both Objectives complete through live owner decisions after independent accepted artifact evidence",
  );
  assert.equal(peakActive, 1);
  assert.ok(
    (await tasks()).every((t) => !["queued", "running", "waiting", "failed"].includes(t.status)),
  );
  assertions.push(
    "Bilateral live governance transfer preserves other Objective linkage and Team concurrency remains one throughout",
  );
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  closing = true;
  await restart?.catch((error) => {
    failure ??= String(error);
    process.exitCode = 1;
  });
  const allTasks = await tasks().catch(() => []);
  const report = {
    status: failure ? "failed" : "passed",
    failure,
    elapsedMs: Date.now() - started,
    mode: `live ${harness} CLI through production Control Plane coordination API and durable remote Worklets`,
    harness,
    maxAttempts,
    timeoutMs,
    cumulativeTokenLimit: null,
    assertions,
    executions,
    disruptions,
    peakActive,
    initialVerification,
    machineVerification,
    finalReview,
    invoiceReview,
    invoiceMachineVerification,
    objectives: await Promise.all(
      ["invoicing", "refunds"].map((id) => store.getObjective(id).catch(() => null)),
    ),
    team: await store.getTeam("payments").catch(() => null),
    tasks: allTasks,
    attempts: await Promise.all(
      allTasks.map(async (t) => ({
        taskId: t.taskId,
        attempts: (await store.listTaskAttempts(t.taskId)).map((a) => ({
          id: a.id,
          taskId: a.taskId,
          attemptNumber: a.attemptNumber,
          status: a.status,
          startedAt: a.startedAt,
          endedAt: a.endedAt,
        })),
      })),
    ),
    limitations: [
      "Fixture creates organization and orchestrates bounded phases and Task admission; this is an integration exercise, not autonomous discovery or strategy",
      "Initial inclusive-boundary defect is deliberately instructed",
      "Worker profile held offline until live priority decision; both work Tasks eligible before connection",
      "Knowledge reuse is live reading and citation of durable Team context with reviewed artifact provenance",
      "Priority and governance negotiation are ordinary Mailbox messages followed by canonical resource updates",
      "Control Plane runtime is stopped/recreated in same test process, same DB/port/vault; Worklet execution remains running",
    ],
  };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  for (const connection of connections) await connection.stop();
  await runtime?.close();
  for (const durable of durables) await durable.shutdown("Combined test cleanup");
  await store.disconnect();
  process.stdout.write(
    `${JSON.stringify(
      {
        status: report.status,
        failure,
        assertions,
        attempts: executions.length,
        report: join(directory, "report.json"),
      },
      null,
      2,
    )}\n`,
  );
}
