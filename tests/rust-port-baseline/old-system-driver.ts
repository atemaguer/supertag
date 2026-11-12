/** Test-only adapter for the frozen TypeScript system; it is not a compatibility API. */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ControlPlane } from "../../packages/control-plane/src/index.ts";
import type { Task } from "../../packages/core/src/index.ts";
import {
  COORDINATION_CAPABILITY,
  DurableLocalWorklet,
  FileAttemptJournal,
  REPORTED_COST_LIMIT_CAPABILITY,
  REPORTED_TOKEN_LIMIT_CAPABILITY,
  SURFACE_COORDINATION_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worklet,
} from "../../packages/runtime/sdk/src/index.ts";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "../support/database.ts";
import { startObjectiveSession } from "../support/objective-session.ts";
import { repositoryAttempt, runRepositoryExecution } from "../support/repository-execution.ts";

const capabilities = [
  COORDINATION_CAPABILITY,
  SURFACE_COORDINATION_CAPABILITY,
  REPORTED_COST_LIMIT_CAPABILITY,
  REPORTED_TOKEN_LIMIT_CAPABILITY,
];

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  const deadline = performance.now() + 20_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(10);
  }
}

function scriptedWorklet() {
  const started: TaskAttemptSpec[] = [];
  const aborted: string[] = [];
  const heldTask = Promise.withResolvers<string | undefined>();
  const release = Promise.withResolvers<void>();
  const worklet: Worklet = {
    id: "baseline-worklet",
    async describe() {
      return {
        id: this.id,
        protocolVersion: 1,
        host: {
          id: "baseline-host",
          workers: [
            {
              id: "baseline-worker",
              type: "deterministic-baseline",
              profiles: [{ id: "default", revision: "1" }],
              capabilities,
              contextTypes: [],
              maxConcurrency: 4,
              profileCapabilities: [
                { profile: { id: "default", revision: "1" }, capabilities, contextTypes: [] },
              ],
            },
          ],
        },
      };
    },
    selectPlacement: async () => ({
      workerHostId: "baseline-host",
      workletId: "baseline-worklet",
      workerId: "baseline-worker",
      workerProfile: { id: "default", revision: "1" },
    }),
    async *execute(spec, signal) {
      started.push(spec);
      const identity = {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
      };
      yield { ...identity, type: "execution.started", workerId: "baseline-worker" };
      if ((await heldTask.promise) === spec.taskId && !signal?.aborted) {
        await new Promise<void>((resolve) => {
          void release.promise.then(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      if (signal?.aborted) {
        aborted.push(spec.taskId);
        throw signal.reason;
      }
      yield {
        ...identity,
        type: "output.message",
        message: { role: "teammate", text: "Baseline complete" },
      };
      yield { ...identity, type: "execution.completed" };
    },
  };
  return { worklet, started, aborted, heldTask, release };
}

async function sqlFixture(directory: string, backend: string) {
  const postgres = process.env["SUPERTAG_POSTGRES_URL"];
  if (backend === "postgresql" && !postgres) throw new Error("Missing isolated PostgreSQL URL");
  const isolated =
    backend === "postgresql" ? await createIsolatedPostgresDatabase(postgres as string) : undefined;
  const url = isolated?.url ?? `file:${join(directory, "baseline.db")}`;
  const store = new DrizzleStore({ url });
  const script = scriptedWorklet();
  const makeControlPlane = () =>
    new ControlPlane({
      store: new DrizzleStore({ url }),
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      worklet: script.worklet,
      reply: async () => ({ externalMessageId: randomUUID() }),
      dispatch: { pollIntervalMs: 10, retryBaseMs: 50, maxAttempts: 1 },
    });
  let controlPlane = makeControlPlane();
  const close = async () => {
    script.heldTask.resolve(undefined);
    script.release.resolve();
    try {
      await controlPlane.stop();
    } finally {
      try {
        await store.disconnect();
      } finally {
        await isolated?.cleanup();
      }
    }
  };
  try {
    await migrateDatabase({ url });
    await store.connect();
    await controlPlane.start();
    const tag = await store.createTag({ name: "baseline-engineer" });
    await store.bindTagWorkerHost(tag.id, "baseline-host");
    return {
      store,
      script,
      tag,
      get controlPlane() {
        return controlPlane;
      },
      async restart() {
        await controlPlane.stop();
        controlPlane = makeControlPlane();
        await controlPlane.start();
      },
      async message(key: string) {
        const result = await controlPlane.messageTag({
          tagName: tag.name,
          operatorId: "baseline-operator",
          session: "baseline-conversation",
          text: "Complete this deterministic baseline Task",
          idempotencyKey: key,
        });
        if (!result.taskId) throw new Error(`No accepted Task: ${result.status}`);
        return result.taskId;
      },
      async task(id: string): Promise<Task> {
        const task = await store.findTaskById(id);
        if (!task) throw new Error("Accepted Task is missing");
        return task;
      },
      async completed(id: string) {
        return until(
          () => store.findTaskById(id),
          (task) => task?.status === "completed",
          "completed Task",
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function admission(directory: string, backend: string) {
  const fixture = await sqlFixture(directory, backend);
  fixture.script.heldTask.resolve(undefined);
  try {
    // Discard the first response's significance: repeat exactly the same operation identity.
    const first = await fixture.message("stable-operation");
    const retry = await fixture.message("stable-operation");
    await fixture.completed(first);
    await fixture.restart();
    const afterRestart = await fixture.message("stable-operation");
    return {
      sameTaskOnRetry: first === retry,
      sameTaskAfterRestart: first === afterRestart,
      taskCount: (await fixture.store.listTasks({ tagId: fixture.tag.id })).length,
      executionCount: fixture.script.started.filter((spec) => spec.taskId === first).length,
      status: (await fixture.task(first)).status,
    };
  } finally {
    await fixture.close();
  }
}

async function permissions(directory: string, backend: string) {
  const fixture = await sqlFixture(directory, backend);
  fixture.script.heldTask.resolve(undefined);
  try {
    const set = await fixture.store.createTagPermissionSet({ name: "baseline-permissions" });
    const original = await fixture.store.addTagPermission({
      permissionSetId: set.id,
      target: "runtime",
      action: "commands:execute",
    });
    const role = await fixture.store.createRole({
      name: "Baseline role",
      purpose: "Run baseline work",
      instructions: "Use allowed actions",
      contextSetIds: [],
      permissionSetIds: [set.id],
    });
    await fixture.store.assignRole({ roleId: role.id, tagId: fixture.tag.id });
    const first = await fixture.message("before-policy-change");
    await fixture.completed(first);
    const originalSnapshot = (await fixture.task(first)).authorizationSnapshot;
    await fixture.store.removeTagPermission(original.id);
    await fixture.store.addTagPermission({
      permissionSetId: set.id,
      target: "runtime",
      action: "files:write",
    });
    const later = await fixture.message("after-policy-change");
    await fixture.completed(later);
    await fixture.restart();
    return {
      firstTaskActions: [
        ...(await fixture.task(first)).authorizationSnapshot.runtimeActions,
      ].sort(),
      firstExecutionActions: [
        ...(fixture.script.started.find((spec) => spec.taskId === first)?.authorization
          .runtimeActions ?? []),
      ].sort(),
      laterTaskActions: [
        ...(await fixture.task(later)).authorizationSnapshot.runtimeActions,
      ].sort(),
      snapshotSurvivedRestart:
        JSON.stringify((await fixture.task(first)).authorizationSnapshot) ===
        JSON.stringify(originalSnapshot),
    };
  } finally {
    await fixture.close();
  }
}

async function objective(directory: string, backend: string) {
  const fixture = await sqlFixture(directory, backend);
  const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  try {
    const session = await startObjectiveSession({
      store: fixture.store,
      controlPlane: fixture.controlPlane,
      ownerTagId: fixture.tag.id,
      objective: { ongoing: true, outcome: "Maintain the baseline", deadline: minutesFromNow(60) },
    });
    fixture.script.heldTask.resolve(session.startTaskId);
    const taskId = session.startTaskId;
    await until(
      () => fixture.task(taskId),
      (task) => task.status === "running",
      "running Objective Task",
    );
    const reload = () => fixture.store.getObjective(session.objective.id);
    const changeDeadline = async (minutes: number) =>
      fixture.store.updateObjectiveStatus(
        session.objective.id,
        { deadline: minutesFromNow(minutes), expectedRevision: (await reload()).revision },
        undefined,
        undefined,
        { operatorId: "baseline-operator" },
      );
    const sweep = () => fixture.controlPlane.objectives.sweepObjectiveLimits(true);
    await changeDeadline(-5);
    await sweep();
    const duringGraceTask = (await fixture.task(taskId)).status;
    const duringGraceObjective = (await reload()).status;
    const duringGraceAborts = fixture.script.aborted.filter((id) => id === taskId).length;
    await changeDeadline(-20);
    await sweep();
    await until(
      () => fixture.task(taskId),
      (task) => task.status === "cancelled",
      "cancelled Objective Task",
    );
    await until(
      async () => {
        await sweep();
        return reload();
      },
      (value) => value.status === "limited",
      "limited Objective",
    );
    return {
      duringGraceTask,
      duringGraceObjective,
      duringGraceAborts,
      afterGraceTask: (await fixture.task(taskId)).status,
      afterGraceObjective: (await reload()).status,
      targetTaskAborts: fixture.script.aborted.filter((id) => id === taskId).length,
    };
  } finally {
    await fixture.close();
  }
}

async function replay(directory: string) {
  const script = scriptedWorklet();
  script.heldTask.resolve(undefined);
  const spec: TaskAttemptSpec = {
    ...repositoryAttempt("baseline-replay"),
    workerProfile: { id: "default", revision: "1" },
  };
  const journal = join(directory, "journal");
  let durable = new DurableLocalWorklet(script.worklet, new FileAttemptJournal(journal));
  try {
    const receipt = await durable.accept(spec);
    const events: Array<{ readonly sequence: number; readonly event: TaskAttemptEvent }> = [];
    for await (const event of durable.events(spec.attemptId)) events.push(event);
    await durable.close();
    durable = new DurableLocalWorklet(script.worklet, new FileAttemptJournal(journal));
    const recovered = await durable.accept(spec);
    const tail: typeof events = [];
    for await (const event of durable.events(spec.attemptId, 1)) tail.push(event);
    let conflictingRetryRejected = false;
    try {
      await durable.accept({ ...spec, taskId: "different-task" });
    } catch (error) {
      if (!(error instanceof Error) || !/conflict/i.test(error.message)) throw error;
      conflictingRetryRejected = true;
    }
    return {
      executionCount: script.started.length,
      receiptPreserved: receipt.specDigest === recovered.specDigest,
      statusAfterRestart: (await durable.inspect(spec.attemptId))?.status,
      sequences: events.map((event) => event.sequence),
      tailSequences: tail.map((event) => event.sequence),
      tailMatches: JSON.stringify(tail) === JSON.stringify(events.slice(1)),
      conflictingRetryRejected,
    };
  } finally {
    await durable.close();
  }
}

async function workspace(directory: string) {
  const result = await runRepositoryExecution(directory);
  const digests = await Promise.all(
    [result.patch, result.evidence, result.verification].map(async (ref) => {
      const digest = ref.digest?.replace("sha256:", "");
      if (!digest) return false;
      const bytes = await readFile(join(directory, "artifacts", digest));
      return createHash("sha256").update(bytes).digest("hex") === digest;
    }),
  );
  return {
    independentChecks: result.outcome.checks,
    reviewPassed: result.outcome.passed,
    revisionMatches: result.outcome.revision === result.revision,
    producerRemovedBeforeReview: result.producerRemovedBeforeReview,
    operatorChangesPreserved: result.originalWorkingTree === "uncommitted operator changes\n",
    artifactDigestsVerified: digests.every(Boolean),
  };
}

const [scenario, backend, directory] = process.argv.slice(2);
if (!directory || !backend) throw new Error("Usage: DRIVER SCENARIO BACKEND DISPOSABLE_DIRECTORY");
if (!["sqlite", "postgresql", "filesystem"].includes(backend))
  throw new Error(`Unsupported baseline backend: ${backend}`);
const filesystemScenario =
  scenario === "durable-event-replay" || scenario === "workspace-verification";
if (filesystemScenario !== (backend === "filesystem"))
  throw new Error("The requested backend does not apply to this scenario");
let facts: unknown;
switch (scenario) {
  case "admission-retry":
    facts = await admission(directory, backend);
    break;
  case "permission-snapshot":
    facts = await permissions(directory, backend);
    break;
  case "objective-deadline":
    facts = await objective(directory, backend);
    break;
  case "durable-event-replay":
    facts = await replay(directory);
    break;
  case "workspace-verification":
    facts = await workspace(directory);
    break;
  default:
    throw new Error(`Unknown baseline scenario: ${scenario}`);
}
process.stdout.write(
  `BASELINE_RESULT ${JSON.stringify({ version: 1, scenario, backend, facts })}\n`,
);
