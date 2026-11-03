import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMount } from "../packages/core/src/index.js";
import {
  copyWorkspaceMount,
  copyWorkspaceMounts,
  type HostVolumeCopy,
  HostVolumeCopyTarget,
  removeHostVolumeCopy,
  type VolumeCopyTarget,
} from "../packages/runtime/sdk/src/index.js";
import {
  type LocalMountRoot,
  resolveLocalMountRoot,
} from "../packages/runtime/sdk/src/local-mount-root.js";
import { taskWritableRoots } from "../packages/runtime/sdk/src/task-writable-roots.js";
import { CopyBudget, HostCopyChangedError } from "../packages/runtime/sdk/src/volume-copy.js";
import { FakeS3 } from "./support/fake-s3.ts";
import { removeSealedTree } from "./support/sealed-tree.ts";

const directoryRace = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      await directoryRace.beforeOpen?.(String(args[0]));
      return actual.opendir(...args);
    },
  };
});

// Scratch directories live in the system temporary directory, which a real Worker Host refuses
// for local copies; these tests lift that refusal except where they check it.
vi.mock("../packages/runtime/sdk/src/task-writable-roots.js", () => ({
  taskWritableRoots: vi.fn(() => []),
}));

const mountAt = (path: string): WorkspaceMount => ({
  volume: "datasets",
  path,
  access: "read-only",
  strategy: "copy",
});

