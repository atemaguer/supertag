import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskResourceFromStore } from "../apps/cli/src/control-plane-resources.ts";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import type { TaskAssignment } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const lists = { decisions: [], changes: [], unresolved: [], references: [], artifacts: [] };

function storedFindings(task: TaskAssignment | undefined): unknown {
  return (task?.result?.["taskResult"] as Record<string, unknown> | undefined)?.["findings"];
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Task result findings`,
    // Each fixture migrates a fresh database, which can take seconds under a parallel run.
    { timeout: 30_000 },
    () => {
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
          const directory = await mkdtemp(join(tmpdir(), "supertag-findings-"));
          cleanups.push(() => rm(directory, { recursive: true, force: true }));
          url = `file:${join(directory, "state.db")}`;
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const worker = await store.createTag({ name: `worker-${randomUUID()}` });
        for (const tag of [owner, worker]) await store.bindTagWorkerHost(tag.id, "fixture-host");
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Review findings",
        });
        const team = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Review",
          leadTagId: owner.id,
          memberTagIds: [worker.id],
          maxConcurrency: 2,
        });
        // No Worklet: the test claims and settles each Task itself.
        const controller = new ObjectiveController(store, undefined);
        await controller.command("start_objective", { objectiveId: objective.id });
        const assign = async (instruction: string) => {
          const task = (await controller.command("assign_task", {
            objectiveId: objective.id,
            taskId: randomUUID(),
            teamId: team.id,
            assignedTagId: worker.id,
            instruction,
            acceptanceCriteria: ["Findings reported"],
          })) as TaskAssignment;
          const claimed = await store.claimTaskAssignment({
            taskId: task.taskId,
            leaseOwner: "worker",
          });
          if (!claimed) throw new Error("Fixture Task could not be claimed");
          return claimed;
        };
        const settle = (task: TaskAssignment, findings: unknown[]) =>
          store.settleTaskAssignment({
            taskId: task.taskId,
            leaseOwner: "worker",
            attemptCount: task.attemptCount,
            result: { text: "Reviewed", taskResult: { summary: "Reviewed", ...lists, findings } },
          });
        return {
          store,
          controller,
          objective,
          a: await assign("Review A"),
          b: await assign("Review B"),
          settle,
        };
      }

      it("records findings for the settling Task only, with Control Plane ids and open status", async () => {
        const f = await fixture();
        await f.settle(f.a, [
          {
            id: "F9",
            severity: "medium",
            summary: "Missing guard",
            location: "src/a.ts:10",
            status: "fixed",
          },
          {
            severity: "high",
            summary: "Unchecked input",
            status: "accepted",
            reason: "Out of scope",
          },
        ]);

        const recorded = [
          {
            id: "F1",
            severity: "medium",
            summary: "Missing guard",
            location: "src/a.ts:10",
            status: "open",
          },
          { id: "F2", severity: "high", summary: "Unchecked input", status: "open" },
        ];
        expect(storedFindings(await f.store.getTaskAssignment(f.a.taskId))).toEqual(recorded);
        const b = await f.store.getTaskAssignment(f.b.taskId);
        expect(b).toMatchObject({ status: "running" });
        expect(b?.result).toBeNull();

        const detail = (await f.controller.commandAsAdministrator("read_task", {
          objectiveId: f.objective.id,
          taskId: f.a.taskId,
        })) as { openFindings: unknown };
        expect(detail.openFindings).toEqual({
          high: [recorded[1]],
          medium: [recorded[0]],
          low: [],
        });
        const other = (await f.controller.commandAsAdministrator("read_task", {
          objectiveId: f.objective.id,
          taskId: f.b.taskId,
        })) as { openFindings: unknown };
        expect(other.openFindings).toEqual({ high: [], medium: [], low: [] });

        // `supertag describe task` reads the same open findings from the store.
        const task = await f.store.findTaskById(f.a.taskId);
        expect(task).toBeDefined();
        const resource = await taskResourceFromStore(f.store, task as never);
        expect(resource.status.openFindings).toEqual({
          high: [recorded[1]],
          medium: [recorded[0]],
          low: [],
        });
      });

      it("reads a corrupt stored findings record as unreadable instead of failing read_task", async () => {
        const f = await fixture();
        await f.settle(f.a, [{ severity: "high", summary: "Unchecked input" }]);
        const read = f.store.getTaskAssignment.bind(f.store);
        // Simulates a record corrupted in storage: settlement itself refuses such findings.
        f.store.getTaskAssignment = async (...args: Parameters<typeof read>) => {
          const task = await read(...args);
          if (task?.taskId !== f.a.taskId || !task.result) return task;
          const taskResult = task.result["taskResult"] as Record<string, unknown>;
          return {
            ...task,
            result: {
              ...task.result,
              taskResult: { ...taskResult, findings: [{ id: "F1", severity: "critical" }] },
            },
          };
        };
        const detail = (await f.controller.commandAsAdministrator("read_task", {
          objectiveId: f.objective.id,
          taskId: f.a.taskId,
        })) as { openFindings: unknown };
        expect(detail.openFindings).toEqual({
          unreadable:
            "Stored Task result findings are invalid: Task finding severity must be high, medium, or low",
        });
      });

      it("refuses a finding that names another Task or carries an unknown severity", async () => {
        const f = await fixture();
        await expect(
          f.settle(f.a, [{ severity: "high", summary: "Belongs elsewhere", taskId: f.b.taskId }]),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
          f.settle(f.a, [{ severity: "critical", summary: "Unknown severity" }]),
        ).rejects.toMatchObject({ statusCode: 400 });

        for (const task of [f.a, f.b]) {
          const stored = await f.store.getTaskAssignment(task.taskId);
          expect(stored).toMatchObject({ status: "running", attemptCount: task.attemptCount });
          expect(stored?.result).toBeNull();
        }
      });

      it("discards top-level findings on settlement", async () => {
        const f = await fixture();
        await f.store.settleTaskAssignment({
          taskId: f.a.taskId,
          leaseOwner: "worker",
          attemptCount: f.a.attemptCount,
          result: {
            text: "Reviewed",
            findings: [{ severity: "high", summary: "Forged top-level finding" }],
            taskResult: { summary: "Reviewed", ...lists, findings: [] },
          },
        });
        const result = (await f.store.getTaskAssignment(f.a.taskId))?.result;
        expect(result?.["findings"]).toBeUndefined();
        expect(storedFindings(await f.store.getTaskAssignment(f.a.taskId))).toEqual([]);
      });

      it("blocks owner review and completion on an open high, naming the finding", async () => {
        const f = await fixture();
        await f.settle(f.a, [
          { severity: "high", summary: "Missing authorization", location: "src/auth.ts:42" },
        ]);
        await f.store.reviewTaskAssignment(f.a.taskId, f.objective.ownerTagId, true, "Confirmed");
        for (const status of ["ready_for_review", "completed"] as const)
          await expect(
            f.store.updateObjectiveStatus(
              f.objective.id,
              {
                status,
                expectedRevision: 1,
                completionSummary: "Reviewed",
              },
              f.objective.ownerTagId,
            ),
          ).rejects.toThrow(`${f.a.taskId} F1: Missing authorization (src/auth.ts:42)`);
        expect((await f.store.getObjective(f.objective.id)).status).toBe("working");
        const overview = await f.controller.readObjectiveOverview({ objectiveId: f.objective.id });
        expect(overview.openHighFindings).toEqual([
          {
            taskId: f.a.taskId,
            id: "F1",
            severity: "high",
            summary: "Missing authorization",
            location: "src/auth.ts:42",
            status: "open",
          },
        ]);
        const inbox = await f.store.readCoordinationInbox({
          objectiveId: f.objective.id,
          kind: "task_attention",
        });
        expect(
          inbox.items.some((item) =>
            item.reason?.includes(`${f.a.taskId} F1: Missing authorization`),
          ),
        ).toBe(true);
        const cancelled = await f.store.cancelObjective(
          f.objective.id,
          { reason: "Operator decision" },
          { operatorId: "operator" },
        );
        expect(cancelled.objective.status).toBe("cancelled");
      });

      it("includes open medium and low findings in the stored completion summary", async () => {
        const f = await fixture();
        await f.settle(f.a, [
          { severity: "medium", summary: "Missing retry", location: "src/queue.ts:12" },
          { severity: "low", summary: "Unclear label" },
        ]);
        await f.store.reviewTaskAssignment(f.a.taskId, f.objective.ownerTagId, true, "Confirmed");
        await f.store.cancelTaskAssignment(f.b.taskId, f.objective.ownerTagId);
        for (const task of await f.store.listTaskAssignments(f.objective.id))
          if (
            task.taskId !== f.a.taskId &&
            task.taskId !== f.b.taskId &&
            ["queued", "running", "waiting", "submitted"].includes(task.status)
          )
            await f.store.cancelTaskAssignment(task.taskId, f.objective.ownerTagId);
        const completed = await f.store.updateObjectiveStatus(f.objective.id, {
          status: "completed",
          expectedRevision: 1,
          completionSummary: "Done.",
        });
        expect(completed.completionSummary).toContain(
          `${f.a.taskId} F1: Missing retry (src/queue.ts:12)`,
        );
        expect(completed.completionSummary).toContain(`${f.a.taskId} F2: Unclear label`);
      });

      it("records open highs and the operator on direct completion and approval", async () => {
        for (const approval of [false, true]) {
          const f = await fixture();
          await f.settle(f.a, [
            { severity: "high", summary: "Missing authorization", location: "src/auth.ts:42" },
          ]);
          await f.store.reviewTaskAssignment(f.a.taskId, f.objective.ownerTagId, true, "Confirmed");
          for (const task of await f.store.listTaskAssignments(f.objective.id))
            if (["queued", "running", "waiting", "submitted"].includes(task.status))
              await f.store.cancelTaskAssignment(task.taskId, f.objective.ownerTagId);
          if (approval)
            await f.store.updateObjectiveStatus(
              f.objective.id,
              {
                status: "ready_for_review",
                expectedRevision: 1,
                completionSummary: "Owner assessment.",
              },
              undefined,
              undefined,
              { operatorId: "review-operator" },
            );
          const completed = approval
            ? await f.controller.approveObjective(
                { objectiveId: f.objective.id },
                { operatorId: "review-operator", scopes: { actions: ["*"] } },
              )
            : await f.store.updateObjectiveStatus(
                f.objective.id,
                {
                  status: "completed",
                  expectedRevision: 1,
                  completionSummary: "Operator decision.",
                },
                undefined,
                undefined,
                { operatorId: "review-operator" },
              );
          expect(completed.completionSummary).toContain("Operator review-operator completed");
          expect(completed.completionSummary).toContain(
            `${f.a.taskId} F1: Missing authorization (src/auth.ts:42)`,
          );
          expect((await f.store.getObjective(f.objective.id)).completionSummary).toBe(
            completed.completionSummary,
          );
        }
      });
    },
  );
}
