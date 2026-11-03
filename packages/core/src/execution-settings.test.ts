import { describe, expect, it } from "vitest";
import {
  assertExecutionInRange,
  defaultExecution,
  ExecutionRangeError,
  ExecutionUnchangedError,
  escalateExecution,
  escalatesExecution,
  executionRange,
  MAX_SELF_ESCALATIONS,
  parseExecutionSettings,
  selfEscalateExecution,
} from "./execution-settings.js";
import { parseTaskExecutionRequirements } from "./task-execution.js";

describe("execution settings", () => {
  it("accepts a single value or a list and stores lists with the default first", () => {
    expect(
      parseExecutionSettings({ harness: "Codex", model: "gpt-6-sol", effort: "medium" }),
    ).toEqual({ harness: "codex", model: ["gpt-6-sol"], effort: ["medium"] });
    expect(
      parseExecutionSettings({ model: ["gpt-6-sol", "gpt-6-mini"], effort: ["medium", "high"] }),
    ).toEqual({ model: ["gpt-6-sol", "gpt-6-mini"], effort: ["medium", "high"] });
    expect(parseExecutionSettings(undefined)).toBeUndefined();
    expect(parseExecutionSettings({})).toBeUndefined();
  });

  it("rejects unknown fields, empty or repeated lists, and unknown efforts", () => {
    expect(() => parseExecutionSettings({ models: ["x"] }, "Role spec.execution")).toThrow(
      "Role spec.execution contains unknown fields: models",
    );
    expect(() => parseExecutionSettings({ model: [] })).toThrow("must not be empty");
    expect(() => parseExecutionSettings({ model: ["a", "a"] })).toThrow("must not repeat");
    expect(() => parseExecutionSettings({ effort: "max" })).toThrow("low, medium, high");
    expect(() => parseExecutionSettings({ harness: "" })).toThrow("harness name");
    expect(() => parseExecutionSettings(["codex"])).toThrow("must be an object");
  });

  it("lets the Tag win over its Roles field by field", () => {
    const role = { harness: "codex", model: ["gpt-6-sol"], effort: ["medium", "high"] } as const;
    expect(executionRange({ effort: ["high"] }, [role])).toEqual({
      harness: "codex",
      model: ["gpt-6-sol"],
      effort: ["high"],
    });
    expect(executionRange(undefined, [role, { harness: "claude-code" }])).toEqual(role);
    expect(executionRange(undefined, [])).toEqual({ effort: ["low", "medium", "high"] });
  });

  it("drops a Role's models when the Tag runs a different harness", () => {
    expect(
      executionRange({ harness: "claude-code" }, [{ harness: "codex", model: ["gpt-6-sol"] }]),
    ).toEqual({ harness: "claude-code", effort: ["low", "medium", "high"] });
    expect(
      executionRange({ harness: "claude-code" }, [
        { harness: "codex", model: ["gpt-6-sol"] },
        { model: ["claude-opus-5-5"] },
      ]),
    ).toEqual({
      harness: "claude-code",
      model: ["claude-opus-5-5"],
      effort: ["low", "medium", "high"],
    });
  });

  it("starts at low with every effort allowed when nothing sets an effort", () => {
    const range = executionRange({ harness: "codex" }, [{ model: ["gpt-6-sol"] }]);
    expect(range.effort).toEqual(["low", "medium", "high"]);
    expect(defaultExecution(range)).toEqual({
      harness: "codex",
      model: "gpt-6-sol",
      effort: "low",
    });
    // An explicit list keeps its own first value as the default.
    expect(defaultExecution(executionRange(undefined, [{ effort: ["medium", "high"] }]))).toEqual({
      effort: "medium",
    });
    expect(escalateExecution(range, defaultExecution(range)).change).toBe("effort low → medium");
  });

  it("defaults to the first allowed model and effort", () => {
    expect(defaultExecution({ harness: "codex", model: ["a", "b"], effort: ["medium"] })).toEqual({
      harness: "codex",
      model: "a",
      effort: "medium",
    });
    expect(defaultExecution({})).toEqual({});
  });

  it("refuses a requested model or effort outside the range with the allowed values", () => {
    const range = { harness: "codex", model: ["gpt-6-sol"], effort: ["medium", "high"] } as const;
    expect(() =>
      assertExecutionInRange(range, { model: "gpt-6-sol", effort: "high" }),
    ).not.toThrow();
    expect(() => assertExecutionInRange(range, { model: "gpt-5" }, "Tag builder")).toThrow(
      new ExecutionRangeError(
        "Tag builder does not allow model gpt-5. Allowed: harness codex; model gpt-6-sol; effort medium, high.",
      ),
    );
    expect(() => assertExecutionInRange(range, { effort: "low" })).toThrow("effort low");
    expect(() => assertExecutionInRange({}, { model: "anything", effort: "low" })).not.toThrow();
  });
});

