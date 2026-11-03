import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostSecretPaths } from "../apps/cli/src/host-service.js";
import { hostVolumeResolver, parseVolumeCredentialSecret } from "../apps/cli/src/host-volumes.js";
import { loadServicesFile, readVolumeCredential } from "../apps/cli/src/supertag-yaml.js";
import { workletVolumeResolver } from "../apps/cli/src/worker.js";
import { dispatchedWorkspacePlan } from "../packages/control-plane/src/label-placement.js";
import {
  type TaskNamedWorkspacePlan,
  type TaskWorkspaceVolume,
  taskWorkspaceBranch,
} from "../packages/core/src/index.js";
import {
  type ResolutionContext,
  type TaskAttemptSpec,
  WorkspaceEnvironmentResolver,
} from "../packages/runtime/sdk/src/index.js";
import {
  type LocalMountRoot,
  resolveLocalMountRoot,
} from "../packages/runtime/sdk/src/local-mount-root.js";
import { pinWorkspaceVolumes } from "../packages/runtime/sdk/src/volume-copy.js";
import { decodeTaskAttemptSpec } from "../packages/runtime/transport/src/attempt-codec.ts";
import { stateDirectory } from "../packages/store/src/index.js";
import { createRepository, isolateGitConfiguration } from "./support/git-repository.js";
import { repositoryAttempt } from "./support/repository-execution.ts";
import { removeSealedTree } from "./support/sealed-tree.ts";

// Scratch directories live in the system temporary directory, which a real Worker Host refuses
// for local copies; tests/volume-copy-races.test.ts checks that refusal.
vi.mock("../packages/runtime/sdk/src/task-writable-roots.js", () => ({
  taskWritableRoots: () => [],
}));

const SECRET = "host-volume-secret-canary-41c2";

