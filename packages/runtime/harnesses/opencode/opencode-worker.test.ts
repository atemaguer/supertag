import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  callManagerProxy,
  startManagerIsolationMcp,
} from "../../../../tests/support/manager-isolation-mcp.js";
import {
  type ExecutionContext,
  type ExecutionEnvironment,
  InMemorySessionStateStore,
  type ProcessHandle,
  type TaskAttemptSpec,
} from "../../sdk/src/index.js";
import {
  createOpenCodeWorker,
  OpenCodeHarness,
  type OpenCodeRunRequest,
  openCodePermissions,
  runOpenCode,
} from "./src/index.js";

const request: OpenCodeRunRequest = {
  prompt: "Implement scheduling",
  executable: "opencode",
  model: "provider/model",
  workspace: "/isolated",
  timeoutMs: 1000,
  environment: { PROVIDER_API_KEY: "secret" },
};
function environment(handle: ProcessHandle): ExecutionEnvironment {
  return {
    id: "test",
    placement: "remote",
    rootDirectory: "/isolated",
    async prepare() {},
    resolvePath: (path) => `/isolated/${path}`,
    async read() {
      return "";
    },
    spawn: vi.fn(async () => handle),
    async dispose() {},
  };
}
function spec(): TaskAttemptSpec {
  const profile = { id: "local-opencode", revision: "1" },
    at = new Date().toISOString();
  return {
    version: 1,
    taskId: "task",
    attemptId: "attempt",
    tag: { id: "tag", name: "Tag" },
    execution: {},
    workerProfile: profile,
    authorization: {
      version: 4,
      capturedAt: at,
      tag: { id: "tag", name: "Tag" },
      origin: { kind: "internal", objectiveId: "objective", requestedByTagId: "tag" },
      requester: { kind: "user", id: "tag" },
      permissionSets: [],
      resources: [],
      runtimeActions: ["files:read"],
    },
    contextPlan: { version: 7, capturedAt: at, sets: [] },
    workspacePlan: { version: 1, status: "none" },
    input: {
      origin: {
        surface: "supertag.coordination",
        accountId: "objective",
        scope: "objective",
        sessionKey: "session",
        occurredAt: at,
      },
      messages: [{ id: "instruction", role: "requester", text: "Implement scheduling" }],
    },
  };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("streams completed text before process exit, with stdin input and no credential flags", async () => {
  let exit = () => {};
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const handle: ProcessHandle = {
    output: (async function* () {
      yield { stream: "stdout" as const, text: '{"type":"text","part":{"text":"Ready"}}\n' };
      await exited;
      yield {
        stream: "stdout" as const,
        text: '{"type":"step_finish","part":{"reason":"stop"}}\n',
      };
    })(),
    wait: vi.fn(async () => {
      await exited;
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
    kill: vi.fn(),
  };
  const env = environment(handle);
  const iterator = runOpenCode(request, env)[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({ value: { type: "output.message", text: "Ready" } });
  expect(handle.wait).not.toHaveBeenCalled();
  expect(env.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      stdin: request.prompt,
      streamOutput: true,
      args: ["run", "--format", "json", "--model", "provider/model", "--agent", "build", "--pure"],
    }),
    expect.any(AbortSignal),
  );
  exit();
  expect((await iterator.next()).done).toBe(true);
});

it.each(["bad-json", "missing-terminal", "process-failure", "missing-stream"])(
  "fails closed on %s and waits for cleanup",
  async (mode) => {
    const handle: ProcessHandle = {
      wait: vi.fn(async () => ({
        exitCode: mode === "process-failure" ? 1 : 0,
        stdout: "",
        stderr: "secret diagnostic",
      })),
      kill: vi.fn(),
      ...(mode === "missing-stream"
        ? {}
        : {
            output: (async function* () {
              yield {
                stream: "stdout" as const,
                text:
                  mode === "bad-json"
                    ? "not-json\n"
                    : '{"type":"text","part":{"text":"Partial"}}\n',
              };
            })(),
          }),
    };
    await expect(
      (async () => {
        for await (const _ of runOpenCode(request, environment(handle))) {
        }
      })(),
    ).rejects.toThrow();
    expect(handle.kill).toHaveBeenCalledOnce();
    expect(handle.wait).toHaveBeenCalled();
  },
);

it("propagates cancellation and does not finish before the process is reaped", async () => {
  const abort = new AbortController();
  let reaped = false;
  const handle: ProcessHandle = {
    output: (async function* () {
      abort.abort(new Error("cancel execution"));
      yield { stream: "stdout" as const, text: "" };
    })(),
    kill: vi.fn(),
    async wait() {
      reaped = true;
      return { exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" };
    },
  };
  await expect(
    (async () => {
      for await (const _ of runOpenCode(request, environment(handle), abort.signal)) {
      }
    })(),
  ).rejects.toThrow("cancel execution");
  expect(reaped).toBe(true);
  expect(handle.kill).toHaveBeenCalledOnce();
});

it("runs with manager-only coordination and bounded General and Explore subagents", async () => {
  const root = await mkdtemp(join(tmpdir(), "supertag-opencode-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const upstream = await startManagerIsolationMcp("Bearer coordination-secret");
  cleanups.push(upstream.close);
  const worker = createOpenCodeWorker({
    model: "provider/model",
    providerNetworkHosts: ["provider.example"],
    providerEnvironment: { PROVIDER_API_KEY: "secret" },
    runner: async function* (input, env, signal) {
      expect(env.placement).toBe("local");
      expect(input.prompt).toContain("Implement scheduling");
      expect(input.prompt).not.toContain("secret");
      expect(input.prompt).not.toContain("coordination-secret");
      const config = JSON.parse(input.environment["OPENCODE_CONFIG_CONTENT"] ?? "{}");
      expect(config.mcp["supertag-coordination"]).toMatchObject({
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u),
        headers: { Authorization: expect.stringMatching(/^Bearer [\w-]{43}$/u) },
      });
      expect(JSON.stringify(input.environment)).not.toContain("coordination-secret");
      expect(config.permission).toMatchObject({
        "*": "deny",
        read: "allow",
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        websearch: "allow",
        task: { "*": "deny", general: "allow", explore: "allow" },
        external_directory: "deny",
      });
      expect(config.permission["supertag-coordination_assign_task"]).toBe("allow");
      expect(config.permission["supertag_coordination_assign_task"]).toBe("allow");
      expect(config.agent.build).toMatchObject({ mode: "primary", permission: config.permission });
      expect(config.agent.general).toMatchObject({
        mode: "subagent",
        permission: {
          read: "allow",
          edit: "allow",
          bash: "deny",
          webfetch: "deny",
          websearch: "deny",
          "supertag-coordination_*": "deny",
          "supertag_coordination_*": "deny",
          task: "deny",
        },
      });
      expect(config.agent.explore).toMatchObject({
        mode: "subagent",
        permission: {
          read: "allow",
          edit: "deny",
          bash: "deny",
          webfetch: "deny",
          websearch: "deny",
          "supertag-coordination_*": "deny",
          "supertag_coordination_*": "deny",
          task: "deny",
        },
      });
      expect(config.agent.plan).toEqual({ disable: true });
      expect(input.environment["HOME"]).toBe(env.resolvePath(".opencode-home"));
      expect(input.workspace).toBe(env.rootDirectory);
      expect(signal?.aborted).not.toBe(true);
      await expect(callManagerProxy(config.mcp["supertag-coordination"].url)).rejects.toThrow();
      await callManagerProxy(
        config.mcp["supertag-coordination"].url,
        config.mcp["supertag-coordination"].headers,
      );
      yield { type: "output.message", text: "Implemented" };
    },
  });
  const events = [];
  const attempt = spec();
  for await (const event of worker.execute({
    ...attempt,
    authorization: {
      ...attempt.authorization,
      runtimeActions: ["files:read", "files:write", "commands:execute", "web:fetch", "web:search"],
    },
    coordination: {
      controlPlaneUrl: upstream.controlPlaneUrl,
      token: "coordination-secret",
      objectiveId: "objective",
    },
  }))
    events.push(event);
  expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
  expect(events.some((event) => event.type === "output.message")).toBe(true);
  expect(upstream.calls).toHaveLength(1);
  expect(upstream.authorizations.every((value) => value === "Bearer coordination-secret")).toBe(
    true,
  );
});

it("preserves admitted command and web tools for children without manager coordination", async () => {
  const root = await mkdtemp(join(tmpdir(), "supertag-opencode-ordinary-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let config:
    | {
        agent?: {
          general?: { permission?: Record<string, unknown> };
          explore?: { permission?: Record<string, unknown> };
        };
      }
    | undefined;
  const worker = createOpenCodeWorker({
    model: "provider/model",
    workspace: root,
    runner: async function* (input) {
      config = JSON.parse(input.environment["OPENCODE_CONFIG_CONTENT"] ?? "{}") as typeof config;
      yield { type: "output.message", text: "ordinary" };
    },
  });
  const ordinary = spec();
  const events = [];
  for await (const event of worker.execute({
    ...ordinary,
    authorization: {
      ...ordinary.authorization,
      runtimeActions: ["files:read", "files:write", "commands:execute", "web:fetch", "web:search"],
    },
  })) {
    events.push(event);
  }
  expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: "execution.completed" });
  expect(config?.agent?.general?.permission).toMatchObject({
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    websearch: "allow",
    task: "deny",
  });
  expect(config?.agent?.explore?.permission).toMatchObject({
    edit: "deny",
    bash: "deny",
    webfetch: "allow",
    websearch: "allow",
    task: "deny",
  });
});

it("rejects implicit models and process config overrides and defaults delegation to denied", () => {
  expect(() => new OpenCodeHarness({ model: "implicit" })).toThrow();
  expect(
    () =>
      new OpenCodeHarness({
        model: "provider/model",
        providerEnvironment: { OPENCODE_CONFIG_CONTENT: "{}" },
      }),
  ).toThrow();
  expect(openCodePermissions(["commands:execute", "files:write", "web:fetch"])).toMatchObject({
    task: "deny",
    bash: "allow",
    edit: "allow",
    webfetch: "allow",
    question: "deny",
  });
});

it("transfers only the selected API provider and redacts its key from events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-auth-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, "auth.json");
  const selected = "selected-api-secret";
  await writeFile(
    authFile,
    JSON.stringify({
      provider: { type: "api", key: selected },
      other: { type: "api", key: "unrelated-secret" },
      oauth: { type: "oauth", access: "oauth-secret" },
    }),
  );
  const worker = createOpenCodeWorker({
    model: "provider/model",
    providerNetworkHosts: ["provider.example"],
    authFile,
    runner: async function* (request, env) {
      const path = env.resolvePath(".opencode-home/opencode/auth.json");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        provider: { type: "api", key: selected },
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(request.prompt).not.toContain(selected);
      expect(JSON.stringify(request.environment)).not.toContain(selected);
      yield { type: "output.message", text: `result ${selected}` };
    },
  });
  const events = [];
  for await (const event of worker.execute(spec())) events.push(event);
  expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
  expect(JSON.stringify(events)).not.toContain(selected);
  expect(JSON.stringify(events)).toContain("[REDACTED]");
  expect(JSON.parse(await readFile(authFile, "utf8"))).toHaveProperty("other");
});
it.each([
  { type: "oauth", access: "private" },
  { type: "api", key: "" },
])("rejects unsupported selected credentials before execution", async (credential) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-auth-denied-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, "auth.json");
  await writeFile(authFile, JSON.stringify({ provider: credential }));
  let ran = false;
  const worker = createOpenCodeWorker({
    model: "provider/model",
    providerNetworkHosts: ["provider.example"],
    authFile,
    runner: async function* () {
      ran = true;
      yield { type: "output.message", text: "unexpected" };
    },
  });
  const events = [];
  for await (const event of worker.execute(spec())) events.push(event);
  expect(ran).toBe(false);
  expect(events.at(-1)?.type).toBe("execution.failed");
});

it("applies validated profile model overrides and reports no native session support", async () => {
  const harness = new OpenCodeHarness({
    model: "default/model",
    providerNetworkHosts: ["api.fixture.invalid"],
  });
  const context: ExecutionContext = {
    attempt: spec(),
    profile: {
      ref: { id: "test", revision: "1" },
      workerType: "supertag",
      harness: {
        provider: "opencode",
        configuration: { model: "selected/model", timeoutMs: 1234 },
      },
      execution: { provider: "test", lifetime: { scope: "attempt" } },
    },
    context: { instructions: [], skills: [], history: [], resources: [] },
    tools: [],
    secrets: [],
    sessionStates: [],
    extensions: [],
    sessionStateStore: new InMemorySessionStateStore(),
  };
  const plan = await harness.plan(context);
  expect(plan.metadata).toMatchObject({ model: "selected/model", timeoutMs: 1234 });
  const resolvedEnvironment = environment({
    wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    kill() {},
  });
  const resolved = await harness.resolve({
    context,
    plan,
    environments: { runtime: resolvedEnvironment, execution: resolvedEnvironment },
  });
  expect(resolved.capabilities.sessions).toEqual({ resume: false, export: false, scope: "none" });
  expect(resolved.runtime).toEqual({ name: "opencode", source: "configured" });
  await expect(
    harness.plan({
      ...context,
      profile: {
        ...context.profile,
        harness: { ...context.profile.harness, configuration: { enableAgents: true } },
      },
    }),
  ).rejects.toThrow("Unsupported Harness configuration");
});

it("rejects Worker-local artifact tools explicitly before starting OpenCode", async () => {
  const harness = new OpenCodeHarness({
    model: "provider/model",
    providerNetworkHosts: ["api.fixture.invalid"],
  });
  const context: ExecutionContext = {
    attempt: spec(),
    profile: {
      ref: { id: "test", revision: "1" },
      workerType: "supertag",
      harness: { provider: "opencode" },
      execution: { provider: "test", lifetime: { scope: "attempt" } },
    },
    context: { instructions: [], skills: [], history: [], resources: [] },
    tools: [
      {
        id: "supertag-artifacts",
        kind: "tool",
        required: true,
        capability: {
          id: "supertag-artifacts",
          provider: "supertag",
          operations: [{ name: "find_artifacts", effect: "read", actions: ["find_artifacts"] }],
          authorization: { provider: "supertag", resources: [] },
        },
        binding: {
          kind: "worker-local",
          name: "supertag-artifacts",
          handle: "attempt-bound-handle",
        },
      },
    ],
    secrets: [],
    sessionStates: [],
    extensions: [],
    sessionStateStore: new InMemorySessionStateStore(),
  };
  expect(
    (await harness.describe()).mcpClients?.some((client) =>
      client.transports.includes("worker-local"),
    ),
  ).toBe(false);
  await expect(harness.plan(context)).rejects.toThrow(
    "does not support Worker-local artifact tools",
  );
});

it("serves the Task's model from its list and advertises no effort option", async () => {
  const harness = new OpenCodeHarness({
    model: "anthropic/claude-sonnet-5-5",
    models: ["openai/gpt-6-sol"],
  });
  const described = await harness.describe();
  expect(described.models).toEqual(["anthropic/claude-sonnet-5-5", "openai/gpt-6-sol"]);
  expect(described.efforts).toBeUndefined();
  const context: ExecutionContext = {
    attempt: { ...spec(), execution: { model: "openai/gpt-6-sol", effort: "high" } },
    profile: {
      ref: { id: "test", revision: "1" },
      workerType: "supertag",
      harness: { provider: "opencode" },
      execution: { provider: "test", lifetime: { scope: "attempt" } },
    },
    context: { instructions: [], skills: [], history: [], resources: [] },
    tools: [],
    secrets: [],
    sessionStates: [],
    extensions: [],
    sessionStateStore: new InMemorySessionStateStore(),
  };
  const plan = await harness.plan(context);
  expect(plan.metadata).toMatchObject({ model: "openai/gpt-6-sol", timeoutMs: 60 * 60_000 });
  expect(plan.metadata?.["effort"]).toBeUndefined();
  await expect(
    harness.plan({ ...context, attempt: { ...spec(), execution: { model: "other/model" } } }),
  ).rejects.toThrow("OpenCode on this Worker Host does not serve model other/model");
});
