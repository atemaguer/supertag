import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectHarnessArtifacts,
  type HarnessArtifactSource,
  prepareHarnessArtifactCollection,
} from "./src/harness-artifact-collection.js";
import type { EnvironmentAccess, SandboxInstance } from "./src/index.js";
import { listLocalOutputFiles } from "./src/output-files.js";
import { listSandboxOutputFiles } from "./src/sandbox-environment.js";

const roots: string[] = [];
const source: HarnessArtifactSource = {
  id: "visualizations",
  directory: ".codex/visualizations",
  include: ["**"],
  category: "visualization",
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "supertag-harness-artifacts-"));
  roots.push(root);
  const env = {
    rootDirectory: root,
    listOutputFiles: (query: Parameters<typeof listLocalOutputFiles>[1]) =>
      listLocalOutputFiles(root, query),
    readBytes: vi.fn((path: string) => readFile(join(root, path))),
    spawn: vi.fn(() => {
      throw new Error("Harness artifact capture must not invoke Git or commands");
    }),
  } as unknown as EnvironmentAccess;
  const put = async (path: string, content = "value") => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  };
  return { root, env, put };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("harness home artifact collection", () => {
  it("captures only a modified skill bundle and retains its unchanged assets", async () => {
    const { env, put } = await fixture();
    const skills = { id: "skills", directory: ".codex/skills", include: ["**"], bundleDepth: 1 };
    await put(".codex/skills/installed/SKILL.md", "installed");
    await put(".codex/skills/custom/SKILL.md", "old");
    await put(".codex/skills/custom/scripts/helper.py", "helper");
    const baseline = await prepareHarnessArtifactCollection(env, [skills]);
    await put(".codex/skills/custom/SKILL.md", "new");
    const groups = await collectHarnessArtifacts(env, [skills], baseline);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toMatch(/^skills-[a-f0-9]{16}$/);
    expect(groups[0]?.files.map((file) => file.path)).toEqual(
      [".codex/skills/custom/scripts/helper.py", ".codex/skills/custom/SKILL.md"].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    expect((await collectHarnessArtifacts(env, [skills], baseline))[0]?.id).toBe(groups[0]?.id);
  });
  it("isolates Claude project memories and independently authored flat plans", async () => {
    const { env, put } = await fixture();
    const sources = [
      { id: "memories", directory: ".claude/projects", include: ["*/memory/**"], bundleDepth: 2 },
      { id: "plans", directory: ".claude/plans", include: ["*.md"], bundleDepth: 1, submit: true },
    ];
    await put(".claude/projects/a/memory/MEMORY.md", "old");
    await put(".claude/projects/b/memory/MEMORY.md", "old");
    await put(".claude/plans/old.md", "old");
    const baseline = await prepareHarnessArtifactCollection(env, sources);
    await put(".claude/projects/b/memory/topic.md", "new");
    await put(".claude/plans/new.md", "new");
    const groups = await collectHarnessArtifacts(env, sources, baseline);
    expect(groups.map((group) => group.source.id)).toEqual(["memories", "plans"]);
    expect(groups[0]?.files.map((file) => file.path)).toEqual([
      ".claude/projects/b/memory/MEMORY.md",
      ".claude/projects/b/memory/topic.md",
    ]);
    expect(groups[1]?.files.map((file) => file.path)).toEqual([".claude/plans/new.md"]);
  });
  it("ignores unchanged inputs and captures a complete changed bundle including dependencies", async () => {
    const { env, put } = await fixture();
    await put(".codex/visualizations/chart/index.html", "old");
    await put(".codex/visualizations/chart/data.json", "data");
    const baseline = await prepareHarnessArtifactCollection(env, [source]);
    expect(await collectHarnessArtifacts(env, [source], baseline)).toEqual([]);
    await put(".codex/visualizations/chart/index.html", "new");
    await put("repository/source.ts", "Git owns this");
    await put(".codex/auth.json", "credentials");
    const [group] = await collectHarnessArtifacts(env, [source], baseline);
    expect(group?.source).toEqual(source);
    expect(group?.files.map((file) => file.path)).toEqual([
      ".codex/visualizations/chart/data.json",
      ".codex/visualizations/chart/index.html",
    ]);
    expect(env.spawn).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(env.readBytes)
        ?.mock.calls.some(([path]) => path.includes("auth.json") || path.startsWith("repository")),
    ).toBe(false);
  });
  it("handles missing directories and outputs created for the first time", async () => {
    const { env, put } = await fixture();
    const baseline = await prepareHarnessArtifactCollection(env, [source]);
    expect(await collectHarnessArtifacts(env, [source], baseline)).toEqual([]);
    await put(".codex/visualizations/new.html", "new");
    expect((await collectHarnessArtifacts(env, [source], baseline))[0]?.files).toHaveLength(1);
  });
  it("detects removed bundle members but emits no empty artifact", async () => {
    const { env, put, root } = await fixture();
    await put(".codex/visualizations/a.html");
    await put(".codex/visualizations/b.html");
    const baseline = await prepareHarnessArtifactCollection(env, [source]);
    await rm(join(root, ".codex/visualizations/b.html"));
    expect((await collectHarnessArtifacts(env, [source], baseline))[0]?.files).toHaveLength(1);
    await rm(join(root, ".codex/visualizations/a.html"));
    expect(await collectHarnessArtifacts(env, [source], baseline)).toEqual([]);
  });
  it("prunes unrelated transcript directories and excluded data before reads", async () => {
    const { env, put } = await fixture();
    const memory = {
      id: "memory",
      directory: ".claude/projects",
      include: ["*/memory/**"],
      exclude: ["*/memory/private/**"],
    };
    await Promise.all(
      Array.from({ length: 110 }, (_, i) =>
        put(`.claude/projects/project/session/transcript-${i}.jsonl`),
      ),
    );
    await put(".claude/projects/project/memory/MEMORY.md");
    await put(".claude/projects/project/memory/private/secret");
    await put(".claude/projects/project/memory/.env", "secret");
    const baseline = await prepareHarnessArtifactCollection(env, [memory]);
    expect(Object.keys(baseline.sources.memory?.digests ?? {})).toEqual([
      ".claude/projects/project/memory/MEMORY.md",
    ]);
    expect(vi.mocked(env.readBytes)?.mock.calls.every(([path]) => path.endsWith("MEMORY.md"))).toBe(
      true,
    );
  });
  it("fences source selection changes and duplicate ids", async () => {
    const { env } = await fixture();
    const baseline = await prepareHarnessArtifactCollection(env, [source]);
    await expect(
      collectHarnessArtifacts(env, [{ ...source, include: ["*.html"] }], baseline),
    ).rejects.toThrow("changed after baseline");
    await expect(prepareHarnessArtifactCollection(env, [source, source])).rejects.toThrow(
      "duplicate",
    );
  });
  it("requires restored sources to be submitted for exact downstream selection", async () => {
    const { env } = await fixture();
    await expect(
      prepareHarnessArtifactCollection(env, [{ ...source, restore: true }]),
    ).rejects.toThrow("submitted");
    await expect(
      prepareHarnessArtifactCollection(env, [{ ...source, restore: true, submit: true }]),
    ).resolves.toBeDefined();
  });
  it.each(["../escape", "/absolute", ".codex/../auth", ".codex\\memory", ".codex/memory\n", ""])(
    "rejects unsafe source directory %j",
    async (directory) => {
      const { env } = await fixture();
      await expect(
        prepareHarnessArtifactCollection(env, [{ ...source, directory }]),
      ).rejects.toThrow("directory");
      expect(env.readBytes).not.toHaveBeenCalled();
    },
  );
  it("rejects unsafe patterns and selected symlinks", async () => {
    const { env, put, root } = await fixture();
    await expect(
      prepareHarnessArtifactCollection(env, [{ ...source, include: ["../auth.json"] }]),
    ).rejects.toThrow("pattern");
    await put(".codex/visualizations/index.html");
    await symlink("index.html", join(root, ".codex/visualizations/link.html"));
    await expect(prepareHarnessArtifactCollection(env, [source])).rejects.toThrow("symbolic link");
  });
  it.each([
    "../secret",
    ".codex/auth.json",
    ".codex/visualizations/../auth",
    ".codex/visualizations/link\\x",
  ])("rejects lying provider path %j before reading", async (path) => {
    const { env } = await fixture();
    env.listOutputFiles = async () => [{ path, sizeBytes: 1 }];
    await expect(prepareHarnessArtifactCollection(env, [source])).rejects.toThrow("manifest");
    expect(env.readBytes).not.toHaveBeenCalled();
  });
  it("rejects duplicate manifest entries and files changing during capture", async () => {
    const { env } = await fixture();
    const entry = { path: ".codex/visualizations/a", sizeBytes: 1 };
    env.listOutputFiles = async () => [entry, entry];
    env.readBytes = vi.fn(async () => Buffer.from("a"));
    await expect(prepareHarnessArtifactCollection(env, [source])).rejects.toThrow("manifest");
    env.listOutputFiles = async () => [entry];
    env.readBytes = vi
      .fn()
      .mockResolvedValueOnce(Buffer.from("a"))
      .mockResolvedValueOnce(Buffer.from("b"));
    await expect(prepareHarnessArtifactCollection(env, [source])).rejects.toThrow("changed during");
  });
  it("enforces file and byte bounds before reading", async () => {
    const { env } = await fixture();
    env.listOutputFiles = async () => [
      { path: ".codex/visualizations/large", sizeBytes: 32 * 1024 * 1024 + 1 },
    ];
    await expect(prepareHarnessArtifactCollection(env, [source])).rejects.toThrow("byte limit");
    expect(env.readBytes).not.toHaveBeenCalled();
    env.listOutputFiles = async () =>
      Array.from({ length: 101 }, (_, i) => ({ path: `.codex/visualizations/${i}`, sizeBytes: 0 }));
    await expect(prepareHarnessArtifactCollection(env, [source])).rejects.toThrow("file limit");
  });
  it("applies identical selector pruning in real sandbox Python enumeration", async () => {
    const { root, put } = await fixture();
    await put(".claude/projects/project/memory/MEMORY.md", "hello");
    await put(".claude/projects/project/memory/private/secret");
    await Promise.all(
      Array.from({ length: 110 }, (_, i) => put(`.claude/projects/project/session/${i}`)),
    );
    const sandbox = {
      start: async (spec: { command: string; args: string[]; stdin: string }) => ({
        wait: () =>
          new Promise((resolve, reject) => {
            const process = execFile(
              spec.command,
              spec.args,
              { maxBuffer: 1024 * 1024 },
              (error, stdout, stderr) =>
                error ? reject(error) : resolve({ stdout, stderr, exitCode: 0 }),
            );
            process.stdin?.end(spec.stdin);
          }),
      }),
    } as unknown as SandboxInstance;
    const query = {
      roots: [".claude/projects"],
      maxFiles: 1,
      include: ["*/memory/**"],
      exclude: ["*/memory/private/**"],
    };
    expect(await listSandboxOutputFiles(sandbox, root, query)).toEqual(
      await listLocalOutputFiles(root, query),
    );
    expect(await listSandboxOutputFiles(sandbox, root, query)).toEqual([
      { path: ".claude/projects/project/memory/MEMORY.md", sizeBytes: 5 },
    ]);
  });
});
