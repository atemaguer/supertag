import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertConformance,
  runWorkspaceEnvironmentConformance,
} from "../packages/runtime/sdk/src/conformance.js";
import {
  type ExecutionEnvironment,
  LocalWorkspaceEnvironment,
  PREPARED_WORKSPACE_LIMITS,
  type PreparedWorkspace,
  PreparedWorkspaceCache,
  preparedWorkspaceDigest,
  preparedWorkspaceWarmKey,
  type WorkspaceDefinition,
  type WorkspaceEnvironment,
  WorkspaceHost,
  workspaceDefinition,
  workspaceHarnessRequirement,
} from "../packages/runtime/sdk/src/index.js";
import { resolveLocalMountRoot } from "../packages/runtime/sdk/src/local-mount-root.js";
import { acquireLockFile } from "../packages/runtime/sdk/src/workspace-environment.js";

// The local copy-mount property copies into the system temporary directory, which a real Worker
// Host refuses for local copies; tests/volume-copy-races.test.ts checks that refusal.
vi.mock("../packages/runtime/sdk/src/task-writable-roots.js", () => ({
  taskWritableRoots: () => [],
}));

describe("Workspace environment conformance", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  const local = (fault?: "task" | "leak" | "branch-head") =>
    runWorkspaceEnvironmentConformance(async (repository) => {
      const root = await mkdtemp(join(tmpdir(), "supertag-local-workspaces-"));
      roots.push(root);
      const host = new WorkspaceHost({
        root,
        checkouts: new Map([[repository.workspace, repository.path]]),
        cloneSources: false,
      });
      // Copy mounts land at their literal path on the host, outside the Workspace state.
      const mounts = await mkdtemp(join(tmpdir(), "supertag-local-mounts-"));
      roots.push(mounts);
      const environment = new LocalWorkspaceEnvironment({
        host,
        localMountRoot: await resolveLocalMountRoot(mounts),
      });
      const mountPath = join(mounts, "data");
      return {
        copyMount: {
          path: mountPath,
          read: (_task, relative) =>
            readFile(join(mountPath, relative), "utf8").catch(() => undefined),
          writable: async (_task, relative) =>
            ((await stat(join(mountPath, relative))).mode & 0o222) !== 0,
          exists: (_task, relative) =>
            lstat(join(mountPath, relative)).then(
              () => true,
              () => false,
            ),
        },
        environment:
          fault === "branch-head"
            ? branchHeadStart(environment, host, repository.path)
            : environment,
        async define({ taskId, trustedCommit, setup, secret }) {
          // The Worker's own path, with a resolved MCP server whose header holds the secret.
          const definition = workspaceDefinition({
            workspace: repository.workspace,
            source: repository.source,
            trustedCommit: fault === "task" ? repository.task : trustedCommit,
            ...(setup === undefined ? {} : { setup }),
            mcp: {
              servers: [
                {
                  name: "docs",
                  url: "https://mcp.example.com",
                  headers: { authorization: `Bearer ${secret}` },
                },
              ],
              definitions: [{ name: "docs", transport: "http" }],
              digest: `sha256:${"d".repeat(64)}`,
            },
            harness: workspaceHarnessRequirement({ harness: { provider: "codex" } }),
            taskId,
          });
          return fault === "leak"
            ? ({
                ...definition,
                mcp: [{ headers: { authorization: secret } }],
              } as WorkspaceDefinition)
            : definition;
        },
      };
    });

  it("passes against the local Workspace environment", async () => {
    const report = await local();
    assertConformance(report);
    expect(report.passed).toBe(true);
  }, 60_000);

  it("reports a provider that prepares from the Task branch", async () => {
    const report = await local("task");
    expect(report.passed).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain(
      "workspace.prepare.trusted-only",
    );
  }, 60_000);

  it("reports a definition that carries a host credential to the provider", async () => {
    const report = await local("leak");
    expect(report.findings.map((finding) => finding.code)).toContain("workspace.secret");
  }, 60_000);

  it("reports a provider that starts at an existing branch's head instead of the Task's", async () => {
    const report = await local("branch-head");
    expect(report.findings.map((finding) => finding.code)).toContain("workspace.start.exact-head");
  }, 60_000);
});

