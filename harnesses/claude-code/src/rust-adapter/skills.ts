import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  copySkill,
  replaceSkillFrontmatter,
  type SelectedSkill,
  skillDirectory,
  skillFrontmatter,
} from "@supertag/worker-sdk/internal/rust-harness";

export { selectSkills } from "@supertag/worker-sdk/internal/rust-harness";

const PLUGIN = "supertag-context";

/**
 * Frontmatter that makes Claude Code run a command or start another agent for a Skill. A Task
 * loads no Skill that sets one.
 */
const REFUSED = ["hooks", "context", "agent"];

/**
 * The frontmatter a staged Skill keeps: what describes it. Claude Code acts on other keys, such
 * as `allowed-tools`, which approves tools, `model` and `effort`, which change how the turn runs,
 * and `user-invocable`, which hides the Skill from the listing the adapter verifies. The staged
 * copy drops those and every key not listed here, so a Skill adds nothing to a Task but
 * instructions it can read.
 */
const KEPT = new Set([
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "arguments",
  "license",
  "compatibility",
  "metadata",
  "version",
]);

/**
 * Copies the selected Skills into an isolated plugin, each with only its descriptive frontmatter.
 * A Skill only a `*` item loaded is left out when Claude Code cannot load it within the Task
 * policy, so one such Skill cannot fail the Task; a named one fails it.
 */
export async function stageSkills(
  selected: readonly SelectedSkill[],
  scratch: string,
  signal: AbortSignal,
) {
  const names = new Set<string>();
  const roots: string[] = [];
  if (!selected.length) return { plugins: [], names, roots };
  const root = join(scratch, PLUGIN);
  await mkdir(root, { mode: 0o700 });
  const manifest = join(root, ".claude-plugin");
  const packages = join(root, "skills");
  await mkdir(manifest, { mode: 0o700 });
  await mkdir(packages, { mode: 0o700 });
  await writeFile(join(manifest, "plugin.json"), JSON.stringify({ name: PLUGIN, version: "1" }), {
    flag: "wx",
    mode: 0o600,
  });
  for (const { skill, named } of selected) {
    signal.throwIfAborted();
    const directory = skillDirectory(skill);
    const destination = join(packages, directory);
    await copySkill(skill, destination);
    let qualified: string;
    try {
      qualified = `${PLUGIN}:${await skillName(join(destination, "SKILL.md"), directory, named)}`;
      if (names.has(qualified)) throw new Error("Duplicate Skill name");
    } catch (error) {
      if (named) throw error;
      await rm(destination, { recursive: true, force: true });
      continue;
    }
    names.add(qualified);
    roots.push(destination);
  }
  signal.throwIfAborted();
  if (!names.size) return { plugins: [], names, roots };
  return {
    plugins: [{ type: "local" as const, path: root, skipMcpDiscovery: true }],
    names,
    roots,
  };
}

/**
 * The name Claude Code loads a staged Skill as. Refuses frontmatter that runs code or another
 * agent, and rewrites the staged file without the settings Claude Code would otherwise act on.
 * `disable-model-invocation: true` marks a Skill for a person to start, and no person starts one
 * in a Task: a `*` item leaves such a Skill out, and an item that names it loads it, since its
 * operator chose it.
 */
async function skillName(file: string, directory: string, named: boolean) {
  const metadata = await skillFrontmatter(file);
  if (REFUSED.some((key) => Object.hasOwn(metadata, key)))
    throw new Error("Skill requests execution settings outside the Task policy");
  const manual = metadata["disable-model-invocation"];
  if (!named && (manual === true || manual === "true"))
    throw new Error("Skill sets disable-model-invocation, so only a person may start it");
  const kept = Object.entries(metadata).filter(([key]) => KEPT.has(key));
  if (kept.length !== Object.keys(metadata).length)
    await replaceSkillFrontmatter(file, Object.fromEntries(kept));
  const { name } = metadata;
  if (
    name !== undefined &&
    (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name))
  )
    throw new Error("Unsupported Skill name");
  return name ?? directory;
}
