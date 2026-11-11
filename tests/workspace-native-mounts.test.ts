import { describe, expect, it, vi } from "vitest";
import {
  placeWorkspaceMounts,
  volumeMountRequirements,
} from "../packages/control-plane/src/label-placement.js";
import { volumeCredentialLabel } from "../packages/core/src/index.js";
import { E2BWorkspaceEnvironment } from "../packages/runtime/environments/e2b/src/index.js";
import { ModalWorkspaceEnvironment } from "../packages/runtime/environments/modal/src/index.js";
import {
  type ResolutionContext,
  WorkspaceEnvironmentResolver,
} from "../packages/runtime/sdk/src/index.js";
import type {
  PreparedWorkspace,
  TaskCheckout,
} from "../packages/runtime/sdk/src/workspace-environment.js";

const mount = {
  volume: "datasets",
  path: "/mnt/datasets",
  strategy: "mount",
  access: "read-only",
} as const;
const native = { id: "supertag.workspace.mount.native", version: 1 };
const copy = { id: "supertag.workspace.mount.copy", version: 1 };
const nativeWrite = { id: "supertag.workspace.mount.native.write", version: 1 };
const copyWrite = { id: "supertag.workspace.mount.copy.write", version: 1 };
const host = (capabilities: unknown[], labels = [volumeCredentialLabel("data")]) => ({
  id: "host",
  enrollmentStatus: "active" as const,
  labels: [],
  workerSnapshot: { labels, workers: [{ profileCapabilities: [{ capabilities }] }] },
});
const tiers = [{ allowedWorkerHostIds: ["host"], requires: [] }];

