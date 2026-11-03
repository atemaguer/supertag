// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import { randomUUID } from "node:crypto";
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  type AuditEntry,
  type AuditStore,
  type ListAuditEntriesInput,
  type RecordAuditEntryInput,
} from "@supertag/core";
import { and, desc, eq, gte } from "drizzle-orm";

const OUTCOMES = new Set(["succeeded", "failed"]);
const SOURCES = new Set(["api", "gateway"]);

export class DrizzleAuditStore implements AuditStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
  ) {}

  async recordAuditEntry(input: RecordAuditEntryInput): Promise<AuditEntry> {
    if (Number.isNaN(Date.parse(input.at))) throw new Error("Audit entry time is invalid");
    for (const [field, value] of [
      ["actor", input.actor],
      ["action", input.action],
      ["target", input.target],
    ] as const)
      if (!value.trim()) throw new Error(`Audit entry ${field} is required`);
    if (!OUTCOMES.has(input.outcome)) throw new Error("Audit entry outcome is invalid");
    if (!SOURCES.has(input.source)) throw new Error("Audit entry source is invalid");
    const [row] = await this.db
      .insert(this.tables.auditEntries)
      .values({
        id: input.id ?? randomUUID(),
        at: new Date(input.at).toISOString(),
        actor: input.actor,
        action: input.action,
        target: input.target,
        outcome: input.outcome,
        status: input.status ?? null,
        source: input.source,
        method: input.method ?? null,
        path: input.path ?? null,
      })
      .returning();
    return auditEntryFromRow(row);
  }

  async listAuditEntries(input: ListAuditEntriesInput = {}): Promise<readonly AuditEntry[]> {
    const limit = input.limit ?? AUDIT_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT)
      throw new RangeError(`limit must be an integer from 1 through ${AUDIT_MAX_LIMIT}`);
    const table = this.tables.auditEntries;
    const filters = [
      ...(input.since === undefined ? [] : [gte(table.at, new Date(input.since).toISOString())]),
      ...(input.actor === undefined ? [] : [eq(table.actor, input.actor)]),
    ];
    const rows = await this.db
      .select()
      .from(table)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(desc(table.at), desc(table.id))
      .limit(limit);
    return rows.map(auditEntryFromRow);
  }
}

function auditEntryFromRow(row: any): AuditEntry {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    target: row.target,
    outcome: row.outcome,
    ...(row.status == null ? {} : { status: Number(row.status) }),
    source: row.source,
    ...(row.method == null ? {} : { method: row.method }),
    ...(row.path == null ? {} : { path: row.path }),
  };
}
