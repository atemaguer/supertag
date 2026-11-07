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
    `${dialect} approval requests in the coordination inbox`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-inbox-approvals-"));
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
          id: `objective-${randomUUID()}`,
          ownerTagId: owner.id,
          outcome: "Ship the export",
        });
        const team = await store.createTeam({
          id: `team-${randomUUID()}`,
          objectiveId: objective.id,
          name: "Export Team",
          leadTagId: owner.id,
          memberTagIds: [worker.id],
          maxConcurrency: 2,
        });
        const assignment = (
          taskId: string,
          extra: Partial<AdmitTaskAssignmentInput> = {},
        ): AdmitTaskAssignmentInput => ({
          taskId,
          objectiveId: objective.id,
          teamId: team.id,
          requestedByTagId: owner.id,
          assignedTagId: worker.id,
          instruction: "secret instruction",
          acceptanceCriteria: ["secret criterion"],
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
          ...extra,
        });
        return { store, owner, worker, objective, team, assignment };
      }

      it("lists pending action and plan requests as approval items with commands", async () => {
        const f = await fixture();
        await f.store.admitTaskAssignment(f.assignment("running-task"));
        await f.store.claimTaskAssignment({ taskId: "running-task", leaseOwner: "test" });
        const blocking = await f.store.createApprovalRequest({
          objectiveId: f.objective.id,
          taskId: "running-task",
          attemptId: "attempt-1",
          requestingTagId: f.worker.id,
          kind: "surface-action",
          actions: [
            {
              target: "surface",
              action: "pull_request.merge",
              surfaceAccountId: "github-account",
              scope: "acme/app",
            },
          ],
          argumentsDigest: `sha256:${"a".repeat(64)}`,
          summary: "Merge pull request 42 in acme/app",
          ruleSources: ["release"],
          approvers: [],
        });
        const plan = await f.store.createApprovalRequest({
          objectiveId: f.objective.id,
          taskId: "running-task",
          requestingTagId: f.owner.id,
          kind: "plan",
          actions: [{ target: "runtime", action: "deploy" }],
          summary: "Deploy after merge",
          ruleSources: ["release"],
          approvers: [],
        });

        const page = await f.store.readCoordinationInbox({ kind: "approval" });
        expect(page.projectionVersion).toBe(7);
        expect(page.items.map((item) => item.key).sort()).toEqual(
          [`approval:${blocking.id}`, `approval:${plan.id}`].sort(),
        );
        const byKey = (key: string) => page.items.find((item) => item.key === key);
        expect(byKey(`approval:${blocking.id}`)).toMatchObject({
          kind: "approval",
          objectiveId: f.objective.id,
          teamId: f.team.id,
          approval: {
            requestId: blocking.id,
            requestKind: "surface-action",
            summary: "Merge pull request 42 in acme/app",
            requestingTagId: f.worker.id,
            taskId: "running-task",
            blocking: true,
          },
          commands: [
            `supertag approve request ${blocking.id}`,
            `supertag deny request ${blocking.id} --reason TEXT`,
          ],
          evidence: [{ kind: "approval_request", id: blocking.id }, { kind: "objective" }],
        });
        // The plan request carries no Attempt, so nothing running waits on it.
        expect(byKey(`approval:${plan.id}`)?.approval?.blocking).toBe(false);
        expect(JSON.stringify(page)).not.toContain("sha256:");

        // Approval items appear in the unfiltered inbox too, and only while pending.
        const all = await f.store.readCoordinationInbox({ objectiveId: f.objective.id });
        expect(all.items.filter((item) => item.kind === "approval")).toHaveLength(2);
        await f.store.decideApprovalRequest({
          id: blocking.id,
          decision: "approve",
          scope: "once",
          decidedBy: "admin",
          decidedByKind: "operator",
        });
        expect(
          (await f.store.readCoordinationInbox({ kind: "approval" })).items.map((i) => i.key),
        ).toEqual([`approval:${plan.id}`]);

        // A principal that may not list approvals sees none.
        expect(
          (await f.store.readCoordinationInbox({ includeApprovals: false })).items.filter(
            (item) => item.kind === "approval",
          ),
        ).toEqual([]);
      });

      it("names the request holding a Task without quoting its instruction", async () => {
        const f = await fixture();
        await f.store.admitTaskAssignment(f.assignment("held-task", { requiresApproval: true }));
        const request = await f.store.createApprovalRequest({
          objectiveId: f.objective.id,
          taskId: "held-task",
          requestingTagId: f.owner.id,
          kind: "task",
          actions: [{ target: "runtime", action: "deploy" }],
          summary: "Start Task held-task for worker with deploy: secret instruction",
          ruleSources: ["release"],
          approvers: [],
        });
        const page = await f.store.readCoordinationInbox({ kind: "task_approval" });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
          key: "task_approval:held-task",
          approval: {
            requestId: request.id,
            requestKind: "task",
            summary: "Start Task held-task with deploy",
            blocking: false,
          },
          commands: [`supertag approve request ${request.id}`, expect.any(String)],
        });
        expect(JSON.stringify(page)).not.toContain("secret instruction");
        // Task requests stay under task_approval, not approval.
        expect((await f.store.readCoordinationInbox({ kind: "approval" })).items).toEqual([]);
      });

      it("matches an action across the covering Tasks and records the caller's Task", async () => {
        const f = await fixture();
        const action = {
          target: "surface" as const,
          action: "pull_request.merge",
          surfaceAccountId: "github-account",
          scope: "acme/app",
        };
        const request = (taskId: string, coveringTaskIds?: readonly string[]) =>
          f.store.requestActionApproval({
            objectiveId: null,
            taskId,
            attemptId: `${taskId}-attempt`,
            requestingTagId: f.worker.id,
            kind: "surface-action",
            actions: [action],
            argumentsDigest: `sha256:${"b".repeat(64)}`,
            summary: "Merge pull request 42",
            ruleSources: ["release"],
            approvers: [],
            ...(coveringTaskIds === undefined ? {} : { coveringTaskIds }),
          });
        const first = await request("work-task-1");
        expect(first).toMatchObject({ status: "pending", created: true });
        // Without covering Tasks, another Task's request is not this one's.
        const other = await request("work-task-2");
        expect(other).toMatchObject({ status: "pending", created: true });
        expect(other.request.id).not.toBe(first.request.id);
        await f.store.expireApprovalRequest(other.request.id);
        await f.store.decideApprovalRequest({
          id: first.request.id,
          decision: "approve",
          scope: "once",
          decidedBy: "admin",
          decidedByKind: "operator",
        });
        // The next Task of the same work Session consumes the once approval its Task waited on.
        const retried = await request("work-task-3", ["work-task-1", "work-task-2", "work-task-3"]);
        expect(retried).toMatchObject({ status: "granted", via: "once" });
        expect(retried.request.id).toBe(first.request.id);
        // Consumed once; the next call asks again, recorded on the calling Task.
        const again = await request("work-task-3", ["work-task-1", "work-task-2", "work-task-3"]);
        expect(again).toMatchObject({ status: "pending", created: true });
        expect(again.request.taskId).toBe("work-task-3");
        // A pending or denied request of a covering Task is found too.
        expect(await request("work-task-4", ["work-task-3", "work-task-4"])).toMatchObject({
          status: "pending",
          created: false,
          request: { id: again.request.id },
        });
        await f.store.decideApprovalRequest({
          id: again.request.id,
          decision: "deny",
          reason: "Not this one",
          decidedBy: "admin",
          decidedByKind: "operator",
        });
        // A denial holds for every later Task of the work Session too.
        expect(await request("work-task-4", ["work-task-3", "work-task-4"])).toMatchObject({
          status: "denied",
          request: { id: again.request.id },
        });
      });

      it("omits requests whose Task already finished", async () => {
        const f = await fixture();
        await f.store.admitTaskAssignment(f.assignment("finished-task"));
        await f.store.createApprovalRequest({
          objectiveId: f.objective.id,
          taskId: "finished-task",
          attemptId: "attempt-1",
          requestingTagId: f.worker.id,
          kind: "surface-action",
          actions: [
            {
              target: "surface",
              action: "issue.comment",
              surfaceAccountId: "github-account",
              scope: "acme/app",
            },
          ],
          summary: "Comment on issue 7",
          ruleSources: ["review"],
          approvers: [],
        });
        await f.store.updateTaskAssignment(
          "finished-task",
          { expectedStatus: "queued", status: "cancelled" },
          f.owner.id,
          { administrator: true },
        );
        expect((await f.store.readCoordinationInbox({ kind: "approval" })).items).toEqual([]);
      });
    },
  );
}
