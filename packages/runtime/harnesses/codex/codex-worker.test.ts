import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ContextResolverRegistry,
  collectTaskAttemptEvents,
  EXECUTION_WARNING_SUMMARY,
  type ExecutionContext,
  type ExecutionEnvironment,
  type ExecutionEnvironmentProvider,
  FINDINGS_INSTRUCTION,
  FileSkillResolver,
  InMemorySessionStateStore,
  PROCESS_OUTPUT_STREAMING_CAPABILITY,
  type ProcessSpec,
  type TaskAttemptSpec,
  type ToolInput,
  ToolProviderRegistry,
  terminalOutputText,
  terminalTaskResult,
  WorkspaceResolverRegistry,
} from "@supertag/worker-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileArtifactStore } from "../../../../tests/support/file-artifact-store.js";
import { assertConformance, runHarnessConformance } from "../../sdk/src/conformance.ts";
import * as codexAppServer from "./src/app-server.js";
import {
  CodexHarness,
  codexInformationRetrievalPrompt,
  createCodexWorker,
  runCodex,
  taskProgressFromCodexTodo,
} from "./src/index.ts";

let outputStateDirectory: string;
let priorStateDirectory: string | undefined;
let fakeCodexHome: string;
beforeEach(async () => {
  priorStateDirectory = process.env["SUPERTAG_STATE_DIR"];
  outputStateDirectory = await mkdtemp(join(tmpdir(), "supertag-harness-output-state-"));
  process.env["SUPERTAG_STATE_DIR"] = outputStateDirectory;
  // Local Codex runs copy the operator's sign-in; never read the developer's real ~/.codex.
  fakeCodexHome = await mkdtemp(join(tmpdir(), "supertag-fake-codex-home-"));
  await writeFile(
    join(fakeCodexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "test-codex-key" }),
  );
  vi.stubEnv("CODEX_HOME", fakeCodexHome);
  vi.stubEnv("CODEX_API_KEY", undefined);
  vi.stubEnv("OPENAI_API_KEY", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (priorStateDirectory === undefined) delete process.env["SUPERTAG_STATE_DIR"];
  else process.env["SUPERTAG_STATE_DIR"] = priorStateDirectory;
  await rm(outputStateDirectory, { recursive: true, force: true });
  await rm(fakeCodexHome, { recursive: true, force: true });
});

const fixtureWorkspace = await mkdtemp(join(tmpdir(), "codex-workspace-"));
afterAll(() => rm(fixtureWorkspace, { recursive: true, force: true }));

it("records provider provenance when the local Codex login is missing", async () => {
  await rm(join(fakeCodexHome, "auth.json"));
  const worker = createCodexWorker({ workspace: fixtureWorkspace });
  const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Check sign-in")));
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "execution.failed",
      error: expect.objectContaining({
        name: "HarnessProviderError",
        message: "Codex SDK requires OPENAI_API_KEY, CODEX_API_KEY, or a file-backed Codex sign-in",
      }),
    }),
  );
});

it.each(["git Authentication failed", "MCP server: Please run codex login"])(
  "does not stamp dependency errors as provider failures: %s",
  async (message) => {
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      runner: async function* () {
        yield* [];
        throw new Error(message);
      },
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(taskAttemptSpec("Check dependency")),
    );
    expect(events.at(-1)).toMatchObject({
      type: "execution.failed",
      error: { name: "Error", message },
    });
  },
);

it.each(["turn.failed", "error"])(
  "preserves Codex provider provenance for %s events",
  async (type) => {
    const message = "Unexpected status 401 Unauthorized";
    const environment: ExecutionEnvironment = {
      ...conformanceEnvironment(fixtureWorkspace),
      placement: "remote",
      spawn: async () => ({
        output: (async function* () {
          yield {
            stream: "stdout" as const,
            text: `${JSON.stringify(type === "error" ? { type, message } : { type, error: { message } })}\n`,
          };
        })(),
        wait: async () => ({ exitCode: 0 }),
        kill: async () => {},
      }),
    };
    await expect(
      (async () => {
        for await (const _event of runCodex(
          {
            prompt: "Check login",
            workspace: fixtureWorkspace,
            timeoutMs: 1000,
            command: "codex",
            mcpServers: [],
            runtimeActions: [],
            toolInputs: [],
          },
          environment,
        )) {
          /* consume */
        }
      })(),
    ).rejects.toMatchObject({
      name: "HarnessProviderError",
      message: `Codex SDK failed: ${message}`,
    });
  },
);

it.each(["gpt-5.4", undefined])(
  "reports cumulative exec tokens and estimated cost with model %s",
  async (model) => {
    const environment: ExecutionEnvironment = {
      ...conformanceEnvironment(fixtureWorkspace),
      placement: "remote",
      spawn: async () => ({
        output: (async function* () {
          yield {
            stream: "stdout" as const,
            text: `${[
              { type: "thread.started", thread_id: "cost-thread" },
              {
                type: "turn.completed",
                usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
              },
              {
                type: "item.completed",
                item: { id: "answer", type: "agent_message", text: "Done" },
              },
              {
                type: "turn.completed",
                usage: { input_tokens: 200, cached_input_tokens: 30, output_tokens: 20 },
              },
            ]
              .map((event) => JSON.stringify(event))
              .join("\n")}\n`,
          };
        })(),
        wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        kill: () => {},
      }),
    };
    const events = [];
    for await (const event of runCodex(
      {
        prompt: "Finish",
        workspace: fixtureWorkspace,
        timeoutMs: 1000,
        command: "codex",
        model,
        mcpServers: [],
        runtimeActions: [],
        toolInputs: [],
      },
      environment,
    ))
      events.push(event);
    expect(events.filter((event) => event.type === "usage.updated")).toEqual([
      {
        type: "usage.updated",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 10,
          totalTokens: 110,
          complete: true,
          reportedCost: { amountMinor: 1, currency: "USD", estimated: true },
        },
      },
      {
        type: "usage.updated",
        usage: {
          inputTokens: 300,
          cachedInputTokens: 50,
          outputTokens: 30,
          totalTokens: 330,
          complete: true,
          reportedCost: { amountMinor: 1, currency: "USD", estimated: true },
        },
      },
    ]);
  },
);

it.each([true, false])(
  "ignores empty native messages without inventing final text (answer=%s)",
  async (answer) => {
    const environment: ExecutionEnvironment = {
      ...conformanceEnvironment(fixtureWorkspace),
      placement: "remote",
      spawn: async () => ({
        output: (async function* () {
          const events = [
            { type: "thread.started", thread_id: "empty-intermediate-thread" },
            ...["", " \n\t"].map((text, id) => ({
              type: "item.completed",
              item: { id: String(id), type: "agent_message", text },
            })),
            ...(answer
              ? [
                  {
                    type: "item.completed",
                    item: { id: "final", type: "agent_message", text: "READY" },
                  },
                ]
              : []),
            { type: "turn.completed", usage: {} },
          ];
          yield {
            stream: "stdout" as const,
            text: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
          };
        })(),
        wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        kill: () => {},
      }),
    };
    const collect = async () => {
      const events = [];
      for await (const event of runCodex(
        {
          prompt: "Reply READY",
          workspace: fixtureWorkspace,
          timeoutMs: 1000,
          command: "codex",
          mcpServers: [],
          runtimeActions: [],
          toolInputs: [],
        },
        environment,
      ))
        events.push(event);
      return events;
    };
    if (answer) {
      const events = await collect();
      expect(events.filter((event) => event.type === "output.message")).toEqual([
        { type: "output.message", text: "READY" },
      ]);
      expect(events.at(-1)).toEqual({
        type: "codex.thread.completed",
        threadId: "empty-intermediate-thread",
      });
    } else await expect(collect()).rejects.toThrow("completed without a final response");
  },
);

it.each(["failed", "completed"] as const)(
  "preserves a %s Codex MCP call with a null result and completes the turn",
  async (status) => {
    const originalError = "Attempt authority expired after Objective completion";
    const environment: ExecutionEnvironment = {
      ...conformanceEnvironment(fixtureWorkspace),
      placement: "remote",
      spawn: async () => ({
        output: (async function* () {
          const startedItem = {
            id: "coordination-call",
            type: "mcp_tool_call",
            server: "coordination-tools",
            tool: "read_team_context",
            arguments: {},
          };
          const events = [
            { type: "thread.started", thread_id: "null-result-thread" },
            { type: "item.started", item: { ...startedItem, status: "in_progress" } },
            {
              type: "item.completed",
              item: {
                ...startedItem,
                // Codex CLI normalizes this server name between the paired events.
                server: "coordination_tools",
                status,
                result: null,
                ...(status === "failed" ? { error: { message: originalError } } : {}),
              },
            },
            {
              type: "item.completed",
              item: { id: "answer", type: "agent_message", text: "Objective completed." },
            },
            {
              type: "turn.completed",
              usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
            },
          ];
          yield {
            stream: "stdout" as const,
            text: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
          };
        })(),
        wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        kill: () => {},
      }),
    };
    const events = [];
    for await (const event of runCodex(
      {
        prompt: "Complete the Objective",
        workspace: fixtureWorkspace,
        timeoutMs: 1000,
        command: "codex",
        mcpServers: [],
        runtimeActions: [],
        toolInputs: [
          {
            id: "coordination",
            kind: "tool",
            required: true,
            capability: {
              id: "supertag.coordination",
              provider: "supertag",
              operations: [{ name: "read_team_context", effect: "read", actions: [] }],
              authorization: { provider: "supertag", resources: [] },
            },
            binding: {
              kind: "mcp-http",
              name: "coordination-tools",
              url: "http://127.0.0.1/mcp",
            },
          },
        ],
      },
      environment,
    ))
      events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "codex.thread.started",
      "tool.call.started",
      `tool.call.${status}`,
      "output.message",
      "usage.updated",
      "codex.thread.completed",
    ]);
    if (status === "failed") expect(events[2]).toMatchObject({ error: { message: originalError } });
    else expect(events[2]).not.toHaveProperty("outcome");
    expect(events.at(-1)).toEqual({
      type: "codex.thread.completed",
      threadId: "null-result-thread",
    });
  },
);

it("attributes a completed-only MCP event using Codex's normalized server name", async () => {
  const environment: ExecutionEnvironment = {
    ...conformanceEnvironment(fixtureWorkspace),
    placement: "remote",
    spawn: async () => ({
      output: (async function* () {
        const events = [
          { type: "thread.started", thread_id: "normalized-thread" },
          {
            type: "item.completed",
            item: {
              id: "coordination-call",
              type: "mcp_tool_call",
              server: "coordination_tools",
              tool: "read_team_context",
              arguments: {},
              status: "failed",
              result: null,
            },
          },
          {
            type: "item.started",
            item: {
              id: "rejected-probe",
              type: "mcp_tool_call",
              server: "coordination_tools",
              tool: "list_mcp_resources",
              arguments: {},
              status: "in_progress",
            },
          },
          {
            type: "item.completed",
            item: {
              id: "rejected-probe",
              type: "mcp_tool_call",
              server: "coordination_tools",
              tool: "list_mcp_resources",
              arguments: {},
              status: "failed",
              result: null,
            },
          },
          { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } },
          { type: "turn.completed", usage: {} },
        ];
        yield {
          stream: "stdout" as const,
          text: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        };
      })(),
      wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      kill: () => {},
    }),
  };
  const events = [];
  for await (const event of runCodex(
    {
      prompt: "Complete the Objective",
      workspace: fixtureWorkspace,
      timeoutMs: 1000,
      command: "codex",
      mcpServers: [],
      runtimeActions: [],
      toolInputs: [
        {
          id: "coordination",
          kind: "tool",
          required: true,
          capability: {
            id: "supertag.coordination",
            provider: "supertag",
            operations: [{ name: "read_team_context", effect: "read", actions: [] }],
            authorization: { provider: "supertag", resources: [] },
          },
          binding: {
            kind: "mcp-http",
            name: "coordination-tools",
            url: "http://127.0.0.1/mcp",
          },
        },
      ],
    },
    environment,
  ))
    events.push(event);

  expect(events[1]).toMatchObject({
    type: "tool.call.failed",
    call: { binding: { name: "coordination-tools" } },
  });
  expect(events[2]).toMatchObject({
    type: "tool.call.started",
    call: {
      binding: { name: "coordination-tools" },
      operation: "list_mcp_resources",
      effect: "write",
      actions: [],
    },
  });
  expect(events[3]).toMatchObject({
    type: "tool.call.failed",
    call: {
      binding: { name: "coordination-tools" },
      operation: "list_mcp_resources",
      effect: "write",
      actions: [],
    },
  });
});

