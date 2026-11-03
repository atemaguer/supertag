import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

// Under a busy full-suite run these tests can exceed vitest's 5-second default timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Workspace pull-request transitions`,
    { timeout: 30_000 },
    () => {
      const cleanups: Array<() => Promise<unknown> | unknown> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      it("stores one pending transition per Task and lists those that are due", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supertag-pr-transitions-"));
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
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Ship it",
        });
        const team = await store.createTeam({
          id: `${objective.id}:leadership`,
          objectiveId: objective.id,
          name: "Leadership",
          leadTagId: owner.id,
          memberTagIds: [owner.id],
          maxConcurrency: 1,
        });
        const admit = async () => {
          const at = new Date().toISOString();
          return store.admitTaskAssignment({
            taskId: randomUUID(),
            objectiveId: objective.id,
            teamId: team.id,
            requestedByTagId: owner.id,
            assignedTagId: owner.id,
            instruction: "Change it",
            acceptanceCriteria: ["Changed"],
            maxCostMinor: 0,
            execution: {},
            workspacePlan: { version: 1, status: "none" },
            contextPlan: emptyTagContextPlan(at),
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
        };
        const [first, second] = [await admit(), await admit()];
        const transition = {
          url: "https://github.com/acme/app/pull/7",
          action: "close" as const,
          lastError: "GitHub pull request close failed with HTTP 503",
        };
        await store.saveWorkspacePullRequestTransition({
          ...transition,
          taskId: first.taskId,
          attemptCount: 1,
          nextAttemptAt: "2026-09-30T12:01:00.000Z",
        });
        await store.saveWorkspacePullRequestTransition({
          ...transition,
          taskId: second.taskId,
          attemptCount: 1,
          nextAttemptAt: "2026-09-30T12:05:00.000Z",
        });
        // Saving again replaces the Task's transition instead of adding another.
        await store.saveWorkspacePullRequestTransition({
          ...transition,
          taskId: first.taskId,
          attemptCount: 2,
          nextAttemptAt: "2026-09-30T12:03:00.000Z",
          lastError: "fetch failed",
        });
        expect(
          await store.listDueWorkspacePullRequestTransitions("2026-09-30T12:02:00.000Z"),
        ).toEqual([]);
        expect(
          await store.listDueWorkspacePullRequestTransitions("2026-09-30T12:10:00.000Z"),
        ).toMatchObject([
          { taskId: first.taskId, attemptCount: 2, lastError: "fetch failed", action: "close" },
          { taskId: second.taskId, attemptCount: 1 },
        ]);
        expect(
          await store.listDueWorkspacePullRequestTransitions("2026-09-30T12:10:00.000Z", 1),
        ).toHaveLength(1);
        await store.deleteWorkspacePullRequestTransition(first.taskId);
        await store.deleteWorkspacePullRequestTransition(first.taskId);
        expect(
          (await store.listDueWorkspacePullRequestTransitions("2026-09-30T12:10:00.000Z")).map(
            (item) => item.taskId,
          ),
        ).toEqual([second.taskId]);
      });
    },
  );
}
