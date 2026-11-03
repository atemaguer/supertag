import { tmpdir } from "node:os";

/**
 * Directories a sandboxed local Task can write besides its checkout: the system and per-user
 * temporary directories. Codex's `workspace-write` sandbox allows `/tmp` and `TMPDIR`, for
 * example. A Task that can write a directory can rename it and put a symbolic link in its place,
 * so the Worker Host never places a local copy mount below one of these.
 */
export function taskWritableRoots(): readonly string[] {
  const roots = [
    tmpdir(),
    process.env["TMPDIR"],
    process.env["TMP"],
    process.env["TEMP"],
    "/tmp",
    "/var/tmp",
    "/dev/shm",
  ];
  return [...new Set(roots.filter((root): root is string => root !== undefined && root !== ""))];
}
