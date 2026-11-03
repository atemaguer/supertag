import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePostgresql } from "drizzle-orm/node-postgres";
import { migrate as migratePostgresql } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

export const sqliteMigrationsFolder = fileURLToPath(new URL("../drizzle/sqlite", import.meta.url));

export const postgresqlMigrationsFolder = fileURLToPath(
  new URL("../drizzle/postgresql", import.meta.url),
);

const DEFAULT_POSTGRESQL_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_POSTGRESQL_STATEMENT_TIMEOUT_MS = 60_000;
const MIGRATION_ADVISORY_LOCK_ID = 1_864_228_019;
/** SQLite migrations that rebuild referenced tables and must run with foreign keys off. */
export const SQLITE_FOREIGN_KEYS_OFF_MIGRATIONS: ReadonlySet<string> = new Set([
  "0012_team_channels",
]);
const bundledMigrationCache = new Map<string, readonly BundledMigration[]>();

export interface MigrationOptions {
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

export type MigrationReadinessState = "current" | "pending" | "uninitialized" | "incompatible";

export interface MigrationReadiness {
  readonly state: MigrationReadinessState;
  readonly currentTag?: string;
  readonly targetTag: string;
  readonly pendingTags: readonly string[];
  readonly detail: string;
}

interface BundledMigration {
  readonly tag: string;
  readonly when: number;
  readonly hash: string;
}

interface AppliedMigration {
  readonly createdAt: number;
  readonly hash: string;
}

export function inspectSqliteMigrationReadiness(
  database: BetterSqlite3.Database,
): MigrationReadiness {
  const historyExists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get();
  if (historyExists === undefined) {
    return untrackedReadiness(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='Task'").get() !==
        undefined,
      sqliteMigrationsFolder,
    );
  }
  const row = database
    .prepare(
      "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { hash: string; createdAt: number | string } | undefined;
  if (row === undefined) {
    return untrackedReadiness(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='Task'").get() !==
        undefined,
      sqliteMigrationsFolder,
    );
  }
  return readinessFromApplied(
    { hash: row.hash, createdAt: Number(row.createdAt) },
    sqliteMigrationsFolder,
  );
}

export async function inspectPostgresqlMigrationReadiness(
  connection: Pick<pg.Pool | pg.PoolClient, "query">,
): Promise<MigrationReadiness> {
  const history = await connection.query<{ relation: string | null }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS relation`,
  );
  if (history.rows[0]?.relation === null || history.rows[0] === undefined) {
    const application = await connection.query<{ relation: string | null }>(
      `SELECT to_regclass('public."Task"')::text AS relation`,
    );
    return untrackedReadiness(
      application.rows[0]?.relation !== null && application.rows[0] !== undefined,
      postgresqlMigrationsFolder,
    );
  }
  const result = await connection.query<{ hash: string; createdAt: string | number }>(
    `SELECT hash, created_at AS "createdAt"
       FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    const application = await connection.query<{ relation: string | null }>(
      `SELECT to_regclass('public."Task"')::text AS relation`,
    );
    return untrackedReadiness(
      application.rows[0]?.relation !== null && application.rows[0] !== undefined,
      postgresqlMigrationsFolder,
    );
  }
  return readinessFromApplied(
    { hash: row.hash, createdAt: Number(row.createdAt) },
    postgresqlMigrationsFolder,
  );
}

export function assertMigrationReady(readiness: MigrationReadiness): void {
  if (readiness.state === "current") return;
  throw new Error(
    `Database schema is ${readiness.state}: ${readiness.detail.replace(/[.!?]$/, "")}. Run \`supertag migrate database --check\` for migration status.`,
  );
}

export function migrateSqliteDatabase(
  database: BetterSqlite3.Database,
  options: MigrationOptions = {},
): void {
  const readiness = inspectSqliteMigrationReadiness(database);
  assertMigrationMayRun(readiness);
  database.pragma(`busy_timeout = ${boundedMilliseconds(options.lockTimeoutMs, 5_000)}`);
  // SQLite ignores PRAGMA foreign_keys inside a transaction, and migrations run in one. A migration
  // that rebuilds a table other rows reference needs enforcement off, as SQLite's ALTER TABLE
  // procedure describes, and ends with a foreign_key_check guard over the tables it rebuilds.
  // Enforcement goes off only while such a migration is pending.
  const enforced =
    database.pragma("foreign_keys", { simple: true }) === 1 &&
    readiness.pendingTags.some((tag) => SQLITE_FOREIGN_KEYS_OFF_MIGRATIONS.has(tag));
  if (enforced) database.pragma("foreign_keys = OFF");
  try {
    migrateSqlite(drizzleSqlite(database), {
      migrationsFolder: sqliteMigrationsFolder,
    });
  } catch (error) {
    if (sqliteLockFailure(error)) {
      throw new Error(
        "SQLite migration could not acquire the database lock. Stop every Control Plane using this database and retry the migration.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (enforced) database.pragma("foreign_keys = ON");
  }
  assertMigrationReady(inspectSqliteMigrationReadiness(database));
}

export async function migratePostgresqlDatabase(
  pool: pg.Pool,
  options: MigrationOptions = {},
): Promise<void> {
  const client = await pool.connect();
  let advisoryLockHeld = false;
  let operationError: unknown;
  const lockTimeoutMs = boundedMilliseconds(
    options.lockTimeoutMs,
    DEFAULT_POSTGRESQL_LOCK_TIMEOUT_MS,
  );
  const statementTimeoutMs = boundedMilliseconds(
    options.statementTimeoutMs,
    DEFAULT_POSTGRESQL_STATEMENT_TIMEOUT_MS,
  );
  try {
    await client.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(`SET statement_timeout = '${statementTimeoutMs}ms'`);
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [MIGRATION_ADVISORY_LOCK_ID],
    );
    if (lock.rows[0]?.acquired !== true) {
      throw new Error(
        "Another SuperTag schema migration is running. Wait for it to finish, then run `supertag migrate database --check`.",
      );
    }
    advisoryLockHeld = true;
    assertMigrationMayRun(await inspectPostgresqlMigrationReadiness(client));
    await migratePostgresql(drizzlePostgresql(client), {
      migrationsFolder: postgresqlMigrationsFolder,
    });
    assertMigrationReady(await inspectPostgresqlMigrationReadiness(client));
  } catch (error) {
    operationError = postgresqlTimeoutFailure(error)
      ? new Error(
          `PostgreSQL migration exceeded its ${lockTimeoutMs}ms lock timeout or ${statementTimeoutMs}ms statement timeout. Keep every Control Plane stopped, inspect blocking sessions, and retry.`,
          { cause: error },
        )
      : error;
  }

  let cleanupError: unknown;
  try {
    if (advisoryLockHeld) {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_ID]);
    }
    await client.query("RESET lock_timeout");
    await client.query("RESET statement_timeout");
  } catch (error) {
    cleanupError = error;
  } finally {
    client.release(cleanupError instanceof Error ? cleanupError : undefined);
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
}

function assertMigrationMayRun(readiness: MigrationReadiness): void {
  if (readiness.state === "incompatible") {
    throw new Error(`Database migration history is incompatible: ${readiness.detail}`);
  }
}

function readinessFromApplied(applied: AppliedMigration, folder: string): MigrationReadiness {
  const bundled = bundledMigrations(folder);
  const target = bundled.at(-1);
  if (target === undefined) throw new Error(`No bundled migrations were found in ${folder}`);
  const currentIndex = bundled.findIndex((migration) => migration.when === applied.createdAt);
  if (currentIndex === -1) {
    return {
      state: "incompatible",
      targetTag: target.tag,
      pendingTags: [],
      detail:
        applied.createdAt > target.when
          ? "the database was migrated by a newer SuperTag release"
          : "the database was created by an earlier, unreleased SuperTag build. Delete it and start again; the default local database is ~/.supertag/supertag.db",
    };
  }
  const current = bundled[currentIndex];
  if (current === undefined || current.hash !== applied.hash) {
    return {
      state: "incompatible",
      ...(current === undefined ? {} : { currentTag: current.tag }),
      targetTag: target.tag,
      pendingTags: [],
      detail: "the latest recorded migration hash does not match this release",
    };
  }
  const pending = bundled.slice(currentIndex + 1);
  return {
    state: pending.length === 0 ? "current" : "pending",
    currentTag: current.tag,
    targetTag: target.tag,
    pendingTags: pending.map((migration) => migration.tag),
    detail:
      pending.length === 0
        ? `schema ${target.tag} is current`
        : `${pending.length} migration${pending.length === 1 ? " is" : "s are"} pending`,
  };
}

function untrackedReadiness(hasApplicationTables: boolean, folder: string): MigrationReadiness {
  const bundled = bundledMigrations(folder);
  const target = bundled.at(-1);
  if (target === undefined) throw new Error(`No bundled migrations were found in ${folder}`);
  return {
    state: hasApplicationTables ? "incompatible" : "uninitialized",
    targetTag: target.tag,
    pendingTags: hasApplicationTables ? [] : bundled.map((migration) => migration.tag),
    detail: hasApplicationTables
      ? "application tables exist without tracked migration history; restore a matching backup or repair migration history before starting SuperTag"
      : "the database has not been initialized",
  };
}

function bundledMigrations(folder: string): readonly BundledMigration[] {
  const cached = bundledMigrationCache.get(folder);
  if (cached !== undefined) return cached;
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as {
    readonly entries: readonly { readonly tag: string; readonly when: number }[];
  };
  const migrations = journal.entries.map((entry) => {
    const sql = readFileSync(`${folder}/${entry.tag}.sql`);
    return {
      ...entry,
      hash: createHash("sha256").update(sql).digest("hex"),
    };
  });
  bundledMigrationCache.set(folder, migrations);
  return migrations;
}

function boundedMilliseconds(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > 10 * 60_000) {
    throw new Error("Migration timeouts must be integers from 1 through 600000 milliseconds");
  }
  return selected;
}

function sqliteLockFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("code" in error ? error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED" : false)
  );
}

function postgresqlTimeoutFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ("code" in current && (current.code === "55P03" || current.code === "57014")) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
