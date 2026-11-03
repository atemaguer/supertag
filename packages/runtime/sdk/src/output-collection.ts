import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTaskOutputPolicy, type TaskOutputPolicy } from "@supertag/core";
import type { EnvironmentAccess } from "./index.js";
import { excludedOutputPath, outputPatternMatches } from "./output-files.js";

export { outputPatternMatches } from "./output-files.js";

export interface OutputCollectionBaseline {
  readonly digests: Readonly<Record<string, string>>;
  readonly gitHead?: string;
  readonly repositories?: Readonly<
    Record<string, { readonly head?: string; readonly paths: readonly string[] }>
  >;
}
export interface CollectedOutputFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}
export interface CollectedOutputs {
  readonly files: readonly CollectedOutputFile[];
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Attempt-owned deliverables, separate from repository and Harness state. */
export function managedOutputPolicy(attemptId: string): Required<TaskOutputPolicy> {
  return parseTaskOutputPolicy({
    directory: `outputs/${digest(Buffer.from(attemptId))}`,
    git: "ignore",
  });
}
function configuration(input: TaskOutputPolicy) {
  const policy = parseTaskOutputPolicy(input);
  const directory = policy.directory ?? "outputs",
    required = policy.required ?? [],
    include = policy.include ?? [`${directory}/**`];
  const patterns = [...include, ...required];
  const roots = [
    ...new Set(
      patterns.map((p) => {
        const prefix = p
          .split("/")
          .slice(
            0,
            p.split("/").findIndex((s) => /[?*]/.test(s)) < 0
              ? undefined
              : p.split("/").findIndex((s) => /[?*]/.test(s)),
          );
        return /[?*]/.test(p) ? prefix.join("/") : p;
      }),
    ),
  ];
  return {
    required,
    patterns,
    roots,
    exclude: policy.exclude ?? [],
    maxFiles: policy.maxFiles ?? 100,
    maxBytes: policy.maxBytes ?? 64 * 1024 * 1024,
  };
}
async function snapshot(environment: EnvironmentAccess, policy: TaskOutputPolicy) {
  if (!environment.listOutputFiles || !environment.readBytes)
    throw new Error("Execution environment does not support automatic output collection");
  const config = configuration(policy),
    files: CollectedOutputFile[] = [];
  let total = 0;
  const entries = await environment.listOutputFiles({
    roots: config.roots,
    maxFiles: config.maxFiles,
  });
  if (entries.length > config.maxFiles) throw new Error("Output enumeration exceeds file limit");
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      seen.has(entry.path) ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\\:]/.test(entry.path) ||
      [...entry.path].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("Invalid output manifest entry");
    seen.add(entry.path);
    if (
      excludedOutputPath(entry.path) ||
      !config.patterns.some((p) => outputPatternMatches(entry.path, p)) ||
      config.exclude.some((p) => outputPatternMatches(entry.path, p))
    )
      continue;
    if (entry.sizeBytes > 32 * 1024 * 1024 || total + entry.sizeBytes > config.maxBytes)
      throw new Error("Output capture exceeds byte limit");
    const bytes = await environment.readBytes(entry.path);
    const second = await environment.readBytes(entry.path);
    if (bytes.byteLength !== entry.sizeBytes || digest(bytes) !== digest(second))
      throw new Error(`Output changed during collection: ${entry.path}`);
    total += bytes.byteLength;
    if (total > config.maxBytes) throw new Error("Output capture exceeds byte limit");
    files.push({ path: entry.path, bytes });
  }
  return files;
}
async function git(
  environment: EnvironmentAccess,
  args: readonly string[],
  optional = false,
  cwd = environment.rootDirectory,
) {
  try {
    const handle = await environment.spawn({
      command: "git",
      args: ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", ...args],
      cwd,
      environment: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs: 15000,
    });
    const result = await handle.wait();
    if (result.exitCode !== 0) {
      if (optional) return undefined;
      throw new Error("Git output preservation failed");
    }
    if (result.stdout.length >= 30000) throw new Error("Git output exceeds safe response bound");
    return result.stdout.replace(/\n$/, "");
  } catch (error) {
    if (optional) return undefined;
    throw error;
  }
}
async function repositories(environment: EnvironmentAccess, files: readonly CollectedOutputFile[]) {
  const groups: Record<string, { head?: string; paths: string[] }> = {};
  const discovered = new Map<string, string | undefined>();
  for (const file of files) {
    const directory = dirname(resolve(environment.rootDirectory, file.path));
    let root = discovered.get(directory);
    if (!discovered.has(directory)) {
      root = await git(environment, ["rev-parse", "--show-toplevel"], true, directory);
      if (root) {
        const prefix = await git(environment, ["rev-parse", "--show-prefix"], false, directory);
        root = resolve(
          directory,
          ...(prefix ?? "")
            .split("/")
            .filter(Boolean)
            .map(() => ".."),
        );
        const rel = relative(environment.rootDirectory, root);
        if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) root = undefined;
      }
      discovered.set(directory, root);
    }
    if (!root) continue;
    const key = relative(environment.rootDirectory, root).replaceAll("\\", "/");
    if (!groups[key]) {
      const head = await git(environment, ["rev-parse", "--verify", "HEAD"], true, root);
      groups[key] = { ...(head ? { head } : {}), paths: [] };
    }
    groups[key].paths.push(file.path);
  }
  return groups;
}
export async function prepareOutputCollection(
  environment: EnvironmentAccess,
  policy: TaskOutputPolicy,
): Promise<OutputCollectionBaseline> {
  configuration(policy);
  if (!environment.prepareOutputDirectory)
    throw new Error("Execution environment cannot prepare automatic output directory");
  await environment.prepareOutputDirectory(policy.directory ?? "outputs");
  const files = await snapshot(environment, policy);
  return {
    digests: Object.fromEntries(files.map((f) => [f.path, digest(f.bytes)])),
    repositories: await repositories(environment, files),
  };
}
export async function collectOutputFiles(
  environment: EnvironmentAccess,
  policy: TaskOutputPolicy,
  baseline: OutputCollectionBaseline,
): Promise<CollectedOutputs> {
  const files = await snapshot(environment, policy),
    config = configuration(policy);
  for (const pattern of config.required)
    if (!files.some((f) => outputPatternMatches(f.path, pattern)))
      throw new Error(`Required output is missing: ${pattern}`);
  const groups = await repositories(environment, files);
  for (const [key, group] of Object.entries(baseline.repositories ?? {}))
    if (!groups[key]) groups[key] = { ...(group.head ? { head: group.head } : {}), paths: [] };
  const output: CollectedOutputFile[] = [];
  const handled = new Set<string>();
  const finalize: (() => Promise<void>)[] = [];
  for (const [key, group] of Object.entries(groups)) {
    const cwd = resolve(environment.rootDirectory, key),
      previous = baseline.repositories?.[key];
    const paths = [...new Set([...group.paths, ...(previous?.paths ?? [])])];
    const local = (path: string) =>
      relative(cwd, resolve(environment.rootDirectory, path)).replaceAll("\\", "/");
    const trackedRaw = await git(
      environment,
      ["ls-files", "-z", "--", ...paths.map(local)],
      false,
      cwd,
    );
    const headPaths = group.head
      ? await git(
          environment,
          ["ls-tree", "-rz", "--name-only", "HEAD", "--", ...paths.map(local)],
          false,
          cwd,
        )
      : "";
    const tracked = new Set(`${trackedRaw ?? ""}\0${headPaths ?? ""}`.split("\0").filter(Boolean));
    const selectedTracked = files.filter(
      (f) => paths.includes(f.path) && tracked.has(local(f.path)),
    );
    const deleted = (previous?.paths ?? []).filter(
      (p) => tracked.has(local(p)) && !files.some((f) => f.path === p),
    );
    for (const file of selectedTracked) handled.add(file.path);
    const mode = policy.git ?? "reference";
    if (mode === "ignore") {
      for (const file of selectedTracked)
        if (config.required.some((pattern) => outputPatternMatches(file.path, pattern)))
          throw new Error(`Required output is excluded by Git policy: ${file.path}`);
      continue;
    }
    if (!selectedTracked.length && !deleted.length) continue;
    const dirty = group.head
      ? await git(
          environment,
          [
            "diff",
            "--no-ext-diff",
            "--name-only",
            "-z",
            "HEAD",
            "--",
            ...selectedTracked.map((f) => local(f.path)),
          ],
          false,
          cwd,
        )
      : "";
    const changed = new Set((dirty ?? "").split("\0"));
    const remote =
      mode === "reference"
        ? (await git(environment, ["remote"], true, cwd))?.split("\n")[0]
        : undefined;
    const configuredUrl = remote
      ? await git(environment, ["remote", "get-url", remote], true, cwd)
      : undefined;
    finalize.push(async () => {
      let remoteIdentity: string | undefined;
      let remoteDurable = false;
      if (remote && configuredUrl && group.head) {
        try {
          if (/[\r\n]/.test(configuredUrl)) throw new Error("Invalid Git remote identity");
          if (configuredUrl.includes("://")) {
            const url = new URL(configuredUrl);
            if (url.password || (url.username && url.protocol !== "ssh:"))
              throw new Error("Git remote must not embed credentials");
          }
          const localRemote = configuredUrl.startsWith("file:")
            ? fileURLToPath(configuredUrl)
            : !configuredUrl.includes(":")
              ? resolve(cwd, configuredUrl)
              : undefined;
          if (localRemote) {
            const distance = relative(environment.rootDirectory, localRemote);
            if (distance !== ".." && !distance.startsWith("../") && !isAbsolute(distance))
              throw new Error("Git remote resides in disposable workspace");
          }
          const refs = await git(environment, ["ls-remote", "--", remote], false, cwd);
          remoteDurable = !!refs?.split("\n").some((line) => line.split(/\s/)[0] === group.head);
          if (remoteDurable) remoteIdentity = configuredUrl;
        } catch {
          /* Buffered selected bytes remain available even if remote probing terminates the environment. */
        }
      }
      output.push(...selectedTracked.filter((f) => !remoteDurable || changed.has(local(f.path))));
      const manifestPath = key ? `${key}/supertag-git-output.json` : "supertag-git-output.json";
      if (files.some((f) => f.path === manifestPath))
        throw new Error("Output collides with reserved Git manifest path");
      output.push({
        path: manifestPath,
        mediaType: "application/json",
        bytes: Buffer.from(
          JSON.stringify(
            {
              kind: "selected-git-snapshot",
              head: group.head ?? null,
              baseCommit: previous?.head ?? null,
              repositoryRoot: key,
              paths: selectedTracked.map((f) => f.path),
              remote: remoteIdentity ?? null,
              remoteDurable,
              deleted,
              partial: true,
            },
            null,
            2,
          ),
        ),
      });
    });
  }
  for (const finish of finalize) await finish();
  output.push(...files.filter((f) => !handled.has(f.path)));
  const total = output.reduce((n, f) => n + f.bytes.byteLength, 0);
  if (output.length > config.maxFiles || total > config.maxBytes)
    throw new Error("Output capture including Git manifest exceeds limits");
  return { files: output };
}
