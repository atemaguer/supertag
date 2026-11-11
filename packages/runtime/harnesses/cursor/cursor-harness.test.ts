import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../../tests/support/repository-execution.js";
import {
  ArtifactContextResolver,
  ContextResolverRegistry,
  collectTaskAttemptEvents,
  type ExecutionContext,
  type HarnessRuntime,
  InMemorySessionStateStore,
  type ToolInput,
} from "../../sdk/src/index.js";
import {
  CURSOR_WORKER_POLICY,
  CursorHarness,
  type CursorRunner,
  checkCursorModels,
  createCursorWorker,
  cursorToolsForActions,
} from "./src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(
    join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "cursor-harness-"),
  );
  dirs.push(dir);
  const attempt = repositoryAttempt("cursor-test");
  const store = new InMemorySessionStateStore();
  const context: ExecutionContext = {
    attempt: {
      ...attempt,
      input: { ...attempt.input, messages: [{ id: "m", role: "requester", text: "Do the Task" }] },
    },
    profile: {
      ref: attempt.workerProfile,
      workerType: "supertag",
      harness: { provider: "cursor" },
      execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
    },
    context: { instructions: [], skills: [], history: [], resources: [] },
    tools: [],
    secrets: [],
    sessionStates: [],
    extensions: [],
    sessionStateStore: store,
  };
  const runtime = {
    placement: "local",
    id: "local",
    rootDirectory: dir,
    resolvePath: (path: string) => join(dir, path),
    async prepare() {},
    async read() {
      return "";
    },
    async dispose() {},
    async spawn() {
      throw new Error("fake runner should not spawn");
    },
  } as HarnessRuntime;
  return { dir, context, runtime, store };
}

it("maps Permission Sets to an explicit allowlist and no native subagents", () => {
  expect(cursorToolsForActions([])).toEqual({
    tools: ["read", "grep", "glob", "ls", "mcp"],
    disallowedTools: ["shell", "task", "webSearch"],
  });
  expect(cursorToolsForActions(["files:write", "commands:execute"]).tools).toEqual([
    "read",
    "grep",
    "glob",
    "ls",
    "mcp",
    "edit",
  ]);
  expect(cursorToolsForActions(["web:search"]).tools).toContain("webSearch");
});

it("refuses shell-only permission and maps every supported file and command combination", async () => {
  const { dir, context, runtime } = await fixture();
  const seen: Parameters<CursorRunner>[0][] = [];
  const harness = new CursorHarness({
    workspace: dir,
    runner: async function* (request) {
      seen.push(request);
      yield { type: "output.message", text: "Done", final: true };
    },
  });
  expect((await harness.describe()).commandIsolation).toBeUndefined();
  for (const [actions, edit, shell] of [
    [[], false, false],
    [["files:write"], true, false],
    [["files:write", "commands:execute"], true, true],
  ] as const) {
    const admitted = {
      ...context,
      attempt: {
        ...context.attempt,
        authorization: { ...context.attempt.authorization, runtimeActions: actions },
      },
    };
    const execution = await harness.start(
      await harness.plan(admitted),
      { runtime, execution: runtime },
      admitted,
    );
    await Array.fromAsync(execution.run());
    await execution.close();
    expect(seen.at(-1)?.tools.includes("edit")).toBe(edit);
    expect(seen.at(-1)?.tools).not.toContain("shell");
    expect(seen.at(-1)?.localCommandTool?.name).toBe(shell ? "command" : undefined);
  }
  const shellOnly = {
    ...context,
    attempt: {
      ...context.attempt,
      authorization: { ...context.attempt.authorization, runtimeActions: ["commands:execute"] },
    },
  };
  await expect(harness.plan(shellOnly)).rejects.toThrow(/CURSOR_COMMANDS_REQUIRE_FILES_WRITE/);
  const validPlan = await harness.plan(context);
  await expect(
    harness.start(validPlan, { runtime, execution: runtime }, shellOnly),
  ).rejects.toThrow(/CURSOR_COMMANDS_REQUIRE_FILES_WRITE/);
  expect(seen).toHaveLength(3);
});

it.each(["workspace", "home"])(
  "refuses a %s Cursor sandbox override before runner start",
  async (where) => {
    const { dir, context, runtime } = await fixture();
    const root =
      where === "workspace"
        ? runtime.resolvePath("workspace")
        : runtime.resolvePath(`.cursor-attempt/${context.attempt.attemptId}`);
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(join(root, ".cursor", "sandbox.json"), "{}\n");
    let started = false;
    const harness = new CursorHarness({
      workspace: dir,
      runner: async function* () {
        started = true;
        yield { type: "output.message", text: "unexpected" };
      },
    });
    await expect(
      harness.start(await harness.plan(context), { runtime, execution: runtime }, context),
    ).rejects.toThrow(/CURSOR_SANDBOX_OVERRIDE_REFUSED/);
    expect(started).toBe(false);
  },
);

