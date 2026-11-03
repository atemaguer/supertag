import { describe, expect, it } from "vitest";
import { workspaceHarnessRequirement } from "./src/workspace-environment.ts";

describe("split workspace harness requirements", () => {
  for (const provider of ["claude-code", "cursor"]) {
    it(`does not require ${provider} in the execution sandbox`, () => {
      expect(
        workspaceHarnessRequirement({
          harness: { provider },
          runtime: { provider: "local-harness-runtime", lifetime: { scope: "attempt" } },
        }),
      ).toEqual({ commands: [] });
      expect(workspaceHarnessRequirement({ harness: { provider } })).toEqual({
        commands: [provider],
      });
    });
  }

  it("preserves Codex and OpenCode requirements", () => {
    for (const provider of ["codex", "opencode"])
      expect(
        workspaceHarnessRequirement({
          harness: { provider },
          runtime: { provider: "local-harness-runtime", lifetime: { scope: "attempt" } },
        }),
      ).toEqual({ commands: [provider] });
  });
});
