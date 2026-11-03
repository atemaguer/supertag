import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  assertWorkspaceMountPaths,
  isSensitiveWorkspaceMountPath,
  pathsOverlap,
  type WorkspaceMount,
} from "@supertag/core";
import type { EnvironmentPlan } from "./index.js";

/** Resolve existing ancestors before deciding where a local copy can write. */
export async function resolvedDestination(
  path: string,
  mountDestination: boolean,
): Promise<string> {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (ancestor === dirname(ancestor)) throw error;
      suffix.push(basename(ancestor));
      ancestor = dirname(ancestor);
      continue;
    }
    if (mountDestination && suffix.length === 0 && entry.isSymbolicLink())
      throw new Error(`Workspace mount destination is a symbolic link: ${path}`);
    return resolve(await realpath(ancestor), ...suffix.reverse());
  }
}

/** Protect host state and other worktrees as well as this Attempt's checkout and staged files. */
export async function assertLocalWorkspaceMountPaths(
  mounts: readonly WorkspaceMount[],
  checkout: string,
  stagedFiles: readonly string[],
  protectedPaths: readonly string[],
  caseInsensitive = process.platform === "darwin",
): Promise<void> {
  const canonical = async (path: string, mountDestination = false) => {
    const resolved = await resolvedDestination(path, mountDestination);
    return (caseInsensitive ? resolved.toLowerCase() : resolved).normalize("NFC");
  };
  const checkedMounts = await Promise.all(
    mounts.map(async (mount) => ({ ...mount, path: await canonical(mount.path, true) })),
  );
  const protectedLocations = await Promise.all(
    [resolve(homedir(), ".supertag"), resolve(homedir(), ".ssh"), ...protectedPaths].map((path) =>
      canonical(path),
    ),
  );
  const canonicalCheckout = await canonical(checkout);
  const canonicalHome = await canonical(homedir());
  const canonicalStaged = await Promise.all(stagedFiles.map((file) => canonical(file)));
  assertWorkspaceMountPaths(checkedMounts, canonicalCheckout, canonicalStaged);
  for (const mount of checkedMounts) {
    if (
      pathsOverlap(mount.path, canonicalHome) &&
      (mount.path === canonicalHome ||
        mount.path.startsWith(`${canonicalHome}/.`) ||
        mount.path.toLowerCase().startsWith(`${canonicalHome.toLowerCase()}/library/`) ||
        mount.path.toLowerCase() === `${canonicalHome.toLowerCase()}/library` ||
        canonicalHome.startsWith(`${mount.path}/`))
    )
      throw new Error(
        `Workspace mount ${mount.volume} path resolves into a home configuration location`,
      );
    if (isSensitiveWorkspaceMountPath(mount.path))
      throw new Error(
        `Workspace mount ${mount.volume} path resolves into a sensitive system location`,
      );
    if (protectedLocations.some((path) => pathsOverlap(mount.path, path)))
      throw new Error(`Workspace mount ${mount.volume} path overlaps Worker Host state`);
  }
}

/** Check every path the final Harness plan writes in its Attempt root. */
export async function assertLocalWorkspacePlanPaths(
  mounts: readonly WorkspaceMount[],
  checkout: string,
  plan: EnvironmentPlan,
  rootDirectory: string,
): Promise<void> {
  const staged = [
    ...plan.files.map((file) => file.path),
    ...plan.mounts.map((mount) => mount.destination),
    ...plan.secretBindings.map((binding) => binding.target),
  ].map((path) => resolve(rootDirectory, path));
  assertWorkspaceMountPaths(mounts, checkout, staged);
  await assertLocalWorkspaceMountPaths(mounts, checkout, staged, []);
}
