import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  ContextResolverRegistry,
  collectTaskAttemptEvents,
  ExecutionCleanupError,
  type ExecutionContext,
  type ExecutionEnvironment,
  type ExecutionEnvironmentProvider,
  FINDINGS_INSTRUCTION,
  FileSkillResolver,
  type HarnessEvent,
  InMemorySessionStateStore,
  LocalExecutionEnvironmentProvider,
  LocalHarnessRuntimeProvider,
  type ProcessSpec,
  type RuntimeInput,
  type TaskAttemptSpec,
  type ToolInput,
  ToolProviderRegistry,
  terminalOutputText,
  terminalTaskResult,
} from "@supertag/worker-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileArtifactStore } from "../../../../tests/support/file-artifact-store.js";
import {
  callManagerProxy,
  startManagerIsolationMcp,
} from "../../../../tests/support/manager-isolation-mcp.js";
import { assertConformance, runHarnessConformance } from "../../sdk/src/conformance.ts";
import {
  ClaudeCodeHarness,
  type ClaudeCodeRunRequest,
  claudeCodeInformationRetrievalPrompt,
  createClaudeCodeWorker,
  runClaudeCode,
} from "./src/index.ts";

let outputStateDirectory: string;
let priorStateDirectory: string | undefined;
beforeEach(async () => {
  priorStateDirectory = process.env["SUPERTAG_STATE_DIR"];
  outputStateDirectory = await mkdtemp(join(tmpdir(), "supertag-harness-output-state-"));
  process.env["SUPERTAG_STATE_DIR"] = outputStateDirectory;
});
afterEach(async () => {
  if (priorStateDirectory === undefined) delete process.env["SUPERTAG_STATE_DIR"];
  else process.env["SUPERTAG_STATE_DIR"] = priorStateDirectory;
  await rm(outputStateDirectory, { recursive: true, force: true });
});

const fixtureWorkspace = await mkdtemp(join(tmpdir(), "claude-code-workspace-"));
afterAll(() => rm(fixtureWorkspace, { recursive: true, force: true }));

type ClaudeAgentOptionsForTest = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly toolAliases: Readonly<Record<string, string>>;
  readonly mcpServers: Readonly<
    Record<
      string,
      {
        readonly type: string;
        readonly instance: {
          readonly _registeredTools: Record<
            string,
            {
              handler(
                input: Record<string, unknown>,
                extra: unknown,
              ): Promise<{ content: readonly { text: string }[] }>;
            }
          >;
        };
      }
    >
  >;
};

