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

it("always reaches the Tag's memory folder, and the Workspace only as the Task allows", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "supertag-bridge-memory-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const memory = join(directory, "memory");
  for (const path of [workspace, memory, join(directory, "outside")]) await mkdir(path);
  await writeFile(join(workspace, "README.md"), "workspace text\n");
  await writeFile(join(memory, "MEMORY.md"), "- [Squash](feedback_squash.md) — merges\n");
  await writeFile(join(directory, "outside", "secret.txt"), "outside secret\n");
  await symlink(join(directory, "outside"), join(memory, "escape"));
  const bridge = (filesRead: boolean, filesWrite: boolean) => {
    const created = createWorkspaceToolBridge({
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
      memoryRoot: memory,
      permissions: { filesRead, filesWrite, commandsExecute: false },
    });
    cleanups.push(() => created.dispose());
    return created;
  };
  const ok = (result: Promise<{ isError: boolean }>) =>
    result.then(
      (value) => !value.isError,
      () => false,
    );
  // No file actions at all, as a review whose Tag reads no files: only the memory folder.
  const none = bridge(false, false);
  expect(none.tools.map(({ name }) => name).sort()).toEqual([
    "edit",
    "glob",
    "grep",
    "ls",
    "read",
    "write",
  ]);
  expect((await none.call("read", { file_path: join(memory, "MEMORY.md") })).text).toContain(
    "feedback_squash.md",
  );
  expect(
    await ok(none.call("write", { file_path: join(memory, "user_a.md"), content: "a\n" })),
  ).toBe(true);
  expect(
    await ok(
      none.call("edit", {
        file_path: join(memory, "MEMORY.md"),
        old_string: "- [Squash]",
        new_string: "- [A](user_a.md) — a\n- [Squash]",
      }),
    ),
  ).toBe(true);
  expect(await readFile(join(memory, "MEMORY.md"), "utf8")).toContain("(user_a.md)");
  expect(await ok(none.call("ls", { path: memory }))).toBe(true);
  for (const refused of [
    () => none.call("read", { file_path: "README.md" }),
    () => none.call("write", { file_path: "new.txt", content: "no\n" }),
    () => none.call("ls", {}),
    () => none.call("grep", { pattern: "text" }),
    // A link out of the folder reaches nothing.
    () => none.call("read", { file_path: join(memory, "escape", "secret.txt") }),
    () => none.call("write", { file_path: join(memory, "escape", "planted.txt"), content: "no\n" }),
    () =>
      none.call("write", { file_path: join(directory, "outside", "planted.txt"), content: "no\n" }),
  ])
    expect(await ok(refused())).toBe(false);
  expect(await exists(join(workspace, "new.txt"))).toBe(false);
  expect(await exists(join(directory, "outside", "planted.txt"))).toBe(false);
  // A read-only Task reads the Workspace and still writes only the memory folder.
  const reading = bridge(true, false);
  expect(await ok(reading.call("read", { file_path: "README.md" }))).toBe(true);
  expect(await ok(reading.call("write", { file_path: "new.txt", content: "no\n" }))).toBe(false);
  expect(
    await ok(reading.call("write", { file_path: join(memory, "user_b.md"), content: "b\n" })),
  ).toBe(true);
  // Without a memory folder, the tools are the Task's own, as before.
  const plain = createWorkspaceToolBridge({
    environment: {
      rootDirectory: workspace,
      resolvePath: (path) => resolve(workspace, path),
      read: (path) => readFile(path, "utf8"),
      spawn: () => Promise.reject(new Error("unused")),
    },
    workspaceRoot: workspace,
    permissions: { filesWrite: false, commandsExecute: false },
  });
  expect(plain.tools.map(({ name }) => name).sort()).toEqual(["glob", "grep", "ls", "read"]);
}, 30_000);
