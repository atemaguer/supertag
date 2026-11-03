import type { TagAuthorizationSnapshot } from "../../packages/core/src/index.js";
import { SharedExecutionEnvironmentProvider } from "../../packages/runtime/environments/shared-execution/src/index.js";
import {
  collectTaskAttemptEvents,
  createWorker,
  type Harness,
  type HarnessPlan,
  LocalHarnessRuntimeProvider,
  type TaskAttemptSpec,
  type WorkerProfile,
} from "../../packages/runtime/sdk/src/index.js";

const [mode, attemptId] = process.argv.slice(2);
const baseUrl = process.env["SUPERTAG_SHARED_EXECUTION_URL"];
const adminToken = process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"];
if (!mode || !baseUrl || !adminToken || !attemptId)
  throw new Error("Expected mode, Attempt ID, and shared execution environment variables");

const health = (await fetch(`${baseUrl}/healthz`).then((response) => response.json())) as {
  environmentId: string;
};

const execution = new SharedExecutionEnvironmentProvider({
  baseUrl,
  adminToken,
  environmentId: health.environmentId,
});
const runtime = new LocalHarnessRuntimeProvider();
const harness: Harness = {
  id: "shared-execution-fixture",
  async describe() {
    return {
      sessions: { resume: false, export: false, scope: "none" as const },
      id: this.id,
      version: "1",
      inputKinds: [],
      streaming: false,
      cancellation: true,
      sessionPersistence: "none",
      runtimePlacements: ["local", "remote"],
      splitExecution: true,
    };
  },
  async plan(): Promise<HarnessPlan> {
    return {
      runtime: emptyPlan("none"),
      execution: emptyPlan("unrestricted"),
    };
  },
  async start(_plan, environments) {
    return {
      async *run(signal) {
        if (mode === "writer") {
          const child = await environments.execution.spawn({
            command: "node",
            args: [
              "-e",
              "const fs=require('fs'); let leaked=false; for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){ try { leaked ||= fs.readFileSync('/proc/'+pid+'/environ','utf8').includes('SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN') } catch {} }; if(leaked) throw new Error('service credential visible'); fs.writeFileSync('pooled.txt', 'worker-a')",
            ],
          });
          await child.wait();
          yield { type: "output.message" as const, text: "wrote pooled.txt" };
          return;
        }
        if (mode === "reader") {
          const value = await environments.execution.read("pooled.txt");
          yield { type: "output.message" as const, text: value };
          return;
        }
        if (mode === "survivor-reader") {
          const value = await environments.execution.read("survivor.txt");
          yield { type: "output.message" as const, text: value };
          return;
        }
        if (mode === "cancelled") {
          const child = await environments.execution.spawn(
            { command: "node", args: ["-e", "setInterval(() => {}, 1000)"] },
            signal,
          );
          await child.wait();
          yield { type: "output.message" as const, text: "unexpected completion" };
          return;
        }
        if (mode === "survivor") {
          const child = await environments.execution.spawn({
            command: "node",
            args: [
              "-e",
              "setTimeout(() => { require('fs').writeFileSync('survivor.txt', 'worker-b'); console.log('survived') }, 350)",
            ],
          });
          const result = await child.wait();
          yield { type: "output.message" as const, text: result.stdout.trim() };
          return;
        }
        throw new Error(`Unknown fixture mode ${mode}`);
      },
      async close() {},
    };
  },
};
const profile: WorkerProfile = {
  ref: { id: "shared-execution", revision: "1" },
  workerType: "fixture",
  harness: { provider: harness.id },
  runtime: { provider: runtime.id, lifetime: { scope: "attempt" } },
  execution: { provider: execution.id, lifetime: { scope: "attempt" } },
};
const controller = new AbortController();
if (mode === "cancelled") setTimeout(() => controller.abort(), 175).unref();
const worker = createWorker({
  id: `fixture-${mode}`,
  profiles: [profile],
  harnesses: [harness],
  harnessRuntimes: [runtime],
  environments: [execution],
});
const events = await collectTaskAttemptEvents(
  worker.execute(task(attemptId, profile), controller.signal),
);
process.stdout.write(`${JSON.stringify({ mode, events })}\n`);

function emptyPlan(network: "none" | "unrestricted") {
  return {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: network },
  };
}

function task(id: string, workerProfile: WorkerProfile): TaskAttemptSpec {
  const capturedAt = "2026-09-14T00:00:00.000Z";
  const authorization: TagAuthorizationSnapshot = {
    version: 5,
    capturedAt,
    tag: { id: "tag-1", name: "Engineering" },
    origin: {
      tagRouteId: "route-1",
      surfaceAccountId: "test-1",
      provider: "github",
      scope: "shared-execution",
    },
    requester: { id: "user-1", kind: "user" },
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  };
  return {
    version: 2,
    taskId: `task-${id}`,
    attemptId: id,
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "test",
        accountId: "test-1",
        scope: "shared-execution",
        sessionKey: `test:${id}`,
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text: mode ?? "" }],
    },
    authorization,
    contextPlan: { version: 7, capturedAt, sets: [] },
    workspacePlan: { version: 1, status: "none" },
    workerProfile: workerProfile.ref,
    execution: {},
  };
}
