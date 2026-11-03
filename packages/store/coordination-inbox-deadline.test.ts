import { describe, expect, it } from "vitest";
import { inboxLimitReason } from "./src/coordination-inbox-store.js";

describe("inbox deadline warning", () => {
  const deadline = "2026-10-02T19:00:00.000Z";
  const event = {
    kind: "objective_deadline_approaching",
    message: `The Objective deadline ${deadline} is near: about 1 hour left.`,
  };

  it("uses the inbox read time", () => {
    expect(inboxLimitReason(event, deadline, "2026-10-02T18:33:00.000Z")).toBe(
      `The Objective deadline ${deadline} is near: about 27 minutes left.`,
    );
  });

  it("does not claim time remains after the deadline", () => {
    expect(inboxLimitReason(event, deadline, deadline)).toBe(
      `The Objective deadline ${deadline} has passed.`,
    );
  });

  it("keeps budget messages unchanged", () => {
    expect(
      inboxLimitReason(
        { kind: "objective_budget_threshold", message: "Budget reached" },
        deadline,
        deadline,
      ),
    ).toBe("Budget reached");
  });
});
