import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { objectiveSessionKey, objectiveStartDeliveryId } from "@supertag/core";
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
    const account = await store.saveSurfaceAccount({
      provider: "slack",
      externalAccountId: randomUUID(),
      displayName: "Slack",
      authMethod: "test",
      credentialId: "test",
      status: "connected",
      configuration: {},
      verifiedAt: at,
    });
    const route = await store.addTagRoute({
      tagId: owner.id,
      surfaceAccountId: account.id,
      scope: "channel:test",
    });
    const authorization = {
      version: 5,
      capturedAt: at,
      tag: { id: owner.id, name: owner.name },
      origin: {
        tagRouteId: route.id,
        surfaceAccountId: account.id,
        provider: "slack",
        scope: "channel:test",
      },
      requester: { id: owner.id, kind: "bot" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    } as const;
    const sessionKey = objectiveSessionKey(objective.id);
    const admitted = await store.admitInboundEvent({
      surfaceAccountId: account.id,
      tagRouteId: route.id,
      tagId: owner.id,
      authorization,
      contextPlan: { version: 7, capturedAt: at, sets: [] },
      event: {
        eventId: objectiveStartDeliveryId(objective.id),
        logicalEventId: objectiveStartDeliveryId(objective.id),
        provider: "slack",
        externalAccountId: account.externalAccountId,
        kind: "message",
        scope: "channel:test",
        sessionKey,
        actor: { id: owner.id, kind: "bot" },
        internal: { kind: "delivery", from: { kind: "supertag" }, reason: "objective_start" },
        text: "Record events concurrently",
        occurredAt: at,
        callback: {
          provider: "slack",
          mode: "slack_thread",
          threadKey: sessionKey,
          target: { channelId: "test", threadTs: sessionKey },
        },
        source: {},
        metadata: {},
      },
    });
    const session = await store.openSession({
      tagId: owner.id,
      sessionKey,
      origin: {},
      objectiveId: objective.id,
      at,
    });
    const { id: taskId } = await store.openTask({
      inboundEventId: admitted.work.id,
      tagId: owner.id,
      sessionId: session.id,
      execution: {},
      actor: { id: owner.id, kind: "bot" },
      trigger: { origin: "objective_start" },
      workspacePlan: { version: 1, status: "none" },
      sessionHistory: [],
      authorizationSnapshot: authorization,
      contextPlan: { version: 7, capturedAt: at, sets: [] },
      createdAt: at,
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
