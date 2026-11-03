import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

describe("Workspace git directory integrity", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let checkout: string;
  let root: string;
  let marks: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    checkout = await createRepository();
    root = await mkdtemp(join(tmpdir(), "supertag-worktrees-"));
    marks = await mkdtemp(join(tmpdir(), "supertag-integrity-marks-"));
    for (const path of [checkout, root, marks])
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

  /** Starts an Attempt and returns the resolver that serves it, with the Task worktree. */
  const start = async () => {
    const resolver = new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
    });
    const input = await resolver.resolve({
      task,
      profile: { harness: { provider: "codex" } },
    } as unknown as ResolutionContext);
    const path = fileURLToPath(input?.source.uri ?? "");
    return {
      resolver,
      path,
      common: git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      gitDir: git(path, "rev-parse", "--path-format=absolute", "--git-dir"),
    };
  };
  const driver = `[filter "evil"]\n\tclean = "sh -c 'touch MARKS/clean; cat'"\n`;

  it.each([
    {
      changed: "repository config",
      tamper: async (where: { common: string }) =>
        writeFile(join(where.common, "config"), driver.replace("MARKS", marks), { flag: "a" }),
    },
    {
      changed: "worktree config",
      tamper: async (where: { gitDir: string }) =>
        writeFile(join(where.gitDir, "config.worktree"), driver.replace("MARKS", marks)),
    },
    {
      changed: "info/attributes",
      tamper: async (where: { common: string }) => {
        await mkdir(join(where.common, "info"), { recursive: true });
        await writeFile(join(where.common, "info", "attributes"), "*.txt diff=evil\n");
      },
    },
    {
      changed: "info/exclude",
      tamper: async (where: { common: string }) => {
        await mkdir(join(where.common, "info"), { recursive: true });
        await writeFile(join(where.common, "info", "exclude"), "feature.txt\n");
      },
    },
    {
      changed: "hooks/pre-commit",
      tamper: async (where: { common: string }) => {
        await writeFile(join(where.common, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
      },
    },
  ])(
    "refuses every git command once the $changed changed during the Attempt",
    async ({ changed, tamper }) => {
      const attempt = await start();
      const location =
        changed === "repository config"
          ? join(attempt.common, "config")
          : changed === "worktree config"
            ? join(attempt.gitDir, "config.worktree")
            : join(attempt.common, changed);
      const original = await readFile(location).catch(() => undefined);
      await tamper(attempt);
      await writeFile(join(attempt.path, ".gitattributes"), "* filter=evil\n");
      await writeFile(join(attempt.path, "feature.txt"), "feature\n");

      const failure = await attempt.resolver.finalize(task, "completed").catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.name).toBe("WorkspaceIntegrityError");
      expect(failure.message).toContain(
        `Repository config changed during the Task Attempt (${changed}`,
      );
      // The Worker ran no git command after the change: nothing was committed or removed.
      expect(await readdir(marks)).toEqual([]);
      expect(git(checkout, "rev-parse", workspacePlan.branch)).toBe(
        git(checkout, "rev-parse", "main"),
      );
      expect(await readdir(attempt.path)).toContain("feature.txt");
      if (original === undefined) {
        await expect(readFile(location)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readFile(location)).toEqual(original);
      }
    },
  );

  it("restores a tampered shared git file before another Task Attempt finalizes", async () => {
    const first = await start();
    const secondTask = {
      ...task,
      taskId: "objective-1:task/2",
      attemptId: "attempt-2",
      workspacePlan: {
        ...workspacePlan,
        branch: taskWorkspaceBranch("objective-1", "objective-1:task/2"),
      },
    } as TaskAttemptSpec;
    const secondInput = await first.resolver.resolve({
      task: secondTask,
      profile: { harness: { provider: "codex" } },
    } as unknown as ResolutionContext);
    const secondPath = fileURLToPath(secondInput?.source.uri ?? "");
    await writeFile(join(first.common, "info", "attributes"), "*.txt diff=evil\n");
    await expect(first.resolver.finalize(task, "completed")).rejects.toThrow("info/attributes");
    await writeFile(join(secondPath, "second.txt"), "second\n");
    await expect(first.resolver.finalize(secondTask, "completed")).resolves.toMatchObject({
      committed: true,
    });
  });

  it("restores an included local config file covered by the integrity digest", async () => {
    const included = join(checkout, ".git", "included-config");
    await writeFile(included, "[alias]\n\tstatus = status\n");
    await appendFile(join(checkout, ".git", "config"), "[include]\n\tpath = included-config\n");
    const attempt = await start();
    await writeFile(included, driver.replace("MARKS", marks));
    await expect(attempt.resolver.finalize(task, "completed")).rejects.toThrow(
      "included-config: modified",
    );
    expect(await readFile(included, "utf8")).toBe("[alias]\n\tstatus = status\n");
  });

  it("detects a byte change even when git config values are unchanged", async () => {
    const attempt = await start();
    const config = join(attempt.common, "config");
    const original = await readFile(config);
    await appendFile(config, "# harmless-looking comment\n");
    await expect(attempt.resolver.finalize(task, "completed")).rejects.toThrow(
      "repository config: modified",
    );
    expect(await readFile(config)).toEqual(original);
  });

  it("restores a git config file replaced by a directory", async () => {
    const attempt = await start();
    const config = join(attempt.common, "config");
    const original = await readFile(config);
    await rm(config);
    await mkdir(config);
    await expect(attempt.resolver.finalize(task, "completed")).rejects.toThrow(
      "repository config: modified",
    );
    expect(await readFile(config)).toEqual(original);
  });

  it("delivers normally when the git directory is unchanged", async () => {
    const attempt = await start();
    await writeFile(join(attempt.path, "feature.txt"), "feature\n");
    expect(await attempt.resolver.finalize(task, "completed")).toMatchObject({
      committed: true,
      worktreeRemoved: true,
    });
  });
});
