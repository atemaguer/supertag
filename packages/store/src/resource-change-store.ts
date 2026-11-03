// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import { randomUUID } from "node:crypto";
import type { DatabaseProvider } from "@supertag/core";
import { and, asc, eq, gt } from "drizzle-orm";
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
