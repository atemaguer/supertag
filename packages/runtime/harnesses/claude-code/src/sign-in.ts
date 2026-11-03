import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { minimalProcessEnvironment } from "@supertag/worker-sdk";

/** A real, tool-free model turn; local credential files alone cannot prove sign-in. */
export async function checkClaudeCodeSignIn(
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly model?: string;
    readonly timeoutMs?: number;
    readonly queryAgent?: typeof query;
  } = {},
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const directory = await mkdtemp(join(tmpdir(), "supertag-claude-signin-"));
  const controller = new AbortController();
  let session: ReturnType<typeof query> | undefined;
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    session = (options.queryAgent ?? query)({
      prompt: "Reply with OK only.",
      options: {
        cwd: directory,
        abortController: controller,
        ...(options.model === undefined ? {} : { model: options.model }),
        maxTurns: 1,
        tools: [],
        skills: [],
        plugins: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: "dontAsk",
        persistSession: false,
        stderr: () => {},
        env: {
          ...minimalProcessEnvironment(environment, [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
          ]),
          CLAUDE_CONFIG_DIR: join(directory, ".claude-config"),
          CLAUDE_SECURESTORAGE_CONFIG_DIR:
            environment["CLAUDE_SECURESTORAGE_CONFIG_DIR"] ??
            environment["CLAUDE_CONFIG_DIR"] ??
            "",
        },
      },
    });
    for await (const event of session)
      if (event.type === "result")
        return event.subtype === "success" && !event.is_error && !controller.signal.aborted;
    return false;
  } catch {
    // Native errors can contain credentials. Only the boolean leaves this boundary.
    return false;
  } finally {
    clearTimeout(timeout);
    try {
      closeSession(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function closeSession(session: ReturnType<typeof query> | undefined): void {
  try {
    session?.close();
  } catch {
    throw new Error("Could not close the Claude Code sign-in check");
  }
}
