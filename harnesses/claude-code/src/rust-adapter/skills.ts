import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  copySkill,
  type SelectedSkill,
  skillDirectory,
  skillFrontmatter,
} from "@supertag/worker-sdk/internal/rust-harness";

export { selectSkills } from "@supertag/worker-sdk/internal/rust-harness";

const PLUGIN = "supertag-context";

/**
 * Copies the selected Skills into an isolated plugin. A Skill only a `*` item loaded is left out
 * when Claude Code cannot load it within the Task policy, so one such Skill cannot fail the Task;
 * a named one fails it.
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
      qualified = `${PLUGIN}:${await skillName(join(destination, "SKILL.md"), directory)}`;
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

/** The name Claude Code loads a staged Skill as, refusing frontmatter that widens the Task. */
async function skillName(file: string, directory: string) {
  const metadata = await skillFrontmatter(file);
  if (
    ["hooks", "context", "agent", "allowed-tools", "model", "effort"].some((key) =>
      Object.hasOwn(metadata, key),
    )
  )
    throw new Error("Skill requests execution settings outside the Task policy");
  const { name } = metadata;
  if (
    name !== undefined &&
    (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name))
  )
    throw new Error("Unsupported Skill name");
  return name ?? directory;
}