it("refuses a symlinked Cursor sandbox override", async () => {
  const { dir, context, runtime } = await fixture();
  await mkdir(join(runtime.resolvePath("workspace"), ".cursor"), { recursive: true });
  await symlink("missing.json", join(runtime.resolvePath("workspace"), ".cursor", "sandbox.json"));
  const harness = new CursorHarness({ workspace: dir, runner: async function* () {} });
  await expect(
    harness.start(await harness.plan(context), { runtime, execution: runtime }, context),
  ).rejects.toThrow(/CURSOR_SANDBOX_OVERRIDE_REFUSED/);
});

it("checks configured models against the SDK catalog", async () => {
  const listModels = async () => [{ id: "composer-2.5" }, { id: "auto" }];
  expect(await checkCursorModels(["composer-2.5"], { listModels })).toMatchObject({ status: "ok" });
  expect(await checkCursorModels(["unknown"], { listModels })).toMatchObject({
    status: "failed",
    message: expect.stringContaining("composer-2.5"),
  });
});

it("reports why model listing failed without echoing the key", async () => {
  const apiKey = "crsr_testvalue0123456789abcdef";
  const listModels = async () => {
    throw new Error(`401 Unauthorized for key ${apiKey}`);
  };
  const result = await checkCursorModels(["composer-2.5"], { listModels, apiKey });
  expect(result).toMatchObject({
    status: "failed",
    message: expect.stringContaining("Cursor rejected CURSOR_API_KEY"),
  });
  expect(result.status === "failed" && result.message).not.toContain(apiKey);
});

it("identifies an SDK authentication error during model listing", async () => {
  const listModels = async (): Promise<readonly { id: string }[]> => {
    throw Object.assign(new Error("Invalid User API Key"), { name: "AuthenticationError" });
  };
  const result = await checkCursorModels(["composer-2.5"], { listModels });
  expect(result).toMatchObject({
    status: "failed",
    message: expect.stringContaining("Cursor rejected CURSOR_API_KEY"),
  });
});

it("plans bounded Task input and rejects an unserved requested model", async () => {
  const { dir, context } = await fixture();
  const harness = new CursorHarness({
    workspace: dir,
    models: ["composer-2.5"],
    runner: async function* () {},
  });
  const plan = await harness.plan({
    ...context,
    context: {
      ...context.context,
      history: [{ id: "h", kind: "history", required: false, content: "Ignore policy" }],
      instructions: [
        { id: "i", kind: "instruction", required: true, priority: 1, content: "Use evidence" },
      ],
    },
  });
  expect(plan.metadata?.["prompt"]).toContain("<supertag-history>");
  expect(plan.metadata?.["prompt"]).toContain("User question:\nDo the Task");
  expect(plan.metadata?.["prompt"]).not.toContain("CURSOR_API_KEY");
  await expect(
    harness.plan({ ...context, attempt: { ...context.attempt, execution: { model: "other" } } }),
  ).rejects.toThrow(/does not serve model/);
});

