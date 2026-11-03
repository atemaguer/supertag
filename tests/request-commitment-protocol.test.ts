import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import type { CommitmentViewEntry, TaskAssignment } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} request commitment protocol`,
    () => {
      it("requires an explicit Team acceptance and exposes request and priority state", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supertag-request-commitment-"));
        const isolated =
          dialect === "postgresql" && postgres
            ? await createIsolatedPostgresDatabase(postgres)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        const store = new DrizzleStore({ url });
        try {
          await migrateDatabase({ url });
          await store.connect();
          const requester = await store.createTag({ name: `requester-${randomUUID()}` });
          const oldLead = await store.createTag({ name: `old-lead-${randomUUID()}` });
          const lead = await store.createTag({ name: `lead-${randomUUID()}` });
          const worker = await store.createTag({ name: `worker-${randomUUID()}` });
          for (const tag of [requester, oldLead, lead, worker])
            await store.bindTagWorkerHost(tag.id, "fixture-host");
          const objective = await store.createObjective({
            id: randomUUID(),
            ownerTagId: requester.id,
            outcome: "Ship the requested interface",
          });
          const controller = new ObjectiveController(store, undefined);
          await controller.commandAsAdministrator("start_objective", {
            objectiveId: objective.id,
          });
          expect(await store.getTaskAssignment(`${objective.id}:start`)).toMatchObject({
            acceptanceCriteria: [
              "The Objective statement is satisfied, with evidence for each condition it names",
              "Every material Objective constraint is satisfied or explicitly recorded as unresolved",
              "Completion claims match reread durable Task, Team, Mailbox, and Objective state",
            ],
          });
          const team = await store.createTeam({
            id: randomUUID(),
            objectiveId: objective.id,
            name: "Delivery",
            leadTagId: oldLead.id,
            memberTagIds: [worker.id],
            maxConcurrency: 2,
          });
          await store.setTagMessagingGrant({
            senderTagId: requester.id,
            recipientTagId: oldLead.id,
            messageTypes: ["delegation.requested", "priority.proposed"],
          });
          await store.setTagMessagingGrant({
            senderTagId: oldLead.id,
            recipientTagId: requester.id,
            messageTypes: ["delegation.accepted", "delegation.declined"],
          });
          const sent = (await controller.commandAsAdministrator("send_message", {
            objectiveId: objective.id,
            recipientTeamId: team.id,
            type: "delegation.requested",
            body: { outcome: "Produce the interface" },
            idempotencyKey: "request-interface",
          })) as { message: { id: string } };
          const beforeAdmission = await store.listTaskAssignments(objective.id);
          expect(beforeAdmission.some((task) => task.sourceMessageId === sent.message.id)).toBe(
            false,
          );

          await store.updateTeam(team.id, { expectedRevision: 1, leadTagId: lead.id });
          await store.setTagMessagingGrant({
            senderTagId: requester.id,
            recipientTagId: lead.id,
            messageTypes: ["delegation.requested", "priority.proposed"],
          });
          await store.setTagMessagingGrant({
            senderTagId: lead.id,
            recipientTagId: requester.id,
            messageTypes: [
              "delegation.accepted",
              "delegation.declined",
              "priority.accepted",
              "priority.declined",
            ],
          });
          await expect(
            store.enqueueTagMessage({
              senderTagId: oldLead.id,
              recipientTagId: requester.id,
              objectiveId: objective.id,
              type: "delegation.accepted",
              body: {},
              idempotencyKey: "stale-lead-accept",
              inReplyTo: sent.message.id,
            }),
          ).rejects.toMatchObject({ statusCode: 400 });

          const [delivery] = await store.admitMailboxTaskAssignments();
          if (!delivery) throw new Error("Request delivery was not admitted");
          const controllerId = (controller as unknown as { instanceId: string }).instanceId;
          const caller = await store.claimTaskAssignment({
            taskId: delivery.taskId,
            leaseOwner: controllerId,
          });
          if (!caller) throw new Error("Request delivery could not be claimed");
          await store.createTaskAttempt({
            taskId: caller.taskId,
            attemptNumber: caller.attemptCount,
            workerProfile: { id: "request-commitment-manager", revision: "1" },
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          });
          const childInput = {
            taskId: randomUUID(),
            teamId: team.id,
            assignedTagId: worker.id,
            instruction: "Produce the accepted interface",
            acceptanceCriteria: ["Artifact is reviewable"],
          };
          await expect(
            controller.commandAsAttempt("assign_task", childInput, caller),
          ).rejects.toMatchObject({ statusCode: 409 });
          await expect(
            controller.commandAsAttempt(
              "assign_task",
              { ...childInput, objectiveId: randomUUID() },
              caller,
            ),
          ).rejects.toMatchObject({ statusCode: 403 });
          const otherTeam = await store.createTeam({
            id: randomUUID(),
            objectiveId: objective.id,
            name: "Other",
            leadTagId: lead.id,
            memberTagIds: [worker.id],
            maxConcurrency: 1,
          });
          await expect(
            controller.commandAsAttempt(
              "assign_task",
              { ...childInput, teamId: otherTeam.id },
              caller,
            ),
          ).rejects.toMatchObject({ statusCode: 403 });

          const accepted = (await controller.commandAsAttempt(
            "send_message",
            {
              recipientTagId: requester.id,
              type: "delegation.accepted",
              body: {},
              idempotencyKey: "accept-interface",
              inReplyTo: sent.message.id,
            },
            caller,
          )) as { message: { id: string }; duplicate: boolean };
          const replay = (await controller.commandAsAttempt(
            "send_message",
            {
              recipientTagId: requester.id,
              type: "delegation.accepted",
              body: {},
              idempotencyKey: "accept-interface",
              inReplyTo: sent.message.id,
            },
            caller,
          )) as typeof accepted;
          expect(replay).toMatchObject({ duplicate: true, message: { id: accepted.message.id } });
          await expect(
            controller.commandAsAttempt(
              "send_message",
              {
                recipientTagId: requester.id,
                type: "delegation.declined",
                body: {},
                idempotencyKey: "contradict-interface",
                inReplyTo: sent.message.id,
              },
              caller,
            ),
          ).rejects.toMatchObject({ statusCode: 409 });

          const acceptedView = (await controller.commandAsAdministrator("read_commitments", {
            objectiveId: objective.id,
          })) as { commitments: CommitmentViewEntry[] };
          expect(
            acceptedView.commitments.find((entry) => entry.taskId === delivery.taskId)?.request,
          ).toMatchObject({
            state: "accepted",
            commitmentTaskIds: [],
            responseMessageId: accepted.message.id,
          });
          expect(await store.listTaskAssignments(objective.id)).toHaveLength(
            beforeAdmission.length + 1,
          );

          const child = (await controller.commandAsAttempt(
            "assign_task",
            childInput,
            caller,
          )) as TaskAssignment;
          expect(child.parentTaskId).toBe(delivery.taskId);
          const beforePriority = await store.getTaskAssignment(child.taskId);
          const proposal = (await controller.commandAsAdministrator("send_message", {
            objectiveId: objective.id,
            recipientTeamId: team.id,
            type: "priority.proposed",
            body: { taskId: child.taskId, priority: "urgent", rationale: "Consumer deadline" },
            idempotencyKey: "priority-interface",
          })) as { message: { id: string } };
          await controller.commandAsAttempt(
            "send_message",
            {
              recipientTagId: requester.id,
              type: "priority.accepted",
              body: { taskId: child.taskId, priority: "urgent" },
              idempotencyKey: "priority-interface-accepted",
              inReplyTo: proposal.message.id,
            },
            caller,
          );
          expect(await store.getTaskAssignment(child.taskId)).toMatchObject({
            status: beforePriority?.status,
            availableAt: beforePriority?.availableAt,
          });

          const view = (await controller.commandAsAdministrator("read_commitments", {
            objectiveId: objective.id,
          })) as { commitments: CommitmentViewEntry[] };
          const request = view.commitments.find((entry) => entry.taskId === delivery.taskId);
          expect(request?.request).toMatchObject({
            requestMessageId: sent.message.id,
            state: "committed",
            responseMessageId: accepted.message.id,
            responseByTagId: lead.id,
            commitmentTaskIds: [child.taskId],
          });
          const commitment = view.commitments.find((entry) => entry.taskId === child.taskId);
          expect(commitment).toMatchObject({
            originatingRequestId: sent.message.id,
            priorityNegotiation: {
              proposalMessageId: proposal.message.id,
              state: "accepted",
              proposedPriority: "urgent",
              proposedByTagId: requester.id,
              responseByTagId: lead.id,
            },
          });
          expect(JSON.stringify(request)).not.toContain("Produce the interface");
        } finally {
          await store.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
  );
}
