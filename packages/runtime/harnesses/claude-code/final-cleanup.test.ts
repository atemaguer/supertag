import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ExecutionCleanupError, type ExecutionEnvironment } from "@supertag/worker-sdk";
import { afterAll, expect, it, vi } from "vitest";

const finalMessage = {
  type: "result",
  subtype: "success",
  result: "Reviewed.",
  session_id: "final-cleanup",
} as SDKMessage;
const failure = new ExecutionCleanupError("Claude Code process termination could not be confirmed");

// The query passes the final result on when it arrives and fails its stream when cleanup after
// it cannot be confirmed. The harness must surface that failure instead of ending normally.
vi.mock("./src/query.js", async (original) => {
  const actual = await original<typeof import("./src/query.js")>();
  return {
    ...actual,
    isClaudeFinalResult: (message: SDKMessage) => message === finalMessage,
    claudeQuery: async function* () {
      yield { type: "system", subtype: "init", session_id: "final-cleanup" } as SDKMessage;
      yield finalMessage;
      throw failure;
    },
  };
});

const { runClaudeCode } = await import("./src/index.ts");
const workspace = await mkdtemp(join(tmpdir(), "claude-final-cleanup-"));
afterAll(() => rm(workspace, { recursive: true, force: true }));

function environment(rootDirectory: string): ExecutionEnvironment {
  return {
    id: "local:test",
    placement: "local",
    rootDirectory,
    prepare: async () => undefined,
    resolvePath: (path: string) => join(rootDirectory, path),
    read: async (path: string) => await readFile(join(rootDirectory, path), "utf8"),
    spawn: async () => {
      throw new Error("not used");
    },
    dispose: async () => undefined,
  };
}

it("fails after the final result when Claude Code cleanup cannot be confirmed", async () => {
  const local = environment(workspace);
  const events: string[] = [];
  await expect(
    (async () => {
      for await (const event of runClaudeCode(
        {
          prompt: "Review",
          runtimeDirectory: workspace,
          workspace,
          timeoutMs: 60_000,
          mcpServers: [],
          runtimeActions: [],
        },
        local,
        local,
        undefined,
        (() => {
          throw new Error("claudeQuery is mocked");
        }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
      ))
        events.push(event.type === "output.message" && event.final ? "final" : event.type);
    })(),
  ).rejects.toBe(failure);
  expect(events).toContain("final");
});
