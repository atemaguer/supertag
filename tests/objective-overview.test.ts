import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatObjectiveOverview } from "../apps/cli/src/objective-overview.js";
import { buildObjectiveOverview } from "../packages/control-plane/src/objective-overview.js";
import {
  emptyTagContextPlan,
  type InternalTurn,
  objectiveSessionKey,
  type Tag,
  type TagAuthorizationSnapshot,
  type TaskResult,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Objective overview`, () => {
    const cleanups: Array<() => Promise<unknown>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    }, 30_000);

    async function fixture(options: { readonly budgetLimitMinor?: number } = {}) {
      const directory = await mkdtemp(join(tmpdir(), "supertag-overview-"));
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
      const helper = await store.createTag({ name: `helper-${randomUUID()}` });
      const team = await store.createTeam({
        id: randomUUID(),
        name: `delivery-${randomUUID()}`,
        memberTagIds: [owner.id, helper.id],
        maxConcurrency: 2,
      });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Deliver a reviewed result",
        teamId: team.id,
        ...(options.budgetLimitMinor === undefined
          ? {}
          : { budgetLimitMinor: options.budgetLimitMinor, budgetCurrency: "USD" }),
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
      const routes = new Map<string, string>();
      const routeOf = async (tag: Tag) => {
        const known = routes.get(tag.id);
        if (known !== undefined) return known;
        const route = await store.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: account.id,
          scope: `channel:${tag.id}`,
        });
        routes.set(tag.id, route.id);
        return route.id;
      };
      let clock = 0;
      const nextAt = () => new Date(Date.UTC(2026, 10, 7, 0, 0, clock++)).toISOString();

      /** Opens one turn of a Session of the Objective, as the dispatcher does at admission. */
      async function turn(input: {
        readonly tag?: Tag;
        readonly sessionKey?: string;
        readonly parentSessionId?: string;
        readonly title?: string;
        readonly internal?: InternalTurn;
        readonly requestText?: string;
        readonly workspace?: string;
        readonly operatorId?: string;
      }) {
        const tag = input.tag ?? owner;
        const sessionKey = input.sessionKey ?? objectiveSessionKey(objective.id);
        const at = nextAt();
        const tagRouteId = await routeOf(tag);
        const authorization = {
          version: 5,
          capturedAt: at,
          tag: { id: tag.id, name: tag.name },
          origin: {
            provider: "slack",
            surfaceAccountId: account.id,
            tagRouteId,
            scope: `channel:${tag.id}`,
          },
          requester: { id: input.operatorId ?? "supertag", kind: "service" },
          roles: [],
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        } as unknown as TagAuthorizationSnapshot;
        const contextPlan = emptyTagContextPlan(at);
        const actor =
          input.operatorId === undefined
            ? ({ id: "supertag", kind: "bot" } as const)
            : ({ id: input.operatorId, kind: "user" } as const);
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId,
          tagId: tag.id,
          authorization,
          contextPlan,
          event: {
            eventId: randomUUID(),
            logicalEventId: randomUUID(),
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: `channel:${tag.id}`,
            sessionKey,
            actor,
            ...(input.internal === undefined ? {} : { internal: input.internal }),
            ...(input.requestText === undefined ? {} : { text: input.requestText }),
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: sessionKey,
              target: { channelId: "objective", threadTs: "1.0" },
            },
            source: {},
            metadata: {},
          },
        });
        const session = await store.openSession({
          tagId: tag.id,
          sessionKey,
          origin: input.title === undefined ? {} : { title: input.title },
          ...(input.parentSessionId === undefined
            ? {}
            : { parentSessionId: input.parentSessionId }),
          objectiveId: objective.id,
          at,
        });
        const task = await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: tag.id,
          sessionId: session.id,
          execution: {},
          actor,
          trigger: {},
          ...(input.requestText === undefined ? {} : { requestText: input.requestText }),
          workspacePlan:
            input.workspace === undefined
              ? { version: 1, status: "none" }
              : {
                  version: 1,
                  status: "workspace",
                  workspace: input.workspace,
                  branch: `supertag/${objective.id}/turn`,
                },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan,
          createdAt: at,
        });
        return { session, task, at };
      }

      const finish = (
        taskId: string,
        options: {
          readonly status?: "completed" | "failed";
          readonly responseText?: string;
          readonly result?: TaskResult;
          readonly outcome?: Record<string, unknown>;
        } = {},
      ) =>
        store.closeTask({
          taskId,
          status: options.status ?? "completed",
          ...(options.responseText === undefined ? {} : { responseText: options.responseText }),
          ...(options.result === undefined ? {} : { result: options.result }),
          ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
          endedAt: nextAt(),
        });

      const overview = async (input: { readonly limit?: number; readonly offset?: number } = {}) =>
        buildObjectiveOverview({
          store,
          objective: await store.getObjective(objective.id),
          sessions: await store.listObjectiveSessions(objective.id),
          team: await store.getTeam(team.id),
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
          executionReadiness: "ready",
          tagNames: { [owner.id]: owner.name, [helper.id]: helper.name },
          posts: await store.listTeamPosts(team.id, { limit: 50 }),
        });

      /** The Objective's own Session with one delivered start turn. */
      const start = () =>
        turn({
          internal: { kind: "delivery", from: { kind: "supertag" }, reason: "objective_start" },
          requestText: "Start: Deliver a reviewed result",
        });

      return { store, owner, helper, team, objective, turn, finish, overview, start, nextAt };
    }

    it("leads with the Objective's own conversation, then each work Session", async () => {
      const f = await fixture();
      const started = await f.start();
      await f.finish(started.task.id, { responseText: "Handing the build to the helper." });
      const work = await f.turn({
        tag: f.helper,
        sessionKey: `work:${started.session.id}:${randomUUID()}`,
        parentSessionId: started.session.id,
        title: "Build the exporter",
        internal: {
          kind: "work_session",
          startedByTaskId: started.task.id,
          parentSessionId: started.session.id,
          title: "Build the exporter",
        },
      });
      const view = await f.overview();
      expect(view.sessions.map((session) => [session.owner, session.tagId])).toEqual([
        [true, f.owner.id],
        [false, f.helper.id],
      ]);
      expect(view.sessions[1]).toMatchObject({
        title: "Build the exporter",
        parentSessionId: started.session.id,
        status: "pending",
        taskCount: 1,
      });
      expect(view.team).toMatchObject({ name: f.team.name, maxConcurrency: 2 });
      // The conversation holds what came in and what the owner replied.
      expect(view.conversation).toEqual([
        {
          taskId: started.task.id,
          from: "supertag",
          text: "Start: Deliver a reviewed result",
          createdAt: started.at,
        },
        {
          taskId: started.task.id,
          from: "owner",
          text: "Handing the build to the helper.",
          createdAt: expect.any(String),
        },
      ]);
      const text = formatObjectiveOverview(view);
      expect(text).toContain(`Owner: ${f.owner.name}`);
      const names: Record<string, string> = {
        [f.owner.id]: f.owner.name,
        [f.helper.id]: f.helper.name,
      };
      expect(text).toContain(
        `Team: ${f.team.name} (${(view.team?.memberTagIds ?? []).map((id) => names[id]).join(", ")})`,
      );
      expect(text).toContain("Work: 2 Sessions");
      expect(text).toContain(`Objective conversation`);
      expect(text).toContain("Build the exporter");
      expect(text).toContain("at most 2 turns at once across its Objectives");
      expect(view.total).toBe(2);
      expect(work.task.id).toBeDefined();
    }, 30_000);

    it("marks the owner's turn waiting on its question and asks the operator to answer", async () => {
      const f = await fixture();
      const started = await f.start();
      await f.finish(started.task.id, {
        outcome: { question: "Which region first?" },
        responseText: "Which region first?",
      });
      const view = await f.overview();
      expect(view.sessions[0]).toMatchObject({
        owner: true,
        status: "waiting",
        question: "Which region first?",
      });
      expect(view.attention.map((item) => item.kind)).toContain("owner_question");
      const text = formatObjectiveOverview(view);
      expect(text).toContain(`${f.owner.name} asks: "Which region first?"`);
      expect(text).toContain(`supertag message objective ${f.objective.id} TEXT`);
    }, 30_000);

    it("explains a failed turn and lists the high findings of the latest results", async () => {
      const f = await fixture();
      const started = await f.start();
      const attempt = await f.store.createTaskAttempt({
        taskId: started.task.id,
        attemptNumber: 1,
        workerProfile: { id: "default", revision: "1" },
        workerSnapshot: { execution: { harness: "codex" } },
        startedAt: f.nextAt(),
      });
      await f.store.appendTaskEvent({
        taskId: started.task.id,
        attemptId: attempt.id,
        type: "execution.failed",
        payload: { error: { message: "The harness is not signed in." } },
      });
      await f.finish(started.task.id, {
        status: "failed",
        outcome: { failureKind: "harness_sign_in" },
        result: {
          summary: "Stopped early.",
          decisions: [],
          changes: [],
          unresolved: [],
          findings: [
            { id: "F1", severity: "high", summary: "Missing authorization.", location: "a.ts:4" },
          ],
          references: [],
          artifacts: [],
        } as unknown as TaskResult,
      });
      const view = await f.overview();
      expect(view.sessions[0]?.task).toMatchObject({ status: "failed", attemptStatus: "running" });
      expect(view.sessions[0]?.task?.explanations).toContainEqual(
        expect.objectContaining({
          kind: "execution_failed",
          message: "The harness is not signed in.",
          harness: "codex",
          failureKind: "harness_sign_in",
        }),
      );
      expect(view.highFindings).toEqual([
        {
          taskId: started.task.id,
          id: "F1",
          summary: "Missing authorization.",
          location: "a.ts:4",
        },
      ]);
      expect(formatObjectiveOverview(view)).toContain(
        "High findings (1):\n  " + `${started.task.id} F1: Missing authorization. (a.ts:4)`,
      );
    }, 30_000);

    it("reports the pool: one budget over the conversation and every Session beneath it", async () => {
      const f = await fixture({ budgetLimitMinor: 1000 });
      const started = await f.start();
      const attempt = await f.store.createTaskAttempt({
        taskId: started.task.id,
        attemptNumber: 1,
        workerProfile: { id: "default", revision: "1" },
        workerSnapshot: {},
        startedAt: f.nextAt(),
      });
      await f.store.appendTaskEvent({
        taskId: started.task.id,
        attemptId: attempt.id,
        type: "usage.updated",
        payload: {
          usage: {
            inputTokens: 10,
            outputTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 10,
            complete: true,
            reportedCost: { amountMinor: 250, currency: "USD" },
          },
        },
      });
      const view = await f.overview();
      // The pool is the Objective's one budget; usage is counted from every Session's Attempts.
      expect(view.pool).toMatchObject({ limitMinor: 1000, currency: "USD", spentMinor: 0 });
      expect(view.objectiveSpend.reportedCostByCurrency).toMatchObject({ USD: 250 });
      expect(formatObjectiveOverview(view)).toContain("Budget: $0.00 of $10.00 spent");
      // The limit sweep records reported spend against the pool.
      const objective = await f.store.getObjective(f.objective.id);
      await f.store.recordObjectiveLimitState(
        f.objective.id,
        {
          reportedSpend: {
            amountMinor: 250,
            currency: "USD",
            unknownAttemptIds: [],
            observedAt: f.nextAt(),
          },
          events: [],
        },
        objective.revision,
      );
      expect(formatObjectiveOverview(await f.overview())).toContain(
        "Budget: $2.50 of $10.00 spent",
      );
    }, 30_000);

    it("pages over the Tasks of every Session while keeping the whole view's totals", async () => {
      const f = await fixture();
      const started = await f.start();
      await f.finish(started.task.id, { responseText: "First." });
      const second = await f.turn({
        internal: {
          kind: "delivery",
          from: { kind: "person", id: "ops" },
          reason: "objective_message",
        },
        requestText: "Use the 2030 figures.",
        operatorId: "ops",
      });
      await f.finish(second.task.id, { responseText: "Updated." });
      const page = await f.overview({ limit: 1 });
      expect(page.tasks.map((task) => task.taskId)).toEqual([started.task.id]);
      expect(page.total).toBe(2);
      expect(page.nextOffset).toBe(1);
      // The conversation and the Sessions are the whole Objective, never one page of it.
      expect(page.conversation).toHaveLength(4);
      expect(page.conversation[2]).toMatchObject({
        from: "operator",
        operatorId: "ops",
        text: "Use the 2030 figures.",
      });
      const next = await f.overview({ limit: 1, offset: 1 });
      expect(next.tasks.map((task) => task.taskId)).toEqual([second.task.id]);
      expect(next.nextOffset).toBeNull();
    }, 30_000);

    it("shows the Team's posts and keeps a paused or cancelled Objective's next step", async () => {
      const f = await fixture();
      await f.start();
      await f.store.post({
        teamId: f.team.id,
        authorTagId: f.helper.id,
        body: "Export is ready for review.",
        to: [f.owner.id],
      });
      const posted = await f.overview();
      expect(posted.posts.map((post) => [post.sequence, post.body])).toEqual([
        [1, "Export is ready for review."],
      ]);
      await f.store.pauseObjective(f.objective.id, { operatorId: "ops" });
      const paused = await f.overview();
      expect(paused.attention).toContainEqual(
        expect.objectContaining({
          kind: "objective_paused",
          nextAction: `supertag resume objective ${f.objective.id}`,
        }),
      );
      expect(formatObjectiveOverview(paused)).toContain(
        `supertag resume objective ${f.objective.id}`,
      );
      await f.store.cancelObjective(
        f.objective.id,
        { reason: "Superseded" },
        { operatorId: "ops" },
      );
      const cancelled = await f.overview();
      expect(cancelled.attention.map((item) => item.kind)).toContain("objective_cancelled");
      // A closed Objective no longer reports whether it could run.
      expect(formatObjectiveOverview(cancelled)).not.toContain("Runnable");
      expect(formatObjectiveOverview(cancelled)).toContain("Nothing was delivered.");
    }, 30_000);

    it("renders agent-authored text without terminal controls", async () => {
      const f = await fixture();
      const started = await f.start();
      await f.finish(started.task.id, {
        outcome: { question: "Pick one:\u001b[2K\r rm -rf /" },
        responseText: "Pick one.",
      });
      const text = formatObjectiveOverview(await f.overview());
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\r");
    }, 30_000);
  });
}
