import { describe, expect, it } from "vitest";
import { DEFAULT_ATTEMPT_TIMEOUT_MS, parseWorkletModels } from "../apps/cli/src/worker.ts";

describe("connect worklet --model", () => {
  it("accepts repeated MODEL and HARNESS=MODEL values, the first being the default", () => {
    expect(parseWorkletModels(["gpt-6-sol", "codex=gpt-6-max", "gpt-6-sol"], "codex")).toEqual([
      "gpt-6-sol",
      "gpt-6-max",
    ]);
    expect(parseWorkletModels(["cursor=composer-2.5"], "cursor")).toEqual(["composer-2.5"]);
    expect(parseWorkletModels(["opencode=anthropic/claude-sonnet-5-5"], "opencode")).toEqual([
      "anthropic/claude-sonnet-5-5",
    ]);
    expect(parseWorkletModels([], "claude-code")).toEqual([]);
  });

  it("refuses a model for another harness or an empty name", () => {
    expect(() => parseWorkletModels(["claude-code=claude-opus-5-5"], "codex")).toThrow(
      "names harness claude-code, but this Worklet runs codex",
    );
    expect(() => parseWorkletModels(["codex="], "codex")).toThrow("--model must name a model");
  });

  it("gives each Task Attempt 60 minutes by default", () => {
    expect(DEFAULT_ATTEMPT_TIMEOUT_MS).toBe(60 * 60_000);
  });
});
