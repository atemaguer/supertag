/**
 * Workspaces in remote sandboxes. `prepare` builds a provider artifact (an E2B template, a Modal
 * image) from a bundle of the trusted commit and runs `setup` inside the build, with network.
 * `start` creates the Task's sandbox from that artifact under the Task's network policy, fetches
 * the Task's objects, and checks out its head. `finalize` commits inside the sandbox and reads the
 * Task's commits back as a bounded bundle. The Worker Host runs git on data only and never runs
 * anything from the sandbox; providers receive bundles, never source credentials. Workspace stdio
 * MCP servers run inside the Task's sandbox from a copy of the trusted commit placed at prepare.
 */
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import {
  assertWorkspaceMountPaths,
  isSensitiveWorkspaceMountPath,
  type LiveMount,
  type MountManifest,
  type MountOutputManifest,
  parseVolumeSource,
  type WorkspaceMount,
} from "@supertag/core";
import { resolvedDevcontainerEnv } from "./devcontainer-subset.js";
import type { EnvironmentPlan, ExecutionEnvironment, ProcessHandle, ProcessSpec } from "./index.js";
import {
  type SandboxBackend,
  type SandboxInstance,
  sandboxExecutionEnvironment,
  terminateSandbox,
} from "./sandbox-environment.js";
import {
  listSandboxMountUploadFiles,
  planWorkspaceMounts,
  type ResolvedVolume,
  SandboxVolumeCopyTarget,
  uploadWorkspaceMount,
  VolumeCopyError,
  type VolumeResolver,
} from "./volume-copy.js";
import {
  CHECKOUT_BUNDLE_REF,
  checkReturnedBundle,
  parseGitBundleHeader,
  readGitObjects,
  readGitObjectsHeader,
  TRUSTED_BUNDLE_REF,
  WORKSPACE_BUNDLE_LIMITS,
  writeReturnedBundle,
} from "./workspace-bundles.js";
import {
  assertWorkspaceMountSupport,
  COMMIT_STAGING,
  type DevcontainerCommand,
  type DevcontainerSubset,
  type FinalizedWork,
  type GitObjects,
  type PreparedWorkspace,
  preparedWorkspaceDigest,
  type TaskCheckout,
  type WorkspaceCommit,
  type WorkspaceDefinition,
  type WorkspaceEnvironment,
  type WorkspaceEnvironmentCapabilities,
  type WorkspaceHarnessRequirement,
} from "./workspace-environment.js";
import { sandboxMcpRefusal } from "./workspace-mcp.js";

/** What a provider driver builds one artifact from. Everything in it is trusted. */
export interface WorkspaceSandboxBuild {
  /** A new artifact name for this host: `supertag-<digest prefix>-<random>`. */
  readonly name: string;
  /** The prepared digest the artifact is for. */
  readonly digest: string;
  /** Warm prepare: an artifact this host prepared earlier to start from, instead of the base. */
  readonly from?: string;
  /** Installed before the content, so a provider can cache the layer. Skipped when warm. */
  readonly harness: WorkspaceHarnessRequirement;
  /**
   * {@link WORKSPACE_MCP_NODE_INSTALL} when the definition selects a stdio MCP server: the driver
   * runs it as root, even after a devcontainer `USER`, before the content and the harness
   * install, then restores the devcontainer's user, so a provider can cache the layer. Skipped
   * when warm; `script` then checks that Node.js is still there.
   */
  readonly mcpRuntimeInstall?: string;
  /**
   * Where `script` places the trusted copy for a stdio MCP server, beside the checkout; set only
   * when one is selected. The driver creates it, owned by the devcontainer's user, with the
   * checkout.
   */
  readonly mcpDirectory?: string;
  /** The host bundle of the trusted commit, already checked against the definition. */
  readonly content: GitObjects;
  /** Validated devcontainer settings from the trusted commit. */
  readonly devcontainer?: DevcontainerSubset;
  /** Host repository used only for data-only Docker build context reads. */
  readonly trustedRepository?: string;
  readonly trustedCommit: string;
  readonly workspaceDirectory: string;
  /** Where the build must place the content bundle before it runs `script`. */
  readonly contentPath: string;
  /** A POSIX shell script the build runs with network, after the bundle is in place. */
  readonly script: string;
  readonly signal?: AbortSignal;
}

/**
 * The provider-specific part of a remote Workspace environment. A driver builds artifacts in a
 * fresh build or setup sandbox where no Task ever ran, creates Task sandboxes from them, and
 * deletes them. It never snapshots a Task sandbox.
 */
export interface WorkspaceSandboxDriver {
  readonly provider: string;
  readonly mounts?: WorkspaceEnvironmentCapabilities["mounts"];
  refuseMount?(mount: WorkspaceMount, volume: ResolvedVolume): string | undefined;
  /** The provider's base template or image; part of every prepared digest. */
  readonly base: string;
  /** Absolute path of the checkout inside every build and Task sandbox. */
  readonly workspaceDirectory: string;
  /** Absolute directory for bundles in transit inside a sandbox. */
  readonly transferDirectory: string;
  readonly backend: Pick<SandboxBackend, "guarantees" | "capabilities">;
  /** Provider-specific subset refusal, before any remote API call. */
  refuse?(definition: WorkspaceDefinition): string | undefined;
  /** Builds an artifact and returns its provider ID. */
  build(input: WorkspaceSandboxBuild): Promise<string>;
  /** Creates a Task sandbox from an artifact, with the network fixed at creation. */
  create(input: {
    readonly nativeMounts?: readonly {
      readonly mount: WorkspaceMount;
      readonly volume: ResolvedVolume;
    }[];
    readonly artifact: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly network: EnvironmentPlan["network"];
    readonly signal?: AbortSignal;
  }): Promise<SandboxInstance>;
  /** Deletes an artifact. Deleting one that is already gone succeeds. */
  remove(artifact: string): Promise<void>;
}

export interface SandboxWorkspaceEnvironmentOptions {
  readonly driver: WorkspaceSandboxDriver;
  /** Private host directory for bundles read back from sandboxes. */
  readonly stagingDirectory: string;
  /** Bound for git commands run inside a Task sandbox. Default: 10 minutes. */
  readonly gitTimeoutMs?: number;
}

