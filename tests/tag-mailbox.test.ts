import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inboxSessionKey,
  TAG_MESSAGE_TEXT_MAX,
  type Tag,
  type TagAuthorizationSnapshot,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const at = "2026-11-07T00:00:00.000Z";
const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Tag Mailboxes`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    }, 30_000);

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-mailbox-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      let url = `file:${join(directory, "state.db")}`;
      if (dialect === "postgresql") {
        const isolated = await createIsolatedPostgresDatabase(postgres as string);
        url = isolated.url;
        cleanups.push(isolated.cleanup);
      }
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      const sender = await store.createTag({ name: `sender-${randomUUID()}` });
      const recipient = await store.createTag({ name: `recipient-${randomUUID()}` });
      const stranger = await store.createTag({ name: `stranger-${randomUUID()}` });
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

      /** Admits an inbox event for the Tag and leaves it pending, as `#deliverInbox` does. */
      const admitInboxEvent = async (tag: Tag) => {
        const route = await store.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: account.id,
          scope: `channel:${tag.id}`,
        });
        const authorization = {
          version: 5,
          capturedAt: at,
          tag: { id: tag.id, name: tag.name },
          origin: {
            provider: "slack",
            surfaceAccountId: account.id,
            tagRouteId: route.id,
            scope: `channel:${tag.id}`,
          },
          requester: { id: "supertag", kind: "service" },
          roles: [],
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        } as unknown as TagAuthorizationSnapshot;
        const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId: tag.id,
          authorization,
          contextPlan,
          event: {
            eventId: randomUUID(),
            logicalEventId: randomUUID(),
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: `channel:${tag.id}`,
            sessionKey: inboxSessionKey(tag.id),
            actor: { id: "supertag", kind: "service" },
            text: "inbox",
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: inboxSessionKey(tag.id),
              target: { channelId: tag.id, threadTs: "1.0" },
            },
            source: {},
            metadata: {},
          },
        });
        return { admitted, authorization, contextPlan, route };
      };

      /** The Task of the Tag's inbox turn, as the dispatcher opens it at admission. */
      const openInboxTask = async (tag: Tag) => {
        const { admitted, authorization, contextPlan } = await admitInboxEvent(tag);
        const session = await store.openSession({
          tagId: tag.id,
          sessionKey: inboxSessionKey(tag.id),
          origin: {},
          at,
        });
        return store.openTask({
          inboundEventId: admitted.work.id,
          tagId: tag.id,
          sessionId: session.id,
          execution: {},
          actor: { id: "supertag", kind: "service" },
          trigger: {},
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan,
          createdAt: at,
        });
      };

      const send = (from: Tag, to: Tag, text: string, hops = 0) =>
        store.deliverTagMessage({
          senderTagId: from.id,
          recipientTagId: to.id,
          text,
          hops,
        });

      return { store, sender, recipient, stranger, admitInboxEvent, openInboxTask, send };
    }

    it("lets Team members message each other, and others only with a grant", async () => {
      const f = await fixture();
      expect(await f.store.mayMessage(f.sender.id, f.recipient.id)).toBe(false);
      const team = await f.store.createTeam({
        id: randomUUID(),
        name: `team-${randomUUID()}`,
        memberTagIds: [f.sender.id, f.recipient.id],
      });
      expect(await f.store.mayMessage(f.sender.id, f.recipient.id)).toBe(true);
      expect(await f.store.mayMessage(f.recipient.id, f.sender.id)).toBe(true);
      expect(await f.store.mayMessage(f.stranger.id, f.recipient.id)).toBe(false);
      // A grant is directional and needs no Team.
      await f.store.setTagMessagingGrants(f.recipient.id, [f.stranger.id]);
      expect(await f.store.mayMessage(f.stranger.id, f.recipient.id)).toBe(true);
      expect(await f.store.mayMessage(f.recipient.id, f.stranger.id)).toBe(false);
      expect(await f.store.listTagMessagingGrants(f.stranger.id)).toEqual([
        { senderTagId: f.stranger.id, recipientTagId: f.recipient.id },
      ]);
      // Setting the list again replaces it.
      await f.store.setTagMessagingGrants(f.recipient.id, []);
      expect(await f.store.listTagMessagingGrants(f.recipient.id)).toEqual([]);
      expect(await f.store.mayMessage(f.stranger.id, f.recipient.id)).toBe(false);
      await expect(
        f.store.setTagMessagingGrants(f.recipient.id, [f.recipient.id]),
      ).rejects.toMatchObject({ statusCode: 400 });
      // A retired Tag neither sends nor receives, even inside its Team.
      await f.store.retireTag(f.sender.id);
      expect(await f.store.mayMessage(f.sender.id, f.recipient.id)).toBe(false);
      expect(await f.store.mayMessage(f.recipient.id, f.sender.id)).toBe(false);
      expect(team.memberTagIds).toContain(f.sender.id);
    }, 30_000);

    it("admits a turn for the first message only while no inbox turn waits for it", async () => {
      const f = await fixture();
      const first = await f.send(f.sender, f.recipient, "One");
      expect(first).toMatchObject({ admit: true });
      expect(first.message).toMatchObject({ status: "pending", hops: 0, text: "One" });
      expect(first.message.taskId).toBeUndefined();
      // Nothing has claimed a turn yet, so the next message still needs one admitted.
      expect(await f.store.listTagsWithUnboundMessages(10)).toEqual([f.recipient.id]);
      await f.admitInboxEvent(f.recipient);
      // The pending turn takes every unbound message, so no second turn is admitted for it.
      expect(await f.send(f.sender, f.recipient, "Two")).toMatchObject({ admit: false });
      expect(await f.store.listTagsWithUnboundMessages(10)).toEqual([]);
    }, 30_000);

    it("batches every unbound message into one inbox turn, idempotently", async () => {
      const f = await fixture();
      // Distinct arrival times, so the batch's order is the order they were sent.
      for (const text of ["One", "Two", "Three"]) {
        await f.send(f.sender, f.recipient, text);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const task = await f.openInboxTask(f.recipient);
      const bound = await f.store.bindInboxMessages(task.id, f.recipient.id);
      expect(bound.map((message) => message.text)).toEqual(["One", "Two", "Three"]);
      expect(bound.every((message) => message.taskId === task.id)).toBe(true);
      // A retried Attempt gets the same messages, plus any that arrived meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 2));
      await f.send(f.sender, f.recipient, "Four");
      expect(
        (await f.store.bindInboxMessages(task.id, f.recipient.id)).map((item) => item.text),
      ).toEqual(["One", "Two", "Three", "Four"]);
      // A Task of another Tag never takes this Tag's messages.
      await expect(f.store.bindInboxMessages(task.id, f.stranger.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    }, 30_000);

    it("derives a message's status from the inbox turn that took it", async () => {
      const f = await fixture();
      await f.send(f.sender, f.recipient, "One");
      const task = await f.openInboxTask(f.recipient);
      const [pending] = await f.store.bindInboxMessages(task.id, f.recipient.id);
      expect(pending?.status).toBe("pending");
      await f.store.startTask({ taskId: task.id, startedAt: at });
      await f.store.closeTask({ taskId: task.id, status: "completed", endedAt: at });
      const handled = await f.store.listTagMessageHistory(f.recipient.id);
      expect(handled.items[0]).toMatchObject({ status: "handled", taskId: task.id });
      const failing = await f.openInboxTask(f.stranger);
      await f.send(f.sender, f.stranger, "Two");
      await f.store.bindInboxMessages(failing.id, f.stranger.id);
      await f.store.startTask({ taskId: failing.id, startedAt: at });
      await f.store.closeTask({ taskId: failing.id, status: "failed", endedAt: at });
      expect((await f.store.listTagMessageHistory(f.stranger.id)).items[0]?.status).toBe("failed");
    }, 30_000);

    it("lists what a Tag sent and received, newest first, and pages with its cursor", async () => {
      const f = await fixture();
      for (const [from, to, text] of [
        [f.sender, f.recipient, "To the recipient"],
        [f.recipient, f.sender, "Back to the sender"],
        [f.sender, f.stranger, "To a stranger"],
      ] as const) {
        await f.send(from, to, text);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const page = await f.store.listTagMessageHistory(f.recipient.id, { limit: 1 });
      expect(page.items.map((message) => message.text)).toEqual(["Back to the sender"]);
      expect(page.nextCursor).toBeDefined();
      const next = await f.store.listTagMessageHistory(f.recipient.id, {
        limit: 1,
        ...(page.nextCursor === undefined ? {} : { before: page.nextCursor }),
      });
      expect(next.items.map((message) => message.text)).toEqual(["To the recipient"]);
      expect(next.nextCursor).toBeUndefined();
      // The stranger's history holds only its own message.
      expect(
        (await f.store.listTagMessageHistory(f.stranger.id)).items.map((item) => item.text),
      ).toEqual(["To a stranger"]);
    }, 30_000);

    it("carries the hop count and refuses empty, oversized, or malformed messages", async () => {
      const f = await fixture();
      const { message } = await f.send(f.sender, f.recipient, "Relayed", 2);
      expect(message.hops).toBe(2);
      await expect(f.send(f.sender, f.recipient, "   ")).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(
        f.send(f.sender, f.recipient, "x".repeat(TAG_MESSAGE_TEXT_MAX + 1)),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(f.send(f.sender, f.recipient, "Relayed", -1)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(
        f.store.deliverTagMessage({
          senderTagId: f.sender.id,
          recipientTagId: "not a tag id",
          text: "Relayed",
          hops: 0,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }, 30_000);
  });
}
