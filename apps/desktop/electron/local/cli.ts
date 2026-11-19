/**
 * Which `supertag` CLI the app runs, and the PATH it runs with. A port of the Tauri app's
 * `local_start::{cli, usable_cli, environment, login_path}`.
 *
 * The CLI is the copy bundled in the app's resources (`Contents/Resources/supertag/supertag` on
 * macOS, `/opt/SuperTag/resources/supertag/supertag` from the deb), else the first `supertag` on
 * the login shell's PATH, else where the installer links it. It must be this app's version. Never
 * a file beside the app's executable: macOS file systems ignore case, so
 * `Contents/MacOS/supertag` is the app itself, `SuperTag`, and running it as the CLI started the
 * app again, which ran itself again. The app's own executable never counts, whatever its name.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

/** The release this app belongs to and where it runs from; tests pass their own. */
export interface AppIdentity {
  /** The app's version, which the CLI's must equal. */
  version: string;
  /** The running executable, which is never run as the CLI. */
  execPath: string;
  /** The app's resources directory (`process.resourcesPath`); absent in development. */
  resourcesPath?: string | undefined;
  env: NodeJS.ProcessEnv;
}

/** The command that installs or updates the CLI to this app's release, not the latest one. */
export function installCommand(version: string): string {
  return `curl -fsSL https://github.com/atemaguer/supertag/releases/download/v${version}/install.sh | sh`;
}

/** The copy of the CLI bundled in the app's resources, in the release archive's layout. */
export function bundledCli(resourcesPath: string | undefined): string | undefined {
  return resourcesPath ? path.join(resourcesPath, "supertag", "supertag") : undefined;
}

/** Where the installer links `supertag`: `$XDG_BIN_HOME`, else `~/.local/bin`. */
export function installerDirectories(env: NodeJS.ProcessEnv): string[] {
  const directories: string[] = [];
  if (env["XDG_BIN_HOME"]) directories.push(env["XDG_BIN_HOME"]);
  if (env["HOME"]) directories.push(path.join(env["HOME"], ".local/bin"));
  return directories;
}

function stat(file: string) {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

/** Whether `candidate` is an executable regular file. */
function executable(candidate: string): boolean {
  const found = stat(candidate);
  return found !== undefined && found.isFile() && (found.mode & 0o111) !== 0;
}

/**
 * Whether `candidate` is the running app's executable, by file identity (device and inode),
 * whatever its name or case and through any link.
 */
export function isThisApp(candidate: string, execPath: string): boolean {
  const app = stat(execPath);
  const other = stat(candidate);
  return app !== undefined && other !== undefined && app.dev === other.dev && app.ino === other.ino;
}

/**
 * The `supertag` to run: `bundled` when usable, else the first on `searchPath`, else in
 * `installed`. Only an executable regular file at an absolute path counts, and never the app.
 */
export function selectCli(
  bundled: string | undefined,
  searchPath: string | undefined,
  installed: readonly string[],
  execPath: string,
): string | undefined {
  const usable = (candidate: string) => executable(candidate) && !isThisApp(candidate, execPath);
  if (bundled !== undefined && usable(bundled)) return bundled;
  const directories = [...(searchPath ? searchPath.split(path.delimiter) : []), ...installed];
  return directories
    .filter((directory) => path.isAbsolute(directory))
    .map((directory) => path.join(directory, "supertag"))
    .find(usable);
}

/** The version in what `supertag --version` printed (`supertag X`). */
export function parseVersion(printed: string): string | undefined {
  const trimmed = printed.trim();
  if (!trimmed.startsWith("supertag ")) return undefined;
  const version = trimmed.slice("supertag ".length).trim();
  return version !== "" && !/\s/u.test(version) ? version : undefined;
}

/** What to say when the CLI is another version than the app's, else nothing. */
export function versionMismatch(
  cliVersion: string | undefined,
  appVersion: string,
): string | undefined {
  if (cliVersion === appVersion) return undefined;
  return `This SuperTag CLI is ${cliVersion ?? "an unknown version"}, the app expects ${appVersion}. Update with: ${installCommand(appVersion)}`;
}

/** Runs `command ARGS` for its stdout, or nothing when it fails or outlasts `timeoutMs`. */
function output(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        env: env ?? process.env,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : undefined);
    });
  });
}

/** The version `cli --version` reports, or nothing when it says nothing usable in 10 seconds. */
export async function cliVersion(cli: string): Promise<string | undefined> {
  const printed = await output(cli, ["--version"], 10_000);
  return printed === undefined ? undefined : parseVersion(printed);
}

/** Marks the PATH a login shell prints, so what its startup files print around it is ignored. */
export const PATH_MARK = "__SUPERTAG_PATH__";

/** The PATH between the marks in a login shell's output. */
export function markedPath(printed: string): string | undefined {
  const start = printed.indexOf(PATH_MARK);
  if (start < 0) return undefined;
  const rest = printed.slice(start + PATH_MARK.length);
  const end = rest.indexOf(PATH_MARK);
  if (end < 0) return undefined;
  const found = rest.slice(0, end);
  return found.trim() === "" ? undefined : found;
}

/** The PATH the user's login shell sets up, or nothing when it can't be read in 5 seconds. */
export async function loginPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const shell = env["SHELL"];
  if (!shell) return undefined;
  const printed = await output(
    shell,
    ["-ilc", `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`],
    5_000,
    env,
  );
  return printed === undefined ? undefined : markedPath(printed);
}

/** The CLI the app runs and the PATH to run it and anything it starts with. */
export interface UsableCli {
  cli: string;
  /**
   * The login shell's PATH, else the app's own. The services find the coding agents (claude,
   * codex, node) on it, which an app opened from Finder lacks.
   */
  path: string | undefined;
}

/** The CLI the app would run, if any, and the PATH to run it with. */
export async function environment(
  app: AppIdentity,
): Promise<{ cli: string | undefined; path: string | undefined }> {
  const found = (await loginPath(app.env)) ?? app.env["PATH"];
  const cli = selectCli(
    bundledCli(app.resourcesPath),
    found,
    installerDirectories(app.env),
    app.execPath,
  );
  return { cli, path: found };
}

/**
 * The CLI the app runs and its PATH, or rejects with what is wrong: none is installed, or it is
 * another version than the app's. A CLI of another version may not read this state, or may
 * migrate it under the app.
 */
export async function usableCli(app: AppIdentity): Promise<UsableCli> {
  const { cli, path: found } = await environment(app);
  if (cli === undefined) {
    throw `Could not find the supertag command. Install it with: ${installCommand(app.version)}`;
  }
  const mismatch = versionMismatch(await cliVersion(cli), app.version);
  if (mismatch !== undefined) throw `${mismatch}\n(It is ${cli}.)`;
  return { cli, path: found };
}

/** The CLI the app runs, for the Gateway backend's local discovery; rejects as `usableCli`. */
export async function appCli(app: AppIdentity): Promise<string> {
  return (await usableCli(app)).cli;
}
