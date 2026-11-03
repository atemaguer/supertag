import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("requires explicit opt-in before creating local resources or using subscription auth", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--conditions=development", "scripts/cli-operator-live.ts"],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Pass --live to use local subscription credentials");
  expect(result.stdout).toBe("");
});
it("rejects an unsupported provider before creating local resources", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions=development",
      "scripts/cli-operator-live.ts",
      "--live",
      "--provider",
      "other",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--provider must be codex or claude-code");
  expect(result.stdout).toBe("");
});
