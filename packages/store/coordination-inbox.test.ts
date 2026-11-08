import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectiveSessionKey } from "@supertag/core";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePostgresql } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT } from "./src/coordination-inbox-store.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";
import * as postgresqlSchema from "./src/schema/postgresql.js";
import * as sqliteSchema from "./src/schema/sqlite.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const spentState = (limitMinor: number, spentMinor: number, at: string) => ({
  reportedSpend: {
    amountMinor: spentMinor,
    currency: "USD",
    unknownAttemptIds: [],
    observedAt: at,
  },
  budgetExhausted: { limitMinor, spentMinor, at },
});

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
        const worker = await store.createTag({ name: `worker-${randomUUID()}` });
        const team = await store.createTeam({
          id: randomUUID(),
          name: `Review Team ${randomUUID()}`,
          memberTagIds: [owner.id, worker.id],
          maxConcurrency: 1,
        });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Review pending Tasks",
          budgetCurrency: "USD",
          budgetLimitMinor: 100,
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
          scope: "channel:review",
        });

        /**
         * One turn of a Session of an Objective: the Objective's own Session, or a work Session
         * under it when `work` names one.
         */
        async function turn(
          options: {
            readonly objectiveId?: string;
            readonly tagId?: string;
            readonly work?: string;
          } = {},
        ) {
          const objectiveId = options.objectiveId ?? objective.id;
          const tagId = options.tagId ?? owner.id;
          const tag = tagId === owner.id ? owner : worker;
          const at = new Date().toISOString();
          const ownerSession = await store.openSession({
            tagId: owner.id,
            sessionKey: objectiveSessionKey(objectiveId),
            origin: {},
            objectiveId,
            at,
          });
          const session =
            options.work === undefined
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
              scope: "channel:review",
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
              scope: "channel:review",
              sessionKey: session.sessionKey,
              actor: { id: tag.id, kind: "bot" },
              internal:
                options.work === undefined
                  ? { kind: "delivery", from: { kind: "supertag" }, reason: "objective_start" }
                  : {
                      kind: "work_session",
                      startedByTaskId: eventId,
                      parentSessionId: ownerSession.id,
                      title: options.work,
                    },
              text: "secret instruction",
              occurredAt: at,
              callback: {
                provider: "slack",
                mode: "slack_thread",
                threadKey: "review",
                target: { channelId: "review", threadTs: "review" },
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
            requestText: "secret instruction",
            workspacePlan: { version: 1, status: "none" },
            sessionHistory: [],
            authorizationSnapshot: authorization,
            contextPlan: { version: 7, capturedAt: at, sets: [] },
            createdAt: at,
          });
          return { task, inboundEventId: admitted.work.id, sessionId: session.id };
        }

        /** The turn ends by asking the operator a question and waiting on the answer. */
        async function ask(taskId: string, question: string) {
          await store.startTask({ taskId, startedAt: new Date().toISOString() });
          await store.closeTask({
            taskId,
            status: "completed",
            endedAt: new Date().toISOString(),
            outcome: { question },
          });
        }
        return { url, store, reopened, owner, worker, objective, team, turn, ask, account, route };
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

      it("projects an Objective's question and clears it when the Objective takes a later turn", async () => {
        const f = await fixture();
        const asking = await f.turn();
        await f.ask(asking.task.id, "Which export format?");

        const page = await f.reopened.readCoordinationInbox({ kind: "question" });
        expect(page.projectionVersion).toBe(8);
        expect(page.items).toMatchObject([
          {
            key: `question:${asking.task.id}`,
            kind: "question",
            objectiveId: f.objective.id,
            operatorEligible: true,
            question: { text: "Which export format?", truncated: false },
            commands: [`supertag message objective ${f.objective.id} TEXT`],
            evidence: [
              { kind: "task", id: asking.task.id, status: "completed" },
              { kind: "objective", id: f.objective.id },
            ],
          },
        ]);
        // The turn's own request text stays out of the projection.
        expect(JSON.stringify(page)).not.toContain("secret instruction");

        // A work Session's question is not the Objective's; only its own Session's latest turn counts.
        const work = await f.turn({ tagId: f.worker.id, work: "export" });
        await f.ask(work.task.id, "Which bucket?");
        expect(
          (await f.reopened.readCoordinationInbox({ kind: "question" })).items.map(
            (item) => item.key,
          ),
        ).toEqual([`question:${asking.task.id}`]);

        // Once the Objective takes a later turn, the old question is no longer the latest.
        await f.turn();
        expect((await f.reopened.readCoordinationInbox({ kind: "question" })).items).toEqual([]);
      });

      it("cuts an over-long question and marks it truncated", async () => {
        const f = await fixture();
        const asking = await f.turn();
        await f.ask(asking.task.id, "Q".repeat(900));
        const [item] = (await f.reopened.readCoordinationInbox({ kind: "question" })).items;
        expect(item?.question?.truncated).toBe(true);
        expect(item?.question?.text).toHaveLength(500);
        expect(item?.question?.text.endsWith("…")).toBe(true);
      });

      it("projects a spent budget and a passed deadline as separate decisions", async () => {
        const f = await fixture();
        await f.turn(); // The Objective started; limits only apply to started Objectives.
        const at = new Date().toISOString();
        const past = new Date(Date.now() - 60_000).toISOString();
        const withDeadline = await f.store.updateObjectiveStatus(f.objective.id, {
          deadline: past,
          expectedRevision: f.objective.revision,
        });
        const limited = await f.store.recordObjectiveLimitState(
          f.objective.id,
          {
            ...(withDeadline.limitState ?? {}),
            ...spentState(100, 110, at),
            deadlinePassed: { deadline: past, at },
          },
          withDeadline.revision,
        );
        if (!limited) throw new Error("Limit state was not recorded");

        const page = await f.reopened.readCoordinationInbox({});
        const budget = page.items.find((item) => item.kind === "objective_budget");
        expect(budget).toMatchObject({
          objectiveId: f.objective.id,
          operatorEligible: true,
          commands: [`supertag update objective ${f.objective.id} --budget-minor N`],
          permittedActions: [
            {
              tool: "update_objective",
              arguments: { objectiveId: f.objective.id, expectedRevision: limited.revision },
              requiredInputFields: ["budgetLimitMinor"],
            },
          ],
        });
        const deadline = page.items.find((item) => item.kind === "objective_limit");
        expect(deadline?.reason).toContain("passed");
        expect(deadline?.commands).toEqual([
          `supertag update objective ${f.objective.id} --deadline ISO-8601`,
        ]);
        expect(deadline?.permittedActions[0]?.requiredInputFields).toEqual(["deadline"]);

        // A closed Objective leaves the inbox.
        await f.store.cancelObjective(f.objective.id, {}, { operatorId: "operator" });
        expect((await f.reopened.readCoordinationInbox({})).items).toEqual([]);
      });

      it("shows a Task held for a lapsed MCP login with the login command until scheduling clears", async () => {
        const f = await fixture();
        const held = await f.turn({ tagId: f.worker.id, work: "notion" });
        await f.store.appendTaskEvent({
          taskId: held.task.id,
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
            key: `mcp_login:${held.task.id}:notion`,
            kind: "mcp_login",
            operatorEligible: true,
            nextActorTagIds: [],
            commands: [
              "supertag mcp login notion",
              `supertag describe objective ${f.objective.id}`,
            ],
          }),
        ]);
        expect(JSON.stringify(page)).not.toContain("secret instruction");
        await f.store.appendTaskEvent({
          taskId: held.task.id,
          type: "task.scheduling-compatible",
          payload: { version: 1, status: "compatible" },
        });
        expect(
          (await f.reopened.readCoordinationInbox({ limit: 10, kind: "mcp_login" })).items,
        ).toEqual([]);
      });

      it("asks an operator to recover a turn whose completion could not be confirmed", async () => {
        const f = await fixture();
        const uncertain = await f.turn({ tagId: f.worker.id, work: "deploy" });
        await f.store.claimDueInboundEvent({
          inboundEventId: uncertain.inboundEventId,
          leaseOwner: "lost",
          now: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        await f.store.startTask({ taskId: uncertain.task.id, startedAt: new Date().toISOString() });
        const attempt = await f.store.createTaskAttempt({
          taskId: uncertain.task.id,
          attemptNumber: 1,
          workerProfile: { id: "uncertain", revision: "1" },
          workerSnapshot: { durableExecution: true },
          startedAt: new Date().toISOString(),
        });
        await f.store.blockInboundSession(uncertain.inboundEventId, "Worker Host restarted");

        const page = await f.reopened.readCoordinationInbox({ kind: "task_attention" });
        expect(page.items).toMatchObject([
          {
            key: `task_attention:${uncertain.task.id}:uncertain:${attempt.id}`,
            kind: "task_attention",
            objectiveId: f.objective.id,
            uncertainAttempt: { attemptId: attempt.id },
            redaction: { level: "metadata_only", omitted: ["request", "result"] },
          },
        ]);
        expect(page.items[0]?.reason).toContain("Worker Host restarted");
        expect(page.items[0]?.commands?.[0]).toContain("supertag recover worklet");
        expect(JSON.stringify(page)).not.toContain("secret instruction");
      });

      it("preserves database ordering across pages with equal timestamps and mixed-case keys", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date());
        const f = await fixture();
        const asking = await f.turn();
        await f.ask(asking.task.id, "Which format?");
        const held = await f.turn({ tagId: f.worker.id, work: "notion" });
        await f.store.appendTaskEvent({
          taskId: held.task.id,
          type: "task.scheduling-incompatible",
          payload: { version: 1, status: "incompatible", mcpLogins: ["notion", "airtable"] },
        });

        const all = await f.store.readCoordinationInbox({});
        expect(all.items.length).toBeGreaterThan(1);
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await f.store.readCoordinationInbox({
            limit: 1,
            ...(cursor ? { cursor } : {}),
          });
          expect(page.asOf).toBe(all.asOf);
          keys.push(...page.items.map((item) => item.key));
          cursor = page.nextCursor;
        } while (cursor);
        expect(keys).toEqual(all.items.map((item) => item.key));
        expect(new Set(keys).size).toBe(keys.length);
      });

      it("finds open work behind more closed Objectives than the candidate scan holds", async () => {
        const f = await fixture();
        const history = COORDINATION_INBOX_CANDIDATE_SCAN_LIMIT + 50;
        const raw = rawDatabase(f.url);
        try {
          const { db, tables } = raw;
          const old = (index: number) =>
            new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();
          const [objectiveRow] = await db
            .select()
            .from(tables.objectives)
            .where(eq(tables.objectives.id, f.objective.id));
          const chunks = <T>(rows: T[]): T[][] =>
            Array.from({ length: Math.ceil(rows.length / 200) }, (_, index) =>
              rows.slice(index * 200, index * 200 + 200),
            );
          const objectiveIds = Array.from({ length: history }, () => randomUUID());
          for (const chunk of chunks(objectiveIds))
            await db.insert(tables.objectives).values(
              chunk.map((id, index) => ({
                ...objectiveRow,
                id,
                status: "cancelled",
                createdAt: old(index),
                updatedAt: old(index),
              })),
            );
        } finally {
          await raw.close();
        }
        const lateObjective = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Late question work",
          teamId: f.team.id,
        });
        const asking = await f.turn();
        await f.ask(asking.task.id, "Which format?");
        const late = await f.turn({ objectiveId: lateObjective.id });
        await f.ask(late.task.id, "Which bucket?");
        for (const input of [{}, { kind: "question" as const }]) {
          const page = await f.reopened.readCoordinationInbox(input);
          expect(page.truncatedKinds).toEqual([]);
          expect(page.items.map((item) => item.key)).toEqual([
            `question:${asking.task.id}`,
            `question:${late.task.id}`,
          ]);
        }
        // And paging one at a time reaches both.
        const first = await f.store.readCoordinationInbox({ kind: "question", limit: 1 });
        expect(first.items.map((item) => item.key)).toEqual([`question:${asking.task.id}`]);
        const next = await f.reopened.readCoordinationInbox({ cursor: first.nextCursor, limit: 1 });
        expect(next.items.map((item) => item.key)).toEqual([`question:${late.task.id}`]);
        expect(next.nextCursor).toBeUndefined();
      }, 120_000);

      it("keeps filters and cursors stable", async () => {
        const f = await fixture();
        const asking = await f.turn();
        await f.ask(asking.task.id, "Which format?");
        const held = await f.turn({ tagId: f.worker.id, work: "notion" });
        await f.store.appendTaskEvent({
          taskId: held.task.id,
          type: "task.scheduling-incompatible",
          payload: { version: 1, status: "incompatible", mcpLogins: ["notion", "airtable"] },
        });
        const first = await f.store.readCoordinationInbox({
          objectiveId: f.objective.id,
          kind: "mcp_login",
          limit: 1,
        });
        expect(first.nextCursor).toBeDefined();
        const second = await f.store.readCoordinationInbox({ cursor: first.nextCursor, limit: 1 });
        expect(second.asOf).toBe(first.asOf);
        expect(second.items[0]?.kind).toBe("mcp_login");
        expect(second.items[0]?.key).not.toBe(first.items[0]?.key);
        await expect(
          f.store.readCoordinationInbox({ cursor: first.nextCursor, kind: "question" }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
          f.store.readCoordinationInbox({ kind: "objective_ready_for_review" as never }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });
    },
  );
}
