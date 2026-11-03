import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EnvironmentPlan, ExecutionEnvironment } from "@supertag/worker-sdk";
import { expect, test } from "vitest";
import {
  capturePortableCodexSessionState,
  restorePortableCodexSessionState,
  validatePortableCodexSessionState,
} from "./src/portable-session-state.js";

const exec = promisify(execFile);
function transcript(id: string, parent?: string): string {
  return `${[
    {
      type: "session_meta",
      payload: {
        id,
        cwd: "/old/workspace",
        source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "exec",
      },
    },
    { type: "turn_context", payload: { cwd: "/old/workspace" } },
    { type: "response_item", payload: { text: "Keep /old/workspace literal 🐦" } },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n")}\n`;
}
function environment(root: string): ExecutionEnvironment {
  return {
    id: root,
    placement: "remote",
    rootDirectory: root,
    resolvePath: (path) => join(root, path),
    read: (path) => readFile(join(root, path), "utf8"),
    readBytes: (path) => readFile(join(root, path)),
    async spawn(spec) {
      const promise = exec(spec.command, [...(spec.args ?? [])], { timeout: spec.timeoutMs });
      return {
        async wait() {
          try {
            return { exitCode: 0, ...(await promise) };
          } catch (error) {
            const failed = error as { code?: number; stdout?: string; stderr?: string };
            return {
              exitCode: typeof failed.code === "number" ? failed.code : 1,
              stdout: failed.stdout ?? "",
              stderr: failed.stderr ?? "",
            };
          }
        },
        kill() {},
      };
    },
    async prepare(plan: EnvironmentPlan) {
      for (const file of plan.files) {
        const path = join(root, file.path);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, file.content, { flag: "wx", mode: file.mode });
      }
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("captures exact parent/descendant transcripts and restores after source disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-portable-")),
    dest = await mkdtemp(join(tmpdir(), "codex-portable-"));
  const source = environment(root),
    target = environment(dest);
  try {
    await mkdir(join(root, ".codex/sessions/2026/09/07"), { recursive: true });
    for (const [id, parent] of [
      ["root", undefined],
      ["child", "root"],
      ["grandchild", "child"],
      ["unrelated", undefined],
    ])
      await writeFile(
        join(root, `.codex/sessions/2026/09/07/${id}.jsonl`),
        transcript(id ?? "", parent),
      );
    await writeFile(join(root, ".codex/auth.json"), "SECRET");
    const snapshot = await capturePortableCodexSessionState(source, "root", "/old/workspace");
    expect(snapshot?.transcripts).toHaveLength(3);
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    await source.dispose("completed");
    if (!snapshot) throw new Error("Missing snapshot");
    await restorePortableCodexSessionState(snapshot, target, "/new/workspace", { mode: "none" });
    const restored = await target.read(".codex/sessions/2026/09/07/root.jsonl");
    expect(restored).toContain('"cwd":"/new/workspace"');
    expect(restored).toContain("Keep /old/workspace literal 🐦");
  } finally {
    await source.dispose("completed");
    await target.dispose("completed");
  }
});
test("rejects traversal, unrelated lineage, duplicate IDs and malformed JSON", () => {
  const base = {
    version: 1,
    threadId: "root",
    workspace: "/old/workspace",
    transcripts: [{ path: "root.jsonl", text: transcript("root") }],
  };
  expect(() => validatePortableCodexSessionState(base)).not.toThrow();
  for (const transcripts of [
    [{ path: "../auth.jsonl", text: transcript("root") }],
    [...base.transcripts, { path: "other.jsonl", text: transcript("other") }],
    [...base.transcripts, { path: "duplicate.jsonl", text: transcript("root") }],
    [{ path: "root.jsonl", text: `${transcript("root")}invalid` }],
    [{ path: "root.jsonl", text: "x".repeat(8 * 1024 * 1024 + 1) }],
  ])
    expect(() => validatePortableCodexSessionState({ ...base, transcripts })).toThrow();
});
test("rejects symlink sessions without reading external transcripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-portable-"));
  const env = environment(root);
  try {
    await mkdir(join(root, ".codex/sessions"), { recursive: true });
    await writeFile(join(root, "outside.jsonl"), transcript("root"));
    await symlink(join(root, "outside.jsonl"), join(root, ".codex/sessions/root.jsonl"));
    await expect(capturePortableCodexSessionState(env, "root", "/old/workspace")).rejects.toThrow();
  } finally {
    await env.dispose("completed");
  }
});
test("reports a fixed, path-free reason when a transcript exceeds the archive bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-portable-"));
  const env = environment(root);
  try {
    await mkdir(join(root, ".codex/sessions/2026/10/02"), { recursive: true });
    const large = `${transcript("root").trimEnd()}\n${JSON.stringify({ text: "x".repeat(3 * 1024 * 1024) })}\n`;
    await writeFile(join(root, ".codex/sessions/2026/10/02/root.jsonl"), large);
    // Rollouts past 2 MiB are normal for long Attempts and must still archive.
    const snapshot = await capturePortableCodexSessionState(env, "root", "/old/workspace");
    expect(snapshot?.transcripts[0]?.text.length).toBe(large.length);
    await writeFile(
      join(root, ".codex/sessions/2026/10/02/root.jsonl"),
      `${large}${JSON.stringify({ text: "x".repeat(6 * 1024 * 1024) })}\n`,
    );
    const failure = capturePortableCodexSessionState(env, "root", "/old/workspace");
    await expect(failure).rejects.toThrow(
      "Could not enumerate Codex Session transcripts: session file exceeds size limit",
    );
    await expect(failure).rejects.not.toThrow(root);
  } finally {
    await env.dispose("completed");
  }
});
