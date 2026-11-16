import { expect, it } from "vitest";
import { claudeToolActivity } from "./src/activity.js";

it("says what a tool call does in one line from its input", () => {
  expect(claudeToolActivity({ name: "Bash", input: { command: "pnpm test\nnext" } })).toBe(
    "Running pnpm test…",
  );
  expect(claudeToolActivity({ name: "Read", input: { file_path: "src/app.ts" } })).toBe(
    "Reading src/app.ts",
  );
  expect(claudeToolActivity({ name: "Edit", input: { file_path: "src/app.ts" } })).toBe(
    "Editing src/app.ts",
  );
  expect(claudeToolActivity({ name: "Grep", input: { pattern: "TODO" } })).toBe(
    "Searching for TODO",
  );
  expect(claudeToolActivity({ name: "mcp__supertag__start_work", input: {} })).toBe(
    "Using supertag start_work",
  );
  expect(claudeToolActivity({ name: "Bash", input: null })).toBe("Running");
  expect([
    ...claudeToolActivity({ name: "Bash", input: { command: "x".repeat(500) } }),
  ]).toHaveLength(160);
});

it("hides a secret before cutting the line, so no part of it shows", () => {
  const secret = "sk-live-0123456789abcdef0123456789";
  const line = claudeToolActivity(
    { name: "Bash", input: { command: `${"x".repeat(140)} --token ${secret}` } },
    (text) => text.replaceAll(secret, "[REDACTED]"),
  );
  expect(line).not.toContain("sk-live");
});
