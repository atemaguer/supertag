import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MountManifest } from "../packages/core/src/index.js";
import { E2BWorkspaceEnvironment } from "../packages/runtime/environments/e2b/src/index.ts";
import { ModalWorkspaceEnvironment } from "../packages/runtime/environments/modal/src/index.ts";
import {
  assertConformance,
  runWorkspaceEnvironmentConformance,
  type WorkspaceEnvironmentConformanceRepository,
} from "../packages/runtime/sdk/src/conformance.js";
import {
  bundleTaskObjects,
  bundleTrustedCommit,
  checkReturnedBundle,
  type EnvironmentPlan,
  type ExecutionEnvironment,
  PreparedWorkspaceCache,
  parseGitBundleHeader,
  type SandboxWorkspaceEnvironment,
  type VolumeResolver,
  WORKSPACE_BUNDLE_LIMITS,
  type WorkspaceDefinition,
  type WorkspaceEnvironment,
} from "../packages/runtime/sdk/src/index.js";
import { WORKSPACE_MCP_NODE_INSTALL } from "../packages/runtime/sdk/src/sandbox-workspace-environment.ts";
import { FakeS3 } from "./support/fake-s3.ts";
import {
  FAKE_TRANSFER,
  FAKE_WORKSPACE,
  FakeSandboxWorld,
} from "./support/fake-workspace-sandboxes.ts";

// Host file:// fixtures use temporary directories; production sources refuse Task-writable roots.
vi.mock("../packages/runtime/sdk/src/task-writable-roots.js", () => ({
  taskWritableRoots: () => [],
}));

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "SuperTag",
  GIT_AUTHOR_EMAIL: "supertag@localhost",
  GIT_COMMITTER_NAME: "SuperTag",
  GIT_COMMITTER_EMAIL: "supertag@localhost",
};
/** A small executable named node. Copying the real binary (over 100 MB) twice per test timed out under load. */
async function fakeNode(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\necho v22.13.0\n");
  await chmod(path, 0o755);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { env: GIT_ENV, encoding: "utf8" },
  );
  return stdout.trim();
}

type Provider = "e2b" | "modal";

function environmentFor(
  provider: Provider,
  world: FakeSandboxWorld,
  stagingDirectory: string,
): SandboxWorkspaceEnvironment {
  const paths = { workspaceDirectory: FAKE_WORKSPACE, transferDirectory: FAKE_TRANSFER };
  return provider === "e2b"
    ? new E2BWorkspaceEnvironment({ stagingDirectory, ...paths, ...world.e2b() })
    : new ModalWorkspaceEnvironment({
        appName: "supertag-test",
        stagingDirectory,
        ...paths,
        ...world.modal(),
      });
}

const PLAN: EnvironmentPlan = {
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "none" },
};
const SOURCE = "https://example.com/conformance.git";
/** Resolves every Volume to one `file://` directory on the host. */
function fileVolumes(directory: string): VolumeResolver {
  return { resolve: async (volume) => ({ volume, source: pathToFileURL(directory).href }) };
}

/** Where the suite's copy mounts land in a fake sandbox, beside the checkout. */
const FAKE_MOUNT = "/workspace/data";

/** The host file behind a path under {@link FAKE_MOUNT} in a started fake sandbox. */
function fakeMountPath(
  world: FakeSandboxWorld,
  task: { readonly provenance?: Record<string, unknown> },
  relative: string,
): string {
  const sandbox = task.provenance?.["sandboxId"];
  if (typeof sandbox !== "string") throw new Error("The started Task has no fake sandbox ID");
  return join(world.directory, sandbox, FAKE_MOUNT, relative);
}

/** Imports a returned bundle into the host repository's Task branch, as delivery would. */
async function importReturned(repository: string, branch: string, bundle: string): Promise<void> {
  await git(repository, "bundle", "verify", "-q", bundle);
  await git(
    repository,
    "-c",
    "fetch.fsckObjects=true",
    "fetch",
    "-q",
    "--no-tags",
    bundle,
    `+refs/heads/${branch}:refs/heads/${branch}`,
  );
}

