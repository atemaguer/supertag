import { describe, expect, it, vi } from "vitest";
import { checkHostModels, type HostModelCheck } from "../apps/cli/src/host-service.ts";
import { checkClaudeCodeModels } from "../packages/runtime/harnesses/claude-code/src/index.ts";
import { checkCodexModels } from "../packages/runtime/harnesses/codex/src/index.ts";
import { checkCursorModels } from "../packages/runtime/harnesses/cursor/src/index.ts";

describe("startup model checks", () => {
  it("fails fast with the provider's answer and notes checks it could not run", async () => {
    const check: HostModelCheck = vi.fn(async (harness, models) =>
      harness === "codex"
        ? {
            status: "failed" as const,
            message: `Codex does not offer ${models.join(", ")} for this account. Available models: gpt-6-sol.`,
          }
        : { status: "skipped" as const, note: `${harness} has no cheap check.` },
    );
    const notices: string[] = [];
    await expect(
      checkHostModels(
        {
          harnesses: ["codex", "opencode", "claude-code"],
          models: { codex: ["gpt-6.1-sol"], opencode: ["anthropic/claude-sonnet-5-5"] },
        },
        check,
        (line) => notices.push(line),
      ),
    ).rejects.toThrow(
      "Host service models are not available: Codex does not offer gpt-6.1-sol for this account. Available models: gpt-6-sol.",
    );
    expect(notices).toEqual(["opencode has no cheap check."]);
    // Harnesses without configured models are not checked.
    expect(check).toHaveBeenCalledTimes(2);
    await expect(
      checkHostModels({ harnesses: ["claude-code"], models: {} }, check, () => undefined),
    ).resolves.toBeUndefined();
  });

  it("checks Codex models against the account's model listing", async () => {
    const list = vi.fn(async () => ["gpt-6-sol", "gpt-6-max"]);
    expect(await checkCodexModels(["gpt-6-sol"], { command: "codex", list })).toEqual({
      status: "ok",
    });
    expect(await checkCodexModels(["gpt-6.1-sol"], { command: "codex", list })).toEqual({
      status: "failed",
      message:
        "Codex does not offer gpt-6.1-sol for this account. Available models: gpt-6-sol, gpt-6-max.",
    });
    const unavailable = await checkCodexModels(["gpt-6-sol"], {
      command: "codex",
      list: async () => {
        throw new Error("not logged in");
      },
    });
    expect(unavailable).toMatchObject({ status: "skipped" });
    expect(unavailable.status === "skipped" && unavailable.note).toContain("not logged in");
  });

  it("checks Cursor models against the SDK listing", async () => {
    const listModels = vi.fn(async () => [{ id: "composer-2.5" }]);
    expect(await checkCursorModels(["composer-2.5"], { listModels })).toMatchObject({
      status: "ok",
    });
    expect(await checkCursorModels(["unknown"], { listModels })).toMatchObject({
      status: "failed",
      message: expect.stringContaining("unknown"),
    });
  });

  it("checks Claude Code models against the Agent SDK listing, aliases, and variants, and only notes a miss", async () => {
    const close = vi.fn();
    const queryAgent = (() => ({
      supportedModels: async () => [
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "" },
        { value: "claude-sonnet-5-5", displayName: "Sonnet", description: "" },
        { value: "claude-fable-5-1[1m]", displayName: "Fable 1M", description: "" },
      ],
      close,
    })) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    expect(
      await checkClaudeCodeModels(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"], {
        queryAgent,
      }),
    ).toEqual({ status: "ok" });
    // Claude Code accepts more IDs than it lists, so a miss is a note, never a startup failure.
    expect(await checkClaudeCodeModels(["claude-haiku-9"], { queryAgent })).toMatchObject({
      status: "skipped",
      note: expect.stringContaining("doesn't include claude-haiku-9"),
    });
    expect(close).toHaveBeenCalledTimes(2);
    const failing = (() => {
      throw new Error("spawn failed");
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    expect(await checkClaudeCodeModels(["x"], { queryAgent: failing })).toMatchObject({
      status: "skipped",
    });
  });
});
