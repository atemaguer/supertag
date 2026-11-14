import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createSplitExecutionBridge,
  type ExecutionEnvironment,
  type ProcessHandle,
  type ProcessSpec,
} from "./src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "split-bridge-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const specs: ProcessSpec[] = [];
  const processes = new Set<ProcessHandle>();
  const environment: ExecutionEnvironment = {
    id: "fake",
    placement: "remote",
    rootDirectory: root,
    async prepare() {},
    async dispose() {},
    resolvePath(path) {
      const target = resolve(root, path);
      if (relative(root, target).startsWith("..")) throw new Error("outside environment");
      return target;
    },
    async read(path) {
      return readFile(path, "utf8");
    },
    async spawn(spec, signal) {
      specs.push(spec);
      const child = spawnChild(spec.command, [...(spec.args ?? [])], {
        cwd: spec.cwd ?? root,
        env: spec.replaceEnvironment
          ? { PATH: process.env["PATH"], HOME: root, ...spec.environment }
          : {
              ...process.env,
              ANTHROPIC_API_KEY: "sentinel",
              CURSOR_API_KEY: "sentinel",
              ...spec.environment,
            },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
      else child.stdin.end();
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      const done = new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          child.on("error", reject);
          child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
        },
      );
      const handle: ProcessHandle = {
        kill() {
          child.kill();
        },
        wait: () =>
          done.finally(() => {
            processes.delete(handle);
            signal?.removeEventListener("abort", abort);
          }),
      };
      processes.add(handle);
      return handle;
    },
  };
  return { root, workspace, environment, specs, processes };
}

it("bridges every workspace tool and bounds read and command output", async () => {
  const { workspace, environment, specs } = await fixture();
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    permissions: { filesWrite: true, commandsExecute: true },
    limits: { maxOutputBytes: 10_000, maxReadBytes: 40 },
  });
  expect(bridge.tools.map((tool) => tool.name)).toEqual([
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "ls",
    "command",
  ]);
  expect((await bridge.call("write", { file_path: "a.txt", content: "hello world" })).isError).toBe(
    false,
  );
  expect((await bridge.call("read", { file_path: "a.txt" })).text).toBe("hello world");
  expect(
    (await bridge.call("edit", { file_path: "a.txt", old_string: "world", new_string: "bridge" }))
      .isError,
  ).toBe(false);
  expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("hello bridge");
  expect((await bridge.call("glob", { pattern: "*.txt" })).text).toContain("a.txt");
  expect((await bridge.call("grep", { pattern: "bridge" })).text).toContain("bridge");
  expect((await bridge.call("ls", {})).text).toContain("a.txt");
  expect((await bridge.call("command", { command: "printf 'hello from sandbox'" })).text).toBe(
    "hello from sandbox",
  );
  expect(await bridge.call("command", { command: "printf bad; exit 7" })).toMatchObject({
    isError: true,
    text: expect.stringContaining("exit 7"),
  });
  const boundedBridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    permissions: { filesWrite: true, commandsExecute: true },
    limits: { maxOutputBytes: 30 },
  });
  const boundedOutput = await boundedBridge.call("command", {
    command: "printf 1234567890123456789012345678901234567890",
  });
  expect(boundedOutput.text).toContain("[truncated]");
  expect(Buffer.byteLength(boundedOutput.text)).toBeLessThanOrEqual(30);
  await boundedBridge.call("command", { command: "true", timeout: 999_999 });
  expect(specs.at(-1)?.timeoutMs).toBe(120_000);
  await writeFile(join(workspace, "large.txt"), "x".repeat(100));
  expect((await bridge.call("read", { file_path: "large.txt" })).text).toContain(
    "[read truncated; next offset: 2]",
  );
  const shortRead = await boundedBridge.call("read", { file_path: "large.txt" });
  expect(shortRead.text).toContain("[truncated; next: 2]");
  expect(Buffer.byteLength(shortRead.text)).toBeLessThanOrEqual(30);
  await boundedBridge.dispose();
  await bridge.dispose();
});

