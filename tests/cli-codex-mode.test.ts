import { expect, it, vi } from "vitest";
import { runWorkletCommand } from "../apps/cli/src/worker.js";

it.each(["invalid", "", "app_server"])(
  "rejects unsupported Codex mode %j before credential access",
  async (mode) => {
    await expect(
      runWorkletCommand(["--worklet-url", "http://127.0.0.1:3435", "--codex-execution-mode", mode]),
    ).rejects.toThrow("--codex-execution-mode must be exec or app-server");
  },
);
it.each(["claude-code", "opencode"])("rejects Codex mode on %s", async (harness) => {
  await expect(
    runWorkletCommand([
      "--worklet-url",
      "http://127.0.0.1:3435",
      "--harness",
      harness,
      "--codex-execution-mode",
      "app-server",
    ]),
  ).rejects.toThrow("--codex-execution-mode requires --harness codex");
});
it("documents the mode before requiring credentials", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runWorkletCommand(["--help"]);
    expect(output.mock.calls.flat().join("")).toContain("--codex-execution-mode exec|app-server");
  } finally {
    output.mockRestore();
  }
});
