// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import {
  type ClaimWorkerHostConnectionInput,
  type DatabaseProvider,
  type EnrollWorkerHostInput,
  effectiveWorkerHostLabels,
  type ReleaseWorkerHostConnectionInput,
  type RevokeWorkerHostInput,
  type RotateWorkerHostCredentialInput,
  type UpdateWorkerHostObservationInput,
  type WorkerHost,
  type WorkerHostObservation,
  type WorkerHostStore,
} from "@supertag/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";

type Flow<T> = Generator<any, T, any>;
interface ObservationValues {
  readonly workletId: string;
  readonly protocolVersion: number;
  readonly durableProtocolVersion: number | null;
  readonly controlProtocolVersion: number | null;
  readonly workerSnapshot: Readonly<Record<string, unknown>>;
  readonly capacity: number;
  readonly availableSlots: number;
  readonly activeAttempts: number;
  readonly ready: boolean;
  readonly lastSeenAt: string;
}

export class DrizzleWorkerHostStore implements WorkerHostStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  private transaction<T>(work: (tx: any) => Flow<T>): Promise<T> {
    return runDialectTransaction(this.db, this.provider, work);
  }

  enrollWorkerHost(input: EnrollWorkerHostInput): Promise<WorkerHost> {
    const workerHostId = required(input.id, "Worker Host id");
    const credentialId = required(input.credentialId, "Worker Host credential id");
    const enrolledAt = timestamp(input.enrolledAt, "Worker Host enrollment time");
    const table = this.tables.workerHosts;
    const credentials = this.tables.workerHostCredentials;
    return this.transaction(function* (tx) {
      const [created] = yield tx
        .insert(table)
        .values(newWorkerHostRow({ id: workerHostId, credentialId, enrolledAt }))
        .onConflictDoNothing({ target: table.id })
        .returning();
      if (created) {
        yield tx
          .insert(credentials)
          .values(firstCredentialRow(workerHostId, credentialId, enrolledAt))
          .returning();
        return workerHostFromRow(created);
      }
      const [existing] = yield tx.select().from(table).where(eq(table.id, workerHostId)).limit(1);
      if (!existing || existing.credentialId !== credentialId)
        throw new Error(`Worker Host ${workerHostId} is already enrolled`);
      return workerHostFromRow(existing);
    });
  }

  async findWorkerHostById(id: string): Promise<WorkerHost | undefined> {
    const table = this.tables.workerHosts;
    const [row] = await this.db
      .select()
      .from(table)
      .where(eq(table.id, required(id, "Worker Host id")))
      .limit(1);
    return row ? workerHostFromRow(row) : undefined;
  }

  async listWorkerHosts(): Promise<readonly WorkerHost[]> {
    const table = this.tables.workerHosts;
    return (await this.db.select().from(table).orderBy(asc(table.createdAt), asc(table.id))).map(
      workerHostFromRow,
    );
  }

  rotateWorkerHostCredential(
    input: RotateWorkerHostCredentialInput,
  ): Promise<WorkerHost | undefined> {
    const workerHostId = required(input.workerHostId, "Worker Host id");
    const credentialId = required(input.credentialId, "Worker Host credential id");
    const expectedRevision = positiveInteger(
      input.expectedCredentialRevision,
      "Worker Host credential revision",
    );
    const rotatedAt = timestamp(input.rotatedAt, "Worker Host credential rotation time");
    const table = this.tables.workerHosts;
    const credentials = this.tables.workerHostCredentials;
    return this.transaction(function* (tx) {
      const nextRevision = expectedRevision + 1;
      const [row] = yield tx
        .update(table)
        .set({
          credentialId,
          credentialRevision: nextRevision,
          connectionGeneration: sql`${table.connectionGeneration} + 1`,
          connectionStatus: "disconnected",
          ready: false,
          availableSlots: 0,
          disconnectedAt: rotatedAt,
          updatedAt: rotatedAt,
        })
        .where(
          and(
            eq(table.id, workerHostId),
            eq(table.enrollmentStatus, "active"),
            eq(table.credentialRevision, expectedRevision),
          ),
        )
        .returning();
      if (!row) return undefined;
      yield tx
        .insert(credentials)
        .values({
          workerHostId,
          revision: nextRevision,
          credentialId,
          status: "active",
          createdAt: rotatedAt,
          retiredAt: null,
        })
        .returning();
      yield tx
        .update(credentials)
        .set({ status: "retired", retiredAt: rotatedAt })
        .where(
          and(
            eq(credentials.workerHostId, workerHostId),
            eq(credentials.revision, expectedRevision),
            eq(credentials.status, "active"),
          ),
        )
        .returning();
      return workerHostFromRow(row);
    });
  }

  revokeWorkerHost(input: RevokeWorkerHostInput): Promise<WorkerHost | undefined> {
    const workerHostId = required(input.workerHostId, "Worker Host id");
    const revokedAt = timestamp(input.revokedAt, "Worker Host revocation time");
    const reason = optional(input.reason);
    const table = this.tables.workerHosts;
    const credentials = this.tables.workerHostCredentials;
    return this.transaction(function* (tx) {
      const [revoked] = yield tx
        .update(table)
        .set({
          enrollmentStatus: "revoked",
          connectionGeneration: sql`${table.connectionGeneration} + 1`,
          connectionStatus: "disconnected",
          ready: false,
          draining: true,
          availableSlots: 0,
          disconnectedAt: revokedAt,
          revokedAt,
          revocationReason: reason ?? null,
          updatedAt: revokedAt,
        })
        .where(and(eq(table.id, workerHostId), eq(table.enrollmentStatus, "active")))
        .returning();
      if (revoked) {
        yield tx
          .update(credentials)
          .set({ status: "retired", retiredAt: revokedAt })
          .where(
            and(
              eq(credentials.workerHostId, workerHostId),
              eq(credentials.revision, revoked.credentialRevision),
              eq(credentials.status, "active"),
            ),
          )
          .returning();
        return workerHostFromRow(revoked);
      }
      const [existing] = yield tx.select().from(table).where(eq(table.id, workerHostId)).limit(1);
      return existing ? workerHostFromRow(existing) : undefined;
    });
  }

  async setWorkerHostDraining(
    workerHostIdValue: string,
    draining: boolean,
    updatedAtValue: string,
  ): Promise<WorkerHost | undefined> {
    const workerHostId = required(workerHostIdValue, "Worker Host id");
    const updatedAt = timestamp(updatedAtValue, "Worker Host drain update time");
    const table = this.tables.workerHosts;
    const availability = sql`CASE
      WHEN ${table.connectionStatus} <> 'connected' THEN 0
      WHEN ${table.capacity} > ${table.activeAttempts}
        THEN ${table.capacity} - ${table.activeAttempts}
      ELSE 0
    END`;
    const [row] = await this.db
      .update(table)
      .set(
        draining
          ? { draining: true, ready: false, availableSlots: 0, updatedAt }
          : {
              draining: false,
              ready: sql`(${table.connectionStatus} = 'connected' AND ${table.capacity} > ${table.activeAttempts})`,
              availableSlots: availability,
              updatedAt,
            },
      )
      .where(and(eq(table.id, workerHostId), eq(table.enrollmentStatus, "active")))
      .returning();
    return row ? workerHostFromRow(row) : undefined;
  }

  claimWorkerHostConnection(
    input: ClaimWorkerHostConnectionInput,
  ): Promise<WorkerHost | undefined> {
    const workerHostId = required(input.workerHostId, "Worker Host id");
    const credentialRevision = positiveInteger(
      input.credentialRevision,
      "Worker Host credential revision",
    );
    const observation = observationValues(input);
    const table = this.tables.workerHosts;
    return this.transaction(function* (tx) {
      const observedReady = sql.raw(observation.ready ? "true" : "false");
      const [row] = yield tx
        .update(table)
        .set({
          ...observation,
          draining: sql`${table.draining}`,
          ready: sql`(NOT ${table.draining} AND ${observedReady})`,
          availableSlots: sql`CASE WHEN ${table.draining} THEN 0 ELSE ${observation.availableSlots} END`,
          connectionGeneration: sql`${table.connectionGeneration} + 1`,
          connectionStatus: "connected",
          lastAuthenticatedAt: observation.lastSeenAt,
          connectedAt: observation.lastSeenAt,
          disconnectedAt: null,
          updatedAt: observation.lastSeenAt,
        })
        .where(
          and(
            eq(table.id, workerHostId),
            eq(table.enrollmentStatus, "active"),
            eq(table.credentialRevision, credentialRevision),
          ),
        )
        .returning();
      return row ? workerHostFromRow(row) : undefined;
    });
  }

  async recordWorkerHostAuthenticationFailure(
    workerHostIdValue: string,
    failedAtValue: string,
  ): Promise<boolean> {
    const workerHostId = required(workerHostIdValue, "Worker Host id");
    const failedAt = timestamp(failedAtValue, "Worker Host authentication failure time");
    const table = this.tables.workerHosts;
    const rows = await this.db
      .update(table)
      .set({
        failedAuthenticationCount: sql`${table.failedAuthenticationCount} + 1`,
        lastAuthenticationFailureAt: failedAt,
        updatedAt: failedAt,
      })
      .where(and(eq(table.id, workerHostId), eq(table.enrollmentStatus, "active")))
      .returning({ id: table.id });
    return rows.length === 1;
  }

  async updateWorkerHostObservation(
    input: UpdateWorkerHostObservationInput,
  ): Promise<{ readonly draining: boolean } | undefined> {
    const workerHostId = required(input.workerHostId, "Worker Host id");
    const connectionGeneration = nonNegativeInteger(
      input.connectionGeneration,
      "Worker Host connection generation",
    );
    const observation = observationValues(input);
    const table = this.tables.workerHosts;
    const observedReady = sql.raw(observation.ready ? "true" : "false");
    const rows = await this.db
      .update(table)
      .set({
        ...observation,
        draining: sql`${table.draining}`,
        ready: sql`(NOT ${table.draining} AND ${observedReady})`,
        availableSlots: sql`CASE WHEN ${table.draining} THEN 0 ELSE ${observation.availableSlots} END`,
        updatedAt: observation.lastSeenAt,
      })
      .where(
        and(
          eq(table.id, workerHostId),
          eq(table.enrollmentStatus, "active"),
          eq(table.connectionStatus, "connected"),
          eq(table.connectionGeneration, connectionGeneration),
        ),
      )
      .returning({ draining: table.draining });
    return rows[0];
  }

  async releaseWorkerHostConnection(input: ReleaseWorkerHostConnectionInput): Promise<boolean> {
    const workerHostId = required(input.workerHostId, "Worker Host id");
    const connectionGeneration = nonNegativeInteger(
      input.connectionGeneration,
      "Worker Host connection generation",
    );
    const disconnectedAt = timestamp(input.disconnectedAt, "Worker Host disconnection time");
    const table = this.tables.workerHosts;
    const rows = await this.db
      .update(table)
      .set({
        connectionStatus: "disconnected",
        ready: false,
        availableSlots: 0,
        disconnectedAt,
        updatedAt: disconnectedAt,
      })
      .where(
        and(
          eq(table.id, workerHostId),
          eq(table.enrollmentStatus, "active"),
          eq(table.connectionStatus, "connected"),
          eq(table.connectionGeneration, connectionGeneration),
        ),
      )
      .returning({ id: table.id });
    return rows.length === 1;
  }
}