it.each(["failed", "completed"] as const)(
  "ignores an unavailable MCP discovery probe that is %s by Codex",
  async (status) => {
    const environment: ExecutionEnvironment = {
      ...conformanceEnvironment(fixtureWorkspace),
      placement: "remote",
      spawn: async () => ({
        output: (async function* () {
          const events = [
            { type: "thread.started", thread_id: "unavailable-server-thread" },
            {
              type: "item.started",
              item: {
                id: "unavailable-call",
                type: "mcp_tool_call",
                server: "codex",
                tool: "list_mcp_resources",
                arguments: {},
                status: "in_progress",
              },
            },
            {
              type: "item.completed",
              item: {
                id: "unavailable-call",
                type: "mcp_tool_call",
                server: "codex",
                tool: "list_mcp_resources",
                arguments: {},
                status,
                result: null,
              },
            },
            { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } },
            { type: "turn.completed", usage: {} },
          ];
          yield {
            stream: "stdout" as const,
            text: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
          };
        })(),
        wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        kill: () => {},
      }),
    };
    const events = [];
    for await (const event of runCodex(
      {
        prompt: "Complete the Objective",
        workspace: fixtureWorkspace,
        timeoutMs: 1000,
        command: "codex",
        mcpServers: [],
        runtimeActions: [],
        toolInputs: [],
      },
      environment,
    ))
      events.push(event);

    expect(events).toEqual([
      { type: "codex.thread.started", threadId: "unavailable-server-thread" },
      { type: "output.message", text: "done" },
      { type: "codex.thread.completed", threadId: "unavailable-server-thread" },
    ]);
  },
);

it("reports Codex exec shell commands as they start and end", async () => {
  const environment: ExecutionEnvironment = {
    ...conformanceEnvironment(fixtureWorkspace),
    placement: "remote",
    spawn: async () => ({
      output: (async function* () {
        const command = (status: string, exit?: number) => ({
          id: "cmd-1",
          type: "command_execution",
          command: "pnpm test:verify",
          aggregated_output: "",
          status,
          ...(exit === undefined ? {} : { exit_code: exit }),
        });
        const events = [
          { type: "thread.started", thread_id: "command-thread" },
          { type: "item.started", item: command("in_progress") },
          { type: "item.completed", item: command("completed", 0) },
          { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } },
          { type: "turn.completed", usage: {} },
        ];
        yield {
          stream: "stdout" as const,
          text: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        };
      })(),
      wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      kill: () => {},
    }),
  };
  const events = [];
  for await (const event of runCodex(
    {
      prompt: "Run the tests",
      workspace: fixtureWorkspace,
      timeoutMs: 1000,
      command: "codex",
      mcpServers: [],
      runtimeActions: [],
      toolInputs: [],
    },
    environment,
  ))
    events.push(event);
  expect(events.filter((event) => event.type === "command.updated")).toEqual([
    {
      type: "command.updated",
      command: { id: "cmd-1", command: "pnpm test:verify", status: "running" },
    },
    {
      type: "command.updated",
      command: { id: "cmd-1", command: "pnpm test:verify", status: "completed" },
    },
  ]);
});

