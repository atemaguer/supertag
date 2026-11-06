import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { PassThrough } from "node:stream";
import type { Agent, JsonlLocalAgentStore } from "@cursor/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../../tests/support/repository-execution.js";
import {
  ExecutionCleanupError,
  type ExecutionContext,
  type ExecutionEnvironment,
  type HarnessRuntime,
  InMemorySessionStateStore,
  type ProcessSpec,
} from "../../sdk/src/index.js";
import {
  CursorHarness,
  type CursorRunner,
  type CursorRunRequest,
  type CursorSplitExecutor,
  type CursorSplitExecutorOptions,
  type CursorSplitToolDefinition,
  cursorToolsForSplit,
  runCursor,
} from "./src/index.js";
import { CursorProcessTree } from "./src/process-tree.js";
import {
  cancelCursorSdk,
  cursorSdkErrorCode,
  cursorSdkErrorFrame,
  executeCursorSdk,
  runCursorStdio,
  serializeCursorRunnerFrame,
  settleWorkspaceCall,
} from "./src/runner.js";

const KEY = "cursor-secret-9f3a7c1d";
const TOOL_NAMES = ["read", "write", "edit", "glob", "grep", "ls", "command"] as const;
const TOOLS: readonly CursorSplitToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: `${name} in the remote workspace`,
  inputSchema: { type: "object", properties: {} },
}));

const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv("CURSOR_API_KEY", KEY);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Outcome = { text: string; isError: boolean };

function fakeExecutor(
  call: (name: string, input: unknown, signal?: AbortSignal) => Promise<Outcome> = async () => ({
    text: "ok",
    isError: false,
  }),
  tools: readonly CursorSplitToolDefinition[] = TOOLS,
) {
  const calls: { name: string; input: unknown; signal: AbortSignal | undefined }[] = [];
  return {
    tools,
    calls,
    call: vi.fn(async (name: string, input: unknown, signal?: AbortSignal) => {
      calls.push({ name, input, signal });
      return call(name, input, signal);
    }),
    cancelAll: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } satisfies CursorSplitExecutor & { calls: unknown[] };
}

/** A sandbox that records every use; the fake executor never touches it. */
function remoteEnvironment(used: string[] = []): ExecutionEnvironment {
  return {
    placement: "remote",
    id: "e2b-fixture",
    rootDirectory: "/remote/root",
    resolvePath: (path: string) => `/remote/root/${path}`,
    async prepare() {
      used.push("prepare");
    },
    async read() {
      used.push("read");
      return "";
    },
    async dispose() {
      used.push("dispose");
    },
    async spawn() {
      used.push("spawn");
      throw new Error("the fake executor must not spawn here");
    },
  } as ExecutionEnvironment;
}

/** Simulates the small process surface used by the shared bridge and records every sandbox input. */
function recordingEnvironment() {
  const root = "/remote/root";
  const files = new Map<string, string>();
  const processes: ProcessSpec[] = [];
  const killed: string[] = [];
  const environment: ExecutionEnvironment = {
    placement: "remote",
    id: "recording-sandbox",
    rootDirectory: root,
    resolvePath: (path) => posix.resolve(root, path),
    async prepare() {},
    async read(path) {
      return files.get(posix.resolve(root, path)) ?? "";
    },
    async dispose() {},
    async spawn(spec) {
      processes.push(spec);
      let finish!: (result: { exitCode: number | null; stdout: string; stderr: string }) => void;
      const done = new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          finish = resolve;
        },
      );
      const args = spec.args ?? [];
      const target = args.at(-1) ?? "";
      const result = (exitCode: number, stdout = "", stderr = "") =>
        finish({ exitCode, stdout, stderr });
      if (args[2] === "split-path") result(0, `${target}\n`);
      else if (args[2] === "split-write") {
        files.set(target, spec.stdin ?? "");
        result(0);
      } else if (spec.command === "cat" || spec.command === "awk") {
        const value = files.get(target);
        result(value === undefined ? 1 : 0, value ?? "", value === undefined ? "missing" : "");
      } else if (spec.command === "find") result(0, [...files.keys()].join("\n"));
      else if (spec.command === "grep") result(0, "note.txt:second");
      else if (spec.command === "ls") result(0, "note.txt");
      else if (args[1] === "echo bridge-ok") result(0, "bridge-ok\n");
      else if (args[1] === "exit 7") result(7, "", "failed");
      else if (args[1] !== "sleep 600")
        throw new Error(`Unexpected sandbox process ${spec.command}`);
      return {
        wait: () => done,
        kill() {
          killed.push(args[1] ?? spec.command);
          finish({ exitCode: null, stdout: "", stderr: "killed" });
        },
      };
    },
  };
  return { environment, files, processes, killed };
}

