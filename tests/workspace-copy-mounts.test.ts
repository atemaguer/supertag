import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TaskNamedWorkspacePlan, taskWorkspaceBranch } from "../packages/core/src/index.js";
import {
  type ResolutionContext,
  type TaskAttemptSpec,
  type VolumeResolver,
  WorkspaceEnvironmentResolver,
} from "../packages/runtime/sdk/src/index.js";
import {
  type LocalMountRoot,
  resolveLocalMountRoot,
} from "../packages/runtime/sdk/src/local-mount-root.js";
import { createRepository, isolateGitConfiguration } from "./support/git-repository.js";
import { removeSealedTree } from "./support/sealed-tree.ts";

// Scratch directories live in the system temporary directory, which a real Worker Host refuses
// for local copies; tests/volume-copy-races.test.ts checks that refusal.
vi.mock("../packages/runtime/sdk/src/task-writable-roots.js", () => ({
  taskWritableRoots: () => [],
}));

describe("Workspace copy mounts on a local Worker Host", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let checkout: string;
  let root: string;
  let scratch: string;
  let localMountRoot: LocalMountRoot;
  let source: string;
  let mountPath: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    checkout = await createRepository();
    root = await mkdtemp(join(tmpdir(), "supertag-worktrees-"));
    scratch = await mkdtemp(join(tmpdir(), "supertag-copy-mounts-"));
    source = join(scratch, "volume");
    mountPath = join(scratch, "mnt", "datasets");
    localMountRoot = await resolveLocalMountRoot(scratch);
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "rows.csv"), "a,b\n");
    await writeFile(join(source, "nested", "notes.txt"), "notes\n");
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => removeSealedTree(scratch));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const plan = (taskId: string): TaskNamedWorkspacePlan => ({
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: taskWorkspaceBranch("objective-1", taskId),
    delivery: "branch",
    // Setup runs before the copy, so it never sees mounted content.
    setup: `if [ -e '${mountPath}' ]; then echo mounted; else echo clean; fi > setup-saw.txt`,
    mounts: [{ volume: "datasets", path: mountPath, access: "read-only", strategy: "copy" }],
  });
  const task = (taskId: string, attemptId: string) =>
    ({
      taskId,
      attemptId,
      workspacePlan: plan(taskId),
      authorization: { runtimeActions: ["files:write"] },
    }) as unknown as TaskAttemptSpec;
  const context = (spec: TaskAttemptSpec) =>
    ({ task: spec, profile: { harness: { provider: "codex" } } }) as unknown as ResolutionContext;
  const volumes: VolumeResolver = {
    resolve: async (volume) => ({ volume, source: pathToFileURL(source).href }),
  };
  const resolver = (withVolumes = true) =>
    new WorkspaceEnvironmentResolver({
      localMountRoot,
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
      ...(withVolumes ? { volumes } : {}),
    });

  it("copies after setup, gives each Task Attempt its own copy, and removes it at finalize", async () => {
    const workspaces = resolver();
    const first = task("objective-1:task/1", "attempt-1");
    await workspaces.resolve(context(first));
    const worktree = workspaces.worktreePath("app", first.taskId);
    expect(await readFile(join(worktree, "setup-saw.txt"), "utf8")).toBe("clean\n");
    expect(await readFile(join(mountPath, "rows.csv"), "utf8")).toBe("a,b\n");
    expect((await stat(join(mountPath, "rows.csv"))).mode & 0o222).toBe(0);
    const [manifest] = workspaces.mountManifestsForAttempt("attempt-1");
    expect(manifest).toMatchObject({ volume: "datasets", path: mountPath, objectCount: 2 });
    // Nothing reached the checkout.
    await expect(lstat(join(worktree, "rows.csv"))).rejects.toThrow();

    await workspaces.finalize(first, "failed");
    await expect(lstat(mountPath)).rejects.toThrow();
    expect(workspaces.mountManifestsForAttempt("attempt-1")).toEqual([]);

    // The retry copies again, from the source as it is now.
    await writeFile(join(source, "rows.csv"), "a,b\n1,2\n");
    await workspaces.resolve(context(task("objective-1:task/1", "attempt-2")));
    expect(await readFile(join(mountPath, "rows.csv"), "utf8")).toBe("a,b\n1,2\n");
    const [retried] = workspaces.mountManifestsForAttempt("attempt-2");
    expect(retried?.digest).not.toBe(manifest?.digest);
    await workspaces.finalize(task("objective-1:task/1", "attempt-2"), "completed");
    await expect(lstat(mountPath)).rejects.toThrow();
  });

  it("uploads local read-write copy changes at finalize and exposes the output manifest", async () => {
    const workspaces = resolver();
    const base = task("objective-1:task/write", "attempt-write");
    const spec = {
      ...base,
      workspacePlan: {
        ...plan(base.taskId),
        mounts: [
          {
            volume: "datasets",
            path: mountPath,
            access: "read-write" as const,
            strategy: "copy" as const,
          },
        ],
      },
    };
    await workspaces.resolve(context(spec));
    await writeFile(join(mountPath, "rows.csv"), "a,b\n1,2\n");
    await writeFile(join(mountPath, "created.txt"), "new\n");
    await workspaces.finalize(spec, "completed");
    expect(await readFile(join(source, "rows.csv"), "utf8")).toBe("a,b\n1,2\n");
    expect(await readFile(join(source, "created.txt"), "utf8")).toBe("new\n");
    const output = workspaces.mountOutputManifestsForAttempt("attempt-write");
    expect(output).toMatchObject([
      {
        status: "complete",
        skipped: 1,
        objects: [{ key: "created.txt" }, { key: "rows.csv" }],
      },
    ]);
    await expect(lstat(mountPath)).rejects.toThrow();
  });

  it("refuses a file source inside a declared checkout that Tasks can write", async () => {
    source = join(checkout, "task-written-data");
    await mkdir(source);
    await writeFile(join(source, "rows.csv"), "untrusted content");
    await expect(resolver().resolve(context(task("t", "a")))).rejects.toThrow(
      /source directory.*overlaps/u,
    );
    await expect(lstat(mountPath)).rejects.toThrow();
  });

  it("refuses a second running Task Attempt at the same mount path", async () => {
    const workspaces = resolver();
    await workspaces.resolve(context(task("objective-1:task/1", "attempt-1")));
    await expect(
      workspaces.resolve(context(task("objective-1:task/2", "attempt-9"))),
    ).rejects.toThrow(/holds another running Task Attempt's copy/u);
    expect(await readFile(join(mountPath, "rows.csv"), "utf8")).toBe("a,b\n");
    await workspaces.finalize(task("objective-1:task/1", "attempt-1"), "completed");
  });

  it("never replaces a path SuperTag did not create", async () => {
    await mkdir(mountPath, { recursive: true });
    await writeFile(join(mountPath, "mine.txt"), "operator data\n");
    await expect(
      resolver().resolve(context(task("objective-1:task/1", "attempt-1"))),
    ).rejects.toThrow(/already exists, and SuperTag did not create it/u);
    expect(await readFile(join(mountPath, "mine.txt"), "utf8")).toBe("operator data\n");
  });

  it("replaces an earlier Attempt's verified copy after a Worker restart", async () => {
    await resolver().resolve(context(task("objective-1:task/1", "attempt-1")));
    await writeFile(join(source, "rows.csv"), "a,b\n1,2\n");
    const restarted = resolver();
    await restarted.resolve(context(task("objective-1:task/2", "attempt-2")));
    expect(await readFile(join(mountPath, "rows.csv"), "utf8")).toBe("a,b\n1,2\n");
    await restarted.finalize(task("objective-1:task/2", "attempt-2"), "completed");
    await expect(lstat(mountPath)).rejects.toThrow();
  });

  it("never removes what a swapped parent exposes when replacing an earlier copy", async () => {
    await resolver().resolve(context(task("objective-1:task/1", "attempt-1")));
    // The Worker stopped without finalizing, and a Task swapped the mount's parent for a link.
    const operatorHome = join(scratch, "operator-home");
    await mkdir(join(operatorHome, "datasets"), { recursive: true });
    await writeFile(join(operatorHome, "datasets", "precious.txt"), "keep me\n");
    await rename(join(scratch, "mnt"), join(scratch, "mnt-moved"));
    await symlink(operatorHome, join(scratch, "mnt"));
    await expect(
      resolver().resolve(context(task("objective-1:task/2", "attempt-2"))),
    ).rejects.toThrow(/already exists, and SuperTag did not create it/u);
    expect(await readFile(join(operatorHome, "datasets", "precious.txt"), "utf8")).toBe(
      "keep me\n",
    );
    // The earlier copy, which no longer verifies, is left in place too.
    expect(await readFile(join(scratch, "mnt-moved", "datasets", "rows.csv"), "utf8")).toBe(
      "a,b\n",
    );
  });

  it("fails as Workspace setup, naming the Volume, without a Volume resolver", async () => {
    const failure = await resolver(false)
      .resolve(context(task("objective-1:task/1", "attempt-1")))
      .catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("WorkspaceSetupError");
    expect((failure as Error).message).toMatch(/cannot copy Volume datasets/u);
    await expect(lstat(mountPath)).rejects.toThrow();
  });
});
