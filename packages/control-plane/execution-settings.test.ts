import { describe, expect, it } from "vitest";
import {
  attemptExecutionRecord,
  resolveTaskExecution,
  unsatisfiableLimits,
} from "./src/execution-settings.js";

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
  it("lets the delegator's choice win over escalation, and escalation over defaults", () => {
    const failed = {
      taskId: "t1",
      status: "failed",
      result: { error: "Tests fail" },
      execution: { harness: "codex", model: "gpt-6-sol", effort: "medium" as const },
    };
    expect(
      resolveTaskExecution({
        range,
        requested: {},
        chosen: { effort: "medium" },
        chosenByTagId: "lead",
        source: failed,
        subject: "Tag b",
      }).selection,
    ).toEqual({
      source: "chosen",
      chosenByTagId: "lead",
      harness: "codex",
      model: "gpt-6-sol",
      effort: "medium",
    });
    expect(
      resolveTaskExecution({ range, requested: {}, chosen: {}, source: failed, subject: "Tag b" }),
    ).toEqual({
      execution: { harness: "codex", model: "gpt-6-sol", effort: "high" },
      selection: {
        source: "escalated",
        harness: "codex",
        model: "gpt-6-sol",
        effort: "high",
        escalatedFromTaskId: "t1",
        escalation: "effort medium → high",
      },
    });
    const exhausted = resolveTaskExecution({
      range,
      requested: {},
      chosen: {},
      source: { ...failed, execution: { model: "gpt-6-max", effort: "high" } },
      subject: "Tag b",
    });
    expect(exhausted.selection).toMatchObject({ source: "escalated", escalationExhausted: true });
    expect(exhausted.execution).toMatchObject({ model: "gpt-6-max", effort: "high" });
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

describe("execution limits at assignment", () => {
  it("names unmet and satisfiable limits, and defers when no host is connected", () => {
    const supporting = {
      ...worker(),
      profileCapabilities: [
        {
          ...worker().profileCapabilities[0],
          capabilities: [{ id: "supertag.harness-limit.native-agents", version: 1 }],
        },
      ],
    };
    const result = unsatisfiableLimits([supporting as never], {
      limits: { maxNativeAgents: 0, maxReportedTokens: 10 },
    });
    expect(result?.unmet).toEqual(["maxReportedTokens"]);
    expect(unsatisfiableLimits([], { limits: { maxReportedTokens: 10 } })).toBeUndefined();
    expect(unsatisfiableLimits([supporting as never], {})).toBeUndefined();
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
