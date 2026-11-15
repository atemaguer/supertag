import { lstat, opendir, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/** Resolve each component before processing `..`, without looking outside the Workspace. */
async function localLink(root: string, directory: string, name: string): Promise<boolean> {
  const location = relative(root, directory).split(sep).filter(Boolean);
  const pending = [name];
  let links = 0;
  while (pending.length) {
    const component = pending.pop();
    if (!component || component === ".") continue;
    if (component === "..") {
      if (!location.length) return false;
      location.pop();
      continue;
    }
    const candidate = join(root, ...location, component);
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info?.isSymbolicLink()) {
      // Keep checking a dangling target's remaining path against the same root.
      location.push(component);
      continue;
    }
    if (++links > 64) return false;
    const target = await readlink(candidate);
    if (isAbsolute(target)) return false;
    pending.push(...target.split(sep).reverse());
  }
  return true;
}

/** Native OpenCode's directory check is lexical, so verify the assigned tree before launch. */
export async function verifyWorkspaceLinks(root: string, signal?: AbortSignal): Promise<boolean> {
  const directories = [root];
  while (directories.length) {
    signal?.throwIfAborted();
    const directory = directories.pop();
    if (directory === undefined) break;
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink() && !(await localLink(root, directory, entry.name))) return false;
      // The Worker Host constructs its own .git metadata outside the admitted content tree.
      if (entry.isDirectory() && !(directory === root && entry.name === ".git"))
        directories.push(join(directory, entry.name));
    }
  }
  return true;
}