describe("Claude Code harness composition", () => {
  it("selects the artifact store for the current Attempt and exports its bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-worker-artifact-"));
    try {
      await writeFile(join(directory, "result.txt"), "reviewed output");
      const store = new FileArtifactStore(join(directory, "artifacts"));
      const artifactStore = vi.fn(() => store);
      const worker = createClaudeCodeWorker({
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

  it("passes the shared Harness conformance contract", async () => {
    const harness = new ClaudeCodeHarness({
      workspace: fixtureWorkspace,
      runner: async function* () {
        yield { type: "output.message", text: "conformant Claude response" };
      },
    });
    const context = harnessExecutionContext({
      attempt: taskAttemptSpec("Explain the runtime."),
      sessionStateStore: new InMemorySessionStateStore(),
    });
    const report = await runHarnessConformance({
      harness,
      context,
      executionEnvironment: testEnvironment(fixtureWorkspace),
      expectedInputKinds: ["instruction", "skill", "tool", "history", "workspace"],
    });

    expect(report.passed).toBe(true);
    expect(() => assertConformance(report)).not.toThrow();
  });

  it("asks Claude Code reviewers for findings and parses them from the result", async () => {
    let observed = "";
    const runner = vi.fn(async function* ({ prompt }: { readonly prompt: string }) {
      observed = prompt;
      yield {
        type: "output.message" as const,
        text: "Reviewed.\nFinding: high | The query skips tenant scoping. | src/query.ts:42\nFinding: low | A comment is stale.",
      };
    });
    const worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, runner });
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

  it("runs a Claude Agent SDK-shaped stream through a Worker", async () => {
    const runner = vi.fn(async function* ({
      prompt,
      maxBudgetUsd,
    }: {
      readonly prompt: string;
      readonly maxBudgetUsd?: number;
    }) {
      expect(maxBudgetUsd).toBe(2.5);
      yield {
        type: "output.message" as const,
        text: prompt.includes("durable inbox")
          ? "The durable inbox is implemented by DurableInboundEvent."
          : "No answer.",
      };
    });
    const worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, runner });

    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...taskAttemptSpec("How does the durable inbox work?"),
        execution: {
          limits: { maxReportedCost: { amountMinor: 250, currency: "USD" } },
        },
      }),
    );

    expect(terminalOutputText(events)).toBe(
      "The durable inbox is implemented by DurableInboundEvent.",
    );
    expect(events.map((event) => event.type)).toEqual([
      "execution.started",
      "execution.limits.applied",
      "runtime-inputs.resolved",
      "output.message",
      "result",
      "execution.completed",
    ]);
    expect(events.find((event) => event.type === "execution.limits.applied")).toMatchObject({
      requested: {
        maxReportedCost: { amountMinor: 250, currency: "USD" },
      },
      applied: {
        maxReportedCost: {
          limit: { amountMinor: 250, currency: "USD" },
          method: "provider-budget",
        },
      },
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("fails closed before execution for a cost currency Claude cannot enforce", async () => {
    const runner = vi.fn(async function* () {
      yield { type: "output.message" as const, text: "must not run" };
    });
    const worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, runner });
    const task = taskAttemptSpec("Stay within budget");
    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...task,
        execution: {
          limits: { maxReportedCost: { amountMinor: 100, currency: "EUR" } },
        },
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "execution.failed",
      error: { message: expect.stringContaining("currency or amount") },
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails closed before sending manager coordination credentials to a remote process", async () => {
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
              text: `${JSON.stringify({
                type: "result",
                subtype: "success",
                result: "remote coordinated result",
              })}\n`,
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
      capabilities: [{ id: "supertag.process-output-streaming", version: 1 }],
      provision: async () => remote,
    };
    const worker = createClaudeCodeWorker({
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
    expect(events.at(-1)).toMatchObject({
      type: "execution.failed",
      error: { message: expect.stringContaining("cannot run in a remote runtime") },
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(processSpec).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("remote-attempt-secret");
  });

  it("keeps Control Plane credentials in a Worker proxy while the root can invoke it", async () => {
    const upstream = await startManagerIsolationMcp("Bearer attempt-secret");
    let managerOptions: Record<string, unknown> | undefined;
    const runner = vi.fn(async function* (request: ClaudeCodeRunRequest, environment) {
      expect(request.mcpServers).toEqual([
        expect.objectContaining({
          name: "supertag-coordination",
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u),
          headers: { Authorization: expect.stringMatching(/^Bearer [\w-]{43}$/u) },
          policyProxy: true,
          toolNames: expect.arrayContaining(["assign_task", "create_team"]),
        }),
      ]);
      expect(JSON.stringify(request)).not.toContain("attempt-secret");
      const server = request.mcpServers[0] as {
        readonly url: string;
        readonly headers: Record<string, string>;
      };
      await expect(callManagerProxy(server.url)).rejects.toThrow();
      await callManagerProxy(server.url, server.headers);
      const fakeQuery = ((params: { readonly options?: Record<string, unknown> }) => {
        managerOptions = params.options;
        return (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "accidental attempt-secret",
            session_id: "session-1",
          };
        })();
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
      yield* runClaudeCode(request, environment, environment, undefined, fakeQuery);
    });
    const worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, runner });
    try {
      const events = await collectTaskAttemptEvents(
        worker.execute({
          ...taskAttemptSpec("Coordinate"),
          coordination: {
            controlPlaneUrl: upstream.controlPlaneUrl,
            token: "attempt-secret",
            objectiveId: "objective-1",
          },
        }),
      );
      expect(runner).toHaveBeenCalledOnce();
      expect(upstream.calls, JSON.stringify(events)).toHaveLength(1);
      expect(upstream.authorizations.length).toBeGreaterThan(0);
      expect(upstream.authorizations.every((value) => value === "Bearer attempt-secret")).toBe(
        true,
      );
      expect(JSON.stringify(events)).not.toContain("attempt-secret");
      expect(terminalOutputText(events)).toContain("[REDACTED]");
      expect(managerOptions).toMatchObject({
        agents: {
          "supertag-local": expect.objectContaining({
            tools: ["Read", "Glob", "Grep"],
            disallowedTools: ["mcp__*", "Agent", "Task", "Bash", "WebFetch", "WebSearch"],
          }),
        },
      });
      expect((await worker.describe()).capabilities).toContainEqual({
        id: "supertag.coordination",
        version: 1,
      });
    } finally {
      await upstream.close();
    }
  });

  it("rejects hosted MCP credentials before spawning a Claude process", async () => {
    let processSpec: ProcessSpec | undefined;
    const environment = {
      id: "remote:test",
      placement: "remote",
      rootDirectory: "/workspace",
      resolvePath: (path: string) => `/workspace/${path}`,
      spawn: async (spec: ProcessSpec) => {
        processSpec = spec;
        return {
          output: (async function* () {
            yield {
              stream: "stdout" as const,
              text: `${JSON.stringify({ type: "result", subtype: "success", result: "organized" })}\n`,
            };
          })(),
          wait: async () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({ type: "result", subtype: "success", result: "organized" }),
          }),
          kill: () => {},
        };
      },
    } as ExecutionEnvironment;
    await expect(
      (async () => {
        for await (const _event of runClaudeCode(
          {
            prompt: "Coordinate",
            runtimeDirectory: "/workspace",
            workspace: "/workspace",
            timeoutMs: 1000,
            maxTurns: 10,
            runtimeActions: [],
            mcpServers: [
              {
                transport: "mcp-http",
                name: "supertag-coordination",
                url: "https://control-plane.example/internal/v1/coordination/mcp",
                headers: { Authorization: "Bearer remote-secret" },
                toolNames: ["assign_task"],
              },
            ],
          },
          environment,
          environment,
        )) {
          // Exhaust the stream to observe pre-spawn validation.
        }
      })(),
    ).rejects.toThrow("requires a local Worker Host runtime");
    expect(processSpec).toBeUndefined();
  });

  it("adapts a permission-resolved hosted MCP server for Claude Code", async () => {
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
    const worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, runner, toolProviders });

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

  it("adapts a permission-resolved stdio MCP server for Claude Code", async () => {
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
    const worker = createClaudeCodeWorker({
      workspace: fixtureWorkspace,
      runner,
      toolProviders: stdioToolProviders(),
    });

    const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Lookup value")));

    expect(terminalOutputText(events)).toBe("stdio MCP configured");
    expect(JSON.stringify(events)).not.toContain("worker-secret");
  });

  it("compiles portable context into Claude Code's prompt dialect", () => {
    const prompt = claudeCodeInformationRetrievalPrompt(
      taskAttemptSpec("Where are replies delivered?"),
      undefined,
      [
        {
          id: "instruction-1",
          kind: "instruction",
          required: true,
          content: "Prefer exported symbols.",
          scope: "task",
          priority: 1,
        },
        {
          id: "history-1",
          kind: "history",
          required: true,
          content: "[prior] The previous run inspected delivery.ts.",
          source: { uri: "supertag://artifact/1" },
          trust: "untrusted-history",
        },
      ],
    );

    expect(prompt).toContain("read-only codebase research harness");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("Prefer exported symbols");
    expect(prompt).toContain("untrusted historical evidence");
    expect(prompt).toContain("Where are replies delivered?");
  });

  it("declares generated Claude home sources without transcripts, credentials or workspaces", async () => {
    const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace });
    const plan = await harness.plan(
      harnessExecutionContext({
        attempt: taskAttemptSpec("Create a report"),
        sessionStateStore: new InMemorySessionStateStore(),
      }),
    );
    expect(plan.artifactSources?.map((source) => source.directory)).toEqual([
      ".claude-config/projects",
      ".claude-config/agent-memory",
      ".claude-config/plans",
      ".claude-config/skills",
      ".claude-config/commands",
      ".claude-config/agents",
      ".claude-config/workflows",
      ".claude-config/usage-data",
    ]);
    expect(
      plan.artifactSources?.find((source) => source.id === "claude-project-memories")?.include,
    ).toEqual(["*/memory/**"]);
    expect(plan.artifactSources?.filter((source) => source.category === "memory")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ submit: true, restore: true }),
        expect.objectContaining({ submit: true, restore: true }),
      ]),
    );
    expect(
      plan.artifactSources?.find((source) => source.id === "claude-insights-reports")?.include,
    ).toEqual(["report*.html"]);
  });

  it("allows explicitly selecting tool results and disabling default artifact sources", async () => {
    const context = harnessExecutionContext({
      attempt: taskAttemptSpec("Extract evidence"),
      sessionStateStore: new InMemorySessionStateStore(),
    });
    const sources = [
      {
        id: "claude-tool-results",
        directory: ".claude-config/projects",
        include: ["*/*/tool-results/**"],
        category: "evidence",
      },
    ];
    const harness = new ClaudeCodeHarness({
      workspace: fixtureWorkspace,
      artifactSources: sources,
    });
    sources[0]?.include.push("**");
    const first = await harness.plan(context);
    expect(first.artifactSources).toEqual([
      {
        id: "claude-tool-results",
        directory: ".claude-config/projects",
        include: ["*/*/tool-results/**"],
        category: "evidence",
      },
    ]);
    const returnedSource = first.artifactSources?.[0];
    if (!returnedSource) throw new Error("Missing source");
    (returnedSource.include as string[]).push("**");
    expect((await harness.plan(context)).artifactSources?.[0]?.include).toEqual([
      "*/*/tool-results/**",
    ]);
    expect(
      (
        await new ClaudeCodeHarness({ workspace: fixtureWorkspace, artifactSources: [] }).plan(
          context,
        )
      ).artifactSources,
    ).toEqual([]);
  });

  it("mounts immutable artifact inputs and declares bounded output files", async () => {
    const harness = new ClaudeCodeHarness({
      workspace: fixtureWorkspace,
      outputs: [{ path: "review.json", mediaType: "application/json" }],
      runner: async function* () {
        yield { type: "output.message", text: "done" };
      },
    });
    const task = taskAttemptSpec("Review the imported artifact");
    const plan = await harness.plan(
      harnessExecutionContext({
        attempt: {
          ...task,
          input: {
            ...task.input,
            attachments: [
              {
                uri: "supertag-artifact:fixture",
                digest: "sha256:fixture",
                mediaType: "application/javascript",
              },
              {
                uri: "supertag-artifact:memory",
                digest: "sha256:memory",
                artifactId: "memory-artifact",
                path: "harness/claude-code/claude-project-memories/project/memory/MEMORY.md",
                mediaType: "text/markdown",
              },
            ],
          },
        },
        sessionStateStore: new InMemorySessionStateStore(),
      }),
    );

    expect(plan.execution.mounts).toEqual(
      expect.arrayContaining([
        {
          source: expect.objectContaining({ uri: "supertag-artifact:fixture" }),
          destination: join("workspace", "inputs", "artifact-1"),
          readOnly: true,
        },
      ]),
    );
    expect(plan.outputs).toEqual([
      {
        path: join("workspace", "review.json"),
        mediaType: "application/json",
      },
    ]);
    expect(plan.metadata?.["prompt"]).toContain("inputs/artifact-1");
    expect(JSON.stringify(plan.execution.mounts)).not.toContain("memory-artifact");
    expect(plan.metadata?.["prompt"]).toContain("restored explicitly admitted Harness memory");
    expect(plan.metadata?.["prompt"]).toContain("review.json");

    const invalid = new ClaudeCodeHarness({
      workspace: fixtureWorkspace,
      outputs: [{ path: "../outside.json" }],
    });
    await expect(
      invalid.plan(
        harnessExecutionContext({
          attempt: task,
          sessionStateStore: new InMemorySessionStateStore(),
        }),
      ),
    ).rejects.toThrow("output path must stay within the Task workspace");
  });

  it("advertises the runtime input and streaming behavior it implements", async () => {
    const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace });

    await expect(harness.describe()).resolves.toEqual(
      expect.objectContaining({
        id: "claude-code",
        inputKinds: ["instruction", "skill", "tool", "history", "workspace"],
        streaming: true,
        cancellation: true,
        sessionPersistence: "native",
        executionLimits: {
          maxReportedCost: {
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
            currencies: ["USD"],
            enforcement: "provider-budget",
          },
        },
      }),
    );
  });

  it("maps Claude Agent SDK results and passes an isolated read-only query configuration", async () => {
    vi.stubEnv("SUPERTAG_SENTINEL_SECRET", "claude-host-secret");
    const root = await mkdtemp(join(tmpdir(), "supertag-claude-sdk-"));
    let captured:
      | { readonly prompt: string; readonly options?: Record<string, unknown> }
      | undefined;
    const fakeQuery = ((params: {
      readonly prompt: string;
      readonly options?: Record<string, unknown>;
    }) => {
      captured = params;
      return (async function* () {
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "inspect",
          description: "Inspect the Control Plane",
          uuid: "message-1",
          session_id: "018f52f0-635a-7b4f-9678-d3a4a6108c31",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          task_id: "inspect",
          patch: { status: "completed" },
          uuid: "message-2",
          session_id: "018f52f0-635a-7b4f-9678-d3a4a6108c31",
        };
        yield {
          type: "result",
          subtype: "success",
          result: "SDK result",
          total_cost_usd: 1.23,
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
          session_id: "018f52f0-635a-7b4f-9678-d3a4a6108c31",
        };
      })();
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const environment = {
      id: "local:test",
      placement: "local",
      rootDirectory: root,
      resolvePath: (path: string) => join(root, path),
    } as ExecutionEnvironment;

    try {
      const events = [];
      for await (const event of runClaudeCode(
        {
          prompt: "Inspect the codebase",
          runtimeDirectory: fixtureWorkspace,
          workspace: fixtureWorkspace,
          timeoutMs: 1_000,
          maxTurns: 3,
          maxBudgetUsd: 2.5,
          mcpServers: [
            {
              transport: "mcp-http",
              name: "github",
              url: "https://api.githubcopilot.com/mcp/",
              headers: { Authorization: "Bearer worker-secret" },
              toolNames: ["get_file_contents"],
            },
          ],
          resumeSessionId: "018f52f0-635a-7b4f-9678-d3a4a6108c31",
          runtimeActions: [],
        },
        environment,
        environment,
        undefined,
        fakeQuery,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: "progress.updated",
          progress: {
            summary: "Working through the plan",
            items: [{ id: "inspect", text: "Inspect the Control Plane", status: "active" }],
          },
        },
        {
          type: "progress.updated",
          progress: {
            summary: "Finishing up",
            items: [{ id: "inspect", text: "Inspect the Control Plane", status: "completed" }],
          },
        },
        { type: "output.message", text: "SDK result", final: true },
        {
          type: "usage.updated",
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            cachedInputTokens: 3,
            totalTokens: 19,
            complete: true,
            reportedCost: { amountMinor: 123, currency: "USD" },
          },
        },
        {
          type: "session.updated",
          sessionState: {
            id: "claude-session:018f52f0-635a-7b4f-9678-d3a4a6108c31",
            format: "claude-code-session-v1",
            uri: "claude-code://session/018f52f0-635a-7b4f-9678-d3a4a6108c31",
            mediaType: "application/vnd.anthropic.claude-code-session+json;version=1",
            provenance: {
              provider: "claude-code",
              sessionId: "018f52f0-635a-7b4f-9678-d3a4a6108c31",
            },
          },
        },
      ]);
      if (!captured) throw new Error("Query was not called");
      const prompts = [];
      for await (const message of captured.prompt as unknown as AsyncIterable<{
        message: { content: string };
      }>)
        prompts.push(message.message.content);
      expect(prompts).toEqual(["Inspect the codebase"]);
      expect(captured?.options).toMatchObject({
        cwd: fixtureWorkspace,
        maxTurns: 3,
        maxBudgetUsd: 2.5,
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        resume: "018f52f0-635a-7b4f-9678-d3a4a6108c31",
        skills: [],
        tools: ["Read", "Glob", "Grep", "Agent", "mcp__github__get_file_contents"],
        allowedTools: [
          "Read",
          "Glob",
          "Grep",
          "mcp__github__get_file_contents",
          "Agent(supertag-local)",
        ],
        mcpServers: {
          github: {
            type: "http",
            alwaysLoad: true,
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer worker-secret" },
          },
        },
        disallowedTools: [
          "Agent(Explore)",
          "Agent(Plan)",
          "Agent(general-purpose)",
          "Agent(statusline-setup)",
          "Agent(claude-code-guide)",
          "Write",
          "Edit",
          "Bash",
          "WebFetch",
          "WebSearch",
        ],
        agents: {
          "supertag-local": {
            description: expect.any(String),
            prompt: expect.stringContaining("return concise results to the main manager"),
            tools: ["Read", "Glob", "Grep"],
            mcpServers: [],
            disallowedTools: ["mcp__*", "Agent", "Task"],
          },
        },
      });
      expect(captured?.options?.["env"]).not.toHaveProperty("SUPERTAG_SENTINEL_SECRET");
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("streams the root agent's reply text from Agent SDK partial messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-claude-sdk-"));
    const session = "018f52f0-635a-7b4f-9678-d3a4a6108c31";
    let options: Record<string, unknown> | undefined;
    const streamEvent = (event: unknown, parent: string | null = null) => ({
      type: "stream_event",
      event,
      parent_tool_use_id: parent,
      uuid: "stream",
      session_id: session,
    });
    const delta = (delta: unknown, parent?: string | null) =>
      streamEvent({ type: "content_block_delta", index: 0, delta }, parent);
    const fakeQuery = ((params: { readonly options?: Record<string, unknown> }) => {
      options = params.options;
      return (async function* () {
        yield streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        });
        yield delta({ type: "thinking_delta", thinking: "private reasoning" });
        yield delta({ type: "text_delta", text: "Hello, " });
        yield delta({ type: "input_json_delta", partial_json: '{"command":"ls"}' });
        yield delta({ type: "text_delta", text: "subagent text" }, "tool-1");
        yield delta({ type: "text_delta", text: "" });
        yield delta({ type: "text_delta", text: "world." });
        yield streamEvent({ type: "content_block_stop", index: 0 });
        yield { type: "result", subtype: "success", result: "Hello, world.", session_id: session };
      })();
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const environment = {
      id: "local:test",
      placement: "local",
      rootDirectory: root,
      resolvePath: (path: string) => join(root, path),
    } as ExecutionEnvironment;
    try {
      const events = [];
      for await (const event of runClaudeCode(
        {
          prompt: "Greet",
          mcpServers: [],
          runtimeDirectory: fixtureWorkspace,
          workspace: fixtureWorkspace,
          timeoutMs: 1_000,
          runtimeActions: [],
        },
        environment,
        environment,
        undefined,
        fakeQuery,
      ))
        events.push(event);
      expect(options?.["includePartialMessages"]).toBe(true);
      expect(events.filter((event) => event.type !== "session.updated")).toEqual([
        { type: "output.delta", text: "Hello, " },
        { type: "output.delta", text: "world." },
        { type: "output.message", text: "Hello, world.", final: true },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("retains reported cost when the Claude provider budget stops SDK execution", async () => {
    const fakeQuery = (() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "error_max_budget_usd",
          total_cost_usd: 0.51,
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          errors: ["Maximum budget reached"],
          session_id: "budget-session",
        };
      })()) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const environment = {
      id: "local:test",
      placement: "local",
      rootDirectory: fixtureWorkspace,
      resolvePath: (path: string) => join(fixtureWorkspace, path),
    } as ExecutionEnvironment;
    const stream = runClaudeCode(
      {
        prompt: "Stay within budget",
        runtimeDirectory: fixtureWorkspace,
        workspace: fixtureWorkspace,
        timeoutMs: 1_000,
        maxTurns: 3,
        maxBudgetUsd: 0.5,
        mcpServers: [],
        runtimeActions: [],
      },
      environment,
      environment,
      undefined,
      fakeQuery,
    )[Symbol.asyncIterator]();

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "usage.updated",
        usage: { reportedCost: { amountMinor: 51, currency: "USD" } },
      },
    });
    await expect(stream.next()).rejects.toMatchObject({
      name: "ExecutionBudgetExceededError",
      message: expect.stringContaining("error_max_budget_usd"),
    });
  });

  it("records provider provenance for a Claude API sign-in failure", async () => {
    const fakeQuery = (() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 401,
          result: "Invalid API key · Please run /login",
          session_id: "session-auth",
        };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const environment = {
      id: "local:test",
      placement: "local",
      rootDirectory: fixtureWorkspace,
      resolvePath: (path: string) => join(fixtureWorkspace, path),
    } as ExecutionEnvironment;
    await expect(
      (async () => {
        for await (const _event of runClaudeCode(
          {
            prompt: "Check login",
            runtimeDirectory: fixtureWorkspace,
            workspace: fixtureWorkspace,
            timeoutMs: 1000,
            maxTurns: 1,
            mcpServers: [],
            runtimeActions: [],
          },
          environment,
          environment,
          undefined,
          fakeQuery,
        )) {
          /* consume */
        }
      })(),
    ).rejects.toMatchObject({
      name: "HarnessProviderError",
      message: expect.stringContaining("Please run /login"),
    });
  });

  it("records native Claude API retries and fails on a terminal API error result", async () => {
    const fakeQuery = (() =>
      (async function* () {
        yield {
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 10,
          retry_delay_ms: 500,
          error_status: 529,
          error: "overloaded",
          session_id: "session-1",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 529,
          result: "API Error: 529 Overloaded",
          session_id: "session-1",
        };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const environment = {
      id: "local:test",
      placement: "local",
      rootDirectory: fixtureWorkspace,
      resolvePath: (path: string) => join(fixtureWorkspace, path),
    } as ExecutionEnvironment;
    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of runClaudeCode(
          {
            prompt: "Make the requested update",
            runtimeDirectory: fixtureWorkspace,
            workspace: fixtureWorkspace,
            timeoutMs: 1_000,
            maxTurns: 3,
            mcpServers: [],
            runtimeActions: [],
          },
          environment,
          environment,
          undefined,
          fakeQuery,
        ))
          events.push(event);
      })(),
    ).rejects.toThrow("Claude Agent SDK failed (api_error 529): API Error: 529 Overloaded");
    expect(events).toContainEqual({
      type: "progress.updated",
      progress: {
        summary:
          "Provider request failed (overloaded, HTTP 529); Claude Code is retrying request 1 of 10 after 500 ms.",
      },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "output.message" }));
  });

  it("maps portable runtime permissions to Claude Code built-in tools", async () => {
    let captured: { readonly options?: Record<string, unknown> } | undefined;
    const fakeQuery = ((params: { readonly options?: Record<string, unknown> }) => {
      captured = params;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "done", session_id: "session-1" };
      })();
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const environment = {
      id: "local:test",
      placement: "local",
      rootDirectory: fixtureWorkspace,
      resolvePath: (path: string) => join(fixtureWorkspace, path),
    } as ExecutionEnvironment;

    for await (const _event of runClaudeCode(
      {
        prompt: "Make the requested update",
        runtimeDirectory: fixtureWorkspace,
        workspace: fixtureWorkspace,
        timeoutMs: 1_000,
        maxTurns: 3,
        mcpServers: [],
        runtimeActions: ["commands:execute", "files:write", "web:fetch", "web:search"],
      },
      environment,
      environment,
      undefined,
      fakeQuery,
    )) {
      // Exhaust the SDK-shaped stream so the captured configuration is complete.
    }

    expect(captured?.options).toMatchObject({
      tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "WebSearch", "Agent"],
      allowedTools: [
        "Read",
        "Glob",
        "Grep",
        "Write",
        "Edit",
        "Bash",
        "WebFetch",
        "WebSearch",
        "Agent(supertag-local)",
      ],
      disallowedTools: [
        "Agent(Explore)",
        "Agent(Plan)",
        "Agent(general-purpose)",
        "Agent(statusline-setup)",
        "Agent(claude-code-guide)",
      ],
      agents: {
        "supertag-local": expect.objectContaining({
          tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "WebSearch"],
          mcpServers: [],
          disallowedTools: ["mcp__*", "Agent", "Task"],
        }),
      },
      permissionMode: "dontAsk",
    });
  });

  it("resumes a compatible Claude session and omits duplicated same-session replay", async () => {
    let captured: ClaudeCodeRunCapture | undefined;
    const runner = vi.fn(async function* (request: ClaudeCodeRunCapture) {
      captured = request;
      yield { type: "output.message" as const, text: "continued" };
      yield { type: "session.updated" as const, sessionState };
    });
    const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace, runner });
    const replayInput = historyInput(
      "session-continuity:session-1",
      "duplicated same-session history",
    );
    const sessionState = claudeSessionStateRef("018f52f0-635a-7b4f-9678-d3a4a6108c31");
    const sessionStateStore = new InMemorySessionStateStore();
    const task: TaskAttemptSpec = {
      ...taskAttemptSpec("What changed?"),
      session: { id: "session-1" },
    };
    const registrationInput = harnessExecutionContext({
      attempt: task,
      sessionStateStore,
      continuity: { sessionId: "session-1" },
    });
    const registrationPlan = await harness.plan(registrationInput);
    const registration = await harness.start(
      registrationPlan,
      environmentAccesses(testEnvironment(fixtureWorkspace)),
      registrationInput,
    );
    for await (const _event of registration.run()) {
      // Capture a sessionState owned by this Harness before attempting resume.
    }
    const capturedState = await registration.sessionState?.();
    expect(capturedState).toEqual({ ...sessionState, id: `${sessionState.id}:attempt-1` });

    const planInput = harnessExecutionContext({
      attempt: task,
      sessionStateStore,
      inputs: [replayInput, historyInput("cross-session", "newly admitted cross-session history")],
      continuity: {
        sessionId: "session-1",
        priorSessionState: capturedState,
        replayInput,
      },
    });
    const plan = await harness.plan(planInput);
    const session = await harness.start(
      plan,
      environmentAccesses(testEnvironment(fixtureWorkspace)),
      planInput,
    );

    for await (const _event of session.run()) {
      // Drain the runner so its request can be inspected.
    }

    expect(captured?.resumeSessionId).toBe("018f52f0-635a-7b4f-9678-d3a4a6108c31");
    expect(captured?.prompt).not.toContain("duplicated same-session history");
    expect(captured?.prompt).toContain("newly admitted cross-session history");
  });

  it("re-prompts once when a resumed session ends empty before the model runs", async () => {
    const sessionState = claudeSessionStateRef("018f52f0-635a-7b4f-9678-d3a4a6108c31");
    const zeroUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      complete: true,
    };
    async function resume(passes: Array<(request: ClaudeCodeRunCapture) => HarnessEvent[]>) {
      const requests: ClaudeCodeRunCapture[] = [];
      let registering = true;
      const runner = vi.fn(async function* (request: ClaudeCodeRunCapture) {
        if (registering) {
          yield { type: "output.message" as const, text: "waiting" };
          yield { type: "session.updated" as const, sessionState };
          return;
        }
        requests.push(request);
        const pass = passes[requests.length - 1];
        if (!pass) throw new Error("Unexpected extra pass");
        for (const event of pass(request)) yield event;
      });
      const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace, runner });
      const sessionStateStore = new InMemorySessionStateStore();
      const task: TaskAttemptSpec = {
        ...taskAttemptSpec("Continue the work"),
        session: { id: "session-1" },
      };
      const registrationInput = harnessExecutionContext({
        attempt: task,
        sessionStateStore,
        continuity: { sessionId: "session-1" },
      });
      const registration = await harness.start(
        await harness.plan(registrationInput),
        environmentAccesses(testEnvironment(fixtureWorkspace)),
        registrationInput,
      );
      for await (const _event of registration.run()) {
        // Register a resumable Session state.
      }
      registering = false;
      const planInput = harnessExecutionContext({
        attempt: task,
        sessionStateStore,
        continuity: {
          sessionId: "session-1",
          priorSessionState: await registration.sessionState?.(),
        },
      });
      const session = await harness.start(
        await harness.plan(planInput),
        environmentAccesses(testEnvironment(fixtureWorkspace)),
        planInput,
      );
      const outputs: string[] = [];
      for await (const event of session.run())
        if (event.type === "output.message") outputs.push(event.text);
      return { outputs, requests };
    }

    const recovered = await resume([
      () => [
        { type: "usage.updated", usage: zeroUsage },
        { type: "output.message", text: "" },
        { type: "session.updated", sessionState },
      ],
      () => [{ type: "output.message", text: "continued" }],
    ]);
    expect(recovered.outputs).toEqual(["continued"]);
    expect(recovered.requests.map((request) => request.resumeSessionId)).toEqual([
      "018f52f0-635a-7b4f-9678-d3a4a6108c31",
      "018f52f0-635a-7b4f-9678-d3a4a6108c31",
    ]);

    // An empty answer after the model produced output is still a failure, with no retry.
    await expect(
      resume([
        () => [
          { type: "usage.updated", usage: { ...zeroUsage, outputTokens: 12, totalTokens: 12 } },
          { type: "output.message", text: "" },
        ],
      ]),
    ).rejects.toThrow("Claude Code returned an empty response");
  });

  it("falls back to replay when a structurally valid Session state is unknown to this worker", async () => {
    let captured: ClaudeCodeRunCapture | undefined;
    const runner = vi.fn(async function* (request: ClaudeCodeRunCapture) {
      captured = request;
      yield { type: "output.message" as const, text: "fresh" };
    });
    const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace, runner });
    const replayInput = historyInput(
      "session-continuity:session-1",
      "canonical same-session replay",
    );
    const sessionState = claudeSessionStateRef("018f52f0-635a-7b4f-9678-d3a4a6108c31");
    const sessionStateStore = new InMemorySessionStateStore();
    const task: TaskAttemptSpec = {
      ...taskAttemptSpec("What changed?"),
      session: { id: "session-1" },
    };
    const planInput = harnessExecutionContext({
      attempt: task,
      sessionStateStore,
      inputs: [replayInput],
      continuity: {
        sessionId: "session-1",
        priorSessionState: sessionState,
        replayInput,
      },
    });
    const plan = await harness.plan(planInput);
    const session = await harness.start(
      plan,
      environmentAccesses(testEnvironment(fixtureWorkspace)),
      planInput,
    );

    for await (const _event of session.run()) {
      // Drain the runner so its request can be inspected.
    }

    expect(captured?.resumeSessionId).toBeUndefined();
    expect(captured?.prompt).toContain("canonical same-session replay");
  });

  it("does not resume a registered Session state for a different SuperTag session", async () => {
    let captured: ClaudeCodeRunCapture | undefined;
    const sessionState = claudeSessionStateRef("018f52f0-635a-7b4f-9678-d3a4a6108c31");
    const runner = vi.fn(async function* (request: ClaudeCodeRunCapture) {
      captured = request;
      yield { type: "output.message" as const, text: "done" };
      yield { type: "session.updated" as const, sessionState };
    });
    const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace, runner });
    const sessionStateStore = new InMemorySessionStateStore();
    const originalTask: TaskAttemptSpec = {
      ...taskAttemptSpec("First turn"),
      session: { id: "session-1" },
    };
    const registrationInput = harnessExecutionContext({
      attempt: originalTask,
      sessionStateStore,
      continuity: { sessionId: "session-1" },
    });
    const registrationPlan = await harness.plan(registrationInput);
    const registration = await harness.start(
      registrationPlan,
      environmentAccesses(testEnvironment(fixtureWorkspace)),
      registrationInput,
    );
    for await (const _event of registration.run()) {
      // Register the sessionState under session-1.
    }

    const replayInput = historyInput("session-continuity:session-2", "session-2 canonical replay");
    const foreignTask: TaskAttemptSpec = {
      ...taskAttemptSpec("Foreign turn"),
      session: { id: "session-2" },
    };
    const planInput = harnessExecutionContext({
      attempt: foreignTask,
      sessionStateStore,
      inputs: [replayInput],
      continuity: {
        sessionId: "session-2",
        priorSessionState: sessionState,
        replayInput,
      },
    });
    const plan = await harness.plan(planInput);
    const session = await harness.start(
      plan,
      environmentAccesses(testEnvironment(fixtureWorkspace)),
      planInput,
    );
    for await (const _event of session.run()) {
      // Drain the foreign attempt.
    }

    expect(captured?.resumeSessionId).toBeUndefined();
    expect(captured?.prompt).toContain("session-2 canonical replay");
  });

  it("promotes a successful runner Session state through a Worker", async () => {
    const sessionState = claudeSessionStateRef("018f52f0-635a-7b4f-9678-d3a4a6108c31");
    const runner = vi.fn(async function* () {
      yield { type: "output.message" as const, text: "done" };
      yield { type: "session.updated" as const, sessionState };
    });
    const worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, runner });

    const spec: TaskAttemptSpec = {
      ...taskAttemptSpec("Inspect it"),
      session: { id: "session-1" },
    };
    const events = await collectTaskAttemptEvents(worker.execute(spec));

    expect(events.find((event) => event.type === "session.updated")).toMatchObject({
      sessionState: { ...sessionState, id: `${sessionState.id}:attempt-1` },
    });
    expect(events.map((event) => event.type)).toEqual([
      "execution.started",
      "execution.limits.applied",
      "runtime-inputs.resolved",
      "output.message",
      "result",
      "session.updated",
      "execution.completed",
    ]);
  });

  it("resolves selected skills into an isolated Claude context plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-claude-skills-"));
    const workspace = join(root, "workspace");
    const skill = join(root, "code-review");
    await mkdir(workspace);
    await mkdir(skill);
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: code-review\ndescription: Review code.\n---\nUse code evidence.\n",
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
        contextPlugin,
      }: {
        readonly workspace: string;
        readonly contextPlugin?: string;
      }) {
        expect(contextPlugin).not.toBe(join(runWorkspace, ".supertag/claude-context"));
        const manifest = await readFile(
          join(contextPlugin as string, ".claude-plugin/plugin.json"),
          "utf8",
        );
        const standalone = await readFile(
          join(contextPlugin as string, "skills/skill-code-review/SKILL.md"),
          "utf8",
        );
        yield {
          type: "output.message" as const,
          text: JSON.stringify({ manifest: JSON.parse(manifest), standalone }),
        };
      });
      const worker = createClaudeCodeWorker({
        workspace,
        runner,
        contextResolvers: new ContextResolverRegistry([skills]),
      });
      const spec: TaskAttemptSpec = {
        ...taskAttemptSpec("Review this incident."),
        contextPlan: {
          version: 7,
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

      const output = JSON.parse(
        terminalOutputText(await collectTaskAttemptEvents(worker.execute(spec))),
      );

      expect(output.manifest).toEqual({ name: "supertag-context", version: "1" });
      expect(output.standalone).toContain("Use code evidence");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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

function harnessExecutionContext(input: {
  readonly attempt: TaskAttemptSpec;
  readonly sessionStateStore: ExecutionContext["sessionStateStore"];
  readonly inputs?: readonly RuntimeInput[];
  readonly continuity?: ExecutionContext["continuity"];
}): ExecutionContext {
  const inputs = input.inputs ?? [];
  return {
    attempt: input.attempt,
    profile: claudeProfile(),
    context: {
      instructions: inputs.filter(
        (runtimeInput) => runtimeInput.kind === "instruction",
      ) as ExecutionContext["context"]["instructions"],
      skills: inputs.filter(
        (runtimeInput) => runtimeInput.kind === "skill",
      ) as ExecutionContext["context"]["skills"],
      history: inputs.filter(
        (runtimeInput) => runtimeInput.kind === "history",
      ) as ExecutionContext["context"]["history"],
      resources: inputs.filter(
        (runtimeInput) => runtimeInput.kind === "resource",
      ) as ExecutionContext["context"]["resources"],
    },
    ...(inputs.find((input) => input.kind === "workspace") === undefined
      ? {}
      : {
          workspace: inputs.find(
            (runtimeInput) => runtimeInput.kind === "workspace",
          ) as NonNullable<ExecutionContext["workspace"]>,
        }),
    tools: inputs.filter(
      (runtimeInput) => runtimeInput.kind === "tool",
    ) as ExecutionContext["tools"],
    ...(input.continuity === undefined ? {} : { continuity: input.continuity }),
    secrets: [],
    sessionStates: [],
    extensions: [],
    sessionStateStore: input.sessionStateStore,
  };
}

function taskAttemptSpec(text: string): TaskAttemptSpec {
  const capturedAt = "2026-08-03T00:00:00.000Z";
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
        sessionKey: "thread:T1",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text }],
    },
    execution: {},
    workerProfile: { id: "local-claude-code", revision: "1" },
    contextPlan: { version: 7, capturedAt, sets: [] },
    authorization: {
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
    },
  };
}

