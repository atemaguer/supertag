import { describe, expect, it } from "vitest";
import { operatorNotice } from "../apps/cli/src/operator-notice.js";

const notice = (reason: string) =>
  `Needs you: owner stalled. SuperTag wrote this notice: the Objective is still working, but no owner activation is running, queued, or waiting, and SuperTag will not start another automatically because ${reason}. Reply with direction to wake the owner, or update or cancel the Objective.`;

describe("operatorNotice", () => {
  it.each([
    ["authentication failed: Please run /login", "Sign in", "claude"],
    ["billing: insufficient credits", "Fix the provider billing", "insufficient credits"],
    ["configuration: invalid model", "Fix the configuration", "invalid model"],
  ])("preserves %s and gives a fitting recovery", (error, recovery, detail) => {
    const original = notice(
      `its last activation failed with an error only an operator can fix (${error})`,
    );
    const text = operatorNotice(original);
    expect(text).toContain(recovery);
    expect(text).toContain(detail);
    expect(text).toContain("before asking the owner to continue");
    expect(text).not.toContain("to restart the owner");
    expect(original).toContain("no owner activation");
  });

  it("keeps the latest failure when automatic retries run out", () => {
    const text = operatorNotice(
      notice(
        "its activations failed 4 times, past the limit of 3 automatic continuations (latest: connection reset)",
      ),
    );
    expect(text).toContain("connection reset");
    expect(text).toContain("reply with your next instruction to restart the owner");
  });

  it("preserves review context and leaves unrelated messages unchanged", () => {
    const original = notice("its last activation was cancelled").replace(
      " Reply with",
      " Submitted results awaiting the owner's review: task-1. Reply with",
    );
    expect(operatorNotice(original)).toContain("task-1");
    expect(operatorNotice("Please run /login")).toBe("Please run /login");
  });
});
