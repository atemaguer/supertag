import type { Objective, ObjectiveSessionSummary, Team } from "@supertag/core";
import { describe, expect, it } from "vitest";
import { objectiveLimitsView, objectiveSummary } from "./src/objective-summary.js";

describe("Objective limits view", () => {
  it("shows reported overrun after running Attempts finish", () => {
    const objective = {
      status: "limited",
      budgetLimitMinor: 100,
      budgetCurrency: "USD",
      deadline: null,
      limitState: {
        reportedSpend: {
          amountMinor: 135,
          currency: "USD",
          unknownAttemptIds: [],
          observedAt: "2026-10-03T07:00:00.000Z",
        },
        budgetExhausted: { limitMinor: 100, spentMinor: 100, at: "2026-10-03T06:59:00.000Z" },
      },
    } as Objective;
    const budget = objectiveLimitsView(objective, "2026-10-03T07:01:00.000Z").budget;
    expect(budget).toMatchObject({
      limitMinor: 100,
      reportedSpentMinor: 135,
      overrunMinor: 35,
      exhausted: true,
    });
    // One pool for every Session of the Objective.
    expect(budget?.guidance).toContain("every Task of the Objective's Sessions");
  });
});

describe("what read_objective returns", () => {
  const objective = {
    id: "objective",
    ownerTagId: "owner",
    status: "working",
    revision: 3,
    outcome: "Ship the importer",
    ongoing: false,
    deadline: null,
    pausedAt: null,
    executionStartedAt: "2026-10-03T06:00:00.000Z",
    completionSummary: null,
    workspaces: ["service"],
    budgetCurrency: "USD",
    budgetLimitMinor: 1_000,
    limitState: { reportedSpend: { amountMinor: 250, currency: "USD", unknownAttemptIds: [] } },
  } as unknown as Objective;
  const team = {
    id: "team",
    name: "importer",
    memberTagIds: ["owner", "reviewer"],
    maxConcurrency: 2,
  } as Team;
  const sessions: ObjectiveSessionSummary[] = [
    {
      sessionId: "owner-session",
      tagId: "owner",
      sessionKey: "objective:objective",
      createdAt: "2026-10-03T06:00:00.000Z",
      task: { id: "owner-task", status: "completed", question: "Which registry?" },
    },
    {
      sessionId: "work-session",
      tagId: "reviewer",
      sessionKey: "work:owner-session:1",
      parentSessionId: "owner-session",
      title: "Review the importer",
      createdAt: "2026-10-03T06:10:00.000Z",
      task: { id: "work-task", status: "running" },
    },
    {
      sessionId: "pending-session",
      tagId: "owner",
      sessionKey: "work:owner-session:2",
      parentSessionId: "owner-session",
      title: "Write the docs",
      createdAt: "2026-10-03T06:20:00.000Z",
    },
  ];

  it("names the Team, the pool and every Session with its waiting state", () => {
    const summary = objectiveSummary({
      objective,
      sessions,
      team,
      tagNames: { owner: "lead", reviewer: "checker" },
      now: "2026-10-03T07:00:00.000Z",
    });
    expect(summary).toMatchObject({
      id: "objective",
      owner: "lead",
      startedAt: "2026-10-03T06:00:00.000Z",
      team: { name: "importer", members: ["lead", "checker"], maxConcurrency: 2 },
      budget: { currency: "USD", limitMinor: 1_000, spentMinor: 250, availableMinor: 750 },
    });
    expect(summary.sessions).toEqual([
      {
        sessionId: "owner-session",
        tag: "lead",
        status: "waiting",
        question: "Which registry?",
      },
      {
        sessionId: "work-session",
        tag: "checker",
        title: "Review the importer",
        parentSessionId: "owner-session",
        status: "running",
      },
      {
        sessionId: "pending-session",
        tag: "lead",
        title: "Write the docs",
        parentSessionId: "owner-session",
        status: "queued",
      },
    ]);
  });

  it("reports an Objective with no Team and no Sessions yet", () => {
    const summary = objectiveSummary({
      objective,
      sessions: [],
      team: undefined,
      tagNames: {},
      now: "2026-10-03T07:00:00.000Z",
    });
    expect(summary.team).toBeNull();
    expect(summary.sessions).toEqual([]);
    expect(summary.owner).toBe("owner");
  });
});
