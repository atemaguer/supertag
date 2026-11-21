import { cp, lstat, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { parse, stringify } from "yaml";
import { digestContextPackage } from "../index.js";
import type { ResolvedSkill, Task } from "./gen/supertag/runtime/v2/runtime_pb.js";

/** The `reference` of a Skill Context Item that loads every Skill available to the Task. */
export const SKILL_WILDCARD = "*";
/** The most Skills one Task delivers. */
export const MAX_DELIVERED_SKILLS = 64;
const PACKAGE_LIMITS = { maxFiles: 2048, maxBytes: 64 * 1024 * 1024 };
const itemKey = (setId: string, itemId: string) => JSON.stringify([setId, itemId]);

/** A delivered Skill, and whether a Context Item names it rather than only a `*` item. */
export type SelectedSkill = { skill: ResolvedSkill; named: boolean };

/**
 * The delivered Skills, one per reference, checked against the Task's accepted Context Items: a
 * named item resolves to its own reference, a `*` item to any number of Skills, and every
 * required item to one.
 */
export function selectSkills(task: Task, delivered: readonly ResolvedSkill[]): SelectedSkill[] {
  const items = new Map(
    task.policySnapshot?.contextSets.flatMap((set) =>
      set.items.map((item) => [itemKey(set.setId, item.itemId), item] as const),
    ),
  );
  const references = new Map<string, SelectedSkill>();
  // The references delivered for each item.
  const seen = new Map<string, Set<string>>();
  for (const skill of delivered) {
    const pin = skill.pin;
    if (!pin) throw new Error("Skill has no resolution pin");
    const key = itemKey(pin.setId, pin.itemId);
    const item = items.get(key);
    if (
      !item ||
      item.itemKey !== pin.itemKey ||
      item.type !== "supertag/skill" ||
      item.version !== 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(pin.digest)
    )
      throw new Error("Skill does not match an accepted Context Item");
    const config = JSON.parse(item.configJson) as {
      reference?: string;
      version?: string | null;
      digest?: string | null;
    };
    const wildcard = config.reference === SKILL_WILDCARD;
    const loaded = seen.get(key) ?? new Set<string>();
    if (loaded.has(pin.reference) || (!wildcard && loaded.size > 0))
      throw new Error("Skill does not match an accepted Context Item");
    loaded.add(pin.reference);
    seen.set(key, loaded);
    if (
      (wildcard
        ? !pin.reference || pin.reference === SKILL_WILDCARD
        : config.reference !== pin.reference) ||
      (config.version ?? pin.version) !== pin.version ||
      (config.digest ?? pin.digest).trim().toLowerCase() !== pin.digest
    )
      throw new Error("Skill does not match its accepted reference");
    const previous = references.get(pin.reference);
    if (
      previous &&
      (previous.skill.pin?.digest !== pin.digest ||
        previous.skill.pin.version !== pin.version ||
        previous.skill.localPath !== skill.localPath)
    )
      throw new Error("Skill has conflicting resolutions");
    references.set(pin.reference, { skill, named: (previous?.named ?? false) || !wildcard });
  }
  for (const [key, item] of items)
    if (item.required && !seen.has(key))
      throw new Error("A required Context Item was not resolved");
  if (references.size > MAX_DELIVERED_SKILLS) throw new Error("Too many Skill packages");
  // Named Skills first, so a name only a `*` item also loads cannot displace them.
  return [...references.values()].sort((a, b) => Number(b.named) - Number(a.named));
}

/** The directory name a staged Skill takes: its reference when that is a plain name. */
export function skillDirectory(skill: ResolvedSkill): string {
  const reference = skill.pin?.reference ?? "";
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(reference)
    ? reference
    : basename(skill.localPath);
}

/**
 * Copies the Worker Host's private copy of a Skill to `destination`, which must not exist,
 * refusing a source the host does not own privately or a copy that differs from its pin.
 */
export async function copySkill(skill: ResolvedSkill, destination: string): Promise<void> {
  const source = skill.localPath;
  if (!isAbsolute(source) || !/^skill-[a-f0-9]{64}$/.test(basename(source)))
    throw new Error("Unsafe resolved Skill path");
  const stat = await lstat(source);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Resolved Skill directory is not privately owned");
  if ((await digestContextPackage(source, PACKAGE_LIMITS)) !== skill.pin?.digest)
    throw new Error("Resolved Skill differs from its pin");
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  if ((await digestContextPackage(destination, PACKAGE_LIMITS)) !== skill.pin?.digest)
    throw new Error("Staged Skill differs from its pin");
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** The YAML frontmatter of a `SKILL.md`, or an empty object when it has none. */
export async function skillFrontmatter(file: string): Promise<Record<string, unknown>> {
  const frontmatter = FRONTMATTER.exec(await readFile(file, "utf8"))?.[1];
  const metadata = frontmatter ? (parse(frontmatter, { merge: true }) as unknown) : {};
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Invalid Skill frontmatter");
  return metadata as Record<string, unknown>;
}

/**
 * Replaces the frontmatter of a staged `SKILL.md` with `metadata`, keeping its instructions. The
 * staged copy then differs from the Skill's pin, which still names the package it came from.
 */
export async function replaceSkillFrontmatter(
  file: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const markdown = await readFile(file, "utf8");
  const body = markdown.slice(FRONTMATTER.exec(markdown)?.[0].length ?? 0);
  await writeFile(file, `---\n${stringify(metadata)}---\n${body}`);
}
