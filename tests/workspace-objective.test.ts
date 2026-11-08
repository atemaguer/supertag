import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import { workSessionBranch } from "../packages/control-plane/src/work-sessions.js";
import type { Task } from "../packages/core/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import {
  COORDINATION_CAPABILITY,
  LocalWorklet,
  SURFACE_COORDINATION_CAPABILITY,
  WORKSPACE_IN_PLACE_CAPABILITY,
  type Worker,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
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
    // The owner runs nowhere: its own conversation's turn stays held, so the test drives that
    // turn's tools itself while the Worker Host runs only the work Sessions it starts.
    await store.bindTagWorkerHost(owner.id, "owner-host");
    await store.bindTagWorkerHost(member.id, "host");
    const team = await store.createTeam({
      id: randomUUID(),
      name: `delivery-${randomUUID()}`,
      memberTagIds: [owner.id, member.id],
      maxConcurrency: 10,
    });
    const objective = await store.createObjective({
      id: `objective-${randomUUID().slice(0, 8)}`,
      ownerTagId: owner.id,
      teamId: team.id,
      outcome: "Ship the change.",
      workspaces,
    });
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      worklet: durableTestWorklet(worklet ?? new LocalWorklet("w", "host", [])),
      reply: async () => undefined,
      dispatch: { pollIntervalMs: 20 },
    });
    const controller = controlPlane.objectives;
    controller.activateCoordination({ url: "http://127.0.0.1:1" });
    await controlPlane.start();
    cleanups.push(() => controlPlane.stop());
    const { taskId: ownerTaskId } = await controlPlane.startObjective(objective.id);
    // The held owner turn, as the Control Plane would hand it to a Worker.
    const ownerTask = await store.findTaskById(ownerTaskId);
    if (!ownerTask?.inboundEventId) throw new Error("The Objective opened no turn");
    const claimed = await store.claimDueInboundEvent({
      inboundEventId: ownerTask.inboundEventId,
      leaseOwner: "workspace-objective",
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    if (!claimed) throw new Error("The Objective's turn was not claimable");
    await store.startTask({ taskId: ownerTaskId, startedAt: new Date().toISOString() });
    const ownerAttempt = await store.createTaskAttempt({
      taskId: ownerTaskId,
      attemptNumber: claimed.attemptCount,
      workerProfile: { id: "default", revision: "1" },
      workerSnapshot: { workerHostId: "owner-host" },
      startedAt: new Date().toISOString(),
    });
    const running = await store.findTaskById(ownerTaskId);
    if (!running) throw new Error("Missing owner Task");
    const capability = await controller.surfaceCoordination(running, ownerAttempt);
    if (!capability) throw new Error("Missing owner coordination");
    const caller = await controller.authenticateExecution(capability.token);
    /** `start_session` from the owner's turn: a work Session of the Team member. */
    const assign = async (extra: Record<string, unknown> = {}) => {
      const started = (await controller.commandAsAttempt(
        "start_session",
        {
          title: "Change the code",
          instruction: "Change the code",
          tag: member.name,
          ...extra,
        },
        caller,
      )) as { sessionId: string };
      const task = (await store.listTasks({ sessionId: started.sessionId }))[0] as Task;
      return { started, task, plan: task?.workspacePlan };
    };
    return { store, controlPlane, controller, objective, owner, member, ownerTaskId, assign };
  }

  it("defaults a work Session to the Objective's only Workspace and pins its plan", async () => {
    const f = await fixture(["app"]);
    expect(f.objective.workspaces).toEqual(["app"]);
    const { started, task, plan } = await f.assign();
    expect(plan).toEqual({
      version: 1,
      status: "workspace",
      workspace: "app",
      ref: "main",
      branch: workSessionBranch(started.sessionId),
      delivery: "patch",
      setup: "pnpm install",
    });
    expect((await f.store.findTaskById(task.id))?.objectiveId).toBe(f.objective.id);
    await expect(f.assign({ workspace: "docs" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("gives each work Session its own branch and keeps a Task's plan once admitted", async () => {
    const f = await fixture(["app"]);
    const sessions = await Promise.all(
      ["Fix the readme", "fix-readme", "Fix Readme"].map((title) => f.assign({ title })),
    );
    const branches = sessions.map(({ plan }) => plan?.status === "workspace" && plan.branch);
    expect(new Set(branches).size).toBe(sessions.length);
    for (const { task, plan } of sessions)
      expect((await f.store.findTaskById(task.id))?.workspacePlan).toEqual(plan);
  });

  it("pins operator mounts at admission and takes no mount input from the caller", async () => {
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
    expect((await f.store.findTaskById(task.id))?.workspacePlan).toMatchObject({ mounts });
    await f.store.applyWorkspace({
      name: "app",
      source: "https://github.com/acme/app.git",
      mounts: [{ volume: "datasets", path: "/mnt/new", access: "read-only", strategy: "copy" }],
      delivery: "branch",
    });
    expect((await f.store.findTaskById(task.id))?.workspacePlan).toMatchObject({ mounts });
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
    expect((await f.store.findTaskById(task.id))?.workspacePlan).toMatchObject({
      skillCatalog,
    });
  });

  it("requires an owner turn to choose among several Workspaces", async () => {
    const f = await fixture(["app", "docs"]);
    await expect(f.assign()).rejects.toMatchObject({
      statusCode: 400,
      message: "This Objective has several Workspaces; pass workspace, one of: app, docs",
    });
    expect((await f.assign({ workspace: "docs" })).plan).toMatchObject({
      status: "workspace",
      workspace: "docs",
      delivery: "branch",
    });
    // The Objective's own conversation works in no Workspace while it names several.
    expect((await f.store.findTaskById(f.ownerTaskId))?.workspacePlan).toEqual({
      version: 1,
      status: "none",
    });
  });

  it("gives the Objective's own conversation its only Workspace, on one Session branch", async () => {
    const f = await fixture(["app"]);
    const ownerTask = await f.store.findTaskById(f.ownerTaskId);
    expect(ownerTask?.workspacePlan).toEqual({
      version: 1,
      status: "workspace",
      workspace: "app",
      ref: "main",
      branch: workSessionBranch(ownerTask?.sessionId as string),
      delivery: "patch",
      setup: "pnpm install",
    });
    // An operator's message is the next turn of the same conversation, so it keeps that plan.
    const { taskId } = await f.controlPlane.messageObjective({
      objectiveId: f.objective.id,
      text: "Please-check-the-build",
      operatorId: "operator",
      idempotencyKey: randomUUID(),
    });
    expect((await f.store.findTaskById(taskId))?.workspacePlan).toEqual(ownerTask?.workspacePlan);
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
                SURFACE_COORDINATION_CAPABILITY,
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
            SURFACE_COORDINATION_CAPABILITY,
            ...(inPlace ? [WORKSPACE_IN_PLACE_CAPABILITY] : []),
          ],
          contextTypes: [],
        };
      },
      async *execute(spec) {
        executions += 1;
        yield {
          type: "execution.started",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          workerId: "worker",
        };
        yield {
          type: "execution.completed",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
        };
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
    const diagnosis = await eventually(async () =>
      (await held.store.listTaskEvents(task.id)).find(
        (event) => event.type === "task.scheduling-incompatible",
      ),
    );
    expect(diagnosis.payload).toMatchObject({
      status: "incompatible",
      unmetRequirements: ["labels:workspace:app"],
    });
    expect(executions).toBe(0);

    const served = await fixture(
      ["app"],
      new LocalWorklet("w", "host", [worker(true)], {
        workspaces: ["app"],
      }),
    );
    const runnable = await served.assign();
    await eventually(async () => executions > 0 || undefined);
    expect(
      (await served.store.listTaskEvents(runnable.task.id)).some(
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
              capabilities: [COORDINATION_CAPABILITY, SURFACE_COORDINATION_CAPABILITY],
              contextTypes: [],
            },
            {
              profile: local,
              harness: "claude-code",
              capabilities: [
                COORDINATION_CAPABILITY,
                SURFACE_COORDINATION_CAPABILITY,
                WORKSPACE_IN_PLACE_CAPABILITY,
              ],
              contextTypes: [],
            },
          ],
        };
      },
      async *execute(spec) {
        profiles.push(spec.workerProfile.id);
        yield {
          type: "execution.started",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          workerId: "mixed",
        };
        yield {
          type: "execution.completed",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
        };
      },
    };
    const worklet = new LocalWorklet("w", "host", [mixed], { workspaces: ["app"] });
    expect((await worklet.describe()).host.labels).toContain("workspace:app");
    const f = await fixture(["app"], worklet);
    await f.assign();
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
              capabilities: [
                COORDINATION_CAPABILITY,
                SURFACE_COORDINATION_CAPABILITY,
                WORKSPACE_IN_PLACE_CAPABILITY,
              ],
              contextTypes: [],
            },
          ],
          id: "worker",
          type: "test",
          profiles: [{ id: "default", revision: "1" }],
          capabilities: [
            COORDINATION_CAPABILITY,
            SURFACE_COORDINATION_CAPABILITY,
            WORKSPACE_IN_PLACE_CAPABILITY,
          ],
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
    const member = (await f.store.findTaskById(task.id))?.tagId as string;
    await f.store.setTagRunsOn(member, ["macos-gpu"]);
    const diagnosis = await eventually(async () =>
      (await f.store.listTaskEvents(task.id)).find(
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
    const failed = await eventually(async () => {
      const current = await f.store.findTaskById(task.id);
      return current?.status === "failed" ? current : undefined;
    });
    expect(harnessStarted).toBe(false);
    expect(failed.outcome).toMatchObject({
      error: "Workspace setup failed (exit 3): install failed",
    });
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
    const failed = await eventually(async () => {
      const current = await f.store.findTaskById(task.id);
      return current?.status === "failed" ? current : undefined;
    });

    await expect(stat(join(root, "escaped"))).rejects.toThrow();
    expect(String(failed.outcome?.["error"])).toContain(
      "Repository config changed during the Task Attempt (repository config",
    );
    expect(failed.outcome?.["failureKind"]).toBe("workspace-integrity");
    // The operator is told, with the Worker's own account of what changed.
    const inbox = await f.store.readCoordinationInbox({ kind: "task_attention" });
    expect(
      inbox.items.map((item) => item.reason).filter((reason) => reason.includes("git config")),
    ).toEqual([expect.stringContaining("The Worker stopped running git for this Task because")]);
    // The Worker restored the repository before giving the Attempt up.
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
