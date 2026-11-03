import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  ContextResolverRegistry,
  FileSkillResolver,
  mergeWorkspaceSkills,
  type ResolutionContext,
  type SkillInput,
} from "./src/index.js";
import { pinWorkspaceSkills } from "./src/workspace-skills.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("pins an ignored checkout Skill for the whole Task and records source and digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "supertag-skills-"));
  directories.push(root);
  const source = join(root, "checkout", ".claude", "skills", "review");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "first");
  const input = { checkout: join(root, "checkout"), cache: join(root, "cache"), names: ["review"] };
  const first = await pinWorkspaceSkills(input);
  expect(first[0]?.source.provenance).toEqual({
    provider: "supertag-workspace",
    source: ".claude/skills/review",
  });
  expect(first[0]?.source.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  await writeFile(join(source, "SKILL.md"), "changed");
  await expect(
    pinWorkspaceSkills({
      ...input,
      cache: join(root, "other-host"),
      expected: [
        { name: "review", source: ".claude/skills/review", digest: first[0]?.source.digest ?? "" },
      ],
    }),
  ).rejects.toThrow(/pinned source or digest/u);
  const second = await pinWorkspaceSkills(input);
  expect(second).toEqual(first);
  expect(await readFile(join(root, "cache", "review", "SKILL.md"), "utf8")).toBe("first");
  await writeFile(join(root, "cache", "review", "SKILL.md"), "tampered");
  await expect(pinWorkspaceSkills(input)).rejects.toThrow(/changed/u);
});

test("finds .agents Skills and fails closed for missing Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "supertag-skills-"));
  directories.push(root);
  const source = join(root, "checkout", ".agents", "skills", "review");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "review");
  const input = { checkout: join(root, "checkout"), cache: join(root, "cache"), names: ["review"] };
  expect((await pinWorkspaceSkills(input))[0]?.source.provenance?.["source"]).toBe(
    ".agents/skills/review",
  );
  await expect(
    pinWorkspaceSkills({ ...input, cache: join(root, "other"), names: ["missing"] }),
  ).rejects.toThrow(/missing/u);
});

test("Workspace Skill takes precedence over a Context Set Skill with the same name", () => {
  const context = {
    id: "skill:review",
    kind: "skill",
    required: true,
    source: { uri: "file:///catalog/review" },
  } as SkillInput;
  const workspace = { ...context, source: { uri: "file:///workspace/review" } };
  expect(mergeWorkspaceSkills([context], [workspace])).toEqual([workspace]);
});

test("Workspace selection bypasses a missing host catalog entry for the same Skill", async () => {
  const context = {
    task: {
      workspacePlan: { version: 1, status: "workspace", skills: ["review"] },
      contextPlan: {
        sets: [
          {
            items: [
              {
                id: "item-review",
                itemKey: "skill:review",
                type: "supertag/skill",
                version: 1,
                required: true,
                config: { reference: "review" },
              },
            ],
          },
        ],
      },
    },
    profile: {},
  } as unknown as ResolutionContext;
  const registry = new ContextResolverRegistry([]);
  await expect(registry.resolve(context)).resolves.toEqual({ inputs: [], omitted: [] });
});

test("GitHub catalog selection takes precedence over a matching Context Set Skill", async () => {
  const context = {
    task: {
      workspacePlan: {
        version: 1,
        status: "workspace",
        skillCatalog: {
          repository: "acme/skills",
          path: "catalog",
          revision: "main",
          skills: ["review"],
        },
      },
      contextPlan: {
        sets: [
          {
            items: [
              {
                id: "item-review",
                itemKey: "skill:review",
                type: "supertag/skill",
                version: 1,
                required: true,
                config: { reference: "review" },
              },
            ],
          },
        ],
      },
    },
    profile: {},
  } as unknown as ResolutionContext;
  expect(await new ContextResolverRegistry([]).resolve(context)).toEqual({
    inputs: [],
    omitted: [],
  });
});

test("rejects a Skill reached through a checkout symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "supertag-skills-"));
  directories.push(root);
  const outside = join(root, "outside", "review");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "SKILL.md"), "outside");
  await mkdir(join(root, "checkout", ".claude"), { recursive: true });
  await symlink(join(root, "outside"), join(root, "checkout", ".claude", "skills"));
  await expect(
    pinWorkspaceSkills({
      checkout: join(root, "checkout"),
      cache: join(root, "cache"),
      names: ["review"],
    }),
  ).rejects.toThrow(/leaves the host checkout/u);
});

test("host directory catalog resolves Context Set Skills by child directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "supertag-host-skills-"));
  directories.push(root);
  const skill = join(root, "review");
  await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), "review instructions");
  await writeFile(join(root, "README.md"), "catalog notes");
  await mkdir(join(root, ".system"));
  const resolver = await FileSkillResolver.load({ catalogPath: root });
  const input = await resolver.resolve({
    id: "item-review",
    itemKey: "skill:review",
    type: "supertag/skill",
    version: 1,
    required: true,
    config: { reference: "review" },
  });
  expect(input).toMatchObject({
    id: "skill:review",
    kind: "skill",
    source: { digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
  });
});
