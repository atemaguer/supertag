import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdmitInboundEventInput } from "@supertag/core";
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
  const now = "2030-01-01T00:00:00.000Z";
  const owner = await store.createTag({ name: `owner-${randomUUID()}` });
  const team = await store.createTeam({
    id: randomUUID(),
    name: `team-${randomUUID()}`,
    memberTagIds: [owner.id],
  });
  const objective = await store.createObjective({
    id: randomUUID(),
    ownerTagId: owner.id,
    teamId: team.id,
    outcome: "Track spend",
    budgetCurrency: "USD",
    budgetLimitMinor: 100,
  });
  const account = await store.saveSurfaceAccount({
    provider: "slack",
    externalAccountId: randomUUID(),
    displayName: "Spend",
    authMethod: "test",
    credentialId: "test",
    status: "connected",
    configuration: {},
    verifiedAt: now,
  });
  const route = await store.addTagRoute({
    tagId: owner.id,
    surfaceAccountId: account.id,
    scope: "channel:spend",
  });
  const admission = (sessionKey: string, eventId: string): AdmitInboundEventInput => ({
    surfaceAccountId: account.id,
    tagRouteId: route.id,
    tagId: owner.id,
    execution: {},
    authorization: {
      version: 5,
      capturedAt: now,
      tag: { id: owner.id, name: owner.name },
      origin: {
        surfaceAccountId: account.id,
        tagRouteId: route.id,
        provider: "slack",
        scope: "channel:spend",
      },
      requester: { id: "supertag", kind: "bot" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    contextPlan: { version: 7, capturedAt: now, sets: [] },
    event: {
      eventId,
      logicalEventId: randomUUID(),
      provider: "slack",
      externalAccountId: account.externalAccountId,
      kind: "message",
      scope: "channel:spend",
      sessionKey,
      actor: { id: "supertag", kind: "bot" },
      text: "Objective has started.",
      occurredAt: now,
      internal: {
        kind: "delivery",
        from: { kind: "supertag" },
        reason: "objective_start",
        objectiveId: objective.id,
      },
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "spend",
        target: { channelId: "spend", threadTs: "spend" },
      },
      source: {},
      metadata: {},
    },
  });
  /** One turn of a Session of the Objective, as the Control Plane admits and opens it. */
  const openTurn = async (sessionKey: string, eventId: string, parentSessionId?: string) => {
    const input = admission(sessionKey, eventId);
    const admitted = await store.admitInboundEvent(input);
    const session = await store.openSession({
      tagId: owner.id,
      sessionKey,
      origin: {},
      objectiveId: objective.id,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      at: now,
    });
    const task = await store.openTask({
      inboundEventId: admitted.work.id,
      tagId: owner.id,
      sessionId: session.id,
      execution: {},
      actor: input.event.actor,
      trigger: {},
      workspacePlan: { version: 1, status: "none" },
      sessionHistory: [],
      authorizationSnapshot: input.authorization,
      contextPlan: input.contextPlan,
      createdAt: now,
    });
    return { session, task };
  };

  const owned = await openTurn(`objective:${objective.id}`, `objective-start:${objective.id}`);
  expect(owned.task.objectiveId).toBe(objective.id);
  await store.startTask({ taskId: owned.task.id, startedAt: now });
  await store.closeTask({
    taskId: owned.task.id,
    status: "completed",
    endedAt: "2030-01-01T00:01:00.000Z",
    result: {
      summary: "Planned",
      decisions: [],
      changes: [],
      unresolved: [],
      artifacts: [],
      references: [],
    },
  });
  // A work Session of the same Objective, still running: its spend is not settled evidence.
  const work = await openTurn(
    `work:${owned.session.id}:1`,
    `work-start:${objective.id}`,
    owned.session.id,
  );
  await store.startTask({ taskId: work.task.id, startedAt: now });

  const events = vi.spyOn(store, "listTaskEvents");
  const attempts = vi.spyOn(store, "listTaskAttempts");
  const controller = new ObjectiveController(store, undefined);
  await controller.sweepObjectiveLimits(true);
  // Both Tasks are read once.
  expect([events.mock.calls.length, attempts.mock.calls.length]).toEqual([2, 2]);
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
  // Only the running Task is measured again; the settled one reuses its report.
  expect([events.mock.calls.length, attempts.mock.calls.length]).toEqual([3, 3]);
  const reads = statements.filter((sql) => /^select\b/i.test(sql.trim()));
  expect(reads.some((sql) => sql.includes('"Objective"'))).toBe(true);

  // Once the work Session's Task settles, neither Task is measured again.
  await store.closeTask({
    taskId: work.task.id,
    status: "failed",
    endedAt: "2030-01-01T00:02:00.000Z",
  });
  await controller.sweepObjectiveLimits(true);
  expect([events.mock.calls.length, attempts.mock.calls.length]).toEqual([4, 4]);
  await controller.sweepObjectiveLimits(true);
  expect([events.mock.calls.length, attempts.mock.calls.length]).toEqual([4, 4]);

  // Late cost evidence on a settled Task is new evidence: the next sweep re-measures that Task.
  await store.appendTaskEvent({
    taskId: work.task.id,
    type: "task.usage-reported",
    payload: { reportedCost: { currency: "USD", amountMinor: 10 } },
    createdAt: "2030-01-01T00:03:00.000Z",
  });
  await controller.sweepObjectiveLimits(true);
  expect([events.mock.calls.length, attempts.mock.calls.length]).toEqual([5, 5]);
});
