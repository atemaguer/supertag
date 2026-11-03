import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommitCapturedArtifactInput,
  validateCapturedArtifactInput,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const digest = `sha256:${"a".repeat(64)}`;
const entry = {
  path: "research/findings.md",
  uri: `supertag-artifact:${digest}`,
  digest,
  sizeBytes: 42,
  mediaType: "text/markdown",
};
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} artifact catalog`, () => {
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
        const input: CommitCapturedArtifactInput = {
          operationId: "capture-1",
          taskId: task.id,
          attemptId: attempt.id,
          tagId: owner.id,
          sessionId: task.sessionId,
          objectiveId: objective.id,
          title: "PT research",
          summary: "Scheduling evidence",
          kind: "research",
          entries: [entry],
        };
        return { input, task, attempt };
      }
      const producer = await work();
      async function upload(input = producer.input) {
        for (const item of input.entries)
          await store.recordArtifactUpload({
            taskId: input.taskId,
            attemptId: input.attemptId,
            digest: item.digest,
            sizeBytes: item.sizeBytes,
          });
      }
      return { store, other, producer, work, upload };
    }
    it.each(["codex", "claude-code"])(
      "persists %s native conversation identity through reads and retries",
      async (harnessId) => {
        const f = await fixture();
        await f.upload();
        const input = {
          ...f.producer.input,
          harnessSession: { harnessId, id: "native-conversation" },
        };
        const artifact = await f.store.commitCapturedArtifact(input);
        expect(artifact.harnessSession).toEqual(input.harnessSession);
        expect(await f.other.findCapturedArtifact(artifact.id)).toEqual(artifact);
        expect((await f.other.listCapturedArtifacts({ taskId: input.taskId })).artifacts).toEqual([
          artifact,
        ]);
        expect(await f.other.commitCapturedArtifact(input)).toEqual(artifact);
        for (const harnessSession of [
          undefined,
          { harnessId, id: "different" },
          { harnessId: "another", id: "native-conversation" },
        ]) {
          await expect(
            f.store.commitCapturedArtifact({ ...input, harnessSession }),
          ).rejects.toMatchObject({ statusCode: 409 });
        }
      },
    );
    it("keeps absent native identity absent and refuses to add it on a retry", async () => {
      const f = await fixture();
      await f.upload();
      const artifact = await f.store.commitCapturedArtifact(f.producer.input);
      expect(artifact).not.toHaveProperty("harnessSession");
      expect(await f.other.findCapturedArtifact(artifact.id)).toEqual(artifact);
      expect(await f.other.commitCapturedArtifact(f.producer.input)).toEqual(artifact);
      await expect(
        f.store.commitCapturedArtifact({
          ...f.producer.input,
          harnessSession: { harnessId: "codex", id: "late" },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
    it("accepts native identity strings at their supported size limits", async () => {
      const f = await fixture();
      await f.upload();
      const harnessSession = { harnessId: "h".repeat(512), id: "s".repeat(1024) };
      const artifact = await f.store.commitCapturedArtifact({
        ...f.producer.input,
        harnessSession,
      });
      expect((await f.other.findCapturedArtifact(artifact.id))?.harnessSession).toEqual(
        harnessSession,
      );
    });
    it("rejects malformed native identities before storage and on retries", async () => {
      const f = await fixture();
      await f.upload();
      await f.store.commitCapturedArtifact(f.producer.input);
      for (const harnessSession of [
        null,
        [],
        "native",
        {},
        { id: "native" },
        { harnessId: "codex" },
        { harnessId: " ", id: "native" },
        { harnessId: "codex", id: " " },
        { harnessId: 4, id: "native" },
        { harnessId: "codex", id: 4 },
        { harnessId: "a".repeat(513), id: "native" },
        { harnessId: "codex", id: "a".repeat(1025) },
        { harnessId: "codex", id: "native", turnId: "unwanted" },
        { harnessId: "codex\n", id: "native" },
        { harnessId: "codex", id: "native\0" },
        { harnessId: "codex", id: "native\u007f" },
      ]) {
        for (const operationId of [f.producer.input.operationId, "new-operation"]) {
          await expect(
            f.store.commitCapturedArtifact({
              ...f.producer.input,
              operationId,
              harnessSession,
            } as CommitCapturedArtifactInput),
          ).rejects.toMatchObject({ statusCode: 400 });
        }
      }
      expect(
        (await f.store.listCapturedArtifacts({ taskId: f.producer.task.id })).artifacts,
      ).toHaveLength(1);
    });
    it("preserves capture-time supplied inputs on retries and rejects foreign outputs at Task closure", async () => {
      const f = await fixture();
      await f.upload();
      const source = await f.store.commitCapturedArtifact(f.producer.input);
      const consumer = await f.work();
      await f.upload(consumer.input);
      const inputs = [{ artifactId: source.id, paths: [entry.path] }];
      const output = await f.store.commitCapturedArtifact({ ...consumer.input, inputs });
      expect(output.inputs).toEqual(inputs);
      expect(await f.store.commitCapturedArtifact({ ...consumer.input, inputs: [] })).toEqual(
        output,
      );
      expect(
        await f.store.commitCapturedArtifact({
          ...consumer.input,
          inputs: Array.from({ length: 101 }, () => inputs[0] as (typeof inputs)[number]),
        }),
      ).toEqual(output);
      await expect(
        f.store.commitCapturedArtifact({
          ...consumer.input,
          operationId: "oversized-lineage",
          inputs: Array.from({ length: 101 }, () => inputs[0] as (typeof inputs)[number]),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      const result = {
        summary: "Done",
        decisions: [],
        changes: [],
        unresolved: [],
        findings: [],
        references: [],
        artifacts: inputs,
      };
      await expect(
        f.store.closeTask({
          taskId: consumer.task.id,
          status: "completed",
          endedAt: new Date().toISOString(),
          result,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await f.store.findTaskById(consumer.task.id))?.result).toBeUndefined();
      const closed = await f.store.closeTask({
        taskId: consumer.task.id,
        status: "completed",
        endedAt: new Date().toISOString(),
        result: { ...result, artifacts: [{ artifactId: output.id, paths: [entry.path] }] },
      });
      expect(closed.result?.artifacts).toEqual([{ artifactId: output.id, paths: [entry.path] }]);
    });
    it("requires verified upload and exact producer provenance, deduplicates concurrent retries", async () => {
      const f = await fixture();
      const input = f.producer.input;
      await expect(f.store.commitCapturedArtifact(input)).rejects.toMatchObject({
        statusCode: 409,
      });
      await f.upload();
      await expect(
        f.store.commitCapturedArtifact({ ...input, tagId: "wrong" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        f.store.commitCapturedArtifact({ ...input, sessionId: "wrong" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        f.store.commitCapturedArtifact({ ...input, objectiveId: "wrong" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const [first, retry] = await Promise.all([
        f.store.commitCapturedArtifact(input),
        f.other.commitCapturedArtifact(input),
      ]);
      expect(first).toEqual(retry);
      expect(await f.other.findCapturedArtifact(first.id)).toEqual(first);
      await expect(
        f.other.commitCapturedArtifact({ ...input, title: "Changed" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const foreign = await f.work();
      await expect(
        f.store.commitCapturedArtifact({ ...input, taskId: foreign.task.id }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(f.store.commitCapturedArtifact(foreign.input)).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(
        f.store.recordArtifactUpload({
          taskId: input.taskId,
          attemptId: input.attemptId,
          digest,
          sizeBytes: 43,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        await f.store.hasArtifactUpload({ attemptId: input.attemptId, digest, sizeBytes: 42 }),
      ).toBe(true);
      expect(
        await f.store.hasArtifactUpload({ attemptId: foreign.attempt.id, digest, sizeBytes: 42 }),
      ).toBe(false);
    });
    it("filters before stable pagination and treats SQL search wildcards literally", async () => {
      const f = await fixture();
      await f.upload();
      const ids = [];
      for (const [operationId, title] of [
        ["1", "Research 100%"],
        ["2", "Research 1000"],
        ["3", "Other"],
      ])
        ids.push(
          (
            await f.store.commitCapturedArtifact({
              ...f.producer.input,
              operationId,
              title,
            })
          ).id,
        );
      const filter = { taskIds: [f.producer.task.id], limit: 1 };
      const first = await f.store.listCapturedArtifacts(filter);
      const second = await f.store.listCapturedArtifacts({ ...filter, cursor: first.nextCursor });
      const third = await f.store.listCapturedArtifacts({ ...filter, cursor: second.nextCursor });
      expect(
        new Set([...first.artifacts, ...second.artifacts, ...third.artifacts].map((a) => a.id)),
      ).toEqual(new Set(ids));
      expect(third.nextCursor).toBeUndefined();
      expect(
        (await f.store.listCapturedArtifacts({ query: "100%" })).artifacts.map((a) => a.title),
      ).toEqual(["Research 100%"]);
      expect((await f.store.listCapturedArtifacts({ taskIds: [] })).artifacts).toEqual([]);
      expect((await f.store.listCapturedArtifacts({ objectiveId: "other" })).artifacts).toEqual([]);
      await expect(f.store.listCapturedArtifacts({ limit: 101 })).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(f.store.listCapturedArtifacts({ cursor: "bad" })).rejects.toMatchObject({
        statusCode: 400,
      });
    });
    it("unions exact admitted artifact IDs with ordinary scope before query and pagination", async () => {
      const f = await fixture();
      await f.upload();
      const first = await f.store.commitCapturedArtifact(f.producer.input);
      const other = await f.work();
      await f.upload(other.input);
      const second = await f.store.commitCapturedArtifact({
        ...other.input,
        title: "External research",
      });
      const filter = { taskIds: [f.producer.task.id], includeArtifactIds: [second.id], limit: 1 };
      const page = await f.store.listCapturedArtifacts(filter);
      expect(
        (
          await f.store.listCapturedArtifacts({ ...filter, taskId: f.producer.task.id })
        ).artifacts.map((a) => a.id),
      ).toEqual([first.id]);
      const next = await f.store.listCapturedArtifacts({ ...filter, cursor: page.nextCursor });
      expect(new Set([...page.artifacts, ...next.artifacts].map((a) => a.id))).toEqual(
        new Set([first.id, second.id]),
      );
      expect(
        (await f.store.listCapturedArtifacts({ ...filter, query: "External" })).artifacts.map(
          (a) => a.id,
        ),
      ).toEqual([second.id]);
      expect((await f.store.listCapturedArtifacts({ ...filter, kind: "other" })).artifacts).toEqual(
        [],
      );
      expect(
        (await f.store.listCapturedArtifacts({ includeArtifactIds: [second.id] })).artifacts.map(
          (a) => a.id,
        ),
      ).toEqual([second.id]);
      expect(
        (await f.store.listCapturedArtifacts({ taskIds: [], includeArtifactIds: [] })).artifacts,
      ).toEqual([]);
    });
    it("records exact selected inputs before delivery and preserves terminal receipts across retries", async () => {
      const f = await fixture();
      await f.upload();
      const artifact = await f.store.commitCapturedArtifact(f.producer.input);
      const consumer = await f.work();
      const input = {
        operationId: "read-1",
        artifactId: artifact.id,
        taskId: consumer.task.id,
        attemptId: consumer.attempt.id,
        paths: [entry.path],
        delivery: "read" as const,
      };
      const [acquired, retry] = await Promise.all([
        f.store.acquireCapturedArtifact(input),
        f.other.acquireCapturedArtifact(input),
      ]);
      expect(acquired).toEqual(retry);
      expect(acquired.status).toBe("authorized");
      await expect(
        f.store.acquireCapturedArtifact({ ...input, paths: ["missing"] }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        f.store.acquireCapturedArtifact({ ...input, operationId: "missing", paths: ["missing"] }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        f.store.settleArtifactAcquisition({
          id: acquired.id,
          attemptId: f.producer.attempt.id,
          status: "delivered",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await f.store.settleArtifactAcquisition({
        id: acquired.id,
        attemptId: consumer.attempt.id,
        status: "uncertain",
      });
      const delivered = await f.other.settleArtifactAcquisition({
        id: acquired.id,
        attemptId: consumer.attempt.id,
        status: "delivered",
      });
      expect(await f.store.acquireCapturedArtifact(input)).toEqual(delivered);
      await expect(
        f.store.settleArtifactAcquisition({
          id: acquired.id,
          attemptId: consumer.attempt.id,
          status: "failed",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        await f.store.listArtifactAcquisitions({
          attemptId: consumer.attempt.id,
          artifactId: artifact.id,
        }),
      ).toEqual([delivered]);
      expect(await f.store.getArtifactAcquisition(acquired.id)).toEqual(delivered);
    });
    it("fences new catalog mutations after Attempt completion", async () => {
      const f = await fixture();
      await f.upload();
      const artifact = await f.store.commitCapturedArtifact(f.producer.input);
      await f.store.closeTaskAttempt({
        attemptId: f.producer.attempt.id,
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      await expect(
        f.store.commitCapturedArtifact({ ...f.producer.input, operationId: "late" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(f.upload()).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        f.store.acquireCapturedArtifact({
          operationId: "late",
          artifactId: artifact.id,
          taskId: f.producer.task.id,
          attemptId: f.producer.attempt.id,
          paths: [entry.path],
          delivery: "read",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await f.store.findCapturedArtifact(artifact.id)).toEqual(artifact);
    });
    it("rejects unsafe or overlapping paths and bad digest metadata before storage", async () => {
      const f = await fixture();
      const input = f.producer.input;
      for (const path of [
        "/absolute",
        "../escape",
        "a/../b",
        "a//b",
        "a\\b",
        "a/",
        "a\0b",
        "C:file",
      ]) {
        expect(() =>
          validateCapturedArtifactInput({ ...input, entries: [{ ...entry, path }] }),
        ).toThrow();
      }
      for (const paths of [
        ["a", "a/b"],
        ["a/b", "a"],
        ["a", "a"],
      ])
        expect(() =>
          validateCapturedArtifactInput({
            ...input,
            entries: paths.map((path) => ({ ...entry, path })),
          }),
        ).toThrow();
      await expect(
        f.store.commitCapturedArtifact({
          ...input,
          entries: [{ ...entry, uri: "s3://private/object" }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        f.store.commitCapturedArtifact({ ...input, entries: [{ ...entry, sizeBytes: -1 }] }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
}
