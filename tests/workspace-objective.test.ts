import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { ownerWakeBrief } from "../packages/control-plane/src/owner-wake-brief.js";
import { type TaskAssignment, taskWorkspaceBranch } from "../packages/core/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import {
  COORDINATION_CAPABILITY,
  LocalWorklet,
  WORKSPACE_IN_PLACE_CAPABILITY,
  type Worker,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { createRepository, isolateGitConfiguration } from "./support/git-repository.js";

describe("Objectives with Workspaces", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function fixture(workspaces: string[], worklet?: LocalWorklet) {
    const directory = await mkdtemp(join(tmpdir(), "supertag-workspace-objective-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    await store.applyWorkspace({
      name: "app",
      ref: "main",
      setup: "pnpm install",
      delivery: "patch",
    });
    await store.applyWorkspace({ name: "docs", delivery: "branch" });
    const owner = await store.createTag({ name: `owner-${randomUUID()}` });
    const member = await store.createTag({ name: `member-${randomUUID()}` });
    for (const tag of [owner, member]) await store.bindTagWorkerHost(tag.id, "host");
    const objective = await store.createObjective({
      id: `objective-${randomUUID().slice(0, 8)}`,
      ownerTagId: owner.id,
      outcome: "Ship the change.",
      workspaces,
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
      durableTestWorklet(worklet ?? new LocalWorklet("w", "host", [])),
    );
    controller.activateCoordination({ url: "http://127.0.0.1:1" });
    cleanups.push(() => controller.stop());
    const assign = async (extra: Record<string, unknown> = {}) => {
      const task = (await controller.command("assign_task", {
        objectiveId: objective.id,
        taskId: randomUUID(),
        teamId: team.id,
        assignedTagId: member.id,
        instruction: "Change the code",
        acceptanceCriteria: ["Changed"],
        ...extra,
      })) as TaskAssignment;
      return { task, plan: (await store.findTaskById(task.taskId))?.workspacePlan };
    };
    return { store, controller, objective, assign };
  }

  it("defaults Tasks to the Objective's only Workspace and captures its plan at admission", async () => {
    const f = await fixture(["app"]);
    expect(f.objective.workspaces).toEqual(["app"]);
    const { task, plan } = await f.assign();
    expect(plan).toEqual({
      version: 1,
      status: "workspace",
      workspace: "app",
      ref: "main",
      branch: taskWorkspaceBranch(f.objective.id, task.taskId),
      delivery: "patch",
      setup: "pnpm install",
    });
    expect(plan?.status === "workspace" && plan.branch).toBe(`supertag/${f.objective.id}/task`);
    await expect(f.assign({ workspace: "docs" })).rejects.toMatchObject({
      statusCode: 400,
      message: "workspace must be one of this Objective's Workspaces: app",
    });
  });

  it("reserves colliding Task names concurrently and retains their plans on readmission", async () => {
    const f = await fixture(["app"]);
    const ids = ["fix/readme", "fix-readme", "Fix-Readme"].map(
      (name) => `${f.objective.id}:${name}`,
    );
    const results = await Promise.all(ids.map((taskId) => f.assign({ taskId })));
    const branches = results.map(({ plan }) => plan?.status === "workspace" && plan.branch);
    expect(new Set(branches).size).toBe(ids.length);
    expect(branches).toContain(`supertag/${f.objective.id}/fix-readme`);
    for (const [index, taskId] of ids.entries()) {
      const repeated = await f.assign({ taskId });
      expect(repeated.plan).toEqual(results[index]?.plan);
    }
  });

  it("pins operator mounts at admission and ignores mount input on assignment", async () => {
    const f = await fixture(["app"]);
    const mounts = [
      {
        volume: "datasets",
        path: "/mnt/datasets",
        access: "read-only" as const,
        strategy: "copy" as const,
      },
    ];
    await f.store.applyWorkspace({
      name: "app",
      source: "https://github.com/acme/app.git",
      mounts,
      delivery: "branch",
    });
    await expect(f.assign({ mounts: [{ volume: "other", path: "/mnt/other" }] })).rejects.toThrow(
      "Unknown field: mounts",
    );
    const { task } = await f.assign();
    expect((await f.store.findTaskById(task.taskId))?.workspacePlan).toMatchObject({ mounts });
    await f.store.applyWorkspace({
      name: "app",
      source: "https://github.com/acme/app.git",
      mounts: [{ volume: "datasets", path: "/mnt/new", access: "read-only", strategy: "copy" }],
      delivery: "branch",
    });
    expect((await f.store.findTaskById(task.taskId))?.workspacePlan).toMatchObject({ mounts });
  });

  it("captures the GitHub Skill catalog on the Task when the Workspace changes", async () => {
    const f = await fixture(["app"]);
    const skillCatalog = {
      repository: "acme/skills",
      path: "catalog",
      revision: "main",
      skills: ["review"],
    };
    await f.store.applyWorkspace({ name: "app", delivery: "branch", skillCatalog });
    const { task, plan } = await f.assign();
    expect(plan).toMatchObject({ skillCatalog });
    await f.store.applyWorkspace({ name: "app", delivery: "branch" });
    expect((await f.store.findTaskById(task.taskId))?.workspacePlan).toMatchObject({
      skillCatalog,
    });
  });

  it("requires the lead to choose among several Workspaces", async () => {
    const f = await fixture(["app", "docs"]);
    expect((await f.assign()).plan).toEqual({ version: 1, status: "none" });
    expect((await f.assign({ workspace: "docs" })).plan).toMatchObject({
      status: "workspace",
      workspace: "docs",
      delivery: "branch",
    });
    const started = (await f.controller.command("start_objective", {
      objectiveId: f.objective.id,
      taskId: randomUUID(),
    })) as TaskAssignment;
    // The owner's start Task uses the Objective's first Workspace.
    expect((await f.store.findTaskById(started.taskId))?.workspacePlan).toMatchObject({
      status: "workspace",
      workspace: "app",
    });
  });

  it("gives an operator's Mailbox Task for the owner the Objective's Workspace", async () => {
    const operatorMessage = async (f: Awaited<ReturnType<typeof fixture>>) => {
      // With its start activation open, the owner would receive the message there instead.
      for (const task of await f.store.listTaskAssignments(f.objective.id))
        if (task.status === "queued")
          await f.store.cancelTaskAssignment(task.taskId, task.assignedTagId);
      const sent = await f.store.sendOperatorObjectiveMessage({
        objectiveId: f.objective.id,
        message: "Please check the build.",
        idempotencyKey: randomUUID(),
        operatorId: "operator",
      });
      await f.store.admitMailboxTaskAssignments();
      const taskId = `message:${sent.message.id}`;
      return { taskId, plan: (await f.store.findTaskById(taskId))?.workspacePlan };
    };
    // The only Workspace: the Mailbox Task gets its own Task worktree branch, not a copy.
    const single = await fixture(["app"]);
    await single.controller.command("start_objective", {
      objectiveId: single.objective.id,
      taskId: randomUUID(),
    });
    const only = await operatorMessage(single);
    expect(only.plan).toEqual({
      version: 1,
      status: "workspace",
      workspace: "app",
      ref: "main",
      branch: taskWorkspaceBranch(single.objective.id, only.taskId),
      delivery: "patch",
      setup: "pnpm install",
    });
    const another = await operatorMessage(single);
    expect(another.plan?.status === "workspace" && another.plan.branch).toMatch(
      new RegExp(`^supertag/${single.objective.id}/message-[a-f0-9]{8}$`, "u"),
    );
    expect((await single.store.findTaskById(only.taskId))?.workspacePlan).toEqual(only.plan);
    // Several Workspaces: the owner's previous Task decides.
    const several = await fixture(["docs", "app"]);
    await several.controller.command("start_objective", {
      objectiveId: several.objective.id,
      taskId: randomUUID(),
    });
    expect((await operatorMessage(several)).plan).toMatchObject({
      status: "workspace",
      workspace: "docs",
    });
  });

  it("rejects a workspace on an Objective that names none, and unknown Objective Workspaces", async () => {
    const f = await fixture([]);
    expect((await f.assign()).plan).toEqual({ version: 1, status: "none" });
    await expect(f.assign({ workspace: "app" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.objective.ownerTagId,
        outcome: "Unknown",
        workspaces: ["missing"],
      }),
    ).rejects.toThrow("Workspace missing does not exist");
  });

  it("holds a Task until a bound Worker Host declares a checkout of its Workspace", async () => {
    let executions = 0;
    const worker = (inPlace: boolean): Worker => ({
      async describe() {
        return {
          profileCapabilities: [
            {
              profile: { id: "default", revision: "1" },
              capabilities: [
                COORDINATION_CAPABILITY,
                ...(inPlace ? [WORKSPACE_IN_PLACE_CAPABILITY] : []),
              ],
              contextTypes: [],
            },
          ],
          id: "worker",
          type: "test",
          profiles: [{ id: "default", revision: "1" }],
          capabilities: [
            COORDINATION_CAPABILITY,
            ...(inPlace ? [WORKSPACE_IN_PLACE_CAPABILITY] : []),
          ],
          contextTypes: [],
        };
      },
      async *execute(spec, signal) {
        executions += 1;
        yield {
          type: "execution.started",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          workerId: "worker",
        };
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      },
    });

    // The host declares the Workspace, but its profile cannot use a checkout in place, so the
    // Worklet does not advertise it.
    const held = await fixture(
      ["app"],
      new LocalWorklet("w", "host", [worker(false)], {
        workspaces: ["app"],
      }),
    );
    const { task } = await held.assign();
    held.controller.start();
    const diagnosis = await eventually(async () =>
      (await held.store.listTaskEvents(task.taskId)).find(
        (event) => event.type === "task.scheduling-incompatible",
      ),
    );
    expect(diagnosis.payload).toMatchObject({
      status: "incompatible",
      unmetRequirements: ["labels:workspace:app"],
    });
    expect(executions).toBe(0);
    await held.controller.stop();

    const served = await fixture(
      ["app"],
      new LocalWorklet("w", "host", [worker(true)], {
        workspaces: ["app"],
      }),
    );
    const runnable = await served.assign();
    served.controller.start();
    await eventually(async () => executions > 0 || undefined);
    expect(
      (await served.store.listTaskEvents(runnable.task.taskId)).some(
        (event) => event.type === "task.scheduling-incompatible",
      ),
    ).toBe(false);
  });

  it("runs a workspace Task on the in-place profile of a mixed-profile host", async () => {
    const profiles: string[] = [];
    const local = { id: "z-local", revision: "1" };
    const remote = { id: "a-remote", revision: "1" };
    const mixed: Worker = {
      async describe() {
        return {
          id: "mixed",
          type: "test",
          profiles: [remote, local],
          capabilities: [COORDINATION_CAPABILITY],
          contextTypes: [],
          profileCapabilities: [
            {
              profile: remote,
              harness: "codex",
              capabilities: [COORDINATION_CAPABILITY],
              contextTypes: [],
            },
            {
              profile: local,
              harness: "claude-code",
              capabilities: [COORDINATION_CAPABILITY, WORKSPACE_IN_PLACE_CAPABILITY],
              contextTypes: [],
            },
          ],
        };
      },
      async *execute(spec, signal) {
        profiles.push(spec.workerProfile.id);
        yield {
          type: "execution.started",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          workerId: "mixed",
        };
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      },
    };
    const worklet = new LocalWorklet("w", "host", [mixed], { workspaces: ["app"] });
    expect((await worklet.describe()).host.labels).toContain("workspace:app");
    const f = await fixture(["app"], worklet);
    await f.assign();
    f.controller.start();
    await eventually(async () => profiles.length > 0 || undefined);
    expect(profiles).toEqual(["z-local"]);
  });

  it("requires the Tag's runsOn labels alongside the workspace label", async () => {
    const worker: Worker = {
      async describe() {
        return {
          profileCapabilities: [
            {
              profile: { id: "default", revision: "1" },
              capabilities: [COORDINATION_CAPABILITY, WORKSPACE_IN_PLACE_CAPABILITY],
              contextTypes: [],
            },
          ],
          id: "worker",
          type: "test",
          profiles: [{ id: "default", revision: "1" }],
          capabilities: [COORDINATION_CAPABILITY, WORKSPACE_IN_PLACE_CAPABILITY],
          contextTypes: [],
        };
      },
      // biome-ignore lint/correctness/useYield: The Task must never run.
      async *execute() {
        throw new Error("The Task must stay held");
      },
    };
    const f = await fixture(
      ["app"],
      new LocalWorklet("w", "host", [worker], { workspaces: ["app"] }),
    );
    const { task } = await f.assign();
    const member = (await f.store.findTaskById(task.taskId))?.tagId as string;
    await f.store.setTagRunsOn(member, ["macos-gpu"]);
    f.controller.start();
    const diagnosis = await eventually(async () =>
      (await f.store.listTaskEvents(task.taskId)).find(
        (event) => event.type === "task.scheduling-incompatible",
      ),
    );
    expect(diagnosis.payload).toMatchObject({ unmetRequirements: ["labels:macos-gpu"] });
  });

  it("records a failed review setup for the assigning owner", async () => {
    cleanups.push(await isolateGitConfiguration());
    const checkout = await createRepository();
    const root = await mkdtemp(join(tmpdir(), "supertag-review-setup-"));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let harnessStarted = false;
    const worker = createClaudeCodeWorker({
      workspace: checkout,
      workspaceResolvers: new WorkspaceResolverRegistry([
        new WorkspaceEnvironmentResolver({
          checkouts: [{ name: "app", path: checkout }],
          worktreeRoot: root,
        }),
      ]),
      runner: async function* () {
        harnessStarted = true;
        yield { type: "output.message" as const, text: "Unexpected run" };
      } as never,
    });
    const f = await fixture(
      ["app"],
      new LocalWorklet("w", "host", [worker], { workspaces: ["app"] }),
    );
    await f.store.applyWorkspace({
      name: "app",
      ref: "main",
      setup: "echo install failed >&2; exit 3",
      delivery: "patch",
    });
    const { task, plan } = await f.assign({ instruction: "Review the submitted change" });
    expect(plan).toMatchObject({ setup: "echo install failed >&2; exit 3" });
    f.controller.start();
    const failed = await eventually(async () => {
      const current = await f.store.getTaskAssignment(task.taskId);
      return current?.status === "failed" ? current : undefined;
    });
    expect(harnessStarted).toBe(false);
    expect(failed.result).toMatchObject({
      error: "Workspace setup failed (exit 3): install failed",
      failureKind: "workspace-setup",
    });
    const brief = ownerWakeBrief({
      objective: f.objective,
      task: { ...failed, taskId: "owner-activation" },
      tasks: [failed],
      messages: [],
      since: null,
    });
    expect(brief).toContain(`Task ${task.taskId} failed`);
    expect(brief).toContain(
      'untrusted setup output: "Workspace setup failed (exit 3): install failed"',
    );
  });

  it("fails the Task Attempt as workspace-integrity and tells the operator when the repository config changes", async () => {
    cleanups.push(await isolateGitConfiguration());
    const checkout = await createRepository();
    const root = await mkdtemp(join(tmpdir(), "supertag-integrity-"));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const worker = createClaudeCodeWorker({
      workspace: checkout,
      workspaceResolvers: new WorkspaceResolverRegistry([
        new WorkspaceEnvironmentResolver({
          checkouts: [{ name: "app", path: checkout }],
          worktreeRoot: root,
        }),
      ]),
      // An unsandboxed harness adds a filter driver to the shared repository config.
      runner: async function* () {
        const worktrees = join(root, "app", "worktrees");
        for (const tree of await readdir(worktrees))
          await writeFile(join(worktrees, tree, ".gitattributes"), "* filter=evil\n");
        await appendFile(
          join(checkout, ".git", "config"),
          `[filter "evil"]\n\tclean = "sh -c 'touch ${join(root, "escaped")}; cat'"\n`,
        );
        yield { type: "output.message" as const, text: "Changed the config" };
      } as never,
    });
    const f = await fixture(
      ["app"],
      new LocalWorklet("w", "host", [worker], { workspaces: ["app"] }),
    );
    await f.store.applyWorkspace({ name: "app", ref: "main", delivery: "branch" });
    const { task } = await f.assign();
    f.controller.start();
    const failed = await eventually(async () => {
      const current = await f.store.getTaskAssignment(task.taskId);
      return current?.status === "failed" ? current : undefined;
    });
    expect(failed.result).toMatchObject({ failureKind: "workspace-integrity" });
    await expect(stat(join(root, "escaped"))).rejects.toThrow();
    expect(String(failed.result?.["error"])).toContain(
      "Repository config changed during the Task Attempt (repository config",
    );
    const inbox = await f.controller.readCoordinationInbox({
      objectiveId: f.objective.id,
      kind: "task_attention",
    });
    expect(inbox.items).toEqual([
      expect.objectContaining({
        key: `task_attention:${task.taskId}`,
        kind: "task_attention",
        nextActorTagIds: [],
        operatorEligible: true,
        reason: expect.stringContaining("repository's git config changed during its Task Attempt"),
      }),
    ]);
    expect(inbox.items[0]?.reason).toContain("repository config: modified");
    expect(await readFile(join(checkout, ".git", "config"), "utf8")).not.toContain("evil");
  });
});

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
