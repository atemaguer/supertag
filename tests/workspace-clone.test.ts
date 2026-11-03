import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type TaskNamedWorkspacePlan,
  taskWorkspaceBranch,
  workspaceBranchHeadPin,
  workspaceBranchPin,
} from "../packages/core/src/index.js";
import {
  type GitSourceCredential,
  gitCredentialArguments,
  type ResolutionContext,
  type TaskAttemptSpec,
  WorkspaceEnvironmentResolver,
  type WorkspaceEnvironmentResolverOptions,
  type WorkspacePullRequestPublisher,
} from "../packages/runtime/sdk/src/index.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

const TOKEN = "ghs_test-token-never-on-disk";

// These tests run real git clones and fetches, which take seconds on a loaded machine.
describe("Workspace source clones", { timeout: 20_000 }, () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let upstream: string;
  let origin: string;
  let source: string;
  let root: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    upstream = await createRepository();
    origin = join(await mkdtemp(join(tmpdir(), "supertag-origin-")), "app.git");
    git(upstream, "clone", "--quiet", "--bare", upstream, origin);
    git(upstream, "remote", "add", "origin", origin);
    source = pathToFileURL(origin).href;
    root = await mkdtemp(join(tmpdir(), "supertag-clone-root-"));
    for (const path of [upstream, join(origin, ".."), root])
      cleanups.push(() => rm(path, { recursive: true, force: true }));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const plan = (taskId: string, overrides: Partial<TaskNamedWorkspacePlan> = {}) =>
    ({
      version: 1,
      status: "workspace",
      workspace: "app",
      source,
      branch: taskWorkspaceBranch("objective-1", taskId),
      delivery: "branch",
      ...overrides,
    }) satisfies TaskNamedWorkspacePlan;
  const task = (taskId: string, overrides: Partial<TaskNamedWorkspacePlan> = {}, attempt = "a1") =>
    ({
      taskId,
      attemptId: attempt,
      workspacePlan: plan(taskId, overrides),
      authorization: { runtimeActions: ["files:write"], resources: [] },
    }) as unknown as TaskAttemptSpec;
  const context = (spec: TaskAttemptSpec) =>
    ({ task: spec, profile: { harness: { provider: "codex" } } }) as unknown as ResolutionContext;
  const resolver = (options: Partial<WorkspaceEnvironmentResolverOptions> = {}) =>
    new WorkspaceEnvironmentResolver({
      checkouts: [],
      worktreeRoot: root,
      cloneSources: true,
      ...options,
    });
  const worktreeOf = async (spec: TaskAttemptSpec, instance = resolver()) =>
    fileURLToPath((await instance.resolve(context(spec)))?.source.uri ?? "");
  const pushUpstream = async (file: string) => {
    await writeFile(join(upstream, file), `${file}\n`);
    git(upstream, "add", "-A");
    git(upstream, "commit", "--quiet", "-m", `Add ${file}`);
    git(upstream, "push", "--quiet", "origin", "main");
  };

  it("clones the source on first use, reuses the clone, and fetches before each new Task worktree", async () => {
    const instance = resolver();
    expect(instance.clonesSources).toBe(true);
    const first = await worktreeOf(task("task-1"), instance);
    const clone = instance.clonePath("app");
    expect(first.startsWith(join(root, "app", "worktrees"))).toBe(true);
    expect(git(clone, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(await readFile(join(first, "README.md"), "utf8")).toBe("# App\n");
    // The Task branch starts from the source's default branch.
    expect(git(first, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "main"));
    git(clone, "config", "supertag.test", "kept");

    // New upstream work reaches the next Task's worktree because the clone is fetched first.
    await pushUpstream("second.txt");
    const second = await worktreeOf(task("task-2"), instance);
    expect(await readFile(join(second, "second.txt"), "utf8")).toBe("second.txt\n");
    expect(git(clone, "config", "supertag.test")).toBe("kept");

    // A new resolver, as after a restart, reuses the same clone and the existing worktree.
    await writeFile(join(second, "draft.txt"), "in progress\n");
    expect(await worktreeOf(task("task-2", {}, "a2"), resolver())).toBe(second);
    expect(await readFile(join(second, "draft.txt"), "utf8")).toBe("in progress\n");
    expect(git(clone, "config", "supertag.test")).toBe("kept");

    const record = await instance.finalize(task("task-2"), "completed");
    expect(record).toMatchObject({ committed: true, changedFiles: 1, worktreeRemoved: true });
    expect(git(clone, "show", `${plan("task-2").branch}:draft.txt`)).toBe("in progress");
    await expect(stat(second)).rejects.toThrow();
  });

  it("uses the Workspace ref from the fetched source", async () => {
    git(upstream, "checkout", "--quiet", "-b", "release");
    await writeFile(join(upstream, "release.txt"), "release\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "--quiet", "-m", "Release");
    git(upstream, "push", "--quiet", "origin", "release");
    const worktree = await worktreeOf(task("task-1", { ref: "release" }));
    expect(git(worktree, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "release"));
  });

  it("refuses a Workspace without a checkout when it cannot clone", async () => {
    await expect(
      resolver({ cloneSources: false }).resolve(context(task("task-1"))),
    ).rejects.toThrow("this Worker does not clone sources");
    await expect(
      resolver().resolve(context(task("task-1", { source: undefined }))),
    ).rejects.toThrow("records no source to clone");
  });

  it("keeps the shared clone consistent under concurrent Tasks and Worklet processes", async () => {
    const one = resolver();
    const two = resolver();
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const paths = await Promise.all(
      tasks.map((id, index) => worktreeOf(task(id), index % 2 === 0 ? one : two)),
    );
    expect(new Set(paths).size).toBe(tasks.length);
    const clone = one.clonePath("app");
    execFileSync("git", ["-C", clone, "fsck", "--no-progress"], { stdio: "pipe" });
    const listed = git(clone, "worktree", "list", "--porcelain");
    for (const path of paths) expect(listed).toContain(path);
    expect(await readdir(join(root, "app"))).not.toContain("repository.lock");
  });

  it("waits for another process's repository lock and replaces a stale one", async () => {
    const instance = resolver();
    await worktreeOf(task("t0"), instance);
    const lock = join(root, "app", "repository.lock");
    // A live holder: this test process.
    await writeFile(lock, `${process.pid}\n`);
    let resolved = false;
    const pending = worktreeOf(task("t1"), instance).then((path) => {
      resolved = true;
      return path;
    });
    await new Promise((done) => setTimeout(done, 400));
    expect(resolved).toBe(false);
    await rm(lock);
    await pending;
    expect(resolved).toBe(true);

    // A holder that no longer runs leaves a stale lock, which is replaced.
    await writeFile(lock, "999999999\n");
    await worktreeOf(task("t2"), instance);
    await expect(stat(lock)).rejects.toThrow();
  });

  it("passes source credentials only through one command's environment", async () => {
    const log = join(root, "git.log");
    const wrapper = join(root, "git-wrapper.sh");
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ -n "$SUPERTAG_GIT_PASSWORD" ]; then echo "credential-in-environment" >> '${log}'; fi\nexec '${real}' "$@"\n`,
    );
    await chmod(wrapper, 0o755);
    const credential: GitSourceCredential = { username: "x-access-token", password: TOKEN };
    const purposes: string[] = [];
    const publisher: WorkspacePullRequestPublisher = {
      async publish(input) {
        await input.push(credential);
        return { status: "failed", message: "pushed without a pull request" };
      },
    };
    const instance = resolver({
      git: wrapper,
      sourceCredentials: {
        async resolve(input) {
          purposes.push(input.purpose);
          return credential;
        },
      },
      pullRequests: publisher,
    });
    const spec = task("task-1", { delivery: "pull-request" });
    const worktree = await worktreeOf(spec, instance);
    await writeFile(join(worktree, "change.txt"), "change\n");
    const record = await instance.finalize(spec, "completed");
    expect(purposes).toEqual(["fetch"]);
    expect(record?.pullRequest).toEqual({
      status: "failed",
      message: "pushed without a pull request",
    });
    // The push reached the source.
    expect(git(origin, "rev-parse", plan("task-1").branch)).toBe(record?.head);

    const commands = await readFile(log, "utf8");
    expect(commands).not.toContain(TOKEN);
    expect(commands).toContain("credential.helper= -c credential.helper=!f()");
    expect(commands).toContain("credential-in-environment");
    // Commands that need no credential never receive one.
    const lines = commands.split("\n");
    const commit = lines.findIndex((line) => line.includes(" commit --no-verify"));
    expect(lines[commit + 1]).not.toBe("credential-in-environment");

    // Nothing under the Workspace root, including git config, records the token.
    const clone = instance.clonePath("app");
    expect(git(clone, "config", "--list")).not.toContain(TOKEN);
    expect(git(clone, "config", "remote.origin.url")).toBe(source);
    // grep exits 1 when no file matches.
    const search = spawnSync("grep", ["-rl", TOKEN, root, "--exclude=git.log"], {
      encoding: "utf8",
    });
    expect(search.stdout).toBe("");
    expect(search.status).toBe(1);
  });

  it("answers a git credential request from the command environment", () => {
    const output = execFileSync(
      "git",
      [
        ...gitCredentialArguments({ username: "x-access-token", password: TOKEN }),
        "credential",
        "fill",
      ],
      {
        input: "protocol=https\nhost=github.com\npath=acme/app.git\n\n",
        encoding: "utf8",
        env: {
          ...process.env,
          SUPERTAG_GIT_USERNAME: "x-access-token",
          SUPERTAG_GIT_PASSWORD: TOKEN,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    expect(output).toContain("username=x-access-token");
    expect(output).toContain(`password=${TOKEN}`);
    expect(gitCredentialArguments(undefined)).toEqual([]);
  });

  it.each([false, true])(
    "does not adopt or push a foreign fetched branch (case variant: %s)",
    async (caseVariant) => {
      const spec = task("message:11111111-1111-1111-1111-111111111111", {
        delivery: "pull-request",
      });
      const candidate = (spec.workspacePlan as TaskNamedWorkspacePlan).branch;
      const foreignBranch = caseVariant ? candidate.toUpperCase() : candidate;
      const foreignHead = git(origin, "rev-parse", "main");
      git(origin, "update-ref", `refs/heads/${foreignBranch}`, foreignHead);
      const instance = resolver({
        pullRequests: {
          async publish(input) {
            expect(input.plan.branch.toLowerCase()).not.toBe(candidate);
            await input.push(undefined);
            return { status: "failed", message: "test push complete" };
          },
        },
      });
      const worktree = await worktreeOf(spec, instance);
      const branch = git(worktree, "branch", "--show-current");
      expect(branch).not.toBe(candidate);
      await writeFile(join(worktree, "mine.txt"), "only this Task\n");
      const record = await instance.finalize(spec, "completed");
      expect(record?.branch).toBe(branch);
      expect(record?.pullRequest).toMatchObject({ message: "test push complete" });
      expect(git(origin, "rev-parse", foreignBranch)).toBe(foreignHead);
      expect(git(origin, "rev-parse", branch)).toBe(record?.head);
    },
  );

  it("resumes a pushed Task branch on another Worker Host using its recorded pin", async () => {
    const pushing: WorkspacePullRequestPublisher = {
      async publish(input) {
        await input.push(undefined);
        return { status: "failed", message: "pushed" };
      },
    };
    const first = resolver({ pullRequests: pushing });
    const spec = task("task-1", { delivery: "pull-request" });
    await writeFile(join(await worktreeOf(spec, first), "host-a.txt"), "a\n");
    const pushed = await first.finalize(spec, "completed");

    const otherRoot = await mkdtemp(join(tmpdir(), "supertag-clone-root-b-"));
    cleanups.push(() => rm(otherRoot, { recursive: true, force: true }));
    const second = resolver({ worktreeRoot: otherRoot });
    // Dispatch carries the branch and delivered head recorded by the earlier Worker.
    const continued = task(
      "task-1",
      { delivery: "pull-request", branchPin: pushed?.branch, branchPinHead: pushed?.head },
      "a2",
    );
    const worktree = await worktreeOf(continued, second);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(pushed?.head);
    expect(await readFile(join(worktree, "host-a.txt"), "utf8")).toBe("a\n");
    await writeFile(join(worktree, "host-b.txt"), "b\n");
    const record = await second.finalize(
      task("task-1", { delivery: "pull-request" }, "a2"),
      "completed",
    );
    // The base stays the default branch commit the Task started from.
    expect(record?.base).toBe(pushed?.base);
    expect(record?.changedFiles).toBe(2);
    expect(record?.branch).toBe(pushed?.branch);
  });

  it("repins a fresh branch and adopts its pushed commit on another Worker Host", async () => {
    const first = resolver({
      pullRequests: {
        async publish(input) {
          await input.push(undefined);
          return { status: "failed", message: "pushed" };
        },
      },
    });
    const spec = task("task-1", { delivery: "pull-request" });
    await writeFile(join(await worktreeOf(spec, first), "host-a.txt"), "a\n");
    const pushed = await first.finalize(spec, "completed");
    if (!pushed?.branch || !pushed.head) throw new Error("Missing pushed Task branch");

    const tree = git(origin, "rev-parse", "main^{tree}");
    const replacement = git(origin, "commit-tree", tree, "-m", "Unrelated replacement");
    git(origin, "update-ref", `refs/heads/${pushed.branch}`, replacement, pushed.head);

    const otherRoot = await mkdtemp(join(tmpdir(), "supertag-clone-root-b-"));
    cleanups.push(() => rm(otherRoot, { recursive: true, force: true }));
    const retry = task(
      "task-1",
      { delivery: "pull-request", branchPin: pushed.branch, branchPinHead: pushed.head },
      "a2",
    );
    const second = resolver({
      worktreeRoot: otherRoot,
      pullRequests: {
        async publish(input) {
          await input.push(undefined);
          return { status: "failed", message: "pushed" };
        },
      },
    });
    const worktree = await worktreeOf(retry, second);
    const freshBranch = git(worktree, "branch", "--show-current");
    expect(freshBranch).not.toBe(pushed.branch);
    expect(git(worktree, "rev-parse", "HEAD")).not.toBe(replacement);
    await expect(stat(join(worktree, "host-a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(origin, "rev-parse", pushed.branch)).toBe(replacement);

    await writeFile(join(worktree, "host-b.txt"), "fresh branch work\n");
    const repushed = await second.finalize(retry, "completed");
    if (!repushed?.head) throw new Error("Missing fresh Task branch head");
    expect(repushed.branch).toBe(freshBranch);
    expect(git(origin, "rev-parse", freshBranch)).toBe(repushed.head);

    // The Control Plane reads both attempts' recorded manifests and Worker delivery progress.
    const resolved = (branch: string) => ({
      type: "runtime-inputs.resolved",
      payload: {
        manifest: {
          inputs: [
            {
              kind: "workspace",
              resource: {
                provenance: { provider: "supertag-workspace", workspace: "app", branch },
              },
            },
          ],
        },
      },
    });
    const delivered = (branch: string, base: string, head: string) => ({
      type: "progress.updated",
      payload: {
        progress: {
          items: [
            { id: "workspace-branch", text: `Branch: ${branch}` },
            { id: "workspace-base", text: `Base: ${base}` },
            { id: "workspace-head", text: `Head: ${head}` },
          ],
        },
      },
    });
    const events = [
      resolved(pushed.branch),
      delivered(pushed.branch, pushed.base, pushed.head),
      resolved(freshBranch),
      delivered(freshBranch, repushed.base, repushed.head),
    ];
    const branchPin = workspaceBranchPin(events, "app");
    const branchPinHead = workspaceBranchHeadPin(events, "app");
    expect(branchPin).toBe(freshBranch);
    expect(branchPinHead).toBe(repushed.head);

    const thirdRoot = await mkdtemp(join(tmpdir(), "supertag-clone-root-c-"));
    cleanups.push(() => rm(thirdRoot, { recursive: true, force: true }));
    const continued = task(
      "task-1",
      { delivery: "pull-request", branch: branchPin, branchPin, branchPinHead },
      "a3",
    );
    const continuedWorktree = await worktreeOf(continued, resolver({ worktreeRoot: thirdRoot }));
    expect(git(continuedWorktree, "branch", "--show-current")).toBe(freshBranch);
    expect(git(continuedWorktree, "rev-parse", "HEAD")).toBe(repushed.head);
    expect(await readFile(join(continuedWorktree, "host-b.txt"), "utf8")).toBe(
      "fresh branch work\n",
    );
  });

  it("resumes a pinned branch when its remote head descends from the recorded commit", async () => {
    const first = resolver({
      pullRequests: {
        async publish(input) {
          await input.push(undefined);
          return { status: "failed", message: "pushed" };
        },
      },
    });
    const spec = task("task-1", { delivery: "pull-request" });
    await writeFile(join(await worktreeOf(spec, first), "host-a.txt"), "a\n");
    const pushed = await first.finalize(spec, "completed");
    if (!pushed?.branch || !pushed.head) throw new Error("Missing pushed Task branch");

    const tree = git(origin, "rev-parse", `${pushed.head}^{tree}`);
    const descendant = git(
      origin,
      "commit-tree",
      tree,
      "-p",
      pushed.head,
      "-m",
      "Remote branch advanced",
    );
    git(origin, "update-ref", `refs/heads/${pushed.branch}`, descendant, pushed.head);

    const otherRoot = await mkdtemp(join(tmpdir(), "supertag-clone-root-b-"));
    cleanups.push(() => rm(otherRoot, { recursive: true, force: true }));
    const retry = task(
      "task-1",
      { delivery: "pull-request", branchPin: pushed.branch, branchPinHead: pushed.head },
      "a2",
    );
    const worktree = await worktreeOf(retry, resolver({ worktreeRoot: otherRoot }));
    expect(git(worktree, "branch", "--show-current")).toBe(pushed.branch);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(descendant);
    expect(await readFile(join(worktree, "host-a.txt"), "utf8")).toBe("a\n");
  });
});
