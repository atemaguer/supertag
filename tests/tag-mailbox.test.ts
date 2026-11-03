import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TagMailboxService } from "../packages/control-plane/src/mailbox.js";
import type { SendTagMessageInput } from "../packages/core/src/mailbox.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { DrizzleMailboxStore } from "../packages/store/src/mailbox-store.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} durable Tag mailboxes`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Mailbox fixture cleanup failed");
    });
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
      const service = new TagMailboxService(store);
      const credential = await service.issueCredential(sender.id);
      const receiver = await service.issueCredential(recipient.id);
      const request: SendTagMessageInput = {
        recipientTagId: recipient.id,
        objectiveId: randomUUID(),
        type: "delegation.requested",
        body: { outcome: "Prepare launch messaging" },
        idempotencyKey: "launch-marketing",
      };
      await service.createObjective(credential.token, {
        id: request.objectiveId,
        outcome: "Launch the product",
      });
      const grant = () =>
        service.setGrant({
          senderTagId: sender.id,
          recipientTagId: recipient.id,
          messageTypes: ["delegation.requested"],
        });
      return {
        store,
        service,
        sender,
        recipient,
        stranger,
        credential,
        receiver,
        request,
        grant,
        url,
      };
    }
    it("admits reciprocal messages across connections without a foreign-key lock deadlock", async () => {
      const f = await fixture();
      await f.grant();
      await f.store.setTagMessagingGrant({
        senderTagId: f.recipient.id,
        recipientTagId: f.sender.id,
        messageTypes: ["delegation.requested"],
      });
      const other = new DrizzleStore({ url: f.url });
      await other.connect();
      cleanups.push(() => other.disconnect());
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          Promise.all([
            f.store.enqueueTagMessage({
              ...f.request,
              senderTagId: f.sender.id,
              idempotencyKey: `forward-${index}`,
            }),
            other.enqueueTagMessage({
              ...f.request,
              senderTagId: f.recipient.id,
              recipientTagId: f.sender.id,
              idempotencyKey: `reverse-${index}`,
            }),
          ]),
        ),
      );
      expect(results.flat()).toHaveLength(40);
      expect(results.flat().every((result) => !result.duplicate)).toBe(true);
      expect(
        (await f.store.listTagMessages(f.sender.id, 200)).filter(
          (message) => message.recipientTagId === f.sender.id,
        ),
      ).toHaveLength(20);
      expect(
        (await other.listTagMessages(f.recipient.id, 200)).filter(
          (message) => message.recipientTagId === f.recipient.id,
        ),
      ).toHaveLength(20);
    });

    it("serializes grant revocation with message admission", async () => {
      const f = await fixture();
      await f.grant();
      const other = new DrizzleStore({ url: f.url });
      await other.connect();
      cleanups.push(() => other.disconnect());

      let sendSettled = false;
      const sending = f.store
        .enqueueTagMessage({
          ...f.request,
          senderTagId: f.sender.id,
          idempotencyKey: "concurrent-grant-revocation",
        })
        .then(
          (value) => {
            sendSettled = true;
            return { status: "fulfilled" as const, value };
          },
          (reason: unknown) => {
            sendSettled = true;
            return { status: "rejected" as const, reason };
          },
        );
      await other.setTagMessagingGrant({
        senderTagId: f.sender.id,
        recipientTagId: f.recipient.id,
        messageTypes: [],
      });
      const settledBeforeRevocationReturned = sendSettled;
      const outcome = await sending;
      if (!settledBeforeRevocationReturned) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected")
          expect(outcome.reason).toMatchObject({ statusCode: 403 });
      }
      await expect(
        f.store.enqueueTagMessage({
          ...f.request,
          senderTagId: f.sender.id,
          idempotencyKey: "after-grant-revocation",
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("serializes Team member removal with post admission", async () => {
      const f = await fixture();
      const team = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.request.objectiveId,
        name: "Membership race",
        leadTagId: f.recipient.id,
        memberTagIds: [f.sender.id],
      });
      const other = new DrizzleStore({ url: f.url });
      await other.connect();
      cleanups.push(() => other.disconnect());

      const originalGetWorkstream = DrizzleMailboxStore.prototype.getWorkstream;
      let releasePreflight: (() => void) | undefined;
      const preflightReleased = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      let reportPreflight: (() => void) | undefined;
      const preflightObserved = new Promise<void>((resolve) => {
        reportPreflight = resolve;
      });
      let intercept = true;
      DrizzleMailboxStore.prototype.getWorkstream = async function (
        id: string,
        viewerTagId?: string,
      ) {
        const current = await originalGetWorkstream.call(this, id, viewerTagId);
        if (intercept && id === team.id && viewerTagId === f.sender.id) {
          intercept = false;
          reportPreflight?.();
          await preflightReleased;
        }
        return current;
      };

      const posting = f.store.postWorkstream({
        workstreamId: team.id,
        authorTagId: f.sender.id,
        body: "Still here?",
        idempotencyKey: "concurrent-member-removal",
      });
      try {
        await preflightObserved;
        const updated = await other.updateTeam(team.id, {
          expectedRevision: team.revision,
          memberTagIds: [],
        });
        expect(updated.memberTagIds).toEqual([f.recipient.id]);
        releasePreflight?.();

        await expect(posting).rejects.toMatchObject({ statusCode: 403 });
        expect(await other.listWorkstreamPosts(team.id, f.recipient.id)).toEqual([]);
      } finally {
        releasePreflight?.();
        DrizzleMailboxStore.prototype.getWorkstream = originalGetWorkstream;
        await posting.catch(() => {});
      }
    });

    it("bounds outstanding messages atomically across senders and admits retries after acknowledgement", async () => {
      const f = await fixture();
      await f.grant();
      await f.store.setTagMessagingGrant({
        senderTagId: f.stranger.id,
        recipientTagId: f.recipient.id,
        messageTypes: ["delegation.requested"],
      });
      const other = new DrizzleStore({ url: f.url });
      await other.connect();
      cleanups.push(() => other.disconnect());
      const otherObjective = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.stranger.id,
        outcome: "Other work",
      });
      const requests = Array.from({ length: 120 }, (_, index) => ({
        ...f.request,
        objectiveId: index % 2 ? f.request.objectiveId : otherObjective.id,
        senderTagId: index % 2 ? f.sender.id : f.stranger.id,
        idempotencyKey: `flood-${index}`,
      }));
      const outcomes = await Promise.allSettled(
        requests.map((request, index) => (index % 2 ? f.store : other).enqueueTagMessage(request)),
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(100);
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(failures).toHaveLength(20);
      for (const failure of failures)
        if (failure.status === "rejected")
          expect(failure.reason).toMatchObject({ statusCode: 429 });
      const existing = requests[outcomes.findIndex((outcome) => outcome.status === "fulfilled")];
      if (!existing) throw new Error("Missing admitted message");
      expect((await other.enqueueTagMessage(existing)).duplicate).toBe(true);
      await expect(
        other.enqueueTagMessage({ ...existing, body: { changed: true } }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const delivery = await f.service.receive(f.receiver.token, { leaseMs: 5000 });
      if (!delivery) throw new Error("Expected outstanding message");
      await expect(
        other.enqueueTagMessage({ ...existing, idempotencyKey: "still-full" }),
      ).rejects.toMatchObject({ statusCode: 429 });
      await f.service.settle(f.receiver.token, delivery.message.id, "ack", {
        leaseToken: delivery.leaseToken,
      });
      expect(
        (await other.enqueueTagMessage({ ...existing, idempotencyKey: "after-ack" })).duplicate,
      ).toBe(false);
      expect(
        (await f.store.listTagMessages(f.recipient.id, 200)).filter(
          (message) => message.status === "pending" || message.status === "processing",
        ),
      ).toHaveLength(100);
    });

    it("persists Objective definitions, validates creation, and restricts visibility", async () => {
      const f = await fixture();
      const id = randomUUID();
      const definition = {
        id,
        outcome: "Win customers",
      };
      await expect(
        f.service.createObjective(f.credential.token, { ...definition, id: ".." }),
      ).rejects.toMatchObject({ statusCode: 400 });
      const objective = await f.service.createObjective(f.credential.token, definition);
      expect(objective).toMatchObject({
        id,
        outcome: "Win customers",
        ownerTagId: f.sender.id,
        status: "working",
        revision: 1,
        completionSummary: null,
      });
      expect(await f.service.createObjective(f.credential.token, definition)).toEqual(objective);
      await expect(
        f.service.createObjective(f.credential.token, { ...definition, outcome: "Other" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        f.service.createObjective(f.credential.token, {
          ...definition,
          ownerTagId: f.recipient.id,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      const statementOnly = await f.service.createObjective(f.credential.token, {
        id: randomUUID(),
        outcome: "Win customers. Done when three contracts are signed.",
      });
      expect(statementOnly).not.toHaveProperty("constraints");
      await expect(f.service.getObjective(f.receiver.token, id)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await f.service.listObjectives(f.receiver.token, {})).toEqual([]);
      // Joining a Team in the Objective makes it visible.
      await f.store.createTeam({
        id: randomUUID(),
        objectiveId: id,
        name: "Outreach",
        leadTagId: f.sender.id,
        memberTagIds: [f.recipient.id],
      });
      // Creating the Team took the Objective's lock; nothing else changed.
      const visible = { ...objective, lockRevision: expect.any(Number) };
      expect(await f.service.getObjective(f.receiver.token, id)).toEqual(visible);
      expect((await f.service.listObjectives(f.receiver.token, {})).map((o) => o.id)).toEqual([id]);
      expect((await f.service.getObjective(f.credential.token, id)).status).toBe("working");
      const reconnected = new DrizzleStore({ url: f.url });
      await reconnected.connect();
      try {
        expect(await reconnected.getObjective(id)).toEqual(visible);
      } finally {
        await reconnected.disconnect();
      }
    });

    it("filters operator Objective listings by owner even when a Tag belongs to a Team", async () => {
      const f = await fixture();
      await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.request.objectiveId,
        name: "Delivery",
        leadTagId: f.sender.id,
        memberTagIds: [f.recipient.id],
        maxConcurrency: 1,
      });
      const owned = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.recipient.id,
        outcome: "Review delivery",
      });
      expect((await f.service.listObjectives(f.receiver.token, {})).map((o) => o.id)).toContain(
        f.request.objectiveId,
      );
      expect((await f.store.listObjectives(f.recipient.id)).map((o) => o.id)).toEqual([owned.id]);
    });

    it("requires an explicit completion assessment and fences owner updates", async () => {
      const f = await fixture();
      const id = f.request.objectiveId;
      await f.store.createTeam({
        id: randomUUID(),
        objectiveId: id,
        name: "Shared",
        leadTagId: f.sender.id,
        memberTagIds: [f.recipient.id],
      });
      await expect(
        f.service.updateObjectiveStatus(f.receiver.token, id, {
          status: "blocked",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.service.updateObjectiveStatus(f.credential.token, id, {
          status: "completed",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        f.service.updateObjectiveStatus(f.credential.token, id, {
          status: "working",
          expectedRevision: 1,
          completionSummary: "Invalid",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      const updates = await Promise.allSettled([
        f.service.updateObjectiveStatus(f.credential.token, id, {
          status: "blocked",
          expectedRevision: 1,
        }),
        f.service.updateObjectiveStatus(f.credential.token, id, {
          status: "ready_for_review",
          expectedRevision: 1,
        }),
      ]);
      expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(updates.find((result) => result.status === "rejected")).toMatchObject({
        reason: { statusCode: 409 },
      });
      const completed = await f.service.updateObjectiveStatus(f.credential.token, id, {
        status: "completed",
        expectedRevision: 2,
        completionSummary: "Materials approved; approval recorded in launch-review.",
      });
      expect(completed).toMatchObject({
        status: "completed",
        revision: 3,
        completionSummary: "Materials approved; approval recorded in launch-review.",
      });
      expect(
        (
          await f.service.createObjective(f.credential.token, {
            id,
            outcome: "Launch the product",
          })
        ).revision,
      ).toBe(3);
      const reopened = await f.store.updateObjectiveStatus(id, {
        status: "working",
        expectedRevision: 3,
      });
      expect(reopened).toMatchObject({ status: "working", revision: 4, completionSummary: null });
      await expect(
        f.service.updateObjectiveStatus(f.credential.token, id, {
          status: "completed",
          expectedRevision: 3,
          completionSummary: "Stale",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("gives each Team one channel that only its members and the Objective owner read", async () => {
      const f = await fixture();
      const team = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.request.objectiveId,
        name: "Launch messaging",
        leadTagId: f.recipient.id,
        memberTagIds: [],
      });
      const stream = await f.service.getWorkstream(f.receiver.token, team.id);
      expect(stream).toEqual({
        id: team.id,
        objectiveId: f.request.objectiveId,
        title: "Launch messaging",
        ownerTagId: f.recipient.id,
        participantTagIds: [f.recipient.id],
        createdAt: team.createdAt,
        updatedAt: team.updatedAt,
      });
      // The sender owns the Objective: it reads the channel but is not a member, so cannot post.
      expect(await f.service.getWorkstream(f.credential.token, team.id)).toEqual(stream);
      const post = await f.service.postWorkstream(f.receiver.token, team.id, {
        body: "Draft ready",
        type: "evidence",
        idempotencyKey: "draft",
      });
      expect(post).toMatchObject({ authorTagId: f.recipient.id, type: "evidence", to: [] });
      await expect(
        f.service.postWorkstream(f.credential.token, team.id, {
          body: "Owner note",
          idempotencyKey: "owner",
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      // Neither the caller's identity nor the channel can be chosen in the body.
      await expect(
        f.service.postWorkstream(f.receiver.token, team.id, {
          body: "Spoofed",
          authorTagId: f.sender.id,
          idempotencyKey: "spoof",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      const outsider = await f.service.issueCredential(f.stranger.id);
      expect(await f.service.listWorkstreams(outsider.token, {})).toEqual([]);
      await expect(f.service.getWorkstream(outsider.token, team.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        f.service.listWorkstreamPosts(outsider.token, team.id, {}),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        f.service.postWorkstream(outsider.token, team.id, { body: "Hi", idempotencyKey: "x" }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(
        (await f.service.listWorkstreams(f.receiver.token, {})).map((item) => item.id),
      ).toEqual([team.id]);
      await f.store.disconnect();
      await f.store.connect();
      expect(await f.service.getWorkstream(f.receiver.token, team.id)).toEqual(stream);
      // A post is only stored text: nothing reaches a Mailbox and no Task starts.
      expect(await f.store.listTagMessages(f.recipient.id)).toEqual([]);
      expect(await f.store.listTaskAssignments(f.request.objectiveId)).toEqual([]);
    });

    it("rejects Workstream-tagged messages", async () => {
      const f = await fixture();
      await f.grant();
      await expect(
        f.service.send(f.credential.token, { ...f.request, workstreamId: randomUUID() }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("automatically provides an empty mailbox without a Route and fails closed until explicitly granted", async () => {
      const f = await fixture();
      expect(await f.store.listTagMessages(f.recipient.id)).toEqual([]);
      await expect(f.service.send(f.credential.token, f.request)).rejects.toMatchObject({
        statusCode: 403,
      });
      await f.grant();
      const sent = await f.service.send(f.credential.token, f.request);
      expect(sent.message).toMatchObject({
        senderTagId: f.sender.id,
        recipientTagId: f.recipient.id,
        status: "pending",
        attemptCount: 0,
      });
      expect(await f.store.listTasks({ tagId: f.recipient.id })).toEqual([]);
      await expect(
        f.service.send(f.credential.token, { ...f.request, type: "cancellation.requested" }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.service.send(f.credential.token, { ...f.request, senderTagId: f.stranger.id }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        f.service.send(f.credential.token, { ...f.request, recipientTagId: f.stranger.id }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await f.service.setGrant({
        senderTagId: f.sender.id,
        recipientTagId: f.recipient.id,
        messageTypes: [],
      });
      await expect(
        f.service.send(f.credential.token, { ...f.request, idempotencyKey: "new" }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
    it("deduplicates concurrent sends and canonical JSON, but rejects a reused key with changed intent", async () => {
      const f = await fixture();
      await f.grant();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          f.service.send(f.credential.token, { ...f.request, body: { b: 2, a: 1 } }),
        ),
      );
      expect(new Set(results.map((result) => result.message.id)).size).toBe(1);
      expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
      expect(
        (await f.service.send(f.credential.token, { ...f.request, body: { a: 1, b: 2 } }))
          .duplicate,
      ).toBe(true);
      await expect(
        f.service.send(f.credential.token, { ...f.request, body: { a: 2, b: 2 } }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
    it("recovers queued work across reconnect and fences concurrent, expired, and foreign claims", async () => {
      const f = await fixture();
      await f.grant();
      await f.service.send(f.credential.token, f.request);
      await f.store.disconnect();
      await f.store.connect();
      const otherStore = new DrizzleStore({ url: f.url });
      await otherStore.connect();
      cleanups.push(() => otherStore.disconnect());
      const other = new TagMailboxService(otherStore);
      const claims = await Promise.all([
        f.service.receive(f.receiver.token, {}),
        other.receive(f.receiver.token, {}),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const first = claims.find((claim) => claim !== undefined);
      if (!first) throw new Error("Missing claim");
      expect(await f.service.receive(f.credential.token, {})).toBeUndefined();
      await expect(
        f.service.settle(f.credential.token, first.message.id, "ack", {
          leaseToken: first.leaseToken,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const later = new Date(Date.parse(first.leaseExpiresAt) + 1);
      const second = await otherStore.claimTagMessage({
        tagId: f.recipient.id,
        credentialId: f.receiver.id,
        now: later.toISOString(),
        leaseExpiresAt: new Date(later.getTime() + 60_000).toISOString(),
      });
      if (!second) throw new Error("Missing replacement claim");
      expect(second.message.attemptCount).toBe(2);
      expect(second.leaseToken).not.toBe(first.leaseToken);
      await expect(
        f.service.settle(f.receiver.token, first.message.id, "ack", {
          leaseToken: first.leaseToken,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await f.service.settle(f.receiver.token, second.message.id, "ack", {
        leaseToken: second.leaseToken,
      });
      await f.service.settle(f.receiver.token, second.message.id, "ack", {
        leaseToken: second.leaseToken,
      });
      expect((await f.store.listTagMessages(f.recipient.id))[0]?.status).toBe("processed");
      expect(JSON.stringify(await f.store.listTagMessages(f.recipient.id))).not.toContain(
        second.leaseToken,
      );
    });
    it("bounds poison-message redelivery and progresses to the next message", async () => {
      const f = await fixture();
      await f.grant();
      const sent = await f.service.send(f.credential.token, f.request);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const delivery = await f.service.receive(f.receiver.token, {});
        if (!delivery) throw new Error("Missing delivery");
        expect(delivery.message.attemptCount).toBe(attempt);
        await f.service.settle(f.receiver.token, delivery.message.id, "release", {
          leaseToken: delivery.leaseToken,
          retry: true,
        });
      }
      expect(await f.service.receive(f.receiver.token, {})).toBeUndefined();
      expect(
        (await f.store.listTagMessages(f.recipient.id)).find(
          (message) => message.id === sent.message.id,
        )?.status,
      ).toBe("failed");
      await f.service.send(f.credential.token, { ...f.request, idempotencyKey: "next" });
      expect((await f.service.receive(f.receiver.token, {}))?.message.idempotencyKey).toBe("next");
    });
    it("requires reply authority and verifies participants and objective correlation", async () => {
      const f = await fixture();
      await f.grant();
      const sent = await f.service.send(f.credential.token, f.request);
      const reply = {
        recipientTagId: f.sender.id,
        objectiveId: f.request.objectiveId,
        type: "delegation.accepted",
        inReplyTo: sent.message.id,
        body: {},
        idempotencyKey: "accept",
      };
      await expect(f.service.send(f.receiver.token, reply)).rejects.toMatchObject({
        statusCode: 403,
      });
      await f.service.setGrant({
        senderTagId: f.recipient.id,
        recipientTagId: f.sender.id,
        messageTypes: ["delegation.accepted"],
      });
      await expect(
        f.service.send(f.receiver.token, { ...reply, objectiveId: "another" }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        f.service.send(f.receiver.token, { ...reply, inReplyTo: randomUUID() }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect((await f.service.send(f.receiver.token, reply)).message.inReplyTo).toBe(
        sent.message.id,
      );
    });
    it("revokes credentials during a pending receive and rejects malformed or oversized messages", async () => {
      const f = await fixture();
      await f.grant();
      const receive = f.service.receive(f.receiver.token, { waitMs: 1_000 });
      const rejected = expect(receive).rejects.toMatchObject({ statusCode: 401 });
      await f.store.revokeTagMailboxCredential(f.receiver.id);
      await rejected;
      await expect(f.service.authenticate(f.receiver.token)).rejects.toMatchObject({
        statusCode: 401,
      });
      await expect(
        f.service.send(f.credential.token, { ...f.request, body: { text: "a".repeat(65_536) } }),
      ).rejects.toMatchObject({ statusCode: 413 });
      await expect(
        f.service.send(f.credential.token, { ...f.request, type: "invented" }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(f.service.receive(f.credential.token, { waitMs: 99_999 })).rejects.toMatchObject(
        { statusCode: 400 },
      );
    });
    it("renews live claims and makes handler failure terminal unless retry is explicitly requested", async () => {
      const f = await fixture();
      await f.grant();
      await f.service.send(f.credential.token, f.request);
      const delivery = await f.service.receive(f.receiver.token, { leaseMs: 5_000 });
      if (!delivery) throw new Error("Missing delivery");
      await f.service.settle(f.receiver.token, delivery.message.id, "renew", {
        leaseToken: delivery.leaseToken,
        leaseMs: 60_000,
      });
      const now = new Date(Date.parse(delivery.leaseExpiresAt) + 1);
      expect(
        await f.store.claimTagMessage({
          tagId: f.recipient.id,
          credentialId: f.receiver.id,
          now: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
        }),
      ).toBeUndefined();
      await f.service.settle(f.receiver.token, delivery.message.id, "release", {
        leaseToken: delivery.leaseToken,
      });
      expect(await f.service.receive(f.receiver.token, {})).toBeUndefined();
      expect((await f.store.listTagMessages(f.recipient.id))[0]?.status).toBe("failed");
    });
  });
}
