import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { workSessionBranch } from "../packages/control-plane/src/work-sessions.js";
import { isValidGitRef } from "../packages/core/src/index.js";

describe("work Session branch names", () => {
  it("names one branch per Session from its id", () => {
    expect(workSessionBranch("3f2a91c4-0b77-4e51-9f0e-2b6c1d8a4e13")).toBe(
      "supertag/session/3f2a91c4",
    );
    // Two Sessions never share a branch, because the Session id never repeats.
    expect(workSessionBranch("9c0d2e71-aaaa-4bbb-8ccc-ddddeeeeffff")).not.toBe(
      workSessionBranch("3f2a91c4-0b77-4e51-9f0e-2b6c1d8a4e13"),
    );
  });

  it("numbers the next branch after the one a Task of the Session already delivered onto", () => {
    const session = "3f2a91c4-0b77-4e51-9f0e-2b6c1d8a4e13";
    const first = workSessionBranch(session);
    const second = workSessionBranch(session, first);
    expect(second).toBe(`${first}-2`);
    expect(workSessionBranch(session, second)).toBe(`${first}-3`);
  });

  it.each(["", "----", "@{bad}~^:?*[\\", "日本語", ".lock", "a".repeat(200), randomUUID()])(
    "produces a bounded git-safe name from %j",
    (sessionId) => {
      for (const branch of [workSessionBranch(sessionId), workSessionBranch(sessionId, "x-9")]) {
        expect(branch.length).toBeLessThanOrEqual(120);
        expect(isValidGitRef(branch)).toBe(true);
        expect(() =>
          execFileSync("git", ["check-ref-format", `refs/heads/${branch}`]),
        ).not.toThrow();
        expect(() => execFileSync("git", ["check-ref-format", "--branch", branch])).not.toThrow();
      }
    },
  );
});