describe("Codex harness composition", () => {
  it("maps Codex todo lists to bounded user-facing progress", () => {
    expect(
      taskProgressFromCodexTodo({
        id: "todo-1",
        type: "todo_list",
        items: [
          { text: "Inspect the Control Plane", completed: true },
          { text: "Trace Slack delivery", completed: false },
          { text: "Verify the final update", completed: false },
        ],
      }),
    ).toEqual({
      summary: "Working through the plan",
      items: [
        { id: "todo-1:0", text: "Inspect the Control Plane", status: "completed" },
        { id: "todo-1:1", text: "Trace Slack delivery", status: "active" },
        { id: "todo-1:2", text: "Verify the final update", status: "pending" },
      ],
    });
  });

  it("selects the artifact store for the current Attempt and exports its bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-worker-artifact-"));
    try {
      await writeFile(join(directory, "result.txt"), "reviewed output");
      const store = new FileArtifactStore(join(directory, "artifacts"));
      const artifactStore = vi.fn(() => store);
      const worker = createCodexWorker({
        workspace: directory,
        artifactStore,
        outputs: [{ path: "result.txt", mediaType: "text/plain" }],
        runner: async function* () {
          yield { type: "output.message", text: "done" };
        },
      });
      const attempt = taskAttemptSpec("Export reviewed output");
      const events = await collectTaskAttemptEvents(worker.execute(attempt));
      expect(events.at(-1)?.type).toBe("execution.completed");
      expect(artifactStore).toHaveBeenCalledExactlyOnceWith(attempt);
      const output = events.find((event) => event.type === "artifact.created");
      expect(output).toBeDefined();
      if (output?.type !== "artifact.created") throw new Error("Missing artifact export");
      expect(Buffer.from(await store.get(output.artifact)).toString()).toBe("reviewed output");
      expect(output.artifact.mediaType).toBe("text/plain");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("declares generated Codex home sources separately from Git workspaces and session state", async () => {
    const harness = new CodexHarness({ workspace: fixtureWorkspace });
    const plan = await harness.plan(emptyExecutionContext(taskAttemptSpec("Create a report")));
    expect(plan.artifactSources).toEqual([
      {
        id: "codex-memories",
        directory: ".codex/memories",
        include: ["**"],
        category: "memory",
        submit: true,
        restore: true,
      },
      {
        id: "codex-generated-images",
        directory: ".codex/generated_images",
        include: ["**"],
        category: "media",
        bundleDepth: 1,
        submit: true,
      },
      {
        id: "codex-visualizations",
        directory: ".codex/visualizations",
        include: ["**"],
        category: "visualization",
        bundleDepth: 4,
        submit: true,
      },
      {
        id: "codex-authored-skills",
        directory: ".codex/skills",
        include: ["**"],
        exclude: [".system/**"],
        category: "capability",
        bundleDepth: 1,
      },
    ]);
    expect(plan.artifactSources?.some((source) => source.directory === fixtureWorkspace)).toBe(
      false,
    );
  });

  it("allows disabling or replacing artifact sources without retaining caller mutations", async () => {
    const context = emptyExecutionContext(taskAttemptSpec("Create a report"));
    expect(
      (await new CodexHarness({ workspace: fixtureWorkspace, artifactSources: [] }).plan(context))
        .artifactSources,
    ).toEqual([]);
    const sources = [
      {
        id: "reports",
        directory: ".codex/reports",
        include: ["*.html"],
        exclude: ["private.html"],
        category: "report",
      },
    ];
    const harness = new CodexHarness({ workspace: fixtureWorkspace, artifactSources: sources });
    sources[0]?.include.push("**");
    sources[0]?.exclude.push("other.html");
    const first = await harness.plan(context);
    expect(first.artifactSources?.[0]?.include).toEqual(["*.html"]);
    expect(first.artifactSources?.[0]?.exclude).toEqual(["private.html"]);
    const returnedSource = first.artifactSources?.[0];
    if (!returnedSource) throw new Error("Missing source");
    (returnedSource.include as string[]).push("**");
    expect((await harness.plan(context)).artifactSources?.[0]?.include).toEqual(["*.html"]);
  });

  it("passes the shared Harness conformance contract", async () => {
    const harness = new CodexHarness({
      workspace: fixtureWorkspace,
      runner: async function* () {
        yield { type: "output.message", text: "conformant Codex response" };
      },
    });
    const context = emptyExecutionContext(taskAttemptSpec("Explain the runtime."));
    const report = await runHarnessConformance({
      harness,
      context,
      executionEnvironment: conformanceEnvironment(fixtureWorkspace),
      expectedInputKinds: ["instruction", "skill", "tool", "history", "workspace"],
    });

    expect(report.passed).toBe(true);
    expect(() => assertConformance(report)).not.toThrow();
  });

  it("asks Codex reviewers for findings and parses them from the result", async () => {
    let observed = "";
    const runner = vi.fn(async function* ({ prompt }: { readonly prompt: string }) {
      observed = prompt;
      yield {
        type: "output.message" as const,
        text: "Reviewed.\nFinding: high | The query skips tenant scoping. | src/query.ts:42\nFinding: low | A comment is stale.",
      };
    });
    const worker = createCodexWorker({ workspace: fixtureWorkspace, runner });
    const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Review it.")));

    expect(observed).toContain(FINDINGS_INSTRUCTION);
    expect(terminalTaskResult(events).findings).toEqual([
      {
        id: "F1",
        severity: "high",
        summary: "The query skips tenant scoping.",
        location: "src/query.ts:42",
        status: "open",
      },
      { id: "F2", severity: "low", summary: "A comment is stale.", status: "open" },
    ]);
  });

  it("runs Codex through a Worker and a local execution environment", async () => {
    const runner = vi.fn(async function* ({ prompt }: { readonly prompt: string }) {
      yield {
        type: "output.message" as const,
        text: prompt.includes("durable inbox")
          ? "The durable inbox is implemented by DurableInboundEvent."
          : "Tags are resolved from configured surfaces.",
      };
    });
    const worker = createCodexWorker({ workspace: fixtureWorkspace, runner });

    const first = await collectTaskAttemptEvents(
      worker.execute(taskAttemptSpec("How does the durable inbox work?")),
    );
    const second = await collectTaskAttemptEvents(
      worker.execute(taskAttemptSpec("How are Tags resolved?")),
    );

    expect(terminalOutputText(first)).toBe(
      "The durable inbox is implemented by DurableInboundEvent.",
    );
    expect(terminalOutputText(second)).toBe("Tags are resolved from configured surfaces.");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(first.map((event) => event.type)).toEqual([
      "execution.started",
      "execution.limits.applied",
      "runtime-inputs.resolved",
      "output.message",
      "result",
      "execution.completed",
    ]);
  });

  it("executes a coordinated Task through a remote environment and real Harness process adapter", async () => {
    let processSpec: ProcessSpec | undefined;
    const dispose = vi.fn(async () => {});
    const prepare = vi.fn(async () => {});
    const remote = {
      id: "remote:test",
      placement: "remote",
      rootDirectory: "/workspace",
      resolvePath: (path: string) => `/workspace/${path}`,
      prepare,
      prepareOutputDirectory: async () => {},
      dispose,
      read: async () => "remote coordinated result",
      listOutputFiles: async () => [],
      readBytes: async () => new Uint8Array(),
      spawn: async (spec: ProcessSpec) => {
        processSpec = spec;
        return {
          output: (async function* () {
            yield {
              stream: "stdout" as const,
              text: `${[
                { type: "thread.started", thread_id: "remote-thread" },
                {
                  type: "item.completed",
                  item: { id: "answer", type: "agent_message", text: "remote coordinated result" },
                },
                {
                  type: "turn.completed",
                  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
                },
              ]
                .map((event) => JSON.stringify(event))
                .join("\n")}\n`,
            };
          })(),
          wait: async () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              type: "result",
              subtype: "success",
              result: "remote coordinated result",
            }),
          }),
          kill: () => {},
        };
      },
    } as unknown as ExecutionEnvironment;
    const environment: ExecutionEnvironmentProvider = {
      id: "remote-test",
      capabilities: [PROCESS_OUTPUT_STREAMING_CAPABILITY],
      provision: async () => remote,
    };
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      executionEnvironment: environment,
    });
    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...taskAttemptSpec("Coordinate"),
        coordination: {
          controlPlaneUrl: "https://control-plane.example",
          token: "remote-attempt-secret",
          objectiveId: "objective-1",
        },
      }),
    );
    expect(terminalOutputText(events)).toBe("remote coordinated result");
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        network: {
          mode: "allowlist",
          allowedHosts: ["api.openai.com", "chatgpt.com", "control-plane.example"],
        },
      }),
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(processSpec?.args)).not.toContain("remote-attempt-secret");
    expect(JSON.stringify(processSpec?.environment)).toContain("remote-attempt-secret");
    expect(JSON.stringify(events)).not.toContain("remote-attempt-secret");
    expect(processSpec?.stdin).toContain("Coordinate");
    const task = taskAttemptSpec("Coordinate");
    expect(processSpec?.stdin).toContain(`Task ${JSON.stringify(task.taskId)}`);
    expect(processSpec?.stdin).toContain(`Attempt ${JSON.stringify(task.attemptId)}`);
    expect(processSpec?.stdin).toContain("Do not wait for or reassign your own Task");
  });

  it("keeps local Control Plane coordination credentials behind the recovery-aware Worker proxy", async () => {
    let processSpec: ProcessSpec | undefined;
    const local = {
      id: "local:test",
      placement: "local",
      rootDirectory: fixtureWorkspace,
      resolvePath: (path: string) => join(fixtureWorkspace, path),
      prepare: async () => {},
      prepareOutputDirectory: async () => {},
      dispose: async () => {},
      read: async () => "local coordinated result",
      listOutputFiles: async () => [],
      readBytes: async () => new Uint8Array(),
      spawn: async (spec: ProcessSpec) => {
        processSpec = spec;
        return {
          output: (async function* () {
            yield {
              stream: "stdout" as const,
              text: `${[
                { type: "thread.started", thread_id: "local-thread" },
                {
                  type: "item.completed",
                  item: { id: "answer", type: "agent_message", text: "local coordinated result" },
                },
                { type: "turn.completed", usage: {} },
              ]
                .map((event) => JSON.stringify(event))
                .join("\n")}\n`,
            };
          })(),
          wait: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
          kill: () => {},
        };
      },
    } as unknown as ExecutionEnvironment;
    const environment: ExecutionEnvironmentProvider = {
      id: "local-test",
      capabilities: [PROCESS_OUTPUT_STREAMING_CAPABILITY],
      provision: async () => local,
    };
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      executionEnvironment: environment,
      command: "custom-codex",
    });

    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...taskAttemptSpec("Coordinate"),
        coordination: {
          controlPlaneUrl: "http://127.0.0.1:54321",
          token: "local-attempt-secret",
          objectiveId: "objective-1",
        },
      }),
    );

    expect(terminalOutputText(events)).toBe("local coordinated result");
    const command = JSON.stringify(processSpec);
    expect(command).toContain("mcp_servers.supertag-coordination.url");
    expect(command).toMatch(/127\.0\.0\.1:\d+\/mcp/u);
    expect(command).not.toContain("127.0.0.1:54321");
    expect(command).not.toContain("local-attempt-secret");
  });

  it("injects Control Plane coordination without leaking credentials into events", async () => {
    const runner = vi.fn(async function* (request: { readonly mcpServers: readonly unknown[] }) {
      expect(request.mcpServers).toEqual([
        expect.objectContaining({
          name: "supertag-coordination",
          url: "https://control-plane.example/internal/v1/coordination/mcp",
          headers: { Authorization: "Bearer attempt-secret" },
          toolNames: expect.arrayContaining(["assign_task", "create_team"]),
        }),
      ]);
      yield { type: "output.message" as const, text: "accidental attempt-secret" };
    });
    const worker = createCodexWorker({ workspace: fixtureWorkspace, runner });
    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...taskAttemptSpec("Coordinate"),
        coordination: {
          controlPlaneUrl: "https://control-plane.example",
          token: "attempt-secret",
          objectiveId: "objective-1",
        },
      }),
    );
    expect(runner).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toContain("attempt-secret");
    expect(terminalOutputText(events)).toContain("[REDACTED]");
    expect((await worker.describe()).capabilities).toContainEqual({
      id: "supertag.coordination",
      version: 1,
    });
  });

  it("plans manager MCP tools for the Worker client in app-server mode", async () => {
    const harness = new CodexHarness({
      workspace: fixtureWorkspace,
      executionMode: "app-server",
    });
    const attempt = taskAttemptSpec("Coordinate");
    const context = { ...emptyExecutionContext(attempt), tools: [managerMcpTool()] };

    const plan = await harness.plan(context);

    expect(plan.metadata?.["mcpServers"]).toEqual([]);
    expect(plan.metadata?.["mcpRoutes"]).toEqual([
      {
        inputId: "supertag-coordination",
        client: "worker-host",
        transport: "mcp-http",
      },
    ]);
    expect((await harness.describe()).mcpClients).toEqual([
      { client: "harness-runtime", transports: ["mcp-http", "mcp-stdio"] },
      { client: "worker-host", transports: ["mcp-http", "worker-local"] },
      { client: "execution-environment", transports: ["mcp-stdio", "mcp-http"] },
    ]);
  });

  it("routes a manager stdio MCP server through the execution environment", async () => {
    const harness = new CodexHarness({
      workspace: fixtureWorkspace,
      executionMode: "app-server",
    });
    const input: ToolInput = {
      ...managerMcpTool(),
      id: "environment-manager",
      binding: {
        kind: "mcp-stdio",
        name: "environment-manager",
        command: "node",
        args: ["environment-server.cjs"],
        runtimeEnvironment: { ENVIRONMENT_TOKEN: "environment-secret-value" },
      },
    };
    const plan = await harness.plan({
      ...emptyExecutionContext(taskAttemptSpec("Use environment tools")),
      tools: [input],
    });

    expect(plan.metadata?.["mcpServers"]).toEqual([]);
    expect(plan.metadata?.["mcpRoutes"]).toEqual([
      {
        inputId: "environment-manager",
        client: "execution-environment",
        transport: "mcp-stdio",
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("ENVIRONMENT_TOKEN");
    expect(JSON.stringify(plan)).not.toContain("environment-secret-value");
  });

  it("routes HTTP MCP through the execution environment with scoped network access", async () => {
    const harness = new CodexHarness({
      workspace: fixtureWorkspace,
      executionMode: "app-server",
      selectMcpClient: () => "execution-environment",
    });
    const context = {
      ...emptyExecutionContext(taskAttemptSpec("Use environment tools")),
      tools: [managerMcpTool()],
    };

    const plan = await harness.plan(context);
    expect(plan.metadata?.["mcpServers"]).toEqual([]);
    expect(plan.metadata?.["mcpRoutes"]).toEqual([
      { inputId: context.tools[0]?.id, client: "execution-environment", transport: "mcp-http" },
    ]);
    expect(plan.execution.network).toMatchObject({ mode: "allowlist" });
  });

  it("adapts a permission-resolved hosted MCP server for Codex", async () => {
    const runner = vi.fn(async function* (request: { readonly mcpServers: readonly unknown[] }) {
      expect(request.mcpServers).toEqual([
        {
          client: "harness-runtime",
          transport: "mcp-http",
          name: "github",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "Bearer worker-secret" },
          toolNames: ["get_file_contents"],
        },
      ]);
      yield { type: "output.message" as const, text: "MCP configured" };
    });
    const toolProviders = new ToolProviderRegistry([
      {
        provider: "github",
        resolve: async () => ({
          provider: "github",
          inputs: [
            {
              id: "github-mcp",
              kind: "tool",
              required: true,
              capability: {
                id: "github:github-account",
                provider: "github",
                operations: [
                  { name: "get_file_contents", effect: "read", actions: ["contents:read"] },
                ],
                authorization: {
                  provider: "github",
                  resources: [{ surfaceAccountId: "github-account", scope: "repository:123" }],
                },
              },
              binding: {
                kind: "mcp-http",
                name: "github",
                url: "https://api.githubcopilot.com/mcp/",
                runtimeHeaders: { Authorization: "Bearer worker-secret" },
              },
            },
          ],
        }),
      },
    ]);
    const worker = createCodexWorker({ workspace: fixtureWorkspace, runner, toolProviders });

    const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Read README")));

    expect(terminalOutputText(events)).toBe("MCP configured");
    expect(events.find((event) => event.type === "runtime-inputs.resolved")).toMatchObject({
      manifest: {
        inputs: [
          { id: "supertag-scratch-directory", kind: "instruction" },
          { id: "github-mcp", kind: "tool" },
        ],
        harness: {
          provenance: {
            mcpClients: [{ client: "harness-runtime", server: "github", transport: "mcp-http" }],
          },
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain("worker-secret");
  });

  it.each([
    { actions: [], sandbox: { filesystem: "read-only", network: "none" } },
    {
      actions: ["commands:execute", "files:write"],
      sandbox: {
        filesystem: "workspace-write",
        network: "loopback",
        permissionProfile: "supertag",
      },
    },
  ])("records the Codex sandbox allowance for $actions", async ({ actions, sandbox }) => {
    const runner = vi.fn(async function* () {
      yield { type: "output.message" as const, text: "done" };
    });
    const worker = createCodexWorker({ workspace: fixtureWorkspace, runner });
    const spec = taskAttemptSpec("Run the tests");
    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...spec,
        authorization: { ...spec.authorization, runtimeActions: actions },
      }),
    );
    expect(events.find((event) => event.type === "runtime-inputs.resolved")).toMatchObject({
      manifest: { harness: { provenance: { protocol: "codex-exec", sandbox } } },
    });
  });

  it("adapts a permission-resolved stdio MCP server for Codex", async () => {
    const runner = vi.fn(async function* (request: { readonly mcpServers: readonly unknown[] }) {
      expect(request.mcpServers).toEqual([
        {
          client: "harness-runtime",
          transport: "mcp-stdio",
          name: "local_tools",
          command: "/opt/supertag/tools-server",
          args: ["--stdio"],
          environment: { TOOL_TOKEN: "worker-secret" },
          toolNames: ["lookup"],
        },
      ]);
      yield { type: "output.message" as const, text: "stdio MCP configured" };
    });
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      runner,
      toolProviders: stdioToolProviders(),
    });

    const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Lookup value")));

    expect(terminalOutputText(events)).toBe("stdio MCP configured");
    expect(JSON.stringify(events)).not.toContain("worker-secret");
  });

  it("normalizes harness tool calls into portable Task Attempt events", async () => {
    const call = {
      id: "call-1",
      capabilityId: "github:github-account",
      provider: "github",
      binding: { kind: "mcp-http" as const, name: "github" },
      operation: "add_issue_comment",
      effect: "write" as const,
      actions: ["issues:comment"],
      resources: [
        {
          surfaceAccountId: "github-account",
          scope: "repository:123",
          reference: "atemaguer/supertag",
        },
      ],
      arguments: { owner: "atemaguer", repo: "supertag", issue_number: 1 },
    };
    const runner = vi.fn(async function* () {
      yield { type: "tool.call.started" as const, call };
      yield { type: "tool.call.completed" as const, call };
      yield { type: "output.message" as const, text: "Comment posted." };
    });
    const worker = createCodexWorker({ workspace: fixtureWorkspace, runner });

    const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Post it")));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool.call.started", call }),
        expect.objectContaining({ type: "tool.call.completed", call }),
      ]),
    );
  });

  it("changes the prompt only when a write-capable tool is resolved", () => {
    const prompt = codexInformationRetrievalPrompt(
      taskAttemptSpec("Comment on issue 1"),
      undefined,
      [
        {
          id: "github-write",
          kind: "tool",
          required: true,
          capability: {
            id: "github:github-account",
            provider: "github",
            operations: [
              { name: "add_issue_comment", effect: "write", actions: ["issues:comment"] },
            ],
            authorization: {
              provider: "github",
              resources: [
                {
                  surfaceAccountId: "github-account",
                  scope: "repository:123",
                  reference: "atemaguer/supertag",
                },
              ],
            },
          },
          binding: {
            kind: "mcp-http",
            name: "github",
            url: "https://api.githubcopilot.com/mcp/",
          },
        },
      ],
    );

    expect(prompt).toContain("permission-scoped collaboration harness");
    expect(prompt).toContain("only through the MCP tools provided for this Task");
    expect(prompt).toContain("only when the user clearly requests the action");
  });

  it("keeps remote MCP bearer tokens out of Codex process arguments", async () => {
    let processSpec: ProcessSpec | undefined;
    const environment = {
      id: "remote:test",
      placement: "remote",
      rootDirectory: "/workspace",
      resolvePath: (path: string) => `/workspace/${path}`,
      read: async () => "remote answer",
      spawn: async (spec: ProcessSpec) => {
        processSpec = spec;
        return {
          output: (async function* () {
            yield {
              stream: "stdout" as const,
              text: `${[
                { type: "thread.started", thread_id: "remote-thread" },
                {
                  type: "item.completed",
                  item: { id: "answer", type: "agent_message", text: "remote answer" },
                },
                {
                  type: "turn.completed",
                  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
                },
              ]
                .map((event) => JSON.stringify(event))
                .join("\n")}\n`,
            };
          })(),
          wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          kill: () => undefined,
        };
      },
    } as ExecutionEnvironment;

    const events = [];
    for await (const event of runCodex(
      {
        prompt: "Read README",
        workspace: "/workspace",
        timeoutMs: 1_000,
        command: "codex",
        mcpServers: [
          {
            transport: "mcp-http",
            name: "github",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: "Bearer worker-secret",
              "X-MCP-Tools": "get_file_contents",
            },
            toolNames: ["get_file_contents"],
          },
        ],
        toolInputs: [],
        runtimeActions: [
          "browser:use",
          "commands:execute",
          "files:write",
          "web:fetch",
          "web:search",
        ],
      },
      environment,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "codex.thread.started", threadId: "remote-thread" },
      { type: "output.message", text: "remote answer" },
      {
        type: "usage.updated",
        usage: expect.objectContaining({ inputTokens: 1, outputTokens: 1 }),
      },
      { type: "codex.thread.completed", threadId: "remote-thread" },
    ]);
    expect(JSON.stringify(processSpec?.args)).not.toContain("worker-secret");
    expect(processSpec?.environment).toMatchObject({
      SUPERTAG_MCP_GITHUB_BEARER_TOKEN: "worker-secret",
    });
    expect(processSpec?.args).toContain(
      'mcp_servers.github.bearer_token_env_var="SUPERTAG_MCP_GITHUB_BEARER_TOKEN"',
    );
    expect(processSpec?.args).toEqual(
      expect.arrayContaining([
        "workspace-write",
        "features.shell_tool=true",
        "features.browser_use=true",
        'web_search="live"',
        "sandbox_workspace_write.network_access=true",
      ]),
    );
    expect(processSpec?.args).toContain('mcp_servers.github.enabled_tools=["get_file_contents"]');
    expect(processSpec?.args).toContain(
      'mcp_servers.github.tools.get_file_contents.approval_mode="approve"',
    );
  });

  it("keeps remote stdio MCP secrets out of Codex process arguments", async () => {
    let processSpec: ProcessSpec | undefined;
    const environment = {
      id: "remote:test",
      placement: "remote",
      rootDirectory: "/workspace",
      resolvePath: (path: string) => `/workspace/${path}`,
      read: async () => "remote answer",
      spawn: async (spec: ProcessSpec) => {
        processSpec = spec;
        return {
          output: (async function* () {
            yield {
              stream: "stdout" as const,
              text: `${[
                { type: "thread.started", thread_id: "remote-thread" },
                {
                  type: "item.completed",
                  item: { id: "answer", type: "agent_message", text: "remote answer" },
                },
                {
                  type: "turn.completed",
                  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
                },
              ]
                .map((event) => JSON.stringify(event))
                .join("\n")}\n`,
            };
          })(),
          wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          kill: () => undefined,
        };
      },
    } as ExecutionEnvironment;

    for await (const _event of runCodex(
      {
        prompt: "Lookup value",
        workspace: "/workspace",
        timeoutMs: 1_000,
        command: "codex",
        mcpServers: [
          {
            transport: "mcp-stdio",
            name: "local_tools",
            command: "/opt/supertag/tools-server",
            args: ["--stdio"],
            environment: { TOOL_TOKEN: "worker-secret" },
            toolNames: ["lookup"],
          },
        ],
        toolInputs: [],
        runtimeActions: [],
      },
      environment,
    )) {
      // Exhaust the remote run so its captured process specification is available below.
    }

    expect(JSON.stringify(processSpec?.args)).not.toContain("worker-secret");
    expect(processSpec?.environment).toMatchObject({ TOOL_TOKEN: "worker-secret" });
    expect(processSpec?.args).toContain('mcp_servers.local_tools.env_vars=["TOOL_TOKEN"]');
    expect(processSpec?.args).not.toContain(
      expect.stringContaining("mcp_servers.local_tools.env.TOOL_TOKEN"),
    );
    expect(processSpec?.args).toEqual(
      expect.arrayContaining([
        "read-only",
        "agents.enabled=false",
        "features.multi_agent=false",
        "features.multi_agent_v2=false",
        "features.enable_fanout=false",
        "features.apps=false",
        "features.plugins=false",
        "features.shell_tool=false",
        "features.browser_use=false",
        'web_search="disabled"',
      ]),
    );
  });

  it("compiles portable instructions into the Codex dialect", () => {
    const prompt = codexInformationRetrievalPrompt(
      taskAttemptSpec("Where are replies delivered?"),
      undefined,
      [
        {
          id: "tag-instruction",
          kind: "instruction",
          required: true,
          content: "Prefer references to exported symbols.",
          scope: "task",
          priority: 10,
        },
        {
          id: "selected-repository",
          kind: "workspace",
          required: true,
          source: {
            uri: "file:///not-exposed",
            digest: "git:abc123",
            provenance: { repository: "atemaguer/supertag", commitSha: "abc123" },
          },
          mountPath: "workspace",
          readOnly: true,
        },
      ],
    );

    expect(prompt).toContain("Inspect the relevant source files");
    expect(prompt).toContain("Do not use the network");
    expect(prompt).toContain("suitable for posting directly into a slack thread");
    expect(prompt).toContain("Prefer references to exported symbols");
    expect(prompt).toContain("atemaguer/supertag at commit abc123");
    expect(prompt).not.toContain("not-exposed");
    expect(prompt).toContain("Where are replies delivered?");
  });

  it("advertises only the runtime input dialect it implements", async () => {
    const harness = new CodexHarness({ workspace: fixtureWorkspace });

    await expect(harness.describe()).resolves.toEqual(
      expect.objectContaining({
        id: "codex",
        inputKinds: ["instruction", "skill", "tool", "history", "workspace"],
        sessionPersistence: "native",
      }),
    );
  });

  it("captures and resumes an opaque native Codex Session state", async () => {
    const runner = vi.fn(async function* (
      request: { readonly prompt: string; readonly resumeThreadId?: string },
      environment: { resolvePath(path: string): string },
    ) {
      const sessions = environment.resolvePath(".codex/sessions");
      await mkdir(sessions, { recursive: true });
      await writeFile(
        join(sessions, "thread.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "thread-123" } })}\n`,
      );
      yield {
        type: "output.message" as const,
        text: request.resumeThreadId === undefined ? "first turn" : "resumed turn",
      };
      yield { type: "codex.thread.completed" as const, threadId: "thread-123" };
    });
    const database = new Map<string, string>();
    const storage = () => ({
      async save(state: import("@supertag/worker-sdk").StoredHarnessSessionState) {
        database.set(state.ref.id, JSON.stringify(state));
      },
      async load(ref: import("@supertag/worker-sdk").SessionStateRef) {
        const value = database.get(ref.id);
        return value ? JSON.parse(value) : undefined;
      },
    });
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      runner,
      sessionStateStore: storage(),
    });
    const firstSpec = withSession(taskAttemptSpec("First question"), "session-1");

    const first = await collectTaskAttemptEvents(worker.execute(firstSpec));
    const created = first.find((event) => event.type === "session.updated");

    expect(created).toMatchObject({
      type: "session.updated",
      sessionState: {
        format: "application/vnd.supertag.codex-thread+json;version=2",
        uri: expect.stringMatching(/^supertag:\/\/workers\/codex\/sessions\//),
      },
    });
    if (created?.type !== "session.updated") throw new Error("sessionState was not captured");

    const second = await collectTaskAttemptEvents(
      createCodexWorker({
        workspace: fixtureWorkspace,
        runner,
        sessionStateStore: storage(),
      }).execute({
        ...withSession(taskAttemptSpec("Follow-up question"), "session-1"),
        taskId: "task-2",
        attemptId: "attempt-2",
        session: { id: "session-1", sessionState: created.sessionState },
      }),
    );

    expect(terminalOutputText(second)).toBe("resumed turn");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]?.[0]).toMatchObject({ resumeThreadId: "thread-123" });
    expect(second.some((event) => event.type === "session.updated")).toBe(true);
  });

  it("starts fresh and replays history for a pre-isolation Codex Session state", async () => {
    const runner = vi.fn(async function* ({ prompt, resumeThreadId }) {
      yield {
        type: "output.message" as const,
        text: JSON.stringify({ prompt, resumeThreadId }),
      };
    });
    const worker = createCodexWorker({ workspace: fixtureWorkspace, runner });
    const spec = {
      ...withSession(taskAttemptSpec("Follow-up question"), "session-1"),
      session: {
        id: "session-1",
        sessionState: {
          id: "pre-isolation",
          format: "application/vnd.supertag.codex-thread+json;version=1",
          uri: "supertag://workers/codex/sessions/pre-isolation",
        },
        history: [priorTaskHistoryEntry("session-1")],
      },
    } satisfies TaskAttemptSpec;

    const events = await collectTaskAttemptEvents(worker.execute(spec));
    const output = JSON.parse(terminalOutputText(events));

    expect(output.resumeThreadId).toBeUndefined();
    expect(output.prompt).toContain("Prior work available to this Task");
    expect(output.prompt).toContain("Earlier answer from this Session");
  });

  it("starts fresh when the admitted manager capability changes", async () => {
    let authorizedScope = "objective:one";
    const toolProviders = new ToolProviderRegistry([
      {
        provider: "supertag",
        resolve: async () => ({
          provider: "supertag",
          inputs: [
            {
              id: "supertag-coordination",
              kind: "tool" as const,
              required: true,
              audience: "manager" as const,
              capability: {
                id: "supertag-coordination",
                provider: "supertag",
                operations: [
                  {
                    name: "assign_task",
                    effect: "write" as const,
                    actions: ["tasks:assign"],
                    inputSchema: {
                      type: "object",
                      properties: { taskId: { type: "string" } },
                    },
                    resourceArgumentPolicies: [
                      {
                        match: "scope" as const,
                        prefix: "objective:",
                        components: [{ arguments: ["objectiveId"] }],
                      },
                    ],
                  },
                ],
                authorization: {
                  provider: "supertag",
                  resources: [{ surfaceAccountId: "control-plane", scope: authorizedScope }],
                },
              },
              binding: {
                kind: "mcp-http" as const,
                name: "supertag-coordination",
                url: "https://control-plane.example/internal/v1/coordination/mcp",
              },
            },
          ],
        }),
      },
    ]);
    const runner = vi.fn(async function* (
      request: { readonly resumeThreadId?: string },
      environment: { resolvePath(path: string): string },
    ) {
      const sessions = environment.resolvePath(".codex/sessions");
      await mkdir(sessions, { recursive: true });
      await writeFile(
        join(sessions, "thread.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "thread-manager" } })}\n`,
      );
      yield {
        type: "output.message" as const,
        text: request.resumeThreadId === undefined ? "fresh" : "resumed",
      };
      yield { type: "codex.thread.completed" as const, threadId: "thread-manager" };
    });
    const worker = createCodexWorker({ workspace: fixtureWorkspace, runner, toolProviders });
    const first = await collectTaskAttemptEvents(
      worker.execute(withSession(taskAttemptSpec("First question"), "session-manager")),
    );
    const created = first.find((event) => event.type === "session.updated");
    if (created?.type !== "session.updated") throw new Error("sessionState was not captured");

    authorizedScope = "objective:two";
    const second = await collectTaskAttemptEvents(
      worker.execute({
        ...withSession(taskAttemptSpec("Follow-up question"), "session-manager"),
        taskId: "task-manager-2",
        attemptId: "attempt-manager-2",
        session: { id: "session-manager", sessionState: created.sessionState },
      }),
    );

    expect(terminalOutputText(second)).toBe("fresh");
    expect(runner.mock.calls[1]?.[0].resumeThreadId).toBeUndefined();
  });

  it("does not replay same-Session work after a native resume", async () => {
    const prompts: string[] = [];
    const runner = vi.fn(async function* (
      request: { readonly prompt: string; readonly resumeThreadId?: string },
      environment: { resolvePath(path: string): string },
    ) {
      prompts.push(request.prompt);
      const sessions = environment.resolvePath(".codex/sessions");
      await mkdir(sessions, { recursive: true });
      await writeFile(
        join(sessions, "thread.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "thread-123" } })}\n`,
      );
      yield { type: "output.message" as const, text: "answer" };
      yield { type: "codex.thread.completed" as const, threadId: "thread-123" };
    });
    const worker = createCodexWorker({ workspace: fixtureWorkspace, runner });
    const first = await collectTaskAttemptEvents(
      worker.execute(withSession(taskAttemptSpec("First question"), "session-1")),
    );
    const created = first.find((event) => event.type === "session.updated");
    if (created?.type !== "session.updated") throw new Error("sessionState was not captured");

    await collectTaskAttemptEvents(
      worker.execute({
        ...withSession(taskAttemptSpec("Follow-up question"), "session-1"),
        taskId: "task-2",
        attemptId: "attempt-2",
        session: {
          id: "session-1",
          sessionState: created.sessionState,
          history: [priorTaskHistoryEntry("session-1")],
        },
      }),
    );

    expect(prompts[1]).not.toContain("Earlier answer from this Session");
    expect(prompts[1]).not.toContain("<supertag-history>");
  });

  it("runs against a workspace selected from the admitted request", async () => {
    const source = await mkdtemp(join(tmpdir(), "supertag-codex-source-"));
    await writeFile(join(source, "evidence.txt"), "selected cross-surface workspace");
    const registry = new WorkspaceResolverRegistry([
      {
        resolve: async () => ({
          id: "workspace-1",
          kind: "workspace",
          required: true,
          source: { uri: pathToFileURL(source).href, digest: "git:abc" },
          mountPath: "workspace",
          readOnly: true,
        }),
      },
    ]);
    const runner = vi.fn(async function* ({ workspace }: { readonly workspace: string }) {
      yield {
        type: "output.message" as const,
        text: await readFile(join(workspace, "evidence.txt"), "utf8"),
      };
    });
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      workspaceResolvers: registry,
      runner,
    });
    const spec = taskAttemptSpec("What evidence was selected?");

    try {
      const events = await collectTaskAttemptEvents(worker.execute(spec));

      expect(terminalOutputText(events)).toBe("selected cross-surface workspace");
      expect(runner).toHaveBeenCalledOnce();
      expect(runner.mock.calls[0]?.[0].workspace).not.toBe(source);
    } finally {
      await rm(source, { force: true, recursive: true });
    }
  });

  it("resolves Context Set Skills into a Codex run", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-codex-skills-"));
    const workspace = join(root, "workspace");
    const skill = join(root, "code-review");
    await mkdir(workspace);
    await writeFile(join(workspace, "evidence.txt"), "workspace evidence");
    await mkdir(skill);
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: code-review\ndescription: Review code.\n---\nUse repository evidence.\n",
    );
    const catalogPath = join(root, "catalog.json");
    await writeFile(
      catalogPath,
      JSON.stringify({
        version: 1,
        skills: [{ id: "code-review", path: "./code-review", version: "1" }],
      }),
    );

    try {
      const skills = await FileSkillResolver.load({ catalogPath });
      const runner = vi.fn(async function* ({
        workspace: runWorkspace,
      }: {
        readonly workspace: string;
      }) {
        const installed = await readdir(join(runWorkspace, ".agents/skills"));
        const standalone = await readFile(
          join(runWorkspace, ".agents/skills/skill-code-review/SKILL.md"),
          "utf8",
        );
        yield {
          type: "output.message" as const,
          text: JSON.stringify({ installed: installed.toSorted(), standalone }),
        };
      });
      const worker = createCodexWorker({
        workspace,
        runner,
        contextResolvers: new ContextResolverRegistry([skills]),
      });
      const spec = {
        ...taskAttemptSpec("Review this incident."),
        contextPlan: {
          version: 7 as const,
          capturedAt: "2026-08-03T00:00:00.000Z",
          sets: [
            {
              id: "set-1",
              name: "engineering",
              items: [
                {
                  id: "skill-1",
                  itemKey: "skill:code-review",
                  type: "supertag/skill",
                  version: 1,
                  required: true,
                  config: { reference: "code-review", version: "1" },
                },
              ],
            },
          ],
        },
      };

      const events = await collectTaskAttemptEvents(worker.execute(spec));
      const output = JSON.parse(terminalOutputText(events));

      expect(output.installed).toEqual(["skill-code-review"]);
      expect(output.standalone).toContain("Use repository evidence");
      expect(runner.mock.calls[0]?.[0].prompt).toContain(
        "skills selected by the Tag's Context Sets",
      );
      expect(events.find((event) => event.type === "runtime-inputs.resolved")).toMatchObject({
        manifest: {
          inputs: [
            { id: "supertag-scratch-directory", kind: "instruction" },
            expect.objectContaining({ kind: "skill", sourceItemKey: "skill:code-review" }),
          ],
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not fall back to the host workspace when a repository target is ambiguous", async () => {
    const runner = vi.fn(async function* () {
      yield { type: "output.message" as const, text: "Please name one repository." };
    });
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      workspaceResolvers: new WorkspaceResolverRegistry([
        {
          resolve: async () => ({
            id: "github-repository-selection-required",
            kind: "instruction",
            required: true,
            scope: "task",
            priority: -100,
            content: "Ask the requester to name one repository.",
          }),
        },
      ]),
      runner,
    });

    const events = await collectTaskAttemptEvents(
      worker.execute(taskAttemptSpec("Please investigate the repository.")),
    );

    expect(terminalOutputText(events)).toBe("Please name one repository.");
    expect(runner.mock.calls[0]?.[0].workspace).not.toBe(fixtureWorkspace);
  });

  it("fails the event stream when assigned an unavailable profile revision", async () => {
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      profileId: "local-codex",
      runner: async function* () {
        yield { type: "output.message", text: "unused" };
      },
    });

    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...taskAttemptSpec("How does this work?"),
        execution: {},
        workerProfile: { id: "local-codex", revision: "other" },
      }),
    );

    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "execution.failed",
        error: expect.objectContaining({ message: expect.stringMatching(/not available/i) }),
      }),
    );
    expect(() => terminalOutputText(events)).toThrow(/not available/i);
  });
});

