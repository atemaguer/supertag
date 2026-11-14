import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { Agent, JsonlLocalAgentStore } from "@cursor/sdk";
import { expect, it, vi } from "vitest";
import { cursorCustomTools, listMcpTools, type McpConnector } from "./src/mcp-custom-tools.js";
import {
  cancelCursorSdk,
  cursorSdkErrorCode,
  cursorSdkErrorFrame,
  executeCursorSdk,
  resolveCursorSandboxEntry,
  runCursorStdio,
} from "./src/runner.js";

it("keeps the runner alive after a terminal result until the harness closes it", async () => {
  const input = new PassThrough();
  let emitted!: () => void;
  const resultEmitted = new Promise<void>((resolve) => {
    emitted = resolve;
  });
  let settled = false;
  const running = runCursorStdio(input, async () => {
    emitted(); // Fake SDK has finished and emitted its terminal result.
  }).finally(() => {
    settled = true;
  });
  input.write(`${JSON.stringify({ type: "start", apiKey: "fixture", request: {} })}\n`);
  await resultEmitted;
  await Promise.resolve();
  expect(settled).toBe(false);
  input.write('{"type":"close"}\n');
  await running;
  expect(settled).toBe(true);
  input.destroy();
});

it("finds the platform helper from the SDK entry and refuses a missing helper", () => {
  const root = mkdtempSync(join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "cursor-helper-"));
  const sdkEntry = join(root, "node_modules", "@cursor", "sdk", "dist", "index.js");
  const helper = join(
    root,
    "node_modules",
    `@cursor/sdk-${process.platform}-${process.arch}`,
    "bin",
    "cursorsandbox",
  );
  try {
    mkdirSync(dirname(sdkEntry), { recursive: true });
    writeFileSync(sdkEntry, "");
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, "");
    expect(resolveCursorSandboxEntry(sdkEntry)).toBe(realpathSync(sdkEntry));
    rmSync(helper);
    expect(() => resolveCursorSandboxEntry(sdkEntry)).toThrow(
      new RegExp(`sdk-${process.platform}-${process.arch}.*checked.*cursorsandbox`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("finds the native helper in the installed SDK layout without network access", () => {
  const sdkEntry = createRequire(import.meta.url).resolve("@cursor/sdk");
  expect(resolveCursorSandboxEntry()).toBe(resolveCursorSandboxEntry(sdkEntry));
});

it("refuses before Agent.create when the native sandbox helper is missing", async () => {
  const create = vi.fn();
  const connect = vi.fn();
  const api = { create, resume: vi.fn() } as unknown as Pick<typeof Agent, "create" | "resume">;
  const error = Object.assign(new Error("sdk-darwin-arm64 helper missing"), {
    name: "ConfigurationError",
  });
  await expect(
    executeCursorSdk(
      request(),
      api,
      () => ({}) as JsonlLocalAgentStore,
      () => {},
      () => {
        throw error;
      },
      connect,
    ),
  ).rejects.toBe(error);
  expect(create).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

it("refuses a missing resumed agent before connecting an MCP child", async () => {
  const connect = vi.fn();
  const api = { create: vi.fn(), resume: vi.fn() } as unknown as Pick<
    typeof Agent,
    "create" | "resume"
  >;
  const base = mcpRequest();
  await expect(
    executeCursorSdk(
      { ...base, request: { ...base.request, resumeAgentId: "agent-missing" } },
      api,
      () => ({ agents: { get: async () => null } }) as unknown as JsonlLocalAgentStore,
      () => {},
      () => "sdk-entry",
      connect,
    ),
  ).rejects.toThrow(/agent state/);
  expect(connect).not.toHaveBeenCalled();
  expect(api.resume).not.toHaveBeenCalled();
});

function request(resumeAgentId?: string): Parameters<typeof executeCursorSdk>[0] {
  return {
    type: "start",
    apiKey: "cursor-test-key",
    request: {
      prompt: "Do the Task",
      workspace: tmpdir(),
      storeDirectory: "/tmp/private/store",
      agentId: "agent-fixture",
      ...(resumeAgentId ? { resumeAgentId } : {}),
      model: "composer-2.5",
      mcpServers: {
        tools: { type: "http", url: "http://127.0.0.1/mcp", headers: {}, toolNames: [] },
      },
      tools: ["read", "mcp"],
      disallowedTools: ["task", "webSearch"],
    },
  };
}

it("uses the SDK with sandbox, inline MCP, private JSONL state and per-run tokens", async () => {
  const old = process.env["CURSOR_API_KEY"];
  delete process.env["CURSOR_API_KEY"];
  const frames: Record<string, unknown>[] = [];
  let options: Record<string, unknown> | undefined;
  let directory: string | undefined;
  let closed = false;
  const fake = {
    agentId: "agent-fixture",
    async send(prompt: string) {
      expect(prompt).toBe("Do the Task");
      // A fake SDK shell tool sees the runner's inherited environment.
      const shell = spawnSync(
        process.execPath,
        ["-e", "process.stdout.write(process.env.CURSOR_API_KEY ?? '')"],
        {
          encoding: "utf8",
        },
      );
      expect(shell.status).toBe(0);
      expect(shell.stdout).toBe("");
      return {
        id: "run-fixture",
        async *stream() {
          yield { type: "system" };
          yield { type: "assistant", message: { content: [{ type: "text", text: "Done" }] } };
          yield {
            type: "usage",
            usage: {
              inputTokens: 2,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 3,
            },
          };
        },
        async wait() {
          return {
            status: "finished",
            result: "Done",
            model: { id: "composer-2.5" },
            usage: {
              inputTokens: 2,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 3,
            },
          };
        },
        async cancel() {},
      };
    },
    async getUsage() {
      return {
        cost: { chargedCents: 5 },
        runs: [{ runId: "local-turn-uuid", cost: { chargedCents: 5 } }],
      };
    },
    close() {
      closed = true;
    },
  };
  const api = {
    async create(value: Record<string, unknown>) {
      options = value;
      return fake;
    },
    async resume() {
      throw new Error("unexpected resume");
    },
  } as unknown as Pick<typeof Agent, "create" | "resume">;
  try {
    await executeCursorSdk(
      request(),
      api,
      (value) => {
        directory = value;
        return {} as JsonlLocalAgentStore;
      },
      (frame) => frames.push(frame),
    );
    expect(directory).toBe("/tmp/private/store");
    expect(options).toMatchObject({
      agentId: "agent-fixture",
      apiKey: "cursor-test-key",
      model: { id: "composer-2.5" },
      local: { cwd: tmpdir(), sandboxOptions: { enabled: true } },
      tools: ["read", "mcp"],
      disallowedTools: ["task", "webSearch"],
    });
    // Admitted MCP tools reach Cursor only as customTools; see the custom tool tests.
    expect(options).not.toHaveProperty("mcpServers");
    expect(
      (options?.["local"] as Record<string, unknown> | undefined)?.["settingSources"],
    ).toBeUndefined();
    // @cursor/sdk 1.0.37 rejects systemPrompt locally: "unknown option '--system-prompt'".
    expect(options).not.toHaveProperty("systemPrompt");
    expect(frames.at(-1)).toMatchObject({
      type: "result",
      chargedCents: 5,
      usage: { totalTokens: 3 },
    });
    expect(JSON.stringify(frames)).not.toContain("cursor-test-key");
    await cancelCursorSdk();
    expect(closed).toBe(true);
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("restores the same agent with repeated tool restrictions on resume", async () => {
  const old = process.env["CURSOR_API_KEY"];
  delete process.env["CURSOR_API_KEY"];
  let resumeId: string | undefined;
  let options: Record<string, unknown> | undefined;
  const fake = {
    agentId: "agent-prior",
    async send() {
      return {
        id: "run",
        async *stream() {
          yield { type: "system" };
        },
        async wait() {
          return { status: "finished", result: "Done" };
        },
        async cancel() {},
      };
    },
    async getUsage() {
      throw Object.assign(new Error("unavailable"), { code: "feature_unavailable" });
    },
    close() {},
  };
  const api = {
    async create() {
      throw new Error("unexpected create");
    },
    async resume(id: string, value: Record<string, unknown>) {
      resumeId = id;
      options = value;
      return fake;
    },
  } as unknown as Pick<typeof Agent, "create" | "resume">;
  try {
    const frames: Record<string, unknown>[] = [];
    await executeCursorSdk(
      request("agent-prior"),
      api,
      () => ({}) as JsonlLocalAgentStore,
      (frame) => frames.push(frame),
    );
    expect(resumeId).toBe("agent-prior");
    expect(options).not.toHaveProperty("systemPrompt");
    expect(options).toMatchObject({
      tools: ["read", "mcp"],
      disallowedTools: ["task", "webSearch"],
      local: { sandboxOptions: { enabled: true } },
    });
    expect(options).not.toHaveProperty("mcpServers");
    expect(frames.at(-1)).toMatchObject({ type: "result", result: "Done" });
    expect(frames.at(-1)).not.toHaveProperty("chargedCents");
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("classifies sandbox ConfigurationError without forwarding sensitive messages", () => {
  expect(
    cursorSdkErrorCode(Object.assign(new Error("helper missing"), { name: "ConfigurationError" })),
  ).toBe("SANDBOX_UNAVAILABLE");
  expect(cursorSdkErrorCode(new Error("cursor-test-key"))).toBe("SDK_FAILURE");
  for (const [name, code] of [
    ["AuthenticationError", "AUTHENTICATION_FAILED"],
    ["RateLimitError", "RATE_LIMITED"],
    ["NetworkError", "NETWORK_ERROR"],
    ["AgentBusyError", "AGENT_BUSY"],
    ["AgentNotFoundError", "AGENT_NOT_FOUND"],
    ["IntegrationNotConnectedError", "INTEGRATION_NOT_CONNECTED"],
    ["ConfigurationError", "CONFIGURATION_ERROR"],
    ["UnknownAgentError", "UNKNOWN_AGENT_ERROR"],
  ])
    expect(cursorSdkErrorCode(Object.assign(new Error("diagnostic"), { name }))).toBe(code);
});

it("redacts the key and bounds an unknown SDK error frame", () => {
  const key = "cursor-test-key";
  const auth = Object.assign(new Error(`Invalid User API Key ${key}`), {
    name: "AuthenticationError",
  });
  expect(cursorSdkErrorFrame(auth, key)).toEqual({
    type: "error",
    code: "AUTHENTICATION_FAILED",
    message: "Invalid User API Key [REDACTED]",
  });
  const unknown = cursorSdkErrorFrame(new Error(`failed ${key} ${"x".repeat(1000)}`), key);
  expect(unknown.code).toBe("SDK_FAILURE");
  expect((unknown.message as string).length).toBeGreaterThan(500);
  expect(JSON.stringify(unknown)).not.toContain(key);
});

it("forwards the SDK's redacted run error message in the result frame", async () => {
  const frames: Record<string, unknown>[] = [];
  const secretRequest = request();
  const withSecret = {
    ...secretRequest,
    request: {
      ...secretRequest.request,
      mcpServers: {
        tools: {
          type: "http",
          url: "http://127.0.0.1/mcp",
          headers: { auth: "mcp-header-secret" },
          toolNames: [],
        },
      },
    },
  };
  const fake = {
    agentId: "agent-fixture",
    async send() {
      return {
        id: "run",
        async *stream() {},
        async wait() {
          return {
            status: "error",
            error: {
              message: `[invalid_argument] unknown option '--system-prompt' cursor-test-key mcp-header-secret ${"x".repeat(600)}`,
            },
          };
        },
        async cancel() {},
      };
    },
    async getUsage() {
      throw new Error("unavailable");
    },
    close() {},
  };
  const api = {
    create: async () => fake,
    resume: async () => fake,
  } as unknown as Pick<typeof Agent, "create" | "resume">;
  await executeCursorSdk(
    withSecret,
    api,
    () => ({}) as JsonlLocalAgentStore,
    (frame) => frames.push(frame),
  );
  const result = frames.at(-1) as Record<string, unknown>;
  expect(result).toMatchObject({ type: "result", status: "error" });
  expect(result["error"]).toMatch(
    /^\[invalid_argument\] unknown option '--system-prompt' \[REDACTED\] \[REDACTED\] x+$/,
  );
  expect((result["error"] as string).length).toBeGreaterThan(500);
});

it("builds an error frame from hostile throwables without throwing", () => {
  const nullPrototype = Object.create(null) as Record<string, unknown>;
  expect(cursorSdkErrorFrame(nullPrototype, "cursor-test-key")).toEqual({
    type: "error",
    code: "SDK_FAILURE",
  });
  const nonString = Object.assign(new Error("ignored"), { message: { secret: 1 } });
  expect(cursorSdkErrorFrame(nonString, "cursor-test-key")).toMatchObject({ type: "error" });
  expect(cursorSdkErrorFrame("plain cursor-test-key", "cursor-test-key")).toEqual({
    type: "error",
    code: "SDK_FAILURE",
    message: "plain [REDACTED]",
  });
});

it.each(
  [
    ...Array.from({ length: 5 }, (_, index) => 0x200b + index),
    ...Array.from({ length: 7 }, (_, index) => 0x2028 + index),
    0x2060,
    ...Array.from({ length: 4 }, (_, index) => 0x2066 + index),
    0xfeff,
  ].map((code) => [code.toString(16), String.fromCodePoint(code)] as const),
)("strips invisible U+%s before redacting a split key in an error", (_code, format) => {
  const key = "cursor-test-key";
  const split = `cursor-test${format}-key`;
  const frame = cursorSdkErrorFrame(new Error(`failure ${split}`), key);
  expect(frame).toMatchObject({ message: "failure [REDACTED]" });
  expect(JSON.stringify(frame)).not.toContain(format);
});

function mcpRequest(): Parameters<typeof executeCursorSdk>[0] {
  const base = request();
  return {
    ...base,
    request: {
      ...base.request,
      mcpServers: {
        supertag: {
          type: "stdio",
          command: "/opt/supertag-mcp",
          args: [],
          env: { TOKEN: "mcp-env-secret" },
          toolNames: ["probe", "fails"],
        },
      },
    },
  };
}

type CustomTools = Record<
  string,
  { execute(args: Record<string, unknown>, context: { toolCallId?: string }): Promise<unknown> }
>;

it("exposes exactly the admitted MCP tools as custom tools and reports their calls", async () => {
  const frames: Record<string, unknown>[] = [];
  const calls: unknown[] = [];
  let closed = 0;
  let options: Record<string, unknown> | undefined;
  const connect: McpConnector = async (server, cwd) => {
    expect(server).toMatchObject({ type: "stdio", command: "/opt/supertag-mcp" });
    expect(cwd).toBe(tmpdir());
    return {
      async listTools() {
        return [
          {
            name: "probe",
            description: "Probe",
            inputSchema: { type: "object", properties: { value: { type: "string" } } },
            annotations: { readOnlyHint: true, unknownHint: "dropped" },
          },
          { name: "fails" },
          { name: "not_admitted" },
        ];
      },
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "fails") throw new Error("upstream refused mcp-env-secret");
        return { content: [{ type: "text", text: "SUPERTAG_MCP_OK" }] };
      },
      async close() {
        closed += 1;
      },
    };
  };
  const results: unknown[] = [];
  const fake = {
    agentId: "agent-fixture",
    async send() {
      const tools =
        (options?.["local"] as { customTools: CustomTools } | undefined)?.customTools ?? {};
      results.push(
        await tools["supertag_probe"]?.execute({ value: "x" }, { toolCallId: "call-1" }),
      );
      results.push(await tools["supertag_fails"]?.execute({}, { toolCallId: "call-2" }));
      return {
        id: "run",
        async *stream() {},
        async wait() {
          return { status: "finished", result: "Done" };
        },
        async cancel() {},
      };
    },
    async getUsage() {
      throw new Error("unavailable");
    },
    close() {},
  };
  const api = {
    async create(value: Record<string, unknown>) {
      options = value;
      return fake;
    },
    resume: vi.fn(),
  } as unknown as Pick<typeof Agent, "create" | "resume">;
  await executeCursorSdk(
    mcpRequest(),
    api,
    () => ({}) as JsonlLocalAgentStore,
    (frame) => frames.push(frame),
    resolveCursorSandboxEntry,
    connect,
  );
  expect(options).not.toHaveProperty("mcpServers");
  const tools =
    (options?.["local"] as { customTools: Record<string, Record<string, unknown>> } | undefined)
      ?.customTools ?? {};
  expect(Object.keys(tools).sort()).toEqual(["supertag_fails", "supertag_probe"]);
  expect(tools["supertag_probe"]).toMatchObject({
    description: "Probe",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  });
  expect(tools["supertag_probe"]?.["annotations"]).not.toHaveProperty("unknownHint");
  expect(calls).toEqual([
    { name: "probe", args: { value: "x" } },
    { name: "fails", args: {} },
  ]);
  expect(results[0]).toEqual({
    content: [{ type: "text", text: "SUPERTAG_MCP_OK" }],
    isError: false,
  });
  expect(results[1]).toEqual({
    content: [{ type: "text", text: "SuperTag MCP tool call failed: upstream refused [REDACTED]" }],
    isError: true,
  });
  const toolFrames = frames.filter((frame) => frame["type"] === "event");
  expect(toolFrames.slice(0, 2)).toEqual([
    {
      type: "event",
      event: { type: "tool_call", call_id: "call-1", name: "supertag_probe", status: "running" },
    },
    {
      type: "event",
      event: { type: "tool_call", call_id: "call-1", name: "supertag_probe", status: "completed" },
    },
  ]);
  expect(toolFrames[3]).toMatchObject({
    event: { type: "tool_call", name: "supertag_fails", status: "error" },
  });
  // Frames carry only the stable envelope, never arguments, results or MCP secrets.
  expect(JSON.stringify(frames)).not.toMatch(/SUPERTAG_MCP_OK|mcp-env-secret|"value"/u);
  expect(closed).toBe(1);
});

it("fails the run and cancels when Cursor declines an admitted MCP tool call", async () => {
  let cancelled = false;
  const frames: Record<string, unknown>[] = [];
  const fake = {
    agentId: "agent-fixture",
    async send() {
      return {
        id: "run",
        async *stream() {
          yield {
            type: "tool_call",
            call_id: "call-1",
            name: "mcp",
            status: "error",
            args: { providerIdentifier: "custom-user-tools", toolName: "supertag_probe", args: {} },
            result: {
              rejected: {
                reason:
                  "User rejected MCP: supertag-probe - Local SDK runs cannot request interactive approval for this MCP tool call.",
              },
            },
          };
        },
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
  const api = {
    create: async () => fake,
    resume: vi.fn(),
  } as unknown as Pick<typeof Agent, "create" | "resume">;
  const failure = await executeCursorSdk(
    mcpRequest(),
    api,
    () => ({}) as JsonlLocalAgentStore,
    (frame) => frames.push(frame),
    () => "sdk-entry",
    async () => ({
      async listTools() {
        return [{ name: "probe" }];
      },
      async callTool() {
        return { content: [] };
      },
      async close() {},
    }),
  ).catch((error: unknown) => error);
  expect(cancelled).toBe(true);
  expect(cursorSdkErrorCode(failure)).toBe("MCP_TOOL_REJECTED");
  expect(frames.some((frame) => frame["type"] === "result")).toBe(false);
  // The rejection reason stays inside the runner; only the envelope is forwarded.
  expect(JSON.stringify(frames)).not.toContain("User rejected");
});

async function runCustomToolStream(options: {
  providerIdentifier?: string;
  eventName?: string;
  toolName?: string;
  callId?: string;
  status: "completed" | "error" | "running";
  execute?: boolean;
  omitArgs?: boolean;
  /** Streams a running event first, as the 1.0.37 stream does before a terminal event. */
  precedeWithRunning?: boolean;
}) {
  let customTools: CustomTools = {};
  let cancelled = false;
  let invoked = 0;
  const frames: Record<string, unknown>[] = [];
  const api = {
    async create(value: { local: { customTools: CustomTools } }) {
      customTools = value.local.customTools;
      return {
        agentId: "agent-fixture",
        async send() {
          return {
            id: "run",
            async *stream() {
              if (options.precedeWithRunning)
                yield {
                  type: "tool_call",
                  call_id: options.callId,
                  name: options.eventName ?? "mcp",
                  status: "running",
                  args: {
                    providerIdentifier: options.providerIdentifier ?? "custom-user-tools",
                    toolName: options.toolName ?? "supertag_probe",
                    args: { secret: "private-arg" },
                  },
                };
              if (options.execute)
                await customTools["supertag_probe"]?.execute({}, { toolCallId: options.callId });
              yield {
                type: "tool_call",
                call_id: options.callId,
                name: options.eventName ?? "mcp",
                status: options.status,
                ...(options.omitArgs
                  ? {}
                  : {
                      args: {
                        providerIdentifier: options.providerIdentifier ?? "custom-user-tools",
                        toolName: options.toolName ?? "supertag_probe",
                        args: { secret: "private-arg" },
                      },
                    }),
                result: "private-result",
              };
            },
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
  const failure = await executeCursorSdk(
    mcpRequest(),
    api,
    () => ({}) as JsonlLocalAgentStore,
    (frame) => frames.push(frame),
    () => "sdk-entry",
    async () => ({
      async listTools() {
        return [{ name: "probe" }];
      },
      async callTool() {
        invoked++;
        return { content: [{ type: "text", text: "private-result" }] };
      },
      async close() {},
    }),
  ).catch((error: unknown) => error);
  expect(JSON.stringify(frames)).not.toMatch(/private-arg|private-result/u);
  return { failure, frames, cancelled, invoked };
}

it("accepts an executed custom MCP call in the SDK stream shape", async () => {
  const result = await runCustomToolStream({
    callId: "call-1",
    status: "completed",
    execute: true,
  });
  expect(result.failure).toBeUndefined();
  expect(result.cancelled).toBe(false);
  expect(result.invoked).toBe(1);
  expect(result.frames.at(-1)).toMatchObject({ type: "result", status: "finished" });
});

it("accepts a custom MCP call streamed as running then completed after execute", async () => {
  const result = await runCustomToolStream({
    callId: "call-1",
    status: "completed",
    execute: true,
    precedeWithRunning: true,
  });
  expect(result.failure).toBeUndefined();
  expect(result.cancelled).toBe(false);
  expect(result.invoked).toBe(1);
  expect(result.frames.at(-1)).toMatchObject({ type: "result", status: "finished" });
});

it.each([{ execute: true }, { execute: false }])(
  "fails a custom MCP call left running at end of stream: %j",
  async ({ execute }) => {
    const result = await runCustomToolStream({
      callId: "call-1",
      status: "running",
      execute,
    });
    expect(cursorSdkErrorCode(result.failure)).toBe("MCP_TOOL_REJECTED");
    expect(result.failure).toHaveProperty(
      "message",
      "Cursor did not execute an admitted SuperTag MCP tool call",
    );
    expect(result.frames.some((frame) => frame["type"] === "result")).toBe(false);
  },
);

it("fails a custom MCP call that ran and was streamed running but never completed", async () => {
  const result = await runCustomToolStream({
    callId: "call-1",
    status: "running",
    execute: true,
    precedeWithRunning: true,
  });
  expect(result.invoked).toBe(1);
  expect(cursorSdkErrorCode(result.failure)).toBe("MCP_TOOL_REJECTED");
});

it("rejects a completed custom MCP event without an execute call", async () => {
  const result = await runCustomToolStream({ callId: "call-1", status: "completed" });
  expect(result.invoked).toBe(0);
  expect(result.cancelled).toBe(true);
  expect(cursorSdkErrorCode(result.failure)).toBe("MCP_TOOL_REJECTED");
});

it("reports a post-execution SDK error as a run failure, not a declined tool", async () => {
  const result = await runCustomToolStream({ callId: "call-1", status: "error", execute: true });
  expect(result.cancelled).toBe(true);
  expect(result.invoked).toBe(1);
  expect(cursorSdkErrorCode(result.failure)).toBe("SDK_FAILURE");
  expect(result.failure).toHaveProperty(
    "message",
    "Cursor failed after executing an admitted SuperTag MCP tool call",
  );
});

it.each([
  { providerIdentifier: "custom-user-tools", toolName: "unknown_tool" },
  { omitArgs: true },
])("fails closed on an unadmitted MCP call: %j", async (input) => {
  const result = await runCustomToolStream({ ...input, callId: "call-1", status: "error" });
  expect(result.cancelled).toBe(true);
  expect(cursorSdkErrorCode(result.failure)).toBe("PROTOCOL_ERROR");
});

it("identifies an untrusted MCP provider", async () => {
  const result = await runCustomToolStream({
    providerIdentifier: "another-provider",
    toolName: "supertag_probe",
    callId: "call-1",
    status: "error",
  });
  expect(result.cancelled).toBe(true);
  expect(cursorSdkErrorCode(result.failure)).toBe("MCP_PROVIDER_UNTRUSTED");
  expect(result.failure).toHaveProperty("message", "Cursor called an untrusted MCP provider");
});

it("rejects an MCP call whose SDK event name is unknown", async () => {
  const result = await runCustomToolStream({
    eventName: "unknown",
    callId: "call-1",
    status: "completed",
    execute: true,
  });
  expect(result.cancelled).toBe(true);
  expect(cursorSdkErrorCode(result.failure)).toBe("PROTOCOL_ERROR");
});

it.each([undefined, ""])("refuses a custom call with missing toolCallId %j", async (callId) => {
  const result = await runCustomToolStream({ callId, status: "error", execute: true });
  expect(result.invoked).toBe(0);
  expect(result.cancelled).toBe(true);
  expect(cursorSdkErrorCode(result.failure)).toBe("MCP_TOOL_REJECTED");
});

it("ignores rejection words in an unrelated tool result", async () => {
  let cancelled = false;
  const fake = {
    agentId: "agent-fixture",
    async send() {
      return {
        id: "run",
        async *stream() {
          yield {
            type: "tool_call",
            call_id: "read-1",
            name: "read",
            status: "completed",
            result: "User rejected MCP",
          };
        },
        async wait() {
          return { status: "finished", result: "Done" };
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
  const frames: Record<string, unknown>[] = [];
  await executeCursorSdk(
    request(),
    { create: async () => fake, resume: vi.fn() } as unknown as Pick<
      typeof Agent,
      "create" | "resume"
    >,
    () => ({}) as JsonlLocalAgentStore,
    (frame) => frames.push(frame),
    () => "sdk-entry",
  );
  expect(cancelled).toBe(false);
  expect(frames.at(-1)).toMatchObject({ type: "result", status: "finished" });
});

// The 1.0.37 stream names an MCP call "mcp". Provider-marked events with
// unfamiliar names must still be refused if a future SDK exposes them.
it.each([
  { name: "mcp", code: "MCP_PROVIDER_UNTRUSTED" },
  { name: "mcp_tool_call", code: "PROTOCOL_ERROR" },
  { name: "get_mcp_tools_tool_call", code: "PROTOCOL_ERROR" },
  { name: "list_mcp_resources_tool_call", code: "PROTOCOL_ERROR" },
  { name: "read_mcp_resource_tool_call", code: "PROTOCOL_ERROR" },
  { name: "mcp_auth_tool_call", code: "PROTOCOL_ERROR" },
])("native MCP event $name fails closed", async ({ name, code }) => {
  let cancelled = false;
  const fake = {
    agentId: "agent-fixture",
    async send() {
      return {
        id: "run",
        async *stream() {
          yield {
            type: "tool_call",
            call_id: "native-1",
            name,
            status: "error",
            args: { providerIdentifier: "other-server", toolName: "probe" },
          };
        },
        async wait() {
          return { status: "cancelled" };
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
  const failure = await executeCursorSdk(
    request(),
    { create: async () => fake, resume: vi.fn() } as unknown as Pick<
      typeof Agent,
      "create" | "resume"
    >,
    () => ({}) as JsonlLocalAgentStore,
    () => {},
    () => "sdk-entry",
  ).catch((error: unknown) => error);
  expect(cancelled).toBe(true);
  expect(cursorSdkErrorCode(failure)).toBe(code);
});

it("bounds empty cursor pages and oversized list responses", async () => {
  const repeated = vi.fn(async () => ({ tools: [], nextCursor: "same" }));
  await expect(listMcpTools(repeated)).rejects.toThrow(/page limit/);
  expect(repeated).toHaveBeenCalledTimes(50);
  await expect(
    listMcpTools(async () => ({
      tools: [{ name: "a", description: "x".repeat(2 * 1024 * 1024) }],
    })),
  ).rejects.toThrow(/size limit/);
});

it("aborts an in-flight MCP call and emits no event after the terminal frame", async () => {
  const frames: Record<string, unknown>[] = [];
  let release!: (value: { content: { type: "text"; text: string }[] }) => void;
  let signal: AbortSignal | undefined;
  const bridge = await cursorCustomTools(
    { supertag: { type: "http", url: "http://127.0.0.1/mcp", headers: {}, toolNames: ["probe"] } },
    tmpdir(),
    (frame) => frames.push(frame),
    () => undefined,
    async () => ({
      async listTools() {
        return [{ name: "probe" }];
      },
      callTool(_name, _args, receivedSignal) {
        signal = receivedSignal;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      async close() {},
    }),
  );
  const pending = bridge.tools["supertag_probe"]?.execute({}, { toolCallId: "call-1" });
  expect(signal?.aborted).toBe(false);
  frames.push({ type: "result" });
  bridge.abort();
  expect(signal?.aborted).toBe(true);
  release({ content: [{ type: "text", text: "late" }] });
  expect(await pending).toEqual({ content: [], isError: true });
  expect(frames.at(-1)).toEqual({ type: "result" });
  await bridge.close();
});

it("bridges a real stdio MCP server through the MCP client", async () => {
  const root = mkdtempSync(join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "cursor-mcp-"));
  const script = join(root, "server.cjs");
  writeFileSync(
    script,
    `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'supertag',version:'1'}}:m.method==='tools/list'?{tools:[{name:'probe',inputSchema:{type:'object',properties:{}}},{name:'hidden',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'SUPERTAG_MCP_OK '+process.env.PROBE_TOKEN}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`,
  );
  const frames: Record<string, unknown>[] = [];
  const bridge = await cursorCustomTools(
    {
      supertag: {
        type: "stdio",
        command: process.execPath,
        args: [script],
        env: { PROBE_TOKEN: "token-from-binding" },
        toolNames: ["probe"],
      },
    },
    root,
    (frame) => frames.push(frame),
    () => undefined,
  );
  try {
    expect(Object.keys(bridge.tools)).toEqual(["supertag_probe"]);
    expect(await bridge.tools["supertag_probe"]?.execute({}, { toolCallId: "call-1" })).toEqual({
      content: [{ type: "text", text: "SUPERTAG_MCP_OK token-from-binding" }],
      isError: false,
    });
    expect(frames.map((frame) => (frame["event"] as Record<string, unknown>)["status"])).toEqual([
      "running",
      "completed",
    ]);
  } finally {
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it.each([
  { admitSearch: true, nativeTool: "webSearch", failure: undefined },
  { admitSearch: false, nativeTool: "webSearch", failure: "requires mcp only" },
  { admitSearch: true, nativeTool: "read", failure: "called a built-in tool" },
])(
  "keeps native workspace tools blocked with scoped web search ($nativeTool, $admitSearch)",
  async ({ admitSearch, nativeTool, failure }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-web-policy-")));
    const workspace = join(root, "workspace");
    const storeDirectory = join(root, "store");
    mkdirSync(workspace);
    mkdirSync(storeDirectory);
    const create = vi.fn(async () => ({
      agentId: "agent-fixture",
      async send() {
        return {
          id: "run",
          async *stream() {
            yield { type: "tool_call", name: nativeTool, call_id: "native", status: "completed" };
          },
          async wait() {
            return { status: "finished", result: "Done" };
          },
          async cancel() {},
        };
      },
      async getUsage() {
        throw new Error("unavailable");
      },
      close() {},
    }));
    try {
      const base = request();
      const execute = executeCursorSdk(
        {
          ...base,
          request: {
            ...base.request,
            workspace,
            storeDirectory,
            splitTools: [],
            tools: ["mcp", "webSearch"],
            disallowedTools: ["read", "edit", "shell", "grep", "glob", "ls", "task"],
            ...(admitSearch ? { allowNativeWebSearch: true } : {}),
          },
        },
        { create, resume: vi.fn() } as unknown as Pick<typeof Agent, "create" | "resume">,
        () => ({}) as JsonlLocalAgentStore,
        () => {},
      );
      if (failure) await expect(execute).rejects.toThrow(failure);
      else {
        await execute;
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({ tools: ["mcp", "webSearch"] }),
        );
      }
      if (!admitSearch) expect(create).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
