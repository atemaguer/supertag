import { type ResolutionContext, WorkspaceEnvironmentResolver } from "@supertag/worker-sdk";
import { ModalClient } from "modal";
import { afterEach, expect, it, vi } from "vitest";
import { hostVolumeResolver } from "../../../../apps/cli/src/host-volumes.js";
import { ModalWorkspaceEnvironment, nativeModalSandboxFactory } from "./src/index.js";

vi.mock("modal", () => ({ ModalClient: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("attaches provider-held bucket credentials and read-only Volume subpaths only to sandbox creation", async () => {
  const secret = { id: "secret-id" };
  const fromName = vi.fn(async () => secret);
  const withMountOptions = vi.fn((options) => ({ kind: "volume", ...options }));
  const volumeFromName = vi.fn(async () => ({ withMountOptions }));
  const bucketCreate = vi.fn((bucket, options) => ({ bucket, ...options }));
  const terminate = vi.fn(async () => 0);
  const create = vi.fn(async (_app, _image, params) => ({
    sandboxId: "sandbox",
    terminate,
    exec: async (command: string[]) => ({
      stdin: { writeBytes: async () => {}, close: async () => {} },
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      wait: async () =>
        command[0] === "write" &&
        (params.cloudBucketMounts[command[1] ?? ""] ?? params.volumes[command[1] ?? ""])?.readOnly
          ? 1
          : 0,
    }),
  }));
  const close = vi.fn();
  vi.mocked(ModalClient).mockImplementation(function MockModalClient() {
    return {
      apps: { fromName: async () => ({}) },
      images: { fromId: async () => ({}) },
      secrets: { fromName },
      volumes: { fromName: volumeFromName },
      cloudBucketMounts: { create: bucketCreate },
      sandboxes: { create },
      close,
    } as unknown as ModalClient;
  });
  const consented = await hostVolumeResolver({
    protectedDirectories: [],
    readCredential: vi.fn(),
    readMountCredential: async () => ({ "modal-volume": "Training" }),
  }).resolveMount?.("volume", {
    taskId: "t",
    attemptId: "a",
    volumes: [
      { name: "volume", source: "modal-volume://Training/models/", credential: "team-data" },
    ],
  });
  if (!consented) throw new Error("missing resolved Modal Volume");
  const mounts = [
    {
      volume: "s3",
      path: "/mnt/s3",
      source: "s3://datasets/train/",
      nativeCredential: { "modal-secret": "dataset-access" },
    },
    {
      volume: "r2",
      path: "/mnt/r2",
      source: "r2://datasets/train/?endpoint=https%3A%2F%2Facct.r2.cloudflarestorage.com",
      nativeCredential: { "modal-secret": "r2-access" },
    },
    {
      volume: "gcs",
      path: "/mnt/gcs",
      source: "gs://datasets/train/",
      nativeCredential: { "modal-secret": "gcs-access" },
    },
    {
      volume: "oidc",
      path: "/mnt/oidc",
      source: "s3://datasets/train/",
      nativeCredential: { "modal-oidc-role": "arn:aws:iam::123456789012:role/datasets" },
    },
    {
      ...consented,
      path: "/mnt/volume",
    },
    {
      volume: "writable-bucket",
      path: "/mnt/writable-bucket",
      source: "s3://datasets/output/",
      access: "read-write" as const,
      nativeCredential: { "modal-secret": "dataset-access" },
    },
    {
      ...consented,
      path: "/mnt/writable-volume",
      access: "read-write" as const,
    },
  ];
  const sandbox = await nativeModalSandboxFactory.create({
    appName: "test",
    environment: "host-environment",
    image: "unused",
    imageId: "image",
    createAppIfMissing: false,
    params: { blockNetwork: true },
    nativeMounts: mounts,
  });
  expect(fromName.mock.calls.map((c) => c[0])).toEqual([
    "dataset-access",
    "r2-access",
    "gcs-access",
    "dataset-access",
  ]);
  expect(ModalClient).toHaveBeenCalledWith({ environment: "host-environment" });
  expect(volumeFromName).toHaveBeenCalledWith("Training", {
    createIfMissing: false,
  });
  expect(withMountOptions).toHaveBeenCalledWith({ readOnly: true, subPath: "models/" });
  expect(withMountOptions).toHaveBeenCalledWith({ readOnly: false, subPath: "models/" });
  expect(bucketCreate).toHaveBeenCalledWith("datasets", {
    readOnly: false,
    keyPrefix: "output/",
    secret,
  });
  expect(bucketCreate).toHaveBeenCalledWith("datasets", {
    readOnly: true,
    keyPrefix: "train/",
    secret,
    bucketEndpointUrl: "https://storage.googleapis.com",
  });
  expect(bucketCreate).toHaveBeenCalledWith("datasets", {
    readOnly: true,
    keyPrefix: "train/",
    oidcAuthRoleArn: "arn:aws:iam::123456789012:role/datasets",
  });
  const params = create.mock.calls[0]?.[2];
  expect(params).toBeDefined();
  expect(params.secrets).toBeUndefined();
  expect(params.env).toBeUndefined();
  expect(params.blockNetwork).toBe(true);
  for (const path of ["/mnt/s3", "/mnt/r2", "/mnt/gcs", "/mnt/oidc", "/mnt/volume"]) {
    const process = await sandbox.exec(["write", path], { mode: "binary" });
    expect(await process.wait()).toBe(1);
  }
  for (const path of ["/mnt/writable-bucket", "/mnt/writable-volume"]) {
    const process = await sandbox.exec(["write", path], { mode: "binary" });
    expect(await process.wait()).toBe(0);
  }
  await sandbox.terminate({ wait: true });
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  "file:///srv/data",
  "s3://datasets/prefix",
  "s3://datasets/prefix/?forcePathStyle=true",
  "s3://datasets/prefix/?endpoint=https%3A%2F%2Fstore.example%2Fpath",
])("refuses unsupported native source before any Modal call: %s", async (source) => {
  const environment = new ModalWorkspaceEnvironment({
    appName: "test",
    stagingDirectory: "/unused",
  });
  expect(
    environment.refuseMount(
      { volume: "data", path: "/mnt/data", strategy: "mount", access: "read-only" },
      { volume: "data", source, nativeCredential: { "modal-secret": "dataset-access" } },
    ),
  ).toMatch(/data/);
  const resolve = vi.fn();
  const resolveMount = vi.fn(async () => ({
    volume: "data",
    source,
    nativeCredential: { "modal-secret": "dataset-access" },
  }));
  const prepare = vi.spyOn(environment, "prepare");
  const resolver = new WorkspaceEnvironmentResolver({
    checkouts: [],
    cloneSources: true,
    worktreeRoot: "/unused",
    environments: { modal: environment },
    volumes: { resolve, resolveMount },
  });
  await expect(
    resolver.resolve({
      profile: { execution: { provider: "modal" } },
      task: {
        taskId: "t",
        attemptId: "a",
        workspacePlan: {
          version: 1,
          status: "workspace",
          workspace: "app",
          source: "https://example.test/app.git",
          branch: "supertag/test",
          delivery: "branch",
          mounts: [{ volume: "data", path: "/mnt/data", strategy: "mount", access: "read-only" }],
        },
      },
    } as ResolutionContext),
  ).rejects.toThrow(/data/);
  expect(resolveMount).toHaveBeenCalledOnce();
  expect(resolve).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(ModalClient).not.toHaveBeenCalled();
});

it.each([
  { source: "modal-volume://Training/models/" },
  { source: "modal-volume://Training/models/", nativeCredential: { "modal-volume": "training" } },
  { source: "modal-volume://Training/models/", nativeCredential: { "modal-secret": "Training" } },
  {
    source: "modal-volume://Training/models/?environment=other",
    nativeCredential: { "modal-volume": "Training" },
  },
  { source: "s3://datasets/models/", nativeCredential: { "modal-volume": "Training" } },
])(
  "refuses unconsented or queried mounts before constructing a Modal client: %j",
  async (mount) => {
    await expect(
      nativeModalSandboxFactory.create({
        appName: "test",
        image: "unused",
        createAppIfMissing: false,
        params: {},
        nativeMounts: [{ volume: "data", path: "/mnt/data", ...mount }],
      }),
    ).rejects.toThrow(/Workspace mount data:/);
    expect(ModalClient).not.toHaveBeenCalled();
  },
);

it.each([undefined, "training"])(
  "refuses missing or mismatched host consent before preparing the workspace: %s",
  async (allowedName) => {
    const environment = new ModalWorkspaceEnvironment({
      appName: "test",
      stagingDirectory: "/unused",
    });
    const prepare = vi.spyOn(environment, "prepare");
    const readCredential = vi.fn();
    const resolver = new WorkspaceEnvironmentResolver({
      checkouts: [],
      cloneSources: true,
      worktreeRoot: "/unused",
      environments: { modal: environment },
      volumes: hostVolumeResolver({
        protectedDirectories: [],
        readCredential,
        readMountCredential: async () => {
          if (allowedName === undefined) throw new Error("unmapped");
          return { "modal-volume": allowedName };
        },
      }),
    });
    await expect(
      resolver.resolve({
        profile: { execution: { provider: "modal" } },
        task: {
          taskId: "t",
          attemptId: "a",
          workspacePlan: {
            version: 1,
            status: "workspace",
            workspace: "app",
            source: "https://example.test/app.git",
            branch: "supertag/test",
            delivery: "branch",
            mounts: [{ volume: "data", path: "/mnt/data", strategy: "mount", access: "read-only" }],
            volumes: [
              { name: "data", source: "modal-volume://Training/data/", credential: "team-data" },
            ],
          },
        },
      } as ResolutionContext),
    ).rejects.toThrow(/Volume data:.*modal-volume/);
    expect(prepare).not.toHaveBeenCalled();
    expect(ModalClient).not.toHaveBeenCalled();
    expect(readCredential).not.toHaveBeenCalled();
  },
);