function stdioToolProviders(): ToolProviderRegistry {
  return new ToolProviderRegistry([
    {
      provider: "internal",
      resolve: async () => ({
        provider: "internal",
        inputs: [
          {
            id: "internal-stdio",
            kind: "tool",
            required: true,
            capability: {
              id: "internal:lookup",
              provider: "internal",
              operations: [{ name: "lookup", effect: "read", actions: ["lookup:read"] }],
              authorization: {
                provider: "internal",
                resources: [{ surfaceAccountId: "internal-1", scope: "service:lookup" }],
              },
            },
            binding: {
              kind: "mcp-stdio",
              name: "local_tools",
              command: "/opt/supertag/tools-server",
              args: ["--stdio"],
              runtimeEnvironment: { TOOL_TOKEN: "worker-secret" },
            },
          },
        ],
      }),
    },
  ]);
}

function managerMcpTool(): ToolInput {
  return {
    id: "supertag-coordination",
    kind: "tool",
    required: true,
    audience: "manager",
    capability: {
      id: "supertag-coordination",
      provider: "supertag",
      operations: [{ name: "read_objective", effect: "read", actions: ["read_objective"] }],
      authorization: {
        provider: "supertag",
        resources: [{ surfaceAccountId: "objective-1", scope: "objective-1" }],
      },
    },
    binding: {
      kind: "mcp-http",
      name: "supertag-coordination",
      url: "https://control-plane.example/internal/v1/coordination/mcp",
      runtimeHeaders: { Authorization: "Bearer secret" },
    },
  };
}

