import { renameSync, symlinkSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMount } from "../packages/core/src/index.js";
import type { EnvironmentPlan } from "../packages/runtime/sdk/src/index.js";
import {
  assertLocalMountDestination,
  type LocalMountRoot,
  resolveLocalMountRoot,
} from "../packages/runtime/sdk/src/local-mount-root.js";
import { LocalWorkspaceEnvironment } from "../packages/runtime/sdk/src/local-workspace-environment.js";
import {
  CopyBudget,
  copyWorkspaceMount,
  HostVolumeCopyTarget,
  planWorkspaceMounts,
  type VolumeCopyTarget,
} from "../packages/runtime/sdk/src/volume-copy.js";
import type { WorkspaceHost } from "../packages/runtime/sdk/src/workspace-environment.js";
import { removeSealedTree } from "./support/sealed-tree.js";

const host = vi.hoisted(() => ({
  home: "",
  writable: [] as string[],
  beforeCreate: undefined as undefined | ((path: string) => void),
  afterOpen: undefined as undefined | ((path: string) => Promise<void>),
  identities: new Map<string, string>(),
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => host.home,
}));
vi.mock("../packages/runtime/sdk/src/task-writable-roots.js", () => ({
  taskWritableRoots: () => host.writable,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      host.beforeCreate?.(String(args[0]));
      return actual.mkdir(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      await host.afterOpen?.(String(args[0]));
      return handle;
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const alias = host.identities.get(String(args[0]));
      return actual.stat(alias ?? args[0], args[1]);
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const argv = args[1] as string[];
      const options = args[2] as import("node:child_process").SpawnOptions;
      if (options?.cwd && argv?.at(-1))
        host.beforeCreate?.(join(String(options.cwd), argv.at(-1) as string));
      return actual.spawn(...args);
    },
  };
});

const LIMIT = 20 * 1024 ** 3;
const mountAt = (path: string): WorkspaceMount => ({
  volume: "data",
  path,
  strategy: "copy",
  access: "read-only",
  maxBytes: LIMIT,
});
const sink = (): VolumeCopyTarget => ({
  async create() {},
  async mkdir() {},
  async seal() {},
  async write(_path, chunks) {
    for await (const _chunk of chunks) {
      /* consume */
    }
  },
});

