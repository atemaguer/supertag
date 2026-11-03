import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertWorkspaceMountPaths,
  gitRefComponent,
  type MountManifest,
  type MountOutputManifest,
  type TaskNamedWorkspacePlan,
  type WorkspaceMount,
} from "@supertag/core";
import type { EnvironmentPlan, ExecutionEnvironment, ProcessHandle } from "./index.js";
import { assertLocalMountDestination, type LocalMountRoot } from "./local-mount-root.js";
import { replaceHardLinks } from "./private-copies.js";
import {
  copyWorkspaceMounts,
  HostCopyChangedError,
  type HostVolumeCopy,
  HostVolumeCopyTarget,
  listHostMountUploadFiles,
  parseHostVolumeCopy,
  removeHostVolumeCopy,
  uploadWorkspaceMount,
  VolumeCopyError,
  type VolumeResolver,
} from "./volume-copy.js";
import {
  assertWorkspaceMountSupport,
  exists,
  type FinalizedWork,
  type PreparedWorkspace,
  preparedWorkspaceDigest,
  SAFE_DIFF,
  type TaskCheckout,
  type WorkspaceCommit,
  type WorkspaceDefinition,
  type WorkspaceEnvironment,
  type WorkspaceHost,
  type WorkspaceRepository,
  type WorkspaceWorktree,
} from "./workspace-environment.js";
import { assertLocalWorkspaceMountPaths } from "./workspace-mount-paths.js";

const SETUP_MARKER = "supertag-setup";
const BASE_MARKER = "supertag-base";

export interface LocalWorkspaceEnvironmentOptions {
  /** The host repositories, locks, and git commands this environment shares with delivery. */
  readonly host: WorkspaceHost;
  readonly localMountRoot?: LocalMountRoot;
  /** Bound for the Workspace setup command. Default: 10 minutes. */
  readonly setupTimeoutMs?: number;
  /**
   * Environment for the setup command. Default: the Worker's process-launch plumbing only.
   * TMPDIR, TMP, and TEMP always name a fresh private directory, removed after setup.
   */
  readonly setupEnvironment?: Readonly<Record<string, string>>;
}

/** Commits a local Workspace Task reads before it is prepared, and the trusted commit if known. */
export interface LocalTaskCommits {
  readonly base: string;
  readonly head: string;
  readonly trusted?: string;
}

/**
 * Workspaces on the Worker Host itself. `prepare` adds a Task worktree detached at the trusted
 * commit and runs the hardened host `setup` there; `start` moves it onto the Task branch with a
 * forced checkout that keeps the files git ignores; `finalize` commits on the host; `evict`
 * discards the worktree. Setup outputs can embed the worktree's absolute path, so each Task gets
 * its own prepared worktree.
 */
export class LocalWorkspaceEnvironment implements WorkspaceEnvironment {
  readonly provider = "local";
  readonly capabilities = {
    // `start` copies mounts after setup and outside any prepared state.
    mounts: { strategies: ["copy"], access: ["read-only", "read-write"] },
    sharedPrepare: false,
    setupOnHost: true,
    declaredCheckouts: true,
    devcontainer: false,
    mcpStdio: "host",
  } as const;
  readonly #host: WorkspaceHost;
  readonly #localMountRoot: LocalMountRoot | undefined;
  readonly #setupTimeoutMs: number;
  readonly #setupEnvironment: Readonly<Record<string, string>> | undefined;
  /** Definitions prepared in this process, by digest, until their Task starts. */
  readonly #definitions = new Map<string, WorkspaceDefinition>();
  /**
   * Kept worktrees {@link resume} accepted, by path, with the trusted commit it checked setup
   * against. Only these, and worktrees this process prepared, are reused by `prepare`.
   */
  readonly #resumed = new Map<string, string | undefined>();
  /** Host mount paths holding a copy, by path, with the Task Attempt that owns each. */
  readonly #mountOwners = new Map<string, string>();
  /** Each started Attempt's copied mount paths, removed by {@link releaseMounts}. */
  readonly #mountsByAttempt = new Map<string, readonly string[]>();
  readonly #uploadsByAttempt = new Map<
    string,
    {
      mounts: readonly WorkspaceMount[];
      manifests: readonly MountManifest[];
      volumes: VolumeResolver | undefined;
      taskId: string;
    }
  >();