function emptyExecutionContext(attempt: TaskAttemptSpec): ExecutionContext {
  return {
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
}

function conformanceEnvironment(rootDirectory: string): ExecutionEnvironment {
  return {
    id: "local:conformance",
    placement: "local",
    rootDirectory,
    prepare: async () => undefined,
    prepareOutputDirectory: async (path: string) => {
      await mkdir(join(rootDirectory, path), { recursive: true });
    },
    resolvePath: (path: string) => join(rootDirectory, path),
    read: async (path: string) => await readFile(join(rootDirectory, path), "utf8"),
    spawn: async () => {
      throw new Error("conformance runner does not spawn a process");
    },
    dispose: async () => undefined,
  };
}

function environmentAccesses(environment: ExecutionEnvironment) {
  return { runtime: environment, execution: environment };
}

function taskAttemptSpec(text: string): TaskAttemptSpec {
  const capturedAt = "2026-08-02T00:00:00.000Z";
  const authorization = {
    version: 5,
    capturedAt,
    tag: {
      id: "tag-1",
      name: "Engineering",
    },
    origin: {
      tagRouteId: "surface-1",
      surfaceAccountId: "account-1",
      provider: "slack",
      scope: "channel:C1",
    },
    requester: { id: "U1", kind: "user" },
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  };
  return {
    version: 1,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "slack",
        accountId: "account-1",
        scope: "channel:C1",
        sessionKey: "slack:account-1:C1:1.0",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text }],
    },
    authorization,
    contextPlan: { version: 7, capturedAt, sets: [] },
    execution: {},
    workerProfile: { id: "local-codex", revision: "1" },
  };
}

function withSession(spec: TaskAttemptSpec, id: string): TaskAttemptSpec {
  return { ...spec, session: { id } };
}

function priorTaskHistoryEntry(
  sessionId: string,
): NonNullable<NonNullable<TaskAttemptSpec["session"]>["history"]>[number] {
  return {
    taskId: "prior-task",
    sessionId,
    tagId: "tag-1",
    requestText: "Earlier question",
    result: {
      summary: "Earlier answer from this Session",
      decisions: [],
      changes: [],
      unresolved: [],
      findings: [],
      references: [],
      artifacts: [],
    },
    completedAt: "2026-08-02T00:00:00.000Z",
  };
}

