import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentAccess, SandboxInstance } from "./src/index.js";
import {
  collectOutputFiles,
  managedOutputPolicy,
  outputPatternMatches,
  prepareOutputCollection,
} from "./src/output-collection.js";
import { listLocalOutputFiles, prepareLocalOutputDirectory } from "./src/output-files.js";
import { listSandboxOutputFiles } from "./src/sandbox-environment.js";

const exec = promisify(execFile),
  roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "supertag-output-test-"));
  roots.push(root);
  const env = {
    rootDirectory: root,
    prepareOutputDirectory: (path: string) => prepareLocalOutputDirectory(root, path),
    listOutputFiles: (q: Parameters<typeof listLocalOutputFiles>[1]) =>
      listLocalOutputFiles(root, q),
    readBytes: (p: string) => readFile(join(root, p)),
    spawn: async (spec: { command: string; args?: readonly string[]; cwd?: string }) => ({
      wait: async () => {
        try {
          const r = await exec(spec.command, [...(spec.args ?? [])], {
            cwd: spec.cwd ?? root,
            maxBuffer: 1024 * 1024,
          });
          return { ...r, exitCode: 0 };
        } catch {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
      },
    }),
  } as unknown as EnvironmentAccess;
  const put = async (p: string, value: string | Buffer) => {
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), value);
  };
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  return { root, env, put, git };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
describe("automatic output collection", () => {
  it("captures only the current Attempt's deliverables and ignores Git-tracked files", async () => {
    const { env, put, git } = await fixture();
    const policy = managedOutputPolicy("attempt-a");
    const other = managedOutputPolicy("attempt-b");
    await git("init");
    await put(`${policy.directory}/tracked.txt`, "tracked");
    await git("add", `${policy.directory}/tracked.txt`);
    const baseline = await prepareOutputCollection(env, policy);
    await put(`${policy.directory}/tracked.txt`, "changed");
    await put(`${policy.directory}/report.md`, "report");
    await put(`${other.directory}/report.md`, "another Attempt");
    await put("repository/untracked.ts", "code");
    expect(
      (await collectOutputFiles(env, policy, baseline)).files.map((file) => file.path),
    ).toEqual([`${policy.directory}/report.md`]);
    expect(managedOutputPolicy("../../escape").directory).toMatch(/^outputs\/[a-f0-9]{64}$/);
  });
  it("captures declared files without agent calls and excludes secrets and inputs", async () => {
    const { env, put } = await fixture();
    const policy = { required: ["outputs/report.md"] };
    const baseline = await prepareOutputCollection(env, policy);
    await put("outputs/report.md", "report");
    await put("outputs/.env", "secret");
    await put("outputs/node_modules/module.js", "module");
    await put("outputs/inputs/source.txt", "input");
    expect((await collectOutputFiles(env, policy, baseline)).files.map((f) => f.path)).toEqual([
      "outputs/report.md",
    ]);
  });
  it("required selectors override include but never exclusions", async () => {
    const { env, put } = await fixture();
    await put("reports/result.txt", "yes");
    const policy = { include: ["outputs/**"], required: ["reports/*.txt"] };
    const baseline = await prepareOutputCollection(env, policy);
    expect((await collectOutputFiles(env, policy, baseline)).files).toHaveLength(1);
    await expect(
      collectOutputFiles(env, { ...policy, exclude: ["reports/**"] }, baseline),
    ).rejects.toThrow("Required output");
  });
  it("rejects absent deliverables, oversized output, links, and path escapes", async () => {
    const { root, env, put } = await fixture();
    const baseline = await prepareOutputCollection(env, {});
    await expect(
      collectOutputFiles(env, { required: ["outputs/report"] }, baseline),
    ).rejects.toThrow("Required output");
    await put("outputs/file", "1234");
    await expect(collectOutputFiles(env, { maxBytes: 3 }, baseline)).rejects.toThrow("byte limit");
    await symlink("file", join(root, "outputs/link"));
    await expect(collectOutputFiles(env, {}, baseline)).rejects.toThrow("symbolic link");
    await expect(listLocalOutputFiles(root, { roots: ["../"], maxFiles: 10 })).rejects.toThrow(
      "escapes",
    );
  });
  it("rejects changing bytes rather than cataloging inconsistent snapshots", async () => {
    const { env, put } = await fixture();
    await put("outputs/file", "one");
    let calls = 0;
    const changing = { ...env, readBytes: async () => Buffer.from(++calls % 2 ? "one" : "two") };
    await expect(prepareOutputCollection(changing, {})).rejects.toThrow("changed");
  });
  it("uses slash-aware recursive patterns", () => {
    expect(outputPatternMatches("outputs/file", "outputs/**/*.txt")).toBe(false);
    expect(outputPatternMatches("outputs/a.txt", "outputs/**/*.txt")).toBe(true);
    expect(outputPatternMatches("outputs/x/a.txt", "outputs/*.txt")).toBe(false);
  });
  it("preserves selected dirty binary files and deletions without whole-repository capture", async () => {
    const { env, put, git, root } = await fixture();
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await put("src/a.bin", Buffer.from([0, 1]));
    await put("src/deleted.txt", "gone");
    await git("add", ".");
    await git("commit", "-m", "base");
    await put("src/a.bin", Buffer.from([0, 2]));
    const policy = { include: ["src/**"], git: "capture" as const };
    const baseline = await prepareOutputCollection(env, policy);
    await rm(join(root, "src/deleted.txt"));
    await put("src/new.txt", "new");
    const result = await collectOutputFiles(env, policy, baseline);
    expect(result.files.find((f) => f.path === "src/a.bin")?.bytes).toEqual(Buffer.from([0, 2]));
    const manifest = JSON.parse(
      Buffer.from(
        result.files.find((f) => f.path === "supertag-git-output.json")?.bytes ?? [],
      ).toString(),
    );
    expect(manifest.deleted).toEqual(["src/deleted.txt"]);
    expect(manifest.partial).toBe(true);
  });
  it("uses verified remote references and preserves bytes for unavailable or local-only commits", async () => {
    const { env, put, git } = await fixture();
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await put("src/main", "base");
    await git("add", ".");
    await git("commit", "-m", "base");
    const policy = { include: ["src/**"], git: "reference" as const };
    const baseline = await prepareOutputCollection(env, policy);
    expect((await collectOutputFiles(env, policy, baseline)).files.map((f) => f.path)).toContain(
      "src/main",
    );
    const remote = await mkdtemp(join(tmpdir(), "supertag-output-remote-"));
    roots.push(remote);
    await exec("git", ["init", "--bare", remote]);
    await git("remote", "add", "origin", remote);
    await git("push", "origin", "HEAD");
    const pristine = await collectOutputFiles(env, policy, baseline);
    expect(pristine.files.map((f) => f.path)).toEqual(["supertag-git-output.json"]);
    await put("src/main", "changed");
    expect((await collectOutputFiles(env, policy, baseline)).files.map((f) => f.path)).toContain(
      "src/main",
    );
    await git("add", ".");
    await git("commit", "-m", "local only");
    expect((await collectOutputFiles(env, policy, baseline)).files.map((f) => f.path)).toContain(
      "src/main",
    );
  });
  it("collects explicitly included Git-ignored reports", async () => {
    const { env, put, git } = await fixture();
    await git("init");
    await put(".gitignore", "outputs/\n");
    await put("outputs/report", "kept");
    const baseline = await prepareOutputCollection(env, {});
    expect((await collectOutputFiles(env, {}, baseline)).files.map((f) => f.path)).toEqual([
      "outputs/report",
    ]);
  });
  it("handles nested staged repositories and staged deletions", async () => {
    const { root, env, put } = await fixture();
    await put("workspace/src/file", "base");
    await put("workspace/src/deleted", "old");
    const git = (...args: string[]) => exec("git", args, { cwd: join(root, "workspace") });
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("add", ".");
    await git("commit", "-m", "base");
    const policy = { include: ["workspace/src/**"], git: "capture" as const };
    const baseline = await prepareOutputCollection(env, policy);
    await git("rm", "src/deleted");
    await put("workspace/src/file", "new");
    const result = await collectOutputFiles(env, policy, baseline);
    const manifest = JSON.parse(
      Buffer.from(
        result.files.find((f) => f.path === "workspace/supertag-git-output.json")?.bytes ?? [],
      ).toString(),
    );
    expect(manifest.repositoryRoot).toBe("workspace");
    expect(manifest.deleted).toEqual(["workspace/src/deleted"]);
    expect(manifest.remoteDurable).toBe(false);
  });
  it("fails when Git ignore would omit a required deliverable", async () => {
    const { env, put, git } = await fixture();
    await git("init");
    await put("outputs/report", "report");
    await git("add", ".");
    const policy = { required: ["outputs/report"], git: "ignore" as const };
    const baseline = await prepareOutputCollection(env, policy);
    await expect(collectOutputFiles(env, policy, baseline)).rejects.toThrow(
      "excluded by Git policy",
    );
  });
  it("counts the generated manifest against aggregate bounds", async () => {
    const { env, put, git } = await fixture();
    await git("init");
    await put("outputs/report", "report");
    await git("add", ".");
    const policy = { maxFiles: 1, git: "capture" as const };
    const baseline = await prepareOutputCollection(env, policy);
    await expect(collectOutputFiles(env, policy, baseline)).rejects.toThrow(
      "including Git manifest",
    );
  });
  it("never treats a remote inside the disposable workspace as durable", async () => {
    const { root, env, put, git } = await fixture();
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await put("src/main", "base");
    await git("add", ".");
    await git("commit", "-m", "base");
    await exec("git", ["init", "--bare", join(root, "remote.git")]);
    await git("remote", "add", "origin", join(root, "remote.git"));
    await git("push", "origin", "HEAD");
    const policy = { include: ["src/**"] };
    const result = await collectOutputFiles(
      env,
      policy,
      await prepareOutputCollection(env, policy),
    );
    expect(result.files.map((f) => f.path)).toContain("src/main");
    const manifest = JSON.parse(
      Buffer.from(
        result.files.find((f) => f.path === "supertag-git-output.json")?.bytes ?? [],
      ).toString(),
    );
    expect(manifest.remoteDurable).toBe(false);
  });
  it("rejects unsafe output directory preparation and unbounded manifest providers", async () => {
    const { root, env, put } = await fixture();
    await put("elsewhere/file", "x");
    await symlink("elsewhere", join(root, "outputs"));
    await expect(prepareOutputCollection(env, {})).rejects.toThrow("safe directory");
    await expect(prepareOutputCollection(env, { directory: "../escape" })).rejects.toThrow();
    const faulty = {
      ...env,
      listOutputFiles: async () =>
        Array.from({ length: 101 }, (_, i) => ({ path: `outputs/${i}`, sizeBytes: 0 })),
    };
    await expect(collectOutputFiles(faulty, {}, { digests: {} })).rejects.toThrow("file limit");
  });
  it("runs the sandbox manifest helper against real files", async () => {
    const { root, put } = await fixture();
    await put("outputs/report", "ok");
    await put("outputs/.env", "secret");
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
    expect(
      await listSandboxOutputFiles(sandbox, root, { roots: ["outputs"], maxFiles: 10 }),
    ).toEqual([{ path: "outputs/report", sizeBytes: 2 }]);
    await symlink("report", join(root, "outputs/link"));
    await expect(
      listSandboxOutputFiles(sandbox, root, { roots: ["outputs"], maxFiles: 10 }),
    ).rejects.toThrow();
  });
});
