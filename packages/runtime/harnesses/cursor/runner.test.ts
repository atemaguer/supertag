import { spawnSync } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionCleanupError } from "@supertag/worker-sdk";
import { expect, it, vi } from "vitest";
import type { HarnessRuntime, ProcessOutputChunk } from "../../sdk/src/index.js";
import { type CursorRunRequest, runCursor } from "./src/index.js";
import { CursorProcessTree } from "./src/process-tree.js";

const request: CursorRunRequest = {
  prompt: "work",
  workspace: "/tmp/work",
  timeoutMs: 5000,
  home: "/tmp/private",
  storeDirectory: "/tmp/private/store",
  agentId: "agent-fixture",
  model: "auto",
  mcpServers: {},
  tools: ["read"],
  disallowedTools: ["task", "webSearch"],
  toolInputs: [],
};

function fakeRuntime(
  chunks: readonly string[],
  exitCode = 0,
  capture?: (value: unknown) => void,
): HarnessRuntime {
  return {
    placement: "remote",
    id: "fixture",
    rootDirectory: "/tmp",
    resolvePath: (path) => `/tmp/${path}`,
    async prepare() {},
    async read() {
      return "";
    },
    async dispose() {},
    async spawn(spec) {
      capture?.(spec);
      return {
        output: (async function* (): AsyncIterable<ProcessOutputChunk> {
          for (const text of chunks) yield { stream: "stdout", text };
        })(),
        write: async (bytes: Uint8Array) => capture?.(new TextDecoder().decode(bytes)),
        wait: async () => ({ exitCode, stdout: "", stderr: "" }),
        kill: () => undefined,
      };
    },
  } as HarnessRuntime;
}

async function collect(chunks: readonly string[], exitCode = 0) {
  return Array.fromAsync(runCursor(request, fakeRuntime(chunks, exitCode)));
}

