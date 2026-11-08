import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxSessionKey, objectiveSessionKey } from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
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
        const team = await store.createTeam({
          id: `team-${randomUUID()}`,
          name: `Export Team ${randomUUID()}`,
          memberTagIds: [owner.id, worker.id],
          maxConcurrency: 2,
        });
        const objective = await store.createObjective({
          id: `objective-${randomUUID()}`,
          ownerTagId: owner.id,
          outcome: "Ship the export",
          teamId: team.id,
        });
        const account = await store.saveSurfaceAccount({
          provider: "slack",
          externalAccountId: randomUUID(),
          displayName: "Slack",
          authMethod: "test",
          credentialId: "test",
          status: "connected",
          configuration: {},
          verifiedAt: new Date().toISOString(),
        });
        const route = await store.addTagRoute({
          tagId: owner.id,
          surfaceAccountId: account.id,
          scope: "channel:export",
        });
        const ownerSession = await store.openSession({
          tagId: owner.id,
          sessionKey: objectiveSessionKey(objective.id),
          origin: {},
          objectiveId: objective.id,
          at: new Date().toISOString(),
        });
        /**
         * One turn of a Session: the Objective's own Session by default, a work Session under it
         * with `work`, or the Tag's inbox Session with `inbox`.
         */
        async function turn(
          options: {
            readonly tagId?: string;
            readonly work?: string;
            readonly inbox?: true;
            readonly instruction?: string;
          } = {},
        ) {
          const tagId = options.tagId ?? owner.id;
          const tag = tagId === owner.id ? owner : worker;
          const at = new Date().toISOString();
          const session = options.inbox
            ? await store.openSession({
                tagId,
                sessionKey: inboxSessionKey(tagId),
                origin: {},
                at,
              })
            : options.work === undefined
              ? ownerSession
              : await store.openSession({
                  tagId,
                  sessionKey: `work:${ownerSession.id}:${options.work}`,
                  origin: {},
                  parentSessionId: ownerSession.id,
                  at,
                });
          const authorization = {
            version: 5,
            capturedAt: at,
            tag: { id: tag.id, name: tag.name },
            origin: {
              tagRouteId: route.id,
              surfaceAccountId: account.id,
              provider: "slack",
              scope: "channel:export",
            },
            requester: { id: owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          } as const;
          const eventId = randomUUID();
          const admitted = await store.admitInboundEvent({
            surfaceAccountId: account.id,
            tagRouteId: route.id,
            tagId,
            authorization,
            contextPlan: { version: 7, capturedAt: at, sets: [] },
            event: {
              eventId,
              logicalEventId: eventId,
              provider: "slack",
              externalAccountId: account.externalAccountId,
              kind: "message",
              scope: "channel:export",
              sessionKey: session.sessionKey,
              actor: { id: tag.id, kind: "bot" },
              internal:
                options.work === undefined
                  ? {
                      kind: "delivery",
                      from: { kind: "supertag" },
                      reason: options.inbox ? "inbox" : "objective_start",
                    }
                  : {
                      kind: "work_session",
                      startedByTaskId: eventId,
                      parentSessionId: ownerSession.id,
                      title: options.work,
                    },
              text: options.instruction ?? "secret instruction",
              occurredAt: at,
              callback: {
                provider: "slack",
                mode: "slack_thread",
                threadKey: "export",
                target: { channelId: "export", threadTs: "export" },
              },
              source: {},
              metadata: {},
            },
          });
          const task = await store.openTask({
            inboundEventId: admitted.work.id,
            tagId,
            sessionId: session.id,
            execution: {},
            actor: { id: tag.id, kind: "bot" },
            trigger: { origin: "objective" },
            requestText: options.instruction ?? "secret instruction",
            workspacePlan: { version: 1, status: "none" },
            sessionHistory: [],
            authorizationSnapshot: authorization,
            contextPlan: { version: 7, capturedAt: at, sets: [] },
            createdAt: at,
          });
          await store.startTask({ taskId: task.id, startedAt: at });
          return task;
        }
        return { store, owner, worker, objective, team, turn };
      }

      const mergeAction = {
        target: "surface" as const,
        action: "pull_request.merge",
        surfaceAccountId: "github-account",
        scope: "acme/app",
      };

      it("lists a pending request as an approval item with commands, and drops it once decided", async () => {
        const f = await fixture();
        const task = await f.turn({ tagId: f.worker.id, work: "merge" });
        const request = await f.store.createApprovalRequest({
          objectiveId: f.objective.id,
          taskId: task.id,
          attemptId: "attempt-1",
          requestingTagId: f.worker.id,
          kind: "surface-action",
          actions: [mergeAction],
          argumentsDigest: `sha256:${"a".repeat(64)}`,
          summary: "Merge pull request 42 in acme/app",
          ruleSources: ["release"],
          approvers: [],
        });

        const page = await f.store.readCoordinationInbox({ kind: "approval" });
        expect(page.projectionVersion).toBe(8);
        expect(page.items).toMatchObject([
          {
            key: `approval:${request.id}`,
            kind: "approval",
            objectiveId: f.objective.id,
            excludedActorTagIds: [f.worker.id],
            operatorEligible: true,
            approval: {
              requestId: request.id,
              requestKind: "surface-action",
              summary: "Merge pull request 42 in acme/app",
              requestingTagId: f.worker.id,
              requestingTagName: f.worker.name,
              taskId: task.id,
              blocking: true,
            },
            commands: [
              `supertag approve request ${request.id}`,
              `supertag deny request ${request.id} --reason TEXT`,
            ],
            evidence: [
              { kind: "approval_request", id: request.id },
              { kind: "objective", id: f.objective.id },
            ],
          },
        ]);
        // Metadata only: neither the arguments digest nor the Task's instruction is exposed.
        expect(JSON.stringify(page)).not.toContain("sha256:");
        expect(JSON.stringify(page)).not.toContain("secret instruction");

        // Approval items appear in the unfiltered inbox too.
        expect(
          (await f.store.readCoordinationInbox({ objectiveId: f.objective.id })).items.filter(
            (item) => item.kind === "approval",
          ),
        ).toHaveLength(1);
        // A principal that may not list approvals sees none.
        expect(
          (await f.store.readCoordinationInbox({ includeApprovals: false })).items.filter(
            (item) => item.kind === "approval",
          ),
        ).toEqual([]);

        await f.store.decideApprovalRequest({
          id: request.id,
          decision: "approve",
          scope: "once",
          decidedBy: "admin",
          decidedByKind: "operator",
        });
        expect((await f.store.readCoordinationInbox({ kind: "approval" })).items).toEqual([]);
      });

      it("lists an inbox turn's request without an Objective", async () => {
        const f = await fixture();
        const task = await f.turn({ tagId: f.worker.id, inbox: true });
        const request = await f.store.createApprovalRequest({
          objectiveId: null,
          taskId: task.id,
          attemptId: "attempt-inbox",
          requestingTagId: f.worker.id,
          kind: "surface-action",
          actions: [mergeAction],
          summary: "Merge pull request 7 in acme/app",
          ruleSources: ["release"],
          approvers: [],
        });
        expect((await f.store.readCoordinationInbox({ kind: "approval" })).items).toMatchObject([
          {
            key: `approval:${request.id}`,
            objectiveId: null,
            deadline: null,
            commands: [
              `supertag approve request ${request.id}`,
              `supertag deny request ${request.id} --reason TEXT`,
            ],
            evidence: [{ kind: "approval_request", id: request.id }],
          },
        ]);
      });

      it("matches an action across the covering Tasks and records the caller's Task", async () => {
        const f = await fixture();
        const request = (taskId: string, coveringTaskIds?: readonly string[]) =>
          f.store.requestActionApproval({
            objectiveId: null,
            taskId,
            attemptId: `${taskId}-attempt`,
            requestingTagId: f.worker.id,
            kind: "surface-action",
            actions: [mergeAction],
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

      it("omits a request whose Session moved on", async () => {
        const f = await fixture();
        const task = await f.turn({ tagId: f.worker.id, work: "comment" });
        await f.store.createApprovalRequest({
          objectiveId: f.objective.id,
          taskId: task.id,
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
        // The Task ended waiting on the decision and is still its Session's latest: still actionable.
        await f.store.closeTask({
          taskId: task.id,
          status: "completed",
          endedAt: new Date().toISOString(),
        });
        expect((await f.store.readCoordinationInbox({ kind: "approval" })).items).toHaveLength(1);
        // A cancelled Task waits on nothing.
        await f.store.closeTask({
          taskId: task.id,
          status: "cancelled",
          endedAt: new Date().toISOString(),
        });
        expect((await f.store.readCoordinationInbox({ kind: "approval" })).items).toEqual([]);
      });
    },
  );
}