describe.each<Provider>(["e2b", "modal"])("%s Workspace environment", (provider) => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup() {
    const world = await FakeSandboxWorld.create(
      provider === "modal" ? { image: "python:3.13-slim" } : {},
    );
    const scratch = await mkdtemp(join(tmpdir(), "supertag-sandbox-workspace-"));
    cleanups.push(
      () => world.cleanup(),
      () => rm(scratch, { recursive: true, force: true }),
    );
    const environment = environmentFor(provider, world, join(scratch, "returned"));
    return { world, scratch, environment };
  }

  const conformance = (
    world: FakeSandboxWorld,
    scratch: string,
    environment: WorkspaceEnvironment,
    onRepository: (repository: WorkspaceEnvironmentConformanceRepository) => void = () => {},
  ) =>
    runWorkspaceEnvironmentConformance(async (built) => {
      onRepository(built);
      const bundles = join(scratch, "bundles");
      return {
        environment,
        async define({ taskId, trustedCommit, setup }) {
          return {
            workspace: built.workspace,
            source: SOURCE,
            trustedCommit,
            content: await bundleTrustedCommit({
              repository: built.path,
              trustedCommit,
              directory: bundles,
            }),
            ...(setup === undefined ? {} : { setup }),
            harness: { commands: ["sh"] },
            taskId,
          };
        },
        objects: ({ trustedCommit, head }) =>
          bundleTaskObjects({ repository: built.path, trustedCommit, head, directory: bundles }),
        async deliver(branch, finalized) {
          if (finalized.objects) await importReturned(built.path, branch, finalized.objects.bundle);
        },
        providerCalls: () => world.calls.length,
        refusals: [
          {
            name: "a host path source",
            definition: (supported) => ({ ...supported, source: "file:///srv/app" }),
            property: "source",
          },
          {
            name: "a definition without content",
            definition: ({ content: _content, ...supported }) => supported,
            property: "content",
          },
          {
            name: "a relative devcontainer workspaceFolder",
            definition: (supported) => ({
              ...supported,
              devcontainer: { image: "node:22", workspaceFolder: "repo" },
            }),
            property: "devcontainer",
          },
          {
            name: "a devcontainer workspaceFolder where Harness credentials are staged",
            definition: (supported) => ({
              ...supported,
              devcontainer: { image: "node:22", workspaceFolder: "/workspace/.codex" },
            }),
            property: "devcontainer",
          },
          {
            name: "a stdio MCP server with a host credential",
            definition: (supported) => ({
              ...supported,
              mcp: {
                digest: `sha256:${"0".repeat(64)}`,
                servers: [
                  {
                    name: "db",
                    transport: "stdio",
                    command: "node",
                    args: ["db.js"],
                    env: { DB_TOKEN: "SUPERTAG_MCP_DB_TOKEN" },
                  },
                ],
              },
            }),
            property: "Workspace MCP server db",
          },
        ],
        network: {
          setup:
            'if [ "$SUPERTAG_FAKE_NETWORK" = reachable ]; then echo reachable > network.txt; fi',
          reachable: (task) => FakeSandboxWorld.reachable(task),
        },
        copyMount: {
          path: FAKE_MOUNT,
          read: (task, relative) =>
            readFile(fakeMountPath(world, task, relative), "utf8").catch(() => undefined),
          writable: async (task, relative) =>
            ((await stat(fakeMountPath(world, task, relative))).mode & 0o222) !== 0,
          exists: (task, relative) =>
            lstat(fakeMountPath(world, task, relative)).then(
              () => true,
              () => false,
            ),
        },
      };
    });

  it("passes the Workspace environment conformance suite against its fake", async () => {
    const { world, scratch, environment } = await setup();
    let repository: WorkspaceEnvironmentConformanceRepository | undefined;
    const report = await conformance(world, scratch, environment, (built) => {
      repository = built;
    });
    // On Modal the fake image is python:3.13-slim, which has no Node.js until preparation's
    // trusted install layer adds it; without that layer, workspace.mcp.run fails with exit 127.
    assertConformance(report);
    expect(report.passed).toBe(true);
    if (provider === "modal")
      expect(
        world.calls.some(
          (call) =>
            call.kind === "modal.image.build" &&
            (call.detail as { commands: string[] }).commands.includes(
              `RUN ${JSON.stringify(["/bin/sh", "-c", WORKSPACE_MCP_NODE_INSTALL])}`,
            ),
        ),
      ).toBe(true);
    // Installing Node.js inside a 128 MiB sandbox is SIGKILLed (exit 137) while dpkg unpacks
    // libnode, so the install belongs to the image build and never to a sandbox command.
    if (provider === "modal")
      expect(
        JSON.stringify(world.calls.filter((call) => call.kind === "modal.sandbox.exec")),
      ).not.toContain("nodejs");
    expect(repository).toBeDefined();
  }, 120_000);

  it("maps staged files beside the checkout and uses only image runtimes", async () => {
    if (provider !== "modal") return;
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const definition: WorkspaceDefinition = {
      ...(await defineFor(repository, scratch)),
      mcp: {
        digest: `sha256:${"c".repeat(64)}`,
        servers: [
          {
            name: "conformance",
            transport: "stdio",
            command: "node",
            args: ["mcp-server.js"],
            env: {},
          },
        ],
      },
    };
    const prepared = await environment.prepare(definition);
    const task = await environment.start(prepared, {
      taskId: "image-layout",
      attemptId: "image-layout",
      branch: "supertag/test/image-layout",
      base: repository.trusted,
      head: repository.trusted,
      plan: PLAN,
    });
    try {
      const harness = environment.harnessEnvironment(task);
      await harness.prepare({
        ...PLAN,
        files: [{ path: "staged.txt", content: "staged beside checkout\n" }],
      });
      expect(await harness.read("staged.txt")).toBe("staged beside checkout\n");
      const probe = await task.spawn({
        command: "sh",
        args: [
          "-c",
          "command -v python3 && command -v apt-get && node --version && test -d /workspace/repo && test -d /workspace/.repo-supertag-mcp && test -f /workspace/staged.txt && test ! -e /workspace/repo/staged.txt",
        ],
      });
      expect((await probe.wait()).exitCode).toBe(0);
      // Node.js comes from preparation's trusted install layer, never from the host's PATH.
      const hostPathProbe = await task.spawn({
        command: "sh",
        args: ["-c", "command -v node"],
        environment: { PATH: process.env["PATH"] ?? "" },
      });
      const hostPathResult = await hostPathProbe.wait();
      expect(hostPathResult.exitCode).toBe(0);
      expect(hostPathResult.stdout.trim()).toBe(join(world.directory, "image-bin-node", "node"));
      await expect(task.spawn({ command: process.execPath })).rejects.toThrow(
        /outside the fake image/u,
      );
      await expect(
        task.spawn({ command: "sh", args: ["-c", "'/opt/homebrew/bin/node' --version"] }),
      ).rejects.toThrow(/outside the fake image/u);
      await expect(
        task.spawn({ command: "sh", args: ["-c", "cat /workspace/../../etc/passwd"] }),
      ).rejects.toThrow(/escapes the fake sandbox/u);
      await expect(
        task.spawn({ command: "sh", args: ["-c", "cat /workspace-evil/secret"] }),
      ).rejects.toThrow(/outside the fake image/u);
      const sandbox = [...world.taskSandboxes].at(-1) as string;
      await fakeNode(join(world.directory, sandbox, "workspace", "copied-node"));
      await expect(task.spawn({ command: "/workspace/copied-node" })).rejects.toThrow(
        /trusted snapshot/u,
      );
      await expect(
        task.spawn({ command: "sh", args: ["-c", "/workspace/copied-node --version"] }),
      ).rejects.toThrow(/trusted snapshot/u);
      await expect(
        task.spawn({ command: "sh", args: ["-c", "cd /workspace && ./copied-node --version"] }),
      ).rejects.toThrow(/trusted snapshot/u);
      await expect(
        task.spawn({ command: "sh", args: ["-c", "./workspace/copied-node --version"] }),
      ).rejects.toThrow(/trusted snapshot/u);
      await expect(
        task.spawn({ command: "sh", args: ["-c", "cd /workspace; ./copied-node --version"] }),
      ).rejects.toThrow(/trusted snapshot/u);
      for (const script of [
        'cd /workspace/repo/.. && sh -c "./copied-node --version"',
        "sh -c \"sh -c '/workspace/copied-node --version'\"",
        'cd /workspace/repo/.. && bash -c "./copied-node --version"',
      ]) {
        const nested = await task.spawn({ command: "sh", args: ["-c", script] });
        const result = await nested.wait();
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/Permission denied|permission denied/u);
      }
      await symlink(scratch, join(world.directory, sandbox, "workspace", "outside-link"));
      await expect(
        task.spawn({ command: "sh", args: ["-c", "cat /workspace/outside-link/secret"] }),
      ).rejects.toThrow(/escapes the fake sandbox/u);
      expect(world.calls.some((call) => call.kind === "modal.sandbox.exec")).toBe(true);
    } finally {
      await task.dispose("completed");
    }
  }, 60_000);

  it("has apt-get but no Node.js when no stdio MCP server is selected", async () => {
    if (provider !== "modal") return;
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const prepared = await environment.prepare(await defineFor(repository, scratch));
    const build = world.calls.find((call) => call.kind === "modal.image.build");
    expect(JSON.stringify(build?.detail)).not.toContain("nodejs");
    expect(world.nodeArtifacts.size).toBe(0);
    const task = await environment.start(prepared, {
      taskId: "no-node",
      attemptId: "no-node",
      branch: "supertag/test/no-node",
      base: repository.trusted,
      head: repository.trusted,
      plan: PLAN,
    });
    try {
      const aptGet = await task.spawn({ command: "sh", args: ["-c", "command -v apt-get"] });
      expect((await aptGet.wait()).exitCode).toBe(0);
      const missing = await task.spawn({ command: "node", args: ["--version"] });
      const missingResult = await missing.wait();
      expect(missingResult.exitCode).toBe(127);
      expect(missingResult.stderr).toMatch(/node: not found/u);
      const missingShell = await task.spawn({
        command: "sh",
        args: ["-c", "node --version"],
        environment: { PATH: process.env["PATH"] ?? "" },
      });
      const missingShellResult = await missingShell.wait();
      expect(missingShellResult.exitCode).toBe(127);
      expect(missingShellResult.stderr).toMatch(/node: (?:command )?not found/u);
      // The image installs nothing at run time: only preparation's trusted layer adds Node.js.
      const install = await task.spawn({
        command: "sh",
        args: ["-c", "apt-get install -y nodejs; node --version"],
      });
      expect((await install.wait()).exitCode).toBe(127);
    } finally {
      await task.dispose("completed");
    }
  }, 60_000);

  it("reports the last lines of setup stderr, not stdout, when Modal setup fails", async () => {
    if (provider !== "modal") return;
    const { scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const failing = {
      ...(await defineFor(repository, scratch)),
      setup:
        "i=0; while [ $i -lt 40 ]; do i=$((i+1)); echo \"setup stderr $i\" >&2; done; printf '%03000d' 0; exit 3",
    };
    const error = await environment.prepare(failing).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toMatch(/^Modal Workspace setup failed \(exit 3\): /u);
    expect(error?.message).toContain("setup stderr 21\nsetup stderr 22");
    expect(error?.message).toMatch(/setup stderr 40$/u);
    expect(error?.message).not.toContain("setup stderr 20\n");
    expect(error?.message).not.toContain("0000");
    expect(error?.message.length).toBeLessThan(1200);
  }, 60_000);

  it("explains a killed Modal setup that wrote no stderr", async () => {
    if (provider !== "modal") return;
    const { scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const killed = { ...(await defineFor(repository, scratch)), setup: "echo progress; exit 137" };
    await expect(environment.prepare(killed)).rejects.toThrow(
      "Modal Workspace setup failed (exit 137) with no stderr: exit 137 usually means the setup process received SIGKILL, often for exceeding the sandbox's memory limit",
    );
  }, 60_000);

  it("adds Node.js to an image only for the exact trusted install layer", async () => {
    if (provider !== "modal") return;
    const { world } = await setup();
    const { workspaceClient, sandboxFactory } = world.modal();
    const target = { appName: "fake", createAppIfMissing: false };
    const nodeVersion = async (commands: string[]) => {
      const imageId = await workspaceClient.buildImage({
        ...target,
        image: "python:3.13-slim",
        commands,
      });
      const task = await sandboxFactory.create({
        ...target,
        image: "python:3.13-slim",
        imageId,
        params: { timeoutMs: 60_000, tags: {} },
      });
      return (await task.exec(["node", "--version"], { mode: "binary" })).wait();
    };
    expect(await nodeVersion([])).toBe(127);
    expect(await nodeVersion(['RUN ["/bin/sh", "-c", "apt-get install -y nodejs"]'])).toBe(127);
    expect(
      await nodeVersion([`RUN ${JSON.stringify(["/bin/sh", "-c", WORKSPACE_MCP_NODE_INSTALL])}`]),
    ).toBe(0);
  });

  it("refuses checkout and staged-file overlap for operator mounts", async () => {
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const prepared = await environment.prepare(await defineFor(repository, scratch));
    const task = {
      taskId: "mount-paths",
      attemptId: "mount-paths",
      branch: "supertag/test/mount-paths",
      base: repository.trusted,
      head: repository.trusted,
      plan: PLAN,
    };
    const volume = join(scratch, "volume");
    await mkdir(volume);
    await writeFile(join(volume, "rows.csv"), "a,b\n");
    const volumes = fileVolumes(volume);
    const before = world.calls.length;
    await expect(
      environment.start(prepared, {
        ...task,
        volumes,
        mounts: [{ volume: "data", path: FAKE_WORKSPACE, access: "read-only", strategy: "copy" }],
      }),
    ).rejects.toThrow(/overlaps the checkout/u);
    expect(world.calls).toHaveLength(before);
    const started = await environment.start(prepared, {
      ...task,
      volumes,
      mounts: [{ volume: "data", path: "/workspace/data", access: "read-only", strategy: "copy" }],
    });
    try {
      await expect(
        environment.harnessEnvironment(started).prepare({
          ...PLAN,
          files: [{ path: "data/token", content: "secret" }],
        }),
      ).rejects.toThrow(/overlaps a staged file/u);
    } finally {
      await started.dispose("completed");
    }
  });

  it("refuses a sandbox mount whose existing ancestor redirects into the checkout", async () => {
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const prepared = await environment.prepare(await defineFor(repository, scratch));
    const artifact = world.artifacts.get(prepared.artifact);
    if (artifact === undefined) throw new Error("Fake prepared artifact missing");
    await symlink("repo", join(artifact, "workspace", "alias"));
    const volume = join(scratch, "volume");
    await mkdir(volume);
    const task = {
      taskId: "linked-mount",
      attemptId: "linked-mount",
      branch: "supertag/test/linked-mount",
      base: repository.trusted,
      head: repository.trusted,
      plan: PLAN,
      volumes: fileVolumes(volume),
    };
    await expect(
      environment.start(prepared, {
        ...task,
        mounts: [
          { volume: "data", path: "/workspace/alias/data", access: "read-only", strategy: "copy" },
        ],
      }),
    ).rejects.toThrow(/overlaps the checkout|crosses a symbolic link/u);
    await expect(
      environment.start(prepared, {
        ...task,
        mounts: [
          { volume: "data", path: "/workspace/alias", access: "read-only", strategy: "copy" },
        ],
      }),
    ).rejects.toThrow(/symbolic link/u);
  }, 60_000);

  it.each(["transfer", "mcp"])("rechecks the %s directory inside the sandbox", async (kind) => {
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const prepared = await environment.prepare(await defineFor(repository, scratch));
    const artifact = world.artifacts.get(prepared.artifact);
    if (artifact === undefined) throw new Error("Fake prepared artifact missing");
    const protectedPath = kind === "transfer" ? FAKE_TRANSFER : environment.mcpDirectory;
    await rm(join(artifact, protectedPath), { recursive: true, force: true });
    await symlink("../workspace/data", join(artifact, protectedPath));
    const volume = join(scratch, "volume");
    await mkdir(volume);
    let started: ExecutionEnvironment | undefined;
    try {
      await expect(
        (async () => {
          started = await environment.start(prepared, {
            taskId: "protected-mount",
            attemptId: "protected-mount",
            branch: "supertag/test/protected-mount",
            base: repository.trusted,
            head: repository.trusted,
            plan: PLAN,
            volumes: fileVolumes(volume),
            mounts: [
              { volume: "data", path: "/workspace/data", access: "read-only", strategy: "copy" },
            ],
          });
        })(),
      ).rejects.toThrow(/symbolic link|overlaps/u);
    } finally {
      await started?.dispose("completed");
    }
  });

  it("refuses an unresolvable or oversized Volume before any provider call", async () => {
    const { world, scratch, environment } = await setup();
    const s3 = await FakeS3.start("refusal-access-key");
    cleanups.push(() => s3.close());
    s3.put("data", "sets/big.bin", "x".repeat(64));
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const prepared = await environment.prepare(await defineFor(repository, scratch));
    const volume = join(scratch, "volume");
    await mkdir(volume);
    await writeFile(join(volume, "rows.csv"), "a,b\n");
    const task = {
      taskId: "refused-volume",
      attemptId: "refused-volume",
      branch: "supertag/test/refused-volume",
      base: repository.trusted,
      head: repository.trusted,
      plan: PLAN,
      mounts: [
        { volume: "data", path: FAKE_MOUNT, access: "read-only", strategy: "copy" },
      ] as const,
    };
    const cases: [VolumeResolver | undefined, number | undefined, RegExp][] = [
      [undefined, undefined, /resolves no Volumes, so it cannot copy Volume data/u],
      [
        {
          resolve: async () => {
            throw new Error("no volume-credentials mapping");
          },
        },
        undefined,
        /cannot resolve Volume data: no volume-credentials mapping/u,
      ],
      [
        {
          resolve: async (name) => ({
            volume: name,
            source: "s3://data/sets",
            credentials: async () => {
              throw new Error("unreadable");
            },
          }),
        },
        undefined,
        /could not resolve the credential for Volume data/u,
      ],
      [
        {
          resolve: async (name) => ({
            volume: name,
            source: `s3://data/sets?endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`,
            credentials: async () => ({
              accessKeyId: "refusal-access-key",
              secretAccessKey: "refusal-secret",
            }),
          }),
        },
        16,
        /holds more than its mount's 16-byte limit/u,
      ],
      [
        { ...fileVolumes(volume), protectedDirectories: [scratch] },
        undefined,
        /Volume data source directory .* overlaps/u,
      ],
    ];
    const before = world.calls.length;
    for (const [volumes, maxBytes, reason] of cases)
      await expect(
        environment.start(prepared, {
          ...task,
          ...(volumes === undefined ? {} : { volumes }),
          mounts: task.mounts.map((mount) => ({
            ...mount,
            ...(maxBytes === undefined ? {} : { maxBytes }),
          })),
        }),
      ).rejects.toThrow(reason);
    // No sandbox was created and nothing was downloaded for any refusal.
    expect(world.calls).toHaveLength(before);
    expect(s3.downloads).toHaveLength(0);
  }, 60_000);

  it("copies an S3 Volume from the Worker Host, keeping its credential away from the provider", async () => {
    const { world, scratch, environment } = await setup();
    const s3 = await FakeS3.start("mount-access-key-canary");
    cleanups.push(() => s3.close());
    const secret = "mount-secret-canary-7f1e";
    s3.put("data", "sets/rows.csv", "a,b\n");
    s3.put("data", "sets/deep/more.txt", "more\n");
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const prepared = await environment.prepare(await defineFor(repository, scratch));
    const volumes: VolumeResolver = {
      resolve: async (volume) => ({
        volume,
        source: `s3://data/sets?endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`,
        credentials: async () => ({
          accessKeyId: "mount-access-key-canary",
          secretAccessKey: secret,
        }),
      }),
    };
    const started = await environment.start(prepared, {
      taskId: "s3-mount",
      attemptId: "s3-mount",
      branch: "supertag/test/s3-mount",
      base: repository.trusted,
      head: repository.trusted,
      plan: PLAN,
      mounts: [{ volume: "data", path: FAKE_MOUNT, access: "read-only", strategy: "copy" }],
      volumes,
    });
    try {
      expect(await readFile(fakeMountPath(world, started, "rows.csv"), "utf8")).toBe("a,b\n");
      expect(await readFile(fakeMountPath(world, started, "deep/more.txt"), "utf8")).toBe("more\n");
      expect((await stat(fakeMountPath(world, started, "rows.csv"))).mode & 0o222).toBe(0);
      const manifests = (started as unknown as { mountManifests: readonly MountManifest[] })
        .mountManifests;
      expect(manifests.map((manifest) => manifest.objects.map((object) => object.key))).toEqual([
        ["deep/more.txt", "rows.csv"],
      ]);
      // Neither the secret nor the access key reached a provider call or the sandbox's files.
      const received = await world.received();
      expect(received).not.toContain(secret);
      expect(received).not.toContain("mount-access-key-canary");
      const sandbox = String(started.provenance?.["sandboxId"]);
      const files = await exec("grep", ["-rl", secret, join(world.directory, sandbox)]).then(
        ({ stdout }) => stdout,
        () => "",
      );
      expect(files).toBe("");
      expect(s3.downloads).toHaveLength(2);
    } finally {
      await started.dispose("completed");
    }
  }, 60_000);

  it("uploads changed read-write copy files from the sandbox at finalize", async () => {
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const volume = join(scratch, "volume");
    await mkdir(volume);
    await writeFile(join(volume, "rows.csv"), "a,b\n");
    const prepared = await environment.prepare(await defineFor(repository, scratch));
    const started = await environment.start(prepared, {
      taskId: "write-mount",
      attemptId: "write-mount",
      branch: "supertag/test/write-mount",
      base: repository.trusted,
      head: repository.trusted,
      plan: PLAN,
      mounts: [{ volume: "data", path: FAKE_MOUNT, access: "read-write", strategy: "copy" }],
      volumes: fileVolumes(volume),
    });
    try {
      await writeFile(fakeMountPath(world, started, "rows.csv"), "a,b\n1,2\n");
      await writeFile(fakeMountPath(world, started, "new.txt"), "new\n");
      const finalized = await environment.finalize(started, {
        message: "Upload data",
        author: { name: "SuperTag", email: "supertag@localhost" },
      });
      expect(finalized.mountOutputManifests).toMatchObject([
        {
          status: "complete",
          objects: [{ key: "new.txt" }, { key: "rows.csv" }],
        },
      ]);
      expect(await readFile(join(volume, "rows.csv"), "utf8")).toBe("a,b\n1,2\n");
      expect(await readFile(join(volume, "new.txt"), "utf8")).toBe("new\n");
    } finally {
      await started.dispose("completed");
    }
  }, 60_000);

  it("refuses a mount path a prepared artifact already holds or reaches through a link", async () => {
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const volume = join(scratch, "volume");
    await mkdir(volume);
    await writeFile(join(volume, "rows.csv"), "a,b\n");
    const prepared = await environment.prepare({
      ...(await defineFor(repository, scratch)),
      setup: "sh setup.sh && mkdir -p /workspace/data && ln -s repo /workspace/linked",
    });
    const task = {
      taskId: "prepared-mount",
      attemptId: "prepared-mount",
      branch: "supertag/test/prepared-mount",
      base: repository.trusted,
      head: repository.trusted,
      plan: PLAN,
      volumes: fileVolumes(volume),
    };
    await expect(
      environment.start(prepared, {
        ...task,
        mounts: [{ volume: "data", path: FAKE_MOUNT, access: "read-only", strategy: "copy" }],
      }),
    ).rejects.toThrow(/already exists in the sandbox/u);
    await expect(
      environment.start(prepared, {
        ...task,
        mounts: [
          { volume: "data", path: "/workspace/linked/data", access: "read-only", strategy: "copy" },
        ],
      }),
    ).rejects.toThrow(/crosses a symbolic link/u);
    expect(await world.received()).not.toContain("rows.csv");
    // Nothing reached the checkout the link points at.
    const before = world.calls.length;
    await expect(
      environment.start(prepared, {
        ...task,
        mounts: [
          {
            volume: "data",
            path: `${FAKE_TRANSFER}/data`,
            access: "read-only",
            strategy: "copy",
          },
        ],
      }),
    ).rejects.toThrow(/overlaps the bundle transfer directory/u);
    expect(world.calls).toHaveLength(before);
  }, 60_000);

  it("finds Node.js installed in a trusted preparation snapshot", async () => {
    if (provider !== "modal") return;
    const { world } = await setup();
    const { workspaceClient, sandboxFactory } = world.modal();
    const target = { appName: "fake", createAppIfMissing: false };
    const base = await workspaceClient.buildImage({
      ...target,
      image: "python:3.13-slim",
      commands: [],
    });
    const preparation = await workspaceClient.createSetupSandbox({
      ...target,
      imageId: base,
      timeoutMs: 60_000,
      tags: {},
    });
    const trustedBin = join(world.directory, preparation.sandboxId, "workspace", "trusted-bin");
    await mkdir(trustedBin, { recursive: true });
    await fakeNode(join(trustedBin, "node"));
    const imageId = await preparation.snapshotFilesystem();
    const task = await sandboxFactory.create({
      ...target,
      image: "python:3.13-slim",
      imageId,
      params: { timeoutMs: 60_000, tags: {} },
    });
    const node = await task.exec(["node", "--version"], { mode: "binary" });
    expect(await node.wait()).toBe(0);
    const shell = await task.exec(["sh", "-c", "command -v node"], { mode: "binary" });
    expect(await shell.wait()).toBe(0);
  });

  it("reports a provider whose stdio MCP servers run from the Task's checkout", async () => {
    const { world, scratch, environment } = await setup();
    // The fault: the server directory is the Task's own checkout, which the Task edited.
    const faulty: WorkspaceEnvironment = {
      provider: environment.provider,
      base: environment.base,
      capabilities: environment.capabilities,
      mcpDirectory: FAKE_WORKSPACE,
      refuse: (definition) => environment.refuse(definition),
      prepare: (definition, signal) => environment.prepare(definition, signal),
      start: (prepared, task, signal) => environment.start(prepared, task, signal),
      finalize: (started, commit, signal) => environment.finalize(started, commit, signal),
      evict: (prepared) => environment.evict(prepared),
    };
    const report = await conformance(world, scratch, faulty);
    const codes = report.findings.map((finding) => finding.code);
    expect(codes).toContain("workspace.mcp.directory");
    expect(codes).toContain("workspace.mcp.trusted-copy");
  }, 120_000);

  it("never snapshots or builds from a Task sandbox, and a Task's writes stay out of the artifact", async () => {
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const cache = new PreparedWorkspaceCache({ root: join(scratch, "cache") });
    const definition = await defineFor(repository, scratch);
    const { prepared } = await cache.prepare(environment, definition);
    const task = await environment.start(prepared, {
      taskId: "t1",
      attemptId: "a1",
      branch: "supertag/test/t1",
      base: repository.trusted,
      head: repository.trusted,
      plan: PLAN,
    });
    await task.prepare({
      ...PLAN,
      files: [
        { path: "prepared.txt", content: "tampered\n" },
        { path: "work.txt", content: "work\n" },
      ],
    });
    const work = await environment.finalize(task, {
      message: "Work",
      author: { name: "SuperTag", email: "supertag@localhost" },
    });
    expect(work.committed).toBe(true);
    await task.dispose("completed");
    expect(world.snapshots.map((snapshot) => snapshot.sandbox)).not.toEqual(
      expect.arrayContaining([...world.taskSandboxes]),
    );
    expect(world.snapshots).toHaveLength(1);
    const again = await cache.prepare(environment, definition);
    expect(again.reused).toBe(true);
    const fresh = await environment.start(again.prepared, {
      taskId: "t2",
      attemptId: "a2",
      branch: "supertag/test/t2",
      base: repository.trusted,
      head: repository.trusted,
      plan: PLAN,
    });
    expect(await fresh.read("prepared.txt")).toBe("trusted\n");
    await expect(fresh.read("work.txt")).rejects.toThrow();
    await fresh.dispose("completed");
  }, 60_000);

  it("sends providers bundles, never source credentials or MCP secrets", async () => {
    const { world, scratch, environment } = await setup();
    const canary = `canary-${Math.random().toString(36).slice(2)}`;
    const saved = { ...process.env };
    process.env["SUPERTAG_GIT_PASSWORD"] = canary;
    process.env["GITHUB_TOKEN"] = canary;
    try {
      const repository = await conformanceLikeRepository(join(scratch, "source"));
      // Definitions carry declared MCP servers and their digest, never resolved secrets.
      const definition: WorkspaceDefinition = await defineFor(repository, scratch);
      const prepared = await environment.prepare(definition);
      const task = await environment.start(prepared, {
        taskId: "t1",
        attemptId: "a1",
        branch: "supertag/test/t1",
        base: repository.trusted,
        head: repository.task,
        objects: await bundleTaskObjects({
          repository: repository.path,
          trustedCommit: repository.trusted,
          head: repository.task,
          directory: join(scratch, "bundles"),
        }),
        plan: PLAN,
      });
      await environment.finalize(task, {
        message: "Work",
        author: { name: "SuperTag", email: "supertag@localhost" },
      });
      await task.dispose("completed");
      const received = await world.received();
      expect(received).not.toContain(canary);
      expect(received).not.toContain("SUPERTAG_GIT_PASSWORD");
      expect(received).not.toContain(SOURCE);
    } finally {
      process.env = saved;
    }
  }, 60_000);

  it("refuses content that is not exactly the trusted commit, before any provider call", async () => {
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const definition = await defineFor(repository, scratch);
    const hostile = {
      ...definition,
      content: await bundleTrustedCommit({
        repository: repository.path,
        trustedCommit: repository.task,
        directory: join(scratch, "bundles"),
      }),
    };
    await expect(environment.prepare(hostile)).rejects.toThrow(/bundle of trusted commit/u);
    await writeFile(definition.content?.bundle as string, "# v2 git bundle\n\n");
    await expect(environment.prepare(definition)).rejects.toThrow(/recorded digest/u);
    expect(world.calls).toEqual([]);
  });

  it("refuses returned bundles with extra refs, another head, or over the size bound", async () => {
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const prepared = await environment.prepare(await defineFor(repository, scratch));
    const finalizeWith = async (tamper: (bytes: Uint8Array) => Uint8Array) => {
      const task = await environment.start(prepared, {
        taskId: "t1",
        attemptId: "a1",
        branch: "supertag/test/t1",
        base: repository.trusted,
        head: repository.trusted,
        plan: PLAN,
      });
      await task.prepare({ ...PLAN, files: [{ path: "work.txt", content: "work\n" }] });
      world.tamper = (path, bytes) => (path.includes("returned-") ? tamper(bytes) : bytes);
      try {
        return await environment.finalize(task, {
          message: "Work",
          author: { name: "SuperTag", email: "supertag@localhost" },
        });
      } finally {
        world.tamper = undefined;
        await task.dispose("failed");
      }
    };
    const extraRef = (bytes: Uint8Array) => {
      const text = Buffer.from(bytes).toString("latin1");
      const line = text.split("\n").find((item) => / refs\/heads\//u.test(item)) as string;
      return new Uint8Array(
        Buffer.from(text.replace(line, `${line}\n${line.split(" ")[0]} refs/heads/main`), "latin1"),
      );
    };
    await expect(finalizeWith(extraRef)).rejects.toThrow(/exactly one ref/u);
    const otherHead = (bytes: Uint8Array) => {
      const text = Buffer.from(bytes).toString("latin1");
      return new Uint8Array(
        Buffer.from(
          text.replace(/\n[0-9a-f]{40} refs\/heads/u, `\n${repository.task} refs/heads`),
          "latin1",
        ),
      );
    };
    await expect(finalizeWith(otherHead)).rejects.toThrow(/reported head/u);
    const good = await finalizeWith((bytes) => bytes);
    expect(good.objects).toBeDefined();
    const header = parseGitBundleHeader(
      new Uint8Array(await readFile(good.objects?.bundle as string)),
    );
    expect(header.refs).toEqual([{ name: "refs/heads/supertag/test/t1", oid: good.head }]);
    expect(header.prerequisites).toEqual([repository.trusted]);
    expect(() =>
      checkReturnedBundle(new Uint8Array(WORKSPACE_BUNDLE_LIMITS.returned + 1), {
        branch: "supertag/test/t1",
        head: good.head,
      }),
    ).toThrow(/over the/u);
  }, 60_000);

  it("warm-prepares a descendant trusted commit from the ancestor's artifact and runs setup again", async () => {
    const { world, scratch, environment } = await setup();
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const cache = new PreparedWorkspaceCache({
      root: join(scratch, "cache"),
      isAncestor: async (_workspace, ancestor, descendant) =>
        git(repository.path, "merge-base", "--is-ancestor", ancestor, descendant).then(
          () => true,
          () => false,
        ),
    });
    const setupCommand = "sh setup.sh && echo run >> runs.txt";
    const first = await cache.prepare(environment, {
      ...(await defineFor(repository, scratch)),
      setup: setupCommand,
    });
    await git(repository.path, "checkout", "-q", "main");
    await writeFile(join(repository.path, "README.md"), "# Moved\n");
    await git(repository.path, "commit", "-qam", "Move main");
    const moved = await git(repository.path, "rev-parse", "HEAD");
    const second = await cache.prepare(environment, {
      ...(await defineFor({ ...repository, trusted: moved }, scratch)),
      setup: setupCommand,
    });
    expect(second.reused).toBe(false);
    expect(second.warmFrom).toEqual(first.prepared);
    const task = await environment.start(second.prepared, {
      taskId: "t1",
      attemptId: "a1",
      branch: "supertag/test/t1",
      base: moved,
      head: moved,
      plan: PLAN,
    });
    expect(await task.read("README.md")).toBe("# Moved\n");
    expect(await task.read("runs.txt")).toBe("run\nrun\n");
    await task.dispose("completed");
    const builds = world.calls.filter(
      (call) => call.kind === "e2b.template.build" || call.kind === "modal.setup.create",
    );
    expect(builds).toHaveLength(2);
    const from = (builds[1]?.detail as { from?: string; imageId?: string }) ?? {};
    expect(from.from ?? from.imageId).toBe(first.prepared.artifact);
  }, 60_000);
});

describe("Workspace bundles", () => {
  const roots: string[] = [];
  afterEach(async () => {
    // A sandbox git process can still be writing packs as the test ends; retry ENOTEMPTY.
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("bundles only the trusted commit, and Task objects from it, without running repository drivers on the host", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "supertag-bundles-"));
    roots.push(scratch);
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const canary = join(scratch, "driver-ran");
    // A Task commit selects a filter driver the repository defines: bundling must never run it.
    await git(repository.path, "checkout", "-q", "task");
    await writeFile(join(repository.path, ".gitattributes"), "* filter=evil\n");
    await git(repository.path, "add", ".gitattributes");
    await git(repository.path, "commit", "-qm", "Attributes");
    const head = await git(repository.path, "rev-parse", "HEAD");
    await git(repository.path, "checkout", "-q", "main");
    await git(repository.path, "config", "filter.evil.clean", `touch ${canary}`);
    await git(repository.path, "config", "filter.evil.smudge", `touch ${canary}`);
    await git(repository.path, "config", "filter.evil.process", `touch ${canary}`);

    const directory = join(scratch, "bundles");
    const content = await bundleTrustedCommit({
      repository: repository.path,
      trustedCommit: repository.trusted,
      directory,
    });
    const contentHeader = parseGitBundleHeader(new Uint8Array(await readFile(content.bundle)));
    expect(contentHeader.prerequisites).toEqual([]);
    expect(contentHeader.refs).toEqual([
      { name: "refs/supertag/trusted", oid: repository.trusted },
    ]);
    const objects = await bundleTaskObjects({
      repository: repository.path,
      trustedCommit: repository.trusted,
      head,
      directory,
    });
    const objectsHeader = parseGitBundleHeader(
      new Uint8Array(await readFile(objects?.bundle as string)),
    );
    expect(objectsHeader.prerequisites).toEqual([repository.trusted]);
    expect(objectsHeader.refs).toEqual([{ name: "refs/supertag/head", oid: head }]);
    await expect(readFile(canary)).rejects.toThrow();
    expect(
      await bundleTaskObjects({
        repository: repository.path,
        trustedCommit: repository.trusted,
        head: repository.trusted,
        directory,
      }),
    ).toBeUndefined();

    // A shallow clone at the trusted commit takes both bundles.
    const sandbox = join(scratch, "sandbox");
    await mkdir(sandbox);
    await git(sandbox, "init", "-q");
    await writeFile(join(sandbox, ".git", "shallow"), `${repository.trusted}\n`);
    await git(
      sandbox,
      "-c",
      "fetch.fsckObjects=true",
      "fetch",
      "-q",
      content.bundle,
      "+refs/supertag/trusted:refs/supertag/trusted",
    );
    await git(
      sandbox,
      "-c",
      "fetch.fsckObjects=true",
      "fetch",
      "-q",
      objects?.bundle as string,
      "+refs/supertag/head:refs/supertag/head",
    );
    expect(await git(sandbox, "rev-parse", "refs/supertag/head")).toBe(head);
  });

  it("refuses Task objects that do not descend from the trusted commit or reach older history", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "supertag-bundles-"));
    roots.push(scratch);
    const repository = await conformanceLikeRepository(join(scratch, "source"));
    const directory = join(scratch, "bundles");
    await expect(
      bundleTaskObjects({
        repository: repository.path,
        trustedCommit: repository.task,
        head: repository.trusted,
        directory,
      }),
    ).rejects.toThrow(/does not descend/u);
    // A Task branch that merges a branch forked before the trusted commit.
    await writeFile(join(repository.path, "README.md"), "# Next\n");
    await git(repository.path, "commit", "-qam", "Next");
    const next = await git(repository.path, "rev-parse", "HEAD");
    await git(repository.path, "checkout", "-q", "-b", "old", repository.trusted);
    await writeFile(join(repository.path, "old.txt"), "old\n");
    await git(repository.path, "add", "old.txt");
    await git(repository.path, "commit", "-qm", "Old");
    await git(repository.path, "checkout", "-q", "-b", "work", next);
    await git(repository.path, "merge", "-q", "--no-edit", "old");
    const merged = await git(repository.path, "rev-parse", "HEAD");
    await expect(
      bundleTaskObjects({
        repository: repository.path,
        trustedCommit: next,
        head: merged,
        directory,
      }),
    ).rejects.toThrow(/history before trusted commit/u);
  });

  it("parses bundle headers strictly", () => {
    const oid = "a".repeat(40);
    expect(
      parseGitBundleHeader(Buffer.from(`# v2 git bundle\n-${oid} c\n${oid} refs/heads/x\n\nPACK`)),
    ).toMatchObject({
      prerequisites: [oid],
      refs: [{ name: "refs/heads/x", oid }],
    });
    expect(() => parseGitBundleHeader(Buffer.from("not a bundle\n\n"))).toThrow(
      /Not a git bundle/u,
    );
    expect(() =>
      parseGitBundleHeader(
        Buffer.from(`# v3 git bundle\n@filter=blob:none\n${oid} refs/heads/x\n\n`),
      ),
    ).toThrow(/unsupported capability/u);
    expect(() =>
      parseGitBundleHeader(Buffer.from(`# v2 git bundle\n${oid.slice(1)} refs/heads/x\n\n`)),
    ).toThrow(/invalid object ID/u);
  });
});

