/** Classify only errors with recorded provider provenance, never arbitrary Task error text. */
export function harnessSignInFailure(
  error: string,
  harness?: string,
  failureKind?: string,
): "claude-code" | "codex" | undefined {
  if (failureKind !== "harness") return undefined;
  // Native turn failures can also report a failed dependency. Those credentials belong to
  // the tool or repository, even when the message was carried by the harness protocol.
  if (/\b(?:mcp|git|repository|workspace)\b/iu.test(error)) return undefined;
  if (
    harness === "codex" &&
    error.includes(
      "Codex SDK requires OPENAI_API_KEY, CODEX_API_KEY, or a file-backed Codex sign-in",
    )
  )
    return "codex";
  if (harness !== "codex" && /\b(?:please\s+)?run\s+\/login\b/iu.test(error)) return "claude-code";
  if (harness !== "claude-code" && /\bcodex\s+login\b/iu.test(error)) return "codex";
  if (
    (harness === "claude-code" || harness === "codex") &&
    /\b(?:not (?:logged|signed) in|authentication (?:failed|required)|invalid (?:api[ -]?key|authentication credentials)|incorrect api key|missing (?:api[ -]?key|authentication credentials)|token (?:has expired|expired)|401 unauthorized|refresh_token_reused|missing bearer or basic authentication)\b/iu.test(
      error,
    )
  )
    return harness;
  return undefined;
}

/** Add operator instructions without changing the recorded provider error. */
export function explainHarnessSignIn(
  error: string,
  harness?: string,
  failureKind?: string,
): string {
  const failed = harnessSignInFailure(error, harness, failureKind);
  if (failed === "claude-code")
    return `${error}\nClaude Code: run \`claude\` and use /login, or set ANTHROPIC_API_KEY in the Worker Host environment. The bundled Claude Agent SDK reads the stored login selected by CLAUDE_SECURESTORAGE_CONFIG_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude (macOS Keychain on macOS; .credentials.json on Linux).`;
  if (failed === "codex")
    return `${error}\nCodex: run \`codex login\` or set CODEX_API_KEY or OPENAI_API_KEY in the Worker Host environment. The bundled Codex SDK reads CODEX_API_KEY first, then copies $CODEX_HOME/auth.json (default ~/.codex/auth.json), then falls back to OPENAI_API_KEY if that file cannot be read. For a file-backed login, run \`codex -c 'cli_auth_credentials_store="file"' login\`; a Keychain-only login is not copied to Task Attempts.`;
  return error;
}
