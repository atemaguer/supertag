import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createRepository,
  git,
  isolateGitConfiguration,
} from "../../../tests/support/git-repository.js";
import { pinGitHubSkillCatalog } from "./src/github-skill-catalog.js";

const cleanups: Array<() => Promise<void> | void> = [];
let repository: string;
let root: string;
const catalog = {
  repository: "acme/skills",
  path: "catalog",
  revision: "main",
  skills: ["review"],
};
beforeEach(async () => {
  cleanups.push(await isolateGitConfiguration());
  repository = await createRepository();
  root = await mkdtemp(join(tmpdir(), "supertag-catalog-test-"));
  cleanups.push(() => rm(repository, { recursive: true, force: true }));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("fetches selected Skill files and pins commit and digest across a moved branch", async () => {
  const skill = join(repository, "catalog", "review");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "first");
  await writeFile(join(skill, "example.txt"), "example");
  git(repository, "add", "catalog");
  git(repository, "commit", "--quiet", "-m", "Add Skill");
  const commit = git(repository, "rev-parse", "HEAD");
  const first = await pinGitHubSkillCatalog({
    catalog,
    cache: join(root, "first"),
    sourceUrl: repository,
  });
  const pin = {
    name: "review",
    source: `github:acme/skills/catalog/review@${commit}`,
    digest: first[0]?.source.digest ?? "",
  };
  expect(first[0]?.source.provenance?.["source"]).toBe(pin.source);
  expect(pin.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  await writeFile(join(skill, "SKILL.md"), "second");
  git(repository, "add", "catalog");
  git(repository, "commit", "--quiet", "-m", "Change Skill");
  const second = await pinGitHubSkillCatalog({
    catalog,
    cache: join(root, "second"),
    expected: [pin],
    sourceUrl: repository,
  });
  expect(await readFile(join(fileURLToPath(second[0]?.source.uri ?? ""), "SKILL.md"), "utf8")).toBe(
    "first",
  );
  expect(second[0]?.source.digest).toBe(pin.digest);
});

test("uses Git file modes for the digest regardless of host umask", async () => {
  const skill = join(repository, "catalog", "review");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "Review this change.");
  await writeFile(join(skill, "check.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(skill, "SKILL.md"), 0o644);
  await chmod(join(skill, "check.sh"), 0o755);
  git(repository, "add", "catalog");
  git(repository, "commit", "--quiet", "-m", "Add executable Skill file");

  const originalUmask = process.umask();
  try {
    process.umask(0o077);
    const restrictive = await pinGitHubSkillCatalog({
      catalog,
      cache: join(root, "restrictive"),
      sourceUrl: repository,
    });
    process.umask(0o022);
    const ordinary = await pinGitHubSkillCatalog({
      catalog,
      cache: join(root, "ordinary"),
      sourceUrl: repository,
    });
    expect(restrictive[0]?.source.digest).toBe(ordinary[0]?.source.digest);
    for (const entry of [restrictive[0], ordinary[0]]) {
      const path = fileURLToPath(entry?.source.uri ?? "");
      expect((await stat(join(path, "SKILL.md"))).mode & 0o777).toBe(0o644);
      expect((await stat(join(path, "check.sh"))).mode & 0o777).toBe(0o755);
    }
    git(repository, "update-index", "--chmod=-x", "catalog/review/check.sh");
    git(repository, "commit", "--quiet", "-m", "Remove executable bit");
    const nonExecutable = await pinGitHubSkillCatalog({
      catalog,
      cache: join(root, "non-executable"),
      sourceUrl: repository,
    });
    expect(nonExecutable[0]?.source.digest).not.toBe(ordinary[0]?.source.digest);
    expect(
      (await stat(join(fileURLToPath(nonExecutable[0]?.source.uri ?? ""), "check.sh"))).mode &
        0o777,
    ).toBe(0o644);
  } finally {
    process.umask(originalUmask);
  }
});

test("reports recovery options when a pinned commit is unavailable on a new host", async () => {
  const skill = join(repository, "catalog", "review");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "Review this change.");
  git(repository, "add", "catalog");
  git(repository, "commit", "--quiet", "-m", "Add Skill");
  const commit = git(repository, "rev-parse", "HEAD");
  const first = await pinGitHubSkillCatalog({
    catalog,
    cache: join(root, "original-host"),
    sourceUrl: repository,
  });
  const expected = [
    {
      name: "review",
      source: `github:acme/skills/catalog/review@${commit}`,
      digest: first[0]?.source.digest ?? "",
    },
  ];
  await expect(
    pinGitHubSkillCatalog({
      catalog,
      cache: join(root, "new-host"),
      expected,
      sourceUrl: join(root, "unavailable-repository"),
    }),
  ).rejects.toThrow(
    new RegExp(
      `acme/skills at ${commit}.*Skill review.*not available on this Worker Host.*restore the commit.*original host.*new Task to re-pin`,
      "u",
    ),
  );
});

test("reports missing Skills, invalid revisions, and inaccessible repositories", async () => {
  const input = { catalog, sourceUrl: repository };
  await expect(pinGitHubSkillCatalog({ ...input, cache: join(root, "missing") })).rejects.toThrow(
    /Skill review is missing/u,
  );
  await expect(
    pinGitHubSkillCatalog({
      ...input,
      catalog: { ...catalog, revision: "absent" },
      cache: join(root, "revision"),
    }),
  ).rejects.toThrow(/cannot fetch revision absent/u);
  await expect(
    pinGitHubSkillCatalog({
      ...input,
      sourceUrl: join(root, "no-repository"),
      cache: join(root, "inaccessible"),
    }),
  ).rejects.toThrow(/Worker Host GitHub access/u);
});
