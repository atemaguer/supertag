import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dependencyWorkspaceBranches } from "../packages/control-plane/src/dependency-branches.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  type TaskAssignment,
  type TaskNamedWorkspacePlan,
  taskWorkspaceBranch,
  workspaceDeliveryEvidence,
} from "../packages/core/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import {
  LocalWorklet,
  type ResolutionContext,
  type TaskAttemptSpec,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

/** Commits `files` on a new branch from `from` in the checkout, and returns the head. */
async function branchWith(
  checkout: string,
  branch: string,
  files: Record<string, string>,
  from = "main",
): Promise<string> {
  git(checkout, "checkout", "--quiet", "-b", branch, from);
  for (const [path, content] of Object.entries(files))
    await writeFile(join(checkout, path), content);
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", `Work on ${branch}`);
  const head = git(checkout, "rev-parse", "HEAD");
  git(checkout, "checkout", "--quiet", "main");
  return head;
}

describe("Dependency branch merges in Workspace setup", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  let checkout: string;
  let root: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    checkout = await createRepository();
    root = await mkdtemp(join(tmpdir(), "supertag-dependency-merge-"));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const taskId = "objective-1:dependent";
  const plan = (overrides: Partial<TaskNamedWorkspacePlan> = {}): TaskNamedWorkspacePlan => ({
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: taskWorkspaceBranch("objective-1", taskId),
    delivery: "branch",
    ...overrides,
  });
  const context = (workspacePlan: TaskNamedWorkspacePlan, attemptId = "attempt-1") =>
    ({
      task: {
        taskId,
        attemptId,
        workspacePlan,
        authorization: { runtimeActions: ["files:write"] },
      } as unknown as TaskAttemptSpec,
      profile: { harness: { provider: "codex" } },
    }) as unknown as ResolutionContext;
  const resolver = () =>
    new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
    });

  it("starts a new Task branch from the base merged with every dependency's delivered commit", async () => {
    // Main moves on after both dependencies branched, so neither is a fast-forward.
    const a = await branchWith(checkout, "supertag/objective-1/a", { "a.txt": "A\n" });
    const b = await branchWith(checkout, "supertag/objective-1/b", { "b.txt": "B\n" });
    await writeFile(join(checkout, "main.txt"), "main\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "Move main");
    const main = git(checkout, "rev-parse", "main");
    const workspacePlan = plan({
      dependencyBranches: [
        { taskId: "objective-1:a", branch: "supertag/objective-1/a", head: a },
        { taskId: "objective-1:b", branch: "supertag/objective-1/b", head: b },
      ],
    });

    const resolved = await resolver().resolve(context(workspacePlan));
    const path = fileURLToPath(resolved?.source.uri ?? "");
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("A\n");
    expect(await readFile(join(path, "b.txt"), "utf8")).toBe("B\n");
    expect(await readFile(join(path, "main.txt"), "utf8")).toBe("main\n");
    const head = git(path, "rev-parse", "HEAD");
    // Each dependency's own commit is an ancestor, so ancestry checks hold, not content copies.
    for (const ancestor of [main, a, b])
      expect(() => git(path, "merge-base", "--is-ancestor", ancestor, head)).not.toThrow();
    expect(git(path, "log", "--merges", "--format=%s", "main..HEAD").split("\n")).toEqual([
      "Merge dependency branch supertag/objective-1/b",
      "Merge dependency branch supertag/objective-1/a",
    ]);
    // The Task measures its own changes from the merge, not the dependencies' work.
    expect(resolved?.source.provenance).toMatchObject({ base: head });
    expect(resolved?.source.digest).toBe(`git:${head}`);
    expect(git(path, "status", "--porcelain")).toBe("");
    // The checkout's own branch and working tree are untouched.
    expect(git(checkout, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(checkout, "rev-parse", "main")).toBe(main);
    expect(git(checkout, "status", "--porcelain")).toBe("");

    // The merge is deterministic: a later Attempt starting afresh merges to the same commit.
    // An Attempt without commits since that merge leaves nothing to deliver and drops the branch.
    const record = await resolver().finalize(context(workspacePlan).task, "completed");
    expect(record).toMatchObject({ base: head, head, changedFiles: 0, branchRemoved: true });
    const again = await resolver().resolve(context(workspacePlan, "attempt-2"));
    expect(git(fileURLToPath(again?.source.uri ?? ""), "rev-parse", "HEAD")).toBe(head);
  });

  it("fast-forwards to a dependency that already contains the base and skips one already merged", async () => {
    const a = await branchWith(checkout, "supertag/objective-1/a", { "a.txt": "A\n" });
    // b was built on a: it contains a's commit.
    const b = await branchWith(checkout, "supertag/objective-1/b", { "b.txt": "B\n" }, a);
    const workspacePlan = plan({
      dependencyBranches: [
        { taskId: "objective-1:b", branch: "supertag/objective-1/b", head: b },
        { taskId: "objective-1:a", branch: "supertag/objective-1/a", head: a },
      ],
    });
    const resolved = await resolver().resolve(context(workspacePlan));
    const path = fileURLToPath(resolved?.source.uri ?? "");
    expect(git(path, "rev-parse", "HEAD")).toBe(b);
    expect(resolved?.source.provenance).toMatchObject({ base: b });
  });

  it("fails before any worktree or harness with the conflicting paths", async () => {
    const a = await branchWith(checkout, "supertag/objective-1/a", {
      "README.md": "# From A\n",
      "shared.txt": "A\n",
    });
    const b = await branchWith(checkout, "supertag/objective-1/b", {
      "README.md": "# From B\n",
      "shared.txt": "B\n",
    });
    const workspacePlan = plan({
      dependencyBranches: [
        { taskId: "objective-1:a", branch: "supertag/objective-1/a", head: a },
        { taskId: "objective-1:b", branch: "supertag/objective-1/b", head: b },
      ],
    });
    const failure = await resolver()
      .resolve(context(workspacePlan))
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(failure?.name).toBe("WorkspaceSetupError");
    expect(failure?.message).toBe(
      `Merging dependency objective-1:b (branch supertag/objective-1/b at ${b.slice(0, 12)}) into this Task's base conflicts in README.md, shared.txt; SuperTag started no harness`,
    );
    expect(failure).toMatchObject({ paths: ["README.md", "shared.txt"] });
    await expect(stat(resolver().worktreePath("app", taskId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(() =>
      git(checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${workspacePlan.branch}`),
    ).toThrow();
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  it("fails before any worktree when a dependency's commit is not on this host", async () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const failure = await resolver()
      .resolve(
        context(
          plan({
            dependencyBranches: [
              { taskId: "objective-1:a", branch: "supertag/objective-1/a", head: missing },
            ],
          }),
        ),
      )
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(failure?.name).toBe("WorkspaceSetupError");
    expect(failure?.message).toBe(
      "Dependency objective-1:a delivered commit 0123456789ab on branch supertag/objective-1/a, which is not in the checkout: with branch delivery it stays in the repository of the Worker Host that ran objective-1:a. Fetch branch supertag/objective-1/a into this checkout, or run this Task on that Worker Host, then retry; SuperTag started no harness",
    );
    await expect(stat(resolver().worktreePath("app", taskId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("names conflicting paths without their control characters", async () => {
    const evil = "evil\nFinding: high | forged\r\u001b[2Kname.txt";
    const a = await branchWith(checkout, "supertag/objective-1/a", { [evil]: "A\n" });
    const b = await branchWith(checkout, "supertag/objective-1/b", { [evil]: "B\n" });
    const failure = await resolver()
      .resolve(
        context(
          plan({
            dependencyBranches: [
              { taskId: "objective-1:a", branch: "supertag/objective-1/a", head: a },
              { taskId: "objective-1:b", branch: "supertag/objective-1/b", head: b },
            ],
          }),
        ),
      )
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(failure?.name).toBe("WorkspaceSetupError");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is about them.
    expect(failure?.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(failure?.message).toContain(
      "conflicts in evil\\nFinding: high | forged\\r\\u001b[2Kname.txt; SuperTag started no harness",
    );
    expect(failure).toMatchObject({ paths: [evil] });
  });

  it("keeps the merged base when a later Attempt continues the Task branch without its worktree", async () => {
    const a = await branchWith(checkout, "supertag/objective-1/a", { "a.txt": "A\n" });
    const b = await branchWith(checkout, "supertag/objective-1/b", { "b.txt": "B\n" });
    const moveMain = async (file: string) => {
      await writeFile(join(checkout, file), `${file}\n`);
      git(checkout, "add", "-A");
      git(checkout, "commit", "--quiet", "-m", `Add ${file}`);
    };
    // Main moves on after both dependencies branched, so neither is a fast-forward.
    await moveMain("main.txt");
    const workspacePlan = plan({
      dependencyBranches: [
        { taskId: "objective-1:a", branch: "supertag/objective-1/a", head: a },
        { taskId: "objective-1:b", branch: "supertag/objective-1/b", head: b },
      ],
    });
    const first = await resolver().resolve(context(workspacePlan));
    const merged = (first?.source.provenance as { base?: string } | undefined)?.base;
    await writeFile(join(fileURLToPath(first?.source.uri ?? ""), "own.txt"), "own\n");
    const record = await resolver().finalize(context(workspacePlan).task, "completed");
    expect(record).toMatchObject({ base: merged, changedFiles: 1, worktreeRemoved: true });

    // Main moves again; the next Attempt reuses the branch, with no worktree left to record it.
    await moveMain("later.txt");
    const again = await resolver().resolve(context(workspacePlan, "attempt-2"));
    expect(again?.source.provenance).toMatchObject({ base: merged });
    expect(git(checkout, "diff", "--name-only", `${merged}..${workspacePlan.branch}`)).toBe(
      "own.txt",
    );
  });

  it("does not merge dependencies into a review, which starts at the submitted commit", async () => {
    const a = await branchWith(checkout, "supertag/objective-1/a", { "a.txt": "A\n" });
    const submitted = await branchWith(checkout, "supertag/objective-1/s", { "s.txt": "S\n" });
    const workspacePlan = plan({
      dependencyBranches: [{ taskId: "objective-1:a", branch: "supertag/objective-1/a", head: a }],
    });
    const review = context(workspacePlan);
    (review.task as { input?: unknown }).input = {
      messages: [],
      attachments: [
        {
          artifactId: "artifact-1",
          provenance: {
            taskId: "objective-1:s",
            workspaceGitReference: `git:supertag/objective-1/s@${submitted}`,
          },
        },
      ],
    };
    const resolved = await resolver().resolve(review);
    expect(git(fileURLToPath(resolved?.source.uri ?? ""), "rev-parse", "HEAD")).toBe(submitted);
  });
});

describe("Dependency commits in a host-managed clone", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  let upstream: string;
  let origin: string;
  let root: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    upstream = await createRepository();
    origin = join(await mkdtemp(join(tmpdir(), "supertag-dependency-origin-")), "app.git");
    git(upstream, "clone", "--quiet", "--bare", upstream, origin);
    git(upstream, "remote", "add", "origin", origin);
    root = await mkdtemp(join(tmpdir(), "supertag-dependency-clone-"));
    for (const path of [upstream, join(origin, ".."), root])
      cleanups.push(() => rm(path, { recursive: true, force: true }));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const taskId = "objective-1:dependent";
  const context = (dependencyBranches: TaskNamedWorkspacePlan["dependencyBranches"]) =>
    ({
      task: {
        taskId,
        attemptId: "attempt-1",
        workspacePlan: {
          version: 1,
          status: "workspace",
          workspace: "app",
          source: pathToFileURL(origin).href,
          branch: taskWorkspaceBranch("objective-1", taskId),
          delivery: "branch",
          ...(dependencyBranches === undefined ? {} : { dependencyBranches }),
        } satisfies TaskNamedWorkspacePlan,
        authorization: { runtimeActions: ["files:write"], resources: [] },
      } as unknown as TaskAttemptSpec,
      profile: { harness: { provider: "codex" } },
    }) as unknown as ResolutionContext;
  const resolver = () =>
    new WorkspaceEnvironmentResolver({ checkouts: [], worktreeRoot: root, cloneSources: true });

  it("fetches a dependency commit the source holds outside its branches", async () => {
    // Another Worker Host's commit reached the source only under a non-branch ref, so the
    // clone's ordinary fetch of branches and tags does not bring it.
    const a = await branchWith(upstream, "supertag/objective-1/a", { "a.txt": "A\n" });
    git(upstream, "push", "--quiet", "origin", `${a}:refs/pull/1/head`);
    git(upstream, "branch", "--quiet", "-D", "supertag/objective-1/a");

    const resolved = await resolver().resolve(
      context([{ taskId: "objective-1:a", branch: "supertag/objective-1/a", head: a }]),
    );
    const path = fileURLToPath(resolved?.source.uri ?? "");
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("A\n");
    expect(git(path, "rev-parse", "HEAD")).toBe(a);
  });

  it("fails with what to do when no repository this host reaches has the commit", async () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const failure = await resolver()
      .resolve(
        context([{ taskId: "objective-1:a", branch: "supertag/objective-1/a", head: missing }]),
      )
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(failure?.name).toBe("WorkspaceSetupError");
    expect(failure?.message).toBe(
      "Dependency objective-1:a delivered commit 0123456789ab on branch supertag/objective-1/a, which is not in the clone of its source and could not be fetched from the source: with branch delivery it stays in the repository of the Worker Host that ran objective-1:a. Push branch supertag/objective-1/a from that host to the Workspace source, or run this Task on that Worker Host, then retry; SuperTag started no harness",
    );
    await expect(stat(resolver().worktreePath("app", taskId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("Dependent Tasks in an Objective", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /**
   * An Objective whose harness writes each Task's files into its Task worktree, and records the
   * files and commit each Task saw when its harness started.
   */
  async function fixture() {
    cleanups.push(await isolateGitConfiguration());
    const checkout = await createRepository();
    const root = await mkdtemp(join(tmpdir(), "supertag-dependency-objective-"));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const seen = new Map<string, { files: string; head: string }>();
    const writes = new Map<string, Record<string, string>>();
    const worker = createClaudeCodeWorker({
      workspace: checkout,
      workspaceResolvers: new WorkspaceResolverRegistry([
        new WorkspaceEnvironmentResolver({
          checkouts: [{ name: "app", path: checkout }],
          worktreeRoot: root,
        }),
      ]),
      runner: async function* (request: { workspace: string }) {
        // Task ids start with their label, and so does each Task worktree's directory name.
        const label = basename(request.workspace).split("-")[0] as string;
        seen.set(label, {
          files: git(request.workspace, "ls-files"),
          head: git(request.workspace, "rev-parse", "HEAD"),
        });
        for (const [path, content] of Object.entries(writes.get(label) ?? {}))
          await writeFile(join(request.workspace, path), content);
        yield { type: "output.message" as const, text: "Change: Write the files" };
      } as never,
    });
    const directory = await mkdtemp(join(tmpdir(), "supertag-dependency-state-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    await store.applyWorkspace({ name: "app", ref: "main", delivery: "branch" });
    const owner = await store.createTag({ name: `owner-${randomUUID()}` });
    const member = await store.createTag({ name: `member-${randomUUID()}` });
    for (const tag of [owner, member]) await store.bindTagWorkerHost(tag.id, "host");
    const objective = await store.createObjective({
      id: `objective-${randomUUID().slice(0, 8)}`,
      ownerTagId: owner.id,
      outcome: "Ship the change.",
      workspaces: ["app"],
    });
    const team = await store.createTeam({
      id: randomUUID(),
      objectiveId: objective.id,
      name: "Delivery",
      leadTagId: owner.id,
      memberTagIds: [member.id],
      maxConcurrency: 2,
    });
    const controller = new ObjectiveController(
      store,
      durableTestWorklet(new LocalWorklet("w", "host", [worker], { workspaces: ["app"] })),
    );
    controller.activateCoordination({ url: "http://127.0.0.1:1" });
    cleanups.push(() => controller.stop());
    const assign = async (
      label: string,
      files: Record<string, string>,
      dependencies: string[] = [],
    ) => {
      writes.set(label, files);
      return (await controller.command("assign_task", {
        objectiveId: objective.id,
        taskId: `${label}-${randomUUID().slice(0, 8)}`,
        teamId: team.id,
        assignedTagId: member.id,
        instruction: "Write the files",
        acceptanceCriteria: ["Written"],
        dependencies,
      })) as TaskAssignment;
    };
    const settled = (taskId: string) =>
      eventually(async () => {
        const current = await store.getTaskAssignment(taskId);
        return current && ["submitted", "failed"].includes(current.status) ? current : undefined;
      });
    const accept = (taskId: string) =>
      store.reviewTaskAssignment(taskId, owner.id, true, "Accepted the delivered change");
    const delivery = async (taskId: string) =>
      (await store.listTaskEvents(taskId))
        .map((event) => workspaceDeliveryEvidence(event.payload))
        .findLast((evidence) => evidence !== undefined);
    return { checkout, store, controller, seen, assign, settled, accept, delivery };
  }

  it("starts a Task whose dependencies are accepted from a merge of their delivered branches", async () => {
    const f = await fixture();
    const a = await f.assign("a", { "a.txt": "A\n" });
    const b = await f.assign("b", { "b.txt": "B\n" });
    const c = await f.assign("c", { "c.txt": "C\n" }, [a.taskId, b.taskId]);
    f.controller.start();
    for (const task of [a, b]) {
      expect((await f.settled(task.taskId)).status).toBe("submitted");
      await f.accept(task.taskId);
    }
    const [deliveredA, deliveredB] = [await f.delivery(a.taskId), await f.delivery(b.taskId)];
    expect(deliveredA?.head).not.toBe(deliveredA?.base);
    expect(deliveredB?.head).not.toBe(deliveredB?.base);

    expect((await f.settled(c.taskId)).status).toBe("submitted");
    // The harness started in a worktree that already held both dependencies' work.
    const started = f.seen.get("c");
    expect(started?.files.split("\n")).toEqual(
      expect.arrayContaining(["README.md", "a.txt", "b.txt"]),
    );
    for (const head of [deliveredA?.head, deliveredB?.head])
      expect(() =>
        git(f.checkout, "merge-base", "--is-ancestor", head as string, started?.head as string),
      ).not.toThrow();
    // C delivers only its own change, measured from the merge it started at.
    const deliveredC = await f.delivery(c.taskId);
    expect(deliveredC).toMatchObject({ base: started?.head, changedFiles: 1 });
    expect(git(f.checkout, "diff", "--name-only", `${deliveredC?.base}..${deliveredC?.head}`)).toBe(
      "c.txt",
    );
  }, 60_000);

  it("fails a dependent Task before its harness starts when the dependencies conflict", async () => {
    const f = await fixture();
    const a = await f.assign("a", { "shared.txt": "A\n" });
    const b = await f.assign("b", { "shared.txt": "B\n" });
    const c = await f.assign("c", { "c.txt": "C\n" }, [a.taskId, b.taskId]);
    f.controller.start();
    for (const task of [a, b]) {
      expect((await f.settled(task.taskId)).status).toBe("submitted");
      await f.accept(task.taskId);
    }
    const failed = await f.settled(c.taskId);
    expect(failed.status).toBe("failed");
    expect(f.seen.has("c")).toBe(false);
    expect(failed.result).toMatchObject({ failureKind: "workspace-setup" });
    expect(String(failed.result?.["error"])).toContain(
      `Merging dependency ${b.taskId} (branch ${taskWorkspaceBranch(failed.objectiveId, b.taskId)} at`,
    );
    expect(String(failed.result?.["error"])).toContain("conflicts in shared.txt");
  }, 60_000);
});

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Dependency branches at dispatch", () => {
  const head = (digit: string) => digit.repeat(40);
  const progress = (attemptId: string, branch: string, base: string, tip: string) => ({
    attemptId,
    type: "progress.updated",
    payload: {
      progress: {
        items: [
          { id: "workspace-branch", text: `Branch: ${branch}` },
          { id: "workspace-base", text: `Base: ${base}` },
          { id: "workspace-head", text: `Head: ${tip}` },
          { id: "workspace-changed-files", text: "Changed files: 1" },
        ],
      },
    },
  });
  const store = (
    tasks: Record<
      string,
      {
        status: string;
        workspace?: string;
        dependencies?: string[];
        reviewedAttemptId?: string;
        events?: ReturnType<typeof progress>[];
      }
    >,
  ) => ({
    getTaskAssignment: async (taskId: string) => {
      const task = tasks[taskId];
      return task === undefined
        ? undefined
        : ({
            taskId,
            status: task.status,
            dependencies: task.dependencies ?? [],
            result:
              task.reviewedAttemptId === undefined
                ? null
                : { reviewedAttemptId: task.reviewedAttemptId },
          } as unknown as TaskAssignment);
    },
    findTaskById: async (taskId: string) =>
      ({
        id: taskId,
        workspacePlan: {
          version: 1,
          status: "workspace",
          workspace: tasks[taskId]?.workspace ?? "app",
          branch: `supertag/o/${taskId}`,
          delivery: "branch",
        },
      }) as never,
    listTaskEvents: async (taskId: string) => (tasks[taskId]?.events ?? []) as never,
  });
  const plan = {
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: "supertag/o/c",
    delivery: "branch",
  } as const;

  it("names each accepted dependency's delivered head from its reviewed Attempt, in order", async () => {
    const branches = await dependencyWorkspaceBranches(
      store({
        b: {
          status: "accepted",
          reviewedAttemptId: "b-2",
          events: [
            progress("b-1", "supertag/o/b", head("0"), head("1")),
            progress("b-2", "supertag/o/b", head("0"), head("2")),
            progress("b-3", "supertag/o/b", head("0"), head("3")),
          ],
        },
        a: {
          status: "accepted",
          reviewedAttemptId: "a-1",
          events: [progress("a-1", "supertag/o/a", head("0"), head("4"))],
        },
      }),
      ["b", "a"],
      plan,
    );
    expect(branches).toEqual([
      { taskId: "b", branch: "supertag/o/b", head: head("2") },
      { taskId: "a", branch: "supertag/o/a", head: head("4") },
    ]);
  });

  it("uses a dependency's allocated branch from its Worker manifest", async () => {
    const branch = "supertag/o/a-deadbeef";
    const f = store({ a: { status: "accepted", reviewedAttemptId: "a-1" } });
    f.listTaskEvents = async () =>
      [
        {
          type: "runtime-inputs.resolved",
          attemptId: "a-1",
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
        },
        progress("a-1", branch, head("0"), head("4")),
      ] as never;
    expect(await dependencyWorkspaceBranches(f, ["a"], plan)).toEqual([
      { taskId: "a", branch, head: head("4") },
    ]);
  });

  it("passes through a dependency that delivered nothing and skips other Workspaces and unaccepted Tasks", async () => {
    const branches = await dependencyWorkspaceBranches(
      store({
        empty: { status: "accepted", dependencies: ["a", "other", "open"] },
        a: {
          status: "accepted",
          events: [progress("a-1", "supertag/o/a", head("0"), head("4"))],
        },
        other: {
          status: "accepted",
          workspace: "docs",
          events: [progress("o-1", "supertag/o/other", head("0"), head("5"))],
        },
        open: {
          status: "submitted",
          events: [progress("p-1", "supertag/o/open", head("0"), head("6"))],
        },
      }),
      ["empty", "a"],
      plan,
    );
    expect(branches).toEqual([{ taskId: "a", branch: "supertag/o/a", head: head("4") }]);
  });
});