/** A Task's branch and commits, as `start` recorded them for `finalize`. */
interface CheckoutState {
  readonly sandbox: SandboxInstance;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly attemptId: string;
  readonly workspaceDirectory: string;
  readonly mounts: readonly WorkspaceMount[];
  readonly volumes: VolumeResolver | undefined;
  readonly taskId: string;
}

const FULL_COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;
type ProtectedDirectory = readonly [kind: string, path: string];

/** Resolve paths inside the started sandbox, including symlinked existing ancestors. */
async function assertSandboxWorkspaceMountPaths(
  environment: ExecutionEnvironment,
  mounts: readonly WorkspaceMount[],
  checkout: string,
  stagedFiles: readonly string[],
  protectedDirectories: readonly ProtectedDirectory[],
  nativeMountSymlinkTargets: SandboxInstance["nativeMountSymlinkTargets"],
): Promise<void> {
  if (mounts.length === 0) return;
  const canonical = async (path: string, expectedLink = ""): Promise<string> => {
    const script = [
      'probe=$1; suffix=""',
      'if [ -L "$probe" ]; then',
      '  parent=$(dirname "$probe")',
      '  if [ -z "$2" ] || [ "$(readlink "$probe")" != "$2" ] ||',
      '      [ "$(cd -P "$parent" && pwd -P)" != "$parent" ]; then printf "SYMLINK\\n"; exit 0; fi',
      "fi",
      'while [ ! -d "$probe" ]; do',
      '  if [ -L "$probe" ]; then printf "SYMLINK\\n"; exit 0; fi',
      '  suffix="/${probe##*/}$suffix"; probe=${probe%/*}',
      '  if [ -z "$probe" ]; then probe=/; fi',
      "done",
      'cd -P "$probe" || exit 1',
      'printf "PATH:%s%s\\n" "$(pwd -P)" "$suffix"',
    ].join("\n");
    const process = await environment.spawn({
      command: "sh",
      args: ["-c", script, "sh", path, expectedLink],
    });
    const result = await process.wait();
    if (result.exitCode !== 0 || !result.stdout.startsWith("PATH:")) {
      if (result.stdout.startsWith("SYMLINK"))
        throw new Error(`Workspace mount path resolves through a symbolic link: ${path}`);
      throw new Error(`Could not resolve Workspace mount path in sandbox: ${path}`);
    }
    return posix.normalize(result.stdout.slice(5).trim());
  };
  const checked = await Promise.all(
    mounts.map(async (mount) => ({
      ...mount,
      path: await canonical(
        mount.path,
        mount.strategy === "mount" ? nativeMountSymlinkTargets?.[mount.path] : undefined,
      ),
    })),
  );
  assertWorkspaceMountPaths(
    checked,
    await canonical(checkout),
    await Promise.all(stagedFiles.map((path) => canonical(path))),
  );
  const protectedPaths = await Promise.all(
    protectedDirectories.map(async ([kind, path]) => [kind, await canonical(path)] as const),
  );
  for (const mount of checked) {
    if (isSensitiveWorkspaceMountPath(mount.path))
      throw new Error(
        `Workspace mount ${mount.volume} path resolves into a sensitive system location`,
      );
    for (const [kind, path] of protectedPaths)
      if (
        mount.path === path ||
        mount.path.startsWith(`${path}/`) ||
        path.startsWith(`${mount.path}/`)
      )
        throw new VolumeCopyError(
          `Workspace mount ${mount.volume} path ${mount.path} overlaps the ${kind} ${path}`,
        );
  }
}

/** The oldest Node.js the environment MCP bridge runs on: it needs global `fetch`. */
export const WORKSPACE_MCP_NODE_MAJOR = 18;

/**
 * Installs Node.js for the environment MCP bridge when the image lacks `node`: from the image's
 * own Debian or Ubuntu package archive, never from the Task or the Worker Host. On an image
 * without `apt-get` it installs nothing, and the prepare script refuses with the reason.
 */
export const WORKSPACE_MCP_NODE_INSTALL =
  "command -v node >/dev/null 2>&1 || ! command -v apt-get >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*)";

/**
 * A Workspace environment over a remote sandbox provider. One prepared artifact serves every Task
 * with the same digest: the checkout path is fixed, and each Task gets its own copy-on-write
 * sandbox, so setup outputs never carry one Task's writes to another.
 */
export class SandboxWorkspaceEnvironment implements WorkspaceEnvironment {
  readonly provider: string;
  readonly base: string;
  readonly capabilities: WorkspaceEnvironmentCapabilities = {
    // `start` copies mounts after setup and outside any prepared state.
    mounts: { strategies: ["copy"], access: ["read-only", "read-write"] },
    sharedPrepare: true,
    setupOnHost: false,
    declaredCheckouts: false,
    devcontainer: true,
    mcpStdio: "sandbox",
  } as const;
  /**
   * The trusted commit's copy that Workspace stdio MCP servers run from, beside the checkout:
   * `prepare` places it when the definition selects a stdio server, and a Task's edits to its own
   * checkout never change it.
   */
  readonly mcpDirectory: string;
  /** The checkout's path within {@link harnessEnvironment}'s view, rooted at its parent. */
  readonly checkoutPath: string;
  readonly #driver: WorkspaceSandboxDriver;
  readonly #stagingDirectory: string;
  readonly #gitTimeoutMs: number;
  readonly #checkouts = new WeakMap<ExecutionEnvironment, CheckoutState>();
  readonly #views = new WeakMap<ExecutionEnvironment, ExecutionEnvironment>();