describe("mount security review regressions", () => {
  let scratch: string;
  let source: string;
  let allowed: string;
  let root: LocalMountRoot;
  let budget: CopyBudget;
  const volume = () => ({ volume: "data", source: pathToFileURL(source).href });
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "mount-security-fixes-")));
    host.home = join(scratch, "home");
    source = join(scratch, "source");
    allowed = join(scratch, "allowed");
    for (const path of [host.home, source, allowed]) await mkdir(path);
    await writeFile(join(source, "rows"), "rows");
    root = await resolveLocalMountRoot(allowed);
    budget = new CopyBudget();
  });
  afterEach(async () => {
    host.beforeCreate = undefined;
    host.afterOpen = undefined;
    host.writable = [];
    host.identities.clear();
    await removeSealedTree(scratch);
  });

  it.each(["literal", "symlink"])(
    "F1 refuses a formerly hard-linked secret in a Task-writable %s source",
    async (kind) => {
      const original = join(scratch, "credential");
      await writeFile(original, "old secret");
      await link(original, join(source, "secret"));
      await writeFile(`${original}.new`, "new secret");
      await rename(`${original}.new`, original);
      expect((await stat(join(source, "secret"))).nlink).toBe(1);
      host.writable = [source];
      if (kind === "symlink") {
        const alias = join(scratch, "alias");
        await symlink(source, alias);
        source = alias;
      }
      const target = sink();
      const create = vi.spyOn(target, "create");
      await expect(
        copyWorkspaceMount({
          mount: mountAt(join(allowed, "copy")),
          volume: volume(),
          budget,
          target,
        }),
      ).rejects.toThrow(/Task.*writ|temporary/u);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("F1 checks opened-file change identity when a hard link is added and the original is renamed", async () => {
    host.afterOpen = async (path) => {
      if (path !== join(source, "rows")) return;
      host.afterOpen = undefined;
      const alias = join(scratch, "original");
      await link(path, alias);
      await writeFile(`${alias}.new`, "rotated");
      await rename(`${alias}.new`, alias);
      expect((await stat(path)).nlink).toBe(1);
    };
    let bytes = 0;
    const target = sink();
    target.write = async (_path, chunks) => {
      for await (const chunk of chunks) bytes += chunk.byteLength;
    };
    await expect(
      copyWorkspaceMount({
        mount: mountAt(join(allowed, "copy")),
        volume: volume(),
        budget,
        target,
      }),
    ).rejects.toThrow(/changed/u);
    expect(bytes).toBe(0);
  });

  it("F1 refuses a same-size rewrite between listing and opening", async () => {
    const target = sink();
    target.create = async () => {
      await writeFile(join(source, "rows"), "leak");
    };
    let bytes = 0;
    target.write = async (_path, chunks) => {
      for await (const chunk of chunks) bytes += chunk.byteLength;
    };
    await expect(
      copyWorkspaceMount({
        mount: mountAt(join(allowed, "copy")),
        volume: volume(),
        budget,
        target,
      }),
    ).rejects.toThrow(/changed/u);
    expect(bytes).toBe(0);
  });

  it("F1 rechecks Task-writable sources after listing", async () => {
    const planned = await planWorkspaceMounts({
      mounts: [mountAt(join(allowed, "copy"))],
      volumes: { resolve: async () => volume() },
      task: { taskId: "t", attemptId: "a" },
    });
    host.writable = [source];
    try {
      await expect(planned.copy(sink())).rejects.toThrow(/Task.*writ|temporary/u);
    } finally {
      planned.close();
    }
  });

  it.each([false, true])(
    "F2 shares one budget across separate calls (concurrent=%s)",
    async (concurrent) => {
      await truncate(join(source, "rows"), 12 * 1024 ** 3);
      const target = sink();
      // Exercise listings without reading 12 GiB of sparse zeroes.
      target.write = async () => {};
      const copy = (suffix: string) =>
        copyWorkspaceMount({
          mount: mountAt(join(allowed, suffix)),
          volume: volume(),
          budget,
          target,
        });
      if (concurrent) {
        const results = await Promise.allSettled([copy("first"), copy("second")]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.find((result) => result.status === "rejected")).toMatchObject({
          reason: { message: expect.stringMatching(/across all mounts/u) },
        });
      } else {
        await copy("first");
        await expect(copy("second")).rejects.toThrow(/across all mounts/u);
      }
      await expect(
        copyWorkspaceMount({
          mount: mountAt(join(allowed, "another-attempt")),
          volume: volume(),
          budget: new CopyBudget(),
          target,
        }),
      ).resolves.toMatchObject({ totalBytes: 12 * 1024 ** 3 });
    },
  );

  it("F3 refuses a protected checkout before creating any missing parent", async () => {
    const checkout = join(allowed, "other-checkout");
    await mkdir(checkout);
    await expect(
      new HostVolumeCopyTarget([checkout], undefined, root).create(
        join(checkout, "missing", "deeper", "copy"),
      ),
    ).rejects.toThrow(/resolves into/u);
    await expect(lstat(join(checkout, "missing"))).rejects.toThrow();
  });

  it("F3 never creates directories through a parent swapped at mkdir", async () => {
    const parent = join(allowed, "parent");
    const outside = join(scratch, "outside");
    await mkdir(parent);
    await mkdir(outside);
    host.beforeCreate = (path) => {
      if (!path.startsWith(`${parent}/`)) return;
      host.beforeCreate = undefined;
      renameSync(parent, `${parent}-old`);
      symlinkSync(outside, parent);
    };
    await expect(
      new HostVolumeCopyTarget([], undefined, root).create(
        join(parent, "missing", "deeper", "copy"),
      ),
    ).rejects.toThrow();
    await expect(lstat(join(outside, "missing"))).rejects.toThrow();
  });

  it.each(["declared checkout", "worktree git directory"])(
    "F3 rechecks %s when the destination moves after start-time validation",
    async (kind) => {
      const state = join(scratch, "state");
      const treePath = join(state, "app", "worktrees", "task");
      const protectedPath = join(allowed, "protected");
      const alias = join(allowed, "alias");
      await mkdir(treePath, { recursive: true });
      await mkdir(protectedPath);
      await mkdir(alias);
      const repository = { path: join(scratch, "repository") };
      const tree = {
        path: treePath,
        gitDir: kind === "worktree git directory" ? protectedPath : join(state, "git"),
      };
      const workspaceHost = {
        root: state,
        declaredCheckoutPaths: kind === "declared checkout" ? [protectedPath] : [],
        opened: async () => repository,
        openWorktree: async () => tree,
        currentBranch: async () => "branch",
        run: async () => "head",
        recordIntegrity: async () => {
          await rename(alias, `${alias}-old`);
          await symlink(protectedPath, alias);
        },
      } as unknown as WorkspaceHost;
      const environment = new LocalWorkspaceEnvironment({
        host: workspaceHost,
        localMountRoot: root,
      });
      await expect(
        environment.start(
          { provider: "local", digest: "d", artifact: treePath, trustedCommit: "head" },
          {
            taskId: "t",
            attemptId: "a",
            branch: "branch",
            base: "head",
            head: "head",
            mounts: [mountAt(join(alias, "missing", "copy"))],
            volumes: { resolve: async () => volume() },
            plan: { files: [] } as unknown as EnvironmentPlan,
          },
        ),
      ).rejects.toThrow(/resolves into/u);
      await expect(lstat(join(protectedPath, "missing"))).rejects.toThrow();
    },
  );

  it("root F1 refuses a startup root exposing home through a filesystem alias", async () => {
    host.identities.set(join(allowed, host.home.slice(1)), host.home);
    await expect(resolveLocalMountRoot(allowed)).rejects.toThrow(/home/u);
  });

  it.each(["project/.vscode", "project/.claude/files", "tools/.cargo/config"])(
    "root F3 refuses dot directories below the root: %s",
    async (suffix) => {
      const path = join(allowed, suffix);
      await expect(assertLocalMountDestination(path, root)).rejects.toThrow(/dot director/u);
      await expect(new HostVolumeCopyTarget([], undefined, root).create(path)).rejects.toThrow(
        /dot director/u,
      );
      await expect(lstat(join(allowed, suffix.split("/")[0] as string))).rejects.toThrow();
    },
  );

  it("root F1 refuses a destination under a bind alias of home by directory identity", async () => {
    const alias = join(allowed, "home-alias");
    await mkdir(alias);
    // Portable bind-mount model: realpath keeps the alias spelling, stat identifies home.
    host.identities.set(alias, host.home);
    await expect(
      assertLocalMountDestination(join(alias, "ordinary", "copy"), root),
    ).rejects.toThrow(/home/u);
  });
});
