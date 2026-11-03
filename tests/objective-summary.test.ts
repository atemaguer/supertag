import { expect, it } from "vitest";
import { objectiveSummary } from "../packages/control-plane/src/objective-summary.js";
import type { Objective, TaskAssignment, Team, Workstream } from "../packages/core/src/index.js";

const objective = {
  id: "objective",
  ownerTagId: "manager",
  status: "working",
  revision: 1,
  outcome: `${"Maintain service ".repeat(200)}${'安全\\"'.repeat(1000)}`,
  budgetLimitMinor: 1000,
  spentMinor: 100,
  reservedMinor: 20,
} as Objective;
const tasks = Array.from({ length: 80 }, (_, i) => ({
  taskId: `task-${String(i).padStart(3, "0")}`,
  teamId: "delivery",
  assignedTagId: "engineer",
  requestedByTagId: "manager",
  parentTaskId: "assessment",
  sourceMessageId: null,
  status: i === 79 ? "running" : "accepted",
  priority: "normal",
  approval: "approved",
  createdAt: "2026-09-19T00:00:00Z",
  instruction: "Fix vendor export ".repeat(100),
  result: { text: "Large result and artifact detail ".repeat(4000) },
})) as TaskAssignment[];
const teams = Array.from({ length: 50 }, (_, i) => ({
  id: `team-${i}`,
  name: "Delivery",
  status: "active",
  leadTagId: "engineer",
  context: "huge".repeat(10000),
})) as unknown as Team[];
const streams = Array.from({ length: 50 }, (_, i) => ({
  id: `team-${i}`,
  objectiveId: "objective",
  title: "Delivery",
  ownerTagId: "engineer",
  participantTagIds: ["engineer"],
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
})) as Workstream[];

it("keeps large Objective reads bounded and exposes existing work without full results", () => {
  const result = objectiveSummary(objective, tasks, teams, streams, {});
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768);
  expect(result.tasks[0]).toMatchObject({
    taskId: "task-079",
    status: "running",
    assignedTagId: "engineer",
    parentTaskId: "assessment",
  });
  expect(JSON.stringify(result)).not.toContain("Large result and artifact detail");
  expect(result.tasks[0]).not.toHaveProperty("result");
  expect(result.pages.tasks.total).toBe(80);
  expect(result.details).toContain("read_task");
});

it("exposes every item and every definition character by following independent page offsets", () => {
  for (const collection of ["tasks", "teams", "workstreams", "definition"] as const) {
    let offset: number | null = 0;
    const all: Record<string, unknown>[] = [];
    while (offset !== null) {
      const result = objectiveSummary(objective, tasks, teams, streams, { offset, limit: 100 });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768);
      all.push(...result[collection]);
      const next: number | null = result.pages[collection].nextOffset;
      if (next !== null) expect(next).toBeGreaterThan(offset);
      offset = next;
    }
    if (collection === "tasks") expect(new Set(all.map((x) => x["taskId"])).size).toBe(80);
    if (collection === "teams" || collection === "workstreams")
      expect(new Set(all.map((x) => x["id"])).size).toBe(50);
    if (collection === "definition") {
      const text = (field: string, index: number) =>
        all
          .filter((x) => x["field"] === field && x["index"] === index)
          .map((x) => x["text"])
          .join("");
      expect(text("outcome", 0)).toBe(objective.outcome);
      expect(new Set(all.map((x) => x["field"]))).toEqual(new Set(["outcome"]));
    }
  }
});
it("rejects invalid page inputs", () => {
  for (const input of [
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { offset: 0.5 },
    { limit: "10" },
  ])
    expect(() => objectiveSummary(objective, tasks, [], [], input)).toThrow();
});

it("retains exact identifiers when a wide row falls back to a detail reference", () => {
  const id = `a${"\u0000".repeat(198)}z`;
  const task = {
    ...tasks[0],
    taskId: id,
    teamId: id,
    assignedTagId: id,
    requestedByTagId: id,
    parentTaskId: id,
    sourceMessageId: id,
  } as TaskAssignment;
  const result = objectiveSummary(objective, [task], [], [], {});
  expect(result.tasks[0]).toEqual({
    id: undefined,
    taskId: id,
    status: task.status,
    detailsOmitted: true,
  });
  expect(result.pages.tasks.nextOffset).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768);
});

it("derives stopping authority from responsibility, independently of sources", () => {
  expect(
    objectiveSummary({ ...objective, ongoing: true, observations: [] }, [], [], [], {})
      .operatorClosureRequired,
  ).toBe(true);
  expect(
    objectiveSummary(
      { ...objective, ongoing: false, observations: [{ workstreamId: "source" }] },
      [],
      [],
      [],
      {},
    ).operatorClosureRequired,
  ).toBe(false);
});

it("shows a waiting consumer's conditions without inventing missing inputs or exposing hidden states", () => {
  const consumer = {
    ...tasks[0],
    taskId: "review",
    status: "waiting",
    dependencies: ["producer", "outside-view"],
    waitState: {
      acceptedTaskIds: [],
      submittedTaskIds: ["producer", "outside-view"],
      mailbox: true,
      notBefore: null,
      registeredAt: "2026-09-19T00:00:00Z",
      attemptCount: 1,
      mailboxTaskIds: [],
      consumedMailboxTaskIds: [],
    },
  } as TaskAssignment;
  const producer = { ...tasks[1], taskId: "producer", status: "submitted" } as TaskAssignment;
  const result = objectiveSummary(objective, [consumer, producer], [], [], {});
  expect(result.tasks[0]).toMatchObject({
    taskId: "review",
    waiting: {
      registeredAt: "2026-09-19T00:00:00Z",
      submittedTasks: {
        items: [
          { taskId: "producer", status: "submitted" },
          { taskId: "outside-view", status: "unavailable" },
        ],
        total: 2,
      },
      mailbox: true,
    },
  });
  expect(result.tasks[1]?.["waiting"]).toBeNull();
  expect(result.tasks[0]).not.toHaveProperty("missingInputs");
  expect(result.details).toContain("alternative wake conditions");
});

it("bounds wait references and does not present an earlier activation's wait as current", () => {
  const task = {
    ...tasks[0],
    status: "waiting",
    waitState: {
      acceptedTaskIds: Array.from({ length: 100 }, (_, i) => `source-${i}`),
      submittedTaskIds: [],
      mailbox: false,
      notBefore: null,
    },
  } as unknown as TaskAssignment;
  const summary = objectiveSummary(objective, [task], [], [], {});
  expect(summary.tasks[0]).toMatchObject({ waiting: { acceptedTasks: { total: 100 } } });
  expect(JSON.stringify(summary.tasks)).not.toContain("source-5");
  expect(
    objectiveSummary(objective, [{ ...task, status: "running" }], [], [], {}).tasks[0],
  ).toMatchObject({ waiting: null });
});
