import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ExecutionUsage } from "@supertag/worker-sdk";

// Per invocation, never seeded from a resumed Session's historical transcript.
// Assistant messages may repeat as their content grows; replace counters per API message.
export function claudeUsageTracker(): (message: SDKMessage) => ExecutionUsage | undefined {
  const messages = new Map<string, ExecutionUsage>();
  return (message) => {
    if (message.type === "assistant") {
      const raw = message.message.usage;
      const id = message.message.id;
      if (!id || !raw) return undefined;
      const next = counters(raw as unknown as Record<string, unknown>);
      const previous = messages.get(id);
      if (previous) {
        next.inputTokens = Math.max(previous.inputTokens, next.inputTokens);
        next.outputTokens = Math.max(previous.outputTokens, next.outputTokens);
        next.cachedInputTokens = Math.max(previous.cachedInputTokens ?? 0, next.cachedInputTokens);
        next.totalTokens = checkedTotal(next);
      }
      messages.set(id, { ...next, complete: false });
      return total(messages.values());
    }
    if (message.type !== "result") return undefined;
    const raw = (message as unknown as { usage?: Record<string, unknown> }).usage;
    const cost = message.total_cost_usd;
    if (raw === undefined && typeof cost !== "number") return undefined;
    const usage = raw === undefined ? total(messages.values()) : counters(raw);
    const complete =
      raw !== undefined &&
      [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
      ].every((key) => raw[key] !== undefined);
    if (typeof cost !== "number") return { ...usage, complete };
    const amountMinor = Math.round(cost * 100);
    if (!Number.isFinite(cost) || cost < 0 || !Number.isSafeInteger(amountMinor))
      throw new Error("Claude Code reported an invalid USD cost");
    return { ...usage, complete, reportedCost: { amountMinor, currency: "USD" } };
  };
}

function counter(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error("Claude Code reported invalid token usage");
  return Number(value);
}
function counters(raw: Record<string, unknown>) {
  const inputTokens = counter(raw["input_tokens"]) + counter(raw["cache_creation_input_tokens"]);
  const outputTokens = counter(raw["output_tokens"]);
  const cachedInputTokens = counter(raw["cache_read_input_tokens"]);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens: checkedTotal({ inputTokens, outputTokens, cachedInputTokens }),
  };
}
function checkedTotal(value: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}) {
  const sum = value.inputTokens + value.outputTokens + value.cachedInputTokens;
  if (!Number.isSafeInteger(sum)) throw new Error("Claude Code reported unsafe token usage");
  return sum;
}
function total(values: Iterable<ExecutionUsage>): ExecutionUsage {
  const sum = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  for (const value of values) {
    sum.inputTokens += value.inputTokens;
    sum.outputTokens += value.outputTokens;
    sum.cachedInputTokens += value.cachedInputTokens ?? 0;
  }
  return { ...sum, totalTokens: checkedTotal(sum), complete: false };
}
