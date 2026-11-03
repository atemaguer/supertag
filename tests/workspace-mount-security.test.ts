import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { assertHostVolumeMountable, hostVolumeResolver } from "../apps/cli/src/host-volumes.js";
import {
  dispatchedWorkspacePlan,
  placeWorkspaceMounts,
  volumeMountRequirements,
} from "../packages/control-plane/src/label-placement.js";
import { artifactVolumeLabel, type TaskNamedWorkspacePlan } from "../packages/core/src/index.js";
import { assertWorkspaceMountPaths, parseWorkspaceMounts } from "../packages/core/src/workspace.js";
import {
  type EnvironmentPlan,
  type ResolutionContext,
  WorkspaceEnvironmentResolver,
} from "../packages/runtime/sdk/src/index.js";
import { SandboxWorkspaceEnvironment } from "../packages/runtime/sdk/src/sandbox-workspace-environment.js";
import { workspaceDevcontainerFixture } from "./support/workspace-devcontainer.js";

const mount = {
  volume: "data",
  path: "/mnt/data",
  access: "read-only",
  strategy: "mount",
} as const;
const plan: TaskNamedWorkspacePlan = {
  version: 1,
  status: "workspace",
  workspace: "app",
  source: "https://example.test/app.git",
  branch: "supertag/task",
  delivery: "branch",
  mounts: [mount],
};
const emptyPlan: EnvironmentPlan = {
  files: [],
  mounts: [],
  secretBindings: [],
  environmentVariables: {},
  network: { mode: "none" },
};
function environment() {
  const create = vi.fn(async () => {
    throw new Error("provider must not be called");
  });
  const env = new SandboxWorkspaceEnvironment({
    stagingDirectory: "/unused",
    driver: {
      provider: "modal",
      base: "image",
      workspaceDirectory: "/workspace/repo",
      transferDirectory: "/transfer",
      mounts: { strategies: ["copy", "mount"], access: ["read-only"] },
      backend: {
        capabilities: {
          networkModes: ["none"],
          readOnlyMounts: true,
          boundedSymlinkSafeReads: true,
          streamOutput: true,
        },
      },
      build: vi.fn(),
      remove: vi.fn(),
      create,
    },
  });
  return { env, create };
}

