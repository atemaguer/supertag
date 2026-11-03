import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TaskNamedWorkspacePlan, taskWorkspaceBranch } from "../packages/core/src/index.js";
import {
  type ResolutionContext,
  type TaskAttemptSpec,
  WorkspaceEnvironmentResolver,
} from "../packages/runtime/sdk/src/index.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

function gitLfsInstalled(): boolean {
  try {
    execFileSync("git", ["lfs", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("Worker git commands and host git config", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let checkout: string;
  let root: string;
  let global: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    global = process.env["GIT_CONFIG_GLOBAL"] as string;
    checkout = await createRepository();
    root = await mkdtemp(join(tmpdir(), "supertag-worktrees-"));
    for (const path of [checkout, root])
      cleanups.push(() => rm(path, { recursive: true, force: true }));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const workspacePlan: TaskNamedWorkspacePlan = {
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: taskWorkspaceBranch("objective-1", "objective-1:task/1"),
    delivery: "branch",
  };
  const task = {
    taskId: "objective-1:task/1",
    attemptId: "attempt-1",
    workspacePlan,
    authorization: { runtimeActions: ["files:write"] },
  } as unknown as TaskAttemptSpec;
  const resolver = () =>
    new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
    });
  const commit = (files: Record<string, string>) =>
    Promise.all(
      Object.entries(files).map(([name, content]) => writeFile(join(checkout, name), content)),
    ).then(() => {
      git(checkout, "add", "-A");
      git(checkout, "commit", "--quiet", "-m", "Add files");
    });

  it("never runs a filter driver from the global config during Worker checkout or add", async () => {
    const marks = await mkdtemp(join(tmpdir(), "supertag-filter-marks-"));
    cleanups.push(() => rm(marks, { recursive: true, force: true }));
    await commit({ ".gitattributes": "*.txt filter=evil\n", "notes.txt": "notes\n" });
    // Defined only after the commit, as a global driver the developer installed.
    await appendFile(
      global,
      `[filter "evil"]\n\tclean = "sh -c 'touch ${marks}/clean; cat'"\n\tsmudge = "sh -c 'touch ${marks}/smudge; cat'"\n`,
    );

    const input = await resolver().resolve({
      task,
      profile: { harness: { provider: "codex" } },
    } as unknown as ResolutionContext);
    const path = fileURLToPath(input?.source.uri ?? "");
    await writeFile(join(path, "notes.txt"), "changed\n");
    await writeFile(join(path, "more.txt"), "more\n");
    const delivered = await resolver().finalize(task, "failed");

    expect(await readdir(marks)).toEqual([]);
    expect(delivered).toMatchObject({ committed: true, changedFiles: 2 });
    expect(git(checkout, "show", `${workspacePlan.branch}:notes.txt`)).toBe("changed");
  });

  it.runIf(gitLfsInstalled())(
    "still applies the lfs filter, by name, when git-lfs is installed",
    async () => {
      await commit({ ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n" });
      // What `git lfs install` writes to the global config.
      await appendFile(
        global,
        '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n',
      );

      const input = await resolver().resolve({
        task,
        profile: { harness: { provider: "codex" } },
      } as unknown as ResolutionContext);
      const path = fileURLToPath(input?.source.uri ?? "");
      await writeFile(join(path, "model.bin"), "large binary content\n");
      await resolver().finalize(task, "failed");

      expect(git(checkout, "cat-file", "-p", `${workspacePlan.branch}:model.bin`)).toMatch(
        /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:/u,
      );
    },
  );
});
