/** Deterministic manager policy using the production MCP and artifact clients. */
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
const plan = {
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "unrestricted" as const },
};
function toolResult(value: unknown): {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
} {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content))
    throw new Error("Invalid MCP result");
  return value as { isError?: boolean; content: Array<{ type: string; text?: string }> };
}
interface CoordinationState {
  result: { taskResult: { artifacts: Array<{ artifactId: string; paths: string[] }> } };
  revision: number;
  ownerTagId: string;
  status: string;
  duplicate: boolean;
  message: { id: string };
  tasks: Array<{ taskId: string; status: string; assignedTagId: string }>;
  teams: Array<{ id: string; leadTagId: string }>;
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
      ...(context.attempt.taskId === "research-produce"
        ? { outputs: [{ path: "conclusion.txt", name: "conclusion", mediaType: "text/plain" }] }
        : {}),
    };
  },
  async start(_plan, environments, context) {
    const task = context.attempt;
    const coordination = task.coordination;
    if (!coordination) throw new Error("Missing admitted manager authority");
    const tool = context.tools.find((input) => input.id === "supertag-coordination");
    if (!tool) throw new Error("Missing manager coordination Tool Input");
    const client = await connectWorkerMcpClient(tool);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = toolResult(await client.callTool(name, args));
      if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
      const blocks = result.content as Array<{ type: string; text?: string }>;
      return JSON.parse(
        blocks.find((block) => block.type === "text")?.text ?? "null",
      ) as CoordinationState;
    };
    return {
      async *run(signal) {
        await call("read_team");
        let objective = await call("read_objective");
        await call("read_mailbox");
        const source = task.input.messages
          .map((message) => {
            try {
              return JSON.parse(message.text)?.sourceMessage;
            } catch {
              return undefined;
            }
          })
          .find(Boolean);
        if (["review-bootstrap", "organization-bootstrap"].includes(task.taskId)) {
          yield {
            type: "output.message" as const,
            text: "Review manager available through its Team Mailbox",
          };
          return;
        }
        if (task.taskId === "research-produce") {
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
          const message = {
            recipientTeamId: "review-team",
            type: "result.submitted",
            body: { sourceTaskId: task.taskId, uri, digest: `sha256:${digest}` },
            idempotencyKey: "research-artifact",
          };
          const first = await call("send_message", message);
          const duplicate = await call("send_message", message);
          if (!duplicate.duplicate || duplicate.message.id !== first.message.id)
            throw new Error("Mailbox retry created a duplicate");
          yield {
            type: "output.message" as const,
            text: "Research artifact produced and review requested",
          };
          return;
        }
        if (task.taskId === "review-evidence") {
          // The admitted input names its catalog entry; bytes come directly from the producer's host.
          const input = task.input.attachments?.find(
            (attachment) => attachment.digest === `sha256:${digest}`,
          );
          if (!input) throw new Error("Missing admitted artifact input");
          const admitted = await artifactStoreFor(task).get(input);
          const shared = await environments.execution.read("conclusion.txt");
          if (Buffer.from(admitted).toString() !== content || shared !== content)
            throw new Error("Admitted and shared evidence disagree");
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
          await call("send_message", {
            recipientTeamId: "pooled-objective:leadership",
            type: "result.submitted",
            body: {
              reviewTaskId: task.taskId,
              uri,
              digest: `sha256:${digest}`,
              verdict: "accepted",
            },
            idempotencyKey: "review-result",
          });
          yield {
            type: "output.message" as const,
            text: "Independent review verified the admitted artifact and shared execution bytes",
          };
          return;
        }
        if (id === "worker-b") {
          if (source?.idempotencyKey !== "research-artifact")
            throw new Error("Unexpected Review manager message");
          const tools = client;
          if (tools.tools.some((tool) => tool.name === "update_objective"))
            throw new Error("Non-owner received owner-only tool");
          // An Attempt credential is not a transfer grant: the producer's Worklet refuses it.
          const denied = await fetch(`http://worker-a:8791/v1/artifacts/${digest}`, {
            headers: { authorization: `Bearer ${coordination.token}` },
          });
          if (denied.status !== 403)
            throw new Error(`Unadmitted artifact access was not denied: ${denied.status}`);
          await denied.body?.cancel();
          const forged = await client.callTool("send_message", {
            recipientTeamId: "pooled-objective:leadership",
            type: "progress.updated",
            body: {},
            idempotencyKey: "forged-authority",
            senderTagId: objective.ownerTagId,
          });
          if (!toolResult(forged).isError) throw new Error("Manager spoofed another Tag");
          await writeFile(
            "/state/permission-evidence.json",
            JSON.stringify({
              nonOwnerToolAbsent: true,
              unadmittedArtifactStatus: denied.status,
              forgedSenderDenied: true,
              tagId: task.tag.id,
              attemptId: task.attemptId,
            }),
          );
          await call("send_message", {
            recipientTeamId: "pooled-objective:leadership",
            type: "progress.updated",
            body: { request: "admit-review", sourceTaskId: "research-produce", uri },
            inReplyTo: source.id,
            idempotencyKey: "review-admission-request",
          });
          yield {
            type: "output.message" as const,
            text: "Requested an admitted artifact input without widening authority",
          };
          return;
        }
        const tasks = objective.tasks;
        const review = tasks.find((candidate) => candidate.taskId === "review-evidence");
        if (!review) {
          const produced = await call("read_task", { taskId: "research-produce" });
          if (produced.status !== "submitted") {
            await call("wait_for", { submittedTaskIds: ["research-produce"] });
            yield {
              type: "output.message" as const,
              text: "Waiting for durable artifact submission",
            };
            return;
          }
          const peer = objective.teams.find((team: { id: string }) => team.id === "review-team");
          await call("assign_task", {
            taskId: "review-evidence",
            teamId: "review-team",
            assignedTagId: peer?.leadTagId,
            instruction: "Verify the admitted artifact against shared execution",
            acceptanceCriteria: ["Stored and shared evidence match"],
            execution: { profile: { id: "worker-b", revision: "1" } },
            inputArtifacts: [
              { ...produced.result.taskResult.artifacts[0], requireAccepted: false },
            ],
            maxCostMinor: 0,
          });
          yield {
            type: "output.message" as const,
            text: "Review delegated with exact artifact provenance",
          };
          return;
        }
        if (review.status !== "submitted" && review.status !== "accepted") {
          await call("wait_for", { submittedTaskIds: ["review-evidence"] });
          yield { type: "output.message" as const, text: "Waiting for independent review" };
          return;
        }
        for (const candidate of tasks)
          if (candidate.status === "submitted")
            await call("update_task", {
              taskId: candidate.taskId,
              expectedStatus: "submitted",
              status: "accepted",
              assessment:
                candidate.taskId === "review-evidence"
                  ? "Independent stored and shared artifact checks passed"
                  : "Coordination responsibility completed",
            });
        objective = await call("read_objective");
        try {
          await call("update_objective", {
            status: "completed",
            expectedRevision: objective.revision,
            completionSummary:
              "Two Team managers produced, admitted, independently reviewed, and accepted one shared result",
          });
        } catch (error) {
          if (!String(error).includes("unsettled")) throw error;
          await call("wait_for", { notBefore: new Date(Date.now() + 1500).toISOString() });
          yield {
            type: "output.message" as const,
            text: "Waiting for outgoing Mailbox delivery settlement",
          };
          return;
        }
        yield {
          type: "output.message" as const,
          text: "Objective completed with independent artifact evidence",
        };
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
