import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { checkInstalledCli, type InstalledCliCheck } from "@supertag/worker-sdk/installed-cli";
import type { WorkletHarness } from "./worker.js";

export const HARNESSES: readonly WorkletHarness[] = ["claude-code", "codex", "cursor", "opencode"];

/** Optional PATH command associated with each harness. */
export const HARNESS_COMMANDS: Readonly<Record<WorkletHarness, string>> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor-agent",
  opencode: "opencode",
};

export function isHarness(value: unknown): value is WorkletHarness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/** Available harnesses in stable order; Cursor also accepts CURSOR_API_KEY. */
export async function detectHarnesses(
  path: string | undefined = process.env["PATH"],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly WorkletHarness[]> {
  return (await inspectHarnesses(path, environment)).found;
}

/**
 * Usable harnesses, plus why an installed one can't be used. Claude Code and Codex run the user's
 * own CLI, so each must be installed and at least the version SuperTag's SDK targets.
 */
export async function inspectHarnesses(
  path: string | undefined = process.env["PATH"],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ readonly found: readonly WorkletHarness[]; readonly problems: readonly string[] }> {
  const found: WorkletHarness[] = [];
  const problems: string[] = [];
  for (const harness of HARNESSES) {
    if (harness === "cursor") {
      if (
        environment["CURSOR_API_KEY"]?.trim() ||
        (await isOnPath("cursor-agent", path)) ||
        (await isCursorAgentAlias(path))
      )
        found.push(harness);
    } else if (harness === "claude-code" || harness === "codex") {
      const check = await checkHarnessCli(harness, { path, environment });
      if (check.status === "ok") found.push(harness);
      else if (check.status !== "missing") problems.push(check.message);
    } else if (await isOnPath(HARNESS_COMMANDS[harness], path)) found.push(harness);
  }
  return { found, problems };
}

/** Checks the installed CLI a harness runs: present on PATH and new enough. */
export async function checkHarnessCli(
  harness: "claude-code" | "codex",
  options: Parameters<typeof checkInstalledCli>[1] = {},
): Promise<InstalledCliCheck> {
  if (harness === "codex") {
    const { codexCliRequirement } = await import("@supertag/worker-codex");
    return checkInstalledCli(await codexCliRequirement(), options);
  }
  const { claudeCodeCliRequirement } = await import("@supertag/worker-claude-code");
  return checkInstalledCli(await claudeCodeCliRequirement(), options);
}

/** Exact local Worker credential lookup, shared with Task Attempt error translation. */
export function harnessSignInInstructions(harness: WorkletHarness): string {
  if (harness === "claude-code")
    return "Claude Code: run claude and use /login, or set ANTHROPIC_API_KEY in the host's env_file (default ~/.supertag/.env). A background host also inherits it from the shell; a service unit does not. The bundled Claude Agent SDK reads the secure sign-in store selected by CLAUDE_SECURESTORAGE_CONFIG_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude (macOS Keychain on macOS; .credentials.json on Linux). Task sessions and settings stay in a separate temporary directory.";
  if (harness === "codex")
    return `Codex: run codex -c 'cli_auth_credentials_store="file"' login, or set CODEX_API_KEY or OPENAI_API_KEY in the host's env_file (default ~/.supertag/.env). On macOS, a Keychain-only login is not copied to Task Attempts. A background host also inherits environment credentials from the shell; a service unit does not. The bundled Codex SDK reads CODEX_API_KEY first, then copies $CODEX_HOME/auth.json (default ~/.codex/auth.json), then falls back to OPENAI_API_KEY if that file cannot be read. The file-backed init check only verifies credential structure; it cannot verify account access without rotating a refresh token.`;
  if (harness === "cursor")
    return "Cursor: generate an API key at https://cursor.com/dashboard/api and set CURSOR_API_KEY in the host's env_file (default ~/.supertag/.env). The Cursor app and cursor-agent logins do not authenticate the bundled SDK runner.";
  return "OpenCode: set the API key for the selected provider/model in the Worker Host environment (for example OPENAI_API_KEY for openai, or ANTHROPIC_API_KEY for anthropic). Tasks use an isolated OpenCode home and do not read your usual OpenCode auth.json.";
}

/** Verify a model turn through the same bundled runtimes used by local Workers. */
export async function probeHarnessSignIn(
  harness: WorkletHarness,
  model?: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  const options = { environment, ...(model === undefined ? {} : { model }) };
  if (harness === "claude-code") {
    const { checkClaudeCodeSignIn } = await import("@supertag/worker-claude-code");
    return checkClaudeCodeSignIn(options);
  }
  if (harness === "codex") {
    const { checkCodexSignIn } = await import("@supertag/worker-codex");
    return checkCodexSignIn(options);
  }
  if (harness === "cursor") {
    const { checkCursorSignIn } = await import("./cursor-sign-in.js");
    const { checkCursorModels } = await import("@supertag/worker-cursor");
    const result = await checkCursorSignIn({
      environment,
      verifyModels: async (apiKey) => {
        const check = await checkCursorModels(
          model === undefined ? [] : [model],
          apiKey === undefined ? {} : { apiKey },
        );
        return check.status === "ok"
          ? { status: "ok" as const, models: check.availableIds }
          : { status: "error" as const };
      },
    });
    return result.signedIn;
  }
  const { checkOpenCodeSignIn } = await import("./opencode-sign-in.js");
  return model === undefined ? false : checkOpenCodeSignIn(model, environment);
}

async function isOnPath(command: string, path: string | undefined): Promise<boolean> {
  const extensions =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const directory of (path ?? "").split(delimiter).filter(Boolean))
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      const stats = await stat(candidate).catch(() => undefined);
      if (stats === undefined || stats.isDirectory()) continue;
      if (
        await access(candidate, constants.X_OK).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
  return false;
}

const execFileAsync = promisify(execFile);

async function isCursorAgentAlias(path: string | undefined): Promise<boolean> {
  if (!(await isOnPath("agent", path))) return false;
  const options = {
    env: { PATH: path },
    timeout: 5_000,
    killSignal: "SIGKILL" as const,
    maxBuffer: 64 * 1024,
  };
  const cursorName = (value: unknown): boolean =>
    typeof value === "string" && /^cursor(?:[- ]agent)?\b/i.test(value.trim());
  const about = await execFileAsync("agent", ["about", "--format", "json"], options).catch(
    () => undefined,
  );
  if (about) {
    try {
      const parsed: unknown = JSON.parse(about.stdout);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        ["name", "product", "application", "cli"].some((field) =>
          cursorName((parsed as Record<string, unknown>)[field]),
        )
      )
        return true;
    } catch {
      // Some Cursor versions only identify themselves in --version.
    }
  }
  const version = await execFileAsync("agent", ["--version"], options).catch(() => undefined);
  return version !== undefined && cursorName(version.stdout);
}

const SIGN_IN_DOCS =
  "https://github.com/atemaguer/supertag/blob/main/docs/operations/requirements.md#choose-and-sign-in-to-a-harness";

/** The message shown when no harness is available. */
export function noHarnessMessage(): string {
  return `No harness is available on this machine. SuperTag runs Tasks through Claude Code, Codex, Cursor, or OpenCode.
Install one and sign in:
  Claude Code  npm install -g @anthropic-ai/claude-code, then run claude to sign in
  Codex        npm install -g @openai/codex, then codex -c 'cli_auth_credentials_store="file"' login
  Cursor       Add CURSOR_API_KEY to ~/.supertag/.env, using a key from https://cursor.com/dashboard/api
  OpenCode     npm install -g opencode-ai, then set your provider's API key
Sign-in details: ${SIGN_IN_DOCS}
SuperTag looks for claude, codex, and opencode on PATH, and for Cursor through CURSOR_API_KEY or cursor-agent.`;
}
