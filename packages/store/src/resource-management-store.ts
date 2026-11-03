// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import {
  type DatabaseProvider,
  MANAGED_RESOURCE_KINDS,
  type ManagedFields,
  type ManagedResourceKind,
  parseApplySetName,
  type ResourceManagement,
  type ResourceManagementStore,
  type SaveResourceManagementInput,
} from "@supertag/core";
import { and, asc, eq } from "drizzle-orm";

export class DrizzleResourceManagementStore implements ResourceManagementStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    readonly provider: DatabaseProvider,
  ) {}

  async findResourceManagement(
    kind: ManagedResourceKind,
    name: string,
  ): Promise<ResourceManagement | undefined> {
    const table = this.tables.resourceManagement;
    const [row] = await this.db
      .select()
      .from(table)
      .where(and(eq(table.kind, managedKind(kind)), eq(table.name, name)))
      .limit(1);
    return row ? resourceManagementFromRow(row) : undefined;
  }

  async saveResourceManagement(input: SaveResourceManagementInput): Promise<ResourceManagement> {
    const table = this.tables.resourceManagement;
    const kind = managedKind(input.kind);
    if (!input.name.trim()) throw new Error("Managed resource name is required");
    const applySet = input.applySet === undefined ? undefined : parseApplySetName(input.applySet);
    const fields = managedFields(input.fields);
    const updatedAt = new Date().toISOString();
    const [row] = await this.db
      .insert(table)
      .values({ kind, name: input.name, applySet: applySet ?? null, fields, updatedAt })
      .onConflictDoUpdate({
        target: [table.kind, table.name],
        set: { fields, updatedAt, ...(applySet === undefined ? {} : { applySet }) },
      })
      .returning();
    return resourceManagementFromRow(row);
  }

  async deleteResourceManagement(kind: ManagedResourceKind, name: string): Promise<boolean> {
    const table = this.tables.resourceManagement;
    const rows = await this.db
      .delete(table)
      .where(and(eq(table.kind, managedKind(kind)), eq(table.name, name)))
      .returning();
    return rows.length > 0;
  }

  async listApplySetMembers(applySet: string): Promise<readonly ResourceManagement[]> {
    const table = this.tables.resourceManagement;
    const rows = await this.db
      .select()
      .from(table)
      .where(eq(table.applySet, parseApplySetName(applySet)))
      .orderBy(asc(table.kind), asc(table.name));
    return rows.map(resourceManagementFromRow);
  }
}

function managedKind(kind: string): ManagedResourceKind {
  if (!(MANAGED_RESOURCE_KINDS as readonly string[]).includes(kind))
    throw new Error(`${kind} is not a managed resource kind`);
  return kind as ManagedResourceKind;
}

function managedFields(value: ManagedFields): ManagedFields {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Managed fields must be an object");
  for (const [path, entry] of Object.entries(value)) {
    if (!path.startsWith("spec.")) throw new Error(`Managed field ${path} must start with spec.`);
    if (typeof entry !== "object" || entry === null || !("value" in entry))
      throw new Error(`Managed field ${path} must record a value`);
    if (entry.manager !== undefined && (typeof entry.manager !== "string" || !entry.manager))
      throw new Error(`Managed field ${path} has an invalid manager`);
  }
  return value;
}

function resourceManagementFromRow(row: any): ResourceManagement {
  const fields = typeof row.fields === "string" ? JSON.parse(row.fields) : row.fields;
  return {
    kind: managedKind(row.kind),
    name: row.name,
    ...(row.applySet == null ? {} : { applySet: row.applySet }),
    fields: fields ?? {},
    updatedAt: row.updatedAt,
  };
}