describe("escalation", () => {
  const range = {
    harness: "codex",
    model: ["gpt-6-sol", "gpt-6-max"],
    effort: ["medium", "high"],
  } as const;

  it("raises effort one step, then moves to the next model at the default effort", () => {
    const first = escalateExecution(range, {
      harness: "codex",
      model: "gpt-6-sol",
      effort: "medium",
    });
    expect(first).toEqual({
      execution: { harness: "codex", model: "gpt-6-sol", effort: "high" },
      change: "effort medium → high",
    });
    const second = escalateExecution(range, first.execution);
    expect(second).toEqual({
      execution: { harness: "codex", model: "gpt-6-max", effort: "medium" },
      change: "model gpt-6-sol → gpt-6-max",
    });
    const third = escalateExecution(range, second.execution);
    expect(third.change).toBe("effort medium → high");
    const exhausted = escalateExecution(range, third.execution);
    expect(exhausted).toEqual({ execution: third.execution });
  });

  it("goes to the highest effort when none was recorded, and stays put with one model", () => {
    expect(escalateExecution({}, {})).toEqual({
      execution: { effort: "high" },
      change: "effort default → high",
    });
    expect(escalateExecution({ model: ["only"] }, { model: "only", effort: "high" })).toEqual({
      execution: { model: "only", effort: "high" },
    });
  });

  it("escalates after rejection or a work failure, never after an infrastructure failure", () => {
    expect(escalatesExecution({ status: "rejected" })).toBe(true);
    expect(escalatesExecution({ status: "failed", result: { error: "Tests still fail" } })).toBe(
      true,
    );
    expect(escalatesExecution({ status: "accepted" })).toBe(false);
    expect(escalatesExecution({ status: "cancelled" })).toBe(false);
    for (const error of [
      "You've hit your usage limit",
      "429 Too Many Requests",
      "Not logged in. Please run /login",
      "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
      "Execution lease expired; explicit reassignment required",
      "Ephemeral Worker Host h1 was removed; explicit reassignment required",
    ])
      expect(escalatesExecution({ status: "failed", result: { error } }), error).toBe(false);
    expect(
      escalatesExecution({
        status: "failed",
        result: { error: "stopped", failureKind: "budget-exhausted" },
      }),
    ).toBe(false);
  });
});

describe("Task execution model and effort", () => {
  it("parses model and effort with the other requirements", () => {
    expect(
      parseTaskExecutionRequirements({ harness: "codex", model: " gpt-6-sol ", effort: "high" }),
    ).toEqual({ harness: "codex", model: "gpt-6-sol", effort: "high" });
    expect(() => parseTaskExecutionRequirements({ effort: "max" })).toThrow("low, medium, high");
    expect(() => parseTaskExecutionRequirements({ model: "" })).toThrow("model name");
  });
});

describe("self-escalation", () => {
  const range = {
    harness: "codex",
    model: ["gpt-6-sol", "gpt-6-max"],
    effort: ["low", "medium", "high"],
  } as const;
  const current = { harness: "codex", model: "gpt-6-sol", effort: "low" } as const;

  it("changes effort, model, or both within the range and describes the change", () => {
    expect(selfEscalateExecution(range, current, { effort: "high" })).toEqual({
      execution: { harness: "codex", model: "gpt-6-sol", effort: "high" },
      change: "effort low → high",
    });
    expect(selfEscalateExecution(range, current, { model: "gpt-6-max", effort: "medium" })).toEqual(
      {
        execution: { harness: "codex", model: "gpt-6-max", effort: "medium" },
        change: "effort low → medium, model gpt-6-sol → gpt-6-max",
      },
    );
  });

  it("refuses values outside the range, empty requests, and requests that change nothing", () => {
    expect(() =>
      selfEscalateExecution({ ...range, effort: ["low", "medium"] }, current, { effort: "high" }),
    ).toThrow(
      new ExecutionRangeError(
        "This Tag does not allow effort high. Allowed: harness codex; model gpt-6-sol, gpt-6-max; effort low, medium.",
      ),
    );
    expect(() => selfEscalateExecution(range, current, {})).toThrow(ExecutionRangeError);
    expect(() => selfEscalateExecution(range, current, { effort: "low" })).toThrow(
      new ExecutionUnchangedError(
        "Nothing would change: this Task already runs with effort low. Allowed: harness codex; model gpt-6-sol, gpt-6-max; effort low, medium, high.",
      ),
    );
    expect(MAX_SELF_ESCALATIONS).toBe(2);
  });
});
