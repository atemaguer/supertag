import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkspaceSkillCatalog } from "@supertag/core";
import { digestContextPackage, type SkillInput } from "./index.js";
import { credentialArguments, type GitSourceCredential } from "./workspace-environment.js";

export interface CatalogSkillPin {
  readonly name: string;
  readonly source: string;
  readonly digest: string;
}

/** Fetches only selected skill trees from an exact Git commit and saves a Task-owned snapshot. */
export async function pinGitHubSkillCatalog(input: {
  readonly catalog: WorkspaceSkillCatalog;
  readonly cache: string;
  readonly expected?: readonly CatalogSkillPin[];
  readonly credential?: GitSourceCredential | undefined;
  /** A configured source credential resolver owns access decisions when present. */
  readonly useEnvironmentToken?: boolean;
  readonly git?: string;
  /** Local git fixture override for tests. Production uses the GitHub HTTPS URL. */
  readonly sourceUrl?: string;
}): Promise<readonly SkillInput[]> {
  const { catalog, cache, expected } = input;
  const url = input.sourceUrl ?? `https://github.com/${catalog.repository}.git`;
  const pinnedCommit = expected?.[0]?.source.match(/@([0-9a-f]{40})$/u)?.[1];
  if (
    expected &&
    (!pinnedCommit ||
      expected.length !== catalog.skills.length ||
      expected.some(
        (pin, index) =>
          pin.name !== catalog.skills[index] ||
          pin.source !== `github:${catalog.repository}/${catalog.path}/${pin.name}@${pinnedCommit}`,
      ))
  )
    throw new Error("Invalid pinned GitHub Skill catalog source or commit");
  let pins: CatalogSkillPin[];
  try {
    pins = JSON.parse(await readFile(join(cache, "manifest.json"), "utf8")) as CatalogSkillPin[];
  } catch (error) {
    if (!isMissing(error)) throw error;
    const temporary = `${cache}.new-${process.pid}`;
    const gitDirectory = await mkdtemp(join(tmpdir(), "supertag-skill-catalog-"));
    await mkdir(dirname(cache), { recursive: true });
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary);
    try {
      await git(input, gitDirectory, ["init", "--bare", "--quiet"]);
      const revision = pinnedCommit ?? catalog.revision;
      try {
        await git(input, gitDirectory, [
          "fetch",
          "--quiet",
          "--no-tags",
          "--depth=1",
          "--filter=blob:none",
          url,
          revision,
        ]);
      } catch {
        if (expected) {
          throw new Error(
            `GitHub Skill catalog ${catalog.repository} at ${revision}: pinned contents for Skill ${expected.map((pin) => pin.name).join(", ")} are not available on this Worker Host; restore the commit in the repository, re-run the Task on the original host, or start a new Task to re-pin`,
          );
        }
        throw new Error(
          `GitHub Skill catalog ${catalog.repository}: cannot fetch revision ${revision}; check the revision and Worker Host GitHub access`,
        );
      }
      const commit = (await git(input, gitDirectory, ["rev-parse", "FETCH_HEAD^{commit}"]))
        .toString()
        .trim();
      if (!/^[0-9a-f]{40}$/u.test(commit))
        throw new Error(
          `GitHub Skill catalog ${catalog.repository}: revision ${revision} did not resolve to a commit`,
        );
      pins = [];
      for (const name of catalog.skills) {
        const prefix = `${catalog.path}/${name}`;
        const output = await git(input, gitDirectory, ["ls-tree", "-rz", commit, "--", prefix]);
        const rows = output.toString().split("\0").filter(Boolean);
        if (rows.length === 0)
          throw new Error(
            `GitHub Skill catalog ${catalog.repository} at ${commit}: Skill ${name} is missing under ${catalog.path}`,
          );
        const target = join(temporary, name);
        const gitFiles = new Map<string, { readonly mode: number; readonly content: Buffer }>();
        let bytes = 0;
        if (rows.length > 2048)
          throw new Error(`GitHub Skill catalog Skill ${name} exceeds 2048 files`);
        for (const row of rows) {
          const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(row);
          if (!match?.[3]?.startsWith(`${prefix}/`))
            throw new Error(`GitHub Skill catalog Skill ${name} contains unsupported file type`);
          const child = match[3].slice(prefix.length + 1);
          if (!child || child.split("/").some((part) => part === ".." || part === "."))
            throw new Error(`GitHub Skill catalog Skill ${name} has an unsafe path`);
          const content = await git(input, gitDirectory, ["cat-file", "blob", match[2] ?? ""]);
          const mode = match[1] === "100755" ? 0o755 : 0o644;
          gitFiles.set(child, { mode, content });
          bytes += content.length;
          if (bytes > 64 * 1024 * 1024)
            throw new Error(`GitHub Skill catalog Skill ${name} exceeds 64 MiB`);
          const destination = join(target, child);
          if (relative(target, destination).startsWith(".."))
            throw new Error(`GitHub Skill catalog Skill ${name} has an unsafe path`);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, content);
          // The package digest includes file modes. Git has only regular and executable blobs;
          // normalize both explicitly so the host umask cannot change a Task's pin.
          await chmod(destination, mode);
        }
        try {
          await readFile(join(target, "SKILL.md"));
        } catch {
          throw new Error(`GitHub Skill catalog Skill ${name} needs SKILL.md`);
        }
        const digest = digestGitFiles(gitFiles);
        if (
          digest !==
          (await digestContextPackage(target, { maxFiles: 2048, maxBytes: 64 * 1024 * 1024 }))
        )
          throw new Error(
            `GitHub Skill catalog Skill ${name} could not be materialized faithfully`,
          );
        pins.push({
          name,
          source: `github:${catalog.repository}/${prefix}@${commit}`,
          digest,
        });
      }
      if (expected && JSON.stringify(pins) !== JSON.stringify(expected))
        throw new Error(
          "GitHub Skill catalog contents differ from this Task's pinned commit or digest",
        );
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(pins));
      await rename(temporary, cache);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(gitDirectory, { recursive: true, force: true });
    }
  }
  if (
    JSON.stringify(pins.map((pin) => pin.name)) !== JSON.stringify(catalog.skills) ||
    pins.some((pin) => {
      const prefix = `github:${catalog.repository}/${catalog.path}/${pin.name}`;
      return (
        !/^sha256:[0-9a-f]{64}$/u.test(pin.digest) ||
        !pin.source.startsWith(prefix) ||
        !/^@[0-9a-f]{40}$/u.test(pin.source.slice(prefix.length))
      );
    })
  )
    throw new Error("Invalid pinned GitHub Skill catalog manifest");
  if (expected && JSON.stringify(pins) !== JSON.stringify(expected))
    throw new Error(
      "GitHub Skill catalog contents differ from this Task's pinned commit or digest",
    );
  return Promise.all(
    pins.map(async (pin): Promise<SkillInput> => {
      const path = join(cache, pin.name);
      if (
        (await digestContextPackage(path, { maxFiles: 2048, maxBytes: 64 * 1024 * 1024 })) !==
        pin.digest
      )
        throw new Error(`Pinned GitHub Skill catalog Skill ${pin.name} changed`);
      return {
        id: `skill:${pin.name}`,
        kind: "skill",
        required: true,
        source: {
          uri: pathToFileURL(path).href,
          digest: pin.digest,
          provenance: { provider: "supertag-workspace", source: pin.source },
        },
      };
    }),
  );
}

