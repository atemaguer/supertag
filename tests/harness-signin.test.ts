import { describe, expect, it } from "vitest";
import {
  explainHarnessSignIn,
  harnessSignInFailure,
} from "../packages/control-plane/src/harness-signin.js";

describe("harness sign-in diagnostics", () => {
  it.each([
    ["Invalid API key · Please run /login", undefined, "claude-code"],
    ["Not logged in. Please run codex login", undefined, "codex"],
    ["Your authentication token has expired", "codex", "codex"],
    ["Authentication required", "claude-code", "claude-code"],
    ["Incorrect API key provided", "codex", "codex"],
    ["Authentication required", undefined, undefined],
    ["MCP server login required", "codex", undefined],
    ["Authorization policy denied", "codex", undefined],
    ["Connection timed out", "claude-code", undefined],
    ["Unexpected status 401 Unauthorized", "codex", "codex"],
    ["Missing bearer or basic authentication in header", "codex", "codex"],
    ["Please run /login", "codex", undefined],
    [
      "Codex SDK requires OPENAI_API_KEY, CODEX_API_KEY, or a file-backed Codex sign-in",
      "codex",
      "codex",
    ],
    ["MCP server: Authentication failed", "codex", undefined],
    ["fatal: Authentication failed for git remote", "codex", undefined],
  ])("classifies %s with harness %s", (error, harness, expected) => {
    expect(harnessSignInFailure(error, harness, "harness")).toBe(expected);
  });

  it.each([undefined, "workspace-setup", "workspace-integrity", "mcp"])(
    "does not classify errors without provider provenance (%s)",
    (source) => {
      for (const message of [
        "Authentication failed",
        "Please run /login",
        "Please run codex login",
      ]) {
        expect(harnessSignInFailure(message, "codex", source)).toBeUndefined();
        expect(explainHarnessSignIn(message, "codex", source)).toBe(message);
      }
    },
  );

  it("names the credential locations without changing unknown errors", () => {
    expect(explainHarnessSignIn("A network failure")).toBe("A network failure");
    const claude = explainHarnessSignIn("Please run /login", "claude-code", "harness");
    expect(claude).toContain("run `claude` and use /login");
    for (const location of [
      "ANTHROPIC_API_KEY",
      "macOS Keychain",
      "~/.claude",
      ".credentials.json",
    ])
      expect(claude).toContain(location);
    const codex = explainHarnessSignIn(
      "Codex SDK requires OPENAI_API_KEY, CODEX_API_KEY, or a file-backed Codex sign-in",
      "codex",
      "harness",
    );
    for (const location of [
      "`codex login`",
      "CODEX_HOME/auth.json",
      "~/.codex/auth.json",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
    ])
      expect(codex).toContain(location);
  });
});
