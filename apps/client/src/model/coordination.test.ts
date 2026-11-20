import { describe, expect, it } from "vitest";
import {
  createdObjectiveId,
  formatMoney,
  goalOutcome,
  newObjectiveId,
  type Objective,
  objectiveDetail,
  objectiveHold,
  objectiveHomeLine,
  parseBudget,
  shortMoney,
  type WorkSession,
  workState,
} from "./coordination";
import { newTagNotes, newTagRules, offeredHarnesses } from "./tag-admin";

const objective = (change: Partial<Objective> = {}): Objective => ({
  objectiveId: "ship-sso",
  ownerTagId: "lead",
  sessionId: "objective/ship-sso",
  outcome: "Ship single sign-on",
  status: "working",
  revision: 1,
  ongoing: false,
  startingTaskId: "task-1",
  createdBy: "operator:local",
  ...change,
});

describe("money", () => {
  it("reads budgets as amounts and currencies, or dollars", () => {
    expect(parseBudget("")).toBeUndefined();
    expect(parseBudget("300 USD")).toEqual({ minor: 30_000, currency: "USD" });
    expect(parseBudget("$12.50")).toEqual({ minor: 1250, currency: "USD" });
    expect(parseBudget("1,200.5 eur")).toEqual({ minor: 120_050, currency: "EUR" });
    expect(parseBudget("300 JPY")).toEqual({ minor: 300, currency: "JPY" });
    expect(() => parseBudget("3.5 JPY")).toThrow("A JPY budget has no decimal places.");
    expect(() => parseBudget("1.2345 KWD")).toThrow("at most 3 decimal places");
    expect(() => parseBudget("0 USD")).toThrow("more than zero");
    expect(() => parseBudget("lots")).toThrow("such as 300 USD or $12.50");
  });

  it("formats amounts in their currency", () => {
    expect(formatMoney(123_456, "USD")).toBe("$1,234.56");
    expect(formatMoney(300, "JPY")).toBe("¥300");
    expect(formatMoney(1500, "CHF")).toBe("CHF 15.00");
    expect(formatMoney(-50, "EUR")).toBe("-€0.50");
    expect(formatMoney(5, "credits")).toBe("5 credits minor units");
    expect(shortMoney(30_000, "USD")).toBe("$300");
    expect(shortMoney(1250, "USD")).toBe("$12.50");
  });
});

describe("Objectives", () => {
  it("says why an open one is held, or its spend against its budget", () => {
    expect(objectiveHold(objective({ status: "blocked" }))).toBe("blocked");
    expect(objectiveHold(objective({ status: "ready_for_review" }))).toBe("review");
    expect(objectiveHold(objective({ pausedAtMs: 1 }))).toBe("paused");
    expect(objectiveHold(objective())).toBeUndefined();
    expect(
      objectiveDetail(objective({ budget: { minor: 30_000, currency: "USD" }, spentMinor: 1250 })),
    ).toBe("$12.50 of $300");
    expect(objectiveDetail(objective({ status: "limited" }))).toBe("limited");
    expect(objectiveDetail(objective())).toBe("");
  });

  it("finds the Objective a /goal reply created, and what its home line says", () => {
    expect(
      createdObjectiveId("Created Objective ship-sso: Ship SSO\nlead owns it, and its first turn"),
    ).toBe("ship-sso");
    expect(createdObjectiveId("Created Objective : nothing")).toBeUndefined();
    expect(createdObjectiveId("I created Objective x: no")).toBeUndefined();
    expect(objectiveHomeLine(objective())).toBeUndefined();
    expect(
      objectiveHomeLine(
        objective({ status: "ready_for_review", completionSummary: "Live.\nMore" }),
      ),
    ).toBe(
      "Objective ship-sso is ready for your review: Live. · open it under Objectives to approve or request changes",
    );
    expect(objectiveHomeLine(objective({ status: "completed" }))).toBe(
      "Objective ship-sso is complete",
    );
    expect(objectiveHomeLine(objective({ status: "cancelled" }))).toBe(
      "Objective ship-sso was cancelled.",
    );
  });

  it("reads /goal and names new Objectives from their outcome", () => {
    expect(goalOutcome("/goal")).toBe("");
    expect(goalOutcome("  /goal   Ship it  ")).toBe("Ship it");
    expect(goalOutcome("/goals")).toBeUndefined();
    expect(goalOutcome("hello")).toBeUndefined();
    expect(newObjectiveId("Ship SSO to all customers!", () => 0.5)).toBe("ship-sso-to-88888888");
    expect(newObjectiveId("!!!", () => 0)).toBe("objective-00000000");
  });
});

it("says how a Work Session stands", () => {
  const work: WorkSession = {
    workSessionId: "work/1",
    title: "t",
    tagId: "lead",
    parentTagId: "lead",
    parentSessionId: "conversation/lead",
    starterTaskId: "s",
    latestTaskId: "c",
    latestTaskState: "running",
  };
  expect(workState(work)).toBe("working");
  expect(workState({ ...work, question: "Which region?" })).toBe("waiting on you");
  expect(workState({ ...work, reportTaskState: "succeeded" })).toBe("reported");
  expect(workState({ ...work, closedAtMs: 1, closeReason: "idle" })).toBe("closed: idle");
});

describe("New Tag rules", () => {
  it("offers the hosts' harnesses in the app's order, and every one without hosts", () => {
    expect(
      offeredHarnesses({ harnesses: ["opencode", "claude_code", "codex"], workspaces: [] }),
    ).toEqual(["codex", "claude_code", "opencode"]);
    expect(offeredHarnesses({ harnesses: [], workspaces: [] })).toContain("cursor");
  });

  it("turns Web access on unless the hosts have no network, and never for Cursor", () => {
    const options = {
      harnesses: ["codex", "claude_code", "cursor"],
      workspaces: [],
      noWeb: ["claude_code"],
      noCommands: ["cursor"],
    };
    expect(newTagRules(options, "codex", undefined).webAccess).toBe(true);
    expect(newTagRules(options, "codex", false).webAccess).toBe(false);
    expect(newTagRules(options, "claude_code", undefined).webAccess).toBe(false);
    expect(newTagRules(options, "claude_code", true).webAccess).toBe(true);
    expect(newTagRules(options, "cursor", true)).toMatchObject({ webless: true, webAccess: false });
    expect(newTagNotes(options, "cursor", newTagRules(options, "cursor", undefined))).toEqual([
      "Cursor has no sandbox of its own, and no host here lets it run commands, so this Tag reads and edits files only.",
      "Cursor has no tool for reading web pages.",
    ]);
    expect(newTagNotes(options, "codex", newTagRules(options, "codex", false))).toEqual([
      "Current Codex models may not run commands without web access.",
    ]);
  });
});
