/**
 * Git bundles that carry a Workspace between the Worker Host and a remote sandbox. The host builds
 * them from its repository with git data commands only (`rev-parse`, `rev-list`, `pack-objects`):
 * no working tree, so no filter driver, hook, or checkout runs, and no source credential is read.
 * A bundle returned by a sandbox is only parsed here; importing it is delivery's job.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type GitObjects, withoutProviderCredentials } from "./workspace-environment.js";

/**
 * Fixed byte bounds, with no settings. The trusted commit's content goes to `prepare`; Task
 * objects, from the trusted commit to the Task's head, go to `start`; work returned by
 * `finalize` is bounded like a patch.
 */
export const WORKSPACE_BUNDLE_LIMITS = {
  content: 512 * 1024 * 1024,
  checkout: 128 * 1024 * 1024,
  returned: 32 * 1024 * 1024,
} as const;

/** The single ref a trusted-content bundle carries. */
export const TRUSTED_BUNDLE_REF = "refs/supertag/trusted";
/** The single ref a Task-objects bundle carries. */
export const CHECKOUT_BUNDLE_REF = "refs/supertag/head";

/** The parsed header of a git bundle (v2 or v3). */
export interface GitBundleHeader {
  readonly version: 2 | 3;
  readonly objectFormat: "sha1" | "sha256";
  readonly prerequisites: readonly string[];
  readonly refs: readonly { readonly name: string; readonly oid: string }[];
  /** Byte offset of the pack data after the header. */
  readonly packOffset: number;
}

const HEADER_LIMIT = 64 * 1024;

/**
 * Parses a bundle header without git. Refuses capabilities other than `object-format`, object
 * IDs of the wrong length, and ref names with whitespace or control characters.
 */
export function parseGitBundleHeader(bytes: Uint8Array): GitBundleHeader {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, HEADER_LIMIT)));
  const end = head.indexOf("\n\n");
  if (end < 0) throw new Error("Git bundle header is missing or too long");
  const lines = head.subarray(0, end).toString("utf8").split("\n");
  const signature = lines.shift();
  const version = signature === "# v2 git bundle" ? 2 : signature === "# v3 git bundle" ? 3 : 0;
  if (version === 0) throw new Error("Not a git bundle");
  let objectFormat: "sha1" | "sha256" = "sha1";
  const prerequisites: string[] = [];
  const refs: { name: string; oid: string }[] = [];
  for (const line of lines) {
    if (line.startsWith("@")) {
      if (version !== 3) throw new Error("Git bundle v2 has a capability line");
      const capability = /^@object-format=(sha1|sha256)$/u.exec(line);
      if (!capability)
        throw new Error(`Git bundle has unsupported capability ${line.slice(0, 80)}`);
      objectFormat = capability[1] as "sha1" | "sha256";
      continue;
    }
    if (line.startsWith("-")) {
      const oid = line.slice(1).split(" ", 1)[0] ?? "";
      prerequisites.push(oid);
      continue;
    }
    const match = /^([0-9a-f]+) (\S+)$/u.exec(line);
    if (
      !match ||
      [...(match[2] as string)].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new Error("Git bundle has an invalid ref line");
    refs.push({ oid: match[1] as string, name: match[2] as string });
  }
  const length = objectFormat === "sha1" ? 40 : 64;
  for (const oid of [...prerequisites, ...refs.map((ref) => ref.oid)])
    if (oid.length !== length || !/^[0-9a-f]+$/u.test(oid))
      throw new Error("Git bundle has an invalid object ID");
  return { version, objectFormat, prerequisites, refs, packOffset: end + 2 };
}

/**
 * Checks the bytes a sandbox returned before they reach the host's disk as a bundle: at most
 * {@link WORKSPACE_BUNDLE_LIMITS.returned} bytes, a valid header, and exactly one ref, the Task
 * branch, at the head the sandbox reported. Delivery still runs `git bundle verify`, fsck, and
 * the ancestry check against the host repository.
 */
export function checkReturnedBundle(
  bytes: Uint8Array,
  expected: { readonly branch: string; readonly head: string },
): GitBundleHeader {
  if (bytes.byteLength > WORKSPACE_BUNDLE_LIMITS.returned)
    throw new Error(
      `Returned Workspace bundle is ${bytes.byteLength} bytes, over the ${WORKSPACE_BUNDLE_LIMITS.returned}-byte limit`,
    );
  const header = parseGitBundleHeader(bytes);
  const ref = `refs/heads/${expected.branch}`;
  if (header.refs.length !== 1 || header.refs[0]?.name !== ref)
    throw new Error(
      `Returned Workspace bundle must carry exactly one ref, ${ref}; it carries ${header.refs.map((item) => item.name).join(", ") || "none"}`,
    );
  if (header.refs[0].oid !== expected.head)
    throw new Error("Returned Workspace bundle's ref does not point at the reported head");
  return header;
}

