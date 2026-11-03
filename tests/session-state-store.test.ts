import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
        const team = await store.createTeam(
          {
            id: randomUUID(),
            objectiveId: objective.id,
            name: "Research",
            leadTagId: owner.id,
            memberTagIds: [],
            maxConcurrency: 2,
          },
          owner.id,
        );
        async function work() {
          const at = new Date().toISOString();
          const assignment = await store.admitTaskAssignment({
            taskId: randomUUID(),
            objectiveId: objective.id,
            teamId: team.id,
            requestedByTagId: owner.id,
            assignedTagId: owner.id,
            instruction: "Research",
            acceptanceCriteria: ["Report"],
            execution: {},
            workspacePlan: { version: 1, status: "none" },
            authorizationSnapshot: {
              version: 4,
              capturedAt: at,
              tag: { id: owner.id, name: owner.name },
              origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
              requester: { id: owner.id, kind: "bot" },
              permissionSets: [],
              resources: [],
              runtimeActions: [],
            },
            contextPlan: { version: 7, capturedAt: at, sets: [] },
          });
          const task = await store.findTaskById(assignment.taskId);
          if (!task) throw new Error("Missing admitted task");
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
        return { store, other, work, url };
      }
      it("promotes only a fenced cooperative wait and resumes its cancelled predecessor", async () => {
        const f = await fixture();
        const { input, task, attempt } = await f.work();
        await f.store.putSessionState(input);
        const claimed = await f.store.claimTaskAssignment({ taskId: task.id, leaseOwner: "owner" });
        expect(claimed?.attemptCount).toBe(1);
        const settlement = {
          taskId: task.id,
          leaseOwner: "owner",
          attemptCount: 1,
          result: { text: "Suspended" },
          terminalAttempt: { id: attempt.id, status: "cancelled" as const },
          waitSessionCompatibility: "wait-policy",
        };
        await expect(f.store.settleTaskAssignment(settlement)).rejects.toThrow(
          "settled durable wait",
        );
        expect((await f.store.findSessionState(input.ref.id))?.status).toBe("stored");
        await f.store.registerTaskAssignmentWait({
          taskId: task.id,
          leaseOwner: "owner",
          attemptCount: 1,
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        });
        await expect(
          f.store.settleTaskAssignment({ ...settlement, leaseOwner: "wrong" }),
        ).rejects.toThrow("Stale execution lease");
        await expect(
          f.store.settleTaskAssignment({
            ...settlement,
            terminalAttempt: { id: attempt.id, status: "failed" },
          }),
        ).rejects.toThrow("settled durable wait");
        expect((await f.store.findSessionState(input.ref.id))?.status).toBe("stored");
        await f.store.settleTaskAssignment(settlement);
        await f.other.disconnect();
        await f.other.connect();
        expect(await f.other.findSessionState(input.ref.id)).toMatchObject({
          status: "resumable",
          compatibility: "wait:wait-policy",
          workerProfile: attempt.workerProfile,
        });
        expect((await f.other.getTaskAssignment(task.id))?.status).toBe("waiting");
        expect((await f.other.listTaskAttempts(task.id))[0]?.status).toBe("cancelled");
      });
      it("keeps a withdrawn transcript archived at wait settlement without a delivery row", async () => {
        const f = await fixture();
        const { input, task, attempt } = await f.work();
        await f.store.putSessionState(input);
        await f.store.appendTaskEvent({
          taskId: task.id,
          attemptId: attempt.id,
          type: "input.withdrawn",
          payload: { commandId: "withdrawn-command" },
          createdAt: new Date().toISOString(),
        });
        await f.store.claimTaskAssignment({ taskId: task.id, leaseOwner: "owner" });
        const lease = { taskId: task.id, leaseOwner: "owner", attemptCount: 1 };
        await f.store.registerTaskAssignmentWait({
          ...lease,
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        });
        await f.store.settleTaskAssignment({
          ...lease,
          result: { text: "Suspended" },
          terminalAttempt: { id: attempt.id, status: "cancelled" },
          waitSessionCompatibility: "wait-policy",
        });
        expect((await f.other.findSessionState(input.ref.id))?.status).toBe("stored");
        expect((await f.other.getTaskAssignment(task.id))?.status).toBe("waiting");
      });
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
