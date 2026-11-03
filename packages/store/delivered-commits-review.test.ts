import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import type { AdmitTaskAssignmentInput } from "../core/src/index.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} failed Task with delivered commits`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-delivered-commits-"));
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
        const worker = await store.createTag({ name: `worker-${randomUUID()}` });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Measure coordination",
          budgetCurrency: "USD",
          budgetLimitMinor: 1000,
        });
        const team = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Metrics Team",
          leadTagId: owner.id,
          memberTagIds: [worker.id],
          maxConcurrency: 1_000,
        });
        const assignment = (
          taskId: string,
          requiresApproval = false,
        ): AdmitTaskAssignmentInput => ({
          taskId,
          objectiveId: objective.id,
          teamId: team.id,
          requestedByTagId: owner.id,
          assignedTagId: worker.id,
          instruction: `Measure ${taskId}`,
          acceptanceCriteria: ["Recorded"],
          requiresApproval,
          execution: {},
          authorizationSnapshot: {
            version: 4,
            capturedAt: new Date().toISOString(),
            tag: { id: worker.id, name: worker.name },
            origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
            requester: { id: owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
          contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
          workspacePlan: { version: 1, status: "none" },
        });
        return { store, owner, worker, objective, assignment };
      }

      async function fail(
        f: Awaited<ReturnType<typeof fixture>>,
        id: string,
        result: Record<string, unknown>,
      ) {
        await f.store.admitTaskAssignment(f.assignment(id));
        await f.store.claimTaskAssignment({ taskId: id, leaseOwner: "test" });
        await f.store.settleTaskAssignment({
          taskId: id,
          leaseOwner: "test",
          attemptCount: 1,
          failed: true,
          result,
        });
      }
      const deliveredCommits = {
        attemptId: "attempt",
        branch: "supertag/o/t",
        base: "a".repeat(40),
        head: "b".repeat(40),
        changedFiles: 2,
      };

      it("lets the delegator accept the committed result of a failed Task", async () => {
        const f = await fixture();
        await fail(f, "timed-out", { error: "Execution timed out", deliveredCommits });
        await expect(
          f.store.updateTaskAssignment(
            "timed-out",
            { expectedStatus: "failed", status: "accepted", assessment: "Reviewed and merged" },
            f.worker.id,
          ),
        ).rejects.toThrow("Objective owner or Team lead required");
        const accepted = await f.store.updateTaskAssignment(
          "timed-out",
          { expectedStatus: "failed", status: "accepted", assessment: "Reviewed and merged" },
          f.owner.id,
        );
        expect(accepted).toMatchObject({
          status: "accepted",
          result: {
            error: "Execution timed out",
            deliveredCommits,
            assessment: "Reviewed and merged",
            reviewedByTagId: f.owner.id,
          },
        });
      });

      it("retains a partial mount write manifest and delivered git commit on failure", async () => {
        const f = await fixture();
        const taskId = "partial-mount-write";
        await f.store.admitTaskAssignment(f.assignment(taskId));
        await f.store.claimTaskAssignment({ taskId, leaseOwner: "test" });
        const attempt = await f.store.createTaskAttempt({
          taskId,
          attemptNumber: 1,
          workerProfile: { id: "test", revision: "1" },
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        const manifest = [
          {
            volume: "data",
            source: "file:///data",
            path: "/mnt/data",
            status: "partial" as const,
            uploadedAt: new Date().toISOString(),
            objects: [{ key: "first", size: 1, sha256: `sha256:${"a".repeat(64)}` }],
            skipped: 0,
            error: { key: "second", reason: "upload failed" },
            notAttempted: ["second"],
          },
        ];
        await f.store.recordTaskAttemptMountOutputManifests(taskId, attempt.id, manifest);
        await f.store.settleTaskAssignment({
          taskId,
          leaseOwner: "test",
          attemptCount: 1,
          failed: true,
          result: {
            error: "Workspace mount data key second: upload failed",
            deliveredCommits: { ...deliveredCommits, attemptId: attempt.id },
          },
          terminalAttempt: { id: attempt.id, status: "failed" },
        });
        expect(await f.store.getTaskAssignment(taskId)).toMatchObject({
          status: "failed",
          result: { deliveredCommits: { head: deliveredCommits.head } },
        });
        expect((await f.store.listTaskAttempts(taskId))[0]).toMatchObject({
          status: "failed",
          mountOutputManifests: manifest,
        });
      });

      it("refuses to accept or reject a failed Task without delivered commits", async () => {
        const f = await fixture();
        await fail(f, "plain", { error: "Execution timed out" });
        await expect(
          f.store.updateTaskAssignment(
            "plain",
            { expectedStatus: "failed", status: "accepted", assessment: "Looks fine" },
            f.owner.id,
          ),
        ).rejects.toThrow("Only submitted results");
        await fail(f, "delivered", { error: "Execution timed out", deliveredCommits });
        await expect(
          f.store.updateTaskAssignment(
            "delivered",
            { expectedStatus: "failed", status: "rejected", assessment: "No" },
            f.owner.id,
          ),
        ).rejects.toThrow("Only submitted results");
      });
    },
  );
}
