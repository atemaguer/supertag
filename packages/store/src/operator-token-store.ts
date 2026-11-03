// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AuthenticateOperatorTokenInput,
  type CreateOperatorTokenInput,
  type DatabaseProvider,
  OPERATOR_TOKEN_LAST_USED_INTERVAL_MS,
  type OperatorToken,
  type OperatorTokenAuthentication,
  type OperatorTokenStore,
  operatorTokenExpiresAt,
  parseOperatorTokenName,
  TagMessagingError,
} from "@supertag/core";
import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";

type Flow<T> = Generator<any, T, any>;

const DIGEST = /^[a-f0-9]{64}$/u;

export class DrizzleOperatorTokenStore implements OperatorTokenStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  async createOperatorToken(input: CreateOperatorTokenInput): Promise<OperatorToken> {
    const name = parseOperatorTokenName(input.name);
    if (!DIGEST.test(input.secretDigest) || !input.lookupId.trim())
      throw new Error("Operator Token secret digest is invalid");
    const createdAt = input.createdAt;
    const table = this.tables.operatorTokens;
    return runDialectTransaction(this.db, this.provider, function* (tx: any): Flow<OperatorToken> {
      const [existing] = yield tx
        .select({ id: table.id })
        .from(table)
        .where(eq(table.name, name))
        .limit(1);
      if (existing)
        throw new TagMessagingError(
          409,
          `Operator Token ${name} already exists; names are never reused, so choose a new name`,
        );
      const [row] = yield tx
        .insert(table)
        .values({
          id: randomUUID(),
          name,
          lookupId: input.lookupId,
          secretDigest: input.secretDigest,
          expiresAt: operatorTokenExpiresAt(createdAt),
          lastUsedAt: null,
          revokedAt: null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();
      return operatorTokenFromRow(row);
    });
  }

  async findOperatorTokenByName(name: string): Promise<OperatorToken | undefined> {
    const table = this.tables.operatorTokens;
    const [row] = await this.db.select().from(table).where(eq(table.name, name)).limit(1);
    return row ? operatorTokenFromRow(row) : undefined;
  }

  async listOperatorTokens(): Promise<readonly OperatorToken[]> {
    const table = this.tables.operatorTokens;
    const rows = await this.db.select().from(table).orderBy(asc(table.createdAt), asc(table.name));
    return rows.map(operatorTokenFromRow);
  }

  async revokeOperatorToken(name: string, revokedAt: string): Promise<OperatorToken | undefined> {
    const table = this.tables.operatorTokens;
    return runDialectTransaction(this.db, this.provider, function* (tx: any): Flow<
      OperatorToken | undefined
    > {
      const [revoked] = yield tx
        .update(table)
        .set({ revokedAt, updatedAt: revokedAt })
        .where(and(eq(table.name, name), isNull(table.revokedAt)))
        .returning();
      if (revoked) return operatorTokenFromRow(revoked);
      const [existing] = yield tx.select().from(table).where(eq(table.name, name)).limit(1);
      return existing ? operatorTokenFromRow(existing) : undefined;
    });
  }

  async authenticateOperatorToken(
    input: AuthenticateOperatorTokenInput,
  ): Promise<OperatorTokenAuthentication> {
    const table = this.tables.operatorTokens;
    const presented = DIGEST.test(input.secretDigest)
      ? Buffer.from(input.secretDigest, "hex")
      : undefined;
    const [row] = await this.db
      .select()
      .from(table)
      .where(eq(table.lookupId, input.lookupId))
      .limit(1);
    if (
      !row ||
      presented === undefined ||
      !timingSafeEqual(Buffer.from(String(row.secretDigest), "hex"), presented)
    )
      return { status: "invalid" };
    if (row.revokedAt != null) return { status: "revoked" };
    if (Date.parse(row.expiresAt) <= Date.parse(input.authenticatedAt))
      return { status: "expired" };
    const staleBefore = new Date(
      Date.parse(input.authenticatedAt) - OPERATOR_TOKEN_LAST_USED_INTERVAL_MS,
    ).toISOString();
    if (row.lastUsedAt != null && row.lastUsedAt > staleBefore)
      return { status: "authenticated", operatorToken: operatorTokenFromRow(row) };
    // The conditional update keeps concurrent requests from each writing, and never revives a
    // token revoked since the read.
    const [touched] = await this.db
      .update(table)
      .set({ lastUsedAt: input.authenticatedAt })
      .where(
        and(
          eq(table.id, row.id),
          isNull(table.revokedAt),
          or(isNull(table.lastUsedAt), lt(table.lastUsedAt, staleBefore)),
        ),
      )
      .returning();
    if (touched) return { status: "authenticated", operatorToken: operatorTokenFromRow(touched) };
    const [current] = await this.db.select().from(table).where(eq(table.id, row.id)).limit(1);
    if (!current || current.revokedAt != null) return { status: "revoked" };
    return { status: "authenticated", operatorToken: operatorTokenFromRow(current) };
  }
}

function operatorTokenFromRow(row: any): OperatorToken {
  return {
    id: row.id,
    name: row.name,
    expiresAt: row.expiresAt,
    ...(row.lastUsedAt == null ? {} : { lastUsedAt: row.lastUsedAt }),
    ...(row.revokedAt == null ? {} : { revokedAt: row.revokedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
