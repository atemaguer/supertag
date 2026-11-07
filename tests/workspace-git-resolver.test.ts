import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TaskNamedWorkspacePlan, taskWorkspaceBranch } from "../packages/core/src/index.js";
import {
  type ResolutionContext,
  resolveSkillPackages,
  type TaskAttemptSpec,
  WorkspaceEnvironmentResolver,
} from "../packages/runtime/sdk/src/index.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

describe("Git worktree Workspace resolver", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let checkout: string;
  let root: string;
  let setupLog: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    checkout = await createRepository();
    root = await mkdtemp(join(tmpdir(), "supertag-worktrees-"));
    setupLog = join(await mkdtemp(join(tmpdir(), "supertag-setup-")), "runs.log");
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const plan = (overrides: Partial<TaskNamedWorkspacePlan> = {}): TaskNamedWorkspacePlan => ({
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: taskWorkspaceBranch("objective-1", "objective-1:task/1"),
    delivery: "branch",
    setup: `echo run >> ${setupLog}`,
    ...overrides,
  });
  const task = (
    workspacePlan: TaskNamedWorkspacePlan,
    attemptId = "attempt-1",
    runtimeActions: string[] = ["files:write"],
  ) =>
    ({
      taskId: "objective-1:task/1",
      attemptId,
      workspacePlan,
      authorization: { runtimeActions },
    }) as unknown as TaskAttemptSpec;
  const context = (spec: TaskAttemptSpec) =>
    ({ task: spec, profile: { harness: { provider: "codex" } } }) as unknown as ResolutionContext;
  const resolver = () =>
    new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
    });

  it.each(["local", "remote", "local-case", "remote-case"])(
    "allocates and remembers a new branch instead of adopting a foreign %s ref",
    async (kind) => {
      const workspacePlan = plan({ setup: undefined });
      const base = git(checkout, "rev-parse", "HEAD");
      await writeFile(join(checkout, "foreign.txt"), "foreign work\n");
      git(checkout, "add", "foreign.txt");
      git(checkout, "commit", "--quiet", "-m", "Foreign work");
      const foreign = git(checkout, "rev-parse", "HEAD");
      const name = kind.endsWith("case")
        ? workspacePlan.branch.toUpperCase()
        : workspacePlan.branch;
      const ref = `${kind.startsWith("remote") ? "refs/remotes/origin/" : "refs/heads/"}${name}`;
      git(checkout, "update-ref", ref, foreign);
      // Keep the foreign commit out of the configured Task base.
      const spec = task({ ...workspacePlan, ref: base });
      const input = await resolver().resolve(context(spec));
      const path = fileURLToPath(input?.source.uri ?? "");
      const allocated = git(path, "branch", "--show-current");
      expect(allocated).toMatch(new RegExp(`^${workspacePlan.branch}-[a-f0-9]{8}(?:-[a-z0-9]+)?$`));
      expect(git(path, "rev-parse", "HEAD")).toBe(base);
      await expect(stat(join(path, "foreign.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(input?.source.provenance?.["branch"]).toBe(allocated);
      await writeFile(join(path, "mine.txt"), "task work\n");
      const delivered = await resolver().finalize(spec, "completed");
      expect(delivered?.branch).toBe(allocated);
      expect(git(checkout, "rev-parse", ref)).toBe(foreign);
      const retry = await resolver().resolve(context({ ...spec, attemptId: "retry" }));
      expect(retry?.source.provenance?.["branch"]).toBe(allocated);
      expect(git(fileURLToPath(retry?.source.uri ?? ""), "rev-parse", "HEAD")).toBe(
        delivered?.head,
      );
    },
  );

  it("reserves colliding message Task names across workspace aliases before setup completes", async () => {
    const workspaces = new WorkspaceEnvironmentResolver({
      checkouts: [
        { name: "app", path: checkout },
        { name: "alias", path: checkout },
      ],
      worktreeRoot: root,
    });
    const specs = [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ].map((id, i) => ({
      ...task(
        plan({
          setup: undefined,
          workspace: i ? "alias" : "app",
          branch: taskWorkspaceBranch("objective-1", `message:${id}`),
        }),
      ),
      taskId: `message:${id}`,
      attemptId: `attempt-${i}`,
    }));
    const inputs = await Promise.all(specs.map((spec) => workspaces.resolve(context(spec))));
    const branches = inputs.map((input) => input?.source.provenance?.["branch"]);
    expect(new Set(branches).size).toBe(2);
    expect(branches).toContain("supertag/objective-1/message");
  });

  it("refuses a declared checkout on a remote provider before fetching or creating an MCP snapshot", async () => {
    const fetch = vi.fn(async () => undefined);
    const workspaces = new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
      sourceCredentials: { resolve: fetch },
      environments: { remote: {} as never },
    });
    const workspacePlan = plan({ source: "https://example.test/app.git", mcp: ["server"] });
    const remote = {
      ...context(task(workspacePlan)),
      profile: { harness: { provider: "codex" }, execution: { provider: "remote" } },
    } as unknown as ResolutionContext;
    await expect(workspaces.resolve(remote)).rejects.toThrow(
      /serves Workspaces from their source, not a checkout declared on this Worker Host/u,
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(stat(workspaces.mcpSnapshotPath("app", remote.task.taskId))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(stat(join(root, "app"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores devcontainer.json in the local provider, including host lifecycle commands", async () => {
    await mkdir(join(checkout, ".devcontainer"));
    const canary = join(root, "initialize-ran");
    await writeFile(
      join(checkout, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ features: { unsupported: {} }, initializeCommand: `touch ${canary}` }),
    );
    git(checkout, "add", ".devcontainer/devcontainer.json");
    git(checkout, "commit", "--quiet", "-m", "Add unsupported devcontainer");
    await expect(resolver().resolve(context(task(plan())))).resolves.toBeDefined();
    await expect(stat(canary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an MCP snapshot when resolution fails after creating it", async () => {
    const workspaces = resolver();
    const workspacePlan = plan({ mcp: ["missing"] });
    await expect(workspaces.resolve(context(task(workspacePlan)))).rejects.toThrow();
    await expect(
      stat(workspaces.mcpSnapshotPath("app", "objective-1:task/1")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a worktree on the deterministic branch, reuses it on retry, and runs setup once", async () => {
    const workspacePlan = plan();
    expect(workspacePlan.branch).toBe("supertag/objective-1/task-1");
    const first = await resolver().resolve(context(task(workspacePlan)));
    expect(first).toMatchObject({
      kind: "workspace",
      placement: "in-place",
      readOnly: false,
      source: { provenance: { workspace: "app", branch: workspacePlan.branch } },
    });
    const path = fileURLToPath(first?.source.uri ?? "");
    expect(path.startsWith(join(root, "app", "worktrees"))).toBe(true);
    expect(git(path, "symbolic-ref", "--short", "HEAD")).toBe(workspacePlan.branch);
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("# App\n");

    // A retry of the same Task, even from a new resolver, reuses the worktree and skips setup.
    await writeFile(join(path, "draft.txt"), "in progress\n");
    const second = await resolver().resolve(context(task(workspacePlan, "attempt-2")));
    expect(fileURLToPath(second?.source.uri ?? "")).toBe(path);
    expect(await readFile(join(path, "draft.txt"), "utf8")).toBe("in progress\n");
    expect(await readFile(setupLog, "utf8")).toBe("run\n");

    // The checkout's own working tree and branch are untouched.
    expect(git(checkout, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  it("never runs a package script from the Task branch when a retry recreates its worktree", async () => {
    const outside = await mkdtemp(join(tmpdir(), "supertag-escape-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const escaped = join(outside, "escaped");
    const script = (postinstall: string) =>
      `${JSON.stringify({ name: "app", version: "1.0.0", private: true, scripts: { postinstall } })}\n`;
    await writeFile(
      join(checkout, "package.json"),
      script(
        "node -e \"require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/.installed','base')\"",
      ),
    );
    await writeFile(join(checkout, ".gitignore"), "*.log\nnode_modules/\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "Add package");
    const base = git(checkout, "rev-parse", "HEAD");
    const workspacePlan = plan({
      setup: "npm install --offline --no-audit --no-fund --no-package-lock --ignore-scripts=false",
    });
    const first = await resolver().resolve(context(task(workspacePlan)));
    const path = fileURLToPath(first?.source.uri ?? "");
    expect(await readFile(join(path, "node_modules", ".installed"), "utf8")).toBe("base");

    // The sandboxed harness commits a postinstall script that writes outside its worktree.
    await writeFile(join(path, "package.json"), script(`touch ${escaped}`));
    const failed = await resolver().finalize(task(workspacePlan), "failed");
    expect(failed).toMatchObject({ committed: true, worktreeRemoved: false });
    const taskHead = failed?.head as string;

    // A retry on a host without the kept worktree recreates it from the Task branch.
    await rm(path, { recursive: true, force: true });
    const retried = await resolver().resolve(context(task(workspacePlan, "attempt-2")));
    expect(fileURLToPath(retried?.source.uri ?? "")).toBe(path);
    await expect(stat(escaped)).rejects.toThrow();
    // Setup ran on the base, and its ignored output survived the move to the Task branch.
    expect(await readFile(join(path, "node_modules", ".installed"), "utf8")).toBe("base");
    expect(git(path, "rev-parse", "HEAD")).toBe(taskHead);
    expect(git(path, "symbolic-ref", "--short", "HEAD")).toBe(workspacePlan.branch);
    expect(await readFile(join(path, "package.json"), "utf8")).toContain(escaped);
    expect(git(path, "status", "--porcelain")).toBe("");
    expect(retried?.source.provenance?.["base"]).toBe(base);
    expect(retried?.source.provenance).toMatchObject({
      preparedDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      preparedProvider: "local",
      trustedCommit: base,
    });
  }, 30_000); // Runs a real npm install.

  it("reruns setup when the trusted base changes, recording the base and the command", async () => {
    const workspacePlan = plan({ setup: `git rev-parse HEAD >> ${setupLog}` });
    const first = await resolver().resolve(context(task(workspacePlan)));
    const path = fileURLToPath(first?.source.uri ?? "");
    const base = git(checkout, "rev-parse", "main");
    const marker = join(
      git(path, "rev-parse", "--path-format=absolute", "--git-dir"),
      "supertag-setup",
    );
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      base,
      setup: workspacePlan.setup,
      outputs: "private",
    });
    await writeFile(join(path, "feature.ts"), "export {};\n");
    await resolver().finalize(task(workspacePlan), "failed");

    // Setup recorded on another base does not count: the clean worktree is rebuilt on this one.
    await writeFile(
      marker,
      `${JSON.stringify({ base: "0".repeat(40), setup: workspacePlan.setup, outputs: "private" })}\n`,
    );
    const second = await resolver().resolve(context(task(workspacePlan, "attempt-2")));
    expect(fileURLToPath(second?.source.uri ?? "")).toBe(path);
    expect(await readFile(setupLog, "utf8")).toBe(`${base}\n${base}\n`);
    expect(await readFile(join(path, "feature.ts"), "utf8")).toBe("export {};\n");

    // A Task that ends without commits starts again from the moved Workspace ref.
    const emptyPlan = { ...workspacePlan, branch: "supertag/objective-1/empty" };
    const emptyTask = { ...task(emptyPlan), taskId: "empty" } as TaskAttemptSpec;
    await resolver().resolve(context(emptyTask));
    await resolver().finalize(emptyTask, "failed");
    await writeFile(join(checkout, "next.txt"), "next\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "Advance main");
    const moved = git(checkout, "rev-parse", "main");
    await resolver().resolve(context({ ...emptyTask, attemptId: "attempt-2" } as TaskAttemptSpec));
    expect((await readFile(setupLog, "utf8")).trim().split("\n")).toEqual([
      base,
      base,
      base,
      moved,
    ]);
  });

  it("runs no hook from the Task worktree, even through a relative hooks path", async () => {
    const outside = await mkdtemp(join(tmpdir(), "supertag-hooks-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    // husky-style configuration resolves hooks inside each worktree, which the harness writes.
    git(checkout, "config", "core.hooksPath", ".husky");
    const workspacePlan = plan();
    const input = await resolver().resolve(context(task(workspacePlan)));
    const path = fileURLToPath(input?.source.uri ?? "");
    await mkdir(join(path, ".husky"), { recursive: true });
    for (const hook of ["post-commit", "post-checkout", "reference-transaction"])
      await writeFile(join(path, ".husky", hook), `#!/bin/sh\ntouch ${join(outside, hook)}\n`, {
        mode: 0o755,
      });
    await resolver().finalize(task(workspacePlan), "failed");
    await rm(path, { recursive: true, force: true });
    await resolver().resolve(context(task(workspacePlan, "attempt-2")));
    await writeFile(join(path, "more.txt"), "more\n");
    await resolver().finalize(task(workspacePlan, "attempt-2"), "completed");
    for (const hook of ["post-commit", "post-checkout", "reference-transaction"])
      await expect(stat(join(outside, hook))).rejects.toThrow();
  });

  it("ignores a worktree .git file the harness redirected to its own configuration", async () => {
    const outside = await mkdtemp(join(tmpdir(), "supertag-gitfile-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const escaped = join(outside, "escaped");
    // Per-worktree configuration is honored, as `git sparse-checkout` enables it.
    git(checkout, "config", "core.repositoryFormatVersion", "1");
    git(checkout, "config", "extensions.worktreeConfig", "true");
    const workspacePlan = plan({ setup: undefined });
    const input = await resolver().resolve(context(task(workspacePlan)));
    const path = fileURLToPath(input?.source.uri ?? "");
    const common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const fake = join(path, ".fake-git");
    await mkdir(fake);
    await writeFile(join(fake, "commondir"), `${common}\n`);
    await writeFile(join(fake, "HEAD"), `ref: refs/heads/${workspacePlan.branch}\n`);
    await writeFile(
      join(fake, "config.worktree"),
      `[filter "evil"]\n\tclean = "sh -c 'touch ${escaped}; cat'"\n[core]\n\tfsmonitor = "touch ${escaped}"\n`,
    );
    await writeFile(join(path, ".gitattributes"), "* filter=evil\n");
    await writeFile(join(path, "feature.ts"), "export {};\n");
    await writeFile(join(path, ".git"), `gitdir: ${fake}\n`);
    const delivered = await resolver().finalize(task(workspacePlan), "failed");
    expect(delivered?.committed).toBe(true);
    await expect(stat(escaped)).rejects.toThrow();
  });

  /** A submitted change on a source Task branch, and a review Task pinned to its commit. */
  const submittedReview = async (workspacePlan: TaskNamedWorkspacePlan, escaped: string) => {
    await writeFile(
      join(checkout, ".mcp.json"),
      JSON.stringify({
        mcpServers: { selected: { type: "http", url: "https://trusted.example/mcp" } },
      }),
    );
    await writeFile(
      join(checkout, "setup.sh"),
      "mkdir -p node_modules && pwd > node_modules/cwd\n",
    );
    await writeFile(join(checkout, ".gitignore"), "*.log\nnode_modules/\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "Configure Workspace MCP server and setup");
    const sourceBranch = taskWorkspaceBranch("objective-1", "objective-1:source");
    git(checkout, "checkout", "--quiet", "-b", sourceBranch);
    await writeFile(join(checkout, "change.txt"), "submitted\n");
    // The change under review rewrites the script the setup command runs.
    await writeFile(join(checkout, "setup.sh"), `touch ${escaped}\n`);
    await writeFile(
      join(checkout, ".mcp.json"),
      JSON.stringify({
        mcpServers: { selected: { type: "http", url: "https://submitted.example/mcp" } },
      }),
    );
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "Submitted change");
    const head = git(checkout, "rev-parse", "HEAD");
    git(checkout, "checkout", "--quiet", "main");
    const spec = {
      ...task(workspacePlan),
      input: {
        messages: [],
        attachments: [
          {
            uri: "supertag-artifact:source/report.md",
            artifactId: "source-artifact",
            provenance: {
              taskId: "objective-1:source",
              workspaceGitReference: `git:${sourceBranch}@${head}`,
            },
          },
        ],
      },
    } as TaskAttemptSpec;
    return { head, spec };
  };

  it("runs a review Task's setup on the base, then checks out the submitted commit", async () => {
    const outside = await mkdtemp(join(tmpdir(), "supertag-review-escape-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const escaped = join(outside, "escaped");
    const workspacePlan = plan({ setup: "test ! -f change.txt && sh setup.sh", mcp: ["selected"] });
    const { head, spec } = await submittedReview(workspacePlan, escaped);
    const workspaces = resolver();
    const input = await workspaces.resolve(context(spec));
    const path = fileURLToPath(input?.source.uri ?? "");
    // The base's setup script ran in the worktree; the submitted one never ran.
    expect((await readFile(join(path, "node_modules", "cwd"), "utf8")).trim()).toBe(
      await realpath(path),
    );
    await expect(stat(escaped)).rejects.toThrow();
    expect(await readFile(join(path, "change.txt"), "utf8")).toBe("submitted\n");
    expect(await readFile(join(path, "setup.sh"), "utf8")).toBe(`touch ${escaped}\n`);
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(input?.source.provenance?.["base"]).toBe(head);
    expect(workspaces.mcpServersForAttempt("attempt-1")).toEqual([
      { name: "selected", url: "https://trusted.example/mcp", headers: {} },
    ]);

    // A review Attempt's own commits are measured from the submitted commit.
    await writeFile(join(path, "review.md"), "Looks good\n");
    const delivered = await workspaces.finalize(spec, "failed");
    expect(delivered).toMatchObject({ base: head, changedFiles: 1 });
    await rm(path, { recursive: true, force: true });
    await workspaces.resolve(context({ ...spec, attemptId: "attempt-2" } as TaskAttemptSpec));
    expect(git(path, "rev-parse", "HEAD^")).toBe(head);
    await expect(stat(escaped)).rejects.toThrow();
  });

  it("refuses a review branch that does not contain the submitted commit", async () => {
    const outside = await mkdtemp(join(tmpdir(), "supertag-review-branch-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const workspacePlan = plan({ setup: "sh setup.sh" });
    const { head, spec } = await submittedReview(workspacePlan, join(outside, "escaped"));

    // An unrecorded branch is left untouched; the review gets its own suffixed branch.
    git(checkout, "branch", workspacePlan.branch, "main");
    const foreign = git(checkout, "rev-parse", workspacePlan.branch);
    const input = await resolver().resolve(context(spec));
    const path = fileURLToPath(input?.source.uri ?? "");
    expect(git(path, "branch", "--show-current")).not.toBe(workspacePlan.branch);
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(git(checkout, "rev-parse", workspacePlan.branch)).toBe(foreign);

    // A kept review worktree whose recorded branch moved cannot be silently readopted.
    git(path, "reset", "--quiet", "--hard", "main");
    await expect(
      resolver().resolve(context({ ...spec, attemptId: "attempt-2" } as TaskAttemptSpec)),
    ).rejects.toThrow("is not on branch");
  });

  it("does not pass Worker Host credentials to setup", async () => {
    vi.stubEnv("SUPERTAG_WORKER_SECRET", "host-secret");
    const workspacePlan = plan({
      setup: 'test -z "$SUPERTAG_WORKER_SECRET" && printf clean > setup-env',
    });
    const input = await resolver().resolve(context(task(workspacePlan)));
    const path = fileURLToPath(input?.source.uri ?? "");
    expect(await readFile(join(path, "setup-env"), "utf8")).toBe("clean");
  });

  it("runs setup with a fresh private TMPDIR, TMP, and TEMP that it removes afterwards", async () => {
    const workspacePlan = plan({
      setup:
        'printf "%s\\n%s\\n%s\\n" "$TMPDIR" "$TMP" "$TEMP" > setup-tmp && touch "$TMPDIR/cache"',
    });
    const input = await resolver().resolve(context(task(workspacePlan)));
    const path = fileURLToPath(input?.source.uri ?? "");
    const [temporary, tmp, temp] = (await readFile(join(path, "setup-tmp"), "utf8"))
      .trim()
      .split("\n");
    expect(tmp).toBe(temporary);
    expect(temp).toBe(temporary);
    // Under the Workspace's Worker-owned state, never the host temporary directory a sandbox writes.
    expect(temporary?.startsWith(join(root, "app", "tmp", "setup-"))).toBe(true);
    await expect(stat(temporary as string)).rejects.toThrow();
  });

  it("reads only selected MCP servers from the host checkout before starting the Task", async () => {
    vi.stubEnv("SUPERTAG_MCP_TEST_TOKEN", "token");
    await writeFile(
      join(checkout, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          selected: {
            type: "http",
            url: "https://example.test/mcp",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
            headers: { Authorization: "${SUPERTAG_MCP_TEST_TOKEN}" },
          },
          extra: { command: "node", args: ["untrusted.js"] },
        },
      }),
    );
    git(checkout, "add", ".mcp.json");
    git(checkout, "commit", "--quiet", "-m", "Declare selected MCP server");
    const workspaces = resolver();
    const input = await workspaces.resolve(context(task(plan({ mcp: ["selected"] }))));
    expect(input?.source.provenance?.["mcpServersDigest"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(workspaces.mcpServersForAttempt("attempt-1")).toEqual([
      { name: "selected", url: "https://example.test/mcp", headers: { Authorization: "token" } },
    ]);
    expect(JSON.stringify(input)).not.toContain("token");
    expect(JSON.stringify(input)).not.toContain("extra");
    await workspaces.finalize(task(plan({ mcp: ["selected"] })), "failed");
    expect(workspaces.mcpServersForAttempt("attempt-1")).toEqual([]);
  });

  it("delivers selected gitignored Skills from the checkout and pins them across retries", async () => {
    const source = join(checkout, ".claude", "skills", "review");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "first version");
    const workspacePlan = plan({ skills: ["review"] });
    const first = resolver();
    const worktree = await first.resolve(context(task(workspacePlan)));
    await expect(
      stat(join(fileURLToPath(worktree?.source.uri ?? ""), ".claude", "skills", "review")),
    ).rejects.toThrow();
    const skills = first.skillInputsForAttempt("attempt-1");
    expect(skills[0]?.source.provenance).toEqual({
      provider: "supertag-workspace",
      source: ".claude/skills/review",
    });
    expect(await resolveSkillPackages(skills)).toHaveLength(1);
    await writeFile(join(source, "SKILL.md"), "second version");
    const retry = resolver();
    await retry.resolve(context(task(workspacePlan, "attempt-2")));
    expect(retry.skillInputsForAttempt("attempt-2")).toEqual(skills);
    await first.finalize(task(workspacePlan), "failed");
    expect(first.skillInputsForAttempt("attempt-1")).toEqual([]);
  });

  it("pins gitignored Skills from a source-backed host checkout", async () => {
    await writeFile(join(checkout, ".gitignore"), "*.log\n.claude/skills/\n");
    git(checkout, "add", ".gitignore");
    git(checkout, "commit", "--quiet", "-m", "Ignore local Skills");
    const source = join(checkout, ".claude", "skills", "review");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "first version");
    expect(git(checkout, "check-ignore", ".claude/skills/review/SKILL.md")).toBe(
      ".claude/skills/review/SKILL.md",
    );

    const workspacePlan = plan({ source: pathToFileURL(checkout).href, skills: ["review"] });
    const first = new WorkspaceEnvironmentResolver({
      checkouts: [],
      cloneSources: true,
      worktreeRoot: root,
    });
    const input = await first.resolve(context(task(workspacePlan)));
    await expect(
      stat(join(fileURLToPath(input?.source.uri ?? ""), ".claude", "skills", "review")),
    ).rejects.toThrow();
    const skills = first.skillInputsForAttempt("attempt-1");
    expect(skills[0]?.source.provenance).toEqual({
      provider: "supertag-workspace",
      source: ".claude/skills/review",
    });
    expect(skills[0]?.source.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(await resolveSkillPackages(skills)).toHaveLength(1);

    await writeFile(join(source, "SKILL.md"), "second version");
    const retry = new WorkspaceEnvironmentResolver({
      checkouts: [],
      cloneSources: true,
      worktreeRoot: root,
    });
    await retry.resolve(context(task(workspacePlan, "attempt-2")));
    expect(retry.skillInputsForAttempt("attempt-2")).toEqual(skills);
  });

  it("loads selected GitHub catalog Skills from a local git fixture and keeps the pinned commit on retry", async () => {
    const catalogRepo = await createRepository();
    cleanups.push(() => rm(catalogRepo, { recursive: true, force: true }));
    const skillPath = join(catalogRepo, "catalog", "review");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "first version");
    git(catalogRepo, "add", "catalog/review/SKILL.md");
    git(catalogRepo, "commit", "--quiet", "-m", "Add Skill");
    const commit = git(catalogRepo, "rev-parse", "HEAD");
    const workspacePlan = plan({
      setup: undefined,
      skillCatalog: {
        repository: "acme/skills",
        path: "catalog",
        revision: "main",
        skills: ["review"],
      },
    });
    const first = new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
      catalogSourceUrl: catalogRepo,
    });
    await first.resolve(context(task(workspacePlan)));
    const skills = first.skillInputsForAttempt("attempt-1");
    expect(skills).toHaveLength(1);
    expect(skills[0]?.source.provenance?.["source"]).toBe(
      `github:acme/skills/catalog/review@${commit}`,
    );
    expect(await resolveSkillPackages(skills)).toHaveLength(1);
    expect(
      await readFile(join(fileURLToPath(skills[0]?.source.uri ?? ""), "SKILL.md"), "utf8"),
    ).toBe("first version");
    await writeFile(join(skillPath, "SKILL.md"), "second version");
    git(catalogRepo, "add", "catalog/review/SKILL.md");
    git(catalogRepo, "commit", "--quiet", "-m", "Change Skill");
    const retry = new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
      catalogSourceUrl: catalogRepo,
    });
    await retry.resolve(
      context(
        task(
          {
            ...workspacePlan,
            skillPins: [
              {
                name: "review",
                source: `github:acme/skills/catalog/review@${commit}`,
                digest: skills[0]?.source.digest ?? "",
              },
            ],
          },
          "attempt-2",
        ),
      ),
    );
    expect(retry.skillInputsForAttempt("attempt-2")).toEqual(skills);
    await expect(first.finalize(task(workspacePlan), "failed")).resolves.toBeDefined();
  });

  it("reads source-backed Skills from a managed primary checkout", async () => {
    const source = join(checkout, ".agents", "skills", "review");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "tracked version");
    git(checkout, "add", ".agents/skills/review/SKILL.md");
    git(checkout, "commit", "--quiet", "-m", "Add Skill");
    const workspaces = new WorkspaceEnvironmentResolver({
      checkouts: [],
      cloneSources: true,
      worktreeRoot: root,
    });
    await workspaces.resolve(context(task(plan({ source: checkout, skills: ["review"] }))));
    expect(
      await readFile(
        join(root, "app", "checkout", ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("tracked version");
    expect(workspaces.skillInputsForAttempt("attempt-1")[0]?.source.provenance?.["source"]).toBe(
      ".agents/skills/review",
    );
  });

  it("reads MCP servers from a fetched source-backed Task worktree", async () => {
    await writeFile(
      join(checkout, ".mcp.json"),
      JSON.stringify({
        mcpServers: { selected: { type: "http", url: "https://example.test/mcp" } },
      }),
    );
    git(checkout, "add", ".mcp.json");
    git(checkout, "commit", "--quiet", "-m", "Declare MCP server");
    const workspaces = new WorkspaceEnvironmentResolver({
      checkouts: [],
      cloneSources: true,
      worktreeRoot: root,
    });
    const input = await workspaces.resolve(
      context(task(plan({ source: checkout, mcp: ["selected"] }))),
    );
    expect(input?.source.provenance?.["mcpServersDigest"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(workspaces.mcpServersForAttempt("attempt-1")).toEqual([
      { name: "selected", url: "https://example.test/mcp", headers: {} },
    ]);
    await expect(stat(join(workspaces.clonePath("app"), ".mcp.json"))).rejects.toThrow();
  });

  it("commits Attempt changes without ignored files and delivers the branch", async () => {
    const workspacePlan = plan();
    const input = await resolver().resolve(context(task(workspacePlan)));
    const path = fileURLToPath(input?.source.uri ?? "");
    await writeFile(join(path, "feature.ts"), "export const feature = true;\n");
    await writeFile(join(path, "debug.log"), "ignored\n");

    // A failed Attempt commits its work and keeps the worktree for a retry.
    const failed = await resolver().finalize(task(workspacePlan), "failed");
    expect(failed).toMatchObject({ committed: true, changedFiles: 1, worktreeRemoved: false });
    expect(git(path, "log", "-1", "--format=%an <%ae>|%s")).toBe(
      "SuperTag <supertag@localhost>|Update task objective-1:task/1",
    );
    expect(git(path, "log", "-1", "--format=%b")).toContain("Attempt: attempt-1");
    expect(git(path, "log", "-1", "--format=%b")).toContain("SuperTag-Task: objective-1:task/1");
    expect(git(path, "show", "--name-only", "--format=", "HEAD")).toBe("feature.ts");
    expect(await stat(join(path, "debug.log")).then(() => true)).toBe(true);

    await resolver().resolve(context(task(workspacePlan, "attempt-2")));
    await writeFile(join(path, "feature.test.ts"), "test\n");
    const completed = await resolver().finalize(task(workspacePlan, "attempt-2"), "completed");
    const base = git(checkout, "rev-parse", "main");
    expect(completed).toMatchObject({
      workspace: "app",
      branch: workspacePlan.branch,
      delivery: "branch",
      base,
      committed: true,
      changedFiles: 2,
      worktreeRemoved: true,
      branchRemoved: false,
    });
    expect(completed?.patch).toBeUndefined();
    // The worktree is gone; the branch stays in the checkout's repository.
    await expect(stat(path)).rejects.toThrow();
    expect(git(checkout, "rev-parse", workspacePlan.branch)).toBe(completed?.head);
    expect(git(checkout, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(checkout, "rev-parse", "main")).toBe(base);

    // A continuation recreates the worktree from the kept branch; setup reruns once for it.
    const continued = await resolver().resolve(context(task(workspacePlan, "attempt-3")));
    const recreated = fileURLToPath(continued?.source.uri ?? "");
    expect(git(recreated, "rev-parse", "HEAD")).toBe(completed?.head);
    expect(continued?.source.provenance?.["base"]).toBe(base);
    expect(await readFile(setupLog, "utf8")).toBe("run\nrun\n");
  });

  it("leaves untracked generated paths out of the commit, but commits tracked files under them", async () => {
    await mkdir(join(checkout, "node_modules"));
    await writeFile(join(checkout, "node_modules", "vendor.js"), "v1\n");
    await writeFile(join(checkout, "obsolete.txt"), "old\n");
    await writeFile(join(checkout, ".gitignore"), "*.pyc\n!keep.pyc\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "Vendor");
    const workspacePlan = plan({ setup: undefined });
    const input = await resolver().resolve(context(task(workspacePlan)));
    const path = fileURLToPath(input?.source.uri ?? "");
    for (const directory of ["__pycache__", "src/__pycache__", "node_modules/a", "pkg.egg-info"])
      await mkdir(join(path, directory), { recursive: true });
    for (const file of [
      "__pycache__/x.pyc",
      "src/__pycache__/y.cpython-313.pyc",
      "node_modules/a/index.js",
      ".DS_Store",
      "src/.DS_Store",
      "pkg.egg-info/PKG-INFO",
      ".coverage",
      "keep.pyc",
    ])
      await writeFile(join(path, file), "generated\n");
    await writeFile(join(path, "src", "real.py"), "print('real')\n");
    await writeFile(join(path, "node_modules", "vendor.js"), "v2\n");
    await rm(join(path, "obsolete.txt"));

    const delivered = await resolver().finalize(task(workspacePlan), "failed");
    expect(delivered?.committed).toBe(true);
    // The built-in exclusion wins over the repository's `!keep.pyc` negation for untracked files.
    expect(git(path, "show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual([
      "A\tsrc/real.py",
      "D\tobsolete.txt",
      "M\tnode_modules/vendor.js",
    ]);
    expect(await stat(join(path, "__pycache__", "x.pyc")).then(() => true)).toBe(true);
  });

  it("keeps the submitted summary out of the subject, in the body, with the Task trailer", async () => {
    const workspacePlan = plan();
    const spec = task(workspacePlan);
    const input = await resolver().resolve(context(spec));
    const path = fileURLToPath(input?.source.uri ?? "");
    await writeFile(join(path, "feature.ts"), "export const feature = true;\n");

    await resolver().finalize(spec, "completed", {
      summary: "  Add feature support\nAdditional detail",
    });
    expect(git(checkout, "log", "-1", "--format=%s", workspacePlan.branch)).toBe(
      "Update task objective-1:task/1",
    );
    expect(git(checkout, "log", "-1", "--format=%b", workspacePlan.branch)).toContain(
      "Add feature support",
    );
    expect(git(checkout, "log", "-1", "--format=%b", workspacePlan.branch)).toContain(
      "SuperTag-Task: objective-1:task/1",
    );
  });

  it("falls back to the Task instruction as the subject when no summary was submitted", async () => {
    const workspacePlan = plan();
    const spec = {
      ...task(workspacePlan),
      input: {
        origin: { kind: "delegation" },
        messages: [{ id: "m1", role: "requester", text: "\n  Fix the widget\nMore detail" }],
      },
    } as unknown as TaskAttemptSpec;
    const input = await resolver().resolve(context(spec));
    const path = fileURLToPath(input?.source.uri ?? "");
    await writeFile(join(path, "widget.ts"), "export const widget = true;\n");

    await resolver().finalize(spec, "failed");
    expect(git(checkout, "log", "-1", "--format=%s", workspacePlan.branch)).toBe("Fix the widget");
    expect(git(checkout, "log", "-1", "--format=%b", workspacePlan.branch)).toContain(
      "SuperTag-Task: objective-1:task/1",
    );
  });

  it("produces a git format-patch against the base for patch delivery", async () => {
    const workspacePlan = plan({ delivery: "patch" });
    const input = await resolver().resolve(context(task(workspacePlan)));
    const path = fileURLToPath(input?.source.uri ?? "");
    await writeFile(join(path, "README.md"), "# App\n\nPatched.\n");
    const delivered = await resolver().finalize(task(workspacePlan), "completed");
    expect(delivered?.changedFiles).toBe(1);
    const patch = new TextDecoder().decode(delivered?.patch);
    expect(patch).toContain("Subject: [PATCH] Update task objective-1:task/1");
    expect(patch).toContain("+Patched.");
    expect(patch).toContain("diff --git a/README.md b/README.md");
  });

  it("reports no commit and no patch when an Attempt changes nothing", async () => {
    const workspacePlan = plan({ delivery: "patch", setup: undefined });
    await resolver().resolve(context(task(workspacePlan)));
    const delivered = await resolver().finalize(task(workspacePlan), "completed");
    expect(delivered).toMatchObject({
      committed: false,
      changedFiles: 0,
      worktreeRemoved: true,
      branchRemoved: true,
    });
    expect(delivered?.head).toBe(delivered?.base);
    expect(delivered?.patch).toBeUndefined();
  });

  it("leaves no Task branch behind after a completed Attempt that made no commits", async () => {
    const workspacePlan = plan({ setup: undefined });
    const input = await resolver().resolve(context(task(workspacePlan)));
    const path = fileURLToPath(input?.source.uri ?? "");
    // An ignored file is not a commit.
    await writeFile(join(path, "debug.log"), "ignored\n");
    const delivered = await resolver().finalize(task(workspacePlan), "completed");
    expect(delivered).toMatchObject({
      committed: false,
      changedFiles: 0,
      worktreeRemoved: true,
      branchRemoved: true,
    });
    await expect(stat(path)).rejects.toThrow();
    expect(git(checkout, "branch", "--list", workspacePlan.branch)).toBe("");
    expect(git(checkout, "symbolic-ref", "--short", "HEAD")).toBe("main");

    // A later Task Attempt starts the branch afresh from the base.
    const again = await resolver().resolve(context(task(workspacePlan, "attempt-2")));
    const recreated = fileURLToPath(again?.source.uri ?? "");
    expect(git(recreated, "rev-parse", "HEAD")).toBe(git(checkout, "rev-parse", "main"));
  });

  for (const outcome of ["failed", "cancelled"] as const)
    it(`leaves no Task branch behind after a ${outcome} Attempt that made no commits`, async () => {
      const workspacePlan = plan({ setup: undefined });
      const input = await resolver().resolve(context(task(workspacePlan)));
      const path = fileURLToPath(input?.source.uri ?? "");
      const delivered = await resolver().finalize(task(workspacePlan), outcome);
      expect(delivered).toMatchObject({
        committed: false,
        changedFiles: 0,
        worktreeRemoved: true,
        branchRemoved: true,
      });
      await expect(stat(path)).rejects.toThrow();
      expect(git(checkout, "branch", "--list", workspacePlan.branch)).toBe("");

      // The retry starts afresh from the base.
      const again = await resolver().resolve(context(task(workspacePlan, "attempt-2")));
      const recreated = fileURLToPath(again?.source.uri ?? "");
      expect(git(recreated, "rev-parse", "HEAD")).toBe(git(checkout, "rev-parse", "main"));
    });

  it.each(["supertag/objective-1/task-1", "supertag/objective-1/objective-1-task-1-a1b2c3d4"])(
    "keeps the recorded Task branch %s and commits an earlier Attempt made",
    async (branch) => {
      const workspacePlan = plan({ setup: undefined, branch });
      const input = await resolver().resolve(context(task(workspacePlan)));
      const path = fileURLToPath(input?.source.uri ?? "");
      await writeFile(join(path, "feature.ts"), "export const feature = true;\n");
      await resolver().finalize(task(workspacePlan), "failed");
      await resolver().resolve(context(task(workspacePlan, "attempt-2")));
      const completed = await resolver().finalize(task(workspacePlan, "attempt-2"), "completed");
      expect(completed).toMatchObject({ committed: false, changedFiles: 1, branchRemoved: false });
      expect(git(checkout, "rev-parse", workspacePlan.branch)).toBe(completed?.head);
    },
  );

  it("bases new branches on the Workspace ref and marks read-only Tasks", async () => {
    git(checkout, "branch", "release");
    git(checkout, "checkout", "--quiet", "-b", "feature");
    await writeFile(join(checkout, "feature.txt"), "feature\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "Feature");
    const input = await resolver().resolve(
      context(task(plan({ ref: "release", setup: undefined }), "attempt-1", [])),
    );
    expect(input?.readOnly).toBe(true);
    const path = fileURLToPath(input?.source.uri ?? "");
    expect(git(path, "rev-parse", "HEAD")).toBe(git(checkout, "rev-parse", "release"));
    // Without a ref, the checkout's current branch is the base.
    const other = new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
    });
    const current = await other.resolve(
      context({
        ...task(plan({ setup: undefined, branch: "supertag/objective-1/other" })),
        taskId: "other",
      } as TaskAttemptSpec),
    );
    expect(git(fileURLToPath(current?.source.uri ?? ""), "rev-parse", "HEAD")).toBe(
      git(checkout, "rev-parse", "feature"),
    );
  });

  it("refuses a checkout that is not a git repository, and an undeclared Workspace", async () => {
    const plain = await mkdtemp(join(tmpdir(), "supertag-plain-"));
    cleanups.push(() => rm(plain, { recursive: true, force: true }));
    const refusing = new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: plain }],
      worktreeRoot: root,
    });
    await expect(refusing.resolve(context(task(plan())))).rejects.toThrow(
      "is not a git repository",
    );
    await expect(resolver().resolve(context(task(plan({ workspace: "docs" }))))).rejects.toThrow(
      "Workspace docs has no checkout declared on this Worker Host",
    );
  });

  it("places remote Workspace environments but refuses a declared checkout before provider or host work", async () => {
    await writeFile(
      join(checkout, ".mcp.json"),
      JSON.stringify({
        mcpServers: { selected: { type: "http", url: "https://example.test/mcp" } },
      }),
    );
    git(checkout, "add", ".mcp.json");
    git(checkout, "commit", "--quiet", "-m", "Declare selected MCP server");
    const prepare = vi.fn();
    const start = vi.fn();
    const remote = {
      provider: "e2b",
      capabilities: {
        sharedPrepare: true,
        setupOnHost: false,
        declaredCheckouts: false,
        devcontainer: false,
        mcpStdio: "sandbox" as const,
      },
      refuse: vi.fn(() => "e2b refuses"),
      prepare,
      start,
      finalize: vi.fn(),
      evict: vi.fn(),
    };
    const workspaces = new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
      environments: { "e2b-execution": remote as never },
    });
    const profile = {
      runtime: undefined,
      harness: { provider: "codex" },
      execution: { provider: "e2b-execution" },
    } as ResolutionContext["profile"];
    // Placement accepts a registered remote environment; it serves Workspaces from their source.
    expect(workspaces.refuseProfile(profile, { id: "e2b-execution" })).toBeUndefined();
    expect(workspaces.refuseProfile(profile, { id: "modal-execution" })).toContain(
      "no registered Workspace environment",
    );
    const workspacePlan = plan({ mcp: ["selected"] });
    await expect(workspaces.resolve({ task: task(workspacePlan), profile })).rejects.toThrow(
      "not a checkout declared on this Worker Host",
    );
    expect(remote.refuse).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(workspaces.mcpServersForAttempt("attempt-1")).toEqual([]);
    await expect(
      stat(workspaces.mcpSnapshotPath("app", task(workspacePlan).taskId)),
    ).rejects.toThrow();
    await expect(
      stat(workspaces.worktreePath("app", task(workspacePlan).taskId)),
    ).rejects.toThrow();
  });

  it("fails clearly when setup fails and leaves Tasks without a Workspace alone", async () => {
    await expect(
      resolver().resolve(context(task(plan({ setup: "echo broken >&2; exit 3" })))),
    ).rejects.toThrow(/Workspace setup failed \(exit 3\): broken/u);
    expect(
      await resolver().resolve(
        context({
          taskId: "t",
          attemptId: "a",
          workspacePlan: { version: 1, status: "none" },
        } as unknown as TaskAttemptSpec),
      ),
    ).toBeUndefined();
  });
});
