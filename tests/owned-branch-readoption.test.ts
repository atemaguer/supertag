import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

describe("owned branch readoption after empty-attempt cleanup", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let checkout: string;
  let rootA: string;
  let rootB: string;
  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    checkout = await createRepository();
    rootA = await mkdtemp(join(tmpdir(), "sbc-rr-a-"));
    rootB = await mkdtemp(join(tmpdir(), "sbc-rr-b-"));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    cleanups.push(() => rm(rootA, { recursive: true, force: true }));
    cleanups.push(() => rm(rootB, { recursive: true, force: true }));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  const branch = taskWorkspaceBranch("demo", "message:11111111-1111-1111-1111-111111111111");
  const plan = (o: Partial<TaskNamedWorkspacePlan> = {}): TaskNamedWorkspacePlan => ({
    version: 1,
    status: "workspace",
    workspace: "app",
    branch,
    delivery: "branch",
    ...o,
  });
  const spec = (taskId: string, attemptId: string, p: TaskNamedWorkspacePlan) =>
    ({
      taskId,
      attemptId,
      workspacePlan: p,
      authorization: { runtimeActions: ["files:write"] },
    }) as unknown as TaskAttemptSpec;
  const context = (s: TaskAttemptSpec) =>
    ({ task: s, profile: { harness: { provider: "codex" } } }) as unknown as ResolutionContext;
  const resolver = (root: string) =>
    new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
    });

  it("a retry allocates another name when another install took its old branch", async () => {
    const T = "message:11111111-1111-1111-1111-111111111111";
    const U = "message:22222222-2222-2222-2222-222222222222";
    // Install A, Task T, attempt 1: gets the unsuffixed name, fails with no commits.
    const first = await resolver(rootA).resolve(context(spec(T, "a1", plan())));
    expect(first?.source.provenance?.["branch"]).toBe(branch);
    await resolver(rootA).finalize(spec(T, "a1", plan()), "failed");
    // Empty-attempt cleanup deletes refs/heads/<branch>; A's owner record keeps the name.
    expect(() => git(checkout, "rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();

    // Install B (another host root, other control plane) on the same checkout: Task U.
    const other = await resolver(rootB).resolve(context(spec(U, "b1", plan())));
    expect(other?.source.provenance?.["branch"]).toBe(branch);
    const otherPath = fileURLToPath(other?.source.uri ?? "");
    await writeFile(join(otherPath, "foreign.txt"), "install B work\n");
    git(otherPath, "add", "foreign.txt");
    git(otherPath, "commit", "--quiet", "-m", "Install B work");
    const foreign = git(otherPath, "rev-parse", "HEAD");
    await resolver(rootB).finalize(spec(U, "b1", plan()), "completed");
    expect(git(checkout, "rev-parse", `refs/heads/${branch}`)).toBe(foreign);

    // Install A retries T; the Control Plane carries T's pin from attempt 1.
    const retrySpec = spec(T, "a2", plan({ branchPin: branch }));
    const retry = await resolver(rootA).resolve(context(retrySpec));
    const path = fileURLToPath(retry?.source.uri ?? "");
    expect(retry?.source.provenance?.["branch"]).not.toBe(branch);
    expect(git(path, "rev-parse", "HEAD")).not.toBe(foreign);
    await expect(stat(join(path, "foreign.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(path, "mine.txt"), "T work\n");
    const delivered = await resolver(rootA).finalize(retrySpec, "completed");
    expect(delivered?.branch).toBe(retry?.source.provenance?.["branch"]);
    expect(git(checkout, "rev-parse", `refs/heads/${branch}`)).toBe(foreign);
    expect(() =>
      git(checkout, "merge-base", "--is-ancestor", foreign, delivered?.head ?? ""),
    ).toThrow();
  });

  it("a retry allocates another name when a human took its old branch", async () => {
    const T = "message:11111111-1111-1111-1111-111111111111";
    await resolver(rootA).resolve(context(spec(T, "a1", plan())));
    await resolver(rootA).finalize(spec(T, "a1", plan()), "failed");
    await writeFile(join(checkout, "human.txt"), "human\n");
    git(checkout, "add", "human.txt");
    git(checkout, "commit", "--quiet", "-m", "Human work");
    const human = git(checkout, "rev-parse", "HEAD");
    git(checkout, "reset", "--quiet", "--hard", "HEAD~1");
    git(checkout, "update-ref", `refs/heads/${branch}`, human);
    const retrySpec = spec(T, "a2", plan({ branchPin: branch }));
    const retry = await resolver(rootA).resolve(context(retrySpec));
    expect(retry?.source.provenance?.["branch"]).not.toBe(branch);
    expect(git(fileURLToPath(retry?.source.uri ?? ""), "rev-parse", "HEAD")).not.toBe(human);
    expect(git(checkout, "rev-parse", `refs/heads/${branch}`)).toBe(human);
  });

  it("does not adopt an origin ref that took a deleted branch name", async () => {
    const T = "message:11111111-1111-1111-1111-111111111111";
    await resolver(rootA).resolve(context(spec(T, "a1", plan())));
    await resolver(rootA).finalize(spec(T, "a1", plan()), "failed");
    await writeFile(join(checkout, "foreign.txt"), "foreign\n");
    git(checkout, "add", "foreign.txt");
    git(checkout, "commit", "--quiet", "-m", "Foreign work");
    const foreign = git(checkout, "rev-parse", "HEAD");
    git(checkout, "reset", "--quiet", "--hard", "HEAD~1");
    git(checkout, "update-ref", `refs/remotes/origin/${branch}`, foreign);
    const retry = await resolver(rootA).resolve(
      context(spec(T, "a2", plan({ branchPin: branch }))),
    );
    expect(retry?.source.provenance?.["branch"]).not.toBe(branch);
    expect(git(fileURLToPath(retry?.source.uri ?? ""), "rev-parse", "HEAD")).not.toBe(foreign);
  });

  it("recreates a missing owned ref at its recorded committed head", async () => {
    const T = "message:11111111-1111-1111-1111-111111111111";
    const firstSpec = spec(T, "a1", plan());
    const first = await resolver(rootA).resolve(context(firstSpec));
    await writeFile(join(fileURLToPath(first?.source.uri ?? ""), "mine.txt"), "mine\n");
    const delivered = await resolver(rootA).finalize(firstSpec, "completed");
    git(checkout, "update-ref", "-d", `refs/heads/${branch}`, delivered?.head ?? "");
    const retry = await resolver(rootA).resolve(
      context(spec(T, "a2", plan({ branchPin: branch }))),
    );
    expect(retry?.source.provenance?.["branch"]).toBe(branch);
    expect(git(checkout, "rev-parse", `refs/heads/${branch}`)).toBe(delivered?.head);
    expect(git(fileURLToPath(retry?.source.uri ?? ""), "rev-parse", "HEAD")).toBe(delivered?.head);
  });
});
