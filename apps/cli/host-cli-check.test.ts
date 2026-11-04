import { expect, it } from "vitest";
import { checkHostCliTools } from "./src/host-service.js";

it("refuses to start a host whose Claude Code or Codex CLI can't run Tasks, naming each", async () => {
  const checked: string[] = [];
  await expect(
    checkHostCliTools(
      { name: "laptop", harnesses: ["claude-code", "codex", "cursor", "opencode"] },
      async (harness) => {
        checked.push(harness);
        return harness === "codex" ? "Codex 0.1.0 is older than 0.156.0." : undefined;
      },
    ),
  ).rejects.toThrow(
    "Host service laptop can't run its harnesses:\n  Codex 0.1.0 is older than 0.156.0.\nInstall or upgrade them",
  );
  // Cursor and OpenCode have no installed CLI to check.
  expect(checked).toEqual(["claude-code", "codex"]);
  await expect(
    checkHostCliTools({ name: "laptop", harnesses: ["codex"] }, async () => undefined),
  ).resolves.toBeUndefined();
});
