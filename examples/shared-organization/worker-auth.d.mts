export function stageWorkerAuth(
  options: {
    name: "claude" | "codex";
    homeDirectory: string;
    sourceFile?: string;
  },
  dependencies?: Record<string, unknown>,
): Promise<{
  provider: "claude-code" | "codex";
  source: "file" | "keychain" | "staged";
  path: string;
}>;