  constructor(options: SandboxWorkspaceEnvironmentOptions) {
    this.#driver = options.driver;
    if (options.driver.mounts)
      this.capabilities = {
        ...this.capabilities,
        mounts: {
          strategies: options.driver.mounts.strategies,
          access: options.driver.mounts.access,
        },
      };
    this.provider = options.driver.provider;
    this.base = options.driver.base;
    this.#stagingDirectory = options.stagingDirectory;
    this.#gitTimeoutMs = options.gitTimeoutMs ?? 600_000;
    for (const path of [options.driver.workspaceDirectory, options.driver.transferDirectory]) {
      const normalized = posix.normalize(path);
      if (!posix.isAbsolute(normalized) || normalized === "/" || normalized !== path)
        throw new Error(`Workspace sandbox path ${path} must be absolute, normalized, and not /`);
    }
    // The Harness's view is rooted at the checkout's parent, which must not be the sandbox's /.
    if (posix.dirname(options.driver.workspaceDirectory) === "/")
      throw new Error(
        `Workspace sandbox checkout ${options.driver.workspaceDirectory} must not sit directly under /`,
      );
    this.checkoutPath = posix.basename(options.driver.workspaceDirectory);
    this.mcpDirectory = posix.join(
      posix.dirname(options.driver.workspaceDirectory),
      `.${posix.basename(options.driver.workspaceDirectory)}-supertag-mcp`,
    );
    if (
      [options.driver.workspaceDirectory, options.driver.transferDirectory].some(
        (path) => path === this.mcpDirectory || this.mcpDirectory.startsWith(`${path}/`),
      )
    )
      throw new Error(
        `Workspace sandbox MCP directory ${this.mcpDirectory} must be outside the checkout and transfer directories`,
      );
  }