describe.each(["copy", "mount"] as const)("%s mount paths", (strategy) => {
  it("names both paths for checkout, staged-file, and mount overlaps", () => {
    const mounts = [{ ...mount, strategy }];
    expect(() => assertWorkspaceMountPaths(mounts, "/mnt/data/repo", [])).toThrow(
      "Workspace mount data path /mnt/data overlaps the checkout /mnt/data/repo",
    );
    expect(() => assertWorkspaceMountPaths(mounts, "/workspace/repo", ["/mnt/data/token"])).toThrow(
      "Workspace mount data path /mnt/data overlaps a staged file /mnt/data/token",
    );
    const overlapping = [
      ...mounts,
      { ...mount, volume: "other", path: "/mnt/data/child", strategy: "mount" as const },
    ];
    expect(() => assertWorkspaceMountPaths(overlapping, "/workspace/repo", [])).toThrow(
      "Workspace mount data path /mnt/data overlaps another mount other path /mnt/data/child",
    );
    expect(() => parseWorkspaceMounts(overlapping)).toThrow(
      "Workspace mount other path /mnt/data/child overlaps another mount data path /mnt/data",
    );
    expect(() =>
      assertWorkspaceMountPaths(
        [...mounts, { ...mount, path: "/mnt/database" }],
        "/mnt/data-repo",
        ["/mnt/data-token"],
      ),
    ).not.toThrow();
  });

  it.each([
    { files: [{ path: "data/token", content: "secret" }] },
    {
      mounts: [
        { source: { uri: "file:///host/input" }, destination: "data/input", readOnly: true },
      ],
    },
    { secretBindings: [{ secretRef: "key", target: "data/key" }] },
  ])(
    "refuses every staged target before resolving sources or creating a sandbox: %j",
    async (staged) => {
      const { env, create } = environment();
      const resolve = vi.fn();
      await expect(
        env.start(
          {
            provider: "modal",
            artifact: "image",
            digest: "sha256:test",
            trustedCommit: "a".repeat(40),
          },
          {
            taskId: "t",
            attemptId: "a",
            base: "a".repeat(40),
            head: "a".repeat(40),
            branch: "supertag/task",
            mounts: [{ ...mount, strategy, path: "/workspace/data" }],
            plan: { ...emptyPlan, ...staged },
            volumes: { resolve },
          },
        ),
      ).rejects.toThrow(/\/workspace\/data overlaps a staged file \/workspace\/data\//u);
      expect(resolve).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );
});

function catalog(source: string, artifactSource = "s3://bucket/artifacts/", recorded = false) {
  const volumes = [
    { id: "art", name: "artifacts", source: artifactSource, credential: "private" },
    { id: "data", name: "data", source, credential: "data" },
  ];
  return {
    findVolumeByName: async (name: string) => volumes.find((volume) => volume.name === name),
    listVolumes: async () => volumes,
    listWorkerHosts: async () => [
      { labels: recorded ? [] : [artifactVolumeLabel("artifacts")], workerSnapshot: {} },
    ],
    listVolumeIdsHoldingArtifacts: async () => (recorded ? ["art"] : []),
  };
}

describe("native artifact-Volume protection", () => {
  it.each([
    "s3://bucket/artifacts",
    "s3://bucket/artifacts///",
    "s3://bucket/arti%66acts/child/",
    "s3://bucket/",
    "s3://bucket/artifacts?region=eu-west-1&forcePathStyle=true",
    "r2://bucket/artifacts/?endpoint=https://s3.eu-west-1.amazonaws.com",
  ])("rejects normalized source overlap at placement and dispatch: %s", async (source) => {
    for (const recorded of [false, true]) {
      const store = catalog(source, undefined, recorded);
      expect(await volumeMountRequirements(store, plan)).toEqual([
        {
          volume: "data",
          refused: "Volume data overlaps artifact Volume artifacts and cannot be mounted",
        },
      ]);
      expect(await dispatchedWorkspacePlan(store, plan)).toMatchObject({ volumes: [] });
    }
  });

  it("fails closed when an artifact holder's source cannot be compared", async () => {
    const store = catalog("s3://bucket/data", "invalid://artifact-source");
    expect(await volumeMountRequirements(store, plan)).toEqual([
      {
        volume: "data",
        refused: expect.stringMatching(/cannot be checked.*artifact Volume artifacts/u),
      },
    ]);
    expect(await dispatchedWorkspacePlan(store, plan)).toMatchObject({ volumes: [] });
  });

  it.each([
    "s3://bucket/artifacts-other",
    "s3://other/artifacts",
    "s3://bucket/artifacts?endpoint=https://other.example",
  ])("allows a separate location: %s", async (source) => {
    expect(await volumeMountRequirements(catalog(source), plan)).toEqual([
      { volume: "data", credential: "data", strategy: "mount", access: "read-only" },
    ]);
  });

  it.each([
    { name: "artifacts", source: "s3://bucket/elsewhere", credential: "data" },
    {
      name: "data",
      source: "r2://bucket/arti%66acts/child/?endpoint=https://s3.eu-west-1.amazonaws.com",
      credential: "data",
    },
    { name: "data", source: "file:///srv/artifacts" },
  ])(
    "F1 rechecks host artifact protection before prepare without reading secrets: %j",
    async (volume) => {
      const { env } = environment();
      const prepare = vi.spyOn(env, "prepare");
      const readCredential = vi.fn();
      const resolver = new WorkspaceEnvironmentResolver({
        checkouts: [],
        worktreeRoot: "/unused",
        environments: { modal: env },
        volumes: hostVolumeResolver({
          readCredential,
          protectedDirectories: [],
          artifactVolume: {
            name: "artifacts",
            source: async () => "s3://bucket/artifacts/",
          },
        }),
      });
      await expect(
        resolver.resolve({
          profile: { execution: { provider: "modal" }, harness: { provider: "codex" } },
          task: {
            taskId: "t",
            attemptId: "a",
            workspacePlan: {
              ...plan,
              mounts: [{ ...mount, volume: volume.name }],
              volumes: [volume],
            },
          },
        } as ResolutionContext),
      ).rejects.toThrow(
        /(?:holds artifacts|overlaps artifact Volume artifacts|protected.*file|file.*protected)/u,
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(readCredential).not.toHaveBeenCalled();
    },
  );
});

it("F3 reports the advertised native-mount capability gap without guessing a provider", () => {
  const result = placeWorkspaceMounts(
    [{ allowedWorkerHostIds: ["custom-host"], requires: [] }],
    [
      {
        id: "custom-host",
        enrollmentStatus: "active",
        labels: [],
        workerSnapshot: {
          workers: [
            {
              profileCapabilities: [
                { capabilities: [{ id: "supertag.workspace.mount.copy", version: 1 }] },
              ],
            },
          ],
        },
      },
    ],
    [mount],
  );
  expect(result).toMatchObject({
    status: "unmet",
    workspaceRefusals: [
      "Workspace mount data: native mount is unsupported on Worker Host custom-host; no profile advertises native read-only mount support",
    ],
  });
});

it("resolves native metadata without opening host copy credentials", async () => {
  const readCredential = vi.fn();
  const resolver = hostVolumeResolver({
    readCredential,
    readMountCredential: async () => ({ "modal-secret": "dataset-access" }),
    protectedDirectories: [],
    artifactVolume: {
      name: "artifacts",
      source: async () => "s3://bucket/artifacts/",
    },
  });
  await expect(
    resolver.resolveMount?.("data", {
      taskId: "t",
      attemptId: "a",
      volumes: [{ name: "data", source: "s3://bucket/data/", credential: "copy-key" }],
    }),
  ).resolves.toEqual({
    volume: "data",
    source: "s3://bucket/data/",
    nativeCredential: { "modal-secret": "dataset-access" },
  });
  expect(readCredential).not.toHaveBeenCalled();
});

it.each([
  "s3://bucket/artifacts",
  "s3://bucket/arti%66acts/child/?forcePathStyle=true&region=eu-west-1",
  "r2://bucket/artifacts/?endpoint=https://s3.eu-west-1.amazonaws.com",
])("the reusable host guard refuses normalized aliases: %s", async (source) => {
  await expect(
    assertHostVolumeMountable(
      {
        readCredential: vi.fn(),
        protectedDirectories: [],
        artifactVolume: {
          name: "artifacts",
          source: async () => "s3://bucket/artifacts/",
        },
      },
      "data",
      { taskId: "t", attemptId: "a", volumes: [{ name: "data", source }] },
    ),
  ).rejects.toThrow(/overlaps artifact Volume artifacts/u);
});

it.each(["unreadable", "invalid"])(
  "refuses native resolution when the host artifact source is %s",
  async (mode) => {
    await expect(
      assertHostVolumeMountable(
        {
          readCredential: vi.fn(),
          protectedDirectories: [],
          artifactVolume: {
            name: "artifacts",
            source: async () => {
              if (mode === "unreadable") throw new Error("catalog offline");
              return "invalid://source";
            },
          },
        },
        "data",
        { taskId: "t", attemptId: "a", volumes: [{ name: "data", source: "s3://bucket/data/" }] },
      ),
    ).rejects.toThrow(/cannot be checked against artifact Volume artifacts/u);
  },
);

it("rejects descendants of another host's protected file Volume", async () => {
  await expect(
    assertHostVolumeMountable({ readCredential: vi.fn(), protectedDirectories: [] }, "data", {
      taskId: "t",
      attemptId: "a",
      volumes: [
        { name: "data", source: "file:///srv/artifacts/child", credential: "data" },
        { name: "foreign-artifacts", source: "file:///srv/artifacts/" },
      ],
    }),
  ).rejects.toThrow(/overlaps protected file Volume foreign-artifacts/u);
});

it("refuses native resolution when the host provides no source guard", async () => {
  const { env } = environment();
  const resolve = vi.fn();
  const resolver = new WorkspaceEnvironmentResolver({
    checkouts: [],
    worktreeRoot: "/unused",
    environments: { modal: env },
    volumes: { resolve },
  });
  await expect(
    resolver.resolve({
      profile: { execution: { provider: "modal" }, harness: { provider: "codex" } },
      task: {
        taskId: "t",
        attemptId: "a",
        workspacePlan: { ...plan, volumes: [{ name: "data", source: "s3://bucket/data" }] },
      },
    } as ResolutionContext),
  ).rejects.toThrow(/data.*no native mount source guard/u);
  expect(resolve).not.toHaveBeenCalled();
});

it("keeps native metadata free of credentials when the same Volume also has a copy mount", async () => {
  const fixture = await workspaceDevcontainerFixture({ "README.md": "mount security fixture" });
  try {
    const { env } = environment();
    vi.spyOn(env, "refuse").mockReturnValue(undefined);
    vi.spyOn(env, "refuseMount").mockReturnValue(undefined);
    vi.spyOn(env, "prepare").mockImplementation(async (definition) => ({
      provider: "modal",
      artifact: "image",
      digest: "sha256:test",
      trustedCommit: definition.trustedCommit,
    }));
    const credentials = vi.fn(async () => ({
      accessKeyId: "copy-key",
      secretAccessKey: "copy-secret",
    }));
    const resolveMount = vi.fn(async () => ({
      volume: "data",
      source: "s3://bucket/data/",
      credentials,
    }));
    const resolver = new WorkspaceEnvironmentResolver({
      checkouts: [],
      cloneSources: true,
      worktreeRoot: join(fixture.root, "worktrees"),
      environments: { modal: env },
      volumes: { resolve: resolveMount, resolveMount },
    });
    const start = vi.spyOn(env, "start").mockImplementation(async (_prepared, checkout) => {
      const task = { taskId: "t", attemptId: "a" };
      const native = await checkout.volumes?.resolveMount?.("data", task);
      expect(native).toEqual({ volume: "data", source: "s3://bucket/data/" });
      const copy = await checkout.volumes?.resolve("data", task);
      expect(await copy?.credentials?.()).toEqual({
        accessKeyId: "copy-key",
        secretAccessKey: "copy-secret",
      });
      await expect(
        checkout.volumes?.resolveMount?.("data", { ...task, attemptId: "other" }),
      ).rejects.toThrow(/not resolved/u);
      await expect(checkout.volumes?.resolveMount?.("undeclared", task)).rejects.toThrow(
        /not resolved/u,
      );
      throw new Error("verified source separation before attachment");
    });
    await resolver.resolve({
      profile: { execution: { provider: "modal" }, harness: { provider: "codex" } },
      task: {
        taskId: "t",
        attemptId: "a",
        authorization: { runtimeActions: ["files:write"] },
        workspacePlan: {
          ...plan,
          source: pathToFileURL(fixture.repository).href,
          mounts: [mount, { ...mount, strategy: "copy", path: "/mnt/copy" }],
          volumes: [{ name: "data", source: "s3://bucket/data/", credential: "copy-key" }],
        },
      },
    } as ResolutionContext);
    await expect(resolver.startWorkspaceSandbox("a", { mode: "none" })).rejects.toThrow(
      "verified source separation before attachment",
    );
    expect(start).toHaveBeenCalledOnce();
  } finally {
    await fixture.cleanup();
  }
});
