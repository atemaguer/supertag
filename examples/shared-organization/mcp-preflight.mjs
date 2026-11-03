import { randomUUID } from "node:crypto";
import { readMcpEvidence } from "./execution.mjs";
import { exampleMcpInputs } from "./mcp-tools.mjs";

const handoff = "INTERRUPTED_HANDOFF";

/** Judge only this probe's backend evidence, separately from manager work. */
export function evaluateMcpPreflight({
  entries,
  taskId,
  attemptId,
  denied,
  interrupted,
  observedText,
}) {
  const own = entries.filter(
    (entry) => entry.actor === "probe" && entry.taskId === taskId && entry.attemptId === attemptId,
  );
  const committedWrites = own.filter((entry) => entry.committed === true).length;
  const forbiddenCalls = own.filter(
    (entry) => entry.forbidden === true || entry.collection !== "docs",
  ).length;
  const interruptedWriteObserved =
    interrupted &&
    committedWrites === 1 &&
    own.some(
      (entry) =>
        entry.transport === "http" &&
        entry.collection === "docs" &&
        entry.action === "publish" &&
        entry.committed === true &&
        entry.text === handoff,
    );
  const deniedCallObserved = denied && forbiddenCalls === 0;
  const readBack =
    observedText === handoff &&
    own.some(
      (entry) => entry.transport === "http" && entry.action === "read" && entry.text === handoff,
    );
  const passed = interruptedWriteObserved && deniedCallObserved && readBack;
  return {
    passed,
    interruptedWriteObserved,
    deniedCallObserved,
    committedWrites,
    forbiddenCalls,
    summary: passed
      ? "Denied access stayed local; the interrupted write committed once and was recovered by reading."
      : "MCP preflight did not establish denial, single-write, and readback evidence.",
  };
}

/** Run through the same execution service as the managers, without calling a model. */
export async function runMcpPreflight({ state, token, executionToken }) {
  const { emptyTagContextPlan } = await import("supertag-ai/core");
  const { SharedExecutionEnvironmentProvider } = await import(
    "supertag-ai/environments/shared-execution"
  );
  const { connectExecutionEnvironmentMcpClient } = await import("supertag-ai/worker");
  const taskId = "mcp-preflight";
  const attemptId = randomUUID();
  const capturedAt = new Date().toISOString();
  const origin = {
    tagRouteId: "example-preflight",
    surfaceAccountId: "example",
    provider: "cli",
    scope: "preflight",
  };
  const profile = {
    ref: { id: "mcp-preflight", revision: "1" },
    workerType: "example-preflight",
    harness: { provider: "none" },
    execution: { provider: "shared-execution:shared-organization", lifetime: { scope: "attempt" } },
  };
  const task = {
    version: 2,
    taskId,
    attemptId,
    tag: { id: "mcp-probe", name: "MCP preflight" },
    input: {
      origin: {
        surface: "cli",
        accountId: "example",
        scope: "preflight",
        sessionKey: attemptId,
        occurredAt: capturedAt,
      },
      messages: [
        {
          id: "preflight",
          role: "requester",
          text: "Verify MCP denial and interrupted-write evidence.",
        },
      ],
    },
    execution: {},
    workerProfile: profile.ref,
    contextPlan: emptyTagContextPlan(capturedAt),
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "mcp-probe", name: "MCP preflight" },
      origin,
      requester: { id: "example", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
  };
  const plan = {
    files: [],
    mounts: [],
    secretBindings: [],
    environmentVariables: {},
    network: { mode: "unrestricted" },
  };
  const provider = new SharedExecutionEnvironmentProvider({
    baseUrl: state.executionUrl,
    adminToken: executionToken,
    environmentId: "shared-organization",
    requestTimeoutMs: 10000,
    guarantees: {
      filesystemIsolation: "sandbox",
      networkPolicy: "none",
      processTreeTermination: true,
      scopedHttp: false,
    },
  });
  const environment = await provider.provision({ task, profile, plan });
  const input = exampleMcpInputs({ actor: "probe", taskId, attemptId, token }).find(
    (candidate) => candidate.binding.kind === "mcp-http",
  );
  let connection;
  const closeConnection = async () => {
    const current = connection;
    connection = undefined;
    await current?.close();
  };
  const failures = [];
  let evidence;
  try {
    await environment.prepare(plan);
    connection = await connectExecutionEnvironmentMcpClient(environment, input, {
      timeoutMs: 5000,
    });
    const denial = await connection.callTool("exchange", { collection: "private", action: "read" });
    const denied = denial?.isError === true;
    let interrupted = false;
    try {
      await connection.callTool("exchange", {
        collection: "docs",
        action: "publish",
        text: handoff,
      });
    } catch {
      interrupted = true;
    }
    // Never replay a write whose response was lost. Inspect through a fresh session instead.
    await closeConnection();
    connection = await connectExecutionEnvironmentMcpClient(environment, input, {
      timeoutMs: 5000,
    });
    const result = await connection.callTool("exchange", { collection: "docs", action: "read" });
    const observedText = (result?.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    await closeConnection();
    evidence = evaluateMcpPreflight({
      entries: await readMcpEvidence(state),
      taskId,
      attemptId,
      denied,
      interrupted,
      observedText,
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await closeConnection();
  } catch (error) {
    failures.push(error);
  }
  try {
    await environment.dispose(evidence?.passed ? "completed" : "failed");
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "MCP preflight or its cleanup could not be confirmed");
  return evidence;
}