  /**
   * Remote sandboxes serve Workspaces by source only, from a bundle of the trusted commit. They
   * do not translate `devcontainer.json` yet. Workspace stdio MCP servers run inside the Task's
   * sandbox, so one whose `env` references a host credential is refused, naming the server;
   * HTTP servers stay behind the Worker's policy proxy.
   */
  refuse(definition: WorkspaceDefinition): string | undefined {
    const name = `${this.provider} Workspace environments`;
    if (definition.source.startsWith("file:"))
      return `${name} serve a Workspace by its source URL; source ${definition.source} is a path on the Worker Host`;
    if (definition.content === undefined)
      return `${name} need content, a bundle of the trusted commit built on the Worker Host`;
    const folder = definition.devcontainer?.workspaceFolder;
    if (folder !== undefined) {
      if (!posix.isAbsolute(folder) || posix.normalize(folder) !== folder || folder === "/")
        return `${name} need a normalized absolute devcontainer workspaceFolder`;
      const transfer = this.#driver.transferDirectory;
      if (
        folder === transfer ||
        folder.startsWith(`${transfer}/`) ||
        transfer.startsWith(`${folder}/`)
      )
        return `${name} devcontainer workspaceFolder overlaps the bundle transfer directory`;
      // The Harness view, staged-file guard, and MCP directory all follow the driver's checkout
      // directory, so a different folder could place the checkout where Harness credentials land.
      if (folder !== this.#driver.workspaceDirectory)
        return `${name} check out the repository at ${this.#driver.workspaceDirectory}; devcontainer workspaceFolder ${folder} differs`;
    }
    const driverRefusal = this.#driver.refuse?.(definition);
    if (driverRefusal !== undefined) return driverRefusal;
    const mcp = sandboxMcpRefusal(this.provider, definition.mcp?.servers ?? []);
    if (mcp !== undefined) return mcp;
    for (const command of definition.harness.commands)
      if (!/^[A-Za-z0-9._+-]+$/u.test(command))
        return `${name} check harness commands by name; harness command ${JSON.stringify(command)} is not a plain name`;
    return undefined;
  }

  /**
   * Checks that the content bundle holds exactly the trusted commit, then has the driver build an
   * artifact from it: a cold build from the provider base, or a warm one from `warmFrom`. A warm
   * build that fails is retried cold once.
   */
  async prepare(definition: WorkspaceDefinition, signal?: AbortSignal): Promise<PreparedWorkspace> {
    const refusal = this.refuse(definition);
    if (refusal !== undefined) throw new Error(refusal);
    const content = definition.content as GitObjects;
    const header = await readGitObjectsHeader(content, WORKSPACE_BUNDLE_LIMITS.content);
    if (
      header.prerequisites.length !== 0 ||
      header.refs.length !== 1 ||
      header.refs[0]?.name !== TRUSTED_BUNDLE_REF ||
      header.refs[0].oid !== definition.trustedCommit
    )
      throw new Error(
        `Workspace ${definition.workspace} content must be a bundle of trusted commit ${definition.trustedCommit.slice(0, 12)} alone`,
      );
    const digest = preparedWorkspaceDigest(this, definition);
    const driver = this.#driver;
    const contentPath = posix.join(driver.transferDirectory, "content.bundle");
    const workspaceDirectory =
      definition.devcontainer?.workspaceFolder ?? driver.workspaceDirectory;
    const mcpStdio = definition.mcp?.servers.some((server) => server.transport === "stdio");
    const build = (from: PreparedWorkspace | undefined) =>
      driver.build({
        name: `supertag-${digest.slice(7, 27)}-${randomBytes(4).toString("hex")}`,
        digest,
        ...(from === undefined ? {} : { from: from.artifact }),
        harness: definition.harness,
        ...(mcpStdio
          ? { mcpRuntimeInstall: WORKSPACE_MCP_NODE_INSTALL, mcpDirectory: this.mcpDirectory }
          : {}),
        content,
        trustedCommit: definition.trustedCommit,
        workspaceDirectory,
        ...(definition.devcontainer === undefined ? {} : { devcontainer: definition.devcontainer }),
        ...(definition.trustedRepository === undefined
          ? {}
          : { trustedRepository: definition.trustedRepository }),
        contentPath,
        script: prepareScript({
          workspaceDirectory,
          contentPath,
          trustedCommit: definition.trustedCommit,
          ...(definition.setup === undefined ? {} : { setup: definition.setup }),
          ...(mcpStdio ? { mcpDirectory: this.mcpDirectory } : {}),
          ...(definition.devcontainer === undefined
            ? {}
            : { devcontainer: definition.devcontainer }),
          warm: from !== undefined,
          harnessCommands: definition.harness.commands,
        }),
        ...(signal === undefined ? {} : { signal }),
      });
    const warm = definition.warmFrom?.provider === this.provider ? definition.warmFrom : undefined;
    let artifact: string;
    if (warm === undefined) artifact = await build(undefined);
    else
      artifact = await build(warm).catch(() => {
        signal?.throwIfAborted();
        return build(undefined);
      });
    return {
      digest,
      provider: this.provider,
      artifact,
      trustedCommit: definition.trustedCommit,
      workspaceDirectory,
    };
  }

  /** Source-specific refusal before preparing or creating a sandbox. */
  refuseMount(mount: WorkspaceMount, volume: ResolvedVolume): string | undefined {
    if (mount.strategy !== "mount") return undefined;
    if (mount.access === "read-write" && !this.#driver.mounts?.access.includes("read-write"))
      return `Workspace mount ${mount.volume}: ${this.provider} does not support read-write native attachments`;
    return (
      this.#driver.refuseMount?.(mount, volume) ??
      (this.#driver.refuseMount === undefined
        ? `Workspace mount ${mount.volume}: ${this.provider} does not implement native attachments`
        : undefined)
    );
  }

  /**
   * Creates the Task's sandbox from the artifact with the Task's network policy, places the Task's
   * objects, and checks out exactly `head` on the Task branch. The returned environment is rooted
   * at the checkout; `finalize` needs it before it is disposed.
   */
  async start(
    prepared: PreparedWorkspace,
    task: TaskCheckout,
    signal?: AbortSignal,
  ): Promise<ExecutionEnvironment> {
    assertWorkspaceMountSupport(this, task.mounts ?? []);
    if (prepared.provider !== this.provider)
      throw new Error(
        `Prepared Workspace ${prepared.digest} belongs to ${prepared.provider}, not ${this.provider}`,
      );
    for (const [name, value] of [
      ["base", task.base],
      ["head", task.head],
      ["trusted commit", prepared.trustedCommit],
    ] as const)
      if (!FULL_COMMIT.test(value)) throw new Error(`Task ${name} must be a full commit ID`);
    if (!validBranch(task.branch))
      throw new Error(`Task branch ${JSON.stringify(task.branch)} is not a valid branch name`);
    let objects: Uint8Array | undefined;
    if (task.head !== prepared.trustedCommit) {
      if (task.objects === undefined)
        throw new Error(
          `Task head ${task.head.slice(0, 12)} is not the prepared trusted commit, so start needs its objects`,
        );
      objects = await readGitObjects(task.objects, WORKSPACE_BUNDLE_LIMITS.checkout);
      const header = parseGitBundleHeader(objects);
      if (
        header.refs.length !== 1 ||
        header.refs[0]?.name !== CHECKOUT_BUNDLE_REF ||
        header.refs[0].oid !== task.head ||
        header.prerequisites.some((oid) => oid !== prepared.trustedCommit)
      )
        throw new Error(
          `Task objects must reach head ${task.head.slice(0, 12)} from trusted commit ${prepared.trustedCommit.slice(0, 12)} alone`,
        );
    }
    const driver = this.#driver;
    const workspaceDirectory = prepared.workspaceDirectory ?? driver.workspaceDirectory;
    if (
      !posix.isAbsolute(workspaceDirectory) ||
      posix.normalize(workspaceDirectory) !== workspaceDirectory ||
      workspaceDirectory === "/"
    )
      throw new Error(
        `Prepared Workspace has invalid checkout directory ${JSON.stringify(workspaceDirectory)}`,
      );
    const staged = [
      ...task.plan.files.map((file) => file.path),
      ...task.plan.mounts.map((mount) => mount.destination),
      ...task.plan.secretBindings.map((binding) => binding.target),
    ].map((path) => posix.resolve(posix.dirname(workspaceDirectory), path));
    assertWorkspaceMountPaths(task.mounts ?? [], workspaceDirectory, staged);
    for (const mount of task.mounts ?? [])
      for (const [kind, path] of [
        ["bundle transfer directory", driver.transferDirectory],
        ["trusted MCP copy", this.mcpDirectory],
      ] as const)
        if (
          mount.path === path ||
          mount.path.startsWith(`${path}/`) ||
          path.startsWith(`${mount.path}/`)
        )
          throw new VolumeCopyError(
            `Workspace mount ${mount.volume} path ${mount.path} overlaps the ${kind} ${path}`,
          );
    const nativeMounts: { mount: WorkspaceMount; volume: ResolvedVolume }[] = [];
    for (const mount of task.mounts ?? []) {
      if (mount.strategy !== "mount") continue;
      if (task.volumes?.resolveMount === undefined)
        throw new VolumeCopyError(
          `Workspace mount ${mount.volume}: this Worker Host has no native mount source guard`,
        );
      const volume = await task.volumes.resolveMount(
        mount.volume,
        { taskId: task.taskId, attemptId: task.attemptId },
        signal,
      );
      if (volume.volume !== mount.volume)
        throw new VolumeCopyError(
          `Workspace mount ${mount.volume}: host resolved a different Volume`,
        );
      const refusal = this.refuseMount(mount, volume);
      if (refusal !== undefined) throw new VolumeCopyError(refusal);
      nativeMounts.push({ mount, volume });
    }
    // Before any provider call: resolve every Volume and its credential on this Worker Host, and
    // list each one within its limits, so a refusal names the Volume and no sandbox exists yet.
    const copies = await planWorkspaceMounts({
      mounts: (task.mounts ?? []).filter((mount) => mount.strategy === "copy"),
      volumes: task.volumes,
      task: { taskId: task.taskId, attemptId: task.attemptId },
      protectedDirectories: [this.#stagingDirectory],
      ...(signal === undefined ? {} : { signal }),
    });
    let sandbox: SandboxInstance;
    try {
      sandbox = await driver.create({
        ...(nativeMounts.length === 0 ? {} : { nativeMounts }),
        artifact: prepared.artifact,
        taskId: task.taskId,
        attemptId: task.attemptId,
        network: task.plan.network,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      copies.close();
      throw error;
    }
    const attachedAt = new Date().toISOString();
    try {
      const liveMounts: LiveMount[] = nativeMounts.map(({ mount, volume }) => {
        const location = parseVolumeSource(volume.source);
        return {
          volume: mount.volume,
          source: volume.source,
          prefix: location.scheme === "file" ? "" : location.prefix,
          path: mount.path,
          strategy: "mount",
          access: mount.access,
          attachedAt,
        };
      });
      signal?.throwIfAborted();
      const objectsPath = posix.join(driver.transferDirectory, "objects.bundle");
      if (objects !== undefined) {
        await sandbox.mkdir(driver.transferDirectory);
        await sandbox.write(objectsPath, objects, { exclusive: true, mode: 0o600 });
      }
      await this.#git(sandbox, workspaceDirectory, CHECKOUT_SCRIPT, {
        SUPERTAG_WORKSPACE: workspaceDirectory,
        SUPERTAG_OBJECTS: objects === undefined ? "" : objectsPath,
        SUPERTAG_BRANCH: task.branch,
        SUPERTAG_BASE: task.base,
        SUPERTAG_HEAD: task.head,
      });
      // After setup, which ran in the prepared artifact, and after the checkout: the copies live
      // only in this Task Attempt's sandbox, and the Worker Host delivers the bytes.
      const mountManifests = await copies.copy(new SandboxVolumeCopyTarget(sandbox), signal);
      const environment = new SandboxWorkspaceCheckout(
        sandboxExecutionEnvironment(sandbox, workspaceDirectory, {
          id: this.provider,
          backend: { ...driver.backend, create: () => Promise.reject(new Error("unused")) },
        }),
        sandbox,
        { provider: this.provider, digest: prepared.digest, branch: task.branch },
        mountManifests,
        liveMounts,
      );
      await assertSandboxWorkspaceMountPaths(
        environment,
        task.mounts ?? [],
        workspaceDirectory,
        staged,
        [
          ["bundle transfer directory", driver.transferDirectory],
          ["trusted MCP copy", this.mcpDirectory],
        ],
        sandbox.nativeMountSymlinkTargets,
      );
      this.#checkouts.set(environment, {
        sandbox,
        branch: task.branch,
        base: task.base,
        head: task.head,
        attemptId: task.attemptId,
        workspaceDirectory,
        mounts: task.mounts ?? [],
        volumes: task.volumes,
        taskId: task.taskId,
      });
      return environment;
    } catch (error) {
      await terminateSandbox(sandbox).catch(() => undefined);
      throw error;
    } finally {
      copies.close();
    }
  }

  /**
   * The Harness's view of a checkout `start` returned: the same sandbox, rooted at the checkout's
   * parent, with the checkout at {@link checkoutPath}. A Harness stages its credentials, session
   * state, Skills, inputs, and outputs at that root, beside the checkout, so `finalize`, which
   * commits everything git does not ignore in the checkout, never commits or delivers them. The
   * view refuses a plan that stages into the checkout. Disposing it disposes the checkout.
   */
  harnessEnvironment(started: ExecutionEnvironment): ExecutionEnvironment {
    const existing = this.#views.get(started);
    if (existing !== undefined) return existing;
    const state = this.#checkouts.get(started);
    if (state === undefined)
      throw new Error(
        `${this.provider} Workspace harness environment needs the environment its start returned`,
      );
    const driver = this.#driver;
    const view = new SandboxWorkspaceRuntime(
      sandboxExecutionEnvironment(state.sandbox, posix.dirname(driver.workspaceDirectory), {
        id: this.provider,
        backend: { ...driver.backend, create: () => Promise.reject(new Error("unused")) },
      }),
      started,
      driver.workspaceDirectory,
      state.mounts,
      [
        ["bundle transfer directory", driver.transferDirectory],
        ["trusted MCP copy", this.mcpDirectory],
      ],
      state.sandbox.nativeMountSymlinkTargets,
    );
    this.#views.set(started, view);
    return view;
  }

  /**
   * Commits what the Task Attempt left inside the sandbox, without hooks or signing, and returns
   * the commits from the Task's base as a bundle when the head moved. The bundle is read with the
   * returned-bundle bound, checked for its one ref, and written to a private host file; the host
   * imports it with delivery. Does not dispose the environment.
   */
  async finalize(
    environment: ExecutionEnvironment,
    commit: WorkspaceCommit,
  ): Promise<FinalizedWork> {
    const state = this.#checkouts.get(environment);
    if (state === undefined)
      throw new Error(
        `${this.provider} Workspace finalize needs the environment its start returned`,
      );
    const driver = this.#driver;
    const bundlePath = posix.join(
      driver.transferDirectory,
      `returned-${randomBytes(8).toString("hex")}.bundle`,
    );
    const output = await this.#git(state.sandbox, state.workspaceDirectory, FINALIZE_SCRIPT, {
      SUPERTAG_WORKSPACE: state.workspaceDirectory,
      SUPERTAG_TRANSFER: driver.transferDirectory,
      SUPERTAG_RETURNED: bundlePath,
      SUPERTAG_BRANCH: state.branch,
      SUPERTAG_BASE: state.base,
      SUPERTAG_START_HEAD: state.head,
      SUPERTAG_AUTHOR_NAME: commit.author.name,
      SUPERTAG_AUTHOR_EMAIL: commit.author.email,
      SUPERTAG_MESSAGE: commit.message,
    });
    const result =
      /^committed=([01])\nhead=([0-9a-f]{40}(?:[0-9a-f]{24})?)\nbundle=([01])\n?$/u.exec(output);
    if (!result)
      throw new Error(`${this.provider} Workspace finalize returned an unexpected result`);
    const committed = result[1] === "1";
    const head = result[2] as string;
    const outputs: MountOutputManifest[] = [];
    const copied = (environment as SandboxWorkspaceCheckout).mountManifests;
    for (const mount of state.mounts) {
      if (mount.strategy !== "copy" || mount.access !== "read-write") continue;
      const input = copied.find((entry) => entry.path === mount.path);
      if (!input || !state.volumes)
        throw new Error(`Volume ${mount.volume} has no input copy manifest`);
      const volume = await state.volumes.resolve(mount.volume, {
        taskId: state.taskId,
        attemptId: state.attemptId,
      });
      outputs.push(
        await uploadWorkspaceMount({
          mount,
          input,
          volume,
          files: () => listSandboxMountUploadFiles(state.sandbox, mount.path),
        }),
      );
      if (outputs.at(-1)?.status !== "complete") break;
    }
    if (head === state.head) {
      if (committed)
        throw new Error(`${this.provider} Workspace finalize committed without a new head`);
      return { head, committed, mountOutputManifests: outputs };
    }
    if (result[3] !== "1")
      throw new Error(
        `${this.provider} Workspace finalize moved the head without returning a bundle`,
      );
    const bytes = await state.sandbox.read(bundlePath, {
      maximumBytes: WORKSPACE_BUNDLE_LIMITS.returned,
      rejectSymlinks: true,
    });
    checkReturnedBundle(bytes, { branch: state.branch, head });
    const objects = await writeReturnedBundle(this.#stagingDirectory, bytes);
    return { head, committed, objects, mountOutputManifests: outputs };
  }

