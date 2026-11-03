import { mkdtemp, realpath, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolvedDestination } from "./workspace-mount-paths.js";

/** Host-only authority, resolved once at startup and never supplied by a Task. */
export interface LocalMountRoot {
  readonly path: string;
  readonly foldCase: boolean;
  readonly device: bigint;
  readonly inode: bigint;
  /** Effective host state path, captured at startup; never supplied by a Task. */
  readonly stateDirectory: string;
}

const canonical = (path: string, insensitive: boolean) =>
  (insensitive ? path.toLowerCase() : path).normalize("NFC");

function within(child: string, parent: string): boolean {
  const rest = relative(parent, child);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function refuse(reason: string): Error {
  const error = new Error(`local-mount-root ${reason}`);
  error.name = "WorkspaceSetupError";
  return error;
}

/** Resolve an existing operator-owned directory; detect its filesystem's case behavior. */
export async function resolveLocalMountRoot(path: string): Promise<LocalMountRoot> {
  let root: string;
  let status: import("node:fs").BigIntStats;
  try {
    root = await realpath(path);
    status = await stat(root, { bigint: true });
    if (!status.isDirectory()) throw new Error("not a directory");
  } catch {
    throw refuse("must name an existing directory");
  }
  const home = await realpath(homedir());
  // Directory identity respects the actual filesystem's case and Unicode aliases, without
  // rejecting distinct case-sensitive siblings that only look like the home directory.
  if (await hasDirectoryAncestor(home, { device: status.dev, inode: status.ino }))
    throw refuse("must not be /, the home directory, or an ancestor of home");

  // Filesystem aliases (macOS firmlinks, or a bind-mounted /home) need not appear in
  // realpath(home). Compare the home ancestors reached through this root by identity too.
  for (const ancestor of await homeAncestors()) {
    const parts = ancestor.path.split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const candidate = await stat(join(root, ...parts.slice(index)), { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
          return undefined;
        },
      );
      if (candidate?.dev === ancestor.device && candidate?.ino === ancestor.inode)
        throw refuse(
          "must not expose the home directory or an ancestor through a filesystem alias",
        );
    }
  }

  let foldCase: boolean;
  try {
    const probe = await mkdtemp(join(root, ".supertag-case-"));
    try {
      const original = await stat(probe, { bigint: true });
      const folded = await stat(join(root, basename(probe).toUpperCase()), { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        },
      );
      foldCase = folded?.dev === original.dev && folded?.ino === original.ino;
    } finally {
      await rmdir(probe);
    }
  } catch (error) {
    // A read-only root can contain writable subdirectories. If probing is unavailable, fold
    // conservatively: the inode ancestry check below still rejects distinct case-sensitive names.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw error;
    foldCase = true;
  }
  const stateDirectory = resolve(
    process.env["INIT_CWD"]?.trim() || process.cwd(),
    process.env["SUPERTAG_STATE_DIR"]?.trim() || join(homedir(), ".supertag"),
  );
  return Object.freeze({
    path: root,
    foldCase,
    device: status.dev,
    inode: status.ino,
    stateDirectory,
  });
}

/** Recheck existing ancestors and directory identity; normalized names alone are not authority. */
export async function assertLocalMountDestination(
  path: string,
  root: LocalMountRoot | undefined,
): Promise<void> {
  if (root === undefined) throw refuse("must be configured on this host to allow local mounts");
  const current = await stat(root.path, { bigint: true }).catch(() => undefined);
  if (
    current?.dev !== root.device ||
    current?.ino !== root.inode ||
    (await realpath(root.path)) !== root.path
  )
    throw refuse("directory changed since startup; restart the host with the intended root");
  const destination = await resolvedDestination(path, true);
  // Check both spellings and real paths, even when the state directory does not exist yet.
  // Re-resolve on every check so a changed state-directory alias cannot expose credentials.
  const state = await resolvedDestination(root.stateDirectory, false);
  const overlaps = (left: string, right: string) => {
    const a = canonical(left, root.foldCase);
    const b = canonical(right, root.foldCase);
    return within(a, b) || within(b, a);
  };
  if (overlaps(destination, state) || overlaps(resolve(path), root.stateDirectory))
    throw refuse("does not allow mount destinations overlapping the SuperTag state directory");
  const stateIdentity = await stat(state, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    },
  );
  if (
    stateIdentity &&
    (await hasDirectoryAncestor(destination, {
      device: stateIdentity.dev,
      inode: stateIdentity.ino,
    }))
  )
    throw refuse("does not allow mount destinations inside a filesystem alias of SuperTag state");
  if (!within(canonical(destination, root.foldCase), canonical(root.path, root.foldCase)))
    throw refuse("does not contain this local mount destination");

  for (const candidate of [path, destination]) {
    if (
      relative(root.path, candidate)
        .split(sep)
        .some((part) => part.startsWith(".") && part !== "..")
    )
      throw refuse("does not allow mount destinations in dot directories below the root");
  }
  // A bind mount can be introduced anywhere below an otherwise safe root. Inspect every
  // existing destination ancestor up to the root; pathname normalization cannot identify it.
  const home = await homeAncestors();
  let ancestor = destination;
  while (within(canonical(ancestor, root.foldCase), canonical(root.path, root.foldCase))) {
    const entry = await stat(ancestor, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (home.some((directory) => entry?.dev === directory.device && entry?.ino === directory.inode))
      throw refuse(
        "destination crosses the home directory or an ancestor through a filesystem alias",
      );
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  // Linux can hold distinct NFC/NFD directories. Even normalized-equal names must lead to
  // the very directory the host approved. This also catches case aliases on mixed filesystems.
  if (!(await hasDirectoryAncestor(destination, root)))
    throw refuse("does not contain this local mount destination's real ancestors");
}

async function hasDirectoryAncestor(
  path: string,
  root: Pick<LocalMountRoot, "device" | "inode">,
): Promise<boolean> {
  let ancestor = path;
  for (;;) {
    const entry = await stat(ancestor, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (entry?.dev === root.device && entry?.ino === root.inode) return true;
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return false;
}

/** Directory identities, rather than spellings, also recognize bind mounts and firmlinks. */
async function homeAncestors(): Promise<{ path: string; device: bigint; inode: bigint }[]> {
  const result: { path: string; device: bigint; inode: bigint }[] = [];
  let path = await realpath(homedir());
  for (;;) {
    const entry = await stat(path, { bigint: true });
    result.push({ path, device: entry.dev, inode: entry.ino });
    const parent = dirname(path);
    if (parent === path) return result;
    path = parent;
  }
}
