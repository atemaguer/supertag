import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { runDialectTransaction } from "./src/dialect-transaction.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";
import * as postgresql from "./src/schema/postgresql.js";
import { nextTaskEventSequence } from "./src/task-event-sequence.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const at = "2026-10-05T08:00:00.000Z";

describe.skipIf(!postgres)("postgresql Task event sequences", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("serializes a transaction's event with a concurrent append instead of colliding", async () => {
    const isolated = await createIsolatedPostgresDatabase(postgres as string);
    cleanups.push(isolated.cleanup);
    await migrateDatabase({ url: isolated.url });
    const store = new DrizzleStore({ url: isolated.url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const pool = new Pool({ connectionString: isolated.url });
    cleanups.push(() => pool.end());
    const db = drizzle(pool, { schema: postgresql.postgresqlSchema });

    const owner = await store.createTag({ name: "Owner" });
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "Record events concurrently",
    });
    const team = await store.createTeam(
      {
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Engineering",
        leadTagId: owner.id,
        memberTagIds: [],
        maxConcurrency: 1,
      },
      owner.id,
    );
    const { taskId } = await store.admitTaskAssignment({
      taskId: randomUUID(),
      teamId: team.id,
      objectiveId: objective.id,
      requestedByTagId: owner.id,
      assignedTagId: owner.id,
      instruction: "Complete the assignment",
      acceptanceCriteria: ["Done"],
      execution: {},
      workspacePlan: { version: 1, status: "none" },
      contextPlan: { version: 7, capturedAt: at, sets: [] },
      authorizationSnapshot: {
        version: 4,
        capturedAt: at,
        tag: { id: owner.id, name: owner.name },
        origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
        requester: { id: owner.id, kind: "bot" },
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      },
    });
    const before = (await store.listTaskEvents(taskId)).length;

    // A transaction picks its sequence, then stays open while another writer appends. Before the
    // lock both read the same latest sequence, and the transaction's insert failed with a unique
    // violation that PostgreSQL can't retry inside the transaction.
    const events = postgresql.taskEvents;
    let picked!: () => void;
    const allocated = new Promise<void>((resolve) => {
      picked = resolve;
    });
    const transaction = runDialectTransaction(db, "postgresql", function* (tx: any) {
      const sequence = yield* nextTaskEventSequence(tx, events, taskId);
      picked();
      yield delay(300);
      yield tx
        .insert(events)
        .values({ id: randomUUID(), taskId, sequence, type: "test.in-transaction", createdAt: at })
        .returning();
      return sequence;
    });
    await allocated;
    const appended = store.appendTaskEvent({ taskId, type: "test.appended" });
    const [inTransaction, append] = await Promise.all([transaction, appended]);

    expect(append.sequence).toBe(inTransaction + 1);
    const recorded = await store.listTaskEvents(taskId);
    expect(recorded).toHaveLength(before + 2);
    expect(new Set(recorded.map((event) => event.sequence)).size).toBe(recorded.length);
  });
});