  /** Deletes the artifact from the provider. The host cache removes its record. */
  async evict(prepared: PreparedWorkspace): Promise<void> {
    if (prepared.provider !== this.provider)
      throw new Error(
        `Prepared Workspace ${prepared.digest} belongs to ${prepared.provider}, not ${this.provider}`,
      );
    await this.#driver.remove(prepared.artifact);
  }

  /** Runs a git script inside the sandbox and returns its standard output. */
  async #git(
    sandbox: SandboxInstance,
    workspaceDirectory: string,
    script: string,
    environment: Readonly<Record<string, string>>,
  ): Promise<string> {
    let stdout = "";
    let stderr = "";
    const process = await sandbox.start(
      {
        command: "sh",
        args: ["-c", script],
        cwd: workspaceDirectory,
        environment: { ...environment, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        timeoutMs: this.#gitTimeoutMs,
      },
      {
        onOutput(chunk) {
          if (chunk.stream === "stdout") stdout = (stdout + chunk.text).slice(-8192);
          else stderr = (stderr + chunk.text).slice(-4000);
        },
      },
    );
    const result = await process.wait();
    if (result.exitCode !== 0)
      throw new Error(
        `${this.provider} Workspace git failed (exit ${result.exitCode}): ${(stderr || result.stderr).trim().slice(-1000)}`,
      );
    return stdout || result.stdout;
  }
}