describe("Local Volume copies against a Task that swaps directories", () => {
  let budget: CopyBudget;
  let scratch: string;
  let localMountRoot: LocalMountRoot;
  const copyTarget = (...args: ConstructorParameters<typeof HostVolumeCopyTarget>) =>
    new HostVolumeCopyTarget(args[0], args[1], localMountRoot);
  let source: string;

  beforeEach(async () => {
    budget = new CopyBudget();
    scratch = await realpath(await mkdtemp(join(tmpdir(), "supertag-copy-races-")));
    localMountRoot = await resolveLocalMountRoot(scratch);
    source = join(scratch, "volume");
    await mkdir(source);
    await writeFile(join(source, "rows.csv"), "a,b\n");
  });
  afterEach(async () => {
    directoryRace.beforeOpen = undefined;
    vi.mocked(taskWritableRoots).mockImplementation(() => []);
    await removeSealedTree(scratch);
  });

  const volume = () => ({ volume: "datasets", source: pathToFileURL(source).href });

  it("refuses a directory swapped for a symlink between lstat and opendir", async () => {
    const nested = join(source, "nested");
    const outside = join(scratch, "outside");
    await mkdir(nested);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "do not copy\n");
    directoryRace.beforeOpen = async (path) => {
      if (path !== nested) return;
      directoryRace.beforeOpen = undefined;
      await rename(nested, `${nested}-moved`);
      await symlink(outside, nested);
    };
    const target = join(scratch, "mnt", "datasets");
    await expect(
      copyWorkspaceMount({
        budget,
        mount: mountAt(target),
        volume: volume(),
        target: copyTarget([]),
      }),
    ).rejects.toThrow(/source directory changed during listing/u);
    await expect(lstat(join(target, "nested", "secret.txt"))).rejects.toThrow();
  });

  it("refuses a listed file reached through a parent symlink at read time", async () => {
    const nested = join(source, "nested");
    const outside = join(scratch, "outside");
    await mkdir(nested);
    await mkdir(outside);
    await writeFile(join(nested, "secret.txt"), "do not copy\n");
    const inner = copyTarget([]);
    const racing: VolumeCopyTarget = {
      create: (path) => inner.create(path),
      mkdir: (path) => inner.mkdir(path),
      write: async (path, bytes) => {
        // Moving the directory preserves the listed inode without introducing a hard link.
        await rename(nested, join(outside, "moved"));
        await symlink(join(outside, "moved"), nested);
        await inner.write(path, bytes);
      },
      seal: (path) => inner.seal(path),
    };
    const target = join(scratch, "mnt", "datasets");
    await expect(
      copyWorkspaceMount({ budget, mount: mountAt(target), volume: volume(), target: racing }),
    ).rejects.toThrow(/changed while it was copied/u);
    expect(await readFile(join(target, "nested", "secret.txt"), "utf8")).toBe("");
  });

  it("never removes or unseals an operator directory behind a swapped parent", async () => {
    const operatorHome = join(scratch, "operator-home");
    await mkdir(join(operatorHome, "datasets"), { recursive: true });
    await writeFile(join(operatorHome, "datasets", "precious.txt"), "keep me\n");
    await writeFile(join(operatorHome, "datasets", "sealed.txt"), "x");
    await chmod(join(operatorHome, "datasets", "sealed.txt"), 0o444);
    const mountPath = join(scratch, "mnt", "datasets");
    let copy: HostVolumeCopy | undefined;
    await copyWorkspaceMount({
      budget,
      mount: mountAt(mountPath),
      volume: volume(),
      target: copyTarget([], async (created) => {
        copy = created;
      }),
    });
    // The Task, able to write the mount path's grandparent, swaps the parent for a symbolic link.
    await rename(join(scratch, "mnt"), join(scratch, "mnt-moved"));
    await symlink(operatorHome, join(scratch, "mnt"));

    await expect(removeHostVolumeCopy(copy as HostVolumeCopy)).rejects.toBeInstanceOf(
      HostCopyChangedError,
    );
    expect(await readdir(operatorHome)).toContain("datasets");
    expect(await readFile(join(operatorHome, "datasets", "precious.txt"), "utf8")).toBe(
      "keep me\n",
    );
    expect((await stat(join(operatorHome, "datasets", "sealed.txt"))).mode & 0o777).toBe(0o444);
  });

  it("writes no Volume file through a parent swapped between create and write", async () => {
    await writeFile(join(source, "planted"), "attacker data\n");
    const victim = join(scratch, "victim");
    await mkdir(join(victim, "datasets"), { recursive: true });
    const mountPath = join(scratch, "mnt", "datasets");
    const inner = copyTarget([]);
    const racing: VolumeCopyTarget = {
      create: async (path) => {
        await inner.create(path);
        await rename(join(scratch, "mnt"), join(scratch, "mnt-moved"));
        await symlink(victim, join(scratch, "mnt"));
      },
      mkdir: (path) => inner.mkdir(path),
      write: (path, bytes) => inner.write(path, bytes),
      seal: (path) => inner.seal(path),
    };
    await expect(
      copyWorkspaceMount({ budget, mount: mountAt(mountPath), volume: volume(), target: racing }),
    ).rejects.toThrow(/no longer the directory SuperTag verified/u);
    expect(await readdir(join(victim, "datasets"))).toEqual([]);
  });

  it("stops when a directory it created is swapped before a nested write", async () => {
    await mkdir(join(source, "nested"));
    await writeFile(join(source, "nested", "notes.txt"), "notes\n");
    const victim = join(scratch, "victim");
    await mkdir(victim);
    const mountPath = join(scratch, "mnt", "datasets");
    const inner = copyTarget([]);
    const racing: VolumeCopyTarget = {
      create: (path) => inner.create(path),
      mkdir: async (path) => {
        await inner.mkdir(path);
        await rename(path, `${path}-moved`);
        await symlink(victim, path);
      },
      write: (path, bytes) => inner.write(path, bytes),
      seal: (path) => inner.seal(path),
    };
    await expect(
      copyWorkspaceMount({ budget, mount: mountAt(mountPath), volume: volume(), target: racing }),
    ).rejects.toThrow(/no longer the directory SuperTag verified/u);
    expect(await readdir(victim)).toEqual([]);
  });

  it("refuses to seal a copy holding anything SuperTag did not write", async () => {
    const mountPath = join(scratch, "mnt", "datasets");
    const inner = copyTarget([]);
    const racing: VolumeCopyTarget = {
      create: (path) => inner.create(path),
      mkdir: (path) => inner.mkdir(path),
      write: async (path, bytes) => {
        await inner.write(path, bytes);
        await symlink(join(scratch, "volume"), join(mountPath, "escape"));
      },
      seal: (path) => inner.seal(path),
    };
    await expect(
      copyWorkspaceMount({ budget, mount: mountAt(mountPath), volume: volume(), target: racing }),
    ).rejects.toThrow(/holds "escape", which SuperTag did not copy/u);
  });

  it("removes a verified copy, and a link planted in it without following the link", async () => {
    const operator = join(scratch, "operator");
    await mkdir(operator);
    await writeFile(join(operator, "keep.txt"), "keep\n");
    const mountPath = join(scratch, "mnt", "datasets");
    let copy: HostVolumeCopy | undefined;
    await copyWorkspaceMount({
      budget,
      mount: mountAt(mountPath),
      volume: volume(),
      target: copyTarget([], async (created) => {
        copy = created;
      }),
    });
    expect((await stat(mountPath)).mode & 0o222).toBe(0);
    // An unsandboxed Task can restore write permission and plant links inside its copy.
    await chmod(mountPath, 0o755);
    await symlink(operator, join(mountPath, "link"));
    expect(await removeHostVolumeCopy(copy as HostVolumeCopy)).toBe("removed");
    await expect(lstat(mountPath)).rejects.toThrow();
    expect(await readFile(join(operator, "keep.txt"), "utf8")).toBe("keep\n");
    expect(await removeHostVolumeCopy(copy as HostVolumeCopy)).toBe("absent");
  });

  it("refuses a mount path inside a directory a local Task can write", async () => {
    const writable = join(scratch, "tmp");
    await mkdir(writable);
    vi.mocked(taskWritableRoots).mockImplementation(() => [writable]);
    await expect(
      copyWorkspaceMount({
        budget,
        mount: mountAt(join(writable, "mnt", "datasets")),
        volume: volume(),
        target: copyTarget([]),
      }),
    ).rejects.toThrow(/inside .*tmp, a temporary directory a local Task can write/u);
    // A path that resolves into one, through a link the operator made, is refused too.
    await symlink(writable, join(scratch, "via-link"));
    await expect(
      copyWorkspaceMount({
        budget,
        mount: mountAt(join(scratch, "via-link", "datasets")),
        volume: volume(),
        target: copyTarget([]),
      }),
    ).rejects.toThrow(/a temporary directory a local Task can write/u);
    expect(await readdir(writable)).toEqual([]);
  });

  it("names the temporary directories as writable by a local Task", async () => {
    const actual = await vi.importActual<
      typeof import("../packages/runtime/sdk/src/task-writable-roots.js")
    >("../packages/runtime/sdk/src/task-writable-roots.js");
    expect(actual.taskWritableRoots()).toEqual(expect.arrayContaining([tmpdir(), "/tmp"]));
  });

  it("refuses a file:// source in or containing a protected host directory", async () => {
    const state = join(source, "state");
    await mkdir(state);
    await expect(
      copyWorkspaceMounts({
        mounts: [mountAt(join(scratch, "mnt", "datasets"))],
        volumes: {
          protectedDirectories: [state],
          resolve: async () => volume(),
        },
        task: { taskId: "t", attemptId: "a" },
        target: copyTarget([]),
      }),
    ).rejects.toThrow(/holds SuperTag's own state on this Worker Host/u);
    await expect(lstat(join(scratch, "mnt", "datasets"))).rejects.toThrow();
  });
});

