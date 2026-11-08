import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionWorkspaceBranches } from "../packages/control-plane/src/dependency-branches.js";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import {
  type TaskNamedWorkspacePlan,
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
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
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
    branch: "supertag/objective-1/dependent",
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
          branch: "supertag/objective-1/dependent",
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

describe("Later Tasks of a work Session", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /**
   * An Objective whose harness writes each turn's files into that Task's worktree, and records
   * the files and commit the harness saw when it started.
   */
  async function fixture() {
    cleanups.push(await isolateGitConfiguration());
    const checkout = await createRepository();
    const root = await mkdtemp(join(tmpdir(), "supertag-session-branches-"));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const seen: { files: string; head: string }[] = [];
    const writes: Record<string, string>[] = [];
    const worker = createClaudeCodeWorker({
      workspace: checkout,
      workspaceResolvers: new WorkspaceResolverRegistry([
        new WorkspaceEnvironmentResolver({
          checkouts: [{ name: "app", path: checkout }],
          worktreeRoot: root,
        }),
      ]),
      runner: async function* (request: { workspace: string }) {
        const turn = seen.length;
        seen.push({
          files: git(request.workspace, "ls-files"),
          head: git(request.workspace, "rev-parse", "HEAD"),
        });
        for (const [path, content] of Object.entries(writes[turn] ?? {}))
          await writeFile(join(request.workspace, path), content);
        yield { type: "output.message" as const, text: "Change: Write the files" };
      } as never,
    });
    const directory = await mkdtemp(join(tmpdir(), "supertag-session-state-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    await store.applyWorkspace({ name: "app", ref: "main", delivery: "branch" });
    const owner = await store.createTag({ name: `owner-${randomUUID()}` });
    const member = await store.createTag({ name: `member-${randomUUID()}` });
    // The owner runs nowhere, so its own conversation's turn stays held and the test drives it.
    await store.bindTagWorkerHost(owner.id, "owner-host");
    await store.bindTagWorkerHost(member.id, "host");
    const team = await store.createTeam({
      id: randomUUID(),
      name: `delivery-${randomUUID()}`,
      memberTagIds: [owner.id, member.id],
      maxConcurrency: 2,
    });
    const objective = await store.createObjective({
      id: `objective-${randomUUID().slice(0, 8)}`,
      ownerTagId: owner.id,
      teamId: team.id,
      outcome: "Ship the change.",
      workspaces: ["app"],
    });
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      worklet: durableTestWorklet(new LocalWorklet("w", "host", [worker], { workspaces: ["app"] })),
      reply: async () => undefined,
      dispatch: { pollIntervalMs: 20 },
    });
    const controller = controlPlane.objectives;
    controller.activateCoordination({ url: "http://127.0.0.1:1" });
    await controlPlane.start();
    cleanups.push(() => controlPlane.stop());
    /** One running Attempt of the Objective's own conversation, as a Worker would hold it. */
    const ownerTurn = async (taskId: string) => {
      const task = await store.findTaskById(taskId);
      if (!task?.inboundEventId) throw new Error("The Objective's turn has no event");
      // The dispatcher also tries this held turn, so claim it as soon as it releases the lease.
      const claimed = await eventually(async () =>
        store.claimDueInboundEvent({
          inboundEventId: task.inboundEventId as string,
          leaseOwner: "session-branches",
          now: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      );
      await store.startTask({ taskId, startedAt: new Date().toISOString() });
      const attempt = await store.createTaskAttempt({
        taskId,
        attemptNumber: claimed.attemptCount,
        workerProfile: { id: "default", revision: "1" },
        workerSnapshot: { workerHostId: "owner-host" },
        startedAt: new Date().toISOString(),
      });
      const running = await store.findTaskById(taskId);
      if (!running) throw new Error("Missing owner Task");
      const capability = await controller.surfaceCoordination(running, attempt);
      if (!capability) throw new Error("Missing owner coordination");
      const caller = await controller.authenticateExecution(capability.token);
      /** Ends the turn, so the conversation can take its next one. */
      const end = async () => {
        await store.settleSurfaceAttempt({
          inboundEventId: task.inboundEventId as string,
          leaseOwner: "session-branches",
          workerId: "owner",
          responseText: "Started the work",
          completedAt: new Date().toISOString(),
          now: new Date().toISOString(),
          taskId,
          attemptId: attempt.id,
          status: "completed",
          outcome: {},
        });
      };
      return { caller, end };
    };
    const { taskId: ownerTaskId } = await controlPlane.startObjective(objective.id);
    const usedOwnerTasks = new Set([ownerTaskId]);
    const start = async (files: Record<string, string>) => {
      writes.push(files);
      const turn = await ownerTurn(ownerTaskId);
      const started = (await controller.commandAsAttempt(
        "start_session",
        { title: "Write the files", instruction: "Write the files", tag: member.name },
        turn.caller,
      )) as { sessionId: string };
      await turn.end();
      return started;
    };
    /**
     * The work Session's report is the Objective's next turn; it continues the Session from
     * there, as a review of the delivered work does.
     */
    const next = async (sessionId: string, files: Record<string, string>) => {
      writes.push(files);
      // The report turn runs and ends first; the Session is continued from the turn after it.
      const reportTaskId = await eventually(async () => {
        const session = await store.findObjectiveOwnerSession(objective.id);
        if (!session) return undefined;
        return (await store.listTasks({ sessionId: session.id })).find(
          (task) => !usedOwnerTasks.has(task.id) && task.status === "pending",
        )?.id;
      });
      usedOwnerTasks.add(reportTaskId);
      await (await ownerTurn(reportTaskId)).end();
      const { taskId } = await controlPlane.messageObjective({
        objectiveId: objective.id,
        text: "Carry-on",
        operatorId: "operator",
        idempotencyKey: randomUUID(),
      });
      usedOwnerTasks.add(taskId);
      const turn = await ownerTurn(taskId);
      await controller.commandAsAttempt(
        "continue_session",
        { sessionId, message: "Write the files" },
        turn.caller,
      );
      await turn.end();
    };
    const tasks = (sessionId: string) =>
      store.listTasks({ tagId: member.id, sessionId, limit: 100 });
    const settled = (sessionId: string, count: number) =>
      eventually(async () => {
        const open = await tasks(sessionId);
        return open.length === count &&
          open.every((task) => ["completed", "failed"].includes(task.status))
          ? open.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
          : undefined;
      });
    const delivery = async (taskId: string) =>
      (await store.listTaskEvents(taskId))
        .map((event) => workspaceDeliveryEvidence(event.payload))
        .findLast((evidence) => evidence !== undefined);
    return { checkout, store, seen, start, next, settled, delivery };
  }

  it("starts a work Session's next Task from the branch its earlier Task delivered", async () => {
    const f = await fixture();
    const { sessionId } = await f.start({ "a.txt": "A\n" });
    const [first] = await f.settled(sessionId, 1);
    expect(first?.status).toBe("completed");
    const deliveredA = await f.delivery(first?.id as string);
    expect(deliveredA?.head).not.toBe(deliveredA?.base);

    await f.next(sessionId, { "b.txt": "B\n" });
    const [, second] = await f.settled(sessionId, 2);
    expect(second?.status).toBe("completed");
    // The harness started in a worktree that already held the Session's earlier work.
    const started = f.seen[1];
    expect(started?.files.split("\n")).toEqual(expect.arrayContaining(["README.md", "a.txt"]));
    expect(() =>
      git(
        f.checkout,
        "merge-base",
        "--is-ancestor",
        deliveredA?.head as string,
        started?.head as string,
      ),
    ).not.toThrow();
    // The second Task delivers only its own change, measured from where it started.
    const deliveredB = await f.delivery(second?.id as string);
    expect(deliveredB).toMatchObject({ base: started?.head, changedFiles: 1 });
    expect(git(f.checkout, "diff", "--name-only", `${deliveredB?.base}..${deliveredB?.head}`)).toBe(
      "b.txt",
    );
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

describe("Work Session branches at dispatch", () => {
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
  /** The Tasks of one work Session, oldest first, with the events each Attempt recorded. */
  const store = (
    tasks: {
      id: string;
      workspace?: string;
      createdAt: string;
      events?: ReturnType<typeof progress>[];
    }[],
  ) => ({
    // The store lists a Session's Tasks newest first.
    listTasks: async () =>
      tasks.toReversed().map(
        (task) =>
          ({
            id: task.id,
            tagId: "tag",
            sessionId: "session",
            createdAt: task.createdAt,
            workspacePlan: {
              version: 1,
              status: "workspace",
              workspace: task.workspace ?? "app",
              branch: `supertag/session/${task.id}`,
              delivery: "branch",
            },
          }) as never,
      ),
    listTaskEvents: async (taskId: string) =>
      (tasks.find((task) => task.id === taskId)?.events ?? []) as never,
  });
  const current = {
    id: "c",
    tagId: "tag",
    sessionId: "session",
    createdAt: "2026-01-04T00:00:00.000Z",
    workspacePlan: {
      version: 1,
      status: "workspace",
      workspace: "app",
      branch: "supertag/session/c",
      delivery: "branch",
    },
  } as never;
  const plan = {
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: "supertag/session/c",
    delivery: "branch",
  } as const;

  it("starts from the latest earlier Task of the Session that delivered commits", async () => {
    const branches = await sessionWorkspaceBranches(
      store([
        {
          id: "a",
          createdAt: "2026-01-01T00:00:00.000Z",
          events: [progress("a-1", "supertag/session/a", head("0"), head("4"))],
        },
        {
          id: "b",
          createdAt: "2026-01-02T00:00:00.000Z",
          events: [
            progress("b-1", "supertag/session/b", head("0"), head("1")),
            progress("b-2", "supertag/session/b", head("0"), head("2")),
          ],
        },
      ]),
      current,
      plan,
    );
    // Newest first: the latest delivering Task already holds every earlier edit.
    expect(branches).toEqual([{ taskId: "b", branch: "supertag/session/b", head: head("2") }]);
  });

  it("uses the branch the Worker allocated in its runtime-input manifest", async () => {
    const branch = "supertag/session/a-deadbeef";
    const f = store([{ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }]);
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
    expect(await sessionWorkspaceBranches(f, current, plan)).toEqual([
      { taskId: "a", branch, head: head("4") },
    ]);
  });

  it("skips a Task that delivered nothing, one in another Workspace, and the Task itself", async () => {
    const branches = await sessionWorkspaceBranches(
      store([
        {
          id: "a",
          createdAt: "2026-01-01T00:00:00.000Z",
          events: [progress("a-1", "supertag/session/a", head("0"), head("4"))],
        },
        {
          id: "other",
          workspace: "docs",
          createdAt: "2026-01-02T00:00:00.000Z",
          events: [progress("o-1", "supertag/session/other", head("0"), head("5"))],
        },
        { id: "asked", createdAt: "2026-01-03T00:00:00.000Z" },
        {
          id: "c",
          createdAt: "2026-01-04T00:00:00.000Z",
          events: [progress("c-1", "supertag/session/c", head("0"), head("9"))],
        },
      ]),
      current,
      plan,
    );
    expect(branches).toEqual([{ taskId: "a", branch: "supertag/session/a", head: head("4") }]);
  });
});
