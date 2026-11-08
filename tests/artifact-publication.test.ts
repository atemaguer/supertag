import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { openTestTask } from "./support/artifact-producer.js";
import { captureTestArtifact } from "./support/captured-artifact.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} cross-Objective artifact publication`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-publication-"));
        const isolated =
          dialect === "postgresql" && postgres
            ? await createIsolatedPostgresDatabase(postgres)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(async () => {
          await store.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        });
        const producerOwner = await store.createTag({ name: `producer-owner-${randomUUID()}` });
        const producerWorker = await store.createTag({ name: `producer-worker-${randomUUID()}` });
        const consumerOwner = await store.createTag({ name: `consumer-owner-${randomUUID()}` });
        const outsider = await store.createTag({ name: `outsider-${randomUUID()}` });
        const sourceObjective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: producerOwner.id,
          outcome: "Produce a reviewed interface",
          budgetLimitMinor: 100,
        });
        const destinationObjective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: consumerOwner.id,
          outcome: "Consume the reviewed interface",
          budgetLimitMinor: 100,
        });
        /** A work Session turn of the producer, with a running Attempt that captured an artifact. */
        async function producerTurn(seed: string, objectiveId = sourceObjective.id) {
          const { task } = await openTestTask(store, {
            tagId: producerWorker.id,
            tagName: producerWorker.name,
            objectiveId,
            requestText: `Produce interface ${seed}`,
          });
          const attempt = await store.createTaskAttempt({
            taskId: task.id,
            attemptNumber: 1,
            workerProfile: { id: "test", revision: "1" },
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          });
          const captured = await captureTestArtifact(store, task.id, { attempt, content: seed });
          const entry = captured.entries[0];
          if (!entry) throw new Error("Missing captured entry");
          return { task, attempt, captured, entry, paths: [entry.path] };
        }
        /** Completes the turn with the artifact in its Task result, as a finished Session does. */
        async function complete(
          turn: Awaited<ReturnType<typeof producerTurn>>,
          paths = turn.paths,
        ) {
          await store.closeTaskAttempt({
            attemptId: turn.attempt.id,
            status: "completed",
            endedAt: new Date().toISOString(),
          });
          await store.closeTask({
            taskId: turn.task.id,
            status: "completed",
            result: {
              summary: "Produced the interface",
              decisions: [],
              changes: [],
              unresolved: [],
              findings: [],
              references: [],
              artifacts: [{ artifactId: turn.captured.id, paths: [...paths] }],
            },
            endedAt: new Date().toISOString(),
          });
        }
        /** A completed producer turn whose artifact may be published. */
        async function completedSource(seed: string) {
          const turn = await producerTurn(seed);
          await complete(turn);
          return {
            source: turn.task,
            attempt: turn.attempt,
            digest: turn.entry.digest,
            uri: turn.entry.uri,
            artifactId: turn.captured.id,
            paths: turn.paths,
          };
        }
        return {
          store,
          producerOwner,
          producerWorker,
          consumerOwner,
          outsider,
          sourceObjective,
          destinationObjective,
          producerTurn,
          complete,
          completedSource,
        };
      }

      it("requires both owners and shows the audience nothing of the source's internals", async () => {
        const f = await fixture();
        const artifact = await f.completedSource("a");
        const publicationInput = {
          id: randomUUID(),
          artifactId: artifact.artifactId,
          paths: artifact.paths,
          audienceObjectiveIds: [f.destinationObjective.id],
        };
        // Only the source Objective's owner may publish.
        await expect(
          f.store.approveArtifactPublication(publicationInput, {
            kind: "tag",
            tagId: f.producerWorker.id,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
        const publication = await f.store.approveArtifactPublication(publicationInput, {
          kind: "tag",
          tagId: f.producerOwner.id,
        });
        expect(
          await f.store.approveArtifactPublication(publicationInput, {
            kind: "tag",
            tagId: f.producerOwner.id,
          }),
        ).toEqual(publication);
        const conflicting = await f.completedSource("z");
        await expect(
          f.store.approveArtifactPublication(
            { ...publicationInput, artifactId: conflicting.artifactId, paths: conflicting.paths },
            { kind: "tag", tagId: f.producerOwner.id },
          ),
        ).rejects.toMatchObject({ statusCode: 409 });

        const audience = await f.store.listArtifactPublicationsForObjective(
          f.destinationObjective.id,
        );
        expect(audience).toEqual([
          expect.objectContaining({
            id: publication.id,
            artifactId: artifact.artifactId,
            paths: artifact.paths,
            sourceObjectiveId: f.sourceObjective.id,
          }),
        ]);
        expect(JSON.stringify(audience)).not.toContain(artifact.source.id);
        expect(JSON.stringify(audience)).not.toContain("approvedBy");
        expect(JSON.stringify(audience)).not.toContain(f.producerOwner.id);

        // Only the audience Objective's owner may consent to consume.
        const consumptionInput = {
          id: randomUUID(),
          publicationApprovalId: publication.id,
          objectiveId: f.destinationObjective.id,
        };
        await expect(
          f.store.approveArtifactConsumption(consumptionInput, {
            kind: "tag",
            tagId: f.outsider.id,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
        const consumption = await f.store.approveArtifactConsumption(consumptionInput, {
          kind: "tag",
          tagId: f.consumerOwner.id,
        });
        expect(consumption).toMatchObject({
          publicationApprovalId: publication.id,
          objectiveId: f.destinationObjective.id,
          status: "available",
          revision: 1,
        });
        expect(await f.store.listArtifactConsumptionApprovals(f.destinationObjective.id)).toEqual([
          consumption,
        ]);
      });

      it("rejects unfinished sources, wrong paths, and unnamed audiences", async () => {
        const f = await fixture();
        const turn = await f.producerTurn("unfinished");
        const approval = {
          id: randomUUID(),
          artifactId: turn.captured.id,
          paths: ["output.json"],
          audienceObjectiveIds: [f.destinationObjective.id],
        };
        // The source Session's turn must have completed with the artifact in its result.
        await expect(
          f.store.approveArtifactPublication(approval, {
            kind: "tag",
            tagId: f.producerOwner.id,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await f.complete(turn);
        await expect(
          f.store.approveArtifactPublication(
            { ...approval, paths: ["missing.json"] },
            { kind: "tag", tagId: f.producerOwner.id },
          ),
        ).rejects.toMatchObject({ statusCode: 400 });
        const publication = await f.store.approveArtifactPublication(approval, {
          kind: "tag",
          tagId: f.producerOwner.id,
        });
        // The source Objective is never its own audience.
        await expect(
          f.store.approveArtifactConsumption(
            {
              id: randomUUID(),
              publicationApprovalId: publication.id,
              objectiveId: f.sourceObjective.id,
            },
            { kind: "tag", tagId: f.producerOwner.id },
          ),
        ).rejects.toMatchObject({ statusCode: 404 });
      });

      it("refuses an artifact that is not from the source turn's final Attempt", async () => {
        const f = await fixture();
        const turn = await f.producerTurn("superseded-attempt");
        await f.complete(turn);
        // A later Attempt of the same turn retires the captured one's standing.
        await f.store.createTaskAttempt({
          taskId: turn.task.id,
          attemptNumber: 2,
          workerProfile: { id: "test", revision: "1" },
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        await expect(
          f.store.approveArtifactPublication(
            {
              id: randomUUID(),
              artifactId: turn.captured.id,
              paths: turn.paths,
              audienceObjectiveIds: [f.destinationObjective.id],
            },
            { kind: "tag", tagId: f.producerOwner.id },
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
      });

      it("withdraws revisioned approvals idempotently, supports replacement, and audits both", async () => {
        const f = await fixture();
        const first = await f.completedSource("b");
        const publication = await f.store.approveArtifactPublication(
          {
            id: randomUUID(),
            artifactId: first.artifactId,
            paths: first.paths,
            audienceObjectiveIds: [f.destinationObjective.id],
          },
          { kind: "operator", operatorId: "test-operator" },
        );
        const consent = await f.store.approveArtifactConsumption(
          {
            id: randomUUID(),
            publicationApprovalId: publication.id,
            objectiveId: f.destinationObjective.id,
          },
          { kind: "tag", tagId: f.consumerOwner.id },
        );
        const withdrawnConsent = await f.store.withdrawArtifactConsumption(
          { id: consent.id, expectedRevision: 1 },
          { kind: "tag", tagId: f.consumerOwner.id },
        );
        expect(withdrawnConsent).toMatchObject({ status: "withdrawn", revision: 2 });
        expect(
          await f.store.withdrawArtifactConsumption(
            { id: consent.id, expectedRevision: 1 },
            { kind: "tag", tagId: f.consumerOwner.id },
          ),
        ).toEqual(withdrawnConsent);

        const replacementArtifact = await f.completedSource("c");
        const replacement = await f.store.approveArtifactPublication(
          {
            id: randomUUID(),
            artifactId: replacementArtifact.artifactId,
            paths: replacementArtifact.paths,
            audienceObjectiveIds: [f.destinationObjective.id],
            supersedesPublicationId: publication.id,
          },
          { kind: "tag", tagId: f.producerOwner.id },
        );
        expect(replacement.supersedesPublicationId).toBe(publication.id);
        expect(
          (await f.store.listArtifactPublicationsForObjective(f.destinationObjective.id)).map(
            (view) => view.id,
          ),
        ).toContain(replacement.id);

        const withdrawn = await f.store.withdrawArtifactPublication(
          { id: replacement.id, expectedRevision: 1 },
          { kind: "tag", tagId: f.producerOwner.id },
        );
        expect(withdrawn).toMatchObject({ status: "withdrawn", revision: 2 });
        expect(
          await f.store.listArtifactApprovalAuditEvents({
            approvalType: "publication",
            approvalId: replacement.id,
          }),
        ).toEqual([
          expect.objectContaining({ action: "approved", revision: 1 }),
          expect.objectContaining({ action: "withdrawn", revision: 2 }),
        ]);
        expect(
          await f.store.listArtifactApprovalAuditEvents({
            approvalType: "consumption",
            approvalId: consent.id,
          }),
        ).toEqual([
          expect.objectContaining({ action: "approved", revision: 1 }),
          expect.objectContaining({ action: "withdrawn", revision: 2 }),
        ]);
      });
    },
  );
}