async function fixture() {
  const dir = await mkdtemp(join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "cursor-split-"));
  dirs.push(dir);
  const attempt = repositoryAttempt("cursor-split-test");
  const context: ExecutionContext = {
    attempt: {
      ...attempt,
      authorization: {
        ...attempt.authorization,
        runtimeActions: ["files:write", "commands:execute"],
      },
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
    sessionStateStore: new InMemorySessionStateStore(),
  };
  const runtime = {
    placement: "local",
    id: "worker-host",
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
  return { dir, context, runtime };
}

function withActions(context: ExecutionContext, actions: readonly string[]): ExecutionContext {
  return {
    ...context,
    attempt: {
      ...context.attempt,
      authorization: { ...context.attempt.authorization, runtimeActions: actions },
    },
  };
}

function splitHarness(
  dir: string,
  runner: CursorRunner,
  executor: CursorSplitExecutor = fakeExecutor(),
) {
  const factory = vi.fn((_options: CursorSplitExecutorOptions) => executor);
  return {
    harness: new CursorHarness({ workspace: dir, runner, splitExecutor: factory }),
    factory,
  };
}

it("allows only mcp and denies every built-in tool, with deny winning", () => {
  const { tools, disallowedTools } = cursorToolsForSplit();
  expect(tools).toEqual(["mcp"]);
  for (const builtIn of [
    "shell",
    "read",
    "edit",
    "grep",
    "glob",
    "ls",
    "task",
    "webSearch",
    "delete",
    "readLints",
    "webFetch",
    "semSearch",
    "updateTodos",
    "readTodos",
    "askQuestion",
    "await",
    "generateImage",
    "applyAgentDiff",
  ])
    expect(disallowedTools).toContain(builtIn);
  expect(disallowedTools).not.toContain("mcp");
  expect(tools.filter((tool) => disallowedTools.includes(tool))).toEqual([]);
});

it("offers the shared split bridge by default and refuses a runtime away from the Worker Host", async () => {
  const { dir, context, runtime } = await fixture();
  const plain = new CursorHarness({ workspace: dir, runner: async function* () {} });
  const plan = await plain.plan(context);
  const execution = remoteEnvironment();
  expect((await plain.describe()).splitExecution).toBe(true);
  await expect(
    plain.resolve({ context, plan, environments: { runtime, execution } }),
  ).resolves.toMatchObject({ runtime: { name: "@cursor/sdk" } });

  const { harness } = splitHarness(dir, async function* () {});
  expect((await harness.describe()).splitExecution).toBe(true);
  await expect(
    harness.resolve({ context, plan, environments: { runtime, execution } }),
  ).resolves.toMatchObject({ runtime: { name: "@cursor/sdk" } });
  // Colocated execution still resolves, and the old refusal stays for a remote runtime.
  await expect(
    harness.resolve({ context, plan, environments: { runtime, execution: runtime } }),
  ).resolves.toBeDefined();
  const remoteRuntime = remoteEnvironment() as HarnessRuntime;
  await expect(
    harness.resolve({
      context,
      plan,
      environments: { runtime: remoteRuntime, execution: remoteRuntime },
    }),
  ).rejects.toThrow(/on the Worker Host/);
  await expect(harness.start(plan, { runtime: remoteRuntime, execution }, context)).rejects.toThrow(
    /on the Worker Host/,
  );
});

it("starts split with the allowlist, an empty private cwd and the remote root in the prompt", async () => {
  const { dir, context, runtime } = await fixture();
  const executor = fakeExecutor();
  let seen: CursorRunRequest | undefined;
  let received: CursorSplitExecutor | undefined;
  const runner: CursorRunner = async function* (request, _runtime, _signal, split) {
    seen = request;
    received = split;
    yield { type: "cursor.session", agentId: request.agentId };
    yield { type: "output.message", text: "Done", final: true };
  };
  const { harness, factory } = splitHarness(dir, runner, executor);
  const environment = remoteEnvironment();
  const execution = await harness.start(
    await harness.plan(context),
    { runtime, execution: environment },
    context,
  );
  await Array.fromAsync(execution.run());

  expect(factory).toHaveBeenCalledWith({
    environment,
    workspaceRoot: "/remote/root/workspace",
    readOnlyRoots: [],
    permissions: { filesWrite: true, commandsExecute: true },
  });
  expect(received).toBe(executor);
  expect(seen?.tools).toEqual(["mcp"]);
  expect(seen?.disallowedTools).toEqual(cursorToolsForSplit().disallowedTools);
  expect(seen?.splitTools?.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  // local.cwd: empty, 0700, under the private HOME, and not the remote root or a repository.
  const cwd = seen?.workspace ?? "";
  expect(cwd).toBe(join(seen?.home ?? "", "workspace"));
  expect(cwd).not.toContain("/remote/root");
  expect(await readdir(cwd)).toEqual([]);
  expect((await stat(cwd)).mode & 0o777).toBe(0o700);
  expect((await stat(seen?.home ?? "")).mode & 0o777).toBe(0o700);
  expect(seen?.prompt).toContain("/remote/root/workspace");
  expect(seen?.prompt).toContain("/remote/root/workspace/AGENTS.md");
  expect(seen?.prompt).toContain("workspace_command");
  expect(seen?.prompt).not.toContain(cwd);
  await execution.close();
  expect(executor.dispose).toHaveBeenCalledOnce();
});

it("routes staged inputs and managed outputs into the split bridge", async () => {
  const { dir, context, runtime } = await fixture();
  const { harness, factory } = splitHarness(dir, async function* () {
    yield { type: "output.message", text: "Done", final: true };
  });
  const original = await harness.plan(context);
  const plan = {
    ...original,
    execution: {
      ...original.execution,
      mounts: [
        ...original.execution.mounts,
        { source: { uri: "file:///skills" }, destination: "cursor-skills/skill-0", readOnly: true },
        {
          source: { uri: "file:///inputs" },
          destination: "cursor-inputs/resource-0",
          readOnly: true,
        },
      ],
      environmentVariables: {
        ...original.execution.environmentVariables,
        SUPERTAG_OUTPUT_DIR: "outputs/attempt",
      },
    },
  };
  const environment = remoteEnvironment();
  const execution = await harness.start(plan, { runtime, execution: environment }, context);
  await Array.fromAsync(execution.run());
  expect(factory).toHaveBeenCalledWith({
    environment,
    workspaceRoot: "/remote/root/workspace",
    readOnlyRoots: ["/remote/root/cursor-skills", "/remote/root/cursor-inputs"],
    outputDirectory: "/remote/root/outputs/attempt",
    permissions: { filesWrite: true, commandsExecute: true },
  });
  await execution.close();
});

it("runs Cursor workspace tools through the shared bridge and keeps the host key out of the sandbox", async () => {
  const { dir, context, runtime } = await fixture();
  const fakeKeys = {
    ANTHROPIC_API_KEY: "fake-cursor-anthropic-key",
    ANTHROPIC_AUTH_TOKEN: "fake-cursor-anthropic-token",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-cursor-oauth-token",
  };
  for (const [name, value] of Object.entries(fakeKeys)) vi.stubEnv(name, value);
  const sandbox = recordingEnvironment();
  const observed: string[] = [];
  const runner: CursorRunner = async function* (_request, _runtime, _signal, split) {
    if (!split) throw new Error("Missing split bridge");
    observed.push(...split.tools.map((tool) => tool.name));
    expect(await split.call("write", { file_path: "note.txt", content: "first" })).toMatchObject({
      isError: false,
    });
    expect(
      await split.call("edit", {
        file_path: "note.txt",
        old_string: "first",
        new_string: "second",
      }),
    ).toMatchObject({ isError: false });
    expect(await split.call("command", { command: "echo bridge-ok" })).toEqual({
      text: "bridge-ok\n",
      isError: false,
    });
    expect(await split.call("command", { command: "exit 7" })).toMatchObject({
      isError: true,
      text: expect.stringContaining("exit 7"),
    });
    expect((await split.call("read", { file_path: "note.txt" })).text).toContain("second");
    expect((await split.call("glob", { pattern: "*.txt" })).text).toContain("note.txt");
    expect((await split.call("grep", { pattern: "second" })).text).toContain("second");
    expect((await split.call("ls", {})).text).toContain("note.txt");
    await expect(
      split.call("write", { file_path: "../escape.txt", content: "escape" }),
    ).rejects.toThrow(/escapes workspace/);
    yield { type: "output.message", text: "Done", final: true };
  };
  const harness = new CursorHarness({ workspace: dir, runner });
  const plan = await harness.plan(context);
  expect(JSON.stringify(plan.execution)).not.toContain(KEY);
  expect(plan.execution.environmentVariables).toEqual({});
  expect(plan.execution.secretBindings).toEqual([]);
  const execution = await harness.start(plan, { runtime, execution: sandbox.environment }, context);
  await Array.fromAsync(execution.run());
  await execution.close();
  expect(observed).toEqual(["read", "write", "edit", "glob", "grep", "ls", "command"]);
  expect(sandbox.files.get("/remote/root/workspace/note.txt")).toBe("second");
  expect(sandbox.files.has("/remote/root/escape.txt")).toBe(false);
  expect(sandbox.processes.every((spec) => spec.replaceEnvironment === true)).toBe(true);
  expect(
    sandbox.processes.every((spec) =>
      Object.keys(spec.environment ?? {}).every(
        (key) => key !== "CURSOR_API_KEY" && !key.startsWith("ANTHROPIC_"),
      ),
    ),
  ).toBe(true);
  const sandboxInputs = JSON.stringify({ processes: sandbox.processes, files: [...sandbox.files] });
  for (const value of [KEY, ...Object.values(fakeKeys)]) expect(sandboxInputs).not.toContain(value);
});

it("kills an in-flight remote command when Cursor is cancelled", async () => {
  const { dir, context, runtime } = await fixture();
  const sandbox = recordingEnvironment();
  const runner: CursorRunner = async function* (_request, _runtime, signal, split) {
    if (!split) throw new Error("Missing split bridge");
    await split.call("command", { command: "sleep 600" }, signal);
    yield { type: "output.message", text: "Cancelled", final: true };
  };
  const harness = new CursorHarness({ workspace: dir, runner });
  const execution = await harness.start(
    await harness.plan(context),
    { runtime, execution: sandbox.environment },
    context,
  );
  const controller = new AbortController();
  const running = Array.fromAsync(execution.run(controller.signal));
  await vi.waitFor(() =>
    expect(sandbox.processes.some((spec) => spec.args?.[1] === "sleep 600")).toBe(true),
  );
  controller.abort();
  await running;
  expect(sandbox.killed).toContain("sleep 600");
  await execution.close();
});

it("maps read-only Permission Sets to the shared bridge on every call", async () => {
  const { dir, context, runtime } = await fixture();
  const sandbox = recordingEnvironment();
  const readOnly = withActions(context, []);
  const runner: CursorRunner = async function* (_request, _runtime, _signal, split) {
    if (!split) throw new Error("Missing split bridge");
    expect(split.tools.map((tool) => tool.name)).toEqual(["read", "glob", "grep", "ls"]);
    await expect(
      split.call("write", { file_path: "note.txt", content: "forbidden" }),
    ).rejects.toThrow(/files:write/);
    await expect(split.call("command", { command: "echo forbidden" })).rejects.toThrow(
      /commands:execute/,
    );
    yield { type: "output.message", text: "Done", final: true };
  };
  const harness = new CursorHarness({ workspace: dir, runner });
  const execution = await harness.start(
    await harness.plan(readOnly),
    { runtime, execution: sandbox.environment },
    readOnly,
  );
  await Array.fromAsync(execution.run());
  expect(sandbox.processes).toEqual([]);
  await execution.close();
});

it("disposes the shared bridge when the Cursor runner dies", async () => {
  const { dir, context, runtime } = await fixture();
  const sandbox = recordingEnvironment();
  let splitBridge: CursorSplitExecutor | undefined;
  const runner: CursorRunner = async function* (_request, _runtime, _signal, split) {
    splitBridge = split;
    yield { type: "output.message", text: "Runner started", final: false };
    throw new Error("runner died");
  };
  const harness = new CursorHarness({ workspace: dir, runner });
  const execution = await harness.start(
    await harness.plan(context),
    { runtime, execution: sandbox.environment },
    context,
  );
  await expect(Array.fromAsync(execution.run())).rejects.toThrow("runner died");
  await expect(splitBridge?.call("read", { file_path: "note.txt" })).rejects.toThrow(/disposed/);
  await execution.close();
});

it("maps Permission Sets to the executor and keeps the shell and file-write rule", async () => {
  const { dir, context, runtime } = await fixture();
  const { harness, factory } = splitHarness(dir, async function* () {
    yield { type: "output.message", text: "Done", final: true };
  });
  for (const [actions, filesWrite, commandsExecute] of [
    [[], false, false],
    [["files:write"], true, false],
    [["files:write", "commands:execute"], true, true],
  ] as const) {
    const admitted = withActions(context, actions);
    const execution = await harness.start(
      await harness.plan(admitted),
      { runtime, execution: remoteEnvironment() },
      admitted,
    );
    await execution.close();
    expect(factory.mock.lastCall?.[0].permissions).toEqual({ filesWrite, commandsExecute });
  }
  const shellOnly = withActions(context, ["commands:execute"]);
  await expect(harness.plan(shellOnly)).rejects.toThrow(/CURSOR_COMMANDS_REQUIRE_FILES_WRITE/);
  await expect(
    harness.start(
      await harness.plan(context),
      { runtime, execution: remoteEnvironment() },
      shellOnly,
    ),
  ).rejects.toThrow(/CURSOR_COMMANDS_REQUIRE_FILES_WRITE/);
  expect(factory).toHaveBeenCalledTimes(3);
});

it("refuses a Cursor sandbox override in the private home before creating the executor", async () => {
  const { dir, context, runtime } = await fixture();
  const { harness, factory } = splitHarness(dir, async function* () {});
  const home = runtime.resolvePath(`.cursor-attempt/${context.attempt.attemptId}`);
  await mkdir(join(home, ".cursor"), { recursive: true });
  await writeFile(join(home, ".cursor", "sandbox.json"), "{}\n");
  await expect(
    harness.start(
      await harness.plan(context),
      { runtime, execution: remoteEnvironment() },
      context,
    ),
  ).rejects.toThrow(/CURSOR_SANDBOX_OVERRIDE_REFUSED/);
  expect(factory).not.toHaveBeenCalled();
});

it("refuses a non-empty working directory before creating the executor", async () => {
  const { dir, context, runtime } = await fixture();
  const { harness, factory } = splitHarness(dir, async function* () {});
  const cwd = join(
    runtime.resolvePath(`.cursor-attempt/${context.attempt.attemptId}`),
    "workspace",
  );
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "leftover.txt"), "x");
  await expect(
    harness.start(
      await harness.plan(context),
      { runtime, execution: remoteEnvironment() },
      context,
    ),
  ).rejects.toThrow(/must be empty/);
  expect(factory).not.toHaveBeenCalled();
});