it("reads lines beyond the byte limit and reports the next offset", async () => {
  const { workspace, environment, specs } = await fixture();
  await writeFile(join(workspace, "long.txt"), `${"x".repeat(31_000)}\nsecond\nthird\nfourth`);
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    permissions: { filesWrite: false, commandsExecute: false },
    limits: { maxReadBytes: 30_000, maxOutputBytes: 100 },
  });
  expect((await bridge.call("read", { file_path: "long.txt", offset: 2, limit: 1 })).text).toBe(
    "second\n[more lines; next offset: 3]",
  );
  expect((await bridge.call("read", { file_path: "long.txt", offset: 3, limit: 2 })).text).toBe(
    "third\nfourth",
  );
  const first = await bridge.call("read", { file_path: "long.txt", limit: 2 });
  expect(first.text).toContain("[read truncated; next offset: 2]");
  expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(100);
  expect(
    specs.filter(
      (spec) =>
        spec.command === "sh" && spec.args?.[2] === "split-path" && spec.args?.[3] === workspace,
    ),
  ).toHaveLength(1);
  await bridge.dispose();
});

it("edits large files and treats replacement text literally", async () => {
  const { workspace, environment } = await fixture();
  await writeFile(join(workspace, "large.txt"), `${"x".repeat(31_000)}\ntarget`);
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    permissions: { filesWrite: true, commandsExecute: false },
  });
  expect(
    (
      await bridge.call("edit", {
        file_path: "large.txt",
        old_string: "target",
        new_string: "$& $$ $' $`",
      })
    ).isError,
  ).toBe(false);
  expect(await readFile(join(workspace, "large.txt"), "utf8")).toBe(
    `${"x".repeat(31_000)}\n$& $$ $' $\u0060`,
  );
  await bridge.dispose();
});

it("rejects escapes and symlinks for all file operations", async () => {
  const { root, workspace, environment } = await fixture();
  await writeFile(join(root, "outside.txt"), "secret");
  await symlink(join(root, "outside.txt"), join(workspace, "link.txt"));
  await symlink(root, join(workspace, "linked-dir"));
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    permissions: { filesWrite: true, commandsExecute: true },
  });
  for (const file_path of ["../outside.txt", join(root, "outside.txt"), "link.txt"]) {
    await expect(bridge.call("read", { file_path })).rejects.toThrow();
    await expect(bridge.call("write", { file_path, content: "bad" })).rejects.toThrow();
    await expect(
      bridge.call("edit", { file_path, old_string: "secret", new_string: "bad" }),
    ).rejects.toThrow();
    await expect(bridge.call("ls", { path: file_path })).rejects.toThrow();
  }
  expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("secret");
  await expect(
    bridge.call("write", { file_path: "linked-dir/new.txt", content: "bad" }),
  ).rejects.toThrow();
  expect((await bridge.call("grep", { pattern: "secret" })).text).not.toContain("secret");
  await bridge.dispose();
});

it("bounds adversarial globs without blocking the Worker Host", async () => {
  const { workspace, environment } = await fixture();
  await writeFile(join(workspace, `${"a".repeat(120)}c`), "ordinary file");
  await (await import("node:fs/promises")).mkdir(join(workspace, "nested"));
  await writeFile(join(workspace, "nested", "x.txt"), "nested file");
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    permissions: { filesWrite: false, commandsExecute: false },
  });
  const started = performance.now();
  expect((await bridge.call("glob", { pattern: "**a**a**a**a**a**a**a**ab" })).text).toBe(
    "(no output)",
  );
  expect(performance.now() - started).toBeLessThan(2_000);
  expect((await bridge.call("glob", { pattern: "nested/?.txt" })).text).toBe("nested/x.txt");
  expect((await bridge.call("glob", { pattern: "**/x.txt" })).text).toBe("nested/x.txt");
  expect((await bridge.call("glob", { pattern: "*.txt" })).text).toBe("(no output)");
  await expect(bridge.call("glob", { pattern: "a".repeat(513) })).rejects.toThrow(
    "Glob pattern exceeds",
  );
  await expect(bridge.call("glob", { pattern: "*".repeat(65) })).rejects.toThrow(
    "Glob pattern exceeds",
  );
  await bridge.dispose();
});

