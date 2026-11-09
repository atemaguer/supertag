import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { objectiveSessionKey } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Session state persistence`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "artifact-catalog-"));
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
        const other = new DrizzleStore({ url });
        await other.connect();
        cleanups.push(() => other.disconnect());
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Research",
          budgetLimitMinor: 100,
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
          scope: "channel:research",
        });
        const ownerSession = await store.openSession({
          tagId: owner.id,
          sessionKey: objectiveSessionKey(objective.id),
          origin: {},
          objectiveId: objective.id,
          at: new Date().toISOString(),
        });
        /** One running work Session turn of the Objective, with its first Task Attempt. */
        async function work() {
          const at = new Date().toISOString();
          const title = `research-${randomUUID()}`;
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
              scope: "channel:research",
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
            contextPlan: { version: 7, capturedAt: at, sets: [] },
            event: {
              eventId,
              logicalEventId: eventId,
              provider: "slack",
              externalAccountId: account.externalAccountId,
              kind: "message",
              scope: "channel:research",
              sessionKey: session.sessionKey,
              actor: { id: owner.id, kind: "bot" },
              internal: {
                kind: "work_session",
                startedByTaskId: eventId,
                parentSessionId: ownerSession.id,
                title,
              },
              text: "Research",
              occurredAt: at,
              callback: {
                provider: "slack",
                mode: "slack_thread",
                threadKey: "research",
                target: { channelId: "research", threadTs: "research" },
              },
              source: {},
              metadata: {},
            },
          });
          const task = await store.openTask({
            inboundEventId: admitted.work.id,
            tagId: owner.id,
            sessionId: session.id,
            execution: {},
            actor: { id: owner.id, kind: "bot" },
            trigger: { origin: "work_session" },
            workspacePlan: { version: 1, status: "none" },
            sessionHistory: [],
            authorizationSnapshot: authorization,
            contextPlan: { version: 7, capturedAt: at, sets: [] },
            createdAt: at,
          });
          const attempt = await store.createTaskAttempt({
            taskId: task.id,
            attemptNumber: 1,
            workerProfile: { id: "test", revision: "1" },
            workerSnapshot: {},
            startedAt: at,
          });
          await store.startTask({ taskId: task.id, startedAt: at });
          const input = {
            taskId: task.id,
            attemptId: attempt.id,
            harnessId: "codex",
            ref: { id: randomUUID(), uri: "supertag:session", format: "codex.v1" },
            data: { threadId: randomUUID(), transcript: "first" },
          };
          return { input, task, attempt };
        }
        return { store, other, work, url, owner, objective };
      }
      it("updates stored transcripts, survives reconnect, and seals resumable state", async () => {
        const f = await fixture();
        const { input, task } = await f.work();
        const first = await f.store.putSessionState(input);
        expect(first).toMatchObject({ sessionId: task.sessionId, status: "stored" });
        expect(first.compatibility).toBeUndefined();
        const updated = { ...input, data: { ...input.data, transcript: "complete" } };
        await f.store.putSessionState(updated);
        expect((await f.other.findSessionState(input.ref.id))?.data).toEqual(updated.data);
        const promotion = {
          id: first.id,
          taskId: input.taskId,
          attemptId: input.attemptId,
          compatibility: "policy-v1",
          workerProfile: { id: "test", revision: "1" },
        };
        await f.store.promoteSessionState(promotion);
        await f.other.promoteSessionState(promotion);
        await expect(f.store.putSessionState(updated)).resolves.toMatchObject({
          status: "resumable",
        });
        await expect(f.store.putSessionState(input)).rejects.toThrow("immutable");
        await expect(
          f.store.promoteSessionState({ ...promotion, compatibility: "changed" }),
        ).rejects.toThrow("immutable");
        await f.other.disconnect();
        await f.other.connect();
        expect(
          await f.other.listSessionStates({ sessionId: task.sessionId, taskId: task.id }),
        ).toEqual([
          expect.objectContaining({
            id: first.id,
            status: "resumable",
            nativeId: updated.data.threadId,
          }),
        ]);
        expect(await f.store.findSessionState("missing")).toBeUndefined();
      });

      it("fences superseded and terminal Attempts while retaining incomplete archives", async () => {
        const f = await fixture();
        const { input, task } = await f.work();
        await f.store.putSessionState(input);
        const retry = await f.store.createTaskAttempt({
          taskId: task.id,
          attemptNumber: 2,
          workerProfile: { id: "test", revision: "1" },
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        await expect(f.store.putSessionState(input)).rejects.toThrow("current active");
        await expect(
          f.store.promoteSessionState({
            id: input.ref.id,
            taskId: task.id,
            attemptId: input.attemptId,
            compatibility: "v1",
            workerProfile: { id: "test", revision: "1" },
          }),
        ).rejects.toThrow("current active");
        await expect(f.store.putSessionState({ ...input, attemptId: retry.id })).rejects.toThrow(
          "another producer",
        );
        const next = { ...input, attemptId: retry.id, ref: { ...input.ref, id: randomUUID() } };
        await f.store.putSessionState(next);
        await f.store.closeTaskAttempt({
          attemptId: retry.id,
          status: "failed",
          endedAt: new Date().toISOString(),
        });
        await expect(f.store.putSessionState(next)).rejects.toThrow("current active");
        const records = await f.store.listSessionStates({ sessionId: task.sessionId });
        expect(records).toHaveLength(2);
        expect(records.every((record) => record.status === "stored")).toBe(true);
        expect(records[0]?.id).toBe(next.ref.id);
        const [newest, older] = records;
        expect(
          await f.store.listSessionStates({
            sessionId: task.sessionId,
            limit: 1,
            before: { createdAt: newest?.createdAt as string, id: newest?.id as string },
          }),
        ).toEqual([older]);
        expect(
          await f.store.listSessionStates({
            sessionId: task.sessionId,
            before: { createdAt: older?.createdAt as string, id: older?.id as string },
          }),
        ).toEqual([]);
      });

      it("rejects foreign ownership, ref and harness changes, oversized payloads, and invalid limits", async () => {
        const f = await fixture();
        const a = await f.work();
        const b = await f.work();
        await f.store.putSessionState(a.input);
        await expect(f.other.putSessionState({ ...b.input, ref: a.input.ref })).rejects.toThrow(
          "another producer",
        );
        await expect(
          f.store.putSessionState({ ...a.input, ref: { ...a.input.ref, uri: "changed" } }),
        ).rejects.toThrow("another producer");
        await expect(
          f.store.putSessionState({ ...a.input, harnessId: "claude-code" }),
        ).rejects.toThrow("another producer");
        await expect(
          f.store.putSessionState({ ...a.input, attemptId: b.attempt.id }),
        ).rejects.toThrow("current active");
        await expect(
          f.store.putSessionState({ ...a.input, data: { content: "x".repeat(16 * 1024 * 1024) } }),
        ).rejects.toThrow("16 MiB");
        await expect(
          f.store.listSessionStates({ sessionId: a.task.sessionId, limit: 0 }),
        ).rejects.toThrow("limit");
        await expect(
          f.store.promoteSessionState({
            id: a.input.ref.id,
            taskId: b.task.id,
            attemptId: b.attempt.id,
            compatibility: "v1",
            workerProfile: { id: "test", revision: "1" },
          }),
        ).rejects.toThrow("another Task Attempt");
      });

      it("lists Tasks after a cursor and by Objective", async () => {
        const f = await fixture();
        const first = await f.work();
        const second = await f.work();
        const all = await f.store.listTasks({ tagId: f.owner.id });
        expect(all.map((task) => task.id).toSorted()).toEqual(
          [first.task.id, second.task.id].toSorted(),
        );
        const [newest, older] = all;
        expect(
          await f.store.listTasks({
            tagId: f.owner.id,
            limit: 1,
            before: { createdAt: newest?.createdAt as string, id: newest?.id as string },
          }),
        ).toEqual([older]);
        expect(
          await f.store.listTasks({
            tagId: f.owner.id,
            before: { createdAt: older?.createdAt as string, id: older?.id as string },
          }),
        ).toEqual([]);
        expect(
          (await f.store.listTasks({ objectiveId: f.objective.id })).map((task) => task.id),
        ).toEqual(all.filter((task) => task.objectiveId === f.objective.id).map((task) => task.id));
        expect(await f.store.listTasks({ objectiveId: "no-such-objective" })).toEqual([]);
      });

      it("rejects reordered writes while accepting exact version retries", async () => {
        const f = await fixture();
        const a = await f.work();
        await f.store.putSessionState({ ...a.input, writeVersion: 1 });
        const latest = { ...a.input, writeVersion: 3, data: { transcript: "newest" } };
        const saved = await f.other.putSessionState(latest);
        expect(saved.writeVersion).toBe(3);
        await expect(f.store.putSessionState(latest)).resolves.toEqual(saved);
        await expect(f.store.putSessionState({ ...a.input, writeVersion: 2 })).rejects.toThrow(
          "writeVersion",
        );
        await expect(f.store.putSessionState({ ...latest, data: a.input.data })).rejects.toThrow(
          "writeVersion",
        );
        await expect(f.store.putSessionState({ ...latest, writeVersion: -1 })).rejects.toThrow(
          "writeVersion",
        );
        expect((await f.store.findSessionState(a.input.ref.id))?.data).toEqual(latest.data);
      });

      it("lists native identifiers without fetching transcript payloads", async () => {
        const f = await fixture();
        const a = await f.work();
        await f.store.putSessionState(a.input);
        const result = await f.store.listSessionStates({
          sessionId: a.task.sessionId,
          nativeId: a.input.data.threadId,
          limit: 1,
        });
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ nativeId: a.input.data.threadId });
        expect(result[0]).not.toHaveProperty("data");
        expect(
          await f.store.listSessionStates({ sessionId: a.task.sessionId, nativeId: "unknown" }),
        ).toEqual([]);
      });

      it("indexes a Cursor portable agent ID", async () => {
        const f = await fixture();
        const a = await f.work();
        await f.store.putSessionState({
          ...a.input,
          harnessId: "cursor",
          data: { portable: { agentId: "agent-123" } },
        });
        expect(
          await f.store.listSessionStates({ sessionId: a.task.sessionId, nativeId: "agent-123" }),
        ).toMatchObject([{ nativeId: "agent-123" }]);
      });

      it("serializes concurrent updates and retry admission", async () => {
        const f = await fixture();
        const a = await f.work();
        const results = await Promise.all([
          f.store.putSessionState(a.input),
          f.other.putSessionState(a.input),
        ]);
        expect(results[0]).toEqual(results[1]);
        const writes = await Promise.allSettled([
          f.store.putSessionState({ ...a.input, data: { transcript: "later" } }),
          f.other.createTaskAttempt({
            taskId: a.task.id,
            attemptNumber: 2,
            workerProfile: { id: "test", revision: "1" },
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          }),
        ]);
        expect(writes[1]?.status).toBe("fulfilled");
        await expect(f.store.putSessionState(a.input)).rejects.toThrow("current active");
        expect((await f.store.findSessionState(a.input.ref.id))?.status).toBe("stored");
      });
    },
  );
}