it("disposes the executor when start fails after creating it", async () => {
  const { dir, context, runtime } = await fixture();
  const executor = fakeExecutor(undefined, [
    { name: "Bad Name", description: "x", inputSchema: { type: "object" } },
  ]);
  const { harness } = splitHarness(dir, async function* () {}, executor);
  await expect(
    harness.start(
      await harness.plan(context),
      { runtime, execution: remoteEnvironment() },
      context,
    ),
  ).rejects.toThrow(/invalid or duplicate tool name/);
  expect(executor.dispose).toHaveBeenCalledOnce();
});

it("separates split sessions from colocated ones", async () => {
  const { dir, context, runtime } = await fixture();
  const resumed: (string | undefined)[] = [];
  const runner: CursorRunner = async function* (request) {
    resumed.push(request.resumeAgentId);
    for (const name of ["agents.ndjson", "runs.ndjson", "run_events.ndjson", "checkpoints.ndjson"])
      await writeFile(
        join(request.storeDirectory, name),
        `${JSON.stringify({ agentId: request.resumeAgentId ?? request.agentId, cwd: request.workspace })}\n`,
      );
    yield { type: "cursor.session", agentId: request.resumeAgentId ?? request.agentId };
    yield { type: "output.message", text: "Done", final: true };
  };
  const harness = new CursorHarness({
    workspace: dir,
    runner,
    splitExecutor: () => fakeExecutor(),
  });
  let attempts = 0;
  async function attempt(split: boolean, prior?: unknown) {
    const admitted: ExecutionContext = {
      ...context,
      attempt: { ...context.attempt, attemptId: `split-session-${++attempts}` },
      continuity: {
        sessionId: "session-1",
        ...(prior ? { priorSessionState: prior as never } : {}),
      },
    };
    const execution = await harness.start(
      await harness.plan(admitted),
      { runtime, execution: split ? remoteEnvironment() : runtime },
      admitted,
    );
    await Array.fromAsync(execution.run());
    const state = await execution.sessionState?.();
    await execution.close();
    return state;
  }
  const colocated = await attempt(false);
  expect(colocated).toBeDefined();
  // A colocated session must not resume into split mode.
  const split = await attempt(true, colocated);
  expect(resumed.at(-1)).toBeUndefined();
  // A split session resumes into split mode, and never back into a colocated Attempt.
  await attempt(true, split);
  expect(resumed.at(-1)).toMatch(/^agent-/);
  await attempt(false, split);
  expect(resumed.at(-1)).toBeUndefined();
});