it.each(["malformed", "incomplete", "cancelled"] as const)(
  "environment-owned Codex fails on %s and confirms process cleanup",
  async (mode) => {
    const controller = new AbortController();
    const reaped = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const kill = vi.fn();
    const environment = {
      id: "remote:failure",
      placement: "remote",
      rootDirectory: "/attempt",
      resolvePath: (path: string) => `/attempt/${path}`,
      async spawn() {
        return {
          kill,
          wait: reaped,
          output: (async function* () {
            if (mode === "cancelled") controller.abort(new Error("cancelled by Control Plane"));
            yield {
              stream: "stdout" as const,
              text:
                mode === "malformed"
                  ? "invalid\n"
                  : `${JSON.stringify({
                      type: "item.completed",
                      item: { id: "text", type: "agent_message", text: "Partial response" },
                    })}\n`,
            };
          })(),
        };
      },
    } as unknown as ExecutionEnvironment;
    await expect(
      (async () => {
        for await (const _event of runCodex(
          {
            prompt: "Task",
            command: "codex",
            workspace: "/attempt",
            timeoutMs: 1000,
            mcpServers: [],
            toolInputs: [],
            runtimeActions: [],
          },
          environment,
          controller.signal,
        )) {
        }
      })(),
    ).rejects.toThrow();
    expect(kill).toHaveBeenCalledOnce();
    expect(reaped).toHaveBeenCalled();
  },
);

it("stages the default workspace and keeps runner writes out of the source", async () => {
  const source = await mkdtemp(join(tmpdir(), "codex-source-"));
  await writeFile(join(source, "input.txt"), "original");
  try {
    const worker = createCodexWorker({
      workspace: source,
      runner: async function* (request, environment) {
        expect(request.workspace).toBe(environment.resolvePath("workspace"));
        expect(await readFile(join(request.workspace, "input.txt"), "utf8")).toBe("original");
        await writeFile(join(request.workspace, "input.txt"), "changed");
        yield { type: "output.message", text: "done" };
      },
    });
    const task = taskAttemptSpec("Edit the staged file");
    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...task,
        authorization: {
          ...task.authorization,
          runtimeActions: [...task.authorization.runtimeActions, "files:write"],
        },
      }),
    );
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(await readFile(join(source, "input.txt"), "utf8")).toBe("original");
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

it("stages only explicitly selected Codex auth and redacts token-bearing events and failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-selected-auth-"));
  const authFile = join(directory, "auth.json");
  const content = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: "selected-access-secret",
      refresh_token: "selected-refresh-secret",
      id_token: "selected-id-secret",
    },
  };
  await writeFile(authFile, JSON.stringify(content));
  await writeFile(join(directory, "config.toml"), "DO_NOT_TRANSFER_CONFIG");
  const prepare = vi.fn(async () => {});
  const environment = {
    ...conformanceEnvironment(directory),
    placement: "remote" as const,
    prepare,
  };
  const harness = new CodexHarness({
    workspace: directory,
    authFile,
    runner: async function* (request) {
      expect(request.authFileStaged).toBe(true);
      expect(JSON.stringify(request)).not.toContain("selected-access-secret");
      yield { type: "output.message", text: "selected-access-secret selected-refresh-secret" };
      throw new Error("provider echoed selected-id-secret");
    },
  });
  const context = emptyExecutionContext(taskAttemptSpec("Inspect"));
  try {
    const plan = await harness.plan(context);
    expect(JSON.stringify(plan)).not.toContain("selected-access-secret");
    const execution = await harness.start(plan, environmentAccesses(environment), context);
    expect(prepare).toHaveBeenCalledOnce();
    const staged = (
      prepare.mock.calls[0] as unknown as [import("@supertag/worker-sdk").EnvironmentPlan]
    )[0];
    expect(staged.files).toEqual([
      { path: ".codex/auth.json", content: JSON.stringify(content), mode: 0o600 },
    ]);
    expect(staged.mounts).toEqual([]);
    const events = [];
    await expect(async () => {
      for await (const event of execution.run()) events.push(event);
    }).rejects.toThrow("provider echoed [REDACTED]");
    expect(JSON.stringify(events)).not.toContain("selected-");
    await execution.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  "not valid json",
  "[]",
  JSON.stringify({ configuration: "no credentials" }),
  "x".repeat(65537),
])("rejects invalid selected auth material before environment staging (%#)", async (content) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-invalid-auth-"));
  const authFile = join(directory, "auth.json");
  await writeFile(authFile, content);
  const prepare = vi.fn(async () => {});
  const harness = new CodexHarness({
    workspace: directory,
    authFile,
    runner: async function* () {
      yield { type: "output.message", text: "unused" };
    },
  });
  const context = emptyExecutionContext(taskAttemptSpec("Inspect"));
  try {
    await expect(
      harness.start(
        await harness.plan(context),
        environmentAccesses({
          ...conformanceEnvironment(directory),
          placement: "remote",
          prepare,
        }),
        context,
      ),
    ).rejects.toThrow(/authFile/);
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses staged auth in the stock remote runner without putting credentials in arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-remote-auth-"));
  const authFile = join(directory, "auth.json");
  await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: "remote-selected-key" }));
  let processSpec: ProcessSpec | undefined;
  const environment: ExecutionEnvironment = {
    ...conformanceEnvironment(directory),
    placement: "remote",
    spawn: async (spec) => {
      processSpec = spec;
      return {
        output: (async function* () {
          yield {
            stream: "stdout" as const,
            text: `${JSON.stringify({ type: "thread.started", thread_id: "test-thread" })}\n${JSON.stringify({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "remote-selected-key" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })}\n`,
          };
        })(),
        wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        kill: () => {},
      };
    },
  };
  try {
    const worker = createCodexWorker({
      workspace: directory,
      authFile,
      executionEnvironment: {
        id: "remote",
        capabilities: [PROCESS_OUTPUT_STREAMING_CAPABILITY],
        provision: async () => environment,
      },
    });
    const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Inspect")));
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(terminalOutputText(events)).toBe("[REDACTED]");
    expect(processSpec?.environment?.["CODEX_HOME"]).toBe(join(directory, ".codex"));
    expect(processSpec?.environment?.["CODEX_API_KEY"]).toBeUndefined();
    expect(JSON.stringify(processSpec)).not.toContain("remote-selected-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  { sandboxMode: undefined, actions: [], expected: "read-only" },
  { sandboxMode: undefined, actions: ["files:write"], expected: undefined },
  { sandboxMode: "external" as const, actions: ["files:write"], expected: "danger-full-access" },
])(
  "uses $expected only for the selected Codex sandbox mode",
  async ({ sandboxMode, actions, expected }) => {
    let processSpec: ProcessSpec | undefined;
    const environment = {
      ...conformanceEnvironment(fixtureWorkspace),
      placement: "remote" as const,
      guarantees: {
        filesystemIsolation: "sandbox" as const,
        networkPolicy: "enforced" as const,
        processTreeTermination: true,
        scopedHttp: false,
      },
      spawn: async (spec: ProcessSpec) => {
        processSpec = spec;
        return {
          output: (async function* () {
            yield {
              stream: "stdout" as const,
              text: `${JSON.stringify({ type: "thread.started", thread_id: "fixture" })}\n${JSON.stringify({ type: "item.completed", item: { id: "output", type: "agent_message", text: "done" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })}\n`,
            };
          })(),
          wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          kill: () => {},
        };
      },
    };
    const events = [];
    for await (const event of runCodex(
      {
        prompt: "test",
        workspace: fixtureWorkspace,
        timeoutMs: 1000,
        command: "codex",
        mcpServers: [],
        toolInputs: [],
        runtimeActions: actions,
        ...(sandboxMode ? { sandboxMode } : {}),
      },
      environment,
    ))
      events.push(event);
    if (expected === undefined) {
      expect(processSpec?.args).not.toContain("--sandbox");
      expect(processSpec?.args).toContain('default_permissions="supertag"');
    } else expect(processSpec?.args?.[processSpec.args.indexOf("--sandbox") + 1]).toBe(expected);
    expect(processSpec?.args).toContain('approval_policy="never"');
    expect(processSpec?.args).toContain("features.multi_agent=false");
    expect(processSpec?.args).toContain("features.shell_tool=false");
    expect(processSpec?.args).not.toContain(
      "permissions.supertag.network.allow_local_binding=true",
    );
  },
);

it.each([
  { actions: ["commands:execute"], base: ":read-only" },
  { actions: ["commands:execute", "files:write"], base: ":workspace" },
])(
  "lets Codex bind loopback through a permission profile for $actions",
  async ({ actions, base }) => {
    let processSpec: ProcessSpec | undefined;
    const environment = {
      ...conformanceEnvironment(fixtureWorkspace),
      placement: "remote" as const,
      spawn: async (spec: ProcessSpec) => {
        processSpec = spec;
        return {
          output: (async function* () {
            yield {
              stream: "stdout" as const,
              text: `${JSON.stringify({ type: "thread.started", thread_id: "fixture" })}\n${JSON.stringify({ type: "item.completed", item: { id: "output", type: "agent_message", text: "done" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })}\n`,
            };
          })(),
          wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          kill: () => {},
        };
      },
    };
    for await (const _ of runCodex(
      {
        prompt: "test",
        workspace: fixtureWorkspace,
        timeoutMs: 1000,
        command: "codex",
        mcpServers: [],
        toolInputs: [],
        runtimeActions: actions,
        outputDirectory: "/out",
      },
      environment,
    )) {
      /* drain */
    }
    const args = processSpec?.args ?? [];
    // An explicit --sandbox would override default_permissions.
    expect(args).not.toContain("--sandbox");
    expect(args).toEqual(
      expect.arrayContaining([
        'default_permissions="supertag"',
        `permissions.supertag.extends="${base}"`,
        "permissions.supertag.network.enabled=true",
        'permissions.supertag.network.mode="limited"',
        "permissions.supertag.network.allow_local_binding=true",
        "features.network_proxy.enabled=true",
        "features.shell_tool=true",
      ]),
    );
    // The profile ignores --add-dir; the output directory is a profile filesystem entry.
    expect(args).not.toContain("--add-dir");
    expect(args.includes('permissions.supertag.filesystem={ "/out" = "write" }')).toBe(
      actions.includes("files:write"),
    );
    expect(args).not.toContain("sandbox_workspace_write.network_access=true");
  },
);

it("retains observed usage when the applied Codex token ceiling terminates execution", async () => {
  const start = vi.spyOn(codexAppServer, "startCodexAppServer").mockResolvedValue({
    threadIds: ["root"],
    threadUsage: {
      root: { inputTokens: 90, outputTokens: 15, cachedInputTokens: 5, totalTokens: 110 },
    },
    run: async function* () {
      yield {
        type: "usage.updated" as const,
        usage: {
          inputTokens: 90,
          outputTokens: 15,
          cachedInputTokens: 5,
          totalTokens: 110,
          complete: true,
        },
      };
      throw new Error("Codex reported token budget exceeded");
    },
    close: async () => undefined,
  });
  try {
    const harness = new CodexHarness({
      workspace: fixtureWorkspace,
      executionMode: "app-server",
      maxNativeAgents: 0,
      maxTokens: 200,
    });
    const task = taskAttemptSpec("Stay within the token ceiling");
    const context = emptyExecutionContext({
      ...task,
      execution: { ...task.execution, limits: { maxReportedTokens: 100 } },
    });
    const environment = {
      ...conformanceEnvironment(fixtureWorkspace),
      placement: "remote" as const,
    };
    const execution = await harness.start(
      await harness.plan(context),
      environmentAccesses(environment),
      context,
    );
    const events = [];
    try {
      expect(execution.appliedLimits).toEqual({
        maxNativeAgents: { limit: 0, method: "harness-guard" },
        maxReportedTokens: { limit: 100, method: "interrupt-on-report" },
      });
      await expect(
        (async () => {
          for await (const event of execution.run()) events.push(event);
        })(),
      ).rejects.toThrow("token budget exceeded");
      expect(events).toEqual([
        {
          type: "usage.updated",
          usage: {
            inputTokens: 90,
            outputTokens: 15,
            cachedInputTokens: 5,
            totalTokens: 110,
            complete: true,
          },
        },
      ]);
    } finally {
      await execution.close();
    }
  } finally {
    start.mockRestore();
  }
});