/**
 * A Task's checkout inside its sandbox. It is the sandbox's execution environment rooted at the
 * checkout; staging a plan file replaces any file already at that path, as in a local worktree.
 */
class SandboxWorkspaceCheckout implements ExecutionEnvironment {
  readonly id: string;
  readonly placement = "remote" as const;
  readonly rootDirectory: string;
  readonly provenance;
  readonly guarantees?: NonNullable<ExecutionEnvironment["guarantees"]>;
  readonly readBytes?: NonNullable<ExecutionEnvironment["readBytes"]>;
  readonly listOutputFiles?: NonNullable<ExecutionEnvironment["listOutputFiles"]>;
  readonly prepareOutputDirectory?: NonNullable<ExecutionEnvironment["prepareOutputDirectory"]>;
  readonly materializeArtifactFiles?: NonNullable<ExecutionEnvironment["materializeArtifactFiles"]>;
  readonly connect?: NonNullable<ExecutionEnvironment["connect"]>;

  constructor(
    readonly inner: ExecutionEnvironment,
    readonly sandbox: SandboxInstance,
    workspace: { readonly provider: string; readonly digest: string; readonly branch: string },
    /** What `start` copied for this Attempt's mounts. */
    readonly mountManifests: readonly MountManifest[] = [],
    /** Live sources the provider attached successfully at start. */
    readonly liveMounts: readonly LiveMount[] = [],
  ) {
    this.id = inner.id;
    this.rootDirectory = inner.rootDirectory;
    this.provenance = { ...(inner.provenance ?? {}), ...workspace };
    if (inner.guarantees) this.guarantees = inner.guarantees;
    if (inner.readBytes) this.readBytes = inner.readBytes.bind(inner);
    if (inner.listOutputFiles) this.listOutputFiles = inner.listOutputFiles.bind(inner);
    if (inner.prepareOutputDirectory)
      this.prepareOutputDirectory = inner.prepareOutputDirectory.bind(inner);
    if (inner.materializeArtifactFiles)
      this.materializeArtifactFiles = inner.materializeArtifactFiles.bind(inner);
    if (inner.connect) this.connect = inner.connect.bind(inner);
  }

  async prepare(plan: EnvironmentPlan): Promise<void> {
    const paths = plan.files.map((file) => this.inner.resolvePath(file.path));
    if (paths.length > 0) {
      // Removing a symbolic link removes the link, never its target.
      const process = await this.inner.spawn({
        command: "sh",
        args: ["-c", 'for path; do rm -f -- "$path"; done', "sh", ...paths],
      });
      if ((await process.wait()).exitCode !== 0)
        throw new Error("Could not replace staged files in the Workspace checkout");
    }
    await this.inner.prepare(plan);
  }

  resolvePath(path: string): string {
    return this.inner.resolvePath(path);
  }

  read(path: string): Promise<string> {
    return this.inner.read(path);
  }

  spawn(process: ProcessSpec, signal?: AbortSignal): Promise<ProcessHandle> {
    return this.inner.spawn(process, signal);
  }

  dispose(reason: "completed" | "failed" | "cancelled"): Promise<void> {
    return this.inner.dispose(reason);
  }
}

/**
 * A Harness's view of a Task's sandbox, rooted at the checkout's parent. Staging into the checkout
 * is refused, so nothing a Harness places reaches a commit; the Task's own edits go through its
 * processes, which start in the checkout when their working directory names it.
 */