/**
 * Local, but `start` checks out an existing Task branch's own head rather than the Task
 * Attempt's: the fault the exact-head case catches.
 */
function branchHeadStart(
  environment: LocalWorkspaceEnvironment,
  host: WorkspaceHost,
  repository: string,
): WorkspaceEnvironment {
  return {
    provider: environment.provider,
    capabilities: environment.capabilities,
    refuse: (definition) => environment.refuse(definition),
    prepare: (definition) => environment.prepare(definition),
    start: async (prepared, task) => {
      const branch = `refs/heads/${task.branch}`;
      const head = (await host.hasRef(repository, branch))
        ? await host.commit(repository, branch, "unreadable")
        : task.head;
      return environment.start(prepared, { ...task, head });
    },
    finalize: (started, commit) => environment.finalize(started, commit),
    evict: (prepared) => environment.evict(prepared),
  };
}

/** A shared-prepare provider that records calls, for the cache. */
function sharedFake(
  provider = "fake",
): WorkspaceEnvironment & { prepares: number; evicted: string[] } {
  const fake = {
    provider,
    base: "fake-base",
    capabilities: {
      sharedPrepare: true,
      setupOnHost: false,
      declaredCheckouts: false,
      devcontainer: true,
      mcpStdio: "sandbox",
    } as const,
    prepares: 0,
    evicted: [] as string[],
    refuse: () => undefined,
    async prepare(definition: WorkspaceDefinition): Promise<PreparedWorkspace> {
      fake.prepares += 1;
      await new Promise((done) => setTimeout(done, 20));
      return {
        digest: preparedWorkspaceDigest(fake, definition),
        provider,
        artifact: `template-${definition.trustedCommit}`,
        trustedCommit: definition.trustedCommit,
      };
    },
    async start(): Promise<ExecutionEnvironment> {
      throw new Error("not used");
    },
    async finalize(): Promise<never> {
      throw new Error("not used");
    },
    async evict(prepared: PreparedWorkspace) {
      fake.evicted.push(prepared.artifact);
    },
  };
  return fake;
}

