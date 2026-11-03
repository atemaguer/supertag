import { expect, it } from "vitest";
import {
  explainDescriptorExecutionIncompatibility,
  type WorkerDescriptor,
} from "../packages/runtime/sdk/src/index.js";

const emptyContext = { version: 1 as const, sets: [] };

it("explains unsupported Harness limits without confusing them with capacity", () => {
  const profile = { id: "codex-engineer", revision: "1" };
  const worker: WorkerDescriptor = {
    id: "codex",
    type: "codex",
    profiles: [profile],
    capabilities: [{ id: "supertag.coordination", version: 1 }],
    contextTypes: [],
    profileCapabilities: [
      {
        profile,
        harness: "codex",
        capabilities: [{ id: "supertag.coordination", version: 1 }],
        contextTypes: [],
      },
    ],
    maxConcurrency: 0,
  };

  expect(
    explainDescriptorExecutionIncompatibility(
      [worker],
      { profile, limits: { maxNativeAgents: 1 } },
      emptyContext,
      { requiresCoordination: true },
    ),
  ).toEqual({
    version: 1,
    status: "incompatible",
    unmetRequirements: ["execution.limits.maxNativeAgents"],
    candidates: [
      {
        workerId: "codex",
        profile,
        unmetRequirements: ["execution.limits.maxNativeAgents"],
      },
    ],
  });

  expect(
    explainDescriptorExecutionIncompatibility([worker], { profile }, emptyContext, {
      requiresCoordination: true,
    }),
  ).toBeUndefined();
});

it("leaves an exact but disconnected profile waiting for discovery", () => {
  const worker: WorkerDescriptor = {
    profileCapabilities: [
      {
        profile: { id: "claude-reviewer", revision: "1" },
        capabilities: [{ id: "supertag.coordination", version: 1 }],
        contextTypes: [],
      },
    ],
    id: "claude",
    type: "claude",
    profiles: [{ id: "claude-reviewer", revision: "1" }],
    capabilities: [{ id: "supertag.coordination", version: 1 }],
    contextTypes: [],
  };
  expect(
    explainDescriptorExecutionIncompatibility(
      [worker],
      { profile: { id: "codex-engineer", revision: "1" } },
      emptyContext,
      { requiresCoordination: true },
    ),
  ).toBeUndefined();
});
