/** Per-turn token counts reported by the Cursor SDK. */
export interface CursorTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens?: number;
}

interface CursorPrice {
  /** USD per million tokens. */
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite?: number;
  readonly output: number;
}

/**
 * Standard USD per million tokens from https://cursor.com/docs/models-and-pricing.md
 * (read 2026-10-09). The SDK identifies `composer-2.5` in
 * https://cursor.com/docs/sdk/typescript.md and `claude-opus-4-7` in
 * https://cursor.com/docs/hooks.md. A dash for cache write is an unpublished rate,
 * so that model is priced only when cacheWriteTokens is zero. These are standard
 * model rates only: callers must leave fast modes and regional billing unpriced.
 * Team plans may add Cursor's $0.25/M Cursor Token Rate for third-party models.
 * Auto and other model aliases are not inferred from display names.
 */
const PRICES: Readonly<Record<string, CursorPrice>> = {
  "composer-2.5": { input: 0.5, cacheRead: 0.2, output: 2.5 },
  "claude-opus-4-7": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
};

function validUsage(usage: CursorTokenUsage): boolean {
  const counts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.totalTokens,
  ];
  return (
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    usage.totalTokens ===
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens &&
    (usage.reasoningTokens === undefined ||
      (Number.isSafeInteger(usage.reasoningTokens) &&
        usage.reasoningTokens >= 0 &&
        usage.reasoningTokens <= usage.outputTokens))
  );
}

/** Estimate cents only when Cursor publishes every rate needed for the SDK token categories. */
export function estimatedCursorCost(
  model: string | undefined,
  usage: CursorTokenUsage,
): { amountMinor: number; currency: "USD"; estimated: true } | undefined {
  if (!model || model === "auto" || model === "auto-smart") return undefined;
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (!price || !validUsage(usage)) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  if (cacheWriteTokens > 0 && price.cacheWrite === undefined) return undefined;
  const amountMinor = Math.ceil(
    (inputTokens * price.input +
      cacheReadTokens * price.cacheRead +
      cacheWriteTokens * (price.cacheWrite ?? 0) +
      outputTokens * price.output) /
      10_000,
  );
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return undefined;
  return { amountMinor, currency: "USD", estimated: true };
}

/** Usage fields for an estimate, or the safely printable model name that has no price. */
export function cursorCostFields(
  model: string | undefined,
  usage: CursorTokenUsage,
):
  | { reportedCost: NonNullable<ReturnType<typeof estimatedCursorCost>> }
  | { unpricedModel: string }
  | Record<string, never> {
  const reportedCost = estimatedCursorCost(model, usage);
  if (reportedCost) return { reportedCost };
  if (!model) return {};
  // An unpublished cache-write rate makes even a known model unpriced for this run.
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (price && (!validUsage(usage) || price.cacheWrite !== undefined)) return {};
  return /^[\w.:/-]{1,200}$/u.test(model) ? { unpricedModel: model } : {};
}
