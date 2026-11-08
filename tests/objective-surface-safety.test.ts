import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { SessionPersistence } from "../packages/control-plane/src/session-persistence.js";
import {
  emptyTagContextPlan,
  type InboundSurfaceEvent,
  type SurfaceTagAuthorizationSnapshot,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} surface Objective safety`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      async function fixture(provider: "github" | "slack" = "github") {
        const directory = await mkdtemp(join(tmpdir(), "supertag-surface-safety-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          if (!postgres) throw new Error("Missing PostgreSQL test database");
          const isolated = await createIsolatedPostgresDatabase(postgres);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        if (!url) throw new Error("Missing test database");
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const at = new Date().toISOString();
        const tag = await store.createTag({ name: "SuperTag" });
        const account = await store.saveSurfaceAccount({
          provider,
          externalAccountId: randomUUID(),
          displayName: "Fixture",
          authMethod: "simulation",
          credentialId: randomUUID(),
          status: "connected",
          configuration: {},
          verifiedAt: at,
        });
        const scope = provider === "slack" ? "channel:C1" : "repository:test/project";
        const route = await store.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: account.id,
          scope,
        });
        const sessionKey = randomUUID();
        const active = new Map<string, { taskId: string; attemptId: string; inboundId: string }>();
        const makeTask = async (patch: Partial<InboundSurfaceEvent> = {}) => {
          const event: InboundSurfaceEvent = {
            eventId: randomUUID(),
            logicalEventId: randomUUID(),
            provider,
            externalAccountId: account.externalAccountId,
            kind: "mention",
            scope,
            sessionKey,
            actor: { id: "supervisor", kind: "user" },
            text: "@SuperTag objective Validate scheduling; this is not approval to deploy",
            occurredAt: at,
            callback:
              provider === "slack"
                ? {
                    provider: "slack",
                    mode: "slack_thread",
                    threadKey: "T1|C1|1.000",
                    target: { channelId: "C1", threadTs: "1.000" },
                  }
                : {
                    provider: "github",
                    mode: "github_issue_comment",
                    threadKey: "test/project#1",
                    target: { repository: "test/project", number: "1" },
                  },
            source: {},
            metadata: {},
            ...patch,
          };
          const authorization: SurfaceTagAuthorizationSnapshot = {
            version: 5,
            capturedAt: at,
            tag: { id: tag.id, name: tag.name },
            origin: {
              tagRouteId: route.id,
              surfaceAccountId: account.id,
              provider: event.provider,
              scope: event.scope,
            },
            requester: event.actor,
            permissionSets: [],
            resources: [],
            runtimeActions: ["files:write"],
          };
          const contextPlan = emptyTagContextPlan(at);
          const admitted = await store.admitInboundEvent({
            surfaceAccountId: account.id,
            tagRouteId: route.id,
            tagId: tag.id,
            authorization,
            contextPlan,
            event,
          });
          const session = await store.openSession({
            tagId: tag.id,

            sessionKey: event.sessionKey,
            origin: { provider: event.provider, scope: event.scope },
            at,
          });
          const task = await store.openTask({
            inboundEventId: admitted.work.id,
            tagId: tag.id,
            sessionId: session.id,
            execution: { profile: { id: "default", revision: "1" } },
            actor: event.actor,
            trigger: { kind: "mention" },
            workspacePlan: { version: 1, status: "none" },
            sessionHistory: [],
            authorizationSnapshot: authorization,
            contextPlan,
            createdAt: at,
          });
          const previous = active.get(session.id);
          if (previous) {
            const endedAt = new Date().toISOString();
            await store.closeTaskAttempt({
              attemptId: previous.attemptId,
              status: "completed",
              endedAt,
            });
            await store.closeTask({ taskId: previous.taskId, status: "completed", endedAt });
            await store.completeInboundEvent({
              inboundEventId: previous.inboundId,
              leaseOwner: "surface-test",
              workerId: "test",
              responseText: "Done",
              completedAt: endedAt,
            });
          }
          const claimed = await store.claimDueInboundEvent({
            inboundEventId: admitted.work.id,
            leaseOwner: "surface-test",
            now: new Date().toISOString(),
            leaseExpiresAt: new Date(Date.now() + 300000).toISOString(),
          });
          if (!claimed) throw new Error("Fixture could not claim the next Session message");
          await store.startTask({ taskId: task.id, startedAt: at });
          const attempt = await store.createTaskAttempt({
            workerProfile: { id: "default", revision: "1" },
            taskId: task.id,
            attemptNumber: 1,
            workerSnapshot: { kind: "test" },
            startedAt: at,
          });
          active.set(session.id, {
            taskId: task.id,
            attemptId: attempt.id,
            inboundId: admitted.work.id,
          });
          const running = await store.findTaskById(task.id);
          if (!running) throw new Error("Missing Task");
          return { task: running, attempt, event };
        };
        const source = await makeTask();
        const controller = new ObjectiveController(store, undefined);
        controller.activateCoordination({ url: "http://127.0.0.1:3434" });
        return { store, tag, account, route, source, controller, makeTask };
      }
      it("validates notification destinations at creation and rejects forged or bot Tasks", async () => {
        const f = await fixture();
        const definition = {
          id: randomUUID(),
          ownerTagId: f.tag.id,
          outcome: "Notify operator",
        };
        const created = await f.store.createObjective({
          ...definition,
          notificationTaskId: f.source.task.id,
        });
        expect(created.notificationTaskId).toBe(f.source.task.id);
        expect(
          await f.store.createObjective({ ...definition, notificationTaskId: f.source.task.id }),
        ).toMatchObject({ id: created.id });
        await expect(f.store.createObjective(definition)).rejects.toMatchObject({
          statusCode: 409,
        });
        const bot = await f.makeTask({ actor: { id: "bot", kind: "bot" } });
        expect(await f.store.getVerifiedSurfaceTask(bot.task.id)).toBeUndefined();
        for (const taskId of [bot.task.id, "missing-task", "https://attacker.example/callback"]) {
          await expect(
            f.store.createObjective({
              ...definition,
              id: randomUUID(),
              notificationTaskId: taskId,
            }),
          ).rejects.toMatchObject({ statusCode: 400 });
          await expect(
            f.store.updateObjectiveStatus(created.id, {
              expectedRevision: created.revision,
              notificationTaskId: taskId,
            }),
          ).rejects.toMatchObject({ statusCode: 400 });
        }
      });
      it("gives bot executions Session storage without organizational coordination authority", async () => {
        const f = await fixture();
        const bot = await f.makeTask({ actor: { id: "automation", kind: "bot" } });
        await expect(f.controller.surfaceCoordination(bot.task, bot.attempt)).rejects.toThrow(
          "human",
        );
        const transport = await f.controller.sessionPersistence(bot.task, bot.attempt);
        expect(transport).toBeDefined();
        if (!transport) throw new Error("Missing Session persistence transport");
        await expect(
          f.controller.authenticateSessionExecution(transport.token),
        ).resolves.toMatchObject({ taskId: bot.task.id, attemptId: bot.attempt.id });
        await expect(f.controller.authenticateExecution(transport.token)).rejects.toThrow(
          "cannot authorize coordination",
        );
        const sessions = new SessionPersistence(f.store, f.controller);
        const state = {
          ref: { id: randomUUID(), format: "codex.v1", uri: "supertag:session:test" },
          harnessId: "codex",
          data: { threadId: "native-thread" },
          writeVersion: 1,
        };
        await sessions.command("save", state, transport.token);
        await expect(
          sessions.command("load", { ref: state.ref }, transport.token),
        ).resolves.toMatchObject({ data: state.data });
        await f.makeTask({ actor: { id: "automation", kind: "bot" } });
        await expect(sessions.command("load", { ref: state.ref }, transport.token)).rejects.toThrow(
          "expired",
        );
      });

      it("creates one Objective per verified conversation with source authority", async () => {
        const f = await fixture();
        const earlier = await f.makeTask({ text: "Inspect scheduling" });
        const input = {
          taskId: f.source.task.id,
          outcome: "Validate scheduling",
          deadline: "2099-01-01T00:00:00.000Z",
          budgetLimitMinor: 200000,
        };
        const results = await Promise.all([
          f.store.createSurfaceObjective(input),
          f.store.createSurfaceObjective(input),
        ]);
        expect(results[0]?.id).toBe(results[1]?.id);
        // The Objective belongs to the conversation, so every Task of it reads the same one.
        expect((await f.store.getSurfaceObjective(earlier.task.id))?.id).toBe(results[0]?.id);
        expect(results[0]).toMatchObject({
          ownerTagId: f.tag.id,
          runtimeActions: ["files:write"],
          budgetLimitMinor: 200000,
          outcome: "Validate scheduling",
          deadline: input.deadline,
        });
        expect((await f.store.getSurfaceObjective(f.source.task.id))?.id).toBe(results[0]?.id);
        if (!results[0]) throw new Error("Missing Objective");
        expect((await f.store.getObjectiveSurfaceTask(results[0].id))?.id).toBe(f.source.task.id);
      });
      it("rejects a reused session key with a different callback audience", async () => {
        const f = await fixture();
        await f.store.createSurfaceObjective({
          taskId: f.source.task.id,
          outcome: "Bound",
        });
        for (const patch of [
          {
            callback: {
              ...f.source.event.callback,
              target: { repository: "test/project", number: "2" },
            },
          },
          { callback: { ...f.source.event.callback, threadKey: "test/project#2" } },
          { scope: "repository:other/project" },
          { provider: "slack" as const },
          { externalAccountId: "another-account" },
        ]) {
          const forged = await f.makeTask(patch);
          expect(await f.store.getSurfaceObjective(forged.task.id)).toBeUndefined();
          await expect(
            f.store.createSurfaceObjective({
              taskId: forged.task.id,
              outcome: "Adopt",
            }),
          ).rejects.toThrow();
        }
      });
      it.each([
        "Help me inspect this scheduling product",
        "> @SuperTag objective Validate scheduling",
        "Someone wrote: @SuperTag objective Validate scheduling",
        "```\n@SuperTag objective Validate scheduling\n```",
      ])("does not create an Objective from ordinary or quoted text: %s", async (text) => {
        const f = await fixture();
        const source = await f.makeTask({ text });
        const capability = await f.controller.surfaceCoordination(source.task, source.attempt);
        const caller = await f.controller.authenticateExecution(capability.token);
        await expect(
          f.controller.commandAsAttempt(
            "create_objective",
            {
              outcome: "Validate scheduling",
            },
            caller,
          ),
        ).rejects.toThrow();
        expect(await f.store.getSurfaceObjective(source.task.id)).toBeUndefined();
      });
      it("does not turn model-supplied owner or runtime actions into authority", async () => {
        const f = await fixture();
        const capability = await f.controller.surfaceCoordination(f.source.task, f.source.attempt);
        const caller = await f.controller.authenticateExecution(capability.token);
        for (const injected of [
          { ownerTagId: "admin" },
          { runtimeActions: ["commands:execute"] },
          { taskId: "other" },
        ]) {
          await expect(
            f.controller.commandAsAttempt(
              "create_objective",
              { outcome: "Bound", ...injected },
              caller,
            ),
          ).rejects.toThrow();
        }
        expect(await f.store.getSurfaceObjective(f.source.task.id)).toBeUndefined();
      });
      it("gives a conversation turn only its own tools and no Objective it cannot see", async () => {
        const f = await fixture();
        const otherTag = await f.store.createTag({ name: "Other Tag" });
        const foreign = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: otherTag.id,
          outcome: "Unlinked",
        });
        const capability = await f.controller.surfaceCoordination(f.source.task, f.source.attempt);
        const caller = await f.controller.authenticateExecution(capability.token);
        expect(await f.controller.coordinationActions(caller)).toEqual([
          "create_objective",
          "start_session",
          "continue_session",
          "send_message",
          "post",
          "read_workstream",
          "read_objective",
          "list_sessions",
          "search_sessions",
          "read_session",
          "list_objectives",
        ]);
        // Another Tag's Objective is never visible to this conversation.
        await expect(
          f.controller.commandAsAttempt("read_objective", { objectiveId: foreign.id }, caller),
        ).rejects.toMatchObject({ statusCode: 404 });
        // Tools of other turns, and administrative ones, are refused on this turn.
        for (const command of ["update_objective", "ask"])
          await expect(
            f.controller.commandAsAttempt(command, { question: "?", status: "blocked" }, caller),
          ).rejects.toMatchObject({
            statusCode: 403,
            message: "A conversation turn cannot use this tool",
          });
        for (const command of ["approve_task", "report_to_surface", "set_messaging_grant"])
          await expect(
            f.controller.commandAsAttempt(command, { objectiveId: foreign.id }, caller),
          ).rejects.toMatchObject({ statusCode: 403 });
      });
      it("revokes surface coordination when the Attempt ends", async () => {
        const f = await fixture();
        const capability = await f.controller.surfaceCoordination(f.source.task, f.source.attempt);
        await expect(f.controller.authenticateExecution(capability.token)).resolves.toBeDefined();
        await f.store.closeTaskAttempt({
          attemptId: f.source.attempt.id,
          status: "completed",
          endedAt: new Date().toISOString(),
        });
        await expect(f.controller.authenticateExecution(capability.token)).rejects.toThrow();
      });
      it("revokes surface coordination when its inbound delivery lease closes", async () => {
        const f = await fixture();
        const capability = await f.controller.surfaceCoordination(f.source.task, f.source.attempt);
        if (!f.source.task.inboundEventId) throw new Error("Missing inbound event");
        await f.store.completeInboundEvent({
          inboundEventId: f.source.task.inboundEventId,
          leaseOwner: "surface-test",
          workerId: "test",
          responseText: "Done",
          completedAt: new Date().toISOString(),
        });
        await expect(f.controller.authenticateExecution(capability.token)).rejects.toThrow();
      });
    },
  );
}
