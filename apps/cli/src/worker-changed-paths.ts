import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const MAX_CHANGED_PATHS = 500;

export interface RunningAttemptWorktree {
  readonly attemptId: string;
  /** Absent for remote environments without a host-readable Task worktree. */
  readonly worktree?: string;
}

export interface ChangedPathReport {
  readonly attemptId: string;
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

async function git(worktree: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runFile("git", ["-C", worktree, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5_000,
  });
  return stdout;
}

function addPath(paths: Set<string>, path: string): void {
  if (
    path.length === 0 ||
    path.length > 4096 ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git")
  )
    return;
  paths.add(path);
}

function diffPaths(output: string, paths: Set<string>): void {
  const fields = output.split("\0");
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index++] ?? "";
    addPath(paths, fields[index++] ?? "");
    if (status.startsWith("R") || status.startsWith("C")) addPath(paths, fields[index++] ?? "");
  }
}

function statusPaths(output: string, paths: Set<string>): void {
  const fields = output.split("\0");
  for (let index = 0; index < fields.length - 1; ) {
    const entry = fields[index++] ?? "";
    addPath(paths, entry.slice(3));
    if (/[RC]/u.test(entry.slice(0, 2))) addPath(paths, fields[index++] ?? "");
  }
}

/** Scan the Attempt's recorded base and its current index, working tree, and untracked files. */
export async function scanChangedPaths(
  worktree: string,
  baseOverride?: string,
): Promise<{ readonly paths: readonly string[]; readonly truncated: boolean } | undefined> {
  try {
    const gitDir = (await git(worktree, ["rev-parse", "--absolute-git-dir"])).trim();
    const base = baseOverride ?? (await readFile(join(gitDir, "supertag-base"), "utf8")).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(base) && baseOverride === undefined) return undefined;
    const [diff, status] = await Promise.all([
      git(worktree, ["diff", "--name-status", "-z", "-M", base, "--"]),
      git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const paths = new Set<string>();
    diffPaths(diff, paths);
    statusPaths(status, paths);
    const sorted = [...paths].sort();
    return {
      paths: sorted.slice(0, MAX_CHANGED_PATHS),
      truncated: sorted.length > MAX_CHANGED_PATHS,
    };
  } catch {
    // A missing remote worktree or a failed Git command must not interrupt host heartbeats.
    return undefined;
  }
}

/** Only host-readable running worktrees can produce reports. */
export async function scanRunningAttempts(
  attempts: readonly RunningAttemptWorktree[],
): Promise<ChangedPathReport[]> {
  const reports: ChangedPathReport[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, attempts.length) }, async () => {
      while (next < attempts.length) {
        const attempt = attempts[next++];
        if (!attempt?.worktree) continue;
        const changed = await scanChangedPaths(attempt.worktree);
        if (changed) reports.push({ attemptId: attempt.attemptId, ...changed });
      }
    }),
  );
  return reports.sort((a, b) => a.attemptId.localeCompare(b.attemptId));
}
