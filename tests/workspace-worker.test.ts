import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TaskNamedWorkspacePlan, taskWorkspaceBranch } from "../packages/core/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import { createCursorWorker } from "../packages/runtime/harnesses/cursor/src/index.js";
import { createOpenCodeWorker } from "../packages/runtime/harnesses/opencode/src/index.js";
import {
  collectTaskAttemptEvents,
  type ExecutionEnvironment,
  type ExecutionEnvironmentProvider,
  type HarnessRuntime,
  LocalWorklet,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  WORKSPACE_ENVIRONMENT_CAPABILITY,
  WORKSPACE_IN_PLACE_CAPABILITY,
  type Worker,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
} from "../packages/runtime/sdk/src/index.js";
import { FileArtifactStore } from "./support/file-artifact-store.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

type Runner = (
  request: { readonly workspace: string },
  environment: HarnessRuntime | ExecutionEnvironment,
) => AsyncIterable<{ readonly type: "output.message"; readonly text: string }>;

describe("Workers on in-place Workspace worktrees", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let checkout: string;
  let root: string;
  let fallback: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    checkout = await createRepository();
    root = await mkdtemp(join(tmpdir(), "supertag-worktrees-"));
    fallback = await mkdtemp(join(tmpdir(), "supertag-fallback-"));
    const state = await mkdtemp(join(tmpdir(), "supertag-worker-state-"));
    const prior = process.env["SUPERTAG_STATE_DIR"];
    process.env["SUPERTAG_STATE_DIR"] = state;
    cleanups.push(() => {
      if (prior === undefined) delete process.env["SUPERTAG_STATE_DIR"];
      else process.env["SUPERTAG_STATE_DIR"] = prior;
    });
    for (const path of [checkout, root, fallback, state])
      cleanups.push(() => rm(path, { recursive: true, force: true }));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const resolvers = () =>
    new WorkspaceResolverRegistry([
      new WorkspaceEnvironmentResolver({
        checkouts: [{ name: "app", path: checkout }],
        worktreeRoot: root,
      }),
    ]);
  const plan = (delivery: "patch" | "branch" = "branch"): TaskNamedWorkspacePlan => ({
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: taskWorkspaceBranch("objective-1", "task-1"),
    delivery,
  });

  /** Writes a file in the directory the harness received, and proves nothing was copied. */
  const writingRunner = (seen: string[]): Runner =>
    async function* (request, environment) {
      seen.push(request.workspace);
      expect(request.workspace.startsWith(root)).toBe(true);
      // The execution root holds no staged copy of the checkout.
      const staged = await readdir(environment.rootDirectory);
      expect(staged).not.toContain("workspace");
      expect(staged).not.toContain("README.md");
      await writeFile(join(request.workspace, "harness.txt"), "written in place\n");
      yield { type: "output.message", text: "Implemented the change." };
    };

  const workers: Record<string, (runner: Runner) => Worker> = {
    "claude-code": (runner) =>
      createClaudeCodeWorker({
        workspace: fallback,
        workspaceResolvers: resolvers(),
        runner: runner as never,
      }),
    codex: (runner) =>
      createCodexWorker({
        workspace: fallback,
        workspaceResolvers: resolvers(),
        runner: runner as never,
      }),
    cursor: (runner) =>
      createCursorWorker({
        workspace: fallback,
        workspaceResolvers: resolvers(),
        runner: runner as never,
      }),
    opencode: (runner) =>
      createOpenCodeWorker({
        model: "provider/model",
        workspaceResolvers: resolvers(),
        runner: runner as never,
      }),
  };

  it("loads a selected GitHub catalog Skill into a real Workspace Task Attempt", async () => {
    const catalogRepo = await createRepository();
    cleanups.push(() => rm(catalogRepo, { recursive: true, force: true }));
    const skill = join(catalogRepo, "catalog", "review");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "Review the change carefully.");
    git(catalogRepo, "add", "catalog/review/SKILL.md");
    git(catalogRepo, "commit", "--quiet", "-m", "Add review Skill");
    const commit = git(catalogRepo, "rev-parse", "HEAD");
    const workspacePlan = {
      ...plan(),
      skillCatalog: {
        repository: "acme/agent-skills",
        path: "catalog",
        revision: "main",
        skills: ["review"],
      },
    };
    const worker = createCodexWorker({
      workspace: fallback,
      workspaceResolvers: new WorkspaceResolverRegistry([
        new WorkspaceEnvironmentResolver({
          checkouts: [{ name: "app", path: checkout }],
          worktreeRoot: root,
          catalogSourceUrl: catalogRepo,
        }),
      ]),
      runner: async function* (
        _request: { readonly workspace: string },
        environment: HarnessRuntime | ExecutionEnvironment,
      ) {
        const content = await readFile(
          join(environment.rootDirectory, ".agents/skills/skill-review/SKILL.md"),
          "utf8",
        );
        yield { type: "output.message" as const, text: content };
      } as never,
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(attemptSpec("codex", workspacePlan, ["files:write"])),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "output.message",
        message: { role: "teammate", text: "Review the change carefully." },
      }),
    );
    const resolved = events.find(
      (event): event is Extract<TaskAttemptEvent, { type: "runtime-inputs.resolved" }> =>
        event.type === "runtime-inputs.resolved",
    );
    expect(JSON.stringify(resolved)).toContain(`github:acme/agent-skills/catalog/review@${commit}`);
    const digest = resolved?.manifest.inputs.find((input) => input.id === "skill:review")?.resource
      .digest;
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await writeFile(join(skill, "SKILL.md"), "Changed catalog guidance.");
    git(catalogRepo, "add", "catalog/review/SKILL.md");
    git(catalogRepo, "commit", "--quiet", "-m", "Change review Skill");
    const retry = {
      ...attemptSpec("codex", workspacePlan, ["files:write"]),
      attemptId: "attempt-2",
      workspacePlan: {
        ...workspacePlan,
        skillPins: [
          {
            name: "review",
            source: `github:acme/agent-skills/catalog/review@${commit}`,
            digest: digest ?? "",
          },
        ],
      },
    };
    const retryEvents = await collectTaskAttemptEvents(worker.execute(retry));
    expect(retryEvents.at(-1)?.type).toBe("execution.completed");
    expect(retryEvents).toContainEqual(
      expect.objectContaining({
        type: "output.message",
        message: { role: "teammate", text: "Review the change carefully." },
      }),
    );
  }, 30_000);

  it("advertises Workspace environments on a registered remote provider", async () => {
    const workspaceEnvironment = {
      provider: "fake",
      capabilities: {
        sharedPrepare: true,
        setupOnHost: false,
        declaredCheckouts: false,
        devcontainer: false,
        mcpStdio: "sandbox",
      },
      refuse: () => undefined,
    };
    const remote: ExecutionEnvironmentProvider = {
      id: "remote-sandbox",
      capabilities: [],
      workspaceEnvironment: workspaceEnvironment as never,
      async provision() {
        throw new Error("must not provision");
      },
    };
    const worker = createClaudeCodeWorker({
      workspace: fallback,
      workspaceResolvers: new WorkspaceResolverRegistry([
        new WorkspaceEnvironmentResolver({
          checkouts: [{ name: "app", path: checkout }],
          worktreeRoot: root,
          environments: { "remote-sandbox": workspaceEnvironment as never },
        }),
      ]),
      executionEnvironment: remote,
      runner: writingRunner([]) as never,
    });
    const descriptor = await worker.describe();
    expect(descriptor.profileCapabilities?.[0]?.capabilities).toContainEqual(
      WORKSPACE_ENVIRONMENT_CAPABILITY,
    );
    expect(descriptor.profileCapabilities?.[0]?.workspaceRefusal).toBeUndefined();
  });

  for (const [harness, create] of Object.entries(workers))
    it(`${harness} edits the Task worktree in place and the Worker commits it to the branch`, async () => {
      const seen: string[] = [];
      const worker = create(writingRunner(seen));
      const events = await collectTaskAttemptEvents(
        worker.execute(attemptSpec(harness, plan(), ["files:write"])),
      );
      expect(events.at(-1)?.type).toBe("execution.completed");
      expect(seen).toHaveLength(1);
      const branch = plan().branch;
      expect(git(checkout, "show", "--name-only", "--format=%an", branch)).toBe(
        "SuperTag\n\nharness.txt",
      );
      expect(git(checkout, "show", `${branch}:harness.txt`)).toBe("written in place");
      // The worktree is removed after the completed Attempt; the checkout is untouched.
      await expect(stat(seen[0] as string)).rejects.toThrow();
      expect(git(checkout, "status", "--porcelain")).toBe("");
      expect(git(checkout, "symbolic-ref", "--short", "HEAD")).toBe("main");

      const progress = events.find(
        (event): event is Extract<TaskAttemptEvent, { type: "progress.updated" }> =>
          event.type === "progress.updated",
      );
      expect(progress?.progress.summary).toBe(`Committed workspace app changes to ${branch}`);
      expect(progress?.progress.items?.map((item) => item.text)).toEqual([
        `Branch: ${branch}`,
        `Base: ${git(checkout, "rev-parse", "main")}`,
        `Head: ${git(checkout, "rev-parse", branch)}`,
        "Changed files: 1",
      ]);
      const result = events.find(
        (event): event is Extract<TaskAttemptEvent, { type: "result" }> => event.type === "result",
      );
      expect(result?.result.changes).toEqual([
        {
          summary: expect.stringContaining(`branch ${branch} at `),
          reference: `git:${branch}@${git(checkout, "rev-parse", branch)}`,
        },
      ]);
    });

  it("keeps repository OpenCode config and its MCP servers out of an in-place run", async () => {
    const repositoryConfig = JSON.stringify({
      mcp: { repo: { type: "remote", url: "https://repo-mcp.example.test/mcp", enabled: true } },
    });
    await writeFile(join(checkout, "opencode.json"), repositoryConfig);
    git(checkout, "add", "opencode.json");
    git(checkout, "commit", "-m", "Add repository OpenCode config");
    let environment: Record<string, string> = {};
    let workspace = "";
    const worker = createOpenCodeWorker({
      model: "provider/model",
      workspaceResolvers: resolvers(),
      runner: async function* (request: {
        readonly workspace: string;
        readonly environment: Record<string, string>;
      }) {
        workspace = request.workspace;
        environment = request.environment;
        yield { type: "output.message" as const, text: "Reviewed." };
      } as never,
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(attemptSpec("opencode", plan(), ["files:write"])),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
    // OpenCode runs in the checkout, which holds the repository's opencode.json ...
    expect(workspace.startsWith(root)).toBe(true);
    // ... so it must not discover project config, and SuperTag's config names no such server.
    expect(environment["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("true");
    expect(environment["OPENCODE_DISABLE_CLAUDE_CODE"]).toBe("true");
    const config = JSON.parse(environment["OPENCODE_CONFIG_CONTENT"] ?? "{}") as {
      mcp: Record<string, unknown>;
    };
    expect(config.mcp).toEqual({});
    expect(JSON.stringify(environment)).not.toContain("repo-mcp.example.test");
  });

  it("attaches a patch artifact for patch delivery", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "supertag-artifacts-"));
    cleanups.push(() => rm(artifacts, { recursive: true, force: true }));
    const store = new FileArtifactStore(artifacts);
    const worker = createClaudeCodeWorker({
      workspace: fallback,
      workspaceResolvers: resolvers(),
      artifactStore: store,
      runner: writingRunner([]) as never,
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(attemptSpec("claude-code", plan("patch"), ["files:write"])),
    );
    const created = events.find(
      (event): event is Extract<TaskAttemptEvent, { type: "artifact.created" }> =>
        event.type === "artifact.created",
    );
    expect(created?.artifact).toMatchObject({
      name: "supertag-objective-1-task-1.patch",
      mediaType: "text/x-diff",
    });
    const patch = new TextDecoder().decode(await store.get(created?.artifact as never));
    expect(patch).toContain("+written in place");
    const result = events.find(
      (event): event is Extract<TaskAttemptEvent, { type: "result" }> => event.type === "result",
    );
    expect(result?.result.changes[0]?.summary).toContain("patch of 1 changed file");
  });

  it("delivers no branch for a completed Attempt that made no commits", async () => {
    const worker = createClaudeCodeWorker({
      workspace: fallback,
      workspaceResolvers: resolvers(),
      runner: async function* () {
        yield { type: "output.message", text: "Reviewed; no changes needed." };
      } as never,
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(attemptSpec("claude-code", plan(), ["files:write"])),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
    expect(git(checkout, "branch", "--list", "supertag/*")).toBe("");
    const progress = events.find(
      (event): event is Extract<TaskAttemptEvent, { type: "progress.updated" }> =>
        event.type === "progress.updated",
    );
    expect(progress?.progress.summary).toBe("No workspace app commits; no Task branch kept");
    expect(JSON.stringify(progress?.progress)).not.toContain(plan().branch);
    const result = events.find(
      (event): event is Extract<TaskAttemptEvent, { type: "result" }> => event.type === "result",
    );
    expect(result?.result.changes).toEqual([
      { summary: "Workspace app: no commits; no Task branch kept" },
    ]);
  });

  it("keeps a harness from reporting the Worker's Workspace delivery record", async () => {
    const forged = "f".repeat(40);
    const worker = createClaudeCodeWorker({
      workspace: fallback,
      workspaceResolvers: resolvers(),
      runner: async function* (request: { readonly workspace: string }) {
        await writeFile(join(request.workspace, "change.txt"), "change\n");
        yield {
          type: "progress.updated" as const,
          progress: {
            summary: "Delivered",
            items: [
              { id: "workspace-branch", text: `Branch: ${plan().branch}`, status: "completed" },
              { id: "workspace-base", text: `Base: ${"0".repeat(40)}`, status: "completed" },
              { id: "workspace-head", text: `Head: ${forged}`, status: "completed" },
              { id: "tests", text: "Run tests", status: "active" },
            ],
          },
        };
        yield { type: "output.message" as const, text: "Changed." };
      } as never,
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(attemptSpec("claude-code", plan(), ["files:write"])),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
    const progress = events.filter(
      (event): event is Extract<TaskAttemptEvent, { type: "progress.updated" }> =>
        event.type === "progress.updated",
    );
    expect(progress[0]?.progress.items).toEqual([
      { id: "tests", text: "Run tests", status: "active" },
    ]);
    expect(JSON.stringify(events)).not.toContain(`Head: ${forged}`);
    expect(progress.at(-1)?.progress.items).toContainEqual({
      id: "workspace-head",
      text: `Head: ${git(checkout, "rev-parse", plan().branch)}`,
      status: "completed",
    });
  });

  it("leaves no branch or worktree after a failed Attempt that made no commits", async () => {
    let path = "";
    const worker = createClaudeCodeWorker({
      workspace: fallback,
      workspaceResolvers: resolvers(),
      runner: async function* (request: { readonly workspace: string }) {
        path = request.workspace;
        yield* [];
        throw new Error("Harness crashed");
      } as never,
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(attemptSpec("claude-code", plan(), ["files:write"])),
    );
    expect(events.at(-1)).toMatchObject({ type: "execution.failed" });
    expect(git(checkout, "branch", "--list", "supertag/*")).toBe("");
    await expect(stat(path)).rejects.toThrow();
    const progress = events.find(
      (event): event is Extract<TaskAttemptEvent, { type: "progress.updated" }> =>
        event.type === "progress.updated",
    );
    expect(progress?.progress.summary).toBe("No workspace app commits; no Task branch kept");
    expect(JSON.stringify(progress?.progress)).not.toContain(plan().branch);
  });

  it("records setup failure before a review harness starts", async () => {
    let started = false;
    const worker = createClaudeCodeWorker({
      workspace: fallback,
      workspaceResolvers: resolvers(),
      runner: async function* () {
        started = true;
        yield { type: "output.message" as const, text: "Unexpected run" };
      } as never,
    });
    const spec = attemptSpec(
      "claude-code",
      { ...plan(), setup: "echo install failed >&2; exit 3" },
      ["files:write"],
    );
    const events = await collectTaskAttemptEvents(worker.execute(spec));
    expect(started).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "execution.failed",
      error: {
        name: "WorkspaceSetupError",
        message: "Workspace setup failed (exit 3): install failed",
      },
    });
  });

  it("commits the work of a failed Attempt and keeps the worktree for a retry", async () => {
    let path = "";
    const worker = createClaudeCodeWorker({
      workspace: fallback,
      workspaceResolvers: resolvers(),
      runner: async function* (request: { readonly workspace: string }) {
        path = request.workspace;
        await writeFile(join(request.workspace, "partial.txt"), "partial\n");
        yield* [];
        throw new Error("Harness crashed");
      } as never,
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(attemptSpec("claude-code", plan(), ["files:write"])),
    );
    expect(events.at(-1)).toMatchObject({ type: "execution.failed" });
    expect(git(checkout, "show", `${plan().branch}:partial.txt`)).toBe("partial");
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  for (const harness of ["claude-code", "codex"] as const)
    it(`${harness} runs two Attempts at once, each in its own Task worktree`, async () => {
      const seen: string[] = [];
      let release = () => {};
      const bothStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runner = async function* (request: { readonly workspace: string }) {
        seen.push(request.workspace);
        await writeFile(join(request.workspace, "attempt.txt"), `${seen.length}\n`);
        if (seen.length === 2) release();
        await bothStarted;
        yield { type: "output.message" as const, text: "Done." };
      };
      const options = {
        workspace: fallback,
        workspaceResolvers: resolvers(),
        maxConcurrency: 2,
        runner: runner as never,
      };
      const worker =
        harness === "codex" ? createCodexWorker(options) : createClaudeCodeWorker(options);
      expect((await worker.describe()).maxConcurrency).toBe(2);
      const spec = (taskId: string) => ({
        ...attemptSpec(harness, { ...plan(), branch: taskWorkspaceBranch("objective-1", taskId) }, [
          "files:write",
        ]),
        taskId,
        attemptId: `${taskId}-attempt`,
      });
      const results = await Promise.all(
        ["task-a", "task-b"].map((taskId) =>
          collectTaskAttemptEvents(worker.execute(spec(taskId))),
        ),
      );
      expect(results.map((events) => events.at(-1)?.type)).toEqual([
        "execution.completed",
        "execution.completed",
      ]);
      expect(new Set(seen).size).toBe(2);
      for (const taskId of ["task-a", "task-b"])
        expect(
          git(checkout, "show", `${taskWorkspaceBranch("objective-1", taskId)}:attempt.txt`),
        ).toMatch(/^[12]$/u);
    });

  it("runs a Mailbox Task on a repository that tracks a relative symbolic link", async () => {
    await mkdir(join(checkout, "deploy", "docker"), { recursive: true });
    await writeFile(
      join(checkout, "deploy", "docker", "Dockerfile.dockerignore"),
      "node_modules\n",
    );
    await symlink("deploy/docker/Dockerfile.dockerignore", join(checkout, ".dockerignore"));
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "Track a link");
    const read: string[] = [];
    const runner = async function* (request: { readonly workspace: string }) {
      read.push(await readFile(join(request.workspace, ".dockerignore"), "utf8"));
      yield { type: "output.message" as const, text: "Assessed the message." };
    };
    const taskId = "message:7a1d5a1c-0000-4000-8000-000000000001";
    const mailboxPlan = { ...plan(), branch: taskWorkspaceBranch("objective-1", taskId) };
    const worker = createClaudeCodeWorker({
      workspace: fallback,
      workspaceResolvers: resolvers(),
      runner: runner as never,
    });
    const events = await collectTaskAttemptEvents(
      worker.execute({ ...attemptSpec("claude-code", mailboxPlan, []), taskId }),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
    expect(read).toEqual(["node_modules\n"]);

    // A Task without a Workspace stages a copy of the host's folder: links inside it survive,
    await symlink(join(checkout, "README.md"), join(fallback, "outside"));
    const none = { version: 1, status: "none" } as unknown as TaskNamedWorkspacePlan;
    await writeFile(join(fallback, "notes.md"), "notes\n");
    await symlink("notes.md", join(fallback, "linked-notes.md"));
    // but a link that leaves the folder fails the Attempt.
    const escaping = await collectTaskAttemptEvents(
      createClaudeCodeWorker({ workspace: fallback, runner: runner as never }).execute(
        attemptSpec("claude-code", none, []),
      ),
    );
    expect(escaping.at(-1)).toMatchObject({
      type: "execution.failed",
      error: { message: expect.stringContaining("points outside the workspace") },
    });
    await rm(join(fallback, "outside"));
    const copied = await collectTaskAttemptEvents(
      createClaudeCodeWorker({
        workspace: fallback,
        runner: async function* (request: { readonly workspace: string }) {
          read.push(await readFile(join(request.workspace, "linked-notes.md"), "utf8"));
          yield { type: "output.message" as const, text: "Read the copy." };
        } as never,
      }).execute(attemptSpec("claude-code", none, [])),
    );
    expect(copied.at(-1)?.type).toBe("execution.completed");
    expect(read.at(-1)).toBe("notes\n");
  });

  it("refuses the Attempt when its provider has no Workspace environment", async () => {
    const remote: ExecutionEnvironmentProvider = {
      id: "remote-sandbox",
      capabilities: [],
      async provision() {
        throw new Error("must not provision");
      },
    };
    const worker = createClaudeCodeWorker({
      workspace: fallback,
      workspaceResolvers: resolvers(),
      executionEnvironment: remote,
      runner: writingRunner([]) as never,
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(attemptSpec("claude-code", plan(), ["files:write"])),
    );
    expect(events.at(-1)).toMatchObject({
      type: "execution.failed",
      error: {
        message: expect.stringContaining(
          "Workspace app: provider remote-sandbox has no registered Workspace environment",
        ),
      },
    });
    // Nothing was created in the checkout's repository.
    expect(git(checkout, "branch", "--list", "supertag/*")).toBe("");

    // Such a Worklet does not advertise the Workspace, so scheduling holds the Task instead.
    const remoteHost = new LocalWorklet("w", "host", [worker], { workspaces: ["app"] });
    expect((await remoteHost.describe()).host.workspaces).toBeUndefined();
    const local = createClaudeCodeWorker({ workspace: fallback, workspaceResolvers: resolvers() });
    expect((await local.describe()).profileCapabilities?.[0]?.capabilities).toContainEqual(
      WORKSPACE_IN_PLACE_CAPABILITY,
    );
    const localHost = new LocalWorklet("w", "host", [local], { workspaces: ["app", "app"] });
    expect((await localHost.describe()).host.workspaces).toEqual(["app"]);
  });
});

function attemptSpec(
  harness: string,
  workspacePlan: TaskNamedWorkspacePlan,
  runtimeActions: string[],
): TaskAttemptSpec {
  const capturedAt = "2026-09-29T00:00:00.000Z";
  return {
    version: 2,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "cli",
        accountId: "account-1",
        scope: "objective:objective-1",
        sessionKey: "objective-1",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text: "Implement the change" }],
    },
    execution: {},
    workerProfile: { id: `local-${harness}`, revision: "1" },
    contextPlan: { version: 7, capturedAt, sets: [] },
    workspacePlan,
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "tag-1", name: "Engineering" },
      origin: {
        tagRouteId: "surface-1",
        surfaceAccountId: "account-1",
        provider: "slack",
        scope: "channel:C1",
      },
      requester: { id: "U1", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions,
    },
  } as unknown as TaskAttemptSpec;
}
