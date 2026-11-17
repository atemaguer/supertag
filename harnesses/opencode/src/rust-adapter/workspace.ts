import { lstat, opendir, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { FileScopeRules } from "@supertag/worker-sdk/internal/rust-harness";

/**
 * Resolve each component before processing `..`, without looking outside the Workspace. Returns
 * the target's Workspace-relative path, or `undefined` when it leaves the Workspace.
 */
async function localLink(
  root: string,
  directory: string,
  name: string,
): Promise<string | undefined> {
  const location = relative(root, directory).split(sep).filter(Boolean);
  const pending = [name];
  let links = 0;
  while (pending.length) {
    const component = pending.pop();
    if (!component || component === ".") continue;
    if (component === "..") {
      if (!location.length) return undefined;
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
    if (++links > 64) return undefined;
    const target = await readlink(candidate);
    if (isAbsolute(target)) return undefined;
    pending.push(...target.split(sep).reverse());
  }
  return location.join("/");
}

/**
 * Native OpenCode's directory and permission checks are lexical, so verify the assigned tree
 * before launch: every link stays in the Workspace and, under a path scope, reaches nothing its
 * own path would not, so a link can neither read a hidden file nor write outside the write paths.
 */
export async function verifyWorkspaceLinks(
  root: string,
  signal?: AbortSignal,
  rules?: FileScopeRules,
): Promise<boolean> {
  const directories = [root];
  while (directories.length) {
    signal?.throwIfAborted();
    const directory = directories.pop();
    if (directory === undefined) break;
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) {
        const target = await localLink(root, directory, entry.name);
        if (target === undefined) return false;
        const link = relative(root, join(directory, entry.name)).split(sep).join("/");
        if (
          rules &&
          ((rules.readDenial(target) && !rules.readDenial(link)) ||
            (rules.writeDenial(target) && !rules.writeDenial(link)))
        )
          return false;
      }
      // The Worker Host constructs its own .git metadata outside the admitted content tree.
      if (entry.isDirectory() && !(directory === root && entry.name === ".git"))
        directories.push(join(directory, entry.name));
    }
  }
  return true;
}
