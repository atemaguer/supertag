import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionCleanupError,
  type ExecutionContext,
  type ExecutionEnvironment,
  InMemorySessionStateStore,
} from "@supertag/worker-sdk";
import { expect, test, vi } from "vitest";
import { repositoryAttempt } from "../../../../tests/support/repository-execution.js";
import { CodexHarness } from "./src/index.js";

const mocks = vi.hoisted(() => ({ proxy: vi.fn(), native: vi.fn() }));
vi.mock("@supertag/worker-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startMcpPolicyProxy: mocks.proxy,
  assertHarnessMcpPolicyEnforceable: () => {},
}));
vi.mock("./src/app-server.js", () => ({ startCodexAppServer: mocks.native }));
test("partial proxy startup drains successful peers and sanitizes aggregated cleanup failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cleanup-"));
  try {
    const authFile = join(directory, "auth.json");
    await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: "private-key" }));
    const harness = new CodexHarness({
      workspace: directory,
      authFile,
      executionMode: "app-server",
      maxTokens: 5_000,
    });
    const original = repositoryAttempt("cleanup");
    const attempt = {
      ...original,
      execution: {
        ...original.execution,
        limits: { maxNativeAgents: 0, maxReportedTokens: 1_234 },
      },
      input: {
        ...original.input,
        messages: [{ id: "question", role: "requester" as const, text: "Inspect this" }],
      },
    };
    const context: ExecutionContext = {
      attempt,
      profile: {
        ref: attempt.workerProfile,
        workerType: "supertag",
        harness: { provider: "codex" },
        execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
      },
      context: { instructions: [], skills: [], history: [], resources: [] },
      tools: [],
      secrets: [],
      sessionStates: [],
      extensions: [],
      sessionStateStore: new InMemorySessionStateStore(),
    };
    const prepare = vi.fn(async () => {});
    const environment: ExecutionEnvironment = {
      id: "test",
      placement: "remote",
      rootDirectory: directory,
      resolvePath: (path) => join(directory, path),
      prepare,
      read: async () => "",
      spawn: async () => {
        throw Error("unexpected");
      },
      dispose: async () => {},
    };
    const environments = { runtime: environment, execution: environment };
    const plan = await harness.plan(context);
    const tools = ["one", "two"].map((name) => ({
      id: name,
      binding: { kind: "mcp-http", name },
    })) as unknown as ExecutionContext["tools"];
    const routedPlan = (
      inputs: ExecutionContext["tools"],
      client: "harness-runtime" | "worker-host" = "harness-runtime",
    ) => ({
      ...plan,
      metadata: {
        ...plan.metadata,
        mcpRoutes: inputs.map((tool) => ({
          inputId: tool.id,
          client,
          transport: tool.binding.kind,
        })),
      },
    });
    const close = vi.fn(async () => {
      throw new Error("close private-key");
    });
    mocks.proxy
      .mockResolvedValueOnce({ url: "http://localhost", close })
      .mockRejectedValueOnce(new Error("startup private-key"));
    const error = await harness
      .start(routedPlan(tools), environments, { ...context, tools })
      .catch((error) => error);
    expect(close).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(ExecutionCleanupError);
    expect(error.message).toContain("startup [REDACTED]");
    expect(error.message).toContain("close [REDACTED]");
    expect(error.message).not.toContain("private-key");
    mocks.proxy.mockResolvedValueOnce({ url: "http://localhost", close });
    mocks.native.mockResolvedValueOnce({
      close: async () => {
        throw new ExecutionCleanupError("native private-key");
      },
    });
    const execution = await harness.start(routedPlan(tools.slice(0, 1)), environments, {
      ...context,
      tools: tools.slice(0, 1),
    });
    expect(mocks.native.mock.calls.at(-1)?.[0].args.join(" ")).not.toContain(
      "agents.default_subagent_model",
    );
    expect(mocks.native.mock.calls.at(-1)?.[0]).toMatchObject({
      limits: { maxAgents: 0, maxTokens: 1_234 },
    });
    expect(mocks.native.mock.calls.at(-1)?.[0].args).toContain(
      "agents.max_concurrent_threads_per_session=1",
    );
    const cleanupError = await execution.close?.().catch((error) => error);
    expect(cleanupError).toBeInstanceOf(ExecutionCleanupError);
    expect(cleanupError.message).toContain("native [REDACTED]");
    expect(cleanupError.message).toContain("close [REDACTED]");
    expect(close).toHaveBeenCalledTimes(2);

    mocks.native.mockResolvedValueOnce({ close: vi.fn(async () => {}) });
    const defaultAttempt = {
      ...attempt,
      execution: { harness: "codex" },
    };
    const defaultContext = { ...context, attempt: defaultAttempt };
    const defaultExecution = await harness.start(
      await harness.plan(defaultContext),
      environments,
      defaultContext,
    );
    expect(mocks.native.mock.calls.at(-1)?.[0]).toMatchObject({
      limits: { maxAgents: 0, maxTokens: 5_000 },
    });
    expect(mocks.native.mock.calls.at(-1)?.[0].args).toEqual(
      expect.arrayContaining([
        "agents.enabled=false",
        "agents.max_concurrent_threads_per_session=1",
      ]),
    );
    await defaultExecution.close?.();

    mocks.native.mockResolvedValueOnce({ close: vi.fn(async () => {}) });
    const managerTool = {
      id: "supertag-coordination",
      kind: "tool",
      required: true,
      audience: "manager",
      capability: {
        id: "supertag-coordination",
        provider: "supertag",
        operations: [{ name: "start_session", effect: "write", actions: ["sessions:start"] }],
        authorization: { provider: "supertag", resources: [] },
      },
      binding: {
        kind: "mcp-http",
        name: "supertag-coordination",
        url: "https://control-plane.example/internal/v1/coordination/mcp",
        runtimeHeaders: { Authorization: "Bearer manager-secret" },
      },
    } as const;
    const isolated = await harness.start(routedPlan([managerTool], "worker-host"), environments, {
      ...context,
      tools: [managerTool],
    });
    const isolatedRequest = mocks.native.mock.calls.at(-1)?.[0];
    expect(isolatedRequest).toMatchObject({
      limits: { maxAgents: 0, maxTokens: 1_234 },
      request: { mcpServers: [], toolInputs: [managerTool] },
    });
    expect(isolatedRequest.args).toEqual(
      expect.arrayContaining([
        "agents.enabled=false",
        "features.multi_agent=false",
        "features.multi_agent_v2=false",
        "features.enable_fanout=false",
      ]),
    );
    expect(isolatedRequest.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(JSON.stringify(isolatedRequest.args)).not.toContain("supertag-coordination");
    expect(JSON.stringify(isolatedRequest.processEnvironment)).not.toContain("manager-secret");
    expect(prepare.mock.calls.at(-1)?.[0].files).toEqual([
      expect.objectContaining({ path: ".codex/auth.json", mode: 0o600 }),
    ]);
    expect(mocks.proxy).toHaveBeenCalledTimes(3);
    await isolated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
