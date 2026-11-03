import { createHash } from "node:crypto";
import type { EnvironmentAccess } from "./index.js";
import { type CollectedOutputFile, outputPatternMatches } from "./output-collection.js";
import { excludedOutputPath } from "./output-files.js";

/** A known output location inside the runtime root, never an entire harness home. */
export interface HarnessArtifactSource {
  readonly id: string;
  readonly directory: string;
  /** Patterns are relative to directory. */
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  readonly category?: string;
  /** Number of relative path components identifying an independently captured bundle. */
  readonly bundleDepth?: number;
  /** Whether these work products are submitted as Task outputs; knowledge defaults to false. */
  readonly submit?: boolean;
  /** Restore an explicitly admitted artifact from this source into the next Harness runtime. */
  readonly restore?: boolean;
}

export interface HarnessArtifactBaseline {
  readonly sources: Readonly<
    Record<
      string,
      { readonly configurationDigest: string; readonly digests: Readonly<Record<string, string>> }
    >
  >;
}

export interface CollectedHarnessArtifact {
  readonly id: string;
  readonly source: HarnessArtifactSource;
  /** Full current bundle, with paths relative to the runtime root. */
  readonly files: readonly CollectedOutputFile[];
}

const MAX_FILES = 100;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function safePath(path: string, pattern = false): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 4096 &&
    !/[\\:]/.test(path) &&
    (pattern || !/[?*]/.test(path)) &&
    ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    path.split("/").every((part) => !!part && part !== "." && part !== "..")
  );
}

export function validateHarnessArtifactSources(sources: readonly HarnessArtifactSource[]): void {
  if (sources.length > MAX_FILES) throw new Error("Too many harness artifact sources");
  const ids = new Set<string>();
  for (const source of sources) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(source.id) || ids.has(source.id))
      throw new Error("Invalid or duplicate harness artifact source id");
    ids.add(source.id);
    if (source.submit !== undefined && typeof source.submit !== "boolean")
      throw new Error("Invalid harness artifact submission flag");
    if (source.restore !== undefined && typeof source.restore !== "boolean")
      throw new Error("Invalid harness artifact restoration flag");
    if (source.restore === true && source.submit !== true)
      throw new Error("Restored harness artifacts must be submitted for explicit selection");
    if (source.category !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(source.category))
      throw new Error("Invalid harness artifact category");
    if (!safePath(source.directory) || excludedOutputPath(source.directory))
      throw new Error("Invalid harness artifact source directory");
    if (
      source.bundleDepth !== undefined &&
      (!Number.isSafeInteger(source.bundleDepth) ||
        source.bundleDepth < 0 ||
        source.bundleDepth > 16)
    )
      throw new Error("Invalid harness artifact bundle depth");
    if (
      !source.include.length ||
      source.include.length > 100 ||
      (source.exclude?.length ?? 0) > 100 ||
      [...source.include, ...(source.exclude ?? [])].some((pattern) => !safePath(pattern, true))
    )
      throw new Error("Invalid harness artifact source pattern");
  }
}

function configurationDigest(source: HarnessArtifactSource): string {
  return digest(
    JSON.stringify({
      directory: source.directory,
      include: [...source.include].sort(),
      exclude: [...(source.exclude ?? [])].sort(),
      category: source.category ?? null,
      bundleDepth: source.bundleDepth ?? 0,
      submit: source.submit ?? false,
      restore: source.restore ?? false,
    }),
  );
}

