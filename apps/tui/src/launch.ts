/**
 * How `supertag-tui` was asked to start: its arguments and the environment it reads. See the
 * entry contract in apps/tui/README.md; the CLI's launcher and the release smoke depend on it.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export interface Launch {
  /** `--gateway`: `local`, a Gateway URL, or the name of a saved Gateway. */
  gateway?: string;
  /** `--state-directory`: the local services' state directory, for Local. */
  stateDirectory?: string;
}

export type Parsed =
  | { kind: "version" }
  | { kind: "headless-check" }
  | { kind: "help" }
  | { kind: "run"; launch: Launch }
  | { kind: "error"; message: string };

export const USAGE = `Usage: supertag-tui [--gateway URL|NAME|local] [--state-directory DIR]

The SuperTag terminal UI. Without --gateway it opens the Gateway used last, else the local
Gateway \`supertag up\` runs (starting it when it was set up but is stopped), else the first
saved Gateway, else the Gateway chooser.

  --gateway URL|NAME|local  A Gateway URL (its token from SUPERTAG_OPERATOR_TOKEN), the name of a
                            Gateway saved with \`supertag connect\` or in the desktop app, or local
  --state-directory DIR     The local services' state directory (default: SUPERTAG_STATE_DIR,
                            else ~/.supertag)
  --version                 Print the version
  -h, --help                Print this help`;

export function parseArguments(args: readonly string[]): Parsed {
  if (args[0] === "--version" && args.length === 1) return { kind: "version" };
  if (args[0] === "--headless-check" && args.length === 1) return { kind: "headless-check" };
  const launch: Launch = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/su) : [arg];
    if (flag === "--gateway" || flag === "--state-directory") {
      const value = inline ?? args[++index];
      if (value === undefined || value.trim() === "") {
        return { kind: "error", message: `${flag} needs a value.` };
      }
      if (flag === "--gateway") launch.gateway = value.trim();
      else launch.stateDirectory = value;
      continue;
    }
    return { kind: "error", message: `Unknown argument: ${arg}` };
  }
  return { kind: "run", launch };
}

/**
 * The `supertag` CLI the terminal UI asks for the local Gateway, starts it with, and saves
 * Gateways with: `SUPERTAG_CLI`, else the one beside this executable (as the release archive
 * installs them), else `supertag` on PATH.
 */
export function cliPath(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath) {
  const named = env["SUPERTAG_CLI"];
  if (named) return named;
  const beside = path.join(path.dirname(execPath), "supertag");
  return existsSync(beside) ? beside : "supertag";
}

/** Which notifications the terminal UI writes: `SUPERTAG_TUI_NOTIFY`, `all` by default. */
export type NotifyLevel = "all" | "questions" | "bell" | "off";

export function notifyLevel(env: NodeJS.ProcessEnv = process.env): NotifyLevel {
  const value = env["SUPERTAG_TUI_NOTIFY"];
  return value === "questions" || value === "bell" || value === "off" ? value : "all";
}
