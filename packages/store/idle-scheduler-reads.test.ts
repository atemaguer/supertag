import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { ControlPlane } from "../control-plane/src/index.js";
import { DrizzleStore, FileGatewayCredentialVault, migrateDatabase } from "./src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("does not select large Objective or TaskAssignment columns on an idle scheduler sweep", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-idle-reads-"));
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
    outcome: "x".repeat(8_000),
  });
  await store.createTeam({
    id: `${objective.id}:leadership`,
    objectiveId: objective.id,
    name: "Leadership",
    leadTagId: owner.id,
    memberTagIds: [owner.id],
    maxConcurrency: null,
  });
  await store.admitTaskAssignment({
    taskId: `${objective.id}:start`,
    objectiveId: objective.id,
    teamId: `${objective.id}:leadership`,
    requestedByTagId: owner.id,
    assignedTagId: owner.id,
    instruction: "x".repeat(8_000),
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
  const native = new Database(join(directory, "state.db"));
  native
    .prepare('update "TaskAssignment" set "status" = ?, "waitState" = ? where "taskId" = ?')
    .run(
      "waiting",
      JSON.stringify({
        reason: "Wait for a change",
        acceptedTaskIds: [],
        submittedTaskIds: [],
        mailbox: false,
        registeredAt: new Date().toISOString(),
        attemptCount: 0,
        mailboxTaskIds: [],
        consumedMailboxTaskIds: [],
      }),
      `${objective.id}:start`,
    );
  native.close();

  const statements: string[] = [];
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) {
    statements.push(sql);
    return original.call(this, sql);
  };
  try {
    await store.reconcileObjectiveObservations();
    await store.wakeWaitingTaskAssignments();
    await store.listStalledObjectiveOwnerTasks();
    await store.listTaskAssignmentFollowups();
    await store.listPendingTaskAssignments({ excludeTaskIds: [`${objective.id}:start`] });
    await store.listPendingTaskAssignments({ approvalOnly: true });
  } finally {
    Database.prototype.prepare = original;
  }
  const reads = statements.filter((sql) => /^select\b/i.test(sql.trim()));
  expect(reads.some((sql) => sql.includes('"Objective"'))).toBe(true);
  expect(reads.filter((sql) => sql.includes('"Objective"'))).not.toEqual(
    expect.arrayContaining([expect.stringContaining('"outcome"')]),
  );
  expect(reads.filter((sql) => sql.includes('"TaskAssignment"'))).not.toEqual(
    expect.arrayContaining([expect.stringContaining('"instruction"')]),
  );

  const errors: unknown[] = [];
  const plane = new ControlPlane({
    store,
    worklet: {
      id: "idle-test",
      describe: async () => ({
        id: "idle-test",
        protocolVersion: 1,
        host: { id: "host", workers: [] },
      }),
      async *execute() {},
    },
    reply: async () => ({ externalMessageId: "idle-test" }),
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    dispatch: { pollIntervalMs: 60_000, onDispatchError: (error) => errors.push(error) },
  });
  const wake = vi.spyOn(store, "wakeWaitingTaskAssignments");
  plane.objectives.activateCoordination({ url: "http://127.0.0.1:1" });
  await plane.start();
  const probe = new Database(":memory:");
  const statementPrototype = Object.getPrototypeOf(probe.prepare("select 1")) as {
    all: (...args: unknown[]) => unknown;
    get: (...args: unknown[]) => unknown;
  };
  probe.close();
  const originalAll = statementPrototype.all;
  const originalGet = statementPrototype.get;
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    statements.length = 0;
    statementPrototype.all = function (this: { source: string }, ...args) {
      statements.push(this.source);
      return Reflect.apply(originalAll, this, args);
    };
    statementPrototype.get = function (this: { source: string }, ...args) {
      statements.push(this.source);
      return Reflect.apply(originalGet, this, args);
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 800));
    } finally {
      statementPrototype.all = originalAll;
      statementPrototype.get = originalGet;
    }
  } finally {
    await plane.stop();
  }
  const idleReads = statements.filter((sql) => /^select\b/i.test(sql.trim()));
  expect(wake.mock.calls.length, JSON.stringify(errors.map(String))).toBeGreaterThan(0);
  expect(idleReads.length, JSON.stringify(statements.slice(0, 5))).toBeGreaterThan(0);
  for (const largeColumn of ['"outcome"', '"instruction"', '"payload"', '"mountManifests"'])
    expect(idleReads.some((sql) => sql.includes(largeColumn))).toBe(false);
});