function observationValues(input: WorkerHostObservation): ObservationValues {
  const capacity = nonNegativeInteger(input.capacity, "Worker Host capacity");
  const availableSlots = nonNegativeInteger(input.availableSlots, "Worker Host available slots");
  if (availableSlots > capacity)
    throw new Error("Worker Host available slots must not exceed capacity");
  return {
    workletId: required(input.workletId, "Worklet id"),
    protocolVersion: positiveInteger(input.protocolVersion, "Worklet protocol version"),
    durableProtocolVersion: optionalPositiveInteger(
      input.durableProtocolVersion,
      "Worklet durable protocol version",
    ),
    controlProtocolVersion: optionalPositiveInteger(
      input.controlProtocolVersion,
      "Worklet control protocol version",
    ),
    workerSnapshot: record(input.workerSnapshot, "Worker Host Worker snapshot"),
    capacity,
    availableSlots,
    activeAttempts: nonNegativeInteger(input.activeAttempts, "Worker Host active Attempts"),
    ready: input.ready,
    lastSeenAt: timestamp(input.observedAt, "Worker Host observation time"),
  };
}

/** Column values for a newly enrolled, disconnected Worker Host. */
export function newWorkerHostRow(input: {
  readonly id: string;
  readonly credentialId: string;
  readonly enrolledAt: string;
  readonly ephemeral?: boolean;
  readonly authKey?: string;
  readonly grantedLabels?: readonly string[];
}): Record<string, unknown> {
  return {
    id: input.id,
    credentialId: input.credentialId,
    credentialRevision: 1,
    enrollmentStatus: "active",
    ephemeral: input.ephemeral ?? false,
    authKey: input.authKey ?? null,
    connectionGeneration: 0,
    connectionStatus: "disconnected",
    workletId: null,
    protocolVersion: null,
    durableProtocolVersion: null,
    controlProtocolVersion: null,
    workerSnapshot: {},
    grantedLabels: [...(input.grantedLabels ?? [])],
    capacity: 0,
    availableSlots: 0,
    activeAttempts: 0,
    ready: false,
    draining: false,
    lastAuthenticatedAt: null,
    failedAuthenticationCount: 0,
    lastAuthenticationFailureAt: null,
    lastSeenAt: null,
    connectedAt: null,
    disconnectedAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: input.enrolledAt,
    updatedAt: input.enrolledAt,
  };
}

