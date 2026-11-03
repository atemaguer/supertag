import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { DrizzleStore, migrateDatabase } from "../store/src/index.js";
import { ObjectiveController } from "./src/objective-controller.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("reuses settled Task budget evidence between idle Objective limit sweeps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-idle-budget-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  cleanups.push(async () => {
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = await store.createTag({ name: `owner-${randomUUID()}` });
  const objective = await store.createObjective({
    id: randomUUID(),
    ownerTagId: owner.id,
    outcome: "Track spend",
    budgetCurrency: "USD",
    budgetLimitMinor: 100,
  });
  await store.createTeam({
    id: `${objective.id}:leadership`,
    objectiveId: objective.id,
    name: "Leadership",
    leadTagId: owner.id,
    memberTagIds: [owner.id],
    maxConcurrency: null,
  });
  const taskId = `${objective.id}:start`;
  await store.admitTaskAssignment({
    taskId,
    objectiveId: objective.id,
    teamId: `${objective.id}:leadership`,
    requestedByTagId: owner.id,
    assignedTagId: owner.id,
    instruction: "Track spend",
    acceptanceCriteria: ["Done"],
    execution: {},
    maxCostMinor: 0,
    authorizationSnapshot: {
      version: 4,
      capturedAt: new Date().toISOString(),
      tag: { id: owner.id, name: owner.name },
      origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
      requester: { id: owner.id, kind: "bot" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
    workspacePlan: { version: 1, status: "none" },
    startObjectiveExecution: true,
  });
  await store.claimTaskAssignment({ taskId, leaseOwner: "test" });
  await store.settleTaskAssignment({
    taskId,
    leaseOwner: "test",
    attemptCount: 1,
    result: { text: "Done" },
  });

  const events = vi.spyOn(store, "listTaskEvents");
  const attempts = vi.spyOn(store, "listTaskAttempts");
  const controller = new ObjectiveController(store, undefined);
  await controller.sweepObjectiveLimits(true);
  const initial = [events.mock.calls.length, attempts.mock.calls.length];
  expect(initial[0]).toBeGreaterThan(0);
  expect(initial[1]).toBeGreaterThan(0);
  const statements: string[] = [];
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) {
    statements.push(sql);
    return original.call(this, sql);
  };
  try {
    await controller.sweepObjectiveLimits(true);
  } finally {
    Database.prototype.prepare = original;
  }
  expect([events.mock.calls.length, attempts.mock.calls.length]).toEqual(initial);
  const reads = statements.filter((sql) => /^select\b/i.test(sql.trim()));
  expect(reads.some((sql) => sql.includes('"Objective"'))).toBe(true);
  for (const largeColumn of ['"outcome"', '"instruction"', '"payload"', '"mountManifests"'])
    expect(reads.some((sql) => sql.includes(largeColumn))).toBe(false);
  await store.appendTaskEvent({ taskId, type: "usage.recorded", payload: { version: 1 } });
  await controller.sweepObjectiveLimits(true);
  expect([events.mock.calls.length, attempts.mock.calls.length]).toEqual(
    initial.map((count) => count + 1),
  );
});
