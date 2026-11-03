import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { TagMailboxService } from "../control-plane/src/mailbox.js";
import type { AdmitTaskAssignmentInput } from "../core/src/index.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} operator questions across Objective actions`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-question-actions-"));
        const isolated =
          dialect === "postgresql" && postgres
            ? await createIsolatedPostgresDatabase(postgres)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(async () => {
          await store.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        });
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Ship the result",
          budgetLimitMinor: 100,
        });
        const team = await store.createTeam({
          id: `${objective.id}:leadership`,
          objectiveId: objective.id,
          name: "Leadership",
          leadTagId: owner.id,
          memberTagIds: [owner.id],
          maxConcurrency: null,
        });
        const taskId = randomUUID();
        const assignment: AdmitTaskAssignmentInput = {
          taskId,
          objectiveId: objective.id,
          teamId: team.id,
          requestedByTagId: owner.id,
          assignedTagId: owner.id,
          instruction: "Ship",
          acceptanceCriteria: ["Done"],
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
        };
        await store.admitTaskAssignment(assignment);
        const { message } = await store.enqueueObjectiveMessage({
          objectiveId: objective.id,
          senderTagId: owner.id,
          sourceTaskId: taskId,
          type: "message",
          body: { message: "Which format?" },
          idempotencyKey: "question",
        });
        async function expectPending() {
          expect(
            (
              await store.listObjectiveMessages({ objectiveId: objective.id, pendingOnly: true })
            ).map((item) => item.id),
          ).toEqual([message.id]);
          expect(await store.getObjectiveMessage(message.id)).toMatchObject({
            status: "pending",
            replyMessageId: null,
            resolvedAt: null,
          });
        }
        return { store, owner, objective, taskId, message, expectPending };
      }

      it("keeps a question pending when the deadline changes", async () => {
        const f = await fixture();
        await f.store.updateObjectiveStatus(f.objective.id, {
          expectedRevision: f.objective.revision,
          deadline: "2099-01-01T00:00:00.000Z",
        });
        await f.expectPending();
      });

      it("keeps a question pending when the budget increases", async () => {
        const f = await fixture();
        await f.store.updateObjectiveStatus(f.objective.id, {
          expectedRevision: f.objective.revision,
          budgetLimitMinor: 200,
        });
        await f.expectPending();
      });

      it("keeps a question pending when paused", async () => {
        const f = await fixture();
        await f.store.pauseObjective(f.objective.id, { operatorId: "operator" });
        await f.expectPending();
      });

      it("keeps a question pending when resumed", async () => {
        const f = await fixture();
        await f.store.pauseObjective(f.objective.id, { operatorId: "operator" });
        await f.store.resumeObjective(f.objective.id, { operatorId: "operator" });
        await f.expectPending();
      });

      it("refuses owner and operator completion with the pending question listed", async () => {
        const f = await fixture();
        await f.store.updateTaskAssignment(
          f.taskId,
          { expectedStatus: "queued", status: "cancelled" },
          f.owner.id,
          { administrator: true },
        );
        const ready = await f.store.updateObjectiveStatus(f.objective.id, {
          expectedRevision: f.objective.revision,
          status: "ready_for_review",
          completionSummary: "Ready",
        });
        for (const actor of [f.owner.id, undefined]) {
          await expect(
            f.store.updateObjectiveStatus(
              f.objective.id,
              {
                expectedRevision: ready.revision,
                status: "completed",
                completionSummary: "Approved",
              },
              actor,
              undefined,
              { operatorId: actor ? undefined : "operator" },
            ),
          ).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining(f.message.id),
          });
          expect((await f.store.getObjective(f.objective.id)).status).toBe("ready_for_review");
        }
        await f.store.sendOperatorObjectiveMessage({
          objectiveId: f.objective.id,
          message: "Markdown",
          inReplyTo: f.message.id,
          idempotencyKey: "answer-before-approval",
          operatorId: "operator",
        });
        const delivery = await f.store.claimTagMessage({
          tagId: f.owner.id,
          credentialId: "test-owner",
          now: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        if (!delivery) throw new Error("Expected operator reply delivery");
        await f.store.settleTagMessage({
          tagId: f.owner.id,
          credentialId: "test-owner",
          messageId: delivery.message.id,
          leaseToken: delivery.leaseToken,
          now: new Date().toISOString(),
          status: "processed",
        });
        const current = await f.store.getObjective(f.objective.id);
        await f.store.updateObjectiveStatus(f.objective.id, {
          expectedRevision: current.revision,
          status: "completed",
          completionSummary: "Approved",
        });
        expect((await f.store.getObjective(f.objective.id)).status).toBe("completed");
      });

      it("lists every pending question with its time and first line", async () => {
        const f = await fixture();
        const second = (
          await f.store.enqueueObjectiveMessage({
            objectiveId: f.objective.id,
            senderTagId: f.owner.id,
            sourceTaskId: f.taskId,
            type: "message",
            body: { message: "Which deadline?\nMore context" },
            idempotencyKey: "second-question",
          })
        ).message;
        await f.store.enqueueObjectiveMessage({
          objectiveId: f.objective.id,
          senderTagId: f.owner.id,
          sourceTaskId: f.taskId,
          type: "progress.updated",
          needsReply: false,
          body: { message: "Still working" },
          idempotencyKey: "progress-report",
        });
        const error = await f.store
          .updateObjectiveStatus(f.objective.id, {
            expectedRevision: f.objective.revision,
            status: "completed",
            completionSummary: "Done",
          })
          .catch((cause: unknown) => cause);
        expect(error).toMatchObject({ statusCode: 409 });
        const message = String((error as Error).message);
        expect(message).toContain(`${f.message.id} (asked ${f.message.createdAt}): Which format?`);
        expect(message).toContain(`${second.id} (asked ${second.createdAt}): Which deadline?`);
        expect(message).toContain(
          `supertag message objective ${f.objective.id} --reply-to MESSAGE_ID TEXT`,
        );
        expect(message).not.toContain("More context");
        expect(message).not.toContain("Still working");
      });

      it("returns the same refusal to the authenticated owner", async () => {
        const f = await fixture();
        const service = new TagMailboxService(f.store);
        const credential = await service.issueCredential(f.owner.id);
        const update = {
          expectedRevision: f.objective.revision,
          status: "completed" as const,
          completionSummary: "Done",
        };
        const storeError = await f.store
          .updateObjectiveStatus(f.objective.id, update, f.owner.id)
          .catch((cause: unknown) => cause);
        await expect(
          service.updateObjectiveStatus(credential.token, f.objective.id, update),
        ).rejects.toMatchObject({
          statusCode: 409,
          message: (storeError as Error).message,
        });
      });

      it("answers only the question named by inReplyTo", async () => {
        const f = await fixture();
        await f.store.sendOperatorObjectiveMessage({
          objectiveId: f.objective.id,
          message: "General direction",
          idempotencyKey: "unmarked",
          operatorId: "operator",
        });
        await f.expectPending();
        await f.store.sendOperatorObjectiveMessage({
          objectiveId: f.objective.id,
          message: "Use Markdown",
          inReplyTo: f.message.id,
          idempotencyKey: "answer",
          operatorId: "operator",
        });
        expect(
          await f.store.listObjectiveMessages({ objectiveId: f.objective.id, pendingOnly: true }),
        ).toEqual([]);
        expect(await f.store.getObjectiveMessage(f.message.id)).toMatchObject({
          status: "replied",
          replyMessageId: expect.any(String),
        });
      });

      it("lets the owner withdraw a pending question and complete afterward", async () => {
        const f = await fixture();
        const result = await f.store.enqueueObjectiveMessage({
          objectiveId: f.objective.id,
          senderTagId: f.owner.id,
          sourceTaskId: f.taskId,
          type: "message",
          body: { message: "No longer needed" },
          idempotencyKey: "withdraw-question",
          inReplyTo: f.message.id,
        });
        expect(result.message).toMatchObject({
          id: f.message.id,
          status: "resolved",
          resolutionReason: "Withdrawn by owner: No longer needed",
        });
        expect(await f.store.listObjectiveMessages({ objectiveId: f.objective.id })).toEqual([
          expect.objectContaining({
            id: f.message.id,
            status: "resolved",
            resolutionReason: "Withdrawn by owner: No longer needed",
          }),
        ]);
        expect(
          await f.store.listObjectiveMessages({ objectiveId: f.objective.id, pendingOnly: true }),
        ).toEqual([]);
        await f.store.updateTaskAssignment(
          f.taskId,
          { expectedStatus: "queued", status: "cancelled" },
          f.owner.id,
          { administrator: true },
        );
        await f.store.updateObjectiveStatus(f.objective.id, {
          expectedRevision: f.objective.revision,
          status: "completed",
          completionSummary: "Done",
        });
        expect((await f.store.getObjective(f.objective.id)).status).toBe("completed");
        await f.store.sendOperatorObjectiveMessage({
          objectiveId: f.objective.id,
          message: "Acknowledged",
          inReplyTo: f.message.id,
          idempotencyKey: "reply-after-withdraw",
          operatorId: "operator",
        });
        expect(await f.store.getObjectiveMessage(f.message.id)).toMatchObject({
          status: "replied",
          resolutionReason: "Withdrawn by owner: No longer needed",
          replyMessageId: expect.any(String),
        });
        expect((await f.store.getObjective(f.objective.id)).status).toBe("completed");
      });

      it("refuses withdrawal by another Tag, without a reason, or after resolution", async () => {
        const f = await fixture();
        const other = await f.store.createTag({ name: `other-${randomUUID()}` });
        const send = (senderTagId: string, message: string) =>
          f.store.enqueueObjectiveMessage({
            objectiveId: f.objective.id,
            senderTagId,
            sourceTaskId: f.taskId,
            type: "message",
            body: { message },
            idempotencyKey: randomUUID(),
            inReplyTo: f.message.id,
          });
        await expect(send(other.id, "No longer needed")).rejects.toMatchObject({ statusCode: 403 });
        await expect(send(f.owner.id, " ")).rejects.toMatchObject({ statusCode: 400 });
        await send(f.owner.id, "No longer needed");
        await expect(send(f.owner.id, "Again")).rejects.toMatchObject({
          statusCode: 409,
          message: "Objective question is no longer pending",
        });
      });
    },
  );
}
