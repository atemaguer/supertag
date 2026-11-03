import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isValidGitRef, taskWorkspaceBranch } from "../packages/core/src/index.js";

describe("Task branch names", () => {
  it("uses the Objective and Task names without repeating the Objective", () => {
    expect(taskWorkspaceBranch("alpha-onboarding", "alpha-onboarding:short-branch-names")).toBe(
      "supertag/alpha-onboarding/short-branch-names",
    );
  });

  it("shortens the reported Mailbox branch without retaining its UUID or unconditional hash", () => {
    expect(
      taskWorkspaceBranch(
        "the-readme-explains-m7j2",
        "message:25754231-5efd-4c5a-91ca-1529d9f45c6a",
      ),
    ).toBe("supertag/the-readme-explains-m7j2/message");
  });

  it("adds a suffix only for collisions, including collisions with a suffixed name", () => {
    const occupied = new Set<string>();
    const names = ["demo:fix/readme", "demo:fix-readme", "demo:Fix-Readme"];
    for (const task of names) {
      const branch = taskWorkspaceBranch("demo", task, occupied);
      expect(occupied.has(branch)).toBe(false);
      occupied.add(branch);
    }
    expect([...occupied][0]).toBe("supertag/demo/fix-readme");
    expect([...occupied][1]).toMatch(/^supertag\/demo\/fix-readme-[a-f0-9]{8}$/u);
    const next = taskWorkspaceBranch("demo", names[1] as string, occupied);
    expect(occupied.has(next)).toBe(false);
    expect(next.length).toBeLessThanOrEqual(120);
  });

  it("resolves truncation, Objective slug, and case-insensitive collisions", () => {
    const first = taskWorkspaceBranch("A.B", `demo-${"a".repeat(200)}-one`);
    const second = taskWorkspaceBranch("a-b", `demo-${"a".repeat(200)}-two`, [first]);
    expect(second).not.toBe(first);
    expect(taskWorkspaceBranch("demo", "fix", ["SUPERTAG/DEMO/FIX"])).not.toBe("supertag/demo/fix");
  });

  it.each([
    [".lock", ".."],
    ["a.lock/b", "@{bad}~^:?*[\\"],
    ["///", "--"],
    ["日本語", "你好 🚀"],
    ["a".repeat(200), "b".repeat(200)],
    ["A.B", "Fix...the\nREADME\u0000"],
    ["demo", "25754231-5efd-4c5a-91ca-1529d9f45c6a"],
  ])("produces bounded git-safe names from %j and %j", (objective, task) => {
    const branch = taskWorkspaceBranch(objective, task);
    expect(branch.length).toBeLessThanOrEqual(120);
    expect(isValidGitRef(branch)).toBe(true);
    expect(() => execFileSync("git", ["check-ref-format", `refs/heads/${branch}`])).not.toThrow();
    expect(() => execFileSync("git", ["check-ref-format", "--branch", branch])).not.toThrow();
  });
});
