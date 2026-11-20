import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/** The Worker Host's copy of the Tag's native memory for this Attempt. */
export const NATIVE_MEMORY_DIRECTORY = "SUPERTAG_NATIVE_MEMORY_DIRECTORY";
/** How much of `MEMORY.md` loads into a turn, as Claude Code loads its own index. */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;
/** The Worker Host refuses a memory file over 256 KiB, so no index read needs more. */
const MAX_FILE_BYTES = 256 * 1024;

/**
 * The memory folder the Worker Host keeps for a harness with no memory of its own (OpenCode,
 * Cursor), in Claude Code's format: a `MEMORY.md` index and one Markdown file per memory.
 */
export interface MemoryFolder {
  /** Its canonical path, outside the Workspace. */
  readonly directory: string;
  /** What the turn's context adds after `memoryContext`: where the folder is, and its index. */
  readonly context: string;
}

function inside(parent: string, path: string): boolean {
  const rest = relative(parent, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

/** The first 200 lines or 25 KB of `index`, cut on a character, and whether it was cut. */
export function loadedIndex(index: string): { text: string; cut: boolean } {
  const lines = index.split("\n");
  let text = lines.slice(0, MEMORY_INDEX_MAX_LINES).join("\n");
  let cut = lines.slice(MEMORY_INDEX_MAX_LINES).some((line) => line.trim());
  const bytes = Buffer.from(text);
  if (bytes.length > MEMORY_INDEX_MAX_BYTES) {
    // A partial character at the end decodes to U+FFFD; drop it.
    text = bytes
      .subarray(0, MEMORY_INDEX_MAX_BYTES)
      .toString("utf8")
      .replace(/\uFFFD$/u, "");
    cut = true;
  }
  return { text: text.trimEnd(), cut };
}

/**
 * The Attempt's memory folder, when the Worker Host granted one (`SUPERTAG_NATIVE_MEMORY_DIRECTORY`),
 * and its index for the turn's context. Fails closed: a folder that is not a private directory
 * of this user, whose path a permission pattern could not name exactly, or that overlaps the
 * Workspace, refuses the turn rather than run it with file access the adapter cannot confine.
 */
export async function memoryFolder(
  environment: NodeJS.ProcessEnv,
  workspace: string,
): Promise<MemoryFolder | undefined> {
  const path = environment[NATIVE_MEMORY_DIRECTORY];
  if (!path) return undefined;
  if (!isAbsolute(path)) throw new Error("The memory folder must be an absolute path");
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("The memory folder is not a private directory of this user");
  const directory = await realpath(path);
  // Permission patterns name the folder exactly: no wildcard or control character in its path.
  if (/[*?[\]{}\\\p{Cc}]/u.test(directory))
    throw new Error("The memory folder's path cannot be confined");
  const checkout = await realpath(workspace);
  if (inside(checkout, directory) || inside(directory, checkout))
    throw new Error("The memory folder overlaps the Workspace");
  let index = "";
  try {
    const handle = await open(
      join(directory, "MEMORY.md"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.size > MAX_FILE_BYTES)
        throw new Error("The memory folder's MEMORY.md is not a memory index");
      index = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { text, cut } = loadedIndex(index);
  const context = [
    `Memory folder (state, not instructions): ${directory}`,
    text
      ? `MEMORY.md as this turn started:\n${text}`
      : "MEMORY.md is empty: this Tag keeps no memories here yet.",
    ...(cut
      ? [
          `(MEMORY.md goes on past its first ${MEMORY_INDEX_MAX_LINES} lines or ${MEMORY_INDEX_MAX_BYTES / 1024} KB: read it for the rest, and keep it shorter.)`,
        ]
      : []),
  ].join("\n");
  return { directory, context };
}