async function snapshot(
  environment: EnvironmentAccess,
  sources: readonly HarnessArtifactSource[],
): Promise<readonly CollectedHarnessArtifact[]> {
  validateHarnessArtifactSources(sources);
  if (!sources.length) return [];
  if (!environment.listOutputFiles || !environment.readBytes)
    throw new Error("Execution environment cannot collect harness artifacts");
  let enumerated = 0;
  let totalBytes = 0;
  const groups: CollectedHarnessArtifact[] = [];
  for (const source of sources) {
    const entries = await environment.listOutputFiles({
      roots: [source.directory],
      maxFiles: MAX_FILES - enumerated,
      include: source.include,
      ...(source.exclude ? { exclude: source.exclude } : {}),
    });
    enumerated += entries.length;
    if (enumerated > MAX_FILES) throw new Error("Harness artifact enumeration exceeds file limit");
    const seen = new Set<string>();
    const files: CollectedOutputFile[] = [];
    for (const entry of entries) {
      if (
        !safePath(entry.path) ||
        !entry.path.startsWith(`${source.directory}/`) ||
        !Number.isSafeInteger(entry.sizeBytes) ||
        entry.sizeBytes < 0 ||
        seen.has(entry.path)
      )
        throw new Error("Invalid harness artifact manifest entry");
      seen.add(entry.path);
      const relativePath = entry.path.slice(source.directory.length + 1);
      if (
        excludedOutputPath(entry.path) ||
        !source.include.some((pattern) => outputPatternMatches(relativePath, pattern)) ||
        source.exclude?.some((pattern) => outputPatternMatches(relativePath, pattern))
      )
        continue;
      if (entry.sizeBytes > MAX_FILE_BYTES || totalBytes + entry.sizeBytes > MAX_BYTES)
        throw new Error("Harness artifact capture exceeds byte limit");
      // Own the bytes: provider buffers can otherwise change while the second read is pending.
      const bytes = Uint8Array.from(await environment.readBytes(entry.path));
      const second = await environment.readBytes(entry.path);
      if (bytes.byteLength !== entry.sizeBytes || digest(bytes) !== digest(second))
        throw new Error(`Harness artifact changed during collection: ${entry.path}`);
      totalBytes += bytes.byteLength;
      files.push({ path: entry.path, bytes });
    }
    groups.push({
      id: source.id,
      source,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    });
  }
  return groups;
}

/** Snapshot before execution so preinstalled skills and restored memory are not new outputs. */
export async function prepareHarnessArtifactCollection(
  environment: EnvironmentAccess,
  sources: readonly HarnessArtifactSource[],
): Promise<HarnessArtifactBaseline> {
  const groups = await snapshot(environment, sources);
  return {
    sources: Object.fromEntries(
      groups.map(({ source, files }) => [
        source.id,
        {
          configurationDigest: configurationDigest(source),
          digests: Object.fromEntries(files.map((file) => [file.path, digest(file.bytes)])),
        },
      ]),
    ),
  };
}

/** Capture a complete selected bundle when any member was added, changed, or removed. */
export async function collectHarnessArtifacts(
  environment: EnvironmentAccess,
  sources: readonly HarnessArtifactSource[],
  baseline: HarnessArtifactBaseline,
): Promise<readonly CollectedHarnessArtifact[]> {
  validateHarnessArtifactSources(sources);
  for (const source of sources) {
    if (baseline.sources[source.id]?.configurationDigest !== configurationDigest(source))
      throw new Error("Harness artifact sources changed after baseline");
  }
  if (Object.keys(baseline.sources).length !== sources.length)
    throw new Error("Harness artifact sources changed after baseline");
  return (await snapshot(environment, sources)).flatMap(({ source, files }) => {
    const previous = baseline.sources[source.id]?.digests ?? {};
    const bundleKey = (path: string) =>
      path
        .slice(source.directory.length + 1)
        .split("/")
        .slice(0, source.bundleDepth ?? 0)
        .join("/");
    const bundles = new Map<string, CollectedOutputFile[]>();
    for (const file of files) {
      const key = bundleKey(file.path);
      const bundle = bundles.get(key) ?? [];
      bundle.push(file);
      bundles.set(key, bundle);
    }
    return [...bundles].flatMap(([key, members]) => {
      // Removed whole bundles have no remaining content to publish. A partial deletion emits the remaining bundle.
      const previousPaths = Object.keys(previous).filter((path) => bundleKey(path) === key);
      const changed =
        members.length !== previousPaths.length ||
        members.some((file) => previous[file.path] !== digest(file.bytes));
      return changed
        ? [
            {
              id: key ? `${source.id}-${digest(key).slice(0, 16)}` : source.id,
              source,
              files: members,
            },
          ]
        : [];
    });
  });
}