export interface WorkspaceBundleInput {
  /** The host repository: a managed bare clone, or any repository holding the commits. */
  readonly repository: string;
  readonly trustedCommit: string;
  /** Host directory the bundle file is written to, with mode 0600. */
  readonly directory: string;
  /** Git executable. Default: `git` on PATH. */
  readonly git?: string;
}

/**
 * A shallow bundle of the trusted commit alone: its commit, tree, and blobs, with no parents and
 * no prerequisites, under {@link TRUSTED_BUNDLE_REF}. A sandbox fetches it after recording the
 * commit as shallow. Refused above {@link WORKSPACE_BUNDLE_LIMITS.content}.
 */
export async function bundleTrustedCommit(input: WorkspaceBundleInput): Promise<GitObjects> {
  const git = input.git ?? "git";
  const trusted = await resolveCommit(git, input.repository, input.trustedCommit);
  const format = await objectFormat(git, input.repository);
  const objects = await gitText(git, input.repository, [
    "rev-list",
    "--objects",
    "--no-walk",
    trusted,
  ]);
  return writeBundle({
    git,
    repository: input.repository,
    directory: input.directory,
    header: bundleHeader(format, [], [{ oid: trusted, name: TRUSTED_BUNDLE_REF }]),
    packArgs: ["pack-objects", "--stdout", "-q"],
    stdin: objects,
    limit: WORKSPACE_BUNDLE_LIMITS.content,
    what: `Trusted commit ${trusted.slice(0, 12)}`,
  });
}

/**
 * The objects a sandbox prepared at the trusted commit needs to reach `head`: a thin bundle of
 * `trustedCommit..head` under {@link CHECKOUT_BUNDLE_REF}, whose only prerequisite is the trusted
 * commit. Undefined when `head` is the trusted commit. Refused when `head` does not descend from
 * the trusted commit, when its history reaches older commits other than through it (the sandbox
 * holds only the trusted commit), or above {@link WORKSPACE_BUNDLE_LIMITS.checkout}.
 */
export async function bundleTaskObjects(
  input: WorkspaceBundleInput & { readonly head: string },
): Promise<GitObjects | undefined> {
  const git = input.git ?? "git";
  const trusted = await resolveCommit(git, input.repository, input.trustedCommit);
  const head = await resolveCommit(git, input.repository, input.head);
  if (head === trusted) return undefined;
  await gitText(git, input.repository, ["merge-base", "--is-ancestor", trusted, head]).catch(() => {
    throw new Error(
      `Task head ${head.slice(0, 12)} does not descend from trusted commit ${trusted.slice(0, 12)}`,
    );
  });
  const boundary = (
    await gitText(git, input.repository, ["rev-list", "--boundary", head, `^${trusted}`])
  )
    .split("\n")
    .filter((line) => line.startsWith("-"))
    .map((line) => line.slice(1).trim());
  const outside = boundary.filter((oid) => oid !== trusted);
  if (outside.length > 0)
    throw new Error(
      `Task head ${head.slice(0, 12)} reaches history before trusted commit ${trusted.slice(0, 12)} other than through it (such as a merge of an older branch, at ${outside[0]?.slice(0, 12)}); a remote Workspace sandbox holds only the trusted commit`,
    );
  const format = await objectFormat(git, input.repository);
  return writeBundle({
    git,
    repository: input.repository,
    directory: input.directory,
    header: bundleHeader(format, [trusted], [{ oid: head, name: CHECKOUT_BUNDLE_REF }]),
    packArgs: ["pack-objects", "--revs", "--thin", "--stdout", "-q"],
    stdin: `${head}\n^${trusted}\n`,
    limit: WORKSPACE_BUNDLE_LIMITS.checkout,
    what: `Task objects from ${trusted.slice(0, 12)} to ${head.slice(0, 12)}`,
  });
}

/**
 * Reads a host bundle file whose digest the caller recorded, refusing a file above `limit` or one
 * whose bytes no longer match.
 */
export async function readGitObjects(objects: GitObjects, limit: number): Promise<Uint8Array> {
  const handle = await open(objects.bundle, "r");
  try {
    const { size } = await handle.stat();
    if (size > limit)
      throw new Error(`Workspace bundle ${objects.bundle} is over the ${limit}-byte limit`);
    const bytes = new Uint8Array(await readFile(handle));
    if (bytes.byteLength > limit)
      throw new Error(`Workspace bundle ${objects.bundle} is over the ${limit}-byte limit`);
    if (gitObjectsDigest(bytes) !== objects.digest)
      throw new Error(`Workspace bundle ${objects.bundle} does not match its recorded digest`);
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * The header of a host bundle file whose digest the caller recorded, streaming the file once to
 * check its digest and size instead of holding it in memory.
 */
export async function readGitObjectsHeader(
  objects: GitObjects,
  limit: number,
): Promise<GitBundleHeader> {
  const handle = await open(objects.bundle, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let head = Buffer.alloc(0);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit)
        throw new Error(`Workspace bundle ${objects.bundle} is over the ${limit}-byte limit`);
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      if (head.byteLength < HEADER_LIMIT)
        head = Buffer.concat([head, bytes.subarray(0, HEADER_LIMIT - head.byteLength)]);
    }
    if (`sha256:${hash.digest("hex")}` !== objects.digest)
      throw new Error(`Workspace bundle ${objects.bundle} does not match its recorded digest`);
    return parseGitBundleHeader(head);
  } finally {
    await handle.close();
  }
}

