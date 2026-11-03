import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { type AdmitTaskAssignmentInput, ownerDeliveries } from "../packages/core/src/index.js";
import { parseTagMessageInput } from "../packages/core/src/mailbox.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { TEAM_REPLY_COALESCE_WINDOW_MS } from "../packages/store/src/team-reply-triggers.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

afterEach(() => vi.useRealTimers());

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} shared Team coordination`,
    () => {
      async function fixture(budgetLimitMinor = 100) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-shared-team-"));
        if (dialect === "postgresql" && !postgres) throw new Error("Missing test database");
        const isolated =
          dialect === "postgresql" && postgres
            ? await createIsolatedPostgresDatabase(postgres)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        const other = new DrizzleStore({ url });
        await store.connect();
        await other.connect();
        const owner = await store.createTag({ name: "Enterprise owner" });
        const ownerB = await store.createTag({ name: "Refund owner" });
        const lead = await store.createTag({ name: "Payments lead" });
        const implementer = await store.createTag({ name: "Payments implementer" });
        const a = await store.createObjective({
          id: "enterprise",
          ownerTagId: owner.id,
          outcome: "Enterprise invoicing",
          budgetLimitMinor,
        });
        const b = await store.createObjective({
          id: "refunds",
          ownerTagId: ownerB.id,
          outcome: "Reliable refunds",
          budgetLimitMinor,
        });
        const team = await store.createTeam({
          id: "payments",
          objectiveId: a.id,
          name: "Payments",
          leadTagId: lead.id,
          memberTagIds: [implementer.id],
          maxConcurrency: 1,
        });
        const make = (
          objectiveId: string,
          extra: Partial<AdmitTaskAssignmentInput> = {},
        ): AdmitTaskAssignmentInput => ({
          taskId: randomUUID(),
          objectiveId,
          teamId: team.id,
          requestedByTagId: lead.id,
          assignedTagId: implementer.id,
          instruction: "Deliver the current Payments requirement",
          acceptanceCriteria: ["Evidence matches current requirement"],
          maxCostMinor: 5,
          execution: {},
          authorizationSnapshot: {
            version: 4,
            capturedAt: new Date().toISOString(),
            tag: { id: implementer.id, name: implementer.name },
            origin: { kind: "internal", objectiveId, requestedByTagId: lead.id },
            requester: { id: lead.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
          contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
          workspacePlan: { version: 1, status: "none" },
          ...extra,
        });
        return {
          store,
          other,
          a,
          b,
          team,
          owner,
          ownerB,
          lead,
          implementer,
          make,
          async cleanup() {
            await other.disconnect();
            await store.disconnect();
            await isolated?.cleanup();
            await rm(directory, { recursive: true, force: true });
          },
        };
      }

      it("treats current Team membership as a reciprocal direct-message grant", async () => {
        const f = await fixture(200);
        try {
          const direct = (
            senderTagId: string,
            recipientTagId: string,
            type: "question" | "blocker",
          ) =>
            f.store.enqueueTagMessage({
              senderTagId,
              recipientTagId,
              objectiveId: f.a.id,
              type,
              body: { message: "Please inspect the test result" },
              idempotencyKey: randomUUID(),
            });
          const question = await direct(f.implementer.id, f.lead.id, "question");
          const blocker = await direct(f.lead.id, f.implementer.id, "blocker");
          expect(question.message).toMatchObject({
            type: "question",
            to: [f.lead.id],
            status: "pending",
          });
          expect(blocker.message).toMatchObject({ type: "blocker", to: [f.implementer.id] });
          await f.store.bindTagWorkerHost(f.owner.id, "fixture-host");
          await new ObjectiveController(f.store, undefined).commandAsAdministrator(
            "start_objective",
            {
              objectiveId: f.a.id,
            },
          );
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(Date.now() + TEAM_REPLY_COALESCE_WINDOW_MS);
          const replies = await f.store.admitMailboxTaskAssignments();
          expect(replies).toHaveLength(2);
          expect(
            replies.every(
              (task) => task.activationKind === "team_reply" && task.sourceMessageId === null,
            ),
          ).toBe(true);
          for (const reply of replies) await f.store.cancelTaskAssignment(reply.taskId, f.owner.id);
          expect(
            (await f.store.listTagMessages(f.lead.id)).find(
              (item) => item.id === question.message.id,
            ),
          ).toMatchObject({ status: "pending" });
          await expect(direct(f.owner.id, f.implementer.id, "question")).rejects.toMatchObject({
            statusCode: 403,
          });
          await f.store.setTagMessagingGrant({
            senderTagId: f.owner.id,
            recipientTagId: f.implementer.id,
            messageTypes: ["question"],
          });
          expect((await direct(f.owner.id, f.implementer.id, "question")).message.status).toBe(
            "pending",
          );
          expect(
            parseTagMessageInput({
              to: [f.lead.id],
              objectiveId: f.a.id,
              body: {},
              idempotencyKey: "to-alias",
            }),
          ).toMatchObject({ recipientTagId: f.lead.id, type: "note" });
          expect(() =>
            parseTagMessageInput({
              to: [f.lead.id, f.owner.id],
              objectiveId: f.a.id,
              body: {},
              idempotencyKey: "invalid",
            }),
          ).toThrow();
          await f.store.updateTeam(f.team.id, { expectedRevision: 1, memberTagIds: [] });
          const admittedAfterRemoval = await f.store.admitMailboxTaskAssignments();
          expect(
            admittedAfterRemoval.some(
              (task) =>
                task.sourceMessageId === question.message.id ||
                task.sourceMessageId === blocker.message.id,
            ),
          ).toBe(false);
          await expect(direct(f.lead.id, f.implementer.id, "question")).rejects.toMatchObject({
            statusCode: 403,
          });
        } finally {
          await f.cleanup();
        }
      });

      it("wakes an existing mailbox wait for a new Team direct message", async () => {
        const f = await fixture();
        try {
          const task = await f.store.admitTaskAssignment(f.make(f.a.id));
          await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "recipient" });
          await f.store.registerTaskAssignmentWait({
            taskId: task.taskId,
            leaseOwner: "recipient",
            attemptCount: 1,
            mailbox: true,
          });
          await f.store.settleTaskAssignment({
            taskId: task.taskId,
            leaseOwner: "recipient",
            attemptCount: 1,
            result: { waiting: true },
          });
          const sent = await f.store.enqueueTagMessage({
            senderTagId: f.lead.id,
            recipientTagId: f.implementer.id,
            objectiveId: f.a.id,
            type: "question",
            body: { message: "Can you review this?" },
            idempotencyKey: randomUUID(),
          });
          expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
          expect(await f.store.wakeWaitingTaskAssignments()).toContainEqual(
            expect.objectContaining({
              taskId: task.taskId,
              waitState: expect.objectContaining({
                wake: expect.objectContaining({ reason: "mailbox", taskIds: [] }),
              }),
            }),
          );
          expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("pending");
        } finally {
          await f.cleanup();
        }
      });

      it("delivers same-Team messages to the Objective owner and frees sender capacity", async () => {
        const f = await fixture();
        try {
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 1,
            memberTagIds: [f.implementer.id, f.owner.id],
          });
          await f.store.bindTagWorkerHost(f.owner.id, "fixture-host");
          await new ObjectiveController(f.store, undefined).commandAsAdministrator(
            "start_objective",
            { objectiveId: f.a.id },
          );
          const send = (index: number) =>
            f.store.enqueueTagMessage({
              senderTagId: f.lead.id,
              recipientTagId: f.owner.id,
              objectiveId: f.a.id,
              type: "blocker",
              body: { message: `Owner report ${index}` },
              idempotencyKey: `owner-${index}`,
            });
          const first = await send(0);
          await f.store.admitMailboxTaskAssignments();
          expect((await f.store.getTagMessage(first.message.id))?.status).toBe("pending");
          await f.store.deliverActivationDigest({ tagId: f.owner.id, objectiveId: f.a.id });
          expect((await f.store.getTagMessage(first.message.id))?.status).toBe("processed");
          const second = await send(1);
          expect(
            await f.store.takeTeamDirectMessages({
              tagId: f.owner.id,
              objectiveId: f.a.id,
              limit: 100,
            }),
          ).toMatchObject([{ id: second.message.id, status: "processed" }]);
          await expect(send(2)).resolves.toMatchObject({ duplicate: false });
        } finally {
          await f.cleanup();
        }
      });

      it("discards queued owner messages when either member leaves and never revives them", async () => {
        const f = await fixture();
        try {
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 1,
            memberTagIds: [f.implementer.id, f.owner.id],
          });
          await f.store.bindTagWorkerHost(f.owner.id, "fixture-host");
          await new ObjectiveController(f.store, undefined).commandAsAdministrator(
            "start_objective",
            { objectiveId: f.a.id },
          );
          await f.store.cancelTaskAssignment(`${f.a.id}:start`, f.owner.id);
          const send = (senderTagId: string) =>
            f.store.enqueueTagMessage({
              senderTagId,
              recipientTagId: f.owner.id,
              objectiveId: f.a.id,
              type: "blocker",
              body: { message: "Queued before membership change" },
              idempotencyKey: randomUUID(),
            });
          const removedSender = await send(f.implementer.id);
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 2,
            memberTagIds: [f.owner.id],
          });
          expect((await f.store.getTagMessage(removedSender.message.id))?.status).toBe("failed");
          expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 3,
            memberTagIds: [f.implementer.id, f.owner.id],
          });
          const removedRecipient = await send(f.implementer.id);
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 4,
            memberTagIds: [f.implementer.id],
          });
          expect((await f.store.getTagMessage(removedRecipient.message.id))?.status).toBe("failed");
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 5,
            memberTagIds: [f.implementer.id, f.owner.id],
          });
          expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
          expect(
            await f.store.getTaskAssignment(`message:${removedSender.message.id}`),
          ).toBeUndefined();
          expect(
            await f.store.getTaskAssignment(`message:${removedRecipient.message.id}`),
          ).toBeUndefined();
        } finally {
          await f.cleanup();
        }
      });

      it("does not bind a removed sender's queued owner delivery", async () => {
        const f = await fixture();
        try {
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 1,
            memberTagIds: [f.implementer.id, f.owner.id],
          });
          await f.store.bindTagWorkerHost(f.owner.id, "fixture-host");
          await new ObjectiveController(f.store, undefined).commandAsAdministrator(
            "start_objective",
            { objectiveId: f.a.id },
          );
          const owner = (await f.store.listTaskAssignments(f.a.id)).find(
            (task) => task.assignedTagId === f.owner.id,
          );
          if (!owner) throw new Error("Missing owner activation");
          const sent = await f.store.enqueueTagMessage({
            senderTagId: f.implementer.id,
            recipientTagId: f.owner.id,
            objectiveId: f.a.id,
            type: "note",
            body: { message: "Sender removed before owner starts" },
            idempotencyKey: "removed-owner-delivery",
          });
          await f.store.admitMailboxTaskAssignments();
          expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("pending");
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 2,
            memberTagIds: [f.owner.id],
          });
          expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("failed");
          const claimed = await f.store.claimTaskAssignment({
            taskId: owner.taskId,
            leaseOwner: "owner",
          });
          expect(claimed).toBeDefined();
          const trigger = (await f.store.findTaskById(owner.taskId))?.trigger;
          expect(ownerDeliveries(trigger).pending).toEqual([]);
        } finally {
          await f.cleanup();
        }
      });

      it.each(["unlink", "governance"] as const)(
        "revokes pending deliveries when %s removes their Objective",
        async (change) => {
          const f = await fixture();
          try {
            const c = await f.store.createObjective({
              id: "third",
              ownerTagId: f.owner.id,
              outcome: "Third",
            });
            const linked = await f.store.updateTeam(f.team.id, {
              expectedRevision: 1,
              objectiveIds: [f.b.id, c.id],
              memberTagIds: [f.implementer.id, f.ownerB.id],
            });
            await f.store.bindTagWorkerHost(f.ownerB.id, "fixture-host");
            await new ObjectiveController(f.store, undefined).commandAsAdministrator(
              "start_objective",
              { objectiveId: f.b.id },
            );
            const sent = await f.store.enqueueTagMessage({
              senderTagId: f.implementer.id,
              recipientTagId: f.ownerB.id,
              objectiveId: f.b.id,
              type: "note",
              body: { message: "Revoke this claimed delivery" },
              idempotencyKey: "unlink-processing",
            });
            await f.store.admitMailboxTaskAssignments();
            const root = (await f.store.listTaskAssignments(f.b.id)).find(
              (task) => task.assignedTagId === f.ownerB.id,
            );
            if (!root) throw new Error("Missing owner activation");
            const claimed = await f.store.claimTaskAssignment({
              taskId: root.taskId,
              leaseOwner: "owner",
            });
            expect(claimed).toBeDefined();
            expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("pending");
            const updated = await f.store.updateTeam(f.team.id, {
              expectedRevision: linked.revision,
              objectiveIds: [],
              ...(change === "governance" ? { objectiveId: c.id } : {}),
            });
            expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("failed");
            // Relinking must never revive a revoked pending delivery, even after a failed Attempt.
            await f.store.updateTeam(f.team.id, {
              expectedRevision: updated.revision,
              objectiveIds: [f.b.id],
            });
            await f.store.settleTaskAssignment({
              taskId: root.taskId,
              leaseOwner: "owner",
              attemptCount: claimed.attemptCount,
              failed: true,
              result: { error: "Stopped" },
            });
            expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("failed");
          } finally {
            await f.cleanup();
          }
        },
      );

      it("rechecks an owner direct message before building its digest", async () => {
        const f = await fixture();
        try {
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 1,
            memberTagIds: [f.implementer.id, f.owner.id],
          });
          await f.store.bindTagWorkerHost(f.owner.id, "fixture-host");
          await new ObjectiveController(f.store, undefined).commandAsAdministrator(
            "start_objective",
            { objectiveId: f.a.id },
          );
          const owner = (await f.store.listTaskAssignments(f.a.id)).find(
            (task) => task.assignedTagId === f.owner.id,
          );
          if (!owner) throw new Error("Missing owner activation");
          const sent = await f.store.enqueueTagMessage({
            senderTagId: f.implementer.id,
            recipientTagId: f.owner.id,
            objectiveId: f.a.id,
            type: "note",
            body: { message: "Revoked after claim" },
            idempotencyKey: "revoked-after-claim",
          });
          await f.store.admitMailboxTaskAssignments();
          expect(
            await f.store.claimTaskAssignment({
              taskId: owner.taskId,
              leaseOwner: "owner",
            }),
          ).toBeDefined();
          expect(
            (
              await f.store.readActivationDigest({ tagId: f.owner.id, objectiveId: f.a.id })
            ).items.map((item) => item.id),
          ).toContain(sent.message.id);
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 2,
            memberTagIds: [f.owner.id],
          });
          // Removal revokes even a claimed delivery before its context is assembled.
          expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("failed");
          expect(
            (
              await f.store.readActivationDigest({ tagId: f.owner.id, objectiveId: f.a.id })
            ).items.map((item) => item.id),
          ).not.toContain(sent.message.id);
          expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("failed");
          await f.store.settleTaskAssignment({
            taskId: owner.taskId,
            leaseOwner: "owner",
            attemptCount: 1,
            failed: true,
            result: { error: "Owner stopped before reading context" },
          });
          await f.store.admitMailboxTaskAssignments();
          expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("failed");
        } finally {
          await f.cleanup();
        }
      });

      it("wakes a mailbox wait for a valid direct message behind 100 stale ones", async () => {
        const f = await fixture();
        try {
          const task = await f.store.admitTaskAssignment(f.make(f.a.id));
          await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "recipient" });
          await f.store.registerTaskAssignmentWait({
            taskId: task.taskId,
            leaseOwner: "recipient",
            attemptCount: 1,
            mailbox: true,
          });
          await f.store.settleTaskAssignment({
            taskId: task.taskId,
            leaseOwner: "recipient",
            attemptCount: 1,
            result: { waiting: true },
          });
          for (let index = 0; index < 100; index++)
            await f.store.enqueueTagMessage({
              senderTagId: f.lead.id,
              recipientTagId: f.implementer.id,
              objectiveId: f.a.id,
              type: "note",
              body: { message: `Stale ${index}` },
              idempotencyKey: `stale-${index}`,
            });
          const replacement = await f.store.createTag({ name: "New Payments lead" });
          await f.store.updateTeam(f.team.id, {
            expectedRevision: 1,
            leadTagId: replacement.id,
          });
          await f.store.enqueueTagMessage({
            senderTagId: replacement.id,
            recipientTagId: f.implementer.id,
            objectiveId: f.a.id,
            type: "question",
            body: { message: "Valid after reassignment" },
            idempotencyKey: "valid-new-lead",
          });
          expect(await f.store.wakeWaitingTaskAssignments()).toContainEqual(
            expect.objectContaining({
              taskId: task.taskId,
              waitState: expect.objectContaining({
                wake: expect.objectContaining({ reason: "mailbox" }),
              }),
            }),
          );
        } finally {
          await f.cleanup();
        }
      });

      it("bounds direct messages per sender without exhausting granted traffic", async () => {
        const f = await fixture();
        try {
          for (let index = 0; index < 100; index++) {
            await f.store.enqueueTagMessage({
              senderTagId: f.lead.id,
              recipientTagId: f.implementer.id,
              objectiveId: f.a.id,
              type: "note",
              // Distinct bodies: identical messages from one sender are dropped as duplicates.
              body: { message: `Team context ${index}` },
              idempotencyKey: `direct-${index}`,
            });
          }
          await expect(
            f.store.enqueueTagMessage({
              senderTagId: f.lead.id,
              recipientTagId: f.implementer.id,
              objectiveId: f.a.id,
              type: "note",
              body: { message: "One too many" },
              idempotencyKey: "direct-over-limit",
            }),
          ).rejects.toMatchObject({ statusCode: 429 });
          await f.store.setTagMessagingGrant({
            senderTagId: f.owner.id,
            recipientTagId: f.implementer.id,
            messageTypes: ["message"],
          });
          await expect(
            f.store.enqueueTagMessage({
              senderTagId: f.owner.id,
              recipientTagId: f.implementer.id,
              objectiveId: f.a.id,
              type: "message",
              body: { message: "Granted traffic" },
              idempotencyKey: "granted-after-direct",
            }),
          ).resolves.toMatchObject({ duplicate: false });
          expect(
            await f.store.takeTeamDirectMessages({
              tagId: f.implementer.id,
              objectiveId: f.a.id,
              limit: 1,
            }),
          ).toHaveLength(1);
          await expect(
            f.store.enqueueTagMessage({
              senderTagId: f.lead.id,
              recipientTagId: f.implementer.id,
              objectiveId: f.a.id,
              type: "note",
              body: { message: "Room after delivery" },
              idempotencyKey: "direct-after-delivery",
            }),
          ).resolves.toMatchObject({ duplicate: false });
        } finally {
          await f.cleanup();
        }
      });

      it("does not turn Team membership into a grant for lifecycle messages", async () => {
        const f = await fixture();
        try {
          for (const type of [
            "delegation.requested",
            "result.submitted",
            "cancellation.requested",
          ] as const)
            await expect(
              f.store.enqueueTagMessage({
                senderTagId: f.lead.id,
                recipientTagId: f.implementer.id,
                objectiveId: f.a.id,
                type,
                body: { message: "Lifecycle request" },
                idempotencyKey: randomUUID(),
              }),
            ).rejects.toMatchObject({ statusCode: 403 });
          await f.store.setTagMessagingGrant({
            senderTagId: f.lead.id,
            recipientTagId: f.implementer.id,
            messageTypes: ["delegation.requested"],
          });
          await expect(
            f.store.enqueueTagMessage({
              senderTagId: f.lead.id,
              recipientTagId: f.implementer.id,
              objectiveId: f.a.id,
              type: "delegation.requested",
              body: { message: "Delegate work" },
              idempotencyKey: randomUUID(),
            }),
          ).resolves.toMatchObject({ duplicate: false });
        } finally {
          await f.cleanup();
        }
      });

      it("ignores a direct message after its sender leaves the Team", async () => {
        const f = await fixture();
        try {
          const task = await f.store.admitTaskAssignment(f.make(f.a.id));
          await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "recipient" });
          await f.store.registerTaskAssignmentWait({
            taskId: task.taskId,
            leaseOwner: "recipient",
            attemptCount: 1,
            mailbox: true,
          });
          await f.store.settleTaskAssignment({
            taskId: task.taskId,
            leaseOwner: "recipient",
            attemptCount: 1,
            result: { waiting: true },
          });
          await f.store.enqueueTagMessage({
            senderTagId: f.lead.id,
            recipientTagId: f.implementer.id,
            objectiveId: f.a.id,
            type: "question",
            body: { message: "Old question" },
            idempotencyKey: randomUUID(),
          });
          const team = await f.store.getTeam(f.team.id);
          await f.store.updateTeam(f.team.id, {
            expectedRevision: team.revision,
            leadTagId: f.owner.id,
            memberTagIds: [f.implementer.id],
          });
          expect(await f.store.wakeWaitingTaskAssignments()).toEqual([]);
        } finally {
          await f.cleanup();
        }
      });

      it("shares one capacity limit, replans locally and preserves the outer review boundary", async () => {
        const f = await fixture();
        try {
          await expect(f.store.admitTaskAssignment(f.make(f.b.id))).rejects.toMatchObject({
            statusCode: 403,
          });
          await expect(
            f.store.updateTeam(
              f.team.id,
              { expectedRevision: 1, objectiveIds: [f.b.id] },
              f.lead.id,
            ),
          ).rejects.toMatchObject({ statusCode: 403 });
          await f.store.updateTeam(f.team.id, { expectedRevision: 1, objectiveIds: [f.b.id] });
          expect(await f.store.getObjective(f.b.id, f.lead.id)).toMatchObject({ id: f.b.id });
          const a = await f.store.admitTaskAssignment(f.make(f.a.id));
          const b = await f.store.admitTaskAssignment(f.make(f.b.id));
          // Different connections and different Objective locks must still share capacity.
          const claims = await Promise.all([
            f.store.claimTaskAssignment({ taskId: a.taskId, leaseOwner: "a" }),
            f.other.claimTaskAssignment({ taskId: b.taskId, leaseOwner: "b" }),
          ]);
          expect(claims.filter(Boolean)).toHaveLength(1);
          const running = claims[0] ? a : b;
          const queued = claims[0] ? b : a;
          await f.store.cancelTaskAssignment(running.taskId, f.lead.id);
          const next = await f.other.claimTaskAssignment({
            taskId: queued.taskId,
            leaseOwner: "next",
          });
          expect(next?.status).toBe("running");
          await f.store.settleTaskAssignment({
            taskId: queued.taskId,
            leaseOwner: "next",
            attemptCount: 1,
            status: "submitted",
            result: { text: "Required behavior missing" },
          });
          await f.store.reviewTaskAssignment(
            queued.taskId,
            f.lead.id,
            false,
            "Required behavior missing",
          );
          const obsolete = await f.store.admitTaskAssignment(
            f.make(queued.objectiveId, { dependencies: [queued.taskId] }),
          );
          expect(
            await f.store.claimTaskAssignment({ taskId: obsolete.taskId, leaseOwner: "blocked" }),
          ).toBeUndefined();
          await f.store.cancelTaskAssignment(obsolete.taskId, f.lead.id);
          const replacement = await f.store.admitTaskAssignment(
            f.make(queued.objectiveId, { instruction: "Repair changed requirements" }),
          );
          await f.store.claimTaskAssignment({ taskId: replacement.taskId, leaseOwner: "repair" });
          await f.store.settleTaskAssignment({
            taskId: replacement.taskId,
            leaseOwner: "repair",
            attemptCount: 1,
            status: "submitted",
            result: { text: "Repair evidence" },
          });
          await f.store.reviewTaskAssignment(
            replacement.taskId,
            f.lead.id,
            true,
            "Repair evidence accepted",
          );
          const commitment = await f.store.admitTaskAssignment(
            f.make(f.b.id, { requestedByTagId: f.ownerB.id, assignedTagId: f.lead.id }),
          );
          await f.store.claimTaskAssignment({ taskId: commitment.taskId, leaseOwner: "lead" });
          await f.store.settleTaskAssignment({
            taskId: commitment.taskId,
            leaseOwner: "lead",
            attemptCount: 1,
            status: "submitted",
            result: { text: "Integrated result" },
          });
          await expect(
            f.store.reviewTaskAssignment(commitment.taskId, f.lead.id, true, "Self acceptance"),
          ).rejects.toMatchObject({ statusCode: 403 });
          await f.store.reviewTaskAssignment(
            commitment.taskId,
            f.ownerB.id,
            true,
            "Owner accepts integrated evidence",
          );
          // Finishing the founding Objective does not remove the shared Team.
          await f.store.updateObjectiveStatus(f.a.id, {
            expectedRevision: 1,
            status: "completed",
            completionSummary: "Founding outcome finished",
          });
          const continuing = await f.store.admitTaskAssignment(f.make(f.b.id));
          expect(
            (
              await f.other.claimTaskAssignment({
                taskId: continuing.taskId,
                leaseOwner: "continuing",
              })
            )?.status,
          ).toBe("running");
          await expect(
            f.store.updateTeam(f.team.id, { expectedRevision: 2, objectiveIds: [] }),
          ).rejects.toMatchObject({ statusCode: 409 });
        } finally {
          await f.cleanup();
        }
      });

      it("enforces a shared Team's own capacity across Objectives but not its children's work", async () => {
        const f = await fixture();
        try {
          await f.store.updateTeam(f.team.id, { expectedRevision: 1, objectiveIds: [f.b.id] });
          const children = await Promise.all(
            [f.a, f.b].map((objective) =>
              f.store.createTeam({
                id: `payments-${objective.id}`,
                objectiveId: objective.id,
                name: "Payments implementation",
                parentTeamId: f.team.id,
                leadTagId: f.lead.id,
                memberTagIds: [f.implementer.id],
                maxConcurrency: 1,
              }),
            ),
          );
          const tasks = await Promise.all(
            children.map((team) =>
              f.store.admitTaskAssignment(f.make(team.objectiveId, { teamId: team.id })),
            ),
          );
          const claims = await Promise.all(
            tasks.map((task, index) =>
              (index ? f.other : f.store).claimTaskAssignment({
                taskId: task.taskId,
                leaseOwner: `child-${index}`,
              }),
            ),
          );
          // Child Teams' work never fills the shared parent's limit of 1.
          expect(claims.filter(Boolean)).toHaveLength(2);
          const shared = await Promise.all(
            [f.a, f.b].map((objective) => f.store.admitTaskAssignment(f.make(objective.id))),
          );
          const sharedClaims = await Promise.all(
            shared.map((task, index) =>
              (index ? f.other : f.store).claimTaskAssignment({
                taskId: task.taskId,
                leaseOwner: `shared-${index}`,
              }),
            ),
          );
          // The shared Team's own work counts across both linked Objectives.
          expect(sharedClaims.filter(Boolean)).toHaveLength(1);
          await expect(
            f.store.updateTeam(f.team.id, { expectedRevision: 2, objectiveIds: [] }),
          ).rejects.toMatchObject({ statusCode: 403 });
        } finally {
          await f.cleanup();
        }
      });

      it("routes a stable Team mailbox through leadership changes without granting work authority", async () => {
        const f = await fixture();
        try {
          await f.store.updateTeam(f.team.id, { expectedRevision: 1, objectiveIds: [f.b.id] });
          await f.store.setTagMessagingGrant({
            senderTagId: f.ownerB.id,
            recipientTagId: f.lead.id,
            messageTypes: ["delegation.requested"],
          });
          const controller = new ObjectiveController(f.store, undefined);
          const message = {
            objectiveId: f.b.id,
            recipientTeamId: f.team.id,
            type: "delegation.requested",
            body: { request: "Provide refunds", evidence: "contract:v1" },
            idempotencyKey: "refund-request",
          };
          const sent = (await controller.commandAsAdministrator("send_message", message)) as {
            message: { id: string };
          };
          expect(await f.store.listTaskAssignments(f.b.id)).toEqual([]);
          await expect(
            f.store.updateTeam(f.team.id, { expectedRevision: 2, objectiveIds: [] }),
          ).rejects.toMatchObject({ statusCode: 409 });
          const next = await f.store.createTag({ name: "Replacement Payments lead" });
          await f.store.updateTeam(f.team.id, { expectedRevision: 2, leadTagId: next.id });
          const replay = (await controller.commandAsAdministrator("send_message", message)) as {
            message: { id: string; recipientTagId: string; recipientTeamId: string };
            duplicate: boolean;
          };
          expect(replay).toMatchObject({
            duplicate: true,
            message: { id: sent.message.id, recipientTagId: next.id, recipientTeamId: f.team.id },
          });
          expect(await f.store.listTaskAssignments(f.b.id)).toEqual([]);
          // A new send still requires a grant to the new lead.
          await expect(
            controller.commandAsAdministrator("send_message", {
              ...message,
              idempotencyKey: "new",
            }),
          ).rejects.toMatchObject({ statusCode: 403 });
          await expect(
            controller.commandAsAdministrator("send_message", {
              ...message,
              body: { request: "Different" },
            }),
          ).rejects.toMatchObject({ statusCode: 409 });
          await expect(
            f.store.updateTeam(f.team.id, { expectedRevision: 3, objectiveIds: [] }, f.ownerB.id),
          ).rejects.toMatchObject({ statusCode: 404 });
        } finally {
          await f.cleanup();
        }
      });
    },
  );
}
