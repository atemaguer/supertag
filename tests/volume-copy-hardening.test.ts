import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostVolumeResolver } from "../apps/cli/src/host-volumes.js";
import type { WorkspaceMount } from "../packages/core/src/index.js";
import {
  type LocalMountRoot,
  resolveLocalMountRoot,
} from "../packages/runtime/sdk/src/local-mount-root.js";
import {
  CopyBudget,
  copyWorkspaceMount,
  copyWorkspaceMounts,
  HostVolumeCopyTarget,
  pinWorkspaceVolumes,
  planWorkspaceMounts,
} from "../packages/runtime/sdk/src/volume-copy.js";
import { assertLocalWorkspaceMountPaths } from "../packages/runtime/sdk/src/workspace-mount-paths.js";
import { FakeS3 } from "./support/fake-s3.js";
import { removeSealedTree } from "./support/sealed-tree.js";

const host = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => host.home,
}));
vi.mock("../packages/runtime/sdk/src/task-writable-roots.js", () => ({
  taskWritableRoots: () => [],
}));

const LIMIT = 20 * 1024 ** 3;
const mountAt = (path: string): WorkspaceMount => ({
  volume: "data",
  path,
  access: "read-only",
  strategy: "copy",
  maxBytes: LIMIT,
});

describe("Workspace copy hardening", () => {
  let budget: CopyBudget;
  let scratch: string;
  let localMountRoot: LocalMountRoot;
  const copyTarget = (...args: ConstructorParameters<typeof HostVolumeCopyTarget>) =>
    new HostVolumeCopyTarget(args[0], args[1], localMountRoot);
  let source: string;
  let destination: string;
  let s3: FakeS3 | undefined;
  beforeEach(async () => {
    budget = new CopyBudget();
    scratch = await realpath(await mkdtemp(join(tmpdir(), "mount-hardening-")));
    host.home = join(scratch, "home");
    source = join(host.home, "data");
    destination = join(scratch, "copies", "data");
    await mkdir(source, { recursive: true });
    await mkdir(join(scratch, "copies"));
    localMountRoot = await resolveLocalMountRoot(join(scratch, "copies"));
    await writeFile(join(source, "rows"), "rows");
  });
  afterEach(async () => {
    await s3?.close();
    s3 = undefined;
    await removeSealedTree(scratch);
  });
  const volume = () => ({ volume: "data", source: pathToFileURL(source).href });
  const task = () => ({
    taskId: "t",
    attemptId: "a",
    volumes: [{ name: "data", source: pathToFileURL(source).href, credential: "data" }],
  });

  it("refuses hard-linked files before creating a destination", async () => {
    await writeFile(join(scratch, "secret"), "host secret");
    await link(join(scratch, "secret"), join(source, "leaked"));
    await expect(
      copyWorkspaceMount({
        budget,
        mount: mountAt(destination),
        volume: volume(),
        target: copyTarget(),
      }),
    ).rejects.toThrow(/hard link/u);
    await expect(lstat(destination)).rejects.toThrow();
  });

  it("rechecks the opened file's link count after listing", async () => {
    const planned = await planWorkspaceMounts({
      mounts: [mountAt(destination)],
      volumes: { resolve: async () => volume() },
      task: task(),
    });
    await link(join(source, "rows"), join(scratch, "late-link"));
    let copied = 0;
    try {
      await expect(
        planned.copy({
          async create() {},
          async mkdir() {},
          async seal() {},
          async write(_path, chunks) {
            for await (const chunk of chunks) copied += chunk.byteLength;
          },
        }),
      ).rejects.toThrow(/hard link/u);
      expect(copied).toBe(0);
    } finally {
      planned.close();
    }
  });

  it.each([".config", "Library", "lIbRaRy"])(
    "rechecks home consent after pinning when a source moves to %s",
    async (name) => {
      const protectedHome = join(host.home, name);
      await mkdir(protectedHome);
      await writeFile(join(protectedHome, "secret"), "host secret");
      const mounts = [mountAt(destination)];
      const resolver = hostVolumeResolver({
        readCredential: async () => ({ path: host.home }),
        protectedDirectories: [],
      });
      const pinned = await pinWorkspaceVolumes({ mounts, volumes: resolver, task: task() });
      await rename(source, `${source}-original`);
      await symlink(protectedHome, source);
      await expect(
        copyWorkspaceMounts({
          mounts,
          volumes: pinned,
          task: task(),
          target: copyTarget(),
        }),
      ).rejects.toThrow(/explicit host path consent/u);
      await expect(lstat(destination)).rejects.toThrow();
    },
  );

  it.each(["", ".."])(
    "refuses a source redirected to home or its ancestor (%s)",
    async (suffix) => {
      const mounts = [mountAt(destination)];
      const resolver = hostVolumeResolver({
        readCredential: async () => ({ path: scratch }),
        protectedDirectories: [],
      });
      const pinned = await pinWorkspaceVolumes({ mounts, volumes: resolver, task: task() });
      await rename(source, `${source}-original`);
      await symlink(join(host.home, suffix), source);
      await expect(
        copyWorkspaceMounts({
          mounts,
          volumes: pinned,
          task: task(),
          target: copyTarget(),
        }),
      ).rejects.toThrow(/contains the Worker Host home directory/u);
      await expect(lstat(destination)).rejects.toThrow();
    },
  );

  it("keeps exact consent for a home configuration source valid", async () => {
    source = join(host.home, ".config", "data");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "rows"), "allowed");
    const resolver = hostVolumeResolver({
      readCredential: async () => ({ path: source }),
      protectedDirectories: [],
    });
    const manifests = await copyWorkspaceMounts({
      mounts: [mountAt(destination)],
      volumes: resolver,
      task: task(),
      target: copyTarget(),
    });
    expect(manifests[0]?.totalBytes).toBe(7);
  });

  it("rechecks home consent again between listing and reading", async () => {
    const planned = await planWorkspaceMounts({
      mounts: [mountAt(destination)],
      volumes: { resolve: async () => ({ ...volume(), consentDirectory: host.home }) },
      task: task(),
    });
    // Keep the file inode unchanged while moving its directory into a home config location.
    const config = join(host.home, ".config");
    await rename(source, config);
    await symlink(config, source);
    let copied = 0;
    try {
      await expect(
        planned.copy({
          async create() {},
          async mkdir() {},
          async seal() {},
          async write(_path, chunks) {
            for await (const chunk of chunks) copied += chunk.byteLength;
          },
        }),
      ).rejects.toThrow(/explicit host path consent/u);
      expect(copied).toBe(0);
    } finally {
      planned.close();
    }
  });

  it("rechecks home destination rules after resolving mount paths", async () => {
    const alias = join(scratch, "alias");
    await symlink(join(scratch, "copies"), alias);
    const mount = mountAt(join(alias, "data"));
    await assertLocalWorkspaceMountPaths([mount], join(scratch, "checkout"), [], []);
    const config = join(host.home, ".config");
    await mkdir(config);
    await unlink(alias);
    await symlink(config, alias);
    await expect(
      copyWorkspaceMount({ budget, mount, volume: volume(), target: copyTarget() }),
    ).rejects.toThrow(/local-mount-root/u);
    await expect(lstat(join(config, "data"))).rejects.toThrow();
  });

  it.each(["file", "s3", "mixed"])(
    "caps all %s mounts together before copying any bytes",
    async (kind) => {
      await truncate(join(source, "rows"), LIMIT / 2 + 1);
      s3 = await FakeS3.start();
      s3.put("data", "prefix/rows", "rows", LIMIT / 2 + 1);
      const cloud = {
        volume: "data",
        source: `s3://data/prefix?region=us-east-1&endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`,
        credentials: async () => ({
          accessKeyId: "fake-access-key",
          secretAccessKey: "secret",
        }),
      };
      let resolves = 0;
      const target = {
        create: vi.fn(async () => {
          throw new Error("copy started before refusing the aggregate limit");
        }),
        mkdir: vi.fn(),
        write: vi.fn(),
        seal: vi.fn(),
      };
      await expect(
        copyWorkspaceMounts({
          mounts: [mountAt(destination), mountAt(`${destination}-second`)],
          volumes: {
            resolve: async () =>
              kind === "file" || (kind === "mixed" && resolves++ === 0) ? volume() : cloud,
          },
          task: task(),
          target,
        }),
      ).rejects.toThrow(/Task Attempt.*21474836480-byte limit/u);
      expect(target.create).not.toHaveBeenCalled();
      expect(s3.downloads).toHaveLength(0);
    },
  );

  it("accepts exactly the aggregate limit and gives each plan its own budget", async () => {
    await truncate(join(source, "rows"), LIMIT / 2);
    for (const attemptId of ["a", "b"]) {
      const planned = await planWorkspaceMounts({
        mounts: [mountAt(destination), mountAt(`${destination}-second`)],
        volumes: { resolve: async () => volume() },
        task: { ...task(), attemptId },
      });
      planned.close();
    }
  });
});
