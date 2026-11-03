import { stat } from "node:fs/promises";
import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { checkClaudeCodeSignIn } from "./src/sign-in.js";

function agent(events: readonly unknown[], failure?: Error) {
  const close = vi.fn();
  const queryAgent = vi.fn((_: Parameters<typeof query>[0]) =>
    Object.assign(
      (async function* () {
        if (failure) throw failure;
        for (const event of events) yield event as SDKMessage;
      })(),
      { close },
    ),
  ) as unknown as ReturnType<typeof vi.fn<typeof query>>;
  return { queryAgent, close };
}

describe("Claude bundled SDK sign-in probe", () => {
  it("requires a successful model turn, isolates settings, and removes its temporary directory", async () => {
    const fake = agent([{ type: "result", subtype: "success", is_error: false }]);
    await expect(
      checkClaudeCodeSignIn({
        queryAgent: fake.queryAgent,
        environment: {
          HOME: "/test-home",
          CLAUDE_CONFIG_DIR: "/selected-store",
          ANTHROPIC_API_KEY: "test-secret",
          UNRELATED_SECRET: "never-pass",
        },
      }),
    ).resolves.toBe(true);
    const options = fake.queryAgent.mock.calls[0]?.[0].options;
    expect(options).toMatchObject({
      tools: [],
      skills: [],
      plugins: [],
      strictMcpConfig: true,
      settingSources: [],
      maxTurns: 1,
      persistSession: false,
      permissionMode: "dontAsk",
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/selected-store", ANTHROPIC_API_KEY: "test-secret" },
    });
    expect(options?.env).not.toHaveProperty("UNRELATED_SECRET");
    expect(options?.env?.["CLAUDE_CONFIG_DIR"]).not.toBe("/selected-store");
    expect(fake.close).toHaveBeenCalledOnce();
    await expect(stat(options?.cwd ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [{ type: "system", subtype: "init" }],
    [{ type: "result", subtype: "success", is_error: true }],
    [
      {
        type: "result",
        subtype: "error_during_execution",
        errors: ["Please run /login test-secret"],
      },
    ],
  ])("does not confuse startup or failed results with sign-in", async (...events) => {
    const fake = agent(events);
    await expect(
      checkClaudeCodeSignIn({ queryAgent: fake.queryAgent, environment: {} }),
    ).resolves.toBe(false);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("withholds native errors containing credentials", async () => {
    const fake = agent([], new Error("provider echoed test-secret"));
    await expect(
      checkClaudeCodeSignIn({ queryAgent: fake.queryAgent, environment: {} }),
    ).resolves.toBe(false);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("withholds native cleanup errors and still removes temporary state", async () => {
    const fake = agent([{ type: "result", subtype: "success", is_error: false }]);
    fake.close.mockImplementation(() => {
      throw new Error("test-secret");
    });
    await expect(
      checkClaudeCodeSignIn({ queryAgent: fake.queryAgent, environment: {} }),
    ).rejects.toThrow("Could not close the Claude Code sign-in check");
    await expect(stat(fake.queryAgent.mock.calls[0]?.[0].options?.cwd ?? "")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("aborts timed out SDK requests and closes the session", async () => {
    const close = vi.fn();
    const queryAgent = ((input: Parameters<typeof query>[0]) =>
      Object.assign(
        (async function* () {
          await new Promise<void>((resolve) =>
            input.options?.abortController?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          yield { type: "result", subtype: "success", is_error: false };
        })(),
        { close },
      )) as typeof query;
    await expect(
      checkClaudeCodeSignIn({ queryAgent, environment: {}, timeoutMs: 10 }),
    ).resolves.toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });
});
