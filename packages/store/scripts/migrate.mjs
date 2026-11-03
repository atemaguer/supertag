import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePostgresql } from "drizzle-orm/node-postgres";
import { migrate as migratePostgresql } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const configuredUrl = process.env["SUPERTAG_DATABASE_URL"];
const configuredStateDirectory = process.env["SUPERTAG_STATE_DIR"]?.trim();
const stateDirectory = configuredStateDirectory
  ? resolve(repositoryRoot, configuredStateDirectory)
  : resolve(homedir(), ".supertag");
const databaseUrl = configuredUrl ?? `file:${resolve(stateDirectory, "supertag.db")}`;

if (databaseUrl.startsWith("file:")) {
  const configuredPath = databaseUrl.slice("file:".length);
  const databasePath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(repositoryRoot, configuredPath);
  mkdirSync(dirname(databasePath), { recursive: true });
  closeSync(openSync(databasePath, "a", 0o600));

  const client = new BetterSqlite3(databasePath);
  try {
    // Migrations run in one transaction, where SQLite ignores PRAGMA foreign_keys; table rebuilds
    // need enforcement off and check foreign keys themselves. See src/migrations.ts.
    client.pragma("foreign_keys = OFF");
    migrateSqlite(drizzleSqlite(client), {
      migrationsFolder: resolve(packageRoot, "drizzle/sqlite"),
    });
  } finally {
    client.close();
  }
} else if (databaseUrl.startsWith("postgresql:") || databaseUrl.startsWith("postgres:")) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await migratePostgresql(drizzlePostgresql(pool), {
      migrationsFolder: resolve(packageRoot, "drizzle/postgresql"),
    });
  } finally {
    await pool.end();
  }
} else {
  throw new Error("SUPERTAG_DATABASE_URL must use file:, postgresql:, or postgres:");
}