describe("Claude Code live input", () => {
  const input = (id: string, text: string) => ({
    id,
    taskId: "task-1",
    attemptId: "attempt-1",
    type: "input" as const,
    text,
  });

  it("queues accepted input into the running query through Harness control", async () => {
    const received: unknown[] = [];
    let capabilities: unknown;
    let acknowledgements: unknown[] = [];
    let worker: ReturnType<typeof createClaudeCodeWorker> | undefined;
    const queryAgent = (({ prompt }: { prompt: AsyncIterable<unknown> }) =>
      (async function* () {
        const stream = prompt[Symbol.asyncIterator]();
        await stream.next();
        // Like the SDK, read input independently of the message stream.
        void (async () => {
          for (let next = await stream.next(); !next.done; next = await stream.next())
            received.push(next.value);
        })();
        yield { type: "system", subtype: "init", session_id: "live-1" };
        yield { type: "assistant", message: { content: [] }, session_id: "live-1" };
        // A lead's decision arrives while the builder's turn is running.
        capabilities = await worker?.controlCapabilities?.("task-1", "attempt-1");
        acknowledgements = [
          await worker?.control?.({
            ...input("decision-1", "Team decision: keep the old schema"),
            advisory: true,
            origin: { kind: "peer", from: "lead-tag" },
          }),
          await worker?.control?.({
            id: "interrupt-1",
            taskId: "task-1",
            attemptId: "attempt-1",
            type: "interrupt",
          }),
        ];
        yield { type: "assistant", message: { content: [] }, session_id: "live-1" };
        yield { type: "result", subtype: "success", result: "done", session_id: "live-1" };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    expect(
      (await new ClaudeCodeHarness({ workspace: fixtureWorkspace }).describe()).control,
    ).toEqual({ version: 1, inputMode: "queue", operations: ["input"] });
    worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent });
    const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Build it.")));
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(capabilities).toEqual({ version: 1, inputMode: "queue", operations: ["input"] });
    expect(acknowledgements).toMatchObject([
      { id: "decision-1", status: "accepted" },
      { id: "interrupt-1", status: "rejected" },
    ]);
    expect(received).toEqual([
      expect.objectContaining({
        message: { role: "user", content: "Team decision: keep the old schema" },
        priority: "next",
        client_composed: true,
      }),
    ]);
    expect(received[0]).not.toHaveProperty("origin");
    expect(await worker.controlCapabilities?.("task-1", "attempt-1")).toBeUndefined();
  });

  it("keeps the finished Task result when live input is answered after the final turn", async () => {
    let worker: ReturnType<typeof createClaudeCodeWorker> | undefined;
    const queryAgent = (({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) =>
      (async function* () {
        const stream = prompt[Symbol.asyncIterator]();
        await stream.next();
        const handed: { uuid?: string }[] = [];
        void (async () => {
          for (let next = await stream.next(); !next.done; next = await stream.next())
            handed.push(next.value);
        })();
        yield { type: "system", subtype: "init", session_id: "live-3" };
        yield { type: "assistant", message: { content: [] }, session_id: "live-3" };
        // A teammate's note arrives while the final turn is writing its result.
        await worker?.control?.(input("note-1", "FYI: thanks"));
        yield {
          type: "result",
          subtype: "success",
          result: "Reviewed.\nFinding: high | Real review finding | a.ts:1",
          session_id: "live-3",
        };
        const uuid = handed[0]?.uuid;
        yield {
          type: "assistant",
          message: { content: [] },
          session_id: "live-3",
          ...(uuid === undefined ? {} : { user_message_uuid: uuid, user_message_uuids: [uuid] }),
        };
        yield {
          type: "result",
          subtype: "success",
          result: "Noted, thanks.",
          session_id: "live-3",
        };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent });
    const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Review it.")));
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(terminalTaskResult(events).summary).toContain("Finding: high");
    expect(terminalTaskResult(events).findings).toMatchObject([
      { id: "F1", severity: "high", summary: "Real review finding" },
    ]);
  });

  it("keeps the finished Task result when a reply turn after the final result fails", async () => {
    let worker: ReturnType<typeof createClaudeCodeWorker> | undefined;
    let replyTurnRan = false;
    const queryAgent = (({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) =>
      (async function* () {
        const stream = prompt[Symbol.asyncIterator]();
        await stream.next();
        const handed: { uuid?: string }[] = [];
        void (async () => {
          for (let next = await stream.next(); !next.done; next = await stream.next())
            handed.push(next.value);
        })();
        yield { type: "system", subtype: "init", session_id: "live-4" };
        yield { type: "assistant", message: { content: [] }, session_id: "live-4" };
        // A teammate's note arrives while the final turn is writing its result.
        await worker?.control?.(input("note-1", "FYI: thanks"));
        yield {
          type: "result",
          subtype: "success",
          result: "Reviewed.\nFinding: high | Real review finding | a.ts:1",
          session_id: "live-4",
        };
        // Claude Code answers the queued note in a reply turn, which hits the budget cap.
        replyTurnRan = true;
        const uuid = handed[0]?.uuid;
        yield {
          type: "assistant",
          message: { content: [] },
          session_id: "live-4",
          ...(uuid === undefined ? {} : { user_message_uuid: uuid, user_message_uuids: [uuid] }),
        };
        yield {
          type: "result",
          subtype: "error_max_budget_usd",
          errors: ["Reached maximum budget"],
          session_id: "live-4",
        };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent });
    const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Review it.")));
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(terminalTaskResult(events).findings).toMatchObject([
      { id: "F1", severity: "high", summary: "Real review finding" },
    ]);
    // The session ends at the final result: no reply turn runs.
    expect(replyTurnRan).toBe(false);
  });

  it("reports accepted input the final result left unread as withdrawn", async () => {
    let worker: ReturnType<typeof createClaudeCodeWorker> | undefined;
    let acknowledgement: unknown;
    const queryAgent = (({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) =>
      (async function* () {
        const stream = prompt[Symbol.asyncIterator]();
        await stream.next();
        void (async () => {
          for (let next = await stream.next(); !next.done; next = await stream.next()) {}
        })();
        yield { type: "system", subtype: "init", session_id: "live-5" };
        yield { type: "assistant", message: { content: [] }, session_id: "live-5" };
        // Claude Code takes a teammate's note while the final turn is writing its result.
        acknowledgement = await worker?.control?.(input("team-input:d1", "FYI: thanks"));
        yield { type: "result", subtype: "success", result: "Done.", session_id: "live-5" };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent });
    const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Build it.")));
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(acknowledgement).toMatchObject({ id: "team-input:d1", status: "accepted" });
    // The model never read it, so its sender treats it as not delivered.
    expect(events.filter((event) => event.type === "input.withdrawn")).toMatchObject([
      { type: "input.withdrawn", commandId: "team-input:d1" },
    ]);
  });

  it.each([
    ["a reply turn answers a note taken during the final turn", "note"],
    ["a turn continues after the final result", "turn"],
    ["a hook runs after the final result", "hook"],
  ] as const)("keeps edits out of the Task branch when %s", async (_case, after) => {
    const git = async (cwd: string, ...args: string[]) =>
      (await promisify(execFile)("git", args, { cwd })).stdout.trim();
    const tree = await mkdtemp(join(tmpdir(), "claude-code-task-branch-"));
    try {
      await git(tree, "init", "--quiet");
      await writeFile(join(tree, "work.ts"), "export const work = 1;\n");
      await git(tree, "add", "-A");
      await git(
        tree,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "--quiet",
        "-m",
        "base",
      );
      const base = await git(tree, "rev-parse", "HEAD");
      let worker: ReturnType<typeof createClaudeCodeWorker> | undefined;
      const queryAgent = (({
        prompt,
        options,
      }: {
        prompt: AsyncIterable<{ uuid?: string }>;
        options: import("@anthropic-ai/claude-agent-sdk").Options;
      }) =>
        (async function* () {
          const stream = prompt[Symbol.asyncIterator]();
          await stream.next();
          void (async () => {
            for (let next = await stream.next(); !next.done; next = await stream.next());
          })();
          yield { type: "system", subtype: "init", session_id: "edits" };
          yield { type: "assistant", message: { content: [] }, session_id: "edits" };
          if (after === "note") await worker?.control?.(input("note-1", "FYI: rename it"));
          yield { type: "result", subtype: "success", result: "Built it.", session_id: "edits" };
          if (after === "hook") {
            // A hook command runs outside PreToolUse, so only stopping Claude Code prevents it.
            yield {
              type: "system",
              subtype: "hook_started",
              hook_name: "Stop",
              session_id: "edits",
            };
            await writeFile(join(tree, "after-final.ts"), "edited\n");
            return;
          }
          // Like Claude Code, a later turn asks the PreToolUse hooks and edits unless one denies.
          const decisions = [];
          for (const matcher of options.hooks?.PreToolUse ?? [])
            for (const hook of matcher.hooks)
              decisions.push(
                await hook(
                  {
                    hook_event_name: "PreToolUse",
                    tool_name: "Write",
                    tool_input: { file_path: "after-final.ts" },
                    tool_use_id: "edit-1",
                    session_id: "edits",
                    transcript_path: "",
                    cwd: tree,
                  },
                  "edit-1",
                  { signal: new AbortController().signal },
                ),
              );
          const denied = decisions.some(
            (decision) =>
              "hookSpecificOutput" in decision &&
              decision.hookSpecificOutput?.hookEventName === "PreToolUse" &&
              decision.hookSpecificOutput.permissionDecision === "deny",
          );
          if (!denied) await writeFile(join(tree, "after-final.ts"), "edited\n");
          yield {
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "edit-1", name: "Write", input: {} }] },
            session_id: "edits",
          };
          yield { type: "result", subtype: "success", result: "Renamed.", session_id: "edits" };
        })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
      worker = createClaudeCodeWorker({ workspace: tree, queryAgent });
      const events = await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Build it.")));
      expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
      expect(terminalTaskResult(events).summary).toBe("Built it.");
      // Commit what the Attempt left, as Workspace finalize does once the Attempt ends.
      if (await git(tree, "status", "--porcelain", "--untracked-files=all")) {
        await git(tree, "add", "-A");
        await git(
          tree,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "--quiet",
          "-m",
          "Task",
        );
      }
      expect(await git(tree, "rev-parse", "HEAD")).toBe(base);
      expect(await git(tree, "ls-tree", "--name-only", "HEAD")).toBe("work.ts");
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  });

  it("rejects input once the query has closed its stream", async () => {
    let status: string | undefined;
    const queryAgent = (({ prompt }: { prompt: AsyncIterable<unknown> }) =>
      (async function* () {
        const stream = prompt[Symbol.asyncIterator]();
        await stream.next();
        yield { type: "result", subtype: "success", result: "done", session_id: "live-2" };
        await stream.next();
        // Input closes before shutdown finishes and the result is published.
        status = (await worker.control?.(input("late-1", "too late")))?.status;
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent });
    await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Build it.")));
    expect(status).toBe("rejected");
  });

  it("opens no control channel for a one-shot CLI process", async () => {
    const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace });
    const context = harnessExecutionContext({
      attempt: taskAttemptSpec("Inspect"),
      sessionStateStore: new InMemorySessionStateStore(),
    });
    const execution = await harness.start(
      await harness.plan(context),
      environmentAccesses(testEnvironment(fixtureWorkspace)),
      context,
    );
    expect(execution.control).toBeUndefined();
    await execution.close();
  });
});

describe("Claude Code execution limits", () => {
  it("imposes no turn cap and a 60-minute time limit by default", async () => {
    const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace });
    const plan = await harness.plan(
      harnessExecutionContext({
        attempt: taskAttemptSpec("Inspect"),
        sessionStateStore: new InMemorySessionStateStore(),
      }),
    );
    expect(plan.metadata?.["maxTurns"]).toBeUndefined();
    expect(plan.metadata?.["timeoutMs"]).toBe(60 * 60_000);
    let observed: import("@anthropic-ai/claude-agent-sdk").Options | undefined;
    const queryAgent = (({
      options,
    }: {
      options: import("@anthropic-ai/claude-agent-sdk").Options;
    }) =>
      (async function* () {
        observed = options;
        yield { type: "result", subtype: "success", result: "done", session_id: "s-1" };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const events = await collectTaskAttemptEvents(
      createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent }).execute(
        taskAttemptSpec("Inspect"),
      ),
    );
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(observed).toBeDefined();
    expect(observed !== undefined && "maxTurns" in observed).toBe(false);
  });

  it("passes the Task's resolved model and effort to the Agent SDK", async () => {
    let observed: import("@anthropic-ai/claude-agent-sdk").Options | undefined;
    const queryAgent = (({
      options,
    }: {
      options: import("@anthropic-ai/claude-agent-sdk").Options;
    }) =>
      (async function* () {
        observed = options;
        yield { type: "result", subtype: "success", result: "done", session_id: "s-2" };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const worker = createClaudeCodeWorker({
      workspace: fixtureWorkspace,
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      queryAgent,
    });
    expect((await worker.describe()).profileCapabilities?.[0]).toMatchObject({
      harness: "claude-code",
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      efforts: ["low", "medium", "high"],
    });
    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...taskAttemptSpec("Inspect"),
        execution: { harness: "claude-code", model: "claude-sonnet-5-5", effort: "low" },
      }),
    );
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(observed).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
    // Without a Task model, the first served model is the default.
    await collectTaskAttemptEvents(worker.execute(taskAttemptSpec("Inspect")));
    expect(observed?.model).toBe("claude-opus-5-5");
    expect(observed && "effort" in observed).toBe(false);
  });

  it("keeps an explicitly configured turn cap", async () => {
    const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace, maxTurns: 7 });
    const plan = await harness.plan(
      harnessExecutionContext({
        attempt: taskAttemptSpec("Inspect"),
        sessionStateStore: new InMemorySessionStateStore(),
      }),
    );
    expect(plan.metadata?.["maxTurns"]).toBe(7);
  });
});

type ClaudeCodeRunCapture = {
  readonly prompt: string;
  readonly resumeSessionId?: string;
};

function claudeSessionStateRef(sessionId: string) {
  return {
    id: `claude-session:${sessionId}`,
    format: "claude-code-session-v1",
    uri: `claude-code://session/${sessionId}`,
    mediaType: "application/vnd.anthropic.claude-code-session+json;version=1",
    provenance: { provider: "claude-code", sessionId },
  } as const;
}

function historyInput(id: string, content: string) {
  return {
    id,
    kind: "history" as const,
    required: true,
    content,
    source: { uri: `supertag://work/${id}` },
    trust: "untrusted-history" as const,
  };
}

function claudeProfile() {
  return {
    ref: { id: "local-claude-code", revision: "1" },
    workerType: "supertag",
    harness: { provider: "claude-code" },
    execution: { provider: "local-execution", lifetime: { scope: "attempt" as const } },
  };
}

function testEnvironment(rootDirectory: string): ExecutionEnvironment {
  return {
    id: "local:test",
    placement: "local",
    rootDirectory,
    prepare: async () => undefined,
    prepareOutputDirectory: async (path: string) => {
      await mkdir(join(rootDirectory, path), { recursive: true });
    },
    resolvePath: (path: string) => join(rootDirectory, path),
    read: async (path: string) => await readFile(join(rootDirectory, path), "utf8"),
    spawn: async () => {
      throw new Error("not used");
    },
    dispose: async () => undefined,
  };
}

function environmentAccesses(environment: ExecutionEnvironment) {
  return { runtime: environment, execution: environment };
}

it("runs stock local Claude through an owned process and normalizes streamed progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-owned-cli-"));
  const executable = join(directory, "claude-fixture");
  await writeFile(
    executable,
    `#!${process.execPath}
if(!Object.hasOwn(process.env,'CLAUDE_SECURESTORAGE_CONFIG_DIR'))process.exit(4);
const budget=process.argv.indexOf('--max-budget-usd');if(budget<0||process.argv[budget+1]!=='2.5')process.exit(5);
process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'task_started',task_id:'inspect',description:'Inspect files'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'Owned CLI result',total_cost_usd:1.23,usage:{input_tokens:10,output_tokens:4,cache_creation_input_tokens:2,cache_read_input_tokens:3},session_id:'fixture-session'}))});
`,
  );
  await chmod(executable, 0o700);
  try {
    const worker = createClaudeCodeWorker({ workspace: directory, executable });
    const task = taskAttemptSpec("Inspect");
    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...task,
        execution: {
          limits: { maxReportedCost: { amountMinor: 250, currency: "USD" } },
        },
      }),
    );
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(terminalOutputText(events)).toBe("Owned CLI result");
    expect(events.some((event) => event.type === "progress.updated")).toBe(true);
    expect(events.find((event) => event.type === "usage.updated")).toMatchObject({
      usage: { reportedCost: { amountMinor: 123, currency: "USD" } },
    });
    expect(events.some((event) => event.type === "session.updated")).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["\n", ""])(
  "keeps the one-shot final result during usage cancellation (terminator %j)",
  async (terminator) => {
    const controller = new AbortController();
    const wait = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const environment: ExecutionEnvironment = {
      ...testEnvironment(fixtureWorkspace),
      spawn: async () => ({
        output: (async function* () {
          yield {
            stream: "stdout" as const,
            text:
              JSON.stringify({
                type: "result",
                subtype: "success",
                result: "Reviewed.\nFinding: high | Keep me | a.ts:1",
                total_cost_usd: 0.25,
                usage: {
                  input_tokens: 10,
                  output_tokens: 4,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
              }) + terminator,
          };
        })(),
        wait,
        kill: vi.fn(),
      }),
    };
    const worker = createClaudeCodeWorker({
      workspace: fixtureWorkspace,
      executionEnvironment: {
        id: "one-shot-test",
        capabilities: [{ id: "supertag.process-output-streaming", version: 1 }],
        provision: async () => environment,
      },
    });
    const events = [];
    for await (const event of worker.execute(taskAttemptSpec("Review"), controller.signal)) {
      events.push(event);
      if (event.type === "usage.updated" && event.usage.complete)
        controller.abort(new Error("cancel during final accounting"));
      if (event.type === "output.message") expect(wait).toHaveBeenCalledOnce();
    }
    expect(controller.signal.aborted, JSON.stringify(events)).toBe(true);
    expect(events.filter((event) => event.type === "usage.updated")).toMatchObject([
      { usage: { complete: true, reportedCost: { amountMinor: 25, currency: "USD" } } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "execution.completed" });
    expect(terminalTaskResult(events).findings).toMatchObject([
      { id: "F1", severity: "high", summary: "Keep me" },
    ]);
  },
);

it("terminates the owned process when Claude emits malformed stream JSON", async () => {
  const kill = vi.fn();
  const wait = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "stopped" }));
  const environment = {
    placement: "local",
    resolvePath: (path: string) => path,
    spawn: async () => ({
      output: (async function* () {
        yield { stream: "stdout" as const, text: "not json\n" };
      })(),
      kill,
      wait,
    }),
  } as unknown as ExecutionEnvironment;
  const events = async () => {
    for await (const _ of runClaudeCode(
      {
        prompt: "test",
        runtimeDirectory: ".",
        workspace: ".",
        timeoutMs: 100,
        maxTurns: 1,
        mcpServers: [],
        runtimeActions: [],
      },
      environment,
      environment,
    )) {
    }
  };
  await expect(events()).rejects.toThrow();
  expect(kill).toHaveBeenCalledOnce();
  expect(wait).toHaveBeenCalledOnce();
});

