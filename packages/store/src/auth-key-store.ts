// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AuthKey,
  type AuthKeyRedemption,
  type AuthKeyStore,
  authKeyExpiresAt,
  type CreateAuthKeyInput,
  type DatabaseProvider,
  MAX_AUTH_KEY_TAGS,
  parseAuthKeyName,
  parseWorkerHostLabels,
  parseWorkerHostName,
  type RedeemAuthKeyInput,
  TagMessagingError,
  workerHostNameCandidate,
} from "@supertag/core";
import { and, asc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";
import {
  firstCredentialRow,
  newWorkerHostRow,
  storedLabels,
  workerHostFromRow,
} from "./worker-host-store.js";

type Flow<T> = Generator<any, T, any>;

/** Upper bound on `NAME-N` candidates tried for one join before giving up. */
const MAX_NAME_CANDIDATES = 1000;
const DIGEST = /^[a-f0-9]{64}$/u;
const JOIN_CREDENTIAL_PREFIX = /^[a-z0-9][a-z0-9/-]*\/$/u;

/** Rolls back a reusable key's redemption that a concurrent one with the same join request beat. */
class RepeatedJoin extends Error {}

export class DrizzleAuthKeyStore implements AuthKeyStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  async createAuthKey(input: CreateAuthKeyInput): Promise<AuthKey> {
    const name = parseAuthKeyName(input.name);
    const tagIds = [...new Set(input.tagIds.map((id) => id.trim()).filter(Boolean))];
    if (tagIds.length === 0 || tagIds.length > MAX_AUTH_KEY_TAGS)
      throw new TagMessagingError(400, `An Auth Key needs 1-${MAX_AUTH_KEY_TAGS} Tags`);
    const labels = parseWorkerHostLabels(input.labels ?? [], "Auth Key labels");
    if (!DIGEST.test(input.secretDigest) || !input.lookupId.trim())
      throw new Error("Auth Key secret digest is invalid");
    const createdAt = input.createdAt;
    const table = this.tables.authKeys;
    const tags = this.tables.tags;
    return runDialectTransaction(this.db, this.provider, function* (tx: any): Flow<AuthKey> {
      const known = yield tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(inArray(tags.id, tagIds), eq(tags.status, "active")));
      if (known.length !== tagIds.length)
        throw new TagMessagingError(400, "Every Auth Key Tag must exist");
      const [existing] = yield tx
        .select({ id: table.id })
        .from(table)
        .where(eq(table.name, name))
        .limit(1);
      if (existing)
        throw new TagMessagingError(
          409,
          `Auth Key ${name} already exists; names are never reused, so choose a new name`,
        );
      const [row] = yield tx
        .insert(table)
        .values({
          id: randomUUID(),
          name,
          lookupId: input.lookupId,
          secretDigest: input.secretDigest,
          tagIds,
          labels,
          reusable: input.reusable,
          ephemeral: input.ephemeral,
          expiresAt: authKeyExpiresAt(createdAt, input.reusable),
          usedAt: null,
          redemptionCount: 0,
          revokedAt: null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();
      return authKeyFromRow(row);
    });
  }

  async findAuthKeyByName(name: string): Promise<AuthKey | undefined> {
    const table = this.tables.authKeys;
    const [row] = await this.db.select().from(table).where(eq(table.name, name)).limit(1);
    return row ? authKeyFromRow(row) : undefined;
  }

  async findAuthKeyBySecret(input: {
    readonly lookupId: string;
    readonly secretDigest: string;
  }): Promise<AuthKey | undefined> {
    if (!DIGEST.test(input.secretDigest)) return undefined;
    const table = this.tables.authKeys;
    const [row] = await this.db
      .select()
      .from(table)
      .where(eq(table.lookupId, input.lookupId))
      .limit(1);
    if (
      !row ||
      !timingSafeEqual(
        Buffer.from(String(row.secretDigest), "hex"),
        Buffer.from(input.secretDigest, "hex"),
      )
    )
      return undefined;
    return authKeyFromRow(row);
  }

  async listAuthKeys(): Promise<readonly AuthKey[]> {
    const table = this.tables.authKeys;
    const rows = await this.db.select().from(table).orderBy(asc(table.createdAt), asc(table.name));
    return rows.map(authKeyFromRow);
  }

  async revokeAuthKey(name: string, revokedAt: string): Promise<AuthKey | undefined> {
    const table = this.tables.authKeys;
    return runDialectTransaction(this.db, this.provider, function* (tx: any): Flow<
      AuthKey | undefined
    > {
      const [revoked] = yield tx
        .update(table)
        .set({ revokedAt, updatedAt: revokedAt })
        .where(and(eq(table.name, name), isNull(table.revokedAt)))
        .returning();
      if (revoked) return authKeyFromRow(revoked);
      const [existing] = yield tx.select().from(table).where(eq(table.name, name)).limit(1);
      return existing ? authKeyFromRow(existing) : undefined;
    });
  }

  async redeemAuthKey(input: RedeemAuthKeyInput): Promise<AuthKeyRedemption> {
    try {
      return await this.#redeemAuthKey(input);
    } catch (error) {
      if (!(error instanceof RepeatedJoin)) throw error;
      return this.#redeemAuthKey(input);
    }
  }

  #redeemAuthKey(input: RedeemAuthKeyInput): Promise<AuthKeyRedemption> {
    const baseName = parseWorkerHostName(input.workerHostName);
    const redeemedAt = input.redeemedAt;
    const credentialId = input.credentialId.trim();
    if (!credentialId) throw new Error("Worker Host credential id must not be empty");
    const prefix = input.joinCredentialPrefix;
    if (
      prefix !== undefined &&
      (!JOIN_CREDENTIAL_PREFIX.test(prefix) || !credentialId.startsWith(prefix))
    )
      throw new Error("The join credential prefix must be a plain prefix of the credential id");
    const presented = DIGEST.test(input.secretDigest)
      ? Buffer.from(input.secretDigest, "hex")
      : undefined;
    const keys = this.tables.authKeys;
    const tags = this.tables.tags;
    const hosts = this.tables.workerHosts;
    const credentials = this.tables.workerHostCredentials;
    const bindings = this.tables.tagWorkerHostBindings;
    return runDialectTransaction(
      this.db,
      this.provider,
      function* (tx: any): Flow<AuthKeyRedemption> {
        const [key] = yield tx
          .select()
          .from(keys)
          .where(eq(keys.lookupId, input.lookupId))
          .limit(1);
        if (
          !key ||
          presented === undefined ||
          !timingSafeEqual(Buffer.from(String(key.secretDigest), "hex"), presented)
        )
          return { status: "invalid" };
        if (key.revokedAt != null) return { status: "revoked" };
        if (Date.parse(key.expiresAt) <= Date.parse(redeemedAt)) return { status: "expired" };
        // A repeat of a join request that enrolled a host returns that host and changes nothing.
        function* repeated(): Flow<AuthKeyRedemption | undefined> {
          if (prefix === undefined) return undefined;
          const [first] = yield tx
            .select({ workerHostId: credentials.workerHostId })
            .from(credentials)
            .where(and(like(credentials.credentialId, `${prefix}%`), eq(credentials.revision, 1)))
            .limit(1);
          if (!first) return undefined;
          const [host] = yield tx
            .select()
            .from(hosts)
            .where(eq(hosts.id, first.workerHostId))
            .limit(1);
          if (!host || host.authKey !== key.name) return undefined;
          return {
            status: "repeated",
            authKey: authKeyFromRow(key),
            workerHost: workerHostFromRow(host),
          };
        }
        const earlier = yield* repeated();
        if (earlier !== undefined) return earlier;
        if (!key.reusable && key.usedAt != null) return { status: "used" };
        const tagIds = stringArray(key.tagIds);
        // A retired Tag is gone from the organization, so a key naming one cannot join.
        const known = yield tx
          .select({ id: tags.id })
          .from(tags)
          .where(and(inArray(tags.id, tagIds), eq(tags.status, "active")));
        if (known.length !== tagIds.length) return { status: "tag-missing" };

        // The conditional update is the redemption fence: under concurrency, only one caller
        // moves a one-off key from unused to used. PostgreSQL re-checks the predicate after the
        // competing transaction commits; SQLite serializes the whole immediate transaction.
        const [used] = yield tx
          .update(keys)
          .set({
            usedAt: redeemedAt,
            redemptionCount: sql`${keys.redemptionCount} + 1`,
            updatedAt: redeemedAt,
          })
          .where(
            and(
              eq(keys.id, key.id),
              isNull(keys.revokedAt),
              ...(key.reusable ? [] : [isNull(keys.usedAt)]),
            ),
          )
          .returning();
        // The key row is now locked, so a concurrent redemption of the same request has
        // committed or waits; PostgreSQL reads what it committed.
        const concurrent = yield* repeated();
        if (concurrent !== undefined) {
          if (used) throw new RepeatedJoin();
          return concurrent;
        }
        if (!used) return { status: key.reusable ? "revoked" : "used" };

        let created: any;
        for (let attempt = 1; attempt <= MAX_NAME_CANDIDATES && !created; attempt += 1) {
          [created] = yield tx
            .insert(hosts)
            .values(
              newWorkerHostRow({
                id: workerHostNameCandidate(baseName, attempt),
                credentialId,
                enrolledAt: redeemedAt,
                ephemeral: Boolean(key.ephemeral),
                authKey: key.name,
                grantedLabels: storedLabels(key.labels),
              }),
            )
            .onConflictDoNothing({ target: hosts.id })
            .returning();
        }
        if (!created) throw new TagMessagingError(409, `No free Worker Host name near ${baseName}`);
        yield tx
          .insert(credentials)
          .values(firstCredentialRow(created.id, credentialId, redeemedAt))
          .returning();
        for (const tagId of tagIds)
          yield tx
            .insert(bindings)
            .values({ tagId, workerHostId: created.id, createdAt: redeemedAt })
            .onConflictDoNothing({ target: [bindings.tagId, bindings.workerHostId] })
            .returning();
        return {
          status: "redeemed",
          authKey: authKeyFromRow(used),
          workerHost: workerHostFromRow(created),
        };
      },
    );
  }
}

function stringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
    throw new Error("Persisted Auth Key Tags are invalid");
  return parsed;
}

function authKeyFromRow(row: any): AuthKey {
  return {
    id: row.id,
    name: row.name,
    tagIds: stringArray(row.tagIds),
    labels: storedLabels(row.labels),
    reusable: Boolean(row.reusable),
    ephemeral: Boolean(row.ephemeral),
    expiresAt: row.expiresAt,
    ...(row.usedAt == null ? {} : { usedAt: row.usedAt }),
    redemptionCount: Number(row.redemptionCount),
    ...(row.revokedAt == null ? {} : { revokedAt: row.revokedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
