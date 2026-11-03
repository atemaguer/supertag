// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.
import { randomUUID } from "node:crypto";
import type {
  CompleteOperatorNotificationInput,
  DatabaseProvider,
  OperatorNotification,
  OperatorNotificationStore,
  RecordOperatorNotificationInput,
  RetryOperatorNotificationInput,
} from "@supertag/core";
import { and, asc, desc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";

const KEY_BATCH = 200;

/** Durable outbox and per-destination item ledger for operator channel notifications. */
export class DrizzleOperatorNotificationStore implements OperatorNotificationStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  async listOperatorNotificationsForItems(
    itemKeys: readonly string[],
  ): Promise<ReadonlyMap<string, readonly OperatorNotification[]>> {
    const items = this.tables.operatorNotificationItems;
    const notifications = this.tables.operatorNotifications;
    const found = new Map<string, OperatorNotification[]>();
    for (let index = 0; index < itemKeys.length; index += KEY_BATCH) {
      const rows = await this.db
        .select({ itemKey: items.itemKey, notification: notifications })
        .from(items)
        .innerJoin(notifications, eq(items.notificationId, notifications.id))
        .where(inArray(items.itemKey, itemKeys.slice(index, index + KEY_BATCH)));
      for (const row of rows) {
        const list = found.get(row.itemKey) ?? [];
        list.push(notificationFromRow(row.notification));
        found.set(row.itemKey, list);
      }
    }
    return found;
  }

  async listNotifiedInboxItems(
    destination: string,
    itemKeys: readonly string[],
  ): Promise<Set<string>> {
    const t = this.tables.operatorNotificationItems;
    const found = new Set<string>();
    const unique = [...new Set(itemKeys)];
    for (let index = 0; index < unique.length; index += KEY_BATCH) {
      const rows = await this.db
        .select({ itemKey: t.itemKey })
        .from(t)
        .where(
          and(
            eq(t.destination, destination),
            inArray(t.itemKey, unique.slice(index, index + KEY_BATCH)),
          ),
        );
      for (const row of rows) found.add(row.itemKey);
    }
    return found;
  }

  async latestOperatorNotification(
    destination: string,
    objectiveId: string,
  ): Promise<OperatorNotification | undefined> {
    const t = this.tables.operatorNotifications;
    const [row] = await this.db
      .select()
      .from(t)
      .where(and(eq(t.destination, destination), eq(t.objectiveId, objectiveId)))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(1);
    return row ? notificationFromRow(row) : undefined;
  }

  async getOperatorNotification(id: string): Promise<OperatorNotification | undefined> {
    const t = this.tables.operatorNotifications;
    const [row] = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return row ? notificationFromRow(row) : undefined;
  }

  async recordOperatorNotification(
    input: RecordOperatorNotificationInput,
  ): Promise<OperatorNotification | undefined> {
    const itemKeys = [...new Set(input.itemKeys)];
    if (itemKeys.length === 0) throw new Error("An operator notification covers at least one item");
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1)
      throw new Error("maxAttempts must be a positive integer");
    const n = this.tables.operatorNotifications;
    const items = this.tables.operatorNotificationItems;
    const id = randomUUID();
    const values = {
      id,
      destination: input.destination,
      objectiveId: input.objectiveId,
      itemKeys,
      text: input.text,
      immediate: input.immediate,
      status: "pending",
      attemptCount: 0,
      maxAttempts: input.maxAttempts,
      availableAt: input.createdAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      externalMessageId: null,
      deliveredAt: null,
      failedAt: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    try {
      return await runDialectTransaction(this.db, this.provider, function* (tx) {
        if (input.windowStartedAt !== undefined) {
          const recent = (yield tx
            .select({ id: n.id })
            .from(n)
            .where(
              and(
                eq(n.destination, input.destination),
                eq(n.objectiveId, input.objectiveId),
                gt(n.createdAt, input.windowStartedAt),
              ),
            )
            .limit(1)) as any[];
          if (recent.length > 0) return undefined;
        }
        for (let index = 0; index < itemKeys.length; index += KEY_BATCH) {
          const claimed = (yield tx
            .select({ itemKey: items.itemKey })
            .from(items)
            .where(
              and(
                eq(items.destination, input.destination),
                inArray(items.itemKey, itemKeys.slice(index, index + KEY_BATCH)),
              ),
            )
            .limit(1)) as any[];
          if (claimed.length > 0) return undefined;
        }
        const [row] = (yield tx.insert(n).values(values).returning()) as any[];
        for (let index = 0; index < itemKeys.length; index += KEY_BATCH)
          yield tx
            .insert(items)
            .values(
              itemKeys.slice(index, index + KEY_BATCH).map((itemKey) => ({
                destination: input.destination,
                itemKey,
                notificationId: id,
                objectiveId: input.objectiveId,
                createdAt: input.createdAt,
              })),
            )
            .returning({ itemKey: items.itemKey });
        return notificationFromRow(row);
      });
    } catch (error) {
      // A concurrent Control Plane instance claimed the same occurrence first.
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  async claimNextOperatorNotification(input: {
    readonly leaseOwner: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<OperatorNotification | undefined> {
    if (!input.leaseOwner.trim()) throw new Error("leaseOwner must not be empty");
    if (!(Date.parse(input.leaseExpiresAt) > Date.parse(input.now)))
      throw new Error("leaseExpiresAt must be later than now");
    const t = this.tables.operatorNotifications;
    const due = or(
      and(
        eq(t.status, "pending"),
        lte(t.availableAt, input.now),
        lt(t.attemptCount, t.maxAttempts),
      ),
      and(eq(t.status, "delivering"), lte(t.leaseExpiresAt, input.now)),
    );
    const [candidate] = await this.db
      .select()
      .from(t)
      .where(due)
      .orderBy(asc(t.availableAt), asc(t.createdAt))
      .limit(1);
    if (!candidate) return undefined;
    const [row] = await this.db
      .update(t)
      .set({
        status: "delivering",
        attemptCount: sql`${t.attemptCount} + 1`,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.now,
      })
      .where(and(eq(t.id, candidate.id), eq(t.attemptCount, candidate.attemptCount), due))
      .returning();
    return row ? notificationFromRow(row) : undefined;
  }

  async completeOperatorNotification(input: CompleteOperatorNotificationInput): Promise<boolean> {
    const t = this.tables.operatorNotifications;
    const rows = await this.db
      .update(t)
      .set({
        status: "delivered",
        deliveredAt: input.deliveredAt,
        externalMessageId: input.externalMessageId ?? null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        failedAt: null,
        updatedAt: input.deliveredAt,
      })
      .where(
        and(eq(t.id, input.id), eq(t.status, "delivering"), eq(t.leaseOwner, input.leaseOwner)),
      )
      .returning({ id: t.id });
    return rows.length === 1;
  }

  async retryOperatorNotification(
    input: RetryOperatorNotificationInput,
  ): Promise<"failed" | "pending"> {
    const t = this.tables.operatorNotifications;
    const owned = and(
      eq(t.id, input.id),
      eq(t.status, "delivering"),
      eq(t.leaseOwner, input.leaseOwner),
    );
    const [current] = await this.db.select().from(t).where(owned).limit(1);
    if (!current)
      throw new Error(`Cannot update operator notification ${input.id}: lease is no longer owned`);
    const status = current.attemptCount >= current.maxAttempts ? "failed" : "pending";
    const rows = await this.db
      .update(t)
      .set({
        status,
        availableAt: input.retryAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: input.error.slice(0, 2_000),
        failedAt: status === "failed" ? input.failedAt : null,
        updatedAt: input.failedAt,
      })
      .where(owned)
      .returning({ id: t.id });
    if (rows.length !== 1)
      throw new Error(`Cannot update operator notification ${input.id}: lease is no longer owned`);
    return status;
  }
}

function notificationFromRow(row: any): OperatorNotification {
  return {
    id: row.id,
    destination: row.destination,
    objectiveId: row.objectiveId,
    itemKeys: Array.isArray(row.itemKeys) ? row.itemKeys : [],
    text: row.text,
    immediate: Boolean(row.immediate),
    status: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    leaseOwner: row.leaseOwner ?? null,
    leaseExpiresAt: row.leaseExpiresAt ?? null,
    lastError: row.lastError ?? null,
    externalMessageId: row.externalMessageId ?? null,
    deliveredAt: row.deliveredAt ?? null,
    failedAt: row.failedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as Record<string, unknown>)["code"];
    if (code === "23505" || (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")))
      return true;
    current = (current as Record<string, unknown>)["cause"];
  }
  return false;
}
