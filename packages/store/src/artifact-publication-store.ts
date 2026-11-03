// biome-ignore-all lint/suspicious/noExplicitAny: Shared dialect transactions execute synchronously on SQLite and asynchronously on PostgreSQL.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ApproveArtifactConsumptionInput,
  ApproveArtifactPublicationInput,
  ArtifactApprovalActor,
  ArtifactApprovalAuditEvent,
  ArtifactConsumptionApproval,
  ArtifactPublication,
  ArtifactPublicationAudienceView,
  ArtifactPublicationStore,
  DatabaseProvider,
  WithdrawArtifactApprovalInput,
} from "@supertag/core";
import { parseArtifactSelection, TagMessagingError } from "@supertag/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { includesSelection, selectedEntries } from "./artifact-selection.js";
import { runDialectTransaction } from "./dialect-transaction.js";
import { lockObjective } from "./objective-lock.js";

type Flow<T> = Generator<any, T, any>;

export class DrizzleArtifactPublicationStore implements ArtifactPublicationStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  private transaction<T>(work: (tx: any) => Flow<T>): Promise<T> {
    return runDialectTransaction(this.db, this.provider, work);
  }

  private *lockObjectives(tx: any, objectiveIds: readonly string[]): Flow<Map<string, any>> {
    const rows = new Map<string, any>();
    for (const objectiveId of [...new Set(objectiveIds)].sort()) {
      const [row] = yield lockObjective(tx, this.tables.objectives, objectiveId);
      if (!row) throw new TagMessagingError(404, "Objective not found");
      rows.set(objectiveId, row);
    }
    return rows;
  }

  private *lockApproval(tx: any, table: any, id: string): Flow<any | undefined> {
    const [row] = yield tx
      .update(table)
      .set({ revision: sql`${table.revision}` })
      .where(eq(table.id, id))
      .returning();
    return row;
  }

  async approveArtifactPublication(
    input: ApproveArtifactPublicationInput,
    actor: ArtifactApprovalActor,
  ): Promise<ArtifactPublication> {
    const definition = publicationDefinition(input);
    const approvalActor = parseActor(actor);
    const q = this.tables.taskAssignments,
      publications = this.tables.artifactPublicationApprovals;
    const [artifact] = await this.db
      .select()
      .from(this.tables.capturedArtifacts)
      .where(eq(this.tables.capturedArtifacts.id, definition.artifactId));
    if (!artifact) throw new TagMessagingError(404, "Accepted artifact not found");
    const entries = selectedEntries(artifact, definition);
    const [initial] = await this.db
      .select({ objectiveId: q.objectiveId })
      .from(q)
      .where(eq(q.taskId, artifact.taskId));
    if (!initial) throw new TagMessagingError(404, "Accepted artifact not found");
    const self = this;
    return this.transaction(function* (tx) {
      const objectives = yield* self.lockObjectives(tx, [
        initial.objectiveId,
        ...definition.audienceObjectiveIds,
      ]);
      const sourceObjective = objectives.get(initial.objectiveId);
      authorizeOwner(sourceObjective, approvalActor);

      const existing = yield* self.lockApproval(tx, publications, definition.id);
      if (existing) {
        if (!samePublicationDefinition(existing, definition, approvalActor))
          throw new TagMessagingError(409, "Publication approval ID has a different definition");
        return publicationFromRow(existing);
      }

      if (definition.audienceObjectiveIds.includes(initial.objectiveId))
        throw new TagMessagingError(400, "Publication audience must name other Objectives");

      const [source] = yield tx.select().from(q).where(eq(q.taskId, artifact.taskId));
      if (!source || source.objectiveId !== initial.objectiveId || source.status !== "accepted")
        throw new TagMessagingError(409, "Artifact source must have an accepted review");
      if (
        !includesSelection(source.result?.taskResult?.artifacts, definition) ||
        !includesSelection(source.result?.reviewedArtifacts, definition) ||
        source.result?.reviewedAttemptId !== artifact.attemptId
      )
        throw new TagMessagingError(409, "Selected artifact has no accepted review");
      const reviewedByTagId = source.result?.reviewedByTagId;
      const assessment = source.result?.assessment;
      if (typeof reviewedByTagId !== "string" || typeof assessment !== "string")
        throw new TagMessagingError(409, "Accepted source review provenance is incomplete");
      const attempts = self.tables.taskAttempts;
      const [attempt] = yield tx
        .select()
        .from(attempts)
        .where(
          and(eq(attempts.taskId, source.taskId), eq(attempts.attemptNumber, source.attemptCount)),
        );
      if (!attempt || attempt.id !== artifact.attemptId)
        throw new TagMessagingError(409, "Accepted source Attempt provenance is incomplete");

      if (definition.supersedesPublicationId) {
        const superseded = yield* self.lockApproval(
          tx,
          publications,
          definition.supersedesPublicationId,
        );
        if (!superseded || superseded.sourceObjectiveId !== source.objectiveId)
          throw new TagMessagingError(404, "Superseded publication not found");
        if (
          superseded.artifactId === definition.artifactId &&
          isDeepStrictEqual(superseded.paths, definition.paths)
        )
          throw new TagMessagingError(
            400,
            "Replacement publication must select different artifact files",
          );
      }

      const at = new Date().toISOString();
      const [row] = yield tx
        .insert(publications)
        .values({
          id: definition.id,
          sourceTaskId: source.taskId,
          sourceObjectiveId: source.objectiveId,
          artifactId: artifact.id,
          paths: definition.paths,
          entries,
          sourceAttemptId: attempt.id,
          sourceAttemptCount: source.attemptCount,
          reviewedByTagId,
          assessment,
          acceptedAt: source.updatedAt,
          audienceObjectiveIds: definition.audienceObjectiveIds,
          approvedByKind: approvalActor.kind,
          approvedById: actorId(approvalActor),
          approvedAt: at,
          supersedesPublicationId: definition.supersedesPublicationId ?? null,
          status: "available",
          revision: 1,
          withdrawnByKind: null,
          withdrawnById: null,
          withdrawnAt: null,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      yield* self.appendAudit(
        tx,
        "publication",
        row.id,
        row.sourceObjectiveId,
        1,
        "approved",
        approvalActor,
        at,
      );
      return publicationFromRow(row);
    });
  }

  async approveArtifactConsumption(
    input: ApproveArtifactConsumptionInput,
    actor: ArtifactApprovalActor,
  ): Promise<ArtifactConsumptionApproval> {
    const definition = consumptionDefinition(input);
    const approvalActor = parseActor(actor);
    const publications = this.tables.artifactPublicationApprovals,
      consumptions = this.tables.artifactConsumptionApprovals;
    const [initial] = await this.db
      .select()
      .from(publications)
      .where(eq(publications.id, definition.publicationApprovalId));
    if (!initial) throw new TagMessagingError(404, "Published artifact not found");
    const self = this;
    return this.transaction(function* (tx) {
      const objectives = yield* self.lockObjectives(tx, [
        initial.sourceObjectiveId,
        definition.objectiveId,
      ]);
      authorizeOwner(objectives.get(definition.objectiveId), approvalActor);
      const publication = yield* self.lockApproval(tx, publications, initial.id);
      if (
        publication?.status !== "available" ||
        !publication.audienceObjectiveIds.includes(definition.objectiveId)
      )
        throw new TagMessagingError(404, "Published artifact not available to this Objective");
      const existing = yield* self.lockApproval(tx, consumptions, definition.id);
      if (existing) {
        if (!sameConsumptionDefinition(existing, definition, approvalActor))
          throw new TagMessagingError(409, "Consumption approval ID has a different definition");
        return consumptionFromRow(existing);
      }
      const [duplicate] = yield tx
        .select()
        .from(consumptions)
        .where(
          and(
            eq(consumptions.publicationApprovalId, publication.id),
            eq(consumptions.objectiveId, definition.objectiveId),
          ),
        );
      if (duplicate)
        throw new TagMessagingError(409, "This Objective already approved the publication");
      const at = new Date().toISOString();
      const [row] = yield tx
        .insert(consumptions)
        .values({
          id: definition.id,
          publicationApprovalId: publication.id,
          objectiveId: definition.objectiveId,
          approvedByKind: approvalActor.kind,
          approvedById: actorId(approvalActor),
          approvedAt: at,
          status: "available",
          revision: 1,
          withdrawnByKind: null,
          withdrawnById: null,
          withdrawnAt: null,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      yield* self.appendAudit(
        tx,
        "consumption",
        row.id,
        row.objectiveId,
        1,
        "approved",
        approvalActor,
        at,
      );
      return consumptionFromRow(row);
    });
  }

  async withdrawArtifactPublication(
    input: WithdrawArtifactApprovalInput,
    actor: ArtifactApprovalActor,
  ): Promise<ArtifactPublication> {
    return (await this.withdraw("publication", input, actor)) as ArtifactPublication;
  }

  async withdrawArtifactConsumption(
    input: WithdrawArtifactApprovalInput,
    actor: ArtifactApprovalActor,
  ): Promise<ArtifactConsumptionApproval> {
    return (await this.withdraw("consumption", input, actor)) as ArtifactConsumptionApproval;
  }

  private async withdraw(
    type: "publication" | "consumption",
    input: WithdrawArtifactApprovalInput,
    actor: ArtifactApprovalActor,
  ): Promise<ArtifactPublication | ArtifactConsumptionApproval> {
    const definition = withdrawalDefinition(input);
    const approvalActor = parseActor(actor);
    const publications = this.tables.artifactPublicationApprovals,
      consumptions = this.tables.artifactConsumptionApprovals;
    const table = type === "publication" ? publications : consumptions;
    const [initial] = await this.db.select().from(table).where(eq(table.id, definition.id));
    if (!initial) throw new TagMessagingError(404, "Artifact approval not found");
    let publication = initial;
    if (type === "consumption") {
      [publication] = await this.db
        .select()
        .from(publications)
        .where(eq(publications.id, initial.publicationApprovalId));
      if (!publication) throw new TagMessagingError(404, "Artifact approval not found");
    }
    const objectiveIds =
      type === "publication"
        ? [initial.sourceObjectiveId, ...initial.audienceObjectiveIds]
        : [publication.sourceObjectiveId, initial.objectiveId];
    const self = this;
    return this.transaction(function* (tx) {
      const objectives = yield* self.lockObjectives(tx, objectiveIds);
      const authorityObjective = objectives.get(
        type === "publication" ? initial.sourceObjectiveId : initial.objectiveId,
      );
      authorizeOwner(authorityObjective, approvalActor);
      if (type === "consumption") yield* self.lockApproval(tx, publications, publication.id);
      const current = yield* self.lockApproval(tx, table, definition.id);
      if (!current) throw new TagMessagingError(404, "Artifact approval not found");
      if (
        current.status === "withdrawn" &&
        current.revision === definition.expectedRevision + 1 &&
        current.withdrawnByKind === approvalActor.kind &&
        current.withdrawnById === actorId(approvalActor)
      )
        return type === "publication" ? publicationFromRow(current) : consumptionFromRow(current);
      if (current.status !== "available" || current.revision !== definition.expectedRevision)
        throw new TagMessagingError(409, "Artifact approval revision conflict");
      const at = new Date().toISOString();
      const revision = current.revision + 1;
      const [row] = yield tx
        .update(table)
        .set({
          status: "withdrawn",
          revision,
          withdrawnByKind: approvalActor.kind,
          withdrawnById: actorId(approvalActor),
          withdrawnAt: at,
          updatedAt: at,
        })
        .where(and(eq(table.id, current.id), eq(table.revision, current.revision)))
        .returning();
      if (!row) throw new TagMessagingError(409, "Artifact approval revision conflict");
      yield* self.appendAudit(
        tx,
        type,
        row.id,
        type === "publication" ? row.sourceObjectiveId : row.objectiveId,
        revision,
        "withdrawn",
        approvalActor,
        at,
      );
      return type === "publication" ? publicationFromRow(row) : consumptionFromRow(row);
    });
  }

  async getArtifactPublication(id: string): Promise<ArtifactPublication | undefined> {
    const approvalId = boundedId(id, "Publication approval id");
    const [row] = await this.db
      .select()
      .from(this.tables.artifactPublicationApprovals)
      .where(eq(this.tables.artifactPublicationApprovals.id, approvalId));
    return row ? publicationFromRow(row) : undefined;
  }

  async getArtifactConsumptionApproval(
    id: string,
  ): Promise<ArtifactConsumptionApproval | undefined> {
    const approvalId = boundedId(id, "Consumption approval id");
    const [row] = await this.db
      .select()
      .from(this.tables.artifactConsumptionApprovals)
      .where(eq(this.tables.artifactConsumptionApprovals.id, approvalId));
    return row ? consumptionFromRow(row) : undefined;
  }

  async listArtifactPublicationsForObjective(
    objectiveId: string,
  ): Promise<readonly ArtifactPublicationAudienceView[]> {
    const id = boundedId(objectiveId, "Objective id");
    const rows = await this.db
      .select()
      .from(this.tables.artifactPublicationApprovals)
      .orderBy(asc(this.tables.artifactPublicationApprovals.createdAt));
    return rows
      .filter((row: any) => row.sourceObjectiveId === id || row.audienceObjectiveIds.includes(id))
      .map(publicationAudienceViewFromRow);
  }

  async listArtifactConsumptionApprovals(
    objectiveId: string,
  ): Promise<readonly ArtifactConsumptionApproval[]> {
    const id = boundedId(objectiveId, "Objective id");
    return (
      await this.db
        .select()
        .from(this.tables.artifactConsumptionApprovals)
        .where(eq(this.tables.artifactConsumptionApprovals.objectiveId, id))
        .orderBy(asc(this.tables.artifactConsumptionApprovals.createdAt))
    ).map(consumptionFromRow);
  }

  async listArtifactApprovalAuditEvents(input: {
    approvalType: ArtifactApprovalAuditEvent["approvalType"];
    approvalId: string;
  }): Promise<readonly ArtifactApprovalAuditEvent[]> {
    if (!["publication", "consumption"].includes(input.approvalType))
      throw new TagMessagingError(400, "Invalid artifact approval type");
    const id = boundedId(input.approvalId, "Artifact approval id");
    const t = this.tables.artifactApprovalAuditEvents;
    return (
      await this.db
        .select()
        .from(t)
        .where(and(eq(t.approvalType, input.approvalType), eq(t.approvalId, id)))
        .orderBy(asc(t.revision))
    ).map(auditFromRow);
  }

  private *appendAudit(
    tx: any,
    approvalType: ArtifactApprovalAuditEvent["approvalType"],
    approvalId: string,
    objectiveId: string,
    revision: number,
    action: ArtifactApprovalAuditEvent["action"],
    actor: ArtifactApprovalActor,
    createdAt: string,
  ): Flow<void> {
    yield tx
      .insert(this.tables.artifactApprovalAuditEvents)
      .values({
        id: randomUUID(),
        approvalType,
        approvalId,
        objectiveId,
        revision,
        action,
        actorKind: actor.kind,
        actorId: actorId(actor),
        createdAt,
      })
      .returning();
  }
}

function publicationDefinition(input: ApproveArtifactPublicationInput) {
  if (!input || typeof input !== "object") throw new TagMessagingError(400, "Invalid publication");
  const id = boundedId(input.id, "Publication approval id");
  const { artifactId, paths } = parseArtifactSelection(input);
  if (!Array.isArray(input.audienceObjectiveIds))
    throw new TagMessagingError(400, "Publication audience must be an array");
  const audienceObjectiveIds = [
    ...new Set(
      input.audienceObjectiveIds.map((value) => boundedId(value, "Audience Objective id")),
    ),
  ].sort();
  if (audienceObjectiveIds.length < 1 || audienceObjectiveIds.length > 100)
    throw new TagMessagingError(400, "Publication audience must contain 1–100 Objectives");
  const supersedesPublicationId =
    input.supersedesPublicationId === undefined
      ? undefined
      : boundedId(input.supersedesPublicationId, "Superseded publication id");
  if (supersedesPublicationId === id)
    throw new TagMessagingError(400, "Publication cannot supersede itself");
  return { id, artifactId, paths, audienceObjectiveIds, supersedesPublicationId };
}

function consumptionDefinition(input: ApproveArtifactConsumptionInput) {
  if (!input || typeof input !== "object")
    throw new TagMessagingError(400, "Invalid consumption approval");
  return {
    id: boundedId(input.id, "Consumption approval id"),
    publicationApprovalId: boundedId(input.publicationApprovalId, "Publication approval id"),
    objectiveId: boundedId(input.objectiveId, "Objective id"),
  };
}

function withdrawalDefinition(input: WithdrawArtifactApprovalInput) {
  if (!input || typeof input !== "object") throw new TagMessagingError(400, "Invalid withdrawal");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new TagMessagingError(400, "expectedRevision must be a positive integer");
  return {
    id: boundedId(input.id, "Artifact approval id"),
    expectedRevision: input.expectedRevision,
  };
}

function parseActor(actor: ArtifactApprovalActor): ArtifactApprovalActor {
  if (!actor || typeof actor !== "object")
    throw new TagMessagingError(403, "Authenticated approval actor required");
  if (actor.kind === "tag") return { kind: "tag", tagId: boundedId(actor.tagId, "Actor Tag id") };
  if (actor.kind === "operator")
    return { kind: "operator", operatorId: boundedId(actor.operatorId, "Operator id") };
  throw new TagMessagingError(403, "Authenticated approval actor required");
}

function authorizeOwner(objective: any, actor: ArtifactApprovalActor): void {
  if (!objective) throw new TagMessagingError(404, "Objective not found");
  if (actor.kind === "tag" && objective.ownerTagId !== actor.tagId)
    throw new TagMessagingError(403, "Objective owner or operator required");
}

function boundedId(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > 200 || /[\s\p{Cc}]/u.test(value))
    throw new TagMessagingError(400, `Invalid ${name}`);
  return value;
}

function samePublicationDefinition(
  row: any,
  definition: ReturnType<typeof publicationDefinition>,
  actor: ArtifactApprovalActor,
): boolean {
  return (
    row.artifactId === definition.artifactId &&
    isDeepStrictEqual(row.paths, definition.paths) &&
    isDeepStrictEqual(row.audienceObjectiveIds, definition.audienceObjectiveIds) &&
    row.supersedesPublicationId === (definition.supersedesPublicationId ?? null) &&
    row.approvedByKind === actor.kind &&
    row.approvedById === actorId(actor)
  );
}

function sameConsumptionDefinition(
  row: any,
  definition: ReturnType<typeof consumptionDefinition>,
  actor: ArtifactApprovalActor,
): boolean {
  return (
    row.publicationApprovalId === definition.publicationApprovalId &&
    row.objectiveId === definition.objectiveId &&
    row.approvedByKind === actor.kind &&
    row.approvedById === actorId(actor)
  );
}

function actorId(actor: ArtifactApprovalActor): string {
  return actor.kind === "tag" ? actor.tagId : actor.operatorId;
}

function actorFromRow(kind: unknown, id: unknown): ArtifactApprovalActor {
  if (kind === "tag" && typeof id === "string") return { kind, tagId: id };
  if (kind === "operator" && typeof id === "string") return { kind, operatorId: id };
  throw new Error("Persisted artifact approval actor is invalid");
}

function optionalActorFromRow(kind: unknown, id: unknown): ArtifactApprovalActor | null {
  if (kind === null && id === null) return null;
  return actorFromRow(kind, id);
}

function publicationFromRow(row: any): ArtifactPublication {
  return {
    id: row.id,
    sourceTaskId: row.sourceTaskId,
    sourceObjectiveId: row.sourceObjectiveId,
    artifactId: row.artifactId,
    paths: row.paths,
    entries: row.entries,
    sourceAttemptId: row.sourceAttemptId,
    sourceAttemptCount: row.sourceAttemptCount,
    reviewedByTagId: row.reviewedByTagId,
    assessment: row.assessment,
    acceptedAt: row.acceptedAt,
    audienceObjectiveIds: row.audienceObjectiveIds,
    approvedBy: actorFromRow(row.approvedByKind, row.approvedById),
    approvedAt: row.approvedAt,
    supersedesPublicationId: row.supersedesPublicationId,
    status: row.status,
    revision: row.revision,
    withdrawnBy: optionalActorFromRow(row.withdrawnByKind, row.withdrawnById),
    withdrawnAt: row.withdrawnAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicationAudienceViewFromRow(row: any): ArtifactPublicationAudienceView {
  return {
    id: row.id,
    sourceObjectiveId: row.sourceObjectiveId,
    artifactId: row.artifactId,
    paths: row.paths,
    entries: row.entries,
    sourceAttemptCount: row.sourceAttemptCount,
    acceptedAt: row.acceptedAt,
    supersedesPublicationId: row.supersedesPublicationId,
    status: row.status,
    revision: row.revision,
  };
}

function consumptionFromRow(row: any): ArtifactConsumptionApproval {
  return {
    id: row.id,
    publicationApprovalId: row.publicationApprovalId,
    objectiveId: row.objectiveId,
    approvedBy: actorFromRow(row.approvedByKind, row.approvedById),
    approvedAt: row.approvedAt,
    status: row.status,
    revision: row.revision,
    withdrawnBy: optionalActorFromRow(row.withdrawnByKind, row.withdrawnById),
    withdrawnAt: row.withdrawnAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function auditFromRow(row: any): ArtifactApprovalAuditEvent {
  return {
    id: row.id,
    approvalType: row.approvalType,
    approvalId: row.approvalId,
    objectiveId: row.objectiveId,
    revision: row.revision,
    action: row.action,
    actor: actorFromRow(row.actorKind, row.actorId),
    createdAt: row.createdAt,
  };
}
