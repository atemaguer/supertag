import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessSignInInstructions } from "./src/harnesses.js";
import { checkOpenCodeSignIn } from "./src/opencode-sign-in.js";

vi.mock("node:child_process", async (original) => {
  const { promisify } = await import("node:util");
  const mock = vi.fn();
  Object.defineProperty(mock, promisify.custom, {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        mock(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
  });
  return { ...(await original<typeof import("node:child_process")>()), execFile: mock };
});
afterEach(() => vi.resetAllMocks());

describe("OpenCode sign-in check", () => {
  it("uses only the selected provider key in an isolated home and removes it", async () => {
    let home = "";
    vi.mocked(execFile).mockImplementation(((_command, _args, options, callback) => {
      home = options.env.HOME;
      expect(options.env).not.toHaveProperty("UNRELATED_SECRET");
      expect(options.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
      expect(JSON.parse(options.env.OPENCODE_PERMISSION)).toEqual({ "*": "deny" });
      void readFile(join(home, "opencode", "auth.json"), "utf8").then((value) => {
        expect(JSON.parse(value)).toEqual({ openai: { type: "api", key: "test-secret" } });
        callback(
          null,
          '{"type":"text","part":{"text":"OK"}}\n{"type":"step_finish","part":{"reason":"stop"}}',
          "",
        );
      });
    }) as typeof execFile);
    await expect(
      checkOpenCodeSignIn("openai/model", {
        OPENAI_API_KEY: "test-secret",
        UNRELATED_SECRET: "never-pass",
      }),
    ).resolves.toBe(true);
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not treat a successful process exit alone as sign-in", async () => {
    vi.mocked(execFile).mockImplementation(((_command, _args, _options, callback) => {
      callback(null, "", "credential test-secret");
    }) as typeof execFile);
    await expect(checkOpenCodeSignIn("openai/model", {})).resolves.toBe(false);
  });
});

it("shares exact sign-in commands and source locations without environment values", () => {
  expect(harnessSignInInstructions("claude-code")).toMatch(
    /run claude and use \/login.*ANTHROPIC_API_KEY.*CLAUDE_SECURESTORAGE_CONFIG_DIR.*CLAUDE_CONFIG_DIR.*~\/.claude.*Keychain.*.credentials.json/,
  );
  expect(harnessSignInInstructions("codex")).toMatch(
    /codex -c 'cli_auth_credentials_store="file"' login.*CODEX_API_KEY.*OPENAI_API_KEY.*Keychain-only login is not copied.*\$CODEX_HOME\/auth.json.*~\/.codex\/auth.json/,
  );
});