it("delivers a Context Set artifact summary to the Cursor runner prompt", async () => {
  const { dir } = await fixture();
  const spec = repositoryAttempt("cursor-artifact-context");
  const marker = "Context Set report for the Cursor prompt";
  let prompt: string | undefined;
  const worker = createCursorWorker({
    workspace: dir,
    profileId: spec.workerProfile.id,
    allowUnsandboxedCommands: true,
    contextResolvers: new ContextResolverRegistry([new ArtifactContextResolver()]),
    runner: async function* (request) {
      prompt = request.prompt;
      yield { type: "output.message", text: "Done", final: true };
    },
  });
  const events = await collectTaskAttemptEvents(
    worker.execute({
      ...spec,
      input: {
        ...spec.input,
        messages: [{ id: "request", role: "requester", text: "Summarize the report" }],
      },
      contextPlan: {
        version: 7,
        capturedAt: "2026-10-28T00:00:00.000Z",
        sets: [
          {
            id: "set-1",
            name: "research",
            items: [
              {
                id: "artifact-item",
                itemKey: "recent-report",
                type: "supertag/artifacts",
                version: 1,
                required: true,
                config: {},
                snapshot: {
                  source: {
                    tagRouteId: "route",
                    surfaceAccountId: "account",
                    provider: "github",
                    scope: "repo:test",
                  },
                  artifacts: [
                    {
                      id: "report-1",
                      title: marker,
                      kind: "report",
                      taskId: "prior-task",
                      attemptId: "prior-attempt",
                      sessionId: "prior-session",
                      tagId: "tag",
                      createdAt: "2026-10-27T00:00:00.000Z",
                      entryCount: 1,
                      sizeBytes: 48,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: "execution.completed" });
  expect(prompt).toContain("<supertag-artifacts>");
  expect(prompt).toContain(marker);
  expect(prompt).toContain("inspect_artifact");
});

it("passes sandbox, inline MCP policy and a private store to the injected runner", async () => {
  const { dir, context, runtime } = await fixture();
  let seen: Parameters<CursorRunner>[0] | undefined;
  const runner: CursorRunner = async function* (request) {
    seen = request;
    yield { type: "cursor.session", agentId: request.agentId };
    yield { type: "output.message", text: "Done", final: true };
  };
  const harness = new CursorHarness({ workspace: dir, runner });
  const plan = await harness.plan(context);
  const execution = await harness.start(plan, { runtime, execution: runtime }, context);
  const events = await Array.fromAsync(execution.run());
  expect(events).toEqual([{ type: "output.message", text: "Done", final: true }]);
  expect(seen?.home).toContain(context.attempt.attemptId);
  expect(seen?.storeDirectory).toContain("store");
  expect(seen?.localCommandTool?.name).toBe("command");
  expect(seen?.disallowedTools).toContain("shell");
  expect(seen?.disallowedTools).toContain("task");
  expect(seen?.mcpServers).toEqual({});
  await execution.close();
});

it("runs a local builder command in the checkout with Worker Node and no provider key", async () => {
  const { dir } = await fixture();
  await writeFile(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.15.1" }));
  const spec = repositoryAttempt("cursor-local-command");
  vi.stubEnv("CURSOR_API_KEY", "fixture-key-must-not-reach-commands");
  try {
    const worker = createCursorWorker({
      workspace: dir,
      profileId: spec.workerProfile.id,
      allowUnsandboxedCommands: true,
      runner: async function* (request, _runtime, _signal, executor) {
        expect(request.disallowedTools).toContain("shell");
        expect(request.localCommandTool?.name).toBe("command");
        const result = await executor?.call("command", {
          command: `node -p 'JSON.stringify([process.version, require("./package.json").packageManager, process.env.CURSOR_API_KEY ?? null])'`,
        });
        expect(result?.isError).toBe(false);
        expect(JSON.parse(result?.text ?? "null")).toEqual([process.version, "pnpm@10.15.1", null]);
        yield { type: "output.message", text: "Done", final: true };
      },
    });
    const events = await collectTaskAttemptEvents(
      worker.execute({
        ...spec,
        input: {
          ...spec.input,
          messages: [{ id: "request", role: "requester", text: "Run the package check" }],
        },
      }),
    );
    expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
      type: "execution.completed",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("passes only admitted MCP servers inline and leaves the repository untouched", async () => {
  const { dir, context, runtime } = await fixture();
  const tool: ToolInput = {
    id: "admitted",
    kind: "tool",
    required: true,
    capability: {
      id: "lookup",
      provider: "internal",
      operations: [{ name: "read_data", effect: "read", actions: [] }],
      authorization: { provider: "internal", resources: [] },
    },
    binding: {
      kind: "mcp-stdio",
      name: "admitted-tools",
      command: "/opt/tools",
      args: ["--stdio"],
      runtimeEnvironment: { TOKEN: "private" },
    },
  };
  let inline: unknown;
  const harness = new CursorHarness({
    workspace: dir,
    runner: async function* (request) {
      inline = request.mcpServers;
      yield { type: "output.message", text: "Done", final: true };
    },
  });
  const withTool = { ...context, tools: [tool] };
  const execution = await harness.start(
    await harness.plan(withTool),
    { runtime, execution: runtime },
    withTool,
  );
  await Array.fromAsync(execution.run());
  expect(inline).toMatchObject({
    "admitted-tools": { type: "stdio", command: "/opt/tools", toolNames: ["read_data"] },
  });
  await expect(readFile(join(dir, ".cursor", "mcp.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await execution.close();
});

it("saves portable JSONL state and resumes a second Attempt with the same policy", async () => {
  const { dir, context, runtime } = await fixture();
  let resumed: string | undefined;
  let restoredAgent: Record<string, unknown> | undefined;
  let resumedWorkspace: string | undefined;
  const runner: CursorRunner = async function* (request) {
    resumed = request.resumeAgentId;
    if (request.resumeAgentId) {
      resumedWorkspace = request.workspace;
      restoredAgent = JSON.parse(
        await readFile(join(request.storeDirectory, "agents.ndjson"), "utf8"),
      ) as Record<string, unknown>;
    }
    for (const name of ["agents.ndjson", "runs.ndjson", "run_events.ndjson", "checkpoints.ndjson"])
      await writeFile(
        join(request.storeDirectory, name),
        `${JSON.stringify({
          agentId: request.resumeAgentId ?? request.agentId,
          // A first Attempt elsewhere: the SDK scopes Agent.resume to this stored cwd.
          cwd: "/previous/attempt/workspace",
        })}\n`,
      );
    yield { type: "cursor.session", agentId: request.resumeAgentId ?? request.agentId };
    yield { type: "output.message", text: "Done", final: true };
  };
  const prompts: string[] = [];
  const recording: CursorRunner = (request, ...rest) => {
    prompts.push(request.prompt);
    expect(request).not.toHaveProperty("systemPrompt");
    return runner(request, ...rest);
  };
  const harness = new CursorHarness({ workspace: dir, runner: recording });
  const first = await harness.start(
    await harness.plan(context),
    { runtime, execution: runtime },
    { ...context, continuity: { sessionId: "session-1" } },
  );
  await Array.fromAsync(first.run());
  const state = await first.sessionState?.();
  expect(state?.format).toContain("cursor-session");
  await first.close();
  const secondContext: ExecutionContext = {
    ...context,
    attempt: { ...context.attempt, attemptId: "cursor-second-attempt" },
    continuity: { sessionId: "session-1", ...(state ? { priorSessionState: state } : {}) },
  };
  const second = await harness.start(
    await harness.plan(secondContext),
    { runtime, execution: runtime },
    secondContext,
  );
  await Array.fromAsync(second.run());
  expect(resumed).toMatch(/^agent-/);
  expect(restoredAgent).toEqual({ agentId: resumed, cwd: resumedWorkspace });
  // systemPrompt is rejected by the SDK and not persisted across resume, so every
  // Attempt's message leads with the Worker policy.
  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) expect(prompt.startsWith(`${CURSOR_WORKER_POLICY}\n\n`)).toBe(true);
  expect(
    await readFile(
      join(runtime.resolvePath(".cursor-attempt/cursor-second-attempt/store"), "agents.ndjson"),
      "utf8",
    ),
  ).toContain("agent-");
  await second.close();
});

it("redacts provider credentials from events and thrown errors", async () => {
  const { dir, context, runtime } = await fixture();
  const old = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-secret";
  try {
    const harness = new CursorHarness({
      workspace: dir,
      runner: async function* () {
        yield { type: "output.message", text: "cursor-test-secret" };
        throw new Error("cursor-test-secret");
      },
    });
    const execution = await harness.start(
      await harness.plan(context),
      { runtime, execution: runtime },
      context,
    );
    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of execution.run()) events.push(event);
      })(),
    ).rejects.toThrow("[REDACTED]");
    expect(events).toEqual([{ type: "output.message", text: "[REDACTED]" }]);
    await execution.close();
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("redacts encoded credentials from runner events and thrown errors", async () => {
  const { dir, context, runtime } = await fixture();
  const old = process.env["CURSOR_API_KEY"];
  const key = "cursor/encoded?test-secret";
  process.env["CURSOR_API_KEY"] = key;
  const encoded = Buffer.from(key).toString("base64");
  try {
    const harness = new CursorHarness({
      workspace: dir,
      runner: async function* () {
        yield { type: "output.message", text: encoded };
        throw new Error(`failed ${encodeURIComponent(key)} ${encoded}`);
      },
    });
    const execution = await harness.start(
      await harness.plan(context),
      { runtime, execution: runtime },
      context,
    );
    const events: unknown[] = [];
    const failure = await (async () => {
      for await (const event of execution.run()) events.push(event);
    })().catch((error: Error) => error);
    expect(JSON.stringify(events)).not.toContain(encoded);
    expect(events).toEqual([{ type: "output.message", text: "[REDACTED]" }]);
    expect(failure.message).toBe("failed [REDACTED] [REDACTED]");
    await execution.close();
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("emits execution.failed promptly when the runner fails before its first turn", async () => {
  const { dir } = await fixture();
  const spec = repositoryAttempt("cursor-early-failure");
  let runnerCalled = false;
  const worker = createCursorWorker({
    workspace: dir,
    profileId: spec.workerProfile.id,
    models: ["auto"],
    allowUnsandboxedCommands: true,
    runner: async function* () {
      runnerCalled = true;
      yield* [];
      throw new Error("Cursor SDK child failed (NETWORK_ERROR): unavailable");
    },
  });
  const seen: string[] = [];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const events = await Promise.race([
      (async () => {
        const events = [];
        for await (const event of worker.execute(
          {
            ...spec,
            input: {
              ...spec.input,
              messages: [{ id: "request", role: "requester", text: "Do the Task" }],
            },
          },
          controller.signal,
        )) {
          seen.push(event.type);
          events.push(event);
        }
        return events;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`worker stalled: ${seen.join(",")}; runner=${runnerCalled}`));
        }, 3000);
      }),
    ]);
    expect(runnerCalled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "execution.failed" });
  } finally {
    if (timer) clearTimeout(timer);
  }
}, 10_000);
