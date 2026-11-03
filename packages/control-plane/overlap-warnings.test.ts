import { describe, expect, it, vi } from "vitest";
import { detectOverlapWarnings } from "./src/overlap-warnings.js";

const workspacePlan = {
  version: 1 as const,
  status: "workspace" as const,
  workspace: "repo",
  branch: "task",
  delivery: { mode: "none" },
};

function report(
  attemptId: string,
  teamId: string,
  tagId: string,
  paths: string[],
  workspace = "repo",
) {
  return {
    attemptId,
    taskId: `task-${attemptId}`,
    teamId,
    tagId,
    workspacePlan: { ...workspacePlan, workspace },
    paths,
    truncated: false,
    reportedAt: "2026-10-07T00:00:00.000Z",
  };
}

describe("overlap warnings", () => {
  it("posts once per Attempt pair and addresses both Tags and the lead", async () => {
    const rows = [
      report("a", "team", "alice", ["src/a.ts"]),
      report("b", "team", "bob", ["src/a.ts"]),
    ];
    const posted = new Set<string>();
    const store = {
      recordTaskAttemptChangedPaths: vi.fn(async () => {}),
      listRunningTaskAttemptChangedPaths: vi.fn(async () => rows),
      getTeam: vi.fn(async () => ({ leadTagId: "lead" })),
      getTaskAssignment: vi.fn(async () => ({ objectiveId: "objective" })),
      recordOverlapWarning: vi.fn(async (input: { paths: string[] }) => {
        const key = input.paths.join(",");
        if (posted.has(key)) return undefined;
        posted.add(key);
        return { id: "post", authorTagId: null, to: ["alice", "bob", "lead"], type: "evidence" };
      }),
    };
    const live = { deliverPost: vi.fn() };
    await detectOverlapWarnings(store as never, live as never, [
      { attemptId: "a", paths: ["src/a.ts"], truncated: false },
    ]);
    await detectOverlapWarnings(store as never, live as never, [
      { attemptId: "a", paths: ["src/a.ts"], truncated: false },
    ]);
    expect(store.recordOverlapWarning).toHaveBeenCalledTimes(2);
    expect(store.recordOverlapWarning).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ["src/a.ts"], to: ["alice", "bob", "lead"] }),
    );
    expect(live.deliverPost).toHaveBeenCalledTimes(1);
  });

  it("ignores different files, Teams, repositories, and truncated scans", async () => {
    const recordOverlapWarning = vi.fn();
    const rows = [
      report("a", "team", "alice", ["src/a.ts"]),
      report("b", "team", "bob", ["src/b.ts"]),
      report("c", "other", "carol", ["src/a.ts"]),
      report("d", "team", "dave", ["src/a.ts"], "elsewhere"),
      { ...report("e", "team", "eve", ["src/a.ts"]), truncated: true },
    ];
    const store = {
      recordTaskAttemptChangedPaths: vi.fn(async () => {}),
      listRunningTaskAttemptChangedPaths: vi.fn(async () => rows),
      recordOverlapWarning,
    };
    await detectOverlapWarnings(store as never, { deliverPost: vi.fn() } as never, [
      { attemptId: "a", paths: ["src/a.ts"], truncated: false },
    ]);
    expect(recordOverlapWarning).not.toHaveBeenCalled();
  });
});