it("resumes a split session when the executor's tool set changes", async () => {
  const { dir, context, runtime } = await fixture();
  const resumed: (string | undefined)[] = [];
  const toolSets: string[][] = [];
  const runner: CursorRunner = async function* (request) {
    resumed.push(request.resumeAgentId);
    toolSets.push((request.splitTools ?? []).map((tool) => tool.name));
    for (const name of ["agents.ndjson", "runs.ndjson", "run_events.ndjson", "checkpoints.ndjson"])
      await writeFile(
        join(request.storeDirectory, name),
        `${JSON.stringify({ agentId: request.resumeAgentId ?? request.agentId, cwd: request.workspace })}\n`,
      );
    yield { type: "cursor.session", agentId: request.resumeAgentId ?? request.agentId };
    yield { type: "output.message", text: "Done", final: true };
  };
  const harness = new CursorHarness({
    workspace: dir,
    runner,
    // Read-only Tasks get fewer tools from the real bridge; model that with the permission.
    splitExecutor: (options) =>
      fakeExecutor(
        undefined,
        options.permissions.filesWrite ? TOOLS : TOOLS.filter((tool) => tool.name === "read"),
      ),
  });
  let attempts = 0;
  const run = async (actions: readonly string[], prior?: unknown) => {
    const withIds = withActions(context, actions);
    const admitted: ExecutionContext = {
      ...withIds,
      attempt: { ...withIds.attempt, attemptId: `tool-set-${++attempts}` },
      continuity: {
        sessionId: "session-1",
        ...(prior ? { priorSessionState: prior as never } : {}),
      },
    };
    const execution = await harness.start(
      await harness.plan(admitted),
      { runtime, execution: remoteEnvironment() },
      admitted,
    );
    await Array.fromAsync(execution.run());
    const state = await execution.sessionState?.();
    await execution.close();
    return state;
  };
  // Each turn passes the current tools again, so a narrower permission still resumes.
  const writable = await run(["files:write"]);
  await run([], writable);
  expect(resumed.at(-1)).toMatch(/^agent-/);
  // The resumed turn gets only the tools its own Task admits.
  expect(toolSets.at(-1)).toEqual(["read"]);
  await run(["files:write"], writable);
  expect(resumed.at(-1)).toMatch(/^agent-/);
});

it("cancels remote processes and disposes the executor when the run ends", async () => {
  const { dir, context, runtime } = await fixture();
  const executor = fakeExecutor();
  const runner: CursorRunner = async function* (_request, _runtime, signal) {
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
    yield* [];
    throw new Error("cancelled");
  };
  const { harness } = splitHarness(dir, runner, executor);
  const execution = await harness.start(
    await harness.plan(context),
    { runtime, execution: remoteEnvironment() },
    context,
  );
  const controller = new AbortController();
  const running = Array.fromAsync(execution.run(controller.signal));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(executor.cancelAll).not.toHaveBeenCalled();
  controller.abort();
  await expect(running).rejects.toThrow("cancelled");
  expect(executor.cancelAll).toHaveBeenCalled();
  expect(executor.dispose).toHaveBeenCalledOnce();
  await execution.close();
  await execution.close();
  expect(executor.dispose).toHaveBeenCalledOnce();
});

it("reports an executor that cannot be disposed as a cleanup failure", async () => {
  const { dir, context, runtime } = await fixture();
  const executor = fakeExecutor();
  executor.dispose.mockRejectedValueOnce(new Error("sandbox unreachable"));
  const { harness } = splitHarness(dir, async function* () {}, executor);
  const execution = await harness.start(
    await harness.plan(context),
    { runtime, execution: remoteEnvironment() },
    context,
  );
  await expect(execution.close()).rejects.toBeInstanceOf(ExecutionCleanupError);
});

// ---- Worker side of the stdio protocol (runCursor) ----

