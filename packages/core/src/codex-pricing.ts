/**
 * USD per million tokens, Standard processing at short-context rates, from
 * https://developers.openai.com/api/docs/pricing (checked 2026-10-07). Usage arrives per Task
 * Attempt rather than per request, so long-context (over 272K input tokens) and cache-write
 * surcharges aren't applied; estimates can run low for those requests. Update this table when
 * Codex model pricing changes.
 */
const PRICES: Readonly<Record<string, { input: number; cached: number; output: number }>> = {
  "gpt-5": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5.1": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5.2": { input: 1.75, cached: 0.175, output: 14 },
  "gpt-5.3-codex": { input: 1.75, cached: 0.175, output: 14 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-6-astra": { input: 10, cached: 1, output: 50 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "gpt-6-sol": { input: 2, cached: 0.2, output: 10 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
};

/** Codex's default when no model is selected in a launch request. */
export const DEFAULT_CODEX_MODEL = "gpt-5.4";

export function reportedCodexModel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function estimatedCodexCost(
  model: string | undefined,
  usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  },
): { amountMinor: number; currency: "USD"; estimated: true } | undefined {
  const name = model ?? DEFAULT_CODEX_MODEL;
  const price = Object.hasOwn(PRICES, name) ? PRICES[name] : undefined;
  if (!price) return undefined;
  const amountMinor = Math.ceil(
    ((usage.inputTokens - usage.cachedInputTokens) * price.input +
      usage.cachedInputTokens * price.cached +
      usage.outputTokens * price.output) /
      10_000,
  );
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return undefined;
  return { amountMinor, currency: "USD", estimated: true };
}

/** Usage fields for an estimate, or the safely printable model name that has no price. */
export function codexCostFields(
  model: string | undefined,
  usage: Parameters<typeof estimatedCodexCost>[1],
):
  | { reportedCost: NonNullable<ReturnType<typeof estimatedCodexCost>> }
  | { unpricedModel: string }
  | Record<string, never> {
  const name = model ?? DEFAULT_CODEX_MODEL;
  const reportedCost = estimatedCodexCost(name, usage);
  if (reportedCost) return { reportedCost };
  // A priced model whose estimate failed (for example, overflow) is not an unpriced model.
  if (Object.hasOwn(PRICES, name)) return {};
  return /^[\w.:/-]{1,200}$/u.test(name) ? { unpricedModel: name } : {};
}