it("reads staged inputs, writes managed outputs, and keeps their roots isolated", async () => {
  const { root, workspace, environment } = await fixture();
  const inputs = join(root, "cursor-inputs");
  const outputs = join(root, "outputs", "attempt");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(inputs);
  await mkdir(outputs, { recursive: true });
  await writeFile(join(inputs, "evidence.txt"), "selected evidence");
  await writeFile(join(root, "private.txt"), "private");
  await symlink(join(root, "private.txt"), join(inputs, "escape.txt"));
  await symlink(root, join(outputs, "escape-dir"));
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    readOnlyRoots: [inputs],
    outputDirectory: outputs,
    permissions: { filesWrite: true, commandsExecute: true },
  });
  expect((await bridge.call("read", { file_path: join(inputs, "evidence.txt") })).text).toBe(
    "selected evidence",
  );
  expect((await bridge.call("grep", { path: inputs, pattern: "selected" })).text).toContain(
    "selected evidence",
  );
  expect((await bridge.call("glob", { path: inputs, pattern: "*.txt" })).text).toContain(
    "evidence.txt",
  );
  expect((await bridge.call("ls", { path: inputs })).text).toContain("evidence.txt");
  await expect(
    bridge.call("write", { file_path: join(inputs, "evidence.txt"), content: "bad" }),
  ).rejects.toThrow("read-only");
  await expect(
    bridge.call("edit", {
      file_path: join(inputs, "evidence.txt"),
      old_string: "selected",
      new_string: "bad",
    }),
  ).rejects.toThrow("read-only");
  expect(
    (await bridge.call("write", { file_path: join(outputs, "report.txt"), content: "ok" })).isError,
  ).toBe(false);
  expect(
    (
      await bridge.call("edit", {
        file_path: join(outputs, "report.txt"),
        old_string: "ok",
        new_string: "done",
      })
    ).isError,
  ).toBe(false);
  expect(await readFile(join(outputs, "report.txt"), "utf8")).toBe("done");
  await expect(
    bridge.call("write", { file_path: `${outputs}/../private.txt`, content: "bad" }),
  ).rejects.toThrow();
  for (const path of [join(root, "private.txt"), "../private.txt", join(inputs, "escape.txt")]) {
    await expect(bridge.call("read", { file_path: path })).rejects.toThrow();
    await expect(bridge.call("write", { file_path: path, content: "bad" })).rejects.toThrow();
  }
  await expect(
    bridge.call("write", { file_path: join(outputs, "escape-dir", "bad.txt"), content: "bad" }),
  ).rejects.toThrow();
  await bridge.dispose();
});

it("rejects a managed output root redirected through a symlink", async () => {
  const { root, workspace, environment } = await fixture();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "private"));
  await mkdir(join(root, "outputs"));
  await symlink(join(root, "private"), join(root, "outputs", "attempt"));
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    outputDirectory: join(root, "outputs", "attempt"),
    permissions: { filesWrite: true, commandsExecute: true },
  });
  await expect(
    bridge.call("write", {
      file_path: join(root, "outputs", "attempt", "bad.txt"),
      content: "bad",
    }),
  ).rejects.toThrow("redirected");
  await expect(readFile(join(root, "private", "bad.txt"), "utf8")).rejects.toThrow();
  await bridge.dispose();
});

it("refuses writes through a workspace symlink into a nested read-only root", async () => {
  const { workspace, environment } = await fixture();
  const readOnly = join(workspace, "inputs");
  await (await import("node:fs/promises")).mkdir(readOnly);
  await writeFile(join(readOnly, "evidence.txt"), "before");
  await symlink(readOnly, join(workspace, "alias"));
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    readOnlyRoots: [readOnly],
    permissions: { filesWrite: true, commandsExecute: true },
  });
  expect((await bridge.call("read", { file_path: "alias/evidence.txt" })).text).toBe("before");
  for (const file_path of ["alias/evidence.txt", "inputs/evidence.txt"]) {
    await expect(bridge.call("write", { file_path, content: "after" })).rejects.toThrow(
      "read-only",
    );
    await expect(
      bridge.call("edit", { file_path, old_string: "before", new_string: "after" }),
    ).rejects.toThrow("read-only");
  }
  expect(await readFile(join(readOnly, "evidence.txt"), "utf8")).toBe("before");
  await bridge.dispose();
});

it("reaches canonical copy roots outside the workspace from the filesystem root", async () => {
  const { workspace, environment } = await fixture();
  const { mkdir, realpath } = await import("node:fs/promises");
  const base = await realpath(join(workspace, ".."));
  const readOnly = join(base, "copies", "ro");
  const writable = join(base, "copies", "rw");
  await mkdir(readOnly, { recursive: true });
  await mkdir(writable, { recursive: true });
  await writeFile(join(readOnly, "rows.csv"), "1,2\n");
  const bridge = createSplitExecutionBridge({
    environment: { ...environment, rootDirectory: "/", resolvePath: (path) => resolve(base, path) },
    workspaceRoot: join(base, "workspace"),
    readOnlyRoots: [readOnly],
    writableRoots: [writable],
    permissions: { filesWrite: true, commandsExecute: false },
  });
  expect((await bridge.call("read", { file_path: join(readOnly, "rows.csv") })).text).toContain(
    "1,2",
  );
  await expect(
    bridge.call("write", { file_path: join(readOnly, "x.txt"), content: "no" }),
  ).rejects.toThrow("read-only");
  await bridge.call("write", { file_path: join(writable, "out.txt"), content: "yes" });
  expect(await readFile(join(writable, "out.txt"), "utf8")).toBe("yes");
  await expect(bridge.call("read", { file_path: join(base, "other.txt") })).rejects.toThrow(
    "escapes",
  );
  await bridge.dispose();
});