it.each(["local", "remote"] as const)(
  "rejects external sandbox mode without sufficient boundaries on %s",
  async (placement) => {
    const spawn = vi.fn(async () => {
      throw new Error("must not spawn");
    });
    const environment = { ...conformanceEnvironment(fixtureWorkspace), placement, spawn };
    const execute = async () => {
      for await (const _ of runCodex(
        {
          prompt: "test",
          workspace: fixtureWorkspace,
          timeoutMs: 1000,
          command: "codex",
          mcpServers: [],
          toolInputs: [],
          runtimeActions: placement === "local" ? ["files:write"] : [],
          sandboxMode: "external",
        },
        environment,
      )) {
      }
    };
    await expect(execute()).rejects.toThrow(/explicit filesystem isolation/);
    expect(spawn).not.toHaveBeenCalled();
  },
);

it("resolves placement-specific session support and validates profile configuration", async () => {
  const harness = new CodexHarness({ workspace: fixtureWorkspace });
  const base = emptyExecutionContext(taskAttemptSpec("Inspect"));
  const context = {
    ...base,
    profile: {
      ...base.profile,
      harness: {
        ...base.profile.harness,
        configuration: { model: "explicit-model", timeoutMs: 1234 },
      },
    },
  };
  const plan = await harness.plan(context);
  expect(plan.metadata).toMatchObject({ model: "explicit-model", timeoutMs: 1234 });
  const local = await harness.resolve({
    context,
    plan,
    environments: environmentAccesses(conformanceEnvironment(fixtureWorkspace)),
  });
  expect(local.capabilities.sessions).toEqual({ resume: true, export: true, scope: "portable" });
  expect(local.runtime?.source).toBe("bundled");
  expect(local.runtime?.version).toMatch(/^\d+\./);
  const remote = await harness.resolve({
    context,
    plan,
    environments: environmentAccesses({
      ...conformanceEnvironment(fixtureWorkspace),
      placement: "remote",
    }),
  });
  expect(remote.capabilities.sessionPersistence).toBe("none");
  expect(remote.capabilities.sessions).toEqual({ resume: false, export: false, scope: "none" });
  await expect(
    harness.plan({
      ...context,
      profile: {
        ...context.profile,
        harness: { ...context.profile.harness, configuration: { ignored: true } },
      },
    }),
  ).rejects.toThrow("Unsupported Harness configuration");
});

it("disables native subagents and advertises duplex controls only in app-server mode", async () => {
  expect(() => new CodexHarness({ workspace: fixtureWorkspace, maxNativeAgents: 1 })).toThrow(
    "native subagents are disabled",
  );
  expect(
    () =>
      new CodexHarness({
        workspace: fixtureWorkspace,
        executionMode: "app-server",
        maxNativeAgents: 9,
      }),
  ).toThrow("native subagents are disabled");
  expect(
    () =>
      new CodexHarness({ workspace: fixtureWorkspace, executionMode: "app-server", maxTokens: 0 }),
  ).toThrow("maxTokens");
  expect(
    () =>
      new CodexHarness({
        workspace: fixtureWorkspace,
        executionMode: "app-server",
        runner: async function* () {},
      }),
  ).toThrow("Injected exec runner");
  const harness = new CodexHarness({
    workspace: fixtureWorkspace,
    executionMode: "app-server",
    sandboxMode: "external",
    maxNativeAgents: 0,
  });
  const context = emptyExecutionContext(taskAttemptSpec("Inspect"));
  const plan = await harness.plan(context);
  const unknown = { ...conformanceEnvironment(fixtureWorkspace), placement: "remote" as const };
  await expect(
    harness.resolve({ context, plan, environments: environmentAccesses(unknown) }),
  ).rejects.toThrow("explicit filesystem isolation");
  const allowed = {
    ...unknown,
    guarantees: {
      filesystemIsolation: "sandbox" as const,
      networkPolicy: "enforced" as const,
      processTreeTermination: true,
      scopedHttp: false,
    },
  };
  const writeTask = {
    ...context.attempt,
    authorization: { ...context.attempt.authorization, runtimeActions: ["files:write"] },
  };
  const writableContext = { ...context, attempt: writeTask };
  const writablePlan = await harness.plan(writableContext);
  const resolved = await harness.resolve({
    context: writableContext,
    plan: writablePlan,
    environments: environmentAccesses(allowed),
  });
  expect(resolved.capabilities.sessions).toEqual({ resume: true, export: true, scope: "portable" });
  expect(resolved.capabilities.control?.operations).toEqual(["input", "reply", "interrupt"]);
  expect(resolved.capabilities.executionLimits).toEqual({
    maxNativeAgents: { minimum: 0, maximum: 0 },
    maxReportedTokens: {
      minimum: 1,
      maximum: 1_000_000,
      enforcement: "interrupt-on-report",
    },
  });
  expect(resolved.capabilities.requiredRuntimeCapabilities).toContainEqual({
    id: "supertag.process-input-streaming",
    version: 1,
  });
  const childRequestContext = {
    ...writableContext,
    attempt: {
      ...writableContext.attempt,
      execution: { limits: { maxNativeAgents: 1 } },
    },
  };
  await expect(
    harness.start(
      await harness.plan(childRequestContext),
      environmentAccesses(allowed),
      childRequestContext,
    ),
  ).rejects.toThrow("native subagents are disabled");
  const execCapabilities = await new CodexHarness({ workspace: fixtureWorkspace }).describe();
  expect(execCapabilities.control).toBeUndefined();
  expect(execCapabilities.executionLimits).toBeUndefined();
  const worker = createCodexWorker({
    workspace: fixtureWorkspace,
    executionMode: "app-server",
    maxNativeAgents: 0,
  });
  const profile = (await worker.describe()).profileCapabilities?.[0];
  expect(profile?.capabilities).toEqual(
    expect.arrayContaining([
      { id: "supertag.harness-limit.native-agents", version: 1 },
      { id: "supertag.harness-limit.reported-tokens", version: 1 },
    ]),
  );
});

it.each([
  { host: undefined, attempt: undefined, expected: undefined },
  { host: undefined, attempt: 200_000, expected: 200_000 },
  { host: 200_000, attempt: undefined, expected: 200_000 },
  { host: 100_000, attempt: 200_000, expected: 100_000 },
  { host: 200_000, attempt: 100_000, expected: 100_000 },
])(
  "preserves optional and explicitly tighter Codex token budgets: $host / $attempt",
  async ({ host, attempt, expected }) => {
    const start = vi.spyOn(codexAppServer, "startCodexAppServer").mockResolvedValue({
      threadIds: [],
      threadUsage: {},
      run: async function* () {
        yield { type: "output.message", text: "done" };
      },
      close: async () => undefined,
    });
    try {
      const harness = new CodexHarness({
        workspace: fixtureWorkspace,
        executionMode: "app-server",
        maxNativeAgents: 0,
        ...(host === undefined ? {} : { maxTokens: host }),
      });
      const task = taskAttemptSpec("Inspect");
      const context = emptyExecutionContext({
        ...task,
        execution: {
          ...task.execution,
          ...(attempt === undefined ? {} : { limits: { maxReportedTokens: attempt } }),
        },
      });
      const environment = {
        ...conformanceEnvironment(fixtureWorkspace),
        placement: "remote" as const,
      };
      const plan = await harness.plan(context);
      const execution = await harness.start(plan, environmentAccesses(environment), context);
      try {
        expect(start).toHaveBeenCalledOnce();
        expect(start.mock.calls[0]?.[0].limits).toEqual({
          maxAgents: 0,
          ...(expected === undefined ? {} : { maxTokens: expected }),
        });
        expect(execution.appliedLimits).toEqual({
          maxNativeAgents: { limit: 0, method: "harness-guard" },
          ...(expected === undefined
            ? {}
            : {
                maxReportedTokens: {
                  limit: expected,
                  method: "interrupt-on-report",
                },
              }),
        });
      } finally {
        await execution.close();
      }
    } finally {
      start.mockRestore();
    }
  },
);

it("redacts credentials from retained provider turn failure diagnostics", async () => {
  const worker = createCodexWorker({
    workspace: fixtureWorkspace,
    redactValues: ["provider-diagnostic-secret"],
    runner: async function* () {
      yield* [];
      throw new Error("Codex turn failed: provider rejected provider-diagnostic-secret");
    },
  });
  const events = await collectTaskAttemptEvents(
    worker.execute(taskAttemptSpec("Inspect failure diagnostics")),
  );
  expect(events.at(-1)).toMatchObject({
    type: "execution.failed",
    error: { message: "Codex turn failed: provider rejected [REDACTED]" },
  });
  expect(JSON.stringify(events)).not.toContain("provider-diagnostic-secret");
});

it("archives failed native Codex execution without exposing a resumable revision", async () => {
  const saved: import("@supertag/worker-sdk").StoredHarnessSessionState[] = [];
  const runner: import("./src/index.ts").CodexRunner = async function* (request, runtime) {
    const sessions = runtime.resolvePath(".codex/sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "thread.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "partial-native" } })}\n${JSON.stringify({ type: "response_item", payload: { text: "partial evidence" } })}\n`,
    );
    request.onSessionId?.("partial-native");
    yield { type: "output.message", text: "partial" };
    throw new Error("original provider error");
  };
  const worker = createCodexWorker({
    workspace: fixtureWorkspace,
    runner,
    sessionStateStore: {
      async save(state) {
        saved.push(state);
      },
      async load() {
        return undefined;
      },
    },
  });
  const events = await collectTaskAttemptEvents(
    worker.execute(withSession(taskAttemptSpec("fail"), "partial-session")),
  );
  expect(events.at(-1)).toMatchObject({
    type: "execution.failed",
    error: { message: expect.stringContaining("original provider error") },
  });
  expect(saved.length).toBeGreaterThan(0);
  expect(JSON.stringify(saved.at(-1))).toContain("partial evidence");
  expect(saved.at(-1)?.data["sessionsDirectory"]).toBeUndefined();
  expect(events.some((event) => event.type === "session.updated")).toBe(false);
});

it.each(["local-attempt-one", "local-attempt-two", "execution target with spaces"])(
  "resolves deliverables for %s independently of repository cwd",
  async (target) => {
    let observed:
      | { prompt: string; outputDirectory?: string; scratchDirectory?: string }
      | undefined;
    const harness = new CodexHarness({
      workspace: fixtureWorkspace,
      runner: async function* (request) {
        observed = request;
        yield { type: "output.message", text: "done" };
      },
    });
    const context = emptyExecutionContext(taskAttemptSpec("Create report"));
    const original = await harness.plan(context);
    const plan = {
      ...original,
      metadata: {
        ...original.metadata,
        requiredOutputPaths: ["outputs/attempt-one/report.json", "report.md"],
      },
      execution: {
        ...original.execution,
        environmentVariables: {
          ...original.execution.environmentVariables,
          SUPERTAG_OUTPUT_DIR: "outputs/attempt-one",
          SUPERTAG_SCRATCH_DIR: join(fixtureWorkspace, target, "scratch"),
        },
      },
    };
    const environment = conformanceEnvironment(join(fixtureWorkspace, target));
    const execution = await harness.start(plan, environmentAccesses(environment), context);
    for await (const _event of execution.run()) {
    }
    expect(observed?.outputDirectory).toBe(environment.resolvePath("outputs/attempt-one"));
    expect(observed?.scratchDirectory).toBe(environment.resolvePath("scratch"));
    expect(observed?.prompt).toContain(
      "Native file tools resolve relative paths against the repository working directory",
    );
    expect(observed?.prompt).toContain("earlier Attempt paths may no longer exist");
    expect(observed?.prompt).toContain("This mapping does not grant write permission");
    expect(observed?.prompt).toContain(
      "Verify that each required file exists at its mapped destination",
    );
    expect(observed?.prompt).toContain(
      `"outputs/attempt-one/report.json" must be written to ${JSON.stringify(`${observed?.outputDirectory}/report.json`)}`,
    );
    expect(observed?.prompt).toContain(
      "Other required paths remain relative to the execution root",
    );
    expect(observed?.prompt).toContain(
      JSON.stringify({ path: "report.md", destination: environment.resolvePath("report.md") }),
    );
    expect(observed?.prompt).not.toContain(
      JSON.stringify({
        path: "report.md",
        destination: environment.resolvePath("outputs/attempt-one/report.md"),
      }),
    );
    await execution.close();
  },
);

it("captures native startup before advancing the runner and retains safe interruption diagnostics", async () => {
  let saveCalls = 0;
  const worker = createCodexWorker({
    workspace: fixtureWorkspace,
    runner: async function* (_request, runtime) {
      const sessions = runtime.resolvePath(".codex/sessions");
      await mkdir(sessions, { recursive: true });
      await writeFile(
        join(sessions, "startup.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "startup-native" } })}\n`,
      );
      yield { type: "codex.thread.started", threadId: "startup-native" };
      expect(saveCalls).toBe(1);
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    },
    sessionStateStore: {
      async save() {
        saveCalls++;
        throw new Error("private-archive-detail");
      },
      async load() {
        return undefined;
      },
    },
  });
  const events = await collectTaskAttemptEvents(
    worker.execute(withSession(taskAttemptSpec("wait"), "startup-session")),
  );
  expect(saveCalls).toBe(2);
  expect(events.at(-1)).toMatchObject({
    type: "execution.failed",
    error: {
      name: "AbortError",
      message: "This operation was aborted; native Session archive unavailable after interruption",
    },
  });
  expect(JSON.stringify(events)).not.toContain("private-archive-detail");
  expect(events.some((event) => event.type === "session.updated")).toBe(false);
});