describe("PreparedWorkspaceCache", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  const definition = (trustedCommit: string): WorkspaceDefinition => ({
    workspace: "app",
    source: "https://example.com/app.git",
    trustedCommit,
    setup: "pnpm install",
    harness: { commands: ["codex"] },
  });

  it("prepares a shared definition once under concurrency and reuses its record", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-prepared-"));
    roots.push(root);
    const fake = sharedFake();
    const cache = new PreparedWorkspaceCache({ root });
    const [first, second] = await Promise.all([
      cache.prepare(fake, definition("a".repeat(40))),
      cache.prepare(fake, definition("a".repeat(40))),
    ]);
    expect(fake.prepares).toBe(1);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(first.prepared).toEqual(second.prepared);
    const record = await cache.read("app", first.prepared.digest);
    expect(record).toMatchObject({
      provider: "fake",
      workspace: "app",
      trustedCommit: "a".repeat(40),
    });
    // A new process reuses the host record.
    expect(
      (await new PreparedWorkspaceCache({ root }).prepare(fake, definition("a".repeat(40)))).reused,
    ).toBe(true);
    expect(fake.prepares).toBe(1);
  });

  it("finds a warm start from an ancestor's artifact with the same key apart from the trusted commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-prepared-"));
    roots.push(root);
    const fake = sharedFake();
    const cache = new PreparedWorkspaceCache({ root });
    const old = await cache.prepare(fake, definition("a".repeat(40)));
    const warmKey = preparedWorkspaceWarmKey(fake, definition("b".repeat(40)));
    expect(
      await cache.warmStart("app", warmKey, async (commit) => commit === "a".repeat(40)),
    ).toMatchObject({
      digest: old.prepared.digest,
    });
    expect(await cache.warmStart("app", warmKey, async () => false)).toBeUndefined();
  });

  it("evicts beyond the three most recently used after each new prepare, and any unused for 7 days", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-prepared-"));
    roots.push(root);
    let now = Date.parse("2026-10-01T00:00:00Z");
    const fake = sharedFake();
    const cache = new PreparedWorkspaceCache({ root, now: () => now });
    for (const commit of ["1", "2", "3", "4", "5"]) {
      await cache.prepare(fake, definition(commit.repeat(40)));
      now += 60_000;
    }
    expect(fake.evicted).toEqual([`template-${"1".repeat(40)}`, `template-${"2".repeat(40)}`]);
    expect((await cache.list("app")).length).toBe(PREPARED_WORKSPACE_LIMITS.perWorkspace);
    expect(await cache.evict("app", fake)).toEqual([]);
    now += PREPARED_WORKSPACE_LIMITS.unusedMs + 1;
    expect((await cache.evict("app", fake)).length).toBe(3);
    expect(await cache.list("app")).toEqual([]);
  });

  it("evicts artifacts unused for 7 days on a cache hit", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-prepared-"));
    roots.push(root);
    let now = Date.parse("2026-10-01T00:00:00Z");
    const fake = sharedFake();
    const cache = new PreparedWorkspaceCache({ root, now: () => now });
    await cache.prepare(fake, definition("1".repeat(40)));
    now += 60_000;
    await cache.prepare(fake, definition("2".repeat(40)));
    now += PREPARED_WORKSPACE_LIMITS.unusedMs + 1;
    // A hit on the second keeps it in use; the first, unused for 7 days, goes.
    expect((await cache.prepare(fake, definition("2".repeat(40)))).reused).toBe(true);
    expect(fake.evicted).toEqual([`template-${"1".repeat(40)}`]);
    expect((await cache.list("app")).map((record) => record.trustedCommit)).toEqual([
      "2".repeat(40),
    ]);
  });

  it("counts the three-artifact limit per Workspace across providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-prepared-"));
    roots.push(root);
    let now = Date.parse("2026-10-01T00:00:00Z");
    const e2b = sharedFake("e2b");
    const modal = sharedFake("modal");
    const cache = new PreparedWorkspaceCache({ root, now: () => now });
    for (const [environment, commit] of [
      [e2b, "1"],
      [modal, "2"],
      [e2b, "3"],
      [modal, "4"],
    ] as const) {
      await cache.prepare(environment, definition(commit.repeat(40)));
      now += 60_000;
    }
    expect(e2b.evicted).toEqual([`template-${"1".repeat(40)}`]);
    expect(modal.evicted).toEqual([]);
    expect((await cache.list("app")).length).toBe(PREPARED_WORKSPACE_LIMITS.perWorkspace);
    // A fresh cache that knows no providers evicts none.
    now += PREPARED_WORKSPACE_LIMITS.unusedMs + 1;
    expect(await new PreparedWorkspaceCache({ root, now: () => now }).evict("app")).toEqual([]);
    expect((await cache.evict("app")).length).toBe(3);
  });

  it("keeps records whose provider is unavailable without counting them toward the limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-prepared-"));
    roots.push(root);
    let now = Date.parse("2026-10-01T00:00:00Z");
    const modal = sharedFake("modal");
    for (const commit of ["1", "2", "3"]) {
      await new PreparedWorkspaceCache({ root, now: () => now }).prepare(
        modal,
        definition(commit.repeat(40)),
      );
      now += 60_000;
    }
    // A cache on a host without Modal: its three e2b artifacts all fit the limit.
    const e2b = sharedFake("e2b");
    const cache = new PreparedWorkspaceCache({ root, now: () => now });
    for (const commit of ["4", "5", "6"]) {
      await cache.prepare(e2b, definition(commit.repeat(40)));
      now += 60_000;
    }
    expect(e2b.evicted).toEqual([]);
    expect(modal.evicted).toEqual([]);
    expect((await cache.list("app")).length).toBe(6);
  });

  it("refuses a provider that returns another digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-prepared-"));
    roots.push(root);
    const fake = sharedFake();
    const lying = {
      ...fake,
      prepare: async (input: WorkspaceDefinition) => ({
        ...(await fake.prepare(input)),
        digest: `sha256:${"0".repeat(64)}`,
      }),
    };
    await expect(
      new PreparedWorkspaceCache({ root }).prepare(lying, definition("a".repeat(40))),
    ).rejects.toThrow(/prepared sha256:0+ for digest/u);
  });

  it("keeps an artifact another process reused after eviction listed it", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-prepared-"));
    roots.push(root);
    let now = Date.parse("2026-10-01T00:00:00Z");
    const fake = sharedFake();
    const cache = new PreparedWorkspaceCache({ root, now: () => now });
    await cache.prepare(fake, definition("1".repeat(40)));
    await cache.prepare(fake, definition("2".repeat(40)));
    now += PREPARED_WORKSPACE_LIMITS.unusedMs + 1;
    // While the first eviction runs, a Task reuses the other artifact.
    const evict = fake.evict;
    let reused = false;
    fake.evict = async (prepared) => {
      if (!reused) {
        reused = true;
        const other = prepared.trustedCommit === "1".repeat(40) ? "2" : "1";
        expect((await cache.prepare(fake, definition(other.repeat(40)))).reused).toBe(true);
      }
      await evict(prepared);
    };
    expect((await cache.evict("app", fake)).length).toBe(1);
    expect((await cache.list("app")).length).toBe(1);
  });
});