it("checks permissions on each call and strips provider credentials", async () => {
  const { workspace, environment, specs } = await fixture();
  const permissions = { filesWrite: false, commandsExecute: false };
  const bridge = createSplitExecutionBridge({ environment, workspaceRoot: workspace, permissions });
  expect(bridge.tools.map((tool) => tool.name)).toEqual(["read", "glob", "grep", "ls"]);
  await expect(bridge.call("write", { file_path: "x", content: "x" })).rejects.toThrow(
    "files:write",
  );
  await expect(bridge.call("command", { command: "true" })).rejects.toThrow("commands:execute");
  permissions.commandsExecute = true;
  expect(bridge.tools.map((tool) => tool.name)).not.toContain("command");
  await expect(bridge.call("command", { command: "true" })).rejects.toThrow("files:write");
  permissions.filesWrite = true;
  expect(
    (await bridge.call("command", { command: "env > environment.txt; env" })).text,
  ).not.toMatch(/ANTHROPIC_|CLAUDE_|CURSOR_API_KEY|OPENAI_|CODEX_|AWS_|GOOGLE_|AZURE_/);
  expect(await readFile(join(workspace, "environment.txt"), "utf8")).not.toMatch(
    /ANTHROPIC_|CLAUDE_|CURSOR_API_KEY|OPENAI_|CODEX_|AWS_|GOOGLE_|AZURE_/,
  );
  expect(specs.every((spec) => spec.replaceEnvironment === true)).toBe(true);
  expect(
    specs.every((spec) =>
      Object.keys(spec.environment ?? {}).every(
        (name) =>
          !/ANTHROPIC_|CLAUDE_|CURSOR_API_KEY|OPENAI_|CODEX_|AWS_|GOOGLE_|AZURE_/.test(name),
      ),
    ),
  ).toBe(true);
  expect((await bridge.call("write", { file_path: "permitted", content: "yes" })).isError).toBe(
    false,
  );
  permissions.filesWrite = false;
  await expect(
    bridge.call("edit", { file_path: "permitted", old_string: "yes", new_string: "no" }),
  ).rejects.toThrow("files:write");
  await bridge.dispose();
});

it("keeps the sandbox PATH and passes only safe command environment variables", async () => {
  const { workspace, environment, specs } = await fixture();
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    permissions: { filesWrite: true, commandsExecute: true },
    commandEnvironment: {
      SUPERTAG_SCRATCH_DIR: "/scratch",
      ANTHROPIC_API_KEY: "secret",
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
      CURSOR_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      CODEX_TOKEN: "secret",
      AWS_ACCESS_KEY_ID: "secret",
      GOOGLE_APPLICATION_CREDENTIALS: "secret",
      AZURE_CLIENT_SECRET: "secret",
      MODAL_TOKEN_ID: "secret",
      E2B_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      GH_TOKEN: "secret",
      cursor_api_key: "fake-cursor-key",
      anthropic_auth_token: "fake-anthropic-token",
      claude_code_oauth_token: "fake-oauth-token",
      CUSTOM_SECRET: "fake-custom-secret",
      NODE_OPTIONS: "--require fake-module",
    },
  });
  const result = await bridge.call("command", {
    command: "env > environment.txt; printf '%s' \"$SUPERTAG_SCRATCH_DIR\"",
  });
  expect(result.text).toBe("/scratch");
  const sandboxEnvironment = await readFile(join(workspace, "environment.txt"), "utf8");
  expect(sandboxEnvironment).toContain("SUPERTAG_SCRATCH_DIR=/scratch");
  expect(sandboxEnvironment).not.toMatch(/fake-|secret|node_options/iu);
  expect(specs.at(-1)?.args?.[0]).toBe("-lc");
  expect(specs.every((spec) => spec.replaceEnvironment === true)).toBe(true);
  expect(specs.every((spec) => !Object.hasOwn(spec.environment ?? {}, "PATH"))).toBe(true);
  expect(
    specs.every((spec) =>
      Object.keys(spec.environment ?? {}).every((name) =>
        ["LANG", "LC_ALL", "SUPERTAG_SCRATCH_DIR"].includes(name),
      ),
    ),
  ).toBe(true);
  await bridge.dispose();
});