class SandboxWorkspaceRuntime implements ExecutionEnvironment {
  readonly id: string;
  readonly placement = "remote" as const;
  readonly rootDirectory: string;
  readonly provenance;
  readonly guarantees?: NonNullable<ExecutionEnvironment["guarantees"]>;
  readonly readBytes?: NonNullable<ExecutionEnvironment["readBytes"]>;
  readonly listOutputFiles?: NonNullable<ExecutionEnvironment["listOutputFiles"]>;
  readonly prepareOutputDirectory?: NonNullable<ExecutionEnvironment["prepareOutputDirectory"]>;
  readonly materializeArtifactFiles?: NonNullable<ExecutionEnvironment["materializeArtifactFiles"]>;
  readonly connect?: NonNullable<ExecutionEnvironment["connect"]>;

  constructor(
    readonly inner: ExecutionEnvironment,
    readonly checkout: ExecutionEnvironment,
    readonly checkoutDirectory: string,
    readonly workspaceMounts: readonly WorkspaceMount[],
    readonly protectedDirectories: readonly ProtectedDirectory[],
    readonly nativeMountSymlinkTargets: SandboxInstance["nativeMountSymlinkTargets"],
  ) {
    this.id = inner.id;
    this.rootDirectory = inner.rootDirectory;
    this.provenance = { ...(checkout.provenance ?? {}) };
    if (inner.guarantees) this.guarantees = inner.guarantees;
    if (inner.readBytes) this.readBytes = inner.readBytes.bind(inner);
    if (inner.listOutputFiles) this.listOutputFiles = inner.listOutputFiles.bind(inner);
    if (inner.prepareOutputDirectory) {
      const prepare = inner.prepareOutputDirectory.bind(inner);
      this.prepareOutputDirectory = async (path) => {
        this.#outsideCheckout(path, "output directory");
        await prepare(path);
      };
    }
    if (inner.materializeArtifactFiles) {
      const materialize = inner.materializeArtifactFiles.bind(inner);
      this.materializeArtifactFiles = async (input) => {
        this.#outsideCheckout(input.directory, "artifact directory");
        return materialize(input);
      };
    }
    if (inner.connect) this.connect = inner.connect.bind(inner);
  }

  /** Refuses a staged path at or inside the checkout, which `finalize` would commit. */
  #outsideCheckout(path: string, kind: string): void {
    const resolved = this.inner.resolvePath(path);
    if (resolved === this.checkoutDirectory || resolved.startsWith(`${this.checkoutDirectory}/`))
      throw new Error(
        `A Harness ${kind} must stay outside the Workspace checkout, which finalize commits: ${path}`,
      );
  }

  async prepare(plan: EnvironmentPlan): Promise<void> {
    const staged = [
      ...plan.files.map((file) => this.inner.resolvePath(file.path)),
      ...plan.mounts.map((mount) => this.inner.resolvePath(mount.destination)),
      ...plan.secretBindings.map((binding) => this.inner.resolvePath(binding.target)),
    ];
    assertWorkspaceMountPaths(this.workspaceMounts, this.checkoutDirectory, staged);
    await assertSandboxWorkspaceMountPaths(
      this.inner,
      this.workspaceMounts,
      this.checkoutDirectory,
      staged,
      this.protectedDirectories,
      this.nativeMountSymlinkTargets,
    );
    for (const file of plan.files) this.#outsideCheckout(file.path, "staged file");
    for (const mount of plan.mounts) this.#outsideCheckout(mount.destination, "mount");
    const paths = plan.files.map((file) => this.inner.resolvePath(file.path));
    if (paths.length > 0) {
      // Restaging replaces a file at the path; removing a symbolic link never touches its target.
      const process = await this.inner.spawn({
        command: "sh",
        args: ["-c", 'for path; do rm -f -- "$path"; done', "sh", ...paths],
      });
      if ((await process.wait()).exitCode !== 0)
        throw new Error("Could not replace staged files beside the Workspace checkout");
    }
    await this.inner.prepare(plan);
  }

  resolvePath(path: string): string {
    return this.inner.resolvePath(path);
  }

  read(path: string): Promise<string> {
    return this.inner.read(path);
  }

  spawn(process: ProcessSpec, signal?: AbortSignal): Promise<ProcessHandle> {
    return this.inner.spawn(process, signal);
  }

  dispose(reason: "completed" | "failed" | "cancelled"): Promise<void> {
    return this.checkout.dispose(reason);
  }
}

/** Branch names a Task may carry: git-valid, no option or revision syntax. */
function validBranch(branch: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/u.test(branch) &&
    !branch.startsWith("-") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock") &&
    !branch.endsWith(".") &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.split("/").some((part) => part.startsWith("."))
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Git inside a sandbox: no hooks, no filesystem monitor, no automatic gc, no signing. */
const SANDBOX_GIT =
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c gc.auto=0 -c commit.gpgsign=false -c protocol.allow=never -c protocol.file.allow=always "$@"; }';

/**
 * The script a build runs, with network, on trusted content only: fetch the shallow bundle of the
 * trusted commit, check it out, place the copy Workspace stdio MCP servers run from when
 * `mcpDirectory` is set, remove the bundle, run `setup` with a private TMPDIR, and check that the
 * harness commands exist and, with `mcpDirectory`, that Node.js runs the environment MCP bridge.
 * A warm build starts from an artifact whose checkout already exists; the forced checkout keeps
 * its ignored setup outputs, and the MCP copy is placed afresh.
 */
