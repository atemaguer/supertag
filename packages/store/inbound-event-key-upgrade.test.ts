import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePostgresql } from "drizzle-orm/node-postgres";
import { migrate as migratePostgresql } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.ts";
import {
  migratePostgresqlDatabase,
  migrateSqliteDatabase,
  postgresqlMigrationsFolder,
  sqliteMigrationsFolder,
} from "./src/migrations.js";

const removalMigration = "0019_drop_inbound_event_key";
const seed = `
  INSERT INTO "Tag" (id, name, status, "createdAt", "updatedAt")
    VALUES ('tag', 'tag', 'active', 'now', 'now');
  INSERT INTO "Session" (id, "tagId", "sessionKey", origin, state, "lastInteractionAt", "createdAt", "updatedAt")
    VALUES ('session', 'tag', 'session', '{}', 'open', 'now', 'now', 'now');
  INSERT INTO "Task" (id, "tagId", "sessionId", actor, trigger, "sessionHistory", "authorizationSnapshot", "contextPlan", status, "createdAt", "updatedAt")
    VALUES ('task', 'tag', 'session', '{}', '{}', '[]', '{}', '{}', 'completed', 'now', 'now');
  INSERT INTO "InboundEventKey" (id, "surfaceAccountId", "eventId", "claimedAt", "taskId")
    VALUES ('claim', 'account', 'event', 'now', 'task');
`;

async function migrationsBeforeRemoval(source: string, directory: string): Promise<string> {
  const base = join(directory, "migrations");
  await cp(source, base, { recursive: true });
  const journalPath = join(base, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => entry.tag < removalMigration,
  );
  await writeFile(journalPath, JSON.stringify(journal));
  return base;
}

describe("obsolete inbound event key upgrade", () => {
  it("drops populated SQLite claims without deleting their Tasks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-inbound-key-upgrade-"));
    const db = new Database(join(directory, "state.db"));
    try {
      const base = await migrationsBeforeRemoval(sqliteMigrationsFolder, directory);
      // Historical migrations rebuild referenced tables before this fixture is populated.
      db.pragma("foreign_keys = OFF");
      migrate(drizzle(db), { migrationsFolder: base });
      db.pragma("foreign_keys = ON");
      db.exec(seed);

      migrateSqliteDatabase(db);

      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'InboundEventKey'").all(),
      ).toEqual([]);
      expect(db.prepare('SELECT id FROM "Task"').all()).toEqual([{ id: "task" }]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env["SUPERTAG_POSTGRES_URL"])(
    "drops populated PostgreSQL claims without deleting their Tasks",
    async () => {
      const postgresqlUrl = process.env["SUPERTAG_POSTGRES_URL"];
      if (postgresqlUrl === undefined) throw new Error("SUPERTAG_POSTGRES_URL is required");
      const isolated = await createIsolatedPostgresDatabase(postgresqlUrl);
      const pool = new Pool({ connectionString: isolated.url, max: 1 });
      const directory = await mkdtemp(join(tmpdir(), "supertag-inbound-key-upgrade-"));
      try {
        const base = await migrationsBeforeRemoval(postgresqlMigrationsFolder, directory);
        await migratePostgresql(drizzlePostgresql(pool), { migrationsFolder: base });
        await pool.query(seed);

        await migratePostgresqlDatabase(pool);

        expect(
          (await pool.query(`SELECT to_regclass('public."InboundEventKey"') AS name`)).rows,
        ).toEqual([{ name: null }]);
        expect((await pool.query('SELECT id FROM "Task"')).rows).toEqual([{ id: "task" }]);
      } finally {
        await pool.end();
        await isolated.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