it("accepts split NDJSON lines and emits the final result only after clean exit", async () => {
  const frames = `${[
    JSON.stringify({ type: "agent", agentId: "agent-fixture" }),
    JSON.stringify({
      type: "event",
      event: { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
    }),
    JSON.stringify({
      type: "result",
      status: "finished",
      result: "done",
      model: "auto",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
      },
    }),
  ].join("\n")}\n`;
  const original = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  try {
    const events = await collect([frames.slice(0, 12), frames.slice(12, 44), frames.slice(44)]);
    expect(events.map((event) => event.type)).toEqual([
      "cursor.session",
      "output.message",
      "usage.updated",
      "output.message",
    ]);
    expect(events.at(-1)).toEqual({ type: "output.message", text: "done", final: true });
  } finally {
    if (original === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = original;
  }
});

it.each([
  ["malformed", ['{"type":"agent",', "\n"], 0, /malformed JSON/],
  ["partial", ['{"type":"agent"'], 0, /partial line/],
  [
    "missing result",
    [`${JSON.stringify({ type: "agent", agentId: "agent-fixture" })}\n`],
    0,
    /without a result/,
  ],
  [
    "nonzero",
    [`${JSON.stringify({ type: "result", status: "finished", result: "done" })}\n`],
    2,
    /unsuccessfully/,
  ],
  [
    "sandbox refusal",
    [`${JSON.stringify({ type: "error", code: "SANDBOX_UNAVAILABLE" })}\n`],
    1,
    /refusing unsandboxed execution/,
  ],
  [
    "declined MCP call",
    [`${JSON.stringify({ type: "error", code: "MCP_TOOL_REJECTED", message: "approval" })}\n`],
    1,
    /^Cursor declined an admitted SuperTag MCP tool call: approval$/,
  ],
] as const)("fails typed on %s stream", async (_name, chunks, exitCode, pattern) => {
  const original = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  try {
    await expect(collect(chunks, exitCode)).rejects.toThrow(pattern);
  } finally {
    if (original === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = original;
  }
});

it("sends cancellation to the child and terminates a stalled runner", async () => {
  const old = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  const controller = new AbortController();
  const writes: string[] = [];
  let released!: () => void;
  const done = new Promise<void>((resolve) => {
    released = resolve;
  });
  let killed = false;
  const runtime = {
    ...fakeRuntime([]),
    async spawn() {
      return {
        output: (async function* () {
          await done;
          yield { stream: "stdout" as const, text: "" };
        })(),
        write: async (bytes: Uint8Array) => {
          const value = new TextDecoder().decode(bytes);
          writes.push(value);
          if (value.includes('"cancel"')) released();
        },
        wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        kill: () => {
          killed = true;
          released();
        },
      };
    },
  } as HarnessRuntime;
  try {
    const pending = Array.fromAsync(runCursor(request, runtime, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toThrow(/without a result/);
    expect(writes.some((value) => value.includes('"cancel"'))).toBe(true);
    expect(killed).toBe(false);
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("reports invalid keys without exposing them to events or errors", async () => {
  const old = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  const events: unknown[] = [];
  try {
    const pending = (async () => {
      for await (const event of runCursor(
        request,
        fakeRuntime(
          [
            `${JSON.stringify({ type: "error", code: "AUTHENTICATION_FAILED", message: "Invalid User API Key cursor-test-key" })}\n`,
          ],
          1,
        ),
        new AbortController().signal,
      ))
        events.push(event);
    })();
    const failure = await pending.catch((error: unknown) => error);
    expect(failure.message).toBe(
      "Cursor rejected CURSOR_API_KEY; replace the key (https://cursor.com/docs/cli/reference/authentication.md): Invalid User API Key [REDACTED]",
    );
    expect(JSON.stringify(events)).not.toContain("cursor-test-key");
    expect(String(failure)).not.toContain("cursor-test-key");
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("reports a bounded, redacted unknown runner error", async () => {
  const old = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  try {
    const failure = await collect(
      [
        `${JSON.stringify({ type: "error", code: "SDK_FAILURE", message: `failed cursor-test-key ${"x".repeat(470)}`.slice(0, 500) })}\n`,
      ],
      1,
    ).catch((error: unknown) => error);
    expect(failure.message).toContain("Cursor SDK child failed (SDK_FAILURE): failed [REDACTED]");
    expect(failure.message.length).toBeLessThan(600);
    expect(String(failure)).not.toContain("cursor-test-key");
    const maliciousCode = await collect(
      [`${JSON.stringify({ type: "error", code: "cursor-test-key", message: "failed" })}\n`],
      1,
    ).catch((error: unknown) => error);
    expect(String(maliciousCode)).not.toContain("cursor-test-key");
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("settles promptly when the runner exits before an agent frame", async () => {
  const old = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  const runtime = {
    ...fakeRuntime([]),
    async spawn() {
      return {
        output: (async function* (): AsyncIterable<ProcessOutputChunk> {
          await new Promise<never>(() => undefined);
        })(),
        write: async () => undefined,
        wait: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
        kill: () => undefined,
      };
    },
  } as HarnessRuntime;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = Array.fromAsync(runCursor(request, runtime, new AbortController().signal));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("runner stalled")), 1500);
    });
    await expect(Promise.race([run, timeout])).rejects.toThrow(/runner exited unsuccessfully/);
  } finally {
    if (timer) clearTimeout(timer);
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("isolates HOME and sends the API key only over runner stdin", async () => {
  const original = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  const seen: unknown[] = [];
  try {
    await Array.fromAsync(
      runCursor(
        request,
        fakeRuntime(
          [
            `${JSON.stringify({ type: "agent", agentId: "agent-fixture" })}\n`,
            `${JSON.stringify({ type: "result", status: "finished", result: "done" })}\n`,
          ],
          0,
          (value) => seen.push(value),
        ),
      ),
    );
    const spawn = seen[0] as {
      args: string[];
      environment: Record<string, string>;
      replaceEnvironment: boolean;
    };
    expect(spawn.args.slice(0, 2)).toEqual(["--conditions=development", "--import"]);
    expect(spawn.replaceEnvironment).toBe(true);
    expect(spawn.environment["HOME"]).toBe(request.home);
    expect(spawn.environment["XDG_CONFIG_HOME"]).toContain(request.home);
    expect(spawn.environment["XDG_DATA_HOME"]).toContain(request.home);
    expect(spawn.environment["XDG_CACHE_HOME"]).toContain(request.home);
    expect(spawn.environment["PATH"]).toBe(
      [dirname(process.execPath), process.env["PATH"]].filter(Boolean).join(delimiter),
    );
    expect(spawn.environment["TMPDIR"]).toBe(process.env["TMPDIR"]);
    expect(spawn.environment["CURSOR_API_KEY"]).toBeUndefined();
    expect(JSON.stringify(spawn.environment)).not.toContain("cursor-test-key");
    expect(JSON.parse(seen[1] as string)).toMatchObject({
      type: "start",
      apiKey: "cursor-test-key",
    });
  } finally {
    if (original === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = original;
  }
});

it("puts the Worker's Node ahead of an older Node without forwarding toolchain secrets", async () => {
  vi.stubEnv("PATH", `/old-node/bin${delimiter}/tools/bin`);
  vi.stubEnv("CURSOR_API_KEY", "cursor-test-key");
  vi.stubEnv("COREPACK_HOME", "/host/corepack");
  vi.stubEnv("PNPM_HOME", "/host/pnpm");
  vi.stubEnv("npm_config_cache", "/host/npm-cache");
  const seen: unknown[] = [];
  try {
    await Array.fromAsync(
      runCursor(
        request,
        fakeRuntime(
          [
            `${JSON.stringify({ type: "agent", agentId: "agent-fixture" })}\n`,
            `${JSON.stringify({ type: "result", status: "finished", result: "done" })}\n`,
          ],
          0,
          (value) => seen.push(value),
        ),
      ),
    );
    const spawn = seen[0] as { environment: Record<string, string> };
    expect(spawn.environment["PATH"]?.split(delimiter)).toEqual([
      dirname(process.execPath),
      "/old-node/bin",
      "/tools/bin",
    ]);
    for (const name of ["CURSOR_API_KEY", "COREPACK_HOME", "PNPM_HOME", "npm_config_cache"])
      expect(spawn.environment[name]).toBeUndefined();
    expect(spawn.environment["HOME"]).toBe(request.home);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("starts the source runner with development conditions without compiled output", () => {
  const source = fileURLToPath(new URL("./src/runner.ts", import.meta.url));
  const tsx = fileURLToPath(import.meta.resolve("tsx"));
  const child = spawnSync(process.execPath, ["--conditions=development", "--import", tsx, source], {
    input: '{"type":"bad"}\n',
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.stdout).toContain('"code":"PROTOCOL_ERROR"');
});

it("reports the SDK cause after mapped text and redacts environment secrets", async () => {
  const oldKey = process.env["CURSOR_API_KEY"];
  const oldSecret = process.env["CURSOR_TEST_SECRET"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  process.env["CURSOR_TEST_SECRET"] = "private-test-secret-value";
  try {
    const frame = JSON.stringify({
      type: "error",
      code: "SANDBOX_UNAVAILABLE",
      message: "Local SDK sandboxing unavailable: private-test-secret-value cursor-test-key",
    });
    await expect(collect([`${frame}\n`], 1)).rejects.toThrow(
      "Cursor sandbox is unavailable; refusing unsandboxed execution: Local SDK sandboxing unavailable: [REDACTED] [REDACTED]",
    );
    const longFrame = JSON.stringify({
      type: "error",
      code: "SDK_FAILURE",
      message: `${"x".repeat(470)}private-test-secret-value`,
    });
    const longFailure = await collect([`${longFrame}\n`], 1).catch((error: Error) => error);
    expect(longFailure.message).not.toContain("private-test-secret");
    expect(longFailure.message).toContain("[REDACTED]");
    expect(longFailure.message.length).toBeLessThan(600);
  } finally {
    if (oldKey === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = oldKey;
    if (oldSecret === undefined) delete process.env["CURSOR_TEST_SECRET"];
    else process.env["CURSOR_TEST_SECRET"] = oldSecret;
  }
});

it("reports the SDK's redacted result error instead of a bare failure", async () => {
  const oldKey = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  try {
    const failed = JSON.stringify({
      type: "result",
      status: "error",
      error:
        "[invalid_argument] unknown option '--system-prompt' cursor-test-key mcp-header-secret",
    });
    const withMcp: CursorRunRequest = {
      ...request,
      mcpServers: {
        tools: {
          type: "http",
          url: "http://127.0.0.1/mcp",
          headers: { auth: "mcp-header-secret" },
        },
      },
    };
    const failure = await Array.fromAsync(runCursor(withMcp, fakeRuntime([`${failed}\n`]))).catch(
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Cursor run failed: [invalid_argument] unknown option '--system-prompt' [REDACTED] [REDACTED]",
    );
    const cancelled = JSON.stringify({ type: "result", status: "cancelled" });
    await expect(collect([`${cancelled}\n`])).rejects.toThrow(/^Cursor run was cancelled$/);
  } finally {
    if (oldKey === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = oldKey;
  }
});

it("redacts an MCP secret crossing the diagnostic limit before truncation", async () => {
  const old = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  const secret = "mcp-original-test-secret";
  const withMcp: CursorRunRequest = {
    ...request,
    mcpServers: {
      tools: {
        type: "http",
        url: "http://127.0.0.1/mcp",
        headers: { auth: secret },
        toolNames: [],
      },
    },
  };
  try {
    const message = `${"x".repeat(490)}${secret}`;
    const frame = `${JSON.stringify({ type: "result", status: "error", error: message })}\n`;
    const failure = await Array.fromAsync(runCursor(withMcp, fakeRuntime([frame]))).catch(
      (error: Error) => error,
    );
    expect(failure.message).toContain("[REDACTED]");
    expect(failure.message).not.toContain(secret.slice(0, 5));
    expect(failure.message.length).toBeLessThan(600);
    const nearCut = `${JSON.stringify({
      type: "result",
      status: "error",
      error: `${"x".repeat(495)}${secret}`,
    })}\n`;
    const nearCutFailure = await Array.fromAsync(runCursor(withMcp, fakeRuntime([nearCut]))).catch(
      (error: Error) => error,
    );
    expect(nearCutFailure.message).not.toContain(secret.slice(0, 5));
    expect(nearCutFailure.message).not.toContain("[REDA");
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("redacts base64 and URL encoded MCP secrets in runner errors", async () => {
  const old = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  const secret = "mcp/header?test-secret";
  const withMcp: CursorRunRequest = {
    ...request,
    mcpServers: {
      tools: {
        type: "http",
        url: "http://127.0.0.1/mcp",
        headers: { auth: secret },
        toolNames: [],
      },
    },
  };
  try {
    const message = `failed ${Buffer.from(secret).toString("base64")} ${encodeURIComponent(secret)}`;
    const frame = `${JSON.stringify({ type: "error", code: "SDK_FAILURE", message })}\n`;
    const failure = await Array.fromAsync(runCursor(withMcp, fakeRuntime([frame], 1))).catch(
      (error: Error) => error,
    );
    expect(failure.message).toBe(
      "Cursor SDK child failed (SDK_FAILURE): failed [REDACTED] [REDACTED]",
    );
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("removes control characters from runner error details", async () => {
  const old = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  try {
    const frame = `${JSON.stringify({ type: "error", code: "SDK_FAILURE", message: "bad\r\n\t\u001b[31m\u007f\u009b" })}\n`;
    const failure = await collect([frame], 1).catch((error: Error) => error);
    expect(failure.message).toContain("bad[31m");
    expect(
      Array.from(failure.message).every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 31 && (code < 127 || code > 159);
      }),
    ).toBe(true);
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("receives an error frame after the runner exits without hanging", async () => {
  const old = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  const runtime = {
    ...fakeRuntime([]),
    async spawn() {
      return {
        output: (async function* (): AsyncIterable<ProcessOutputChunk> {
          await new Promise((resolve) => setTimeout(resolve, 120));
          yield {
            stream: "stdout" as const,
            text: `${JSON.stringify({ type: "error", code: "SDK_FAILURE", message: "late diagnostic" })}\n`,
          };
        })(),
        write: async () => undefined,
        wait: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
        kill: () => undefined,
      };
    },
  } as HarnessRuntime;
  try {
    const failure = await Array.fromAsync(runCursor(request, runtime)).catch(
      (error: Error) => error,
    );
    expect(failure.message).toContain("late diagnostic");
  } finally {
    if (old === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = old;
  }
});

it("closes the runner only after the result-time process scan", async () => {
  const original = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  const order: string[] = [];
  const prepare = vi.spyOn(CursorProcessTree, "prepare").mockResolvedValue({
    marker: "cursor-test-marker",
    start: vi.fn(async () => {}),
    scanWhileRunnerStopped: vi.fn(async () => {
      order.push("scan");
    }),
    signalDescendants: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    confirm: vi.fn(async () => {}),
    close: vi.fn(),
  } as unknown as CursorProcessTree);
  const base = fakeRuntime(
    [
      `${JSON.stringify({ type: "agent", agentId: "agent-fixture" })}\n`,
      `${JSON.stringify({ type: "result", status: "finished", result: "done" })}\n`,
    ],
    0,
    (value) => {
      if (typeof value === "string" && value.includes('"close"')) order.push("close");
    },
  );
  const runtime = {
    ...base,
    placement: "local" as const,
    async spawn(spec: Parameters<HarnessRuntime["spawn"]>[0]) {
      return { ...(await base.spawn(spec)), pid: 900001 };
    },
  } as HarnessRuntime;
  try {
    await Array.fromAsync(runCursor(request, runtime));
    expect(order).toEqual(["scan", "scan", "close"]);
  } finally {
    prepare.mockRestore();
    if (original === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = original;
  }
});

it("fails typed after a final result when process inventory cannot confirm termination", async () => {
  const original = process.env["CURSOR_API_KEY"];
  process.env["CURSOR_API_KEY"] = "cursor-test-key";
  const close = vi.fn();
  const prepare = vi.spyOn(CursorProcessTree, "prepare").mockResolvedValue({
    marker: "cursor-test-marker",
    start: vi.fn(async () => {}),
    scanWhileRunnerStopped: vi.fn(async () => {}),
    signalDescendants: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    confirm: vi.fn(async () => {
      throw new Error("hidden child");
    }),
    close,
  } as unknown as CursorProcessTree);
  const base = fakeRuntime([
    `${JSON.stringify({ type: "agent", agentId: "agent-fixture" })}\n`,
    `${JSON.stringify({ type: "result", status: "finished", result: "done" })}\n`,
  ]);
  const runtime = {
    ...base,
    placement: "local" as const,
    async spawn(spec: Parameters<HarnessRuntime["spawn"]>[0]) {
      return { ...(await base.spawn(spec)), pid: 900001 };
    },
  } as HarnessRuntime;
  const events: string[] = [];
  try {
    const failure = await (async () => {
      for await (const event of runCursor(request, runtime)) events.push(event.type);
    })().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExecutionCleanupError);
    expect(failure.message).toContain("could not be confirmed");
    expect(events).toContain("output.message");
    expect(close).toHaveBeenCalledOnce();
  } finally {
    prepare.mockRestore();
    if (original === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = original;
  }
});
