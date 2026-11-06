import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Decides which entries of a local directory a Task copy includes, by path relative to it.
 * Returns undefined when the directory is staged whole.
 */
export type LocalResourceFilter = (relativePath: string) => boolean;

/**
 * For the top level of a git repository, a copy holds what git considers part of the repository:
 * tracked files, untracked files that are not ignored, and the `.git` entry. Ignored entries such
 * as `node_modules`, a Python `.venv`, build output, or a `.env` file stay on the Worker Host, so a
 * Task copy is small and never exposes local secrets or environment links. Any other directory, or
 * a host without git, is staged whole.
 */
export async function localResourceFilter(root: string): Promise<LocalResourceFilter | undefined> {
  if (!(await stat(root)).isDirectory()) return undefined;
  let listed: string;
  try {
    const top = (
      await run("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" })
    ).stdout.trim();
    if (relative(await realpath(top), await realpath(root)) !== "") return undefined;
    listed = (
      await run(
        "git",
        ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        {
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
        },
      )
    ).stdout;
  } catch {
    return undefined;
  }
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const path of listed.split("\0")) {
    if (path === "") continue;
    const native = path.split("/").join(sep);
    files.add(native);
    for (let index = native.indexOf(sep); index !== -1; index = native.indexOf(sep, index + 1))
      directories.add(native.slice(0, index));
  }
  return (relativePath) =>
    relativePath === "" ||
    relativePath === ".git" ||
    relativePath.startsWith(`.git${sep}`) ||
    files.has(relativePath) ||
    directories.has(relativePath);
}

/** Joins a relative entry path the way the filter expects. */
export function childPath(parent: string, name: string): string {
  return parent === "" ? name : join(parent, name);
}