function interactiveRuntime(placement: "local" | "remote" = "remote", root = tmpdir()) {
  const writes: string[] = [];
  const spawned: unknown[] = [];
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const end = () => {
    ended = true;
    wake?.();
    finish();
  };
  const runtime = {
    placement,
    id: "runner-host",
    rootDirectory: root,
    resolvePath: (path: string) => join(root, path),
    async prepare() {},
    async read() {
      return "";
    },
    async dispose() {},
    async spawn(spec: unknown) {
      spawned.push(spec);
      return {
        ...(placement === "local" ? { pid: 900001 } : {}),
        output: (async function* () {
          while (true) {
            const next = queue.shift();
            if (next !== undefined) {
              yield { stream: "stdout" as const, text: next };
              continue;
            }
            if (ended) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
        write: async (bytes: Uint8Array) => {
          const text = new TextDecoder().decode(bytes);
          writes.push(text);
          // The fake runner exits when asked to close or cancel, like the real one.
          if (text.includes('"type":"close"') || text.includes('"type":"cancel"')) end();
        },
        wait: async () => {
          await exited;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        kill: () => end(),
      };
    },
  } as unknown as HarnessRuntime;
  return {
    runtime,
    writes,
    spawned,
    end,
    push: (frame: Record<string, unknown>) => {
      queue.push(`${JSON.stringify(frame)}\n`);
      wake?.();
    },
    pushLine: (line: string) => {
      queue.push(line);
      wake?.();
    },
    results: () =>
      writes
        .filter((line) => line.includes('"type":"workspace_result"'))
        .map((line) => JSON.parse(line) as { id: string; text: string; isError: boolean }),
  };
}

/** Runs the real Worker spawn spec through the real runner preflight with a fake SDK. */
function guardedRunnerRuntime(root: string) {
  const specs: ProcessSpec[] = [];
  const runtime = {
    placement: "local",
    id: "guarded-runner-host",
    rootDirectory: root,
    resolvePath: (path: string) => join(root, path),
    async prepare() {},
    async read() {
      return "";
    },
    async dispose() {},
    async spawn(spec: ProcessSpec) {
      specs.push(spec);
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      let finish!: () => void;
      const exited = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let closed = false;
      const close = () => {
        closed = true;
        wake?.();
        finish();
      };
      const emit = (frame: Record<string, unknown>) => {
        queue.push(`${JSON.stringify(frame)}\n`);
        wake?.();
      };
      const sdk = fakeApi(async () =>
        (async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: "started" }] } };
        })(),
      );
      return {
        pid: 900001,
        output: (async function* () {
          while (true) {
            const next = queue.shift();
            if (next !== undefined) {
              yield { stream: "stdout" as const, text: next };
              continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
        async write(bytes: Uint8Array) {
          const frame = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
          if (frame["type"] === "close" || frame["type"] === "cancel") {
            close();
            return;
          }
          if (frame["type"] !== "start") return;
          const originalCwd = process.cwd();
          let running: Promise<void>;
          try {
            // executeCursorSdk checks process.cwd() synchronously before its first await.
            process.chdir(spec.cwd ?? root);
            running = executeCursorSdk(
              frame as Parameters<typeof executeCursorSdk>[0],
              sdk.api,
              emptyStore,
              emit,
              () => process.argv[1] ?? "sdk-entry",
            );
          } finally {
            process.chdir(originalCwd);
          }
          void running.catch((error: unknown) => emit(cursorSdkErrorFrame(error, KEY)));
        },
        wait: async () => {
          await exited;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        kill: close,
      };
    },
  } as HarnessRuntime;
  return { runtime, specs };
}

it.each(["split", "colocated"])(
  "starts the real Cursor Worker and runner guards in %s mode",
  async (mode) => {
    const { dir, context } = await fixture();
    const host = guardedRunnerRuntime(dir);
    if (mode === "colocated")
      await mkdir(host.runtime.resolvePath("workspace"), { recursive: true });
    const tree = {
      marker: "cursor-guard-test",
      start: async () => {},
      scanWhileRunnerStopped: async () => {},
      signalDescendants: async () => {},
      terminate: async () => {},
      confirm: async () => {},
      close: () => {},
    } as unknown as CursorProcessTree;
    vi.spyOn(CursorProcessTree, "prepare").mockResolvedValue(tree);
    const harness = new CursorHarness({
      workspace: dir,
      splitExecutor: () => fakeExecutor(),
    });
    const execution = await harness.start(
      await harness.plan(context),
      { runtime: host.runtime, execution: mode === "split" ? remoteEnvironment() : host.runtime },
      context,
    );
    try {
      const events = await Array.fromAsync(execution.run());
      expect(events.some((event) => event.type === "output.message" && event.final)).toBe(true);
      expect(host.specs).toHaveLength(1);
      const spec = host.specs[0];
      expect(spec?.cwd).toBe(
        mode === "split"
          ? host.runtime.resolvePath(`.cursor-attempt/${context.attempt.attemptId}`)
          : host.runtime.resolvePath("workspace"),
      );
    } finally {
      await execution.close();
    }
  },
);

const workerRequest: CursorRunRequest = {
  prompt: "work",
  workspace: "/tmp/split-cwd",
  timeoutMs: 5000,
  home: "/tmp/private",
  storeDirectory: "/tmp/private/store",
  agentId: "agent-fixture",
  model: "auto",
  mcpServers: {},
  ...cursorToolsForSplit(),
  toolInputs: [],
  splitTools: TOOLS,
};

const call = (id: string, name: string, input: unknown = {}) => ({
  type: "workspace_call",
  id,
  name,
  input,
});

it("forwards each workspace call to the executor and answers with its result", async () => {
  const { runtime, push, results } = interactiveRuntime();
  const executor = fakeExecutor(async (name) =>
    name === "command"
      ? { text: "exit code 2\nboom", isError: true }
      : { text: "hello", isError: false },
  );
  const running = Array.fromAsync(runCursor(workerRequest, runtime, undefined, executor));
  push({ type: "agent", agentId: "agent-fixture" });
  push(call("workspace-1", "read", { path: "a.txt" }));
  push(call("workspace-2", "command", { command: "false" }));
  await vi.waitFor(() => expect(results()).toHaveLength(2));
  push({ type: "result", status: "finished", result: "done" });
  const events = await running;
  expect(events.at(-1)).toEqual({ type: "output.message", text: "done", final: true });
  expect(executor.calls.map(({ name, input }) => ({ name, input }))).toEqual([
    { name: "read", input: { path: "a.txt" } },
    { name: "command", input: { command: "false" } },
  ]);
  expect(results().toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
    { type: "workspace_result", id: "workspace-1", text: "hello", isError: false },
    { type: "workspace_result", id: "workspace-2", text: "exit code 2\nboom", isError: true },
  ]);
  expect(executor.cancelAll).toHaveBeenCalled();
});

it("preserves workspace write text through the runner and Worker while redacting diagnostics", async () => {
  const text = "https://user:password@example.test/file\nAuthorization: Basic dXNlcjpwYXNz";
  const { runtime, push, pushLine } = interactiveRuntime();
  const executor = fakeExecutor();
  const running = Array.fromAsync(runCursor(workerRequest, runtime, undefined, executor));
  push({ type: "agent", agentId: "agent-fixture" });
  pushLine(
    serializeCursorRunnerFrame(
      call("workspace-1", "write", { file_path: "note.txt", content: text }),
      KEY,
      workerRequest,
    ),
  );
  pushLine(
    serializeCursorRunnerFrame(
      call("workspace-2", "write", { file_path: "secret.txt", content: `value=${KEY}` }),
      KEY,
      workerRequest,
    ),
  );
  await vi.waitFor(() => expect(executor.call).toHaveBeenCalledTimes(2));
  push({ type: "result", status: "finished", result: "done" });
  await running;
  expect(executor.calls[0]?.input).toEqual({ file_path: "note.txt", content: text });
  expect(executor.calls[1]?.input).toEqual({
    file_path: "secret.txt",
    content: "value=[REDACTED]",
  });
  const error = serializeCursorRunnerFrame(
    { type: "error", code: "SDK_FAILURE", message: text },
    KEY,
    workerRequest,
  );
  expect(error).not.toContain("user:password");
  expect(error).not.toContain("dXNlcjpwYXNz");
  expect(error).toContain("[REDACTED]");
});

it("answers an executor failure, an unknown tool and an oversized result with an error or bound", async () => {
  const { runtime, push, results } = interactiveRuntime();
  const executor = fakeExecutor(async (name) => {
    if (name === "grep") throw new Error(`sandbox gone ${KEY}`);
    return { text: "x".repeat(700_000), isError: false };
  });
  const running = Array.fromAsync(runCursor(workerRequest, runtime, undefined, executor));
  push({ type: "agent", agentId: "agent-fixture" });
  push(call("workspace-1", "grep"));
  push(call("workspace-2", "delete"));
  push(call("workspace-3", "ls"));
  await vi.waitFor(() => expect(results()).toHaveLength(3));
  push({ type: "result", status: "finished", result: "done" });
  await running;
  const byId = Object.fromEntries(results().map((result) => [result.id, result]));
  expect(byId["workspace-1"]).toMatchObject({ isError: true });
  expect(byId["workspace-1"]?.text).toContain("Workspace tool failed: sandbox gone [REDACTED]");
  expect(byId["workspace-2"]).toMatchObject({ isError: true });
  expect(byId["workspace-2"]?.text).toContain("Unknown workspace tool delete");
  expect(executor.calls.map(({ name }) => name).sort()).toEqual(["grep", "ls"]);
  expect(byId["workspace-3"]?.isError).toBe(false);
  expect(byId["workspace-3"]?.text.length).toBeLessThan(600_000);
});

it("refuses a workspace call outside split execution and a reused call ID", async () => {
  const outside = interactiveRuntime();
  outside.push({ type: "agent", agentId: "agent-fixture" });
  outside.push(call("workspace-1", "read"));
  const { splitTools: _unused, ...colocated } = workerRequest;
  await expect(Array.fromAsync(runCursor(colocated, outside.runtime))).rejects.toThrow(
    /outside split execution/,
  );

  const reused = interactiveRuntime();
  const executor = fakeExecutor(() => new Promise<Outcome>(() => undefined));
  reused.push({ type: "agent", agentId: "agent-fixture" });
  reused.push(call("workspace-1", "read"));
  reused.push(call("workspace-1", "read"));
  await expect(
    Array.fromAsync(runCursor(workerRequest, reused.runtime, undefined, executor)),
  ).rejects.toThrow(/reused a workspace call ID/);
  expect(executor.cancelAll).toHaveBeenCalled();
});

it("answers in-flight calls with an error and cancels remote processes on Task cancel", async () => {
  const { runtime, push, results } = interactiveRuntime();
  const executor = fakeExecutor(() => new Promise<Outcome>(() => undefined));
  const controller = new AbortController();
  const running = Array.fromAsync(runCursor(workerRequest, runtime, controller.signal, executor));
  push({ type: "agent", agentId: "agent-fixture" });
  push(call("workspace-1", "command", { command: "sleep 600" }));
  await vi.waitFor(() => expect(executor.call).toHaveBeenCalledOnce());
  expect(executor.cancelAll).not.toHaveBeenCalled();
  controller.abort();
  await expect(running).rejects.toThrow(/without a result/);
  expect(executor.cancelAll).toHaveBeenCalled();
  expect(executor.calls[0]?.signal?.aborted).toBe(true);
  await vi.waitFor(() =>
    expect(results()).toEqual([
      {
        type: "workspace_result",
        id: "workspace-1",
        text: "Workspace tool call was cancelled",
        isError: true,
      },
    ]),
  );
});

it("cancels remote processes and answers in-flight calls when the runner dies", async () => {
  const { runtime, push, end, results } = interactiveRuntime();
  const executor = fakeExecutor(() => new Promise<Outcome>(() => undefined));
  const running = Array.fromAsync(runCursor(workerRequest, runtime, undefined, executor));
  push({ type: "agent", agentId: "agent-fixture" });
  push(call("workspace-1", "command", { command: "sleep 600" }));
  await vi.waitFor(() => expect(executor.call).toHaveBeenCalledOnce());
  end();
  await expect(running).rejects.toThrow(/without a result/);
  expect(executor.cancelAll).toHaveBeenCalled();
  await vi.waitFor(() => expect(results()).toHaveLength(1));
  expect(results()[0]).toMatchObject({ id: "workspace-1", isError: true });
});

it("cancels remote processes at a normal attempt end and reports a cleanup that fails", async () => {
  const { runtime, push } = interactiveRuntime();
  const executor = fakeExecutor();
  executor.cancelAll.mockRejectedValue(new Error("sandbox unreachable"));
  const running = Array.fromAsync(runCursor(workerRequest, runtime, undefined, executor));
  push({ type: "agent", agentId: "agent-fixture" });
  push({ type: "result", status: "finished", result: "done" });
  await expect(running).rejects.toBeInstanceOf(ExecutionCleanupError);
  expect(executor.cancelAll).toHaveBeenCalledOnce();
});

it("never gives CURSOR_API_KEY to the executor, its environment, its tools or its answers", async () => {
  const { dir, context } = await fixture();
  const mockTree = {
    marker: "cursor-test-marker",
    start: async () => {},
    scanWhileRunnerStopped: async () => {},
    signalDescendants: async () => {},
    terminate: async () => {},
    confirm: async () => {},
    close: () => {},
  } as unknown as CursorProcessTree;
  vi.spyOn(CursorProcessTree, "prepare").mockResolvedValue(mockTree);
  const sandboxUse: string[] = [];
  const environment = remoteEnvironment(sandboxUse);
  const executor = fakeExecutor(async () => ({ text: `echo ${KEY}`, isError: false }));
  const factoryInput: string[] = [];
  const harness = new CursorHarness({
    workspace: dir,
    splitExecutor: (options) => {
      factoryInput.push(JSON.stringify(options));
      return executor;
    },
  });
  const host = interactiveRuntime("local", dir);
  const execution = await harness.start(
    await harness.plan(context),
    { runtime: host.runtime, execution: environment },
    context,
  );
  const running = Array.fromAsync(execution.run());
  await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
  host.push({ type: "agent", agentId: "agent-fixture" });
  // The model, not the Worker, chose this input; it must not carry the key into the sandbox.
  host.push(call("workspace-1", "write", { path: `leak-${KEY}.txt`, content: KEY }));
  await vi.waitFor(() => expect(host.results()).toHaveLength(1));
  host.push({ type: "result", status: "finished", result: "done" });
  await running;
  await execution.close();

  const forExecutor = JSON.stringify({
    calls: executor.calls.map(({ name, input }) => ({ name, input })),
    tools: executor.tools,
    factory: factoryInput,
    sandboxUse,
  });
  expect(forExecutor).not.toContain(KEY);
  expect(forExecutor).toContain("[REDACTED]");
  // The key travels once, on the private stdin start frame; no later frame and no spawn
  // environment carries it, and the answer the executor gave is redacted too.
  expect(JSON.parse(host.writes[0] ?? "{}")).toMatchObject({ type: "start", apiKey: KEY });
  expect(JSON.stringify(JSON.parse(host.writes[0] ?? "{}").request)).not.toContain(KEY);
  expect(host.writes.slice(1).join("")).not.toContain(KEY);
  expect(JSON.stringify(host.spawned)).not.toContain(KEY);
  expect(host.results()[0]?.text).toBe("echo [REDACTED]");
  expect(sandboxUse).toEqual([]);
});

// ---- Runner side (SDK custom tools) ----

type CustomTools = Record<
  string,
  { execute(args: Record<string, unknown>, context: { toolCallId?: string }): Promise<unknown> }
>;

function splitStart(
  overrides: Partial<Parameters<typeof executeCursorSdk>[0]["request"]> = {},
): Parameters<typeof executeCursorSdk>[0] {
  const home = mkdtempSync(join(tmpdir(), "cursor-split-runner-"));
  dirs.push(home);
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  return {
    type: "start",
    apiKey: KEY,
    request: {
      prompt: "Do the Task",
      workspace,
      storeDirectory: join(home, "store"),
      agentId: "agent-fixture",
      model: "composer-2.5",
      mcpServers: {},
      ...cursorToolsForSplit(),
      splitTools: TOOLS,
      ...overrides,
    },
  };
}

function fakeApi(
  send: (customTools: CustomTools, cancelled: () => boolean) => Promise<AsyncIterable<unknown>>,
) {
  let options: Record<string, unknown> | undefined;
  let cancelled = false;
  const api = {
    async create(value: Record<string, unknown>) {
      options = value;
      return {
        agentId: "agent-fixture",
        async send() {
          const customTools = (value["local"] as { customTools?: CustomTools }).customTools ?? {};
          const events = await send(customTools, () => cancelled);
          return {
            id: "run",
            stream: () => events,
            async wait() {
              return { status: cancelled ? "cancelled" : "finished", result: "Done" };
            },
            async cancel() {
              cancelled = true;
            },
          };
        },
        async getUsage() {
          throw new Error("unavailable");
        },
        close() {},
      };
    },
    resume: vi.fn(),
  } as unknown as Pick<typeof Agent, "create" | "resume">;
  return { api, options: () => options, cancelled: () => cancelled };
}

const emptyStore = () => ({}) as JsonlLocalAgentStore;

it("registers the executor's tools as custom tools and forwards a call to the Worker", async () => {
  const frames: Record<string, unknown>[] = [];
  let outcome: unknown;
  const fake = fakeApi(async (customTools) => {
    const pending = customTools["workspace_command"]?.execute(
      { command: "ls" },
      { toolCallId: "call-1" },
    );
    const forwarded = frames.find((frame) => frame["type"] === "workspace_call");
    expect(forwarded).toMatchObject({ name: "command", input: { command: "ls" } });
    settleWorkspaceCall({
      type: "workspace_result",
      id: forwarded?.["id"],
      text: "exit code 2\nboom",
      isError: true,
    });
    outcome = await pending;
    const custom = (status: string) => ({
      type: "tool_call",
      call_id: "call-1",
      name: "mcp",
      status,
      args: {
        providerIdentifier: "custom-user-tools",
        toolName: "workspace_command",
        args: { command: "ls" },
      },
    });
    return (async function* () {
      yield custom("running");
      yield custom("error");
    })();
  });
  await executeCursorSdk(
    splitStart(),
    fake.api,
    emptyStore,
    (frame) => frames.push(frame),
    () => "sdk-entry",
  );
  const options = fake.options() as {
    tools: string[];
    disallowedTools: string[];
    local: { cwd: string; sandboxOptions: unknown; customTools: CustomTools };
  };
  expect(options.tools).toEqual(["mcp"]);
  expect(options.disallowedTools).toEqual(cursorToolsForSplit().disallowedTools);
  // Cursor's own sandbox stays on as defense in depth.
  expect(options.local.sandboxOptions).toEqual({ enabled: true });
  expect(Object.keys(options.local.customTools).sort()).toEqual(
    TOOL_NAMES.map((name) => `workspace_${name}`).sort(),
  );
  expect(outcome).toEqual({
    content: [{ type: "text", text: "exit code 2\nboom" }],
    isError: true,
  });
  expect(frames.at(-1)).toMatchObject({ type: "result", status: "finished" });
  // The envelope for the harness never carries arguments or results.
  const events = frames.filter((frame) => frame["type"] === "event");
  expect(events[0]).toEqual({
    type: "event",
    event: { type: "tool_call", call_id: "call-1", name: "workspace_command", status: "running" },
  });
  expect(JSON.stringify(events)).not.toMatch(/boom|"ls"/u);
});

it.each(["read", "shell", "edit", "grep", "glob", "ls", "task", "webSearch", "delete"])(
  "fails closed when Cursor calls the built-in %s tool in split mode",
  async (name) => {
    const frames: Record<string, unknown>[] = [];
    const fake = fakeApi(async () =>
      (async function* () {
        yield { type: "tool_call", call_id: "native-1", name, status: "running", args: {} };
      })(),
    );
    const failure = await executeCursorSdk(
      splitStart(),
      fake.api,
      emptyStore,
      (frame) => frames.push(frame),
      () => "sdk-entry",
    ).catch((error: unknown) => error);
    expect(fake.cancelled()).toBe(true);
    expect(cursorSdkErrorCode(failure)).toBe("NATIVE_TOOL_BLOCKED");
    expect(frames.some((frame) => frame["type"] === "result")).toBe(false);
    const options = fake.options() as {
      tools: string[];
      disallowedTools: string[];
      local: { cwd: string; sandboxOptions: { enabled: boolean } };
    };
    expect(options.tools).toEqual(["mcp"]);
    expect(options.disallowedTools).toContain(name);
    expect(options.local.sandboxOptions.enabled).toBe(true);
    expect(options.local.cwd).not.toBe(process.cwd());
    expect(await readdir(options.local.cwd)).toEqual([]);
  },
);

it("refuses a split run whose native cwd contains host files", async () => {
  const frame = splitStart();
  for (let index = 0; index < 6; index++)
    await writeFile(join(frame.request.workspace, `host-file-${index}`), "private payload");
  const create = vi.fn();
  const error = await executeCursorSdk(
    frame,
    { create, resume: vi.fn() } as unknown as Pick<typeof Agent, "create" | "resume">,
    emptyStore,
    () => {},
    () => "sdk-entry",
  ).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain("working directory is not empty:");
  expect(message.match(/"host-file-\d"/gu)).toHaveLength(5);
  expect(message).not.toContain("private payload");
  expect(create).not.toHaveBeenCalled();
});

it("distinguishes a split path outside the Attempt workspace", async () => {
  const frame = splitStart();
  const create = vi.fn();
  await expect(
    executeCursorSdk(
      { ...frame, request: { ...frame.request, workspace: join(frame.request.workspace, "..") } },
      { create, resume: vi.fn() } as unknown as Pick<typeof Agent, "create" | "resume">,
      emptyStore,
      () => {},
      () => "sdk-entry",
    ),
  ).rejects.toThrow("working directory is not <attemptRoot>/workspace");
  expect(create).not.toHaveBeenCalled();
});

it("distinguishes a split directory used as the runner process cwd", async () => {
  const frame = splitStart();
  const create = vi.fn();
  const originalCwd = process.cwd();
  let run: Promise<void>;
  try {
    process.chdir(frame.request.workspace);
    run = executeCursorSdk(
      frame,
      { create, resume: vi.fn() } as unknown as Pick<typeof Agent, "create" | "resume">,
      emptyStore,
      () => {},
      () => "sdk-entry",
    );
  } finally {
    process.chdir(originalCwd);
  }
  await expect(run).rejects.toThrow("working directory must not be the runner process cwd");
  expect(create).not.toHaveBeenCalled();
});

it.each([
  { providerIdentifier: "another-provider", toolName: "workspace_read" },
  { providerIdentifier: "custom-user-tools", toolName: "unadmitted_tool" },
])("fails closed on a non-workspace MCP call in split mode: %j", async (args) => {
  const fake = fakeApi(async () =>
    (async function* () {
      yield { type: "tool_call", call_id: "mcp-1", name: "mcp", status: "running", args };
    })(),
  );
  const failure = await executeCursorSdk(
    splitStart(),
    fake.api,
    emptyStore,
    () => {},
    () => "sdk-entry",
  ).catch((error: unknown) => error);
  expect(fake.cancelled()).toBe(true);
  expect(cursorSdkErrorCode(failure)).toBe("NATIVE_TOOL_BLOCKED");
});

it("refuses split execution when the allowlist is more than mcp", async () => {
  const create = vi.fn();
  const api = { create, resume: vi.fn() } as unknown as Pick<typeof Agent, "create" | "resume">;
  for (const tools of [["read", "mcp"], ["mcp", "shell"], []])
    await expect(
      executeCursorSdk(
        splitStart({ tools }),
        api,
        emptyStore,
        () => {},
        () => "sdk-entry",
      ),
    ).rejects.toThrow(/requires mcp only and native tools denied/);
  await expect(
    executeCursorSdk(
      splitStart({ disallowedTools: [] }),
      api,
      emptyStore,
      () => {},
      () => "sdk-entry",
    ),
  ).rejects.toThrow(/native tools denied/);
  expect(create).not.toHaveBeenCalled();
});

it("answers a pending workspace call with an error when the run is cancelled", async () => {
  const frames: Record<string, unknown>[] = [];
  let outcome: unknown;
  const fake = fakeApi(async (customTools) => {
    const pending = customTools["workspace_command"]?.execute(
      { command: "sleep 600" },
      { toolCallId: "call-1" },
    );
    expect(frames.some((frame) => frame["type"] === "workspace_call")).toBe(true);
    await cancelCursorSdk();
    outcome = await pending;
    return (async function* () {})();
  });
  await executeCursorSdk(
    splitStart(),
    fake.api,
    emptyStore,
    (frame) => frames.push(frame),
    () => "sdk-entry",
  ).catch(() => undefined);
  expect(outcome).toEqual({ content: [], isError: true });
});

it("settles a workspace call from a stdin frame and ignores unknown or malformed answers", async () => {
  expect(() => settleWorkspaceCall({ type: "workspace_result", id: "workspace-404" })).toThrow(
    /invalid workspace result/,
  );
  expect(() =>
    settleWorkspaceCall({
      type: "workspace_result",
      id: "workspace-404",
      text: "late",
      isError: false,
    }),
  ).not.toThrow();

  const frames: Record<string, unknown>[] = [];
  const input = new PassThrough();
  let outcome: unknown;
  const fake = fakeApi(async (customTools) => {
    const pending = customTools["workspace_read"]?.execute({ path: "a" }, { toolCallId: "call-1" });
    const forwarded = await vi.waitFor(() => {
      const frame = frames.find((candidate) => candidate["type"] === "workspace_call");
      if (!frame) throw new Error("not forwarded yet");
      return frame;
    });
    input.write(
      `${JSON.stringify({ type: "workspace_result", id: forwarded["id"], text: "from stdin", isError: false })}\n`,
    );
    outcome = await pending;
    return (async function* () {
      const custom = (status: string) => ({
        type: "tool_call",
        call_id: "call-1",
        name: "mcp",
        status,
        args: { providerIdentifier: "custom-user-tools", toolName: "workspace_read" },
      });
      yield custom("running");
      yield custom("completed");
    })();
  });
  const done = runCursorStdio(input, (frame) =>
    executeCursorSdk(
      frame,
      fake.api,
      emptyStore,
      (value) => frames.push(value),
      () => "sdk-entry",
    ),
  );
  input.write(`${JSON.stringify(splitStart())}\n`);
  await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ type: "result" }));
  input.write('{"type":"close"}\n');
  await done;
  expect(outcome).toEqual({ content: [{ type: "text", text: "from stdin" }], isError: false });
  expect(JSON.stringify(frames)).not.toContain(KEY);
  input.destroy();
});
