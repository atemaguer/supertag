import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryContext, memoryFolder } from "@supertag/worker-sdk/internal/rust-harness";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspace } from "./src/rust-adapter/workspace.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("gives a read-only Cursor turn its memory folder, and only that, to write", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "supertag-cursor-memory-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  const memory = join(root, "native-memory-attempts", "attempt", "work");
  await mkdir(state, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(memory, { recursive: true, mode: 0o700 });
  vi.stubEnv("SUPERTAG_ADAPTER_STATE_DIRECTORY", state);
  vi.stubEnv("SUPERTAG_WORKSPACE_DIRECTORY", workspace);
  vi.stubEnv("SUPERTAG_NATIVE_MEMORY_DIRECTORY", memory);
  const folder = await memoryFolder(process.env, workspace);
  expect(folder?.directory).toBe(memory);
  expect(folder?.context).toContain("MEMORY.md is empty: this Tag keeps no memories here yet.");
  expect(memoryContext({}, "cursor")).toContain("Cursor keeps no memory of its own");

  const { executor } = await createWorkspace(
    ["files:read"],
    10_000,
    undefined,
    undefined,
    [],
    folder?.directory,
  );
  cleanups.push(() => executor.dispose());
  expect(executor.tools.map(({ name }) => name).sort()).toEqual([
    "edit",
    "glob",
    "grep",
    "ls",
    "read",
    "write",
  ]);
  const write = (path: string) =>
    executor.call("write", { file_path: path, content: "kept\n" }).then(
      (result) => !result.isError,
      () => false,
    );
  expect(await write(join(memory, "feedback_kept.md"))).toBe(true);
  expect(await readFile(join(memory, "feedback_kept.md"), "utf8")).toBe("kept\n");
  expect(await write("README.md")).toBe(false);
  expect(await write(join(root, "outside.md"))).toBe(false);
  await expect(stat(join(workspace, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });

  // Without a grant the tools are the Task's own: a read-only turn writes nothing.
  const fresh = join(root, "fresh-state");
  await mkdir(fresh, { mode: 0o700 });
  vi.stubEnv("SUPERTAG_ADAPTER_STATE_DIRECTORY", fresh);
  const plain = await createWorkspace(["files:read"], 10_000);
  cleanups.push(() => plain.executor.dispose());
  expect(plain.executor.tools.map(({ name }) => name)).not.toContain("write");
}, 30_000);
