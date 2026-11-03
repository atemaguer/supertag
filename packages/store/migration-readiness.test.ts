import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.ts";
import {
  assertDatabaseSchemaReady,
  inspectDatabaseMigrationReadiness,
  migrateDatabase,
} from "./src/index.js";
import {
  inspectPostgresqlMigrationReadiness,
  inspectSqliteMigrationReadiness,
  migrateSqliteDatabase,
} from "./src/migrations.js";

/** The newest PostgreSQL migration, read from its journal so new migrations need no test edit. */
const latestPostgresqlTag = (
  JSON.parse(
    readFileSync(new URL("./drizzle/postgresql/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: readonly { tag: string }[] }
).entries.at(-1)?.tag;

/** Every SQLite migration in order, read from its journal so new migrations need no test edit. */
const sqliteTags = (
  JSON.parse(
    readFileSync(new URL("./drizzle/sqlite/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: readonly { tag: string }[] }
).entries.map((entry) => entry.tag);

describe("database migration readiness", () => {
  it("applies every migration to a new SQLite database and reports it current", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-migration-readiness-"));
    const url = `file:${join(directory, "state.db")}`;
    try {
      await expect(inspectDatabaseMigrationReadiness({ url })).resolves.toMatchObject({
        state: "uninitialized",
        targetTag: sqliteTags.at(-1),
        pendingTags: sqliteTags,
      });
      await expect(assertDatabaseSchemaReady({ url })).rejects.toThrow(/uninitialized/);
      await migrateDatabase({ url });
      await expect(inspectDatabaseMigrationReadiness({ url })).resolves.toMatchObject({
        state: "current",
        currentTag: sqliteTags.at(-1),
        pendingTags: [],
      });
      await expect(assertDatabaseSchemaReady({ url })).resolves.toBeUndefined();
      // Migrating again changes nothing.
      await migrateDatabase({ url });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects untracked application tables instead of replaying migrations over them", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE Task (id text PRIMARY KEY)");
      db.exec(`CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric
      )`);
      expect(inspectSqliteMigrationReadiness(db)).toMatchObject({ state: "incompatible" });
      expect(() => migrateSqliteDatabase(db)).toThrow(/application tables exist without tracked/);
    } finally {
      db.close();
    }
  });

  it("asks to delete a database created by an earlier unreleased build", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE Task (id text PRIMARY KEY)");
      db.exec(`CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric
      )`);
      db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
        "earlier",
        1,
      );
      expect(inspectSqliteMigrationReadiness(db)).toMatchObject({
        state: "incompatible",
        detail: expect.stringContaining("~/.supertag/supertag.db"),
      });
      expect(() => migrateSqliteDatabase(db)).toThrow(/earlier, unreleased SuperTag build/);
    } finally {
      db.close();
    }
  });

  it.skipIf(!process.env["SUPERTAG_POSTGRES_URL"])(
    "applies every migration to a new PostgreSQL database and reports it current",
    async () => {
      const postgresqlUrl = process.env["SUPERTAG_POSTGRES_URL"];
      if (postgresqlUrl === undefined) throw new Error("SUPERTAG_POSTGRES_URL is required");
      const isolated = await createIsolatedPostgresDatabase(postgresqlUrl);
      try {
        await expect(
          inspectDatabaseMigrationReadiness({ url: isolated.url }),
        ).resolves.toMatchObject({
          state: "uninitialized",
          targetTag: latestPostgresqlTag,
        });
        await migrateDatabase({ url: isolated.url });
        await migrateDatabase({ url: isolated.url });
        const pool = new Pool({ connectionString: isolated.url, max: 1 });
        try {
          await expect(inspectPostgresqlMigrationReadiness(pool)).resolves.toMatchObject({
            state: "current",
            currentTag: latestPostgresqlTag,
          });
        } finally {
          await pool.end();
        }
      } finally {
        await isolated.cleanup();
      }
    },
  );
});
