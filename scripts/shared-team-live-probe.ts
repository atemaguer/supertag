import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AdmitTaskAssignmentInput } from "../packages/core/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  collectTaskAttemptEvents,
  type TaskAttemptSpec,
  type ToolInput,
  ToolProviderRegistry,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { captureTestArtifact } from "../tests/support/captured-artifact.js";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    harness: { type: "string" },
    output: { type: "string" },
    "timeout-ms": { type: "string" },
    "max-attempts": { type: "string" },
  },
});
if (!values.live)
  throw new Error(
    "Explicit --live required; uses the selected Harness CLI subscription authentication",
  );
const harness = values.harness ?? "codex";
if (harness !== "codex" && harness !== "claude-code")
  throw new Error("harness must be codex or claude-code");
const model = harness === "claude-code" ? "haiku" : "gpt-5.6-luna";
const timeoutMs = Number(values["timeout-ms"] ?? 480000);
const maxAttempts = Number(values["max-attempts"] ?? 4);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
  throw new Error("timeout-ms must be 1000..600000");
if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4)
  throw new Error("max-attempts must be 1..4");
const directory = resolve(values.output ?? `.supertag/shared-team-live/${Date.now()}`);
await mkdir(directory, { recursive: true });
const url = `file:${resolve(directory, "state.db")}`;
await migrateDatabase({ url });
let store = new DrizzleStore({ url });
await store.connect();
const started = Date.now();
const calls: Array<{ role: string; name: string; success: boolean }> = [];
const runs: Array<{ role: string; eventTypes: string[]; output: string[] }> = [];
const assertions: string[] = [];
let server: HttpServer | undefined;
const credentials = new Map<string, string>();
let failure: string | undefined;
try {
  const ownerA = await store.createTag({ name: "Invoicing owner" });
  const ownerB = await store.createTag({ name: "Refunds owner" });
  const lead = await store.createTag({ name: "Payments lead" });
  const implementer = await store.createTag({ name: "Payments implementer" });
  await store.createObjective({
    id: "invoicing",
    ownerTagId: ownerA.id,
    outcome: "Batch invoices next week",
    budgetLimitMinor: 100,
  });
  await store.createObjective({
    id: "refunds",
    ownerTagId: ownerB.id,
    outcome: "Repair duplicate refunds today",
    budgetLimitMinor: 100,
  });
  await store.createTeam({
    id: "payments",
    objectiveId: "invoicing",
    objectiveIds: ["refunds"],
    name: "Payments",
    leadTagId: lead.id,
    memberTagIds: [implementer.id],
    maxConcurrency: 1,
  });
  const make = (
    taskId: string,
    objectiveId: string,
    requestedByTagId: string,
  ): AdmitTaskAssignmentInput => ({
    taskId,
    objectiveId,
    teamId: "payments",
    requestedByTagId,
    assignedTagId: implementer.id,
    instruction: taskId,
    acceptanceCriteria: ["Independent evidence"],
    execution: {},
    authorizationSnapshot: {
      version: 4,
      capturedAt: new Date().toISOString(),
      tag: { id: implementer.id, name: implementer.name },
      origin: { kind: "internal", objectiveId, requestedByTagId },
      requester: { kind: "bot", id: requestedByTagId },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
    workspacePlan: { version: 1, status: "none" },
  });
  const evidenceTask = await store.admitTaskAssignment(
    make("reviewed-refund-contract", "invoicing", ownerA.id),
  );
  await store.claimTaskAssignment({ taskId: evidenceTask.taskId, leaseOwner: "fixture-evidence" });
  const sourceAttempt = await store.createTaskAttempt({
    taskId: evidenceTask.taskId,
    attemptNumber: 1,
    workerProfile: { id: "fixture", revision: "1" },
    workerSnapshot: {},
    startedAt: new Date().toISOString(),
  });
  const captured = await captureTestArtifact(store, evidenceTask.taskId, {
    attempt: sourceAttempt,
  });
  const digest = captured.entries[0]?.digest;
  if (!digest) throw new Error("Missing captured digest");
  await store.settleTaskAssignment({
    taskId: evidenceTask.taskId,
    leaseOwner: "fixture-evidence",
    attemptCount: 1,
    terminalAttempt: { id: sourceAttempt.id, status: "completed" },
    result: { taskResult: { artifacts: [{ artifactId: captured.id, paths: ["output.json"] }] } },
  });
  await store.reviewTaskAssignment(
    evidenceTask.taskId,
    ownerA.id,
    true,
    "Deterministic fixture represents a previously reviewed contract",
  );
  await store.updateTeam(
    "payments",
    {
      expectedRevision: 1,
      context: {
        policyId: "POLICY-R17",
        rule: "Active duplicate payouts take precedence over non-due invoice batching. Preserve idempotency on refund retries.",
        sourceTaskId: evidenceTask.taskId,
        sourceAttemptId: sourceAttempt.id,
        digest,
      },
    },
    ownerA.id,
  );
  await store.setTagMessagingGrant({
    senderTagId: ownerB.id,
    recipientTagId: lead.id,
    messageTypes: ["message"],
  });
  await store.setTagMessagingGrant({
    senderTagId: ownerB.id,
    recipientTagId: ownerA.id,
    messageTypes: ["message"],
  });
  await store.admitTaskAssignment(make("invoice-task", "invoicing", ownerA.id));
  await store.admitTaskAssignment(make("refund-task", "refunds", ownerB.id));
  const actors: Record<string, string> = { ownerA: ownerA.id, ownerB: ownerB.id, lead: lead.id };
  const schema = {
    type: "object",
    properties: {
      taskId: { type: "string" },
      teamId: { type: "string" },
      recipientTeamId: { type: "string" },
      recipientTagId: { type: "string" },
      type: { type: "string" },
      idempotencyKey: { type: "string" },
      body: { type: "object" },
      expectedStatus: { type: "string" },
      priority: { type: "string" },
      expectedRevision: { type: "integer" },
      governingObjectiveId: { type: "string" },
    },
    additionalProperties: true,
  };
  const names = [
    "read_team",
    "read_task",
    "read_mailbox",
    "send_message",
    "update_task",
    "update_team",
  ];
  const invoke = async (role: string, name: string, args: Record<string, unknown>) => {
    const tagId = actors[role];
    if (!tagId) throw new Error("Unknown role");
    const team = await store.getTeam("payments");
    switch (name) {
      case "read_team":
        return team;
      case "read_task":
        return store.getTaskAssignment(String(args["taskId"]));
      case "read_mailbox":
        return { messages: await store.listTagMessages(tagId) };
      case "send_message": {
        const recipientTeamId = args["recipientTeamId"] as string | undefined;
        const recipientTagId = recipientTeamId
          ? (await store.getTeam(recipientTeamId)).leadTagId
          : String(args["recipientTagId"]);
        return store.enqueueTagMessage({
          senderTagId: tagId,
          recipientTagId,
          ...(recipientTeamId ? { recipientTeamId } : {}),
          objectiveId: "refunds",
          type: "message",
          body: (args["body"] ?? {}) as Record<string, unknown>,
          idempotencyKey: String(args["idempotencyKey"]),
        });
      }
      case "update_task":
        return store.updateTaskAssignment(
          String(args["taskId"]),
          {
            expectedStatus: String(args["expectedStatus"]) as "queued",
            priority: String(args["priority"]) as "urgent",
          },
          tagId,
        );
      case "update_team":
        return store.updateTeam(
          "payments",
          {
            expectedRevision: Number(args["expectedRevision"]),
            objectiveId: String(args["governingObjectiveId"]),
          },
          tagId,
        );
      default:
        throw new Error("Unknown tool");
    }
  };
  const app = createMcpExpressApp();
  type Req = IncomingMessage & { body?: unknown };
  type Res = ServerResponse & { status(n: number): Res; json(v: unknown): void };
  app.post("/mcp", async (req: Req, res: Res) => {
    const role = credentials.get(req.headers.authorization ?? "");
    if (!role) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const protocol = new McpProtocolServer(
      { name: "shared-team-live", version: "1" },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: names.map((name) => ({
        name,
        description: `${name}: perform an authorized shared Team operation as ${role}. Actor identity is fixed by server authentication.`,
        inputSchema: schema,
      })),
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        const result = await invoke(role, params.name, params.arguments ?? {});
        calls.push({ role, name: params.name, success: true });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        calls.push({ role, name: params.name, success: false });
        return {
          isError: true,
          content: [
            { type: "text", text: error instanceof Error ? error.message : "Operation failed" },
          ],
        };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
    await protocol.connect(transport as Parameters<McpProtocolServer["connect"]>[0]);
    res.on("close", () => {
      void transport.close();
      void protocol.close();
    });
    await transport.handleRequest(req as never, res as never, req.body);
  });
  server = await new Promise<HttpServer>((done, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => done(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No MCP address");
  const run = async (role: string, prompt: string) => {
    if (runs.length >= maxAttempts) throw new Error("Attempt budget exhausted");
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining < 1000) throw new Error("Total time budget exhausted");
    const credential = `Bearer ${randomUUID()}`;
    credentials.set(credential, role);
    const input: ToolInput = {
      id: "supertag-coordination",
      kind: "tool",
      required: true,
      audience: "manager",
      capability: {
        id: "supertag-coordination",
        provider: "supertag",
        operations: names.map((name) => ({
          name,
          effect: name.startsWith("read_") ? "read" : "write",
          actions: ["coordination:probe"],
          inputSchema: schema,
        })),
        authorization: {
          provider: "supertag",
          resources: [{ surfaceAccountId: "shared-team-live", scope: "payments" }],
        },
      },
      binding: {
        kind: "mcp-http",
        name: "supertag-coordination",
        url: `http://127.0.0.1:${address.port}/mcp`,
        runtimeHeaders: { authorization: credential },
      },
    };
    const toolProviders = new ToolProviderRegistry([
      { provider: "supertag", resolve: async () => ({ provider: "supertag", inputs: [input] }) },
    ]);
    const common = {
      workspace: directory,
      model,
      timeoutMs: Math.min(120000, remaining),
      toolProviders: toolProviders as never,
      profileId: "shared-team-live",
      profileRevision: "1",
    };
    const worker =
      harness === "claude-code"
        ? createClaudeCodeWorker({ ...common, maxTurns: 12 })
        : createCodexWorker({
            ...common,
            executionMode: "app-server",
            authFile: resolve(homedir(), ".codex/auth.json"),
          });
    const events = await collectTaskAttemptEvents(
      worker.execute(
        probeAttempt(
          `Use only the supplied MCP tools. Do not run shell, inspect files, or spawn subagents. Read the relevant resources first. ${prompt} Then finish immediately in one sentence.`,
          randomUUID(),
        ),
      ),
    );
    credentials.delete(credential);
    const clean = (s: string) => s.replaceAll(credential, "[redacted]");
    runs.push({
      role,
      eventTypes: events.map((e) => e.type),
      output: events.flatMap((e) => (e.type === "output.message" ? [clean(e.message.text)] : [])),
    });
    const failed = events.findLast((e) => e.type === "execution.failed");
    if (failed?.type === "execution.failed") throw new Error(clean(failed.error.message));
  };
  await run(
    "ownerB",
    "You own refunds. Read_team payments and read_task refund-task. Send_message to recipientTeamId payments with idempotencyKey refund-priority-request and a body explaining that active duplicate payouts affect customers today while invoice batching is due next week, and request urgent priority. Do not update the Task yourself.",
  );
  assert.equal((await store.getTaskAssignment("refund-task"))?.priority, "normal");
  assert.ok(
    (await store.listTagMessages(lead.id)).some(
      (message) => message.idempotencyKey === "refund-priority-request",
    ),
  );
  assertions.push("Live owner request persists in the Team lead Mailbox without changing priority");
  await run(
    "lead",
    "You lead Payments independently of both owners. Read_mailbox, read_team payments, and read_task refund-task. If the request and Team context support it, update_task refund-task from expectedStatus queued to priority urgent. Cite the Team policy identifier in your final explanation.",
  );
  assert.equal((await store.getTaskAssignment("refund-task"))?.priority, "urgent");
  assert.equal((await store.listPendingTaskAssignments())[0]?.taskId, "refund-task");
  assertions.push("Independent live lead accepts priority and real pending queue reorders");
  assert.ok(
    runs
      .find((r) => r.role === "lead")
      ?.output.join(" ")
      .includes("POLICY-R17"),
  );
  assertions.push(
    "Live independent lead cites the accepted policy retrieved through its Team knowledge tool view",
  );
  const other = new DrizzleStore({ url });
  await other.connect();
  try {
    const claims = await Promise.all([
      store.claimTaskAssignment({ taskId: "refund-task", leaseOwner: "refund-worker" }),
      other.claimTaskAssignment({ taskId: "invoice-task", leaseOwner: "invoice-worker" }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assertions.push(
      "Two database connections cannot exceed shared Team capacity across Objectives",
    );
  } finally {
    await other.disconnect();
  }
  await store.disconnect();
  store = new DrizzleStore({ url });
  await store.connect();
  assert.equal((await store.getTaskAssignment("refund-task"))?.priority, "urgent");
  assertions.push("Priority update survives closing and reopening the database connection");
  const reopenedTeam = await store.getTeam("payments", lead.id);
  assert.equal(reopenedTeam.context["sourceAttemptId"], sourceAttempt.id);
  assert.equal(reopenedTeam.context["digest"], digest);
  assert.equal(reopenedTeam.context["policyId"], "POLICY-R17");
  assertions.push(
    "Accepted knowledge and immutable source Attempt digest survive database reconnect",
  );
  await run(
    "ownerB",
    `You own refunds. Read_team payments and send_message to recipientTagId ${ownerA.id} with type message, idempotencyKey refund-governance-request, and a body requesting that refunds govern the Team while invoicing remains linked. Do not update the Team yourself.`,
  );
  assert.equal((await store.getTeam("payments")).objectiveId, "invoicing");
  assertions.push("Live governance request does not transfer authority by itself");
  await run(
    "ownerA",
    `You are the current governing invoice owner (${ownerA.id}). Call read_mailbox with an empty object, then call read_team with {"teamId":"payments"}. If the request preserves invoice linkage, call update_team with {"teamId":"payments","expectedRevision":<the revision returned by read_team>,"governingObjectiveId":"refunds"}.`,
  );
  const team = await store.getTeam("payments");
  assert.equal(team.objectiveId, "refunds");
  assert.ok(team.objectiveIds.includes("invoicing"));
  assert.equal((await store.getTaskAssignment("invoice-task"))?.teamId, "payments");
  assertions.push("Live receiving owner accepts governance while preserving linked invoice work");
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (server)
    await new Promise<void>((done) => {
      server?.closeAllConnections();
      server?.close(() => done());
    });
  await store.disconnect();
  const report = {
    status: failure ? "failed" : "passed",
    failure,
    elapsedMs: Date.now() - started,
    mode: `live ${harness} CLI managers calling real Store methods through authenticated test MCP`,
    harness,
    model,
    assertions,
    calls,
    runs,
    limitations: [
      "Fixture creates Objectives, Tasks, and Team; model does not autonomously discover organizational structure",
      "Test MCP fixes resource IDs and role identity, not production Control Plane coordination API",
      "Capacity contention is injected deterministically; it is not live Worker scheduling",
      "Database reconnect is not a Control Plane process restart",
      "Team context and its accepted artifact provenance are deterministic fixtures, not an artifact produced by this live model run",
      "Artifact rejection/repair and native subagent isolation are separate tests",
    ],
  };
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function probeAttempt(prompt: string, nonce: string): TaskAttemptSpec {
  const capturedAt = new Date().toISOString();
  return {
    version: 2,
    taskId: `shared-team-live-${nonce}`,
    attemptId: `attempt-${nonce}`,
    tag: { id: "shared-team-live", name: "Shared Team live manager" },
    input: {
      origin: {
        surface: "supertag.coordination",
        accountId: "shared-team-live",
        scope: "objective",
        sessionKey: `probe:${nonce}`,
        occurredAt: capturedAt,
      },
      messages: [{ id: "probe", role: "requester", text: prompt }],
    },
    authorization: {
      version: 4,
      capturedAt,
      tag: { id: "shared-team-live", name: "Shared Team live manager" },
      origin: {
        kind: "internal",
        objectiveId: "shared-team-live",
        requestedByTagId: "shared-team-live",
      },
      requester: { kind: "user", id: "shared-team-live" },
      permissionSets: [],
      resources: [],
      runtimeActions: ["files:read", "commands:execute"],
    },
    contextPlan: { version: 7, capturedAt, sets: [] },
    workspacePlan: { version: 1, status: "none" },
    workerProfile: { id: "shared-team-live", revision: "1" },
    execution: {},
  };
}