describe("acquireLockFile", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("keeps a held lock fresh past the timeout, so a waiter never takes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-lock-"));
    roots.push(root);
    const path = join(root, "a.lock");
    const release = await acquireLockFile(path, 200);
    await new Promise((done) => setTimeout(done, 500));
    await expect(acquireLockFile(path, 200)).rejects.toThrow(/Timed out/u);
    await release();
    await (await acquireLockFile(path, 200))();
  });

  it("releases only the lock it holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-lock-"));
    roots.push(root);
    const path = join(root, "a.lock");
    const release = await acquireLockFile(path, 10_000);
    const token = await readFile(path, "utf8");
    expect(token).toMatch(new RegExp(`^${process.pid} [0-9a-f-]{36}\\n$`, "u"));
    // Another holder replaced it, as after a stale-lock takeover.
    await writeFile(path, `${process.pid} other\n`);
    await release();
    expect(await readFile(path, "utf8")).toBe(`${process.pid} other\n`);
  });
});

describe("LocalWorkspaceEnvironment", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "SuperTag",
        GIT_AUTHOR_EMAIL: "supertag@localhost",
        GIT_COMMITTER_NAME: "SuperTag",
        GIT_COMMITTER_EMAIL: "supertag@localhost",
      },
    }).trim();

  const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-local-environment-"));
    roots.push(root);
    const checkout = join(root, "checkout");
    await mkdir(checkout);
    git(checkout, "init", "--quiet", "-b", "main");
    await writeFile(join(checkout, "README.md"), "# App\n");
    git(checkout, "add", "-A");
    git(checkout, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial");
    const trusted = git(checkout, "rev-parse", "HEAD");
    const host = new WorkspaceHost({
      root: join(root, "workspaces"),
      checkouts: new Map([["app", checkout]]),
      cloneSources: false,
    });
    const environment = new LocalWorkspaceEnvironment({
      host,
      localMountRoot: await resolveLocalMountRoot(root),
    });
    const define = (taskId: string): WorkspaceDefinition =>
      workspaceDefinition({
        workspace: "app",
        source: "file:///app",
        trustedCommit: trusted,
        harness: { commands: ["codex"] },
        taskId,
      });
    const start = (prepared: PreparedWorkspace, taskId: string) =>
      environment.start(prepared, {
        taskId,
        attemptId: `${taskId}-attempt`,
        branch: `supertag/app/${taskId}`,
        base: trusted,
        head: trusted,
        plan: {
          files: [],
          mounts: [],
          environmentVariables: {},
          secretBindings: [],
          network: { mode: "none" },
        },
      });
    return { root, checkout, host, environment, define, start };
  };

  it("refuses a mount over the local Task checkout before starting it", async () => {
    const f = await fixture();
    const prepared = await f.environment.prepare(f.define("task-1"));
    await expect(
      f.environment.start(prepared, {
        taskId: "task-1",
        attemptId: "task-1-attempt",
        branch: "supertag/app/task-1",
        base: prepared.trustedCommit,
        head: prepared.trustedCommit,
        mounts: [
          { volume: "data", path: prepared.artifact, access: "read-only", strategy: "copy" },
        ],
        plan: {
          files: [],
          mounts: [],
          environmentVariables: {},
          secretBindings: [],
          network: { mode: "none" },
        },
      }),
    ).rejects.toThrow(/overlaps the checkout/u);
  });

  it("refuses to prepare over a worktree that resume did not check", async () => {
    const { host, environment, define } = await fixture();
    await environment.prepare(define("task-1"));
    // A new process, such as a restarted Worker, finds the worktree already there.
    const other = new LocalWorkspaceEnvironment({ host });
    await expect(other.prepare(define("task-1"))).rejects.toThrow(
      /already exists and was not checked/u,
    );
  });

  it("reads and writes only regular files inside the worktree", async () => {
    const { root, environment, define, start } = await fixture();
    const checkout = await start(await environment.prepare(define("task-1")), "task-1");
    await writeFile(join(root, "outside.txt"), "outside\n");
    await symlink(join(root, "outside.txt"), join(checkout.rootDirectory, "link.txt"));
    await symlink(root, join(checkout.rootDirectory, "dir"));
    await expect(checkout.read("link.txt")).rejects.toThrow(/symbolic link/u);
    await expect(checkout.read("dir/outside.txt")).rejects.toThrow(/symbolic link/u);
    await expect(
      checkout.prepare({
        files: [{ path: "link.txt", content: "tampered\n" }],
        mounts: [],
        environmentVariables: {},
        secretBindings: [],
        network: { mode: "none" },
      }),
    ).rejects.toThrow(/symbolic link/u);
    expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("outside\n");
    execFileSync("mkfifo", [join(checkout.rootDirectory, "pipe")]);
    await expect(checkout.read("pipe")).rejects.toThrow(/not a regular file/u);
    await checkout.prepare({
      files: [{ path: "nested/work.txt", content: "work\n", mode: 0o600 }],
      mounts: [],
      environmentVariables: {},
      secretBindings: [],
      network: { mode: "none" },
    });
    expect(await checkout.read("nested/work.txt")).toBe("work\n");
  });
});

