import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { claudeCommandUpdates } from "./src/index.ts";

const assistant = (content: unknown[]) =>
  ({ type: "assistant", message: { content } }) as unknown as SDKMessage;
const user = (content: unknown[]) =>
  ({ type: "user", message: { content } }) as unknown as SDKMessage;

it("reports a Bash call as running at tool_use and ended at its tool_result", () => {
  const running = new Map<string, string>();
  expect(
    claudeCommandUpdates(
      assistant([
        { type: "text", text: "Running tests" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test:verify" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x" } },
      ]),
      running,
    ),
  ).toEqual([{ id: "t1", command: "pnpm test:verify", status: "running" }]);
  expect(
    claudeCommandUpdates(
      user([
        { type: "tool_result", tool_use_id: "t2", content: "file" },
        { type: "tool_result", tool_use_id: "t1", is_error: true, content: "exit 1" },
      ]),
      running,
    ),
  ).toEqual([{ id: "t1", command: "pnpm test:verify", status: "failed" }]);
  expect(running.size).toBe(0);
  expect(claudeCommandUpdates(user([{ type: "tool_result", tool_use_id: "t1" }]), running)).toEqual(
    [],
  );
});

it("ignores other messages and bounds the open command table", () => {
  const running = new Map<string, string>();
  expect(
    claudeCommandUpdates({ type: "result", subtype: "success" } as SDKMessage, running),
  ).toEqual([]);
  expect(
    claudeCommandUpdates(user([{ type: "tool_use", id: "x", name: "Bash" }]), running),
  ).toEqual([]);
  for (let index = 0; index < 300; index++)
    claudeCommandUpdates(
      assistant([
        { type: "tool_use", id: `t${index}`, name: "Bash", input: { command: `echo ${index}` } },
      ]),
      running,
    );
  expect(running.size).toBe(256);
  expect(running.has("t0")).toBe(false);
  expect(running.has("t299")).toBe(true);
});
