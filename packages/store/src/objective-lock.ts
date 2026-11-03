// biome-ignore-all lint/suspicious/noExplicitAny: This query is shared across both Drizzle dialects.

import { eq, sql } from "drizzle-orm";

/**
 * Yield inside the caller's transaction before reading Objective-scoped authority,
 * budget, capacity or membership that determines writes. All such workflows use
 * this same row lock; acquire it before dependent Tag/Team locks, and acquire
 * multiple Objectives in sorted ID order. It does not open another transaction.
 *
 * Missing rows return no results; callers must reject a missing Objective themselves.
 */
export function lockObjective(tx: any, objectives: any, objectiveId: string) {
  return tx
    .update(objectives)
    .set({ lockRevision: sql`${objectives.lockRevision} + 1` })
    .where(eq(objectives.id, objectiveId))
    .returning();
}