export function prepareScript(input: {
  readonly workspaceDirectory: string;
  readonly contentPath: string;
  readonly trustedCommit: string;
  readonly setup?: string;
  readonly mcpDirectory?: string;
  readonly devcontainer?: DevcontainerSubset;
  readonly warm?: boolean;
  readonly harnessCommands: readonly string[];
}): string {
  return [
    "set -eu",
    SANDBOX_GIT,
    `dir=${shellQuote(input.workspaceDirectory)}`,
    `bundle=${shellQuote(input.contentPath)}`,
    `trusted=${shellQuote(input.trustedCommit)}`,
    'mkdir -p "$dir"',
    'cd "$dir"',
    "if [ ! -d .git ]; then g init -q; fi",
    "printf '%s\\n' \"$trusted\" >> .git/shallow",
    `g -c fetch.fsckObjects=true fetch -q --no-tags --no-write-fetch-head "$bundle" "+${TRUSTED_BUNDLE_REF}:${TRUSTED_BUNDLE_REF}"`,
    `test "$(g rev-parse --verify '${TRUSTED_BUNDLE_REF}^{commit}')" = "$trusted"`,
    'g checkout -q --force --detach "$trusted"',
    ...(input.mcpDirectory === undefined
      ? []
      : [
          `mcp=${shellQuote(input.mcpDirectory)}`,
          // Emptied, not removed: under a devcontainer user, only the directory itself is theirs.
          'mkdir -p "$mcp"',
          'find "$mcp" -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
          "g worktree prune",
          'g worktree add -q --detach "$mcp" "$trusted"',
        ]),
    'rm -f "$bundle"',
    ...devcontainerCommands(input.devcontainer, input.warm ?? false, input.workspaceDirectory),
    ...(input.setup === undefined
      ? []
      : [
          `setup=${shellQuote(input.setup)}`,
          'tmp="$(mktemp -d)"',
          'TMPDIR="$tmp" TMP="$tmp" TEMP="$tmp" sh -c "$setup"',
          'rm -rf "$tmp"',
        ]),
    ...input.harnessCommands.map(
      (command) =>
        `command -v ${shellQuote(command)} >/dev/null 2>&1 || { echo ${shellQuote(`harness command ${command} is not installed`)} >&2; exit 1; }`,
    ),
    ...(input.mcpDirectory === undefined
      ? []
      : [
          `node -e ${shellQuote(`process.exit(Number(process.versions.node.split(".")[0]) >= ${WORKSPACE_MCP_NODE_MAJOR} ? 0 : 1)`)} >/dev/null 2>&1 || { echo ${shellQuote(`Workspace stdio MCP servers need Node.js ${WORKSPACE_MCP_NODE_MAJOR} or later in the sandbox for the environment MCP bridge, and the prepared image has none. Preparation installs it only on images with apt-get; install it in the image or in setup, or serve the server over HTTP`)} >&2; exit 1; }`,
        ]),
    "",
  ].join("\n");
}

/** Lifecycle commands execute only in the provider build or setup sandbox. */
export function devcontainerCommands(
  devcontainer:
    | Pick<
        DevcontainerSubset,
        | "onCreateCommand"
        | "updateContentCommand"
        | "postCreateCommand"
        | "containerEnv"
        | "remoteEnv"
      >
    | undefined,
  warm: boolean,
  workspaceFolder: string,
): string[] {
  if (devcontainer === undefined) return [];
  const out: string[] = [];
  const env = resolvedDevcontainerEnv(devcontainer, workspaceFolder);
  for (const [name, value] of Object.entries(env)) out.push(`export ${name}=${shellQuote(value)}`);
  const add = (value: DevcontainerCommand | undefined) => {
    if (value === undefined) return;
    const commands =
      typeof value === "string" || Array.isArray(value) ? [value] : Object.values(value);
    for (const entry of commands) {
      if (typeof entry === "string") out.push(`sh -c ${shellQuote(entry)}`);
      else out.push(entry.map(shellQuote).join(" "));
    }
  };
  if (!warm) add(devcontainer.onCreateCommand);
  add(devcontainer.updateContentCommand);
  if (!warm) add(devcontainer.postCreateCommand);
  return out;
}

/** Fetches the Task's objects, then checks out exactly `head` on the Task branch. */
const CHECKOUT_SCRIPT = [
  "set -eu",
  SANDBOX_GIT,
  'cd "$SUPERTAG_WORKSPACE"',
  'if [ -n "$SUPERTAG_OBJECTS" ]; then',
  `  g -c fetch.fsckObjects=true fetch -q --no-tags --no-write-fetch-head "$SUPERTAG_OBJECTS" "+${CHECKOUT_BUNDLE_REF}:${CHECKOUT_BUNDLE_REF}"`,
  '  rm -f "$SUPERTAG_OBJECTS"',
  "fi",
  'test "$(g rev-parse --verify "$SUPERTAG_HEAD^{commit}")" = "$SUPERTAG_HEAD"',
  'g merge-base --is-ancestor "$SUPERTAG_BASE" "$SUPERTAG_HEAD"',
  'g checkout -q --force -B "$SUPERTAG_BRANCH" "$SUPERTAG_HEAD"',
  "",
].join("\n");

/**
 * Commits every change {@link COMMIT_STAGING} stages, then bundles `base..HEAD` under the Task branch when
 * the head moved. Prints `committed`, `head`, and `bundle` lines.
 */
const FINALIZE_SCRIPT = [
  "set -eu",
  SANDBOX_GIT,
  'cd "$SUPERTAG_WORKSPACE"',
  "committed=0",
  'if [ -n "$(g status --porcelain --untracked-files=all)" ]; then',
  ...COMMIT_STAGING.map((args) => `  g ${args.map(shellQuote).join(" ")}`),
  "  if ! g diff --cached --quiet --no-ext-diff; then",
  '    g -c user.name="$SUPERTAG_AUTHOR_NAME" -c user.email="$SUPERTAG_AUTHOR_EMAIL" commit --no-verify -q -m "$SUPERTAG_MESSAGE"',
  "    committed=1",
  "  fi",
  "fi",
  'head="$(g rev-parse --verify HEAD^{commit})"',
  "bundle=0",
  'if [ "$head" != "$SUPERTAG_START_HEAD" ]; then',
  '  g update-ref "refs/heads/$SUPERTAG_BRANCH" "$head"',
  '  mkdir -p "$SUPERTAG_TRANSFER"',
  '  g bundle create -q "$SUPERTAG_RETURNED" "refs/heads/$SUPERTAG_BRANCH" "^$SUPERTAG_BASE" >/dev/null 2>&1',
  "  bundle=1",
  "fi",
  'printf \'committed=%s\\nhead=%s\\nbundle=%s\\n\' "$committed" "$head" "$bundle"',
  "",
].join("\n");
