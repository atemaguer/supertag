import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { digestContextPackage } from "@supertag/worker-sdk";
import type { ResolvedSkill, Task } from "@supertag/worker-sdk/internal/rust-harness";
import { parse } from "yaml";

const PLUGIN = "supertag-context";
const PACKAGE_LIMITS = { maxFiles: 2048, maxBytes: 64 * 1024 * 1024 };
const itemKey = (setId: string, itemId: string) => JSON.stringify([setId, itemId]);

export function selectSkills(task: Task, delivered: readonly ResolvedSkill[]) {
  const items = new Map(
    task.policySnapshot?.contextSets.flatMap((set) =>
      set.items.map((item) => [itemKey(set.setId, item.itemId), item] as const),
    ),
  );
  const references = new Map<string, ResolvedSkill>();
  const seen = new Set<string>();
  for (const skill of delivered) {
    const pin = skill.pin;
    if (!pin) throw new Error("Skill has no resolution pin");
    const key = itemKey(pin.setId, pin.itemId);
    const item = items.get(key);
    if (
      !item ||
      seen.has(key) ||
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
    if (
      config.reference !== pin.reference ||
      (config.version ?? pin.version) !== pin.version ||
      (config.digest ?? pin.digest).trim().toLowerCase() !== pin.digest
    )
      throw new Error("Skill does not match its accepted reference");
    const previous = references.get(pin.reference);
    if (
      previous &&
      (previous.pin?.digest !== pin.digest ||
        previous.pin.version !== pin.version ||
        previous.localPath !== skill.localPath)
    )
      throw new Error("Skill has conflicting resolutions");
    seen.add(key);
    references.set(pin.reference, skill);
  }
  for (const [key, item] of items)
    if (item.required && !seen.has(key))
      throw new Error("A required Context Item was not resolved");
  return [...references.values()];
}

export async function stageSkills(
  selected: readonly ResolvedSkill[],
  scratch: string,
  signal: AbortSignal,
) {
  const names = new Set<string>();
  const roots: string[] = [];
  if (!selected.length) return { plugins: [], names, roots };
  if (selected.length > 64) throw new Error("Too many Skill packages");
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
  for (const skill of selected) {
    signal.throwIfAborted();
    const source = skill.localPath;
    const folder = basename(source);
    if (!isAbsolute(source) || !/^skill-[a-f0-9]{64}$/.test(folder))
      throw new Error("Unsafe resolved Skill path");
    const stat = await lstat(source);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Resolved Skill directory is not privately owned");
    const destination = join(packages, folder);
    if ((await digestContextPackage(source, PACKAGE_LIMITS)) !== skill.pin?.digest)
      throw new Error("Resolved Skill differs from its pin");
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
    if ((await digestContextPackage(destination, PACKAGE_LIMITS)) !== skill.pin?.digest)
      throw new Error("Staged Skill differs from its pin");
    const markdown = await readFile(join(destination, "SKILL.md"), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1];
    const metadata = frontmatter ? (parse(frontmatter, { merge: true }) as unknown) : {};
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
      throw new Error("Invalid Skill frontmatter");
    if (
      ["hooks", "context", "agent", "allowed-tools", "model", "effort"].some((key) =>
        Object.hasOwn(metadata, key),
      )
    )
      throw new Error("Skill requests execution settings outside the Task policy");
    const { name } = metadata as { name?: unknown };
    if (
      name !== undefined &&
      (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name))
    )
      throw new Error("Unsupported Skill name");
    const qualified = `${PLUGIN}:${name ?? folder}`;
    if (names.has(qualified)) throw new Error("Duplicate Skill name");
    names.add(qualified);
    roots.push(destination);
  }
  signal.throwIfAborted();
  return {
    plugins: [{ type: "local" as const, path: root, skipMcpDiscovery: true }],
    names,
    roots,
  };
}
