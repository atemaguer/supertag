import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Removes a test tree that may hold read-only copies, restoring write permission first. */
export async function removeSealedTree(path: string): Promise<void> {
  const status = await lstat(path).catch(() => undefined);
  if (status === undefined) return;
  if (status.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await removeSealedTree(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
}
