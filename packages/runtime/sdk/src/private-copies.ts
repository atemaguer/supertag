import { constants } from "node:fs";
import { chmod, copyFile, lstat, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** What {@link replaceHardLinks} found and changed. */
export interface PrivateCopyResult {
  /** Regular files examined. */
  readonly files: number;
  /** Files that had more than one link and now have their own copy. */
  readonly replaced: number;
}

let sequence = 0;

/**
 * Gives every regular file under `paths` that has more than one hard link its own copy, so a
 * write to it can never reach another name for the same inode, such as a file in a package
 * manager's shared store. The copy is a copy-on-write clone where the filesystem supports one,
 * otherwise a full copy, and keeps the file mode. Symlinks are never followed, so nothing outside
 * `root` is read or changed. `paths` are relative to `root`; a path that leaves it is refused.
 */
export async function replaceHardLinks(
  root: string,
  paths: readonly string[],
): Promise<PrivateCopyResult> {
  const top = resolve(root);
  let files = 0;
  let replaced = 0;
  const visit = async (path: string): Promise<void> => {
    const status = await lstat(path).catch(() => undefined);
    if (status === undefined || status.isSymbolicLink()) return;
    if (status.isDirectory()) {
      const entries = await readdir(path);
      await Promise.all(entries.map((entry) => visit(join(path, entry))));
      return;
    }
    if (!status.isFile()) return;
    files += 1;
    if (status.nlink <= 1) return;
    sequence += 1;
    const temporary = join(
      dirname(path),
      `.${basename(path)}.supertag-copy-${process.pid}-${sequence}`,
    );
    try {
      await copyFile(path, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await chmod(temporary, status.mode & 0o7777);
      // Replacing the name, not writing through it, leaves every other link untouched.
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new Error(
        `Could not give setup output ${relative(top, path)} its own copy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    replaced += 1;
  };
  await Promise.all(
    paths.map((path) => {
      const absolute = resolve(top, path);
      if (absolute === top || !absolute.startsWith(`${top}${sep}`))
        throw new Error(`Setup output ${path} is outside the Task worktree`);
      return visit(absolute);
    }),
  );
  return { files, replaced };
}
