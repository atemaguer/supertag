import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskNamedWorkspacePlan } from "../packages/core/src/index.js";
import { WorkspaceBranches } from "../packages/runtime/sdk/src/workspace-branches.js";
import {
  WorkspaceHost,
  type WorkspaceRepository,
} from "../packages/runtime/sdk/src/workspace-environment.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

describe("A pinned branch continued on another Worker Host", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  const branch = "supertag/session/5e55104a";
  let path: string;
  let repository: WorkspaceRepository;
  let branches: WorkspaceBranches;
  let base: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    path = await createRepository();
    const root = await mkdtemp(join(tmpdir(), "supertag-branch-pins-"));
    cleanups.push(() => rm(path, { recursive: true, force: true }));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    // A managed clone reads origin copies; refs/remotes/origin/* stand in for a fetch.
    repository = { path, managed: true };
    branches = new WorkspaceBranches(
      new WorkspaceHost({ root, checkouts: new Map(), cloneSources: true }),
    );
    base = git(path, "rev-parse", "main");
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const commit = (parent: string, message: string) =>
    git(path, "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", message);
  const set = (ref: string, at: string) => git(path, "update-ref", ref, at);
  const local = `refs/heads/${branch}`;
  const origin = `refs/remotes/origin/${branch}`;
  const plan = (head: string): TaskNamedWorkspacePlan =>
    ({
      version: 1,
      status: "workspace",
      workspace: "app",
      branch,
      delivery: "branch",
      branchPin: branch,
      branchPinHead: head,
    }) as unknown as TaskNamedWorkspacePlan;
  const refs = () => git(path, "for-each-ref", "--format=%(refname) %(objectname)");
  const allocate = (head: string) => branches.allocate(repository, plan(head), "session-1");

  it("adopts a branch whose copies match the pinned head", async () => {
    const head = commit(base, "A");
    set(local, head);
    set(origin, head);
    expect(await allocate(head)).toMatchObject({ branch, branchPin: branch });
  });

  it("adopts a compatible fast-forward and safe unpushed local commits", async () => {
    const head = commit(base, "A");
    const pushed = commit(head, "Reviewer");
    set(local, head);
    set(origin, pushed);
    expect(await allocate(head)).toMatchObject({ branch, branchPin: branch });
    set(local, commit(pushed, "Unpushed"));
    expect(await allocate(head)).toMatchObject({ branch, branchPin: branch });
  });

  it("refuses an older branch without allocating a suffixed one or moving refs", async () => {
    const older = commit(base, "A");
    const head = commit(older, "B");
    set(local, older);
    set(origin, older);
    const before = refs();
    const refused = allocate(head);
    await expect(refused).rejects.toThrow(
      `Branch ${branch} no longer holds commit ${head.slice(0, 12)}`,
    );
    await expect(refused).rejects.toThrow(`local ${older.slice(0, 12)} (older, behind it)`);
    await expect(refused).rejects.toThrow(`origin ${older.slice(0, 12)} (older, behind it)`);
    await expect(refused).rejects.toThrow(
      `push it to branch "${branch}" on this Workspace's source`,
    );
    await expect(refused).rejects.not.toThrow("git push");
    await expect(refused).rejects.toMatchObject({ name: "WorkspaceSetupError" });
    expect(refs()).toBe(before);
  });

  it("refuses a pinned head this repository does not have", async () => {
    const other = commit(base, "Other");
    set(origin, other);
    const missing = "1".repeat(40);
    await expect(allocate(missing)).rejects.toThrow(
      `origin ${other.slice(0, 12)} (pinned commit missing here)`,
    );
    await expect(allocate(missing)).rejects.toThrow("local absent");
    expect(git(path, "rev-parse", origin)).toBe(other);
  });

  it("refuses divergent copies and a branch replaced without the head", async () => {
    const head = commit(base, "A");
    const ours = commit(head, "Local");
    const theirs = commit(head, "Origin");
    set(local, ours);
    set(origin, theirs);
    await expect(allocate(head)).rejects.toThrow("its local and origin copies diverged");
    expect(git(path, "rev-parse", local)).toBe(ours);
    expect(git(path, "rev-parse", origin)).toBe(theirs);
    const replaced = commit(base, "Replaced");
    set(local, replaced);
    set(origin, replaced);
    await expect(allocate(head)).rejects.toThrow(
      `local ${replaced.slice(0, 12)} (divergent from it)`,
    );
  });

  it("refuses an absent branch", async () => {
    const head = commit(base, "A");
    await expect(allocate(head)).rejects.toThrow("on another Worker Host and was not pushed");
    expect(git(path, "branch", "--list", "supertag/*")).toBe("");
  });

  it("refuses a branch whose name differs only in case", async () => {
    const head = commit(base, "A");
    set(`refs/heads/${branch.toUpperCase()}`, head);
    await expect(allocate(head)).rejects.toThrow("differs only in case");
  });

  it("still gives a fresh, unpinned branch a suffixed name when the name is taken", async () => {
    set(local, commit(base, "Person"));
    const fresh = { ...plan(base) } as Partial<TaskNamedWorkspacePlan>;
    delete fresh.branchPin;
    delete fresh.branchPinHead;
    const allocated = await branches.allocate(repository, fresh as TaskNamedWorkspacePlan, "s-2");
    expect(allocated.branch).toMatch(new RegExp(`^${branch}-[0-9a-f]{8}$`));
    expect(allocated.branchPin).toBeUndefined();
  });

  it("recreates a recorded branch at its head and refuses one rewritten without it", async () => {
    const head = commit(base, "A");
    await branches.record(repository, { ...plan(head) }, "session-1", head);
    git(path, "update-ref", "-d", local);
    expect(await allocate(head)).toMatchObject({ branch, branchPin: branch });
    expect(git(path, "rev-parse", local)).toBe(head);
    set(local, base);
    await expect(allocate(head)).rejects.toThrow(
      `the last one this Worker Host recorded on it (pinned head ${head})`,
    );
    expect(git(path, "rev-parse", local)).toBe(base);
  });

  describe("with a local ownership record", () => {
    const record = (head: string, name = branch) =>
      branches.record(repository, { ...plan(head), branch: name }, "session-1", head);

    it("refuses recreating a stale recorded head when the pin is newer", async () => {
      const h1 = commit(base, "H1");
      const h2 = commit(h1, "H2");
      await record(h1);
      git(path, "update-ref", "-d", local);
      await expect(allocate(h2)).rejects.toThrow(`no longer holds commit ${h2.slice(0, 12)}`);
      expect(git(path, "for-each-ref", "--format=%(refname)", local)).toBe("");
    });

    it("refuses a stale local copy the pin moved past, and accepts it once fetched", async () => {
      const h1 = commit(base, "H1");
      const h2 = commit(h1, "H2");
      await record(h1);
      const before = refs();
      await expect(allocate(h2)).rejects.toThrow(`local ${h1.slice(0, 12)} (older, behind it)`);
      expect(refs()).toBe(before);
      set(origin, h2);
      expect(await allocate(h2)).toMatchObject({ branch, branchPin: branch });
    });

    it("refuses a record that names a different branch than the pin", async () => {
      const h1 = commit(base, "H1");
      await record(h1, "supertag/session/other");
      set(local, h1);
      const before = refs();
      await expect(allocate(h1)).rejects.toThrow(
        'recorded branch "supertag/session/other" for this work, but the Control Plane pinned branch',
      );
      expect(refs()).toBe(before);
    });

    it("keeps legacy soft name pins and empty-work retries", async () => {
      const h1 = commit(base, "H1");
      await record(h1);
      const soft = { ...plan(h1) } as Partial<TaskNamedWorkspacePlan>;
      delete soft.branchPinHead;
      expect(
        await branches.allocate(repository, soft as TaskNamedWorkspacePlan, "session-1"),
      ).toMatchObject({ branch, branchPin: branch });
      // An empty earlier Task deleted its branch; the unpinned retry gets the name back afresh.
      git(path, "update-ref", "-d", local);
      await branches.advance(repository, "session-1", branch, h1, true);
      const retry = await branches.allocate(
        repository,
        soft as TaskNamedWorkspacePlan,
        "session-1",
      );
      expect(retry.branch).toBe(branch);
      expect(retry.branchPin).toBeUndefined();
    });
  });
});
