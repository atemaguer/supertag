import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import {
  decodeObjective,
  encodeObjective,
} from "../packages/runtime/transport/src/mailbox-codec.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Objective observations`,
    () => {
      const cleanups: (() => Promise<unknown>)[] = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      async function fixture(
        budget = 100,
        ongoing = true,
        allocation?: number,
        observedSource?: string,
      ) {
        const directory = await mkdtemp(join(tmpdir(), "observations-"));
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
        const other = new DrizzleStore({ url });
        await other.connect();
        cleanups.push(() => other.disconnect());
        const owner = await store.createTag({ name: randomUUID() });
        const publisher = await store.createTag({ name: randomUUID() });
        const source = randomUUID();
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          ongoing,
          outcome: "Maintain service",
          budgetLimitMinor: budget,
          ...(allocation === undefined ? {} : { budgetCurrency: "USD" }),
          observations: [{ workstreamId: observedSource ?? source }],
        });
        // The observed channel is the Measurements Team's channel; its ID is the Team ID.
        const stream = await store.createTeam({
          id: source,
          objectiveId: objective.id,
          name: "Measurements",
          leadTagId: owner.id,
          memberTagIds: [owner.id, publisher.id],
        });
        const team = await store.createTeam({
          id: `${objective.id}:leadership`,
          objectiveId: objective.id,
          name: "Leadership",
          leadTagId: owner.id,
          memberTagIds: [],
          maxConcurrency: 1,
        });
        const now = new Date().toISOString();
        const root = await store.admitTaskAssignment({
          taskId: `${objective.id}:start`,
          objectiveId: objective.id,
          teamId: team.id,
          requestedByTagId: owner.id,
          assignedTagId: owner.id,
          instruction: "Maintain service",
          acceptanceCriteria: ["Healthy"],
          startObjectiveExecution: true,
          maxCostMinor: allocation ?? 0,
          execution:
            allocation === undefined
              ? {}
              : { limits: { maxReportedCost: { amountMinor: allocation, currency: "USD" } } },
          contextPlan: emptyTagContextPlan(now),
          workspacePlan: { version: 1, status: "none" },
          authorizationSnapshot: {
            version: 4,
            capturedAt: now,
            tag: { id: owner.id, name: owner.name },
            origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
            requester: { id: owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
        });
        const post = (sourceTaskId?: string) =>
          store.postWorkstream(
            {
              workstreamId: stream.id,
              authorTagId: sourceTaskId ? owner.id : publisher.id,
              // Each call represents fresh evidence, not a content retry.
              body: `A measurement ${randomUUID()}`,
              idempotencyKey: randomUUID(),
            },
            sourceTaskId,
          );
        const admitOwnerTask = (taskId: string, parentTaskId?: string) =>
          store.admitTaskAssignment({
            taskId,
            objectiveId: objective.id,
            teamId: team.id,
            requestedByTagId: owner.id,
            assignedTagId: owner.id,
            ...(parentTaskId ? { parentTaskId } : {}),
            instruction: "Continue maintaining service",
            acceptanceCriteria: ["Healthy"],
            maxCostMinor: 0,
            execution: {},
            contextPlan: emptyTagContextPlan(new Date().toISOString()),
            workspacePlan: { version: 1, status: "none" },
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
          });
        const admitRoot = (taskId: string) => admitOwnerTask(taskId);
        const admitChild = (taskId: string) => admitOwnerTask(taskId, root.taskId);
        const state = async () => (await store.getObjective(objective.id)).observationState;
        return {
          store,
          other,
          objective,
          owner,
          publisher,
          root,
          stream,
          post,
          admitRoot,
          admitChild,
          state,
        };
      }
      it("batches once across controllers, survives restart, and acknowledges only settled assessment", async () => {
        const f = await fixture();
        await f.store.cancelTaskAssignment(f.root.taskId, f.owner.id);
        await f.post();
        await f.post();
        await Promise.all([
          f.store.reconcileObjectiveObservations(),
          f.other.reconcileObjectiveObservations(),
        ]);
        expect((await f.state())?.cursors).toEqual({});
        const messages = await f.store.listTagMessages(f.owner.id);
        expect(messages).toHaveLength(1);
        const [task] = await f.store.admitMailboxTaskAssignments();
        if (!task) throw new Error("Expected observation assessment");
        expect(task).toBeDefined();
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "notice" });
        await f.store.listWorkstreamPosts(f.stream.id, f.owner.id);
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.cursors).toEqual({});
        await f.post();
        await f.store.disconnect();
        await f.store.connect();
        await f.store.reconcileObjectiveObservations();
        expect(await f.store.listTagMessages(f.owner.id)).toHaveLength(1);
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "notice",
          attemptCount: 1,
          result: {},
        });
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.cursors[f.stream.id]).toBe(2);
        expect((await f.state())?.pending?.through[f.stream.id]).toBe(3);
        const durable = await f.store.getObjective(f.objective.id);
        expect(decodeObjective(encodeObjective(durable))).toMatchObject({
          observations: durable.observations,
          observationState: durable.observationState,
        });
        expect(await f.store.listTagMessages(f.owner.id)).toHaveLength(2);
      });
      it("bounds each batch and retains overflow until the first assessment settles", async () => {
        const f = await fixture();
        await f.store.cancelTaskAssignment(f.root.taskId, f.owner.id);
        await Promise.all(Array.from({ length: 51 }, () => f.post()));
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.pending?.through[f.stream.id]).toBe(50);
        const messages = await f.store.listTagMessages(f.owner.id);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.body).toMatchObject({
          afterSequence: 0,
          throughSequence: 50,
          postIds: expect.any(Array),
        });
        const [task] = await f.store.admitMailboxTaskAssignments();
        if (!task) throw new Error("Expected assessment");
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "notice" });
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "notice",
          attemptCount: 1,
          result: {},
        });
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.cursors[f.stream.id]).toBe(50);
        expect((await f.state())?.pending?.through[f.stream.id]).toBe(51);
      });
      it("reuses a matching owner wait with a durable fenced assessment receipt", async () => {
        const f = await fixture();
        const suspend = async (attemptCount: number, afterSequence: number) => {
          await f.store.registerTaskAssignmentWait({
            taskId: f.root.taskId,
            leaseOwner: "root",
            attemptCount,
            workstreamPosts: { workstreamId: f.stream.id, afterSequence },
          });
          await f.store.settleTaskAssignment({
            taskId: f.root.taskId,
            leaseOwner: "root",
            attemptCount,
            result: {},
          });
        };
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "root" });
        await suspend(1, 0);
        await f.post();
        await Promise.all([
          f.store.reconcileObjectiveObservations(),
          f.other.reconcileObjectiveObservations(),
        ]);
        expect((await f.state())?.pending).toMatchObject({
          taskId: f.root.taskId,
          attemptCount: 2,
        });
        expect(
          decodeObjective(encodeObjective(await f.store.getObjective(f.objective.id)))
            .observationState,
        ).toEqual(await f.state());
        expect(await f.other.admitMailboxTaskAssignments()).toEqual([]);
        // The prior completed Attempt is not acknowledgement of this new batch.
        expect((await f.state())?.cursors).toEqual({});
        expect(await f.other.wakeWaitingTaskAssignments()).toHaveLength(0);
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "root" });
        await f.post();
        await f.post(f.root.taskId);
        await f.other.reconcileObjectiveObservations();
        expect((await f.state())?.cursors).toEqual({});
        await suspend(2, 1);
        await f.other.reconcileObjectiveObservations();
        expect((await f.state())?.cursors[f.stream.id]).toBe(1);
        expect((await f.state())?.pending).toMatchObject({
          taskId: f.root.taskId,
          attemptCount: 3,
          through: { [f.stream.id]: 3 },
        });
        expect(await f.other.admitMailboxTaskAssignments()).toEqual([]);
        expect(await f.other.wakeWaitingTaskAssignments()).toHaveLength(0);
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "root" });
        await f.store.settleTaskAssignment({
          taskId: f.root.taskId,
          leaseOwner: "root",
          attemptCount: 3,
          result: { failureKind: "test" },
          failed: true,
        });
        await f.other.reconcileObjectiveObservations();
        expect((await f.state())?.blocked).toContain("failed");
        expect((await f.state())?.cursors[f.stream.id]).toBe(1);
        expect(
          (
            await f.other.readCoordinationInbox({
              objectiveId: f.objective.id,
              kind: "task_attention",
            })
          ).items[0]?.reason,
        ).toContain("without acknowledging");
      });
      it("binds observation batches to the existing queued owner activation", async () => {
        const f = await fixture();
        await f.post();
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.pending).toMatchObject({
          taskId: f.root.taskId,
          attemptCount: 1,
          through: { [f.stream.id]: 1 },
        });
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "root" });
        await f.store.registerTaskAssignmentWait({
          taskId: f.root.taskId,
          leaseOwner: "root",
          attemptCount: 1,
          notBefore: new Date(Date.now() + 3_600_000).toISOString(),
        });
        await f.store.settleTaskAssignment({
          taskId: f.root.taskId,
          leaseOwner: "root",
          attemptCount: 1,
          result: {},
        });
        await f.other.reconcileObjectiveObservations();
        expect((await f.state())?.cursors[f.stream.id]).toBe(1);
        expect((await f.state())?.pending).toBeUndefined();
        expect((await f.store.getTaskAssignment(f.root.taskId)).waitState).toMatchObject({
          workstreamPosts: { workstreamId: f.stream.id, afterSequence: 1 },
        });
        await f.post();
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.pending).toMatchObject({
          taskId: f.root.taskId,
          attemptCount: 2,
          through: { [f.stream.id]: 2 },
        });
        expect((await f.state())?.cursors[f.stream.id]).toBe(1);
        expect(await f.other.admitMailboxTaskAssignments()).toEqual([]);
        expect(await f.store.listTaskAssignments(f.objective.id)).toHaveLength(1);
      });
      it("reattaches a pending observation when the owner activation appears later", async () => {
        const f = await fixture();
        await f.store.cancelTaskAssignment(f.root.taskId, f.owner.id);
        await f.post();
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.pending?.taskId).toBeUndefined();
        expect((await f.state())?.pending?.through).toEqual({ [f.stream.id]: 1 });
        const resumed = await f.admitRoot(`${f.objective.id}:resume`);
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        await f.other.reconcileObjectiveObservations();
        expect((await f.state())?.pending).toMatchObject({
          taskId: resumed.taskId,
          attemptCount: 1,
        });
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        expect(await f.store.listTaskAssignments(f.objective.id)).toHaveLength(2);
      });
      it("coalesces observations with the delegated result the owner already awaits", async () => {
        const f = await fixture();
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "root" });
        const child = await f.admitChild(`${f.objective.id}:child`);
        await f.store.registerTaskAssignmentWait({
          taskId: f.root.taskId,
          leaseOwner: "root",
          attemptCount: 1,
          submittedTaskIds: [child.taskId],
          workstreamPosts: { workstreamId: f.stream.id, afterSequence: 0 },
        });
        await f.store.settleTaskAssignment({
          taskId: f.root.taskId,
          leaseOwner: "root",
          attemptCount: 1,
          result: {},
        });
        await f.post();
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.pending).toMatchObject({
          taskId: f.root.taskId,
          attemptCount: 2,
        });
        expect(await f.store.getTaskAssignment(f.root.taskId)).toMatchObject({
          status: "waiting",
        });
        expect(
          (await f.store.getTaskAssignment(f.root.taskId))?.waitState?.workstreamPosts,
        ).toBeUndefined();
        expect(await f.store.wakeWaitingTaskAssignments()).toEqual([]);
        await f.store.claimTaskAssignment({ taskId: child.taskId, leaseOwner: "child" });
        await f.store.settleTaskAssignment({
          taskId: child.taskId,
          leaseOwner: "child",
          attemptCount: 1,
          result: {},
        });
        expect(await f.store.wakeWaitingTaskAssignments()).toHaveLength(1);
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "root" });
        await f.store.registerTaskAssignmentWait({
          taskId: f.root.taskId,
          leaseOwner: "root",
          attemptCount: 2,
          notBefore: new Date(Date.now() + 3_600_000).toISOString(),
        });
        await f.store.settleTaskAssignment({
          taskId: f.root.taskId,
          leaseOwner: "root",
          attemptCount: 2,
          result: {},
        });
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.pending).toBeUndefined();
        expect((await f.state())?.cursors[f.stream.id]).toBe(1);
      });
      it.each(["running", "timer"] as const)(
        "defers to a %s owner or reuses its queued activation",
        async (mode) => {
          const f = await fixture();
          await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "root" });
          await f.store.registerTaskAssignmentWait({
            taskId: f.root.taskId,
            leaseOwner: "root",
            attemptCount: 1,
            workstreamPosts: { workstreamId: f.stream.id, afterSequence: 0 },
            ...(mode === "timer" ? { notBefore: new Date().toISOString() } : {}),
          });
          await f.store.settleTaskAssignment({
            taskId: f.root.taskId,
            leaseOwner: "root",
            attemptCount: 1,
            result: {},
          });
          if (mode === "timer") await f.store.wakeWaitingTaskAssignments();
          await f.post();
          if (mode === "running") {
            await f.store.wakeWaitingTaskAssignments();
            await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "root" });
          }
          await f.store.reconcileObjectiveObservations();
          if (mode === "running") {
            expect((await f.state())?.pending).toBeUndefined();
            expect(await f.store.listTagMessages(f.owner.id)).toHaveLength(0);
            await f.store.registerTaskAssignmentWait({
              taskId: f.root.taskId,
              leaseOwner: "root",
              attemptCount: 2,
              workstreamPosts: { workstreamId: f.stream.id, afterSequence: 0 },
            });
            await f.store.settleTaskAssignment({
              taskId: f.root.taskId,
              leaseOwner: "root",
              attemptCount: 2,
              result: {},
            });
            await f.store.reconcileObjectiveObservations();
            expect((await f.state())?.pending).toMatchObject({
              taskId: f.root.taskId,
              attemptCount: 3,
            });
          } else {
            expect((await f.state())?.pending?.taskId).toBe(f.root.taskId);
            expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
          }
        },
      );
      it("wakes the original owner assignment from a distant timer", async () => {
        const f = await fixture();
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "root" });
        await f.store.registerTaskAssignmentWait({
          taskId: f.root.taskId,
          leaseOwner: "root",
          attemptCount: 1,
          notBefore: new Date(Date.now() + 3_600_000).toISOString(),
        });
        await f.store.settleTaskAssignment({
          taskId: f.root.taskId,
          leaseOwner: "root",
          attemptCount: 1,
          result: {},
        });
        await f.post();
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.pending?.taskId).toBe(f.root.taskId);
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        expect(await f.store.getTaskAssignment(f.root.taskId)).toMatchObject({
          status: "queued",
          waitState: { wake: { reason: "workstream_posts" } },
        });
      });
      it("delivers fresh evidence after a successful assessment reports unresolved work", async () => {
        const f = await fixture();
        await f.store.cancelTaskAssignment(f.root.taskId, f.owner.id);
        await f.post();
        await f.store.reconcileObjectiveObservations();
        const [task] = await f.store.admitMailboxTaskAssignments();
        if (!task) throw new Error("Expected assessment");
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "notice" });
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "notice",
          attemptCount: 1,
          result: { taskResult: { unresolved: ["Need operator decision"] } },
        });
        await f.post();
        await f.other.reconcileObjectiveObservations();
        expect((await f.state())?.blocked).toBeUndefined();
        expect((await f.state())?.cursors).toEqual({ [f.stream.id]: 1 });
        expect(await f.store.listTagMessages(f.owner.id)).toHaveLength(2);
      });
      it("retains failed batches and suppresses an assessment's own posts", async () => {
        const f = await fixture();
        await f.store.cancelTaskAssignment(f.root.taskId, f.owner.id);
        await f.post();
        await f.store.reconcileObjectiveObservations();
        const [task] = await f.store.admitMailboxTaskAssignments();
        if (!task) throw new Error("Expected observation assessment");
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "notice" });
        await f.post(task.taskId);
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "notice",
          attemptCount: 1,
          result: { failureKind: "budget-exhausted" },
          failed: true,
        });
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.blocked).toContain("failed");
        expect(
          (
            await f.other.readCoordinationInbox({
              kind: "task_attention",
              objectiveId: f.objective.id,
            })
          ).items.find((item) => item.reason.includes("without acknowledging"))?.reason,
        ).toContain("without acknowledging");
        expect((await f.state())?.cursors).toEqual({});
        expect(await f.store.listTagMessages(f.owner.id)).toHaveLength(1);
        await f.store.updateTaskAssignment(
          task.taskId,
          {
            expectedStatus: "failed",
            status: "queued",
            executionLimits: { maxReportedTokens: 1000 },
          },
          f.owner.id,
          { administrator: true },
        );
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "retry" });
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "retry",
          attemptCount: 2,
          result: {},
        });
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.pending).toBeUndefined();
        expect((await f.state())?.cursors[f.stream.id]).toBe(2);
      });
      it("acknowledges successful batches without a self-post feedback loop", async () => {
        const f = await fixture();
        await f.store.cancelTaskAssignment(f.root.taskId, f.owner.id);
        await f.post();
        await f.store.reconcileObjectiveObservations();
        const [task] = await f.store.admitMailboxTaskAssignments();
        if (!task) throw new Error("Expected assessment");
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "notice" });
        await f.post(task.taskId);
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "notice",
          attemptCount: 1,
          result: {},
        });
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.pending).toBeUndefined();
        expect((await f.state())?.cursors[f.stream.id]).toBe(2);
        expect(await f.store.listTagMessages(f.owner.id)).toHaveLength(1);
      });
      it("refuses to dissolve a configured source while its Objective is open", async () => {
        const f = await fixture();
        await f.post();
        await expect(
          f.store.updateTeam(f.stream.id, {
            expectedRevision: f.stream.revision,
            status: "dissolved",
          }),
        ).rejects.toThrow(`Observation source ${f.stream.id}`);
        expect((await f.store.getTeam(f.stream.id)).status).toBe("active");
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.blocked).toBeUndefined();
        expect(await f.store.listTagMessages(f.owner.id)).toHaveLength(1);
      });
      it("allows owner closure of a finite Objective with observations", async () => {
        const f = await fixture(100, false);
        await f.store.cancelTaskAssignment(f.root.taskId, f.owner.id);
        const closed = await f.store.updateObjectiveStatus(
          f.objective.id,
          {
            status: "completed",
            expectedRevision: 1,
            completionSummary: "Criteria verified",
          },
          f.owner.id,
        );
        expect(closed.status).toBe("completed");
      });
      it("requires operator closure of an ongoing Objective without observations", async () => {
        const f = await fixture();
        const objective = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Maintain responsibility",
          ongoing: true,
        });
        expect((await f.other.getObjective(objective.id)).ongoing).toBe(true);
        await expect(
          f.store.updateObjectiveStatus(
            objective.id,
            { status: "completed", expectedRevision: 1, completionSummary: "Done" },
            f.owner.id,
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          f.store.updateObjectiveStatus(objective.id, {
            status: "completed",
            expectedRevision: 1,
            completionSummary: "Operator ended responsibility",
          }),
        ).resolves.toMatchObject({ status: "completed" });
      });
      it("keeps an ongoing Objective owner waiting for its next valid observation", async () => {
        const f = await fixture();
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "owner" });
        const settled = await f.store.settleTaskAssignment({
          taskId: f.root.taskId,
          leaseOwner: "owner",
          attemptCount: 1,
          result: { text: "Current work is complete" },
        });
        expect(settled).toMatchObject({
          status: "waiting",
          attemptCount: 1,
          waitState: {
            workstreamPosts: { workstreamId: f.stream.id, afterSequence: 0 },
            attemptCount: 1,
          },
        });
        await f.post();
        await f.store.reconcileObjectiveObservations();
        expect(await f.store.getTaskAssignment(f.root.taskId)).toMatchObject({
          status: "queued",
          waitState: { wake: { reason: "workstream_posts" } },
        });
        expect((await f.state())?.pending).toMatchObject({
          taskId: f.root.taskId,
          attemptCount: 2,
        });
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
      });
      it("does not wake again for the batch just assessed before reconciliation", async () => {
        const f = await fixture();
        await f.post();
        await f.store.reconcileObjectiveObservations();
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "owner" });
        await f.store.settleTaskAssignment({
          taskId: f.root.taskId,
          leaseOwner: "owner",
          attemptCount: 1,
          result: { text: "Assessed the assigned batch" },
        });
        expect(await f.other.wakeWaitingTaskAssignments()).toEqual([]);
        await f.other.reconcileObjectiveObservations();
        expect((await f.state())?.cursors[f.stream.id]).toBe(1);
        expect(await f.store.wakeWaitingTaskAssignments()).toEqual([]);
        await f.post();
        expect(await f.store.wakeWaitingTaskAssignments()).toHaveLength(1);
      });
      it("allows a finite Objective owner to submit without scheduling more work", async () => {
        const f = await fixture(100, false);
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "owner" });
        expect(
          await f.store.settleTaskAssignment({
            taskId: f.root.taskId,
            leaseOwner: "owner",
            attemptCount: 1,
            result: { text: "Finished" },
          }),
        ).toMatchObject({
          status: "accepted",
          waitState: null,
          result: { closure: "owner-activation", reviewedByTagId: null },
        });
      });
      it("shows a lost owner follow-up in the operator inbox across connections", async () => {
        const missingSource = randomUUID();
        const f = await fixture(100, true, undefined, missingSource);
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.blocked).toContain(`Observation source ${missingSource}`);
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "owner" });
        await f.store.settleTaskAssignment({
          taskId: f.root.taskId,
          leaseOwner: "owner",
          attemptCount: 1,
          result: {},
        });
        const inbox = await f.other.readCoordinationInbox({
          objectiveId: f.objective.id,
          kind: "task_attention",
        });
        expect(inbox.items).toHaveLength(1);
        expect(inbox.items[0]?.reason).toContain("no scheduled work");
        expect(inbox.items[0]?.permittedActions).toEqual([]);
        // The owner's activation closed itself when it settled; nothing is left to cancel.
        expect(await f.store.getTaskAssignment(f.root.taskId)).toMatchObject({
          status: "accepted",
        });
        await f.store.updateObjectiveStatus(f.objective.id, {
          status: "completed",
          expectedRevision: 1,
          completionSummary: "Ended",
        });
        expect(
          (
            await f.other.readCoordinationInbox({
              objectiveId: f.objective.id,
              kind: "task_attention",
            })
          ).items,
        ).toEqual([]);
      });
      it("exposes a standalone observation allocation decision and resumes after operator approval", async () => {
        const f = await fixture(10, true, 10);
        await f.store.claimTaskAssignment({ taskId: f.root.taskId, leaseOwner: "root" });
        await f.store.settleTaskAssignment({
          taskId: f.root.taskId,
          leaseOwner: "root",
          attemptCount: 1,
          result: {},
        });
        await f.store.cancelTaskAssignment(f.root.taskId, f.owner.id);
        await f.post();
        await f.store.reconcileObjectiveObservations();
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        expect((await f.state())?.blocked).toContain("budget");
        const inbox = await f.store.readCoordinationInbox({
          objectiveId: f.objective.id,
          kind: "objective_budget",
        });
        expect(inbox.items).toHaveLength(1);
        expect(inbox.items[0]?.permittedActions[0]).toMatchObject({
          tool: "update_objective",
          requiredInputFields: ["budgetLimitMinor"],
        });
        await expect(
          f.store.updateObjectiveStatus(
            f.objective.id,
            { expectedRevision: 1, budgetLimitMinor: 20 },
            f.owner.id,
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        for (const limit of [0, 9, 10]) {
          await expect(
            f.store.updateObjectiveStatus(f.objective.id, {
              expectedRevision: 1,
              budgetLimitMinor: limit,
            }),
          ).rejects.toMatchObject({ statusCode: 409 });
        }
        expect((await f.store.getObjective(f.objective.id)).revision).toBe(1);
        await f.store.disconnect();
        await f.store.connect();
        const attempts = await Promise.allSettled(
          [f.store, f.other].map((store) =>
            store.updateObjectiveStatus(
              f.objective.id,
              { expectedRevision: 1, budgetLimitMinor: 20 },
              undefined,
              undefined,
              { operatorId: "test-operator" },
            ),
          ),
        );
        expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect(
          await f.store.listResourceChanges({
            resourceType: "objective",
            resourceId: f.objective.id,
          }),
        ).toMatchObject([
          {
            operatorId: "test-operator",
            changes: { budgetLimitMinor: { previous: 10, next: 20 } },
          },
        ]);
        await f.store.reconcileObjectiveObservations();
        const [notice] = await f.store.admitMailboxTaskAssignments();
        if (!notice) throw new Error("Observation not admitted after approval");
        expect(await f.store.admitMailboxTaskAssignments()).toHaveLength(0);
        expect((await f.state())?.cursors).toEqual({});
        expect(
          (
            await f.store.readCoordinationInbox({
              objectiveId: f.objective.id,
              kind: "objective_budget",
            })
          ).items,
        ).toHaveLength(0);
        await f.store.claimTaskAssignment({ taskId: notice.taskId, leaseOwner: "notice" });
        await f.store.settleTaskAssignment({
          taskId: notice.taskId,
          leaseOwner: "notice",
          attemptCount: 1,
          result: { text: "Assessed" },
        });
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.cursors[f.stream.id]).toBe(1);
      });
      it("admits zero-allocation observations at the limit and forbids agent completion", async () => {
        const f = await fixture(0);
        await f.post();
        await f.store.reconcileObjectiveObservations();
        expect((await f.state())?.blocked).toBeUndefined();
        expect(await f.store.listTagMessages(f.owner.id)).toHaveLength(1);
        expect((await f.state())?.pending?.taskId).toBe(f.root.taskId);
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        await expect(
          f.store.updateObjectiveStatus(
            f.objective.id,
            { status: "completed", expectedRevision: 1, completionSummary: "Done" },
            f.owner.id,
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
      });
    },
  );
}
