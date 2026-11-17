import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnOwnedProcess } from "./src/process-supervision.js";
import { createWorkspaceToolBridge } from "./src/split-execution-bridge.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

it("never writes Git metadata in the workspace or a read-write copy, in any case", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "supertag-bridge-git-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const copy = join(directory, "copy");
  for (const path of [join(workspace, ".git/hooks"), join(copy, ".git"), join(workspace, "src")])
    await mkdir(path, { recursive: true });
  await symlink(join(workspace, ".git"), join(workspace, "metadata"));
  const bridge = createWorkspaceToolBridge({
    environment: {
      rootDirectory: "/",
      resolvePath: (path) => resolve(workspace, path),
      read: (path) => readFile(path, "utf8"),
      spawn: (spec, signal) =>
        spawnOwnedProcess({
          spec,
          cwd: spec.cwd ?? workspace,
          environment: { PATH: "/usr/bin:/bin" },
          ...(signal ? { signal } : {}),
          maximumOutput: 64 * 1024,
          record: async () => {},
        }),
    },
    workspaceRoot: workspace,
    writableRoots: [copy],
    permissions: { filesWrite: true, commandsExecute: false },
  });
  cleanups.push(() => bridge.dispose());
  const write = (path: string) =>
    bridge.call("write", { file_path: path, content: "x" }).then(
      (result) => !result.isError,
      () => false,
    );
  expect(await write("src/main.ts")).toBe(true);
  expect(await write(join(copy, "data.txt"))).toBe(true);
  for (const path of [
    ".git/config",
    ".git/hooks/pre-commit",
    ".GIT/hooks/post-checkout",
    ".Git/commondir",
    "src/.git/config",
    "metadata/hooks/pre-push",
    join(copy, ".git/config"),
    join(copy, ".GIT/hooks/pre-commit"),
  ]) {
    expect(await write(path), path).toBe(false);
  }
  for (const hook of ["pre-commit", "post-checkout", "pre-push"])
    expect(await exists(join(workspace, ".git/hooks", hook))).toBe(false);
  expect(await exists(join(workspace, ".git/config"))).toBe(false);
  expect(await exists(join(workspace, ".git/commondir"))).toBe(false);
  expect(await exists(join(copy, ".git/config"))).toBe(false);
  // Reading Git metadata stays allowed.
  expect((await bridge.call("ls", { path: ".git" })).isError).toBe(false);
});
