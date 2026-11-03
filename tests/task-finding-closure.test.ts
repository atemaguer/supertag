import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import type { TaskAssignment } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const lists = { decisions: [], changes: [], unresolved: [], references: [], artifacts: [] };
const reported = [
  { severity: "high", summary: "The export skips tenant scoping.", location: "query.ts:42" },
  { severity: "medium", summary: "Retries are unbounded." },
  { severity: "low", summary: "README misspells ledger." },
];

function findingsOf(task: TaskAssignment | undefined): Record<string, unknown>[] {
  const taskResult = task?.result?.["taskResult"] as
    | { findings: Record<string, unknown>[] }
    | undefined;
  if (!taskResult) throw new Error("Task has no result");
  return taskResult.findings;
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} closing findings`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      let url: string;
      if (dialect === "postgresql") {
        if (!postgres) throw new Error("Missing test database");
        const isolated = await createIsolatedPostgresDatabase(postgres);
        cleanups.push(isolated.cleanup);
        url = isolated.url;
      } else {
        const directory = await mkdtemp(join(tmpdir(), "supertag-finding-closure-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        url = `file:${join(directory, "state.db")}`;
      }
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      const reviewer = await store.createTag({ name: `reviewer-${randomUUID()}` });
      const builder = await store.createTag({ name: `builder-${randomUUID()}` });
      for (const tag of [owner, reviewer, builder])
        await store.bindTagWorkerHost(tag.id, "fixture-host");
      // No Worklet: the test claims and settles each Task itself.
      const controller = new ObjectiveController(store, undefined);
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Close review findings",
      });
      const team = await store.createTeam({
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Delivery",
        leadTagId: owner.id,
        memberTagIds: [reviewer.id, builder.id],
        maxConcurrency: 10,
      });
      await controller.command("start_objective", { objectiveId: objective.id });
      // A Task this Control Plane leased, with a recorded Attempt, calls tools as its Tag.
      const leaseOwner = (controller as unknown as { instanceId: string }).instanceId;
      const run = async (taskId: string) => {
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
      const ownerCaller = await run(`${objective.id}:start`);
      const assign = async (
        assignedTagId: string,
        objectiveId = objective.id,
        teamId = team.id,
      ): Promise<TaskAssignment> => {
        const task = (await controller.command("assign_task", {
          objectiveId,
          taskId: randomUUID(),
          teamId,
          assignedTagId,
          instruction: "Review the change",
          acceptanceCriteria: ["Findings reported"],
        })) as TaskAssignment;
        return run(task.taskId);
      };
      const settle = (
        task: TaskAssignment,
        findings: unknown[],
        fixedFindings?: { taskId: string; findingId: string }[],
      ) =>
        store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner,
          attemptCount: task.attemptCount,
          result: {
            text: "Reviewed",
            taskResult: {
              summary: "Reviewed",
              ...lists,
              findings,
              ...(fixedFindings ? { fixedFindings } : {}),
            },
          },
        });
      const asOwner = (input: Record<string, unknown>) =>
        controller.commandAsAttempt("update_task", input, ownerCaller);
      const accept = (taskId: string) =>
        asOwner({ taskId, expectedStatus: "submitted", status: "accepted", assessment: "Ok" });
      const review = await assign(reviewer.id);
      await settle(review, reported);
      return {
        store,
        controller,
        objective,
        team,
        owner,
        reviewer,
        builder,
        assign,
        settle,
        asOwner,
        accept,
        review,
      };
    }

    it("lets the owner close a medium as fixed and a low as accepted, recording who and when", async () => {
      const f = await fixture();
      const before = new Date().toISOString();
      await f.asOwner({
        taskId: f.review.taskId,
        expectedStatus: "submitted",
        finding: { id: "F2", status: "fixed", fixedBy: "4f9c2a1" },
      });
      await f.asOwner({
        taskId: f.review.taskId,
        expectedStatus: "submitted",
        finding: { id: "F3", status: "accepted", reason: "Docs typo, tracked separately" },
      });
      const stored = await f.store.getTaskAssignment(f.review.taskId);
      // Closing a finding leaves the Task itself as it was.
      expect(stored?.status).toBe("submitted");
      const [high, medium, low] = findingsOf(stored);
      expect(high).toMatchObject({ id: "F1", status: "open" });
      expect(high).not.toHaveProperty("closedBy");
      expect(medium).toEqual({
        id: "F2",
        severity: "medium",
        summary: "Retries are unbounded.",
        status: "fixed",
        fixedBy: "4f9c2a1",
        closedBy: { tagId: f.owner.id },
        closedAt: expect.any(String),
      });
      expect(low).toMatchObject({
        id: "F3",
        status: "accepted",
        reason: "Docs typo, tracked separately",
        closedBy: { tagId: f.owner.id },
      });
      expect(String(medium?.["closedAt"]) >= before).toBe(true);
      const detail = (await f.controller.commandAsAdministrator("read_task", {
        objectiveId: f.objective.id,
        taskId: f.review.taskId,
      })) as { openFindings: { high: unknown[]; medium: unknown[]; low: unknown[] } };
      expect(detail.openFindings.high).toHaveLength(1);
      expect(detail.openFindings.medium).toEqual([]);
      expect(detail.openFindings.low).toEqual([]);
      const events = await f.store.listTaskEvents(f.review.taskId);
      expect(
        events
          .filter((event) => event.type === "task.finding-closed")
          .map((event) => (event.payload as { finding: { id: string } }).finding.id),
      ).toEqual(["F2", "F3"]);

      // A closed finding stays closed, and each call changes one field.
      await expect(
        f.asOwner({
          taskId: f.review.taskId,
          expectedStatus: "submitted",
          finding: { id: "F2", status: "accepted", reason: "Again" },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        f.asOwner({
          taskId: f.review.taskId,
          expectedStatus: "submitted",
          status: "accepted",
          assessment: "Ok",
          finding: { id: "F1", status: "accepted", reason: "No" },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        f.asOwner({
          taskId: f.review.taskId,
          expectedStatus: "submitted",
          finding: { id: "F1", status: "fixed" },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        f.asOwner({
          taskId: f.review.taskId,
          expectedStatus: "submitted",
          finding: { id: "F9", status: "accepted", reason: "No" },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("refuses the owner closing a high, and lets an operator close it", async () => {
      const f = await fixture();
      for (const finding of [
        { id: "F1", status: "fixed", fixedBy: "4f9c2a1" },
        { id: "F1", status: "accepted", reason: "Out of scope" },
      ])
        await expect(
          f.asOwner({ taskId: f.review.taskId, expectedStatus: "submitted", finding }),
        ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("re-review") });
      expect(findingsOf(await f.store.getTaskAssignment(f.review.taskId))[0]).toMatchObject({
        status: "open",
      });

      await f.controller.commandAsAdministrator(
        "update_task",
        {
          objectiveId: f.objective.id,
          taskId: f.review.taskId,
          expectedStatus: "submitted",
          finding: { id: "F1", status: "accepted", reason: "Single-tenant deployment" },
        },
        {
          kind: "operator-token",
          operatorId: "alice",
          scopes: { actions: ["*"] },
        } as never,
      );
      expect(findingsOf(await f.store.getTaskAssignment(f.review.taskId))[0]).toMatchObject({
        status: "accepted",
        reason: "Single-tenant deployment",
        closedBy: { operatorId: "alice" },
        closedAt: expect.any(String),
      });
    });

    it("closes a high as fixed only when the owner accepts a re-review by the reporting Tag", async () => {
      const f = await fixture();
      // A builder claiming its own fix closes nothing, even once its result is accepted.
      const fix = await f.assign(f.builder.id);
      await f.settle(fix, [], [{ taskId: f.review.taskId, findingId: "F1" }]);
      const acceptedFix = (await f.accept(fix.taskId)) as TaskAssignment;
      expect(acceptedFix.result?.["findingClosures"]).toEqual([
        {
          taskId: f.review.taskId,
          findingId: "F1",
          outcome: "refused",
          reason: "Only the Tag that reported a finding can confirm it fixed",
        },
      ]);
      expect(findingsOf(await f.store.getTaskAssignment(f.review.taskId))[0]).toMatchObject({
        status: "open",
      });

      // The reviewer's re-review names the finding; submitting alone does not close it.
      const reReview = await f.assign(f.reviewer.id);
      await f.settle(
        reReview,
        [],
        [
          { taskId: f.review.taskId, findingId: "F1" },
          { taskId: reReview.taskId, findingId: "F1" },
        ],
      );
      expect(findingsOf(await f.store.getTaskAssignment(f.review.taskId))[0]).toMatchObject({
        status: "open",
      });
      const acceptedReReview = (await f.accept(reReview.taskId)) as TaskAssignment;
      expect(acceptedReReview.result?.["findingClosures"]).toEqual([
        { taskId: f.review.taskId, findingId: "F1", outcome: "closed" },
        {
          taskId: reReview.taskId,
          findingId: "F1",
          outcome: "refused",
          reason: "A Task cannot close findings on its own result",
        },
      ]);
      const [high, medium] = findingsOf(await f.store.getTaskAssignment(f.review.taskId));
      expect(high).toMatchObject({
        id: "F1",
        severity: "high",
        status: "fixed",
        fixedBy: reReview.taskId,
        closedBy: { tagId: f.reviewer.id, taskId: reReview.taskId },
        closedAt: expect.any(String),
      });
      expect(medium).toMatchObject({ id: "F2", status: "open" });
    });

    it("refuses a re-review created before the finding was recorded", async () => {
      const f = await fixture();
      // The reviewer Tag runs two Tasks at once (as in dogfood). Its unrelated Task B settles
      // first and speculatively names a finding on review A that A has not reported yet.
      const reviewA = await f.assign(f.reviewer.id);
      const unrelatedB = await f.assign(f.reviewer.id);
      await f.settle(unrelatedB, [], [{ taskId: reviewA.taskId, findingId: "F1" }]);
      // Only afterwards does review A report its high finding.
      await f.settle(reviewA, reported);
      const accepted = await f.accept(unrelatedB.taskId);
      expect((accepted as TaskAssignment).result?.["findingClosures"]).toEqual([
        {
          taskId: reviewA.taskId,
          findingId: "F1",
          outcome: "refused",
          reason: "The re-review was created before the finding was recorded",
        },
      ]);
      expect(findingsOf(await f.store.getTaskAssignment(reviewA.taskId))[0]).toMatchObject({
        severity: "high",
        status: "open",
      });
    });

    it("refuses closure by a child Team lead without authority over the finding Task", async () => {
      const f = await fixture();
      // The builder leads a child Team that includes the reviewer; it has no authority over
      // the review Task in the parent Team, so it cannot close its findings directly.
      const child = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Child",
        leadTagId: f.builder.id,
        memberTagIds: [f.reviewer.id],
        parentTeamId: f.team.id,
        maxConcurrency: 10,
      });
      const leadTask = await f.assign(f.builder.id, f.objective.id, child.id);
      await expect(
        f.controller.commandAsAttempt(
          "update_task",
          {
            taskId: f.review.taskId,
            expectedStatus: "submitted",
            finding: { id: "F2", status: "accepted", reason: "Direct" },
          },
          leadTask,
        ),
      ).rejects.toThrow();
      // A "re-review" by the reviewer in the child Team, accepted by the child lead.
      const assigned = (await f.controller.commandAsAttempt(
        "assign_task",
        {
          taskId: randomUUID(),
          teamId: child.id,
          assignedTagId: f.reviewer.id,
          instruction: "Confirm the fix",
          acceptanceCriteria: ["Confirmed"],
        },
        leadTask,
      )) as TaskAssignment;
      const leaseOwner = (f.controller as unknown as { instanceId: string }).instanceId;
      const reReview = await f.store.claimTaskAssignment({ taskId: assigned.taskId, leaseOwner });
      if (!reReview) throw new Error("not claimed");
      await f.store.createTaskAttempt({
        taskId: reReview.taskId,
        attemptNumber: reReview.attemptCount,
        workerProfile: { id: "fixture", revision: "1" },
        workerSnapshot: {},
        startedAt: new Date().toISOString(),
      });
      await f.settle(reReview, [], [{ taskId: f.review.taskId, findingId: "F1" }]);
      const accepted = (await f.controller.commandAsAttempt(
        "update_task",
        {
          taskId: reReview.taskId,
          expectedStatus: "submitted",
          status: "accepted",
          assessment: "Ok",
        },
        leadTask,
      )) as TaskAssignment;
      expect(accepted.result?.["findingClosures"]).toEqual([
        {
          taskId: f.review.taskId,
          findingId: "F1",
          outcome: "refused",
          reason: "Only the finding Task's Objective owner or Team lead can close its findings",
        },
      ]);
      expect(findingsOf(await f.store.getTaskAssignment(f.review.taskId))[0]).toMatchObject({
        severity: "high",
        status: "open",
      });
    });

    it("refuses closing findings from a foreign Task or another Objective", async () => {
      const f = await fixture();
      // A running builder Task is neither the owner nor the Team lead.
      const foreign = await f.assign(f.builder.id);
      await expect(
        f.controller.commandAsAttempt(
          "update_task",
          {
            taskId: f.review.taskId,
            expectedStatus: "submitted",
            finding: { id: "F2", status: "accepted", reason: "Forged" },
          },
          foreign,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      // The reporting reviewer cannot close its findings directly either.
      const reviewerTask = await f.assign(f.reviewer.id);
      await expect(
        f.controller.commandAsAttempt(
          "update_task",
          {
            taskId: f.review.taskId,
            expectedStatus: "submitted",
            finding: { id: "F1", status: "fixed", fixedBy: "4f9c2a1" },
          },
          reviewerTask,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      // A worker cannot forge a closure into its own result either: settlement reopens it,
      // and drops any closure outcomes it claims.
      await f.store.settleTaskAssignment({
        taskId: reviewerTask.taskId,
        leaseOwner: (f.controller as unknown as { instanceId: string }).instanceId,
        attemptCount: reviewerTask.attemptCount,
        result: {
          text: "Reviewed",
          findingClosures: [{ taskId: f.review.taskId, findingId: "F1", outcome: "closed" }],
          taskResult: { summary: "Reviewed", ...lists, findings: [] },
        },
      });
      expect((await f.store.getTaskAssignment(reviewerTask.taskId))?.result).not.toHaveProperty(
        "findingClosures",
      );
      await f.settle(foreign, [
        {
          severity: "high",
          summary: "Forged closure.",
          status: "fixed",
          fixedBy: "x",
          closedBy: { operatorId: "alice" },
          closedAt: "2026-10-04T12:00:00.000Z",
        },
      ]);
      expect(findingsOf(await f.store.getTaskAssignment(foreign.taskId))).toEqual([
        { id: "F1", severity: "high", summary: "Forged closure.", status: "open" },
      ]);

      // The same reviewer's Task in another Objective cannot close this Objective's findings.
      const other = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.owner.id,
        outcome: "Elsewhere",
      });
      const otherTeam = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: other.id,
        name: "Elsewhere",
        leadTagId: f.owner.id,
        memberTagIds: [f.reviewer.id],
        maxConcurrency: 10,
      });
      await f.controller.command("start_objective", { objectiveId: other.id });
      const elsewhere = await f.assign(f.reviewer.id, other.id, otherTeam.id);
      await f.settle(elsewhere, [], [{ taskId: f.review.taskId, findingId: "F1" }]);
      const accepted = (await f.controller.commandAsAdministrator("update_task", {
        objectiveId: other.id,
        taskId: elsewhere.taskId,
        expectedStatus: "submitted",
        status: "accepted",
        assessment: "Ok",
      })) as TaskAssignment;
      expect(accepted.result?.["findingClosures"]).toEqual([
        {
          taskId: f.review.taskId,
          findingId: "F1",
          outcome: "refused",
          reason: "No such Task in this Objective",
        },
      ]);
      expect(findingsOf(await f.store.getTaskAssignment(f.review.taskId))[0]).toMatchObject({
        status: "open",
      });
    });
  });
}
