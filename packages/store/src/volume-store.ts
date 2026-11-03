// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import { randomUUID } from "node:crypto";
import {
  type ApplyVolumeInput,
  type DatabaseProvider,
  parseVolumeName,
  parseVolumeSpec,
  TagMessagingError,
  type Volume,
  type VolumeStore,
  volumeArtifactCopyRefusal,
} from "@supertag/core";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";

type Flow<T> = Generator<any, T, any>;

export class DrizzleVolumeStore implements VolumeStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  async applyVolume(
    input: ApplyVolumeInput,
  ): Promise<{ readonly volume: Volume; readonly created: boolean }> {
    const name = parseVolumeName(input.name);
    const { name: _name, ...rest } = input;
    const spec = parseVolumeSpec(rest);
    const table = this.tables.volumes;
    const copies = this.tables.artifactVolumeCopies;
    const hosts = this.tables.workerHosts;
    return runDialectTransaction(this.db, this.provider, function* (tx: any): Flow<{
      readonly volume: Volume;
      readonly created: boolean;
    }> {
      const at = new Date().toISOString();
      // Share the row lock used by recordArtifactVolumeCopy before checking its records.
      const [existing] = yield tx
        .update(table)
        .set({ updatedAt: sql`${table.updatedAt}` })
        .where(eq(table.name, name))
        .returning();
      const fields = { source: spec.source, credential: spec.credential ?? null };
      if (existing) {
        if (existing.source === fields.source && existing.credential === fields.credential)
          return { volume: volumeFromRow(existing), created: false };
        if (existing.source !== fields.source)
          yield* assertNoArtifactCopies(tx, copies, hosts, existing, "change the source of");
        const [row] = yield tx
          .update(table)
          .set({ ...fields, revision: existing.revision + 1, updatedAt: at })
          .where(eq(table.id, existing.id))
          .returning();
        return { volume: volumeFromRow(row), created: false };
      }
      const [row] = yield tx
        .insert(table)
        .values({ id: randomUUID(), name, ...fields, revision: 1, createdAt: at, updatedAt: at })
        .returning();
      return { volume: volumeFromRow(row), created: true };
    });
  }

  async findVolumeByName(name: string): Promise<Volume | undefined> {
    const table = this.tables.volumes;
    const [row] = await this.db.select().from(table).where(eq(table.name, name)).limit(1);
    return row ? volumeFromRow(row) : undefined;
  }

  async listVolumes(): Promise<readonly Volume[]> {
    const table = this.tables.volumes;
    const rows = await this.db.select().from(table).orderBy(asc(table.name));
    return rows.map(volumeFromRow);
  }

  async deleteVolume(name: string): Promise<boolean> {
    const table = this.tables.volumes;
    const copies = this.tables.artifactVolumeCopies;
    const hosts = this.tables.workerHosts;
    return runDialectTransaction(this.db, this.provider, function* (tx: any): Flow<boolean> {
      const [existing] = yield tx
        .update(table)
        .set({ updatedAt: sql`${table.updatedAt}` })
        .where(eq(table.name, name))
        .returning();
      if (!existing) return false;
      yield* assertNoArtifactCopies(tx, copies, hosts, existing, "delete");
      yield tx.delete(table).where(eq(table.id, existing.id)).returning();
      return true;
    });
  }

  async countVolumeArtifactCopies(volumeId: string): Promise<number> {
    const [row] = await artifactCopyCount(
      this.db,
      this.tables.artifactVolumeCopies,
      this.tables.workerHosts,
      volumeId,
    );
    return Number(row.total);
  }
}

function artifactCopyCount(db: any, copies: any, hosts: any, volumeId: string) {
  return db
    .select({ total: count() })
    .from(copies)
    .innerJoin(hosts, eq(hosts.id, copies.workerHostId))
    .where(and(eq(copies.volumeId, volumeId), eq(hosts.enrollmentStatus, "active")));
}

function* assertNoArtifactCopies(
  tx: any,
  copies: any,
  hosts: any,
  volume: any,
  action: string,
): Flow<void> {
  const [row] = yield artifactCopyCount(tx, copies, hosts, volume.id);
  const refusal = volumeArtifactCopyRefusal(Number(row.total));
  if (refusal !== undefined)
    throw new TagMessagingError(409, `Cannot ${action} Volume ${volume.name}: ${refusal}`);
}

function volumeFromRow(row: any): Volume {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    ...(row.credential == null ? {} : { credential: row.credential }),
    revision: Number(row.revision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
