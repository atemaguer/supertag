import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdmitTaskAssignmentInput, Tag } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
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
        const other = new DrizzleStore({ url });
        await other.connect();
        cleanups.push(async () => {
          await other.disconnect();
          await store.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        });
        const producerOwner = await store.createTag({ name: `producer-owner-${randomUUID()}` });
        const producerWorker = await store.createTag({ name: `producer-worker-${randomUUID()}` });
        const consumerOwner = await store.createTag({ name: `consumer-owner-${randomUUID()}` });
        const consumerWorker = await store.createTag({ name: `consumer-worker-${randomUUID()}` });
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
        const sourceTeam = await store.createTeam(
          {
            id: randomUUID(),
            objectiveId: sourceObjective.id,
            name: "Producer",
            leadTagId: producerOwner.id,
            memberTagIds: [producerWorker.id],
            maxConcurrency: 1,
          },
          producerOwner.id,
        );
        const destinationTeam = await store.createTeam(
          {
            id: randomUUID(),
            objectiveId: destinationObjective.id,
            name: "Consumer",
            leadTagId: consumerOwner.id,
            memberTagIds: [consumerWorker.id],
            maxConcurrency: 1,
          },
          consumerOwner.id,
        );
        const make = (
          objectiveId: string,
          teamId: string,
          requester: Tag,
          assignee: Tag,
          extra: Partial<AdmitTaskAssignmentInput> = {},
        ): AdmitTaskAssignmentInput => ({
          taskId: randomUUID(),
          objectiveId,
          teamId,
          requestedByTagId: requester.id,
          assignedTagId: assignee.id,
          instruction: "Produce or consume the interface",
          acceptanceCriteria: ["Evidence is reviewable"],
          execution: {},
          authorizationSnapshot: {
            version: 4,
            capturedAt: new Date().toISOString(),
            tag: { id: assignee.id, name: assignee.name },
            origin: { kind: "internal", objectiveId, requestedByTagId: requester.id },
            requester: { id: requester.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
          contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
          workspacePlan: { version: 1, status: "none" },
          ...extra,
        });
        async function acceptedSource(seed: string) {
          const source = await store.admitTaskAssignment(
            make(sourceObjective.id, sourceTeam.id, producerOwner, producerWorker, {
              instruction: `Produce interface ${seed}`,
            }),
          );
          await store.claimTaskAssignment({ taskId: source.taskId, leaseOwner: seed });
          const attempt = await store.createTaskAttempt({
            taskId: source.taskId,
            attemptNumber: 1,
            workerProfile: { id: "test", revision: "1" },
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          });
          const captured = await captureTestArtifact(store, source.taskId, {
            attempt,
            content: seed,
          });
          const entry = captured.entries[0];
          if (!entry) throw new Error("Missing captured entry");
          const { digest, uri } = entry;
          await store.settleTaskAssignment({
            taskId: source.taskId,
            leaseOwner: seed,
            attemptCount: 1,
            result: {
              taskResult: {
                artifacts: [{ artifactId: captured.id, paths: [entry.path] }],
              },
            },
          });
          await store.reviewTaskAssignment(
            source.taskId,
            producerOwner.id,
            true,
            `Internal assessment ${seed}`,
          );
          return { source, attempt, digest, uri, artifactId: captured.id, paths: [entry.path] };
        }
        return {
          store,
          other,
          producerOwner,
          producerWorker,
          consumerOwner,
          consumerWorker,
          outsider,
          sourceObjective,
          destinationObjective,
          sourceTeam,
          destinationTeam,
          make,
          acceptedSource,
        };
      }

      it("requires both owners and freezes only approved provenance in the consumer", async () => {
        const f = await fixture();
        const artifact = await f.acceptedSource("a");
        const publicationInput = {
          id: randomUUID(),
          artifactId: artifact.artifactId,
          paths: artifact.paths,
          audienceObjectiveIds: [f.destinationObjective.id],
        };
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
        const conflicting = await f.acceptedSource("z");
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
        expect(JSON.stringify(audience)).not.toContain(artifact.source.taskId);
        expect(JSON.stringify(audience)).not.toContain("Internal assessment");
        expect(JSON.stringify(audience)).not.toContain("approvedBy");
        expect(JSON.stringify(audience)).not.toContain(f.producerOwner.id);

        const selector = {
          publicationApprovalId: publication.id,
          artifactId: artifact.artifactId,
          paths: artifact.paths,
        };
        const beforeConsent = f.make(
          f.destinationObjective.id,
          f.destinationTeam.id,
          f.consumerOwner,
          f.consumerWorker,
          { inputArtifacts: [selector], maxCostMinor: 25 },
        );
        await expect(f.store.admitTaskAssignment(beforeConsent)).rejects.toMatchObject({
          statusCode: 404,
        });
        expect(await f.store.getObjective(f.destinationObjective.id)).toMatchObject({
          reservedMinor: 0,
        });

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
        const admitted = await f.store.admitTaskAssignment(beforeConsent);
        const frozen = (await f.store.findTaskById(admitted.taskId))?.trigger["inputArtifacts"];
        expect(frozen).toEqual([
          {
            artifactId: artifact.artifactId,
            path: artifact.paths[0],
            sizeBytes: 1,
            uri: artifact.uri,
            digest: artifact.digest,
            mediaType: "application/json",
            provenance: {
              taskId: artifact.source.taskId,
              attemptId: artifact.attempt.id,
              attemptCount: 1,
              statusAtAdmission: "accepted",
              reviewedByTagId: f.producerOwner.id,
              sourceObjectiveId: f.sourceObjective.id,
              publicationApproval: {
                id: publication.id,
                revision: 1,
                approvedAt: publication.approvedAt,
              },
              consumptionApproval: {
                id: consumption.id,
                revision: 1,
                approvedAt: consumption.approvedAt,
              },
            },
          },
        ]);
        expect(JSON.stringify(frozen)).not.toContain("Internal assessment");
        expect(JSON.stringify(frozen)).not.toContain("hidden");
      });

      it("rejects unreviewed sources, wrong paths, and unnamed audiences", async () => {
        const f = await fixture();
        const source = await f.store.admitTaskAssignment(
          f.make(f.sourceObjective.id, f.sourceTeam.id, f.producerOwner, f.producerWorker),
        );
        await f.store.claimTaskAssignment({ taskId: source.taskId, leaseOwner: "unreviewed" });
        const attempt = await f.store.createTaskAttempt({
          taskId: source.taskId,
          attemptNumber: 1,
          workerProfile: { id: "test", revision: "1" },
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        const captured = await captureTestArtifact(f.store, source.taskId, { attempt });
        await f.store.settleTaskAssignment({
          taskId: source.taskId,
          leaseOwner: "unreviewed",
          attemptCount: 1,
          result: {
            taskResult: { artifacts: [{ artifactId: captured.id, paths: ["output.json"] }] },
          },
        });
        const approval = {
          id: randomUUID(),
          artifactId: captured.id,
          paths: ["output.json"],
          audienceObjectiveIds: [f.destinationObjective.id],
        };
        await expect(
          f.store.approveArtifactPublication(approval, {
            kind: "tag",
            tagId: f.producerOwner.id,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await f.store.reviewTaskAssignment(source.taskId, f.producerOwner.id, true, "Accepted");
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

      it("withdraws revisioned approvals without altering existing pins and supports replacement", async () => {
        const f = await fixture();
        const first = await f.acceptedSource("b");
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
        const originalInput = f.make(
          f.destinationObjective.id,
          f.destinationTeam.id,
          f.consumerOwner,
          f.consumerWorker,
          {
            inputArtifacts: [
              {
                publicationApprovalId: publication.id,
                artifactId: first.artifactId,
                paths: first.paths,
              },
            ],
          },
        );
        const original = await f.store.admitTaskAssignment(originalInput);
        const originalTrigger = (await f.store.findTaskById(original.taskId))?.trigger;
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
        expect(await f.store.admitTaskAssignment(originalInput)).toEqual(original);
        expect((await f.store.findTaskById(original.taskId))?.trigger).toEqual(originalTrigger);
        await expect(
          f.store.admitTaskAssignment({ ...originalInput, taskId: randomUUID() }),
        ).rejects.toMatchObject({ statusCode: 404 });

        const replacementArtifact = await f.acceptedSource("c");
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
        await f.store.approveArtifactConsumption(
          {
            id: randomUUID(),
            publicationApprovalId: replacement.id,
            objectiveId: f.destinationObjective.id,
          },
          { kind: "tag", tagId: f.consumerOwner.id },
        );
        const replacementTask = await f.store.admitTaskAssignment(
          f.make(
            f.destinationObjective.id,
            f.destinationTeam.id,
            f.consumerOwner,
            f.consumerWorker,
            {
              inputArtifacts: [
                {
                  publicationApprovalId: replacement.id,
                  artifactId: replacementArtifact.artifactId,
                  paths: replacementArtifact.paths,
                },
              ],
            },
          ),
        );
        expect(
          (await f.store.findTaskById(replacementTask.taskId))?.trigger["inputArtifacts"],
        ).toEqual([
          expect.objectContaining({
            digest: replacementArtifact.digest,
            provenance: expect.objectContaining({
              publicationApproval: expect.objectContaining({ id: replacement.id }),
            }),
          }),
        ]);
        expect((await f.store.findTaskById(original.taskId))?.trigger).toEqual(originalTrigger);

        const withdrawn = await f.store.withdrawArtifactPublication(
          { id: replacement.id, expectedRevision: 1 },
          { kind: "tag", tagId: f.producerOwner.id },
        );
        expect(withdrawn).toMatchObject({ status: "withdrawn", revision: 2 });
        await expect(
          f.store.admitTaskAssignment(
            f.make(
              f.destinationObjective.id,
              f.destinationTeam.id,
              f.consumerOwner,
              f.consumerWorker,
              {
                inputArtifacts: [
                  {
                    publicationApprovalId: replacement.id,
                    artifactId: replacementArtifact.artifactId,
                    paths: replacementArtifact.paths,
                  },
                ],
              },
            ),
          ),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(
          await f.store.listArtifactApprovalAuditEvents({
            approvalType: "publication",
            approvalId: replacement.id,
          }),
        ).toEqual([
          expect.objectContaining({ action: "approved", revision: 1 }),
          expect.objectContaining({ action: "withdrawn", revision: 2 }),
        ]);
      });

      it("serializes withdrawal against admission with either a durable pin or no Task", async () => {
        const f = await fixture();
        const artifact = await f.acceptedSource("d");
        const publication = await f.store.approveArtifactPublication(
          {
            id: randomUUID(),
            artifactId: artifact.artifactId,
            paths: artifact.paths,
            audienceObjectiveIds: [f.destinationObjective.id],
          },
          { kind: "tag", tagId: f.producerOwner.id },
        );
        await f.store.approveArtifactConsumption(
          {
            id: randomUUID(),
            publicationApprovalId: publication.id,
            objectiveId: f.destinationObjective.id,
          },
          { kind: "tag", tagId: f.consumerOwner.id },
        );
        const input = f.make(
          f.destinationObjective.id,
          f.destinationTeam.id,
          f.consumerOwner,
          f.consumerWorker,
          {
            inputArtifacts: [
              {
                publicationApprovalId: publication.id,
                artifactId: artifact.artifactId,
                paths: artifact.paths,
              },
            ],
          },
        );
        const [withdrawal, admission] = await Promise.allSettled([
          f.store.withdrawArtifactPublication(
            { id: publication.id, expectedRevision: 1 },
            { kind: "tag", tagId: f.producerOwner.id },
          ),
          f.other.admitTaskAssignment(input),
        ]);
        expect(withdrawal.status).toBe("fulfilled");
        if (admission.status === "fulfilled") {
          expect((await f.store.findTaskById(input.taskId))?.trigger["inputArtifacts"]).toEqual([
            expect.objectContaining({
              digest: artifact.digest,
              provenance: expect.objectContaining({
                publicationApproval: expect.objectContaining({ id: publication.id }),
              }),
            }),
          ]);
        } else {
          expect(admission.reason).toMatchObject({ statusCode: 404 });
          expect(await f.store.findTaskById(input.taskId)).toBeUndefined();
        }
      });
    },
  );
}
