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
  objectiveId: string,
  paths: string[],
  workspace = "repo",
): {
  attemptId: string;
  taskId: string;
  objectiveId: string;
  workspacePlan: typeof workspacePlan;
  paths: string[];
  truncated: boolean;
  reportedAt: string;
} {
  return {
    attemptId,
    taskId: `task-${attemptId}`,
    objectiveId,
    workspacePlan: { ...workspacePlan, workspace },
    paths,
    truncated: false,
    reportedAt: "2026-10-07T00:00:00.000Z",
  };
}

function overlapStore(rows: ReturnType<typeof report>[]) {
  const recorded = new Set<string>();
  return {
    recordTaskAttemptChangedPaths: vi.fn(async () => {}),
    listRunningTaskAttemptChangedPaths: vi.fn(async () => rows),
    recordOverlaps: vi.fn(
      async (input: {
        objectiveId: string;
        firstAttemptId: string;
        secondAttemptId: string;
        paths: readonly string[];
      }) => {
        const [lowerAttemptId, higherAttemptId] = [
          input.firstAttemptId,
          input.secondAttemptId,
        ].sort();
        return input.paths
          .filter((path) => {
            const key = `${lowerAttemptId}:${higherAttemptId}:${path}`;
            if (recorded.has(key)) return false;
            recorded.add(key);
            return true;
          })
          .map((path) => ({
            objectiveId: input.objectiveId,
            lowerAttemptId: lowerAttemptId ?? "",
            higherAttemptId: higherAttemptId ?? "",
            path,
          }));
      },
    ),
  };
}

describe("overlap warnings", () => {
  it("tells the Objective's conversation once per overlapping Attempt pair and path", async () => {
    const store = overlapStore([
      report("a", "objective", ["src/a.ts"]),
      report("b", "objective", ["src/a.ts"]),
    ]);
    const notify = vi.fn(async () => {});
    const scan = [{ attemptId: "a", paths: ["src/a.ts"], truncated: false }];
    await detectOverlapWarnings(store as never, notify, scan);
    await detectOverlapWarnings(store as never, notify, scan);
    expect(store.recordOverlaps).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    const [objectiveId, key, text] = notify.mock.calls[0] as unknown as [string, string, string];
    expect(objectiveId).toBe("objective");
    expect(key).toMatch(/^overlap:a:b:[0-9a-f]{16}$/u);
    expect(text).toContain("Tasks task-a and task-b of this Objective");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("Workspace repo");
    expect(text).toContain("continue one work Session");
  });

  it("warns again about a newly overlapping path of the same pair", async () => {
    const rows = [report("a", "objective", ["src/a.ts"]), report("b", "objective", ["src/a.ts"])];
    const store = overlapStore(rows);
    const notify = vi.fn(async () => {});
    await detectOverlapWarnings(store as never, notify, [
      { attemptId: "a", paths: ["src/a.ts"], truncated: false },
    ]);
    rows[0]?.paths.push("src/b.ts");
    rows[1]?.paths.push("src/b.ts");
    await detectOverlapWarnings(store as never, notify, [
      { attemptId: "a", paths: ["src/a.ts", "src/b.ts"], truncated: false },
    ]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]?.[2]).toContain("src/b.ts");
    expect(notify.mock.calls[1]?.[2]).not.toContain("src/a.ts");
  });

  it("ignores different files, Objectives, repositories, and truncated scans", async () => {
    const store = overlapStore([
      report("a", "objective", ["src/a.ts"]),
      report("b", "objective", ["src/b.ts"]),
      report("c", "other", ["src/a.ts"]),
      report("d", "objective", ["src/a.ts"], "elsewhere"),
      { ...report("e", "objective", ["src/a.ts"]), truncated: true },
    ]);
    const notify = vi.fn(async () => {});
    await detectOverlapWarnings(store as never, notify, [
      { attemptId: "a", paths: ["src/a.ts"], truncated: false },
    ]);
    expect(store.recordOverlaps).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
