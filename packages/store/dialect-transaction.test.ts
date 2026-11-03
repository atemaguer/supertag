import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { runDialectTransaction } from "./src/dialect-transaction.js";
import { migrateDatabase } from "./src/index.js";
import * as postgresSchema from "./src/schema/postgresql.js";
import * as sqliteSchema from "./src/schema/sqlite.js";

const { Pool } = createRequire(import.meta.url)("pg") as typeof import("pg");
const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const provider of ["sqlite", "postgresql"] as const) {
  describe.skipIf(provider === "postgresql" && !postgres)(`${provider} domain transactions`, () => {
    const cleanups: Array<() => void | Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    async function fixture() {
      if (provider === "sqlite") {
        const native = new Database(":memory:");
        cleanups.push(() => native.close());
        native.exec(
          'CREATE TABLE "Tag" (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, status TEXT NOT NULL, "runsOn" TEXT NOT NULL DEFAULT \'[]\', "execution" TEXT, "retiredAt" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)',
        );
        return { db: sqliteDrizzle(native), table: sqliteSchema.tags };
      }
      const isolated = await createIsolatedPostgresDatabase(postgres as string);
      cleanups.push(isolated.cleanup);
      await migrateDatabase({ url: isolated.url });
      const pool = new Pool({ connectionString: isolated.url });
      cleanups.push(() => pool.end());
      return { db: postgresDrizzle(pool), table: postgresSchema.tags };
    }
    const tag = () => ({
      id: randomUUID(),
      name: randomUUID(),
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    it("returns values from sequential queries only after committing the entire flow", async () => {
      const { db, table } = await fixture();
      const first = tag();
      const result = await runDialectTransaction(db, provider, function* (tx) {
        const [saved] = yield tx.insert(table).values(first).returning();
        yield tx
          .insert(table)
          .values({ ...tag(), name: `${saved.name}-next` })
          .returning();
        const rows = yield tx.select().from(table);
        return { id: saved.id, count: rows.length };
      });
      expect(result).toEqual({ id: first.id, count: 2 });
      expect(await db.select().from(table)).toHaveLength(2);
    });

    it("rolls back preceding writes when a later query violates a constraint", async () => {
      const { db, table } = await fixture();
      const first = tag();
      await expect(
        runDialectTransaction(db, provider, function* (tx) {
          yield tx.insert(table).values(first).returning();
          yield tx
            .insert(table)
            .values({ ...tag(), name: first.name })
            .returning();
        }),
      ).rejects.toThrow();
      expect(await db.select().from(table)).toEqual([]);
    });

    it("rolls back preceding writes when domain validation rejects the result", async () => {
      const { db, table } = await fixture();
      const rejection = new Error("Domain invariant rejected");
      await expect(
        runDialectTransaction(db, provider, function* (tx) {
          yield tx.insert(table).values(tag()).returning();
          throw rejection;
        }),
      ).rejects.toBe(rejection);
      expect(await db.select().from(table)).toEqual([]);
    });
  });
}
