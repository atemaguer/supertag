/**
 * First launch: setting SuperTag up from the app, with no terminal. A port of the Tauri app's
 * `onboarding.rs`. The app checks a project folder and the harnesses with
 * `supertag init --check --json`, which also says whether Claude Code and Codex are installed and
 * signed in and how to install them (the app bundles neither), then runs `supertag init --yes`.
 * The CLI does all the work, so the app never repeats init's logic.
 */
import { jsonOf, reason, result, run } from "./run";

/** How long the checks may take: a harness sign-in check runs one short turn. */
const CHECK_TIMEOUT_MS = 120_000;
/** How long init may take: it writes the configuration and starts the services. */
const SETUP_TIMEOUT_MS = 600_000;

/** `supertag init --check --json` for `directory` and, when given, only `harness`. */
export async function checkWith(
  cli: string,
  searchPath: string | undefined,
  install: string,
  directory: string | undefined,
  harness: string | undefined,
): Promise<Record<string, unknown>> {
  const args = ["init", "--check", "--json"];
  if (directory !== undefined) args.push("--directory", directory);
  if (harness !== undefined) args.push("--harness", harness);
  const ran = await run(cli, args, { path: searchPath, timeoutMs: CHECK_TIMEOUT_MS });
  // A CLI older than the app has no check: say to update it, as for one that is missing.
  if (!ran.success && ran.stderr.includes("unexpected argument")) {
    return { cli: null, outdated: cli, install };
  }
  const value = jsonOf(ran.stdout);
  if (value === undefined) {
    throw ran.success
      ? "This version of the supertag CLI can't check a setup for the app. Update it, then try again."
      : reason(ran);
  }
  return { ...value, cli };
}

/** Sets SuperTag up for the project in `directory` with `harness`, and starts it. */
export async function setUpWith(
  cli: string,
  searchPath: string | undefined,
  directory: string,
  harness: string,
): Promise<Record<string, unknown> | null> {
  const ran = await run(
    cli,
    ["init", "--yes", "--json", "--harness", harness, "--directory", directory],
    { path: searchPath, cwd: directory, timeoutMs: SETUP_TIMEOUT_MS },
  );
  return result(ran);
}
