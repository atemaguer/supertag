import { lstat, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface OutputFileEntry {
  readonly path: string;
  readonly sizeBytes: number;
}
export interface OutputFileQuery {
  readonly roots: readonly string[];
  readonly maxFiles: number;
  /** Optional patterns relative to each root, pruned before unrelated directories are traversed. */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}
export function outputPatternMatches(path: string, pattern: string): boolean {
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        expression += "(?:.*/)?";
      } else expression += ".*";
    } else if (c === "*") expression += "[^/]*";
    else if (c === "?") expression += "[^/]";
    else expression += c?.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`).test(path);
}
function mayContainMatch(path: string, pattern: string): boolean {
  const parts = path.split("/"),
    segments = pattern.split("/");
  for (let i = 0; i < parts.length; i++) {
    const segment = segments[i];
    // Conservatively traverse a recursive wildcard; filtering files still uses the full pattern.
    if (segment?.includes("**")) return true;
    if (!segment || !outputPatternMatches(parts[i] ?? "", segment)) return false;
  }
  return parts.length < segments.length;
}
/** Enumeration is bounded and never traverses links. Implementations must fail on unsupported entries. */
export async function listLocalOutputFiles(
  root: string,
  query: OutputFileQuery,
): Promise<readonly OutputFileEntry[]> {
  const entries = new Map<string, OutputFileEntry>();
  let visited = 0;
  async function visit(path: string, selectedRoot: string): Promise<void> {
    const selectedPath =
      path === selectedRoot ? "" : path.slice(selectedRoot.length + (selectedRoot ? 1 : 0));
    if (
      selectedPath &&
      (query.exclude?.some(
        (pattern) =>
          outputPatternMatches(selectedPath, pattern) ||
          outputPatternMatches(`${selectedPath}/`, pattern),
      ) ||
        (query.include &&
          !query.include.some(
            (pattern) =>
              outputPatternMatches(selectedPath, pattern) || mayContainMatch(selectedPath, pattern),
          )))
    )
      return;
    if (++visited > query.maxFiles * 4 + 1000)
      throw new Error("Output enumeration exceeds entry limit");
    const absolute = resolve(root, path),
      rel = relative(root, absolute);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new Error("Output root escapes workspace");
    let cursor = root;
    for (const part of rel.split("/").filter(Boolean)) {
      cursor = join(cursor, part);
      let status: Awaited<ReturnType<typeof lstat>>;
      try {
        status = await lstat(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (status.isSymbolicLink()) throw new Error(`Output contains symbolic link: ${path}`);
    }
    const status = await lstat(absolute);
    if (status.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        if (excludedOutputPath(name)) continue;
        await visit(path ? `${path}/${name}` : name, selectedRoot);
      }
    } else if (status.isFile()) {
      if (
        query.include &&
        !query.include.some((pattern) => outputPatternMatches(selectedPath, pattern))
      )
        return;
      entries.set(path, { path, sizeBytes: status.size });
      if (entries.size > query.maxFiles) throw new Error("Output enumeration exceeds file limit");
    } else throw new Error(`Output is not a regular file: ${path}`);
  }
  for (const path of query.roots) {
    if (path && excludedOutputPath(path)) continue;
    await visit(path, path);
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function excludedOutputPath(path: string): boolean {
  return path
    .split("/")
    .some(
      (part) =>
        /^(?:\.git|node_modules|\.venv|venv|__pycache__|\.cache|inputs|\.ssh|\.aws|\.gnupg|\.supertag)$/.test(
          part,
        ) ||
        /^artifact-[a-f0-9]{64}$/.test(part) ||
        /^\.env(?:\.|$)/.test(part) ||
        /\.(?:pem|key|p12|pfx)$/.test(part),
    );
}

/** Prepare only a relative output directory beneath the Attempt root. */
export async function prepareLocalOutputDirectory(root: string, path: string): Promise<void> {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || /[\\:]/.test(path))
    throw new Error("Invalid output directory");
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const status = await lstat(target);
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new Error("Output directory is not a safe directory");
  }
}
