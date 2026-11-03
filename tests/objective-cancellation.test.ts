import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  emptyTagContextPlan,
  parseObjectiveStatus,
  TagMessagingError,
} from "../packages/core/src/index.js";
import {
  decodeObjective,
  encodeObjective,
} from "../packages/runtime/transport/src/mailbox-codec.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Objective cancellation`,
    { timeout: 30_000 },
    () => {
      const cleanups: Array<() => Promise<unknown> | unknown> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture(definition: Record<string, unknown> = {}) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-cancel-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        const isolated =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(postgres as string)
            : undefined;
        if (isolated) cleanups.push(isolated.cleanup);
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const member = await store.createTag({ name: `member-${randomUUID()}` });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Ship the release",
          budgetLimitMinor: 100,
          ...definition,
        });
        const team = await store.createTeam({
          id: `${objective.id}:leadership`,
          objectiveId: objective.id,
          name: "Leadership",
          leadTagId: owner.id,
          memberTagIds: [owner.id, member.id],
          maxConcurrency: 4,
        });
        const reports: { objectiveId: string; text: string; deliveryKey: string }[] = [];
        const controller = new ObjectiveController(store, undefined);
        controller.setSurfaceReporter(async (objectiveId, text, deliveryKey) => {
          reports.push({ objectiveId, text, deliveryKey });
        });
        const admit = (
          taskId: string,
          options: {
            assignee?: string;
            cost?: number;
            start?: boolean;
            parentTaskId?: string;
            teamId?: string;
          } = {},
        ) => {
          const at = new Date().toISOString();
          const assignee = options.assignee ?? owner.id;
          return store.admitTaskAssignment({
            taskId,
            objectiveId: objective.id,
            teamId: options.teamId ?? team.id,
            requestedByTagId: owner.id,
            assignedTagId: assignee,
            instruction: `Produce ${taskId}`,
            acceptanceCriteria: ["Reviewed"],
            maxCostMinor: options.cost ?? 0,
            execution: {},
            workspacePlan: { version: 1, status: "none" },
            contextPlan: emptyTagContextPlan(at),
            authorizationSnapshot: {
              version: 4,
              capturedAt: at,
              tag: { id: assignee, name: assignee },
              origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
              requester: { id: owner.id, kind: "bot" },
              permissionSets: [],
              resources: [],
              runtimeActions: [],
            },
            ...(options.start ? { startObjectiveExecution: true } : {}),
            ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
          });
        };
        const run = async (taskId: string, leaseOwner = "test") => {
          const claim = await store.claimTaskAssignment({ taskId, leaseOwner });
          if (!claim) throw new Error(`Could not claim ${taskId}`);
          await store.createTaskAttempt({
            taskId,
            attemptNumber: claim.attemptCount,
            workerProfile: { id: "fixture", revision: "1" },
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          });
          return claim;
        };
        return { store, controller, owner, member, objective, team, reports, admit, run };
      }

      it("cancels open Tasks, releases reservations, and tells the owner and surface why", async () => {
        const f = await fixture();
        const root = await f.admit(`${f.objective.id}:start`, { start: true, cost: 10 });
        const queued = await f.admit(randomUUID(), { assignee: f.member.id, cost: 20 });
        const running = await f.admit(randomUUID(), { assignee: f.member.id, cost: 5 });
        await f.run(running.taskId);
        expect((await f.store.getObjective(f.objective.id)).reservedMinor).toBe(30);

        const result = await f.controller.cancelObjective({
          objectiveId: f.objective.id,
          reason: "The launch moved to next quarter",
        });

        expect(result.changed).toBe(true);
        expect(new Set(result.cancelledTaskIds)).toEqual(
          new Set([root.taskId, queued.taskId, running.taskId]),
        );
        const objective = await f.store.getObjective(f.objective.id);
        expect(objective).toMatchObject({
          status: "cancelled",
          cancellationReason: "The launch moved to next quarter",
          reservedMinor: 0,
          spentMinor: 5,
          revision: f.objective.revision + 1,
        });
        expect(Date.parse(objective.cancelledAt ?? "")).toBeGreaterThan(0);
        for (const task of await f.store.listTaskAssignments(f.objective.id)) {
          expect(task.status).toBe("cancelled");
          expect((await f.store.listTaskEvents(task.taskId)).map((e) => e.type)).toContain(
            "task.cancelled",
          );
        }
        // The owner's Mailbox records the notice without starting an activation.
        const notices = (await f.store.listTagMessages(f.owner.id)).filter(
          (message) => message.idempotencyKey === `objective-cancelled:${f.objective.id}`,
        );
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({
          recipientTagId: f.owner.id,
          objectiveId: f.objective.id,
          status: "processed",
        });
        expect(String(notices[0]?.body["message"])).toContain("The launch moved to next quarter");
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        expect(f.reports).toEqual([
          {
            objectiveId: f.objective.id,
            text: expect.stringContaining("The launch moved to next quarter"),
            deliveryKey: expect.stringMatching(/^objective-report:/u),
          },
        ]);
        const overview = await f.controller.readObjectiveOverview({ objectiveId: f.objective.id });
        expect(overview.attention).toContainEqual(
          expect.objectContaining({
            kind: "objective_cancelled",
            message: expect.stringContaining("The launch moved to next quarter"),
            observedAt: objective.cancelledAt,
          }),
        );
        const changes = await f.store.listResourceChanges?.({
          resourceType: "objective",
          resourceId: f.objective.id,
        });
        expect(changes?.at(-1)?.changes).toMatchObject({
          status: { previous: "working", next: "cancelled" },
        });
        // SDK clients reading over gRPC see the same cancellation.
        expect(decodeObjective(encodeObjective(objective))).toMatchObject({
          status: "cancelled",
          cancelledAt: objective.cancelledAt,
          cancellationReason: "The launch moved to next quarter",
        });
      });

      it("records why each Task stopped and dissolves the Objective's Teams", async () => {
        const f = await fixture();
        const queued = await f.admit(randomUUID(), { assignee: f.member.id });
        await f.controller.cancelObjective({
          objectiveId: f.objective.id,
          reason: "Scope moved",
        });
        expect((await f.store.getTaskAssignment(queued.taskId))?.result).toMatchObject({
          closure: "objective-closed",
          reason: `Objective ${f.objective.id} was cancelled: Scope moved; this Task can no longer run.`,
        });
        expect((await f.store.getTeam(f.team.id)).status).toBe("dissolved");
        const history = await f.store.listResourceChanges?.({
          resourceType: "team",
          resourceId: f.team.id,
        });
        expect(history?.at(-1)?.changes).toEqual({
          status: { previous: "active", next: "dissolved" },
          reason: { previous: null, next: `Objective ${f.objective.id} was cancelled` },
          closedWithObjective: { previous: null, next: f.objective.id },
        });
        expect(await f.store.listClosedObjectiveLeftovers()).not.toContain(f.objective.id);
      });

      it("ends the owner's own queued follow-up when the owner completes the Objective", async () => {
        // Regression: mcp-http:review-final-fixes-4:followup stayed queued after completion.
        const f = await fixture();
        const leaseOwner = (f.controller as unknown as { instanceId: string }).instanceId;
        const start = await f.admit(`${f.objective.id}:start`, { start: true });
        const review = await f.admit(randomUUID(), { assignee: f.member.id });
        const reviewClaim = await f.run(review.taskId);
        await f.store.settleTaskAssignment({
          taskId: review.taskId,
          leaseOwner: "test",
          attemptCount: reviewClaim.attemptCount,
          result: { text: "Reviewed" },
        });
        // The owner is busy, so the result's follow-up waits in the queue.
        const followup = await f.admit(`${review.taskId}:followup`);
        const owner = await f.run(start.taskId, leaseOwner);
        await f.controller.commandAsAttempt(
          "update_task",
          {
            taskId: review.taskId,
            expectedStatus: "submitted",
            status: "accepted",
            assessment: "Good",
          },
          owner,
        );
        const current = await f.store.getObjective(f.objective.id);
        await f.controller.commandAsAttempt(
          "update_objective",
          {
            status: "completed",
            expectedRevision: current.revision,
            completionSummary: "Shipped",
          },
          owner,
        );
        expect(await f.store.getTaskAssignment(followup.taskId)).toMatchObject({
          status: "cancelled",
          result: {
            closure: "objective-closed",
            reason: `Objective ${f.objective.id} completed; this Task can no longer run.`,
          },
        });
        // The completing activation still runs, so its Team stays until it settles.
        expect((await f.store.getTeam(f.team.id)).status).toBe("active");
        await f.store.settleTaskAssignment({
          taskId: start.taskId,
          leaseOwner,
          attemptCount: owner.attemptCount,
          result: { text: "Completed" },
        });
        // The owner's activation ends on its own; nobody reviews it.
        expect(await f.store.getTaskAssignment(start.taskId)).toMatchObject({
          status: "accepted",
          result: { closure: "owner-activation", reviewedByTagId: null },
        });
        expect(await f.store.listClosedObjectiveLeftovers()).toContain(f.objective.id);
        expect(await f.controller.settleClosedObjective(f.objective.id)).toMatchObject({
          dissolvedTeamIds: [f.team.id],
        });
        expect(await f.store.listClosedObjectiveLeftovers()).not.toContain(f.objective.id);
        // Reopening the Objective restores the Team its completion dissolved.
        await f.controller.messageObjective({
          objectiveId: f.objective.id,
          message: "Translate it too.",
          reopen: true,
        });
        expect((await f.store.getTeam(f.team.id)).status).toBe("active");
      });

      it("settles leftovers an earlier completion left behind", async () => {
        const f = await fixture();
        const root = await f.admit(`${f.objective.id}:start`, { start: true });
        const claim = await f.run(root.taskId);
        // The owner's activation closes itself when it ends.
        await f.store.settleTaskAssignment({
          taskId: root.taskId,
          leaseOwner: "test",
          attemptCount: claim.attemptCount,
          result: { text: "Done" },
        });
        expect((await f.store.getTaskAssignment(root.taskId))?.status).toBe("accepted");
        const legacy = await f.admit(`${f.objective.id}:start:assessment:followup`);
        // A completion without the controller, as before this cleanup existed.
        await f.store.updateObjectiveStatus(
          f.objective.id,
          {
            status: "completed",
            expectedRevision: (await f.store.getObjective(f.objective.id)).revision,
            completionSummary: "Finished",
          },
          f.owner.id,
        );
        expect(await f.store.listClosedObjectiveLeftovers()).toEqual([f.objective.id]);
        const settled = await f.controller.settleClosedObjective(f.objective.id);
        expect(settled).toEqual({
          cancelledTaskIds: [legacy.taskId],
          closedTaskIds: [],
          dissolvedTeamIds: [f.team.id],
        });
        expect(await f.store.listClosedObjectiveLeftovers()).toEqual([]);
        await expect(
          f.store.settleClosedObjective(
            (
              await f.store.createObjective({
                id: randomUUID(),
                ownerTagId: f.owner.id,
                outcome: "x",
              })
            ).id,
            "Not closed",
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
      });

      it("waits for review of work assigned directly to the owner, then settles it at completion", async () => {
        const f = await fixture();
        const finish = async (taskId: string) => {
          const claim = await f.run(taskId);
          await f.store.settleTaskAssignment({
            taskId,
            leaseOwner: "test",
            attemptCount: claim.attemptCount,
            result: { text: `Did ${taskId}` },
          });
          return f.store.getTaskAssignment(taskId);
        };
        const start = await f.admit(`${f.objective.id}:start`, { start: true });
        const delivery = await f.store.createTeam({
          id: `${f.objective.id}:delivery`,
          objectiveId: f.objective.id,
          name: "Delivery",
          leadTagId: f.owner.id,
          memberTagIds: [f.owner.id],
          parentTeamId: f.team.id,
          maxConcurrency: 2,
        });
        // An operator's direct assignment to the owner is not an owner activation.
        const direct = await f.admit(`direct-${randomUUID()}`, { teamId: delivery.id });
        // Neither is work the owner delegated to itself under its activation.
        const delegated = await f.admit(randomUUID(), { parentTaskId: start.taskId });
        const followup = await f.admit(`${direct.taskId}:followup`);
        const assessment = await f.admit(`${f.objective.id}:start:assessment:followup`);
        expect((await finish(direct.taskId))?.status).toBe("submitted");
        expect((await finish(delegated.taskId))?.status).toBe("submitted");
        for (const owner of [followup, assessment])
          expect(await finish(owner.taskId)).toMatchObject({
            status: "accepted",
            result: { closure: "owner-activation", reviewedByTagId: null },
          });
        expect((await finish(start.taskId))?.status).toBe("accepted");
        // The owner completes; its own submitted work does not hold that.
        await f.store.updateObjectiveStatus(
          f.objective.id,
          {
            status: "completed",
            expectedRevision: (await f.store.getObjective(f.objective.id)).revision,
            completionSummary: "Finished",
          },
          f.owner.id,
        );
        const settled = await f.controller.settleClosedObjective(f.objective.id);
        expect(new Set(settled.closedTaskIds)).toEqual(new Set([direct.taskId, delegated.taskId]));
        expect(new Set(settled.dissolvedTeamIds)).toEqual(new Set([f.team.id, delivery.id]));
        for (const taskId of [direct.taskId, delegated.taskId])
          expect(await f.store.getTaskAssignment(taskId)).toMatchObject({
            status: "accepted",
            result: {
              closure: "objective-closed",
              reason: `Objective ${f.objective.id} completed`,
              reviewedByTagId: null,
            },
          });
        for (const teamId of [f.team.id, delivery.id])
          expect((await f.store.getTeam(teamId)).status).toBe("dissolved");
        expect(await f.store.listClosedObjectiveLeftovers()).not.toContain(f.objective.id);
      });

      it("keeps a Team that also serves an open Objective", async () => {
        const f = await fixture();
        const other = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Still open",
        });
        await f.store.updateTeam(f.team.id, {
          expectedRevision: f.team.revision,
          objectiveIds: [other.id],
        });
        await f.controller.cancelObjective({ objectiveId: f.objective.id });
        expect((await f.store.getTeam(f.team.id)).status).toBe("active");
      });

      it("keeps a channel named by an open Objective's observation source", async () => {
        const f = await fixture();
        await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Watch the channel",
          observations: [{ workstreamId: f.team.id }],
        });
        await f.controller.cancelObjective({ objectiveId: f.objective.id });
        expect((await f.store.getTeam(f.team.id)).status).toBe("active");
      });

      it("is idempotent and refuses a completed Objective", async () => {
        const f = await fixture();
        await f.admit(randomUUID(), { assignee: f.member.id });
        const first = await f.controller.cancelObjective({ objectiveId: f.objective.id });
        const second = await f.controller.cancelObjective({
          objectiveId: f.objective.id,
          reason: "Again",
        });
        expect(second.changed).toBe(false);
        expect(second.cancelledTaskIds).toEqual([]);
        expect(second.objective).toMatchObject({
          status: "cancelled",
          cancelledAt: first.objective.cancelledAt,
          cancellationReason: null,
          revision: first.objective.revision,
        });
        expect(
          (await f.store.listTagMessages(f.owner.id)).filter((m) =>
            m.idempotencyKey.startsWith("objective-cancelled:"),
          ),
        ).toHaveLength(1);
        expect(f.reports).toHaveLength(1);
        await expect(
          f.controller.messageObjective({
            objectiveId: f.objective.id,
            message: "Try again",
            reopen: true,
          }),
        ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/cancelled/) });
        await expect(
          f.controller.approveObjective({ objectiveId: f.objective.id }),
        ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/cancelled/) });

        const done = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Already finished",
        });
        await f.store.updateObjectiveStatus(done.id, {
          status: "completed",
          expectedRevision: done.revision,
          completionSummary: "Finished",
        });
        await expect(f.controller.cancelObjective({ objectiveId: done.id })).rejects.toMatchObject({
          statusCode: 409,
          message: "A completed Objective cannot be cancelled",
        });
        await expect(
          f.controller.cancelObjective({ objectiveId: "missing" }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });

      it("keeps cancellation away from AI actors and status updates", async () => {
        const f = await fixture();
        expect(() => parseObjectiveStatus({ status: "cancelled", expectedRevision: 1 })).toThrow(
          TagMessagingError,
        );
        // Neither the owner's update_objective tool nor an operator status update can cancel.
        await expect(
          f.store.updateObjectiveStatus(
            f.objective.id,
            { status: "cancelled" as never, expectedRevision: f.objective.revision },
            f.owner.id,
          ),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
          f.controller.command("update_objective", {
            objectiveId: f.objective.id,
            status: "cancelled",
            expectedRevision: f.objective.revision,
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
        // Scoped operators need the cancel_objective action and Objective-wide scope.
        for (const scopes of [
          { actions: ["update_task", "update_objective"] },
          { actions: ["cancel_objective"], objectiveIds: ["another"] },
          { actions: ["cancel_objective"], teamIds: [f.team.id] },
        ])
          await expect(
            f.controller.cancelObjective(
              { objectiveId: f.objective.id },
              {
                operatorId: "scoped",
                scopes,
              },
            ),
          ).rejects.toMatchObject({ statusCode: 403 });
        expect((await f.store.getObjective(f.objective.id)).status).toBe("working");
        await f.controller.cancelObjective(
          { objectiveId: f.objective.id },
          { operatorId: "scoped", scopes: { actions: ["cancel_objective"] } },
        );
        // A cancelled Objective is terminal.
        const cancelled = await f.store.getObjective(f.objective.id);
        await expect(
          f.store.updateObjectiveStatus(f.objective.id, {
            status: "working",
            expectedRevision: cancelled.revision,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await expect(f.admit(randomUUID())).rejects.toMatchObject({
          statusCode: 409,
          message: "Objective is cancelled",
        });
      });

      it("stops owner continuation and limit sweeps", async () => {
        const f = await fixture({ deadline: new Date(Date.now() + 3_600_000).toISOString() });
        const root = await f.admit(`${f.objective.id}:start`, { start: true });
        const claim = await f.run(root.taskId);
        await f.store.settleTaskAssignment({
          taskId: root.taskId,
          leaseOwner: "test",
          attemptCount: claim.attemptCount,
          failed: true,
          result: { error: "The model crashed" },
        });
        expect((await f.store.listStalledObjectiveOwnerTasks()).map((t) => t.taskId)).toEqual([
          root.taskId,
        ]);
        expect((await f.store.listExecutingObjectives()).map((o) => o.id)).toEqual([
          f.objective.id,
        ]);
        await f.controller.cancelObjective({ objectiveId: f.objective.id });
        expect(await f.store.listStalledObjectiveOwnerTasks()).toEqual([]);
        expect(await f.store.listExecutingObjectives()).toEqual([]);
        const inbox = await f.controller.readCoordinationInbox({ objectiveId: f.objective.id });
        expect(inbox.items.filter((item) => item.kind === "objective_limit")).toEqual([]);
      });

      it("stops observing an ongoing Objective and fails its unadmitted messages", async () => {
        const source = randomUUID();
        const f = await fixture({ ongoing: true, observations: [{ workstreamId: source }] });
        const publisher = await f.store.createTag({ name: `publisher-${randomUUID()}` });
        const stream = await f.store.createTeam({
          id: source,
          objectiveId: f.objective.id,
          name: "Measurements",
          leadTagId: f.owner.id,
          memberTagIds: [f.owner.id, publisher.id],
        });
        const root = await f.admit(`${f.objective.id}:start`, { start: true });
        await f.store.cancelTaskAssignment(root.taskId, f.owner.id);
        const post = () =>
          f.store.postWorkstream({
            workstreamId: stream.id,
            authorTagId: publisher.id,
            body: "A measurement",
            idempotencyKey: randomUUID(),
          });
        await post();
        await f.store.reconcileObjectiveObservations();
        const [observation] = await f.store.listTagMessages(f.owner.id);
        expect(observation?.status).toBe("pending");

        // A second post arrives before cancellation and has not been batched yet.
        await post();
        await f.controller.cancelObjective({ objectiveId: f.objective.id });
        expect((await f.store.getTagMessage(observation?.id ?? ""))?.status).toBe("failed");
        // Cancellation dissolves the Objective's Teams, so their channels accept no more posts.
        expect((await f.store.getTeam(stream.id)).status).toBe("dissolved");
        await expect(post()).rejects.toMatchObject({ statusCode: 403 });
        await f.store.reconcileObjectiveObservations();
        const after = await f.store.listTagMessages(f.owner.id);
        expect(after.filter((message) => message.status === "pending")).toEqual([]);
        expect(after).toHaveLength(2);
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
      });
    },
  );
}
