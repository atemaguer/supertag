import { describe, expect, it } from "vitest";
import { parseTaskExecutionRequirements } from "./task-execution.js";

describe("Task execution limits", () => {
  it("accepts bounded provider-neutral Harness controls", () => {
    expect(
      parseTaskExecutionRequirements({
        harness: "codex",
        limits: {
          maxNativeAgents: 0,
          maxReportedTokens: 12_000,
          maxReportedCost: { amountMinor: 250, currency: "USD" },
        },
      }),
    ).toEqual({
      harness: "codex",
      limits: {
        maxNativeAgents: 0,
        maxReportedTokens: 12_000,
        maxReportedCost: { amountMinor: 250, currency: "USD" },
      },
    });
  });

  it.each([
    { limits: {} },
    { limits: { maxNativeAgents: -1 } },
    { limits: { maxNativeAgents: 1.5 } },
    { limits: { maxReportedTokens: 0 } },
    { limits: { maxReportedCost: { amountMinor: -1, currency: "USD" } } },
    { limits: { maxReportedCost: { amountMinor: 1.5, currency: "USD" } } },
    { limits: { maxReportedCost: { amountMinor: 1, currency: "usd" } } },
    { limits: { maxReportedCost: { amountMinor: 1, currency: "USD", amount: 1 } } },
    { limits: { maxCostUsd: 100 } },
    { limits: { providerLimit: 1 } },
  ])("rejects invalid execution limit %#", (requirements) => {
    expect(() => parseTaskExecutionRequirements(requirements)).toThrow();
  });
});

describe("Task output policy", () => {
  it("freezes portable defaults at acceptance without opting other Tasks in", () => {
    expect(parseTaskExecutionRequirements({})).toEqual({});
    expect(parseTaskExecutionRequirements({ outputs: {} }).outputs).toEqual({
      directory: "outputs",
      required: [],
      include: ["outputs/**"],
      exclude: [],
      git: "reference",
      maxFiles: 100,
      maxBytes: 67_108_864,
    });
    expect(
      parseTaskExecutionRequirements({
        outputs: { directory: "reports", required: ["report.md"], git: "capture" },
      }).outputs,
    ).toMatchObject({ include: ["reports/**"], required: ["report.md"], git: "capture" });
  });
  it.each([
    null,
    [],
    { directory: "/tmp/out" },
    { directory: null },
    { include: null },
    { directory: "../out" },
    { directory: "a/../b" },
    { directory: "a\\b" },
    { directory: "a\u0000b" },
    { directory: "C:/a" },
    { directory: "." },
    { directory: "a/" },
    { directory: "a/*" },
    { include: ["!outputs/**"] },
    { include: ["{a,b}"] },
    { include: "outputs/**" },
    { required: ["../secret"] },
    { git: "push" },
    { maxFiles: 101 },
    { maxFiles: 0 },
    { maxBytes: 67_108_865 },
    { maxBytes: 1.5 },
    { maxBytes: true },
    { upload: true },
  ])("rejects unsafe or unsupported output policy %#", (outputs) => {
    expect(() => parseTaskExecutionRequirements({ outputs })).toThrow();
  });
});

describe("Task execution requirements", () => {
  it("rejects invalid requirements instead of treating them as unconstrained", () => {
    expect(parseTaskExecutionRequirements({})).toEqual({});
    for (const value of [
      undefined,
      { workerProfile: { id: "old", revision: "1" } },
      { requires: [{ id: "shell", version: 0 }] },
      { harness: 3 },
      { profile: { id: "", revision: "1" } },
    ])
      expect(() => parseTaskExecutionRequirements(value)).toThrow();
  });
});
