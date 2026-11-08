import { describe, expect, it } from "vitest";
import { attemptExecutionRecord, resolveTaskExecution } from "./src/execution-settings.js";

const range = {
  harness: "codex",
  model: ["gpt-6-sol", "gpt-6-max"],
  effort: ["medium", "high"],
} as const;
const profile = { id: "local-codex", revision: "1" };
const worker = (efforts?: readonly ("low" | "medium" | "high")[]) => ({
  id: "worker",
  type: "test",
  profiles: [profile],
  capabilities: [],
  contextTypes: [],
  profileCapabilities: [
    {
      profile,
      harness: "codex",
      models: ["gpt-6-sol"],
      ...(efforts === undefined ? {} : { efforts }),
      capabilities: [],
      contextTypes: [],
    },
  ],
});

describe("Task execution resolution", () => {
  it("lets the delegator's choice win over the Tag's defaults", () => {
    expect(
      resolveTaskExecution({
        range,
        requested: {},
        chosen: { effort: "high" },
        chosenByTagId: "lead",
        subject: "Tag b",
      }).selection,
    ).toEqual({
      source: "chosen",
      chosenByTagId: "lead",
      harness: "codex",
      model: "gpt-6-sol",
      effort: "high",
    });
    // Without a choice the Tag's own configuration decides; nothing escalates a failed turn.
    expect(resolveTaskExecution({ range, requested: {}, chosen: {}, subject: "Tag b" })).toEqual({
      execution: { harness: "codex", model: "gpt-6-sol", effort: "medium" },
      selection: {
        source: "default",
        harness: "codex",
        model: "gpt-6-sol",
        effort: "medium",
      },
    });
  });

  it("keeps other requirements and ignores a model the delegator did not choose", () => {
    expect(
      resolveTaskExecution({
        range: {},
        requested: { model: "inherited", limits: { maxNativeAgents: 0 } },
        chosen: {},
        subject: "Tag b",
      }).execution,
    ).toEqual({ limits: { maxNativeAgents: 0 } });
  });
});

describe("Task Attempt execution record", () => {
  it("records the host's default model and an ignored effort", () => {
    expect(attemptExecutionRecord({ effort: "high" }, worker(), profile)).toEqual({
      harness: "codex",
      model: "gpt-6-sol",
      modelSource: "host-default",
      effort: "high",
      effortIgnored: "codex has no reasoning-effort option; effort high was ignored",
    });
    expect(
      attemptExecutionRecord({ model: "gpt-6-sol", effort: "high" }, worker(["high"]), profile),
    ).toEqual({ harness: "codex", model: "gpt-6-sol", modelSource: "task", effort: "high" });
  });
});
