import { expect, it } from "vitest";
import { cursorCostFields, estimatedCursorCost } from "./cursor-pricing.js";

const usage = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 250_000,
  cacheWriteTokens: 125_000,
  totalTokens: 1_475_000,
};

it("prices published input, cache read, cache write, and output rates", () => {
  expect(estimatedCursorCost("claude-opus-4-7", usage)).toEqual({
    amountMinor: 841,
    currency: "USD",
    estimated: true,
  });
  expect(cursorCostFields("claude-opus-4-7", usage)).toEqual({
    reportedCost: { amountMinor: 841, currency: "USD", estimated: true },
  });
});

it("prices Composer only when its unpublished cache-write rate is not needed", () => {
  const noWrite = { ...usage, cacheWriteTokens: 0, totalTokens: 1_350_000 };
  expect(estimatedCursorCost("composer-2.5", noWrite)).toEqual({
    amountMinor: 80,
    currency: "USD",
    estimated: true,
  });
  expect(cursorCostFields("composer-2.5", usage)).toEqual({
    unpricedModel: "composer-2.5",
  });
});

it("keeps automatic, unknown, and unpublished models unpriced", () => {
  for (const model of ["auto", "auto-smart", "future-model", "composer-unknown"]) {
    expect(estimatedCursorCost(model, usage)).toBeUndefined();
    expect(cursorCostFields(model, usage)).toEqual({ unpricedModel: model });
  }
});

it("never treats an omitted model as a known priced model", () => {
  expect(cursorCostFields(undefined, usage)).toEqual({});
});

it("does not echo unsafe model names", () => {
  expect(cursorCostFields("model\u001b[2J", usage)).toEqual({});
});

it("does not price invalid usage", () => {
  expect(cursorCostFields("claude-opus-4-7", { ...usage, cacheReadTokens: -1 })).toEqual({});
  expect(cursorCostFields("claude-opus-4-7", { ...usage, totalTokens: 1 })).toEqual({});
});

it("prices zero usage at zero and rounds positive estimates up to a cent", () => {
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  expect(estimatedCursorCost("composer-2.5", zero)?.amountMinor).toBe(0);
  expect(
    estimatedCursorCost("claude-opus-4-7", { ...zero, inputTokens: 1, totalTokens: 1 })
      ?.amountMinor,
  ).toBe(1);
});
