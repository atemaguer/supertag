import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { digestContextPackage, type SkillInput } from "./index.js";

interface PinnedSkill {
  readonly name: string;
  readonly source: string;
  readonly digest: string;
}

/** Snapshot repository Skills outside the Task worktree so later edits cannot change them. */
export async function pinWorkspaceSkills(input: {
  readonly checkout: string;
  readonly cache: string;
  readonly names: readonly string[];
  readonly expected?: readonly PinnedSkill[];
}): Promise<readonly SkillInput[]> {
  let pinned: readonly PinnedSkill[];
  try {
    pinned = JSON.parse(
      await readFile(join(input.cache, "manifest.json"), "utf8"),
    ) as PinnedSkill[];
    if (JSON.stringify(pinned.map((entry) => entry.name)) !== JSON.stringify(input.names))
      throw new Error("Workspace Skill selection changed after Task start");
  } catch (error) {
    if (!isMissing(error)) throw error;
    const temporary = `${input.cache}.new-${process.pid}`;
    await mkdir(dirname(input.cache), { recursive: true });
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary);
    try {
      const entries: PinnedSkill[] = [];
      for (const name of input.names) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u.test(name))
          throw new Error(`Invalid Workspace Skill name ${JSON.stringify(name)}`);
        const source = await findSkill(input.checkout, name);
        const original = join(input.checkout, source);
        const digest = await digestContextPackage(original, {
          maxFiles: 2_048,
          maxBytes: 64 * 1024 * 1024,
        });
        const target = join(temporary, name);
        await cp(original, target, { recursive: true, dereference: false });
        if (
          (await digestContextPackage(target, { maxFiles: 2_048, maxBytes: 64 * 1024 * 1024 })) !==
          digest
        )
          throw new Error(`Workspace Skill ${name} changed while being pinned`);
        if (!(await lstat(join(target, "SKILL.md"))).isFile())
          throw new Error(`Workspace Skill ${name} needs SKILL.md`);
        entries.push({ name, source, digest });
      }
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(entries));
      await rename(temporary, input.cache);
      pinned = entries;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  if (input.expected !== undefined && JSON.stringify(pinned) !== JSON.stringify(input.expected))
    throw new Error("Workspace Skills differ from this Task's pinned source or digest");
  return Promise.all(
    pinned.map(async (entry): Promise<SkillInput> => {
      if (!input.names.includes(entry.name) || !/^sha256:[a-f0-9]{64}$/u.test(entry.digest))
        throw new Error("Invalid pinned Workspace Skill manifest");
      const path = join(input.cache, entry.name);
      if (
        (await digestContextPackage(path, { maxFiles: 2_048, maxBytes: 64 * 1024 * 1024 })) !==
        entry.digest
      )
        throw new Error(`Pinned Workspace Skill ${entry.name} changed`);
      return {
        id: `skill:${entry.name}`,
        kind: "skill",
        required: true,
        source: {
          uri: pathToFileURL(path).href,
          digest: entry.digest,
          provenance: { provider: "supertag-workspace", source: entry.source },
        },
      };
    }),
  );
}

async function findSkill(checkout: string, name: string): Promise<string> {
  for (const directory of [".claude/skills", ".agents/skills"]) {
    const source = `${directory}/${name}`;
    const path = join(checkout, source);
    if (!(await lstat(path).catch(() => undefined))?.isDirectory()) continue;
    const root = await realpath(checkout);
    const resolved = await realpath(path);
    const inside = relative(root, resolved);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new Error(`Workspace Skill ${name} leaves the host checkout`);
    return source;
  }
  throw new Error(`Workspace Skill ${name} is missing from .claude/skills and .agents/skills`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
