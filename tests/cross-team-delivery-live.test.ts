import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("requires explicit opt-in before creating local resources or using subscription auth", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--conditions=development", "scripts/cross-team-delivery-live.ts"],
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
      "scripts/cross-team-delivery-live.ts",
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
it.each(["0", "-1", "1000001", "1.5", "1e5"])(
  "rejects invalid token cap %s before resources",
  (value) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--conditions=development",
        "scripts/cross-team-delivery-live.ts",
        "--live",
        "--provider",
        "codex",
        `--max-reported-tokens=${value}`,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--max-reported-tokens must be an integer");
    expect(result.stdout).toBe("");
  },
);
it("rejects Codex-only token ceilings for Claude", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions=development",
      "scripts/cross-team-delivery-live.ts",
      "--live",
      "--provider",
      "claude-code",
      "--max-reported-tokens",
      "500000",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--max-reported-tokens is only supported for codex");
  expect(result.stdout).toBe("");
});
