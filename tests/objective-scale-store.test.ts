import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AdmitTaskAssignmentInput,
  Tag,
  TaskAssignment,
  Team,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} 100-agent assignment stress`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      it("preserves budgets, Team capacity, dependencies and execution fences across connections", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supertag-scale-store-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          if (!postgres) throw new Error("PostgreSQL test URL missing");
          const isolated = await createIsolatedPostgresDatabase(postgres);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        if (!url) throw new Error("PostgreSQL test URL missing");
        await migrateDatabase({ url });
        const stores = await Promise.all(
          Array.from({ length: 8 }, async () => {
            const store = new DrizzleStore({ url });
            await store.connect();
            cleanups.push(() => store.disconnect());
            return store;
          }),
        );
        const connection = (index: number): DrizzleStore => {
          const store = stores[index % stores.length];
          if (!store) throw new Error("Missing test connection");
          return store;
        };
        const store = connection(0);
        const prefix = randomUUID();
        const owner = await store.createTag({ name: `${prefix}-owner` });
        const workers = await Promise.all(
          Array.from({ length: 100 }, (_, index) =>
            connection(index).createTag({ name: `${prefix}-agent-${index}` }),
          ),
        );
        const workerAt = (index: number): Tag => {
          const worker = workers[index];
          if (!worker) throw new Error("Missing worker Tag");
          return worker;
        };
        const objective = await store.createObjective({
          id: prefix,
          ownerTagId: owner.id,
          outcome: "Complete 100 bounded assignments within resource limits",
          budgetLimitMinor: 1000,
        });
        const roots = await Promise.all(
          [0, 1].map((index) =>
            connection(index).createTeam(
              {
                id: `${prefix}-root-${index}`,
                objectiveId: objective.id,
                name: `Division ${index}`,
                leadTagId: owner.id,
                memberTagIds: workers.slice(index * 50, index * 50 + 50).map((worker) => worker.id),
                maxConcurrency: 6,
              },
              owner.id,
            ),
          ),
        );
        const children = await Promise.all(
          Array.from({ length: 10 }, (_, index) => {
            const parent = roots[Math.floor(index / 5)];
            if (!parent) throw new Error("Missing parent Team");
            return connection(index).createTeam(
              {
                id: `${prefix}-child-${index}`,
                objectiveId: objective.id,
                name: `Team ${index}`,
                leadTagId: owner.id,
                memberTagIds: workers.slice(index * 10, index * 10 + 10).map((worker) => worker.id),
                parentTeamId: parent.id,
                maxConcurrency: 3,
              },
              owner.id,
            );
          }),
        );
        const teamFor = (index: number): Team => {
          const team = children[Math.floor(index / 10)];
          if (!team) throw new Error("Missing child Team");
          return team;
        };
        const at = new Date().toISOString();
        const assignment = (
          index: number,
          extra: Partial<AdmitTaskAssignmentInput> = {},
        ): AdmitTaskAssignmentInput => {
          const worker = workerAt(index);
          return {
            taskId: `${prefix}-task-${index}`,
            objectiveId: objective.id,
            teamId: teamFor(index).id,
            assignedTagId: worker.id,
            requestedByTagId: owner.id,
            instruction: `Produce validated result ${index}`,
            acceptanceCriteria: [`Result ${index} matches its assignment`],
            execution: {},
            workspacePlan: { version: 1, status: "none" },
            contextPlan: { version: 7, capturedAt: at, sets: [] },
            authorizationSnapshot: {
              version: 4,
              capturedAt: at,
              tag: { id: worker.id, name: worker.name },
              origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
              requester: { id: owner.id, kind: "bot" },
              permissionSets: [],
              resources: [],
              runtimeActions: [],
            },
            maxCostMinor: 10,
            ...extra,
          };
        };
        const gate = await store.admitTaskAssignment(
          assignment(0, { taskId: `${prefix}-gate`, maxCostMinor: 0 }),
        );
        const inputs = Array.from({ length: 100 }, (_, index) =>
          assignment(index, {
            // Two workers per child Team wait on a gate that will be superseded.
            dependencies: index % 10 < 2 ? [gate.taskId] : [],
          }),
        );
        const duplicates = await Promise.all(
          inputs.flatMap((input, index) => [
            connection(index).admitTaskAssignment(input),
            connection(index + 1).admitTaskAssignment(input),
            connection(index + 2).admitTaskAssignment(input),
          ]),
        );
        const admitted = [...new Map(duplicates.map((task) => [task.taskId, task])).values()];
        expect(new Set(duplicates.map((task) => task.taskId)).size).toBe(100);
        expect((await store.listTaskAssignments(objective.id)).length).toBe(101);
        expect(await store.getObjective(objective.id)).toMatchObject({
          spentMinor: 0,
          reservedMinor: 1000,
        });
        const overflow = await Promise.allSettled(
          Array.from({ length: 20 }, (_, index) =>
            connection(index).admitTaskAssignment(
              assignment(index, { taskId: `${prefix}-overflow-${index}`, maxCostMinor: 1 }),
            ),
          ),
        );
        expect(overflow.every((result) => result.status === "rejected")).toBe(true);
        for (const result of overflow)
          if (result.status === "rejected")
            expect(result.reason).toMatchObject({ statusCode: 409 });
        await expect(
          store.admitTaskAssignment({ ...assignment(2), instruction: "Mutated duplicate" }),
        ).rejects.toMatchObject({ statusCode: 409 });

        // Reopen every database connection before dispatch: admission cannot rely on process memory.
        await Promise.all(stores.map((connection) => connection.disconnect()));
        await Promise.all(stores.map((connection) => connection.connect()));
        expect((await store.listTaskAssignments(objective.id)).length).toBe(101);

        const claim = async (tasks: readonly TaskAssignment[], round: number) => {
          const claims = await Promise.all(
            tasks.map((task, index) =>
              connection(index).claimTaskAssignment({
                taskId: task.taskId,
                leaseOwner: `${prefix}-executor-${round}-${index}`,
                leaseSeconds: 300,
              }),
            ),
          );
          const running = claims.filter((task): task is TaskAssignment => task !== undefined);
          // Each child Team's own limit of 3 binds; the Division limit of 6 counts only its own work.
          expect(running.length).toBeLessThanOrEqual(30);
          const persisted = (await store.listTaskAssignments(objective.id)).filter(
            (task) => task.status === "running",
          );
          expect(persisted).toHaveLength(running.length);
          for (const child of children)
            expect(persisted.filter((task) => task.teamId === child.id).length).toBeLessThanOrEqual(
              3,
            );
          expect(running.every((task) => task.dependencies.length === 0)).toBe(true);
          return running;
        };
        const first = await claim(admitted, 0);
        expect(first).toHaveLength(30);
        await Promise.all(
          first.map((task, index) => connection(index).cancelTaskAssignment(task.taskId, owner.id)),
        );
        const stale = await Promise.allSettled(
          first.map((task, index) =>
            connection(index + 1).settleTaskAssignment({
              taskId: task.taskId,
              leaseOwner: task.leaseOwner ?? "missing",
              attemptCount: task.attemptCount,
              result: { stale: true },
            }),
          ),
        );
        expect(stale.every((result) => result.status === "rejected")).toBe(true);
        for (const result of stale)
          if (result.status === "rejected")
            expect(result.reason).toMatchObject({ statusCode: 409 });
        await store.cancelTaskAssignment(gate.taskId, owner.id);

        let accepted = 0;
        for (let round = 1; round <= 20; round++) {
          const queued = (await store.listTaskAssignments(objective.id)).filter(
            (task) => task.status === "queued",
          );
          const running = await claim(queued, round);
          if (running.length === 0) break;
          await Promise.all(
            running.map(async (task, index) => {
              await connection(index).settleTaskAssignment({
                taskId: task.taskId,
                leaseOwner: task.leaseOwner ?? "missing",
                attemptCount: task.attemptCount,
                result: { validated: task.taskId },
              });
              await connection(index + 1).reviewTaskAssignment(
                task.taskId,
                owner.id,
                true,
                "Evidence matches acceptance criteria",
              );
            }),
          );
          accepted += running.length;
        }
        expect(accepted).toBe(50);
        const blocked = (await store.listTaskAssignments(objective.id)).filter(
          (task) => task.status === "queued",
        );
        expect(blocked).toHaveLength(20);
        expect(blocked.every((task) => task.dependencies.includes(gate.taskId))).toBe(true);
        expect(await store.getObjective(objective.id)).toMatchObject({
          spentMinor: 800,
          reservedMinor: 200,
        });
        await Promise.all(
          blocked.map((task, index) =>
            connection(index).cancelTaskAssignment(task.taskId, owner.id),
          ),
        );
        expect(await store.getObjective(objective.id)).toMatchObject({
          spentMinor: 800,
          reservedMinor: 0,
        });
        const final = await store.listTaskAssignments(objective.id);
        expect(final.filter((task) => task.status === "accepted")).toHaveLength(50);
        expect(final.filter((task) => task.status === "cancelled")).toHaveLength(51);
        expect(final.reduce((sum, task) => sum + (task.chargedMinor ?? 0), 0)).toBe(800);
        for (const task of final) {
          const canonical = await connection(task.attemptCount).findTaskById(task.taskId);
          expect(canonical?.inboundEventId).toBeNull();
          expect(canonical?.status).toBe(task.status === "accepted" ? "completed" : "cancelled");
        }
      }, 30000);
    },
  );
}