it("persists only the completed transcript and resumes stock CLI in a fresh environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-native-sessionState-"));
  const executable = join(directory, "claude-fixture");
  const sessionId = "018f52f0-635a-7b4f-9678-d3a4a6108c31";
  await writeFile(
    executable,
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const home=process.env.CLAUDE_CONFIG_DIR;
const key=fs.realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g,'-');
const transcript=path.join(home,'projects',key,'${sessionId}.jsonl');
const resumed=process.argv.includes('--resume');
if(resumed && (!fs.existsSync(transcript) || !fs.readFileSync(transcript,'utf8').includes('prior evidence'))) process.exit(2);
if(resumed && fs.existsSync(path.join(home,'credentials.json'))) process.exit(3);
fs.mkdirSync(path.dirname(transcript),{recursive:true});
fs.writeFileSync(transcript,JSON.stringify({type:'user',sessionId:'${sessionId}',message:{role:'user',content:'prior evidence'}})+'\\n');
fs.writeFileSync(path.join(home,'credentials.json'),'DO-NOT-COPY');
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',result:resumed?'Resumed transcript':'First turn',session_id:'${sessionId}'})));
`,
  );
  await chmod(executable, 0o700);
  try {
    const sessionStateStore = new InMemorySessionStateStore();
    const worker = createClaudeCodeWorker({ workspace: directory, executable, sessionStateStore });
    const first = await collectTaskAttemptEvents(
      worker.execute({ ...taskAttemptSpec("First"), session: { id: "native-session" } }),
    );
    expect(first.at(-1)?.type, JSON.stringify(first)).toBe("execution.completed");
    const sessionState = first.find((event) => event.type === "session.updated");
    expect(sessionState?.type).toBe("session.updated");
    if (sessionState?.type !== "session.updated") throw new Error("Missing sessionState");
    const stored = await sessionStateStore.load(sessionState.sessionState);
    expect(JSON.stringify(stored)).not.toContain("DO-NOT-COPY");
    expect(stored?.data["transcript"]).toContain("prior evidence");
    const second = await collectTaskAttemptEvents(
      worker.execute({
        ...taskAttemptSpec("Continue"),
        attemptId: "second-native-attempt",
        session: { id: "native-session", sessionState: sessionState.sessionState },
      }),
    );
    expect(second.at(-1)?.type, JSON.stringify(second)).toBe("execution.completed");
    expect(terminalOutputText(second)).toBe("Resumed transcript");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["wrong-session", "oversized", "symlink"])(
  "rejects %s native transcript sessionStates",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "claude-invalid-sessionState-"));
    const executable = join(directory, "claude-fixture");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const home=process.env.CLAUDE_CONFIG_DIR;
const key=fs.realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g,'-');
const transcript=path.join(home,'projects',key,'fixture-session.jsonl');
fs.mkdirSync(path.dirname(transcript),{recursive:true});
const text=JSON.stringify({type:'user',sessionId:'${kind === "wrong-session" ? "other" : "fixture-session"}',message:'${kind === "oversized" ? "'+'x'.repeat(8*1024*1024)+'" : "evidence"}'});
if('${kind}'==='symlink'){fs.writeFileSync(path.join(home,'outside.jsonl'),text);fs.symlinkSync(path.join(home,'outside.jsonl'),transcript)}else fs.writeFileSync(transcript,text);
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',result:'done',session_id:'fixture-session'})));
`,
    );
    await chmod(executable, 0o700);
    try {
      const worker = createClaudeCodeWorker({ workspace: directory, executable });
      const events = await collectTaskAttemptEvents(
        worker.execute({ ...taskAttemptSpec("Inspect"), session: { id: "native-session" } }),
      );
      expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.failed");
      expect(events.some((event) => event.type === "session.updated")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("stages the default workspace and keeps runner writes out of the source", async () => {
  const source = await mkdtemp(join(tmpdir(), "claude-code-source-"));
  await writeFile(join(source, "input.txt"), "original");
  try {
    const worker = createClaudeCodeWorker({
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

it("keeps Claude local while routing every admitted workspace tool to split execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-split-execution-"));
  const sentinel = "ANTHROPIC-CREDENTIAL-SENTINEL-NEVER-IN-SANDBOX";
  const secureStorage = join(directory, "host-secure-storage");
  const hostConfig = join(directory, "host-claude-config");
  const storedCredential = "CLAUDE-STORED-CREDENTIAL-SENTINEL-NEVER-IN-SANDBOX";
  const fakeKeys = {
    ANTHROPIC_API_KEY: sentinel,
    ANTHROPIC_AUTH_TOKEN: "fake-claude-anthropic-token",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-oauth-token",
    CURSOR_API_KEY: "fake-claude-cursor-key",
  };
  const priorKeys = Object.fromEntries(
    ["CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CONFIG_DIR", ...Object.keys(fakeKeys)].map(
      (name) => [name, process.env[name]],
    ),
  );
  for (const [name, value] of Object.entries(fakeKeys)) process.env[name] = value;
  process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] = secureStorage;
  process.env["CLAUDE_CONFIG_DIR"] = hostConfig;
  await mkdir(secureStorage);
  await writeFile(join(secureStorage, ".credentials.json"), storedCredential);
  const localExecution = new LocalExecutionEnvironmentProvider({ temporaryDirectory: directory });
  const localRuntime = new LocalHarnessRuntimeProvider({ temporaryDirectory: directory });
  const recordingRuntime = {
    id: localRuntime.id,
    capabilities: localRuntime.capabilities,
    async provisionRuntime(spec: Parameters<typeof localRuntime.provisionRuntime>[0]) {
      const base = await localRuntime.provisionRuntime(spec);
      return new Proxy(base, {
        get(target, property) {
          if (property === "dispose")
            return async () => await rm(target.rootDirectory, { recursive: true, force: true });
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const sandboxPlans: unknown[] = [];
  const sandboxProcesses: ProcessSpec[] = [];
  const sandboxRoots: string[] = [];
  const recordingExecution: ExecutionEnvironmentProvider = {
    id: "recording-remote",
    capabilities: localExecution.capabilities,
    async provision(spec) {
      sandboxPlans.push(spec.plan);
      const base = await localExecution.provision(spec);
      sandboxRoots.push(base.rootDirectory);
      return new Proxy(base, {
        get(target, property) {
          if (property === "placement") return "remote";
          if (property === "prepare")
            return async (plan: unknown) => {
              sandboxPlans.push(plan);
              await target.prepare(plan as Parameters<typeof target.prepare>[0]);
            };
          if (property === "spawn")
            return async (processSpec: ProcessSpec, signal?: AbortSignal) => {
              sandboxProcesses.push(processSpec);
              let child: ReturnType<typeof execFile>;
              const result = new Promise<{
                exitCode: number | null;
                stdout: string;
                stderr: string;
              }>((resolveResult) => {
                child = execFile(
                  processSpec.command,
                  [...(processSpec.args ?? [])],
                  {
                    cwd: processSpec.cwd,
                    env: {
                      PATH: process.env["PATH"],
                      HOME: directory,
                      TMPDIR: directory,
                      ...processSpec.environment,
                    },
                    timeout: processSpec.timeoutMs,
                  },
                  (error, stdout, stderr) =>
                    resolveResult({
                      exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
                      stdout,
                      stderr,
                    }),
                );
                child.stdin?.end(processSpec.stdin);
                signal?.addEventListener("abort", () => child.kill(), { once: true });
              });
              return { wait: () => result, kill: () => child.kill() };
            };
          if (property === "dispose")
            return async () => await rm(target.rootDirectory, { recursive: true, force: true });
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const source = join(directory, "source");
  await mkdir(source);
  await writeFile(join(source, "input.txt"), "original\nneedle\n");
  let observedRuntime = "";
  let observedWorkspace = "";
  const fakeQuery = ((params: { readonly options: ClaudeAgentOptionsForTest }) => {
    return (async function* () {
      const options = params.options;
      expect(options.env["ANTHROPIC_API_KEY"]).toBe(fakeKeys.ANTHROPIC_API_KEY);
      observedRuntime = options.cwd;
      expect(options.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe(secureStorage);
      const server = options.mcpServers["supertag_execution"];
      if (server?.type !== "sdk") throw new Error("Missing execution MCP server");
      const registered = server.instance._registeredTools;
      expect(options.toolAliases).toEqual({
        Read: "mcp__supertag_execution__read",
        Glob: "mcp__supertag_execution__glob",
        Grep: "mcp__supertag_execution__grep",
        Write: "mcp__supertag_execution__write",
        Edit: "mcp__supertag_execution__edit",
        Bash: "mcp__supertag_execution__bash",
      });
      expect(options.disallowedTools).toEqual(
        expect.arrayContaining(["Read", "Glob", "Grep", "Write", "Edit", "Bash"]),
      );
      expect(options.allowedTools).not.toContain("Read");
      const read = await registered.read.handler({ file_path: "input.txt" }, {});
      expect(JSON.stringify(read)).toContain("needle");
      expect(JSON.stringify(await registered.glob.handler({ pattern: "*.txt" }, {}))).toContain(
        "input.txt",
      );
      expect(JSON.stringify(await registered.grep.handler({ pattern: "needle" }, {}))).toContain(
        "needle",
      );
      await registered.write.handler({ file_path: "created.txt", content: "from remote tool" }, {});
      await registered.edit.handler(
        { file_path: "created.txt", old_string: "remote", new_string: "execution" },
        {},
      );
      const bash = await registered.bash.handler({ command: "pwd" }, {});
      observedWorkspace = bash.content[0]?.text.trim() ?? "";
      expect(await registered.read.handler({ file_path: "created.txt" }, {})).toMatchObject({
        content: [{ text: "from execution tool" }],
      });
      const sandboxRoot = dirname(observedWorkspace);
      const sandboxFiles = await Promise.all(
        (await readdir(sandboxRoot, { recursive: true })).map(async (path) => ({
          path,
          content: await readFile(join(sandboxRoot, path), "utf8").catch(() => ""),
        })),
      );
      expect(JSON.stringify(sandboxPlans)).not.toContain(sentinel);
      expect(JSON.stringify(sandboxProcesses)).not.toContain(sentinel);
      for (const root of sandboxRoots) {
        await expect(readFile(join(root, ".claude", ".credentials.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(join(root, "workspace", ".credentials.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      const sandboxInputs = JSON.stringify({
        plans: sandboxPlans,
        processes: sandboxProcesses,
        files: sandboxFiles,
      });
      for (const value of Object.values(fakeKeys)) expect(sandboxInputs).not.toContain(value);
      const transcriptKey = (await realpath(options.cwd)).replace(/[^a-zA-Z0-9]/gu, "-");
      const transcript = join(
        options.env["CLAUDE_CONFIG_DIR"] as string,
        "projects",
        transcriptKey,
        "split-session.jsonl",
      );
      await mkdir(transcript.slice(0, transcript.lastIndexOf("/")), { recursive: true });
      await writeFile(
        transcript,
        `${JSON.stringify({ type: "user", sessionId: "split-session", message: "evidence" })}\n`,
      );
      yield {
        type: "result",
        subtype: "success",
        result: "split complete",
        session_id: "split-session",
      };
    })();
  }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
  try {
    const worker = createClaudeCodeWorker({
      workspace: source,
      queryAgent: fakeQuery,
      harnessRuntime: recordingRuntime,
      executionEnvironment: recordingExecution,
    });
    const task = taskAttemptSpec("Use split tools");
    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...task,
        authorization: {
          ...task.authorization,
          runtimeActions: ["files:write", "commands:execute"],
        },
      }),
    );
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(observedRuntime).toContain("supertag-attempt-");
    expect(observedWorkspace).toContain("supertag-attempt-");
    expect(observedRuntime).not.toBe(observedWorkspace);
    expect(sandboxProcesses.length).toBeGreaterThan(0);
    for (const value of [secureStorage, hostConfig, storedCredential, ...Object.values(fakeKeys)]) {
      expect(JSON.stringify(sandboxPlans)).not.toContain(value);
      expect(JSON.stringify(sandboxProcesses)).not.toContain(value);
    }
    expect(await readFile(join(source, "input.txt"), "utf8")).toBe("original\nneedle\n");
    expect(events.find((event) => event.type === "runtime-inputs.resolved")).toMatchObject({
      manifest: {
        harness: {
          id: "claude-code",
          provenance: { protocol: "claude-split-execution-bridge", protocolVersion: 1 },
        },
        executionEnvironment: { placement: "remote" },
        harnessRuntime: { placement: "local" },
      },
    });
  } finally {
    for (const [name, value] of Object.entries(priorKeys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses split commands without file writes while building the plan", async () => {
  const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace });
  const base = harnessExecutionContext({ attempt: taskAttemptSpec("Run a command") });
  await expect(
    harness.plan({
      ...base,
      profile: {
        ...base.profile,
        runtime: { provider: "local-harness-runtime", lifetime: { scope: "attempt" } },
      },
      attempt: {
        ...base.attempt,
        authorization: {
          ...base.attempt.authorization,
          runtimeActions: ["commands:execute"],
        },
      },
    }),
  ).rejects.toThrow("requires files:write when commands:execute");
});

it("resolves placement-specific session support and validates profile configuration", async () => {
  const harness = new ClaudeCodeHarness({ workspace: fixtureWorkspace });
  const base = harnessExecutionContext({
    attempt: taskAttemptSpec("Inspect"),
    sessionStateStore: new InMemorySessionStateStore(),
  });
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
    environments: environmentAccesses(testEnvironment(fixtureWorkspace)),
  });
  expect(local.capabilities.sessions).toEqual({ resume: true, export: true, scope: "portable" });
  expect(local.runtime?.source).toBe("configured");
  expect(local.runtime?.version).toMatch(/^\d+\./);
  await expect(
    harness.resolve({
      context,
      plan,
      environments: environmentAccesses({
        ...testEnvironment(fixtureWorkspace),
        placement: "remote",
      }),
    }),
  ).rejects.toThrow("Claude Code requires a local Worker Host runtime");
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

it("forwards environment MCP schemas and calls only to the Claude root", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { sharedMcpInputs } = await import("../../../../tests/support/shared-mcp-fixture.ts");
  const task = taskAttemptSpec("Publish shared evidence");
  const plan = {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" as const },
  };
  const environment = await new LocalExecutionEnvironmentProvider().provision({
    task,
    profile: {
      ref: task.workerProfile,
      workerType: "supertag",
      harness: { provider: "claude-code" },
      execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
    },
    plan,
  });
  await environment.prepare(plan);
  const original = sharedMcpInputs(environment.rootDirectory, "secret")[0];
  if (original?.binding.kind !== "mcp-stdio") throw new Error("Missing fixture");
  const input = { ...original, binding: { ...original.binding, command: process.execPath } };
  const fakeQuery = (({ options }: { options: import("@anthropic-ai/claude-agent-sdk").Options }) =>
    (async function* () {
      const server = options.mcpServers?.["shared_stdio"];
      if (server?.type !== "sdk") throw new Error("Expected SDK forwarder");
      expect(server).not.toHaveProperty("command");
      expect(server).not.toHaveProperty("env");
      const child = options.agents?.["supertag-local"];
      expect(child?.mcpServers).toEqual([]);
      expect(child?.tools?.some((name) => name.startsWith("mcp__shared_stdio"))).toBe(false);
      const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
      if (!hook) throw new Error("Missing root guard");
      const hookInput = {
        hook_event_name: "PreToolUse",
        agent_id: "child",
        tool_name: "mcp__shared_stdio__exchange",
        tool_input: {},
        tool_use_id: "call",
        session_id: "session",
        transcript_path: "",
        cwd: environment.rootDirectory,
      } as const;
      expect(await hook(hookInput, "call", { signal: new AbortController().signal })).toMatchObject(
        { hookSpecificOutput: { permissionDecision: "deny" } },
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "claude-test", version: "1" });
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["exchange"]);
        const allowed = await client.callTool({
          name: "exchange",
          arguments: { collection: "docs", action: "publish", text: "claude-root-evidence" },
        });
        expect(allowed).toMatchObject({ content: [{ text: "claude-root-evidence" }] });
        const denied = await client.callTool({
          name: "exchange",
          arguments: { collection: "private", action: "read" },
        });
        expect(denied).toMatchObject({ isError: true });
        expect((await environment.read("mcp-calls.jsonl")).trim().split("\n")).toHaveLength(1);
      } finally {
        await client.close();
      }
      yield {
        type: "result",
        subtype: "success",
        result: "forwarded",
        session_id: "forwarded-session",
      };
    })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  try {
    const events = [];
    for await (const event of runClaudeCode(
      {
        prompt: "Use the shared MCP tools",
        runtimeDirectory: environment.rootDirectory,
        workspace: environment.rootDirectory,
        timeoutMs: 5_000,
        maxTurns: 3,
        mcpServers: [],
        runtimeActions: [],
        dynamicMcpInputs: [{ input, client: "execution-environment" }],
        toolInputs: [input],
      },
      environment,
      environment,
      undefined,
      fakeQuery,
    ))
      events.push(event);
    expect(events).toContainEqual({ type: "output.message", text: "forwarded", final: true });
  } finally {
    await environment.dispose();
  }
});

it("records Claude MCP placement without credentials and refuses changed routes", async () => {
  const { sharedMcpInputs } = await import("../../../../tests/support/shared-mcp-fixture.ts");
  const harness = new ClaudeCodeHarness({
    workspace: fixtureWorkspace,
    selectMcpClient: () => "execution-environment",
  });
  const inputs = sharedMcpInputs("/workspace", "private-http-token");
  const context = {
    ...harnessExecutionContext({
      attempt: taskAttemptSpec("Use shared MCP"),
      sessionStateStore: new InMemorySessionStateStore(),
    }),
    tools: inputs,
  };
  const plan = await harness.plan(context);
  expect(plan.metadata?.["mcpServers"]).toEqual([]);
  expect(plan.execution.network).toEqual({ mode: "allowlist", allowedHosts: ["127.0.0.1"] });
  expect(JSON.stringify(plan)).not.toContain("private-http-token");
  const environment = testEnvironment(fixtureWorkspace);
  await expect(
    harness.start(
      plan,
      { runtime: environment, execution: environment },
      { ...context, tools: [] },
    ),
  ).rejects.toThrow("routes do not match");
});

it.each([true, false])(
  "retains the primary Claude failure when MCP cleanup is uncertain (execution failed: %s)",
  async (executionFailed) => {
    const deleted: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") {
        deleted.push(String(request.headers["mcp-session-id"] ?? ""));
        response.writeHead(503).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "cleanup-fixture", version: "1" },
            }
          : { tools: [{ name: "inspect", inputSchema: { type: "object" } }] };
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "owned-session",
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const input: ToolInput = {
        id: "cleanup-fixture",
        kind: "tool",
        required: true,
        capability: {
          id: "cleanup-fixture",
          provider: "fixture",
          operations: [{ name: "inspect", effect: "read", actions: [] }],
        },
        binding: {
          kind: "mcp-http",
          name: "cleanup_fixture",
          url: `http://127.0.0.1:${address.port}/mcp`,
        },
      };
      const primary = new Error("Fixture native execution failed", {
        cause: new Error("Fixture original diagnostic"),
      });
      const fakeQuery = (() =>
        (async function* () {
          if (executionFailed) throw primary;
          yield {
            type: "result",
            subtype: "success",
            result: "done",
            session_id: "fixture-session",
          };
        })()) as typeof import("@anthropic-ai/claude-agent-sdk").query;
      const environment = testEnvironment(fixtureWorkspace);
      let failure: unknown;
      try {
        for await (const _event of runClaudeCode(
          {
            prompt: "Exercise error composition",
            runtimeDirectory: fixtureWorkspace,
            workspace: fixtureWorkspace,
            timeoutMs: 5_000,
            maxTurns: 2,
            mcpServers: [],
            runtimeActions: [],
            dynamicMcpInputs: [{ input, client: "worker-host" }],
            toolInputs: [input],
          },
          environment,
          environment,
          undefined,
          fakeQuery,
        )) {
          /* Consume the real client lifecycle. */
        }
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ExecutionCleanupError);
      if (!(failure instanceof Error) || !(failure.cause instanceof AggregateError))
        throw new Error("Missing cleanup causes");
      expect(failure.cause.errors).toHaveLength(executionFailed ? 2 : 1);
      if (executionFailed) {
        expect(failure.cause.errors[0]).toBe(primary);
        expect(failure.cause.errors[0].cause).toBe(primary.cause);
      }
      expect(failure.cause.errors.at(-1)).toBeInstanceOf(ExecutionCleanupError);
      expect(deleted).toEqual(["owned-session"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("resumes native SDK main and subagent transcripts through a new Worker and store instance", async () => {
  const database = new Map<string, string>();
  const store = () => ({
    async save(state: import("@supertag/worker-sdk").StoredHarnessSessionState) {
      database.set(state.ref.id, JSON.stringify(state));
    },
    async load(ref: import("@supertag/worker-sdk").SessionStateRef) {
      const value = database.get(ref.id);
      return value ? JSON.parse(value) : undefined;
    },
  });
  const nativeId = "portable-native-session";
  let call = 0;
  const queryAgent = (({
    options,
  }: {
    options: import("@anthropic-ai/claude-agent-sdk").Options;
  }) =>
    (async function* () {
      const key = { projectKey: `worker-${++call}`, sessionId: nativeId };
      const nativeStore = options.sessionStore;
      if (!nativeStore) throw new Error("Missing native Session store");
      if (call === 2) {
        expect(options.resume).toBe(nativeId);
        expect(await nativeStore.load(key)).toEqual([
          { type: "user", uuid: "user-1", message: "before compaction" },
          { type: "system", uuid: "compact-1", subtype: "compact_boundary" },
        ]);
        expect(await nativeStore.listSubkeys?.(key)).toEqual(["subagents/agent-child.jsonl"]);
        expect(await nativeStore.load({ ...key, subpath: "subagents/agent-child.jsonl" })).toEqual([
          { type: "assistant", uuid: "child-1", message: "child evidence" },
        ]);
      } else {
        await nativeStore.append(key, [
          { type: "user", uuid: "user-1", message: "before compaction" },
          { type: "system", uuid: "compact-1", subtype: "compact_boundary" },
        ]);
        await nativeStore.append({ ...key, subpath: "subagents/agent-child.jsonl" }, [
          { type: "assistant", uuid: "child-1", message: "child evidence" },
        ]);
        expect(database.size).toBe(1);
      }
      yield { type: "result", subtype: "success", result: "persisted", session_id: nativeId };
    })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const first = await collectTaskAttemptEvents(
    createClaudeCodeWorker({
      workspace: fixtureWorkspace,
      queryAgent,
      sessionStateStore: store(),
    }).execute({ ...taskAttemptSpec("first"), session: { id: "durable-session" } }),
  );
  expect(first.at(-1)?.type, JSON.stringify(first)).toBe("execution.completed");
  const state = first.find((event) => event.type === "session.updated");
  if (state?.type !== "session.updated") throw new Error("Missing native state");
  const second = await collectTaskAttemptEvents(
    createClaudeCodeWorker({
      workspace: fixtureWorkspace,
      queryAgent,
      sessionStateStore: store(),
    }).execute({
      ...taskAttemptSpec("second"),
      attemptId: "attempt-second",
      session: { id: "durable-session", sessionState: state.sessionState },
    }),
  );
  expect(second.at(-1)?.type, JSON.stringify(second)).toBe("execution.completed");
  expect(database.size).toBe(2);
});

it.each(["withdrawn", "answered", "unconfirmed", "timeout", "before-output"] as const)(
  "presents teammate input once on the next activation (%s)",
  async (mode) => {
    const answered = mode === "answered";
    const timedOut = mode === "timeout" || mode === "before-output";
    const database = new Map<string, string>();
    const store = () => ({
      async save(state: import("@supertag/worker-sdk").StoredHarnessSessionState) {
        database.set(state.ref.id, JSON.stringify(state));
      },
      async load(ref: import("@supertag/worker-sdk").SessionStateRef) {
        const value = database.get(ref.id);
        return value ? JSON.parse(value) : undefined;
      },
    });
    const note = "Teammate decision: preserve the selected schema";
    const nativeId = "withdrawn-input-session";
    let call = 0;
    let resumed: string | undefined;
    let nextContext = "";
    let acknowledgement: unknown;
    let worker: ReturnType<typeof createClaudeCodeWorker>;
    const queryAgent = (({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage>;
      options: import("@anthropic-ai/claude-agent-sdk").Options;
    }) =>
      (async function* () {
        const key = { projectKey: `worker-${++call}`, sessionId: nativeId };
        const nativeStore = options.sessionStore;
        if (!nativeStore) throw new Error("Missing native Session store");
        const stream = prompt[Symbol.asyncIterator]();
        const initial = await stream.next();
        if (initial.done) throw new Error("Missing activation prompt");
        if (call === 2) {
          resumed = options.resume;
          const history = options.resume ? await nativeStore.load(key) : [];
          nextContext = JSON.stringify([history, initial.value.message.content]);
          await nativeStore.append(key, [
            { type: "user", uuid: "next-activation", message: initial.value.message },
          ]);
          yield { type: "result", subtype: "success", result: "Continued.", session_id: nativeId };
          return;
        }
        await nativeStore.append(key, [
          { type: "user", uuid: "original-request", message: initial.value.message },
        ]);
        let delivered: import("@anthropic-ai/claude-agent-sdk").SDKUserMessage | undefined;
        let mirrored!: () => void;
        const inputMirrored = new Promise<void>((resolve) => {
          mirrored = resolve;
        });
        const mirrorInput = (async () => {
          for (let next = await stream.next(); !next.done; next = await stream.next()) {
            delivered = next.value;
            // The SDK persists the input before confirming its acceptance, even when no
            // model reply ever reads it. This archive survives replacement of the Worker.
            await nativeStore.append(key, [
              { type: "user", uuid: next.value.uuid, message: next.value.message },
            ]);
            mirrored();
            if (mode === "unconfirmed" || mode === "timeout") return;
          }
        })();
        if (mode !== "before-output")
          yield { type: "system", subtype: "init", session_id: nativeId };
        if (timedOut) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const receipt = worker.control?.({
          id: "team-input:withdrawn-session",
          taskId: "task-1",
          attemptId: "attempt-1",
          type: "input",
          text: note,
        });
        await inputMirrored;
        if (timedOut) {
          try {
            await vi.advanceTimersByTimeAsync(4000);
            acknowledgement = await receipt;
          } finally {
            vi.useRealTimers();
          }
        } else if (mode !== "unconfirmed") acknowledgement = await receipt;
        // A late write confirmation cannot reverse the receipt that already timed out.
        if (mode === "timeout") void stream.next();
        if (mode === "before-output")
          yield { type: "system", subtype: "init", session_id: nativeId };
        if (answered || timedOut) {
          yield {
            type: "assistant",
            message: { content: [] },
            session_id: nativeId,
            user_message_uuid: delivered?.uuid,
          };
        }
        yield { type: "result", subtype: "success", result: "Done.", session_id: nativeId };
        await mirrorInput;
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    worker = createClaudeCodeWorker({
      workspace: fixtureWorkspace,
      queryAgent,
      sessionStateStore: store(),
    });
    const first = await collectTaskAttemptEvents(
      worker.execute({ ...taskAttemptSpec("Build it."), session: { id: "durable-session" } }),
    );
    expect(first.at(-1)?.type, JSON.stringify(first)).toBe("execution.completed");
    if (mode !== "unconfirmed")
      expect(acknowledgement).toMatchObject({ status: timedOut ? "unknown" : "accepted" });
    expect(first.filter((event) => event.type === "input.withdrawn")).toHaveLength(
      mode === "withdrawn" ? 1 : 0,
    );
    expect([...database.values()].join("\n")).toContain(note);
    const state = first.find((event) => event.type === "session.updated");
    // The Control Plane admits only promoted state. Withdrawn input returns in its digest;
    // answered input stays solely in native history.
    const second = await collectTaskAttemptEvents(
      createClaudeCodeWorker({
        workspace: fixtureWorkspace,
        queryAgent,
        sessionStateStore: store(),
      }).execute({
        ...taskAttemptSpec(answered ? "Continue." : `Continue.\nActivation digest:\n${note}`),
        attemptId: "attempt-second",
        session: {
          id: "durable-session",
          ...(state?.type === "session.updated" ? { sessionState: state.sessionState } : {}),
        },
      }),
    );
    expect(second.at(-1)?.type, JSON.stringify(second)).toBe("execution.completed");
    expect(nextContext.split(note)).toHaveLength(2);
    expect(resumed).toBe(answered ? nativeId : undefined);
    expect(state === undefined).toBe(!answered);
  },
);

it("retains native SDK partial transcript on failure without promoting a resume state", async () => {
  const saved: import("@supertag/worker-sdk").StoredHarnessSessionState[] = [];
  const queryAgent = (({
    options,
  }: {
    options: import("@anthropic-ai/claude-agent-sdk").Options;
  }) =>
    (async function* () {
      await options.sessionStore?.append({ projectKey: "worker", sessionId: "partial-session" }, [
        { type: "user", uuid: "partial-1", message: "durable partial evidence" },
      ]);
      yield { type: "system", subtype: "init", session_id: "partial-session" };
      throw new Error("original provider failure");
    })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const worker = createClaudeCodeWorker({
    workspace: fixtureWorkspace,
    queryAgent,
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
    worker.execute({ ...taskAttemptSpec("fail"), session: { id: "durable-session" } }),
  );
  expect(events.at(-1)).toMatchObject({
    type: "execution.failed",
    error: { message: expect.stringContaining("original provider failure") },
  });
  expect(saved.length).toBeGreaterThan(0);
  expect(JSON.stringify(saved[0])).toContain("durable partial evidence");
  expect(events.some((event) => event.type === "session.updated")).toBe(false);
});

it.each([false, true])(
  "preserves exhausted native state only with reliable mirroring: dropped=%s",
  async (dropped) => {
    const saved: import("@supertag/worker-sdk").StoredHarnessSessionState[] = [];
    const queryAgent = (({
      options,
    }: {
      options: import("@anthropic-ai/claude-agent-sdk").Options;
    }) =>
      (async function* () {
        await options.sessionStore?.append({ projectKey: "worker", sessionId: "partial-session" }, [
          { type: "user", uuid: "partial-1", message: "durable partial evidence" },
        ]);
        yield { type: "system", subtype: "init", session_id: "partial-session" };
        if (dropped)
          yield { type: "system", subtype: "mirror_error", session_id: "partial-session" };
        yield {
          type: "result",
          subtype: "error_max_budget_usd",
          errors: ["budget exhausted"],
          session_id: "partial-session",
        };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const worker = createClaudeCodeWorker({
      workspace: fixtureWorkspace,
      queryAgent,
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
      worker.execute({ ...taskAttemptSpec("fail"), session: { id: "durable-session" } }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "execution.failed",
      error: { name: "ExecutionBudgetExceededError" },
    });
    expect(saved.length).toBeGreaterThan(0);
    expect(JSON.stringify(saved[0])).toContain("durable partial evidence");
    expect(events.some((event) => event.type === "session.updated")).toBe(!dropped);
  },
);

it.each([false, true])(
  "does not promote a dropped mirror batch and preserves provider failure=%s",
  async (providerFails) => {
    const queryAgent = (() =>
      (async function* () {
        yield {
          type: "system",
          subtype: "mirror_error",
          error: "unavailable",
          session_id: "mirror-session",
        };
        if (providerFails) throw new Error("original provider failure");
        yield { type: "result", subtype: "success", result: "done", session_id: "mirror-session" };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const events = await collectTaskAttemptEvents(
      createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent }).execute({
        ...taskAttemptSpec("fail"),
        session: { id: "durable-session" },
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "execution.failed",
      error: {
        message: expect.stringContaining(
          providerFails ? "original provider failure" : "mirroring failed",
        ),
      },
    });
    expect(events.some((event) => event.type === "session.updated")).toBe(false);
  },
);

it("does not mark a subagent-only archive resumable", async () => {
  const saved: import("@supertag/worker-sdk").StoredHarnessSessionState[] = [];
  const queryAgent = (({
    options,
  }: {
    options: import("@anthropic-ai/claude-agent-sdk").Options;
  }) =>
    (async function* () {
      await options.sessionStore?.append(
        { projectKey: "worker", sessionId: "missing-main", subpath: "subagents/agent-child.jsonl" },
        [{ type: "assistant", uuid: "child", message: "child evidence" }],
      );
      yield { type: "result", subtype: "success", result: "done", session_id: "missing-main" };
    })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const events = await collectTaskAttemptEvents(
    createClaudeCodeWorker({
      workspace: fixtureWorkspace,
      queryAgent,
      sessionStateStore: {
        async save(state) {
          saved.push(state);
        },
        async load() {
          return undefined;
        },
      },
    }).execute({ ...taskAttemptSpec("fail"), session: { id: "durable-session" } }),
  );
  expect(saved.length).toBeGreaterThan(0);
  expect(events.at(-1)).toMatchObject({
    type: "execution.failed",
    error: { message: expect.stringContaining("main Session transcript is unavailable") },
  });
  expect(events.some((event) => event.type === "session.updated")).toBe(false);
});

it("exposes the observed native identity before SDK tool work without Session continuity", async () => {
  let execution: Awaited<ReturnType<ClaudeCodeHarness["start"]>>;
  let observedBeforeResult = false;
  const fakeQuery = (() =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "native-without-continuity" };
      // This is where the SDK can invoke capture_artifact before returning a result.
      expect(execution.session).toEqual({
        harnessId: "claude-code",
        id: "native-without-continuity",
      });
      observedBeforeResult = true;
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        session_id: "native-without-continuity",
      };
    })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const harness = new ClaudeCodeHarness({
    workspace: fixtureWorkspace,
    runner: async function* (request, runtime, environment, signal) {
      expect(request.sessionStore).toBeUndefined();
      yield* runClaudeCode(request, runtime, environment, signal, fakeQuery);
    },
  });
  const context = harnessExecutionContext({
    attempt: taskAttemptSpec("Capture a report"),
    sessionStateStore: new InMemorySessionStateStore(),
  });
  const environment = testEnvironment(fixtureWorkspace);
  execution = await harness.start(
    await harness.plan(context),
    environmentAccesses(environment),
    context,
  );
  try {
    expect(execution.session).toBeUndefined();
    for await (const _event of execution.run()) {
    }
    expect(observedBeforeResult).toBe(true);
  } finally {
    await execution.close();
  }
});

it.each(["local-attempt-one", "local-attempt-two", "execution target with spaces"])(
  "resolves deliverables for %s independently of repository cwd",
  async (target) => {
    let observed: { prompt: string; outputDirectory?: string } | undefined;
    const harness = new ClaudeCodeHarness({
      workspace: fixtureWorkspace,
      runner: async function* (request) {
        observed = request;
        yield { type: "output.message", text: "done" };
      },
    });
    const context = harnessExecutionContext({
      attempt: taskAttemptSpec("Create report"),
      sessionStateStore: new InMemorySessionStateStore(),
    });
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
        },
      },
    };
    const environment = testEnvironment(join(fixtureWorkspace, target));
    const execution = await harness.start(plan, environmentAccesses(environment), context);
    for await (const _event of execution.run()) {
    }
    expect(observed?.outputDirectory).toBe(environment.resolvePath("outputs/attempt-one"));
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

it.each([
  { split: false, write: true },
  { split: false, write: false },
  { split: true, write: true },
])(
  "forwards managed output env without widening runtime access ($split/$write)",
  async ({ split, write }) => {
    let captured: Record<string, unknown> | undefined;
    const fakeQuery = ((params: { options: Record<string, unknown> }) => {
      captured = params.options;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          session_id: "output-test",
          usage: {},
        };
      })();
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const runtime = testEnvironment(fixtureWorkspace);
    const execution = split ? testEnvironment(join(fixtureWorkspace, "execution")) : runtime;
    const outputDirectory = execution.resolvePath("outputs/attempt");
    const scratchDirectory = execution.resolvePath("scratch");
    for await (const _event of runClaudeCode(
      {
        prompt: "Create report",
        runtimeDirectory: runtime.rootDirectory,
        workspace: execution.rootDirectory,
        outputDirectory,
        scratchDirectory,
        timeoutMs: 1000,
        maxTurns: 1,
        mcpServers: [],
        runtimeActions: write ? ["files:write"] : [],
      },
      runtime,
      execution,
      undefined,
      fakeQuery,
    )) {
    }
    expect(captured?.["env"]).toMatchObject({
      SUPERTAG_OUTPUT_DIR: outputDirectory,
      SUPERTAG_SCRATCH_DIR: scratchDirectory,
    });
    expect(captured?.["additionalDirectories"]).toEqual(
      !split && write ? [outputDirectory, scratchDirectory] : undefined,
    );
  },
);

it("emits partial SDK usage before an interruption prevents the final result", async () => {
  const queryAgent = (() =>
    (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "api-call-one",
          content: [],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 5,
            output_tokens: 3,
          },
        },
      };
      throw new Error("Execution registered a durable wait");
    })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const events = await collectTaskAttemptEvents(
    createClaudeCodeWorker({
      workspace: fixtureWorkspace,
      queryAgent,
    }).execute(taskAttemptSpec("Wait for a future observation")),
  );
  expect(events.find((event) => event.type === "usage.updated")).toMatchObject({
    usage: { totalTokens: 20, complete: false },
  });
  expect(events.at(-1)?.type).toBe("execution.failed");
});

it("refuses a durable wait while background tasks would be discarded", async () => {
  const decisions: unknown[] = [];
  const queryAgent = (({
    options,
  }: {
    options: import("@anthropic-ai/claude-agent-sdk").Options;
  }) =>
    (async function* () {
      const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
      if (!hook) throw new Error("Missing root guard");
      const decide = (tool_name: string, agent_id?: string) =>
        hook(
          {
            hook_event_name: "PreToolUse",
            tool_name,
            tool_input: {},
            tool_use_id: "call",
            session_id: "background",
            transcript_path: "",
            cwd: fixtureWorkspace,
            ...(agent_id ? { agent_id } : {}),
          },
          "call",
          { signal: new AbortController().signal },
        );
      yield { type: "system", subtype: "init", session_id: "background" };
      const background = (tasks: unknown[]) => ({
        type: "system",
        subtype: "background_tasks_changed",
        tasks,
        session_id: "background",
      });
      yield background([
        { task_id: "a", task_type: "local_agent", description: "Fix issue 1" },
        { task_id: "w", task_type: "monitor", description: "watcher", ambient: true },
      ]);
      decisions.push(await decide("mcp__supertag__wait_for"));
      decisions.push(await decide("mcp__supertag__read_objective"));
      decisions.push(await decide("mcp__supertag__wait_for", "child"));
      yield background([
        { task_id: "w", task_type: "monitor", description: "watcher", ambient: true },
      ]);
      decisions.push(await decide("mcp__supertag__wait_for"));
      yield { type: "result", subtype: "success", result: "done", session_id: "background" };
    })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  await collectTaskAttemptEvents(
    createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent }).execute(
      taskAttemptSpec("Wait"),
    ),
  );
  expect(decisions[0]).toMatchObject({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining(
        "1 running background task(s): Fix issue 1",
      ),
    },
  });
  expect(decisions.slice(1)).toEqual([{}, {}, {}]);
});

it("retains final cancellation usage without accepting late output or completion", async () => {
  const controller = new AbortController();
  let interrupted = false;
  const queryAgent = (({
    options,
  }: {
    options: import("@anthropic-ai/claude-agent-sdk").Options;
  }) =>
    Object.assign(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "cancel-accounting" };
        controller.abort(new Error("registered wait"));
        await Promise.resolve();
        const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
        if (!hook) throw new Error("Missing cancellation guard");
        expect(
          await hook(
            {
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command: "echo unsafe" },
              tool_use_id: "late",
              session_id: "cancel-accounting",
              transcript_path: "",
              cwd: fixtureWorkspace,
            },
            "late",
            { signal: new AbortController().signal },
          ),
        ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
        yield {
          type: "result",
          subtype: "success",
          result: "must not publish",
          session_id: "cancel-accounting",
          total_cost_usd: 0.12,
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
        };
      })(),
      {
        interrupt: async () => {
          interrupted = true;
        },
      },
    )) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const events = await collectTaskAttemptEvents(
    createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent }).execute(
      taskAttemptSpec("Wait"),
      controller.signal,
    ),
  );
  expect(interrupted).toBe(true);
  expect(events.filter((e) => e.type === "usage.updated")).toEqual([
    expect.objectContaining({
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cachedInputTokens: 3,
        totalTokens: 19,
        complete: true,
        reportedCost: { amountMinor: 12, currency: "USD" },
      },
    }),
  ]);
  expect(
    events.some((e) =>
      ["output.message", "result", "execution.completed", "artifact.created"].includes(e.type),
    ),
  ).toBe(false);
});

it.runIf(process.env["SUPERTAG_LIVE_CLAUDE_USAGE"] === "1")(
  "collects final usage when a live Sonnet turn is interrupted",
  async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const controller = new AbortController();
    const events = [];
    const worker = createClaudeCodeWorker({
      workspace: fixtureWorkspace,
      queryAgent: query,
      model: "sonnet",
    });
    let cancelledAt = 0;
    for await (const event of worker.execute(
      taskAttemptSpec(
        "Explain the sorting algorithms in this repository in detail. Read the source files first.",
      ),
      controller.signal,
    )) {
      events.push(event);
      if (event.type === "usage.updated" && !event.usage.complete && !cancelledAt) {
        cancelledAt = Date.now();
        controller.abort(new Error("live accounting cancellation probe"));
      }
    }
    expect(cancelledAt).toBeGreaterThan(0);
    expect(Date.now() - cancelledAt).toBeLessThan(15_000);
    const reports = events.filter((e) => e.type === "usage.updated");
    expect(reports.at(-1)).toMatchObject({
      usage: { complete: true, reportedCost: { currency: "USD" } },
    });
    expect(events.some((e) => e.type === "execution.completed")).toBe(false);
  },
  120_000,
);

it("stops a busy Claude Agent SDK run at its total time limit, not after idle time", async () => {
  vi.useFakeTimers();
  try {
    let turns = 0;
    const fakeQuery = (({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        const signal = options.abortController.signal;
        // A model that keeps working: one message every ten minutes, never idle.
        while (true) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 10 * 60_000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          if (signal.aborted) throw signal.reason;
          turns++;
          yield {
            type: "assistant",
            session_id: "busy-session",
            message: { role: "assistant", content: [{ type: "text", text: `turn ${turns}` }] },
          };
        }
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const environment = {
      placement: "local",
      resolvePath: (path: string) => path,
    } as unknown as ExecutionEnvironment;
    const outcome = (async () => {
      for await (const _event of runClaudeCode(
        {
          prompt: "Keep working",
          runtimeDirectory: ".",
          workspace: ".",
          timeoutMs: 60 * 60_000,
          mcpServers: [],
          runtimeActions: [],
        },
        environment,
        environment,
        undefined,
        fakeQuery,
      )) {
      }
      return "completed";
    })().catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(turns).toBe(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toMatch(/timed out after 3600000ms/);
    expect(turns).toBe(5);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the final result when the time limit passes while Claude Code is still exiting", async () => {
  vi.useFakeTimers();
  try {
    const fakeQuery = (({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        const signal = options.abortController.signal;
        yield { type: "system", subtype: "init", session_id: "exiting-session" };
        yield {
          type: "result",
          subtype: "success",
          result: "Done.",
          session_id: "exiting-session",
        };
        // The process is slow to exit after its final result, past the Attempt's time limit.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2 * 60 * 60_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        throw signal.reason ?? new Error("exited");
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const environment = {
      placement: "local",
      resolvePath: (path: string) => path,
    } as unknown as ExecutionEnvironment;
    const outputs: string[] = [];
    const outcome = (async () => {
      for await (const event of runClaudeCode(
        {
          prompt: "Finish",
          runtimeDirectory: ".",
          workspace: ".",
          timeoutMs: 60 * 60_000,
          mcpServers: [],
          runtimeActions: [],
        },
        environment,
        environment,
        undefined,
        fakeQuery,
      ))
        if (event.type === "output.message") outputs.push(event.text);
      return "completed";
    })().catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(await outcome).toBe("completed");
    expect(outputs).toEqual(["Done."]);
  } finally {
    vi.useRealTimers();
  }
});

it("claims a one-shot final response before the process exit wait", async () => {
  const controller = new AbortController();
  const claimFinalResponse = vi.fn(() => !controller.signal.aborted);
  const result = { type: "result", subtype: "success", result: "original" };
  const environment: ExecutionEnvironment = {
    ...testEnvironment(fixtureWorkspace),
    spawn: async () => ({
      output: (async function* () {
        yield { stream: "stdout" as const, text: `${JSON.stringify(result)}\n` };
        expect(claimFinalResponse).toHaveBeenCalledOnce();
        controller.abort(new Error("cancel before process exit"));
        yield {
          stream: "stdout" as const,
          text: `${JSON.stringify({ ...result, result: "late replacement" })}\n`,
        };
      })(),
      wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      kill: () => {},
    }),
  };
  const events = [];
  for await (const event of runClaudeCode(
    {
      prompt: "Finish",
      runtimeDirectory: fixtureWorkspace,
      workspace: fixtureWorkspace,
      timeoutMs: 60_000,
      executable: "fake-claude",
      mcpServers: [],
      runtimeActions: [],
      claimFinalResponse,
    },
    environment,
    environment,
    controller.signal,
  ))
    events.push(event);
  expect(events.filter((event) => event.type === "output.message")).toEqual([
    { type: "output.message", text: "original", final: true },
  ]);
  expect(claimFinalResponse).toHaveBeenCalledOnce();
});

it.each([
  ["the exit wait", false],
  ["the output stream", true],
])(
  "keeps a claimed one-shot final response when cancellation fails %s",
  async (_label, streamFails) => {
    const controller = new AbortController();
    const claimFinalResponse = vi.fn(() => !controller.signal.aborted);
    const cancellation = new Error("cancel during exit wait");
    const kill = vi.fn();
    const environment: ExecutionEnvironment = {
      ...testEnvironment(fixtureWorkspace),
      spawn: async () => ({
        output: (async function* () {
          yield {
            stream: "stdout" as const,
            text: `${JSON.stringify({ type: "result", subtype: "success", result: "kept" })}\n`,
          };
          controller.abort(cancellation);
          // Process supervision closes the stream and fails the wait with the abort reason.
          if (streamFails) throw cancellation;
        })(),
        wait: async () => {
          throw cancellation;
        },
        kill,
      }),
    };
    const events = [];
    for await (const event of runClaudeCode(
      {
        prompt: "Finish",
        runtimeDirectory: fixtureWorkspace,
        workspace: fixtureWorkspace,
        timeoutMs: 60_000,
        executable: "fake-claude",
        mcpServers: [],
        runtimeActions: [],
        claimFinalResponse,
      },
      environment,
      environment,
      controller.signal,
    ))
      events.push(event);
    expect(events.filter((event) => event.type === "output.message")).toEqual([
      { type: "output.message", text: "kept", final: true },
    ]);
    expect(claimFinalResponse).toHaveBeenCalledOnce();
  },
);

it("streams a one-shot run's root reply text as output deltas", async () => {
  const delta = (text: string, parent: string | null = null, type = "text_delta") => ({
    type: "stream_event",
    parent_tool_use_id: parent,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: type === "text_delta" ? { type, text } : { type, thinking: text },
    },
  });
  let args: readonly string[] = [];
  const environment: ExecutionEnvironment = {
    ...testEnvironment(fixtureWorkspace),
    spawn: async (spec) => {
      args = spec.args ?? [];
      return {
        output: (async function* () {
          for (const line of [
            delta("Hello, "),
            delta("hidden", null, "thinking_delta"),
            delta("subagent text", "tool-1"),
            delta("world."),
            { type: "result", subtype: "success", result: "Hello, world." },
          ])
            yield { stream: "stdout" as const, text: `${JSON.stringify(line)}\n` };
        })(),
        wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        kill: () => {},
      };
    },
  };
  const events = [];
  for await (const event of runClaudeCode(
    {
      prompt: "Greet",
      runtimeDirectory: fixtureWorkspace,
      workspace: fixtureWorkspace,
      timeoutMs: 60_000,
      executable: "fake-claude",
      mcpServers: [],
      runtimeActions: [],
    },
    environment,
    environment,
  ))
    events.push(event);
  expect(args).toContain("--include-partial-messages");
  expect(
    events.filter((event) => event.type === "output.delta" || event.type === "output.message"),
  ).toEqual([
    { type: "output.delta", text: "Hello, " },
    { type: "output.delta", text: "world." },
    { type: "output.message", text: "Hello, world.", final: true },
  ]);
});

it("does not claim an empty one-shot result", async () => {
  const claimFinalResponse = vi.fn(() => true);
  const environment: ExecutionEnvironment = {
    ...testEnvironment(fixtureWorkspace),
    spawn: async () => ({
      output: (async function* () {
        yield {
          stream: "stdout" as const,
          text: `${JSON.stringify({ type: "result", subtype: "success", result: " " })}\n`,
        };
      })(),
      wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      kill: () => {},
    }),
  };
  const events = [];
  for await (const event of runClaudeCode(
    {
      prompt: "Finish",
      runtimeDirectory: fixtureWorkspace,
      workspace: fixtureWorkspace,
      timeoutMs: 60_000,
      executable: "fake-claude",
      mcpServers: [],
      runtimeActions: [],
      claimFinalResponse,
    },
    environment,
    environment,
  ))
    events.push(event);
  expect(claimFinalResponse).not.toHaveBeenCalled();
  expect(events.filter((event) => event.type === "output.message")).toEqual([
    { type: "output.message", text: " ", final: false },
  ]);
});

it("fails a claimed one-shot final response when cleanup is unconfirmed", async () => {
  const controller = new AbortController();
  const environment: ExecutionEnvironment = {
    ...testEnvironment(fixtureWorkspace),
    spawn: async () => ({
      output: (async function* () {
        yield {
          stream: "stdout" as const,
          text: `${JSON.stringify({ type: "result", subtype: "success", result: "kept" })}\n`,
        };
        controller.abort(new Error("cancel during exit wait"));
      })(),
      wait: async () => {
        throw new ExecutionCleanupError("Process tree termination could not be confirmed");
      },
      kill: () => {},
    }),
  };
  const events: unknown[] = [];
  await expect(
    (async () => {
      for await (const event of runClaudeCode(
        {
          prompt: "Finish",
          runtimeDirectory: fixtureWorkspace,
          workspace: fixtureWorkspace,
          timeoutMs: 60_000,
          executable: "fake-claude",
          mcpServers: [],
          runtimeActions: [],
          claimFinalResponse: () => !controller.signal.aborted,
        },
        environment,
        environment,
        controller.signal,
      ))
        events.push(event);
    })(),
  ).rejects.toBeInstanceOf(ExecutionCleanupError);
  expect(events.some((event) => (event as { type: string }).type === "output.message")).toBe(false);
});

it("keeps a Claude final response claimed before delayed Worker delivery", async () => {
  const controller = new AbortController();
  const queryAgent = (() =>
    (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "Claimed before cancellation.",
        session_id: "claimed-result",
      };
    })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const worker = createClaudeCodeWorker({
    workspace: fixtureWorkspace,
    runner: async function* (request, runtime, environment, signal) {
      for await (const event of runClaudeCode(request, runtime, environment, signal, queryAgent)) {
        if (event.type === "output.message") {
          // Query receipt has already claimed the response, but the Worker has not seen it.
          controller.abort(new Error("cancel before Worker delivery"));
          yield { type: "output.delta", text: "buffered event before final output" };
        }
        yield event;
      }
    },
  });
  const events = await collectTaskAttemptEvents(
    worker.execute(taskAttemptSpec("Finish"), controller.signal),
  );
  expect(controller.signal.aborted).toBe(true);
  expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: "execution.completed" });
  expect(terminalTaskResult(events).summary).toBe("Claimed before cancellation.");
});

it("keeps the final result when cancellation arrives during its usage reporting", async () => {
  const controller = new AbortController();
  const queryAgent = (() =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "final-accounting" };
      yield {
        type: "result",
        subtype: "success",
        result: "Reviewed.\nFinding: high | Keep me | a.ts:1",
        total_cost_usd: 0.25,
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        session_id: "final-accounting",
      };
      controller.signal.throwIfAborted();
    })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent });
  const events = [];
  for await (const event of worker.execute(taskAttemptSpec("Review"), controller.signal)) {
    events.push(event);
    if (event.type === "usage.updated" && event.usage.complete)
      controller.abort(new Error("cancel during final accounting"));
  }
  expect(controller.signal.aborted, JSON.stringify(events)).toBe(true);
  expect(events.filter((event) => event.type === "usage.updated")).toMatchObject([
    { usage: { complete: true, reportedCost: { amountMinor: 25, currency: "USD" } } },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "execution.completed" });
  expect(terminalTaskResult(events).findings).toMatchObject([
    { id: "F1", severity: "high", summary: "Keep me" },
  ]);
});

it.each(["cancellation", "a mirror failure"])(
  "keeps the final result when %s follows it",
  async (failure) => {
    const controller = new AbortController();
    const queryAgent = (() =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "after-final" };
        yield {
          type: "result",
          subtype: "success",
          result: "Reviewed.\nFinding: high | Keep me | a.ts:1",
          session_id: "after-final",
        };
        if (failure === "cancellation") controller.abort(new Error("cancel after final"));
        else
          yield {
            type: "system",
            subtype: "mirror_error",
            error: "late mirror failure",
            session_id: "after-final",
          };
      })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const worker = createClaudeCodeWorker({ workspace: fixtureWorkspace, queryAgent });
    const events = await collectTaskAttemptEvents(
      worker.execute(
        {
          ...taskAttemptSpec("Review"),
          // Session continuity: a mirror failure must stop the session from being resumed.
          ...(failure === "a mirror failure" ? { session: { id: "durable-session" } } : {}),
        },
        controller.signal,
      ),
    );
    expect(events.at(-1), JSON.stringify(events.slice(-3))).toMatchObject({
      type: "execution.completed",
    });
    expect(terminalTaskResult(events).findings).toMatchObject([
      { id: "F1", severity: "high", summary: "Keep me" },
    ]);
    // A transcript that may be incomplete is never offered for resumption.
    if (failure === "a mirror failure")
      expect(events.some((event) => event.type === "session.updated")).toBe(false);
  },
);

it("preserves process cleanup uncertainty after the Claude deadline expires", async () => {
  const failure = new ExecutionCleanupError("Claude process termination uncertain");
  const fakeQuery = (() =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "cleanup-timeout" };
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw failure;
    })()) as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const environment = testEnvironment(fixtureWorkspace);
  await expect(
    (async () => {
      for await (const _event of runClaudeCode(
        {
          prompt: "Finish",
          runtimeDirectory: fixtureWorkspace,
          workspace: fixtureWorkspace,
          timeoutMs: 1,
          mcpServers: [],
          runtimeActions: [],
        },
        environment,
        environment,
        undefined,
        fakeQuery,
      )) {
      }
    })(),
  ).rejects.toBe(failure);
});
