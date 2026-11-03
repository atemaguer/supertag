import { expect, it, vi } from "vitest";
import { runHarnessConformance } from "./src/conformance.js";
import type {
  ExecutionContext,
  ExecutionEnvironment,
  Harness,
  HarnessEvent,
  HarnessPlan,
} from "./src/index.js";

function fixture(mode: "stall" | "error" | "abort" | "close" | "iterator-cleanup") {
  let closed = 0;
  const harness: Harness = {
    id: "probe",
    describe: async () => ({
      sessions: { resume: false, export: false, scope: "none" as const },
      id: "probe",
      version: "1",
      inputKinds: [],
      streaming: true,
      cancellation: true,
      sessionPersistence: "none",
    }),
    plan: async () => ({}) as HarnessPlan,
    start: async () => ({
      run(signal) {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<HarnessEvent>> {
                if (!signal?.aborted) return { done: true, value: undefined };
                if (mode === "stall") return new Promise(() => {});
                if (mode === "error") throw new Error("Execution cleanup failed");
                throw signal.reason;
              },
              async return() {
                if (mode === "iterator-cleanup") throw new Error("iterator cleanup failed");
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
      async close() {
        closed++;
        if (mode === "close") await new Promise(() => {});
      },
    }),
  };
  return {
    harness,
    closed: () => closed,
    context: {} as ExecutionContext,
    executionEnvironment: { placement: "local" } as ExecutionEnvironment,
    verifyCancellation: true,
    cancellationTimeoutMs: 10,
  };
}

it("does not accept stalled cancellation as conformance", async () => {
  const report = await runHarnessConformance(fixture("stall"));
  expect(report.passed).toBe(false);
  expect(report.findings).toContainEqual(
    expect.objectContaining({ code: "harness.execution.threw" }),
  );
});

it("does not hide execution cleanup errors after cancellation", async () => {
  expect((await runHarnessConformance(fixture("error"))).passed).toBe(false);
});

it("accepts the explicit abort reason after cancellation", async () => {
  expect((await runHarnessConformance(fixture("abort"))).passed).toBe(true);
});

it("bounds Harness cleanup and reports the failure", async () => {
  vi.useFakeTimers();
  try {
    const options = fixture("close");
    const result = runHarnessConformance(options);
    await vi.runAllTimersAsync();
    const report = await result;
    expect(report.passed).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "harness.close.threw" }),
    );
    expect(options.closed()).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("does not hide failed iterator cleanup behind the abort reason", async () => {
  expect((await runHarnessConformance(fixture("iterator-cleanup"))).passed).toBe(false);
});