describe("native Workspace mounts", () => {
  it("refuses copy-only placement and never downgrades the requested strategy", () => {
    expect(placeWorkspaceMounts(tiers, [host([copy])], [mount])).toMatchObject({
      status: "unmet",
      requirement: "workspace.mount.mount:datasets",
      workspaceRefusals: [
        expect.stringMatching(/datasets.*native mount.*unsupported.*no profile advertises native/u),
      ],
    });
    expect(
      placeWorkspaceMounts(tiers, [host([native])], [{ ...mount, credential: "data" }]),
    ).toEqual({
      status: "eligible",
      tiers: [{ ...tiers[0], requires: [native] }],
    });
  });

  it("preserves native requirements through Volume lookup without requiring host copy credentials", async () => {
    const requirements = await volumeMountRequirements(
      {
        findVolumeByName: async () => ({ source: "s3://bucket/data/", credential: "data" }),
        listVolumes: async () => [],
        listWorkerHosts: async () => [],
        listVolumeIdsHoldingArtifacts: async () => [],
      },
      {
        version: 1,
        status: "workspace",
        workspace: "research",
        source: "https://example.test/repo.git",
        branch: "supertag/task",
        delivery: "branch",
        mounts: [mount],
      },
    );
    expect(requirements).toEqual([
      { volume: "datasets", credential: "data", strategy: "mount", access: "read-only" },
    ]);
    expect(placeWorkspaceMounts(tiers, [host([native])], requirements)).toMatchObject({
      status: "eligible",
    });
    expect(placeWorkspaceMounts(tiers, [host([copy])], requirements)).toMatchObject({
      status: "unmet",
    });
  });

  it("requires one profile to support the mount and the rest of placement", () => {
    const split = host([]);
    split.workerSnapshot.workers = [
      { profileCapabilities: [{ capabilities: [native] }, { capabilities: [copy] }] },
    ];
    expect(
      placeWorkspaceMounts(
        [{ allowedWorkerHostIds: ["host"], requires: [copy] }],
        [split],
        [{ ...mount, credential: "data" }],
      ),
    ).toMatchObject({
      status: "unmet",
    });
    expect(
      placeWorkspaceMounts(
        tiers,
        [host([native])],
        [{ ...mount, access: "read-write", credential: "data" }],
      ),
    ).toMatchObject({
      status: "unmet",
      workspaceRefusals: [expect.stringMatching(/datasets.*read-write/u)],
    });
  });

  it.each([
    ["mount", native, nativeWrite],
    ["copy", copy, copyWrite],
  ] as const)(
    "places writable %s mounts only on a profile advertising write support",
    async (strategy, read, write) => {
      const writable = { ...mount, strategy, access: "read-write", credential: "data" } as const;
      expect(placeWorkspaceMounts(tiers, [host([read, write])], [writable])).toEqual({
        status: "eligible",
        tiers: [{ ...tiers[0], requires: [read, write] }],
      });
      const split = host([]);
      split.workerSnapshot.workers = [
        { profileCapabilities: [{ capabilities: [read] }, { capabilities: [write] }] },
      ];
      expect(placeWorkspaceMounts(tiers, [split], [writable])).toMatchObject({ status: "unmet" });
      const requirements = await volumeMountRequirements(
        {
          findVolumeByName: async () => ({ source: "s3://bucket/data/", credential: "data" }),
          listVolumes: async () => [],
          listWorkerHosts: async () => [],
          listVolumeIdsHoldingArtifacts: async () => [],
        },
        {
          version: 1,
          status: "workspace",
          workspace: "research",
          source: "https://example.test/repo.git",
          branch: "supertag/task",
          delivery: "branch",
          mounts: [writable],
        },
      );
      expect(requirements).toEqual([
        { volume: "datasets", strategy, access: "read-write", credential: "data" },
      ]);
    },
  );

  it("rejects local mounts before accessing checkout paths", async () => {
    const resolver = new WorkspaceEnvironmentResolver({ checkouts: [], worktreeRoot: "/unused" });
    await expect(
      resolver.environment.start({} as PreparedWorkspace, { mounts: [mount] } as TaskCheckout),
    ).rejects.toThrow(/datasets.*local.*mount/u);
  });

  it("rejects e2b before prepare, start, credential resolution, or any cloud call", async () => {
    const build = vi.fn();
    const environment = new E2BWorkspaceEnvironment({
      stagingDirectory: "/unused",
      templateClient: { build, delete: vi.fn() },
    });
    const prepare = vi.spyOn(environment, "prepare");
    const start = vi.spyOn(environment, "start");
    const resolve = vi.fn();
    const resolver = new WorkspaceEnvironmentResolver({
      checkouts: [],
      worktreeRoot: "/unused",
      environments: { e2b: environment },
      volumes: { resolve },
    });
    await expect(
      resolver.resolve({
        profile: { execution: { provider: "e2b" } },
        task: {
          taskId: "task",
          attemptId: "attempt",
          workspacePlan: {
            version: 1,
            status: "workspace",
            workspace: "research",
            source: "https://example.test/repo.git",
            branch: "supertag/task",
            delivery: "branch",
            mounts: [mount],
          },
        },
      } as ResolutionContext),
    ).rejects.toThrow(/datasets.*keys inside the sandbox/u);
    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    await expect(
      environment.start({} as PreparedWorkspace, { mounts: [mount] } as TaskCheckout),
    ).rejects.toThrow(/keys inside the sandbox/u);
  });

  it("advertises Modal support but refuses missing native credentials without copying or creating a sandbox", async () => {
    const buildImage = vi.fn();
    const createSetupSandbox = vi.fn();
    const sandboxFactory = { create: vi.fn() };
    const environment = new ModalWorkspaceEnvironment({
      appName: "test",
      stagingDirectory: "/unused",
      workspaceClient: { buildImage, createSetupSandbox, deleteImage: vi.fn() },
      sandboxFactory,
    });
    expect(environment.capabilities.mounts).toEqual({
      strategies: ["copy", "mount"],
      access: ["read-only", "read-write"],
    });
    const resolver = new WorkspaceEnvironmentResolver({
      checkouts: [],
      worktreeRoot: "/unused",
      environments: { modal: environment },
    });
    expect(resolver.supportsNativeMounts("modal")).toBe(true);
    expect(resolver.supportsNativeMounts("local-execution")).toBe(false);
    const credentials = vi.fn();
    const resolve = vi.fn(async () => ({
      volume: "datasets",
      source: "s3://bucket/data/",
      credentials,
    }));
    await expect(
      environment.start(
        {
          provider: "modal",
          artifact: "image",
          digest: "sha256:test",
          trustedCommit: "a".repeat(40),
        },
        {
          taskId: "t",
          attemptId: "a",
          branch: "supertag/task",
          base: "a".repeat(40),
          head: "a".repeat(40),
          plan: {
            files: [],
            mounts: [],
            secretBindings: [],
            environmentVariables: {},
            network: { mode: "none" },
          },
          mounts: [mount],
          volumes: { resolve, resolveMount: resolve },
        },
      ),
    ).rejects.toThrow(/datasets.*native mounts require a provider-held/u);
    expect(credentials).not.toHaveBeenCalled();
    expect(buildImage).not.toHaveBeenCalled();
    expect(createSetupSandbox).not.toHaveBeenCalled();
    expect(sandboxFactory.create).not.toHaveBeenCalled();
  });
});

it("places Modal Volumes only on hosts advertising their credential mapping", async () => {
  const requirements = await volumeMountRequirements(
    {
      findVolumeByName: async () => ({
        source: "modal-volume://Training/data/",
        credential: "data",
      }),
      listVolumes: async () => [],
      listWorkerHosts: async () => [],
      listVolumeIdsHoldingArtifacts: async () => [],
    },
    {
      version: 1,
      status: "workspace",
      workspace: "research",
      source: "https://example.test/repo.git",
      branch: "supertag/task",
      delivery: "branch",
      mounts: [mount],
    },
  );
  expect(placeWorkspaceMounts(tiers, [host([native], [])], requirements)).toMatchObject({
    status: "unmet",
    workspaceRefusals: [expect.stringMatching(/datasets.*no credential mapping.*host/)],
  });
  expect(placeWorkspaceMounts(tiers, [host([native])], requirements)).toMatchObject({
    status: "eligible",
  });
  expect(placeWorkspaceMounts(tiers, [host([native])], [mount])).toMatchObject({ status: "unmet" });
});
