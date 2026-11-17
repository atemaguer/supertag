import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { ExecutionEnvironment, ProcessSpec } from "@supertag/worker-sdk";
import { spawnOwnedProcess } from "@supertag/worker-sdk/internal/rust-harness";
import {
  COMMAND_GRACE_MS,
  createWorkspaceOperations,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { afterEach, expect, it, vi } from "vitest";

const cleanups: (() => Promise<void>)[] = [];
const allActions = ["files:read", "files:write", "commands:execute"];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "supertag-e2b-operations-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = "repository";
  const workspace = join(root, workspaceRoot);
  await mkdir(workspace);
  const specs: ProcessSpec[] = [];
  const captured: { stdout: string; stderr: string }[] = [];
  const environment: ExecutionEnvironment = {
    id: "e2b-fixture",
    placement: "remote",
    rootDirectory: root,
    async prepare() {},
    async dispose() {},
    resolvePath: (path) => posix.resolve(root, path),
    read: (path) => readFile(path, "utf8"),
    async spawn(spec, signal) {
      specs.push(spec);
      const process = await spawnOwnedProcess({
        spec,
        cwd: spec.cwd ?? root,
        // Simulate variables baked into a sandbox image, even when the SDK
        // received a replace-environment request for the provider process.
        environment: { E2B_API_KEY: "sandbox-canary", CURSOR_API_KEY: "model-canary", HOME: root },
        ...(signal ? { signal } : {}),
        maximumOutput: 64 * 1024,
        record: async () => {},
      });
      return {
        ...process,
        async wait() {
          const result = await process.wait();
          captured.push(result);
          return result;
        },
      };
    },
  };
  const operations = (
    allowedActions: readonly string[] = allActions,
    limits?: Parameters<typeof createWorkspaceOperations>[0]["limits"],
  ) => {
    const tools = createWorkspaceOperations({
      environment,
      workspaceRoot,
      allowedActions,
      ...(limits ? { limits } : {}),
    });
    cleanups.push(() => tools.dispose());
    return tools;
  };
  return { root, workspace, environment, specs, captured, operations };
}

it("rejects out-of-root paths and ungranted operations before contacting the sandbox", async () => {
  const { environment, operations, specs } = await fixture();
  for (const workspaceRoot of [".", "../repository", "/repository", "repository/../other"]) {
    expect(() =>
      createWorkspaceOperations({ environment, workspaceRoot, allowedActions: allActions }),
    ).toThrow(/workspace root/i);
  }
  const tools = operations(["files:read", "commands:execute"]);
  for (const path of ["/etc/passwd", "../outside", "nested/../file", "file\nname"]) {
    await expect(tools.execute({ kind: "read", path })).rejects.toThrow(/relative path/i);
  }
  await expect(tools.execute({ kind: "write", path: "file", content: "write" })).rejects.toThrow(
    /files:write/,
  );
  await expect(tools.execute({ kind: "command", command: "true" })).rejects.toThrow(/files:write/);
  await expect(operations(["files:write"]).execute({ kind: "read", path: "file" })).rejects.toThrow(
    /files:read/,
  );
  expect(specs).toEqual([]);
});

it("runs typed file operations under the authorized workspace", async () => {
  const { workspace, operations } = await fixture();
  const tools = operations();
  await expect(
    tools.execute({ kind: "write", path: "nested/a.txt", content: "first\nsecond\nthird" }),
  ).resolves.toMatchObject({ isError: false });
  await expect(
    tools.execute({ kind: "read", path: "nested/a.txt", offset: 2, limit: 1 }),
  ).resolves.toMatchObject({ text: expect.stringContaining("second") });
  await expect(
    tools.execute({ kind: "edit", path: "nested/a.txt", oldText: "second", newText: "changed" }),
  ).resolves.toMatchObject({ isError: false });
  expect(await readFile(join(workspace, "nested/a.txt"), "utf8")).toBe("first\nchanged\nthird");
  await expect(
    tools.execute({ kind: "glob", pattern: "**/*.txt", path: "." }),
  ).resolves.toMatchObject({ text: "nested/a.txt" });
  await expect(
    tools.execute({
      kind: "grep",
      pattern: "changed",
      path: "nested",
      glob: "*.txt",
      outputMode: "count",
    }),
  ).resolves.toMatchObject({ text: expect.stringContaining("a.txt:1") });
  await expect(tools.execute({ kind: "ls", path: "." })).resolves.toMatchObject({
    text: expect.stringContaining("nested"),
  });
}, 15_000);

it("rejects file operations through an escaping symlink", async () => {
  const { root, workspace, operations } = await fixture();
  const tools = operations();
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(workspace, "escape"));
  await expect(tools.execute({ kind: "read", path: "escape" })).rejects.toThrow(
    /escapes workspace/,
  );
  await expect(
    tools.execute({ kind: "write", path: "escape", content: "overwrite" }),
  ).rejects.toThrow(/escapes workspace/);
  expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("outside");
});