describe("the Worker Host's Volume resolver", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let checkout: string;
  let root: string;
  let scratch: string;
  let localMountRoot: LocalMountRoot;
  let state: string;
  let source: string;
  let mountPath: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    checkout = await createRepository();
    root = await mkdtemp(join(tmpdir(), "supertag-host-volume-worktrees-"));
    scratch = await mkdtemp(join(tmpdir(), "supertag-host-volumes-"));
    state = join(scratch, "state");
    source = join(scratch, "volume");
    mountPath = join(scratch, "mnt", "datasets");
    localMountRoot = await resolveLocalMountRoot(scratch);
    await mkdir(state);
    await mkdir(source);
    await writeFile(join(source, "rows.csv"), "a,b\n");
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => removeSealedTree(scratch));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const plan = (taskId: string, volumes?: readonly TaskWorkspaceVolume[]) =>
    ({
      version: 1,
      status: "workspace",
      workspace: "app",
      branch: taskWorkspaceBranch("objective-1", taskId),
      delivery: "branch",
      mounts: [{ volume: "datasets", path: mountPath, access: "read-only", strategy: "copy" }],
      ...(volumes === undefined ? {} : { volumes }),
    }) satisfies TaskNamedWorkspacePlan;
  const context = (taskId: string, attemptId: string, volumes?: readonly TaskWorkspaceVolume[]) =>
    ({
      task: {
        taskId,
        attemptId,
        workspacePlan: plan(taskId, volumes),
        authorization: { runtimeActions: ["files:write"] },
      } as unknown as TaskAttemptSpec,
      profile: { harness: { provider: "codex" } },
    }) as unknown as ResolutionContext;
  const workspaces = (
    readVolumeCredential?: (name: string) => Promise<string | { path: string }>,
  ) =>
    new WorkspaceEnvironmentResolver({
      localMountRoot,
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
      volumes: workletVolumeResolver(
        readVolumeCredential === undefined ? {} : { readVolumeCredential },
        state,
      ),
    });
  const catalog = (volumeSource = source): TaskWorkspaceVolume[] => [
    { name: "datasets", source: pathToFileURL(volumeSource).href, credential: "datasets" },
  ];

  it("copies a Volume the Attempt was dispatched with when this host maps its credential", async () => {
    const read = vi.fn(async (name: string) => {
      if (name !== "datasets") throw new Error("unmapped");
      return { path: source };
    });
    const resolver = workspaces(read);
    await resolver.resolve(context("objective-1:task/1", "attempt-1", catalog()));
    expect(await readFile(join(mountPath, "rows.csv"), "utf8")).toBe("a,b\n");
    expect(read).toHaveBeenCalledWith("datasets");
    const [manifest] = resolver.mountManifestsForAttempt("attempt-1");
    expect(manifest).toMatchObject({ volume: "datasets", objectCount: 1 });
    await resolver.finalize(
      context("objective-1:task/1", "attempt-1").task as TaskAttemptSpec,
      "completed",
    );
  });

  it("binds file:// consent to a real host directory and rejects object-store mappings", async () => {
    const other = join(scratch, "other");
    await mkdir(other);
    await symlink(other, join(scratch, "other-link"));
    const task = (path: string) => ({
      taskId: "t",
      attemptId: "a",
      volumes: catalog(path),
    });
    for (const value of [
      "opaque consent",
      JSON.stringify({ path: source }),
      JSON.stringify({ accessKeyId: "a", secretAccessKey: SECRET }),
      { path: other },
      { path: join(scratch, "other-link") },
    ]) {
      const resolver = hostVolumeResolver({
        readCredential: async () => value,
        protectedDirectories: [state],
      });
      await expect(resolver.resolve("datasets", task(source))).rejects.toThrow(/Volume datasets/u);
    }
    const resolver = hostVolumeResolver({
      readCredential: async () => ({ path: source }),
      protectedDirectories: [state],
    });
    expect((await resolver.resolve("datasets", task(source))).source).toBe(
      pathToFileURL(source).href,
    );
    await symlink(other, join(source, "escape"));
    await expect(resolver.resolve("datasets", task(join(source, "escape")))).rejects.toThrow(
      /outside its host consent directory/u,
    );
  });

  it("refuses file sources containing home or protected state even with exact consent", async () => {
    const task = (path: string) => ({ taskId: "t", attemptId: "a", volumes: catalog(path) });
    for (const path of [homedir(), dirname(homedir())]) {
      const resolver = hostVolumeResolver({
        readCredential: async () => ({ path }),
        protectedDirectories: [],
      });
      await expect(resolver.resolve("datasets", task(path))).rejects.toThrow(
        /contains the Worker Host home directory/u,
      );
    }
    const resolver = hostVolumeResolver({
      readCredential: async () => ({ path: scratch }),
      protectedDirectories: [state],
    });
    await expect(resolver.resolve("datasets", task(scratch))).rejects.toThrow(
      /overlaps a protected Worker Host directory/u,
    );
  });

  it("rechecks path consent if a file:// source link changes after resolution", async () => {
    const other = join(scratch, "other");
    const link = join(scratch, "source-link");
    await mkdir(other);
    await symlink(source, link);
    const task = { taskId: "t", attemptId: "a", volumes: catalog(link) };
    const resolved = await hostVolumeResolver({
      readCredential: async () => ({ path: source }),
      protectedDirectories: [state],
    }).resolve("datasets", task);
    await unlink(link);
    await symlink(other, link);
    await expect(
      pinWorkspaceVolumes({
        mounts: [{ volume: "datasets", path: mountPath, access: "read-only", strategy: "copy" }],
        volumes: { resolve: async () => resolved },
        task,
      }),
    ).rejects.toThrow(/outside its host consent directory/u);
  });

  it.each([
    [
      "no catalog entry",
      async () => ({ path: source }),
      undefined,
      /Volume datasets was not in the Volume catalog when this Task Attempt was dispatched/u,
    ],
    [
      "no credential mapping",
      undefined,
      [{ name: "datasets", source: "s3://bucket/prefix", credential: "datasets" }],
      /no readable volume-credentials mapping for credential datasets of Volume datasets/u,
    ],
    [
      "a mapping whose secret cannot be read",
      async () => {
        throw new Error(SECRET);
      },
      [{ name: "datasets", source: "s3://bucket/prefix", credential: "datasets" }],
      /no readable volume-credentials mapping for credential datasets of Volume datasets/u,
    ],
    [
      "a malformed credential secret",
      async () => `not json ${SECRET}`,
      [{ name: "datasets", source: "s3://bucket/prefix", credential: "datasets" }],
      /credential secret for Volume datasets must be a JSON object/u,
    ],
    [
      "a file:// Volume without a credential name",
      async () => ({ path: source }),
      [{ name: "datasets", source: "file:///srv/data" }],
      /Volume datasets names no credential/u,
    ],
  ])(
    "refuses %s before the Task's worktree or any provider call",
    async (_, read, volumes, reason) => {
      const failure = await workspaces(read)
        .resolve(context("objective-1:task/2", "attempt-2", volumes))
        .then(
          () => "resolved",
          (error: unknown) => error as Error,
        );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("WorkspaceSetupError");
      expect(String(failure)).toMatch(reason);
      expect(String(failure)).not.toContain(SECRET);
      await expect(lstat(join(root, "app"))).rejects.toThrow();
      await expect(lstat(mountPath)).rejects.toThrow();
    },
  );

  it("refuses a file:// Volume in or containing the Worker Host's state, after resolving links", async () => {
    await writeFile(join(state, "supertag.db"), SECRET);
    await symlink(state, join(scratch, "state-link"));
    for (const volumeSource of [join(scratch, "state-link"), state, scratch])
      await expect(
        workspaces(async () => ({ path: scratch })).resolve(
          context("objective-1:task/3", "attempt-3", catalog(volumeSource)),
        ),
      ).rejects.toThrow(
        /Volume datasets file:\/\/ source overlaps a protected Worker Host directory/u,
      );
    await expect(lstat(mountPath)).rejects.toThrow();
  });

  it("refuses a file:// Volume that contains a host secret file", async () => {
    const secretFile = join(source, "volume.json");
    await writeFile(secretFile, SECRET);
    const resolver = workletVolumeResolver(
      {
        readVolumeCredential: async () => ({ path: source }),
        volumeProtectedPaths: [secretFile],
      },
      state,
    );
    expect(resolver.protectedDirectories).toEqual([state, secretFile]);
    await expect(
      new WorkspaceEnvironmentResolver({
        localMountRoot,
        checkouts: [{ name: "app", path: checkout }],
        worktreeRoot: root,
        volumes: resolver,
      }).resolve(context("objective-1:task/4", "attempt-4", catalog())),
    ).rejects.toThrow(
      /Volume datasets file:\/\/ source overlaps a protected Worker Host directory/u,
    );
    await expect(lstat(mountPath)).rejects.toThrow();
  });

  it("parses an object-store credential secret without echoing it", async () => {
    const value = JSON.stringify({
      accessKeyId: "AKIA-test",
      secretAccessKey: SECRET,
      sessionToken: "session-canary",
    });
    const resolved = await workletVolumeResolver(
      { readVolumeCredential: async () => value },
      state,
    ).resolve("datasets", {
      taskId: "t",
      attemptId: "a",
      volumes: [{ name: "datasets", source: "s3://bucket/prefix", credential: "acme" }],
    });
    expect(resolved.source).toBe("s3://bucket/prefix");
    expect(await resolved.credentials?.()).toEqual({
      accessKeyId: "AKIA-test",
      secretAccessKey: SECRET,
      sessionToken: "session-canary",
    });
    for (const bad of [
      "[]",
      JSON.stringify({ accessKeyId: "a" }),
      JSON.stringify({ accessKeyId: "a", secretAccessKey: SECRET, extra: SECRET }),
      JSON.stringify({ accessKeyId: "a", secretAccessKey: "b", [SECRET]: "misplaced" }),
      JSON.stringify({ accessKeyId: "a", secretAccessKey: SECRET, forcePathStyle: "yes" }),
    ]) {
      const failure = (() => {
        try {
          parseVolumeCredentialSecret("datasets", bad);
          return "parsed";
        } catch (error) {
          return String(error);
        }
      })();
      expect(failure).toMatch(/credential secret for Volume datasets/u);
      expect(failure).not.toContain(SECRET);
    }
  });

  it("protects the files a host service reads secrets from", async () => {
    const config = join(scratch, "config");
    await mkdir(config);
    await writeFile(join(config, ".env"), `DATASET_KEY=${SECRET}\n`);
    await writeFile(join(config, "volume-key.json"), SECRET);
    await writeFile(
      join(config, "supertag.yaml"),
      `services:
  laptop:
    type: host
    control-plane: https://supertag.example.com
    harnesses: [codex]
    volume-credentials:
      datasets: { environment: DATASET_KEY }
      archive: { file: ./volume-key.json }
`,
    );
    const file = await loadServicesFile({ files: [join(config, "supertag.yaml")] });
    const service = file.services.find((entry) => entry.type === "host");
    if (service?.type !== "host") throw new Error("missing host service");
    expect(hostSecretPaths(file)).toEqual([
      join(config, "supertag.yaml"),
      join(config, ".env"),
      join(config, "volume-key.json"),
      join(stateDirectory(), "artifacts"),
    ]);
    expect(await readVolumeCredential(file, service, "datasets", {})).toBe(SECRET);
  });
});