interface TestRepository {
  readonly path: string;
  readonly trusted: string;
  readonly task: string;
}

/** The conformance repository's shape: `main` at the trusted commit, `task` on top. */
async function conformanceLikeRepository(path: string): Promise<TestRepository> {
  await mkdir(path, { recursive: true });
  await git(path, "init", "-q", "-b", "main");
  await writeFile(join(path, ".gitignore"), "prepared.txt\nruns.txt\n");
  await writeFile(join(path, "README.md"), "# Test\n");
  await writeFile(join(path, "setup.sh"), "printf 'trusted\\n' > prepared.txt\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-qm", "Trusted");
  const trusted = await git(path, "rev-parse", "HEAD");
  await git(path, "checkout", "-q", "-b", "task");
  await writeFile(join(path, "task.txt"), "task\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-qm", "Task");
  const task = await git(path, "rev-parse", "HEAD");
  await git(path, "checkout", "-q", "main");
  return { path, trusted, task };
}

async function defineFor(
  repository: TestRepository,
  scratch: string,
): Promise<WorkspaceDefinition> {
  return {
    workspace: "app",
    source: SOURCE,
    trustedCommit: repository.trusted,
    content: await bundleTrustedCommit({
      repository: repository.path,
      trustedCommit: repository.trusted,
      directory: join(scratch, "bundles"),
    }),
    setup: "sh setup.sh",
    harness: { commands: ["sh"] },
  };
}
