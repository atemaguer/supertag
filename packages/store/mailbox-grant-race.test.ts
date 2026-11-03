import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

describe.skipIf(!postgres)("PostgreSQL Mailbox grant transactions", () => {
  it("waits for an in-flight Team membership removal before admitting a message", async () => {
    if (!postgres) throw new Error("PostgreSQL test URL missing");
    const isolated = await createIsolatedPostgresDatabase(postgres);
    await migrateDatabase({ url: isolated.url });
    const store = new DrizzleStore({ url: isolated.url });
    await store.connect();
    const sender = await store.createTag({ name: `team-race-sender-${randomUUID()}` });
    const recipient = await store.createTag({ name: `team-race-recipient-${randomUUID()}` });
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: sender.id,
      outcome: "Verify Team membership authorization serialization",
    });
    const team = await store.createTeam({
      id: randomUUID(),
      objectiveId: objective.id,
      name: "Racing Team",
      leadTagId: sender.id,
      memberTagIds: [recipient.id],
    });
    const pool = new Pool({ connectionString: isolated.url });
    const client = await pool.connect();
    let sending:
      | Promise<{ status: "fulfilled" } | { status: "rejected"; reason: unknown }>
      | undefined;
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE "Team" SET "memberTagIds"='[]'::jsonb WHERE "id"=$1`, [team.id]);
      let settled = false;
      sending = store
        .enqueueTagMessage({
          senderTagId: sender.id,
          recipientTagId: recipient.id,
          objectiveId: objective.id,
          type: "question",
          body: { message: "Does membership still permit this?" },
          idempotencyKey: randomUUID(),
        })
        .then(
          () => {
            settled = true;
            return { status: "fulfilled" as const };
          },
          (reason: unknown) => {
            settled = true;
            return { status: "rejected" as const, reason };
          },
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await client.query("COMMIT");
      const outcome = await sending;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ statusCode: 403 });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await sending;
      await pool.end();
      await store.disconnect();
      await isolated.cleanup();
    }
  });
  it("waits for an in-flight grant revocation before admitting a message", async () => {
    if (!postgres) throw new Error("PostgreSQL test URL missing");
    const isolated = await createIsolatedPostgresDatabase(postgres);
    await migrateDatabase({ url: isolated.url });
    const store = new DrizzleStore({ url: isolated.url });
    await store.connect();
    const sender = await store.createTag({ name: `grant-race-sender-${randomUUID()}` });
    const recipient = await store.createTag({ name: `grant-race-recipient-${randomUUID()}` });
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: sender.id,
      outcome: "Verify Mailbox authorization serialization",
    });
    await store.setTagMessagingGrant({
      senderTagId: sender.id,
      recipientTagId: recipient.id,
      messageTypes: ["delegation.requested"],
    });

    const pool = new Pool({ connectionString: isolated.url });
    const client = await pool.connect();
    let sending:
      | Promise<{ status: "fulfilled" } | { status: "rejected"; reason: unknown }>
      | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE "TagMessagingGrant" SET "messageTypes"='[]'::jsonb
         WHERE "senderTagId"=$1 AND "recipientTagId"=$2`,
        [sender.id, recipient.id],
      );
      let settled = false;
      sending = store
        .enqueueTagMessage({
          senderTagId: sender.id,
          recipientTagId: recipient.id,
          objectiveId: objective.id,
          type: "delegation.requested",
          body: { outcome: "This request must observe revocation" },
          idempotencyKey: "locked-grant-revocation",
        })
        .then(
          () => {
            settled = true;
            return { status: "fulfilled" as const };
          },
          (reason: unknown) => {
            settled = true;
            return { status: "rejected" as const, reason };
          },
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await client.query("COMMIT");
      const outcome = await sending;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ statusCode: 403 });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await sending;
      await pool.end();
      await store.disconnect();
      await isolated.cleanup();
    }
  });
});