it("uses the symlink-free checked path for existing files and new files below symlinks", async () => {
  const { workspace, environment, specs } = await fixture();
  const actual = join(workspace, "actual");
  await (await import("node:fs/promises")).mkdir(actual);
  await writeFile(join(actual, "file.txt"), "before");
  await symlink(actual, join(workspace, "alias"));
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    permissions: { filesWrite: true, commandsExecute: false },
  });
  await bridge.call("read", { file_path: "alias/file.txt" });
  // The resolved path stays under the lexical root the environment confines to, with every
  // symlink inside the workspace already resolved, so a later swap cannot redirect it.
  expect(specs.at(-1)?.args?.at(-1)).toBe(join(actual, "file.txt"));
  await bridge.call("write", { file_path: "alias/new.txt", content: "new" });
  expect(specs.at(-1)?.args?.at(-1)).toBe(join(actual, "new.txt"));
  expect(await readFile(join(actual, "new.txt"), "utf8")).toBe("new");
  const large = `${"x".repeat(64 * 1024)}needle${"y".repeat(64 * 1024)}`;
  await writeFile(join(actual, "large.txt"), large);
  expect(
    await bridge.call("edit", {
      file_path: "alias/large.txt",
      old_string: "needle",
      new_string: "pin",
    }),
  ).toMatchObject({ isError: false });
  expect(await readFile(join(actual, "large.txt"), "utf8")).toBe(large.replace("needle", "pin"));
  await bridge.dispose();
});

it.each(["cursor", "claude-code"])(
  "keeps %s provider credentials out of every bridged tool process and file",
  async () => {
    const { workspace, environment, specs } = await fixture();
    const fakeKeys = {
      CURSOR_API_KEY: "fake-cursor-provider-value",
      ANTHROPIC_API_KEY: "fake-anthropic-provider-value",
      ANTHROPIC_AUTH_TOKEN: "fake-anthropic-auth-value",
      CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-oauth-value",
    };
    const bridge = createSplitExecutionBridge({
      environment,
      workspaceRoot: workspace,
      permissions: { filesWrite: true, commandsExecute: true },
      commandEnvironment: { ...fakeKeys, cursor_api_key: "fake-lowercase-provider-value" },
    });
    expect(
      (await bridge.call("write", { file_path: "record.txt", content: "before" })).isError,
    ).toBe(false);
    await bridge.call("read", { file_path: "record.txt" });
    await bridge.call("edit", {
      file_path: "record.txt",
      old_string: "before",
      new_string: "after",
    });
    await bridge.call("glob", { pattern: "*.txt" });
    await bridge.call("grep", { pattern: "after" });
    await bridge.call("ls", {});
    await bridge.call("command", { command: "printf command-ok" });
    const allWrittenFiles = await Promise.all(
      ["record.txt"].map((name) => readFile(join(workspace, name), "utf8")),
    );
    const recorded = JSON.stringify({ specs, allWrittenFiles });
    for (const value of [...Object.values(fakeKeys), "fake-lowercase-provider-value"])
      expect(recorded).not.toContain(value);
    expect(specs.every((spec) => spec.replaceEnvironment)).toBe(true);
    await bridge.dispose();
  },
);

it("kills calls on abort, cancelAll and dispose, then refuses later calls", async () => {
  const { workspace, environment, processes } = await fixture();
  const bridge = createSplitExecutionBridge({
    environment,
    workspaceRoot: workspace,
    permissions: { filesWrite: true, commandsExecute: true },
  });
  const command = { command: "exec node -e 'setTimeout(() => {}, 30000)'" };
  const controller = new AbortController();
  const first = bridge.call("command", command, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await first;
  expect(processes.size).toBe(0);
  const second = bridge.call("command", command);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await bridge.cancelAll();
  await second;
  expect(processes.size).toBe(0);
  const third = bridge.call("command", command);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await bridge.dispose();
  await third;
  expect(processes.size).toBe(0);
  await expect(bridge.call("read", { file_path: "x" })).rejects.toThrow("disposed");
});
