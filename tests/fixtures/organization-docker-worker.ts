/** Deterministic Objective and work Session policy using the production MCP and artifact clients. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { artifactTransferVerificationKey } from "../../apps/cli/src/artifact-transfer-key.js";
import type { ResolvedArtifactTransfer } from "../../packages/core/src/index.js";
import { SharedExecutionEnvironmentProvider } from "../../packages/runtime/environments/shared-execution/src/index.js";
import {
  connectWorkerMcpClient,
  createWorker,
  DurableLocalWorklet,
  FileArtifactStore,
  FileAttemptJournal,
  type Harness,
  LocalHarnessRuntimeProvider,
  LocalWorklet,
  type TaskAttemptSpec,
  type WorkerProfile,
  WorkletArtifactStore,
  WorkletArtifactTransferServer,
} from "../../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../../packages/runtime/transport/src/index.js";

const id = process.env["WORKER_ID"];
const credential = process.env["SUPERTAG_WORKLET_CREDENTIAL"];
const adminToken = process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"];
if (!id || !credential || !adminToken) throw new Error("Missing Worker configuration");
const execution = new SharedExecutionEnvironmentProvider({
  baseUrl: "http://execution:8787",
  adminToken,
  environmentId: "organization-shared",
});
const runtime = new LocalHarnessRuntimeProvider();
// Each Worker Host keeps its own artifact copies and serves them directly to admitted peers under
// grants the Control Plane signs. The Control Plane records only metadata and never holds bytes.
const controlPlaneUrl = "https://control-plane:8790";
const copies = new FileArtifactStore("/state/artifacts");
const transferKey = (await (
  await fetch(`${controlPlaneUrl}/internal/v1/artifacts/transfer-key`)
).json()) as { publicKey: string };
const transfers = new WorkletArtifactTransferServer({
  workerHostId: id,
  store: copies,
  verificationKey: artifactTransferVerificationKey(transferKey.publicKey),
  onError: (error) => process.stderr.write(`Artifact transfer error: ${String(error)}\n`),
});
const transferBaseUrl = await transfers.listen({
  host: "0.0.0.0",
  port: 8791,
  advertiseUrl: `http://${id}:8791`,
  allowInsecureHttp: true,
});
/** Retries transient failures, such as a restarting Control Plane; metadata writes are idempotent. */
async function artifactRequest(
  path: string,
  token: string,
  body: unknown,
  method = "POST",
  headers: Record<string, string> = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${controlPlaneUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
    }).catch((error: unknown) => {
      if (attempt >= 5) throw error;
      return undefined;
    });
    if (response?.ok) return response;
    await response?.body?.cancel();
    if (response && (![502, 503, 504].includes(response.status) || attempt >= 5))
      throw Object.assign(new Error(`Artifact ${path} failed (${response.status})`), {
        status: response.status,
      });
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
}
let inventoryRevision = 0;
let inventory = Promise.resolve();
/** Advertises local copies for the current connection; later revisions supersede earlier ones. */
function registerCopies(entries: readonly { digest: string; sizeBytes: number }[]): Promise<void> {
  const registration = inventory.then(async () => {
    inventoryRevision += 1;
    const response = await artifactRequest(
      "/internal/v1/artifacts/worklet-copies",
      credential as string,
      { inventoryRevision, transferBaseUrl, copies: entries },
      "PUT",
      { "x-supertag-worker-host-id": id as string },
    );
    await response.body?.cancel();
  });
  inventory = registration.catch(() => undefined);
  return registration;
}
function artifactStoreFor(spec: TaskAttemptSpec): WorkletArtifactStore {
  let token = spec.coordination?.token;
  if (!token) throw new Error("Missing artifact authority");
  // A Control Plane restart re-leases the Attempt; exchange the earlier credential once.
  const catalog = async (operation: string, body: unknown): Promise<Response> => {
    const used = token as string;
    try {
      return await artifactRequest(`/internal/v1/artifacts/catalog/${operation}`, used, body);
    } catch (error) {
      if ((error as { status?: number }).status !== 401) throw error;
      if (token === used)
        token = (
          (await (await artifactRequest("/internal/v1/coordination/rebind", used, {})).json()) as {
            token: string;
          }
        ).token;
      return artifactRequest(`/internal/v1/artifacts/catalog/${operation}`, token as string, body);
    }
  };
  return new WorkletArtifactStore({
    copies,
    allowInsecureHttp: true,
    publish: async ({ ref, sizeBytes }) => {
      if (!ref.digest) throw new Error("Artifact publication requires a digest");
      await registerCopies([{ digest: ref.digest, sizeBytes }]);
      await (await catalog("upload", { digest: ref.digest, sizeBytes })).body?.cancel();
    },
    resolve: async (ref) =>
      (await (
        await catalog("resolve-transfer", { artifactId: ref.artifactId, path: ref.path })
      ).json()) as ResolvedArtifactTransfer,
  });
}
const content = "Reviewed shared conclusion: the pooled result is 42.\n";
const digest = createHash("sha256").update(content).digest("hex");
const uri = `supertag-artifact:sha256:${digest}`;
/** Work Session instructions start with one of these; the Objective's own turns never do. */
const PRODUCE = "PRODUCE-EVIDENCE";
const REVIEW = "REVIEW-EVIDENCE";
/** Work Session titles, which report turns name. */
const PRODUCE_TITLE = "Produce pooled evidence";
const REVIEW_TITLE = "Review pooled evidence";
const plan = {
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "unrestricted" as const },
};
function request(task: TaskAttemptSpec): string {
  return task.input.messages.findLast((message) => message.role === "requester")?.text ?? "";
}
function toolResult(value: unknown): {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
} {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content))
    throw new Error("Invalid MCP result");
  return value as { isError?: boolean; content: Array<{ type: string; text?: string }> };
}
const harness: Harness = {
  id: "organization-fixture",
  async describe() {
    return {
      sessions: { resume: false, export: false, scope: "none" as const },
      id: this.id,
      version: "1",
      inputKinds: ["instruction", "tool"],
      streaming: true,
      cancellation: true,
      sessionPersistence: "none",
      runtimePlacements: ["local", "remote"],
      splitExecution: true,
      toolIsolation: { managerOnly: true, schemaIsolation: "hard" },
    };
  },
  async plan(context) {
    return {
      runtime: plan,
      execution: plan,
      ...(request(context.attempt).startsWith(PRODUCE)
        ? { outputs: [{ path: "conclusion.txt", name: "conclusion", mediaType: "text/plain" }] }
        : {}),
    };
  },
  async start(_plan, environments, context) {
    const task = context.attempt;
    const coordination = task.coordination;
    if (!coordination) throw new Error("Missing admitted coordination authority");
    const tool = context.tools.find((input) => input.id === "supertag-coordination");
    if (!tool) throw new Error("Missing coordination Tool Input");
    const client = await connectWorkerMcpClient(tool);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = toolResult(await client.callTool(name, args));
      if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
      const blocks = result.content as Array<{ type: string; text?: string }>;
      return JSON.parse(blocks.find((block) => block.type === "text")?.text ?? "null") as Record<
        string,
        unknown
      >;
    };
    const catalog = async (operation: string, body: unknown) =>
      (await (
        await artifactRequest(
          `/internal/v1/artifacts/catalog/${operation}`,
          coordination.token,
          body,
        )
      ).json()) as Record<string, unknown>;
    const turn = request(task);
    const transcript = task.input.messages.map((message) => message.text).join("\n");
    return {
      async *run(signal) {
        if (turn.startsWith(PRODUCE)) {
          const child = await environments.execution.spawn(
            {
              command: "node",
              args: [
                "-e",
                `const fs=require('fs');fs.appendFileSync('effects.txt','produce\\n');fs.writeFileSync('started.txt','ready');setTimeout(()=>{fs.writeFileSync('conclusion.txt',${JSON.stringify(content)});console.log('produced')},12000)`,
              ],
            },
            signal,
          );
          const result = await child.wait();
          if (result.exitCode !== 0) throw new Error("Research process did not complete");
          yield { type: "output.message" as const, text: "Research artifact produced" };
          return;
        }
        if (turn.startsWith(REVIEW)) {
          if (id !== "worker-b") throw new Error("The review ran outside the reviewer's host");
          // A work Session has only ask: no Objective or messaging authority.
          const names = client.tools.map((candidate) => candidate.name);
          for (const name of ["update_objective", "send_message", "start_session"])
            if (names.includes(name)) throw new Error(`A work Session received ${name}`);
          // An Attempt credential is not a transfer grant: the producer's Worklet refuses it.
          const denied = await fetch(`http://worker-a:8791/v1/artifacts/${digest}`, {
            headers: { authorization: `Bearer ${coordination.token}` },
          });
          if (denied.status !== 403)
            throw new Error(`Unacquired artifact access was not denied: ${denied.status}`);
          await denied.body?.cancel();
          // The catalog finds the Objective's artifact; bytes come directly from the producer's host.
          const found = (await catalog("find", { query: "conclusion" }))["artifacts"] as Array<{
            id: string;
          }>;
          const artifactId = found[0]?.id;
          if (!artifactId) throw new Error("The reviewer found no Objective artifact");
          const acquired = (await catalog("acquire", {
            operationId: "review-read",
            artifactId,
            paths: ["conclusion.txt"],
            delivery: "read",
          })) as { acquisition: { id: string } };
          const admitted = await artifactStoreFor(task).get({
            uri,
            digest: `sha256:${digest}`,
            artifactId,
            path: "conclusion.txt",
          });
          await catalog("settle", { id: acquired.acquisition.id, status: "delivered" });
          const shared = await environments.execution.read("conclusion.txt");
          if (Buffer.from(admitted).toString() !== content || shared !== content)
            throw new Error("Acquired and shared evidence disagree");
          const written = await environments.execution.spawn(
            {
              command: "node",
              args: [
                "-e",
                "require('fs').writeFileSync('review.txt', 'Independent review agrees: 42\\n')",
              ],
            },
            signal,
          );
          if ((await written.wait()).exitCode !== 0)
            throw new Error("Review record was not stored");
          await writeFile(
            "/state/permission-evidence.json",
            JSON.stringify({
              workSessionToolsLimited: true,
              unacquiredArtifactStatus: denied.status,
              tagId: task.tag.id,
              attemptId: task.attemptId,
            }),
          );
          yield {
            type: "output.message" as const,
            text: "Independent review verified the acquired artifact and shared execution bytes",
          };
          return;
        }
        // The Objective's own turns: its start, then each work Session's report.
        if (transcript.includes(REVIEW_TITLE)) {
          const read = await call("read_objective");
          const objective = (read["objective"] ?? read) as { revision: number };
          await call("update_objective", {
            status: "completed",
            expectedRevision: objective.revision,
            completionSummary:
              "Two Team members produced, acquired, and independently reviewed one shared result",
          });
          yield { type: "output.message" as const, text: "Objective completed" };
          return;
        }
        if (transcript.includes(PRODUCE_TITLE)) {
          await call("start_session", {
            title: REVIEW_TITLE,
            instruction: `${REVIEW}: verify the Objective's conclusion artifact against shared execution`,
            tag: "Review manager",
          });
          yield { type: "output.message" as const, text: "Review delegated" };
          return;
        }
        await call("start_session", {
          title: PRODUCE_TITLE,
          instruction: `${PRODUCE}: produce the shared conclusion`,
        });
        yield { type: "output.message" as const, text: "Research started" };
      },
      async close() {
        await client.close();
      },
    };
  },
};
const profile: WorkerProfile = {
  ref: { id, revision: "1" },
  workerType: "fixture",
  harness: { provider: harness.id },
  runtime: { provider: runtime.id, lifetime: { scope: "attempt" } },
  execution: { provider: execution.id, lifetime: { scope: "attempt" } },
};
const worker = createWorker({
  id: `${id}-worker`,
  profiles: [profile],
  harnesses: [harness],
  harnessRuntimes: [runtime],
  environments: [execution],
  artifactStore: artifactStoreFor,
});
const worklet = new LocalWorklet(`${id}-worklet`, id, [worker]);
const durableWorklet = new DurableLocalWorklet(worklet, new FileAttemptJournal("/state/journal"));
await connectWorklet({
  url: "wss://control-plane:8790/worklets",
  credential,
  worklet,
  durableWorklet,
  reconnectIntervalMs: 100,
  // A new connection generation starts a new inventory, so re-advertise every local copy.
  onConnected: () => {
    void (async () => {
      const entries: { digest: string; sizeBytes: number }[] = [];
      for await (const copy of copies.inventory()) entries.push(copy);
      await registerCopies(entries);
    })().catch((error) =>
      process.stderr.write(`Artifact inventory registration failed: ${String(error)}\n`),
    );
  },
});
process.stdout.write("Organization Worker ready\n");
