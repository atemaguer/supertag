import { describe, expect, it } from "vitest";
import {
  deleteHarnessMemoryArgs,
  listHarnessMemoryArgs,
  parseHarnessMemory,
  parseHarnessMemoryList,
} from "./harness-memory";

const record = {
  memory_id: "hmem_0123456789abcdef01234567",
  tag_id: "lead",
  harness: "claude-code",
  shared: false,
  audience: "client:ada",
  scope: "person-0123",
  kind: "feedback",
  title: "Prefer squash merges",
  hook: "merge pull requests by squashing",
  text: "Prefer squash merges.",
  truncated: false,
  trust: "proposed-only",
  status: "owned",
  source: {
    host_id: "local",
    native_id: "claude-code:feedback_squash.md",
    path: "feedback_squash.md",
    revision: 3,
  },
  source_task_id: "task-1",
  content_hash: "abc",
  created_at: "2026-11-19T10:00:00Z",
  updated_at: "2026-11-19T11:00:00Z",
};

describe("harness memory from the CLI", () => {
  it("asks the local services' state directory for one Tag's harness memory only", () => {
    expect(listHarnessMemoryArgs("/state", "lead")).toEqual([
      "get",
      "memories",
      "--native",
      "--tag",
      "lead",
      "--state-directory",
      "/state",
    ]);
    expect(deleteHarnessMemoryArgs("/state", record.memory_id)).toEqual([
      "delete",
      "memory",
      record.memory_id,
      "--state-directory",
      "/state",
    ]);
  });

  it("reads each memory with who sees it, its trust, and where it is kept", () => {
    const list = parseHarnessMemoryList(
      JSON.stringify({ native_memory: [record], native_memory_kept_on: ["laptop-2"] }),
    );
    expect(list).toEqual({
      memories: [
        {
          memoryId: record.memory_id,
          tagId: "lead",
          harness: "claude-code",
          private: true,
          kind: "feedback",
          title: "Prefer squash merges",
          hook: "merge pull requests by squashing",
          text: "Prefer squash merges.",
          truncated: false,
          trust: "proposed-only",
          path: "feedback_squash.md",
          hostId: "local",
          updatedAtMs: Date.parse("2026-11-19T11:00:00Z"),
        },
      ],
      keptOn: ["laptop-2"],
    });
    expect(parseHarnessMemory(JSON.stringify(record)).memoryId).toBe(record.memory_id);
  });

  it("says why none can be read, and refuses output it doesn't understand", () => {
    expect(
      parseHarnessMemoryList(
        JSON.stringify({ native_memory: [], native_memory_unavailable: "No Worker Host runs." }),
      ),
    ).toEqual({ memories: [], keptOn: [], unavailable: "No Worker Host runs." });
    expect(() => parseHarnessMemoryList("{}")).toThrow(/can't list harness memory/u);
    expect(() => parseHarnessMemoryList("not json")).toThrow(/can't list harness memory/u);
    expect(() => parseHarnessMemory(JSON.stringify({ memory_id: "x" }))).toThrow();
  });
});
