import { expect, it } from "vitest";
import { validateSubmittedArtifacts } from "./src/artifact-selection.js";

it("ignores top-level artifacts instead of submitting the legacy result shape", () => {
  const validation = validateSubmittedArtifacts({}, {}, "task", 1, {
    artifacts: [{ artifactId: "legacy", paths: ["report.md"] }],
  });
  expect(validation.next()).toEqual({ done: true, value: [] });
});

it("validates canonical selections even when top-level artifacts are present", () => {
  const validation = validateSubmittedArtifacts({}, {}, "task", 1, {
    taskResult: { artifacts: "invalid" },
    artifacts: [],
  });
  expect(() => validation.next()).toThrow("Invalid submitted artifact selections");
});