describe("Mount manifest size", () => {
  let budget: CopyBudget;
  let s3: FakeS3;
  let scratch: string;
  let localMountRoot: LocalMountRoot;
  const copyTarget = (...args: ConstructorParameters<typeof HostVolumeCopyTarget>) =>
    new HostVolumeCopyTarget(args[0], args[1], localMountRoot);
  beforeEach(async () => {
    budget = new CopyBudget();
    s3 = await FakeS3.start("manifest-access-key");
    scratch = await mkdtemp(join(tmpdir(), "supertag-manifest-size-"));
  });
  afterEach(async () => {
    await s3.close();
    await removeSealedTree(scratch);
  });

  it("refuses, before any download, a listing whose manifest would not fit in one event", async () => {
    // Keys of about 1,000 bytes, in segments a filesystem accepts.
    const long = Array.from({ length: 4 }, () => "k".repeat(240)).join("/");
    for (let index = 0; index < 2_100; index += 1)
      s3.put("data", `prefix/${String(index).padStart(5, "0")}/${long}`, "x");
    await expect(
      copyWorkspaceMount({
        budget,
        mount: mountAt(join(scratch, "mnt", "datasets")),
        volume: {
          volume: "datasets",
          source: `s3://data/prefix?endpoint=${encodeURIComponent(s3.endpoint)}&forcePathStyle=true`,
          credentials: async () => ({
            accessKeyId: "manifest-access-key",
            secretAccessKey: "manifest-secret",
          }),
        },
        target: copyTarget([]),
      }),
    ).rejects.toThrow(/mount manifests can record \(2097152 bytes as JSON\); SuperTag downloaded/u);
    expect(s3.downloads).toHaveLength(0);
    await expect(lstat(join(scratch, "mnt", "datasets"))).rejects.toThrow();
  }, 30_000);
});