it.each([true, false])(
  "archives iterator closure without duplicating successful capture (early=%s)",
  async (early) => {
    const saved: import("@supertag/worker-sdk").StoredHarnessSessionState[] = [];
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      runner: async function* (_request, runtime) {
        const sessions = runtime.resolvePath(".codex/sessions");
        await mkdir(sessions, { recursive: true });
        const transcript = join(sessions, "iterator.jsonl");
        const metadata = `${JSON.stringify({ type: "session_meta", payload: { id: "iterator-native" } })}\n`;
        await writeFile(transcript, metadata);
        yield { type: "codex.thread.started", threadId: "iterator-native" };
        await writeFile(
          transcript,
          metadata +
            `${JSON.stringify({ type: "response_item", payload: { text: "late evidence" } })}\n`,
        );
        yield { type: "output.message", text: "READY" };
        yield { type: "codex.thread.completed", threadId: "iterator-native" };
      },
      sessionStateStore: {
        async save(state) {
          saved.push(state);
        },
        async load() {
          return undefined;
        },
      },
    });
    const observed = [];
    for await (const event of worker.execute(
      withSession(taskAttemptSpec("return"), "iterator-session"),
    )) {
      observed.push(event);
      if (early && event.type === "output.message") break;
    }
    expect(saved).toHaveLength(2);
    expect(JSON.stringify(saved[0])).not.toContain("late evidence");
    expect(JSON.stringify(saved[1])).toContain("late evidence");
    expect(observed.some((event) => event.type === "session.updated")).toBe(!early);
  },
);

describe("Codex execution settings", () => {
  it("advertises its models and efforts, the first model being the default", async () => {
    const harness = new CodexHarness({
      workspace: fixtureWorkspace,
      models: ["gpt-6-sol", "gpt-6-max"],
    });
    expect(await harness.describe()).toMatchObject({
      models: ["gpt-6-sol", "gpt-6-max"],
      efforts: ["low", "medium", "high"],
    });
    const plan = await harness.plan(emptyExecutionContext(taskAttemptSpec("Inspect")));
    expect(plan.metadata?.["model"]).toBe("gpt-6-sol");
    expect(plan.metadata?.["effort"]).toBeUndefined();
    expect(plan.metadata?.["timeoutMs"]).toBe(60 * 60_000);
    expect((await new CodexHarness({ workspace: fixtureWorkspace }).describe()).models).toBe(
      undefined,
    );
  });

  it("passes the Task's resolved model and effort and refuses a model it does not serve", async () => {
    const harness = new CodexHarness({
      workspace: fixtureWorkspace,
      models: ["gpt-6-sol", "gpt-6-max"],
    });
    const attempt = {
      ...taskAttemptSpec("Inspect"),
      execution: { harness: "codex", model: "gpt-6-max", effort: "high" as const },
    };
    const plan = await harness.plan(emptyExecutionContext(attempt));
    expect(plan.metadata).toMatchObject({ model: "gpt-6-max", effort: "high" });
    await expect(
      harness.plan(
        emptyExecutionContext({ ...attempt, execution: { ...attempt.execution, model: "gpt-5" } }),
      ),
    ).rejects.toThrow("Codex on this Worker Host does not serve model gpt-5");
  });

  it("maps effort to model_reasoning_effort on the Codex command line", async () => {
    let processSpec: ProcessSpec | undefined;
    const environment = {
      ...conformanceEnvironment(fixtureWorkspace),
      spawn: async (spec: ProcessSpec) => {
        processSpec = spec;
        return {
          output: (async function* () {
            yield {
              stream: "stdout" as const,
              text: `${JSON.stringify({ type: "thread.started", thread_id: "fixture" })}\n${JSON.stringify({ type: "item.completed", item: { id: "output", type: "agent_message", text: "done" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })}\n`,
            };
          })(),
          wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          kill: () => {},
        };
      },
    };
    for await (const _ of runCodex(
      {
        prompt: "test",
        workspace: fixtureWorkspace,
        timeoutMs: 1000,
        command: "/usr/bin/false",
        model: "gpt-6-sol",
        effort: "high",
        mcpServers: [],
        toolInputs: [],
        runtimeActions: [],
      },
      environment,
    )) {
      /* drain */
    }
    const args = processSpec?.args ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6-sol");
    expect(args).toContain('model_reasoning_effort="high"');
  });

  it("sets model_reasoning_effort in the app-server thread configuration", () => {
    expect(codexAppServer.codexThreadConfig("medium", undefined)).toEqual({
      config: { model_reasoning_effort: "medium" },
    });
    expect(codexAppServer.codexThreadConfig("high", "/out")).toEqual({
      config: {
        model_reasoning_effort: "high",
        "sandbox_workspace_write.writable_roots": ["/out"],
      },
    });
    expect(codexAppServer.codexThreadConfig(undefined, undefined)).toEqual({});
  });
});

describe("Codex native Session archive after completed execution", () => {
  type Stored = import("@supertag/worker-sdk").StoredHarnessSessionState;
  const meta = (id: string) => `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`;
  const line = (text: string) =>
    `${JSON.stringify({ type: "response_item", payload: { text } })}\n`;
  const savingStore = (saved: Stored[]) => ({
    async save(state: Stored) {
      saved.push(state);
    },
    async load() {
      return undefined;
    },
  });
  const transcripts = (state: Stored | undefined) => {
    if (!state) throw new Error("Missing saved Session state");
    return (state.data["portable"] as { transcripts: { text: string }[] }).transcripts;
  };

  it("archives a long transcript beyond the former 2 MiB per-file bound", async () => {
    const saved: Stored[] = [];
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      runner: async function* (_request, runtime) {
        const sessions = runtime.resolvePath(".codex/sessions/2026/10/02");
        await mkdir(sessions, { recursive: true });
        const transcript = join(sessions, "rollout-long.jsonl");
        await writeFile(transcript, meta("long-native"));
        yield { type: "codex.thread.started", threadId: "long-native" };
        await writeFile(transcript, meta("long-native") + line("x".repeat(3 * 1024 * 1024)));
        yield { type: "output.message", text: "DONE" };
        yield { type: "codex.thread.completed", threadId: "long-native" };
      },
      sessionStateStore: savingStore(saved),
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(withSession(taskAttemptSpec("long"), "long-session")),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
    expect(events.some((event) => event.type === "session.updated")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(EXECUTION_WARNING_SUMMARY);
    expect(transcripts(saved.at(-1))[0]?.text.length).toBeGreaterThan(3 * 1024 * 1024);
  });

  it("completes the Attempt with a recorded warning when the final archive fails", async () => {
    const saved: Stored[] = [];
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      runner: async function* (_request, runtime) {
        const sessions = runtime.resolvePath(".codex/sessions/2026/10/02");
        await mkdir(sessions, { recursive: true });
        const transcript = join(sessions, "rollout-huge.jsonl");
        await writeFile(transcript, meta("huge-native") + line("early evidence"));
        yield { type: "codex.thread.started", threadId: "huge-native" };
        // The rollout outgrows the archive bound after the last periodic save.
        await writeFile(transcript, meta("huge-native") + line("x".repeat(9 * 1024 * 1024)));
        yield { type: "output.message", text: "Implemented the item." };
        yield { type: "codex.thread.completed", threadId: "huge-native" };
      },
      sessionStateStore: savingStore(saved),
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(withSession(taskAttemptSpec("huge"), "huge-session")),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
    expect(events.some((event) => event.type === "execution.failed")).toBe(false);
    const warning = events.find(
      (event) =>
        event.type === "progress.updated" && event.progress.summary === EXECUTION_WARNING_SUMMARY,
    );
    expect(warning).toMatchObject({
      progress: {
        items: [
          {
            id: "warning-1",
            status: "blocked",
            text: expect.stringContaining(
              "Could not enumerate Codex Session transcripts: session file exceeds size limit",
            ),
          },
        ],
      },
    });
    expect(JSON.stringify(warning)).toContain("Kept the last archived transcript");
    expect(JSON.stringify(warning)).not.toContain("/");
    // The last good archive stays the Attempt's Session state.
    expect(saved).toHaveLength(1);
    expect(transcripts(saved[0])[0]?.text).toContain("early evidence");
    expect(events.find((event) => event.type === "session.updated")).toMatchObject({
      sessionState: { id: saved[0]?.ref.id },
    });
  });

  it("does not let concurrent Attempts on one Worker see each other's transcripts", async () => {
    const saved: Stored[] = [];
    const homes: string[] = [];
    let arrived = 0;
    let release: () => void = () => undefined;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = createCodexWorker({
      workspace: fixtureWorkspace,
      maxConcurrency: 2,
      runner: async function* (request, runtime) {
        const id = request.prompt.includes("first") ? "first-native" : "second-native";
        homes.push(runtime.resolvePath(".codex"));
        const sessions = runtime.resolvePath(".codex/sessions/2026/10/02");
        await mkdir(sessions, { recursive: true });
        const transcript = join(sessions, `rollout-${id}.jsonl`);
        await writeFile(transcript, meta(id));
        yield { type: "codex.thread.started", threadId: id };
        if (++arrived === 2) release();
        await together;
        await writeFile(transcript, meta(id) + line(`${id} evidence`));
        yield { type: "output.message", text: `${id} done` };
        yield { type: "codex.thread.completed", threadId: id };
      },
      sessionStateStore: savingStore(saved),
    });
    const second = { ...taskAttemptSpec("second"), taskId: "task-2", attemptId: "attempt-2" };
    const [one, two] = await Promise.all([
      collectTaskAttemptEvents(worker.execute(withSession(taskAttemptSpec("first"), "s-1"))),
      collectTaskAttemptEvents(worker.execute(withSession(second, "s-2"))),
    ]);
    expect(one.at(-1)?.type).toBe("execution.completed");
    expect(two.at(-1)?.type).toBe("execution.completed");
    expect(new Set(homes).size).toBe(2);
    for (const [id, other] of [
      ["first-native", "second-native"],
      ["second-native", "first-native"],
    ] as const) {
      const files = transcripts(saved.findLast((state) => state.data["threadId"] === id));
      expect(files).toHaveLength(1);
      expect(files[0]?.text).toContain(`${id} evidence`);
      expect(JSON.stringify(files)).not.toContain(other);
    }
  });
});
