import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A harness CLI the user installs, such as `claude` or `codex`, and the oldest version SuperTag supports. */
export interface InstalledCliRequirement {
  /** Name shown to people, such as "Codex". */
  readonly name: string;
  /** Command looked up on PATH, such as "codex". */
  readonly command: string;
  /** Oldest supported version, as major.minor.patch. */
  readonly minimumVersion: string;
  /** How to install or upgrade it, shown when it is missing or too old. */
  readonly install: string;
}

export type InstalledCliCheck =
  | { readonly status: "ok"; readonly path: string; readonly version: string }
  | { readonly status: "missing"; readonly message: string }
  | {
      readonly status: "outdated" | "unknown-version";
      readonly path: string;
      readonly version?: string;
      readonly message: string;
    };

/** The absolute path of `command` on `path`, or undefined. An absolute command is checked as is. */
export async function findCommandOnPath(
  command: string,
  path: string | undefined = process.env["PATH"],
): Promise<string | undefined> {
  if (isAbsolute(command)) return (await isExecutableFile(command)) ? command : undefined;
  for (const directory of (path ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Finds the CLI and checks `--version` against its minimum. Never throws: a CLI that is missing,
 * too old, or reports no version is a result with a message saying what to do.
 */
export async function checkInstalledCli(
  requirement: InstalledCliRequirement,
  options: {
    readonly path?: string | undefined;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
  } = {},
): Promise<InstalledCliCheck> {
  const found = await findCommandOnPath(requirement.command, options.path ?? process.env["PATH"]);
  if (found === undefined)
    return {
      status: "missing",
      message: `${requirement.name} is not installed: \`${requirement.command}\` is not on PATH. ${requirement.install}`,
    };
  let output: string;
  try {
    const result = await run(found, ["--version"], {
      timeout: options.timeoutMs ?? 15_000,
      env: { ...process.env, ...options.environment },
      maxBuffer: 64 * 1024,
    });
    output = `${result.stdout}\n${result.stderr}`;
  } catch {
    return {
      status: "unknown-version",
      path: found,
      message: `${requirement.name} at ${found} did not report a version with \`${requirement.command} --version\`. ${requirement.install}`,
    };
  }
  const version = firstVersion(output);
  if (version === undefined)
    return {
      status: "unknown-version",
      path: found,
      message: `${requirement.name} at ${found} did not report a version with \`${requirement.command} --version\`. ${requirement.install}`,
    };
  if (compareVersions(version, requirement.minimumVersion) < 0)
    return {
      status: "outdated",
      path: found,
      version,
      message: `${requirement.name} ${version} is older than ${requirement.minimumVersion}, the oldest version SuperTag supports. ${requirement.install}`,
    };
  return { status: "ok", path: found, version };
}

/** The first major.minor.patch in `text`, such as 0.163.0 from "codex-cli 0.163.0". */
export function firstVersion(text: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/u.exec(text)?.slice(0, 1)[0];
}

/** Compares major.minor.patch numerically; a missing part counts as 0. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