it("runs bounded foreground commands with a clean non-login environment and a verified cwd", async () => {
  const { root, workspace, operations, specs, captured } = await fixture();
  const tools = operations(allActions, { maxOutputBytes: 64, commandTimeoutMs: 4_000 });
  await expect(
    tools.execute({
      kind: "command",
      command: `printf "%s/%s" "\${E2B_API_KEY-unset}" "\${CURSOR_API_KEY-unset}"; printf x > result.txt`,
      timeoutMs: 999_999,
    }),
  ).resolves.toEqual({ text: "unset/unset", isError: false });
  expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("x");
  const command = specs.at(-1);
  // The wrapper enforces the 4 s deadline in the sandbox; the provider's stop waits longer.
  expect(command?.timeoutMs).toBe(4_000 + COMMAND_GRACE_MS);
  expect(command?.args).toContain("4000");
  expect(command?.replaceEnvironment).toBe(true);
  expect(command?.args).not.toContain("-lc");
  const bounded = await tools.execute({
    kind: "command",
    command: "printf %70000s x; printf %70000s y >&2",
  });
  expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(64);
  expect(bounded.text).toContain("[truncated]");
  expect(Buffer.byteLength(captured.at(-1)?.stdout ?? "")).toBe(16 * 1024);
  expect(Buffer.byteLength(captured.at(-1)?.stderr ?? "")).toBe(16 * 1024);

  const sibling = join(root, "sibling");
  await mkdir(sibling);
  await rm(workspace, { recursive: true });
  await symlink(sibling, workspace);
  await expect(
    tools.execute({ kind: "command", command: "printf escaped > leaked.txt" }),
  ).resolves.toMatchObject({ isError: true });
  await expect(readFile(join(sibling, "leaked.txt"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("bounds incoming writes and edit expansion before mutating a file", async () => {
  const { workspace, operations, specs } = await fixture();
  const tools = operations();
  await expect(
    tools.execute({ kind: "write", path: "file", content: "x".repeat(1024 * 1024) }),
  ).rejects.toThrow(/limit/i);
  expect(specs).toEqual([]);
  const original = "x".repeat(100_000);
  await writeFile(join(workspace, "file"), original);
  await expect(
    tools.execute({
      kind: "edit",
      path: "file",
      oldText: "x",
      newText: "y".repeat(100),
      replaceAll: true,
    }),
  ).rejects.toThrow(/limit/i);
  expect(await readFile(join(workspace, "file"), "utf8")).toBe(original);
});

it("cancels an active foreground command and fences later calls after disposal", async () => {
  const { operations, specs } = await fixture();
  const tools = operations();
  const controller = new AbortController();
  const running = tools.execute({ kind: "command", command: "exec sleep 30" }, controller.signal);
  const cancelled = expect(running).rejects.toThrow();
  await vi.waitFor(() => expect(specs).toHaveLength(1));
  controller.abort(new Error("Attempt cancelled"));
  await cancelled;
  await tools.dispose();
  await expect(tools.execute({ kind: "command", command: "true" })).rejects.toThrow(/closed/i);
  // The cancel stopped the command's group with a second sandbox process, never the provider.
  expect(specs).toHaveLength(2);
  expect(specs[1]?.args?.join(" ")).toContain("killpg");
});

it("stops a command at its deadline inside the sandbox, with its process group", async () => {
  const { workspace, operations } = await fixture();
  const tools = operations(allActions, { commandTimeoutMs: 1_500 });
  const started = Date.now();
  const result = await tools.execute({
    kind: "command",
    command: "(sleep 30; echo late > late.txt) & echo started; sleep 30",
  });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("deadline");
  expect(Date.now() - started).toBeLessThan(10_000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await expect(readFile(join(workspace, "late.txt"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("fails every tool once the sandbox becomes unreachable and never runs it on the host", async () => {
  const { environment, operations, workspace } = await fixture();
  const tools = operations();
  await expect(
    tools.execute({ kind: "write", path: "before.txt", content: "ok" }),
  ).resolves.toEqual(expect.objectContaining({ isError: false }));
  // The sandbox disappears mid-turn.
  const unreachable = () => Promise.reject(new Error("sandbox is unreachable"));
  vi.spyOn(environment, "spawn").mockImplementation(unreachable);
  vi.spyOn(environment, "read").mockImplementation(unreachable);
  const marker = join(workspace, "fallback.txt");
  for (const operation of [
    { kind: "write", path: "fallback.txt", content: "host" },
    { kind: "edit", path: "before.txt", oldText: "ok", newText: "host" },
    { kind: "read", path: "before.txt" },
    { kind: "command", command: `touch ${marker}` },
  ] as const)
    await expect(tools.execute(operation)).rejects.toThrow();
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(process.cwd(), "fallback.txt"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(workspace, "before.txt"), "utf8")).toBe("ok");
});
