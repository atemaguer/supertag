import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type JsonRecord,
  type MountManifest,
  mountManifestDigest,
  objectiveSessionKey,
} from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const at = "2026-09-15T12:00:00.000Z";
const identity = { workerHostId: "host-a", workletId: "worklet-a", workerId: "worker-a" };

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Task Attempt Worker identity`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        const errors: unknown[] = [];
        for (const cleanup of cleanups.splice(0).reverse()) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, "Store fixture cleanup failed");
      });

      async function fixture(snapshot: JsonRecord = {}) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-attempt-worker-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        const other = new DrizzleStore({ url });
        cleanups.push(
          () => store.disconnect(),
          () => other.disconnect(),
        );
        await store.connect();
        await other.connect();
        const owner = await store.createTag({ name: "Owner" });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Bind accepted Worker identity",
        });
        const account = await store.saveSurfaceAccount({
          provider: "slack",
          externalAccountId: randomUUID(),
          displayName: "Slack",
          authMethod: "test",
          credentialId: "test",
          status: "connected",
          configuration: {},
          verifiedAt: at,
        });
        const route = await store.addTagRoute({
          tagId: owner.id,
          surfaceAccountId: account.id,
          scope: "channel:engineering",
        });
        const authorization = {
          version: 5,
          capturedAt: at,
          tag: { id: owner.id, name: owner.name },
          origin: {
            tagRouteId: route.id,
            surfaceAccountId: account.id,
            provider: "slack",
            scope: "channel:engineering",
          },
          requester: { id: owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        } as const;
        const sessionKey = objectiveSessionKey(objective.id);
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId: owner.id,
          authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          event: {
            eventId: randomUUID(),
            logicalEventId: randomUUID(),
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: "channel:engineering",
            sessionKey,
            actor: { id: owner.id, kind: "bot" },
            internal: { kind: "delivery", from: { kind: "supertag" }, reason: "objective_start" },
            text: "Complete the Objective",
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: sessionKey,
              target: { channelId: "engineering", threadTs: sessionKey },
            },
            source: {},
            metadata: {},
          },
        });
        const session = await store.openSession({
          tagId: owner.id,
          sessionKey,
          origin: {},
          objectiveId: objective.id,
          at,
        });
        const task = await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: owner.id,
          sessionId: session.id,
          execution: {},
          actor: { id: owner.id, kind: "bot" },
          trigger: { origin: "objective_start" },
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          createdAt: at,
        });
        await store.startTask({ taskId: task.id, startedAt: at });
        const attemptInput = {
          taskId: task.id,
          attemptNumber: 1,
          workerProfile: { id: "default", revision: "1" },
          workerSnapshot: snapshot,
          startedAt: at,
        };
        const attempt = await store.createTaskAttempt(attemptInput);
        const binding = { taskId: task.id, attemptId: attempt.id, ...identity };
        return { store, other, attempt, binding, attemptInput, objective, owner };
      }

      it("preserves the admission snapshot and does not rewrite duplicate recovery receipts", async () => {
        const snapshot = { profile: { id: "engineering", revision: "3" }, capabilities: ["mcp"] };
        const { store, other, binding, attempt } = await fixture(snapshot);
        const recorded = await store.recordTaskAttemptWorker(binding);
        expect(recorded).toMatchObject({
          ...attempt,
          workerSnapshot: { ...snapshot, ...identity },
          updatedAt: expect.any(String),
        });
        expect(await other.recordTaskAttemptWorker(binding)).toEqual(recorded);
        const { workerId: _, ...withoutWorker } = binding;
        expect(await other.recordTaskAttemptWorker(withoutWorker)).toEqual(recorded);
        expect((await store.listTaskAttempts(binding.taskId))[0]).toEqual(recorded);
      });

      it("stores the latest changed paths for a running Attempt and inserts each overlap once", async () => {
        const { store, other, attempt, objective } = await fixture();
        await store.recordTaskAttemptChangedPaths({
          attemptId: attempt.id,
          paths: ["src/old.ts", "src/new.ts"],
          truncated: false,
        });
        expect(await other.listRunningTaskAttemptChangedPaths()).toEqual([
          expect.objectContaining({
            attemptId: attempt.id,
            taskId: attempt.taskId,
            objectiveId: objective.id,
            paths: ["src/old.ts", "src/new.ts"],
            truncated: false,
          }),
        ]);
        await other.recordTaskAttemptChangedPaths({
          attemptId: attempt.id,
          paths: ["src/new.ts"],
          truncated: true,
        });
        expect(await store.listRunningTaskAttemptChangedPaths()).toEqual([
          expect.objectContaining({ paths: ["src/new.ts"], truncated: true }),
        ]);
        const input = {
          objectiveId: "objective-a",
          firstAttemptId: "attempt-b",
          secondAttemptId: "attempt-a",
          paths: ["src/new.ts", "src/old.ts"],
        };
        expect(await store.recordOverlaps(input)).toEqual([
          {
            objectiveId: "objective-a",
            lowerAttemptId: "attempt-a",
            higherAttemptId: "attempt-b",
            path: "src/new.ts",
          },
          {
            objectiveId: "objective-a",
            lowerAttemptId: "attempt-a",
            higherAttemptId: "attempt-b",
            path: "src/old.ts",
          },
        ]);
        expect(
          await other.recordOverlaps({
            ...input,
            firstAttemptId: "attempt-a",
            secondAttemptId: "attempt-b",
          }),
        ).toEqual([]);
        expect(
          await other.recordOverlaps({
            ...input,
            objectiveId: "objective-b",
            paths: ["src/new.ts"],
          }),
        ).toHaveLength(1);
      });

      it("reads a batch of Task Attempts without duplicating repeated Task IDs", async () => {
        const { store, attempt, attemptInput } = await fixture({});
        const retry = await store.createTaskAttempt({ ...attemptInput, attemptNumber: 2 });
        expect(
          await store.listTaskAttempts([attempt.taskId, "missing-task", attempt.taskId]),
        ).toEqual([expect.objectContaining({ id: attempt.id, status: "failed" }), retry]);
        expect(await store.listTaskAttempts([])).toEqual([]);
      });

      it("records an immutable Workspace MCP digest on the Task Attempt", async () => {
        const { store, other, attempt } = await fixture();
        const digest = `sha256:${"a".repeat(64)}`;
        expect(
          (await store.recordTaskAttemptMcpDigest(attempt.taskId, attempt.id, digest))
            .mcpServersDigest,
        ).toBe(digest);
        expect((await other.listTaskAttempts(attempt.taskId))[0]?.mcpServersDigest).toBe(digest);
        expect(
          (await other.recordTaskAttemptMcpDigest(attempt.taskId, attempt.id, digest))
            .mcpServersDigest,
        ).toBe(digest);
        await expect(
          other.recordTaskAttemptMcpDigest(attempt.taskId, attempt.id, `sha256:${"b".repeat(64)}`),
        ).rejects.toThrow(/conflict/u);
        await expect(other.recordTaskAttemptMcpDigest("wrong", attempt.id, digest)).rejects.toThrow(
          /conflict/u,
        );
      });

      it("records write-once live mounts separately for each Task Attempt", async () => {
        const { store, other, attempt, attemptInput } = await fixture();
        const mounts = [
          {
            volume: "datasets",
            source: "s3://datasets/prefix/",
            prefix: "prefix/",
            path: "/mnt/datasets",
            strategy: "mount" as const,
            access: "read-only" as const,
            attachedAt: at,
          },
        ];
        const first = mounts[0];
        if (!first) throw new Error("Missing mount fixture");
        const recorded = await store.recordTaskAttemptLiveMounts(
          attempt.taskId,
          attempt.id,
          mounts,
        );
        expect(recorded.liveMounts).toEqual(mounts);
        expect(recorded.mountManifests).toBeUndefined();
        expect((await other.listTaskAttempts(attempt.taskId))[0]?.liveMounts).toEqual(mounts);
        expect(await other.recordTaskAttemptLiveMounts(attempt.taskId, attempt.id, mounts)).toEqual(
          recorded,
        );
        const changed = [{ ...first, attachedAt: "2026-10-06T14:00:00.000Z" }];
        await expect(
          other.recordTaskAttemptLiveMounts(attempt.taskId, attempt.id, changed),
        ).rejects.toThrow(/conflict/u);
        await expect(
          other.recordTaskAttemptLiveMounts("wrong", attempt.id, mounts),
        ).rejects.toThrow(/not found/u);
        const retry = await store.createTaskAttempt({ ...attemptInput, attemptNumber: 2 });
        expect(
          (await store.recordTaskAttemptLiveMounts(attempt.taskId, retry.id, changed)).liveMounts,
        ).toEqual(changed);
        await expect(
          store.recordTaskAttemptLiveMounts(attempt.taskId, retry.id, [
            { ...first, credential: "secret" } as (typeof mounts)[number],
          ]),
        ).rejects.toThrow();
      });

      it("records write-once mount manifests on one Task Attempt", async () => {
        const { store, other, attempt, attemptInput } = await fixture();
        const manifest = (etag: string): MountManifest => {
          const source = "s3://datasets/prefix/";
          const objects = [{ key: "a.csv", size: 1024, etag }];
          return {
            volume: "datasets",
            source,
            path: "/mnt/datasets",
            strategy: "copy",
            access: "read-only",
            objectCount: 1,
            totalBytes: 1024,
            digest: mountManifestDigest(source, objects),
            copiedAt: at,
            objects,
          };
        };
        const first = [manifest('"abc"')];
        expect(
          (await store.recordTaskAttemptMountManifests(attempt.taskId, attempt.id, first))
            .mountManifests,
        ).toEqual(first);
        expect((await other.listTaskAttempts(attempt.taskId))[0]?.mountManifests).toEqual(first);
        expect(
          (await other.recordTaskAttemptMountManifests(attempt.taskId, attempt.id, first))
            .mountManifests,
        ).toEqual(first);
        await expect(
          other.recordTaskAttemptMountManifests(attempt.taskId, attempt.id, [manifest('"def"')]),
        ).rejects.toThrow(/conflict/u);
        await expect(
          other.recordTaskAttemptMountManifests("wrong", attempt.id, first),
        ).rejects.toThrow(/not found/u);
        // A later Attempt may record different manifests: a changed source is evidence, not an error.
        const retry = await store.createTaskAttempt({ ...attemptInput, attemptNumber: 2 });
        const changed = [manifest('"def"')];
        expect(
          (await store.recordTaskAttemptMountManifests(attempt.taskId, retry.id, changed))
            .mountManifests,
        ).toEqual(changed);
        expect(
          (await store.listTaskAttempts(attempt.taskId)).map((entry) => entry.mountManifests),
        ).toEqual([first, changed]);
        await expect(
          store.recordTaskAttemptMountManifests(attempt.taskId, retry.id, [
            { ...manifest('"def"'), digest: `sha256:${"0".repeat(64)}` },
          ]),
        ).rejects.toThrow(/digest does not match/u);
      });

      it("persists a partial output manifest across store instances and a failed Attempt", async () => {
        const { store, other, attempt } = await fixture();
        const output = [
          {
            volume: "datasets",
            source: "file:///data",
            path: "/mnt/data",
            status: "partial" as const,
            uploadedAt: at,
            objects: [{ key: "first", size: 1, sha256: `sha256:${"a".repeat(64)}` }],
            skipped: 0,
            error: { key: "second", reason: "upload failed" },
            notAttempted: ["second"],
          },
        ];
        expect(
          (await store.recordTaskAttemptMountOutputManifests(attempt.taskId, attempt.id, output))
            .mountOutputManifests,
        ).toEqual(output);
        expect((await other.listTaskAttempts(attempt.taskId))[0]?.mountOutputManifests).toEqual(
          output,
        );
        await other.recordTaskAttemptMountOutputManifests(attempt.taskId, attempt.id, output);
        await expect(
          other.recordTaskAttemptMountOutputManifests(attempt.taskId, attempt.id, [
            { ...output[0], error: { key: "second", reason: "different" } },
          ]),
        ).rejects.toThrow(/conflict/u);
        await store.closeTaskAttempt({
          attemptId: attempt.id,
          status: "failed",
          endedAt: at,
          outcome: { reason: "Mount datasets key second: upload failed" },
        });
        expect((await other.listTaskAttempts(attempt.taskId))[0]).toMatchObject({
          status: "failed",
          mountOutputManifests: output,
        });
      });

      it("refuses a later Attempt's Workspace MCP digest that differs from the first Attempt's", async () => {
        const { store, attempt, attemptInput } = await fixture();
        const first = `sha256:${"a".repeat(64)}`;
        await store.recordTaskAttemptMcpDigest(attempt.taskId, attempt.id, first);
        const retry = await store.createTaskAttempt({ ...attemptInput, attemptNumber: 2 });
        await expect(
          store.recordTaskAttemptMcpDigest(attempt.taskId, retry.id, `sha256:${"b".repeat(64)}`),
        ).rejects.toThrow(/first Task Attempt pinned/u);
        expect(
          (await store.recordTaskAttemptMcpDigest(attempt.taskId, retry.id, first))
            .mcpServersDigest,
        ).toBe(first);
      });

      it("allows a later receipt to fill in Worker id without changing the Host or Worklet", async () => {
        const { store, binding } = await fixture();
        const { workerId: _, ...withoutWorker } = binding;
        await store.recordTaskAttemptWorker(withoutWorker);
        expect((await store.recordTaskAttemptWorker(binding)).workerSnapshot).toEqual(identity);
      });

      it("advances a reconnect fence without allowing a stale receipt to roll it back", async () => {
        const { store, other, binding } = await fixture();
        await store.recordTaskAttemptWorker({ ...binding, connectionGeneration: 1 });
        expect(
          (await other.recordTaskAttemptWorker({ ...binding, connectionGeneration: 2 }))
            .workerSnapshot,
        ).toEqual({ ...identity, connectionGeneration: 2 });
        expect(
          (await store.recordTaskAttemptWorker({ ...binding, connectionGeneration: 1 }))
            .workerSnapshot,
        ).toEqual({ ...identity, connectionGeneration: 2 });
      });

      it.each(["workerHostId", "workletId", "workerId"] as const)(
        "rejects changing the recorded %s",
        async (key) => {
          const { store, other, binding } = await fixture();
          const recorded = await store.recordTaskAttemptWorker(binding);
          await expect(
            other.recordTaskAttemptWorker({ ...binding, [key]: "different" }),
          ).rejects.toThrow("conflicts");
          expect((await store.listTaskAttempts(binding.taskId))[0]).toEqual(recorded);
        },
      );

      it("rejects a foreign Task, missing Attempt, and superseded receipt without changing history", async () => {
        const { store, binding, attemptInput } = await fixture();
        await expect(
          store.recordTaskAttemptWorker({ ...binding, taskId: "foreign-task" }),
        ).rejects.toThrow("does not exist");
        await expect(
          store.recordTaskAttemptWorker({ ...binding, attemptId: "foreign-attempt" }),
        ).rejects.toThrow("latest Task Attempt");
        const retry = await store.createTaskAttempt({ ...attemptInput, attemptNumber: 2 });
        await expect(store.recordTaskAttemptWorker(binding)).rejects.toThrow("latest Task Attempt");
        const attempts = await store.listTaskAttempts(binding.taskId);
        expect(attempts.map((attempt) => attempt.workerSnapshot)).toEqual([{}, {}]);
        expect(attempts[1]?.id).toBe(retry.id);
      });

      it("allows exact latest terminal recovery and preserves completion evidence", async () => {
        const { store, binding } = await fixture();
        const terminal = await store.closeTaskAttempt({
          attemptId: binding.attemptId,
          status: "completed",
          endedAt: at,
          outcome: { result: "accepted" },
        });
        expect(await store.recordTaskAttemptWorker(binding)).toMatchObject({
          ...terminal,
          workerSnapshot: identity,
          updatedAt: expect.any(String),
        });
      });

      it("serializes conflicting receipts from independent connections without merging their identities", async () => {
        const { store, other, binding } = await fixture({ harness: "codex" });
        const second = {
          ...binding,
          workerHostId: "host-b",
          workletId: "worklet-b",
          workerId: "worker-b",
        };
        const results = await Promise.allSettled([
          store.recordTaskAttemptWorker(binding),
          other.recordTaskAttemptWorker(second),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        const snapshot = (await store.listTaskAttempts(binding.taskId))[0]?.workerSnapshot;
        expect([
          { harness: "codex", ...identity },
          {
            harness: "codex",
            workerHostId: "host-b",
            workletId: "worklet-b",
            workerId: "worker-b",
          },
        ]).toContainEqual(snapshot);
      });

      it("serializes retries against late receipts and never binds the replacement Attempt", async () => {
        const { store, other, binding, attemptInput } = await fixture();
        const results = await Promise.allSettled([
          store.createTaskAttempt({ ...attemptInput, attemptNumber: 2 }),
          other.recordTaskAttemptWorker(binding),
        ]);
        expect(results[0]?.status).toBe("fulfilled");
        const attempts = await store.listTaskAttempts(binding.taskId);
        expect(attempts[0]?.status).toBe("failed");
        expect(attempts[1]?.workerSnapshot).toEqual({});
        await expect(other.recordTaskAttemptWorker(binding)).rejects.toThrow("latest Task Attempt");
      });

      it("rolls back supersession if the new Attempt cannot be inserted", async () => {
        const { store, attempt, attemptInput } = await fixture();
        await expect(store.createTaskAttempt(attemptInput)).rejects.toThrow();
        expect(await store.listTaskAttempts(attempt.taskId)).toEqual([attempt]);
      });
    },
  );
}
