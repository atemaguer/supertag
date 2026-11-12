import { createHash } from "node:crypto";
import { posix } from "node:path";

export interface InputFile {
  readonly path: string;
  readonly blob?: { readonly sha256: string; readonly byteLength: bigint } | undefined;
}

export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

export function inputManifest(files: readonly InputFile[]) {
  const paths = new Set<string>();
  let total = 0;
  if (files.length > 100) throw new Error("Too many Workspace input files");
  for (const { path, blob } of files) {
    if (
      !/^inputs\/[0-9a-f]{64}\/artifact-[0-9a-f]{64}\/.+/u.test(path) ||
      Buffer.byteLength(path) > 1170 ||
      /[\\:\p{Cc}]/u.test(path) ||
      path
        .split("/")
        .some((part) => ["", ".", "..", ".git", ".supertag"].includes(part.toLowerCase())) ||
      paths.has(path) ||
      !blob ||
      blob.byteLength < 0n ||
      blob.byteLength > 32n * 1024n * 1024n ||
      !/^[0-9a-f]{64}$/u.test(blob.sha256)
    )
      throw new Error("Invalid Workspace input manifest");
    paths.add(path);
    total += Number(blob.byteLength);
    if (total > MAX_INPUT_BYTES) throw new Error("Workspace inputs exceed their transfer limit");
  }
  for (const path of paths) {
    for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) {
      if (paths.has(parent)) throw new Error("Workspace input paths overlap");
    }
  }
  return total;
}

export function inputRoot(attemptId: string): string {
  return `inputs/${createHash("sha256").update(attemptId).digest("hex")}`;
}
