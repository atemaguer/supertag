import { describe, expect, it } from "vitest";
import {
  CHANGE_SUMMARY_INSTRUCTION,
  commitSubject,
  type WorkspaceTask,
} from "./src/git-workspace.js";

function task(instruction?: string): WorkspaceTask {
  return {
    taskId: "fix-commit",
    attemptId: "attempt-1",
    workspacePlan: { mode: "none" },
    ...(instruction === undefined
      ? {}
      : {
          input: {
            origin: {} as never,
            messages: [{ role: "requester" as const, text: instruction }],
          },
        }),
  };
}

describe("commitSubject", () => {
  it("uses the request as an imperative subject", () => {
    expect(commitSubject(task("Please fix commit subjects for Workspace Tasks."))).toBe(
      "Fix commit subjects for Workspace Tasks",
    );
  });

  it("bounds long subjects and supplies a fallback", () => {
    expect(
      commitSubject(task(`Update ${"commit subject ".repeat(12)}`)).length,
    ).toBeLessThanOrEqual(72);
    expect(commitSubject(task())).toBe("Update task fix-commit");
  });

  it("strips a leading Title: label", () => {
    expect(commitSubject(task("Title: Add pause and resume\nDetails follow."))).toBe(
      "Add pause and resume",
    );
    expect(commitSubject(task("## title: fix the list command"))).toBe("Fix the list command");
  });

  it("keeps branch names, labels, and Markdown out of the subject", () => {
    expect(commitSubject(task("Implement item 2 on branch `feature/x`."))).toBe("Implement item 2");
    expect(commitSubject(task("## Task: fix the `list` command\nMore detail"))).toBe(
      "Fix the list command",
    );
    expect(commitSubject(task("\n- **Add** status output\n"))).toBe("Add status output");
  });

  it("falls back instead of using a first-person report", () => {
    expect(commitSubject(task("I am fixing the widget"))).toBe("Update task fix-commit");
    expect(commitSubject(task("Implemented item 2"))).toBe("Update task fix-commit");
  });

  it("never exceeds 72 characters for multiline instructions", () => {
    const subject = commitSubject(task(`${"Refactor ".repeat(20)}\nsecond line`));
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject).not.toContain("second line");
  });
});

describe("commitSubject round 2", () => {
  it("drops bare branch names and keeps the verb after a first-person intent", () => {
    expect(commitSubject(task("Review branch feature/x for regressions"))).toBe(
      "Review for regressions",
    );
    expect(commitSubject(task("I will fix the widget"))).toBe("Fix the widget");
  });

  it("prefers the harness change summary and falls back to the Task title", () => {
    const item = task("Item 3 of Objective parallelism");
    expect(commitSubject(item, "Done.\nChange: add pause and resume for Objectives")).toBe(
      "Add pause and resume for Objectives",
    );
    expect(commitSubject(item, "**Change:** `supertag pause` stops new Tasks.")).toBe(
      "Supertag pause stops new Tasks",
    );
    expect(commitSubject(task("Fix the docs links."), "No change line here.")).toBe(
      "Fix the docs links",
    );
    expect(commitSubject(task("Fix the docs links."), `Change: ${"x".repeat(73)}`)).toBe(
      "Fix the docs links",
    );
    expect(CHANGE_SUMMARY_INSTRUCTION).toContain("at most 72 characters");
  });
});
