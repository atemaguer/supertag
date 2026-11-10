// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import { randomUUID } from "node:crypto";
import type { DatabaseProvider } from "@supertag/core";
import { and, asc, eq, gt, max } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";
import {
  parseResourceChangeListInput,
  type ResourceChange,
  type ResourceChangeListInput,
  type ResourceChangeStore,
} from "./resource-change.js";

export interface AppendResourceChangeInput extends Omit<ResourceChange, "id" | "createdAt"> {
  readonly createdAt?: string;
}

export function* appendResourceChange(
  tx: any,
  tables: any,
  input: AppendResourceChangeInput,
): Generator<any, ResourceChange, any> {
  const [created] = yield tx
    .insert(tables.resourceChanges)
    .values({
      id: randomUUID(),
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
    .returning();
  return created as ResourceChange;
}

/**
 * The last revision recorded for a resource ID, or 0 when it has no history. A resource ID
 * created again after deletion continues from here, so no incarnation reuses a revision.
 */
export function* lastResourceRevision(
  tx: any,
  tables: any,
  resourceType: ResourceChange["resourceType"],
  resourceId: string,
): Generator<any, number, any> {
  const t = tables.resourceChanges;
  const [row] = yield tx
    .select({ revision: max(t.toRevision) })
    .from(t)
    .where(and(eq(t.resourceType, resourceType), eq(t.resourceId, resourceId)));
  return Number(row?.revision ?? 0);
}

export class DrizzleResourceChangeStore implements ResourceChangeStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  async listResourceChanges(input: ResourceChangeListInput): Promise<readonly ResourceChange[]> {
    const filter = parseResourceChangeListInput(input);
    const t = this.tables.resourceChanges;
    return runDialectTransaction(this.db, this.provider, function* (tx) {
      return (yield tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.resourceType, filter.resourceType),
            eq(t.resourceId, filter.resourceId),
            gt(t.toRevision, filter.afterRevision),
          ),
        )
        .orderBy(asc(t.toRevision))
        .limit(filter.limit)) as ResourceChange[];
    });
  }
}
