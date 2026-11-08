import { describe, expect, it } from "vitest";
import {
  assertExecutionInRange,
  defaultExecution,
  ExecutionRangeError,
  executionRange,
  parseExecutionSettings,
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

describe("Task execution model and effort", () => {
  it("parses model and effort with the other requirements", () => {
    expect(
      parseTaskExecutionRequirements({ harness: "codex", model: " gpt-6-sol ", effort: "high" }),
    ).toEqual({ harness: "codex", model: "gpt-6-sol", effort: "high" });
    expect(() => parseTaskExecutionRequirements({ effort: "max" })).toThrow("low, medium, high");
    expect(() => parseTaskExecutionRequirements({ model: "" })).toThrow("model name");
  });
});
