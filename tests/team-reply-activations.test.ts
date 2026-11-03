import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { ownerActivation, type TaskAssignment } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { TEAM_REPLY_COALESCE_WINDOW_MS } from "../packages/store/src/team-reply-triggers.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Team reply activations`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        vi.useRealTimers();
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      async function fixture(budgetLimitMinor = 100) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-replies-"));
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
        const owner = await store.createTag({ name: randomUUID() });
        const sender = await store.createTag({ name: randomUUID() });
        const recipient = await store.createTag({ name: randomUUID() });
        const outsider = await store.createTag({ name: randomUUID() });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Answer questions",
          budgetLimitMinor,
          budgetCurrency: "USD",
          runtimeActions: [],
        });
        const team = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Build",
          leadTagId: owner.id,
          memberTagIds: [sender.id, recipient.id],
        });
        await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Other",
          leadTagId: outsider.id,
          memberTagIds: [],
        });
        await store.createTeam({
          id: `${objective.id}:leadership`,
          objectiveId: objective.id,
          name: "Leadership",
          leadTagId: owner.id,
          memberTagIds: [],
        });
        for (const tag of [owner, sender, recipient, outsider])
          await store.bindTagWorkerHost(tag.id, "reply-host");
        const controller = new ObjectiveController(store, undefined);
        const assign = async (tagId: string, extra: Record<string, unknown> = {}) =>
          controller.command("assign_task", {
            objectiveId: objective.id,
            taskId: randomUUID(),
            teamId: team.id,
            assignedTagId: tagId,
            instruction: "Work",
            acceptanceCriteria: ["Done"],
            ...extra,
          }) as Promise<TaskAssignment>;
        // Starting execution is a trusted store operation, independent of any teammate's text.
        const start = await store.admitTaskAssignment({
          taskId: randomUUID(),
          objectiveId: objective.id,
          teamId: team.id,
          requestedByTagId: owner.id,
          assignedTagId: owner.id,
          startObjectiveExecution: true,
          instruction: "Start",
          acceptanceCriteria: ["Started"],
          execution: {},
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
        });
        await store.cancelTaskAssignment(start.taskId, owner.id);
        const post = (extra: Record<string, unknown> = {}) =>
          store.postWorkstream({
            workstreamId: team.id,
            authorTagId: sender.id,
            type: "question",
            to: [recipient.id],
            body: "Which schema should I use?",
            idempotencyKey: randomUUID(),
            ...extra,
          });
        const message = (extra: Record<string, unknown> = {}) =>
          store.enqueueTagMessage({
            senderTagId: sender.id,
            recipientTagId: recipient.id,
            objectiveId: objective.id,
            type: "question",
            body: { message: "Which schema?" },
            idempotencyKey: randomUUID(),
            ...extra,
          });
        vi.useFakeTimers({ toFake: ["Date"] });
        const admit = () => {
          // This helper is for admission after a window. Boundary behavior has its own
          // exact-time tests, so unrelated assertions need not depend on equality at cutoff.
          vi.setSystemTime(Date.now() + TEAM_REPLY_COALESCE_WINDOW_MS + 1);
          return store.admitMailboxTaskAssignments();
        };
        return {
          admit,
          url,
          store,
          controller,
          owner,
          sender,
          recipient,
          outsider,
          objective,
          team,
          assign,
          post,
          message,
        };
      }

      it("coalesces a mixed burst at a fixed window boundary", async () => {
        const f = await fixture(1000);
        vi.useFakeTimers({ toFake: ["Date"] });
        const started = Date.now();
        const first = await f.post();
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        vi.setSystemTime(started + 1_000);
        const second = (await f.message()).message;
        vi.setSystemTime(started + 1_999);
        const third = await f.post({ type: "blocker", body: "Cannot choose a schema" });
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        vi.setSystemTime(started + 2_000);
        const replies = await f.store.admitMailboxTaskAssignments();
        expect(replies).toHaveLength(1);
        const reply = replies[0];
        if (!reply) throw new Error("Missing reply");
        const execution = await f.store.findTaskById(reply.taskId);
        expect(execution?.trigger).toMatchObject({
          kind: "team_reply",
          sources: [
            { itemKind: "post", itemId: first.id },
            { itemKind: "direct_message", itemId: second.id },
            { itemKind: "post", itemId: third.id },
          ],
        });
        expect((await f.store.getObjective(f.objective.id)).reservedMinor).toBe(100);
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        const claimed = await f.store.claimTaskAssignment({
          taskId: reply.taskId,
          leaseOwner: "coalesce-test",
        });
        expect(claimed).toBeDefined();
        const digest = await f.store.deliverActivationDigest({
          tagId: f.recipient.id,
          objectiveId: f.objective.id,
        });
        expect(digest.items.map((item) => item.id).sort()).toEqual(
          [first.id, second.id, third.id].sort(),
        );
        // New arrivals during execution remain delivery-only even after this reply ends.
        const live = await f.post({ body: "One more detail" });
        const direct = (await f.message({ body: { message: "One more private detail" } })).message;
        await f.store.settleTaskAssignment({
          taskId: reply.taskId,
          leaseOwner: "coalesce-test",
          attemptCount: claimed?.attemptCount ?? 0,
          result: {},
        });
        vi.setSystemTime(started + 4_000);
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        const later = await f.store.deliverActivationDigest({
          tagId: f.recipient.id,
          objectiveId: f.objective.id,
        });
        expect(later.items.map((item) => item.id).sort()).toEqual([live.id, direct.id].sort());
      });

      it("opens a new window for a later post when the recipient is idle again", async () => {
        const f = await fixture(1000);
        vi.useFakeTimers({ toFake: ["Date"] });
        const started = Date.now();
        await f.post();
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        vi.setSystemTime(started + 2_000);
        const [first] = await f.store.admitMailboxTaskAssignments();
        if (!first) throw new Error("Missing reply");
        const claimed = await f.store.claimTaskAssignment({
          taskId: first.taskId,
          leaseOwner: "coalesce-test",
        });
        if (!claimed) throw new Error("Missing claim");
        await f.store.deliverActivationDigest({
          tagId: f.recipient.id,
          objectiveId: f.objective.id,
        });
        await f.store.settleTaskAssignment({
          taskId: first.taskId,
          leaseOwner: "coalesce-test",
          attemptCount: claimed.attemptCount,
          result: {},
        });
        vi.setSystemTime(started + 3_000);
        const next = await f.post({ body: "A separate question" });
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        vi.setSystemTime(started + 5_000);
        const [second] = await f.store.admitMailboxTaskAssignments();
        expect(second?.taskId).toBeDefined();
        expect(second?.taskId).not.toBe(first.taskId);
        expect((await f.store.findTaskById(second?.taskId ?? "missing"))?.trigger).toMatchObject({
          sources: [{ itemId: next.id }],
        });
      });

      it("coalesces concurrent posts and messages across connections and admission scans", async () => {
        const f = await fixture();
        const other = new DrizzleStore({ url: f.url });
        await other.connect();
        cleanups.push(() => other.disconnect());
        vi.useFakeTimers({ toFake: ["Date"] });
        const started = Date.now();
        const [first, second, direct] = await Promise.all([
          f.post(),
          other.postWorkstream({
            workstreamId: f.team.id,
            authorTagId: f.owner.id,
            type: "blocker",
            to: [f.recipient.id],
            body: "The schema blocks release",
            idempotencyKey: randomUUID(),
          }),
          f.message(),
        ]);
        vi.setSystemTime(started + 2_000);
        const results = await Promise.all([
          f.store.admitMailboxTaskAssignments(),
          other.admitMailboxTaskAssignments(),
        ]);
        expect(results.flat()).toHaveLength(1);
        const reply = results.flat()[0];
        if (!reply) throw new Error("Missing reply");
        const trigger = (await other.findTaskById(reply.taskId))?.trigger;
        expect(trigger).toMatchObject({
          kind: "team_reply",
          sources: expect.arrayContaining([
            expect.objectContaining({ itemId: first.id }),
            expect.objectContaining({ itemId: second.id }),
            expect.objectContaining({ itemId: direct.message.id }),
          ]),
        });
        expect((await other.getObjective(f.objective.id)).reservedMinor).toBe(100);
        const digest = await other.deliverActivationDigest({
          tagId: f.recipient.id,
          objectiveId: f.objective.id,
        });
        expect(digest.items.map((item) => item.id).sort()).toEqual(
          [first.id, second.id, direct.message.id].sort(),
        );
      });

      it("revalidates every source and keeps an authorized member's question", async () => {
        const f = await fixture();
        const removed = (await f.message()).message;
        const valid = await f.post({ authorTagId: f.owner.id, body: "An independent question" });
        const team = await f.store.getTeam(f.team.id);
        await f.store.updateTeam(team.id, {
          expectedRevision: team.revision,
          memberTagIds: [f.recipient.id],
        });
        const [reply] = await f.admit();
        if (!reply) throw new Error("Missing reply");
        expect((await f.store.findTaskById(reply.taskId))?.trigger).toMatchObject({
          sources: [{ itemId: valid.id }],
        });
        const digest = await f.store.deliverActivationDigest({
          tagId: f.recipient.id,
          objectiveId: f.objective.id,
        });
        expect(digest.items.map((item) => item.id)).toContain(valid.id);
        expect(digest.items.map((item) => item.id)).not.toContain(removed.id);
      });

      it("preserves the original window across budget retries and store restarts", async () => {
        const f = await fixture();
        const occupying = await f.assign(f.sender.id, { maxCostMinor: 100 });
        const started = Date.now();
        const first = await f.post();
        vi.setSystemTime(started + 1_000);
        const second = (await f.message()).message;
        vi.setSystemTime(started + 2_000);
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        // This later source belongs outside the original window, even if admission is delayed.
        vi.setSystemTime(started + 2_500);
        const later = await f.post({ body: "Outside the first window" });
        await f.store.cancelTaskAssignment(occupying.taskId, f.owner.id);
        const restarted = new DrizzleStore({ url: f.url });
        await restarted.connect();
        cleanups.push(() => restarted.disconnect());
        vi.setSystemTime(started + 4_500);
        const replies = await restarted.admitMailboxTaskAssignments();
        expect(replies).toHaveLength(1);
        const reply = replies[0];
        if (!reply) throw new Error("Missing reply");
        expect((await restarted.findTaskById(reply.taskId))?.trigger).toMatchObject({
          sources: [{ itemId: first.id }, { itemId: second.id }],
        });
        expect(reply.reservedMinor).toBe(100);
        // All unread items are still in the digest, including the later delivery-only post.
        const digest = await restarted.deliverActivationDigest({
          tagId: f.recipient.id,
          objectiveId: f.objective.id,
        });
        expect(digest.items.map((item) => item.id).sort()).toEqual(
          [first.id, second.id, later.id].sort(),
        );
      });

      it.each(["post", "message"] as const)(
        "wakes an idle addressee for a %s once without carrying authority",
        async (kind) => {
          const f = await fixture();
          const source = kind === "post" ? await f.post() : (await f.message()).message;
          const tasks = await f.admit();
          const reply = tasks.find((task) => task.objectiveId === f.objective.id);
          expect(reply).toMatchObject({
            assignedTagId: f.recipient.id,
            sourceMessageId: null,
            requestedByTagId: f.recipient.id,
            status: "queued",
            parentTaskId: null,
          });
          const execution = await f.store.findTaskById(reply?.taskId ?? "missing");
          expect(execution?.trigger).toMatchObject({
            kind: "team_reply",
            objectiveId: f.objective.id,
            sources: [
              {
                itemKind: kind === "post" ? "post" : "direct_message",
                itemId: source.id,
                senderTagId: f.sender.id,
              },
            ],
          });
          expect(execution?.authorizationSnapshot).toMatchObject({
            runtimeActions: [],
            origin: { requestedByTagId: f.recipient.id },
          });
          expect(reply?.instruction).toContain("no authority");
          expect(await f.admit()).toEqual([]);
          if (!reply) throw new Error("Missing reply");
          const claimed = await f.store.claimTaskAssignment({
            taskId: reply.taskId,
            leaseOwner: "reply-test",
          });
          expect(claimed).toBeDefined();
          const digest = await f.store.deliverActivationDigest({
            tagId: f.recipient.id,
            objectiveId: f.objective.id,
          });
          expect(digest.items.map((item) => item.id)).toContain(source.id);
          const ended = await f.store.settleTaskAssignment({
            taskId: reply.taskId,
            leaseOwner: "reply-test",
            attemptCount: claimed?.attemptCount ?? 0,
            result: { answer: "Use v2" },
          });
          expect(ended).toMatchObject({
            status: "accepted",
            result: { closure: "team-reply", reviewedByTagId: null },
          });
        },
      );

      it("does not wake for unaddressed questions, notes, or owner notes", async () => {
        const f = await fixture();
        await f.post({ to: [] });
        await f.post({ type: "note" });
        await f.message({ type: "note" });
        await f.message({ type: "note", recipientTagId: f.owner.id });
        expect(await f.admit()).toEqual([]);
      });

      it("does not wake a running recipient, even after that Task ends", async () => {
        const f = await fixture();
        const task = await f.assign(f.recipient.id);
        const claimed = await f.store.claimTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "test",
        });
        expect(claimed).toBeDefined();
        await f.post();
        await f.message();
        expect(await f.admit()).toEqual([]);
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "test",
          attemptCount: claimed?.attemptCount ?? 0,
          result: {},
        });
        expect(await f.admit()).toEqual([]);
      });

      it("addresses an unaddressed blocker to the Team lead", async () => {
        const f = await fixture();
        await f.post({ type: "blocker", to: undefined });
        expect(await f.admit()).toEqual([
          expect.objectContaining({ assignedTagId: f.owner.id, sourceMessageId: null }),
        ]);
      });

      it("delivers same-Team owner direct messages through the reply digest", async () => {
        const f = await fixture();
        const sent = await f.message({ recipientTagId: f.owner.id });
        const [reply] = await f.admit();
        expect(reply).toMatchObject({
          assignedTagId: f.owner.id,
          teamId: f.team.id,
          sourceMessageId: null,
        });
        const digest = await f.store.deliverActivationDigest({
          tagId: f.owner.id,
          objectiveId: f.objective.id,
        });
        expect(digest.items.map((item) => item.id)).toContain(sent.message.id);
        expect((await f.store.getTagMessage(sent.message.id))?.status).toBe("processed");
      });

      it.each(["before-admission", "before-claim"])(
        "rechecks the sender's Team membership %s",
        async (when) => {
          const f = await fixture();
          await f.post();
          const replies = when === "before-claim" ? await f.admit() : [];
          const team = await f.store.getTeam(f.team.id);
          await f.store.updateTeam(team.id, {
            expectedRevision: team.revision,
            memberTagIds: team.memberTagIds.filter((id) => id !== f.sender.id),
          });
          expect(await f.admit()).toEqual([]);
          if (when === "before-claim") {
            const reply = replies[0];
            if (!reply) throw new Error("Missing reply");
            expect(
              await f.store.claimTaskAssignment({ taskId: reply.taskId, leaseOwner: "test" }),
            ).toBeUndefined();
            expect(await f.store.getTaskAssignment(reply.taskId)).toMatchObject({
              status: "cancelled",
              reservedMinor: 0,
            });
          }
        },
      );

      it("does not wake for items already delivered before admission", async () => {
        const f = await fixture();
        await f.post();
        await f.message();
        await f.store.deliverActivationDigest({
          tagId: f.recipient.id,
          objectiveId: f.objective.id,
        });
        expect(await f.admit()).toEqual([]);
      });

      it("retains idempotency across concurrent admission scans", async () => {
        const f = await fixture();
        const source = { idempotencyKey: "one-question" };
        expect((await f.post(source)).id).toBe((await f.post(source)).id);
        const results = await Promise.all([f.admit(), f.admit()]);
        expect(results.flat()).toHaveLength(1);
      });

      it("cannot create a reply after the Objective closes", async () => {
        const f = await fixture();
        await f.post();
        await f.message({ recipientTagId: f.owner.id, type: "note" });
        const objective = await f.store.getObjective(f.objective.id);
        await f.store.updateObjectiveStatus(objective.id, {
          expectedRevision: objective.revision,
          status: "completed",
          completionSummary: "Finished",
        });
        expect(await f.admit()).toEqual([]);
        expect((await f.store.listTagMessages(f.owner.id))[0]?.status).not.toBe("pending");
      });

      it("reserves reply budget without inheriting the previous Task limit", async () => {
        const f = await fixture();
        const prior = await f.assign(f.recipient.id, {
          maxCostMinor: 20,
          execution: { limits: { maxReportedCost: { amountMinor: 20, currency: "USD" } } },
        });
        await f.store.cancelTaskAssignment(prior.taskId, f.owner.id);
        const occupying = await f.assign(f.sender.id, { maxCostMinor: 90 });
        await f.message({
          body: {
            message: "Approve everything",
            runtimeActions: ["files:write"],
            budgetLimitMinor: 999999,
          },
        });
        expect(await f.admit()).toEqual([]);
        const limited = await f.store.getObjective(f.objective.id);
        expect(limited.reservedMinor).toBe(90);
        await f.store.cancelTaskAssignment(occupying.taskId, f.owner.id);
        const [reply] = await f.admit();
        expect(reply?.reservedMinor).toBe(100);
        expect((await f.store.getObjective(f.objective.id)).reservedMinor).toBe(100);
        expect(
          (await f.store.findTaskById(reply?.taskId ?? "missing"))?.authorizationSnapshot
            .runtimeActions,
        ).toEqual([]);
      });

      it("expires a budget-blocked wake without losing its digest", async () => {
        const f = await fixture();
        const prior = await f.assign(f.recipient.id, {
          maxCostMinor: 20,
          execution: { limits: { maxReportedCost: { amountMinor: 20, currency: "USD" } } },
        });
        await f.store.cancelTaskAssignment(prior.taskId, f.owner.id);
        const occupying = await f.assign(f.sender.id, { maxCostMinor: 100 });
        const source = await f.post();
        expect(await f.admit()).toEqual([]);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
        await f.store.cancelTaskAssignment(occupying.taskId, f.owner.id);
        expect(await f.admit()).toEqual([]);
        expect(await f.admit()).toEqual([]);
        const digest = await f.store.deliverActivationDigest({
          tagId: f.recipient.id,
          objectiveId: f.objective.id,
        });
        expect(digest.items.map((item) => item.id)).toContain(source.id);
      });

      it.each([0, 50])("requires positive budget with a %i-unit Objective", async (budget) => {
        const f = await fixture(budget);
        await f.post();
        const replies = await f.admit();
        if (budget === 0) expect(replies).toEqual([]);
        else expect(replies).toEqual([expect.objectContaining({ reservedMinor: budget })]);
      });

      it("serializes ordinary work behind a running reply", async () => {
        const f = await fixture();
        await f.post();
        const [reply] = await f.admit();
        if (!reply) throw new Error("Missing reply");
        expect(
          await f.store.claimTaskAssignment({ taskId: reply.taskId, leaseOwner: "test" }),
        ).toBeDefined();
        const ordinary = await f.assign(f.recipient.id);
        expect(
          await f.store.claimTaskAssignment({ taskId: ordinary.taskId, leaseOwner: "test" }),
        ).toBeUndefined();
      });

      it.each(["post", "message"] as const)(
        "resumes a matching %s wait without an extra reply",
        async (kind) => {
          const f = await fixture();
          const assignment = await f.assign(f.recipient.id);
          const claimed = await f.store.claimTaskAssignment({
            taskId: assignment.taskId,
            leaseOwner: "test",
          });
          if (!claimed) throw new Error("Missing claim");
          await f.store.registerTaskAssignmentWait({
            taskId: claimed.taskId,
            leaseOwner: "test",
            attemptCount: claimed.attemptCount,
            ...(kind === "message"
              ? { mailbox: true }
              : { workstreamPosts: { workstreamId: f.team.id, afterSequence: 0 } }),
          });
          await f.store.settleTaskAssignment({
            taskId: claimed.taskId,
            leaseOwner: "test",
            attemptCount: claimed.attemptCount,
            result: {},
          });
          if (kind === "post") await f.post();
          else await f.message();
          expect(await f.admit()).toEqual([]);
          expect(await f.store.wakeWaitingTaskAssignments()).toEqual([
            expect.objectContaining({ taskId: claimed.taskId, status: "queued" }),
          ]);
        },
      );

      it("closes an owner reply without restarting it as Objective ownership work", async () => {
        const f = await fixture();
        await f.post({ to: [f.owner.id] });
        const [reply] = await f.admit();
        if (!reply) throw new Error("Missing reply");
        expect(reply.activationKind).toBe("team_reply");
        expect(ownerActivation(reply, f.owner.id)).toBe(false);
        const claimed = await f.store.claimTaskAssignment({
          taskId: reply.taskId,
          leaseOwner: "test",
        });
        if (!claimed) throw new Error("Missing claim");
        await f.store.settleTaskAssignment({
          taskId: reply.taskId,
          leaseOwner: "test",
          attemptCount: claimed.attemptCount,
          result: {},
        });
        expect(await f.store.listStalledObjectiveOwnerTasks()).toEqual([]);
      });

      it("does not charge failed replies against the owner's continuation limit", async () => {
        const f = await fixture(1000);
        const [bootstrap] = await f.store.listTaskAssignments(f.objective.id);
        if (!bootstrap) throw new Error("Missing bootstrap Task");
        // The bootstrap cancellation and a fast failure can share one millisecond.
        // Put the later Task first lexically to expose an ID-based tie break.
        vi.setSystemTime(new Date(bootstrap.updatedAt));
        const fail = async (taskId: string) => {
          const claimed = await f.store.claimTaskAssignment({ taskId, leaseOwner: "test" });
          if (!claimed) throw new Error("Missing claim");
          await f.store.settleTaskAssignment({
            taskId,
            leaseOwner: "test",
            attemptCount: claimed.attemptCount,
            failed: true,
            result: { error: "Harness returned an empty response" },
          });
        };
        const root = await f.assign(f.owner.id, { taskId: "0-root" });
        await fail(root.taskId);
        for (let index = 0; index < 4; index++) {
          // Distinct source Tasks test the owner's continuation limit independently of pair caps.
          const source = await f.assign(f.sender.id);
          await f.store.claimTaskAssignment({ taskId: source.taskId, leaseOwner: "test" });
          await f.message({ recipientTagId: f.owner.id, body: { message: `Question ${index}` } });
          const [reply] = await f.admit();
          if (!reply) throw new Error("Missing reply");
          await fail(reply.taskId);
          await f.store.cancelTaskAssignment(source.taskId, f.owner.id);
        }
        // One scheduler recovery pass, with no Worker or background timer started.
        f.controller["running"] = true;
        try {
          await f.controller["continueStalledObjectives"]();
        } finally {
          f.controller["running"] = false;
        }
        const tasks = await f.store.listTaskAssignments(f.objective.id);
        expect(tasks.filter((task) => task.status === "queued")).toEqual([
          expect.objectContaining({
            instruction: expect.stringContaining("Continue from durable state"),
          }),
        ]);
      }, 20_000);

      it("preserves cross-Team message Tasks", async () => {
        const f = await fixture();
        await f.store.setTagMessagingGrant({
          senderTagId: f.sender.id,
          recipientTagId: f.outsider.id,
          messageTypes: ["question"],
        });
        const sent = await f.message({ recipientTagId: f.outsider.id });
        expect(await f.admit()).toEqual([
          expect.objectContaining({
            taskId: `message:${sent.message.id}`,
            sourceMessageId: sent.message.id,
          }),
        ]);
      });
    },
  );
}
