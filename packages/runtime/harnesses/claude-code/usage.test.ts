import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { claudeUsageTracker } from "./src/usage.js";

const assistant = (id: string, output = 3) =>
  ({
    type: "assistant",
    message: {
      id,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 5,
        output_tokens: output,
      },
    },
  }) as unknown as SDKMessage;
it("retains partial usage without a final result and deduplicates API message updates", () => {
  const track = claudeUsageTracker();
  expect(track(assistant("a"))).toMatchObject({ totalTokens: 20, complete: false });
  expect(track(assistant("a", 7))).toMatchObject({ totalTokens: 24 });
  expect(track(assistant("a", 2))).toMatchObject({ totalTokens: 24 });
  expect(track(assistant("b"))).toEqual({
    inputTokens: 24,
    outputTokens: 10,
    cachedInputTokens: 10,
    totalTokens: 44,
    complete: false,
  });
  expect(claudeUsageTracker()(assistant("a"))).toMatchObject({ totalTokens: 20 });
});
it("uses authoritative final totals even when they revise provisional usage downward", () => {
  const track = claudeUsageTracker();
  track(assistant("a", 100));
  expect(
    track({
      type: "result",
      total_cost_usd: 0.12,
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
      },
    } as unknown as SDKMessage),
  ).toEqual({
    inputTokens: 20,
    outputTokens: 8,
    cachedInputTokens: 10,
    totalTokens: 38,
    complete: true,
    reportedCost: { amountMinor: 12, currency: "USD" },
  });
});
it("does not require cost to retain tokens or label missing token fields complete", () => {
  const track = claudeUsageTracker();
  track(assistant("a"));
  expect(track({ type: "result", total_cost_usd: 0.1 } as SDKMessage)).toMatchObject({
    totalTokens: 20,
    complete: false,
  });
  expect(
    track({ type: "result", usage: { input_tokens: 5 } } as unknown as SDKMessage),
  ).toMatchObject({ totalTokens: 5, complete: false });
});
it("rejects invalid and overflowing counters", () => {
  expect(() => claudeUsageTracker()(assistant("a", -1))).toThrow("invalid token usage");
  expect(() => claudeUsageTracker()(assistant("a", Number.MAX_SAFE_INTEGER))).toThrow(
    "unsafe token usage",
  );
});
