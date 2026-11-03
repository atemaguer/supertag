import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} operator inbox when an Objective closes`,
    () => {
      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "terminal-inbox-"));
        const isolated =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(postgres as string)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        const owner = await store.createTag({ name: randomUUID() });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Repair the service",
          budgetLimitMinor: 1000,
        });
        const team = await store.createTeam({
          id: `${objective.id}:leadership`,
          objectiveId: objective.id,
          name: "Leadership",
          leadTagId: owner.id,
          memberTagIds: [],
          maxConcurrency: 1,
        });
        const at = new Date().toISOString();
        const root = await store.admitTaskAssignment({
          taskId: `${objective.id}:start`,
          objectiveId: objective.id,
          teamId: team.id,
          requestedByTagId: owner.id,
          assignedTagId: owner.id,
          instruction: "Repair the service",
          acceptanceCriteria: ["Safe"],
          execution: {},
          startObjectiveExecution: true,
          contextPlan: emptyTagContextPlan(at),
          workspacePlan: { version: 1, status: "none" },
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
        const ask = await store.enqueueObjectiveMessage({
          objectiveId: objective.id,
          senderTagId: owner.id,
          sourceTaskId: root.taskId,
          type: "message",
          body: { message: "Raise the budget to 2000?" },
          idempotencyKey: "budget-question",
        });
        const approval = await store.createApprovalRequest({
          objectiveId: objective.id,
          taskId: root.taskId,
          requestingTagId: owner.id,
          kind: "plan",
          actions: [{ target: "runtime", action: "deploy" }],
          summary: "Deploy the repair",
          ruleSources: ["release"],
          approvers: [],
        });
        return {
          store,
          owner,
          objective,
          root,
          ask: ask.message,
          approval,
          controller: new ObjectiveController(store, undefined),
          async close() {
            await store.disconnect();
            await isolated?.cleanup();
            await rm(directory, { recursive: true, force: true });
          },
        };
      }

      it("resolves questions and expires approvals when the operator cancels", async () => {
        const f = await fixture();
        try {
          const before = await f.controller.readCoordinationInbox({ objectiveId: f.objective.id });
          expect(before.items.map((item) => item.kind).toSorted()).toEqual([
            "approval",
            "operator_message",
          ]);

          await f.store.cancelObjective(
            f.objective.id,
            { reason: "No longer needed" },
            { operatorId: "test-operator" },
          );

          const after = await f.controller.readCoordinationInbox({ objectiveId: f.objective.id });
          expect(after.items).toEqual([]);
          const [message] = await f.store.listObjectiveMessages({ objectiveId: f.objective.id });
          expect(message).toMatchObject({
            id: f.ask.id,
            status: "resolved",
            resolutionReason: "Objective cancelled",
            replyMessageId: null,
            resolvedAt: expect.any(String),
          });
          expect(
            (
              await f.store.listObjectiveMessages({
                objectiveId: f.objective.id,
                pendingOnly: true,
              })
            ).map((item) => item.id),
          ).toEqual([]);
          const [request] = await f.store.listApprovalRequests({ objectiveId: f.objective.id });
          expect(request).toMatchObject({
            id: f.approval.id,
            status: "expired",
            reason: "Objective cancelled",
          });
          // A linked answer remains possible without reopening the Objective.
          await f.store.sendOperatorObjectiveMessage({
            objectiveId: f.objective.id,
            message: "Too late, but yes.",
            inReplyTo: f.ask.id,
            idempotencyKey: "late-reply",
            operatorId: "test-operator",
          });
          expect(await f.store.getObjectiveMessage(f.ask.id)).toMatchObject({ status: "replied" });
          expect((await f.store.getObjective(f.objective.id)).status).toBe("cancelled");
        } finally {
          await f.close();
        }
      });

      it("refuses completion until questions are answered and then expires approvals", async () => {
        const f = await fixture();
        try {
          await f.store.updateTaskAssignment(
            f.root.taskId,
            { expectedStatus: "queued", status: "cancelled" },
            f.owner.id,
          );
          const current = await f.store.getObjective(f.objective.id);
          await expect(
            f.store.updateObjectiveStatus(f.objective.id, {
              expectedRevision: current.revision,
              status: "completed",
              completionSummary: "Repaired.",
            }),
          ).rejects.toThrow(f.ask.id);

          const pending = await f.store.getObjectiveMessage(f.ask.id);
          expect(pending).toMatchObject({ status: "pending", resolutionReason: null });
          expect(
            (await f.store.listApprovalRequests({ objectiveId: f.objective.id }))[0],
          ).toMatchObject({ status: "pending" });
          await f.store.sendOperatorObjectiveMessage({
            objectiveId: f.objective.id,
            message: "Yes",
            inReplyTo: f.ask.id,
            idempotencyKey: "answer-before-completion",
            operatorId: "test-operator",
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
          const refreshed = await f.store.getObjective(f.objective.id);
          await f.store.updateObjectiveStatus(f.objective.id, {
            expectedRevision: refreshed.revision,
            status: "completed",
            completionSummary: "Repaired.",
          });

          const after = await f.controller.readCoordinationInbox({ objectiveId: f.objective.id });
          expect(after.items).toEqual([]);
          const [message] = await f.store.listObjectiveMessages({ objectiveId: f.objective.id });
          expect(message).toMatchObject({
            status: "replied",
            resolutionReason: null,
          });
          const [request] = await f.store.listApprovalRequests({ objectiveId: f.objective.id });
          expect(request).toMatchObject({ status: "expired", reason: "Objective completed" });
        } finally {
          await f.close();
        }
      });

      it("leaves answered questions and decided approvals unchanged", async () => {
        const f = await fixture();
        try {
          await f.store.replyToObjectiveMessage({
            messageId: f.ask.id,
            objectiveId: f.objective.id,
            recipientTagId: f.owner.id,
            body: { message: "Yes" },
            idempotencyKey: "reply",
            operatorId: "test-operator",
          });
          await f.store.decideApprovalRequest({
            id: f.approval.id,
            decision: "deny",
            decidedBy: "test-operator",
            decidedByKind: "operator",
            reason: "Not now",
          });
          await f.store.cancelObjective(f.objective.id, {}, { operatorId: "test-operator" });
          const [message] = await f.store.listObjectiveMessages({ objectiveId: f.objective.id });
          expect(message).toMatchObject({ status: "replied", resolvedAt: null });
          const [request] = await f.store.listApprovalRequests({ objectiveId: f.objective.id });
          expect(request).toMatchObject({ status: "denied", reason: "Not now" });
        } finally {
          await f.close();
        }
      });
    },
  );
