import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagMailboxService } from "../packages/control-plane/src/mailbox.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const PostgresqlPool = createRequire(new URL("../packages/store/package.json", import.meta.url))(
  "pg",
).Pool as new (options: {
  connectionString: string;
  max: number;
}) => { query(text: string): Promise<unknown>; end(): Promise<void> };
const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} mailbox history and retention`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        vi.useRealTimers();
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      async function fixture(started = true) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-mailbox-safety-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          if (!postgres) throw new Error("Missing test database");
          // Bridge/controller sweeps are deliberately database-wide. A dedicated
          // database prevents another suite from consuming this fixture's message.
          const databaseName = `supertag_mailbox_${randomUUID().replaceAll("-", "")}`;
          const admin = new PostgresqlPool({ connectionString: postgres, max: 1 });
          try {
            await admin.query(`CREATE DATABASE "${databaseName}"`);
          } finally {
            await admin.end();
          }
          const isolated = new URL(postgres);
          isolated.pathname = `/${databaseName}`;
          url = isolated.toString();
          cleanups.push(async () => {
            const cleanup = new PostgresqlPool({ connectionString: postgres, max: 1 });
            try {
              await cleanup.query(`DROP DATABASE "${databaseName}"`);
            } finally {
              await cleanup.end();
            }
          });
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const sender = await store.createTag({ name: randomUUID() });
        const recipient = await store.createTag({ name: randomUUID() });
        await store.bindTagWorkerHost(sender.id, "fixture-host");
        await store.bindTagWorkerHost(recipient.id, "fixture-host");
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: sender.id,
          outcome: "Coordinate",
          runtimeActions: ["commands:execute"],
        });
        const team = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Recipient",
          leadTagId: recipient.id,
          memberTagIds: [],
          maxConcurrency: 2,
        });
        const controller = new ObjectiveController(store, undefined);
        const start = () => controller.command("start_objective", { objectiveId: objective.id });
        if (started) await start();
        const mailbox = new TagMailboxService(store);
        const credential = await mailbox.issueCredential(recipient.id);
        await store.setTagMessagingGrant({
          senderTagId: sender.id,
          recipientTagId: recipient.id,
          messageTypes: ["delegation.requested"],
        });
        const send = (body: Record<string, unknown> = {}) =>
          store.enqueueTagMessage({
            senderTagId: sender.id,
            recipientTagId: recipient.id,
            objectiveId: objective.id,
            type: "delegation.requested",
            idempotencyKey: randomUUID(),
            body,
          });
        return {
          store,
          sender,
          recipient,
          objective,
          team,
          controller,
          start,
          mailbox,
          credential,
          send,
        };
      }
      it("paginates over 200 tied timestamps and retains idempotency after body pruning", async () => {
        const f = await fixture(false);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
        const original = {
          senderTagId: f.sender.id,
          recipientTagId: f.recipient.id,
          objectiveId: f.objective.id,
          type: "delegation.requested" as const,
          body: { secret: "Retain fingerprint" },
          idempotencyKey: randomUUID(),
        };
        const first = await f.store.enqueueTagMessage(original);
        for (let i = 0; i < 220; i++) {
          if (i) await f.send({ number: i });
          const delivery = await f.mailbox.receive(f.credential.token, {});
          if (!delivery) throw new Error("Missing delivery");
          await f.mailbox.settle(f.credential.token, delivery.message.id, "ack", {
            leaseToken: delivery.leaseToken,
          });
        }
        const pending = await f.send({ pending: true });
        const all = [];
        let before: { createdAt: string; id: string } | undefined;
        do {
          const page = await f.store.listTagMessageHistory(f.sender.id, {
            limit: 37,
            ...(before ? { before } : {}),
          });
          all.push(...page.items);
          before = page.nextCursor;
        } while (before);
        expect(all).toHaveLength(221);
        expect(new Set(all.map((row) => row.id)).size).toBe(221);
        expect(all.map((row) => row.id)).toEqual(
          all
            .map((row) => row.id)
            .sort()
            .reverse(),
        );
        expect(
          (await f.store.listTagMessageHistory(f.recipient.id, { limit: 200 })).items,
        ).toHaveLength(200);
        expect(
          await f.store.pruneTagMessageBodies({ before: "2026-09-02T00:00:00.000Z", limit: 1000 }),
        ).toEqual({ pruned: 220 });
        expect(await f.store.pruneTagMessageBodies({ before: "2026-09-02T00:00:00.000Z" })).toEqual(
          { pruned: 0 },
        );
        const duplicate = await f.store.enqueueTagMessage(original);
        expect(duplicate).toMatchObject({
          duplicate: true,
          message: {
            id: first.message.id,
            body: {},
            bodyPrunedAt: "2026-09-01T00:00:00.000Z",
            status: "processed",
          },
        });
        await expect(
          f.store.enqueueTagMessage({ ...original, body: { changed: true } }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const delivery = await f.mailbox.receive(f.credential.token, {});
        expect(delivery?.message.id).toBe(pending.message.id);
        expect(delivery?.message.body).toEqual({ pending: true });
        expect(await f.store.pruneTagMessageBodies({ before: "2026-09-02T00:00:00.000Z" })).toEqual(
          { pruned: 0 },
        );
      }, 30000);
      it("prunes a delivered message body once its Mailbox Task closes", async () => {
        const f = await fixture();
        const sent = await f.send({ finding: "Still awaiting review" });
        await f.store.admitMailboxTaskAssignments();
        const task = (await f.store.listTaskAssignments(f.objective.id)).find(
          (row) => row.sourceMessageId === sent.message.id,
        );
        if (!task) throw new Error("Missing Task");
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "worker" });
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "worker",
          attemptCount: 1,
          result: {},
        });
        // A self-requested delivery closes on settlement; no separate review holds its body.
        expect((await f.store.getTaskAssignment(task.taskId))?.status).toBe("accepted");
        const before = new Date(Date.now() + 10000).toISOString();
        expect(await f.store.pruneTagMessageBodies({ before })).toEqual({ pruned: 1 });
      });
    },
  );
}
