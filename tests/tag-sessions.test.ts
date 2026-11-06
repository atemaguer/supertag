import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { surfaceTools } from "../apps/cli/src/coordination-http.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { tagPortfolio } from "../packages/control-plane/src/tag-sessions.js";
import {
  emptyTagContextPlan,
  type InboundSurfaceEvent,
  type SurfaceTagAuthorizationSnapshot,
  sessionRequesterKey,
  type TaskResult,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const PostgresqlPool = createRequire(new URL("../packages/store/package.json", import.meta.url))(
  "pg",
).Pool as new (options: {
  connectionString: string;
  max: number;
}) => { query(text: string): Promise<unknown>; end(): Promise<void> };

function result(summary: string): TaskResult {
  return {
    summary,
    decisions: [],
    changes: [],
    unresolved: [],
    findings: [],
    references: [],
    artifacts: [],
  };
}

it("advertises tight schemas for the Session tools", () => {
  const schema = (name: string) => {
    const tool = surfaceTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    return tool.inputSchema;
  };
  const limit = { type: "integer", minimum: 1, maximum: 20 };
  expect(schema("list_sessions")).toEqual({
    type: "object",
    properties: { limit, offset: { type: "integer", minimum: 0 } },
    required: [],
    additionalProperties: false,
  });
  expect(schema("search_sessions")).toEqual({
    type: "object",
    properties: { query: { type: "string", minLength: 1, maxLength: 200 }, limit },
    required: ["query"],
    additionalProperties: false,
  });
  expect(schema("read_session")).toMatchObject({
    properties: { sessionId: { type: "string", minLength: 1 }, limit, before: { type: "string" } },
    required: ["sessionId"],
    additionalProperties: false,
  });
  expect(schema("list_objectives")).toMatchObject({
    properties: { limit },
    required: [],
    additionalProperties: false,
  });
  expect(schema("read_objective")).toMatchObject({
    properties: { objectiveId: { type: "string" } },
    required: [],
  });
  for (const name of [
    "list_sessions",
    "search_sessions",
    "read_session",
    "list_objectives",
    "read_objective",
  ])
    expect(surfaceTools.find((tool) => tool.name === name)?.description).toContain("untrusted");
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Tag Sessions`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-tag-sessions-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const databasePath = join(directory, "state.db");
      let url = `file:${databasePath}`;
      if (dialect === "postgresql") {
        if (!postgres) throw new Error("Missing PostgreSQL test database");
        const isolated = await createIsolatedPostgresDatabase(postgres);
        url = isolated.url;
        cleanups.push(isolated.cleanup);
      }
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      const at = new Date().toISOString();
      const tag = await store.createTag({ name: "SuperTag" });
      const otherTag = await store.createTag({ name: "Other" });
      const account = await store.saveSurfaceAccount({
        provider: "slack",
        externalAccountId: randomUUID(),
        displayName: "Fixture",
        authMethod: "simulation",
        credentialId: randomUUID(),
        status: "connected",
        configuration: {},
        verifiedAt: at,
      });
      const route = await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C1",
      });
      const larkAccount = await store.saveSurfaceAccount({
        provider: "lark",
        externalAccountId: randomUUID(),
        displayName: "Lark fixture",
        authMethod: "simulation",
        credentialId: randomUUID(),
        status: "connected",
        configuration: {},
        verifiedAt: at,
      });
      const larkRoute = await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: larkAccount.id,
        scope: "chat:oc_1",
      });
      const keyOf = (actorId: string) => sessionRequesterKey("slack", account.id, actorId);
      /** Runs SQL directly against the fixture database, as a migration would. */
      const execute = async (statement: string) => {
        if (dialect === "sqlite") {
          const database = new Database(databasePath);
          try {
            database.exec(statement);
          } finally {
            database.close();
          }
          return;
        }
        const pool = new PostgresqlPool({ connectionString: url, max: 1 });
        try {
          await pool.query(statement);
        } finally {
          await pool.end();
        }
      };

      /** A running conversation Task in its own Session, as a verified surface would admit it. */
      const conversation = async (input: {
        readonly actorId: string;
        readonly text: string;
        readonly direct?: boolean;
        readonly sessionKey?: string;
        /** Admit the message from the Lark account in a chat of this type. */
        readonly larkChatType?: "p2p" | "group";
      }) => {
        const sessionKey = input.sessionKey ?? randomUUID();
        const thread = randomUUID();
        const lark = input.larkChatType !== undefined;
        const surfaceAccount = lark ? larkAccount : account;
        const surfaceRoute = lark ? larkRoute : route;
        const provider = lark ? "lark" : "slack";
        const scope = lark ? "chat:oc_1" : "channel:C1";
        const event: InboundSurfaceEvent = {
          eventId: randomUUID(),
          logicalEventId: randomUUID(),
          provider,
          externalAccountId: surfaceAccount.externalAccountId,
          kind: "mention",
          scope,
          sessionKey,
          actor: { id: input.actorId, kind: "user" },
          ...(input.direct ? { direct: true } : {}),
          text: input.text,
          occurredAt: at,
          callback: {
            provider: "slack",
            mode: "slack_thread",
            threadKey: `T1|C1|${thread}`,
            target: { channelId: "C1", threadTs: thread },
          },
          source: {},
          metadata: lark ? { chatType: input.larkChatType } : {},
        };
        const authorization: SurfaceTagAuthorizationSnapshot = {
          version: 5,
          capturedAt: at,
          tag: { id: tag.id, name: tag.name },
          origin: {
            tagRouteId: surfaceRoute.id,
            surfaceAccountId: surfaceAccount.id,
            provider,
            scope,
          },
          requester: event.actor,
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        };
        const contextPlan = emptyTagContextPlan(at);
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: surfaceAccount.id,
          tagRouteId: surfaceRoute.id,
          tagId: tag.id,
          authorization,
          contextPlan,
          event,
        });
        const session = await store.openSession({
          tagId: tag.id,
          sessionKey,
          origin: { provider, surfaceAccountId: surfaceAccount.id, scope },
          ...(input.direct ? { audienceActorKey: keyOf(input.actorId) } : {}),
          at: new Date().toISOString(),
        });
        const task = await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: tag.id,
          sessionId: session.id,
          execution: { profile: { id: "default", revision: "1" } },
          actor: event.actor,
          trigger: { kind: "mention" },
          requestText: input.text,
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan,
          createdAt: at,
        });
        const claimed = await store.claimDueInboundEvent({
          inboundEventId: admitted.work.id,
          leaseOwner: "tag-sessions-test",
          now: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 300000).toISOString(),
        });
        if (!claimed) throw new Error("Fixture could not claim the message");
        await store.startTask({ taskId: task.id, startedAt: at });
        const attempt = await store.createTaskAttempt({
          workerProfile: { id: "default", revision: "1" },
          taskId: task.id,
          attemptNumber: 1,
          workerSnapshot: { kind: "test" },
          startedAt: at,
        });
        const caller = { kind: "surface" as const, taskId: task.id, attemptId: attempt.id };
        const complete = async (summary: string) => {
          const endedAt = new Date().toISOString();
          await store.closeTaskAttempt({ attemptId: attempt.id, status: "completed", endedAt });
          await store.closeTask({
            taskId: task.id,
            status: "completed",
            result: result(summary),
            endedAt,
          });
          await store.completeInboundEvent({
            inboundEventId: admitted.work.id,
            leaseOwner: "tag-sessions-test",
            workerId: "test",
            responseText: summary,
            completedAt: endedAt,
          });
        };
        return { task, session, caller, complete };
      };
      const controller = new ObjectiveController(store, undefined);
      controller.activateCoordination({ url: "http://127.0.0.1:3434" });
      const call = (name: string, input: Record<string, unknown>, caller: { taskId: string }) =>
        // biome-ignore lint/suspicious/noExplicitAny: assertions read the JSON tool results directly.
        controller.commandAsAttempt(name, input, caller as never) as Promise<any>;
      return {
        store,
        tag,
        otherTag,
        larkAccount,
        keyOf,
        conversation,
        controller,
        call,
        execute,
      };
    }

    it("keeps the audience a Session opened with", async () => {
      const f = await fixture();
      const at = new Date().toISOString();
      const origin = { provider: "slack", scope: "channel:C1" };
      const shared = await f.store.openSession({ tagId: f.tag.id, sessionKey: "s", origin, at });
      expect(shared.audience).toBe("shared");
      expect(shared.audienceActorKey).toBeUndefined();
      const reopened = await f.store.openSession({
        tagId: f.tag.id,
        sessionKey: "s",
        origin,
        audienceActorKey: f.keyOf("alice"),
        at,
      });
      expect(reopened).toMatchObject({ id: shared.id, audience: "shared" });
      const direct = await f.store.openSession({
        tagId: f.tag.id,
        sessionKey: "d",
        origin,
        audienceActorKey: f.keyOf("alice"),
        at,
      });
      expect(direct).toMatchObject({ audience: "private", audienceActorKey: f.keyOf("alice") });
      expect(
        await f.store.openSession({ tagId: f.tag.id, sessionKey: "d", origin, at }),
      ).toMatchObject({ id: direct.id, audience: "private", audienceActorKey: f.keyOf("alice") });
      expect(await f.store.findSessionById(direct.id)).toMatchObject({ audience: "private" });
    });

    it("lists, searches and reads shared Sessions and the requester's own private ones only", async () => {
      const f = await fixture();
      const shared = await f.conversation({ actorId: "carol", text: "Deploy the BILLING service" });
      await shared.complete("Billing deployed to staging");
      const bobPrivate = await f.conversation({
        actorId: "bob",
        text: "Draft my billing review",
        direct: true,
      });
      await bobPrivate.complete("Billing review drafted for Bob");
      const alicePrivate = await f.conversation({
        actorId: "alice",
        text: "Remind me about billing",
        direct: true,
      });
      await alicePrivate.complete("Billing reminder noted");
      const alice = await f.conversation({ actorId: "alice", text: "What about billing?" });

      const listed = await f.call("list_sessions", {}, alice.caller);
      expect(listed.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(
        [shared.session.id, alicePrivate.session.id].sort(),
      );
      expect(
        listed.sessions.find((s: { sessionId: string }) => s.sessionId === shared.session.id),
      ).toMatchObject({
        audience: "shared",
        provider: "slack",
        scope: "channel:C1",
        firstRequest: "Deploy the BILLING service",
      });

      const found = await f.call("search_sessions", { query: "billing" }, alice.caller);
      expect(found.matches.map((m: { taskId: string }) => m.taskId).sort()).toEqual(
        [shared.task.id, alicePrivate.task.id].sort(),
      );
      expect(
        found.matches.find((m: { taskId: string }) => m.taskId === shared.task.id),
      ).toMatchObject({
        sessionId: shared.session.id,
        provider: "slack",
        requestExcerpt: "Deploy the BILLING service",
        summaryExcerpt: "Billing deployed to staging",
      });
      expect(
        (await f.call("search_sessions", { query: "STAGING" }, alice.caller)).matches,
      ).toHaveLength(1);
      expect(
        (await f.call("search_sessions", { query: "no such text" }, alice.caller)).matches,
      ).toEqual([]);

      const read = await f.call("read_session", { sessionId: shared.session.id }, alice.caller);
      expect(read.session).toMatchObject({ sessionId: shared.session.id, audience: "shared" });
      expect(read.entries).toMatchObject([
        { taskId: shared.task.id, requestText: "Deploy the BILLING service" },
      ]);
      await expect(
        f.call("read_session", { sessionId: bobPrivate.session.id }, alice.caller),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        f.call("read_session", { sessionId: alicePrivate.session.id }, alice.caller),
      ).resolves.toMatchObject({ entries: [{ taskId: alicePrivate.task.id }] });

      await expect(
        f.call("search_sessions", { query: "x".repeat(201) }, alice.caller),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(f.call("list_sessions", { limit: 21 }, alice.caller)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(f.call("list_sessions", { extra: true }, alice.caller)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("pages one Session's history with before", async () => {
      const f = await fixture();
      const sessionKey = randomUUID();
      for (const text of ["first", "second", "third"]) {
        const turn = await f.conversation({ actorId: "carol", text, sessionKey });
        await turn.complete(`${text} done`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const reader = await f.conversation({ actorId: "alice", text: "catch me up" });
      const sessionId = (await f.store.findSessionByTagAndKey(f.tag.id, sessionKey))?.id;
      const page = await f.call("read_session", { sessionId, limit: 2 }, reader.caller);
      expect(page.entries.map((e: { requestText: string }) => e.requestText)).toEqual([
        "second",
        "third",
      ]);
      const older = await f.call(
        "read_session",
        { sessionId, limit: 2, before: page.nextBefore },
        reader.caller,
      );
      expect(older.entries.map((e: { requestText: string }) => e.requestText)).toEqual(["first"]);
      expect(older.nextBefore).toBeUndefined();
    });

    it("builds the portfolio from visible open Objectives and reads them Tag-wide", async () => {
      const f = await fixture();
      const bobPrivate = await f.conversation({
        actorId: "bob",
        text: "@SuperTag objective Bob's private plan",
        direct: true,
      });
      const hidden = await f.store.createSurfaceObjective({
        taskId: bobPrivate.task.id,
        outcome: "Bob's private plan",
      });
      await bobPrivate.complete("Created");
      const homed = await f.conversation({
        actorId: "carol",
        text: "@SuperTag objective Ship the release notes",
      });
      const shipped = await f.store.createSurfaceObjective({
        taskId: homed.task.id,
        outcome: "Ship the release notes",
        deadline: "2030-01-01T00:00:00.000Z",
      });
      await homed.complete("Created");
      const done = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.tag.id,
        outcome: "Already done",
      });
      await f.store.updateObjectiveStatus(done.id, {
        expectedRevision: done.revision,
        status: "completed",
        completionSummary: "Done",
      });
      const cancelled = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.tag.id,
        outcome: "Cancelled work",
      });
      await f.store.cancelObjective(cancelled.id, {}, { operatorId: "test" });
      const foreign = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.otherTag.id,
        outcome: "Another Tag's work",
      });
      const alice = await f.conversation({ actorId: "alice", text: "What are you working on?" });
      const viewer = {
        tagId: f.tag.id,
        sessionId: alice.task.sessionId,
        requesterKey: f.keyOf("alice"),
      };
      const portfolio = await tagPortfolio(f.store, viewer);
      expect(portfolio).toContain(
        `- ${shipped.id} [working, deadline 2030-01-01T00:00:00.000Z] Ship the release notes (from slack channel:C1)`,
      );
      expect(portfolio).toContain("search_sessions, list_sessions and read_session");
      for (const absent of [hidden.id, done.id, cancelled.id, foreign.id])
        expect(portfolio).not.toContain(absent);
      // The same person sees their own private Objective from another conversation.
      const bob = await f.conversation({ actorId: "bob", text: "status?" });
      expect(
        await tagPortfolio(f.store, {
          tagId: f.tag.id,
          sessionId: bob.task.sessionId,
          requesterKey: f.keyOf("bob"),
        }),
      ).toContain(hidden.id);

      const listed = await f.call("list_objectives", {}, alice.caller);
      expect(listed).toMatchObject({ total: 1, objectives: [{ id: shipped.id }] });
      await expect(
        f.call("read_objective", { objectiveId: shipped.id }, alice.caller),
      ).resolves.toMatchObject({ id: shipped.id, outcome: "Ship the release notes" });
      await expect(
        f.call("read_objective", { objectiveId: done.id }, alice.caller),
      ).resolves.toMatchObject({ id: done.id, status: "completed" });
      for (const objectiveId of [hidden.id, foreign.id])
        await expect(f.call("read_objective", { objectiveId }, alice.caller)).rejects.toMatchObject(
          { statusCode: 404 },
        );
      // Without an id read_objective still reads only the bound Objective.
      await expect(f.call("read_objective", {}, alice.caller)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        f.call("list_tasks", { objectiveId: shipped.id }, alice.caller),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("hides an operator Objective that notifies a private Session from other people", async () => {
      const f = await fixture();
      const bobPrivate = await f.conversation({ actorId: "bob", text: "notify me", direct: true });
      await bobPrivate.complete("Noted");
      const notifying = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.tag.id,
        outcome: "Bob's operator-created plan",
        notificationTaskId: bobPrivate.task.id,
      });
      const alice = await f.conversation({ actorId: "alice", text: "What are you working on?" });
      expect(
        await tagPortfolio(f.store, {
          tagId: f.tag.id,
          sessionId: alice.task.sessionId,
          requesterKey: f.keyOf("alice"),
        }),
      ).toContain("owns no open Objectives");
      expect(await f.call("list_objectives", {}, alice.caller)).toMatchObject({
        total: 0,
        objectives: [],
      });
      await expect(
        f.call("read_objective", { objectiveId: notifying.id }, alice.caller),
      ).rejects.toMatchObject({ statusCode: 404 });

      const bob = await f.conversation({ actorId: "bob", text: "status?" });
      expect(
        await tagPortfolio(f.store, {
          tagId: f.tag.id,
          sessionId: bob.task.sessionId,
          requesterKey: f.keyOf("bob"),
        }),
      ).toContain(notifying.id);
      expect(await f.call("list_objectives", {}, bob.caller)).toMatchObject({
        total: 1,
        objectives: [{ id: notifying.id, home: { provider: "slack", scope: "channel:C1" } }],
      });
      await expect(
        f.call("read_objective", { objectiveId: notifying.id }, bob.caller),
      ).resolves.toMatchObject({ id: notifying.id });
    });

    it("backfills Lark direct-chat Sessions opened before Session audience as private", async () => {
      const f = await fixture();
      const direct = await f.conversation({ actorId: "ou_dm", text: "hi", larkChatType: "p2p" });
      await direct.complete("Hello");
      const group = await f.conversation({
        actorId: "ou_group",
        text: "hi",
        larkChatType: "group",
      });
      await group.complete("Hello");
      const slack = await f.conversation({ actorId: "carol", text: "hi" });
      // Before the audience migration every Session became shared.
      await f.execute(`UPDATE "Session" SET "audience" = 'shared', "audienceActorKey" = NULL`);
      const backfill = await readFile(
        new URL(
          `../packages/store/drizzle/${dialect}/0030_session_audience_backfill.sql`,
          import.meta.url,
        ),
        "utf8",
      );
      for (const statement of backfill.split("--> statement-breakpoint"))
        await f.execute(statement);
      expect(await f.store.findSessionById(direct.session.id)).toMatchObject({
        audience: "private",
        audienceActorKey: `lark:${f.larkAccount.id}:ou_dm`,
      });
      for (const shared of [group, slack]) {
        const session = await f.store.findSessionById(shared.session.id);
        expect(session).toMatchObject({ audience: "shared" });
        expect(session?.audienceActorKey).toBeUndefined();
      }
    });

    it("caps the portfolio at 20 lines with a count of the rest", async () => {
      const f = await fixture();
      for (let index = 0; index < 23; index++)
        await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.tag.id,
          outcome: `Outcome ${index} ${"long ".repeat(60)}`,
        });
      const alice = await f.conversation({ actorId: "alice", text: "hi" });
      const portfolio = await tagPortfolio(f.store, {
        tagId: f.tag.id,
        sessionId: alice.task.sessionId,
        requesterKey: f.keyOf("alice"),
      });
      if (portfolio === undefined) throw new Error("Expected a portfolio");
      const lines = portfolio.split("\n").filter((line) => line.startsWith("- "));
      expect(lines.length).toBeLessThanOrEqual(20);
      expect(portfolio).toContain(`…and ${23 - lines.length} more`);
      expect(portfolio.length).toBeLessThan(4000);
      for (const line of lines) expect(line).toContain("…");
      expect(
        await tagPortfolio(f.store, {
          tagId: f.otherTag.id,
          sessionId: alice.task.sessionId,
          requesterKey: f.keyOf("alice"),
        }),
      ).toContain("owns no open Objectives");
    });
  });
}
