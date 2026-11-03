import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadServicesFile, renderServicesFile } from "../apps/cli/src/supertag-yaml.js";
import { startWorkletRuntime, type WorkletRuntimeOptions } from "../apps/cli/src/worker.js";
import { WorkspaceEnvironmentResolver } from "../packages/runtime/sdk/src/git-workspace.js";
import type { ResolutionContext } from "../packages/runtime/sdk/src/index.js";
import {
  assertLocalMountDestination,
  type LocalMountRoot,
  resolveLocalMountRoot,
} from "../packages/runtime/sdk/src/local-mount-root.js";
import { HostVolumeCopyTarget } from "../packages/runtime/sdk/src/volume-copy.js";

vi.mock("../packages/runtime/sdk/src/task-writable-roots.js", () => ({
  taskWritableRoots: () => [],
}));

describe("local-mount-root confinement", () => {
  let scratch: string;
  let allowed: string;
  let outside: string;
  let root: LocalMountRoot;
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "local-mount-root-")));
    allowed = join(scratch, "allowed");
    outside = join(scratch, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    root = await resolveLocalMountRoot(allowed);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(scratch, { recursive: true, force: true });
  });

  const context = (path: string) =>
    ({
      task: {
        taskId: "t",
        attemptId: "a",
        workspacePlan: {
          version: 1,
          status: "workspace",
          workspace: "app",
          branch: "supertag/t",
          delivery: "branch",
          mounts: [{ volume: "data", path, strategy: "copy", access: "read-only" }],
        },
      },
      profile: { harness: { provider: "codex" } },
    }) as unknown as ResolutionContext;

  async function refusedAtResolveAndCopy(
    path: string,
    configured: LocalMountRoot | undefined = root,
  ) {
    const resolver = new WorkspaceEnvironmentResolver({
      checkouts: [],
      worktreeRoot: join(scratch, "state"),
      ...(configured === undefined ? {} : { localMountRoot: configured }),
    });
    await expect(resolver.resolve(context(path))).rejects.toThrow(/local-mount-root/u);
    await expect(new HostVolumeCopyTarget([], undefined, configured).create(path)).rejects.toThrow(
      /local-mount-root/u,
    );
  }

  it.each(["state", "state/credentials/copy", ""])(
    "refuses a mount overlapping the configured state directory: %s",
    async (suffix) => {
      vi.stubEnv("SUPERTAG_STATE_DIR", join(allowed, "state"));
      const configured = await resolveLocalMountRoot(allowed);
      await refusedAtResolveAndCopy(join(allowed, suffix), configured);
      await expect(lstat(join(allowed, "state"))).rejects.toThrow();
    },
  );

  it("protects a state directory reached through an alias", async () => {
    await mkdir(join(allowed, "state"));
    await symlink(join(allowed, "state"), join(scratch, "state-alias"));
    vi.stubEnv("SUPERTAG_STATE_DIR", join(scratch, "state-alias"));
    const configured = await resolveLocalMountRoot(allowed);
    await refusedAtResolveAndCopy(join(allowed, "state", "copy"), configured);
    await expect(lstat(join(allowed, "state", "copy"))).rejects.toThrow();
  });

  it("resolves relative state paths against INIT_CWD and allows siblings", async () => {
    vi.stubEnv("INIT_CWD", allowed);
    vi.stubEnv("SUPERTAG_STATE_DIR", "state");
    const configured = await resolveLocalMountRoot(allowed);
    await refusedAtResolveAndCopy(join(allowed, "state", "copy"), configured);
    await expect(
      assertLocalMountDestination(join(allowed, "state-other", "copy"), configured),
    ).resolves.toBeUndefined();
  });

  it("refuses a local destination when local-mount-root is unset", async () => {
    await expect(new HostVolumeCopyTarget().create(join(scratch, "copy"))).rejects.toThrow(
      /local-mount-root/u,
    );
    await expect(
      new WorkspaceEnvironmentResolver({ checkouts: [] }).resolve(context(join(allowed, "copy"))),
    ).rejects.toThrow(/local-mount-root/u);
  });

  it.each(["/", homedir(), dirname(homedir())])("refuses unsafe startup root %s", async (path) => {
    await expect(resolveLocalMountRoot(path)).rejects.toThrow(/local-mount-root/u);
  });

  it.runIf(process.platform === "darwin")(
    "refuses the macOS data-volume alias of home's ancestors",
    async () => {
      await expect(resolveLocalMountRoot("/System/Volumes/Data")).rejects.toThrow(/home/u);
    },
  );

  it("refuses missing roots and files at startup before opening a Worklet", async () => {
    const file = join(scratch, "file");
    await writeFile(file, "data");
    for (const path of [file, join(scratch, "missing")]) {
      await expect(
        startWorkletRuntime({ localMountRoot: path } as WorkletRuntimeOptions),
      ).rejects.toThrow(/local-mount-root.*existing directory/u);
    }
  });

  it("accepts a read-only root containing a writable destination parent", async () => {
    const child = join(allowed, "child");
    await mkdir(child);
    await chmod(allowed, 0o555);
    try {
      const configured = await resolveLocalMountRoot(allowed);
      await new HostVolumeCopyTarget([], undefined, configured).create(join(child, "copy"));
      expect((await stat(join(child, "copy"))).isDirectory()).toBe(true);
    } finally {
      await chmod(allowed, 0o755);
    }
  });

  it.each([homedir(), dirname(homedir())])("refuses startup aliases of %s", async (target) => {
    const alias = join(scratch, "unsafe-root");
    await symlink(target, alias);
    await expect(resolveLocalMountRoot(alias)).rejects.toThrow(/local-mount-root/u);
  });

  it.each(["project/.vscode", "project/.claude", "tools/.cargo", "node_modules", "homebrew/lib"])(
    "refuses destinations outside the root even in ordinary host paths: %s",
    async (suffix) => {
      await refusedAtResolveAndCopy(join(outside, suffix));
      await expect(lstat(join(outside, suffix))).rejects.toThrow();
    },
  );

  it("resolves a configured symlink once and retains the approved directory", async () => {
    const link = join(scratch, "root-link");
    await symlink(allowed, link);
    const configured = await resolveLocalMountRoot(link);
    expect(configured.path).toBe(allowed);
    await unlink(link);
    await symlink(outside, link);
    await expect(assertLocalMountDestination(join(link, "copy"), configured)).rejects.toThrow(
      /local-mount-root/u,
    );
    await expect(
      assertLocalMountDestination(join(allowed, "copy"), configured),
    ).resolves.toBeUndefined();
  });

  it("allows the root and nested destinations, including missing ancestors", async () => {
    await expect(assertLocalMountDestination(allowed, root)).resolves.toBeUndefined();
    const path = join(allowed, "new", "nested", "copy");
    await expect(assertLocalMountDestination(path, root)).resolves.toBeUndefined();
    await new HostVolumeCopyTarget([], undefined, root).create(path);
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  it.each(["../outside/copy", "../allowed-other/copy", "child/../../outside/copy"])(
    "refuses traversal or prefix sibling %s",
    async (suffix) => {
      await refusedAtResolveAndCopy(`${allowed}/${suffix}`);
      await expect(lstat(join(outside, "copy"))).rejects.toThrow();
    },
  );

  it.each(["link/copy", "link/missing/ancestors/copy"])(
    "refuses symlinked ancestor %s",
    async (suffix) => {
      await symlink(outside, join(allowed, "link"));
      await refusedAtResolveAndCopy(join(allowed, suffix));
      await expect(lstat(join(outside, "missing"))).rejects.toThrow();
    },
  );

  it("refuses a destination symlink", async () => {
    const path = join(allowed, "copy");
    await symlink(outside, path);
    await expect(assertLocalMountDestination(path, root)).rejects.toThrow(/symbolic link/u);
    await expect(new HostVolumeCopyTarget([], undefined, root).create(path)).rejects.toThrow(
      /symbolic link/u,
    );
  });

  it("rechecks an ancestor redirected after resolution", async () => {
    const parent = join(allowed, "parent");
    await mkdir(parent);
    const path = join(parent, "missing", "copy");
    await assertLocalMountDestination(path, root);
    await rename(parent, `${parent}-old`);
    await symlink(outside, parent);
    await expect(new HostVolumeCopyTarget([], undefined, root).create(path)).rejects.toThrow(
      /local-mount-root/u,
    );
    await expect(lstat(join(outside, "missing"))).rejects.toThrow();
  });

  it("refuses replacing the approved root with a directory or a symlink", async () => {
    await rename(allowed, `${allowed}-old`);
    await mkdir(allowed);
    await refusedAtResolveAndCopy(join(allowed, "copy"));
    await rm(allowed, { recursive: true });
    await symlink(outside, allowed);
    await refusedAtResolveAndCopy(join(allowed, "copy"));
  });

  it("uses actual filesystem case behavior and refuses an uppercase escape alias", async () => {
    const alias = join(scratch, "ALLOWED");
    if (root.foldCase) {
      await expect(assertLocalMountDestination(join(alias, "copy"), root)).resolves.toBeUndefined();
    } else {
      await mkdir(alias);
      await refusedAtResolveAndCopy(join(alias, "copy"));
    }
    await symlink(outside, join(allowed, "ESCAPE"));
    await refusedAtResolveAndCopy(join(allowed, "ESCAPE", "copy"));
  });

  it.each(["NFC", "NFD"] as const)(
    "does not confuse distinct normalized directories (%s root)",
    async (form) => {
      const name = "café";
      const path = join(scratch, name.normalize(form));
      const alias = join(scratch, name.normalize(form === "NFC" ? "NFD" : "NFC"));
      await mkdir(path);
      const configured = await resolveLocalMountRoot(path);
      const actual = await stat(path);
      const alternate = await stat(alias).catch(() => undefined);
      if (alternate?.ino === actual.ino && alternate.dev === actual.dev) {
        await expect(
          assertLocalMountDestination(join(alias, "copy"), configured),
        ).resolves.toBeUndefined();
      } else {
        await mkdir(alias);
        await refusedAtResolveAndCopy(join(alias, "copy"), configured);
      }
      await symlink(outside, join(path, "é".normalize(form)));
      await refusedAtResolveAndCopy(join(path, "é".normalize(form), "copy"), configured);
    },
  );

  it("parses and renders the host setting relative to its declaring file", async () => {
    const file = join(scratch, "supertag.yaml");
    await writeFile(
      file,
      `services:\n  laptop:\n    type: host\n    control-plane: https://example.com\n    harnesses: [codex]\n    local-mount-root: ./allowed\n`,
    );
    const loaded = await loadServicesFile({ files: [file] });
    expect(loaded.services[0]).toMatchObject({ localMountRoot: allowed });
    expect(renderServicesFile(loaded)).toContain(`local-mount-root: ${allowed}`);
    for (const value of ["null", "true", "[]", '""']) {
      await writeFile(
        file,
        `services:\n  laptop:\n    type: host\n    control-plane: https://example.com\n    harnesses: [codex]\n    local-mount-root: ${value}\n`,
      );
      await expect(loadServicesFile({ files: [file] })).rejects.toThrow(/local-mount-root/u);
    }
  });
});
