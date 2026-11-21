import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  copySkill,
  type SelectedSkill,
  skillDirectory,
  skillFrontmatter,
} from "@supertag/worker-sdk/internal/rust-harness";
import type { OpenCodeSkills } from "../index.js";

/** The Skill OpenCode itself provides, which a Task never gets. */
const BUILT_IN = "customize-opencode";

/**
 * Copies the selected Skills into `root`, which OpenCode loads with its `skills.paths`
 * configuration; it finds no other Skill. OpenCode names a Skill by its frontmatter `name` and
 * finds every `SKILL.md` under the path, so a Skill needs a name no other has and holds no nested
 * `SKILL.md`. A Skill only a `*` item loaded is left out when it does not meet these, so one such
 * Skill cannot fail the Task; a named one fails it.
 */
export async function stageOpenCodeSkills(
  selected: readonly SelectedSkill[],
  root: string,
  signal: AbortSignal | undefined,
): Promise<OpenCodeSkills | undefined> {
  if (!selected.length) return undefined;
  await mkdir(root, { mode: 0o700 });
  const names: string[] = [];
  for (const { skill, named } of selected) {
    signal?.throwIfAborted();
    const destination = join(root, skillDirectory(skill));
    await copySkill(skill, destination);
    try {
      const { name } = await skillFrontmatter(join(destination, "SKILL.md"));
      if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))
        throw new Error("OpenCode needs a Skill name of letters, digits, '.', '_', and '-'");
      if (name === BUILT_IN || names.includes(name)) throw new Error("Duplicate Skill name");
      if (await nestedInstructions(destination, ""))
        throw new Error("Skill holds another SKILL.md");
      names.push(name);
    } catch (error) {
      if (named) throw error;
      await rm(destination, { recursive: true, force: true });
    }
  }
  signal?.throwIfAborted();
  return names.length ? { root, names } : undefined;
}

async function nestedInstructions(directory: string, relative: string): Promise<boolean> {
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (await nestedInstructions(directory, path)) return true;
    } else if (entry.name === "SKILL.md" && relative) return true;
  }
  return false;
}
