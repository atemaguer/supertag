import { expect, it } from "vitest";
import {
  objectiveLimitsView,
  objectiveSummary,
} from "../packages/control-plane/src/objective-summary.js";
import type { Objective, ObjectiveSessionSummary, Team } from "../packages/core/src/index.js";

const now = "2026-01-01T00:00:00.000Z";
const objective = {
  id: "objective",
  ownerTagId: "manager",
  status: "working",
  revision: 3,
  outcome: "Maintain the scheduling service",
  ongoing: false,
  deadline: null,
  pausedAt: null,
  executionStartedAt: "2025-12-31T00:00:00.000Z",
  completionSummary: null,
  workspaces: ["service"],
  teamId: "team",
  budgetLimitMinor: 1000,
  budgetCurrency: "USD",
  limitState: {},
} as unknown as Objective;
const team = {
  id: "team",
  name: "Delivery",
  memberTagIds: ["manager", "engineer"],
  maxConcurrency: 3,
} as Team;
const tagNames = { manager: "Manager", engineer: "Engineer" };

const session = (patch: Partial<ObjectiveSessionSummary>): ObjectiveSessionSummary => ({
  sessionId: "s1",
  tagId: "manager",
  sessionKey: "objective:objective",
  createdAt: now,
  ...patch,
});

it("reads the Objective with its Team, pool and Sessions", () => {
  const summary = objectiveSummary({
    objective,
    team,
    tagNames,
    now,
    sessions: [
      session({ task: { id: "t1", status: "running" } as never }),
      session({
        sessionId: "s2",
        tagId: "engineer",
        sessionKey: "work:s1:1",
        parentSessionId: "s1",
        title: "Probe the scheduler",
        task: { id: "t2", status: "completed", question: "Which region?" } as never,
      }),
      // A Session whose first Task has not opened yet is queued.
      session({ sessionId: "s3", tagId: "engineer", sessionKey: "work:s1:2", title: "Later" }),
    ],
  });
  expect(summary).toMatchObject({
    id: "objective",
    owner: "Manager",
    status: "working",
    revision: 3,
    outcome: "Maintain the scheduling service",
    ongoing: false,
    startedAt: "2025-12-31T00:00:00.000Z",
    workspaces: ["service"],
    team: { name: "Delivery", members: ["Manager", "Engineer"], maxConcurrency: 3 },
    budget: { currency: "USD", limitMinor: 1000, spentMinor: 0, availableMinor: 1000 },
  });
  expect(summary.sessions).toEqual([
    { sessionId: "s1", tag: "Manager", status: "running" },
    {
      sessionId: "s2",
      tag: "Engineer",
      title: "Probe the scheduler",
      parentSessionId: "s1",
      status: "waiting",
      question: "Which region?",
    },
    { sessionId: "s3", tag: "Engineer", title: "Later", status: "queued" },
  ]);
});

it("falls back to Tag IDs it cannot name and reports no Team", () => {
  const summary = objectiveSummary({
    objective: { ...objective, teamId: null } as Objective,
    team: undefined,
    tagNames: {},
    now,
    sessions: [session({ task: { id: "t1", status: "failed" } as never })],
  });
  expect(summary.owner).toBe("manager");
  expect(summary.team).toBeNull();
  expect(summary.sessions[0]).toMatchObject({ tag: "manager", status: "failed" });
});

it("reports the pool as limit minus reported spend, and caps it at the limit", () => {
  const spent = {
    ...objective,
    limitState: { reportedSpend: { amountMinor: 1200, observedAt: now, unknownAttemptIds: [] } },
  } as unknown as Objective;
  expect(objectiveSummary({ objective: spent, team, tagNames, now, sessions: [] }).budget).toEqual({
    currency: "USD",
    limitMinor: 1000,
    spentMinor: 1200,
    availableMinor: -200,
  });
  // Without a currency there is no pool to count against.
  expect(
    objectiveSummary({
      objective: { ...objective, budgetCurrency: null } as Objective,
      team,
      tagNames,
      now,
      sessions: [],
    }).budget,
  ).toEqual({ currency: null, limitMinor: 1000, spentMinor: null, availableMinor: null });
});

it("shows the deadline, its grace and the notices already raised", () => {
  const view = objectiveLimitsView(
    {
      ...objective,
      deadline: "2026-01-01T01:00:00.000Z",
      limitState: {
        deadlineWarnings: [
          {
            deadline: "2026-01-01T01:00:00.000Z",
            minutesBefore: 15,
            at: "2026-01-01T00:45:00.000Z",
          },
        ],
      },
    } as unknown as Objective,
    now,
  );
  expect(view.deadline).toMatchObject({
    at: "2026-01-01T01:00:00.000Z",
    minutesRemaining: 60,
    passed: false,
    notices: [
      {
        kind: "objective_deadline_approaching",
        at: "2026-01-01T00:45:00.000Z",
        message: expect.stringContaining("15"),
      },
    ],
  });
  expect(view.deadline?.remaining).toContain("left");
  expect(view.budget).toMatchObject({ measure: "provider_reported_cost", limitMinor: 1000 });
});

it("reports an unmeasured budget when it names no currency", () => {
  const view = objectiveLimitsView({ ...objective, budgetCurrency: null } as Objective, now);
  expect(view.deadline).toBeNull();
  expect(view.budget).toMatchObject({ measure: "unmeasured", limitMinor: 1000, currency: null });
});

it("keeps a large read bounded", () => {
  const sessions = Array.from({ length: 50 }, (_, index) =>
    session({
      sessionId: `s${index}`,
      sessionKey: `work:s1:${index}`,
      parentSessionId: "s1",
      title: "Investigate the vendor export ".repeat(4),
      tagId: "engineer",
      task: { id: `t${index}`, status: "completed" } as never,
    }),
  );
  const summary = objectiveSummary({ objective, team, tagNames, now, sessions });
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(32768);
});
