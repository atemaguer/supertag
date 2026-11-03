import { expect, it } from "vitest";
import {
  cursorUsage,
  encodeWorkspaceResult,
  MAX_CURSOR_ERROR_CHARS,
  mapCursorEvent,
  parseCursorFrame,
  parseWorkspaceResult,
} from "./src/protocol.js";

it("parses every documented Cursor SDK event envelope without exposing tool payloads", () => {
  const events = [
    { type: "system" },
    { type: "user" },
    { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    { type: "thinking", text: "private thought" },
    { type: "tool_call", name: "shell", call_id: "c", status: "running", args: { secret: "x" } },
    { type: "tool_call", name: "shell", call_id: "c", status: "completed" },
    { type: "tool_call", name: "shell", call_id: "c", status: "error" },
    { type: "status", status: "RUNNING" },
    { type: "task", text: "checking" },
    {
      type: "usage",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
        totalTokens: 7,
        reasoningTokens: 1,
      },
    },
  ];
  for (const event of events) {
    const frame = parseCursorFrame(JSON.stringify({ type: "event", event }));
    expect(frame.type).toBe("event");
    if (frame.type === "event") expect(mapCursorEvent(frame.event).length).toBeGreaterThan(0);
  }
  expect(mapCursorEvent(events[3] as Record<string, unknown>)).toEqual([
    { type: "progress.updated", progress: { summary: "Cursor is reasoning" } },
  ]);
  expect(JSON.stringify(mapCursorEvent(events[4] as Record<string, unknown>))).not.toContain(
    "secret",
  );
  expect(() => mapCursorEvent({ type: "request", request_id: "approval" })).toThrow(/cannot grant/);
});

it("rejects malformed frames and invalid usage instead of inventing results", () => {
  expect(() => parseCursorFrame("{")).toThrow(/malformed JSON/);
  expect(() => parseCursorFrame("{}")).toThrow(/invalid frame/);
  expect(() =>
    parseCursorFrame(JSON.stringify({ type: "result", status: "error", error: { message: "x" } })),
  ).toThrow(/invalid frame/);
  expect(() =>
    parseCursorFrame(
      JSON.stringify({
        type: "result",
        status: "error",
        error: "x".repeat(MAX_CURSOR_ERROR_CHARS + 1),
      }),
    ),
  ).toThrow(/invalid frame/);
  expect(
    parseCursorFrame(JSON.stringify({ type: "result", status: "error", error: "bad option" })),
  ).toMatchObject({ status: "error", error: "bad option" });
  expect(() =>
    cursorUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 4 },
      "auto",
    ),
  ).toThrow(/inconsistent/);
});

it("accepts bounded runner diagnostics and rejects malformed messages", () => {
  expect(
    parseCursorFrame(
      JSON.stringify({ type: "error", code: "RATE_LIMITED", message: "retry later" }),
    ),
  ).toEqual({
    type: "error",
    code: "RATE_LIMITED",
    message: "retry later",
  });
  expect(() =>
    parseCursorFrame(
      JSON.stringify({
        type: "error",
        code: "SDK_FAILURE",
        message: "x".repeat(MAX_CURSOR_ERROR_CHARS + 1),
      }),
    ),
  ).toThrow(/invalid frame/);
  expect(() =>
    parseCursorFrame(JSON.stringify({ type: "error", code: "SDK_FAILURE", message: 42 })),
  ).toThrow(/invalid frame/);
  expect(() =>
    parseCursorFrame(JSON.stringify({ type: "error", code: "secret-key", message: "failed" })),
  ).toThrow(/invalid frame/);
});

it("reports token details, real provider cost, and unpriced usage", () => {
  const tokens = {
    inputTokens: 5,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    totalTokens: 12,
    reasoningTokens: 2,
  };
  expect(cursorUsage(tokens, "composer-2.5")).toMatchObject({
    cachedInputTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 2,
    unpricedModel: "composer-2.5",
  });
  expect(
    cursorUsage({ ...tokens, cacheWriteTokens: 0, totalTokens: 11 }, "composer-2.5"),
  ).toMatchObject({
    reportedCost: { currency: "USD", estimated: true },
  });
  expect(cursorUsage(tokens, "composer-2.5", 25)).toMatchObject({
    reportedCost: { amountMinor: 25, currency: "USD" },
  });
  expect(cursorUsage(tokens, "auto").unpricedModel).toBe("auto");
});

it("parses a workspace call frame and refuses malformed ones", () => {
  expect(
    parseCursorFrame(
      JSON.stringify({ type: "workspace_call", id: "workspace-1", name: "read", input: { a: 1 } }),
    ),
  ).toEqual({ type: "workspace_call", id: "workspace-1", name: "read", input: { a: 1 } });
  for (const frame of [
    { type: "workspace_call", id: "has space", name: "read" },
    { type: "workspace_call", id: "workspace-1", name: "Read" },
    { type: "workspace_call", id: "workspace-1", name: "../read" },
    { type: "workspace_call", id: 1, name: "read" },
    { type: "workspace_call", id: "workspace-1" },
  ])
    expect(() => parseCursorFrame(JSON.stringify(frame))).toThrow(/invalid frame/);
});

it("round-trips a workspace result and refuses a malformed one", () => {
  const line = encodeWorkspaceResult({ id: "workspace-1", text: "ok", isError: false });
  expect(line.endsWith("\n")).toBe(true);
  expect(parseWorkspaceResult(JSON.parse(line))).toEqual({
    type: "workspace_result",
    id: "workspace-1",
    text: "ok",
    isError: false,
  });
  for (const frame of [
    { type: "workspace_result", id: "workspace-1", text: "ok" },
    { type: "workspace_result", id: "bad id", text: "ok", isError: false },
    { type: "workspace_result", id: "workspace-1", text: 1, isError: false },
    { type: "other", id: "workspace-1", text: "ok", isError: false },
  ])
    expect(() => parseWorkspaceResult(frame)).toThrow(/invalid workspace result/);
});