/** Matches the package digest layout using Git blob bytes and executable bits. */
function digestGitFiles(
  files: ReadonlyMap<string, { readonly mode: number; readonly content: Buffer }>,
): string {
  const children = new Map<string, Set<string>>();
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      const names = children.get(parent) ?? new Set<string>();
      names.add(parts[index] ?? "");
      children.set(parent, names);
    }
  }
  const hash = createHash("sha256");
  const visit = (path: string): void => {
    const file = files.get(path);
    if (file) {
      hash.update(`file\0${path}\0${file.mode}\0${file.content.length}\0`);
      hash.update(file.content);
      hash.update("\0");
      return;
    }
    hash.update(`directory\0${path}\0`);
    for (const name of [...(children.get(path) ?? [])].toSorted()) {
      visit(path ? `${path}/${name}` : name);
    }
  };
  visit("");
  return `sha256:${hash.digest("hex")}`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function git(
  input: {
    readonly git?: string;
    readonly credential?: GitSourceCredential | undefined;
    readonly useEnvironmentToken?: boolean;
  },
  cwd: string,
  args: readonly string[],
): Promise<Buffer> {
  const credential =
    input.credential ??
    (input.useEnvironmentToken !== false && process.env["GITHUB_TOKEN"]
      ? { username: "x-access-token", password: process.env["GITHUB_TOKEN"] }
      : undefined);
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_LFS_SKIP_SMUDGE: "1",
    ...(credential
      ? { SUPERTAG_GIT_USERNAME: credential.username, SUPERTAG_GIT_PASSWORD: credential.password }
      : {}),
  };
  return new Promise((resolve, reject) =>
    execFile(
      input.git ?? "git",
      ["-C", cwd, ...credentialArguments(credential), ...args],
      { encoding: "buffer", maxBuffer: 70 * 1024 * 1024, env },
      (error, stdout) => {
        if (error) reject(new Error(`git ${args[0]} failed`));
        else resolve(stdout as Buffer);
      },
    ),
  );
}
