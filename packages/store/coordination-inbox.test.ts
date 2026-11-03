import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePostgresql } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import type { AdmitTaskAssignmentInput } from "../core/src/index.js";
import { COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT } from "./src/coordination-inbox-store.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";
import * as postgresqlSchema from "./src/schema/postgresql.js";
import * as sqliteSchema from "./src/schema/sqlite.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} coordination inbox projection`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        vi.useRealTimers();
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-coordination-inbox-"));
        const isolated =
          dialect === "postgresql" && postgres
            ? await createIsolatedPostgresDatabase(postgres)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        const reopened = new DrizzleStore({ url });
        await store.connect();
        await reopened.connect();
        cleanups.push(async () => {
          await reopened.disconnect();
          await store.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        });
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const lead = await store.createTag({ name: `lead-${randomUUID()}` });
        const worker = await store.createTag({ name: `worker-${randomUUID()}` });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Review pending Tasks",
        });
        const team = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Review Team",
          leadTagId: lead.id,
          memberTagIds: [worker.id, owner.id],
          maxConcurrency: 1,
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
        return { url, store, reopened, owner, lead, worker, objective, team, assignment };
      }

      /** A second connection for seeding history rows in bulk, bypassing the store's rules. */
      function rawDatabase(url: string): {
        // biome-ignore lint/suspicious/noExplicitAny: Seeding spans dialect-specific Drizzle databases.
        readonly db: any;
        // biome-ignore lint/suspicious/noExplicitAny: Seeding spans dialect-specific Drizzle tables.
        readonly tables: any;
        readonly close: () => Promise<void>;
      } {
        if (url.startsWith("file:")) {
          const connection = new Database(url.slice("file:".length));
          return {
            db: drizzleSqlite(connection),
            tables: sqliteSchema,
            close: async () => connection.close(),
          };
        }
        const pool = new Pool({ connectionString: url, max: 1 });
        return { db: drizzlePostgresql(pool), tables: postgresqlSchema, close: () => pool.end() };
      }

      it("projects Objective review and completion without exposing summaries", async () => {
        const f = await fixture();
        const review = await f.store.updateObjectiveStatus(
          f.objective.id,
          {
            status: "ready_for_review",
            expectedRevision: f.objective.revision,
            completionSummary: "private review summary",
          },
          f.owner.id,
        );
        const reviewItems = (
          await f.reopened.readCoordinationInbox({ kind: "objective_ready_for_review" })
        ).items;
        expect(reviewItems).toMatchObject([
          {
            key: `objective_ready_for_review:${f.objective.id}`,
            operatorEligible: true,
            commands: [`supertag describe objective ${f.objective.id}`],
            redaction: { level: "metadata_only", omitted: ["outcome", "completionSummary"] },
          },
        ]);
        expect(JSON.stringify(reviewItems)).not.toContain("private review summary");
        await f.store.updateObjectiveStatus(
          f.objective.id,
          {
            status: "completed",
            expectedRevision: review.revision,
            completionSummary: "private completion summary",
          },
          f.owner.id,
        );
        expect(
          (await f.reopened.readCoordinationInbox({ kind: "objective_ready_for_review" })).items,
        ).toEqual([]);
        const completed = (await f.reopened.readCoordinationInbox({ kind: "objective_completed" }))
          .items;
        expect(completed).toMatchObject([
          {
            key: `objective_completed:${f.objective.id}`,
            commands: [`supertag describe objective ${f.objective.id}`],
          },
        ]);
        expect(JSON.stringify(completed)).not.toContain("private completion summary");
        // Completion needs no action: the open inbox omits it; only the notification outbox reads it.
        const open = (await f.reopened.readCoordinationInbox({})).items;
        expect(open.some((item) => item.kind === "objective_completed")).toBe(false);
        const notices = (await f.reopened.readCoordinationInbox({ includeNotices: true })).items;
        expect(notices.some((item) => item.kind === "objective_completed")).toBe(true);
        expect(
          (
            await f.reopened.readCoordinationInbox({
              includeNotices: true,
              includeNoticesSince: new Date(
                Date.parse(completed[0]?.actionableSince ?? "") + 1,
              ).toISOString(),
            })
          ).items.some((item) => item.kind === "objective_completed"),
        ).toBe(false);
      });

      it("lists pending owner questions on a review item", async () => {
        const f = await fixture();
        await f.store.admitTaskAssignment(
          f.assignment("owner-question", { assignedTagId: f.owner.id }),
        );
        const { message } = await f.store.enqueueObjectiveMessage({
          objectiveId: f.objective.id,
          senderTagId: f.owner.id,
          sourceTaskId: "owner-question",
          type: "message",
          body: { message: "Which format?\nExtra private detail" },
          idempotencyKey: "review-question",
        });
        const { message: second } = await f.store.enqueueObjectiveMessage({
          objectiveId: f.objective.id,
          senderTagId: f.owner.id,
          sourceTaskId: "owner-question",
          type: "message",
          body: { message: "Which date?" },
          idempotencyKey: "review-question-2",
        });
        await f.store.updateObjectiveStatus(f.objective.id, {
          status: "ready_for_review",
          expectedRevision: f.objective.revision,
        });
        const [item] = (
          await f.reopened.readCoordinationInbox({ kind: "objective_ready_for_review" })
        ).items;
        expect(item?.reason).toContain("Approval waits for answers");
        expect(item?.reason).toContain(`${message.id} (asked ${message.createdAt}): Which format?`);
        expect(item?.reason).toContain(`${second.id} (asked ${second.createdAt}): Which date?`);
        expect(item?.reason).toContain(
          `supertag message objective ${f.objective.id} --reply-to ${message.id} TEXT`,
        );
        expect(item?.reason).not.toContain("Extra private detail");
        await f.store.replyToObjectiveMessage({
          messageId: message.id,
          objectiveId: f.objective.id,
          recipientTagId: f.owner.id,
          body: { message: "Use the standard format" },
          idempotencyKey: "review-answer",
          operatorId: "operator",
        });
        const [afterReply] = (
          await f.reopened.readCoordinationInbox({ kind: "objective_ready_for_review" })
        ).items;
        expect(afterReply?.reason).not.toContain(message.id);
        expect(afterReply?.reason).toContain(second.id);
      });

      it("preserves database ordering across budget pages with equal timestamps and mixed-case IDs", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date());
        const f = await fixture();
        for (const taskId of ["a-budget", "B-budget"]) {
          await f.store.admitTaskAssignment(f.assignment(taskId));
          await f.store.claimTaskAssignment({ taskId, leaseOwner: "test" });
          await f.store.settleTaskAssignment({
            taskId,
            leaseOwner: "test",
            attemptCount: 1,
            failed: true,
            result: { failureKind: "budget-exhausted" },
          });
        }
        const all = await f.store.readCoordinationInbox({ kind: "task_budget" });
        const first = await f.store.readCoordinationInbox({ kind: "task_budget", limit: 1 });
        expect(first.nextCursor).toBeDefined();
        const second = await f.store.readCoordinationInbox({ cursor: first.nextCursor, limit: 1 });
        expect([...first.items, ...second.items].map((item) => item.key)).toEqual(
          all.items.map((item) => item.key),
        );
        expect(new Set([...first.items, ...second.items].map((item) => item.key)).size).toBe(2);
        expect(second.nextCursor).toBeUndefined();
        expect(second.asOf).toBe(first.asOf);
      });
      it("finds and pages budget decisions beyond unrelated scan limits", async () => {
        const f = await fixture();
        // Every old global candidate window would fill before the actionable rows.
        for (let index = 0; index < 1001; index++) {
          const unrelated = await f.store.createObjective({
            id: randomUUID(),
            ownerTagId: f.owner.id,
            outcome: "Unrelated",
          });
          await f.store.createTeam({
            id: randomUUID(),
            objectiveId: unrelated.id,
            name: "Unrelated",
            maxConcurrency: 1,
            leadTagId: f.owner.id,
            memberTagIds: [],
          });
          const taskId = `noise-${index}`;
          await f.store.admitTaskAssignment(f.assignment(taskId));
          await f.store.claimTaskAssignment({ taskId, leaseOwner: "noise" });
          await f.store.settleTaskAssignment({
            taskId,
            leaseOwner: "noise",
            attemptCount: 1,
            failed: true,
            result: { error: "ordinary failure" },
          });
        }
        const lateObjective = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Late budget work",
        });
        const lateTeam = await f.store.createTeam({
          id: randomUUID(),
          objectiveId: lateObjective.id,
          name: "Late Team",
          maxConcurrency: 1,
          leadTagId: f.owner.id,
          memberTagIds: [f.worker.id],
        });
        for (const taskId of ["budget-late-a", "budget-late-b"]) {
          const input = f.assignment(taskId, {
            objectiveId: lateObjective.id,
            teamId: lateTeam.id,
          });
          await f.store.admitTaskAssignment({
            ...input,
            authorizationSnapshot: {
              ...input.authorizationSnapshot,
              origin: {
                kind: "internal",
                objectiveId: lateObjective.id,
                requestedByTagId: f.owner.id,
              },
            },
          });
          await f.store.claimTaskAssignment({ taskId, leaseOwner: "late" });
          await f.store.settleTaskAssignment({
            taskId,
            leaseOwner: "late",
            attemptCount: 1,
            failed: true,
            result: { failureKind: "budget-exhausted" },
          });
        }
        const first = await f.store.readCoordinationInbox({ kind: "task_budget", limit: 1 });
        expect(first.items.map((item) => item.key)).toEqual(["task_budget:budget-late-a"]);
        expect(first.truncatedKinds).toEqual([]);
        expect(first.nextCursor).toBeDefined();
        const second = await f.reopened.readCoordinationInbox({
          cursor: first.nextCursor,
          limit: 1,
        });
        expect(second.items.map((item) => item.key)).toEqual(["task_budget:budget-late-b"]);
        expect(second.nextCursor).toBeUndefined();
      }, 120000);
      it("finds open work behind more finished history than the candidate scan holds", async () => {
        const f = await fixture();
        const history = COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 50;
        // One closed Objective whose Team finished more Tasks than the scan holds.
        const closed = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Finished history",
        });
        const closedTeam = await f.store.createTeam({
          id: randomUUID(),
          objectiveId: closed.id,
          name: "History Team",
          leadTagId: f.lead.id,
          memberTagIds: [f.worker.id],
          maxConcurrency: 1,
        });
        const template = f.assignment("history-template", {
          objectiveId: closed.id,
          teamId: closedTeam.id,
        });
        await f.store.admitTaskAssignment({
          ...template,
          authorizationSnapshot: {
            ...template.authorizationSnapshot,
            origin: { kind: "internal", objectiveId: closed.id, requestedByTagId: f.owner.id },
          },
        });
        const raw = rawDatabase(f.url);
        try {
          const { db, tables } = raw;
          const old = (index: number) =>
            new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();
          const [task] = await db
            .select()
            .from(tables.tasks)
            .where(eq(tables.tasks.id, "history-template"));
          const [assignment] = await db
            .select()
            .from(tables.taskAssignments)
            .where(eq(tables.taskAssignments.taskId, "history-template"));
          const [objectiveRow] = await db
            .select()
            .from(tables.objectives)
            .where(eq(tables.objectives.id, closed.id));
          const [teamRow] = await db
            .select()
            .from(tables.teams)
            .where(eq(tables.teams.id, closedTeam.id));
          const chunks = <T>(rows: T[]): T[][] =>
            Array.from({ length: Math.ceil(rows.length / 200) }, (_, index) =>
              rows.slice(index * 200, index * 200 + 200),
            );
          const ids = Array.from({ length: history }, (_, index) => `history-${index}`);
          for (const chunk of chunks(ids))
            await db
              .insert(tables.tasks)
              .values(chunk.map((id) => ({ ...task, id, inboundEventId: null })));
          for (const [offset, chunk] of chunks(ids).entries())
            await db.insert(tables.taskAssignments).values(
              chunk.map((taskId, index) => ({
                ...assignment,
                taskId,
                status: "accepted",
                createdAt: old(offset * 200 + index),
                updatedAt: old(offset * 200 + index),
              })),
            );
          await db
            .update(tables.taskAssignments)
            .set({ status: "accepted", updatedAt: old(0) })
            .where(eq(tables.taskAssignments.taskId, "history-template"));
          await db
            .update(tables.objectives)
            .set({ status: "completed", createdAt: old(0), updatedAt: old(0) })
            .where(eq(tables.objectives.id, closed.id));
          // And more cancelled Objectives, each with its Team, than the scan holds.
          const objectiveIds = Array.from({ length: history }, () => randomUUID());
          for (const chunk of chunks(objectiveIds)) {
            await db.insert(tables.objectives).values(
              chunk.map((id, index) => ({
                ...objectiveRow,
                id,
                status: "cancelled",
                createdAt: old(index),
                updatedAt: old(index),
              })),
            );
            await db.insert(tables.teams).values(
              chunk.map((objectiveId, index) => ({
                ...teamRow,
                id: randomUUID(),
                objectiveId,
                objectiveIds: [objectiveId],
                createdAt: old(index),
                updatedAt: old(index),
              })),
            );
          }
        } finally {
          await raw.close();
        }
        // The open item: a current Task Attempt became uncertain and holds a Worker slot.
        const taskId = "uncertain-current";
        await f.store.admitTaskAssignment(f.assignment(taskId));
        if (!(await f.store.claimTaskAssignment({ taskId, leaseOwner: "lost" })))
          throw new Error("Claim missing");
        const attempt = await f.store.createTaskAttempt({
          taskId,
          attemptNumber: 1,
          workerProfile: { id: "uncertain", revision: "1" },
          workerSnapshot: { durableExecution: true, kind: "assignment" },
          startedAt: new Date().toISOString(),
        });
        await f.store.markTaskAssignmentUncertain({
          taskId,
          attemptId: attempt.id,
          reason: "Worker Host restarted",
        });
        const key = `task_attention:${taskId}:uncertain:${attempt.id}`;
        for (const input of [{}, { includeNotices: true }, { kind: "task_attention" as const }]) {
          const page = await f.reopened.readCoordinationInbox(input);
          expect(page.truncatedKinds).toEqual([]);
          expect(page.items.map((item) => item.key)).toContain(key);
        }
        // Paging one item at a time reaches it too.
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await f.reopened.readCoordinationInbox({
            limit: 1,
            ...(cursor ? { cursor } : {}),
          });
          keys.push(...page.items.map((item) => item.key));
          cursor = page.nextCursor;
        } while (cursor);
        expect(keys).toContain(key);
      }, 60000);
      it("projects exhausted work for independent allocation decisions and removes it on renewal", async () => {
        const f = await fixture();
        const taskId = randomUUID();
        await f.store.admitTaskAssignment(f.assignment(taskId, { assignedTagId: f.owner.id }));
        await f.store.claimTaskAssignment({ taskId, leaseOwner: "budget" });
        await f.store.settleTaskAssignment({
          taskId,
          leaseOwner: "budget",
          attemptCount: 1,
          failed: true,
          result: { failureKind: "budget-exhausted", secret: "private budget evidence" },
        });
        const ordinaryId = randomUUID();
        await f.store.admitTaskAssignment(f.assignment(ordinaryId));
        await f.store.claimTaskAssignment({ taskId: ordinaryId, leaseOwner: "ordinary" });
        await f.store.settleTaskAssignment({
          taskId: ordinaryId,
          leaseOwner: "ordinary",
          attemptCount: 1,
          failed: true,
          result: { error: "ordinary failure" },
        });
        const page = await f.reopened.readCoordinationInbox({ kind: "task_budget" });
        expect(page.items).toHaveLength(1);
        expect(page.tagNames?.[f.lead.id]).toBe(f.lead.name);
        expect(page.items[0]).toMatchObject({
          kind: "task_budget",
          key: `task_budget:${taskId}`,
          nextActorTagIds: [f.lead.id],
          excludedActorTagIds: [f.owner.id],
          operatorEligible: true,
          permittedActions: [
            {
              tool: "update_task",
              arguments: {
                objectiveId: f.objective.id,
                taskId,
                expectedStatus: "failed",
                status: "queued",
              },
              requiredInputFields: ["executionLimits"],
            },
          ],
        });
        expect(JSON.stringify(page)).not.toContain("private budget evidence");
        expect(JSON.stringify(page)).not.toContain("secret instruction");
        expect(
          (await f.reopened.readCoordinationInbox({ kind: "task_budget", nextActorId: f.owner.id }))
            .items,
        ).toEqual([]);
        expect(
          (await f.reopened.readCoordinationInbox({ kind: "task_budget", nextActorId: f.lead.id }))
            .items,
        ).toHaveLength(1);
        await f.store.updateTaskAssignment(
          taskId,
          {
            expectedStatus: "failed",
            status: "queued",
            executionLimits: { maxReportedTokens: 1000 },
          },
          f.lead.id,
        );
        expect((await f.reopened.readCoordinationInbox({ kind: "task_budget" })).items).toEqual([]);
      });
      it("records exhaustion durably without reopening a completed Objective or allocating a retry", async () => {
        const f = await fixture();
        const taskId = randomUUID();
        await f.store.admitTaskAssignment(
          f.assignment(taskId, {
            assignedTagId: f.owner.id,
            authorizationSnapshot: {
              ...f.assignment(taskId).authorizationSnapshot,
              tag: { id: f.owner.id, name: f.owner.name },
            },
          }),
        );
        await f.store.claimTaskAssignment({ taskId, leaseOwner: "budget" });
        const attempt = await f.store.createTaskAttempt({
          taskId,
          attemptNumber: 1,
          workerProfile: { id: "budget", revision: "1" },
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        await f.store.startTask({ taskId, startedAt: new Date().toISOString() });
        await f.store.updateObjectiveStatus(
          f.objective.id,
          {
            status: "completed",
            expectedRevision: f.objective.revision,
            completionSummary: "Accepted delivery finished",
          },
          f.owner.id,
          { taskId, attemptCount: 1, leaseOwner: "budget" },
        );
        await f.store.settleTaskAssignment({
          taskId,
          leaseOwner: "budget",
          attemptCount: 1,
          failed: true,
          terminalAttempt: { id: attempt.id, status: "failed" },
          result: {
            failureKind: "budget-exhausted",
            budgetExhaustion: { attemptId: attempt.id, requiresAuthorization: true },
          },
        });
        expect((await f.reopened.getObjective(f.objective.id)).status).toBe("completed");
        expect((await f.reopened.readCoordinationInbox({ kind: "task_budget" })).items).toEqual([]);
        expect(await f.reopened.getTaskAssignment(taskId)).toMatchObject({
          status: "failed",
          attemptCount: 1,
          result: { failureKind: "budget-exhausted" },
        });
        expect(
          (await f.reopened.listTaskEvents(taskId)).find(
            (event) => event.type === "task.budget-exhausted",
          ),
        ).toMatchObject({ attemptId: attempt.id, payload: { requiresAuthorization: true } });
        expect(
          (await f.reopened.listPendingTaskAssignments()).some((task) => task.taskId === taskId),
        ).toBe(false);
      });

      it("shows a Task held for a lapsed MCP login with the login command until scheduling clears", async () => {
        const f = await fixture();
        const heldId = randomUUID();
        await f.store.admitTaskAssignment(f.assignment(heldId));
        await f.store.appendTaskEvent({
          taskId: heldId,
          type: "task.scheduling-incompatible",
          payload: {
            version: 1,
            status: "incompatible",
            unmetRequirements: ["labels:mcp:notion"],
            candidates: [],
            mcpLogins: ["notion", "Not A Server"],
          },
        });
        const page = await f.reopened.readCoordinationInbox({ limit: 10, kind: "mcp_login" });
        expect(page.items).toEqual([
          expect.objectContaining({
            key: `mcp_login:${heldId}:notion`,
            kind: "mcp_login",
            operatorEligible: true,
            nextActorTagIds: [],
            commands: [
              "supertag mcp login notion",
              `supertag describe objective ${f.objective.id}`,
            ],
          }),
        ]);
        expect(JSON.stringify(page)).not.toContain("secret");
        await f.store.appendTaskEvent({
          taskId: heldId,
          type: "task.scheduling-compatible",
          payload: { version: 1, status: "compatible" },
        });
        expect((await f.reopened.readCoordinationInbox({ limit: 10 })).items).toEqual([]);
      });

      it("projects Task decisions as partial update_task invocations", async () => {
        const f = await fixture();
        const approvalId = randomUUID();
        await f.store.admitTaskAssignment(f.assignment(approvalId, { requiresApproval: true }));
        const reviewId = randomUUID();
        await f.store.admitTaskAssignment(f.assignment(reviewId));
        await f.store.claimTaskAssignment({ taskId: reviewId, leaseOwner: "review" });
        await f.store.settleTaskAssignment({
          taskId: reviewId,
          leaseOwner: "review",
          attemptCount: 1,
          result: { privateResult: "must remain hidden" },
        });

        const page = await f.reopened.readCoordinationInbox({ limit: 10 });
        expect(page.projectionVersion).toBe(7);
        expect(page.items.map((item) => item.kind).sort()).toEqual([
          "task_approval",
          "task_review",
        ]);
        expect(page.items.find((item) => item.kind === "task_approval")).toMatchObject({
          permittedActions: [
            {
              tool: "update_task",
              arguments: {
                taskId: approvalId,
                expectedStatus: "queued",
                approval: "approved",
              },
              requiredInputFields: [],
            },
          ],
        });
        expect(page.items.find((item) => item.kind === "task_review")).toMatchObject({
          excludedActorTagIds: [f.worker.id],
          permittedActions: [
            {
              tool: "update_task",
              arguments: { expectedStatus: "submitted", status: "accepted" },
              requiredInputFields: ["assessment"],
            },
            {
              tool: "update_task",
              arguments: { expectedStatus: "submitted", status: "rejected" },
              requiredInputFields: ["assessment"],
            },
          ],
        });
        expect(JSON.stringify(page)).not.toContain("secret");
      });

      it("keeps filters and cursors stable", async () => {
        const f = await fixture();
        for (let index = 0; index < 3; index += 1)
          await f.store.admitTaskAssignment(f.assignment(randomUUID(), { requiresApproval: true }));
        const first = await f.store.readCoordinationInbox({
          objectiveId: f.objective.id,
          kind: "task_approval",
          limit: 1,
        });
        expect(first.nextCursor).toBeDefined();
        const second = await f.store.readCoordinationInbox({ cursor: first.nextCursor, limit: 1 });
        expect(second.asOf).toBe(first.asOf);
        expect(second.items[0]?.key).not.toBe(first.items[0]?.key);
        await expect(
          f.store.readCoordinationInbox({
            cursor: first.nextCursor,
            kind: "task_review",
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });
    },
  );
}