/** `sha256:<hex>` of bundle bytes, as {@link GitObjects.digest} records it. */
export function gitObjectsDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Writes bytes a sandbox returned to a new private host file, after {@link checkReturnedBundle}.
 */
export async function writeReturnedBundle(
  directory: string,
  bytes: Uint8Array,
): Promise<GitObjects> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `returned-${randomUUID()}.bundle`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return { bundle: path, digest: gitObjectsDigest(bytes) };
}

function bundleHeader(
  format: "sha1" | "sha256",
  prerequisites: readonly string[],
  refs: readonly { readonly oid: string; readonly name: string }[],
): string {
  return [
    format === "sha1" ? "# v2 git bundle" : "# v3 git bundle",
    ...(format === "sha1" ? [] : ["@object-format=sha256"]),
    ...prerequisites.map((oid) => `-${oid}`),
    ...refs.map((ref) => `${ref.oid} ${ref.name}`),
    "",
    "",
  ].join("\n");
}

/** Streams `git pack-objects` behind a header into a private file named by its digest. */
async function writeBundle(input: {
  readonly git: string;
  readonly repository: string;
  readonly directory: string;
  readonly header: string;
  readonly packArgs: readonly string[];
  readonly stdin: string;
  readonly limit: number;
  readonly what: string;
}): Promise<GitObjects> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const temporary = join(input.directory, `.bundle-${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  let total = 0;
  const write = (chunk: Buffer) => {
    total += chunk.byteLength;
    hash.update(chunk);
    return output.write(chunk);
  };
  try {
    write(Buffer.from(input.header, "utf8"));
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(input.git, [...gitPrefix(input.repository), ...input.packArgs], {
        env: bundleGitEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      let failure: Error | undefined;
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        if (total + chunk.byteLength > input.limit) {
          failure = new Error(
            `${input.what} exceed the ${input.limit}-byte Workspace bundle limit`,
          );
          child.kill("SIGKILL");
          return;
        }
        if (!write(chunk)) {
          child.stdout.pause();
          output.once("drain", () => child.stdout.resume());
        }
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new Error(`git pack-objects failed for ${input.what}: ${stderr.trim()}`));
        else resolvePromise();
      });
      child.stdin.end(input.stdin);
    });
    await new Promise<void>((resolvePromise, reject) =>
      output.end((error?: Error | null) => (error ? reject(error) : resolvePromise())),
    );
    const digest = `sha256:${hash.digest("hex")}`;
    const path = join(input.directory, `${digest.slice(7)}.bundle`);
    await rename(temporary, path);
    return { bundle: path, digest };
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}

async function resolveCommit(git: string, repository: string, commit: string): Promise<string> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(commit))
    throw new Error(`Workspace bundles take full commit IDs, not ${JSON.stringify(commit)}`);
  const resolved = (
    await gitText(git, repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${commit}^{commit}`,
    ]).catch(() => "")
  ).trim();
  if (resolved !== commit) throw new Error(`Commit ${commit.slice(0, 12)} is not in ${repository}`);
  return resolved;
}

async function objectFormat(git: string, repository: string): Promise<"sha1" | "sha256"> {
  const format = (await gitText(git, repository, ["rev-parse", "--show-object-format"])).trim();
  if (format !== "sha1" && format !== "sha256")
    throw new Error(`Unsupported git object format ${format}`);
  return format;
}

function gitText(git: string, repository: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      git,
      [...gitPrefix(repository), ...args],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: bundleGitEnvironment() },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(`git ${args[0]} failed: ${(stderr || error.message).trim().slice(0, 500)}`),
          );
        else resolvePromise(stdout);
      },
    );
  });
}

/** Repository-local config only, no hooks, no filesystem monitor. */
function gitPrefix(repository: string): string[] {
  return ["-C", repository, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
}

/** No global or system config, no prompts, and no source or provider credential variables. */
export function bundleGitEnvironment(
  base: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...withoutProviderCredentials(base),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  delete environment["SUPERTAG_GIT_USERNAME"];
  delete environment["SUPERTAG_GIT_PASSWORD"];
  return environment;
}
