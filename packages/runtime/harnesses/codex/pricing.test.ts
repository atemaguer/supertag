import { expect, it } from "vitest";
import { codexCostFields, estimatedCodexCost } from "./src/pricing.js";

it("prices uncached, cached, and output Codex tokens with an explicit estimate", () => {
  expect(
    estimatedCodexCost("gpt-5", {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 100_000,
    }),
  ).toEqual({ amountMinor: 169, currency: "USD", estimated: true });
  expect(
    estimatedCodexCost("unknown", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }),
  ).toBeUndefined();
  expect(
    estimatedCodexCost(undefined, {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    }),
  ).toEqual({ amountMinor: 250, currency: "USD", estimated: true });
});

it("prices the published GPT-6 models at Standard short-context rates", () => {
  const usage = { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 };
  // 0.5M uncached input, 0.5M cached input, and 0.1M output, in cents.
  expect(estimatedCodexCost("gpt-6-sol", usage)).toEqual({
    amountMinor: 210,
    currency: "USD",
    estimated: true,
  });
  expect(estimatedCodexCost("gpt-6.1-sol", usage)?.amountMinor).toBe(205);
  expect(estimatedCodexCost("gpt-6-astra", usage)?.amountMinor).toBe(1050);
  expect(estimatedCodexCost("gpt-6-luna", usage)?.amountMinor).toBe(11);
});

it("leaves models without published provider prices unpriced", () => {
  const usage = { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 };
  for (const model of ["gpt-6-max", "gpt-7-preview"]) {
    expect(estimatedCodexCost(model, usage)).toBeUndefined();
    expect(codexCostFields(model, usage)).toEqual({ unpricedModel: model });
  }
});

it("names an unpriced model so spend can explain the unknown cost", () => {
  const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 };
  expect(codexCostFields("gpt-x", usage)).toEqual({ unpricedModel: "gpt-x" });
  expect(codexCostFields("gpt-5", usage)).toHaveProperty("reportedCost");
  // Unprintable provider names are dropped rather than echoed to terminals.
  expect(codexCostFields("gpt\u001b[2J", usage)).toEqual({});
});

it("does not call a priced model unpriced when its estimate fails", () => {
  const invalid = { inputTokens: 0, cachedInputTokens: 1_000_000, outputTokens: 0 };
  expect(codexCostFields("gpt-5.4", invalid)).toEqual({});
});

it("treats inherited object keys as unpriced models", () => {
  expect(
    codexCostFields("constructor", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }),
  ).toEqual({ unpricedModel: "constructor" });
});