describe("dispatching a Task Attempt with its Volumes", () => {
  const plan: TaskNamedWorkspacePlan = {
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: "supertag/objective/task",
    delivery: "branch",
    mounts: [
      { volume: "datasets", path: "/mnt/a", access: "read-only", strategy: "copy" },
      { volume: "datasets", path: "/mnt/b", access: "read-only", strategy: "copy" },
      { volume: "gone", path: "/mnt/c", access: "read-only", strategy: "copy" },
    ],
    // A plan never carries Volumes of its own into dispatch; the catalog replaces them.
    volumes: [{ name: "datasets", source: "file:///etc", credential: "forged" }],
  };
  const store = {
    findVolumeByName: async (name: string) =>
      name === "datasets"
        ? { source: "s3://acme/datasets/", credential: "acme", id: "v1", revision: 1 }
        : undefined,
    // No Volume holds artifacts, so the artifact-Volume guard refuses none.
    listVolumes: async () => [],
    listWorkerHosts: async () => [],
    listVolumeIdsHoldingArtifacts: async () => [],
  };

  it("carries each named Volume's source and credential name from the catalog", async () => {
    const dispatched = await dispatchedWorkspacePlan(store, plan);
    expect(dispatched).toEqual({
      ...plan,
      volumes: [{ name: "datasets", source: "s3://acme/datasets/", credential: "acme" }],
    });
  });

  it("leaves plans without mounts unchanged", async () => {
    const { mounts: _, volumes: __, ...bare } = plan;
    expect(await dispatchedWorkspacePlan(store, bare)).toBe(bare);
    expect(await dispatchedWorkspacePlan(store, { version: 1, status: "none" })).toEqual({
      version: 1,
      status: "none",
    });
  });

  it("carries only names, sources, and credential names on the Worklet wire", () => {
    const spec = repositoryAttempt("test");
    const withVolumes = (volumes: unknown) => ({ ...spec, workspacePlan: { ...plan, volumes } });
    expect(
      decodeTaskAttemptSpec(
        withVolumes([{ name: "datasets", source: "s3://acme/datasets/", credential: "acme" }]),
      ).workspacePlan,
    ).toMatchObject({ volumes: [{ name: "datasets", credential: "acme" }] });
    expect(() => decodeTaskAttemptSpec(withVolumes("datasets"))).toThrow();
    expect(() => decodeTaskAttemptSpec(withVolumes([{ name: "datasets" }]))).toThrow();
    expect(() =>
      decodeTaskAttemptSpec(
        withVolumes([{ name: "datasets", source: "s3://acme/", secretAccessKey: "value" }]),
      ),
    ).toThrow(/only name, source, and credential/u);
  });
});
