import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyTagContextPlan, objectiveSessionKey } from "../packages/core/src/index.js";
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
          scope: "channel:ship",
        });
        const ownerSession = await store.openSession({
          tagId: owner.id,
          sessionKey: objectiveSessionKey(objective.id),
          origin: {},
          objectiveId: objective.id,
          at: new Date().toISOString(),
        });
        /** One work Session of the Objective, whose Task may leave a pull request behind. */
        const workTurn = async (title: string) => {
          const at = new Date().toISOString();
          const session = await store.openSession({
            tagId: owner.id,
            sessionKey: `work:${ownerSession.id}:${title}`,
            origin: {},
            parentSessionId: ownerSession.id,
            at,
          });
          const authorization = {
            version: 5,
            capturedAt: at,
            tag: { id: owner.id, name: owner.name },
            origin: {
              tagRouteId: route.id,
              surfaceAccountId: account.id,
              provider: "slack",
              scope: "channel:ship",
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
            tagId: owner.id,
            authorization,
            contextPlan: emptyTagContextPlan(at),
            event: {
              eventId,
              logicalEventId: eventId,
              provider: "slack",
              externalAccountId: account.externalAccountId,
              kind: "message",
              scope: "channel:ship",
              sessionKey: session.sessionKey,
              actor: { id: owner.id, kind: "bot" },
              internal: {
                kind: "work_session",
                startedByTaskId: eventId,
                parentSessionId: ownerSession.id,
                title,
              },
              text: "Change it",
              occurredAt: at,
              callback: {
                provider: "slack",
                mode: "slack_thread",
                threadKey: "ship",
                target: { channelId: "ship", threadTs: "ship" },
              },
              source: {},
              metadata: {},
            },
          });
          return store.openTask({
            inboundEventId: admitted.work.id,
            tagId: owner.id,
            sessionId: session.id,
            execution: {},
            actor: { id: owner.id, kind: "bot" },
            trigger: { origin: "work_session" },
            workspacePlan: { version: 1, status: "none" },
            sessionHistory: [],
            authorizationSnapshot: authorization,
            contextPlan: emptyTagContextPlan(at),
            createdAt: at,
          });
        };
        const [first, second] = [await workTurn("first"), await workTurn("second")];
        const transition = {
          url: "https://github.com/acme/app/pull/7",
          action: "close" as const,
          lastError: "GitHub pull request close failed with HTTP 503",
        };
        await store.saveWorkspacePullRequestTransition({
          ...transition,
          taskId: first.id,
          attemptCount: 1,
          nextAttemptAt: "2026-09-30T12:01:00.000Z",
        });
        await store.saveWorkspacePullRequestTransition({
          ...transition,
          taskId: second.id,
          attemptCount: 1,
          nextAttemptAt: "2026-09-30T12:05:00.000Z",
        });
        // Saving again replaces the Task's transition instead of adding another.
        await store.saveWorkspacePullRequestTransition({
          ...transition,
          taskId: first.id,
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
          { taskId: first.id, attemptCount: 2, lastError: "fetch failed", action: "close" },
          { taskId: second.id, attemptCount: 1 },
        ]);
        expect(
          await store.listDueWorkspacePullRequestTransitions("2026-09-30T12:10:00.000Z", 1),
        ).toHaveLength(1);
        await store.deleteWorkspacePullRequestTransition(first.id);
        await store.deleteWorkspacePullRequestTransition(first.id);
        expect(
          (await store.listDueWorkspacePullRequestTransitions("2026-09-30T12:10:00.000Z")).map(
            (item) => item.taskId,
          ),
        ).toEqual([second.id]);
      });
    },
  );
}
