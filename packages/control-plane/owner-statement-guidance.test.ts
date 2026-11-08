import { OBJECTIVE_STATEMENT_TEMPLATE } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { deliveryTurnMessages } from "./src/objective-sessions.js";

const objective = {
  id: "objective",
  outcome: "Ship the importer. Done when the suite passes.",
  deadline: "2026-11-30T00:00:00.000Z",
  ongoing: false,
  workspaces: ["service"],
};

function ownerTurn(
  reason: "objective_start" | "objective_idle" | "objective_notice" | "approval_decision",
  text: string,
  context: Parameters<typeof deliveryTurnMessages>[4] = { objective },
) {
  return deliveryTurnMessages(
    { kind: "delivery", from: { kind: "supertag" }, reason, objectiveId: objective.id },
    text,
    "session",
    true,
    context,
  );
}

describe("what an Objective's owner is told on its own turns", () => {
  it("names each part of the statement template in order", () => {
    expect(OBJECTIVE_STATEMENT_TEMPLATE).toBe(
      "<desired end state>. Done when <specific evidence>. Keep <constraints>. Use <boundaries>. Between steps, <how to choose the next action>. If blocked, stop and report <what you tried and what would unlock it>.",
    );
  });

  it("tells the owner how to do the work, finish it, and where its reply goes", () => {
    const { system, prompt } = ownerTurn("objective_start", "Objective objective has started.");
    expect(system).toContain(`conversation of Objective ${objective.id}`);
    expect(system).toContain("start_session {title, instruction}");
    expect(system).toContain("continue_session {sessionId, message}");
    expect(system).toContain("ask {question}");
    expect(system).toContain("status ready_for_review");
    expect(system).toContain("home thread");
    expect(system).toContain(objective.deadline);
    // The outcome reaches the turn as data, not as instructions in the system message.
    expect(system).not.toContain(objective.outcome);
    expect(prompt).toContain(`<objective-outcome>\n${objective.outcome}\n</objective-outcome>`);
    expect(prompt).toContain("has started");
  });

  it("says why each kind of turn runs", () => {
    expect(ownerTurn("objective_start", "").system).toContain("The Objective just started");
    expect(ownerTurn("objective_idle", "").system).toContain("nothing running and nothing asked");
    expect(ownerTurn("objective_idle", "").system).toContain("the Objective is blocked");
    expect(ownerTurn("objective_notice", "").system).toContain("reports a limit of this Objective");
    expect(ownerTurn("approval_decision", "").system).toContain("was decided");
  });

  it("tells an operator's message apart from SuperTag's own", () => {
    const person = deliveryTurnMessages(
      {
        kind: "delivery",
        from: { kind: "person", id: "operator", displayName: "Ada" },
        reason: "objective_message",
        objectiveId: objective.id,
      },
      "Drop the CSV path.",
      "session",
      true,
      { objective },
    );
    expect(person.system).toContain("An operator wrote to this Objective");
    expect(person.prompt).toContain("Drop the CSV path.");
  });

  it("offers delegation only with a Team, and workspaces only when there are several", () => {
    expect(ownerTurn("objective_start", "").system).not.toContain("pass tag");
    expect(ownerTurn("objective_start", "").system).not.toContain("Pass workspace");
    const wider = ownerTurn("objective_start", "", {
      objective: { ...objective, workspaces: ["service", "docs"] },
      team: { name: "importer", members: ["reviewer"] },
    });
    expect(wider.system).toContain("Team importer (reviewer)");
    expect(wider.system).toContain("Pass workspace, one of service, docs");
  });

  it("tells an ongoing Objective to rest instead of completing", () => {
    const ongoing = ownerTurn("objective_start", "", {
      objective: { ...objective, ongoing: true },
    });
    expect(ongoing.system).toContain("stays open until an operator ends it");
    expect(ongoing.system).not.toContain("status ready_for_review");
  });

  it("folds the system message into the prompt for an uncoordinated turn", () => {
    const uncoordinated = deliveryTurnMessages(
      {
        kind: "delivery",
        from: { kind: "supertag" },
        reason: "objective_start",
        objectiveId: objective.id,
      },
      "Objective objective has started.",
      "session",
      false,
      { objective },
    );
    expect(uncoordinated.prompt.startsWith(uncoordinated.system)).toBe(true);
  });
});