/** Credential history row for a host's first credential revision. */
export function firstCredentialRow(
  workerHostId: string,
  credentialId: string,
  createdAt: string,
): Record<string, unknown> {
  return { workerHostId, revision: 1, credentialId, status: "active", createdAt, retiredAt: null };
}

export function workerHostFromRow(row: any): WorkerHost {
  if (row.enrollmentStatus !== "active" && row.enrollmentStatus !== "revoked")
    throw new Error(`Unsupported Worker Host enrollment status: ${row.enrollmentStatus}`);
  if (row.connectionStatus !== "connected" && row.connectionStatus !== "disconnected")
    throw new Error(`Unsupported Worker Host connection status: ${row.connectionStatus}`);
  const snapshot = record(row.workerSnapshot, "Worker Host Worker snapshot");
  const grantedLabels = storedLabels(row.grantedLabels);
  return {
    id: required(row.id, "Worker Host id"),
    credentialId: required(row.credentialId, "Worker Host credential id"),
    credentialRevision: positiveInteger(row.credentialRevision, "Worker Host credential revision"),
    enrollmentStatus: row.enrollmentStatus,
    ephemeral: Boolean(row.ephemeral),
    ...(row.authKey == null ? {} : { authKey: row.authKey }),
    connectionGeneration: nonNegativeInteger(
      row.connectionGeneration,
      "Worker Host connection generation",
    ),
    connectionStatus: row.connectionStatus,
    ...(row.workletId === null ? {} : { workletId: required(row.workletId, "Worklet id") }),
    ...(row.protocolVersion === null
      ? {}
      : { protocolVersion: positiveInteger(row.protocolVersion, "Worklet protocol version") }),
    ...(row.durableProtocolVersion === null
      ? {}
      : {
          durableProtocolVersion: positiveInteger(
            row.durableProtocolVersion,
            "Worklet durable protocol version",
          ),
        }),
    ...(row.controlProtocolVersion === null
      ? {}
      : {
          controlProtocolVersion: positiveInteger(
            row.controlProtocolVersion,
            "Worklet control protocol version",
          ),
        }),
    workerSnapshot: snapshot,
    labels: effectiveWorkerHostLabels(snapshot, grantedLabels),
    grantedLabels,
    capacity: nonNegativeInteger(row.capacity, "Worker Host capacity"),
    availableSlots: nonNegativeInteger(row.availableSlots, "Worker Host available slots"),
    activeAttempts: nonNegativeInteger(row.activeAttempts, "Worker Host active Attempts"),
    ready: row.ready,
    draining: row.draining,
    ...(row.lastAuthenticatedAt === null ? {} : { lastAuthenticatedAt: row.lastAuthenticatedAt }),
    failedAuthenticationCount: nonNegativeInteger(
      row.failedAuthenticationCount,
      "Worker Host failed authentication count",
    ),
    ...(row.lastAuthenticationFailureAt === null
      ? {}
      : { lastAuthenticationFailureAt: row.lastAuthenticationFailureAt }),
    ...(row.lastSeenAt === null ? {} : { lastSeenAt: row.lastSeenAt }),
    ...(row.connectedAt === null ? {} : { connectedAt: row.connectedAt }),
    ...(row.disconnectedAt === null ? {} : { disconnectedAt: row.disconnectedAt }),
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
    ...(row.revocationReason === null ? {} : { revocationReason: row.revocationReason }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A persisted label list; rows written before labels existed read as empty. */
export function storedLabels(value: unknown): readonly string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed == null) return [];
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
    throw new Error("Persisted labels are invalid");
  return parsed;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  return normalized;
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function timestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | null {
  return value === undefined ? null : positiveInteger(value, label);
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function record(value: object, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}
