import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  // About a dozen bridge calls in sequence; loaded CI runners take over five seconds.
}, 30_000);

it("applies the Task's path scope to every file tool after symlinks resolve", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "supertag-bridge-scope-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const copy = join(workspace, "copy");
  for (const path of [
    join(workspace, "src/generated"),
    join(workspace, "apps/web"),
    join(workspace, "secrets"),
    copy,
  ])
    await mkdir(path, { recursive: true });
  for (const [path, content] of [
    [".env", "KEY=root-secret\n"],
    ["apps/web/.env", "KEY=web-secret\n"],
    ["secrets/token", "KEY=token-secret\n"],
    ["src/main.ts", "const KEY = 1;\n"],
    ["README.md", "KEY docs\n"],
  ] as const)
    await writeFile(join(workspace, path), content);
  await symlink(join(workspace, ".env"), join(workspace, "src/env-link"));
  await symlink(join(workspace, "README.md"), join(workspace, "src/readme-link"));
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
    fileScope: {
      write: ["src/"],
      readOnly: ["src/generated/"],
      hidden: ["**/.env", "secrets/"],
    },
  });
  cleanups.push(() => bridge.dispose());
  const succeeds = (name: string, input: Record<string, unknown>) =>
    bridge.call(name, input).then(
      (result) => !result.isError,
      () => false,
    );
  expect(await succeeds("write", { file_path: "src/new.ts", content: "x" })).toBe(true);
  expect(await succeeds("write", { file_path: join(copy, "data.txt"), content: "x" })).toBe(true);
  for (const [name, input] of [
    ["write", { file_path: "README.md", content: "x" }],
    ["write", { file_path: "src/readme-link", content: "x" }],
    ["write", { file_path: "src/generated/api.ts", content: "x" }],
    ["write", { file_path: "src/GENERATED/api.ts", content: "x" }],
    ["edit", { file_path: "README.md", old_string: "docs", new_string: "x" }],
    ["read", { file_path: ".env" }],
    ["read", { file_path: ".ENV" }],
    ["read", { file_path: "apps/web/.env" }],
    ["read", { file_path: "src/env-link" }],
    ["read", { file_path: "secrets/token" }],
    ["ls", { path: "secrets" }],
    ["grep", { pattern: "KEY", path: "secrets" }],
    ["glob", { pattern: "*", path: "secrets" }],
  ] as const)
    expect(await succeeds(name, input), `${name} ${JSON.stringify(input)}`).toBe(false);
  expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("KEY docs\n");
  expect(await succeeds("read", { file_path: "README.md" })).toBe(true);
  // Searches over a directory holding hidden entries leave them out.
  for (const mode of ["content", "files_with_matches", "count"]) {
    const grep = await bridge.call("grep", { pattern: "KEY", path: ".", output_mode: mode });
    expect(grep.isError, mode).toBe(false);
    expect(grep.text, mode).not.toMatch(/secret|\.env|secrets/u);
    expect(grep.text, mode).toContain("README.md");
    expect(grep.text, mode).toContain("src/main.ts");
  }
  const content = await bridge.call("grep", { pattern: "KEY", path: "." });
  expect(content.text).toContain(`${join(workspace, "src/main.ts")}:1:const KEY = 1;`);
  const glob = await bridge.call("glob", { pattern: "**/*" });
  expect(glob.text).not.toMatch(/\.env|secrets/u);
  expect(glob.text).toContain("src/main.ts");
  const listing = await bridge.call("ls", { path: "." });
  expect(listing.text).not.toMatch(/ \.env$|secrets/mu);
  expect(listing.text).toContain("README.md");
  expect((await bridge.call("ls", { path: "apps/web" })).text).not.toContain(".env");
}, 30_000);
