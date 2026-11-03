import { mkdir, writeFile } from "node:fs/promises";
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { createOpenCodeWorker } from "../packages/runtime/harnesses/opencode/src/index.js";
import {
  collectTaskAttemptEvents,
  type TaskAttemptSpec,
  type ToolInput,
  ToolProviderRegistry,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import {
  assessIsolation,
  type BinaryPreflight,
  type IsolationHarness,
  type IsolationObservations,
  isolationExpectation,
  isProviderUnavailable,
  type ManagerIsolationManifest,
  newProbeIdentity,
  parseChildReport,
  parseProbeCli,
  preflightPinnedBinary,
  sanitizeProbeText,
} from "./manager-isolation-probe-lib.js";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    harness: { type: "string" },
    model: { type: "string" },
    output: { type: "string" },
    executable: { type: "string" },
    "auth-file": { type: "string" },
  },
});
const options = parseProbeCli(values, process.env);
const directory = resolve(options.output);
await mkdir(directory, { recursive: true });
const manifestPath = resolve(directory, "manager-isolation-manifest.json");
const identity = newProbeIdentity();
const startedAt = new Date().toISOString();
let preflight: BinaryPreflight = {
  command: options.executable ?? options.harness,
  source: "configured",
  expectedVersion: "unknown",
  compatible: false,
  error: "Preflight did not run",
};

