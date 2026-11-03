// biome-ignore-all lint/suspicious/noExplicitAny: Shared SQLite/PostgreSQL transaction adaptation.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AcquireCapturedArtifactInput,
  ArtifactAcquisition,
  ArtifactCatalogStore,
  ArtifactStorageLocation,
  ArtifactVolumeLocation,
  CapturedArtifact,
  CapturedArtifactFilter,
  CapturedArtifactPage,
  CommitCapturedArtifactInput,
  DatabaseProvider,
  RecordArtifactVolumeCopyInput,
  RegisterWorkerArtifactCopiesInput,
  RegisterWorkerArtifactCopiesResult,
} from "@supertag/core";
import {
  ArtifactCatalogError,
  advertisedWorkerHostLabels,
  artifactVolumeKeyDirectory,
  artifactVolumeLabel,
  MAX_WORKER_ARTIFACT_COPIES,
  parseArtifactSelection,
  validateArtifactPath,
  validateCapturedArtifactInput,
} from "@supertag/core";
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import { selectedEntries } from "./artifact-selection.js";
import { runDialectTransaction } from "./dialect-transaction.js";

type Flow<T> = Generator<any, T, any>;
export class DrizzleArtifactCatalogStore implements ArtifactCatalogStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}
  private transaction<T>(work: (tx: any) => Flow<T>): Promise<T> {
    return runDialectTransaction(this.db, this.provider, work);
  }
  /** Serialize all Attempt-owned writes, including duplicate operations across connections. */
  private *lockAttempt(tx: any, taskId: string, attemptId: string): Flow<any> {
    const a = this.tables.taskAttempts;
    const [attempt] = yield tx
      .update(a)
      .set({ updatedAt: sql`${a.updatedAt}` })
      .where(and(eq(a.id, attemptId), eq(a.taskId, taskId)))
      .returning();
    if (!attempt) throw new ArtifactCatalogError(404, "Task Attempt not found");
    if (attempt.status !== "running")
      throw new ArtifactCatalogError(409, "Task Attempt is no longer running");
    const t = this.tables.tasks;
    const [task] = yield tx.select().from(t).where(eq(t.id, taskId));
    if (!task) throw new ArtifactCatalogError(404, "Task not found");
    return task;
  }
  async recordArtifactUpload(input: {
    attemptId: string;
    taskId: string;
    digest: string;
    sizeBytes: number;
  }): Promise<void> {
    validateUpload(input);
    const self = this;
    return this.transaction(function* (tx) {
      yield* self.lockAttempt(tx, input.taskId, input.attemptId);
      const t = self.tables.artifactUploads;
      const [existing] = yield tx
        .select()
        .from(t)
        .where(and(eq(t.attemptId, input.attemptId), eq(t.digest, input.digest)));
      if (existing) {
        if (existing.taskId !== input.taskId || existing.sizeBytes !== input.sizeBytes)
          throw new ArtifactCatalogError(409, "Artifact upload differs from existing receipt");
        return;
      }
      yield tx
        .insert(t)
        .values({ ...input, createdAt: new Date().toISOString() })
        .returning();
    });
  }
  async hasArtifactUpload(input: {
    attemptId: string;
    digest: string;
    sizeBytes: number;
  }): Promise<boolean> {
    const t = this.tables.artifactUploads;
    const [row] = await this.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.attemptId, input.attemptId),
          eq(t.digest, input.digest),
          eq(t.sizeBytes, input.sizeBytes),
        ),
      )
      .limit(1);
    return !!row;
  }
  async commitCapturedArtifact(input: CommitCapturedArtifactInput): Promise<CapturedArtifact> {
    validateCapturedArtifactInput({ ...input, inputs: [] });
    const definition = captureDefinition(input);
    const self = this;
    return this.transaction(function* (tx) {
      const task = yield* self.lockAttempt(tx, input.taskId, input.attemptId);
      if (task.tagId !== input.tagId || task.sessionId !== input.sessionId)
        throw new ArtifactCatalogError(409, "Artifact producer does not match Task");
      const q = self.tables.taskAssignments;
      const [assignment] = yield tx
        .select({ objectiveId: q.objectiveId })
        .from(q)
        .where(eq(q.taskId, input.taskId));
      if ((assignment?.objectiveId ?? task.surfaceObjectiveId ?? undefined) !== input.objectiveId)
        throw new ArtifactCatalogError(409, "Artifact Objective does not match Task");
      const t = self.tables.capturedArtifacts;
      const [existing] = yield tx
        .select()
        .from(t)
        .where(and(eq(t.attemptId, input.attemptId), eq(t.operationId, input.operationId)));
      if (existing) {
        if (!isDeepStrictEqual(captureDefinition(captureFromRow(existing)), definition))
          throw new ArtifactCatalogError(409, "Artifact operation has a different definition");
        return captureFromRow(existing);
      }
      validateCapturedArtifactInput(input);
      const uploads = self.tables.artifactUploads;
      for (const entry of definition.entries) {
        const [receipt] = yield tx
          .select()
          .from(uploads)
          .where(
            and(
              eq(uploads.attemptId, input.attemptId),
              eq(uploads.digest, entry.digest),
              eq(uploads.sizeBytes, entry.sizeBytes),
            ),
          );
        if (!receipt)
          throw new ArtifactCatalogError(
            409,
            "Artifact content has no verified upload for this Attempt",
          );
      }
      const inputs = (input.inputs ?? []).map(parseArtifactSelection);
      for (const selection of inputs) {
        const [source] = yield tx.select().from(t).where(eq(t.id, selection.artifactId));
        if (!source) throw new ArtifactCatalogError(400, "Input artifact not found");
        selectedEntries(source, selection);
      }
      const [row] = yield tx
        .insert(t)
        .values({
          ...definition,
          inputs,
          id: randomUUID(),
          objectiveId: definition.objectiveId ?? null,
          summary: definition.summary ?? null,
          createdAt: new Date().toISOString(),
        })
        .returning();
      return captureFromRow(row);
    });
  }
  async findCapturedArtifact(id: string): Promise<CapturedArtifact | undefined> {
    const t = this.tables.capturedArtifacts;
    const [row] = await this.db.select().from(t).where(eq(t.id, id));
    return row ? captureFromRow(row) : undefined;
  }
  async listCapturedArtifacts(filter: CapturedArtifactFilter): Promise<CapturedArtifactPage> {
    const t = this.tables.capturedArtifacts;
    const limit = filter.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ArtifactCatalogError(400, "Artifact page limit must be 1 through 100");
    const conditions = [];
    if (filter.source) {
      const source = filter.source,
        task = this.tables.tasks,
        session = this.tables.sessions;
      const pg = this.provider === "postgresql";
      const originField = (name: string) =>
        pg
          ? sql`coalesce(${task.trigger}->'origin', ${task.authorizationSnapshot}->'origin')->>${name}`
          : sql`json_extract(coalesce(json_extract(${task.trigger}, '$.origin'), json_extract(${task.authorizationSnapshot}, '$.origin')), ${`$.${name}`})`;
      const relatedRows = pg
        ? sql`jsonb_array_elements(coalesce(${task.result}->'references', '[]'::jsonb)) as r(value)`
        : sql`json_each(${task.result}, '$.references') as r`;
      const field = (name: string) =>
        pg ? sql`r.value->>${name}` : sql`json_extract(r.value, ${`$.${name}`})`;
      const related = source.relatedTo.length
        ? sql`exists (select 1 from ${relatedRows} where ${or(...source.relatedTo.map((ref) => and(eq(field("provider"), ref.provider), eq(field("resourceType"), ref.resourceType), ref.surfaceAccountId === undefined ? undefined : eq(field("surfaceAccountId"), ref.surfaceAccountId), ref.resourceId === undefined ? eq(field("reference"), ref.reference) : eq(field("resourceId"), ref.resourceId))))})`
        : sql`false`;
      conditions.push(
        sql`exists (select 1 from ${task} inner join ${session} on ${session.id} = ${task.sessionId} where ${and(eq(task.id, t.taskId), eq(task.tagId, source.tagId), eq(originField("tagRouteId"), source.tagRouteId), eq(originField("provider"), source.provider), eq(originField("surfaceAccountId"), source.surfaceAccountId), eq(originField("scope"), source.scope), ne(session.sessionKey, source.excludeSessionKey), gte(task.endedAt, source.completedAfter), related)})`,
      );
    }
    const scope = [];
    if (filter.taskIds !== undefined) scope.push(inArray(t.taskId, [...filter.taskIds]));
    for (const field of ["objectiveId", "sessionId"] as const)
      if (filter[field] !== undefined) scope.push(eq(t[field], filter[field]));
    if (filter.includeArtifactIds !== undefined) {
      // An empty ordinary scope means this request grants only the exact IDs.
      conditions.push(
        or(
          scope.length ? and(...scope) : sql`false`,
          inArray(t.id, [...filter.includeArtifactIds]),
        ),
      );
    } else if (scope.length) conditions.push(and(...scope));
    if (filter.artifactIds !== undefined) conditions.push(inArray(t.id, [...filter.artifactIds]));
    if (filter.taskId !== undefined) conditions.push(eq(t.taskId, filter.taskId));
    if (filter.kind !== undefined) conditions.push(eq(t.kind, filter.kind));
    if (filter.query !== undefined) {
      if (filter.query.length > 512)
        throw new ArtifactCatalogError(400, "Artifact search query is too long");
      const pattern = `%${filter.query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push(
        sql`(lower(${t.title}) like ${pattern} escape '\\' or lower(coalesce(${t.summary}, '')) like ${pattern} escape '\\')`,
      );
    }
    if (filter.cursor) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(filter.cursor);
      } catch {
        throw new ArtifactCatalogError(400, "Invalid artifact cursor");
      }
      if (
        filter.cursor.length > 512 ||
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        cursor.some((v) => typeof v !== "string")
      )
        throw new ArtifactCatalogError(400, "Invalid artifact cursor");
      conditions.push(
        filter.newestFirst
          ? or(lt(t.createdAt, cursor[0]), and(eq(t.createdAt, cursor[0]), lt(t.id, cursor[1])))
          : or(gt(t.createdAt, cursor[0]), and(eq(t.createdAt, cursor[0]), gt(t.id, cursor[1]))),
      );
    }
    const rows = await this.db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(
        filter.newestFirst ? desc(t.createdAt) : asc(t.createdAt),
        filter.newestFirst ? desc(t.id) : asc(t.id),
      )
      .limit(limit + 1);
    const artifacts = rows.slice(0, limit).map(captureFromRow);
    const last = artifacts.at(-1);
    return {
      artifacts,
      ...(rows.length > limit && last
        ? { nextCursor: JSON.stringify([last.createdAt, last.id]) }
        : {}),
    };
  }
  async acquireCapturedArtifact(input: AcquireCapturedArtifactInput): Promise<ArtifactAcquisition> {
    validateAcquisition(input);
    const definition = acquisitionDefinition(input);
    const self = this;
    return this.transaction(function* (tx) {
      yield* self.lockAttempt(tx, input.taskId, input.attemptId);
      const t = self.tables.artifactAcquisitions;
      const [existing] = yield tx
        .select()
        .from(t)
        .where(and(eq(t.attemptId, input.attemptId), eq(t.operationId, input.operationId)));
      if (existing) {
        if (!isDeepStrictEqual(acquisitionDefinition(acquisitionFromRow(existing)), definition))
          throw new ArtifactCatalogError(
            409,
            "Artifact acquisition operation has a different definition",
          );
        return acquisitionFromRow(existing);
      }
      const a = self.tables.capturedArtifacts;
      const [artifact] = yield tx.select().from(a).where(eq(a.id, input.artifactId));
      if (!artifact) throw new ArtifactCatalogError(404, "Artifact not found");
      const paths = new Set(
        (artifact.entries as CapturedArtifact["entries"]).map((entry) => entry.path),
      );
      if (definition.paths.some((path) => !paths.has(path)))
        throw new ArtifactCatalogError(400, "Acquisition selects a missing artifact path");
      const at = new Date().toISOString();
      const [row] = yield tx
        .insert(t)
        .values({
          ...definition,
          destination: definition.destination ?? null,
          id: randomUUID(),
          status: "authorized",
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      return acquisitionFromRow(row);
    });
  }
  async settleArtifactAcquisition(
    input: Parameters<ArtifactCatalogStore["settleArtifactAcquisition"]>[0],
  ): Promise<ArtifactAcquisition> {
    if (!["delivered", "failed", "uncertain"].includes(input.status))
      throw new ArtifactCatalogError(400, "Invalid acquisition settlement status");
    const self = this;
    return this.transaction(function* (tx) {
      const t = self.tables.artifactAcquisitions;
      const [row] = yield tx
        .update(t)
        .set({ updatedAt: sql`${t.updatedAt}` })
        .where(and(eq(t.id, input.id), eq(t.attemptId, input.attemptId)))
        .returning();
      if (!row) throw new ArtifactCatalogError(404, "Artifact acquisition not found");
      if (row.status === input.status) return acquisitionFromRow(row);
      if (row.status === "delivered" || row.status === "failed")
        throw new ArtifactCatalogError(409, "Artifact acquisition is already terminal");
      const [updated] = yield tx
        .update(t)
        .set({ status: input.status, updatedAt: new Date().toISOString() })
        .where(eq(t.id, input.id))
        .returning();
      return acquisitionFromRow(updated);
    });
  }
  async getArtifactAcquisition(id: string): Promise<ArtifactAcquisition | undefined> {
    const t = this.tables.artifactAcquisitions;
    const [row] = await this.db.select().from(t).where(eq(t.id, id));
    return row ? acquisitionFromRow(row) : undefined;
  }
  async listArtifactAcquisitions(input: {
    attemptId: string;
    artifactId?: string;
  }): Promise<readonly ArtifactAcquisition[]> {
    const t = this.tables.artifactAcquisitions;
    const rows = await this.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.attemptId, input.attemptId),
          input.artifactId ? eq(t.artifactId, input.artifactId) : undefined,
        ),
      )
      .orderBy(asc(t.createdAt), asc(t.id));
    return rows.map(acquisitionFromRow);
  }

  async registerWorkerArtifactCopies(
    input: RegisterWorkerArtifactCopiesInput,
  ): Promise<RegisterWorkerArtifactCopiesResult> {
    validateInventory(input);
    const self = this;
    return this.transaction(function* (tx) {
      const hosts = self.tables.workerHosts;
      const [host] = yield tx
        .update(hosts)
        .set({ updatedAt: sql`${hosts.updatedAt}` })
        .where(eq(hosts.id, input.workerHostId))
        .returning();
      if (
        host?.enrollmentStatus !== "active" ||
        host.connectionStatus !== "connected" ||
        host.connectionGeneration !== input.connectionGeneration
      )
        throw new ArtifactCatalogError(409, "Worker Host connection is no longer current");

      const inventories = self.tables.workerArtifactInventories;
      const [current] = yield tx
        .select()
        .from(inventories)
        .where(eq(inventories.workerHostId, input.workerHostId));
      if (
        current &&
        (current.connectionGeneration > input.connectionGeneration ||
          (current.connectionGeneration === input.connectionGeneration &&
            current.inventoryRevision >= input.inventoryRevision))
      )
        return {
          accepted: false,
          connectionGeneration: current.connectionGeneration,
          inventoryRevision: current.inventoryRevision,
        };
      if (
        current?.connectionGeneration === input.connectionGeneration &&
        current.transferBaseUrl !== input.transferBaseUrl
      )
        throw new ArtifactCatalogError(
          409,
          "Worker artifact transfer URL changed within one connection generation",
        );

      yield tx
        .insert(inventories)
        .values({
          workerHostId: input.workerHostId,
          connectionGeneration: input.connectionGeneration,
          inventoryRevision: input.inventoryRevision,
          transferBaseUrl: input.transferBaseUrl,
          observedAt: input.observedAt,
        })
        .onConflictDoUpdate({
          target: inventories.workerHostId,
          set: {
            connectionGeneration: input.connectionGeneration,
            inventoryRevision: input.inventoryRevision,
            transferBaseUrl: input.transferBaseUrl,
            observedAt: input.observedAt,
          },
        })
        .returning();

      const locations = self.tables.artifactStorageLocations;
      if (input.copies.length) {
        const existingCopies = yield tx
          .select({ digest: locations.digest, sizeBytes: locations.sizeBytes })
          .from(locations)
          .where(
            and(
              eq(locations.workerHostId, input.workerHostId),
              inArray(
                locations.digest,
                input.copies.map((copy) => copy.digest),
              ),
            ),
          );
        const sizes = new Map(
          existingCopies.map((copy: { digest: string; sizeBytes: number }) => [
            copy.digest,
            copy.sizeBytes,
          ]),
        );
        if (
          input.copies.some(
            (copy) =>
              sizes.get(copy.digest) !== undefined && sizes.get(copy.digest) !== copy.sizeBytes,
          )
        )
          throw new ArtifactCatalogError(409, "Artifact copy size conflicts with its digest");
      }
      for (const copy of input.copies)
        yield tx
          .insert(locations)
          .values({
            workerHostId: input.workerHostId,
            digest: copy.digest,
            sizeBytes: copy.sizeBytes,
            connectionGeneration: input.connectionGeneration,
            inventoryRevision: input.inventoryRevision,
            transferBaseUrl: input.transferBaseUrl,
            status: "available",
            observedAt: input.observedAt,
            unavailableAt: null,
          })
          .onConflictDoUpdate({
            target: [locations.workerHostId, locations.digest],
            set: {
              sizeBytes: copy.sizeBytes,
              connectionGeneration: input.connectionGeneration,
              inventoryRevision: input.inventoryRevision,
              transferBaseUrl: input.transferBaseUrl,
              status: "available",
              observedAt: input.observedAt,
              unavailableAt: null,
            },
          })
          .returning();
      return {
        accepted: true,
        connectionGeneration: input.connectionGeneration,
        inventoryRevision: input.inventoryRevision,
      };
    });
  }

  async listArtifactStorageLocations(input: {
    digest: string;
    sizeBytes: number;
    status?: ArtifactStorageLocation["status"];
  }): Promise<readonly ArtifactStorageLocation[]> {
    validateCopy(input);
    const locations = this.tables.artifactStorageLocations;
    const hosts = this.tables.workerHosts;
    const rows = await this.db
      .select({ location: locations })
      .from(locations)
      .innerJoin(hosts, eq(hosts.id, locations.workerHostId))
      .where(
        and(
          eq(locations.digest, input.digest),
          eq(locations.sizeBytes, input.sizeBytes),
          ...(input.status ? [eq(locations.status, input.status)] : []),
          ...(input.status === "available"
            ? [
                eq(hosts.enrollmentStatus, "active"),
                eq(hosts.connectionStatus, "connected"),
                eq(hosts.connectionGeneration, locations.connectionGeneration),
              ]
            : []),
        ),
      )
      .orderBy(asc(locations.observedAt), asc(locations.workerHostId));
    return rows.map(({ location }: { location: any }) => locationFromRow(location));
  }

  async recordArtifactVolumeCopy(
    input: RecordArtifactVolumeCopyInput,
  ): Promise<ArtifactVolumeLocation> {
    validateVolumeCopy(input);
    const self = this;
    return this.transaction(function* (tx) {
      const hosts = self.tables.workerHosts;
      const [host] = yield tx.select().from(hosts).where(eq(hosts.id, input.workerHostId));
      if (host?.enrollmentStatus !== "active")
        throw new ArtifactCatalogError(409, "Worker Host is not enrolled");
      // Lock the Volume row so concurrent records of one Volume's keys apply one at a time.
      const volumes = self.tables.volumes;
      const [volume] = yield tx
        .update(volumes)
        .set({ updatedAt: sql`${volumes.updatedAt}` })
        .where(eq(volumes.id, input.volumeId))
        .returning();
      if (!volume) throw new ArtifactCatalogError(404, "Volume not found");
      if (volume.source !== input.source)
        throw new ArtifactCatalogError(
          409,
          `Artifact Volume ${volume.name} source changed; refresh the Volume and write the copy again`,
        );
      // Only a host that stores its artifacts on this Volume writes copies there.
      if (
        !advertisedWorkerHostLabels(
          (host.workerSnapshot ?? {}) as Record<string, unknown>,
        ).includes(artifactVolumeLabel(volume.name))
      )
        throw new ArtifactCatalogError(
          403,
          `Worker Host ${host.id} does not store artifacts on Volume ${volume.name}`,
        );
      // A host's Volume label is only a reachability claim. Bind this key to its actual
      // producing Attempt before accepting a receipt, even when the digest already exists.
      const attempts = self.tables.taskAttempts;
      const attemptId = input.key.split("/")[1];
      const [attempt] = yield tx.select().from(attempts).where(eq(attempts.id, attemptId));
      if (!attempt || attempt.workerSnapshot?.workerHostId !== input.workerHostId)
        throw new ArtifactCatalogError(
          403,
          "Artifact Volume key does not belong to this host's Task Attempt",
        );
      if (attempt.status !== "running")
        throw new ArtifactCatalogError(409, "Task Attempt is no longer running");
      const copies = self.tables.artifactVolumeCopies;
      // A case-insensitive Volume, such as a default macOS disk, stores these keys as one file.
      const [variant] = yield tx
        .select({ key: copies.key })
        .from(copies)
        .where(
          and(
            eq(copies.volumeId, input.volumeId),
            sql`lower(${copies.key}) = lower(${input.key})`,
            ne(copies.key, input.key),
          ),
        )
        .limit(1);
      if (variant)
        throw new ArtifactCatalogError(
          409,
          "Volume artifact key differs only by case from an existing key",
        );
      // The Volume lock also serializes records from different holders. A key must name
      // the same immutable content for every host, including hosts no longer enrolled.
      const [conflict] = yield tx
        .select({ key: copies.key })
        .from(copies)
        .where(
          and(
            eq(copies.volumeId, input.volumeId),
            eq(copies.key, input.key),
            or(ne(copies.digest, input.digest), ne(copies.sizeBytes, input.sizeBytes)),
          ),
        )
        .limit(1);
      if (conflict)
        throw new ArtifactCatalogError(409, "Volume artifact key already holds other content");
      // Each Attempt key has one producing host; retries can refresh only that record.
      const [row] = yield tx
        .insert(copies)
        .values({
          volumeId: input.volumeId,
          key: input.key,
          digest: input.digest,
          sizeBytes: input.sizeBytes,
          workerHostId: input.workerHostId,
          status: "available",
          observedAt: input.observedAt,
          unavailableAt: null,
        })
        .onConflictDoUpdate({
          target: [copies.volumeId, copies.key],
          set: { status: "available", observedAt: input.observedAt, unavailableAt: null },
          setWhere: and(
            eq(copies.digest, input.digest),
            eq(copies.sizeBytes, input.sizeBytes),
            eq(copies.workerHostId, input.workerHostId),
          ),
        })
        .returning();
      if (!row)
        throw new ArtifactCatalogError(409, "Volume artifact key already holds other content");
      return volumeLocationFromRow(row);
    });
  }

  async listArtifactVolumeLocations(input: {
    digest: string;
    sizeBytes: number;
    status?: ArtifactVolumeLocation["status"];
  }): Promise<readonly ArtifactVolumeLocation[]> {
    validateCopy(input);
    const copies = this.tables.artifactVolumeCopies;
    const rows = await this.db
      .select()
      .from(copies)
      .where(
        and(
          eq(copies.digest, input.digest),
          eq(copies.sizeBytes, input.sizeBytes),
          ...(input.status ? [eq(copies.status, input.status)] : []),
        ),
      )
      .orderBy(asc(copies.observedAt), asc(copies.volumeId), asc(copies.key));
    return rows.map(volumeLocationFromRow);
  }

  async listVolumeIdsHoldingArtifacts(): Promise<readonly string[]> {
    const copies = this.tables.artifactVolumeCopies;
    const rows = await this.db
      .selectDistinct({ volumeId: copies.volumeId })
      .from(copies)
      .orderBy(asc(copies.volumeId));
    return rows.map((row: { volumeId: string }) => row.volumeId);
  }
}
function captureDefinition(input: CommitCapturedArtifactInput): CommitCapturedArtifactInput {
  return {
    operationId: input.operationId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    tagId: input.tagId,
    sessionId: input.sessionId,
    ...(input.harnessSession
      ? {
          harnessSession: {
            harnessId: input.harnessSession.harnessId,
            id: input.harnessSession.id,
          },
        }
      : {}),
    ...(input.objectiveId ? { objectiveId: input.objectiveId } : {}),
    title: input.title,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    kind: input.kind,
    entries: input.entries
      .map((entry) => ({
        path: entry.path,
        uri: entry.uri,
        digest: entry.digest,
        sizeBytes: entry.sizeBytes,
        ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}
function captureFromRow(row: any): CapturedArtifact {
  return {
    ...captureDefinition({
      ...row,
      objectiveId: row.objectiveId ?? undefined,
      summary: row.summary ?? undefined,
    }),
    inputs: row.inputs ?? [],
    id: row.id,
    createdAt: row.createdAt,
  };
}
function acquisitionDefinition(input: AcquireCapturedArtifactInput): AcquireCapturedArtifactInput {
  return {
    operationId: input.operationId,
    artifactId: input.artifactId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    paths: [...input.paths].sort(),
    delivery: input.delivery,
    ...(input.destination ? { destination: input.destination } : {}),
  };
}
function acquisitionFromRow(row: any): ArtifactAcquisition {
  return {
    ...acquisitionDefinition(row),
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function validateAcquisition(input: AcquireCapturedArtifactInput): void {
  for (const value of [input.operationId, input.artifactId, input.taskId, input.attemptId])
    if (typeof value !== "string" || !value.trim() || value.length > 512)
      throw new ArtifactCatalogError(400, "Invalid acquisition identity");
  if (
    !Array.isArray(input.paths) ||
    !input.paths.length ||
    input.paths.length > 100 ||
    new Set(input.paths).size !== input.paths.length
  )
    throw new ArtifactCatalogError(400, "Acquisition requires 1 through 100 unique paths");
  for (const path of input.paths) validateArtifactPath(path);
  if (input.delivery !== "read" && input.delivery !== "materialize")
    throw new ArtifactCatalogError(400, "Invalid artifact delivery method");
  if (input.delivery === "read" && input.destination !== undefined)
    throw new ArtifactCatalogError(400, "Read acquisition cannot specify a destination");
  if (
    input.delivery === "materialize" &&
    (typeof input.destination !== "string" ||
      !input.destination.trim() ||
      input.destination.length > 1024 ||
      [...input.destination].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    throw new ArtifactCatalogError(400, "Materialization requires a destination");
}
function validateUpload(input: { digest: string; sizeBytes: number }): void {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(input.digest) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 0
  )
    throw new ArtifactCatalogError(400, "Invalid artifact upload receipt");
}

function validateInventory(input: RegisterWorkerArtifactCopiesInput): void {
  if (
    typeof input.workerHostId !== "string" ||
    !input.workerHostId.trim() ||
    input.workerHostId.length > 512 ||
    !Number.isSafeInteger(input.connectionGeneration) ||
    input.connectionGeneration < 1 ||
    !Number.isSafeInteger(input.inventoryRevision) ||
    input.inventoryRevision < 1 ||
    !validInstant(input.observedAt) ||
    !Array.isArray(input.copies) ||
    input.copies.length > MAX_WORKER_ARTIFACT_COPIES
  )
    throw new ArtifactCatalogError(400, "Invalid Worker artifact inventory");
  validateTransferBaseUrl(input.transferBaseUrl);
  const digests = new Set<string>();
  for (const copy of input.copies) {
    validateCopy(copy);
    if (digests.has(copy.digest))
      throw new ArtifactCatalogError(400, "Worker artifact inventory contains duplicate copies");
    digests.add(copy.digest);
  }
}

function validateVolumeCopy(input: RecordArtifactVolumeCopyInput): void {
  if (
    typeof input.volumeId !== "string" ||
    !input.volumeId.trim() ||
    input.volumeId.length > 512 ||
    typeof input.workerHostId !== "string" ||
    !input.workerHostId.trim() ||
    input.workerHostId.length > 512 ||
    !validInstant(input.observedAt) ||
    !validVolumeKey(input.key)
  )
    throw new ArtifactCatalogError(400, "Invalid Volume artifact copy");
  validateCopy(input);
  // A key names one file's content, so a reader granted that file reads nothing else there.
  try {
    artifactVolumeKeyDirectory(input.key, input.digest);
  } catch {
    throw new ArtifactCatalogError(400, "Volume artifact key does not name this copy's content");
  }
}

/** A relative key of plain segments: no traversal, no absolute or empty segments. */
function validVolumeKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= 1024 &&
    /^[A-Za-z0-9._:=-]+(\/[A-Za-z0-9._:=-]+)*$/u.test(key) &&
    key.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}

function validateCopy(input: { digest: string; sizeBytes: number }): void {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(input.digest) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 0
  )
    throw new ArtifactCatalogError(400, "Invalid Worker artifact copy");
}

function validateTransferBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ArtifactCatalogError(400, "Invalid Worker artifact transfer URL");
  }
  if (
    value.length > 2048 ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new ArtifactCatalogError(400, "Invalid Worker artifact transfer URL");
}

function validInstant(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function locationFromRow(row: any): ArtifactStorageLocation {
  return {
    workerHostId: row.workerHostId,
    connectionGeneration: row.connectionGeneration,
    inventoryRevision: row.inventoryRevision,
    transferBaseUrl: row.transferBaseUrl,
    digest: row.digest,
    sizeBytes: row.sizeBytes,
    status: row.status,
    observedAt: row.observedAt,
    ...(row.unavailableAt ? { unavailableAt: row.unavailableAt } : {}),
  };
}

function volumeLocationFromRow(row: any): ArtifactVolumeLocation {
  return {
    volumeId: row.volumeId,
    key: row.key,
    digest: row.digest,
    sizeBytes: row.sizeBytes,
    ...(row.workerHostId ? { workerHostId: row.workerHostId } : {}),
    status: row.status,
    observedAt: row.observedAt,
    ...(row.unavailableAt ? { unavailableAt: row.unavailableAt } : {}),
  };
}