describe("workspaceHarnessRequirement", () => {
  it("puts the Worker Profile's Harness into the prepared digest", () => {
    const local = new LocalWorkspaceEnvironment({
      host: new WorkspaceHost({ root: tmpdir(), checkouts: new Map(), cloneSources: false }),
    });
    const define = (provider: string) =>
      workspaceDefinition({
        workspace: "app",
        source: "file:///app",
        trustedCommit: "a".repeat(40),
        harness: workspaceHarnessRequirement({ harness: { provider } }),
        taskId: "task-1",
      });
    expect(define("codex").harness).toEqual({ commands: ["codex"] });
    expect(preparedWorkspaceDigest(local, define("codex"))).not.toBe(
      preparedWorkspaceDigest(local, define("claude-code")),
    );
  });

  it("keeps resolved MCP servers out of the definition, keeping only declared shapes", () => {
    const definition = workspaceDefinition({
      workspace: "app",
      source: "file:///app",
      trustedCommit: "a".repeat(40),
      mcp: {
        servers: [
          { name: "docs", url: "https://mcp.example.com", headers: { a: "secret" } },
          { name: "db", command: "node", args: ["db.js"], cwd: "/snapshot", env: { T: "secret" } },
        ],
        definitions: [
          { name: "db", transport: "stdio", command: "node", args: ["db.js"], env: { T: "X" } },
          // Fields a caller attached beyond the declared shape never reach a provider.
          { name: "docs", transport: "http", url: "secret" } as never,
        ],
        digest: "sha256:mcp",
      },
      harness: { commands: ["codex"] },
    });
    expect(definition).toEqual({
      workspace: "app",
      source: "file:///app",
      trustedCommit: "a".repeat(40),
      mcp: {
        digest: "sha256:mcp",
        servers: [
          { name: "db", transport: "stdio", command: "node", args: ["db.js"], env: { T: "X" } },
          { name: "docs", transport: "http" },
        ],
      },
      harness: { commands: ["codex"] },
    });
    expect(JSON.stringify(definition)).not.toContain("secret");
  });
});
