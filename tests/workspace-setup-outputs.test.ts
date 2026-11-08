import { chmod, link, lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workSessionBranch } from "../packages/control-plane/src/work-sessions.js";
import type { TaskNamedWorkspacePlan } from "../packages/core/src/index.js";
import {
  type ResolutionContext,
  type TaskAttemptSpec,
  WorkspaceEnvironmentResolver,
} from "../packages/runtime/sdk/src/index.js";
import { replaceHardLinks } from "../packages/runtime/sdk/src/private-copies.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

describe("Workspace setup outputs", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let checkout: string;
  let root: string;
  let store: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    checkout = await createRepository();
    root = await mkdtemp(join(tmpdir(), "supertag-worktrees-"));
    // Stands in for a package manager's global store, outside every worktree.
    store = await mkdtemp(join(tmpdir(), "supertag-package-store-"));
    for (const path of [checkout, root, store])
      cleanups.push(() => rm(path, { recursive: true, force: true }));
    await writeFile(join(checkout, ".gitignore"), "*.log\nnode_modules/\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "Ignore dependencies");
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const resolve = async (setup: string) => {
    const workspacePlan: TaskNamedWorkspacePlan = {
      version: 1,
      status: "workspace",
      workspace: "app",
      branch: workSessionBranch("task-1"),
      delivery: "branch",
      setup,
    };
    const input = await new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
    }).resolve({
      task: {
        taskId: "objective-1:task/1",
        attemptId: "attempt-1",
        workspacePlan,
        authorization: { runtimeActions: ["files:write"] },
      } as unknown as TaskAttemptSpec,
      profile: { harness: { provider: "codex" } },
    } as unknown as ResolutionContext);
    return fileURLToPath(input?.source.uri ?? "");
  };

  it("gives a hardlinked file in node_modules its own copy with the same content and mode", async () => {
    const original = join(store, "index.js");
    await writeFile(original, "module.exports = 1;\n");
    await chmod(original, 0o755);
    const path = await resolve(
      `mkdir -p node_modules/pkg && ln ${original} node_modules/pkg/index.js && ln node_modules/pkg/index.js node_modules/pkg/twin.js`,
    );

    const copy = join(path, "node_modules", "pkg", "index.js");
    expect((await stat(copy)).nlink).toBe(1);
    expect((await stat(join(path, "node_modules", "pkg", "twin.js"))).nlink).toBe(1);
    expect(await readFile(copy, "utf8")).toBe("module.exports = 1;\n");
    expect((await stat(copy)).mode & 0o777).toBe(0o755);
    expect((await stat(original)).nlink).toBe(1);
    // A Task that edits its dependencies changes only its own copy, never the store.
    await writeFile(copy, "tampered\n");
    expect(await readFile(original, "utf8")).toBe("module.exports = 1;\n");
  });

  it("never follows a symlink out of the worktree", async () => {
    const shared = join(store, "shared.js");
    await writeFile(shared, "shared\n");
    await link(shared, join(store, "shared-twin.js"));
    const path = await resolve(`mkdir -p node_modules && ln -s ${shared} node_modules/shared.js`);

    expect((await lstat(join(path, "node_modules", "shared.js"))).isSymbolicLink()).toBe(true);
    expect((await stat(shared)).nlink).toBe(2);
    expect(await readFile(join(store, "shared-twin.js"), "utf8")).toBe("shared\n");
  });

  it("refuses an output path outside the worktree", async () => {
    await expect(replaceHardLinks(root, ["../elsewhere"])).rejects.toThrow(
      "Setup output ../elsewhere is outside the Task worktree",
    );
  });
});