  constructor(options: LocalWorkspaceEnvironmentOptions) {
    this.#host = options.host;
    this.#localMountRoot = options.localMountRoot;
    this.#setupTimeoutMs = options.setupTimeoutMs ?? 600_000;
    this.#setupEnvironment = options.setupEnvironment;
  }

  /** The Task worktree directory for a Workspace and Task. */
  worktreePath(workspace: string, taskId: string): string {
    return join(this.#host.root, workspace, "worktrees", gitRefComponent(taskId));
  }

  refuse(definition: WorkspaceDefinition): string | undefined {
    if (definition.taskId === undefined)
      return `Local Workspace environments prepare one worktree per Task, and the definition of Workspace ${definition.workspace} names no Task`;
    return undefined;
  }

  /**
   * Checks the worktree a failed or cancelled Attempt kept. It is reused when it is on the Task
   * branch and setup already ran on the same trusted commit; then its commits are returned. A
   * worktree whose preparation stopped before it reached the Task branch, or one needing setup
   * again with no uncommitted changes, is discarded. Uncommitted changes are never discarded.
   */
  async resume(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    taskId: string,
    reviewHead?: string,
  ): Promise<LocalTaskCommits | undefined> {
    const worktree = this.worktreePath(plan.workspace, taskId);
    if (!(await exists(worktree))) return undefined;
    const host = this.#host;
    const needsTrusted = plan.setup !== undefined || !!plan.mcp?.length || !!plan.skills?.length;
    const tree = await host.openWorktree(repository, worktree);
    const current = await host.currentBranch(tree);
    const clean = async () =>
      !(await host.run(tree, ["status", "--porcelain", "--untracked-files=all"])).trim();
    if (current === "") {
      // A detached worktree whose preparation stopped before it reached the Task branch, and
      // so before any harness ran in it, is recreated.
      const prepared = await exists(join(tree.gitDir, SETUP_MARKER));
      if (prepared && !(await clean()))
        throw new Error(
          `Task worktree ${worktree} is not on branch ${plan.branch} and has uncommitted changes; remove it to recreate it`,
        );
    } else {
      if (current !== plan.branch)
        throw new Error(
          `Task worktree ${worktree} is not on branch ${plan.branch} of this repository; remove it to recreate it`,
        );
      if (reviewHead) await host.assertContains(tree, reviewHead, "HEAD");
      const base = await this.recordedBase(tree, plan, repository);
      const trusted = needsTrusted
        ? await host.trusted(repository, plan, reviewHead ?? base)
        : undefined;
      if (plan.setup === undefined || (await setupDone(tree, trusted as string, plan.setup))) {
        const head = (await host.run(tree, ["rev-parse", "HEAD"])).trim();
        this.#resumed.set(worktree, trusted);
        return { base, head, ...(trusted === undefined ? {} : { trusted }) };
      }
      // Setup has not run on this trusted commit. The branch holds every commit, so a clean
      // worktree is recreated from it; uncommitted changes are never discarded.
      if (!(await clean()))
        throw new Error(
          `Task worktree ${worktree} has uncommitted changes and needs Workspace setup on base commit ${(trusted as string).slice(0, 12)}; commit or remove the changes`,
        );
    }
    await host.discardWorktree(repository, worktree);
    return undefined;
  }

  /**
   * Adds the Task worktree detached at the trusted commit, so `setup` sees no AI-authored file,
   * and runs `setup` there with a private TMPDIR. Setup outputs then get private copies of any
   * hardlinked file. A worktree that already exists is reused as it is only when it is the Task's
   * kept one, which {@link resume} accepted for the same trusted commit, or one this process
   * prepared for the same definition and has not started; any other is refused. A failed setup
   * removes the worktree.
   */
  async prepare(definition: WorkspaceDefinition): Promise<PreparedWorkspace> {
    const refusal = this.refuse(definition);
    if (refusal !== undefined) throw new Error(refusal);
    const host = this.#host;
    const worktree = this.worktreePath(definition.workspace, definition.taskId as string);
    const prepared: PreparedWorkspace = {
      digest: preparedWorkspaceDigest(this, definition),
      provider: this.provider,
      artifact: worktree,
      trustedCommit: definition.trustedCommit,
    };
    if (await exists(worktree)) {
      const resumed = this.#resumed.has(worktree);
      const trusted = this.#resumed.get(worktree);
      if (
        !(resumed && (trusted === undefined || trusted === definition.trustedCommit)) &&
        !this.#definitions.has(prepared.digest)
      )
        throw new Error(
          `Task worktree ${worktree} already exists and was not checked for this Task Attempt; remove it to recreate it`,
        );
      this.#resumed.delete(worktree);
      this.#definitions.set(prepared.digest, definition);
      return prepared;
    }
    this.#resumed.delete(worktree);
    this.#definitions.set(prepared.digest, definition);
    const repository = await host.opened(definition.workspace);
    const tree = await host.exclusive(definition.workspace, async () => {
      // A worktree directory removed by hand leaves stale registration behind.
      await host.run(repository.path, ["worktree", "prune"]);
      await mkdir(dirname(worktree), { recursive: true });
      await host.run(repository.path, [
        "worktree",
        "add",
        "--quiet",
        "--detach",
        worktree,
        definition.trustedCommit,
      ]);
      return host.openWorktree(repository, worktree);
    });
    if (definition.setup === undefined) return prepared;
    try {
      // A fresh private temporary directory, so setup reads no cache a sandbox could write.
      const temporaryRoot = join(host.root, definition.workspace, "tmp");
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const temporary = await mkdtemp(join(temporaryRoot, "setup-"));
      try {
        await runShell(definition.setup, tree.path, this.#setupTimeoutMs, {
          ...(this.#setupEnvironment ?? inheritedSetupEnvironment()),
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
        });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      // Setup outputs share no inode with anything outside the worktree, such as a package
      // manager's store, so a Task that edits them changes only its own copy.
      const outputs = await host.run(tree, ["ls-files", "--others", "--directory", "-z"]);
      await replaceHardLinks(tree.path, outputs.split("\0").filter(Boolean)).catch(
        (error: unknown) => {
          throw new WorkspaceSetupError(error instanceof Error ? error.message : String(error));
        },
      );
    } catch (error) {
      this.#definitions.delete(prepared.digest);
      await host
        .exclusive(definition.workspace, () => host.discardWorktree(repository, worktree))
        .catch(() => undefined);
      throw error;
    }
    return prepared;
  }

  /**
   * Moves a newly prepared worktree onto the Task branch with a forced checkout: tracked files
   * are replaced and the files git ignores, such as `node_modules/`, stay. A kept worktree is
   * already on the branch and keeps its uncommitted changes. The checkout is exactly `task.head`:
   * an existing Task branch, or a kept worktree, at any other commit is refused rather than moved,
   * and the checkout must contain the Task's base. The Attempt's git digest is recorded here; later Worker git commands check it. The
   * returned environment is the worktree, used in place: the Worker's local execution
   * environment runs the Harness, and the Task's plan applies there.
   */
  async start(prepared: PreparedWorkspace, task: TaskCheckout): Promise<LocalWorkspaceCheckout> {
    assertWorkspaceMountSupport(this, task.mounts ?? []);
    for (const mount of task.mounts ?? [])
      await assertLocalMountDestination(mount.path, this.#localMountRoot);
    assertWorkspaceMountPaths(
      task.mounts ?? [],
      prepared.artifact,
      task.plan.files.map((file) => resolve(prepared.artifact, file.path)),
    );
    const host = this.#host;
    const workspace = this.#workspaceOf(prepared);
    const definition = this.#definitions.get(prepared.digest);
    this.#definitions.delete(prepared.digest);
    const repository = await host.opened(workspace);
    const tree = await host.openWorktree(repository, prepared.artifact);
    await assertLocalWorkspaceMountPaths(
      task.mounts ?? [],
      tree.path,
      task.plan.files.map((file) => resolve(tree.path, file.path)),
      [host.root, repository.path, tree.gitDir, ...host.declaredCheckoutPaths],
    );
    const current = await host.currentBranch(tree);
    const atHead = async (where: string) => {
      const head = (await host.run(tree, ["rev-parse", "HEAD"])).trim();
      if (head !== task.head)
        throw new Error(
          `${where} is at ${head.slice(0, 12)}, not this Task Attempt's head ${task.head.slice(0, 12)}; SuperTag refused to start from it`,
        );
    };
    if (current === task.branch) await atHead(`Task worktree ${tree.path}`);
    else {
      if (current !== "")
        throw new Error(
          `Task worktree ${tree.path} is not on branch ${task.branch} of this repository; remove it to recreate it`,
        );
      try {
        await writeFile(join(tree.gitDir, BASE_MARKER), `${task.base}\n`);
        await host.exclusive(workspace, async () => {
          const branch = `refs/heads/${task.branch}`;
          if (await host.hasRef(repository.path, branch)) {
            // The branch could have moved since its head was read; never start elsewhere.
            const head = await host.commit(
              repository.path,
              branch,
              `Task branch ${branch} is unreadable`,
            );
            if (head !== task.head)
              throw new Error(
                `Task branch ${task.branch} is at ${head.slice(0, 12)}, not this Task Attempt's head ${task.head.slice(0, 12)}; SuperTag refused to start from it`,
              );
            await host.run(tree, ["checkout", "--force", "--quiet", task.branch]);
          } else
            await host.run(tree, [
              "checkout",
              "--force",
              "--quiet",
              "--no-track",
              "-b",
              task.branch,
              task.head,
            ]);
          await atHead(`Task branch ${task.branch}`);
          // The branch could have moved while setup ran; it must still contain the base, which
          // for a review is the submitted commit.
          await host.assertContains(tree, task.base, "HEAD");
        });
        if (definition?.setup !== undefined)
          await writeFile(
            join(tree.gitDir, SETUP_MARKER),
            setupMarker(prepared.trustedCommit, definition.setup),
          );
      } catch (error) {
        await host
          .exclusive(workspace, () => host.discardWorktree(repository, tree.path))
          .catch(() => undefined);
        throw error;
      }
    }
    await host.recordIntegrity(task.attemptId, repository, tree);
    const mountManifests = await this.#copyMounts(task, [
      tree.path,
      repository.path,
      tree.gitDir,
      ...host.declaredCheckoutPaths,
      ...task.plan.files.map((file) => resolve(tree.path, file.path)),
    ]);
    this.#uploadsByAttempt.set(task.attemptId, {
      mounts: task.mounts ?? [],
      manifests: mountManifests,
      volumes: task.volumes,
      taskId: task.taskId,
    });
    return new LocalWorkspaceCheckout({
      workspace,
      repository,
      tree,
      branch: task.branch,
      taskId: task.taskId,
      attemptId: task.attemptId,
      mounts: task.mounts ?? [],
      mountManifests,
    });
  }

  /**
   * Copies the Task's `copy` mounts to their literal paths on this host, after setup and the
   * checkout, so each Task Attempt gets its own copy, including of a `file://` Volume.
   * A path another running Attempt holds is refused. A copy an earlier Attempt left is replaced
   * only when this host's record of it still verifies, directory by directory, by device and
   * inode; any other existing path is refused, never removed. A copy may not resolve into the
   * checkout, the declared repository, the host's Workspace state, or a temporary directory, and
   * a `file://` source may not be in or contain the host's Workspace state.
   */
  async #copyMounts(
    task: TaskCheckout,
    forbidden: readonly string[],
  ): Promise<readonly MountManifest[]> {
    const mounts = task.mounts ?? [];
    if (mounts.length === 0) return [];
    const registry = join(this.#host.root, ".mounts");
    await mkdir(registry, { recursive: true, mode: 0o700 });
    const record = (path: string) => mountRecord(registry, path);
    const claimed: string[] = [];
    try {
      for (const mount of mounts) {
        const owner = this.#mountOwners.get(mount.path);
        if (owner !== undefined && owner !== task.attemptId)
          throw new VolumeCopyError(
            `Mount path ${mount.path} for Volume ${mount.volume} holds another running Task Attempt's copy on this Worker Host`,
          );
        this.#mountOwners.set(mount.path, task.attemptId);
        claimed.push(mount.path);
        // A copy an earlier Attempt left, for example after the Worker stopped, is replaced.
        await removeRecordedCopy(record(mount.path), mount.path, true);
      }
      const manifests = await copyWorkspaceMounts({
        mounts,
        volumes: task.volumes,
        task: { taskId: task.taskId, attemptId: task.attemptId },
        protectedDirectories: [this.#host.root, ...forbidden],
        // The record is written only once this Attempt created and verified the directory, so
        // cleanup never removes a path SuperTag did not create.
        target: new HostVolumeCopyTarget(
          [...forbidden, this.#host.root],
          (copy) =>
            writeFile(
              record(copy.path),
              `${JSON.stringify({ attemptId: task.attemptId, copy } satisfies MountRecord)}\n`,
              { mode: 0o600 },
            ),
          this.#localMountRoot,
        ),
      });
      this.#mountsByAttempt.set(task.attemptId, claimed);
      return manifests;
    } catch (error) {
      await this.#removeCopies(task.attemptId, claimed);
      throw error;
    }
  }

  /** Removes the copies a Task Attempt's `start` made; done when the Attempt ends. */
  async releaseMounts(attemptId: string): Promise<void> {
    this.#uploadsByAttempt.delete(attemptId);
    const paths = this.#mountsByAttempt.get(attemptId) ?? [];
    this.#mountsByAttempt.delete(attemptId);
    await this.#removeCopies(attemptId, paths);
  }

  async #removeCopies(attemptId: string, paths: readonly string[]): Promise<void> {
    const registry = join(this.#host.root, ".mounts");
    for (const path of paths) {
      if (this.#mountOwners.get(path) !== attemptId) continue;
      // Only a copy this host recorded, and that still verifies, is removed.
      await removeRecordedCopy(mountRecord(registry, path), path, false).catch(() => undefined);
      this.#mountOwners.delete(path);
    }
  }

  /**
   * The checkout of an existing Task worktree on its branch, for an Attempt that this process did
   * not start, such as after a Worker restart. Undefined when the worktree is gone.
   */
  async reopen(
    repository: WorkspaceRepository,
    plan: TaskNamedWorkspacePlan,
    task: { readonly taskId: string; readonly attemptId: string },
  ): Promise<LocalWorkspaceCheckout | undefined> {
    const worktree = this.worktreePath(plan.workspace, task.taskId);
    if (!(await exists(worktree))) return undefined;
    const tree = await this.#host.openWorktree(repository, worktree, plan.branch);
    return new LocalWorkspaceCheckout({
      workspace: plan.workspace,
      repository,
      tree,
      branch: plan.branch,
      taskId: task.taskId,
      attemptId: task.attemptId,
      mounts: plan.mounts ?? [],
    });
  }

  /**
   * Commits whatever the Attempt left, for every outcome. `add -A` never stages files matched by
   * `.gitignore`. Hooks, signing, and host git config never apply.
   */
  async finalize(
    environment: ExecutionEnvironment,
    commit: WorkspaceCommit,
  ): Promise<FinalizedWork> {
    if (!(environment instanceof LocalWorkspaceCheckout))
      throw new Error("Local Workspace finalize needs the checkout its start returned");
    const host = this.#host;
    const tree = environment.tree;
    const finalized = await host.checked(environment.attemptId, async () => {
      const status = await host.run(tree, ["status", "--porcelain", "--untracked-files=all"]);
      let committed = false;
      if (status.trim()) {
        await host.run(tree, ["add", "-A"]);
        const staged = await host.run(tree, ["diff", ...SAFE_DIFF, "--cached", "--name-only"]);
        if (staged.trim()) {
          await host.run(tree, [
            "-c",
            `user.name=${commit.author.name}`,
            "-c",
            `user.email=${commit.author.email}`,
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--no-verify",
            "--quiet",
            "-m",
            commit.message,
          ]);
          committed = true;
        }
      }
      const head = (await host.run(tree, ["rev-parse", "HEAD"])).trim();
      return { head, committed };
    });
    const upload = this.#uploadsByAttempt.get(environment.attemptId);
    const outputs: MountOutputManifest[] = [];
    try {
      if (upload)
        for (const mount of upload.mounts) {
          if (mount.strategy !== "copy" || mount.access !== "read-write") continue;
          const input = upload.manifests.find((entry) => entry.path === mount.path);
          if (!input || !upload.volumes)
            throw new Error(`Volume ${mount.volume} has no input copy manifest`);
          const volume = await upload.volumes.resolve(mount.volume, {
            taskId: upload.taskId,
            attemptId: environment.attemptId,
          });
          outputs.push(
            await uploadWorkspaceMount({
              mount,
              input,
              volume,
              files: () => listHostMountUploadFiles(mount.path),
            }),
          );
          if (outputs.at(-1)?.status !== "complete") break;
        }
      return { ...finalized, mountOutputManifests: outputs };
    } finally {
      // Copies remain available through upload and end with this Attempt.
      await this.releaseMounts(environment.attemptId);
    }
  }

  /** Discards the Task worktree and its registration; the Task branch and its commits stay. */
  async evict(prepared: PreparedWorkspace): Promise<void> {
    const workspace = this.#workspaceOf(prepared);
    this.#definitions.delete(prepared.digest);
    const repository = await this.#host.opened(workspace);
    await this.#host.exclusive(workspace, () =>
      this.#host.discardWorktree(repository, prepared.artifact),
    );
  }

  /** The recorded base, or the merge base with the configured base ref for recreated worktrees. */
  async recordedBase(
    tree: WorkspaceWorktree,
    plan: TaskNamedWorkspacePlan,
    repository: WorkspaceRepository,
  ): Promise<string> {
    const marker = join(tree.gitDir, BASE_MARKER);
    const recorded = (await readFile(marker, "utf8").catch(() => "")).trim();
    if (/^[0-9a-f]{40,64}$/u.test(recorded)) return recorded;
    const baseRef = await this.#host.baseRef(repository, plan);
    const base = (
      await this.#host
        .run(tree, ["merge-base", "HEAD", baseRef])
        .catch(() => this.#host.run(tree, ["rev-parse", "HEAD"]))
    ).trim();
    await writeFile(marker, `${base}\n`);
    return base;
  }

  /** The Workspace a local artifact belongs to, from its path under the Workspace root. */
  #workspaceOf(prepared: PreparedWorkspace): string {
    if (prepared.provider !== this.provider)
      throw new Error(
        `Prepared Workspace ${prepared.digest} belongs to ${prepared.provider}, not local`,
      );
    const parts = relative(this.#host.root, prepared.artifact).split(sep);
    if (parts.length !== 3 || parts[1] !== "worktrees" || !parts[0] || parts[0] === "..")
      throw new Error(
        `Prepared Workspace artifact ${prepared.artifact} is not a local Task worktree`,
      );
    return parts[0];
  }
}

/**
 * A local Task worktree, used in place. It reads and stages files inside the worktree only and
 * never runs a process: the Worker's local execution environment runs the Harness in it. Its
 * lifetime is the Workspace's, so `dispose` leaves the worktree for delivery or a retry.
 */
export class LocalWorkspaceCheckout implements ExecutionEnvironment {
  readonly id: string;
  readonly placement = "local" as const;
  readonly rootDirectory: string;
  readonly workspace: string;
  readonly repository: WorkspaceRepository;
  readonly tree: WorkspaceWorktree;
  readonly branch: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly mounts: readonly WorkspaceMount[];
  /** What `start` copied for this Attempt's mounts. */
  readonly mountManifests: readonly MountManifest[];

  constructor(input: {
    readonly workspace: string;
    readonly repository: WorkspaceRepository;
    readonly tree: WorkspaceWorktree;
    readonly branch: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly mounts?: readonly WorkspaceMount[];
    readonly mountManifests?: readonly MountManifest[];
  }) {
    this.id = `local-workspace:${input.tree.path}`;
    this.rootDirectory = input.tree.path;
    this.workspace = input.workspace;
    this.repository = input.repository;
    this.tree = input.tree;
    this.branch = input.branch;
    this.taskId = input.taskId;
    this.attemptId = input.attemptId;
    this.mounts = input.mounts ?? [];
    this.mountManifests = input.mountManifests ?? [];
  }

  get provenance() {
    return { provider: "local", workspace: this.workspace, branch: this.branch };
  }

  /** Stages the plan's files into the worktree. Mounts and secrets belong to the Worker's environment. */
  async prepare(plan: EnvironmentPlan): Promise<void> {
    assertWorkspaceMountPaths(
      this.mounts,
      this.tree.path,
      plan.files.map((file) => resolve(this.rootDirectory, file.path)),
    );
    if (plan.mounts.length > 0 || plan.secretBindings.length > 0)
      throw new Error(
        "A local Workspace checkout stages files only; mounts and secrets apply in the Worker's execution environment",
      );
    for (const file of plan.files) {
      await mkdir(dirname(await this.#confined(file.path)), { recursive: true });
      const handle = await open(
        await this.#confined(file.path),
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        file.mode ?? 0o644,
      );
      try {
        if (!(await handle.stat()).isFile())
          throw new Error(`Path ${file.path} is not a regular file`);
        await handle.writeFile(file.content);
        if (file.mode !== undefined) await handle.chmod(file.mode);
      } finally {
        await handle.close();
      }
    }
  }

  resolvePath(path: string): string {
    const target = resolve(this.rootDirectory, path);
    const inside = relative(this.rootDirectory, target);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new Error(`Path ${path} is outside the Task worktree`);
    return target;
  }

  async read(path: string): Promise<string> {
    return Buffer.from(await this.readBytes(path)).toString("utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const handle = await open(
      await this.#confined(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`Path ${path} is not a regular file`);
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  async spawn(): Promise<ProcessHandle> {
    throw new Error(
      "A local Workspace checkout is used in place; the Worker's local execution environment runs processes in it",
    );
  }

  async dispose(): Promise<void> {}

  /**
   * The path inside the worktree, refusing any symbolic link along it and a parent directory
   * whose real path leaves the worktree. Callers open the final component with `O_NOFOLLOW`.
   */
  async #confined(path: string): Promise<string> {
    const target = this.resolvePath(path);
    let current = this.rootDirectory;
    for (const part of relative(this.rootDirectory, target).split(sep)) {
      current = join(current, part);
      const status = await lstat(current).catch(() => undefined);
      if (status?.isSymbolicLink()) throw new Error(`Path ${path} crosses a symbolic link`);
    }
    const root = await realpath(this.rootDirectory);
    const parent = await realpath(dirname(target)).catch(() => undefined);
    if (parent !== undefined) {
      const inside = relative(root, parent);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        throw new Error(`Path ${path} is outside the Task worktree`);
    }
    return target;
  }
}

/** Setup completion for one command on one trusted commit. */
function setupMarker(trusted: string, setup: string): string {
  // `outputs: private` records that setup ran with a private TMPDIR and its outputs were given
  // their own copies; a worktree prepared without that is set up again.
  return `${JSON.stringify({ base: trusted, setup, outputs: "private" })}\n`;
}

/** True when setup completed for this command on this trusted commit. */
async function setupDone(
  tree: WorkspaceWorktree,
  trusted: string,
  setup: string,
): Promise<boolean> {
  const recorded = await readFile(join(tree.gitDir, SETUP_MARKER), "utf8").catch(() => undefined);
  return recorded === setupMarker(trusted, setup);
}

/** Setup gets its own TMPDIR, TMP, and TEMP instead of the Worker's. */
const SETUP_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

/** A failed operator-declared setup command, distinct from harness execution failures. */
class WorkspaceSetupError extends Error {
  override name = "WorkspaceSetupError";
}

/** The Worker's process-launch plumbing, without credentials. */
function inheritedSetupEnvironment(): Record<string, string> {
  return Object.fromEntries(
    SETUP_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

/** The Workspace setup command is one operator-declared shell command, by definition. */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new WorkspaceSetupError(`Workspace setup could not start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else
        reject(
          new WorkspaceSetupError(
            `Workspace setup failed (${signal ?? `exit ${code}`}): ${output.trim().slice(-1000)}`,
          ),
        );
    });
  });
}

/** What `.mounts/<sha256 of path>.json` holds: the copy a Task Attempt created at that path. */
interface MountRecord {
  readonly attemptId: string;
  readonly copy: HostVolumeCopy;
}

function mountRecord(registry: string, path: string): string {
  return join(registry, `${createHash("sha256").update(resolve(path)).digest("hex")}.json`);
}

/**
 * Removes the copy a record names, when every directory from `/` down to it is still the one
 * SuperTag created. A record whose copy moved or changed is dropped and the path left alone, so
 * a later `create` refuses it if anything is there. Any other failure keeps the record, so a
 * later Attempt retries; at `start` it refuses the mount.
 */
async function removeRecordedCopy(file: string, path: string, starting: boolean): Promise<void> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return;
  let copy: HostVolumeCopy | undefined;
  try {
    copy = parseHostVolumeCopy((JSON.parse(text) as { copy?: unknown }).copy);
  } catch {
    copy = undefined;
  }
  if (copy !== undefined && copy.path === resolve(path))
    try {
      await removeHostVolumeCopy(copy);
    } catch (error) {
      if (!(error instanceof HostCopyChangedError)) {
        if (!starting) throw error;
        throw new VolumeCopyError(
          `Mount path ${path} holds an earlier Task Attempt's copy that SuperTag could not remove: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  await rm(file, { force: true });
}