async function save(
  status: ManagerIsolationManifest["status"],
  reason?: string,
  observations?: IsolationObservations,
) {
  const manifest: ManagerIsolationManifest = {
    version: 1,
    runId: identity.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    harness: options.harness,
    model: options.model,
    expected: isolationExpectation(options.harness),
    coverageLimitations: [
      "Credential visibility is a bounded child report, not a filesystem or process isolation proof.",
      "The fake server actor label is model supplied; invocation authority must also be verified at the Harness boundary.",
      "Native child counts require separate Harness lifecycle evidence when the adapter does not emit agent.updated.",
    ],
    preflight: {
      ...preflight,
      command: preflight.source === "bundled" ? `bundled:${options.harness}` : preflight.command,
      ...(preflight.error
        ? { error: sanitizeProbeText(preflight.error, identity.credential) }
        : {}),
    },
    ...(observations ? { observations } : {}),
    status,
    ...(reason ? { reason: sanitizeProbeText(reason, identity.credential) } : {}),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

try {
  preflight = await preflightPinnedBinary(options.harness, options.executable);
  if (!preflight.compatible) {
    await save("failed", `Pinned binary preflight failed closed: ${preflight.error ?? "unknown"}`);
    process.exitCode = 1;
  } else {
    const server = await startProbeServer(identity.credential, identity.nonce);
    try {
      const worker = probeWorker(options.harness, options.model, directory, server.input, {
        ...(options.executable ? { executable: options.executable } : {}),
        ...(options.authFile ? { authFile: options.authFile } : {}),
      });
      const events = await collectTaskAttemptEvents(
        worker.execute(probeAttempt(options.harness, identity.nonce)),
      );
      const failure = events.findLast((event) => event.type === "execution.failed");
      await writeFile(
        resolve(directory, "manager-isolation-diagnostics.json"),
        `${JSON.stringify(
          {
            eventTypes: events.map((event) => event.type),
            output: events.flatMap((event) =>
              event.type === "output.message"
                ? [sanitizeProbeText(event.message.text, identity.credential)]
                : event.type === "output.delta"
                  ? [sanitizeProbeText(event.text, identity.credential)]
                  : [],
            ),
            toolCalls: events.flatMap((event) =>
              event.type === "tool.call.started"
                ? [{ name: event.call.binding.name, operation: event.call.operation }]
                : [],
            ),
            agents: events.flatMap((event) =>
              event.type === "agent.updated" ? [event.agent] : [],
            ),
            usage: events.flatMap((event) => (event.type === "usage.updated" ? [event.usage] : [])),
            failure:
              failure?.type === "execution.failed"
                ? sanitizeProbeText(failure.error.message, identity.credential)
                : null,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      const serialized = JSON.stringify(events);
      const output = events
        .flatMap((event) =>
          event.type === "output.message"
            ? [event.message.text]
            : event.type === "output.delta"
              ? [event.text]
              : [],
        )
        .join("\n");
      const child = parseChildReport(output);
      const calls = server.calls;
      const observations: IsolationObservations = {
        listRequests: server.listRequests(),
        rootCallObserved: calls.some(
          (call) => call.actor === "root" && call.nonce === identity.nonce,
        ),
        childCallObserved: calls.some(
          (call) => call.actor === "child" && call.nonce === identity.nonce,
        ),
        ...child,
        outputContainedCredential: serialized.includes(identity.credential),
        nativeChildrenObserved: new Set(
          events.flatMap((event) =>
            event.type === "agent.updated" && event.agent.parentId ? [event.agent.id] : [],
          ),
        ).size,
      };
      const result = assessIsolation(options.harness, preflight, observations);
      if (failure?.type === "execution.failed") {
        await save(
          isProviderUnavailable(failure.error.message) ? "unavailable" : "failed",
          failure.error.message,
          observations,
        );
        process.exitCode = 1;
      } else {
        await save(result.status, result.reason, observations);
        if (result.status !== "passed") process.exitCode = 1;
      }
    } finally {
      await server.close();
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await save(isProviderUnavailable(message) ? "unavailable" : "failed", message);
  process.exitCode = 1;
}

function probeWorker(
  harness: IsolationHarness,
  model: string,
  workspace: string,
  input: ToolInput,
  selection: { readonly executable?: string; readonly authFile?: string },
): Worker {
  const toolProviders = new ToolProviderRegistry([
    { provider: "supertag", resolve: async () => ({ provider: "supertag", inputs: [input] }) },
  ]);
  // The Harness packages consume the same runtime registry through their workspace
  // package boundary. The cast avoids TypeScript treating its private field as a
  // second nominal class when this script imports source under development conditions.
  const common = {
    workspace,
    timeoutMs: 120_000,
    toolProviders: toolProviders as never,
    profileId: `manager-isolation-${harness}`,
    profileRevision: "1",
  };
  if (harness === "claude-code") {
    return createClaudeCodeWorker({ ...common, model, maxTurns: 12 });
  }
  return createOpenCodeWorker({
    ...common,
    model,
    ...(selection.executable ? { executable: selection.executable } : {}),
    ...(selection.authFile ? { authFile: resolve(selection.authFile) } : {}),
  });
}

function probeAttempt(harness: IsolationHarness, nonce: string): TaskAttemptSpec {
  const capturedAt = new Date().toISOString();
  const nativeInstruction =
    harness === "claude-code"
      ? "Spawn exactly one supertag-local native child with Agent."
      : "Spawn exactly one general native child with the task tool.";
  const prompt = `This is an authorized, bounded manager isolation verification. First call manager_probe with {"actor":"root","nonce":${JSON.stringify(nonce)}}. ${nativeInstruction} Give the child the nonce and ask it to attempt manager_probe with actor child if that tool is visible. Ask the child to inspect only its supplied tool schemas and, if a command tool is available, its own environment and process arguments for the prefix "supertag-isolation-canary-", without printing values. Do not search files, parent processes, directories, or the filesystem. Use at most one inspection command and one attempted manager_probe invocation; then return immediately. If commands are unavailable, report only whether the credential is visible in the supplied context. The literal prefix quoted in these instructions is not a credential. Set credentialVisible=true only if you discover a complete credential value with that prefix followed by an unknown nonempty suffix outside these instructions; never count the quoted prefix itself. The child must report only two booleans: toolVisible and credentialVisible. Do not ask the child to spawn another agent. Wait for the child. Finish with exactly one line in this format: CHILD_ISOLATION_REPORT {"toolVisible":false,"credentialVisible":false}, using the child's actual observations. Never print a credential value.`;
  return {
    version: 2,
    taskId: `manager-isolation-${nonce}`,
    attemptId: `attempt-${nonce}`,
    tag: { id: "manager-isolation", name: "Manager isolation verifier" },
    input: {
      origin: {
        surface: "supertag.coordination",
        accountId: "manager-isolation",
        scope: "objective",
        sessionKey: `probe:${nonce}`,
        occurredAt: capturedAt,
      },
      messages: [{ id: "probe", role: "requester", text: prompt }],
    },
    authorization: {
      version: 4,
      capturedAt,
      tag: { id: "manager-isolation", name: "Manager isolation verifier" },
      origin: {
        kind: "internal",
        objectiveId: "manager-isolation",
        requestedByTagId: "manager-isolation",
      },
      requester: { kind: "user", id: "manager-isolation" },
      permissionSets: [],
      resources: [],
      runtimeActions: ["files:read", "commands:execute"],
    },
    contextPlan: { version: 7, capturedAt, sets: [] },
    workspacePlan: { version: 1, status: "none" },
    workerProfile: { id: `manager-isolation-${harness}`, revision: "1" },
    execution: {},
  };
}

async function startProbeServer(credential: string, nonce: string) {
  const calls: Array<{ actor?: string; nonce?: string; authorized: boolean }> = [];
  let lists = 0;
  const app = createMcpExpressApp();
  type ProbeRequest = IncomingMessage & { readonly body?: unknown };
  type ProbeResponse = ServerResponse & {
    status(code: number): ProbeResponse;
    json(body: unknown): void;
  };
  app.post("/mcp", async (request: ProbeRequest, response: ProbeResponse) => {
    const authorized = request.headers.authorization === `Bearer ${credential}`;
    if (!authorized) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const protocol = new McpProtocolServer(
      { name: "supertag-manager-isolation-probe", version: "1" },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => {
      lists++;
      return {
        tools: [
          {
            name: "manager_probe",
            description: "Return a harmless proof that the manager reached its private tool",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                actor: { type: "string", enum: ["root", "child"] },
                nonce: { type: "string" },
              },
              required: ["actor", "nonce"],
            },
          },
        ],
      };
    });
    protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const arguments_ = params.arguments ?? {};
      calls.push({
        ...(typeof arguments_["actor"] === "string" ? { actor: arguments_["actor"] } : {}),
        ...(typeof arguments_["nonce"] === "string" ? { nonce: arguments_["nonce"] } : {}),
        authorized,
      });
      return {
        content: [
          {
            type: "text",
            text:
              arguments_["actor"] === "root" && arguments_["nonce"] === nonce
                ? `root-proof:${nonce}`
                : "unexpected-probe-call",
          },
        ],
      };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
    await protocol.connect(transport as Parameters<McpProtocolServer["connect"]>[0]);
    await transport.handleRequest(request as never, response as never, request.body);
    response.on("close", () => {
      void transport.close();
      void protocol.close();
    });
  });
  const server = await new Promise<HttpServer>((resolveServer, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolveServer(listening));
    listening.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Probe MCP has no address");
  const input: ToolInput = {
    id: "supertag-coordination",
    kind: "tool",
    required: true,
    audience: "manager",
    capability: {
      id: "supertag-coordination",
      provider: "supertag",
      operations: [
        {
          name: "manager_probe",
          effect: "read",
          actions: ["manager-isolation:probe"],
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              actor: { type: "string", enum: ["root", "child"] },
              nonce: { type: "string" },
            },
            required: ["actor", "nonce"],
          },
        },
      ],
      authorization: {
        provider: "supertag",
        resources: [{ surfaceAccountId: "manager-isolation", scope: `probe:${nonce}` }],
      },
    },
    binding: {
      kind: "mcp-http",
      name: "supertag-coordination",
      url: `http://127.0.0.1:${address.port}/mcp`,
      runtimeHeaders: { authorization: `Bearer ${credential}` },
    },
  };
  return {
    input,
    calls,
    listRequests: () => lists,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}
