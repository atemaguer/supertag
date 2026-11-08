import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import { sessionBranchPin } from "../packages/control-plane/src/session-branch.js";
import { workspaceDeliveryEvidence } from "../packages/core/src/index.js";
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

  it("commits a work Session's next Task onto the branch its earlier Task delivered", async () => {
    const f = await fixture();
    const { sessionId } = await f.start({ "a.txt": "A\n" });
    const [first] = await f.settled(sessionId, 1);
    expect(first?.status).toBe("completed");
    const deliveredA = await f.delivery(first?.id as string);
    expect(deliveredA?.head).not.toBe(deliveredA?.base);

    await f.next(sessionId, { "b.txt": "B\n" });
    const [, second] = await f.settled(sessionId, 2);
    expect(second?.status).toBe("completed");
    expect(second?.workspacePlan).toMatchObject({ branch: deliveredA?.branch });
    // The harness started on the Session's branch, at the earlier Task's commit.
    const started = f.seen[1];
    expect(started?.files.split("\n")).toEqual(expect.arrayContaining(["README.md", "a.txt"]));
    expect(started?.head).toBe(deliveredA?.head);
    // The second Task's commit sits on top of the first on the same branch, which holds both.
    const deliveredB = await f.delivery(second?.id as string);
    expect(deliveredB).toMatchObject({
      branch: deliveredA?.branch,
      base: deliveredA?.base,
      changedFiles: 2,
    });
    expect(git(f.checkout, "rev-parse", `${deliveredB?.head}^`)).toBe(deliveredA?.head);
    expect(git(f.checkout, "rev-parse", deliveredA?.branch as string)).toBe(deliveredB?.head);
    expect(git(f.checkout, "branch", "--list", "--format=%(refname:short)", "supertag/*")).toBe(
      deliveredA?.branch,
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

describe("A Session's branch at dispatch", () => {
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

  it("pins the latest earlier Task of the Session that delivered commits", async () => {
    const pin = await sessionBranchPin(
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
    // Newest first: the latest delivering Task's head holds every earlier edit.
    expect(pin).toEqual({ branch: "supertag/session/b", head: head("2") });
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
    expect(await sessionBranchPin(f, current, plan)).toEqual({ branch, head: head("4") });
  });

  it("skips a Task that delivered nothing, one in another Workspace, and the Task itself", async () => {
    const pin = await sessionBranchPin(
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
    expect(pin).toEqual({ branch: "supertag/session/a", head: head("4") });
  });
});

describe("One branch per Session on a Worker Host", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  let checkout: string;
  let root: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    checkout = await createRepository();
    root = await mkdtemp(join(tmpdir(), "supertag-session-worktrees-"));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const branch = "supertag/session/5e55104a";
  /** Task `taskId` of Session `sessionId`, as the Control Plane dispatches it. */
  const spec = (taskId: string, sessionId = "5e55104a-0000-4000-8000-000000000000") =>
    ({
      taskId,
      attemptId: `${taskId}:attempt-1`,
      session: { id: sessionId },
      workspacePlan: {
        version: 1,
        status: "workspace",
        workspace: "app",
        branch,
        delivery: "branch",
      },
      authorization: { runtimeActions: ["files:write"] },
    }) as unknown as TaskAttemptSpec;
  const context = (task: TaskAttemptSpec) =>
    ({ task, profile: { harness: { provider: "codex" } } }) as unknown as ResolutionContext;
  /** Resolves `task`'s worktree, writes `files` there, and returns its path. */
  const work = async (
    workspaces: WorkspaceEnvironmentResolver,
    task: TaskAttemptSpec,
    files: Record<string, string>,
  ) => {
    const input = await workspaces.resolve(context(task));
    const path = fileURLToPath(input?.source.uri ?? "");
    for (const [name, content] of Object.entries(files)) await writeFile(join(path, name), content);
    return { path, branch: input?.source.provenance?.["branch"] };
  };
  const workspaces = () =>
    new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
    });

  it("commits a later Task of the Session onto the branch, on top of the earlier Task's commit", async () => {
    const base = git(checkout, "rev-parse", "main");
    const first = spec("task-1");
    await work(workspaces(), first, { "a.txt": "A\n" });
    const a = await workspaces().finalize(first, "completed");
    expect(a).toMatchObject({ branch, base });

    const second = spec("task-2");
    const started = await work(workspaces(), second, { "b.txt": "B\n" });
    expect(started.branch).toBe(branch);
    expect(git(started.path, "branch", "--show-current")).toBe(branch);
    expect(git(started.path, "rev-parse", "HEAD")).toBe(a?.head);
    const b = await workspaces().finalize(second, "completed");
    // The branch holds both Tasks' commits; delivery measures the Session's changes from its base.
    expect(b).toMatchObject({ branch, base, changedFiles: 2 });
    expect(git(checkout, "rev-parse", `${b?.head}^`)).toBe(a?.head);
    expect(git(checkout, "rev-parse", branch)).toBe(b?.head);
    expect(git(checkout, "branch", "--list", "--format=%(refname:short)", "supertag/*")).toBe(
      branch,
    );
  });

  it("frees the branch from the worktree a failed earlier Task kept", async () => {
    const first = spec("task-1");
    const kept = await work(workspaces(), first, { "a.txt": "A\n" });
    const a = await workspaces().finalize(first, "failed");
    expect(a?.worktreeRemoved).toBe(false);

    const second = spec("task-2");
    const started = await work(workspaces(), second, { "b.txt": "B\n" });
    expect(git(started.path, "rev-parse", "HEAD")).toBe(a?.head);
    await expect(stat(kept.path)).rejects.toMatchObject({ code: "ENOENT" });
    const b = await workspaces().finalize(second, "completed");
    expect(git(checkout, "rev-parse", `${b?.head}^`)).toBe(a?.head);
  });

  it("refuses the branch while an earlier Task's worktree has uncommitted changes", async () => {
    const first = spec("task-1");
    const kept = await work(workspaces(), first, { "a.txt": "A\n" });
    await workspaces().finalize(first, "failed");
    await writeFile(join(kept.path, "late.txt"), "written after the Attempt\n");

    await expect(work(workspaces(), spec("task-2"), {})).rejects.toThrow(
      `Branch ${branch} is checked out in an earlier Task's worktree with uncommitted changes`,
    );
    expect(git(kept.path, "status", "--porcelain")).toContain("late.txt");
  });

  it("refuses the branch while another Task of the Session runs on it", async () => {
    const shared = workspaces();
    await work(shared, spec("task-1"), { "a.txt": "A\n" });
    await expect(work(shared, spec("task-2"), {})).rejects.toThrow(
      `Branch ${branch} is in use by another running Task Attempt`,
    );
  });

  it("refuses the branch while a person has it checked out in the declared checkout", async () => {
    const first = spec("task-1");
    await work(workspaces(), first, { "a.txt": "A\n" });
    await workspaces().finalize(first, "completed");
    git(checkout, "switch", "--quiet", branch);

    await expect(work(workspaces(), spec("task-2"), {})).rejects.toThrow(
      `Branch ${branch} is checked out in another working tree of Workspace app`,
    );
  });

  it("gives the Session a suffixed branch of its own when an unrelated branch has the name", async () => {
    git(checkout, "branch", branch, "main");
    const unrelated = git(checkout, "rev-parse", branch);
    const first = spec("task-1");
    const started = await work(workspaces(), first, { "a.txt": "A\n" });
    expect(started.branch).toMatch(new RegExp(`^${branch}-[0-9a-f]{8}$`, "u"));
    const a = await workspaces().finalize(first, "completed");

    // Later Tasks of the Session keep the suffixed branch, and the unrelated one is never touched.
    const second = spec("task-2");
    expect((await work(workspaces(), second, { "b.txt": "B\n" })).branch).toBe(started.branch);
    const b = await workspaces().finalize(second, "completed");
    expect(b?.branch).toBe(started.branch);
    expect(git(checkout, "rev-parse", `${b?.head}^`)).toBe(a?.head);
    expect(git(checkout, "rev-parse", branch)).toBe(unrelated);
  });

  it("never gives another Session's Task the branch", async () => {
    const first = spec("task-1");
    await work(workspaces(), first, { "a.txt": "A\n" });
    const a = await workspaces().finalize(first, "completed");
    const other = spec("task-9", "5e55104a-9999-4000-8000-000000000000");
    const started = await work(workspaces(), other, {});
    expect(started.branch).not.toBe(branch);
    expect(git(started.path, "rev-parse", "HEAD")).toBe(git(checkout, "rev-parse", "main"));
    expect(git(checkout, "rev-parse", branch)).toBe(a?.head);
  });
  it("continues the branch from a commit a person added to it", async () => {
    const first = spec("task-1");
    await work(workspaces(), first, { "a.txt": "A\n" });
    const a = await workspaces().finalize(first, "completed");
    const head = a?.head ?? "";
    const added = git(checkout, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "Person");
    git(checkout, "update-ref", `refs/heads/${branch}`, added, head);

    const started = await work(workspaces(), spec("task-2"), {});
    expect(started.branch).toBe(branch);
    expect(git(started.path, "rev-parse", "HEAD")).toBe(added);
  });

  it("refuses the branch once it no longer holds the Session's last commit", async () => {
    const first = spec("task-1");
    await work(workspaces(), first, { "a.txt": "A\n" });
    const a = await workspaces().finalize(first, "completed");
    git(checkout, "branch", "--force", branch, "main");

    await expect(work(workspaces(), spec("task-2"), {})).rejects.toThrow(
      `Branch ${branch} no longer holds commit ${a?.head?.slice(0, 12)}`,
    );
    expect(git(checkout, "rev-parse", branch)).toBe(git(checkout, "rev-parse", "main"));
  });

  it("adopts the pinned branch on another Worker Host that serves the same checkout", async () => {
    const first = spec("task-1");
    await work(workspaces(), first, { "a.txt": "A\n" });
    const a = await workspaces().finalize(first, "completed");
    const otherRoot = await mkdtemp(join(tmpdir(), "supertag-session-worktrees-b-"));
    cleanups.push(() => rm(otherRoot, { recursive: true, force: true }));
    const other = new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: otherRoot,
    });
    const second = spec("task-2");
    const pinned = {
      ...second,
      workspacePlan: { ...second.workspacePlan, branchPin: branch, branchPinHead: a?.head },
    } as unknown as TaskAttemptSpec;
    const started = await work(other, pinned, { "b.txt": "B\n" });
    expect(started.branch).toBe(branch);
    expect(git(started.path, "rev-parse", "HEAD")).toBe(a?.head);
  });

  it("refuses a pinned branch this Worker Host does not have", async () => {
    const head = git(checkout, "rev-parse", "main");
    const second = spec("task-2");
    const pinned = {
      ...second,
      workspacePlan: { ...second.workspacePlan, branchPin: branch, branchPinHead: head },
    } as unknown as TaskAttemptSpec;
    await expect(work(workspaces(), pinned, {})).rejects.toThrow(
      `Branch ${branch} holds commit ${head.slice(0, 12)} on another Worker Host and was not pushed`,
    );
  });
});
