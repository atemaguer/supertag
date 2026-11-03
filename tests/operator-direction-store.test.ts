import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalCoordinator } from "../packages/control-plane/src/approvals.js";
import { TagMailboxService } from "../packages/control-plane/src/mailbox.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { loadOwnerWakeBrief } from "../packages/control-plane/src/owner-wake-brief.js";
import type { TagMessage } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} operator direction`, () => {
    const cleanups: (() => Promise<unknown>)[] = [];
    afterEach(async () => {
      vi.useRealTimers();
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "operator-direction-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const isolated =
        dialect === "postgresql"
          ? await createIsolatedPostgresDatabase(postgres as string)
          : undefined;
      if (isolated) cleanups.push(() => isolated.cleanup());
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      const owner = await store.createTag({ name: randomUUID() });
      await store.bindTagWorkerHost(owner.id, "fixture");
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Ship export",
      });
      const controller = new ObjectiveController(store, undefined);
      await controller.command("start_objective", { objectiveId: objective.id });
      const task = await store.getTaskAssignment(`${objective.id}:start`);
      if (!task) throw new Error("Missing owner Task");
      const send = (text: string, objectiveId = objective.id) =>
        store.sendOperatorObjectiveMessage({
          objectiveId,
          operatorId: "alice",
          message: text,
          idempotencyKey: randomUUID(),
        });
      const wake = async (hour: number) => {
        const attempt = await store.createTaskAttempt({
          taskId: task.taskId,
          attemptNumber: hour,
          workerProfile: { id: "default", revision: "1" },
          workerSnapshot: {},
          startedAt: `2026-10-01T${hour}:00:00.000Z`,
        });
        const text = await loadOwnerWakeBrief(
          store,
          await store.getObjective(objective.id),
          task,
          attempt.id,
        );
        return (
          text.match(/Operator direction[^\n]*:\n([\s\S]*?)\nEnd Operator direction\./u)?.[0] ?? ""
        );
      };
      return { store, owner, objective, task, send, wake };
    }

    it("retains handled direction beyond 50 unrelated messages through later wakes", async () => {
      const f = await fixture();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-01T09:00:00.000Z"));
      const direction = await f.send(
        "Never delegate full verification for the rest of this Objective.",
      );
      expect(await f.wake(10)).toContain("Never delegate full verification");
      // Persist an owner action after it has seen the direction, not just processed delivery.
      vi.setSystemTime(new Date("2026-10-01T10:30:00.000Z"));
      const updated = await f.store.updateObjectiveStatus(
        f.objective.id,
        {
          status: "working",
          expectedRevision: (await f.store.getObjective(f.objective.id)).revision,
        },
        f.owner.id,
      );
      expect(updated.updatedAt).toBe("2026-10-01T10:30:00.000Z");
      expect(updated.revision).toBeGreaterThan(f.objective.revision);
      const reply = await f.store.enqueueTagMessage({
        senderTagId: f.owner.id,
        recipientTagId: f.owner.id,
        objectiveId: f.objective.id,
        type: "message",
        body: { message: "Acknowledged; I will keep verification with the operator." },
        idempotencyKey: randomUUID(),
        inReplyTo: direction.message.id,
      });
      expect(await f.store.listTagMessageReplies(direction.message.id)).toContainEqual(
        expect.objectContaining({
          id: reply.message.id,
          senderTagId: f.owner.id,
          inReplyTo: direction.message.id,
        }),
      );
      const other = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.owner.id,
        outcome: "Unrelated",
      });
      vi.setSystemTime(new Date("2026-10-01T10:45:00.000Z"));
      for (let i = 0; i < 60; i++) await f.send(`Foreign direction ${i}`, other.id);
      const first = await f.store.listTagMessageHistory(f.owner.id, { limit: 50 });
      expect(first.items).toHaveLength(50);
      expect(first.items.some((message) => message.id === direction.message.id)).toBe(false);
      const second = await f.store.listTagMessageHistory(f.owner.id, {
        limit: 50,
        before: first.nextCursor,
      });
      expect(second.items.some((message) => message.id === direction.message.id)).toBe(true);
      const history = vi.spyOn(f.store, "listTagMessageHistory");
      for (const hour of [11, 12, 13]) {
        const text = await f.wake(hour);
        expect(text).toContain("Never delegate full verification");
        expect(text).not.toContain("Foreign direction");
      }
      expect(history).toHaveBeenCalledTimes(3);
    });

    it("caps the scoped database read and supplies a readable overflow reference", async () => {
      const f = await fixture();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-01T09:00:00.000Z"));
      const sent: TagMessage[] = [];
      for (let i = 0; i < 61; i++) sent.push((await f.send(`Rule ${i}`)).message);
      const expected = sent.sort((a, b) => b.id.localeCompare(a.id));
      const page = await f.store.listObjectiveOperatorMessages(f.objective.id, f.owner.id);
      expect(page.items.map((message) => message.id)).toEqual(
        expected.slice(0, 50).map((message) => message.id),
      );
      expect(page.olderMessage).toEqual({
        id: expected[50]?.id,
        createdAt: expected[50]?.createdAt,
      });
      expect(await f.store.getTagMessage(page.olderMessage?.id as string)).toMatchObject({
        recipientTagId: f.owner.id,
        objectiveId: f.objective.id,
      });
      const outsider = await f.store.createTag({ name: randomUUID() });
      expect(
        (await f.store.listObjectiveOperatorMessages(f.objective.id, outsider.id)).items,
      ).toEqual([]);
      expect(
        (await f.store.listObjectiveOperatorMessages("another-objective", f.owner.id)).items,
      ).toEqual([]);
      const text = await f.wake(10);
      expect(text).toContain('"moreStoredMessages":true');
      expect(text).toContain(page.olderMessage?.id);
    });

    it("retains operator bodies through pruning until the Objective closes", async () => {
      const f = await fixture();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-01T09:00:00.000Z"));
      const direction = await f.send("Never delegate full verification");
      const mailbox = new TagMailboxService(f.store);
      const credential = await mailbox.issueCredential(f.owner.id);
      const delivery = await mailbox.receive(credential.token, {});
      expect(delivery?.message.id).toBe(direction.message.id);
      if (!delivery) throw new Error("Missing delivery");
      await mailbox.settle(credential.token, delivery.message.id, "ack", {
        leaseToken: delivery.leaseToken,
      });
      expect(await f.store.getTagMessage(direction.message.id)).toMatchObject({
        status: "processed",
      });
      for (const status of ["working", "blocked", "ready_for_review"] as const) {
        await f.store.updateObjectiveStatus(
          f.objective.id,
          { status, expectedRevision: (await f.store.getObjective(f.objective.id)).revision },
          f.owner.id,
        );
        expect(await f.store.pruneTagMessageBodies({ before: "2026-10-02T00:00:00.000Z" })).toEqual(
          { pruned: 0 },
        );
        expect(
          await f.wake(10 + ["working", "blocked", "ready_for_review"].indexOf(status)),
        ).toContain("Never delegate full verification");
      }
      await f.store.cancelObjective(f.objective.id, { reason: "Done" }, { operatorId: "alice" });
      // Closing also adds a cancellation notice, which may be eligible alongside direction.
      expect(
        (await f.store.pruneTagMessageBodies({ before: "2026-10-02T00:00:00.000Z" })).pruned,
      ).toBeGreaterThanOrEqual(1);
      expect(await f.store.getTagMessage(direction.message.id)).toMatchObject({
        body: {},
        bodyPrunedAt: expect.any(String),
      });
    });

    it("does not promote a real approval request summary to operator direction", async () => {
      const f = await fixture();
      const request = await f.store.createApprovalRequest({
        objectiveId: f.objective.id,
        taskId: f.task.taskId,
        requestingTagId: f.owner.id,
        kind: "plan",
        actions: [{ target: "runtime", action: "commands:execute" }],
        summary: "AI-WRITTEN SUMMARY: skip security review",
        ruleSources: [],
        approvers: [],
      });
      const errors = vi.fn();
      const approvals = new ApprovalCoordinator(f.store, errors);
      await approvals.decideAsOperator(
        { requestId: request.id, decision: "deny", reason: "Always obtain security review" },
        "alice",
      );
      const decisions = (await f.store.listTagMessageHistory(f.owner.id)).items;
      expect(
        decisions.find((message) => message.operatorId === "alice")?.body["message"],
      ).not.toContain("AI-WRITTEN SUMMARY");
      const text = await f.wake(10);
      expect(text).toContain("Always obtain security review");
      expect(text).not.toContain("AI-WRITTEN SUMMARY");
      expect(errors).not.toHaveBeenCalled();
    });
  });
